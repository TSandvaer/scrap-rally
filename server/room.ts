// Rooms, players, phases, input queues and the per-tick simulation. Transport-agnostic:
// a socket is reached only through the Conn interface, so index.ts owns `ws`.

import { randomBytes, randomInt } from "node:crypto";
import {
  BASE_STATS,
  collideCars,
  NO_INPUT,
  stepCar,
  type CarState,
  type CarStats,
  type Input,
} from "../shared/physics";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  COUNTDOWN_MS,
  FINISH_GRACE_MS,
  MAX_PLAYERS,
  RECONNECT_GRACE_MS,
  RESULTS_MS,
  SNAPSHOT_EVERY,
  round,
  type CarSnap,
  type ClientMsg,
  type GameEvent,
  type Phase,
  type PlayerInfo,
  type ResultRow,
  type ServerMsg,
} from "../shared/protocol";
import { buildTrack, gridSlot, RUST_BOWL, type Track } from "../shared/track";
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

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];

interface QueuedInput {
  seq: number;
  input: Input;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  token: string;
  session: Session | null;
  disconnectedAt: number;
  inRace: boolean;
  car: CarState | null;
  progress: Progress | null;
  stats: CarStats;
  queue: QueuedInput[];
  lastQueuedSeq: number;
  ack: number;
  buffering: boolean;
  lastInput: Input;
  starved: number;
}

const sharedTrack = buildTrack(RUST_BOWL);

function newId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[^\p{L}\p{N} _.\-]/gu, "").trim() : "";
  return s.slice(0, NAME_MAX) || "Driver";
}

export class Room {
  readonly players = new Map<string, Player>();
  hostId = "";
  phase: Phase = "lobby";
  phaseEnds = 0;
  raceStart = 0;
  private finishers = 0;

  constructor(
    readonly code: string,
    readonly track: Track,
    readonly laps: number,
  ) {}

  get empty(): boolean {
    return this.players.size === 0;
  }

