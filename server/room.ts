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
import { buy, clampAmmo, isItem, payouts, startingWallet, statsFor, type Wallet } from "../shared/shop";
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
  private readonly chatLog: ChatLine[] = []; // the last CHAT_HISTORY lines; gone with the room
  private chatSeq = 0;
  // Room-wide budgets (shared/protocol.ts CHAT_ROOM_*, CHAT_COMINGS_*); full at the start.
  private readonly sayBudget: Bucket = { tokens: CHAT_ROOM_BURST, at: -Infinity };
  private readonly comingsBudget: Bucket = { tokens: CHAT_COMINGS_BURST, at: -Infinity };

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
    this.broadcastRoom();
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
    this.broadcastRoom();
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
    for (const q of this.players.values()) q.ready = false; // everyone readies again next time
    this.combat.reset();
    this.startAmmo.clear();
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

  /** Give each racer of the current race the ammo they started it with. */
  private restoreAmmo(): void {
    for (const [id, a] of this.startAmmo) {
      const q = this.players.get(id);
      if (!q) continue;
      // In place: p.ammo is the wallet's own object.
      q.wallet.ammo.rivets = a.rivets;
      q.wallet.ammo.mines = a.mines;
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

  /** Garage purchase; only between races. */
  buy(p: Player, item: unknown): string | null {
    if (this.phase !== "lobby") return "The garage is closed during a race";
    if (!isItem(item)) return "Unknown item";
    const e = buy(p.wallet, item);
    if (!e) this.sendGarage(p);
    return e;
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
    // Phase timers first, so the first racing tick already applies inputs.
    if (this.phase === "countdown" && now >= this.phaseEnds) this.setPhase("racing", 0);
    else if (this.phase === "racing" && this.phaseEnds && now >= this.phaseEnds) this.endRace(now);
    else if (this.phase === "results" && now >= this.phaseEnds) this.toLobby(now);

    const racing = this.phase === "racing";
    // Weapons stay cold for the first seconds after GO. consumeInput still moves mineBase,
    // so a mine press in that window is discarded rather than dropped later.
    const armed = racing && now >= this.raceStart + WEAPONS_ARM_MS;
    const racers = [...this.players.values()].filter((p) => p.car);
    const prev = new Map<string, { x: number; y: number }>();
    const recovered = new Set<Player>();
    for (const p of racers) {
      const c = p.car!;
      prev.set(p.id, { x: c.x, y: c.y });
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
      if (racers.length > 0 && racers.every((p) => p.progress!.fin)) this.endRace(now);
      else if (racers.length === 0) this.toLobby(now);
    }

    for (const p of [...this.players.values()]) {
      if (!p.session && now - p.disconnectedAt > RECONNECT_GRACE_MS) this.remove(p, now);
    }

    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots(tick, now);
  }

  private endRace(now: number): void {
    const rows: { id: string; fin: number; rd: number; p: Player }[] = [];
    for (const p of this.players.values()) {
      if (!p.car || !p.progress) continue;
      rows.push({ id: p.id, fin: p.progress.fin, rd: raceDistance(this.track, p.progress), p });
    }
    rows.sort(compareStanding);
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
    for (const p of this.players.values()) {
      p.car = null;
      p.progress = null;
      p.inRace = false;
      p.finished = false;
      resetQueue(p);
    }
    this.combat.reset();
    this.startAmmo.clear();
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
      players: this.info(),
    });
  }

  private broadcast(msg: ServerMsg): void {
    for (const p of this.players.values()) p.session?.conn.send(msg);
  }
}

function resetQueue(p: Player): void {
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
      case "leave":
        if (session.room && session.player) session.room.leave(session.player, now);
        session.conn.close();
        return;
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
