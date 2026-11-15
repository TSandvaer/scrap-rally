// Client game state and netcode: own-car prediction + reconciliation, interpolation of
// the other cars, shots and mines, and the server clock estimate. No DOM access, so the
// headless bot test drives exactly this code.

import { angleDiff, BASE_STATS, CAR_RADIUS, cloneCar, type CarState, type CarStats, type Input } from "../shared/physics";
import {
  INPUT_REDUNDANCY,
  round,
  type CarSnap,
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
import { buildTrack, RUST_BOWL } from "../shared/track";
import {
  BTN_RIVET,
  makeButtons,
  moveShot,
  RIVET_COOLDOWN,
  spawnShot,
  stepRaceCar,
  WEAPONS_ARM_MS,
  type Command,
  type Shot,
} from "../shared/weapons";
import type { Transport } from "./net";

export const track = buildTrack(RUST_BOWL);

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

export interface Pose {
  id: string;
  x: number;
  y: number;
  h: number;
}

interface Snapshot {
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
 * full = room full, taken = seat taken over, busy = the server is full. restarted = the
 * room is gone after the server announced a restart; restarting = that notice itself;
 * unreachable = no answer.
 */
export type ConnReason = "gone" | "restarted" | "full" | "taken" | "busy" | "unreachable" | "restarting";

const LOST_MESSAGES: Partial<Record<ConnReason, string>> = {
  restarted: "The room is gone — the server restarted. Create a new room to play on.",
  gone: "The room was closed while you were away. Create a new room to play on.",
  full: "The room filled up while you were away.",
  taken: "This seat is now being played in another tab or window.",
  busy: "The server is full right now, try again later",
};

/** The menu text for connection("lost", reason). wasInRoom: the player had a seat. */
export function lostMessage(reason: ConnReason | undefined, wasInRoom: boolean): string {
  return (reason && LOST_MESSAGES[reason]) ?? (wasInRoom ? "Connection lost" : "Could not reach the server");
}

export interface GameHandlers {
  welcome(): void;
  room(): void;
  garage(): void;
  event(ev: GameEvent): void;
  results(rows: ResultRow[]): void;
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
  results: ResultRow[] | null = null;
  connected = false;
  rtt = 0;

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
  localShots: Shot[] = []; // cosmetic: our own rivets, drawn before the server confirms
  private cooldown = 0;
  private mineCounter = 0;
  private localShotId = 1;

  // Everyone (server view)
  snaps: Snapshot[] = [];
  latest: Snapshot | null = null;

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

  start(): void {
    this.send({ t: "start" });
  }

  buy(item: string): void {
    this.send({ t: "buy", item });
  }

  /** Drop the connection as a network failure would; the client then reconnects. */
  simulateDrop(): void {
    const tr = this.transport;
    tr?.close();
  }

  /** Leave for good (no reconnect). */
  leave(): void {
    this.intent = null;
    this.cancelReconnect();
    const tr = this.transport;
    this.transport = null;
    tr?.close();
    this.connected = false;
    this.restarting = false;
    this.busy = false;
    this.code = "";
    this.you = "";
    this.players = [];
    this.hostId = "";
    this.phase = "lobby";
    this.results = null;
    this.resetOwnCar();
    this.snaps = [];
    this.latest = null;
  }

  private resetOwnCar(): void {
    this.car = null;
    this.prevCar = null;
    this.pending = [];
    this.history.clear();
    this.localShots = [];
    this.cooldown = 0;
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
        this.hostId = msg.hostId;
        this.phase = msg.phase;
        this.raceStart = msg.raceStart;
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
        if (msg.code === "taken") {
          // Another tab or window took this seat: do not take it back (no ping-pong).
          this.stop("taken");
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
        this.on.event?.(msg.ev);
        return;
      case "results":
        this.results = msg.rows;
        this.on.results?.(msg.rows);
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
    };
    if (!this.car) {
      this.car = server;
      this.prevCar = cloneCar(server);
      this.pending = this.pending.filter((p) => p.seq > msg.ack);
      this.lastAck = msg.ack;
      return;
    }
    this.reconcile(server, msg.ack);
  }

  private reconcile(server: CarState, ack: number): void {
    const predicted = this.history.get(ack);
    if (predicted && ack > this.lastAck) {
      const err = Math.hypot(predicted.x - server.x, predicted.y - server.y);
      if (this.recErrors.length < MAX_ERROR_SAMPLES) this.recErrors.push(err);
    }
    if (ack > this.lastAck) this.lastAck = ack;
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
    for (const k of this.history.keys()) if (k <= ack) this.history.delete(k);

    // Rewind to the server state and replay what the server has not seen yet. Replay goes
    // through stepRaceCar, so a wreck freeze and the respawn jump are predicted too.
    const old = this.car!;
    const c = cloneCar(server);
    for (const p of this.pending) {
      stepRaceCar(c, p.cmd, this.stats, track);
      this.history.set(p.seq, cloneCar(c));
    }
    this.car = c;

    // Hide the jump: shift the render offset (and the interpolation start) by it. Wreck
    // state changes and big jumps are shown as they are.
    const dx = old.x - c.x;
    const dy = old.y - c.y;
    const dh = angleDiff(c.h, old.h);
    if (Math.hypot(dx, dy) > SNAP_DISTANCE || old.wreck > 0 !== c.wreck > 0) {
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
   * the car is not wrecked, ghosted or finished.
   */
  armed(): boolean {
    const s = this.latest?.cars.get(this.you);
    return !!this.car && this.car.wreck === 0 && !!s && !s.ghost && this.raceOn() && this.armsInMs() === 0;
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
    const [rivets, mines] = this.predictedAmmo();
    const minePress = ctl.mine && this.armed() && mines > 0;
    if (minePress) this.mineCounter = (this.mineCounter + 1) & 7;
    // Round before use so the server applies exactly what we predicted with.
    const cmd: Command = on
      ? {
          throttle: round(ctl.throttle, 2),
          steer: round(ctl.steer, 2),
          buttons: makeButtons(ctl.fire, this.mineCounter),
        }
      : { throttle: 0, steer: 0, buttons: makeButtons(false, this.mineCounter) };

    const seq = this.seq++;
    const before = this.car;
    this.prevCar = cloneCar(before);
    if (this.cooldown > 0) this.cooldown--;
    stepRaceCar(this.car, cmd, this.stats, track);
    if (this.prevCar.wreck > 0 && this.car.wreck === 0) this.prevCar = cloneCar(this.car); // respawn: no slide

    // Same order as the server: step, then fire from the new pose.
    let fired = false;
    if (cmd.buttons & BTN_RIVET && this.cooldown === 0 && rivets > 0 && this.armed()) {
      this.localShots.push(spawnShot(this.car, this.localShotId++, this.you));
      this.cooldown = RIVET_COOLDOWN;
      fired = true;
    }
    this.pending.push({ seq, cmd, fired, mine: minePress });
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

  /** Cosmetic own rivets: fly until range, a wall, or another car they visibly touch. */
  private moveLocalShots(): void {
    if (!this.localShots.length) return;
    const targets = this.otherPoses().filter((p) => {
      const s = this.latest?.cars.get(p.id);
      return s && !s.ghost && !s.wreck;
    });
    const r = CAR_RADIUS + 2;
    this.localShots = this.localShots.filter((s) => {
      if (!moveShot(s, track)) return false;
      return !targets.some((t) => (t.x - s.x) ** 2 + (t.y - s.y) ** 2 <= r * r);
    });
  }

  // ---- queries for rendering and HUD ------------------------------------------------

  /** Estimated server time now (biased slightly late by the one-way latency). */
  serverNow(): number {
    return performance.now() + (this.haveOffset ? this.offset : 0);
  }

  /** Own car pose: interpolated between the last two steps, plus the decaying correction. */
  ownPose(alpha: number): Pose | null {
    const c = this.car;
    if (!c) return null;
    const p = this.prevCar ?? c;
    return {
      id: this.you,
      x: p.x + (c.x - p.x) * alpha + this.smooth.x,
      y: p.y + (c.y - p.y) * alpha + this.smooth.y,
      h: p.h + angleDiff(p.h, c.h) * alpha + this.smooth.h,
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

  /** Every car except our own predicted one, interpolated in the past. */
  otherPoses(): Pose[] {
    const out: Pose[] = [];
    const br = this.bracket();
    if (!br) return out;
    const { a, b, t } = br;
    for (const [id, ca] of a.cars) {
      if (id === this.you && this.car) continue;
      const cb = b?.cars.get(id);
      if (b && cb && b.time > a.time && t >= a.time) {
        const f = Math.min(1, (t - a.time) / (b.time - a.time));
        out.push({ id, x: ca.x + (cb.x - ca.x) * f, y: ca.y + (cb.y - ca.y) * f, h: ca.h + angleDiff(ca.h, cb.h) * f });
      } else if (!b) {
        const dt = Math.max(0, Math.min(EXTRAP_MAX_MS, t - a.time)) / 1000;
        out.push({ id, x: ca.x + ca.vx * dt, y: ca.y + ca.vy * dt, h: ca.h });
      } else {
        out.push({ id, x: ca.x, y: ca.y, h: ca.h });
      }
    }
    // Cars that only exist in the newer snapshot (just spawned).
    if (b) {
      for (const [id, cb] of b.cars) {
        if (a.cars.has(id) || (id === this.you && this.car)) continue;
        out.push({ id, x: cb.x, y: cb.y, h: cb.h });
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
