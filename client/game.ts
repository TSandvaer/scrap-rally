// Client game state and netcode: own-car prediction + reconciliation, interpolation of
// the other cars, shots and mines, and the server clock estimate. No DOM access, so the
// headless bot test drives exactly this code.

import { angleDiff, BASE_STATS, CAR_RADIUS, cloneCar, TICK_HZ, wallLimit, type CarState, type CarStats, type Input } from "../shared/physics";
import {
  CHAT_HISTORY,
  CHAT_MAX,
  INPUT_REDUNDANCY,
  round,
  type CarSnap,
  type ChatLine,
  type ClientMsg,
  type GameEvent,
  type InputTuple,
  type MineSnap,
  type Phase,
  type PlayerInfo,
  type ResultRow,
  type ServerMsg,
  type ShotSnap,
} from "../shared/protocol";
import { statsFor, type Levels } from "../shared/shop";
import { queryTrackNear, type Track } from "../shared/track";
import { DEFAULT_TRACK_ID, findTrack, trackById } from "../shared/tracks";
import {
  airHeight,
  BTN_RIVET,
  FALL_TICKS,
  makeButtons,
  moveShot,
  RIVET_COOLDOWN,
  spawnShot,
  stepRaceCar,
  WEAPONS_ARM_MS,
  type Command,
  type Shot,
} from "../shared/weapons";
import { Contacts } from "./contact";
import type { Transport } from "./net";

const INTERP_DELAY_MS = 100; // other cars are drawn this far in the past
const EXTRAP_MAX_MS = 100; // how far past the newest snapshot we dare to extrapolate
const OFFSET_WINDOW_MS = 2000; // clock offset = best sample in this window
const SNAP_KEEP_MS = 1000;
const SMOOTH_TAU_MS = 35; // visual correction decays with this time constant (~100 ms)
const SNAP_DISTANCE = 120; // corrections bigger than this are applied instantly
const MAX_PENDING = 180;
const MAX_ERROR_SAMPLES = 20000;
const PING_EVERY_MS = 2000;
const RECONNECT_DELAY_MS = 1000;
const RECONNECT_TRIES = 15;

export interface TokenStore {
  get(code: string): string | null;
  set(code: string, token: string): void;
}

/** What the player (or a bot) does this step. */
export interface Controls extends Input {
  fire: boolean; // rivet gun held
  mine: boolean; // mine key pressed since the last step
}

export const NO_CONTROLS: Controls = { throttle: 0, steer: 0, fire: false, mine: false };

/**
 * Own-car sound cues, queued by step() only (reconcile's replays never queue one) and
 * drained by the frame loop (takeOwnSounds; client/sfx.ts). No landing event exists: a
 * landing is the last air tick ending without a fall. A wall hit carries its speed into the
 * wall (wallHitSpeed).
 */
export type OwnSound = "takeoff" | "land" | "fall" | "recover" | "shot" | "mine" | "wall";
export interface OwnCue {
  k: OwnSound;
  speed: number; // wall: units/s into the wall; 0 otherwise
}
const MAX_OWN_SOUNDS = 32; // bots and scripts never drain the queue
const NO_SOUNDS: readonly OwnCue[] = [];
export const WALL_HIT_MIN = 50; // units/s into the wall for a wall-hit cue

/**
 * Speed into the wall a step ended against, from the velocity before the step (collideWalls
 * removes that component, shared/physics.ts): 0 when the car is not at the wall afterwards
 * or was not moving into it. Same normal as the physics (queryTrackNear with the seg hint).
 */
export function wallHitSpeed(before: { vx: number; vy: number }, after: CarState, track: Track): number {
  const q = queryTrackNear(track, after.x, after.y, after.seg);
  if (q.dist < wallLimit(track) - 0.01) return 0;
  return Math.max(0, before.vx * q.nx + before.vy * q.ny);
}

export interface Pose {
  id: string;
  x: number;
  y: number;
  h: number;
  // Drawing only (client/render.ts):
  height?: number; // 0..1, airHeight() of the drawn car; absent or 0 = on the ground
  falling?: number; // 0..1, fraction of the fall elapsed (FALL_TICKS); absent = not falling
  ghost?: boolean; // ghosted (after a recovery or a wreck respawn, or finished): blinks
}

/** A car's air/fall/wreck state, as far as drawing and the no-slide rules care. */
function sameState(a: { air: number; fall: number; wreck: number }, b: { air: number; fall: number; wreck: number }): boolean {
  return a.air > 0 === b.air > 0 && a.fall > 0 === b.fall > 0 && a.wreck > 0 === b.wreck > 0;
}

