// Rooms, players, phases, input queues and the per-tick simulation. Transport-agnostic:
// a socket is reached only through the Conn interface, so index.ts owns `ws`.

import { randomBytes, randomInt } from "node:crypto";
import { BASE_STATS, collideCars, NO_INPUT, type CarStats } from "../shared/physics";
import {
  BLOCKLIST_MAX,
  CHAT_BURST,
  CHAT_COMINGS_BURST,
  CHAT_COMINGS_PER_SEC,
  CHAT_HISTORY,
  CHAT_MAX,
  CHAT_REFILL_MS,
  CHAT_ROOM_BURST,
  CHAT_ROOM_PER_SEC,
  CODE_ALPHABET,
  CODE_LENGTH,
  COUNTDOWN_MS,
  FINISH_GRACE_MS,
  FORCE_START_MS,
  MAX_PLAYERS,
  PAUSE_COOLDOWN_MS,
  PAUSE_MAX_MS,
  PAUSE_RESUME_MS,
  RECONNECT_GRACE_MS,
  RESULTS_MS,
  SNAPSHOT_EVERY,
  round,
  type ChatLine,
  type ClientMsg,
  type EntSnap,
  type ErrCode,
  type GameEvent,
  type Phase,
  type PlayerInfo,
  type ResultRow,
  type ServerMsg,
} from "../shared/protocol";
import { AMMO, buy, clampAmmo, isItem, payouts, startingWallet, statsFor, type AmmoId, type Wallet } from "../shared/shop";
import { gridSlot, type Track } from "../shared/track";
import { DEFAULT_TRACK_ID, isTrackId, trackById } from "../shared/tracks";
import { BTN_RIVET, CAR_HP, GHOST_TICKS, mineCount, NO_COMMAND, stepRaceCar, WEAPONS_ARM_MS, type Command } from "../shared/weapons";
import { Combat, solid, type Fighter } from "./combat";
import { advance, compareStanding, newProgress, raceDistance, type Progress } from "./race";

export interface Conn {
  send(msg: ServerMsg): void;
  close(): void;
}

/** One socket's binding to a room and player, owned by the transport layer. */
export interface Session {
  conn: Conn;
  room: Room | null;
  player: Player | null;
}

// Jitter buffer (see PLAN.md, Netcode).
const QUEUE_START = 2; // inputs needed before consuming after a start or an underrun
const QUEUE_MAX = 6; // above this, drop the oldest ...
const QUEUE_TRIM = 3; // ... down to this many
const REPEAT_TICKS = 6; // on underrun, repeat the last input this long, then coast
// After a resume each car waits for its driver's first inputs (QUEUE_START), at most this many
// ticks: the client predicts from the frozen car, so a car coasting until they arrive would
// be a reconciliation jump of a round trip's worth of driving.
const RESUME_HOLD_TICKS = 60;
const MAX_INPUTS_PER_MSG = 10;
const NAME_MAX = 12;
const CHAT_ERR_EVERY_MS = 1000; // "Slow down" at most this often per player

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];

interface QueuedInput {
  seq: number;
  cmd: Command;
}

export interface Player extends Fighter {
  name: string;
  color: string;
  token: string;
  session: Session | null;
  disconnectedAt: number;
  ready: boolean; // lobby ready check: kept across a rebind, reset when a race starts
  inRace: boolean;
  // Retired from the current race (Esc menu): no car, the progress kept for the DNF row and the
  // wreck bonus, the garage open. Reset by clearRace and beginRace.
  retired: boolean;
  progress: Progress | null;
  stats: CarStats;
  wallet: Wallet; // scrap, upgrade levels, ammo: kept across races and reconnects
  queue: QueuedInput[];
  lastQueuedSeq: number;
  ack: number;
  buffering: boolean;
  lastInput: Command;
  starved: number;
  mineBase: number | null; // mine counter of the last real input consumed
  held: number; // ticks the car still waits for its driver's first inputs after a resume
  // Chat rate bucket: on the player, not the socket, so a reconnect does not refill it.
  chatBucket: Bucket;
  chatErrAt: number; // server time "Slow down" was last sent
}

/** A token bucket: tokens left, and the server time it was last topped up. */
export interface Bucket {
  tokens: number;
  at: number;
}

/** Top the bucket up to now: perSec tokens a second, at most burst. */
function refill(b: Bucket, burst: number, perSec: number, now: number): void {
  b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) * perSec) / 1000);
  b.at = now;
}

function newId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} _.\-]/gu, "").trim() : "";
  return s.slice(0, NAME_MAX) || "Driver";
}

/**
 * A chat message as stored and sent: "" (ignored) for a non-string or nothing left. Runs of
 * whitespace (newlines and tabs too) become one space first, then control, format and other
 * \p{C} characters go, except ZWNJ / ZWJ (joined emoji, some scripts); then trim and cut to
 * CHAT_MAX code points. Spaces left side by side by the strip are collapsed again.
 */