  addPlayer(name: string, session: Session): Player | string {
    if (this.players.size >= MAX_PLAYERS) return "Room is full";
    const used = new Set([...this.players.values()].map((p) => p.color));
    const p: Player = {
      id: newId(6),
      name,
      color: COLORS.find((c) => !used.has(c)) ?? COLORS[0],
      token: newId(18),
      session: null,
      disconnectedAt: 0,
      inRace: false,
      car: null,
      progress: null,
      stats: { ...BASE_STATS },
      queue: [],
      lastQueuedSeq: -1,
      ack: -1,
      buffering: true,
      lastInput: NO_INPUT,
      starved: 0,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
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
      old.conn.send({ t: "err", msg: "This seat was taken over by another connection" });
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

  private remove(p: Player): void {
    this.players.delete(p.id);
    if (this.hostId === p.id) this.hostId = this.players.keys().next().value ?? "";
    this.broadcastRoom();
  }

  start(p: Player, now: number): string | null {
    if (p.id !== this.hostId) return "Only the host can start";
    if (this.phase !== "lobby") return "A race is already running";
    let slot = 0;
    for (const q of this.players.values()) {
      if (!q.session) continue; // disconnected players sit this race out
      const g = gridSlot(this.track, slot++);
      q.car = { x: g.x, y: g.y, h: g.h, vx: 0, vy: 0, seg: g.seg };
      q.progress = newProgress(this.track, q.car);
      q.inRace = true;
      resetQueue(q);
    }
    this.finishers = 0;
    this.raceStart = now + COUNTDOWN_MS;
    this.setPhase("countdown", this.raceStart);
    return null;
  }

  queueInputs(p: Player, tuples: unknown): void {
    if (!p.car || !Array.isArray(tuples)) return;
    for (const t of tuples.slice(-MAX_INPUTS_PER_MSG)) {
      if (!Array.isArray(t) || t.length !== 3) continue;
      const [seq, throttle, steer] = t;
      if (!Number.isInteger(seq) || seq <= p.lastQueuedSeq) continue;
      if (!Number.isFinite(throttle) || !Number.isFinite(steer)) continue;
      p.lastQueuedSeq = seq;
      p.queue.push({
        seq,
        input: { throttle: Math.max(-1, Math.min(1, throttle)), steer: Math.max(-1, Math.min(1, steer)) },
      });
    }
    if (p.queue.length > QUEUE_MAX) p.queue.splice(0, p.queue.length - QUEUE_TRIM);
  }

  tick(tick: number, now: number): void {
    // Phase timers first, so the first racing tick already applies inputs.
    if (this.phase === "countdown" && now >= this.phaseEnds) this.setPhase("racing", 0);
    else if (this.phase === "racing" && this.phaseEnds && now >= this.phaseEnds) this.endRace(now);
    else if (this.phase === "results" && now >= this.phaseEnds) this.toLobby();

    const racers = [...this.players.values()].filter((p) => p.car);
    for (const p of racers) {
      const input = consumeInput(p);
      stepCar(p.car!, this.phase === "racing" ? input : NO_INPUT, p.stats, this.track);
    }
    for (let i = 0; i < racers.length; i++) {
      for (let j = i + 1; j < racers.length; j++) collideCars(racers[i].car!, racers[j].car!);
    }

    if (this.phase === "racing") {
      for (const p of racers) {
        if (!advance(this.track, p.progress!, p.car!) || p.progress!.fin) continue;
        const pr = p.progress!;
        if (pr.lap < this.laps) {
          this.event(tick, { k: "lap", id: p.id, lap: pr.lap });
          continue;
        }
        pr.fin = Math.max(1, Math.round(now - this.raceStart));
        this.finishers++;
        this.event(tick, { k: "finish", id: p.id, place: this.finishers, timeMs: pr.fin });
        if (this.finishers === 1) this.phaseEnds = now + FINISH_GRACE_MS;
      }
      if (racers.length > 0 && racers.every((p) => p.progress!.fin)) this.endRace(now);
      else if (racers.length === 0) this.toLobby();
    }

    for (const p of [...this.players.values()]) {
      if (!p.session && now - p.disconnectedAt > RECONNECT_GRACE_MS) this.remove(p);
    }

    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots(tick, now);
  }

  private endRace(now: number): void {
    const rows: (ResultRow & { rd: number; fin: number })[] = [];
    for (const p of this.players.values()) {
      if (!p.car || !p.progress) continue;
      rows.push({
        id: p.id,
        name: p.name,
        color: p.color,
        timeMs: p.progress.fin,
        fin: p.progress.fin,
        rd: raceDistance(this.track, p.progress),
      });
    }
    rows.sort(compareStanding);
    this.setPhase("results", now + RESULTS_MS);
    this.broadcast({
      t: "results",
      rows: rows.map(({ id, name, color, timeMs }) => ({ id, name, color, timeMs })),
    });
  }

  private toLobby(): void {
    for (const p of this.players.values()) {
      p.car = null;
      p.progress = null;
      p.inRace = false;
      resetQueue(p);
    }
    this.raceStart = 0;
    this.setPhase("lobby", 0);
  }

  private setPhase(phase: Phase, ends: number): void {
    this.phase = phase;
    this.phaseEnds = ends;
    this.broadcastRoom();
  }

  private event(tick: number, ev: GameEvent): void {
    this.broadcast({ t: "ev", tick, ev });
  }

  private sendSnapshots(tick: number, now: number): void {
    const ents: CarSnap[] = [];
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
      });
    }
    const time = round(now, 1);
    for (const p of this.players.values()) {
      p.session?.conn.send({
        t: "snap",
        tick,
        time,
        phase: this.phase,
        phaseEnds: this.phaseEnds,
        ack: p.ack,
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
    }));
  }

  broadcastRoom(): void {
    this.broadcast({
      t: "room",
      hostId: this.hostId,
      phase: this.phase,
      raceStart: this.raceStart,
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
  p.lastInput = NO_INPUT;
  p.starved = 0;
}

/** Take this tick's input from the player's jitter buffer. */
function consumeInput(p: Player): Input {
  if (p.buffering && p.queue.length >= QUEUE_START) p.buffering = false;
  if (!p.buffering) {
    const next = p.queue.shift();
    if (next) {
      p.ack = next.seq;
      p.lastInput = next.input;
      p.starved = 0;
      return next.input;
    }
    p.buffering = true; // underrun: wait for the buffer to refill
  }
  p.starved++;
  return p.starved <= REPEAT_TICKS ? p.lastInput : NO_INPUT;
}

export class Rooms {
  readonly rooms = new Map<string, Room>();
  private tickNo = 0;

  constructor(private readonly laps: number) {}

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  onMessage(session: Session, msg: ClientMsg | null, now: number): void {
    if (!msg || typeof msg !== "object") return;
    const err = (m: string) => session.conn.send({ t: "err", msg: m });
    switch (msg.t) {
      case "create": {
        if (session.room) return err("Already in a room");
        const room = new Room(this.newCode(), sharedTrack, this.laps);
        this.rooms.set(room.code, room);
        room.addPlayer(cleanName(msg.name), session);
        return;
      }
      case "join": {
        if (session.room) return err("Already in a room");
        const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
        const room = this.rooms.get(code);
        if (!room) return err(`No room with code ${code || "(empty)"}`);
        const existing = room.playerByToken(msg.token);
        if (existing) return room.bind(existing, session);
        const res = room.addPlayer(cleanName(msg.name), session);
        if (typeof res === "string") err(res);
        return;
      }
      case "start": {
        if (!session.room || !session.player) return;
        const e = session.room.start(session.player, now);
        if (e) err(e);
        return;
      }
      case "in":
        if (session.room && session.player) session.room.queueInputs(session.player, msg.i);
        return;
      case "ping":
        session.conn.send({ t: "pong", c: Number(msg.c) || 0, s: round(now, 1) });
        return;
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
