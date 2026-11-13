// Client game state and netcode: own-car prediction + reconciliation, interpolation of
// the other cars, and the server clock estimate. No DOM access, so the headless bot test
// drives exactly this code.

import {
  angleDiff,
  BASE_STATS,
  cloneCar,
  NO_INPUT,
  stepCar,
  type CarState,
  type Input,
} from "../shared/physics";
import {
  INPUT_REDUNDANCY,
  round,
  type CarSnap,
  type ClientMsg,
  type GameEvent,
  type InputTuple,
  type Phase,
  type PlayerInfo,
  type ResultRow,
  type ServerMsg,
} from "../shared/protocol";
import { buildTrack, RUST_BOWL } from "../shared/track";
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

export interface Pose {
  id: string;
  x: number;
  y: number;
  h: number;
}

interface Snapshot {
  time: number;
  cars: Map<string, CarSnap>;
}

interface Pending {
  seq: number;
  input: Input;
}

export interface GameHandlers {
  welcome(): void;
  room(): void;
  event(ev: GameEvent): void;
  results(rows: ResultRow[]): void;
  error(msg: string): void;
  connection(state: "connected" | "reconnecting" | "lost"): void;
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

  // Own car (predicted)
  car: CarState | null = null;
  prevCar: CarState | null = null; // state before the last step, for render interpolation
  readonly smooth = { x: 0, y: 0, h: 0 }; // visual correction offset, decays to 0
  seq = 0;
  pending: Pending[] = [];
  history = new Map<number, CarState>();
  lastAck = -1;
  readonly recErrors: number[] = [];

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
    this.code = "";
    this.you = "";
    this.players = [];
    this.hostId = "";
    this.phase = "lobby";
    this.results = null;
    this.car = null;
    this.prevCar = null;
    this.pending = [];
    this.history.clear();
    this.snaps = [];
    this.latest = null;
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
      this.on.connection?.("lost");
      return;
    }
    if (this.reconnectTries >= RECONNECT_TRIES) {
      this.on.connection?.("lost");
      return;
    }
    this.on.connection?.("reconnecting");
    this.reconnectTries++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(this.joinMsg());
    }, RECONNECT_DELAY_MS);
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
        // Sequence numbers restart with every welcome; the server reset its queue too.
        this.seq = 0;
        this.lastAck = -1;
        this.pending = [];
        this.history.clear();
        this.car = null;
        this.prevCar = null;
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
      case "err":
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
    const cars = new Map<string, CarSnap>();
    for (const e of msg.ents) if (e.k === "car") cars.set(e.id, e);
    const snap: Snapshot = { time: msg.time, cars };
    if (!this.latest || msg.time > this.latest.time) {
      this.snaps.push(snap);
      this.latest = snap;
    }
    while (this.snaps.length > 2 && this.snaps[0].time < msg.time - SNAP_KEEP_MS) this.snaps.shift();

    const mine = cars.get(this.you);
    if (!mine) {
      this.car = null;
      this.prevCar = null;
      this.pending = [];
      this.history.clear();
      return;
    }
    const server: CarState = { x: mine.x, y: mine.y, h: mine.h, vx: mine.vx, vy: mine.vy, seg: mine.seg };
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

    // Rewind to the server state and replay what the server has not seen yet.
    const old = this.car!;
    const c = cloneCar(server);
    for (const p of this.pending) {
      stepCar(c, p.input, BASE_STATS, track);
      this.history.set(p.seq, cloneCar(c));
    }
    this.car = c;

    // Hide the jump: shift the render offset (and the interpolation start) by it.
    const dx = old.x - c.x;
    const dy = old.y - c.y;
    const dh = angleDiff(c.h, old.h);
    if (Math.hypot(dx, dy) > SNAP_DISTANCE) {
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

  /** Advance one fixed step (DT) with the raw player input. */
  step(raw: Input, stepMs: number): void {
    const k = Math.exp(-stepMs / SMOOTH_TAU_MS);
    this.smooth.x *= k;
    this.smooth.y *= k;
    this.smooth.h *= k;

    const now = performance.now();
    if (this.connected && now - this.lastPing > PING_EVERY_MS) {
      this.lastPing = now;
      this.send({ t: "ping", c: round(now, 1) });
    }
    if (!this.car || !this.connected) return;

    // Round before use so the server applies exactly what we predicted with.
    const input: Input = this.raceOn()
      ? { throttle: round(raw.throttle, 2), steer: round(raw.steer, 2) }
      : NO_INPUT;
    const seq = this.seq++;
    this.prevCar = cloneCar(this.car);
    stepCar(this.car, input, BASE_STATS, track);
    this.pending.push({ seq, input });
    this.history.set(seq, cloneCar(this.car));
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.shift()!;
      this.history.delete(dropped.seq);
    }
    const tail: InputTuple[] = this.pending
      .slice(-INPUT_REDUNDANCY)
      .map((p) => [p.seq, p.input.throttle, p.input.steer]);
    this.send({ t: "in", i: tail });
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

  /** Every car except our own predicted one, interpolated in the past. */
  otherPoses(): Pose[] {
    const out: Pose[] = [];
    if (!this.snaps.length) return out;
    const t = this.serverNow() - INTERP_DELAY_MS;
    const snaps = this.snaps;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].time > t) i--;
    const a = snaps[i];
    const b = snaps[i + 1];
    for (const [id, ca] of a.cars) {
      if (id === this.you && this.car) continue;
      const cb = b?.cars.get(id);
      if (cb && b.time > a.time && t >= a.time) {
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

  player(id: string): PlayerInfo | undefined {
    return this.players.find((p) => p.id === id);
  }

  me(): PlayerInfo | undefined {
    return this.player(this.you);
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