/** Fraction of the fall elapsed, or undefined when the car is not falling. */
function fallFraction(fall: number): number | undefined {
  return fall > 0 ? (FALL_TICKS - fall) / FALL_TICKS : undefined;
}

/** height / falling for a car drawn between states a and b (fraction t from a to b). */
function airFall(a: CarState, b: CarState, t: number): { height: number; falling?: number } {
  const ha = airHeight(a), hb = airHeight(b);
  const out: { height: number; falling?: number } = { height: ha + (hb - ha) * t };
  const fb = fallFraction(b.fall);
  if (fb !== undefined) {
    const fa = fallFraction(a.fall) ?? fb;
    out.falling = fa + (fb - fa) * t;
  }
  return out;
}

export interface Snapshot {
  time: number;
  cars: Map<string, CarSnap>;
  shots: Map<number, ShotSnap>;
  mines: MineSnap[];
}

interface Pending {
  seq: number;
  cmd: Command;
  fired: boolean; // a rivet left the gun on this step (predicted)
  mine: boolean; // a mine press was sent on this step
}

/**
 * Why a connection changed state. From the server: gone = the room no longer exists,
 * full = room full, taken = seat taken over, busy = the server is full, kicked = the host
 * removed us (or this tab's token was removed), locked = the room takes no new players.
 * restarted = the room is gone after the server announced a restart; restarting = that notice
 * itself; unreachable = no answer.
 */
export type ConnReason = "gone" | "restarted" | "full" | "taken" | "busy" | "kicked" | "locked" | "unreachable" | "restarting";

const LOST_MESSAGES: Partial<Record<ConnReason, string>> = {
  restarted: "The room is gone — the server restarted. Create a new room to play on.",
  gone: "The room was closed while you were away. Create a new room to play on.",
  full: "The room filled up while you were away.",
  taken: "This seat is now being played in another tab or window.",
  busy: "The server is full right now, try again later",
  kicked: "You were removed from the room by the host.",
  locked: "That room is locked: the host is not letting new drivers in.",
};

/** The menu text for connection("lost", reason). wasInRoom: the player had a seat. */
export function lostMessage(reason: ConnReason | undefined, wasInRoom: boolean): string {
  return (reason && LOST_MESSAGES[reason]) ?? (wasInRoom ? "Connection lost" : "Could not reach the server");
}

export interface GameHandlers {
  welcome(): void;
  room(): void;
  garage(): void;
  /** tick: the server tick the event happened in (snapshots carry theirs: snapTick). */
  event(ev: GameEvent, tick: number): void;
  results(rows: ResultRow[]): void;
  /** A live chat line (already in game.chat). */
  chat(line: ChatLine): void;
  /** game.chat was replaced (the room's history after a welcome) or cleared. */
  chatlog(): void;
  error(msg: string): void;
  /**
   * reason: for "reconnecting", "restarting" when the server announced a restart; for
   * "lost", why the seat is gone (no more reconnect attempts).
   */
  connection(state: "connected" | "reconnecting" | "lost", reason?: ConnReason): void;
}

export class Game {
  // Room state
  code = "";
  you = "";
  name = "";
  laps = 0;
  hostId = "";
  players: PlayerInfo[] = [];
  phase: Phase = "lobby";
  phaseEnds = 0;
  raceStart = 0;
  forceStartAt = 0; // server time from which the host may "Start anyway", 0 outside the lobby
  trackId = DEFAULT_TRACK_ID; // the room's track (room message); the default outside a room
  locked = false; // the host locked the room (no new players)
  track: Track = trackById(DEFAULT_TRACK_ID); // built from trackId: prediction, shots, bots, renderer
  results: ResultRow[] | null = null;
  connected = false;
  rtt = 0;
  /** Room chat, oldest first: replaced by every chatlog, cleared on leave and in a new room. */
  chat: ChatLine[] = [];
  private chatCode = ""; // the room `chat` belongs to

  // Garage (server-confirmed only: never updated optimistically)
  scrap = 0;
  levels: Levels = { engine: 0, tyres: 0, welder: 0 };
  stats: CarStats = { ...BASE_STATS };
  serverAmmo: [number, number] = [0, 0]; // [rivets, mines] as of the last snapshot