export function cleanChat(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .replace(/\s+/gu, " ")
    .replace(/(?![\u200C\u200D])\p{C}/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return [...s].slice(0, CHAT_MAX).join("").trimEnd();
}

const PLACES = ["1st", "2nd", "3rd", "4th", "5th", "6th"]; // MAX_PLAYERS places

/** Game lines about one player, and their text after the name. */
type ComingKind = "join" | "leave" | "removed" | "host";
const COMING_TEXT: Record<ComingKind, string> = {
  join: "joined the room",
  leave: "left the room",
  removed: "was removed",
  host: "is now the host",
};

export class Room {
  readonly players = new Map<string, Player>();
  private _trackId: string;
  private _track: Track;
  private _combat: Combat;
  hostId = "";
  phase: Phase = "lobby";
  phaseEnds = 0;
  raceStart = 0;
  private finishers = 0;
  private tickNo = 0;
  private lastOrder: string[] = []; // last race's standings, for the reverse grid
  private lobbyAt = 0; // server time the lobby last opened (back from results)
  private lastJoinAt = 0; // server time the last new player joined (the creator included)
  private startedAt = 0; // server time the current race's countdown began (start or restart)
  /** The host's lock: no new players join; a seat rejoin with its token still does. */
  locked = false;
  // Rejoin tokens of the players the host removed, oldest first (BLOCKLIST_MAX); gone with the room.
  private readonly blocked = new Set<string>();
  // Each racer's ammo as the race began: a stopped or restarted race gives back what it used.
  private readonly startAmmo = new Map<string, { rivets: number; mines: number }>();
  // Ammo packs bought by retired players during the current race, in order, with the scrap paid:
  // a stop or a restart replays them on the start-of-race ammo (restoreAmmo).
  private readonly retiredBuys = new Map<string, { item: AmmoId; paid: number }[]>();
  private readonly chatLog: ChatLine[] = []; // the last CHAT_HISTORY lines; gone with the room
  private chatSeq = 0;
  // Room-wide budgets (shared/protocol.ts CHAT_ROOM_*, CHAT_COMINGS_*); full at the start.
  private readonly sayBudget: Bucket = { tokens: CHAT_ROOM_BURST, at: -Infinity };
  private readonly comingsBudget: Bucket = { tokens: CHAT_COMINGS_BURST, at: -Infinity };
  // The host's pause (MENU-3, PLAN-MENU.md): the room message carries all four.
  paused = false;
  pausedBy = ""; // name of who paused
  pausedAt = 0; // server time the pause began
  resumeAt = 0; // server time the resume 3-2-1 ends (the room steps again), 0 = none under way
  private pausedById = ""; // their player id: their unbind or removal starts the resume
  private pauseOkAt = 0; // server time from which the next pause is accepted (cooldown)

  constructor(
    readonly code: string,
    readonly laps: number,
    readonly hp: number = CAR_HP,
    trackId: string = DEFAULT_TRACK_ID,
  ) {
    this._trackId = trackId;
    this._track = trackById(trackId);
    this._combat = this.newCombat();
  }

  /** The room's track id (shared/tracks.ts); changed only through setTrack. */
  get trackId(): string {
    return this._trackId;
  }

  /** The room's track, built from the registry. */
  get track(): Track {
    return this._track;
  }

  get combat(): Combat {
    return this._combat;
  }

  private newCombat(): Combat {
    return new Combat(this._track, (ev) => this.event(this.tickNo, ev));
  }

  get empty(): boolean {
    return this.players.size === 0;
  }

  /** Server time from which the host may start with players not ready; 0 outside the lobby. */
  get forceStartAt(): number {
    return this.phase === "lobby" ? Math.max(this.lobbyAt, this.lastJoinAt) + FORCE_START_MS : 0;
  }

  /** Players the host's Start waits for: connected, not the host, not ready. */
  notReady(): Player[] {
    return [...this.players.values()].filter((p) => p.session && p.id !== this.hostId && !p.ready);
  }

  addPlayer(name: string, session: Session, now: number): Player | string {
    if (this.players.size >= MAX_PLAYERS) return "Room is full";
    const used = new Set([...this.players.values()].map((p) => p.color));
    const wallet = startingWallet();
    const p: Player = {
      id: newId(6),
      name,
      color: COLORS.find((c) => !used.has(c)) ?? COLORS[0],
      token: newId(18),
      session: null,
      disconnectedAt: 0,
      ready: false,
      inRace: false,
      retired: false,
      car: null,
      progress: null,
      finished: false,
      hp: this.hp,
      maxHp: this.hp,
      ghost: 0,
      cooldown: 0,
      wallet,
      ammo: wallet.ammo,
      levels: wallet.levels,
      stats: { ...BASE_STATS },
      queue: [],
      lastQueuedSeq: -1,
      ack: -1,
      buffering: true,
      lastInput: NO_COMMAND,
      starved: 0,
      mineBase: null,
      held: 0,
      chatBucket: { tokens: CHAT_BURST, at: now },
      chatErrAt: -Infinity,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.lastJoinAt = now; // only a new player moves forceStartAt, never a rebind
    // Before bind: the others get it live, the joiner once, in the chatlog after its welcome.
    this.comingLine("join", p, now);
    this.bind(p, session);
    return p;
  }

  playerByToken(token: unknown): Player | null {
    if (typeof token !== "string") return null;
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  /** Attach a (new) socket to a player. Input sequence numbers restart at 0. */
  bind(p: Player, session: Session): void {
    const old = p.session;
    if (old && old !== session) {
      old.room = null;
      old.player = null;
      old.conn.send({ t: "err", code: "taken", msg: "This seat was taken over by another connection" });
      old.conn.close();
    }
    p.session = session;
    p.disconnectedAt = 0;
    session.room = this;
    session.player = p;
    p.lastQueuedSeq = -1;
    p.ack = -1;
    resetQueue(p);
    session.conn.send({ t: "welcome", code: this.code, you: p.id, token: p.token, laps: this.laps });
    session.conn.send({ t: "chatlog", lines: [...this.chatLog] });
    this.sendGarage(p);
    this.broadcastRoom();
  }

  unbind(p: Player, now: number): void {
    if (!p.session) return;
    p.session.room = null;
    p.session.player = null;
    p.session = null;
    p.disconnectedAt = now;
    if (!this.pauserGone(p, now)) this.broadcastRoom();
  }

  /**
   * The player is gone for good: the Leave button, or the reconnect grace ran out, or the host
   * removed them (kick: a "removed" line instead). The only place a "leave" line is written (a
   * reconnect or a takeover writes neither join nor leave).
   */
  private remove(p: Player, now: number, line: "leave" | "removed" = "leave"): void {
    this.players.delete(p.id);
    if (this.hostId === p.id) this.hostId = this.players.keys().next().value ?? "";
    this.comingLine(line, p, now);
    if (!this.pauserGone(p, now)) this.broadcastRoom();
  }

  /** The leave message: the player leaves at once, without the reconnect grace. */
  leave(p: Player, now: number): void {
    if (this.players.get(p.id) !== p) return;
    const s = p.session;
    if (s) {
      s.room = null;
      s.player = null;
    }
    p.session = null;
    this.remove(p, now);
  }

  /** A player's chat message, in any phase: cleaned, rate-limited, then sent to everyone. */
  chat(p: Player, raw: unknown, now: number): void {
    const text = cleanChat(raw);
    if (!text) return;
    refill(p.chatBucket, CHAT_BURST, 1000 / CHAT_REFILL_MS, now);
    refill(this.sayBudget, CHAT_ROOM_BURST, CHAT_ROOM_PER_SEC, now);
    if (p.chatBucket.tokens < 1 || this.sayBudget.tokens < 1) {
      if (now - p.chatErrAt >= CHAT_ERR_EVERY_MS) {
        p.chatErrAt = now;
        p.session?.conn.send({ t: "err", msg: "Slow down" });
      }
      return;
    }
    p.chatBucket.tokens--;
    this.sayBudget.tokens--;
    this.addLine("say", p.name, p.color, text, p.id);
  }

  /**
   * A join, leave, removed or new-host line, unless the room's budget for them is spent (a churn
   * of seats, or a host flipping the host or removing players in a loop).
   */
  private comingLine(kind: ComingKind, p: Player, now: number): void {
    refill(this.comingsBudget, CHAT_COMINGS_BURST, CHAT_COMINGS_PER_SEC, now);
    if (this.comingsBudget.tokens < 1) return;
    this.comingsBudget.tokens--;
    this.addLine(kind, p.name, p.color, COMING_TEXT[kind]);
  }

  /** The room's chat history, oldest first. */
  get chatLines(): readonly ChatLine[] {
    return this.chatLog;
  }

  private addLine(kind: ChatLine["kind"], name: string, color: string, text: string, from?: string): void {
    const line: ChatLine = from ? { n: ++this.chatSeq, kind, from, name, color, text } : { n: ++this.chatSeq, kind, name, color, text };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.splice(0, this.chatLog.length - CHAT_HISTORY);
    this.broadcast({ t: "chat", line });
  }

  /** Grid order: newcomers first (join order), then the last race reversed (leader last). */
  gridOrder(): Player[] {
    const present = [...this.players.values()].filter((p) => p.session);
    const raced = new Set(this.lastOrder);
    const fresh = present.filter((p) => !raced.has(p.id));
    const reversed = [...this.lastOrder]
      .reverse()
      .map((id) => this.players.get(id))
      .filter((p): p is Player => !!p && !!p.session);
    return [...fresh, ...reversed];
  }

  /**
   * The host's Start counts as the host's ready. Without force, every other connected
   * player must be ready; force ("Start anyway") is accepted from forceStartAt and races
   * every connected player, ready or not. Offline players sit the race out either way.
   */
  start(p: Player, now: number, force = false): string | null {
    if (p.id !== this.hostId) return "Only the host can start";
    if (this.phase !== "lobby") return "A race is already running";
    const waiting = this.notReady().length;
    if (waiting > 0 && !force) return `Waiting for ${waiting} player${waiting === 1 ? "" : "s"} to get ready`;
    if (waiting > 0 && now < this.forceStartAt) return "Start anyway is not available yet";
    this.beginRace(now);
    return null;
  }

  /**
   * A fresh countdown on the room's track: every connected player races (start() checked the
   * ready flags; a restart does not). Offline players sit it out. Each racer's ammo is noted, so
   * a stop or a restart can give back what the race used.
   */
  private beginRace(now: number): void {
    for (const q of this.players.values()) {
      q.ready = false; // everyone readies again next time
      q.retired = false;
    }
    this.combat.reset();
    this.startAmmo.clear();
    this.retiredBuys.clear();
    this.gridOrder().forEach((q, slot) => {
      const g = gridSlot(this.track, slot);
      q.car = { x: g.x, y: g.y, h: g.h, vx: 0, vy: 0, seg: g.seg, wreck: 0, air: 0, fall: 0 };
      q.progress = newProgress(this.track, q.car);
      q.inRace = true;
      q.finished = false;
      q.hp = q.maxHp = this.hp;
      q.ghost = 0;
      q.cooldown = 0;
      q.stats = statsFor(q.wallet.levels);
      clampAmmo(q.wallet); // e.g. an old wallet over the mine cap: nobody races with more
      this.startAmmo.set(q.id, { ...q.wallet.ammo });
      resetQueue(q);
    });
    this.finishers = 0;
    this.startedAt = now;
    this.raceStart = now + COUNTDOWN_MS;
    this.setPhase("countdown", this.raceStart);
  }

  // ---- host room controls (the Esc menu, PLAN-MENU.md) ----------------------------------

  /**
   * Host only, countdown or race: abort it. Back to the lobby as if the race never ran: no
   * results, no result line, no scrap, the ammo it used given back, the last finished race's
   * grid order kept. "Start anyway" is available at once: the racers already had their lobby
   * time (all ready, or the host forced the start after it); a player who joined during the
   * aborted race still gets FORCE_START_MS to shop.
   */
  stopRace(p: Player, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can stop the race";
    if (this.phase !== "countdown" && this.phase !== "racing") return "No race to stop";
    this.restoreAmmo();
    const open = now - FORCE_START_MS;
    if (this.lastJoinAt <= this.startedAt) this.lastJoinAt = Math.min(this.lastJoinAt, open);
    this.toLobby(now, open);
    return null;
  }

  /**
   * Host only, countdown or race: a fresh countdown on the same track. The race is cleared as
   * on the way back to the lobby first (an offline player's car too: start only resets the
   * connected ones), the ammo it used is given back, and then everyone connected races, ready
   * or not (a player who joined during the race too).
   */
  restartRace(p: Player, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can restart the race";
    if (this.phase !== "countdown" && this.phase !== "racing") return "No race to restart";
    this.restoreAmmo();
    this.clearRace();
    this.beginRace(now);
    return null;
  }

  /**
   * Host only, any phase: remove a player at once. Their socket is detached first (as leave()
   * does: no chat or input from it afterwards), then told "kicked" and closed. Their rejoin token
   * is blocked in this room (best effort: a join without a token is a new player, and a locked
   * room refuses that too). One "removed" line, no "left the room".
   */
  kick(p: Player, id: unknown, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can remove a player";
    const q = typeof id === "string" ? this.players.get(id) : undefined;
    if (!q) return "That player is not in the room";
    if (q === p) return "You cannot remove yourself";
    const s = q.session;
    if (s) {
      s.room = null;
      s.player = null;
    }
    q.session = null;
    this.blocked.delete(q.token); // re-added below as the newest
    this.blocked.add(q.token);
    for (const t of this.blocked) {
      if (this.blocked.size <= BLOCKLIST_MAX) break;
      this.blocked.delete(t);
    }
    this.remove(q, now, "removed");
    s?.conn.send({ t: "err", code: "kicked", msg: "You were removed by the host" });
    s?.conn.close();
    return null;
  }

  /** A join with this token is refused: the host removed its player. */
  isBlocked(token: unknown): boolean {
    return typeof token === "string" && this.blocked.has(token);
  }

  /** How many removed players' tokens the room remembers (BLOCKLIST_MAX at most). */
  get blockedCount(): number {
    return this.blocked.size;
  }

  /**
   * Host only, any phase: hand the host over to a connected player. Both lose any stale ready
   * flag (a host never readies; the new host's old flag is not theirs to keep).
   */
  setHost(p: Player, id: unknown, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can hand over the host";
    const q = typeof id === "string" ? this.players.get(id) : undefined;
    if (!q) return "That player is not in the room";
    if (q === p) return "You are already the host";
    if (!q.session) return `${q.name} is offline`;
    q.ready = false;
    p.ready = false;
    this.hostId = q.id;
    this.comingLine("host", q, now);
    this.broadcastRoom();
    return null;
  }

  /** Host only, any phase: lock (no new players) or unlock the room. */
  setLocked(p: Player, locked: unknown): string | null {
    if (p.id !== this.hostId) return "Only the host can lock the room";
    if (typeof locked !== "boolean") return "Bad lock request";
    if (locked === this.locked) return null;
    this.locked = locked;
    this.broadcastRoom();
    return null;
  }

  // ---- pause (MENU-3) -------------------------------------------------------------------
  //
  // While paused the room does not run its phase timers or the simulation: cars, shots, mines
  // and every tick-based timer (wreck, ghost, air, fall, mine life, rivet cooldown) stand
  // still. Everything else keeps going: inputs are taken off the queues and thrown away (acked,
  // the mine counter moves on), offline players' grace runs out as usual, snapshots flow
  // (frozen poses), the auto-resume and the end of the 3-2-1 are checked, and a race left with
  // nobody on the field (a kick or a retire) ends. On the resume raceStart and a nonzero
  // phaseEnds move on by the time paused, so the race clock, finish times, the weapons-armed
  // delay and the finish grace go on where they stood. disconnectedAt, chat buckets and the
  // lobby's forceStartAt are not shifted.

  /**
   * Host only, countdown or race: freeze it for everyone. Refused while paused (the 3-2-1
   * too) and for PAUSE_COOLDOWN_MS after the room stepped again.
   */
  pause(p: Player, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can pause the race";
    if (this.phase !== "countdown" && this.phase !== "racing") return "No race to pause";
    if (this.paused) return "The race is already paused";
    if (now < this.pauseOkAt) return `You can pause again in ${Math.ceil((this.pauseOkAt - now) / 1000)}s`;
    this.paused = true;
    this.pausedBy = p.name;
    this.pausedById = p.id;
    this.pausedAt = now;
    this.resumeAt = 0;
    this.broadcastRoom();
    return null;
  }

  /** Host only (a new host too), while paused: the 3-2-1, then the room steps again. */
  resume(p: Player, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can resume the race";
    if (!this.paused) return "The race is not paused";
    if (this.resumeAt) return null; // already counting down
    this.beginResume(now);
    return null;
  }

  /**
   * Start the resume. In the race: resumeAt = now + PAUSE_RESUME_MS, still paused until then.
   * In the countdown phase the countdown starts over at once (a full 3-2-1-GO instead of a
   * 3-2-1 stacked on what was left of it); the cars wait on the grid either way.
   */
  private beginResume(now: number): void {
    if (this.phase !== "countdown") {
      this.resumeAt = now + PAUSE_RESUME_MS;
      this.broadcastRoom();
      return;
    }
    this.clearPause();
    this.pauseOkAt = now + PAUSE_COOLDOWN_MS;
    for (const q of this.players.values()) resetQueue(q);
    this.raceStart = now + COUNTDOWN_MS;
    this.setPhase("countdown", this.raceStart);
  }

  /**
   * The 3-2-1 is over: shift the race's wall-clock times by the time paused and step again.
   * Every queue starts afresh (no pre-pause input repeated on an underrun); a connected
   * driver's car waits for their first inputs (RESUME_HOLD_TICKS).
   */
  private endPause(now: number): void {
    const d = now - this.pausedAt;
    this.raceStart += d;
    if (this.phaseEnds) this.phaseEnds += d; // 0 = open-ended (no winner yet)
    this.clearPause();
    this.pauseOkAt = now + PAUSE_COOLDOWN_MS;
    for (const q of this.players.values()) {
      resetQueue(q);
      if (q.car && q.session) q.held = RESUME_HOLD_TICKS;
    }
    this.broadcastRoom();
  }

  /** Paused, no resume under way: it starts by itself after PAUSE_MAX_MS; the 3-2-1's end. */
  private pauseTimers(now: number): void {
    if (!this.resumeAt && now - this.pausedAt >= PAUSE_MAX_MS) this.beginResume(now);
    if (this.paused && this.resumeAt && now >= this.resumeAt) this.endPause(now);
  }

  /**
   * The player who paused went offline or left (or was removed after a handover): the pause
   * does not wait for them, the resume starts. True when it broadcast the room.
   */
  private pauserGone(p: Player, now: number): boolean {
    if (!this.paused || this.resumeAt || p.id !== this.pausedById) return false;
    this.beginResume(now);
    return true;
  }

  private clearPause(): void {
    this.paused = false;
    this.pausedBy = "";
    this.pausedById = "";
    this.pausedAt = 0;
    this.resumeAt = 0;
  }

  /**
   * A paused tick: inputs are consumed and thrown away (ack and the mine counter move on, so
   * nothing pressed during the pause fires afterwards); nothing is stepped. A race left with
   * nobody to wait for (a kick, a retire or the grace removing the last driver on the field)
   * ends now, as an unpaused tick would end it.
   */
  private pausedTick(now: number): void {
    const racers = [...this.players.values()].filter((p) => p.car);
    for (const p of racers) consumeInput(p);
    if (this.phase !== "racing") return;
    if (racers.length > 0 && racers.every((p) => p.progress!.fin)) this.endRace(now);
    else if (racers.length === 0) this.toLobby(now);
  }

  /**
   * Any racer, racing only ("Retire to garage" in the Esc menu): the car leaves the field at once
   * (not stepped, not solid, no inputs, not in the snapshots) and the player is DNF. The progress
   * stays, so endRace still writes their row and pays their wreck bonus; the race-end check only
   * looks at cars, so it ends as soon as everyone left has finished (or, nobody having finished,
   * goes back to the lobby). The garage opens for them (buy) until the race is over.
   */
  retire(p: Player): string | null {
    if (this.phase !== "racing") return "You can only retire during a race";
    if (p.retired) return "You already retired";
    if (!p.car || !p.progress) return "You are not in this race";
    if (p.finished) return "You already finished";
    p.retired = true;
    p.car = null;
    p.ghost = 0;
    p.cooldown = 0;
    resetQueue(p);
    this.broadcastRoom();
    return null;
  }

  /**
   * Give each racer of the current race the ammo they started it with. The ammo packs a retired
   * player bought during it are then bought again on top, as if in the lobby: a pack that would
   * have been "Already maxed out" there (the start ammo is at the cap) gets its scrap back, so
   * a stop or a restart never costs scrap, never takes a purchase away and never adds ammo.
   */
  private restoreAmmo(): void {
    for (const [id, a] of this.startAmmo) {
      const q = this.players.get(id);
      if (!q) continue;
      // In place: p.ammo is the wallet's own object.
      const ammo = q.wallet.ammo;
      ammo.rivets = a.rivets;
      ammo.mines = a.mines;
      let refund = 0;
      for (const b of this.retiredBuys.get(id) ?? []) {
        if (ammo[b.item] >= AMMO[b.item].cap) refund += b.paid;
        else ammo[b.item] = Math.min(AMMO[b.item].cap, ammo[b.item] + AMMO[b.item].pack);
      }
      if (refund > 0) {
        q.wallet.scrap += refund;
        this.sendGarage(q);
      }
    }
  }

  /**
   * Host only, lobby only: race on another track. Picking a different track resets everyone's
   * ready flag (they agreed to the old one); picking the current one changes nothing.
   */
  setTrack(p: Player, id: unknown): string | null {
    if (p.id !== this.hostId) return "Only the host can pick the track";
    if (this.phase !== "lobby") return "The track can only be changed in the lobby";
    if (!isTrackId(id)) return "Unknown track";
    if (id === this._trackId) return null;
    this._trackId = id;
    this._track = trackById(id);
    this._combat = this.newCombat(); // no shots or mines exist in the lobby
    for (const q of this.players.values()) q.ready = false;
    this.broadcastRoom();
    return null;
  }

  /** Lobby ready toggle. Ignored from the host, outside the lobby and for non-booleans. */
  setReady(p: Player, ready: unknown): void {
    if (this.phase !== "lobby" || p.id === this.hostId || typeof ready !== "boolean" || p.ready === ready) return;
    p.ready = ready;
    this.broadcastRoom();
  }

  /**
   * Garage purchase: between races, and for a player who retired from the running race. An ammo
   * pack a retired player buys is noted, so a stop or a restart (which gives back the ammo the
   * race used) can replay it (restoreAmmo).
   */
  buy(p: Player, item: unknown): string | null {
    if (this.phase !== "lobby" && !(this.phase === "racing" && p.retired)) return "The garage is closed during a race";
    if (!isItem(item)) return "Unknown item";
    const scrap = p.wallet.scrap;
    const e = buy(p.wallet, item);
    if (e) return e;
    if (this.phase === "racing" && (item === "rivets" || item === "mines") && this.startAmmo.has(p.id)) {
      const list = this.retiredBuys.get(p.id) ?? [];
      list.push({ item, paid: scrap - p.wallet.scrap });
      this.retiredBuys.set(p.id, list);
    }
    this.sendGarage(p);
    return null;
  }

  queueInputs(p: Player, tuples: unknown): void {
    if (!p.car || !Array.isArray(tuples)) return;
    for (const t of tuples.slice(-MAX_INPUTS_PER_MSG)) {
      if (!Array.isArray(t) || t.length < 3 || t.length > 4) continue;
      const [seq, throttle, steer, buttons = 0] = t;
      if (!Number.isInteger(seq) || seq <= p.lastQueuedSeq) continue;
      if (!Number.isFinite(throttle) || !Number.isFinite(steer)) continue;
      p.lastQueuedSeq = seq;
      p.queue.push({
        seq,
        cmd: {
          throttle: Math.max(-1, Math.min(1, throttle)),
          steer: Math.max(-1, Math.min(1, steer)),
          buttons: Number.isInteger(buttons) ? buttons & 15 : 0,
        },
      });
    }
    if (p.queue.length > QUEUE_MAX) p.queue.splice(0, p.queue.length - QUEUE_TRIM);
  }

  tick(tick: number, now: number): void {
    this.tickNo = tick;
    if (this.paused) this.pauseTimers(now);
    if (this.paused) this.pausedTick(now);
    else this.simulate(tick, now);

    for (const p of [...this.players.values()]) {
      if (!p.session && now - p.disconnectedAt > RECONNECT_GRACE_MS) this.remove(p, now);
    }

    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots(tick, now);
  }

  /** Phase timers and one simulation step (skipped while paused). */
  private simulate(tick: number, now: number): void {
    // Phase timers first, so the first racing tick already applies inputs.
    if (this.phase === "countdown" && now >= this.phaseEnds) this.setPhase("racing", 0);
    else if (this.phase === "racing" && this.phaseEnds && now >= this.phaseEnds) this.endRace(now);
    else if (this.phase === "results" && now >= this.phaseEnds) this.toLobby(now);

    const racing = this.phase === "racing";
    // Weapons stay cold for the first seconds after GO. consumeInput still moves mineBase,
    // so a mine press in that window is discarded rather than dropped later.
    const armed = racing && now >= this.raceStart + WEAPONS_ARM_MS;
    const racers = [...this.players.values()].filter((p) => p.car); // a retired player has none
    const prev = new Map<string, { x: number; y: number }>();
    const recovered = new Set<Player>();
    for (const p of racers) {
      const c = p.car!;
      prev.set(p.id, { x: c.x, y: c.y });
      if (p.held > 0) {
        // Resumed: the car stands where the pause left it until its driver's inputs are in.
        if (p.queue.length >= QUEUE_START || !p.session) p.held = 0;
        else if (--p.held > 0) continue;
      }
      // Consumed every tick, wrecked or not, so ack keeps moving.
      const { cmd, minePress } = consumeInput(p);
      // A car put back at a recovery point after a fall is ghosted (as after a wreck), from
      // this tick's car-car pass on.
      if (stepRaceCar(c, racing ? cmd : NO_INPUT, p.stats, this.track) === "recover") {
        p.ghost = GHOST_TICKS;
        recovered.add(p);
      }
      this.combat.act(p, cmd, minePress, armed);
    }
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) {
        if (solid(racers[i]) && solid(racers[j])) collideCars(racers[i].car!, racers[j].car!);
      }
    }

    if (racing) {
      this.combat.step(racers, prev, recovered);
      for (const p of racers) {
        // No progress while falling: the car sits where it fell (possibly lost, off its own
        // section) until it is put back, and moving back to the recovery point never counts.
        if (p.car!.fall > 0) continue;
        if (!advance(this.track, p.progress!, p.car!) || p.progress!.fin) continue;
        const pr = p.progress!;
        if (pr.lap < this.laps) {
          this.event(tick, { k: "lap", id: p.id, lap: pr.lap });
          continue;
        }
        pr.fin = Math.max(1, Math.round(now - this.raceStart));
        p.finished = true;
        this.finishers++;
        this.event(tick, { k: "finish", id: p.id, place: this.finishers, timeMs: pr.fin });
        if (this.finishers === 1) this.phaseEnds = now + FINISH_GRACE_MS;
      }
      // Retired players have no car: they are not waited for. Nobody left on the field (all
      // retired or gone, no finisher) -> back to the lobby with no results.
      if (racers.length > 0 && racers.every((p) => p.progress!.fin)) this.endRace(now);
      else if (racers.length === 0) this.toLobby(now);
    }
  }

  private endRace(now: number): void {
    // Keyed on progress, not car: a retired player (no car) keeps a DNF row and the wreck bonus,
    // ranked among the non-finishers by the distance driven when they retired, like any other
    // DNF (user decision 2026-11-18: retiring must not buy the front of the reversed grid).
    const rows: { id: string; fin: number; rd: number; p: Player }[] = [];
    for (const p of this.players.values()) {
      if (!p.progress) continue;
      rows.push({ id: p.id, fin: p.progress.fin, rd: raceDistance(this.track, p.progress), p });
    }
    rows.sort(compareStanding);
    this.clearPause(); // a race over while paused (nobody left on the field) takes the pause with it
    const earned = payouts(rows, this.combat.wrecksCaused);
    this.lastOrder = rows.map((r) => r.id);
    const results: ResultRow[] = rows.map(({ id, fin, p }) => {
      const e = earned.get(id) ?? 0;
      p.wallet.scrap += e;
      return { id, name: p.name, color: p.color, timeMs: fin, earned: e };
    });
    this.setPhase("results", now + RESULTS_MS);
    this.broadcast({ t: "results", rows: results });
    for (const r of rows) this.sendGarage(r.p);
    // One result line per race, finishers only (endRace always has a winner).
    const [winner, ...rest] = results.filter((r) => r.timeMs > 0);
    if (winner) {
      const tail = rest.map((r, i) => `${PLACES[i + 1]} ${r.name}`).join(", ");
      this.addLine("result", "", winner.color, `Race won by ${winner.name}${tail ? ` — ${tail}` : ""}`);
    }
  }

  /** lobbyAt: when the lobby counts as opened (FORCE_START_MS); a stop backdates it. */
  private toLobby(now: number, lobbyAt = now): void {
    this.lobbyAt = lobbyAt;
    this.clearRace();
    this.raceStart = 0;
    this.setPhase("lobby", 0);
  }

  /** Every car, shot and mine gone, offline players' too. */
  private clearRace(): void {
    this.clearPause();
    for (const p of this.players.values()) {
      p.car = null;
      p.progress = null;
      p.inRace = false;
      p.retired = false;
      p.finished = false;
      resetQueue(p);
    }
    this.combat.reset();
    this.startAmmo.clear();
    this.retiredBuys.clear();
  }

  private setPhase(phase: Phase, ends: number): void {
    this.phase = phase;
    this.phaseEnds = ends;
    this.broadcastRoom();
  }

  private event(tick: number, ev: GameEvent): void {
    this.broadcast({ t: "ev", tick, ev });
  }

  private sendGarage(p: Player): void {
    p.session?.conn.send({ t: "garage", scrap: p.wallet.scrap, levels: { ...p.wallet.levels } });
  }

  private sendSnapshots(tick: number, now: number): void {
    const ents: EntSnap[] = [];
    for (const p of this.players.values()) {
      const c = p.car;
      if (!c || !p.progress) continue;
      ents.push({
        k: "car",
        id: p.id,
        x: round(c.x, 2),
        y: round(c.y, 2),
        h: round(c.h, 4),
        vx: round(c.vx, 2),
        vy: round(c.vy, 2),
        seg: c.seg,
        lap: p.progress.lap,
        rd: round(raceDistance(this.track, p.progress), 1),
        fin: p.progress.fin,
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        wreck: c.wreck,
        air: c.air,
        fall: c.fall,
        ghost: p.ghost > 0 || p.finished,
      });
    }
    ents.push(...this.combat.shotSnaps(), ...this.combat.mineSnaps());
    const time = round(now, 1);
    for (const p of this.players.values()) {
      p.session?.conn.send({
        t: "snap",
        tick,
        time,
        phase: this.phase,
        phaseEnds: this.phaseEnds,
        ack: p.ack,
        ammo: [p.wallet.ammo.rivets, p.wallet.ammo.mines],
        ents,
      });
    }
  }

  info(): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      inRace: p.inRace,
      connected: !!p.session,
      ready: p.ready && p.id !== this.hostId, // a new host's old flag is not shown
      retired: p.retired,
    }));
  }

  broadcastRoom(): void {
    this.broadcast({
      t: "room",
      hostId: this.hostId,
      phase: this.phase,
      raceStart: this.raceStart,
      forceStartAt: this.forceStartAt,
      trackId: this._trackId,
      locked: this.locked,
      paused: this.paused,
      pausedBy: this.pausedBy,
      pausedAt: this.pausedAt,
      resumeAt: this.resumeAt,
      players: this.info(),
    });
  }

  private broadcast(msg: ServerMsg): void {
    for (const p of this.players.values()) p.session?.conn.send(msg);
  }
}

function resetQueue(p: Player): void {
  p.held = 0;
  p.queue.length = 0;
  p.buffering = true;
  p.lastInput = NO_COMMAND;
  p.starved = 0;
  p.mineBase = null;
}

/**
 * Take this tick's command from the player's jitter buffer. A mine press is reported only
 * when a real input's mine counter differs from the last real input's; repeats on underrun
 * never fire the rivet gun and never drop a mine.
 */
function consumeInput(p: Player): { cmd: Command; minePress: boolean } {
  if (p.buffering && p.queue.length >= QUEUE_START) p.buffering = false;
  if (!p.buffering) {
    const next = p.queue.shift();
    if (next) {
      p.ack = next.seq;
      p.lastInput = next.cmd;
      p.starved = 0;
      const count = mineCount(next.cmd.buttons);
      const minePress = p.mineBase !== null && count !== p.mineBase;
      p.mineBase = count;
      return { cmd: next.cmd, minePress };
    }
    p.buffering = true; // underrun: wait for the buffer to refill
  }
  p.starved++;
  const last = p.lastInput;
  const buttons = last.buttons & ~BTN_RIVET;
  const cmd =
    p.starved <= REPEAT_TICKS ? { throttle: last.throttle, steer: last.steer, buttons } : { ...NO_COMMAND, buttons };
  return { cmd, minePress: false };
}