  // Own car (predicted)
  car: CarState | null = null;
  prevCar: CarState | null = null; // state before the last step, for render interpolation
  readonly smooth = { x: 0, y: 0, h: 0 }; // visual correction offset, decays to 0
  seq = 0;
  pending: Pending[] = [];
  history = new Map<number, CarState>();
  lastAck = -1;
  readonly recErrors: number[] = [];
  /** Acked steps whose predicted air/fall/wreck state differed from the server's. */
  recStateErrors = 0;
  localShots: Shot[] = []; // cosmetic: our own rivets, drawn before the server confirms
  readonly contact = new Contacts(); // own-car bump prediction, near cars' drawn pose
  private ownSounds: OwnCue[] = [];
  private cooldown = 0;
  private mineCounter = 0;
  private localShotId = 1;

  // Everyone (server view)
  snaps: Snapshot[] = [];
  latest: Snapshot | null = null;
  snapTick = 0; // server tick of the last snapshot received

  on: Partial<GameHandlers> = {};

  private transport: Transport | null = null;
  private intent: ClientMsg | null = null;
  private offsetSamples: { at: number; v: number }[] = [];
  private offset = 0;
  private haveOffset = false;
  private lastPing = 0;
  private reconnectTries = 0;
  private restarting = false; // the server announced a restart since the last welcome
  private busy = false; // the latest connection attempt was refused: server full
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly makeTransport: () => Transport,
    private readonly tokens: TokenStore,
  ) {}

  // ---- connection -------------------------------------------------------------------

  create(name: string): void {
    this.name = name;
    this.open({ t: "create", name });
  }

  join(code: string, name: string): void {
    this.name = name;
    this.code = code.trim().toUpperCase();
    this.open(this.joinMsg());
  }

  /** Host only. force: "Start anyway" while players are not ready (from forceStartAt). */
  start(force = false): void {
    this.send(force ? { t: "start", force: true } : { t: "start" });
  }

  /** Non-hosts in the lobby: report ready (or take it back). */
  setReady(ready: boolean): void {
    this.send({ t: "ready", ready });
  }

  buy(item: string): void {
    this.send({ t: "buy", item });
  }

  /** Host only, in the lobby: race on another track (an id from shared/tracks.ts). */
  pickTrack(id: string): void {
    this.send({ t: "track", id });
  }

  // Host room controls (the Esc menu). The server refuses them from anyone else with an err.

  /** Host only, countdown or race: abort it, everyone back to the lobby (no results, no scrap). */
  stopRace(): void {
    this.send({ t: "stop" });
  }

  /** Host only, countdown or race: a fresh countdown on the same track. */
  restartRace(): void {
    this.send({ t: "restart" });
  }

  /** Host only: remove a player at once (their seat token is blocked in this room). */
  kick(id: string): void {
    this.send({ t: "kick", id });
  }

  /** Host only: hand the host over to a connected player. */
  makeHost(id: string): void {
    this.send({ t: "host", id });
  }

  /** Host only: lock the room (no new players; seat rejoins still work) or unlock it. */
  setLocked(locked: boolean): void {
    this.send({ t: "lock", locked });
  }

  /** Say something in the room chat. The server cleans it; it comes back as a chat line. */
  say(text: string): void {
    const t = [...text.trim()].slice(0, CHAT_MAX).join("");
    if (t) this.send({ t: "chat", text: t });
  }

  /** Drop the connection as a network failure would; the client then reconnects. */
  simulateDrop(): void {
    const tr = this.transport;
    tr?.close();
  }

  /** Leave for good (no reconnect): the server removes us at once, the chat is cleared. */
  leave(): void {
    this.intent = null;
    this.cancelReconnect();
    const tr = this.transport;
    this.transport = null;
    if (this.connected) tr?.send({ t: "leave" });
    tr?.close();
    this.connected = false;
    this.restarting = false;
    this.busy = false;
    this.code = "";
    this.you = "";
    this.players = [];
    this.hostId = "";
    this.phase = "lobby";
    this.raceStart = 0;
    this.forceStartAt = 0;
    this.locked = false;
    this.results = null;
    this.resetOwnCar();
    this.snaps = [];
    this.latest = null;
    this.useTrack(DEFAULT_TRACK_ID);
    this.setChat([], "");
  }

  private setChat(lines: ChatLine[], code: string): void {
    const changed = this.chat.length > 0 || lines.length > 0;
    this.chat = lines.slice(-CHAT_HISTORY);
    this.chatCode = code;
    if (changed) this.on.chatlog?.();
  }

  /**
   * Race on the room's track from now on. Only changes in the lobby (no cars), but a car
   * predicted on the old track is dropped anyway: the next snapshot seeds it again. An id
   * this build does not know (client older than the server) falls back to the default.
   */
  private useTrack(id: string): void {
    if (id === this.trackId) return;
    this.trackId = id;
    this.track = findTrack(id) ?? trackById(DEFAULT_TRACK_ID);
    this.resetOwnCar();
  }

  private resetOwnCar(): void {
    this.car = null;
    this.prevCar = null;
    this.pending = [];
    this.history.clear();
    this.localShots = [];
    this.cooldown = 0;
    this.contact.reset();
    this.ownSounds = [];
  }

  private joinMsg(): ClientMsg {
    const token = this.tokens.get(this.code) ?? undefined;
    return { t: "join", code: this.code, name: this.name, token };
  }

  private open(hello: ClientMsg): void {
    this.cancelReconnect();
    const old = this.transport;
    this.transport = null;
    old?.close();
    this.intent = hello;
    this.busy = false;
    const tr = this.makeTransport();
    this.transport = tr;
    tr.onOpen = () => {
      if (this.transport !== tr || !this.intent) return;
      tr.send(this.intent);
    };
    tr.onMessage = (msg) => {
      if (this.transport === tr) this.handle(msg);
    };
    tr.onClose = () => {
      if (this.transport !== tr) return;
      this.transport = null;
      this.connected = false;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    // Only rejoin a room we were welcomed into; a failed create/join is just an error.
    if (!this.you || !this.code || !this.intent) {
      this.on.connection?.("lost", "unreachable");
      return;
    }
    if (this.reconnectTries >= RECONNECT_TRIES) {
      this.on.connection?.("lost", this.busy ? "busy" : "unreachable");
      return;
    }
    this.on.connection?.("reconnecting", this.restarting ? "restarting" : undefined);
    this.reconnectTries++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(this.joinMsg());
    }, RECONNECT_DELAY_MS);
  }

  /** Give up on this seat for good: no socket, no reconnect. */
  private stop(reason: ConnReason): void {
    this.intent = null;
    this.cancelReconnect();
    this.detach();
    this.on.connection?.("lost", reason);
  }

  /** Close the current socket without triggering a reconnect. */
  private detach(): void {
    const tr = this.transport;
    this.transport = null;
    this.connected = false;
    tr?.close();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private send(msg: ClientMsg): void {
    if (this.connected) this.transport?.send(msg);
  }

  // ---- messages ---------------------------------------------------------------------

  private handle(msg: ServerMsg): void {
    const now = performance.now();
    switch (msg.t) {
      case "welcome":
        if (msg.code !== this.code) {
          this.snaps = [];
          this.latest = null;
          this.results = null;
        }
        if (msg.code !== this.chatCode) this.setChat([], msg.code); // the chatlog follows
        this.code = msg.code;
        this.you = msg.you;
        this.laps = msg.laps;
        this.tokens.set(msg.code, msg.token);
        this.connected = true;
        this.reconnectTries = 0;
        this.restarting = false;
        // Sequence numbers restart with every welcome; the server reset its queue too.
        this.seq = 0;
        this.lastAck = -1;
        this.resetOwnCar();
        this.intent = this.joinMsg();
        this.on.connection?.("connected");
        this.on.welcome?.();
        return;
      case "room":
        // A new race (a restart above all: the cars go back to the grid mid-race) drops the
        // predicted car; the next snapshot seeds it at the new pose. Else the replay of old
        // inputs from the grid would look like a teleport to reconciliation.
        if (msg.raceStart !== this.raceStart) this.resetOwnCar();
        this.hostId = msg.hostId;
        this.phase = msg.phase;
        this.raceStart = msg.raceStart;
        this.forceStartAt = msg.forceStartAt;
        this.locked = msg.locked === true;
        this.useTrack(msg.trackId);
        this.players = msg.players;
        if (msg.phase !== "results") this.results = null;
        this.on.room?.();
        return;
      case "garage":
        this.scrap = msg.scrap;
        this.levels = msg.levels;
        this.stats = statsFor(msg.levels);
        this.on.garage?.();
        return;
      case "err":
        if (msg.code === "taken" || msg.code === "kicked" || msg.code === "locked") {
          // Another tab or window took this seat: do not take it back (no ping-pong). Removed
          // by the host, or a locked room: retrying would only be refused again. The stored
          // token stays, so typing the code again still meets the block.
          this.stop(msg.code);
          return;
        }
        if (msg.code === "restarting") {
          this.restarting = true; // the server closes the socket next; we reconnect
          return;
        }
        if (msg.code === "busy") {
          if (!this.you) {
            this.stop("busy"); // create/join refused: the server is full
          } else if (!this.connected) {
            this.busy = true; // rejoin refused: the server closes, we retry while the seat lasts
          }
          return;
        }
        if (this.you && !this.connected && (msg.code === "gone" || msg.code === "full")) {
          // Rejoin after a drop failed: the room no longer exists or filled up. Blame a
          // restart only if the server announced one; otherwise the room closed while we
          // were away (e.g. everyone was gone longer than the reconnect grace).
          this.stop(msg.code === "gone" && this.restarting ? "restarted" : msg.code);
          return;
        }
        if (!this.you) this.detach(); // failed create/join: the socket is no longer needed
        this.on.error?.(msg.msg);
        return;
      case "ev":
        this.on.event?.(msg.ev, msg.tick);
        return;
      case "results":
        this.results = msg.rows;
        this.on.results?.(msg.rows);
        return;
      case "chatlog":
        this.setChat(msg.lines, this.code);
        return;
      case "chat":
        this.chat.push(msg.line);
        if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
        this.on.chat?.(msg.line);
        return;
      case "pong": {
        const sample = now - msg.c;
        this.rtt = this.rtt ? this.rtt * 0.7 + sample * 0.3 : sample;
        return;
      }
      case "snap":
        this.onSnapshot(msg, now);
        return;
    }
  }

  private onSnapshot(msg: Extract<ServerMsg, { t: "snap" }>, now: number): void {
    // Clock: keep the minimum-latency sample of the last few seconds.
    this.offsetSamples.push({ at: now, v: msg.time - now });
    while (this.offsetSamples.length && this.offsetSamples[0].at < now - OFFSET_WINDOW_MS) {
      this.offsetSamples.shift();
    }
    this.offset = Math.max(...this.offsetSamples.map((s) => s.v));
    this.haveOffset = true;

    this.phase = msg.phase;
    this.phaseEnds = msg.phaseEnds;
    this.serverAmmo = msg.ammo;
    this.snapTick = msg.tick;
    const snap: Snapshot = { time: msg.time, cars: new Map(), shots: new Map(), mines: [] };
    for (const e of msg.ents) {
      if (e.k === "car") snap.cars.set(e.id, e);
      else if (e.k === "shot") snap.shots.set(e.id, e);
      else snap.mines.push(e);
    }
    if (!this.latest || msg.time > this.latest.time) {
      this.snaps.push(snap);
      this.latest = snap;
    }
    while (this.snaps.length > 2 && this.snaps[0].time < msg.time - SNAP_KEEP_MS) this.snaps.shift();

    const mine = snap.cars.get(this.you);
    if (!mine) {
      this.resetOwnCar();
      return;
    }
    const server: CarState = {
      x: mine.x,
      y: mine.y,
      h: mine.h,
      vx: mine.vx,
      vy: mine.vy,
      seg: mine.seg,
      wreck: mine.wreck,
      air: mine.air,
      fall: mine.fall,
    };
    if (!this.car) {
      this.car = server;
      this.prevCar = cloneCar(server);
      this.pending = this.pending.filter((p) => p.seq > msg.ack);
      this.lastAck = msg.ack;
      this.contact.setBase(snap, this.you);
      return;
    }
    this.reconcile(server, msg.ack, snap);
  }

  private reconcile(server: CarState, ack: number, snap: Snapshot): void {
    const kOld = this.pending.length;
    const predicted = this.history.get(ack);
    if (predicted && ack > this.lastAck) {
      const err = Math.hypot(predicted.x - server.x, predicted.y - server.y);
      if (this.recErrors.length < MAX_ERROR_SAMPLES) this.recErrors.push(err);
      if (!sameState(predicted, server)) this.recStateErrors++;
    }
    if (ack > this.lastAck) this.lastAck = ack;
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    for (const k of this.history.keys()) if (k <= ack) this.history.delete(k);

    // Rewind to the server state and replay what the server has not seen yet. Replay goes
    // through stepRaceCar, so a wreck freeze and the respawn jump, jumps, falls and the
    // recovery are predicted too, and bumps: pending[i] is applied i + 1 ticks after this
    // snapshot.
    this.contact.rebase(snap, this.you, kOld, this.pending.length);
    const old = this.car!;
    const c = cloneCar(server);
    this.pending.forEach((p, i) => {
      stepRaceCar(c, p.cmd, this.stats, this.track);
      this.contact.collide(c, i + 1);
      this.history.set(p.seq, cloneCar(c));
    });
    this.car = c;

    // Hide the jump: shift the render offset (and the interpolation start) by it. Wreck, air
    // and fall state changes (a take-off, a landing, a fall or a recovery a tick off) and
    // big jumps are shown as they are.
    const dx = old.x - c.x;
    const dy = old.y - c.y;
    const dh = angleDiff(c.h, old.h);
    if (Math.hypot(dx, dy) > SNAP_DISTANCE || !sameState(old, c)) {
      this.smooth.x = this.smooth.y = this.smooth.h = 0;
      this.prevCar = cloneCar(c);
      return;
    }
    this.smooth.x += dx;
    this.smooth.y += dy;
    this.smooth.h += dh;
    if (this.prevCar) {
      this.prevCar.x -= dx;
      this.prevCar.y -= dy;
      this.prevCar.h -= dh;
    }
  }

  // ---- per fixed step ---------------------------------------------------------------

  /** The race is on as far as this client can tell: only then is input applied. */
  raceOn(): boolean {
    return this.phase === "racing" || (this.phase === "countdown" && this.serverNow() >= this.phaseEnds);
  }

  /** Time until weapons arm in this race (estimated server time, ms); 0 once armed. */
  armsInMs(): number {
    return Math.max(0, this.raceStart + WEAPONS_ARM_MS - this.serverNow());
  }

  /**
   * Our car can shoot and drop mines: the race is on, the weapons-armed delay is over, and
   * the car is not wrecked, airborne, falling, ghosted or finished (the server's solid()).
   */
  armed(): boolean {
    const c = this.car;
    const s = this.latest?.cars.get(this.you);
    return !!c && c.wreck === 0 && c.air === 0 && c.fall === 0 && !!s && !s.ghost && this.raceOn() && this.armsInMs() === 0;
  }

  /** Ammo minus what we already fired in inputs the server has not consumed yet. */
  predictedAmmo(): [number, number] {
    let r = this.serverAmmo[0];
    let m = this.serverAmmo[1];
    for (const p of this.pending) {
      if (p.fired) r--;
      if (p.mine) m--;
    }
    return [Math.max(0, r), Math.max(0, m)];
  }

  /** Advance one fixed step (DT) with the player's controls. */
  step(ctl: Controls, stepMs: number): void {
    const k = Math.exp(-stepMs / SMOOTH_TAU_MS);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.h *= k;

    const now = performance.now();
    if (this.connected && now - this.lastPing > PING_EVERY_MS) {
      this.lastPing = now;
      this.send({ t: "ping", c: round(now, 1) });
    }
    this.moveLocalShots();
    if (!this.car || !this.connected) return;

    const on = this.raceOn();
    const armed = this.armed();
    const [rivets, mines] = this.predictedAmmo();
    const minePress = ctl.mine && armed && mines > 0;
    if (minePress) this.mineCounter = (this.mineCounter + 1) & 7;
    // Round before use so the server applies exactly what we predicted with. The fire bit is
    // only sent once we are armed: our serverNow runs behind the server, which reads the
    // input later still, so an earlier bit would fire rivets we never predicted.
    const cmd: Command = on
      ? {
          throttle: round(ctl.throttle, 2),
          steer: round(ctl.steer, 2),
          buttons: makeButtons(ctl.fire && armed, this.mineCounter),
        }
      : { throttle: 0, steer: 0, buttons: makeButtons(false, this.mineCounter) };

    const seq = this.seq++;
    const before = this.car;
    this.prevCar = cloneCar(before);
    if (this.cooldown > 0) this.cooldown--;
    const ev = stepRaceCar(this.car, cmd, this.stats, this.track);
    this.contact.step(this.car, this.pending.length + 1); // the server applies it then
    if (ev) this.cue(ev);
    else if (this.prevCar.air > 0 && this.car.air === 0 && this.car.fall === 0) this.cue("land");
    else if (this.car.air === 0 && this.car.fall === 0 && this.car.wreck === 0) {
      const into = wallHitSpeed(this.prevCar, this.car, this.track); // a driving step: collideWalls ran
      if (into >= WALL_HIT_MIN) this.cue("wall", into);
    }
    // A respawn, a take-off or a recovery: drawn from the new state, no slide into it.
    if ((this.prevCar.wreck > 0 && this.car.wreck === 0) || ev === "takeoff" || ev === "recover") {
      this.prevCar = cloneCar(this.car);
    }

    // Same order as the server: step, then fire from the new pose. A mine press the server
    // will discard (the step took the car off the ground) is not counted as a mine dropped.
    let fired = false;
    const armedNow = this.armed();
    if (cmd.buttons & BTN_RIVET && this.cooldown === 0 && rivets > 0 && armedNow) {
      this.localShots.push(spawnShot(this.car, this.localShotId++, this.you));
      this.cooldown = RIVET_COOLDOWN;
      fired = true;
      this.cue("shot");
    }
    if (minePress && armedNow) this.cue("mine");
    this.pending.push({ seq, cmd, fired, mine: minePress && armedNow });
    this.history.set(seq, cloneCar(this.car));
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.shift()!;
      this.history.delete(dropped.seq);
    }
    const tail: InputTuple[] = this.pending
      .slice(-INPUT_REDUNDANCY)
      .map((p) => [p.seq, p.cmd.throttle, p.cmd.steer, p.cmd.buttons]);
    this.send({ t: "in", i: tail });
  }

  /** The own car's sound cues queued since the last call (client/sfx.ts). */
  takeOwnSounds(): readonly OwnCue[] {
    if (!this.ownSounds.length) return NO_SOUNDS;
    const out = this.ownSounds;
    this.ownSounds = [];
    return out;
  }

  private cue(k: OwnSound, speed = 0): void {
    this.ownSounds.push({ k, speed });
    if (this.ownSounds.length > MAX_OWN_SOUNDS) this.ownSounds.shift();
  }

  /**
   * Cosmetic own rivets: fly until range, a wall, or another car they visibly touch (one the
   * server can hit: not ghosted, wrecked, airborne or falling).
   */
  private moveLocalShots(): void {
    if (!this.localShots.length) return;
    const targets = this.otherPoses().filter((p) => {
      const s = this.latest?.cars.get(p.id);
      return s && !s.ghost && !s.wreck && !s.air && !s.fall;
    });
    const r = CAR_RADIUS + 2;
    this.localShots = this.localShots.filter((s) => {
      if (!moveShot(s, this.track)) return false;
      return !targets.some((t) => (t.x - s.x) ** 2 + (t.y - s.y) ** 2 <= r * r);
    });
  }

  // ---- queries for rendering and HUD ------------------------------------------------

  /** A clock offset exists (first snapshot seen); before that serverNow() is local time. */
  hasClock(): boolean {
    return this.haveOffset;
  }

  /** Estimated server time now (biased slightly late by the one-way latency). */
  serverNow(): number {
    return performance.now() + (this.haveOffset ? this.offset : 0);
  }

  /**
   * Own car pose: interpolated between the last two steps, plus the decaying correction.
   * Height and fall progress come from the predicted car, the ghost from the snapshot.
   */
  ownPose(alpha: number): Pose | null {
    const c = this.car;
    if (!c) return null;
    const p = this.prevCar ?? c;
    return {
      id: this.you,
      x: p.x + (c.x - p.x) * alpha + this.smooth.x,
      y: p.y + (c.y - p.y) * alpha + this.smooth.y,
      h: p.h + angleDiff(p.h, c.h) * alpha + this.smooth.h,
      ...airFall(p, c, alpha),
      ghost: !!this.latest?.cars.get(this.you)?.ghost,
    };
  }

  /** The two snapshots around the interpolation time, and the time itself. */
  private bracket(): { a: Snapshot; b: Snapshot | undefined; t: number } | null {
    if (!this.snaps.length) return null;
    const t = this.serverNow() - INTERP_DELAY_MS;
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i].time > t) i--;
    return { a: this.snaps[i], b: this.snaps[i + 1], t };
  }

  /**
   * Every car except our own predicted one, interpolated in the past, with its height, fall
   * progress and ghost from the snapshots. Across a teleport between the two snapshots (a
   * recovery or a wreck respawn) the car is not interpolated (no slide to a recovery point
   * or a respawn spot): it is drawn as in the older one until the newer one is reached. The
   * start of a fall or a wreck is no teleport and interpolates as usual.
   */
  otherPoses(): Pose[] {
    const out: Pose[] = [];
    const br = this.bracket();
    if (!br) return out;
    const { a, b, t } = br;
    for (const [id, ca] of a.cars) {
      if (id === this.you && this.car) continue;
      const cb = b?.cars.get(id);
      const teleport = cb && ((ca.wreck > 0 && cb.wreck === 0) || (ca.fall > 0 && cb.fall === 0));
      if (b && cb && b.time > a.time && t >= a.time && !teleport) {
        const f = Math.min(1, (t - a.time) / (b.time - a.time));
        out.push({
          id,
          x: ca.x + (cb.x - ca.x) * f,
          y: ca.y + (cb.y - ca.y) * f,
          h: ca.h + angleDiff(ca.h, cb.h) * f,
          ...airFall(ca, cb, f),
          ghost: f < 0.5 ? ca.ghost : cb.ghost,
        });
      } else if (!b) {
        // Extrapolated along the velocity: in the air too (committed flight); the height
        // follows the air ticks left.
        const dt = Math.max(0, Math.min(EXTRAP_MAX_MS, t - a.time)) / 1000;
        const ticks = Math.floor(dt * TICK_HZ);
        const on = { ...ca, air: Math.max(0, ca.air - ticks), fall: ca.fall > 0 ? Math.max(1, ca.fall - ticks) : 0 };
        out.push({ id, x: ca.x + ca.vx * dt, y: ca.y + ca.vy * dt, h: ca.h, ...airFall(on, on, 0), ghost: ca.ghost });
      } else {
        out.push({ id, x: ca.x, y: ca.y, h: ca.h, ...airFall(ca, ca, 0), ghost: ca.ghost });
      }
    }
    // Cars that only exist in the newer snapshot (just spawned).
    if (b) {
      for (const [id, cb] of b.cars) {
        if (a.cars.has(id) || (id === this.you && this.car)) continue;
        out.push({ id, x: cb.x, y: cb.y, h: cb.h, ...airFall(cb, cb, 0), ghost: cb.ghost });
      }
    }
    return out;
  }

  /** Other players' rivets at the interpolation time (ours are drawn from localShots). */
  otherShots(): { x: number; y: number; vx: number; vy: number }[] {
    const br = this.bracket();
    if (!br) return [];
    const { a, b, t } = br;
    const out: { x: number; y: number; vx: number; vy: number }[] = [];
    for (const s of a.shots.values()) {
      if (s.o === this.you) continue;
      // Straight-line motion: extrapolate from `a`. A shot gone by `b` hit something
      // between the two snapshots; stop it halfway rather than draw it through a car.
      let dt = Math.max(0, Math.min(EXTRAP_MAX_MS, t - a.time));
      if (b && !b.shots.has(s.id)) dt = Math.min(dt, (b.time - a.time) / 2);
      out.push({ x: s.x + (s.vx * dt) / 1000, y: s.y + (s.vy * dt) / 1000, vx: s.vx, vy: s.vy });
    }
    return out;
  }

  /** The snapshot other cars, shots and mines are drawn from: the older one at the interpolation time. */
  interpSnapshot(): Snapshot | null {
    return this.bracket()?.a ?? null;
  }

  /** Mines as of the interpolation time, so they vanish when the (past) car hits them. */
  visibleMines(): MineSnap[] {
    return this.bracket()?.a.mines ?? [];
  }

  player(id: string): PlayerInfo | undefined {
    return this.players.find((p) => p.id === id);
  }

  me(): PlayerInfo | undefined {
    return this.player(this.you);
  }

  ownSnap(): CarSnap | undefined {
    return this.latest?.cars.get(this.you);
  }

  isHost(): boolean {
    return !!this.you && this.hostId === this.you;
  }

  /** How many players the host's Start waits for: connected, not the host, not ready. */
  waitingFor(): number {
    return this.players.filter((p) => p.connected && p.id !== this.hostId && !p.ready).length;
  }

  /** The host may "Start anyway" now, by the estimated server clock. */
  canForceStart(): boolean {
    return this.phase === "lobby" && this.forceStartAt > 0 && this.hasClock() && this.serverNow() >= this.forceStartAt;
  }

  /** Cars in race order (server view), for positions and the spectator camera. */
  standings(): CarSnap[] {
    if (!this.latest) return [];
    return [...this.latest.cars.values()].sort((a, b) => {
      if (a.fin && b.fin) return a.fin - b.fin;
      if (a.fin) return -1;
      if (b.fin) return 1;
      return b.rd - a.rd;
    });
  }
}