export class Rooms {
  readonly rooms = new Map<string, Room>();
  private tickNo = 0;

  constructor(
    private readonly laps: number,
    private readonly hp: number = CAR_HP,
    private readonly maxRooms: number = Infinity,
  ) {}

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  onMessage(session: Session, msg: ClientMsg | null, now: number): void {
    if (!msg || typeof msg !== "object") return;
    const err = (m: string, code?: ErrCode) => session.conn.send({ t: "err", msg: m, code });
    switch (msg.t) {
      case "create": {
        if (session.room) return err("Already in a room");
        if (this.rooms.size >= this.maxRooms) return err("The server is full right now, try again later", "busy");
        const room = new Room(this.newCode(), this.laps, this.hp);
        this.rooms.set(room.code, room);
        room.addPlayer(cleanName(msg.name), session, now);
        return;
      }
      case "join": {
        if (session.room) return err("Already in a room");
        const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
        const room = this.rooms.get(code);
        if (!room) return err(`No room with code ${code || "(empty)"}`, "gone");
        const existing = room.playerByToken(msg.token);
        if (existing) return room.bind(existing, session);
        // A removed player's token, then the lock: neither lets a new player in.
        if (room.isBlocked(msg.token)) return err("You were removed from this room", "kicked");
        if (room.locked) return err("This room is locked", "locked");
        const res = room.addPlayer(cleanName(msg.name), session, now);
        if (typeof res === "string") err(res, "full");
        return;
      }
      case "start": {
        if (!session.room || !session.player) return;
        const e = session.room.start(session.player, now, msg.force === true);
        if (e) err(e);
        return;
      }
      case "ready":
        if (session.room && session.player) session.room.setReady(session.player, msg.ready);
        return;
      case "track": {
        if (!session.room || !session.player) return;
        const e = session.room.setTrack(session.player, msg.id);
        if (e) err(e);
        return;
      }
      case "buy": {
        if (!session.room || !session.player) return;
        const e = session.room.buy(session.player, msg.item);
        if (e) err(e);
        return;
      }
      case "in":
        if (session.room && session.player) session.room.queueInputs(session.player, msg.i);
        return;
      case "ping":
        session.conn.send({ t: "pong", c: Number(msg.c) || 0, s: round(now, 1) });
        return;
      case "chat":
        if (session.room && session.player) session.room.chat(session.player, msg.text, now);
        return;
      case "retire": {
        if (!session.room || !session.player) return;
        const e = session.room.retire(session.player);
        if (e) err(e);
        return;
      }
      case "leave":
        if (session.room && session.player) session.room.leave(session.player, now);
        session.conn.close();
        return;
      case "pause":
      case "resume": {
        if (!session.room || !session.player) return;
        const e = msg.t === "pause" ? session.room.pause(session.player, now) : session.room.resume(session.player, now);
        if (e) err(e);
        return;
      }
      case "stop":
      case "restart":
      case "kick":
      case "host":
      case "lock": {
        const room = session.room;
        const player = session.player;
        if (!room || !player) return;
        const e =
          msg.t === "stop"
            ? room.stopRace(player, now)
            : msg.t === "restart"
              ? room.restartRace(player, now)
              : msg.t === "kick"
                ? room.kick(player, msg.id, now)
                : msg.t === "host"
                  ? room.setHost(player, msg.id, now)
                  : room.setLocked(player, msg.locked);
        if (e) err(e);
        return;
      }
    }
  }

  onClose(session: Session, now: number): void {
    if (session.room && session.player) session.room.unbind(session.player, now);
  }

  /** One fixed simulation step for every room. */
  step(now: number): void {
    this.tickNo++;
    for (const [code, room] of this.rooms) {
      room.tick(this.tickNo, now);
      if (room.empty) this.rooms.delete(code);
    }
  }
}
