// Deterministic server simulation test: drives a Room directly with fake connections and
// scripted inputs (no sockets, no wall clock). Covers weapons, wrecks, the garage and
// payouts. Run: npx tsx scripts/sim-test.ts

import { BASE_STATS, cloneCar, DT, speedOf, stepCar, TICK_HZ, type CarState } from "../shared/physics";
import { FORCE_START_MS, RECONNECT_GRACE_MS, type ClientMsg, type GameEvent, type ServerMsg } from "../shared/protocol";
import { payouts, startingWallet, buy as shopBuy, statsFor } from "../shared/shop";
import { buildTrack, pointAt, queryTrackNear, RUST_BOWL, type TrackDef } from "../shared/track";
import {
  BTN_RIVET,
  GHOST_TICKS,
  makeButtons,
  MINE_DAMAGE,
  RIVET_DAMAGE,
  raceEnv,
  shotHits,
  spinOut,
  SPIN_KICK,
  stepRaceCar,
  WEAPONS_ARM_MS,
  WRECK_TICKS,
  type Command,
} from "../shared/weapons";
import { Room, Rooms, type Conn, type Player, type Session } from "../server/room";
import { CAR_RESTITUTION, capsuleGap, carContact, collideCarOneSided, collideCars } from "../shared/physics";
import type { CarSnap } from "../shared/protocol";
import { Contacts, drawnPose, IMPACT_MIN_SPEED, PREDICT_MAX_MS, predicted } from "../client/contact";
import { JerkMeter } from "../client/jerk";
import {
  DEFAULT_SOUND,
  isMuteKey,
  MUSIC_FADE_OUT_S,
  MusicDirector,
  musicWanted,
  parseStoredSound,
  SEQ_LOOKAHEAD_S,
  SEQ_START_DELAY_S,
  SEQ_TIMER_MS,
  StepClock,
  stepSeconds,
  type MusicAction,
} from "../client/soundlogic";
import { midiOf, SONG } from "../client/music";
import { angleDiff, clamp } from "../shared/physics";
import { LIP_ZONE, queryTrack, recoveryAt, validateTrack, type Track } from "../shared/track";
import {
  airHeight,
  airTicksFor,
  FALL_TICKS,
  MIN_TAKEOFF_SPEED,
  NO_COMMAND,
  validateRunUps,
  wreckCar,
  type RaceStepEvent,
} from "../shared/weapons";

const track = buildTrack(RUST_BOWL);
const L = track.length;

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---- harness ----------------------------------------------------------------------

class FakeConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
  close(): void {}
}

/** Scripted controls for one input: fire = rivet gun held, mine = a new mine press. */
type Ctl = Partial<Command> & { fire?: boolean; mine?: boolean };

class Sim {
  readonly room: Room;
  readonly conns = new Map<string, FakeConn>();
  readonly events: GameEvent[] = [];
  private readonly seqs = new Map<string, number>();
  private readonly mineCounts = new Map<string, number>();
  now = 1000;
  tickNo = 0;

  constructor(laps = 1, hp?: number) {
    this.room = new Room("TEST", laps, hp); // the default track: Rust Bowl, as `track` above
  }

  add(name: string): Player {
    const conn = new FakeConn();
    const session: Session = { conn, room: null, player: null };
    const p = this.room.addPlayer(name, session, this.now) as Player;
    this.conns.set(p.id, conn);
    this.seqs.set(p.id, 0);
    this.mineCounts.set(p.id, 0);
    return p;
  }

  /** Queue one input for p (one per tick keeps the jitter buffer steady). */
  feed(p: Player, cmd: Ctl = {}): void {
    if (cmd.mine) this.mineCounts.set(p.id, (this.mineCounts.get(p.id)! + 1) & 7);
    const buttons = cmd.buttons ?? makeButtons(!!cmd.fire, this.mineCounts.get(p.id)!);
    const seq = this.seqs.get(p.id)!;
    this.seqs.set(p.id, seq + 1);
    this.room.queueInputs(p, [[seq, cmd.throttle ?? 0, cmd.steer ?? 0, buttons]]);
  }

  rivet(p: Player): number {
    return BTN_RIVET | ((this.mineCounts.get(p.id)! & 7) << 1);
  }

  tick(): void {
    this.tickNo++;
    this.now += 1000 / 60;
    const before = new Map([...this.conns].map(([id, c]) => [id, c.msgs.length]));
    this.room.tick(this.tickNo, this.now);
    // Collect events once (from the first connection that received them).
    const first = [...this.conns.entries()].find(([id]) => this.room.players.get(id)?.session);
    if (first) {
      const [id, c] = first;
      for (const m of c.msgs.slice(before.get(id))) if (m.t === "ev") this.events.push(m.ev);
    }
  }

  /** Run n ticks, feeding every racer the command from `cmd` (default idle). */
  run(n: number, cmd: (p: Player) => Ctl = () => ({})): void {
    for (let i = 0; i < n; i++) {
      for (const p of this.room.players.values()) if (p.car) this.feed(p, cmd(p));
      this.tick();
    }
  }

  /** Every player except the host reports ready (the host's Start is the host's ready). */
  readyAll(host: Player): void {
    for (const p of this.room.players.values()) if (p !== host) this.room.setReady(p, true);
  }

  startRace(host: Player): void {
    this.readyAll(host);
    const e = this.room.start(host, this.now);
    if (e) throw new Error(e);
    while (this.room.phase !== "racing") this.run(1);
  }

  /** Give every player a full race's worth of ammo (players start with none). */
  grantAmmo(rivets = 40, mines = 3): void {
    for (const p of this.room.players.values()) {
      p.ammo.rivets = rivets;
      p.ammo.mines = mines;
    }
  }

  /** Grant ammo and jump the clock past the weapons-armed delay (no ticks run). */
  armWeapons(): void {
    this.grantAmmo();
    this.now = Math.max(this.now, this.room.raceStart + WEAPONS_ARM_MS);
  }

  /** Milliseconds since GO. */
  sinceGo(): number {
    return this.now - this.room.raceStart;
  }

  /** Put a car on the track at distance s, `lateral` units sideways, facing along the track. */
  place(p: Player, s: number, lateral = 0, speed = 0): void {
    const pt = pointAt(track, s);
    const x = pt.x - Math.sin(pt.h) * lateral;
    const y = pt.y + Math.cos(pt.h) * lateral;
    p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    p.progress = { s: queryTrackNear(track, x, y, pt.seg).s, cp: 1, lap: 0, fin: 0 };
  }

  eventsOf(k: GameEvent["k"]): GameEvent[] {
    return this.events.filter((e) => e.k === k);
  }

  lastGarage(p: Player): Extract<ServerMsg, { t: "garage" }> | undefined {
    return this.conns.get(p.id)!.msgs.filter((m) => m.t === "garage").pop() as Extract<ServerMsg, { t: "garage" }>;
  }

  lastRoom(p: Player): Extract<ServerMsg, { t: "room" }> | undefined {
    return this.conns.get(p.id)!.msgs.filter((m) => m.t === "room").pop() as Extract<ServerMsg, { t: "room" }>;
  }

  /** Reconnect p on a fresh socket, as a rejoin with the token does. */
  rebind(p: Player): void {
    const conn = new FakeConn();
    this.room.bind(p, { conn, room: null, player: null });
    this.conns.set(p.id, conn);
  }
}

// ---- tests --------------------------------------------------------------------------

function rivets(): void {
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.armWeapons();
  sim.place(a, 200, 0);
  sim.place(b, 320, 0);
  const ammo0 = a.ammo.rivets;
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(20);
  const hits = sim.eventsOf("hit");
  check(
    "rivet hits the car ahead for 4",
    RIVET_DAMAGE === 4 && hits.length === 1 && b.hp === 96 && hits[0].k === "hit" && hits[0].dmg === 4 && hits[0].by === a.id && hits[0].w === "rivet",
    `hits=${hits.length} b.hp=${b.hp}`,
  );
  check("firing uses one rivet", a.ammo.rivets === ammo0 - 1, `${ammo0} -> ${a.ammo.rivets}`);
  check("shot is gone after the hit", sim.room.combat.shots.length === 0);

  // Hold the trigger 30 inputs with nothing in front: cooldown 9 ticks -> 4 shots.
  sim.place(b, 1500, 0);
  const before = a.ammo.rivets;
  sim.run(30, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  check("cooldown: 30 held inputs fire 4 rivets", before - a.ammo.rivets === 4, `${before - a.ammo.rivets} fired`);
  check("own rivets never hit their owner", a.hp === 100);
  sim.run(60);
  check("rivets expire at range", sim.room.combat.shots.length === 0);

  // Fire sideways into the wall: gone well before the range runs out.
  sim.place(a, 200, 0);
  a.car!.h += Math.PI / 2;
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(1); // inputs are consumed one tick after they are fed
  const fired = sim.room.combat.shots.length;
  sim.run(12);
  check("rivets stop at the wall", fired === 1 && sim.room.combat.shots.length === 0, `fired=${fired}`);

  // No ammo, no shots.
  a.ammo.rivets = 0;
  sim.run(20, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  check("no rivets without ammo", sim.room.combat.shots.length === 0 && a.ammo.rivets === 0);

  // Swept hit test: a shot passing straight through in one tick, and a head-on pass.
  check("swept test: shot crossing a car within one tick hits", shotHits(-20, 0, 20, 0, 0, 0, 0, 0));
  check("swept test: head-on pass (car 30 -> 16, shot 0 -> 15) hits", shotHits(0, 0, 15, 0, 30, 0, 16, 0));
  check("swept test: clean miss", !shotHits(-20, 30, 20, 30, 0, 0, 0, 0));
}

function gating(): void {
  const sim = new Sim();
  const a = sim.add("A");
  sim.add("B");
  sim.readyAll(a);
  const started = sim.room.start(a, sim.now);
  check("gating: start accepted once B is ready", started === null, started ?? "");
  sim.grantAmmo(); // with ammo, so the countdown check cannot pass for lack of it
  let ammo = a.ammo.rivets;
  for (let i = 0; i < 60; i++) sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  check("no firing during the countdown", ammo === 40 && a.ammo.rivets === ammo && sim.room.combat.shots.length === 0);
  while (sim.room.phase !== "racing") sim.run(1);
  sim.armWeapons();
  sim.place(a, 200, 0);

  // 9 real rivet inputs then starve: repeats must not fire again (cooldown would allow it).
  ammo = a.ammo.rivets;
  for (let i = 0; i < 9; i++) {
    sim.feed(a, { buttons: sim.rivet(a) });
    sim.tick();
  }
  for (let i = 0; i < 12; i++) sim.tick();
  check("underrun repeats never fire", ammo - a.ammo.rivets === 1, `${ammo - a.ammo.rivets} fired`);

  // One mine tap, then starve, then resume with the same counter: exactly one mine.
  const mines = a.ammo.mines;
  sim.run(3);
  sim.feed(a, { mine: true });
  for (let i = 0; i < 10; i++) sim.tick();
  sim.run(10);
  check("one tap drops one mine, repeats drop none", mines - a.ammo.mines === 1, `${mines - a.ammo.mines} dropped`);

  // A tap inside a burst that overflows the queue (trimmed to the last 3) still counts.
  const m2 = a.ammo.mines;
  const seqBase = 10_000;
  const counter = 5;
  const burst = Array.from({ length: 8 }, (_, i) => [seqBase + i, 0, 0, makeButtons(false, i === 0 ? 1 : counter)]);
  sim.room.queueInputs(a, burst);
  for (let i = 0; i < 5; i++) sim.tick();
  check("a mine tap survives an overflow trim", m2 - a.ammo.mines === 1, `${m2 - a.ammo.mines} dropped`);
}

function mines(): void {
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.armWeapons();
  sim.place(a, 300, 0);
  sim.place(b, 1500, 0);
  sim.run(1, (p) => (p === a ? { mine: true } : {}));
  sim.run(1);
  const m = sim.room.combat.mines[0];
  check("mine dropped behind the car", !!m && m.owner === a.id, m ? `at ${m.x.toFixed(0)},${m.y.toFixed(0)}` : "none");
  if (!m) return;
  // B parks 2 units off the mine, before it arms.
  const pt = pointAt(track, 0);
  b.car = { x: m.x, y: m.y + 2, h: pt.h, vx: 0, vy: 0, seg: a.car!.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const h0 = b.car.h;
  let hitAt = -1;
  for (let i = 0; i < 40 && hitAt < 0; i++) {
    sim.run(1);
    if (sim.eventsOf("hit").length) hitAt = i;
  }
  check("mine is harmless until armed (~0.4 s), then hits", hitAt >= 18 && hitAt <= 26, `hit after ${hitAt} ticks`);
  check(
    "mine does 15 damage and spins the car",
    MINE_DAMAGE === 15 && b.hp === 85 && Math.abs(Math.abs(b.car.h - h0) - SPIN_KICK) < 1e-9,
    `hp=${b.hp}`,
  );
  check("mine is used up", sim.room.combat.mines.length === 0);

  // Owner drives back over its own armed mine.
  sim.place(a, 600, 0);
  sim.run(1, (p) => (p === a ? { mine: true } : {}));
  sim.run(40);
  const own = sim.room.combat.mines[0];
  a.car!.x = own.x;
  a.car!.y = own.y;
  sim.run(2);
  check("an armed mine also hits its owner", a.hp === 85, `a.hp=${a.hp}`);
  check("no wreck credit for hurting yourself", !sim.room.combat.wrecksCaused.has(a.id));

  const c = { x: 0, y: 0, h: 0, vx: 100, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 };
  spinOut(c, 0, 10);
  check("spin-out is deterministic: away from the mine, speed x0.3", c.h === -SPIN_KICK && Math.abs(c.vx - 30) < 1e-9);
}

function wrecks(): void {
  const sim = new Sim(1, 4); // 4 HP: one rivet wrecks
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.armWeapons();
  sim.place(a, 200, 20);
  sim.place(b, 320, 20);
  const progress0 = { ...b.progress! };
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  let clone = null as ReturnType<typeof cloneCar> | null;
  for (let i = 0; i < 20 && !clone; i++) {
    sim.run(1, (p) => (p === b ? { throttle: 1 } : {}));
    if (sim.eventsOf("wreck").length) clone = cloneCar(b.car!);
  }
  const sAtWreck = queryTrackNear(track, b.car!.x, b.car!.y, b.car!.seg).s;
  const wreckEv = sim.eventsOf("wreck")[0];
  check("0 HP wrecks the car", !!clone && wreckEv?.k === "wreck" && wreckEv.by === a.id && b.car!.wreck === WRECK_TICKS);
  if (!clone) return;
  const frozenAt = { x: b.car!.x, y: b.car!.y };
  sim.run(WRECK_TICKS - 1, (p) => (p === b ? { throttle: 1 } : {}));
  check("wrecked car stays put with the throttle held", b.car!.x === frozenAt.x && b.car!.y === frozenAt.y && b.car!.wreck === 1);
  for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(clone, { throttle: 1, steer: 0 }, b.stats, raceEnv(track));
  sim.run(1, (p) => (p === b ? { throttle: 1 } : {}));
  const q = queryTrackNear(track, b.car!.x, b.car!.y, b.car!.seg);
  check("respawn on the centerline at the same distance", q.dist < 0.5 && Math.abs(q.s - sAtWreck) < 0.5, `dist=${q.dist.toFixed(2)} ds=${(q.s - sAtWreck).toFixed(2)}`);
  check("respawn restores HP and ghosts the car", b.hp === b.maxHp && b.ghost === GHOST_TICKS - 0, `hp=${b.hp} ghost=${b.ghost}`);
  check("prediction parity: stepRaceCar on a clone gives the server pose", clone.x === b.car!.x && clone.y === b.car!.y && clone.h === b.car!.h);
  check("lap/checkpoint progress kept through the wreck", b.progress!.lap === progress0.lap && b.progress!.cp === progress0.cp);
  check("attacker credited with the wreck", sim.room.combat.wrecksCaused.get(a.id) === 1);

  // Ghosted: rivets pass through.
  sim.place(a, b.progress!.s - 120, 0);
  b.car!.vx = b.car!.vy = 0;
  const hits0 = sim.eventsOf("hit").length;
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(15);
  check("ghosted cars cannot be hit", sim.eventsOf("hit").length === hits0 && b.hp === b.maxHp);
}

function finishing(): void {
  const sim = new Sim(1);
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.armWeapons();
  const near = (p: Player) => {
    sim.place(p, L - 40, 0, 300);
    p.progress = { s: queryTrackNear(track, p.car!.x, p.car!.y, p.car!.seg).s, cp: 3, lap: 0, fin: 0 };
  };
  near(a);
  sim.place(b, 2000, 0);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  check("car finishes", a.finished && sim.eventsOf("finish").length === 1);
  // Finished: cannot fire, cannot be hit.
  const ammo = a.ammo.rivets;
  sim.run(10, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  check("finished cars cannot fire", ammo > 0 && a.ammo.rivets === ammo);
  a.car!.vx = a.car!.vy = 0;
  const s = queryTrackNear(track, a.car!.x, a.car!.y, a.car!.seg).s;
  sim.place(b, s - 120, 0);
  b.progress!.cp = 1;
  const bAmmo = b.ammo.rivets;
  sim.run(1, (p) => (p === b ? { buttons: sim.rivet(b) } : {}));
  sim.run(15);
  check(
    "finished cars are ghosted (rivets pass through)",
    b.ammo.rivets === bAmmo - 1 && a.hp === 100 && sim.eventsOf("hit").length === 0,
    `b fired ${bAmmo - b.ammo.rivets}`,
  );

  // B finishes too -> race ends, payouts.
  near(b);
  sim.run(15, (p) => (p === b ? { throttle: 1 } : {}));
  check("race ends when everyone finished", sim.room.phase === "results");
  const res = sim.conns.get(a.id)!.msgs.filter((m) => m.t === "results").pop();
  const rows = res && res.t === "results" ? res.rows : [];
  check(
    "results carry earned scrap by place",
    rows.length === 2 && rows[0].id === a.id && rows[0].earned === 1000 && rows[1].earned === 700,
    rows.map((r) => `${r.name}+${r.earned}`).join(" "),
  );
  check("scrap added to wallets and sent", a.wallet.scrap === 1400 && sim.lastGarage(a)?.scrap === 1400, `a=${a.wallet.scrap}`);

  // Back to lobby; a newcomer joins; reverse grid: newcomer, then B (2nd), then A (winner).
  while (sim.room.phase !== "lobby") sim.run(1);
  const c = sim.add("C");
  const order = sim.room.gridOrder().map((p) => p.name).join(",");
  check("reverse grid: newcomers first, winner last", order === "C,B,A", order);
  sim.startRace(a);
  check("grid slots follow that order", c.car!.y < b.car!.y && b.car!.y < a.car!.y, "track starts heading up");
}

/** Lobby ready check and "Start anyway", on the fake clock (sim.now is set directly). */
function readyCheck(): void {
  const shown = (sim: Sim, to: Player, p: Player) => sim.lastRoom(to)?.players.find((x) => x.id === p.id)?.ready;

  // Not ready -> refused; un-ready; buying keeps ready; the host's ready is ignored.
  let sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  const c = sim.add("C");
  check("ready: host and newcomers start not ready", !a.ready && !b.ready && !c.ready);
  let e = sim.room.start(a, sim.now);
  check("ready: start refused while 2 are not ready", e === "Waiting for 2 players to get ready" && sim.room.phase === "lobby", e ?? "");
  sim.room.setReady(b, true);
  check("ready: shown in the room message", shown(sim, a, b) === true && shown(sim, a, c) === false);
  e = sim.room.start(a, sim.now);
  check("ready: still refused while 1 is not ready", e === "Waiting for 1 player to get ready", e ?? "");
  sim.room.setReady(c, true);
  sim.room.setReady(b, false);
  e = sim.room.start(a, sim.now);
  check("ready: a player can un-ready", !b.ready && shown(sim, a, b) === false && e === "Waiting for 1 player to get ready", e ?? "");
  sim.room.setReady(b, true);
  sim.room.buy(b, "mines");
  check("ready: buying does not change ready", b.ready && shown(sim, a, b) === true);
  sim.room.setReady(a, true);
  check("ready: the host's ready is ignored (no READY on the host row)", !a.ready && shown(sim, b, a) === false);
  sim.room.setReady(c, "no");
  check("ready: a non-boolean ready is ignored", c.ready);
  e = sim.room.start(a, sim.now);
  check("ready: start accepted once everyone else is ready", e === null && sim.room.phase === "countdown", e ?? "");
  check("ready: reset for everyone when the race starts", ![a, b, c].some((p) => p.ready) && shown(sim, a, b) === false);
  check("ready: forceStartAt is 0 outside the lobby", sim.room.forceStartAt === 0 && sim.lastRoom(a)?.forceStartAt === 0);
  sim.room.setReady(b, true);
  const inCountdown = b.ready;
  while (sim.room.phase !== "racing") sim.run(1);
  sim.room.setReady(b, true);
  check("ready: never set outside the lobby (countdown, race)", !inCountdown && !b.ready);

  // Everyone finishes -> results -> lobby: everyone readies again.
  for (const p of [a, b, c]) {
    sim.place(p, L - 40, 0, 300);
    p.progress = { s: queryTrackNear(track, p.car!.x, p.car!.y, p.car!.seg).s, cp: 3, lap: 0, fin: 0 };
    sim.run(15, (q) => (q === p ? { throttle: 1 } : {}));
  }
  const phase = (): string => sim.room.phase; // not narrowed by the loop above
  check("ready: race over", phase() === "results", phase());
  while (phase() !== "lobby") sim.run(1);
  e = sim.room.start(a, sim.now);
  check("ready: after the results nobody is ready, start refused", e === "Waiting for 2 players to get ready", e ?? "");
  check(
    "ready: the lobby reopening restarts the Start anyway clock",
    sim.room.forceStartAt === sim.now + FORCE_START_MS && sim.lastRoom(b)?.forceStartAt === sim.now + FORCE_START_MS,
  );

  // A solo host starts at once.
  sim = new Sim();
  const solo = sim.add("Solo");
  check("ready: a solo host can start at once", sim.room.start(solo, sim.now) === null);

  // An offline player (in the reconnect grace) is not waited for and sits the race out.
  sim = new Sim();
  const h = sim.add("H");
  const on = sim.add("On");
  const off = sim.add("Off");
  sim.room.setReady(on, true);
  sim.room.unbind(off, sim.now);
  e = sim.room.start(h, sim.now);
  check("ready: an offline player is not waited for", e === null, e ?? "");
  check("ready: the offline player sits the race out", !off.car && !off.inRace && !!on.car && sim.room.players.has(off.id));

  // Start anyway: from 60 s after the last join; a late joiner pushes it, a rejoin does not.
  sim = new Sim();
  const fh = sim.add("FH");
  const slow = sim.add("Slow");
  const t0 = sim.now;
  check("force: forceStartAt = last join + 60 s", sim.room.forceStartAt === t0 + FORCE_START_MS && sim.lastRoom(fh)?.forceStartAt === t0 + FORCE_START_MS);
  e = sim.room.start(fh, t0 + FORCE_START_MS - 1, true);
  check("force: refused before forceStartAt", e === "Start anyway is not available yet" && sim.room.phase === "lobby", e ?? "");
  sim.now = t0 + 30_000;
  const late = sim.add("Late");
  check("force: a late joiner pushes forceStartAt", sim.room.forceStartAt === t0 + 30_000 + FORCE_START_MS && sim.lastRoom(fh)?.forceStartAt === sim.room.forceStartAt);
  e = sim.room.start(fh, t0 + FORCE_START_MS, true);
  check("force: refused at the old forceStartAt", e === "Start anyway is not available yet", e ?? "");
  sim.room.setReady(late, true);
  sim.room.unbind(late, sim.now);
  sim.now = t0 + 50_000;
  sim.rebind(late);
  check("force: a rejoin does not move forceStartAt", sim.room.forceStartAt === t0 + 30_000 + FORCE_START_MS);
  check("ready: kept across a rebind (a Wi-Fi blip does not un-ready)", late.ready && shown(sim, fh, late) === true);
  sim.now = t0 + 30_000 + FORCE_START_MS;
  e = sim.room.start(fh, sim.now, true);
  check("force: accepted from forceStartAt", e === null && sim.room.phase === "countdown", e ?? "");
  check("force: races every connected player, ready or not", [fh, slow, late].every((p) => !!p.car && p.inRace));

  // Force with everyone ready is just a start, whatever the clock says.
  sim = new Sim();
  const qh = sim.add("QH");
  sim.room.setReady(sim.add("Q"), true);
  check("force: with everyone ready it is a plain start", sim.room.start(qh, sim.now, true) === null);

  // Host reassignment: the new host need not be ready; the rest still are waited for.
  sim = new Sim();
  const oldHost = sim.add("Old");
  const next = sim.add("Next");
  const g = sim.add("G");
  sim.room.setReady(next, true);
  sim.room.unbind(oldHost, sim.now);
  sim.now += RECONNECT_GRACE_MS + 1;
  sim.tick();
  check("host leaves: the host passes on", sim.room.hostId === next.id && !sim.room.players.has(oldHost.id));
  check("host leaves: no READY on the new host's row", shown(sim, g, next) === false);
  e = sim.room.start(next, sim.now);
  check("host leaves: the new host need not be ready, G still is waited for", e === "Waiting for 1 player to get ready", e ?? "");
  sim.room.setReady(g, true);
  e = sim.room.start(next, sim.now);
  check("host leaves: the new host starts once G is ready", e === null, e ?? "");

  // The same rules through the message handler (ready and start with force on the wire).
  const rooms = new Rooms(1);
  const conn1 = new FakeConn();
  const conn2 = new FakeConn();
  const s1: Session = { conn: conn1, room: null, player: null };
  const s2: Session = { conn: conn2, room: null, player: null };
  const w0 = 5000;
  rooms.onMessage(s1, { t: "create", name: "W1" }, w0);
  rooms.onMessage(s2, { t: "join", code: s1.room!.code, name: "W2" }, w0 + 1000);
  const room = s1.room!;
  const lastErr = () => (conn1.msgs.filter((m) => m.t === "err").pop() as Extract<ServerMsg, { t: "err" }> | undefined)?.msg;
  rooms.onMessage(s2, { t: "ready", ready: "yes" } as unknown as ClientMsg, w0 + 2000);
  rooms.onMessage(s1, { t: "start" }, w0 + 2000);
  check("wire: a non-boolean ready is ignored, start refused", !s2.player!.ready && lastErr() === "Waiting for 1 player to get ready", lastErr());
  rooms.onMessage(s2, { t: "ready", ready: true }, w0 + 3000);
  rooms.onMessage(s2, { t: "ready", ready: false }, w0 + 4000);
  rooms.onMessage(s1, { t: "start", force: true }, w0 + 1000 + FORCE_START_MS - 1);
  check("wire: ready, un-ready, force too early refused", !s2.player!.ready && lastErr() === "Start anyway is not available yet", lastErr());
  rooms.onMessage(s1, { t: "start", force: true }, w0 + 1000 + FORCE_START_MS);
  check("wire: force accepted from forceStartAt", room.phase === "countdown" && !!s2.player!.car);
}

function garage(): void {
  const sim = new Sim();
  const a = sim.add("A");
  sim.add("B");
  const g0 = sim.lastGarage(a);
  check(
    "starting kit: 400 scrap, no rivets, no mines",
    g0?.scrap === 400 && a.ammo.rivets === 0 && a.ammo.mines === 0 && startingWallet().ammo.rivets === 0 && startingWallet().ammo.mines === 0,
    `scrap ${g0?.scrap}, ammo ${a.ammo.rivets}/${a.ammo.mines}`,
  );
  check("buy engine L1 (400)", sim.room.buy(a, "engine") === null && a.wallet.scrap === 0 && a.levels.engine === 1);
  check("garage sent after a purchase", sim.lastGarage(a)?.levels.engine === 1 && sim.lastGarage(a)?.scrap === 0);
  check("refused when too poor", sim.room.buy(a, "tyres") === "Not enough scrap");
  check("refused for unknown items", sim.room.buy(a, "laser") === "Unknown item");
  a.wallet.scrap = 10_000;
  a.ammo.rivets = 100;
  check("ammo cap enforced", sim.room.buy(a, "rivets") === "Already maxed out");
  a.ammo.rivets = 90;
  check("ammo pack clamps to the cap", sim.room.buy(a, "rivets") === null && a.ammo.rivets === 100);
  sim.room.buy(a, "welder");
  sim.room.buy(a, "welder");
  sim.room.buy(a, "welder");
  check("upgrade levels cap at 3", sim.room.buy(a, "welder") === "Already maxed out" && a.levels.welder === 3);
  sim.startRace(a);
  check("garage closed during a race", sim.room.buy(a, "mines") === "The garage is closed during a race");
  check(
    "upgrades change the stats the car steps with: engine raises accel, not top speed",
    a.stats.accel === statsFor("sport", a.levels).accel && a.stats.accel > BASE_STATS.accel * 1.069 && a.stats.topSpeed === BASE_STATS.topSpeed,
    `accel=${a.stats.accel.toFixed(1)} topSpeed=${a.stats.topSpeed}`,
  );

  // Welding rig L3: 6 HP/s.
  sim.place(a, 300, 0);
  a.hp = 50;
  sim.run(60);
  check("welding rig repairs while driving", Math.abs(a.hp - 56) < 0.01, `hp=${a.hp.toFixed(2)}`);

  // Pure helpers.
  const pay = payouts(
    [
      { id: "x", fin: 1000 },
      { id: "y", fin: 2000 },
      { id: "z", fin: 0 },
    ],
    new Map([["x", 2], ["z", 1]]),
  );
  check("payouts: place + 60 per wreck, DNF no place money", pay.get("x") === 1120 && pay.get("y") === 700 && pay.get("z") === 60);
  const w = startingWallet();
  check("shop.buy is pure on the wallet", shopBuy(w, "mines") === null && w.ammo.mines === 3 && w.scrap === 200);
  check("DT sanity", Math.abs(DT - 1 / 60) < 1e-12);
}

// ---- solid car collisions -------------------------------------------------------------

const body = (x: number, y: number, h: number, vx = 0, vy = 0): CarState => ({ x, y, h, vx, vy, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 });

/** b relative to a, in a's frame: along a's heading and sideways. */
function relPos(a: CarState, b: CarState): { along: number; lat: number } {
  const c = Math.cos(a.h), s = Math.sin(a.h);
  const dx = b.x - a.x, dy = b.y - a.y;
  return { along: dx * c + dy * s, lat: -dx * s + dy * c };
}

/**
 * Drive a and b for n ticks (straight-line motion, or a Room when given) and report whether
 * they ever overlapped after a tick, touched at all, or b went through a's body (crossed
 * a's nose-tail line within its width, or its side line within its length).
 */
function drive(a: CarState, b: CarState, n: number): { overlap: number; touched: boolean; through: boolean } {
  const r0 = relPos(a, b);
  let overlap = 0, touched = false, through = false;
  for (let i = 0; i < n; i++) {
    a.x += a.vx * DT; a.y += a.vy * DT;
    b.x += b.vx * DT; b.y += b.vy * DT;
    touched = collideCars(a, b) || touched;
    overlap = Math.max(overlap, -capsuleGap(a, b));
    const r = relPos(a, b);
    if (Math.sign(r.along) !== Math.sign(r0.along) && Math.abs(r.lat) < 16 && Math.abs(r0.lat) < 16) through = true;
    if (Math.sign(r.lat) !== Math.sign(r0.lat) && Math.abs(r.along) < 15.5 && Math.abs(r0.along) < 15.5) through = true;
  }
  return { overlap, touched, through };
}

/** Snapshot-shaped car (what the client's prediction sees). */
function snapCar(id: string, c: CarState, extra: Partial<CarSnap> = {}): CarSnap {
  return { k: "car", id, x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, seg: 0, lap: 0, rd: 0, fin: 0, hp: 100, maxHp: 100, wreck: c.wreck, air: c.air, fall: c.fall, boost: c.boost, ghost: false, ...extra };
}

function collisions(): void {
  // Shape: a capsule matching the drawn 30x16 car.
  const contactAt = (dirx: number, diry: number, h: number) => {
    let lo = 0, hi = 60;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (carContact(body(0, 0, 0), body(dirx * m, diry * m, h))) lo = m;
      else hi = m;
    }
    return lo;
  };
  const side = contactAt(0, 1, 0), nose = contactAt(1, 0, 0), tee = contactAt(0, 1, Math.PI / 2);
  check("capsule: contact at 16 between centres side by side", Math.abs(side - 16) < 0.01, side.toFixed(3));
  check("capsule: contact at 31 between centres nose to tail", Math.abs(nose - 31) < 0.01, nose.toFixed(3));
  check("capsule: T contact at 23.5 (nose to side)", Math.abs(tee - 23.5) < 0.01, tee.toFixed(3));
  const pushed = body(0, 0, 0), other = body(0, 10, 0);
  collideCars(pushed, other);
  check("an overlap resolves to exactly touching (side by side 10 -> 16)", Math.abs(other.y - pushed.y - 16) < 1e-9, `${(other.y - pushed.y).toFixed(6)}`);

  // No pass-through at twice top speed: head-on with every lateral offset that touches,
  // at several tick phases, and T-bones on a still and on a moving car.
  const V = 2 * BASE_STATS.topSpeed;
  let cases = 0, bad: string[] = [];
  for (const lat of [0, 0.5, 2, 5, 8, 12, 15]) {
    for (const start of [100, 100.4, 103.1, 107.7, 112]) {
      const r = drive(body(0, 0, 0, V, 0), body(start, lat, Math.PI, -V, 0), 40);
      cases++;
      if (r.through || r.overlap > 1e-6 || !r.touched) bad.push(`lat ${lat} start ${start}: ${JSON.stringify(r)}`);
    }
  }
  check(`no pass-through head-on at twice top speed (${cases} offsets and tick phases)`, bad.length === 0, bad.slice(0, 2).join("; "));
  cases = 0;
  bad = [];
  for (const avx of [0, V / 2, V]) {
    for (const bx of [-12, -5, 0, 5, 12]) {
      for (const off of [0, 3.3, 7.1, 11.9]) {
        const r = drive(body(0, 0, 0, avx, 0), body(bx + (avx * (60 + off)) / V, -60 - off, Math.PI / 2, 0, V), 40);
        cases++;
        if (r.through || r.overlap > 1e-6 || !r.touched) bad.push(`avx ${avx} bx ${bx} off ${off}: ${JSON.stringify(r)}`);
      }
    }
  }
  check(`no pass-through in a T-bone at twice top speed (${cases} cases)`, bad.length === 0, bad.slice(0, 2).join("; "));

  // The same through the server: Room ticks with stepCar, walls and the jitter buffer, on
  // the straight at s = 6500..6800.
  {
    const sim = new Sim();
    const a = sim.add("A");
    const b = sim.add("B");
    sim.startRace(a);
    sim.place(a, 6560, 3, V);
    sim.place(b, 6700, -3, V);
    b.car!.h += Math.PI;
    b.car!.vx = -b.car!.vx;
    b.car!.vy = -b.car!.vy;
    const r0 = relPos(a.car!, b.car!);
    let overlap = 0, through = false, minGap = Infinity;
    for (let i = 0; i < 30; i++) {
      sim.run(1, () => ({ throttle: 1 }));
      const g = capsuleGap(a.car!, b.car!);
      overlap = Math.max(overlap, -g);
      minGap = Math.min(minGap, g);
      const r = relPos(a.car!, b.car!);
      if (Math.sign(r.along) !== Math.sign(r0.along) && Math.abs(r.lat) < 16) through = true;
    }
    check("server: head-on at twice top speed bounces back, no overlap after any tick", !through && overlap < 1e-6 && minGap < 0.5, `min gap ${minGap.toFixed(3)}, max overlap ${overlap.toExponential(1)}`);

    sim.place(a, 6600, 0, 0);
    sim.place(b, 6600, -60, 0);
    b.car!.h += Math.PI / 2; // facing a's side
    b.car!.vx = Math.cos(b.car!.h) * V;
    b.car!.vy = Math.sin(b.car!.h) * V;
    const t0 = relPos(a.car!, b.car!);
    overlap = 0;
    through = false;
    minGap = Infinity;
    for (let i = 0; i < 20; i++) {
      sim.run(1, (p) => (p === b ? { throttle: 1 } : {}));
      const g = capsuleGap(a.car!, b.car!);
      overlap = Math.max(overlap, -g);
      minGap = Math.min(minGap, g);
      const r = relPos(a.car!, b.car!);
      if (Math.sign(r.lat) !== Math.sign(t0.lat) && Math.abs(r.along) < 15.5) through = true;
    }
    check("server: T-bone at twice top speed stops at the side, no overlap after any tick", !through && overlap < 1e-6 && minGap < 0.5, `min gap ${minGap.toFixed(3)}, max overlap ${overlap.toExponential(1)}`);
  }

  // One-sided resolver = collideCars for car a; b untouched.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let contacts = 0, maxDiff = 0, bMoved = 0, mismatched = 0;
  for (let i = 0; i < 20000; i++) {
    const a = body(rnd() * 10, rnd() * 10, rnd() * 7 - 3.5, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900);
    const b = body(a.x + (rnd() - 0.5) * 64, a.y + (rnd() - 0.5) * 64, rnd() * 7 - 3.5, (rnd() - 0.5) * 900, (rnd() - 0.5) * 900);
    const a1 = cloneCar(a), b1 = cloneCar(b), a2 = cloneCar(a), b2 = cloneCar(b);
    const hit = collideCars(a1, b1);
    const one = collideCarOneSided(a2, b2);
    if (hit !== !!one) mismatched++;
    if (hit) contacts++;
    for (const k of ["x", "y", "h", "vx", "vy"] as const) {
      maxDiff = Math.max(maxDiff, Math.abs(a1[k] - a2[k]));
      if (b2[k] !== b[k]) bMoved++;
    }
  }
  check(
    "one-sided resolver gives car a exactly collideCars' result, b unchanged",
    contacts > 5000 && maxDiff === 0 && bMoved === 0 && mismatched === 0,
    `${contacts} contacts, max diff ${maxDiff}, b changed ${bMoved}x, hit mismatches ${mismatched}`,
  );

  // Server: ghosted, wrecked and finished cars are skipped (side by side 10 apart stays 10).
  {
    const sim = new Sim();
    const a = sim.add("A");
    const b = sim.add("B");
    sim.startRace(a);
    const gapAfter = (prep: () => void) => {
      sim.place(a, 2000, -5);
      sim.place(b, 2000, 5);
      a.ghost = b.ghost = 0;
      a.finished = b.finished = false;
      prep();
      sim.run(1);
      return Math.hypot(b.car!.x - a.car!.x, b.car!.y - a.car!.y);
    };
    const solidGap = gapAfter(() => {});
    const ghostGap = gapAfter(() => (b.ghost = 30));
    const wreckGap = gapAfter(() => (b.car!.wreck = 30));
    const finGap = gapAfter(() => (b.finished = true));
    check("server: solid cars 10 apart are pushed to 16", Math.abs(solidGap - 16) < 0.5, solidGap.toFixed(2));
    check(
      "server: ghosted, wrecked and finished cars do not collide",
      [ghostGap, wreckGap, finGap].every((g) => Math.abs(g - 10) < 0.5),
      `ghost ${ghostGap.toFixed(2)}, wreck ${wreckGap.toFixed(2)}, finished ${finGap.toFixed(2)}`,
    );

    // Client prediction against a real snapshot: the same cars are skipped there.
    const snapWith = (prep: () => void) => {
      sim.place(a, 2000, -40);
      sim.place(b, 2000, 5);
      a.ghost = b.ghost = 0;
      a.finished = b.finished = false;
      prep();
      sim.run(2); // a snapshot goes out every 2 ticks
      const m = sim.conns.get(a.id)!.msgs.filter((x) => x.t === "snap").pop() as Extract<ServerMsg, { t: "snap" }>;
      return { cars: new Map(m.ents.filter((e): e is CarSnap => e.k === "car").map((e) => [e.id, e])) };
    };
    const predictHit = (snap: { cars: Map<string, CarSnap> }, wreck = 0) => {
      const c = new Contacts();
      c.setBase(snap, a.id);
      const bs = snap.cars.get(b.id)!;
      const own = body(bs.x - Math.sin(bs.h) * 10, bs.y + Math.cos(bs.h) * 10, bs.h); // 10 to b's side
      own.wreck = wreck;
      return !!c.collide(own, 0);
    };
    const solid = predictHit(snapWith(() => {}));
    const ghost = predictHit(snapWith(() => (b.ghost = 30)));
    const wreck = predictHit(snapWith(() => (b.car!.wreck = 30)));
    const fin = predictHit(snapWith(() => (b.finished = true)));
    const ownGhost = predictHit(snapWith(() => (a.ghost = 30)));
    const ownFin = predictHit(snapWith(() => (a.finished = true)));
    const ownWreck = predictHit(snapWith(() => {}), 30);
    check("client prediction: bumps a solid car from the snapshot", solid);
    check("client prediction: skips ghosted, wrecked and finished cars", !ghost && !wreck && !fin, `ghost ${ghost} wreck ${wreck} finished ${fin}`);
    check(
      "client prediction: no bumps while the own car is ghosted, finished or wrecked",
      !ownGhost && !ownFin && !ownWreck,
      `ghost ${ownGhost} finished ${ownFin} wrecked ${ownWreck}`,
    );
  }

  // Prediction pose: snapshot + v * k * DT, heading turned on at the car's turning speed.
  const ps = snapCar("o", body(100, 50, 0.3, 300, -120));
  const p3 = predicted(ps, 3), d9 = drawnPose(ps, 9, 2);
  check(
    "predicted pose = snapshot + v*k*DT, heading + turn*k*DT",
    Math.abs(p3.x - (100 + 300 * 3 * DT)) < 1e-9 && Math.abs(p3.y - (50 - 120 * 3 * DT)) < 1e-9 && p3.h === 0.3 &&
      Math.abs(d9.x - (100 + 300 * 9 * DT)) < 1e-9 && Math.abs(d9.h - (0.3 + 2 * 9 * DT)) < 1e-9,
    `k=3 (${p3.x.toFixed(2)}, ${p3.y.toFixed(2)}), k=9 turning 2 rad/s: h ${d9.h.toFixed(3)}`,
  );

  // No predicted bump past the cap: not for a step beyond it, nor while the own car ran
  // further ahead than it in the last snapshot cycle (near cars are not drawn predicted then).
  {
    const capSteps = Math.round((PREDICT_MAX_MS / 1000) * 60);
    const other = snapCar("o", body(100, 0, 0, 0, 0));
    const mk = () => {
      const c = new Contacts();
      c.setBase({ time: 0, cars: new Map([["o", other], ["me", snapCar("me", body(0, 0, 0))]]) }, "me");
      return c;
    };
    const touching = () => body(100, 10, 0); // 10 to the side of o: overlapping
    const inCap = !!mk().collide(touching(), capSteps);
    const pastCap = !!mk().collide(touching(), capSteps + 1);
    const ahead = mk();
    ahead.rebase({ time: 1000 / 30, cars: new Map([["o", other], ["me", snapCar("me", body(0, 0, 0))]]) }, "me", capSteps + 2, capSteps);
    const whileAhead = !!ahead.collide(touching(), 3);
    check(
      "no predicted bump past the cap (step beyond it, or the own car ran past it last cycle)",
      inCap && !pastCap && !whileAhead,
      `at cap ${inCap}, past cap ${pastCap}, k 3 while ahead ${whileAhead}`,
    );

    // The bump capsule is the drawn one: heading turned on at the turning speed.
    const t1 = { time: 0, cars: new Map([["o", snapCar("o", body(100, 0, 0, 0, 0))], ["me", snapCar("me", body(0, 0, 0))]]) };
    const t2 = { time: 1000 / 30, cars: new Map([["o", snapCar("o", body(100, 0, 0.2, 0, 0))], ["me", snapCar("me", body(0, 0, 0))]]) };
    const tc = new Contacts();
    tc.setBase(t1, "me");
    tc.rebase(t2, "me", 4, 2);
    const k = 9;
    const drawn = drawnPose(t2.cars.get("o")!, k, 0.2 / (1 / 30)); // turning 6 rad/s
    const own = body(drawn.x + 30 * Math.cos(drawn.h), drawn.y + 30 * Math.sin(drawn.h), drawn.h); // nose to tail, 1 deep
    const gapTurned = capsuleGap(own, drawn);
    const gapSnap = capsuleGap(own, { x: drawn.x, y: drawn.y, h: 0.2 });
    const hit = !!tc.collide(own, k);
    check(
      "predicted bump uses the drawn (turned) heading",
      gapTurned < 0 && gapSnap > 0 && hit,
      `drawn h ${drawn.h.toFixed(2)}, gap to drawn capsule ${gapTurned.toFixed(2)}, to snapshot heading ${gapSnap.toFixed(2)}, bumped ${hit}`,
    );
  }

  // Feedback: a hard live contact queues one effect, then a cooldown; replays never do.
  {
    const snap = { cars: new Map([["o", snapCar("o", body(100, 0, 0))], ["me", snapCar("me", body(0, 0, 0))]]) };
    const fx = new Contacts();
    fx.setBase(snap, "me");
    const hard = body(70, 0, 0, 300, 0); // nose 1 unit into o's tail, closing at 300
    fx.step(hard, 1);
    const first = fx.takeImpacts();
    let again = 0;
    for (let i = 0; i < 5; i++) {
      const c = body(70, 0, 0, 300, 0);
      fx.step(c, 1);
      again += fx.takeImpacts().length;
    }
    const replay = new Contacts();
    replay.setBase(snap, "me");
    const replayHit = replay.collide(body(70, 0, 0, 300, 0), 1);
    const slow = new Contacts();
    slow.setBase(snap, "me");
    slow.step(body(70, 0, 0, IMPACT_MIN_SPEED * 0.5, 0), 1);
    check(
      "impact effect: one for a hard live contact, at the contact point",
      first.length === 1 && Math.abs(first[0].x - 85) < 1e-6 && Math.abs(first[0].y) < 1e-9 && first[0].speed === 300, // nose 77.5, tail 92.5
      first.map((e) => `(${e.x.toFixed(2)}, ${e.y.toFixed(2)}) at ${e.speed}`).join() || "none",
    );
    check("impact effect: ~150 ms cooldown (none for the next 5 hard steps)", again === 0, `${again} more`);
    check("impact effect: replayed contacts and soft touches fire none", !!replayHit && replay.takeImpacts().length === 0 && slow.takeImpacts().length === 0);
    check("one-sided bump: own car takes half the push and half the impulse", Math.abs(hard.x - 69.5) < 1e-6 && Math.abs(hard.vx - 300 * (1 - (1 + CAR_RESTITUTION) / 2)) < 1e-6, `x ${hard.x.toFixed(3)} vx ${hard.vx.toFixed(2)}`);

    // Drawing: a near car eases to exactly its predicted pose; a far one stays interpolated.
    const draw = new Contacts();
    const near = snapCar("n", body(50, 20, 0.5, 200, 0));
    const far = snapCar("f", body(400, 0, 0, 200, 0));
    draw.setBase({ cars: new Map([["n", near], ["f", far], ["me", snapCar("me", body(0, 0, 0))]]) }, "me");
    const interp = [{ id: "n", x: 30, y: 20, h: 0.5 }, { id: "f", x: 380, y: 0, h: 0 }];
    let out = draw.blend(interp, body(0, 0, 0), 4.5, 16);
    const early = out[0].x;
    for (let i = 0; i < 40; i++) out = draw.blend(interp, body(0, 0, 0), 4.5, 16);
    const want = predicted(near, 4.5);
    check(
      "drawing: a near car eases (~500 ms) to exactly its predicted pose; a far car stays interpolated",
      early > 30 && early < want.x && out[0].x === want.x && out[0].y === want.y && out[1].x === 380,
      `first frame x ${early.toFixed(2)}, after 41 frames (${out[0].x.toFixed(2)}, ${out[0].y.toFixed(2)}) want (${want.x.toFixed(2)}, ${want.y.toFixed(2)}), far x ${out[1].x}`,
    );

    // A new snapshot that disagrees with the prediction by 2 units: no jump on screen and
    // no velocity jump either (the offset springs back; it does not decay from a kick).
    // Frames every 16 ms; the velocity change across the rebase counts (a plain decay of
    // the offset gives ~46 u/s there, the spring ~13).
    const t0 = 1000;
    const s1 = { time: t0, cars: new Map([["n", snapCar("n", body(50, 20, 0, 200, 0))], ["me", snapCar("me", body(0, 0, 0))]]) };
    const sm = new Contacts();
    sm.setBase(s1, "me");
    const iv = [{ id: "n", x: 30, y: 20, h: 0 }];
    const fk = 16 / (1000 / 60); // steps per 16 ms frame
    for (let i = 0; i < 40; i++) sm.blend(iv, body(0, 0, 0), 4 - fk, 16); // ease in
    const xs = [sm.blend(iv, body(0, 0, 0), 4 - fk, 0)[0], sm.blend(iv, body(0, 0, 0), 4, 16)[0]];
    const before = xs[1];
    const s2 = { time: t0 + 2000 / 60, cars: new Map([["n", snapCar("n", body(50 + (200 * 2) / 60, 22, 0, 200, 0))], ["me", snapCar("me", body(0, 0, 0))]]) };
    sm.rebase(s2, "me", 4, 2);
    const after = sm.blend(iv, body(0, 0, 0), 2, 0)[0];
    for (let i = 1; i <= 10; i++) xs.push(sm.blend(iv, body(0, 0, 0), 2 + i * fk, 16)[0]);
    let maxDv = 0;
    for (let i = 2; i < xs.length; i++) {
      const v2x = (xs[i].x - xs[i - 1].x) / 0.016, v2y = (xs[i].y - xs[i - 1].y) / 0.016;
      const v1x = (xs[i - 1].x - xs[i - 2].x) / 0.016, v1y = (xs[i - 1].y - xs[i - 2].y) / 0.016;
      maxDv = Math.max(maxDv, Math.hypot(v2x - v1x, v2y - v1y));
    }
    const settled = predicted(s2.cars.get("n")!, 2 + 10 * fk);
    check(
      "drawing: a snapshot jump of a near car is hidden without a jump in its velocity",
      Math.hypot(after.x - before.x, after.y - before.y) < 1e-9 && maxDv < 25 && Math.abs(xs[11].y - settled.y) < 0.3,
      `jump on screen ${Math.hypot(after.x - before.x, after.y - before.y).toExponential(1)}, max velocity change ${maxDv.toFixed(1)} u/s per frame (across the rebase too), y after 160 ms ${xs[11].y.toFixed(3)} (target ${settled.y})`,
    );

    // The own car ran further ahead than PREDICT_MAX_MS in the last snapshot cycle: near
    // cars ease back to the interpolated pose instead of standing still at the cap.
    const capSteps = Math.round((PREDICT_MAX_MS / 1000) * 60);
    draw.rebase({ cars: new Map([["n", near], ["f", far], ["me", snapCar("me", body(0, 0, 0))]]) }, "me", capSteps + 2, capSteps);
    let o2 = draw.blend(interp, body(0, 0, 0), capSteps, 16);
    for (let i = 0; i < 40; i++) o2 = draw.blend(interp, body(0, 0, 0), capSteps, 16);
    check("drawing: past the prediction cap near cars go back to the interpolated pose", o2[0].x === 30 && draw.weight("n") === 0, `x ${o2[0].x}`);
  }

  // How far the own car runs ahead of the newest snapshot (lead, in steps; it swings by 2
  // over each 30 Hz snapshot cycle) must never make near cars stutter: not at any steady
  // lead, around the cap, nor when the lead moves across the cap. Two cars at 300 u/s side
  // by side, 60 fps, JerkMeter as in the browser overlay.
  {
    const run = (leadAt: (i: number) => number, frames: number) => {
      const V = 300, DTMS = 1000 / 60, D = 100;
      const meter = new JerkMeter();
      const c = new Contacts();
      const carsAt = (tick: number) => ({
        time: tick * DTMS,
        cars: new Map([["o", snapCar("o", body(V * tick * DT, 30, 0, V, 0))], ["me", snapCar("me", body(V * tick * DT, 0, 0))]]),
      });
      let pending = 0;
      let first = true;
      for (let i = 0; i < frames; i++) {
        pending++; // one step per frame
        if (i % 2 === 0) {
          // a snapshot arrives: the server is `lead` ticks behind the own car's step
          const lead = leadAt(i);
          const snap = carsAt(i + D - lead);
          if (first) c.setBase(snap, "me");
          else c.rebase(snap, "me", pending, lead);
          first = false;
          pending = lead;
        }
        const now = i + D; // tick of the own car's step
        const own = body(V * now * DT, 0, 0);
        const interp = [{ id: "o", x: V * (now - 18) * DT, y: 30, h: 0 }];
        const drawnPoses = c.blend(interp, own, pending - 1, DTMS);
        if (i > 20) meter.frame(drawnPoses, (id) => c.weight(id), () => false, DTMS);
      }
      return meter;
    };
    const bad: string[] = [];
    let nearFrames = 0, farFrames = 0;
    for (let lead = 1; lead <= 24; lead++) {
      const m = run(() => lead, 360);
      nearFrames += m.near.frames;
      farFrames += m.far.frames;
      for (const [name, b] of [["near", m.near], ["ramp", m.ramp], ["far", m.far]] as const) {
        const st = b.stats();
        if (b.stutters > 0 || st.max > 60) bad.push(`lead ${lead} ${name}: ${b.stutters} stutters, max ${st.max.toFixed(0)}`);
      }
    }
    const cap = Math.round((PREDICT_MAX_MS / 1000) * 60);
    const swing = (i: number) => (Math.floor(i / 120) % 2 === 0 ? cap - 6 : cap + 1); // across the cap every 2 s
    const ms = run(swing, 1440);
    for (const [name, b] of [["near", ms.near], ["ramp", ms.ramp], ["far", ms.far]] as const) {
      const st = b.stats();
      if (b.stutters > 0 || st.max > 60) bad.push(`swinging lead ${name}: ${b.stutters} stutters, max ${st.max.toFixed(0)}`);
    }
    check(
      "no near-car stutter at any lead 1..24 steps, nor with the lead swinging across the cap",
      bad.length === 0 && nearFrames > 0 && farFrames > 0 && ms.ramp.frames > 60 && ms.near.frames > 300,
      bad.slice(0, 3).join("; ") || `near ${nearFrames} / far ${farFrames} frames over 24 leads; swinging: near ${ms.near.frames}, ramp ${ms.ramp.frames}, far ${ms.far.frames} frames`,
    );
  }
}

function armDelay(): void {
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.grantAmmo(); // ammo in hand, so "nothing fired" means the delay held it back
  sim.place(a, 200, 0);
  sim.place(b, 1500, 0);
  const rivets0 = a.ammo.rivets;
  const mines0 = a.ammo.mines;

  // Hold the gun from GO and tap the mine key every 20 ticks, the last tap just before 7.9 s.
  let taps = 0;
  let i = 0;
  while (sim.sinceGo() < 7900) {
    const tap = i++ % 20 === 0 || sim.sinceGo() + 1000 / 60 >= 7900;
    if (tap) taps++;
    sim.run(1, (p) => (p === a ? { fire: true, mine: tap } : {}));
  }
  const c = sim.room.combat;
  check(
    "armed delay: no rivet and no mine at ~7.9 s, ammo in hand",
    WEAPONS_ARM_MS === 8000 && rivets0 > 0 && mines0 > 0 && taps > 10 && a.ammo.rivets === rivets0 && a.ammo.mines === mines0 && c.shots.length === 0 && c.mines.length === 0,
    `t=${sim.sinceGo().toFixed(0)} ms, ${taps} mine taps, shots ${c.shots.length}, mines ${c.mines.length}`,
  );

  // Keep holding the gun (no new mine taps) until ~8.1 s.
  let firstShot = -1;
  while (sim.sinceGo() < 8100) {
    sim.run(1, (p) => (p === a ? { fire: true } : {}));
    if (firstShot < 0 && a.ammo.rivets < rivets0) firstShot = sim.sinceGo();
  }
  check(
    "armed delay: the rivet gun fires from 8 s",
    firstShot >= WEAPONS_ARM_MS && firstShot < 8100 && a.ammo.rivets < rivets0,
    `first shot at ${firstShot.toFixed(0)} ms, ${rivets0 - a.ammo.rivets} fired by ${sim.sinceGo().toFixed(0)} ms`,
  );
  sim.run(30);
  check(
    "armed delay: a mine press in the window never drops later",
    a.ammo.mines === mines0 && c.mines.length === 0,
    `mines ${mines0} -> ${a.ammo.mines}`,
  );
  sim.run(1, (p) => (p === a ? { mine: true } : {}));
  sim.run(1);
  check("armed delay: a mine press after 8 s drops a mine", a.ammo.mines === mines0 - 1 && c.mines.length === 1);
}


// Engine upgrade = acceleration only (playtest 2026-11-16). Pure physics on a flat straight:
// full throttle from standstill, same terminal speed at every level, L3 gets there sooner.
function engine(): void {
  const ok = [0, 1, 2, 3].every((e) => {
    const s = statsFor("sport", { engine: e, tyres: 0, welder: 0 });
    return s.topSpeed === BASE_STATS.topSpeed && Math.abs(s.accel - BASE_STATS.accel * (1 + 0.07 * e)) < 1e-9;
  });
  check("engine L0-L3: accel +7% per level, top speed always the base value", ok);
  const t2 = statsFor("sport", { engine: 3, tyres: 2, welder: 1 });
  check("tyres still scale grip and turn", Math.abs(t2.grip - BASE_STATS.grip * 1.2) < 1e-9 && Math.abs(t2.turn - BASE_STATS.turn * 1.08) < 1e-9);

  // A long closed loop whose bottom edge is a 12 000 u straight (collinear control points keep
  // the spline exactly on y = 0 there). The car starts at x = 1500 on the centerline, heading +x.
  const straight: TrackDef = {
    id: "test-straight",
    name: "Test Straight",
    control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [0, 3000]],
    halfWidth: 64,
    verge: 44,
  };
  const flat = buildTrack(straight);
  const SECONDS = 8;
  const drive = (level: number) => {
    const stats = statsFor("sport", { engine: level, tyres: 0, welder: 0 });
    const c: CarState = { x: 1500, y: 0, h: 0, vx: 0, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 };
    let t300 = -1;
    for (let i = 1; i <= SECONDS * TICK_HZ; i++) {
      stepCar(c, { throttle: 1, steer: 0 }, stats, flat);
      if (t300 < 0 && speedOf(c) >= 300) t300 = i * DT;
    }
    return { terminal: speedOf(c), t300, x: c.x, y: c.y };
  };
  const l0 = drive(0);
  const l3 = drive(3);
  const detail = (r: ReturnType<typeof drive>) =>
    `terminal ${r.terminal.toFixed(2)} u/s, 300 u/s at ${r.t300.toFixed(3)} s, x=${r.x.toFixed(0)} y=${r.y.toFixed(2)}`;
  check("engine L0 run stays on the straight", l0.x < 12000 && Math.abs(l0.y) < 1e-6, detail(l0));
  check("engine L3 run stays on the straight", l3.x < 12000 && Math.abs(l3.y) < 1e-6, detail(l3));
  check(
    "engine L3 and L0 reach the same terminal speed (within 1%)",
    Math.abs(l3.terminal - l0.terminal) / l0.terminal < 0.01,
    `L0 ${l0.terminal.toFixed(2)} vs L3 ${l3.terminal.toFixed(2)} u/s`,
  );
  check(
    "engine L3 reaches 300 u/s measurably sooner than L0 (>= 10%)",
    l0.t300 > 0 && l3.t300 > 0 && l3.t300 <= l0.t300 * 0.9,
    `L0 ${l0.t300.toFixed(3)} s vs L3 ${l3.t300.toFixed(3)} s`,
  );
}

// ---- M3-T1a: track features, jumps, falls, recovery, track validation ------------------
// Pure shared code on small synthetic tracks (no Room): stepRaceCar, validateTrack and
// validateRunUps. Lateral offsets are + = right of travel; on the test straight (heading
// +x) that is +y.

/** The test straight (as in the engine test): x = 1000..11000 lies exactly on y = 0. */
const JUMPS_BASE: TrackDef = {
  id: "test-jumps",
  name: "Test Jumps",
  control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [0, 3000]],
  halfWidth: 64,
  verge: 44,
};

function trackFeatures(): void {
  const plain = buildTrack(JUMPS_BASE);
  const sx = (x: number) => queryTrack(plain, x, 0).s; // s of a point on the straight
  // A ramp ending at x = 2500 straight into a 200-unit gap, a hole at x = 4000 on the
  // centerline, recovery points at the start line, x = 2000 (before the jump) and 3500.
  const jumpsDef = (gapLen = 200, recovery = [0, sx(2000), sx(3500)]): TrackDef => ({
    ...JUMPS_BASE,
    features: [
      { k: "ramp", s: sx(2400), len: 100 },
      { k: "gap", s0: sx(2500), s1: sx(2500 + gapLen) },
      { k: "hole", s: sx(4000), lat: 0, r: 30 },
    ],
    recovery,
  });
  const jt = buildTrack(jumpsDef());
  const carAt = (t: Track, x: number, y: number, speed: number, h = 0): CarState => ({
    x, y, h, vx: Math.cos(h) * speed, vy: Math.sin(h) * speed, seg: queryTrack(t, x, y).seg, wreck: 0, air: 0, fall: 0, boost: 0,
  });
  type Ev = { i: number; ev: RaceStepEvent; x: number; y: number; v: number };
  /** Step n ticks; returns the events with the pose after the step and the speed before it. */
  const run = (t: Track, c: CarState, n: number, input = { throttle: 1, steer: 0 }, until?: (e: Ev) => boolean) => {
    const evs: Ev[] = [];
    for (let i = 0; i < n; i++) {
      const v = speedOf(c);
      const ev = stepRaceCar(c, input, BASE_STATS, raceEnv(t));
      if (ev) {
        const e = { i, ev, x: c.x, y: c.y, v };
        evs.push(e);
        if (until?.(e)) break;
      }
    }
    return evs;
  };
  const kinds = (evs: Ev[]) => evs.map((e) => e.ev).join(",");
  const lipStart = 2500; // the ramp's end, in x

  // 1. A full-throttle run from rest at the recovery point clears the jump.
  {
    const c = carAt(jt, 2000, 0, 0);
    const evs = run(jt, c, 200, undefined, (e) => e.ev === "takeoff");
    const off = evs[0];
    const air0 = c.air!;
    const frozen = { vx: c.vx, vy: c.vy, h: c.h };
    // Committed flight: a twin fed full brake and full lock flies exactly the same.
    const twin = cloneCar(c);
    let same = true, frozenOk = true, peak = 0;
    let ticks = 0;
    while (c.air! > 0 && ticks < 200) {
      stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
      stepRaceCar(twin, { throttle: -1, steer: 1 }, BASE_STATS, raceEnv(jt));
      ticks++;
      peak = Math.max(peak, airHeight(c));
      same &&= c.x === twin.x && c.y === twin.y && c.h === twin.h && c.vx === twin.vx && c.air === twin.air;
      frozenOk &&= c.vx === frozen.vx && c.vy === frozen.vy && c.h === frozen.h;
    }
    const landX = c.x;
    const q = queryTrackNear(jt, c.x, c.y, c.seg);
    check(
      "jump: full throttle from rest at the recovery point takes off in the lip zone",
      evs.length === 1 && off.ev === "takeoff" && off.x >= lipStart && off.x < lipStart + LIP_ZONE + 8 && off.v >= MIN_TAKEOFF_SPEED,
      `take-off after ${off?.i} ticks at x=${off?.x.toFixed(1)}, ${off?.v.toFixed(1)} u/s`,
    );
    check(
      "jump: air time = airTicksFor(speed); the car flies that many ticks",
      air0 === airTicksFor(speedOf(c)) - 1 && ticks === air0,
      `air ${air0 + 1} ticks for ${speedOf(c).toFixed(1)} u/s`,
    );
    check("jump: committed flight (velocity and heading frozen, input ignored)", same && frozenOk && ticks > 0);
    check("jump: airHeight rises to ~1 mid-flight and is 0 on the ground", peak > 0.95 && peak <= 1 && airHeight(c) === 0, `peak ${peak.toFixed(3)}`);
    const after = run(jt, c, 60);
    check(
      "jump: lands on the road past the gap and drives on",
      landX > 2700 && q.dist <= jt.def.halfWidth && c.fall === 0 && after.length === 0 && speedOf(c) > 300,
      `landed at x=${landX.toFixed(1)}, ${q.dist.toFixed(2)} from the centerline`,
    );
  }

  // 2. Just over the minimum speed: takes off, falls short into the gap.
  let fallX = 0;
  {
    const c = carAt(jt, 2490, 0, MIN_TAKEOFF_SPEED + 20);
    const evs = run(jt, c, 120, undefined, (e) => e.ev === "fall");
    fallX = evs[1]?.x ?? 0;
    check(
      "jump: just over the minimum speed it takes off and falls short",
      kinds(evs) === "takeoff,fall" && fallX > 2500 && fallX < 2700 && c.fall === FALL_TICKS && c.air === 0 && c.vx === 0 && c.vy === 0,
      `${kinds(evs)} at x=${fallX.toFixed(1)}`,
    );
    // Fall timing and the recovery point.
    const at = { x: c.x, y: c.y };
    let still = true, ticks = 0, ev: RaceStepEvent | null = null;
    const counts: number[] = [];
    while (!ev && ticks < 200) {
      ev = stepRaceCar(c, { throttle: 1, steer: 1 }, BASE_STATS, raceEnv(jt));
      ticks++;
      if (!ev) {
        counts.push(c.fall!);
        still &&= c.x === at.x && c.y === at.y && c.vx === 0 && c.vy === 0;
      }
    }
    const rec = pointAt(jt, sx(2000));
    check(
      "fall: frozen for FALL_TICKS ticks, then 'recover'",
      ev === "recover" && ticks === FALL_TICKS && still && counts[0] === FALL_TICKS - 1 && counts[counts.length - 1] === 1,
      `recovered after ${ticks} ticks`,
    );
    check(
      "fall: placed at the last recovery point before it, facing along the track, speed 0",
      Math.abs(c.x - rec.x) < 1e-9 && Math.abs(c.y - rec.y) < 1e-9 && c.h === rec.h && c.vx === 0 && c.vy === 0 && c.air === 0 && c.fall === 0 && c.seg === rec.seg,
      `at x=${c.x.toFixed(1)} y=${c.y.toFixed(2)} h=${c.h.toFixed(3)}`,
    );
  }

  // 3. Too slow at the lip: rolls off the end into the gap (no take-off).
  {
    const c = carAt(jt, 2470, 0, 100);
    const evs = run(jt, c, 120, undefined, (e) => e.ev === "fall");
    check(
      "jump: below the minimum speed it rolls off the ramp into the gap",
      kinds(evs) === "fall" && evs[0].x >= 2500 && evs[0].x < 2520 && evs[0].v < MIN_TAKEOFF_SPEED,
      `${kinds(evs)} at x=${evs[0]?.x.toFixed(1)}, ${evs[0]?.v.toFixed(1)} u/s`,
    );
    // Level-triggered: a fast car already inside the lip zone takes off on its next step;
    // the same car moving backward through it does not.
    const fwd = carAt(jt, 2503, 0, 300);
    const back = carAt(jt, 2503, 0, 300, Math.PI);
    const ef = stepRaceCar(fwd, NO_COMMAND, BASE_STATS, raceEnv(jt)), eb = stepRaceCar(back, NO_COMMAND, BASE_STATS, raceEnv(jt));
    check("jump: take-off is level-triggered in the lip zone, forward only", ef === "takeoff" && eb === "fall", `forward ${ef}, backward ${eb}`);
  }

  // 4. Holes.
  {
    const inLine = carAt(jt, 3800, 0, 200);
    const e1 = run(jt, inLine, 120, { throttle: 0.5, steer: 0 }, (e) => e.ev === "fall");
    const beside = carAt(jt, 3800, 45, 200);
    const e2 = run(jt, beside, 120, { throttle: 0.5, steer: 0 });
    check(
      "hole: a grounded car whose centre enters the pit falls",
      kinds(e1) === "fall" && Math.hypot(e1[0].x - 4000, e1[0].y) < 30,
      `fell at x=${e1[0]?.x.toFixed(1)}`,
    );
    check("hole: a car passing beside it (45 off the line) drives on", e2.length === 0 && beside.x > 4100, `x=${beside.x.toFixed(0)} y=${beside.y.toFixed(1)}`);
  }

  // 5. Lost: no global snap; further than 2 * wall from its own section = falls.
  {
    const c = carAt(jt, 6000, 0, 0);
    c.y = 2 * jt.wall + 10;
    const q = queryTrackNear(jt, c.x, c.y, c.seg);
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
    check("lost: > 2 * wall from its own section falls", ev === "fall" && c.fall === FALL_TICKS && Math.abs(q.dist - (2 * jt.wall + 10)) < 1e-6, `dist ${q.dist.toFixed(1)}`);
    // A sideways jump that lands beyond the walls falls.
    const side = carAt(jt, 2503, 0, 380, 0.5);
    const evs = run(jt, side, 100, undefined, (e) => e.ev === "fall");
    check("lost: a jump that lands outside the walls falls", kinds(evs) === "takeoff,fall" && Math.abs(evs[1].y) > jt.wall, `landed y=${evs[1]?.y.toFixed(1)}`);
  }

  // 6. Recovery point choice, wrapping to the last point of the lap before.
  {
    const wrapT = buildTrack(jumpsDef(200, [sx(3500), sx(2000)]));
    const rs = [recoveryAt(jt, sx(2600)), recoveryAt(jt, sx(2000)), recoveryAt(jt, sx(1999)), recoveryAt(jt, sx(5000)), recoveryAt(jt, jt.length - 1)];
    check(
      "recovery: last point at or before s",
      rs[0] === sx(2000) && rs[1] === sx(2000) && rs[2] === 0 && rs[3] === sx(3500) && rs[4] === sx(3500),
      rs.map((r) => r.toFixed(1)).join(" "),
    );
    const c = carAt(wrapT, 1500, 0, 0);
    c.y = 300; // lost before the first recovery point
    const evs = run(wrapT, c, FALL_TICKS + 5, undefined, (e) => e.ev === "recover");
    const p = pointAt(wrapT, sx(3500));
    check(
      "recovery: before the first point it wraps to the last one (defs need not list s = 0)",
      kinds(evs) === "fall,recover" && wrapT.recovery[0] === sx(2000) && Math.abs(c.x - p.x) < 1e-9 && Math.abs(c.y - p.y) < 1e-9,
      `${kinds(evs)}, recovered at x=${c.x.toFixed(1)}`,
    );
  }

  // 7. Precedence: wreck > fall > air > drive.
  {
    const c = carAt(jt, 3000, 0, 0);
    c.wreck = 3;
    c.fall = 50;
    c.air = 10;
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
    check("precedence: a wreck beats fall and air (only the wreck counts down)", ev === null && c.wreck === 2 && c.fall === 50 && c.air === 10 && c.x === 3000);
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
    check("precedence: the respawn clears fall and air", c.wreck === 0 && c.fall === 0 && c.air === 0 && Math.abs(c.y) < 1e-9);
    const f = carAt(jt, 3000, 0, 200);
    f.fall = 10;
    f.air = 10;
    const e2 = stepRaceCar(f, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(jt));
    check("precedence: a fall beats air (frozen, no flight)", e2 === null && f.fall === 9 && f.air === 10 && f.x === 3000 && f.vx === 0);
    // A wreck respawn over a gap goes to the recovery point; on the road it stays put.
    const w = carAt(jt, 2600, 0, 0);
    wreckCar(w);
    for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(w, NO_COMMAND, BASE_STATS, raceEnv(jt));
    const rec = pointAt(jt, sx(2000));
    const r = carAt(jt, 3000, 20, 0);
    wreckCar(r);
    for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(r, NO_COMMAND, BASE_STATS, raceEnv(jt));
    check(
      "wreck respawn onto a gap goes to the recovery point",
      w.wreck === 0 && Math.abs(w.x - rec.x) < 1e-9 && Math.abs(r.x - 3000) < 1e-6 && Math.abs(r.y) < 1e-9,
      `gap wreck -> x=${w.x.toFixed(1)}, road wreck -> x=${r.x.toFixed(1)}`,
    );
    const a = carAt(jt, 2503, 0, 300);
    stepRaceCar(a, NO_COMMAND, BASE_STATS, raceEnv(jt));
    const wasAir = a.air!;
    wreckCar(a);
    check("wreckCar ends a jump or a fall", wasAir > 0 && a.air === 0 && a.fall === 0 && a.wreck === WRECK_TICKS);
  }

  // 8. Prediction parity: a clone taken at any tick and stepped with the same inputs gives
  // exactly the reference states (take-off, flight, landing, fall, recovery).
  {
    const ref = carAt(jt, 2000, 0, 0);
    const inputs: { throttle: number; steer: number }[] = [];
    const states: CarState[] = [cloneCar(ref)];
    const evs: RaceStepEvent[] = [];
    for (let i = 0; i < 800; i++) {
      // Drive the jump, then brake back and roll the wrong way into the gap.
      const inp = i < 200 ? { throttle: 1, steer: Math.sin(i / 30) * 0.05 } : { throttle: -1, steer: 0 };
      inputs.push(inp);
      const ev = stepRaceCar(ref, inp, BASE_STATS, raceEnv(jt));
      if (ev) evs.push(ev);
      states.push(cloneCar(ref));
    }
    const fields = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall"] as const;
    let mismatches = 0, starts = 0;
    for (let k = 0; k < inputs.length; k += 7) {
      const c = cloneCar(states[k]);
      starts++;
      for (let i = k; i < inputs.length; i++) {
        stepRaceCar(c, inputs[i], BASE_STATS, raceEnv(jt));
        if (fields.some((f) => c[f] !== states[i + 1][f])) mismatches++;
      }
    }
    check(
      "prediction parity: stepRaceCar on a clone == reference run through jump, fall and recovery",
      mismatches === 0 && evs.includes("takeoff") && evs.includes("fall") && evs.includes("recover"),
      `${starts} clones, events ${evs.join(",")}, ${mismatches} mismatches`,
    );
    const src: CarState = { x: 1, y: 2, h: 3, vx: 4, vy: 5, seg: 6, wreck: 0, air: 7, fall: 8, boost: 0 };
    const cl = cloneCar(src);
    check("cloneCar copies air and fall", cl.air === 7 && cl.fall === 8 && cl !== src);
  }

  // 9. A crossing: a figure-eight whose upper pass jumps over the lower road.
  const N = 16, A = 2400;
  const eightBase: TrackDef = {
    id: "test-eight",
    name: "Test Eight",
    halfWidth: 64,
    verge: 44,
    control: Array.from({ length: N }, (_, k): [number, number] => {
      const t = Math.PI / 2 + (2 * Math.PI * k) / N;
      return [Math.round(A * Math.sin(t)), Math.round(A * Math.sin(t) * Math.cos(t))];
    }),
  };
  const e0 = buildTrack(eightBase);
  const upperSeg = 64, lowerSeg = 192; // the two passes through the origin
  const sUp = queryTrackNear(e0, 0, 0, upperSeg).s;
  const eightDef = (half: number, runUp = 400): TrackDef => ({
    ...eightBase,
    features: [
      { k: "ramp", s: sUp - half - 60, len: 60 },
      { k: "gap", s0: sUp - half, s1: sUp + half },
    ],
    recovery: [0, sUp - half - 60 - runUp],
  });
  {
    const plainErr = validateTrack(e0);
    const shortErr = validateTrack(buildTrack(eightDef(60)));
    const good = buildTrack(eightDef(125));
    const goodErr = validateTrack(good);
    check("validation: a crossing without a gap is caught", plainErr.some((e) => e.includes("ground corridors overlap")), plainErr[0]);
    check("validation: a crossing whose gap is too short is caught", shortErr.some((e) => e.includes("ground corridors overlap")), shortErr[0]);
    check("validation: a crossing covered by a 250-unit gap validates", goodErr.length === 0, goodErr.join("; "));
    const runUps = validateRunUps(good);
    const tooShort = validateRunUps(buildTrack(eightDef(125, 200)));
    check("run-up: the crossing jump can be made from its recovery point", runUps.length === 0, runUps.join("; "));
    check("run-up: a 200-unit run-up to the crossing jump is caught", tooShort.length === 1 && tooShort[0].includes("lands short"), tooShort[0]);

    // Jump over the lower road: the car keeps its own section all the way (no snap).
    const rec = pointAt(good, good.recovery[1]);
    const c: CarState = { x: rec.x, y: rec.y, h: rec.h, vx: 0, vy: 0, seg: rec.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const segs: number[] = [];
    const evs: RaceStepEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const q = queryTrackNear(good, c.x, c.y, c.seg);
      const t = pointAt(good, q.s + 60 + speedOf(c) * 0.25);
      const steer = clamp(angleDiff(c.h, Math.atan2(t.y - c.y, t.x - c.x)) * 2.2, -1, 1);
      const ev = stepRaceCar(c, { throttle: 1, steer }, BASE_STATS, raceEnv(good));
      if (ev) evs.push(ev);
      if (c.air! > 0) segs.push(c.seg);
    }
    const n = good.pts.length;
    const cyc = (a: number, b: number) => Math.min(Math.abs(a - b), n - Math.abs(a - b));
    const passedOver = segs.some((s) => cyc(s, upperSeg) <= 1);
    check(
      "crossing: a car jumping over the lower road keeps its own section and lands beyond",
      evs.join(",") === "takeoff" && passedOver && segs.every((s) => cyc(s, upperSeg) < 12) && cyc(c.seg, lowerSeg) > 40,
      `events ${evs.join(",")}, flight segs ${segs[0]}..${segs[segs.length - 1]}`,
    );
    // No global fallback: a point on the lower road, searched around a hint on the upper
    // section, stays on the upper section (lost) instead of snapping onto the lower road.
    const lowPt = pointAt(good, queryTrackNear(good, 0, 0, lowerSeg).s + 400);
    const qLow = queryTrackNear(good, lowPt.x, lowPt.y, upperSeg);
    check(
      "queryTrackNear never snaps to another section (no global fallback)",
      cyc(qLow.seg, upperSeg) <= 13 && qLow.dist > 2 * good.wall && queryTrack(good, lowPt.x, lowPt.y).dist < 1e-6,
      `seg ${qLow.seg}, dist ${qLow.dist.toFixed(1)}`,
    );
    // The lower road runs under the gap: a car on it drives straight through.
    const lp = pointAt(good, queryTrackNear(good, 0, 0, lowerSeg).s - 300);
    const d: CarState = { x: lp.x, y: lp.y, h: lp.h, vx: Math.cos(lp.h) * 250, vy: Math.sin(lp.h) * 250, seg: lp.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const devs: RaceStepEvent[] = [];
    const dsegs: number[] = [];
    for (let i = 0; i < 150; i++) {
      const q = queryTrackNear(good, d.x, d.y, d.seg);
      const t = pointAt(good, q.s + 60 + speedOf(d) * 0.25);
      const ev = stepRaceCar(d, { throttle: 0.6, steer: clamp(angleDiff(d.h, Math.atan2(t.y - d.y, t.x - d.x)) * 2.2, -1, 1) }, BASE_STATS, raceEnv(good));
      if (ev) devs.push(ev);
      dsegs.push(d.seg);
    }
    check(
      "crossing: a car on the lower road drives under the gap without falling",
      devs.length === 0 && dsegs.some((s) => cyc(s, lowerSeg) <= 1) && dsegs.every((s) => cyc(s, lowerSeg) < 20),
      `events [${devs.join(",")}], segs ${dsegs[0]}..${dsegs[dsegs.length - 1]}`,
    );
  }

  // 10. Validation: near sections must be far apart in segment index; start zone; recovery.
  {
    const clip = buildTrack({ id: "test-clip", name: "Test Clip", halfWidth: 64, verge: 44, control: [[0, 0], [3000, 0], [3000, 200], [0, 200]] });
    const clipErr = validateTrack(clip);
    check("validation: sections that come near within too few segment indices are caught", clipErr.some((e) => e.includes("segments apart")), clipErr.find((e) => e.includes("segments apart")));
    const L = plain.length;
    const grid = validateTrack(buildTrack({ ...jumpsDef(), features: [...jumpsDef().features!, { k: "hole", s: L - 150, lat: 0, r: 20 }] }));
    const start = validateTrack(buildTrack({ ...jumpsDef(), features: [...jumpsDef().features!, { k: "ramp", s: 120, len: 60 }] }));
    check("validation: a feature in the grid zone is caught", grid.length === 1 && grid[0].includes("start zone"), grid.join("; "));
    check("validation: a feature on the start straight is caught", start.length === 1 && start[0].includes("start zone"), start.join("; "));
    const badRec = validateTrack(buildTrack(jumpsDef(200, [0, sx(2600)])));
    check("validation: a recovery point inside a gap is caught", badRec.length === 1 && badRec[0].includes("recovery point"), badRec.join("; "));
    const okErr = validateTrack(jt);
    check("validation: the jump test track validates", okErr.length === 0, okErr.join("; "));
  }

  // 11. The run-up validator.
  {
    const ok = validateRunUps(jt);
    const long = validateRunUps(buildTrack(jumpsDef(300)));
    const slow = validateRunUps(buildTrack(jumpsDef(200, [0, sx(2470), sx(3500)])));
    check("run-up: every recovery point of the jump test track gets past its hazard", ok.length === 0, ok.join("; "));
    check("run-up: an impossible jump (300-unit gap after a 500-unit run-up) is caught", long.length === 1 && long[0].includes("lands short"), long.join("; "));
    check("run-up: a recovery point too close to the ramp to reach take-off speed is caught", slow.length === 1 && slow[0].includes("rolls into a gap"), slow.join("; "));
  }

  // 12. Rust Bowl: still valid, no features, behaviour unchanged (the tests above this section).
  {
    const errs = [...validateTrack(track), ...validateRunUps(track)];
    check(
      "Rust Bowl validates (no features, recovery = start line)",
      errs.length === 0 && RUST_BOWL.id === "rust-bowl" && track.ramps.length + track.gaps.length + track.holes.length === 0 && track.recovery.join() === "0",
      errs.join("; "),
    );
  }
}

// ---- per-room track (M3-T2) ----------------------------------------------------------

// This section's imports (hoisted like the ones at the top; queryTrack and Track come from there).
import { CRUSHER_RUN, gridSlot, OVERPASS_KNOT } from "../shared/track";
import { DEFAULT_TRACK_ID, registerTestTrack, trackById, trackList } from "../shared/tracks";

/** Sim.place on any track (Sim.place uses the default track). */
function placeOn(t: Track, p: Player, s: number, lateral = 0, speed = 0): void {
  const pt = pointAt(t, s);
  const x = pt.x - Math.sin(pt.h) * lateral;
  const y = pt.y + Math.cos(pt.h) * lateral;
  p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  p.progress = { s: queryTrackNear(t, x, y, pt.seg).s, cp: 1, lap: 0, fin: 0 };
}

function roomTrack(): void {
  // A track for this test only (not shipped), far away from Rust
  // Bowl: a car, a shot or a lap on it cannot pass by accident on the default track.
  const LOOP = "test-loop";
  const loopDef: TrackDef = {
    id: LOOP,
    name: "Test Loop",
    control: [[5000, 400], [5600, 400], [6050, 650], [6050, 1250], [5600, 1500], [4600, 1500], [4150, 1250], [4150, 650], [4500, 400]],
    halfWidth: 64,
    verge: 44,
  };
  registerTestTrack(loopDef);
  const loop = trackById(LOOP);
  const rust = trackById(DEFAULT_TRACK_ID);
  check("track: the test loop is nowhere near Rust Bowl", loop.pts.every((q) => queryTrack(rust, q.x, q.y).dist > 4 * rust.wall));
  check(
    "track: the registry ships rust-bowl (first, the default), crusher-run, overpass-knot, slag-harbour and breakers-mile, keyed by TrackDef.id",
    trackList().map((e) => e.id).join() === `${DEFAULT_TRACK_ID},crusher-run,overpass-knot,slag-harbour,breakers-mile,${LOOP}` &&
      rust.def === RUST_BOWL && trackList()[0].name === RUST_BOWL.name &&
      trackById("crusher-run").def === CRUSHER_RUN && trackById("overpass-knot").def === OVERPASS_KNOT,
    trackList().map((e) => e.id).join(),
  );
  // Every registered track (the shipped one and the test loop) passes T1a's validators.
  const invalid = trackList().flatMap((e) => [...validateTrack(trackById(e.id)), ...validateRunUps(trackById(e.id))].map((m) => `${e.id}: ${m}`));
  check("track: every registered track passes validateTrack and validateRunUps", invalid.length === 0, invalid.join("; "));

  // A new room: the default track, built from the registry, in the room message.
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  const c = sim.add("C");
  check(
    "track: a new room races on rust-bowl from the registry; the room message says so",
    sim.room.trackId === DEFAULT_TRACK_ID && sim.room.track === rust && [a, b, c].every((p) => sim.lastRoom(p)?.trackId === DEFAULT_TRACK_ID),
  );

  // Host only; unknown ids refused; the current track again changes nothing.
  sim.room.setReady(b, true);
  sim.room.setReady(c, true);
  let e = sim.room.setTrack(b, LOOP);
  check("track: refused from a non-host", e === "Only the host can pick the track" && sim.room.trackId === DEFAULT_TRACK_ID && b.ready, e ?? "");
  const bad: unknown[] = ["no-such-track", "", "RUST-BOWL", " rust-bowl", "__proto__", "toString", 7, null, undefined, {}, ["rust-bowl"]];
  const refusals = bad.map((id) => sim.room.setTrack(a, id));
  check(
    "track: unknown ids refused (also non-strings and object keys)",
    refusals.every((x) => x === "Unknown track") && sim.room.trackId === DEFAULT_TRACK_ID && sim.room.track === rust && b.ready && c.ready,
    refusals.join(", "),
  );
  const nMsgs = sim.conns.get(b.id)!.msgs.length;
  e = sim.room.setTrack(a, DEFAULT_TRACK_ID);
  check("track: picking the current track keeps ready and sends nothing", e === null && b.ready && c.ready && sim.conns.get(b.id)!.msgs.length === nMsgs);

  // The switch: everyone hears the new trackId and readies again.
  e = sim.room.setTrack(a, LOOP);
  check(
    "track: the host switches in the lobby; every room message carries the new trackId",
    e === null && sim.room.trackId === LOOP && sim.room.track === loop && [a, b, c].every((p) => sim.lastRoom(p)?.trackId === LOOP),
    e ?? "",
  );
  check("track: the switch resets everyone's ready flag", !b.ready && !c.ready && sim.lastRoom(a)!.players.every((p) => !p.ready));
  e = sim.room.start(a, sim.now);
  check("track: Start waits for everyone again after a switch", e === "Waiting for 2 players to get ready", e ?? "");

  // Rejoin and a fresh joiner both get the room's track.
  sim.room.unbind(c, sim.now);
  sim.rebind(c);
  const d = sim.add("D");
  check("track: a rejoin and a new joiner get trackId in their room message", sim.lastRoom(c)?.trackId === LOOP && sim.lastRoom(d)?.trackId === LOOP);

  // Race on it: the grid, walls, shots and laps are the test loop's.
  sim.startRace(a);
  const racers = [a, b, c, d];
  const onGrid = racers.every((p) => [0, 1, 2, 3].some((slot) => {
    const g = gridSlot(loop, slot);
    return Math.hypot(p.car!.x - g.x, p.car!.y - g.y) < 1e-6;
  }));
  check("track: the race starts on the test loop's grid", onGrid, racers.map((p) => `${p.car!.x.toFixed(0)},${p.car!.y.toFixed(0)}`).join(" "));
  e = sim.room.setTrack(a, DEFAULT_TRACK_ID);
  check("track: refused outside the lobby (racing)", e === "The track can only be changed in the lobby" && sim.room.trackId === LOOP, e ?? "");

  sim.armWeapons();
  for (const [i, p] of racers.entries()) placeOn(loop, p, 2000 + i * 400, 0); // spread out, nobody in the line of fire
  placeOn(loop, a, 100, 0); // the start straight
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(10);
  check("track: a rivet flies along the test loop (combat uses the room's track)", sim.room.combat.shots.length === 1, `${sim.room.combat.shots.length} shots`);
  sim.run(60);
  placeOn(loop, a, 300, 0);
  a.car!.h += Math.PI / 2;
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(1);
  const fired = sim.room.combat.shots.length;
  sim.run(12);
  check("track: a rivet stops at the test loop's wall", fired === 1 && sim.room.combat.shots.length === 0, `fired=${fired}`);

  for (const p of racers) {
    placeOn(loop, p, loop.length - 40, 0, 300);
    p.progress!.cp = 3;
    sim.run(15, (q) => (q === p ? { throttle: 1 } : {}));
  }
  const finishes = sim.eventsOf("finish");
  check(
    "track: every car finishes its lap on the test loop",
    finishes.length === 4 && racers.every((p) => p.progress!.fin > 0) && sim.room.phase === "results",
    `${finishes.length} finishes, phase ${sim.room.phase}`,
  );
  e = sim.room.setTrack(a, DEFAULT_TRACK_ID);
  check("track: refused outside the lobby (results)", e === "The track can only be changed in the lobby", e ?? "");
  const phase = (): string => sim.room.phase; // not narrowed by the check above
  while (phase() !== "lobby") sim.run(1);
  check("track: the room stays on its track after a race", sim.room.trackId === LOOP && sim.lastRoom(b)?.trackId === LOOP);

  // The same through the message handler.
  const rooms = new Rooms(1);
  const conn1 = new FakeConn();
  const conn2 = new FakeConn();
  const s1: Session = { conn: conn1, room: null, player: null };
  const s2: Session = { conn: conn2, room: null, player: null };
  rooms.onMessage(s1, { t: "create", name: "W1" }, 1000);
  rooms.onMessage(s2, { t: "join", code: s1.room!.code, name: "W2" }, 1000);
  const room = s1.room!;
  const lastErr = (cn: FakeConn) => (cn.msgs.filter((m) => m.t === "err").pop() as Extract<ServerMsg, { t: "err" }> | undefined)?.msg;
  const lastRoom = (cn: FakeConn) => cn.msgs.filter((m) => m.t === "room").pop() as Extract<ServerMsg, { t: "room" }> | undefined;
  check("wire: a created room is on the default track", room.trackId === DEFAULT_TRACK_ID && lastRoom(conn2)?.trackId === DEFAULT_TRACK_ID);
  rooms.onMessage(s2, { t: "ready", ready: true }, 1000);
  rooms.onMessage(s2, { t: "track", id: LOOP }, 1000);
  check("wire: {t:'track'} from a non-host is refused", lastErr(conn2) === "Only the host can pick the track" && room.trackId === DEFAULT_TRACK_ID, lastErr(conn2));
  rooms.onMessage(s1, { t: "track", id: "nope" }, 1000);
  rooms.onMessage(s1, { t: "track" } as unknown as ClientMsg, 1000);
  check("wire: unknown or missing id is refused", lastErr(conn1) === "Unknown track" && room.trackId === DEFAULT_TRACK_ID, lastErr(conn1));
  rooms.onMessage(s1, { t: "track", id: LOOP }, 1000);
  check(
    "wire: the host's {t:'track'} switches; both get trackId and the ready flag drops",
    room.trackId === LOOP && lastRoom(conn1)?.trackId === LOOP && lastRoom(conn2)?.trackId === LOOP && !s2.player!.ready,
  );
}

// ---- M3-T1b: jumps, falls and recovery in the room and the client ---------------------

// This section's imports (hoisted like the ones at the top).
import { Game, NO_CONTROLS, type Controls } from "../client/game";
import type { Transport } from "../client/net";
import { solid } from "../server/combat";
import { decode, encode, SNAPSHOT_EVERY } from "../shared/protocol";
import { MINE_ARM_TICKS, RIVET_COOLDOWN } from "../shared/weapons";

/**
 * A test track with a jump and a roll-off ramp on one straight (s = x there, heading +x):
 * ramp 1100..1200 into a gap 1200..1400, ramp 2000..2100 into a gap 2100..2250, a hole at
 * s = 5000 on the centerline; recovery points 0, 700, 1700 and 4500. scripts/bots.ts uses
 * the same layout.
 */
const T1B_ID = "t1b-jumps";
const T1B_DEF: TrackDef = {
  id: T1B_ID,
  name: "T1b Jumps",
  control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [-1000, 3000], [-1000, 0]],
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "ramp", s: 1100, len: 100 },
    { k: "gap", s0: 1200, s1: 1400 },
    { k: "ramp", s: 2000, len: 100 },
    { k: "gap", s0: 2100, s1: 2250 },
    { k: "hole", s: 5000, lat: 0, r: 30 },
  ],
  recovery: [0, 700, 1700, 4500],
};

/**
 * The jump-then-roll-off driver (also in scripts/bots.ts): full throttle along the
 * centerline over the first jump; once landed, hold ~150 u/s (below take-off speed) and
 * roll off the second ramp into its gap; after the recovery, sit still.
 */
class JumpFallScript {
  stage: "jump" | "slow" | "fall" | "done" = "jump";
  private flown = false;
  constructor(private readonly track: Track) {}
  done(): boolean {
    return this.stage === "done";
  }
  controls(c: CarState | null): Controls {
    if (!c) return NO_CONTROLS;
    if (c.air > 0) this.flown = true;
    if (this.stage === "jump" && this.flown && c.air === 0 && c.fall === 0) this.stage = "slow";
    if (this.stage === "slow" && c.fall > 0) this.stage = "fall";
    if (this.stage === "fall" && c.fall === 0) this.stage = "done";
    if (this.stage === "fall" || this.stage === "done") return NO_CONTROLS;
    const q = queryTrackNear(this.track, c.x, c.y, c.seg);
    const v = speedOf(c);
    const t = pointAt(this.track, q.s + 40 + v * 0.25);
    const steer = clamp(angleDiff(c.h, Math.atan2(t.y - c.y, t.x - c.x)) * 2.2, -1, 1);
    const throttle = this.stage === "jump" ? 1 : v < 140 ? 1 : v > 160 ? -1 : 0;
    return { throttle, steer, fire: false, mine: false };
  }
}

/** A client Game on a Rooms server with no lag: inputs arrive at once, server messages on flush(). */
function wiredGame(rooms: Rooms, clock: { now: number }): { game: Game; open(): void; flush(): void } {
  const inbox: ServerMsg[] = [];
  const session: Session = { conn: { send: (m) => inbox.push(decode<ServerMsg>(encode(m))!), close() {} }, room: null, player: null };
  const tr: Transport = {
    send: (m) => rooms.onMessage(session, decode<ClientMsg>(encode(m)), clock.now),
    close() {},
    onOpen() {},
    onMessage() {},
    onClose() {},
  };
  const tokens = new Map<string, string>();
  const game = new Game(() => tr, { get: (c) => tokens.get(c) ?? null, set: (c, t) => void tokens.set(c, t) });
  return {
    game,
    open: () => tr.onOpen(), // after create/join: the socket "opens" and sends the hello
    flush: () => {
      for (const m of inbox.splice(0)) tr.onMessage(m);
    },
  };
}

function jumpsWired(): void {
  registerTestTrack(T1B_DEF);
  const t = trackById(T1B_ID);
  // A test straight: its features sit on the start straight on purpose (s = x), so that one
  // rule (startStraightEnd) is not asked of it; everything else is.
  const tErr = [...validateTrack(t).filter((m) => !m.includes("start straight")), ...validateRunUps(t)];
  check("t1b track: validates (track and run-ups; its features are on the start straight by design)", tErr.length === 0, tErr.join("; "));
  const lastSnap = (sim: Sim, to: Player, of: Player): CarSnap | undefined => {
    const m = sim.conns.get(to.id)!.msgs.filter((x) => x.t === "snap").pop() as Extract<ServerMsg, { t: "snap" }> | undefined;
    return m?.ents.find((e): e is CarSnap => e.k === "car" && e.id === of.id);
  };

  // A room on the test track, racing, weapons armed.
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  sim.room.setTrack(a, T1B_ID);
  sim.startRace(a);
  sim.armWeapons();
  const put = (p: Player, s: number, lat = 0, speed = 0) => placeOn(t, p, s, lat, speed);
  const fire = (p: Player) => (q: Player) => (q === p ? { fire: true } : {});
  /** Run n ticks, then up to one more so the last tick sent a snapshot. */
  const runToSnap = (n: number, cmd?: (p: Player) => Ctl) => {
    sim.run(n, cmd);
    if (sim.tickNo % SNAPSHOT_EVERY !== 0) sim.run(1, cmd);
  };

  // 1. The snapshot carries air and fall.
  {
    put(b, 8000);
    put(a, 1203, 0, 300); // in the lip zone at take-off speed
    runToSnap(1);
    const s1 = lastSnap(sim, b, a);
    const air1 = a.car!.air;
    const airOk = air1 > 0 && s1?.air === air1 && s1.fall === 0;
    runToSnap(40, () => ({ throttle: 1 })); // 300 u/s is too slow to clear 200 units: lands short
    const s2 = lastSnap(sim, b, a);
    check("snapshot: carries air while a car is airborne", airOk, `server air ${air1}, snap air ${s1?.air}`);
    check(
      "snapshot: carries fall while a car is falling (and air 0)",
      a.car!.fall > 0 && s2?.fall === a.car!.fall && s2.air === 0,
      `server fall ${a.car!.fall}, snap fall ${s2?.fall}`,
    );
  }

  // 2. Airborne and falling cars are not solid: no rivets, mines or car contact, no firing.
  for (const state of ["air", "fall"] as const) {
    const lift = (p: Player, n: number) => {
      p.car![state] = n; // hovering in place: zero speed, so it neither moves nor falls
    };
    const what = state === "air" ? "an airborne" : "a falling";
    sim.run(RIVET_COOLDOWN + 1);
    // Rivets: B 200 units ahead of A, A fires straight at it.
    put(a, 6000);
    put(b, 6200);
    lift(b, 40);
    const hp0 = b.hp;
    const hits0 = sim.eventsOf("hit").length;
    check(`not solid: ${what} car is not solid()`, !solid(b) && solid(a));
    sim.run(1, fire(a));
    sim.run(20);
    const passed = b.hp === hp0 && sim.eventsOf("hit").length === hits0;
    put(b, 6200);
    sim.run(1, fire(a));
    sim.run(20);
    check(`not solid: a rivet flies through ${what} car; the same shot hits it on the ground`, passed && b.hp === hp0 - RIVET_DAMAGE, `hp ${hp0} -> ${b.hp}`);
    b.hp = b.maxHp;
    // Mines: an armed mine under an airborne/falling car does not go off.
    put(b, 7000);
    lift(b, 30);
    sim.room.combat.mines.push({ id: 9000, owner: a.id, x: b.car!.x, y: b.car!.y, age: MINE_ARM_TICKS });
    sim.run(5);
    const kept = sim.room.combat.mines.length === 1 && b.hp === b.maxHp;
    sim.room.combat.mines.length = 0;
    check(`not solid: an armed mine under ${what} car does not go off`, kept);
    // Car contact: A overlaps the hovering B and neither is pushed.
    put(b, 7500);
    lift(b, 30);
    put(a, 7490);
    const ax = a.car!.x, bx = b.car!.x;
    sim.run(3);
    const still = a.car!.x === ax && b.car!.x === bx && capsuleGap(a.car!, b.car!) < 0;
    put(b, 7500);
    put(a, 7490);
    sim.run(1);
    check(`not solid: no car contact with ${what} car (on the ground they are pushed apart)`, still && a.car!.x < ax && b.car!.x > bx);
    // No firing, no mines dropped: the press made in the air is discarded, not saved.
    put(b, 9500);
    put(a, 8000);
    lift(a, 30);
    sim.room.combat.shots.length = 0;
    const ammo = [a.ammo.rivets, a.ammo.mines];
    sim.run(1, (p) => (p === a ? { fire: true, mine: true } : {}));
    sim.run(10, fire(a));
    const quiet = sim.room.combat.shots.length === 0 && sim.room.combat.mines.length === 0 && a.ammo.rivets === ammo[0] && a.ammo.mines === ammo[1];
    const inAir = `in the air: shots ${sim.room.combat.shots.length}, mines ${sim.room.combat.mines.length}, ammo ${a.ammo.rivets}/${a.ammo.mines}`;
    a.car![state] = 0;
    sim.run(5); // grounded again, the old mine press does not come back
    check(
      `not solid: ${what} car cannot fire or drop mines (the mine press is discarded)`,
      quiet && sim.room.combat.mines.length === 0 && a.ammo.mines === ammo[1],
      `${inAir}; after landing: mines ${sim.room.combat.mines.length}`,
    );
    sim.room.combat.shots.length = 0;
  }

  // 3. The recovery ghost: GHOST_TICKS after the "recover" tick, longer while it overlaps a car.
  {
    put(b, 9000);
    put(a, 1250); // grounded in the gap: falls at once
    a.progress!.cp = 0;
    let ticks = 0;
    while (a.car!.fall === 0 && ticks++ < 5) sim.run(1);
    const sFall = a.progress!.s;
    let progressFrozen = true;
    while (a.car!.fall > 0 && ticks++ < 200) {
      sim.run(1);
      if (a.car!.fall > 0) progressFrozen &&= a.progress!.s === sFall;
    }
    const rec = pointAt(t, 700);
    const atRec = Math.abs(a.car!.x - rec.x) < 1e-9 && Math.abs(a.car!.y - rec.y) < 1e-9;
    const ghost0 = a.ghost;
    const snapGhost = (sim.run(1), lastSnap(sim, b, a)?.ghost);
    let ghosted = 2; // the recover tick and the one just run
    while (a.ghost > 0 && ghosted < 200) {
      sim.run(1);
      if (a.ghost > 0) ghosted++;
    }
    check("recovery: the car is put at the recovery point with GHOST_TICKS of ghost", atRec && ghost0 === GHOST_TICKS && snapGhost === true, `ghost ${ghost0}`);
    check("recovery: the ghost lasts GHOST_TICKS ticks when no car is near", ghosted === GHOST_TICKS, `${ghosted} ticks`);
    // A guard, not a proof: the room skips progress while falling, but a falling car is
    // frozen, so its progress would not move without the skip either. The checkpoint test
    // across the recovery teleport is in 4b below.
    check(
      "race progress (guard): unchanged while falling; after the recovery it is at the recovery point",
      progressFrozen && Math.abs(a.progress!.s - 700) < 1e-6 && a.progress!.cp === 0 && a.progress!.lap === 0,
      `s ${sFall.toFixed(1)} while falling -> ${a.progress!.s.toFixed(1)}, cp ${a.progress!.cp}`,
    );

    // B parked on the recovery point: A recovers on top of it and stays ghosted until apart.
    put(b, 700);
    put(a, 1250);
    sim.run(2 + FALL_TICKS + GHOST_TICKS + 30);
    const bx = b.car!.x;
    const held = a.ghost === 1 && capsuleGap(a.car!, b.car!) < 0 && Math.abs(bx - rec.x) < 1e-9 && !solid(a);
    put(b, 9000);
    sim.run(1);
    check(
      "recovery: the ghost lasts while the car still overlaps another car, and ends once apart",
      held && a.ghost === 0 && solid(a),
      `ghost ${a.ghost} after moving B away; B at x=${bx.toFixed(1)}`,
    );
  }

  // 4. A wreck respawn onto a hazard goes to the recovery point (room level). A regression
  // check of T1a's respawn() through the room's tick, not new T1b code.
  {
    put(b, 9000);
    put(a, 5000, 45); // beside the hole: its centerline point is inside the pit
    sim.room.combat.damage(a, 999, b.id, "rivet");
    sim.run(WRECK_TICKS);
    const p4500 = pointAt(t, 4500);
    const toRec = Math.abs(a.car!.x - p4500.x) < 1e-9 && Math.abs(a.car!.y) < 1e-9 && a.car!.wreck === 0;
    const ghost = a.ghost;
    put(a, 6000, 45);
    sim.room.combat.damage(a, 999, b.id, "rivet");
    sim.run(WRECK_TICKS);
    check(
      "wreck respawn onto a hole goes to the recovery point (on the road: respawns where it was)",
      toRec && ghost === GHOST_TICKS && Math.abs(a.car!.x - 6000) < 1e-6 && Math.abs(a.car!.y) < 1e-9,
      `hole wreck -> recovery point ${toRec}, ghost ${ghost}; road wreck -> x=${a.car!.x.toFixed(1)}`,
    );
  }

  // 4b. Race progress across the recovery teleport: a car crosses checkpoint 1, falls into a
  // gap past it and is put back at a recovery point before it. It keeps the checkpoint (not
  // lost) and crossing it again on the way back up earns nothing (not earned twice).
  {
    const L = trackById(T1B_ID).length; // same geometry as T1B_DEF
    const cp1 = 0.25 * L; // checkpoint 1, on the straight (s = x)
    const progDef: TrackDef = {
      ...T1B_DEF,
      id: "t1b-progress",
      name: "T1b Progress",
      features: [{ k: "gap", s0: cp1 + 150, s1: cp1 + 350 }],
      recovery: [0, cp1 - 500],
    };
    registerTestTrack(progDef);
    const pt = trackById(progDef.id);
    const sim2 = new Sim();
    const c = sim2.add("C");
    sim2.room.setTrack(c, progDef.id);
    sim2.startRace(c);
    placeOn(pt, c, cp1 - 100, 0, 300);
    c.progress!.cp = 0;
    const log: string[] = [];
    let cpBeforeFall = -1, cpAfterRecovery = -1, cpAfterRecross = -1;
    for (let i = 0; i < 600 && cpAfterRecross < 0; i++) {
      const wasFalling = c.car!.fall > 0;
      sim2.run(1, () => ({ throttle: 1 }));
      if (!wasFalling && c.car!.fall > 0) cpBeforeFall = c.progress!.cp;
      if (wasFalling && c.car!.fall === 0) cpAfterRecovery = c.progress!.cp;
      if (cpAfterRecovery >= 0 && c.progress!.s > cp1 + 50) cpAfterRecross = c.progress!.cp;
    }
    log.push(`cp ${cpBeforeFall} at the fall, ${cpAfterRecovery} after the recovery to s=${(cp1 - 500).toFixed(0)}, ${cpAfterRecross} after re-crossing`);
    check(
      "race progress: a recovery back behind a checkpoint neither loses it nor lets it be earned twice",
      cpBeforeFall === 1 && cpAfterRecovery === 1 && cpAfterRecross === 1 && c.progress!.lap === 0 && sim2.eventsOf("lap").length === 0,
      log.join("; "),
    );
  }

  // 5. Client: armed(), contact prediction and the Pose fields from the predicted car and the snapshots.
  {
    const g = new Game(() => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }), { get: () => null, set() {} });
    const car = body(0, 0, 0);
    g.you = "me";
    g.car = car;
    g.prevCar = cloneCar(car);
    g.phase = "racing";
    g.raceStart = -1e12;
    g.latest = { time: 0, rtBase: 0, rtOpen: true, cars: new Map([["me", snapCar("me", car)]]), shots: new Map(), mines: [] };
    const armedGround = g.armed();
    car.air = 5;
    const armedAir = g.armed();
    car.air = 0;
    car.fall = 5;
    const armedFall = g.armed();
    car.fall = 0;
    check("client armed(): on the ground yes, airborne or falling no", armedGround && !armedAir && !armedFall);

    const ct = new Contacts();
    const other = body(12, 0, 0);
    const base = (extra: Partial<CarSnap>) => ({ cars: new Map([["me", snapCar("me", car)], ["o", snapCar("o", other, extra)]]) });
    const hits = (extra: Partial<CarSnap>, k: number, own: Partial<CarState> = {}) => {
      ct.setBase(base(extra), "me");
      return ct.collide({ ...cloneCar(car), ...own }, k) !== null;
    };
    check(
      "client contact: no bump with an airborne car (until its air ticks run out) or a falling one",
      hits({}, 1) && !hits({ air: 5 }, 1) && !hits({ air: 5 }, 4) && hits({ air: 5 }, 5) && !hits({ fall: 3 }, 1),
    );
    check("client contact: the own car does not bump while airborne or falling", !hits({}, 1, { air: 3 }) && !hits({}, 1, { fall: 3 }));

    // Own pose: height and fall progress from the predicted car (interpolated), ghost from the snapshot.
    const up = { ...cloneCar(car), vx: 300, air: airTicksFor(300) - 10 };
    g.prevCar = { ...up, air: up.air + 1 };
    g.car = up;
    const pose = g.ownPose(0.5)!;
    const hMid = (airHeight(g.prevCar) + airHeight(up)) / 2;
    g.car = { ...cloneCar(car), fall: 30 };
    g.prevCar = { ...cloneCar(car), fall: 31 };
    g.latest.cars.set("me", snapCar("me", car, { ghost: true }));
    const falling = g.ownPose(0)!;
    g.car = cloneCar(car);
    g.prevCar = cloneCar(car);
    const ground = g.ownPose(1)!;
    check(
      "client ownPose: height (interpolated), falling fraction and ghost",
      Math.abs(pose.height! - hMid) < 1e-9 && pose.height! > 0 && pose.falling === undefined &&
        Math.abs(falling.falling! - (FALL_TICKS - 31) / FALL_TICKS) < 1e-9 && falling.ghost === true &&
        ground.height === 0 && ground.falling === undefined,
      `height ${pose.height?.toFixed(3)}, falling ${falling.falling?.toFixed(3)}`,
    );

    // Other cars: interpolated height; no slide across a recovery between two snapshots.
    const now = performance.now(); // serverNow() without a clock offset; drawn at now - 100 ms
    const snapOf = (time: number, s: CarSnap) => ({ time, rtBase: 0, rtOpen: true, cars: new Map([["o", s]]), shots: new Map(), mines: [] });
    g.car = null;
    const fly = body(0, 0, 0, 300, 0);
    g.snaps = [snapOf(now - 150, snapCar("o", { ...fly, air: 20 })), snapOf(now - 50, snapCar("o", { ...fly, x: 10, air: 18 }, { ghost: true }))];
    const o1 = g.otherPoses()[0];
    const hExp = (airHeight({ ...fly, air: 20 }) + airHeight({ ...fly, air: 18 })) / 2;
    g.snaps = [snapOf(now - 150, snapCar("o", { ...body(1300, 0, 0), fall: 1 })), snapOf(now - 50, snapCar("o", body(700, 0, 0), { ghost: true }))];
    const o2 = g.otherPoses()[0];
    check(
      "client otherPoses: height interpolated from the snapshots' air, ghost from the snapshots",
      Math.abs(o1.height! - hExp) < 0.02 && o1.height! > 0 && Math.abs(o1.x - 5) < 0.5 && typeof o1.ghost === "boolean",
      `height ${o1.height?.toFixed(3)} (expected ~${hExp.toFixed(3)}), x ${o1.x.toFixed(2)}`,
    );
    check(
      "client otherPoses: a recovery between two snapshots is not interpolated (no slide)",
      o2.x === 1300 && o2.falling !== undefined && o2.falling > 0.98,
      `x ${o2.x.toFixed(1)}, falling ${o2.falling}`,
    );
    // The start of a wreck or a fall is no teleport: the car moved up to where it froze, so
    // it is interpolated as when driving (no freeze, then a pop forward). A wreck respawn is
    // a teleport and is not.
    const drive = body(0, 0, 0, 400, 0);
    const halfway = (ea: Partial<CarSnap>, eb: Partial<CarSnap>, xb = 20) => {
      g.snaps = [snapOf(now - 150, snapCar("o", drive, ea)), snapOf(now - 50, snapCar("o", { ...drive, x: xb }, eb))];
      return g.otherPoses()[0];
    };
    const plain = halfway({}, {});
    const wreckStart = halfway({}, { wreck: WRECK_TICKS, vx: 0 });
    const fallStart = halfway({}, { fall: FALL_TICKS, vx: 0 });
    const respawn = halfway({ wreck: 1, vx: 0 }, { wreck: 0, vx: 0 }, 300);
    check(
      "client otherPoses: the start of a wreck or a fall between two snapshots still interpolates",
      Math.abs(plain.x - 10) < 0.5 && Math.abs(wreckStart.x - plain.x) < 0.05 && Math.abs(fallStart.x - plain.x) < 0.05 && fallStart.falling === 0,
      `driving x ${plain.x.toFixed(2)}, wreck start x ${wreckStart.x.toFixed(2)}, fall start x ${fallStart.x.toFixed(2)} falling ${fallStart.falling}`,
    );
    check("client otherPoses: a wreck respawn between two snapshots is not interpolated (no slide)", respawn.x === 0, `x ${respawn.x.toFixed(2)}`);
  }

  // 6. End to end without lag: a client Game on a Rooms server jumps, rolls off into a gap
  // and recovers; its prediction matches the server step for step, and a car-less observer
  // sees the height, the fall and the ghost. The clients' performance.now() is the sim clock,
  // so the observer draws at the real interpolation time (100 ms behind the server).
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const J = wiredGame(rooms, clock);
    J.game.create("Jumper");
    J.open();
    J.flush();
    J.game.pickTrack(T1B_ID);
    J.flush();
    J.game.start();
    J.flush();
    const room = [...rooms.rooms.values()][0];
    const me = room.players.get(J.game.you)!;
    const script = new JumpFallScript(t);
    const O = wiredGame(rooms, clock);
    let observing = false;
    const seen = { serverAir: false, serverFall: false, serverGhost: false, ownHeight: false, ownFalling: false, ownGhost: false, obsHeight: false, obsFalling: false, obsGhost: false };
    let slide = 0;
    const stages = new Set<string>();
    // Until a second after the predicted recovery (the server's comes a few ticks later).
    let after = 0;
    for (let i = 0; i < 60 * 40 && after < 60; i++) {
      if (script.done()) after++;
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      J.flush();
      O.flush();
      J.game.step(script.controls(J.game.car), 1000 / 60);
      O.game.step(NO_CONTROLS, 1000 / 60);
      stages.add(script.stage);
      if (room.phase === "racing" && !observing) {
        observing = true;
        O.game.join(room.code, "Observer");
        O.open();
      }
      const c = me.car;
      if (c) {
        seen.serverAir ||= c.air > 0;
        seen.serverFall ||= c.fall > 0;
        seen.serverGhost ||= me.ghost > 0 && seen.serverFall;
      }
      const own = J.game.ownPose(1);
      seen.ownHeight ||= (own?.height ?? 0) > 0;
      seen.ownFalling ||= own?.falling !== undefined;
      seen.ownGhost ||= !!own?.ghost && seen.ownFalling;
      const obs = O.game.otherPoses().find((p) => p.id === J.game.you);
      if (obs) {
        seen.obsHeight ||= (obs.height ?? 0) > 0;
        seen.obsFalling ||= obs.falling !== undefined;
        seen.obsGhost ||= !!obs.ghost && seen.obsFalling;
        // While falling or just recovered, the car is at the fall spot or the recovery point.
        if ((script.stage === "fall" || script.stage === "done") && obs.x > 1750 && obs.x < 2050) slide++;
      }
    }
    const errs = J.game.recErrors;
    const max = errs.length ? Math.max(...errs) : NaN;
    const rec = pointAt(t, 1700);
    check(
      "no lag: the scripted jumper jumps, rolls off into the second gap and recovers at s = 1700",
      script.done() && seen.serverAir && seen.serverFall && seen.serverGhost && Math.hypot(me.car!.x - rec.x, me.car!.y - rec.y) < 1,
      `stages ${[...stages].join(">")}, server car at x=${me.car!.x.toFixed(1)}`,
    );
    check(
      "no lag: prediction parity through take-off, flight, landing, fall and recovery (state and position)",
      errs.length > 300 && J.game.recStateErrors === 0 && max < 0.1,
      `${errs.length} acked steps, ${J.game.recStateErrors} state mismatches, max error ${max.toFixed(4)}`,
    );
    check("no lag: own Pose has height in the air, falling while falling, ghost after the recovery", seen.ownHeight && seen.ownFalling && seen.ownGhost, JSON.stringify(seen));
    check(
      "no lag: an observer's Pose of the jumper has height, falling and ghost; no slide to the recovery point",
      seen.obsHeight && seen.obsFalling && seen.obsGhost && slide === 0,
      `${slide} poses between the fall spot and the recovery point`,
    );
  } finally {
    performance.now = realNow;
  }
}

// ---- M3-T4: the shipped tracks (Crusher Run, Overpass Knot) and the bot driver ----------

// This section's imports (hoisted like the ones at the top).
import { BotDriver, holeLane, speedAfter, takeoffSpeedFor } from "./bot-ai";
import { gapAt as gapAtT4, START_ZONE, startStraightEnd } from "../shared/track";
import { CAR_WIDTH } from "../shared/physics";
import type { Pose } from "../client/game";

const MAX_UPGRADES = statsFor("sport", { engine: 3, tyres: 3, welder: 3 });
/** The new tracks: the shipped ones with features. */
const T4_TRACKS = ["crusher-run", "overpass-knot"];

/** The hazards of a track as stretches of s: a ramp with the gap at its lip is one jump; holes closer than 400 are one field. */
function hazardStretches(t: Track): { what: string; s0: number; s1: number }[] {
  const out: { what: string; s0: number; s1: number }[] = [];
  for (const r of t.ramps) {
    const lip = r.s + r.len;
    const g = t.gaps.find((x) => x.s0 >= r.s && x.s0 <= lip + LIP_ZONE);
    out.push({ what: g ? (g.scrap ? "scrap jump" : "jump") : "ramp", s0: r.s, s1: g ? g.s1 : lip + LIP_ZONE });
  }
  for (const g of t.gaps) {
    if (!t.ramps.some((r) => g.s0 >= r.s && g.s0 <= r.s + r.len + LIP_ZONE)) out.push({ what: "gap", s0: g.s0, s1: g.s1 });
  }
  for (const h of t.holes) {
    const last = out[out.length - 1];
    if (last && last.what === "holes" && h.s - h.r - last.s1 < 400) last.s1 = Math.max(last.s1, h.s + h.r);
    else out.push({ what: "holes", s0: h.s - h.r, s1: h.s + h.r });
  }
  return out.sort((a, b) => a.s0 - b.s0);
}

/** A grounded car taking off from the lip of `lipS` at speed v, `lat` units off the centerline, along the track. */
function flyFrom(t: Track, lipS: number, v: number, lat: number): { fell: boolean; landS: number; landDist: number } {
  const p = pointAt(t, lipS + 1);
  const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
  const c: CarState = { x, y, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  let fell = false;
  for (let i = 0; i < 200; i++) {
    const ev = stepRaceCar(c, NO_COMMAND, BASE_STATS, raceEnv(t));
    if (ev === "fall") fell = true;
    if (c.air === 0) break;
  }
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  return { fell, landS: q.s, landDist: q.dist };
}

/** BotDriver on a bare car (no server): the Game fields it reads. */
function stubGame(t: Track, car: CarState, others: { pose: Pose; snap: Partial<CarSnap> }[] = []): Game {
  const cars = new Map<string, CarSnap>(others.map((o) => [o.pose.id, { ...snapCar(o.pose.id, car), ...o.pose, ...o.snap } as CarSnap]));
  return {
    car,
    track: t,
    stats: { ...BASE_STATS },
    raceOn: () => true,
    otherPoses: () => others.map((o) => o.pose),
    visibleMines: () => [],
    raceTickNow: () => 0,
    latest: { time: 0, cars, shots: new Map(), mines: [] },
  } as unknown as Game;
}

function shippedTracks(): void {
  for (const id of T4_TRACKS) {
    const t = trackById(id);
    const v1 = validateTrack(t), v2 = validateRunUps(t, BASE_STATS), v3 = validateRunUps(t, MAX_UPGRADES);
    check(
      `${id}: validateTrack and validateRunUps (no upgrades and max upgrades) pass`,
      v1.length + v2.length + v3.length === 0,
      [...v1, ...v2.map((m) => `base: ${m}`), ...v3.map((m) => `max: ${m}`)].join("; ") ||
        `length ${t.length.toFixed(0)}, ${t.ramps.length} ramps, ${t.gaps.length} gaps, ${t.holes.length} holes, recovery ${t.recovery.map((r) => r.toFixed(0)).join(",")}`,
    );
    // Recovery: the start line listed explicitly (PLAN-M3 design 1), and one before every hazard.
    const hz = hazardStretches(t);
    const missing: string[] = [];
    hz.forEach((h, i) => {
      const prev = hz[(i - 1 + hz.length) % hz.length];
      const from = i === 0 ? prev.s1 - t.length : prev.s1;
      if (!t.recovery.some((r) => (r >= from && r < h.s0) || (r - t.length >= from && r - t.length < h.s0))) missing.push(`${h.what} at ${h.s0.toFixed(0)}`);
    });
    check(
      `${id}: recovery point at s = 0 listed, and one between every two hazards`,
      t.def.recovery?.[0] === 0 && missing.length === 0 && hz.length >= 2,
      missing.join(", ") || hz.map((h) => `${h.what} ${h.s0.toFixed(0)}..${h.s1.toFixed(0)}`).join(", "),
    );
    check(`${id}: every hole has r <= 38 (the renderer's cull)`, t.holes.every((h) => h.r <= 38), t.holes.map((h) => h.r).join(","));
    // Every jump lands on the asphalt past its gap at any take-off speed from the one the bot
    // aims for up to top speed, on the bot lanes; just below the bare minimum it falls short.
    const top = speedAfter(0, 20_000, MAX_UPGRADES);
    for (const r of t.ramps) {
      const lip = r.s + r.len;
      const need = takeoffSpeedFor(t, r);
      const bad: string[] = [];
      let n = 0;
      for (let v = need; v <= top + 1; v += 5) {
        for (const lat of [-40, -24, 0, 24, 40]) {
          n++;
          const f = flyFrom(t, lip, v, lat);
          if (f.fell || f.landDist > t.def.halfWidth || gapAtT4(t, f.landS)) bad.push(`${v}@${lat}: ${f.fell ? "fell" : `lands ${f.landDist.toFixed(0)} off`} at ${f.landS.toFixed(0)}`);
        }
      }
      check(
        `${id}: the jump at s=${r.s} lands on the asphalt for every take-off from ${need} to ${top.toFixed(0)} u/s, lanes -40..40`,
        n > 20 && bad.length === 0,
        bad.slice(0, 4).join("; ") || `${n} flights`,
      );
    }
  }
  // The start straight is measured from the track (startStraightEnd), not a fixed 300 units:
  // the first Crusher Run layout (2cb0eed), whose scrap jumps sat on a ~1970-unit start
  // straight, is rejected for exactly those four features; the shipped tracks keep theirs clear.
  {
    const first = buildTrack({
      id: "crusher-run-2cb0eed",
      name: "Crusher Run (first layout)",
      control: [
        [900, 500], [1400, 500], [1900, 500], [2400, 500], [2900, 500], [3400, 500], [3800, 700],
        [3950, 1150], [3850, 1650], [3450, 2000], [2900, 2150], [2400, 2150], [1900, 2150],
        [1400, 2150], [950, 2100], [650, 1850], [750, 1450], [450, 1150], [300, 750], [500, 500],
      ],
      halfWidth: 64,
      verge: 44,
      features: [
        { k: "ramp", s: 620, len: 80 }, { k: "gap", s0: 700, s1: 830, scrap: true },
        { k: "ramp", s: 1680, len: 80 }, { k: "gap", s0: 1760, s1: 1900, scrap: true },
        { k: "hole", s: 3350, lat: -10, r: 24 },
        { k: "ramp", s: 5800, len: 80 }, { k: "gap", s0: 5880, s1: 6100 },
      ],
      recovery: [0, 1300, 2950, 5300],
    });
    const errs = validateTrack(first);
    const onStraight = errs.filter((m) => m.includes("start straight"));
    check(
      "validation: features on a long start straight are rejected (the first Crusher Run's two scrap jumps)",
      startStraightEnd(first) > 1900 && onStraight.length === 4 && errs.length === 4 &&
        ["ramp at s=620.0", "gap 700.0..830.0", "ramp at s=1680.0", "gap 1760.0..1900.0"].every((w) => onStraight.some((m) => m.startsWith(w))),
      `start straight 0..${startStraightEnd(first).toFixed(0)}; ${errs.join("; ")}`,
    );
    const ends = ["rust-bowl", ...T4_TRACKS].map((id) => {
      const t = trackById(id);
      const firstFeature = Math.min(...t.ramps.map((r) => r.s), ...t.gaps.map((g) => g.s0), ...t.holes.map((h) => h.s - h.r));
      return { id, end: startStraightEnd(t), first: firstFeature };
    });
    check(
      "validation: the start straight of every shipped track is measured, and its first feature lies past it",
      ends.every((e) => e.end >= START_ZONE && e.first > e.end) && ends.find((e) => e.id === "crusher-run")!.end > 1900,
      ends.map((e) => `${e.id} straight 0..${e.end.toFixed(0)}, first feature ${Number.isFinite(e.first) ? e.first.toFixed(0) : "-"}`).join("; "),
    );
  }

  // Overpass Knot really crosses itself: the passes meet at (2000, 1400), the upper one (gap) over the lower one (ground).
  {
    const t = trackById("overpass-knot");
    const up = queryTrackNear(t, 2000, 1400, 21 * 16), low = queryTrackNear(t, 2000, 1400, 8 * 16);
    check(
      "overpass-knot: a crossing; the upper pass is a gap over it, the lower pass is ground",
      up.dist < 1 && low.dist < 1 && Math.abs(up.s - low.s) > t.length / 4 && !!gapAtT4(t, up.s) && !gapAtT4(t, low.s),
      `upper s=${up.s.toFixed(0)} (gap ${gapAtT4(t, up.s)?.s0}..${gapAtT4(t, up.s)?.s1}), lower s=${low.s.toFixed(0)}`,
    );
  }
}

function botDriver(): void {
  const knot = trackById("overpass-knot");
  const crossRamp = knot.ramps[0];
  const lip = crossRamp.s + crossRamp.len;
  const need = takeoffSpeedFor(knot, crossRamp);
  const bare = flyFrom(knot, lip, need - 30, 0);
  check(
    "bot: knows the take-off speed a jump needs (over the crossing: above MIN_TAKEOFF_SPEED; 30 u/s less falls short)",
    need > MIN_TAKEOFF_SPEED + 100 && need < 420 && bare.fell && !flyFrom(knot, lip, need, 0).fell,
    `${need} u/s`,
  );
  check("bot: a ramp with no gap behind it asks for no speed", takeoffSpeedFor(knot, { k: "ramp", s: 3000, len: 60 }) === 0);

  // Slow at the foot of the crossing ramp (a mine, a bump): the bot backs up for a longer run-up
  // and then clears the gap. Full throttle from there instead falls short.
  const run = (backUp: boolean) => {
    const p = pointAt(knot, lip - 160);
    const car: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 120, vy: Math.sin(p.h) * 120, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const bot = new BotDriver(stubGame(knot, car), 0);
    bot.weapons = false;
    let reversed = false, fell = false, took = 0;
    for (let i = 0; i < 60 * 20 && !fell; i++) {
      const ctl = backUp ? bot.controls() : { throttle: 1, steer: 0 };
      if (ctl.throttle < 0 && speedOf(car) > 5 && car.vx * Math.cos(car.h) + car.vy * Math.sin(car.h) < 0) reversed = true;
      const v0 = speedOf(car);
      const ev = stepRaceCar(car, ctl, BASE_STATS, raceEnv(knot));
      if (ev === "takeoff") took = v0;
      if (ev === "fall") fell = true;
      if (took && car.air === 0) break;
    }
    return { reversed, fell, took };
  };
  const naive = run(false), smart = run(true);
  check(
    "bot: too slow before the crossing ramp, it backs up and then clears the gap (full throttle from there falls short)",
    naive.fell && smart.reversed && !smart.fell && smart.took >= need - 12,
    `full throttle: ${naive.fell ? "falls" : "clears"} (took off at ${naive.took.toFixed(0)}); bot: reversed ${smart.reversed}, took off at ${smart.took.toFixed(0)}, ${smart.fell ? "fell" : "landed"}`,
  );

  // Holes: 100 before each Crusher Run pit the lane clears it; across the field the lane moves
  // from one side of the road to the other. With no hole near, it is the preferred lane.
  const crusher = trackById("crusher-run");
  const pits = crusher.holes;
  const lanes = pits.map((h) => holeLane(crusher, h.s - 100, 300, 0).lane);
  check(
    "bot: the hole lane keeps the car's centre clear of each pit and moves across the field",
    pits.length === 3 && lanes.every((l, i) => Math.abs(l - pits[i].lat) > pits[i].r + CAR_WIDTH / 2) &&
      Math.sign(lanes[1]) === -Math.sign(lanes[2]) && holeLane(crusher, 1000, 300, 12).lane === 12,
    `pits ${pits.map((h) => `${h.s}@${h.lat} r${h.r}`).join(", ")}; lanes 100 before them: ${lanes.join(", ")}`,
  );

  // Away from holes the bot holds its own racing line: one solo Rust Bowl lap per lane (after
  // 2 s off the grid), the share of steps more than 12 units off the lane stays small.
  {
    const rust = trackById("rust-bowl");
    const hold = [-24, 0, 24].map((lane) => {
      const g = gridSlot(rust, 0);
      const car: CarState = { x: g.x, y: g.y, h: g.h, vx: 0, vy: 0, seg: g.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
      const bot = new BotDriver(stubGame(rust, car), lane);
      bot.weapons = false;
      let off = 0, n = 0, dist = 0, prev = queryTrackNear(rust, car.x, car.y, car.seg).s;
      for (let i = 0; i < 60 * 60 && dist < rust.length; i++) {
        stepRaceCar(car, bot.controls(), BASE_STATS, raceEnv(rust));
        const q = queryTrackNear(rust, car.x, car.y, car.seg);
        let ds = q.s - prev;
        if (ds < -rust.length / 2) ds += rust.length;
        dist += ds;
        prev = q.s;
        if (i < 120) continue;
        const p = pointAt(rust, q.s);
        const lat = (car.x - p.x) * -Math.sin(p.h) + (car.y - p.y) * Math.cos(p.h);
        n++;
        if (Math.abs(lat - lane) > 12) off++;
      }
      return { lane, share: off / n, lap: dist >= rust.length };
    });
    check(
      "bot: holds its lane on Rust Bowl (no holes): under 10% of a lap more than 12 off the lane",
      hold.every((h) => h.lap && h.share < 0.1),
      hold.map((h) => `lane ${h.lane}: ${(100 * h.share).toFixed(1)}%`).join(", "),
    );
  }

  // Weapons: never at an airborne or falling car (the server ignores those shots).
  const p = pointAt(knot, 3000);
  const me: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const ahead = { id: "x", x: p.x + Math.cos(p.h) * 200, y: p.y + Math.sin(p.h) * 200, h: p.h };
  const fires = (snap: Partial<CarSnap>) => {
    const b = new BotDriver(stubGame(knot, cloneCar(me), [{ pose: ahead, snap }]), 0);
    return b.controls().fire;
  };
  const fire = { grounded: fires({}), air: fires({ air: 20 }), fall: fires({ fall: 40 }), ghost: fires({ ghost: true }) };
  check("bot: fires at a grounded car ahead, not at an airborne, falling or ghosted one", fire.grounded && !fire.air && !fire.fall && !fire.ghost, JSON.stringify(fire));

  // A fall is not "stuck": after the recovery the bot drives on instead of reversing.
  const fc: CarState = { ...me, fall: 90 };
  const fb = new BotDriver(stubGame(knot, fc), 0);
  fb.weapons = false;
  for (let i = 0; i < 90; i++) {
    fb.controls();
    stepRaceCar(fc, NO_COMMAND, BASE_STATS, raceEnv(knot));
  }
  const after = fb.controls();
  check("bot: no reversing after a fall's 90 frozen ticks", fc.fall === 0 && after.throttle === 1, `throttle ${after.throttle}`);
}

/** A reconciliation error this big is "large": a visible snap. */
const LARGE_ERR = 1;

/**
 * Deterministic headless bot laps: three bots (lanes -24, 0, 24, no weapons) race one lap on
 * a track through the real client Game against a Rooms server on the sim clock (no sockets,
 * no lag). Returns each bot's finish tick, take-offs and falls (the server's car state).
 */
function botLap(id: string): {
  ticks: number[]; jumps: number[]; falls: number[]; stateErrs: number; samples: number; large: number; over01: number; maxErr: number;
} {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const lanes = [-24, 0, 24];
    const ws = lanes.map(() => wiredGame(rooms, clock));
    ws[0].game.create("Bot0");
    ws[0].open();
    ws[0].flush();
    ws[0].game.pickTrack(id);
    ws[0].flush();
    const room = [...rooms.rooms.values()][0];
    ws.slice(1).forEach((w, i) => {
      w.game.join(room.code, `Bot${i + 1}`);
      w.open();
    });
    for (const w of ws) w.flush();
    for (const w of ws.slice(1)) {
      w.game.setReady(true);
      w.flush();
    }
    ws[0].game.start();
    ws[0].flush();
    const drivers = ws.map((w, i) => {
      const d = new BotDriver(w.game, lanes[i]);
      d.weapons = false;
      return d;
    });
    const n = ws.length;
    const ticks = Array(n).fill(0), jumps = Array(n).fill(0), falls = Array(n).fill(0);
    const prev = ws.map(() => ({ air: 0, fall: 0 }));
    let raceTicks = 0;
    for (let i = 0; i < 60 * 120 && ticks.some((x) => x === 0); i++) {
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      for (const w of ws) w.flush();
      ws.forEach((w, k) => w.game.step(drivers[k].controls(), 1000 / 60));
      if (room.phase === "racing") raceTicks++;
      ws.forEach((w, k) => {
        const c = room.players.get(w.game.you)?.car;
        if (!c) return;
        if (c.air > 0 && prev[k].air === 0) jumps[k]++;
        if (c.fall > 0 && prev[k].fall === 0) falls[k]++;
        prev[k] = { air: c.air, fall: c.fall };
        if (!ticks[k] && room.players.get(w.game.you)!.progress?.fin) ticks[k] = raceTicks;
      });
    }
    const errs = ws.flatMap((w) => w.game.recErrors);
    return {
      ticks, jumps, falls,
      stateErrs: ws.reduce((a, w) => a + w.game.recStateErrors, 0),
      samples: errs.length,
      large: errs.filter((x) => x > LARGE_ERR).length,
      over01: errs.filter((x) => x > 0.1).length,
      maxErr: errs.length ? Math.max(...errs) : NaN,
    };
  } finally {
    performance.now = realNow;
  }
}

function botLaps(): void {
  // Bounds per track (measured 2026-11-17: Crusher Run ~34 s, Overpass Knot ~29 s, Rust Bowl ~32 s, 0 falls).
  const limits: Record<string, { ticks: number; falls: number }> = {
    "rust-bowl": { ticks: 40 * 60, falls: 0 },
    "crusher-run": { ticks: 42 * 60, falls: 1 },
    "overpass-knot": { ticks: 38 * 60, falls: 1 },
  };
  for (const e of trackList().filter((x) => x.id in limits)) {
    const t = trackById(e.id);
    const lim = limits[e.id];
    const a = botLap(e.id);
    const b = botLap(e.id);
    const secs = a.ticks.map((x) => (x / 60).toFixed(2)).join("/");
    const falls = a.falls.reduce((x, y) => x + y, 0);
    check(
      `bot laps on ${e.id}: 3 bots finish within ${lim.ticks / 60} s with <= ${lim.falls} falls`,
      a.ticks.every((x) => x > 0 && x <= lim.ticks) && falls <= lim.falls,
      `finish ${secs} s, falls ${a.falls.join("/")}, take-offs ${a.jumps.join("/")}`,
    );
    check(
      `bot laps on ${e.id}: every bot takes every jump (${t.ramps.length} per lap) and the run is deterministic`,
      a.jumps.every((j) => j >= t.ramps.length) && JSON.stringify(a) === JSON.stringify(b),
      `take-offs ${a.jumps.join("/")}; rerun finish ${b.ticks.join("/")} vs ${a.ticks.join("/")}`,
    );
    // Bumps between the bots are predicted only approximately, which is why socket races bound
    // the count of large errors, not the max (advisor change 9). This run has no lag and is
    // deterministic, so it can ask for no large error at all: in effect a max bound.
    check(
      `bot laps on ${e.id}: prediction matches the server (no air/fall state mismatch, no error > ${LARGE_ERR})`,
      a.samples > 1000 && a.stateErrs === 0 && a.large === 0,
      `${a.stateErrs} state mismatches; ${a.large} errors > ${LARGE_ERR}, ${a.over01} > 0.1 of ${a.samples}; max ${a.maxErr.toFixed(3)}`,
    );
  }
}

// ---- mine cap: hold at most 3 mines (ClickUp 123jpnbf8nx, 2026-11-17) ----------------

import { AMMO, clampAmmo, priceOf } from "../shared/shop";

function mineCap(): void {
  check(
    "mine cap: AMMO.mines is a pack of 3 for 200 with a cap of 3",
    AMMO.mines.cap === 3 && AMMO.mines.pack === 3 && AMMO.mines.price === 200,
    `pack ${AMMO.mines.pack}, price ${AMMO.mines.price}, cap ${AMMO.mines.cap}`,
  );
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  a.wallet.scrap = 1000;
  let e = sim.room.buy(a, "mines");
  check("mine cap: buying at 0 gives 3 for 200", e === null && a.ammo.mines === 3 && a.wallet.scrap === 800, `${e} ${a.ammo.mines} ${a.wallet.scrap}`);
  e = sim.room.buy(a, "mines");
  check(
    "mine cap: refused at 3 (Already maxed out), scrap kept, garage price shows maxed",
    e === "Already maxed out" && a.ammo.mines === 3 && a.wallet.scrap === 800 && priceOf("mines", a.wallet) === null,
    `${e} ${a.ammo.mines} ${a.wallet.scrap}`,
  );
  for (const left of [1, 2]) {
    a.ammo.mines = left;
    const before = a.wallet.scrap;
    e = sim.room.buy(a, "mines");
    check(
      `mine cap: a top-up from ${left} fills to 3 for 200`,
      e === null && a.ammo.mines === 3 && a.wallet.scrap === before - 200,
      `${e} ${a.ammo.mines} ${before}->${a.wallet.scrap}`,
    );
  }

  // Over-cap wallets (e.g. kept from before the cap was lowered) are clamped at race start.
  const w = startingWallet();
  w.ammo.rivets = 37;
  w.ammo.mines = 9;
  clampAmmo(w);
  check("mine cap: clampAmmo cuts mines to 3 and leaves ammo under its cap alone", w.ammo.mines === 3 && w.ammo.rivets === 37, `${w.ammo.rivets}/${w.ammo.mines}`);
  a.ammo.mines = 9;
  b.ammo.mines = 2;
  sim.readyAll(a);
  e = sim.room.start(a, sim.now);
  check("mine cap: a 9-mine wallet is clamped to 3 when the race starts", e === null && a.ammo.mines === 3 && a.wallet.ammo.mines === 3, `${e} ${a.ammo.mines}`);
  check("mine cap: a wallet under the cap keeps its mines at race start", b.ammo.mines === 2, `${b.ammo.mines}`);
  while (sim.room.phase !== "racing") sim.run(1);
  const snap = sim.conns.get(a.id)!.msgs.filter((x) => x.t === "snap").pop() as Extract<ServerMsg, { t: "snap" }> | undefined;
  check("mine cap: the racer's snapshot shows 3 mines", snap?.ammo[1] === 3, `${snap?.ammo.join("/")}`);
  // Past the armed delay, five mine taps drop only the three mines it holds.
  sim.now = Math.max(sim.now, sim.room.raceStart + WEAPONS_ARM_MS);
  sim.place(a, 300, 0);
  sim.place(b, 1500, 0);
  for (let i = 0; i < 5; i++) {
    sim.run(1, (p) => (p === a ? { mine: true } : {}));
    sim.run(1);
  }
  const dropped = sim.room.combat.mines.filter((m) => m.owner === a.id).length;
  check("mine cap: five taps from a clamped wallet drop 3 mines", dropped === 3 && a.ammo.mines === 0, `${dropped} dropped, ${a.ammo.mines} left`);
}

// ---- room chat (CHAT-1, PLAN-CHAT.md, 2026-11-17) --------------------------------------

// This section's imports (hoisted like the ones at the top).
import {
  CHAT_COMINGS_BURST,
  CHAT_COMINGS_PER_SEC,
  CHAT_HISTORY,
  CHAT_ROOM_BURST,
  CHAT_ROOM_PER_SEC,
  FINISH_GRACE_MS,
  type ChatLine,
} from "../shared/protocol";
import { cleanChat } from "../server/room";
import { Keyboard } from "../client/input";

type ChatMsg = Extract<ServerMsg, { t: "chat" }>;
type ChatlogMsg = Extract<ServerMsg, { t: "chatlog" }>;

/** FakeConn that remembers being closed. */
class ClosingConn extends FakeConn {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

/** Live chat lines a connection received. */
function liveLines(c: FakeConn): ChatLine[] {
  return c.msgs.filter((m): m is ChatMsg => m.t === "chat").map((m) => m.line);
}

/** The last chatlog a connection received. */
function lastChatlog(c: FakeConn): ChatLine[] | undefined {
  return (c.msgs.filter((m): m is ChatlogMsg => m.t === "chatlog").pop() as ChatlogMsg | undefined)?.lines;
}

function errsOf(c: FakeConn): string[] {
  return c.msgs.filter((m) => m.t === "err").map((m) => (m as Extract<ServerMsg, { t: "err" }>).msg);
}

const lineKey = (l: ChatLine) => `${l.n}:${l.kind}:${l.name}:${l.text}`;

/** Put p just before the line on its last lap, so full throttle finishes within 15 ticks. */
function nearFinish(sim: Sim, p: Player): void {
  sim.place(p, L - 40, 0, 300);
  p.progress = { s: queryTrackNear(track, p.car!.x, p.car!.y, p.car!.seg).s, cp: 3, lap: 0, fin: 0 };
}

function chatRoom(): void {
  // ---- every phase, and the result line ----
  let sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  const cb = sim.conns.get(b.id)!;
  const say = (p: Player, text: unknown) => sim.room.chat(p, text, sim.now);
  say(a, "in the lobby");
  sim.readyAll(a);
  sim.room.start(a, sim.now);
  const countdown: string = sim.room.phase;
  say(b, "in the countdown");
  while (sim.room.phase !== "racing") sim.run(1);
  say(a, "in the race");
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  nearFinish(sim, b);
  sim.run(15, (p) => (p === b ? { throttle: 1 } : {}));
  const resultsPhase: string = sim.room.phase;
  say(b, "in the results");
  const saidTexts = liveLines(cb).filter((l) => l.kind === "say").map((l) => `${l.name}: ${l.text}`);
  check(
    "chat: accepted in the lobby, the countdown, the race and the results, sent to everyone",
    countdown === "countdown" &&
      resultsPhase === "results" &&
      saidTexts.join("|") === "Ann: in the lobby|Bo: in the countdown|Ann: in the race|Bo: in the results",
    saidTexts.join("|"),
  );
  const sayA = sim.room.chatLines.find((l) => l.text === "in the lobby");
  check(
    "chat: a say line carries from, name and colour",
    !!sayA && sayA.kind === "say" && sayA.from === a.id && sayA.name === "Ann" && sayA.color === a.color,
    JSON.stringify(sayA),
  );
  const results1 = sim.room.chatLines.filter((l) => l.kind === "result");
  check(
    "chat: one result line from endRace, winner first (game line: no from, empty name)",
    results1.length === 1 && results1[0].text === "Race won by Ann — 2nd Bo" && results1[0].name === "" && !("from" in results1[0]),
    results1.map((l) => l.text).join("; "),
  );
  while ((sim.room.phase as string) !== "lobby") sim.run(1);
  check("chat: no second result line on the way back to the lobby", sim.room.chatLines.filter((l) => l.kind === "result").length === 1);
  // A race that ends on the finish grace: the DNF is left out.
  sim.startRace(a);
  nearFinish(sim, b);
  sim.run(15, (p) => (p === b ? { throttle: 1 } : {}));
  sim.now += FINISH_GRACE_MS;
  sim.run(1);
  const results2 = sim.room.chatLines.filter((l) => l.kind === "result");
  check(
    "chat: a DNF is left out of the result line",
    (sim.room.phase as string) === "results" && results2.length === 2 && results2[1].text === "Race won by Bo",
    results2.map((l) => l.text).join("; "),
  );

  // ---- no result line when the race ends through toLobby ----
  sim = new Sim(1);
  const solo = sim.add("Solo");
  sim.startRace(solo);
  const late = sim.add("Late"); // joins mid-race: no car
  sim.room.leave(solo, sim.now);
  sim.run(2);
  check(
    "chat: a race ended through toLobby (every racer gone) writes no result line",
    sim.room.phase === "lobby" && !late.car && sim.room.chatLines.every((l) => l.kind !== "result"),
    `${sim.room.phase}; ${sim.room.chatLines.map((l) => l.kind).join(",")}`,
  );

  // ---- cleaning ----
  const zwj = "👩‍🚀 and ‌x"; // ZWJ emoji, ZWNJ
  const cleaned: [unknown, string][] = [
    ["  hello \n\t world  ", "hello world"],
    ["line1\r\nline2", "line1 line2"],
    ["a\u0000b‮c​d\u0007", "abcd"],
    ["a \u0007 b", "a b"],
    [zwj, zwj],
    ["   \n ", ""],
    ["\u0000\u0001‮", ""],
    [42, ""],
    [null, ""],
    [["x"], ""],
  ];
  const bad = cleaned.filter(([raw, want]) => cleanChat(raw) !== want);
  check(
    "chat cleaning: whitespace collapsed first, \\p{C} stripped except ZWNJ/ZWJ, trimmed; non-strings and empty give ''",
    bad.length === 0,
    bad.map(([raw]) => `${JSON.stringify(raw)} -> ${JSON.stringify(cleanChat(raw))}`).join("; "),
  );
  const emoji = cleanChat("😀".repeat(250));
  const plain = cleanChat("x".repeat(500));
  check(
    "chat cleaning: cut to 200 code points (not UTF-16 units)",
    [...emoji].length === 200 && emoji.length === 400 && plain.length === 200,
    `${[...emoji].length} emoji, ${plain.length} x`,
  );
  sim = new Sim(1);
  const c1 = sim.add("C1");
  const before = sim.room.chatLines.length;
  sim.room.chat(c1, "  \n\u0000  ", sim.now);
  sim.room.chat(c1, 12345, sim.now);
  sim.room.chat(c1, { text: "x" }, sim.now);
  sim.room.chat(c1, "y".repeat(300), sim.now);
  const kept = sim.room.chatLines.slice(before);
  check(
    "chat: empty and non-string text ignored (no line, no token spent), a long one cut to 200",
    kept.length === 1 && kept[0].text.length === 200 && c1.chatBucket.tokens === 4,
    `${kept.length} lines, tokens ${c1.chatBucket.tokens}`,
  );

  // ---- rate limit ----
  sim = new Sim(1);
  const r = sim.add("R");
  const rc = sim.conns.get(r.id)!;
  const t0 = sim.now;
  const count = () => sim.room.chatLines.filter((l) => l.kind === "say").length;
  for (let i = 1; i <= 7; i++) sim.room.chat(r, `burst ${i}`, t0);
  const afterBurst = count();
  const errs1 = errsOf(rc).length;
  sim.room.chat(r, "too soon", t0 + 500);
  const errs2 = errsOf(rc).length;
  sim.room.chat(r, "refilled", t0 + 1100);
  const afterRefill = count();
  sim.room.chat(r, "again too soon", t0 + 1150);
  check(
    "chat rate limit: 5 in a burst, the 6th and 7th refused with one 'Slow down'",
    afterBurst === 5 && errs1 === 1 && errsOf(rc)[0] === "Slow down",
    `${afterBurst} accepted, ${errs1} errs`,
  );
  check(
    "chat rate limit: 'Slow down' at most about once a second; one message back after a second",
    errs2 === 1 && afterRefill === 6 && errsOf(rc).length === 2 && count() === 6,
    `errs ${errs2} -> ${errsOf(rc).length}, accepted ${afterRefill}`,
  );
  // The bucket is on the player: a rejoin does not refill it.
  const q = sim.add("Q");
  for (let i = 0; i < 5; i++) sim.room.chat(q, `q ${i}`, t0);
  sim.room.unbind(q, t0);
  sim.rebind(q);
  const n0 = count();
  sim.room.chat(q, "after the rejoin", t0);
  check("chat rate limit: the bucket survives a rejoin", count() === n0 && errsOf(sim.conns.get(q.id)!).includes("Slow down"), `${count() - n0} accepted`);

  // ---- room-wide budgets: a join / say / leave churn cannot flush the history ----
  // Each new seat brings a full player bucket and the leave message frees the seat at once,
  // so one client could otherwise write 5 lines (plus join and leave) per cycle.
  const churnRoom = (t: number) => {
    const rs = new Rooms(1);
    const hostConn = new FakeConn();
    const hs: Session = { conn: hostConn, room: null, player: null };
    rs.onMessage(hs, { t: "create", name: "Host" }, t);
    rs.onMessage(hs, { t: "chat", text: "real line before the churn" }, t);
    const room = hs.room!;
    const cycle = (i: number, now: number) => {
      const s: Session = { conn: new FakeConn(), room: null, player: null };
      rs.onMessage(s, { t: "join", code: room.code, name: "Spam" }, now);
      for (let k = 0; k < 5; k++) rs.onMessage(s, { t: "chat", text: `spam ${i}.${k}` }, now);
      rs.onMessage(s, { t: "leave" }, now);
    };
    const spam = () => room.chatLines.filter((l) => l.name === "Spam");
    const kept = () =>
      room.chatLines[0]?.kind === "join" && room.chatLines[0].name === "Host" && room.chatLines.some((l) => l.text === "real line before the churn");
    return { rs, hs, hostConn, room, cycle, spam, kept };
  };
  const ch = churnRoom(10_000);
  for (let i = 0; i < 100; i++) ch.cycle(i, 10_000);
  const spamSays = ch.spam().filter((l) => l.kind === "say").length;
  const spamComings = ch.spam().filter((l) => l.kind === "join" || l.kind === "leave").length;
  check(
    "chat budget: 100 join/say/leave cycles at one instant keep the history (host's join and earlier lines stay, spam bounded)",
    ch.kept() &&
      ch.room.players.size === 1 &&
      spamSays === CHAT_ROOM_BURST - 1 && // the host's line took one
      spamComings === CHAT_COMINGS_BURST - 1 && // the host's join took one
      ch.room.chatLines.length === 2 + spamSays + spamComings,
    `${ch.room.chatLines.length} lines: ${spamSays} spam says, ${spamComings} spam join/leave`,
  );
  ch.rs.onMessage(ch.hs, { t: "chat", text: "host during the churn" }, 10_000);
  const blocked = !ch.room.chatLines.some((l) => l.text === "host during the churn") && errsOf(ch.hostConn).includes("Slow down");
  ch.rs.onMessage(ch.hs, { t: "chat", text: "host a second later" }, 11_000);
  check(
    "chat budget: over the room budget a say gets 'Slow down'; a second later the room can talk again",
    blocked && ch.room.chatLines[ch.room.chatLines.length - 1]?.text === "host a second later",
  );
  // Sustained churn, 10 cycles a second for 10 s: lines grow at the budgets' rates only.
  const ch2 = churnRoom(50_000);
  for (let i = 0; i < 100; i++) ch2.cycle(i, 50_000 + i * 100);
  const says2 = ch2.spam().filter((l) => l.kind === "say").length;
  const comings2 = ch2.spam().length - says2;
  const maxSays = CHAT_ROOM_BURST + CHAT_ROOM_PER_SEC * 10;
  const maxComings = CHAT_COMINGS_BURST + CHAT_COMINGS_PER_SEC * 10;
  check(
    `chat budget: 10 s of churn writes at most ${maxSays} says and ${maxComings} join/leave lines; the history keeps its start`,
    ch2.kept() && says2 <= maxSays && comings2 <= maxComings && ch2.room.chatLines.length < CHAT_HISTORY,
    `${says2} says, ${comings2} join/leave, ${ch2.room.chatLines.length} lines`,
  );

  // Normal chat by a full room stays inside the budgets: nothing refused, nothing skipped.
  const full = new Sim(1);
  const six = ["N1", "N2", "N3", "N4", "N5", "N6"].map((n) => full.add(n)); // six joins at once
  let tn = full.now;
  for (const p of six) for (let k = 0; k < 2; k++) full.room.chat(p, `${p.name} hello ${k}`, tn); // 12 at once
  for (let round = 0; round < 8; round++) {
    tn += 2500; // then each player once every 2.5 s: 2.4 lines a second for the room
    for (const p of six) full.room.chat(p, `${p.name} round ${round}`, tn);
  }
  for (const p of six) full.room.leave(p, tn);
  const fullLines = full.room.chatLines;
  check(
    "chat budget: six players chatting normally (12 at once, then 2.4/s for 20 s), joining and leaving lose nothing",
    fullLines.filter((l) => l.kind === "join").length === 6 &&
      fullLines.filter((l) => l.kind === "say").length === 12 + 6 * 8 &&
      fullLines.filter((l) => l.kind === "leave").length === 6 &&
      six.every((p) => errsOf(full.conns.get(p.id)!).length === 0),
    `${fullLines.filter((l) => l.kind === "say").length} says, errors ${six.map((p) => errsOf(full.conns.get(p.id)!).length).join("/")}`,
  );

  // ---- join / leave lines, chatlog order, takeover, the leave message (over Rooms) ----
  const rooms = new Rooms(1);
  const conn1 = new ClosingConn();
  const conn2 = new ClosingConn();
  const s1: Session = { conn: conn1, room: null, player: null };
  const s2: Session = { conn: conn2, room: null, player: null };
  let now = 5000;
  rooms.onMessage(s1, { t: "create", name: "Host" }, now);
  const room = s1.room!;
  rooms.onMessage(s1, { t: "chat", text: "hello early" }, now);
  rooms.onMessage(s2, { t: "join", code: room.code, name: "Guest" }, now);
  const guest = s2.player!;
  const iWelcome = conn2.msgs.findIndex((m) => m.t === "welcome");
  const iLog = conn2.msgs.findIndex((m) => m.t === "chatlog");
  const log2 = lastChatlog(conn2) ?? [];
  const guestJoins = [...log2, ...liveLines(conn2)].filter((l) => l.kind === "join" && l.name === "Guest");
  check(
    "chat: the chatlog comes right after the welcome, with the joiner's own join line exactly once",
    iWelcome >= 0 && iLog === iWelcome + 1 && guestJoins.length === 1 && log2[log2.length - 1]?.kind === "join" && log2.map((l) => l.text).includes("hello early"),
    `welcome@${iWelcome} chatlog@${iLog}, join lines ${guestJoins.length}, log ${log2.map(lineKey).join(" | ")}`,
  );
  check(
    "chat: the others get the join line live (game line: name and colour of the joiner, no from)",
    liveLines(conn1).filter((l) => l.kind === "join" && l.name === "Guest" && l.color === guest.color && !("from" in l)).length === 1,
  );
  check("chat: a session without a room cannot chat", (() => {
    const stray: Session = { conn: new FakeConn(), room: null, player: null };
    const n = room.chatLines.length;
    rooms.onMessage(stray, { t: "chat", text: "let me in" }, now);
    return room.chatLines.length === n;
  })());

  // A dropped connection and a rejoin with the token: no join, no leave; same log in order.
  rooms.onClose(s2, now);
  const conn2b = new ClosingConn();
  const s2b: Session = { conn: conn2b, room: null, player: null };
  now += 2000;
  rooms.onMessage(s2b, { t: "join", code: room.code, name: "Guest", token: guest.token }, now);
  check(
    "chat: a reconnect writes no join or leave line; the rejoin gets the whole log again, in order",
    s2b.player === guest &&
      room.chatLines.filter((l) => l.name === "Guest" && (l.kind === "join" || l.kind === "leave")).length === 1 &&
      (lastChatlog(conn2b) ?? []).map(lineKey).join() === room.chatLines.map(lineKey).join(),
    room.chatLines.map(lineKey).join(" | "),
  );

  // Takeover by another tab with the same token: no join, no leave; the old session is out.
  const conn2c = new ClosingConn();
  const s2c: Session = { conn: conn2c, room: null, player: null };
  const nLines = room.chatLines.length;
  rooms.onMessage(s2c, { t: "join", code: room.code, name: "Guest", token: guest.token }, now);
  rooms.onMessage(s2b, { t: "chat", text: "from the old tab" }, now);
  check(
    "chat: a 'taken' takeover writes no join or leave line, and the old session can no longer chat",
    errsOf(conn2b).length === 1 && // just the "taken" notice
      conn2b.msgs.some((m) => m.t === "err" && m.code === "taken") &&
      conn2b.closed &&
      room.chatLines.length === nLines,
    `${room.chatLines.length - nLines} new lines`,
  );
  rooms.onMessage(s2c, { t: "chat", text: "from the new tab" }, now);
  check("chat: the new tab chats as the same player", room.chatLines[room.chatLines.length - 1]?.from === guest.id);

  // The leave message: removed at once, one leave line, the socket closed; nothing more later.
  rooms.onMessage(s2c, { t: "leave" }, now);
  const leaves = () => room.chatLines.filter((l) => l.kind === "leave" && l.name === "Guest");
  const goneAtOnce = !room.players.has(guest.id) && s2c.room === null && conn2c.closed;
  const hostView = (conn1.msgs.filter((m) => m.t === "room").pop() as Extract<ServerMsg, { t: "room" }> | undefined)?.players.length;
  rooms.onClose(s2c, now);
  rooms.step(now + RECONNECT_GRACE_MS + 1);
  check(
    "chat: the leave message removes the player at once and writes exactly one leave line",
    goneAtOnce && hostView === 1 && leaves().length === 1 && liveLines(conn1).filter((l) => l.kind === "leave").length === 1,
    `gone ${goneAtOnce}, host sees ${hostView} players, ${leaves().length} leave lines`,
  );

  // A dropped player whose grace runs out: one leave line.
  const conn3 = new FakeConn();
  const s3: Session = { conn: conn3, room: null, player: null };
  rooms.onMessage(s3, { t: "join", code: room.code, name: "Drop" }, now);
  const drop = s3.player!;
  rooms.onClose(s3, now);
  rooms.step(now + RECONNECT_GRACE_MS / 2);
  const leftEarly = room.chatLines.some((l) => l.kind === "leave" && l.name === "Drop");
  rooms.step(now + RECONNECT_GRACE_MS + 1);
  rooms.step(now + RECONNECT_GRACE_MS + 50);
  check(
    "chat: a dropped player gets one leave line when the reconnect grace runs out (not before)",
    !leftEarly && !room.players.has(drop.id) && room.chatLines.filter((l) => l.kind === "leave" && l.name === "Drop").length === 1,
  );

  // ---- colour kept after the sender is removed ----
  sim = new Sim(1);
  const k1 = sim.add("K1");
  const k2 = sim.add("K2");
  const k2Color = k2.color;
  sim.room.chat(k2, "bye all", sim.now);
  sim.room.leave(k2, sim.now);
  const k3 = sim.add("K3"); // takes K2's freed colour
  const byeLine = lastChatlog(sim.conns.get(k3.id)!)?.find((l) => l.text === "bye all");
  check(
    "chat: a line keeps its sender's colour after the sender is gone and the colour is reassigned",
    k3.color === k2Color && byeLine?.color === k2Color && byeLine.from === k2.id && !sim.room.players.has(k2.id) && k1.color !== k2Color,
    `K3 ${k3.color}, line ${byeLine?.color}`,
  );

  // ---- history capped at 300, sent on join and on rejoin ----
  sim = new Sim(1);
  const h1 = sim.add("H1");
  const h2 = sim.add("H2");
  let t = sim.now;
  for (let i = 0; i < 320; i++) {
    t += 1000; // one a second: never rate-limited
    sim.room.chat(i % 2 ? h1 : h2, `msg ${i}`, t);
  }
  const hist = sim.room.chatLines;
  const ordered = hist.every((l, i) => i === 0 || l.n === hist[i - 1].n + 1);
  check(
    "chat: history capped at 300, oldest dropped first",
    hist.length === CHAT_HISTORY && hist[hist.length - 1].text === "msg 319" && hist[0].text === "msg 20" && ordered,
    `${hist.length} lines, ${hist[0].text} .. ${hist[hist.length - 1].text}`,
  );
  const h3 = sim.add("H3");
  const log3 = lastChatlog(sim.conns.get(h3.id)!) ?? [];
  sim.room.unbind(h1, t);
  sim.rebind(h1);
  const logRe = lastChatlog(sim.conns.get(h1.id)!) ?? [];
  check(
    "chat: a joiner and a rejoin get the full 300 lines, the same lines in the same order",
    log3.length === CHAT_HISTORY &&
      log3[log3.length - 1].kind === "join" &&
      log3.map(lineKey).join() === sim.room.chatLines.map(lineKey).join() &&
      logRe.map(lineKey).join() === log3.map(lineKey).join(),
    `joiner ${log3.length}, rejoin ${logRe.length}`,
  );

  // ---- a deleted room's code, reused, starts empty ----
  const rooms2 = new Rooms(1);
  const sa: Session = { conn: new FakeConn(), room: null, player: null };
  rooms2.onMessage(sa, { t: "create", name: "Old" }, 1000);
  const code = sa.room!.code;
  rooms2.onMessage(sa, { t: "chat", text: "remember me" }, 1000);
  rooms2.onMessage(sa, { t: "leave" }, 1000);
  rooms2.step(1100);
  const deleted = !rooms2.rooms.has(code);
  (rooms2 as unknown as { newCode: () => string }).newCode = () => code;
  const cn = new FakeConn();
  const sn: Session = { conn: cn, room: null, player: null };
  rooms2.onMessage(sn, { t: "create", name: "New" }, 2000);
  const freshLog = lastChatlog(cn) ?? [];
  check(
    "chat: a deleted room's code reused starts with an empty history",
    deleted && sn.room?.code === code && freshLog.length === 1 && freshLog[0].kind === "join" && freshLog[0].name === "New" && freshLog[0].n === 1,
    freshLog.map(lineKey).join(" | "),
  );
}

/** The client side: Game keeps the room's lines; Keyboard.clear() drops held keys. */
function chatClient(): void {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock);
  const B = wiredGame(rooms, clock);
  let chatlogs = 0;
  const live: ChatLine[] = [];
  B.game.on.chatlog = () => chatlogs++;
  B.game.on.chat = (l) => live.push(l);
  A.game.create("Ann");
  A.open();
  A.flush();
  A.game.say("  first  ");
  A.flush();
  B.game.join(A.game.code, "Bo");
  B.open();
  B.flush();
  check(
    "chat client: a joiner's list is the room's log (with its own join line once)",
    B.game.chat.map((l) => l.text).join("|") === "joined the room|first|joined the room" && chatlogs === 1,
    B.game.chat.map(lineKey).join(" | "),
  );
  A.game.say("x".repeat(250));
  B.game.say("hi Ann");
  A.flush();
  B.flush();
  check(
    "chat client: live lines are appended for everyone; say() trims and cuts to 200",
    live.length === 2 && live[0].text.length === 200 && A.game.chat[A.game.chat.length - 1]?.text === "hi Ann",
    live.map((l) => `${l.name}:${l.text.length}`).join(", "),
  );
  // A chatlog replaces the list (a rejoin's log holds the lines already shown).
  const room = rooms.rooms.get(A.game.code)!;
  const player = room.players.get(B.game.you)!;
  const s: Session = { conn: { send: () => {}, close() {} }, room: null, player: null };
  room.bind(player, s); // the server sends B's old socket "taken"; B ignores it here
  B.game["handle"]({ t: "chatlog", lines: [...room.chatLines] });
  check("chat client: a chatlog replaces the list (no duplicates)", B.game.chat.length === room.chatLines.length, `${B.game.chat.length} vs ${room.chatLines.length}`);
  // A welcome to another room clears it; the leave message clears it and removes us at once.
  const before = A.game.chat.length;
  const annId = A.game.you;
  A.game.leave();
  check(
    "chat client: leave() sends the leave message (removed at once) and clears the list",
    before > 0 && A.game.chat.length === 0 && !room.players.has(annId) && room.players.size === 1 && room.chatLines[room.chatLines.length - 1]?.kind === "leave",
    `players left ${room.players.size}`,
  );
  const C = wiredGame(rooms, clock);
  C.game.create("Cy");
  C.open();
  C.flush();
  const cyCode = C.game.code;
  C.game["handle"]({ t: "chatlog", lines: [{ n: 9, kind: "say", from: "z", name: "Z", color: "#fff", text: "old room" }] });
  C.game["handle"]({ t: "welcome", code: cyCode === "ABCD" ? "WXYZ" : "ABCD", you: "y", token: "t", laps: 1 });
  check("chat client: a welcome to a different room clears the list", C.game.chat.length === 0, `${C.game.chat.length}`);

  // Keyboard: typing blocks new keydowns only, so a key held as the chat opens kept driving
  // until its keyup. clear() (on the chat input's focus) drops it.
  const g = globalThis as unknown as Record<string, unknown>;
  const stubbed = !g.HTMLInputElement;
  if (stubbed) {
    g.HTMLInputElement = class {};
    g.HTMLTextAreaElement = class {};
  }
  try {
    const handlers = new Map<string, (e: unknown) => void>();
    const target = { addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn) } as unknown as Window;
    const kb = new Keyboard(target);
    const key = (type: string, code: string, on: unknown = null) =>
      handlers.get(type)!({ code, key: code, repeat: false, target: on, preventDefault() {} });
    const field = new (g.HTMLInputElement as new () => object)();
    key("keydown", "ArrowUp");
    const driving = kb.read().throttle;
    key("keydown", "KeyX", field); // typed into the chat: ignored
    const held = kb.read();
    kb.clear();
    const cleared = kb.read();
    key("keydown", "KeyW", field);
    const stillTyping = kb.read();
    check(
      "chat client: a key held when the chat opens stops driving (Keyboard.clear)",
      driving === 1 && held.throttle === 1 && !held.mine && cleared.throttle === 0 && stillTyping.throttle === 0,
      `before ${driving}, while typing ${held.throttle}, after clear ${cleared.throttle}`,
    );
  } finally {
    if (stubbed) {
      delete g.HTMLInputElement;
      delete g.HTMLTextAreaElement;
    }
  }
}

// ---- sound (SND-1, PLAN-SOUND.md, 2026-11-17): settings, music state, sequencer timing ----

function sound(): void {
  // Settings: defaults, clamping, broken storage (SND-4: only moved keys are the player's own).
  const d = parseStoredSound(null);
  const broken = parseStoredSound("{not json");
  const clamped = parseStoredSound(JSON.stringify({ v: 2, own: { music: 2, effects: -1, musicOn: "yes" }, muted: "yes" }));
  const kept = parseStoredSound(JSON.stringify({ v: 2, own: { music: 0.3, effects: 0.65 }, muted: true }));
  const partial = parseStoredSound(JSON.stringify({ v: 2, own: { effects: 0.2 } }));
  const eff = (st: ReturnType<typeof parseStoredSound>) => effectiveSound(st.own, null);
  check(
    "sound settings: defaults music on 0.4 (the user, 2026-11-18), effects 0.8, unmuted, nothing own; broken or missing values fall back; out of range clamps",
    DEFAULT_SOUND.musicOn && DEFAULT_SOUND.music === 0.4 && DEFAULT_SOUND.effects === 0.8 && !DEFAULT_SOUND.muted &&
      JSON.stringify(d) === JSON.stringify({ own: {}, muted: false, engine: DEFAULT_SOUND.engine }) && JSON.stringify(broken) === JSON.stringify(d) &&
      eff(d).music === 0.4 && eff(d).effects === 0.8 && eff(d).musicOn &&
      clamped.own.music === 1 && clamped.own.effects === 0 && clamped.own.musicOn === undefined && clamped.muted === false &&
      eff(kept).music === 0.3 && eff(kept).effects === 0.65 && kept.muted && eff(partial).music === 0.4 && eff(partial).effects === 0.2 && partial.own.music === undefined,
    `${JSON.stringify(d)} ${JSON.stringify(clamped)} ${JSON.stringify(partial)}`,
  );
  const key = (code: string, mods: Partial<{ repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    isMuteKey({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  check(
    "sound settings: M (KeyM) mutes; not on repeat, with a modifier, or another key",
    key("KeyM") && !key("KeyM", { repeat: true }) && !key("KeyM", { ctrlKey: true }) && !key("KeyM", { metaKey: true }) &&
      !key("KeyM", { altKey: true }) && !key("KeyM", { shiftKey: true }) && !key("KeyN") && !key("KeyX"),
  );

  // Phase -> music.
  check(
    "music: wanted in a room's lobby and results only, never on the menu (phase reads lobby there too)",
    musicWanted(true, "lobby") && musicWanted(true, "results") && !musicWanted(true, "countdown") &&
      !musicWanted(true, "racing") && !musicWanted(false, "lobby") && !musicWanted(false, "results"),
  );
  const dir = new MusicDirector();
  const trace: string[] = [];
  const at = (inRoom: boolean, phase: string, audible: boolean, now: number, force?: boolean) => {
    const a: MusicAction | null = dir.update(inRoom, phase, audible, now, force);
    if (a) trace.push(`${now}:${a}`);
    return a;
  };
  at(false, "lobby", true, 0); // menu, unlocked
  at(true, "lobby", false, 1); // joined by a reload: no gesture yet
  const locked = trace.length;
  at(true, "lobby", true, 2); // the first click unlocks: music starts
  at(true, "lobby", true, 3); // garage, still the lobby
  at(true, "countdown", true, 10); // fade out
  at(true, "countdown", true, 10 + MUSIC_FADE_OUT_S / 2);
  at(true, "countdown", true, 10 + MUSIC_FADE_OUT_S); // then stop
  at(true, "racing", true, 15);
  at(true, "results", true, 60); // back in on the results screen
  at(true, "lobby", true, 70);
  at(false, "lobby", true, 80); // left the room
  at(false, "lobby", true, 81);
  check(
    "music: nothing on the menu or before the unlock; starts on unlock in the lobby; fades at the countdown, stops after the fade; back on results; stops on leave",
    locked === 0 && trace.join(" ") === `2:start 10:fadeOut ${10 + MUSIC_FADE_OUT_S}:stop 60:start 80:stop` && dir.mode === "off",
    trace.join(" "),
  );
  trace.length = 0;
  at(true, "lobby", true, 100);
  at(true, "countdown", true, 101);
  at(true, "lobby", true, 101.3); // the countdown cancelled mid-fade: fade back in
  at(true, "lobby", false, 102); // tab hidden while wanted: keep the state (the clock pauses)
  at(true, "countdown", false, 103); // the race began while hidden: stop at once
  at(true, "racing", true, 104);
  at(false, "lobby", true, 105, true); // sound board Play on the menu
  at(false, "lobby", true, 106, false); // sound board Stop
  check(
    "music: a cancelled countdown fades back in; hidden keeps playing state, a race starting while hidden stops at once; the board's play/stop override",
    trace.join(" ") === "100:start 101:fadeOut 101.3:resume 103:stop 105:start 106:stop",
    trace.join(" "),
  );

  // Sequencer timing: a jittery ~25 ms timer, some late wakes, a hidden stretch.
  const sec = stepSeconds(SONG.bpm);
  const clock = new StepClock(sec);
  let now = 3.217;
  clock.start(now);
  const t0 = clock.timeOf(0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const got: { step: number; time: number; now: number }[] = [];
  let hiddenCalls = 0;
  let afterHidden: { step: number; time: number; now: number } | null = null;
  let resumedAt = 0;
  for (let i = 0; i < 4000; i++) {
    const late = i % 500 === 250 ? 1.3 : 0; // a throttled timer: 1.3 s late
    now += SEQ_TIMER_MS / 1000 + rnd() * 0.02 + late;
    const hidden = i >= 2000 && i < 2100;
    const due = clock.due(now, !hidden);
    if (hidden) hiddenCalls += due.length;
    if (!hidden && i >= 2100 && !afterHidden && due.length) {
      afterHidden = { ...due[0], now };
      resumedAt = now;
    }
    for (const x of due) got.push({ ...x, now });
  }
  const neverPast = got.every((x) => x.time >= x.now - 1e-9);
  const ahead = got.every((x) => x.time < x.now + SEQ_LOOKAHEAD_S + 1e-9);
  const increasing = got.every((x, i) => i === 0 || (x.step > got[i - 1].step && x.time > got[i - 1].time));
  const before = got.filter((x) => x.now < 2000 * 0.03); // the first stretch (before any restart)
  const onGrid = got
    .filter((x) => x.now < resumedAt || resumedAt === 0)
    .every((x) => Math.abs((x.time - t0) / sec - Math.round((x.time - t0) / sec)) < 1e-6 && Math.round((x.time - t0) / sec) === x.step);
  const beat = (60 / SONG.bpm);
  const beats = before.filter((x) => x.step % 4 === 0).every((x) => Math.abs(((x.time - t0) / beat) - x.step / 4) < 1e-6);
  check(
    "music sequencer: steps land on the beat grid of the song's BPM; lookahead never schedules in the past or past now + 100 ms",
    got.length > 500 && neverPast && ahead && increasing && onGrid && beats,
    `${got.length} steps, past ${got.filter((x) => x.time < x.now - 1e-9).length}, grid ${onGrid}, beats ${beats}`,
  );
  check(
    "music sequencer: nothing is due while hidden; on return the clock restarts from now (+start delay) at the next song step",
    hiddenCalls === 0 && !!afterHidden && Math.abs(afterHidden.time - (afterHidden.now + SEQ_START_DELAY_S)) < 1e-9,
    afterHidden ? `restart step ${afterHidden.step} at now+${(afterHidden.time - afterHidden.now).toFixed(3)} s` : "no restart",
  );
  const skip = new StepClock(sec);
  skip.start(0);
  const first = skip.due(0.01, true).length;
  const lateBurst = skip.due(5, true); // woke 5 s late
  check(
    "music sequencer: a late wake skips the missed steps instead of playing them in a burst",
    first > 0 && lateBurst.length <= Math.ceil(SEQ_LOOKAHEAD_S / sec) + 1 && lateBurst.every((x) => x.time >= 5),
    `${lateBurst.length} steps due after a 5 s gap`,
  );

  // The song: tempo, length, A/B structure, playable note ranges, a mono lead.
  const bars = SONG.bars;
  const steps = SONG.steps;
  const names = SONG.sections.map((x) => x.name);
  const covered = SONG.sections.reduce((n, x, i) => (x.bar === n && (i === 0 || x.bar > SONG.sections[i - 1].bar) ? n + x.bars : -1), 0);
  let leadOk = true;
  let lastEnd = 0;
  let bassOk = true;
  let drumsOk = true;
  steps.forEach((e, i) => {
    if (e.lead) {
      leadOk &&= i >= lastEnd && e.lead.len > 0 && i + e.lead.len <= steps.length && e.lead.midi >= midiOf("C4") && e.lead.midi <= midiOf("C6");
      lastEnd = i + (e.lead?.len ?? 0);
    }
    if (e.bass) bassOk &&= e.bass.len > 0 && e.bass.midi >= midiOf("A1") && e.bass.midi <= midiOf("C4");
    if (i % SONG.stepsPerBar === 0) drumsOk &&= e.drums.some((x) => x.kind === "kick");
  });
  check(
    "music song: 110-128 BPM, 16-32 bars in A/B sections covering the loop, 16 steps a bar; a kick on every downbeat; a mono lead and bass in range",
    SONG.bpm >= 110 && SONG.bpm <= 128 && bars >= 16 && bars <= 32 && steps.length === bars * SONG.stepsPerBar &&
      SONG.stepsPerBar === 16 && names.includes("A") && names.includes("B") && covered === bars && leadOk && bassOk && drumsOk,
    `${SONG.title}: ${SONG.bpm} BPM, ${bars} bars, sections ${names.join(" ")}, loop ${((bars * 16 * sec)).toFixed(1)} s`,
  );
}

// ---- race sound effects (SND-2, PLAN-SOUND.md, 2026-11-17): trigger decisions ----------

import {
  COUNTDOWN_CUES,
  CountdownCues,
  CUE_LATE_MS,
  distanceGain,
  engineTarget,
  EventGate,
  FAR_UNITS,
  HIT_HOLD_MAX_MS,
  NEAR_UNITS,
  PAN_MAX,
  panFor,
  Refractory,
  REFRACTORY_MS,
  SFX_CAPS,
  SfxCaps,
  SNAP_GAP_MS,
  SnapWatcher,
  SoundTriggers,
  type EngineState,
  type SoundView,
  type Trigger,
  type WatchedSnap,
  ENGINE_PRESETS,
} from "../client/soundlogic";
import { ENGINES } from "../client/sfx";
import { AudioEngine } from "../client/audio";

/** A client Game on a Rooms server whose inbox can also be thrown away (a dropped link). */
function soundWired(rooms: Rooms, clock: { now: number }): { game: Game; open(): void; flush(): void; drop(): void } {
  const inbox: ServerMsg[] = [];
  const session: Session = { conn: { send: (m) => inbox.push(decode<ServerMsg>(encode(m))!), close() {} }, room: null, player: null };
  const tr: Transport = {
    send: (m) => rooms.onMessage(session, decode<ClientMsg>(encode(m)), clock.now),
    close() {},
    onOpen() {},
    onMessage() {},
    onClose() {},
  };
  const game = new Game(() => tr, { get: () => null, set() {} });
  return {
    game,
    open: () => tr.onOpen(),
    flush: () => {
      for (const m of inbox.splice(0)) tr.onMessage(m);
    },
    drop: () => void inbox.splice(0),
  };
}

/** The view main.ts builds each frame (client/sfx.ts RaceSounds.frame). */
function soundView(g: Game): SoundView {
  return {
    you: g.you,
    phase: g.phase,
    raceStart: g.raceStart,
    phaseEnds: g.phaseEnds,
    serverNow: g.serverNow(),
    hasClock: g.hasClock(),
    snapTick: g.snapTick,
    own: g.takeOwnSounds(),
    snap: g.you ? g.interpSnapshot() : null,
  };
}

const tkey = (t: Trigger) => `${t.src}:${t.own ? "own" : "other"}:${t.kind}`;
const tally = (ts: Trigger[]) => ts.reduce<Record<string, number>>((m, t) => ((m[tkey(t)] = (m[tkey(t)] ?? 0) + 1), m), {});

function raceSounds(): void {
  // Distance gain and pan.
  const dg = [0, NEAR_UNITS, 300, 600, FAR_UNITS, 2000].map(distanceGain);
  check(
    "sfx distance: full within 150 units, silent from 900, falling in between; pan is light and follows the side",
    dg[0] === 1 && dg[1] === 1 && dg[2] < 1 && dg[3] < dg[2] && dg[3] > 0 && dg[4] === 0 && dg[5] === 0 &&
      panFor(-1e4) === -PAN_MAX && panFor(1e4) === PAN_MAX && panFor(0) === 0 && panFor(100) > 0 && PAN_MAX <= 0.6,
    dg.map((x) => x.toFixed(3)).join(" "),
  );

  // Per-kind caps.
  const caps = new SfxCaps();
  let other = 0;
  for (let t = 0; t < 100; t += 5) if (caps.tryStart("rivet", t, 120, false)) other++; // 20 rivets in 100 ms
  let own = 0;
  for (let t = 0; t < 100; t += 5) if (caps.tryStart("rivet", t, 120, true)) own++;
  const caps2 = new SfxCaps();
  const wrecks = [0, 50, 120, 240, 360, 2000].map((t) => caps2.tryStart("wreck", t, 1300, false));
  check(
    "sfx caps: other cars' sounds keep a per-kind gap and a concurrent cap; the own car's always play; a cap frees when its sounds end",
    other === Math.ceil(100 / SFX_CAPS.rivet.gapMs) && own === 20 && wrecks.join() === "true,false,true,false,false,true",
    `rivets in 100 ms: ${other} of 20 (others), ${own} of 20 (own); wrecks ${wrecks.join(",")}`,
  );

  // Refractory.
  const rf = new Refractory();
  const rfs = [
    rf.allow("takeoff", 0),
    rf.allow("takeoff", 16),
    rf.allow("land", 20),
    rf.allow("takeoff", REFRACTORY_MS - 1),
    rf.allow("takeoff", REFRACTORY_MS),
  ];
  check("sfx refractory: a kind plays at most once per 400 ms; kinds are independent", REFRACTORY_MS === 400 && rfs.join() === "true,false,true,false,true", rfs.join());

  // Countdown: a race seen from the lobby, the clock estimate jittering and jumping back.
  const cueRun = (o: { firstMs: number; stallAt?: number; stallMs?: number; jitter: number; clock?: (t: number) => boolean }) => {
    const cc = new CountdownCues();
    const T0 = 50_000; // the countdown starts (server time); raceStart = T0 + 3000
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: { cue: number; late: number }[] = [];
    let err = 0;
    for (let t = T0 - 500; t < T0 + 5000; t += 1000 / 60) {
      if (o.stallAt !== undefined && t >= o.stallAt && t < o.stallAt + o.stallMs!) continue; // no frames
      if (Math.floor(t / 400) !== Math.floor((t - 1000 / 60) / 400)) err = (rnd() * 2 - 1) * o.jitter; // the estimate moves in steps
      const now = t + err;
      const seen = t >= T0 + o.firstMs; // when this client learns of the countdown
      const phase = !seen ? "lobby" : now < T0 + 3000 + 60 ? "countdown" : "racing";
      const raceStart = seen ? T0 + 3000 : 0;
      const phaseEnds = phase === "countdown" ? T0 + 3000 : 0;
      const cue = cc.update(phase, raceStart, phaseEnds, now, o.clock ? o.clock(t) : true);
      if (cue !== null) out.push({ cue, late: Math.round(now - (T0 + 3000 - (COUNTDOWN_CUES - 1 - cue) * 1000)) });
    }
    return out;
  };
  const normal = cueRun({ firstMs: 60, jitter: 40 });
  const rejoin = cueRun({ firstMs: 1400, jitter: 40 });
  const stall = cueRun({ firstMs: 60, jitter: 0, stallAt: 51_900, stallMs: 450 }); // straddles the "1" beep at 52 000
  const noClock = cueRun({ firstMs: 60, jitter: 0, clock: (t) => t > 50_500 });
  const fmt = (r: { cue: number; late: number }[]) => r.map((x) => `${x.cue}@${x.late}`).join(" ");
  check(
    "sfx countdown: exactly 3 beeps + GO per race, in order, on time, under a jittering clock estimate that jumps back",
    normal.map((x) => x.cue).join() === "0,1,2,3" && normal.every((x) => x.late >= 0 && x.late <= CUE_LATE_MS),
    fmt(normal),
  );
  check(
    "sfx countdown: first seen mid-countdown (a rejoin) passes the cues already gone silently; a stalled frame skips its cue; none before the clock exists",
    rejoin.map((x) => x.cue).join() === "2,3" && stall.map((x) => x.cue).join() === "0,1,3" && noClock.map((x) => x.cue).join() === "1,2,3",
    `rejoin ${fmt(rejoin)} | stall ${fmt(stall)} | no clock until 0.5 s ${fmt(noClock)}`,
  );
  const cc2 = new CountdownCues();
  const second: number[] = [];
  for (const [race, t] of [[10_000, 7_000], [10_000, 8_000], [10_000, 9_000], [10_000, 10_100], [60_000, 57_010], [60_000, 58_010], [60_000, 59_010], [60_000, 60_010]] as const) {
    const c = cc2.update(t < race ? "countdown" : "racing", race, t < race ? race : 0, t, true);
    if (c !== null) second.push(c);
  }
  check("sfx countdown: latched per raceStart: the next race counts down again", second.join() === "0,1,2,3,0,1,2,3", second.join());

  // Snapshot watcher.
  const car = (air = 0, fall = 0) => ({ x: 0, y: 0, air, fall });
  const snapOf = (time: number, o: { shots?: [number, string][]; mines?: [number, string][]; cars?: [string, number, number][] }): WatchedSnap => ({
    time,
    shots: new Map((o.shots ?? []).map(([id, ow]) => [id, { o: ow, x: 0, y: 0 }])),
    mines: (o.mines ?? []).map(([id, ow]) => ({ id, o: ow, x: 0, y: 0 })),
    cars: new Map((o.cars ?? []).map(([id, a, f]) => [id, car(a, f)])),
  });
  const sw = new SnapWatcher();
  const run = (s: WatchedSnap | null) => {
    const out: Trigger[] = [];
    sw.update(s, "me", out);
    return out.map((t) => `${t.kind}:${t.id}`).join(",");
  };
  const steps = [
    run(snapOf(1000, { shots: [[1, "o"], [2, "me"]], mines: [[1, "o"]], cars: [["o", 5, 0], ["me", 0, 0]] })), // first: seeds
    run(snapOf(1033, { shots: [[1, "o"], [2, "me"], [3, "o"], [4, "me"]], mines: [[1, "o"], [2, "o"], [3, "me"]], cars: [["o", 0, 0], ["me", 7, 0]] })),
    run(snapOf(1033, { shots: [[9, "o"]] })), // the same snapshot again
    run(snapOf(1000, { shots: [[9, "o"]] })), // an older one (the clock jumped back)
    run(snapOf(1066, { cars: [["o", 0, 30]] })),
    run(snapOf(1100, { cars: [["o", 0, 0]] })),
    run(snapOf(1133, { cars: [["o", 9, 0]] })),
    run(snapOf(1500, { shots: [[20, "o"]], mines: [[30, "o"]], cars: [["o", 0, 0]] })), // a gap > 250 ms: seeds
    run(snapOf(1533, { shots: [[20, "o"], [21, "o"]], mines: [[30, "o"]], cars: [["o", 0, 0]] })),
  ];
  sw.reset(); // a welcome
  steps.push(run(snapOf(1566, { shots: [[22, "o"]], mines: [[31, "o"]], cars: [["o", 3, 0]] })));
  steps.push(run(snapOf(1600, { shots: [[22, "o"], [23, "o"]], mines: [[31, "o"]], cars: [["o", 0, 0]] })));
  check(
    "sfx snapshots: seeded silently on the first snapshot, after a gap > 250 ms and after a welcome; new shots, mines and air/fall changes of other cars only; never the own car; old or repeated snapshots ignored",
    SNAP_GAP_MS === 250 &&
      steps.join(" | ") === " | rivet:o,drop:o,land:o |  |  | fall:o | recover:o | takeoff:o |  | rivet:o |  | rivet:o,land:o",
    steps.join(" | "),
  );

  // Server events.
  const gate = new EventGate(100);
  const got: string[] = [];
  const take = (now: number, snapTick: number) => {
    const out: Trigger[] = [];
    gate.take(now, snapTick, out);
    for (const t of out) got.push(`${now}:${t.kind}:${t.id}`);
  };
  gate.event({ k: "hit", id: "o", by: "me", dmg: 4, w: "rivet" }, 10, "me", 0); // another car: 100 ms later
  gate.event({ k: "hit", id: "me", by: "o", dmg: 4, w: "rivet" }, 11, "me", 0); // own: when tick 11's snapshot is in
  take(0, 10);
  take(16, 12);
  take(99, 12);
  take(100, 12);
  gate.event({ k: "hit", id: "me", by: "o", dmg: 4, w: "rivet" }, 20, "me", 200); // fatal: the wreck follows, same tick
  take(210, 18);
  gate.event({ k: "wreck", id: "me", by: "o" }, 20, "me", 230);
  take(240, 20);
  gate.event({ k: "hit", id: "o", by: "me", dmg: 15, w: "mine" }, 30, "me", 300); // a fatal mine: blast under the wreck
  gate.event({ k: "wreck", id: "o", by: "me" }, 30, "me", 310);
  take(405, 30);
  take(410, 30);
  gate.event({ k: "hit", id: "o", by: "me", dmg: 15, w: "mine" }, 40, "me", 500); // a mine that does not wreck
  gate.event({ k: "hit", id: "me", by: "o", dmg: 4, w: "rivet" }, 41, "me", 500); // no snapshot ever: released after the hold
  gate.event({ k: "lap", id: "me", lap: 1 }, 41, "me", 500);
  take(500, 0);
  take(500 + HIT_HOLD_MAX_MS, 0);
  take(600, 0);
  take(750, 0);
  check(
    "sfx events: other cars' wait out the interpolation delay; own hits wait for their tick's snapshot; a wreck replaces its fatal hit (a mine keeps its blast); a mine hit is a blast",
    got.join(" ") === "16:hit:me 100:hit:o 240:wreck:me 405:blast:o 410:wreck:o 500:lap:me 650:hit:me 750:blast:o",
    got.join(" "),
  );

  // Engine.
  const base: EngineState = { phase: "racing", hasCar: true, connected: true, wreck: 0, fall: 0, air: 0, finished: false, speed: 200, topSpeed: 430, throttle: 1 };
  const silentWhen: Partial<EngineState>[] = [{ hasCar: false }, { connected: false }, { wreck: 5 }, { fall: 5 }, { finished: true }, { phase: "results" }, { phase: "lobby" }];
  const silent = silentWhen.every((p) => engineTarget({ ...base, ...p }).gain === 0 && !engineTarget({ ...base, ...p }).on);
  const slow = engineTarget({ ...base, speed: 100 });
  const fast = engineTarget({ ...base, speed: 430 });
  const coast = engineTarget({ ...base, throttle: 0 });
  const countdownRev = engineTarget({ ...base, phase: "countdown", speed: 0 });
  const countdownIdle = engineTarget({ ...base, phase: "countdown", speed: 0, throttle: 0 });
  const top = engineTarget({ ...base, speed: 430 });
  check(
    "sfx engine: silent with no car, disconnected, wrecked, falling, finished, on results and outside races; revs rise with speed (1 at top), load and gain with throttle; revs in the countdown",
    silent && fast.rpm > slow.rpm && top.rpm === 1 && base.throttle === 1 && engineTarget(base).load === 1 && coast.load === 0 &&
      engineTarget(base).gain > coast.gain && coast.gain > 0 && countdownRev.rpm > countdownIdle.rpm && countdownIdle.rpm === 0 && countdownRev.on,
    `rpm slow ${slow.rpm.toFixed(2)}, fast ${fast.rpm.toFixed(2)}, countdown rev ${countdownRev.rpm.toFixed(2)}; gain ${engineTarget(base).gain.toFixed(2)} / coast ${coast.gain.toFixed(2)}`,
  );

  // Engine presets: petrol firing rates, a stored choice.
  const ranges = ENGINE_PRESETS.map((p) => `${p} ${ENGINES[p].idleHz}-${ENGINES[p].topHz} Hz`);
  const rangesOk = ENGINE_PRESETS.every((p) => ENGINES[p].idleHz >= 25 && ENGINES[p].idleHz <= 40 && ENGINES[p].topHz >= 150 && ENGINES[p].topHz <= 220);
  const distinct = new Set(ENGINE_PRESETS.map((p) => JSON.stringify(ENGINES[p].pulses))).size === ENGINE_PRESETS.length;
  const stored = parseStoredSound(JSON.stringify({ engine: "v8" })).engine;
  const unknown = parseStoredSound(JSON.stringify({ engine: "electric" })).engine;
  check(
    "sfx engine presets: 3 distinct petrol engines, idle firing 25-40 Hz up to 150-220 Hz at top speed; the choice is a stored sound setting (unknown -> the default)",
    ENGINE_PRESETS.length === 3 && rangesOk && distinct && stored === "v8" && unknown === DEFAULT_SOUND.engine && ENGINE_PRESETS.includes(DEFAULT_SOUND.engine) &&
      parseStoredSound(null).engine === DEFAULT_SOUND.engine,
    `${ranges.join(", ")}; default ${DEFAULT_SOUND.engine}`,
  );

  // Hidden / not running: nothing comes out, nothing is kept for later.
  const st = new SoundTriggers(100);
  st.event({ k: "hit", id: "o", by: "x", dmg: 4, w: "rivet" }, 1, "me", 0, false);
  const view: SoundView = { you: "me", phase: "racing", raceStart: 1, phaseEnds: 0, serverNow: 5000, hasClock: true, snapTick: 99, own: [{ k: "shot", speed: 0 }, { k: "takeoff", speed: 0 }], snap: null };
  const hiddenOut = st.frame(view, 0, false);
  st.event({ k: "hit", id: "o", by: "x", dmg: 4, w: "rivet" }, 2, "me", 10, true);
  st.frame({ ...view, own: [] }, 20, false); // hidden before it was due: dropped
  const back = st.frame({ ...view, own: [] }, 500, true);
  check(
    "sfx hidden: while audio does not run (hidden tab, suspended), no trigger comes out and held events are dropped, not played on return",
    hiddenOut.length === 0 && back.length === 0 && st.bump(500, 0, 0, false) === null,
    `${hiddenOut.length} while hidden, ${back.length} on return`,
  );

  // End to end without lag (performance.now() is the sim clock): a jumper through a race on
  // the T1b track with an observer, then a weapons race with a dropped link and a rejoin.
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const J = soundWired(rooms, clock);
    const jt = new SoundTriggers(100);
    J.game.on.welcome = () => jt.reset();
    J.game.on.event = (ev, tick) => jt.event(ev, tick, J.game.you, clock.now, true);
    J.game.create("Jumper");
    J.open();
    J.flush();
    J.game.pickTrack(T1B_ID);
    J.flush();
    J.game.start();
    J.flush();
    const room = [...rooms.rooms.values()][0];
    const t1b = trackById(T1B_ID);
    const script = new JumpFallScript(t1b);
    const O = soundWired(rooms, clock);
    const ot = new SoundTriggers(100);
    O.game.on.welcome = () => ot.reset();
    let observing = false;
    const jOut: Trigger[] = [];
    const oOut: Trigger[] = [];
    let after = 0;
    for (let i = 0; i < 60 * 40 && after < 90; i++) {
      if (script.done()) after++;
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      J.flush();
      O.flush();
      J.game.step(script.controls(J.game.car), 1000 / 60);
      O.game.step(NO_CONTROLS, 1000 / 60);
      jOut.push(...jt.frame(soundView(J.game), clock.now, true));
      if (observing) oOut.push(...ot.frame(soundView(O.game), clock.now, true).filter((t) => t.src === "snap"));
      if (room.phase === "racing" && !observing) {
        observing = true;
        O.game.join(room.code, "Observer");
        O.open();
      }
    }
    const jt1 = tally(jOut);
    const ot1 = tally(oOut);
    check(
      "sfx end to end: the jumper hears 3 beeps + GO, and its own take-off, landing, fall and recovery once each (from step())",
      script.done() && jt1["countdown:own:beep"] === 3 && jt1["countdown:own:go"] === 1 &&
        ["takeoff", "land", "fall", "recover"].every((k) => jt1[`step:own:${k}`] === 1) && Object.keys(jt1).length === 6,
      JSON.stringify(jt1),
    );
    check(
      "sfx end to end: an observer hears the jumper's take-off, landing, fall and recovery once each (from its snapshots)",
      ["takeoff", "land", "fall", "recover"].every((k) => ot1[`snap:other:${k}`] === 1) && Object.keys(ot1).length === 4,
      JSON.stringify(ot1),
    );

    // Weapons: A fires and drops mines, B watches; B's link drops, A drops a mine meanwhile,
    // B is welcomed back with the mines on the track.
    const rooms2 = new Rooms(1);
    const A = soundWired(rooms2, clock);
    const B = soundWired(rooms2, clock);
    const at = new SoundTriggers(100);
    const bt = new SoundTriggers(100);
    let bWelcomes = 0;
    A.game.on.welcome = () => at.reset();
    B.game.on.welcome = () => {
      bWelcomes++;
      bt.reset();
    };
    A.game.create("Ann");
    A.open();
    A.flush();
    B.game.join(A.game.code, "Bo");
    B.open();
    B.flush();
    A.flush();
    for (const g of [A, B]) {
      g.game.buy("rivets");
      g.game.buy("mines");
    }
    B.game.setReady(true);
    A.flush();
    B.flush();
    A.game.start();
    const room2 = rooms2.rooms.get(A.game.code)!;
    const aOut: Trigger[] = [];
    const bOut: Trigger[] = [];
    const bAfter: Trigger[] = [];
    let linkDown = false;
    let rejoined = false;
    let mineAt = -1;
    const shot0 = A.game["localShotId"];
    const aBot = new BotDriver(A.game, 0);
    aBot.weapons = false;
    let droppedMine = 0;
    for (let i = 0; i < 60 * 20; i++) {
      clock.now += 1000 / 60;
      rooms2.step(clock.now);
      A.flush();
      if (linkDown) B.drop();
      else B.flush();
      // A drives on, fires in bursts once armed and drops its 3 mines; B sits still behind.
      const mine = A.game.armed() && droppedMine < 3 && (i % 50 === 0);
      if (mine) {
        droppedMine++;
        if (droppedMine === 3) mineAt = i;
      }
      A.game.step({ ...aBot.controls(), fire: A.game.armed() && i % 40 < 20, mine }, 1000 / 60);
      B.game.step(NO_CONTROLS, 1000 / 60);
      aOut.push(...at.frame(soundView(A.game), clock.now, true));
      runTimers();
      if (linkDown) continue;
      const bt1 = bt.frame(soundView(B.game), clock.now, true);
      (rejoined ? bAfter : bOut).push(...bt1);
      // Two mines are out: the link drops for 1.5 s; the third goes down while it is down.
      if (droppedMine === 2 && !linkDown && !rejoined && i % 50 === 25) {
        linkDown = true;
        setTimeout0(() => {
          linkDown = false;
          rejoined = true;
          B.game["handle"]({ t: "welcome", code: A.game.code, you: B.game.you, token: "t", laps: room2.laps });
        }, 90);
      }
    }
    const fired = A.game["localShotId"] - shot0;
    const aT = tally(aOut);
    const bT = tally(bOut);
    const bA = tally(bAfter);
    check(
      "sfx end to end: the own rivet sounds equal the rivets fired, the own mine drops the mines dropped (from step(), none from snapshots)",
      fired > 10 && aT["step:own:rivet"] === fired && aT["step:own:drop"] === 3 && !aT["snap:other:rivet"] && !aT["snap:other:drop"],
      `fired ${fired}, rivet sounds ${aT["step:own:rivet"]}, mines 3, drop sounds ${aT["step:own:drop"]}`,
    );
    check(
      "sfx end to end: a watcher hears the other car's rivets and its first 2 mines; after a dropped link and a welcome, the mine laid meanwhile and the ones on the track make no sound",
      (bT["snap:other:rivet"] ?? 0) > 0 && bT["snap:other:drop"] === 2 && rejoined && bWelcomes === 2 && mineAt > 0 && !bA["snap:other:drop"] &&
        (B.game.interpSnapshot()?.mines.length ?? 0) >= 3,
      `before ${JSON.stringify(bT)}; after the rejoin ${JSON.stringify(bA)}; mines on the track ${B.game.interpSnapshot()?.mines.length}; welcomes ${bWelcomes}`,
    );
  } finally {
    performance.now = realNow;
  }
}

// A tiny frame-counted timer for the tests above (no wall clock).
const timers: { left: number; fn: () => void }[] = [];
function setTimeout0(fn: () => void, frames: number): void {
  timers.push({ left: frames, fn });
}
function runTimers(): void {
  for (const t of timers.splice(0)) {
    if (--t.left <= 0) t.fn();
    else timers.push(t);
  }
}

// ---- surface and crash sounds (SND-2 taste round): gravel band, impacts, wall hits -------

import { CRASH_HARD_SPEED, CRASH_MIN_SPEED, gravelTarget, impactSound, onGravel, WALL_CRASH_SPEED, WALL_REFRACTORY_MS } from "../client/soundlogic";
import { WALL_HIT_MIN, wallHitSpeed, type OwnCue } from "../client/game";
import { wallLimit } from "../shared/physics";

function surfaceSounds(): void {
  // Gravel: the car's centre off the asphalt, at lateral offsets on a real (curved) track.
  const half = track.def.halfWidth;
  const at = (s: number, lat: number) => {
    const p = pointAt(track, s);
    const x = p.x - Math.sin(p.h) * lat;
    const y = p.y + Math.cos(p.h) * lat;
    return onGravel(queryTrackNear(track, x, y, p.seg).dist, half);
  };
  const lats = [0, half - 6, half - 1, half + 1, half + 4, track.wall - CAR_WIDTH / 2];
  const sides = [-1, 1].map((side) => [L * 0.13, L * 0.41, L * 0.77].map((s0) => lats.map((l) => (at(s0, side * l) ? "G" : "a")).join("")).join(" "));
  check(
    "sfx gravel band: asphalt up to the tarmac half-width, gravel beyond it out to the wall, on both sides, on straights and bends",
    sides.every((x) => x === "aaaGGG aaaGGG aaaGGG"),
    `lateral ${lats.map((l) => l.toFixed(0)).join("/")}: ${sides.join(" | ")}`,
  );
  const st: EngineState = { phase: "racing", hasCar: true, connected: true, wreck: 0, fall: 0, air: 0, finished: false, speed: 250, topSpeed: 430, throttle: 1 };
  const quiet: Partial<EngineState>[] = [{ air: 5 }, { wreck: 5 }, { fall: 5 }, { finished: true }, { phase: "results" }, { phase: "lobby" }, { hasCar: false }, { connected: false }, { speed: 10 }];
  const slow = gravelTarget({ ...st, speed: 60 }, true);
  const fast = gravelTarget({ ...st, speed: 350 }, true);
  check(
    "sfx gravel: on only off the asphalt while rolling; silent airborne, wrecked, falling, finished, outside races, nearly stopped; louder and denser with speed",
    gravelTarget(st, true).on && !gravelTarget(st, false).on && gravelTarget(st, false).gain === 0 &&
      quiet.every((q) => !gravelTarget({ ...st, ...q }, true).on && gravelTarget({ ...st, ...q }, true).gain === 0) &&
      fast.gain > slow.gain && fast.density > slow.density,
    `gain ${slow.gain.toFixed(2)} at 60 u/s, ${fast.gain.toFixed(2)} at 350; density ${slow.density.toFixed(2)} / ${fast.density.toFixed(2)}`,
  );

  // Impacts: a touch is a thud, harder a crash whose force grows.
  const im = [100, CRASH_MIN_SPEED, 300, CRASH_HARD_SPEED, 900].map((v) => impactSound(v, CRASH_MIN_SPEED, CRASH_HARD_SPEED, "crash"));
  const wl = [80, WALL_CRASH_SPEED, 400].map((v) => impactSound(v, WALL_CRASH_SPEED, 350, "wall"));
  check(
    "sfx impacts: a car contact below 150 u/s closing speed is a soft thud, from it a metal crash, force 0 -> 1 at 450; wall hits alike (thud below 110 u/s into the wall)",
    im[0].kind === "bump" && im.slice(1).every((x) => x.kind === "crash") && im[1].force === 0 && im[2].force > 0 && im[2].force < 1 && im[3].force === 1 && im[4].force === 1 &&
      im[3].vel > im[1].vel && wl[0].kind === "bump" && wl[1].kind === "wall" && wl[2].force === 1,
    im.map((x) => `${x.kind} ${x.force.toFixed(2)}`).join(", "),
  );

  // Wall hits through the real physics on the T1b straight (centerline y = 0, heading +x).
  const t1b = trackById(T1B_ID);
  const limit = wallLimit(t1b);
  const into = (vy: number) => {
    const c: CarState = { x: 3000, y: limit - 1, h: 0.3, vx: 250, vy, seg: pointAt(t1b, 3000).seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const before = cloneCar(c);
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(t1b));
    return { speed: wallHitSpeed(before, c, t1b), vyAfter: c.vy, atWall: Math.abs(c.y - limit) < 0.02 };
  };
  const hard = into(180);
  const soft = into(30);
  const away = into(-80);
  const free = { ...into(0) };
  const mid: CarState = { x: 3000, y: 0, h: 0, vx: 250, vy: 120, seg: pointAt(t1b, 3000).seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const midBefore = cloneCar(mid);
  stepRaceCar(mid, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(t1b));
  check(
    "sfx wall hit: the speed into the wall that collideWalls removes (velocity before the step, wall normal after it); none away from the wall or moving off it; the 50 u/s threshold",
    hard.atWall && Math.abs(hard.speed - 180) < 1 && hard.vyAfter < 0 && hard.speed >= WALL_HIT_MIN && soft.speed < WALL_HIT_MIN &&
      away.speed === 0 && wallHitSpeed(midBefore, mid, t1b) === 0 && free.speed === 0,
    `hard ${hard.speed.toFixed(1)} u/s (vy after ${hard.vyAfter.toFixed(1)}), soft ${soft.speed.toFixed(1)}, moving away ${away.speed}, mid-track 0`,
  );

  // Refractory: one wall sound per 200 ms while the car keeps touching the wall.
  const tr = new SoundTriggers(100);
  const wv = (own: OwnCue[]): SoundView => ({ you: "me", phase: "racing", raceStart: 1, phaseEnds: 0, serverNow: 1e6, hasClock: true, snapTick: 0, own, snap: null });
  const walls: number[] = [];
  for (const [ms, sp] of [[0, 200], [50, 120], [150, 300], [WALL_REFRACTORY_MS, 90], [WALL_REFRACTORY_MS + 100, 400], [WALL_REFRACTORY_MS * 2 + 10, 200]] as const) {
    if (tr.frame(wv([{ k: "wall", speed: sp }]), ms, true).length) walls.push(ms);
  }
  check("sfx wall hit: at most one wall sound per 200 ms", walls.join() === `0,${WALL_REFRACTORY_MS},${WALL_REFRACTORY_MS * 2 + 10}`, walls.join());

  // End to end on the wired room: steer into the wall with snapshots arriving 150 ms late, so
  // reconcile replays the steps across the hit. Cues come from step() only.
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const W = soundWired(rooms, clock);
    W.game.create("Waller");
    W.open();
    W.flush();
    W.game.pickTrack(T1B_ID);
    W.flush();
    W.game.start();
    W.flush();
    const room = [...rooms.rooms.values()][0];
    let fromStep = 0;
    let fromReplay = 0;
    let speeds: number[] = [];
    let flushes = 0;
    let side = 1;
    for (let i = 0; i < 60 * 16; i++) {
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      if (i % 9 === 0) {
        W.flush(); // reconcile: rewinds to the server state and replays the pending steps
        flushes++;
        fromReplay += W.game.takeOwnSounds().filter((c) => c.k === "wall").length;
      }
      const racing = room.phase === "racing";
      // Aim at one wall (0.45 rad off the straight's heading +x), then at the other once there.
      const c = W.game.car;
      if (c && Math.abs(c.y) > limit - 3) side = -Math.sign(c.y);
      const steer = c ? clamp((side * 0.45 - angleDiff(0, c.h)) * 3, -1, 1) : 0;
      W.game.step(racing ? { throttle: 0.75, steer, fire: false, mine: false } : NO_CONTROLS, 1000 / 60);
      const cues = W.game.takeOwnSounds().filter((c) => c.k === "wall");
      fromStep += cues.length;
      speeds = speeds.concat(cues.map((c) => Math.round(c.speed)));
    }
    check(
      "sfx wall hit end to end: a car weaving into both walls under 150 ms late snapshots queues its wall hits from step(); reconcile's replays across them queue none",
      fromStep >= 3 && fromReplay === 0 && speeds.every((v) => v >= WALL_HIT_MIN) && W.game.recErrors.length > 20 && flushes > 30,
      `${fromStep} wall cues from step (speeds ${speeds.join(", ")}), ${fromReplay} after replays, ${W.game.recErrors.length} acked steps over ${flushes} late flushes`,
    );
  } finally {
    performance.now = realNow;
  }
}

// ---- audio unlock after a hidden tab (SND-2 review fix, client/audio.ts) -----------------

/**
 * AudioEngine on fake browser globals: window and document event targets and an
 * AudioContext whose resume() can be told to leave it suspended (as a browser may on
 * return to a tab). Promises are synchronous thenables, so the checks need no event loop.
 */
function audioUnlock(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, AudioContext: g.AudioContext };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const done = { then(ok?: () => void) { ok?.(); return done; }, catch() { return done; } };
  const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} });
  const node = () => ({ gain: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: (n: unknown) => n, disconnect() {} });
  class FakeContext extends EventTarget {
    static last: FakeContext | null = null;
    state = "suspended";
    currentTime = 0;
    sampleRate = 8000;
    destination = node();
    resumeWorks = true;
    resumes = 0;
    constructor() {
      super();
      FakeContext.last = this;
    }
    createGain() { return node(); }
    createDynamicsCompressor() { return node(); }
    createBuffer(_ch: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
    resume() { this.resumes++; if (this.resumeWorks) this.to("running"); return done; }
    suspend() { this.to("suspended"); return done; }
    private to(s: string) { if (s !== this.state) { this.state = s; this.dispatchEvent(new Event("statechange")); } }
  }
  Object.assign(g, { window: win, document: doc, AudioContext: FakeContext });
  try {
    const eng = new AudioEngine();
    eng.attach();
    const states: string[] = [];
    const note = (what: string) => states.push(`${what}:${FakeContext.last?.state ?? "none"}:${eng.running()}`);
    win.dispatchEvent(new Event("pointerup")); // the first gesture creates and starts the context
    note("unlock");
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    note("hidden");
    const ctx = FakeContext.last!;
    ctx.resumeWorks = false; // the browser keeps it suspended on return
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    note("back");
    ctx.resumeWorks = true;
    win.dispatchEvent(new Event("keydown")); // the next gesture
    note("key");
    const resumes = ctx.resumes;
    win.dispatchEvent(new Event("click")); // running: the unlock is disarmed again
    check(
      "audio: back from a hidden tab with the context still suspended, the next key or click starts it again (and the unlock disarms once it runs)",
      states.join(" ") === "unlock:running:true hidden:suspended:false back:suspended:false key:running:true" && ctx.resumes === resumes,
      `${states.join(" ")}; resume() calls ${resumes}, after another click ${ctx.resumes}`,
    );
  } finally {
    Object.assign(g, saved);
  }
}

// ---- in-game menu: host room controls (MENU-1, PLAN-MENU.md, 2026-11-18) ----------------

// This section's imports (hoisted like the ones at the top).
import { BLOCKLIST_MAX, COUNTDOWN_MS } from "../shared/protocol";
import { lostMessage } from "../client/game";

type MenuSession = Session & { conn: ClosingConn };
const menuSession = (): MenuSession => ({ conn: new ClosingConn(), room: null, player: null });

/** A Rooms server with a host and players joined over onMessage (the socket path). */
function menuRooms(names: string[]): { rooms: Rooms; room: Room; s: MenuSession[]; p: Player[]; clock: { now: number }; send(i: number, m: ClientMsg): void; join(name: string, token?: string): MenuSession; step(n: number): void } {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const s = names.map(() => menuSession());
  rooms.onMessage(s[0], { t: "create", name: names[0] }, clock.now);
  const room = s[0].room!;
  for (let i = 1; i < names.length; i++) rooms.onMessage(s[i], { t: "join", code: room.code, name: names[i] }, clock.now);
  return {
    rooms,
    room,
    s,
    p: s.map((x) => x.player!),
    clock,
    send: (i, m) => rooms.onMessage(s[i], m, clock.now),
    join: (name, token) => {
      const x = menuSession();
      rooms.onMessage(x, token ? { t: "join", code: room.code, name, token } : { t: "join", code: room.code, name }, clock.now);
      return x;
    },
    step: (n) => {
      for (let i = 0; i < n; i++) rooms.step((clock.now += 1000 / 60));
    },
  };
}

function errMsgs(c: FakeConn): Extract<ServerMsg, { t: "err" }>[] {
  return c.msgs.filter((m): m is Extract<ServerMsg, { t: "err" }> => m.t === "err");
}

function lastRoomMsg(c: FakeConn): Extract<ServerMsg, { t: "room" }> | undefined {
  return c.msgs.filter((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room").pop();
}

/** Lines written since index `from` of the room's log. */
const linesSince = (room: Room, from: number) => room.chatLines.slice(from).map((l) => `${l.kind}:${l.name} ${l.text}`);

function menuHostOnly(): void {
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [, b, c] = R.p;
  const cmds: ClientMsg[] = [{ t: "stop" }, { t: "restart" }, { t: "kick", id: c.id }, { t: "host", id: b.id }, { t: "lock", locked: true }];
  const want = "Only the host can stop the race|Only the host can restart the race|Only the host can remove a player|Only the host can hand over the host|Only the host can lock the room";
  const e0 = errsOf(R.s[1].conn).length;
  for (const m of cmds) R.send(1, m);
  const lobbyErrs = errsOf(R.s[1].conn).slice(e0).join("|");
  const unchanged = () => R.room.players.size === 3 && R.room.hostId === R.p[0].id && !R.room.locked;
  const lobbyOk = unchanged() && R.room.phase === "lobby";
  R.send(1, { t: "ready", ready: true });
  R.send(2, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  while (R.room.phase !== "racing") R.step(1);
  const raceStart = R.room.raceStart;
  const e1 = errsOf(R.s[1].conn).length;
  for (const m of cmds) R.send(1, m);
  const raceErrs = errsOf(R.s[1].conn).slice(e1).join("|");
  check(
    "menu: every host command (stop, restart, kick, host, lock) is refused from a non-host with an err, in the lobby and in a race",
    lobbyErrs === want && lobbyOk && raceErrs === want && unchanged() && R.room.phase === "racing" && R.room.raceStart === raceStart,
    `lobby: ${lobbyErrs}; race: ${raceErrs}`,
  );

  // Phase rules: no stop or restart in the lobby or the results.
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const s = sim.add("Sol");
  const lobby = [sim.room.stopRace(a, sim.now), sim.room.restartRace(a, sim.now)];
  sim.startRace(a);
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  nearFinish(sim, s);
  sim.run(15, (p) => (p === s ? { throttle: 1 } : {}));
  const phase: string = sim.room.phase;
  const results = [sim.room.stopRace(a, sim.now), sim.room.restartRace(a, sim.now)];
  check(
    "menu: the host's stop and restart are refused in the lobby and in the results (countdown and race only)",
    lobby.join("|") === "No race to stop|No race to restart" && phase === "results" && results.join("|") === lobby.join("|") && sim.room.phase === "results",
    `lobby: ${lobby.join("|")}; ${phase}: ${results.join("|")}`,
  );
}

function menuStop(): void {
  // ---- in the race: lobby, no payouts, no result line, ammo back ----
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  a.ammo.rivets = 30;
  a.ammo.mines = 2;
  b.ammo.rivets = 12;
  b.ammo.mines = 1;
  sim.startRace(a);
  const grid0 = sim.room.gridOrder().map((p) => p.name).join(",");
  sim.now = sim.room.raceStart + WEAPONS_ARM_MS;
  sim.run(1, () => ({ throttle: 1, mine: true }));
  sim.run(90, () => ({ throttle: 1, fire: true }));
  const spent = `${a.ammo.rivets}/${a.ammo.mines} ${b.ammo.rivets}/${b.ammo.mines}`;
  const scrap = [a.wallet.scrap, b.wallet.scrap];
  const lines0 = sim.room.chatLines.length;
  const msgs0 = [...sim.conns.values()].map((c) => c.msgs.length);
  const e = sim.room.stopRace(a, sim.now);
  sim.run(2);
  const after = [...sim.conns.values()].flatMap((c, i) => c.msgs.slice(msgs0[i]));
  check(
    "stop: a race goes back to the lobby at once: no cars, no results message, no result line, no scrap paid",
    e === null &&
      sim.room.phase === "lobby" &&
      !a.car && !b.car && !a.inRace &&
      after.every((m) => m.t !== "results") &&
      sim.room.chatLines.length === lines0 &&
      a.wallet.scrap === scrap[0] && b.wallet.scrap === scrap[1] &&
      sim.room.combat.shotSnaps().length === 0 && sim.room.combat.mineSnaps().length === 0,
    `phase ${sim.room.phase}, lines +${sim.room.chatLines.length - lines0}, scrap ${a.wallet.scrap}/${b.wallet.scrap}`,
  );
  check(
    "stop: each racer gets back the ammo the aborted race used (snapshot from start)",
    spent !== "30/2 12/1" && a.ammo.rivets === 30 && a.ammo.mines === 2 && b.ammo.rivets === 12 && b.ammo.mines === 1 && a.ammo === a.wallet.ammo,
    `spent to ${spent}, after the stop ${a.ammo.rivets}/${a.ammo.mines} ${b.ammo.rivets}/${b.ammo.mines}`,
  );
  const lastSnapAmmo = (sim.conns.get(a.id)!.msgs.filter((m) => m.t === "snap").pop() as Extract<ServerMsg, { t: "snap" }>).ammo;
  check("stop: the lobby's snapshots carry the restored ammo", lastSnapAmmo.join() === "30,2", lastSnapAmmo.join());
  // "Start anyway" at once: Bo is not ready.
  const force = sim.room.forceStartAt;
  const plain = sim.room.start(a, sim.now);
  const forced = sim.room.start(a, sim.now, true);
  check(
    "stop: Start anyway is available at once afterwards (forceStartAt <= now)",
    force <= sim.now && plain === "Waiting for 1 player to get ready" && forced === null && sim.room.phase === "countdown",
    `forceStartAt ${force - sim.now} ms from now; ${plain}; forced: ${forced}`,
  );
  check("stop: the aborted race does not change the grid order (the last finished race's)", sim.room.gridOrder().map((p) => p.name).join(",") === grid0, grid0);
  // Stop in the countdown.
  const ec = sim.room.stopRace(a, sim.now);
  check("stop: in the countdown too", ec === null && sim.room.phase === "lobby" && !a.car && sim.room.raceStart === 0, `${ec}`);

  // A player who joined during the aborted race still gets their shop time.
  sim.readyAll(a);
  sim.room.start(a, sim.now);
  while (sim.room.phase !== "racing") sim.run(1);
  sim.run(60);
  const late = sim.add("Late");
  const joinedAt = sim.now;
  sim.run(60);
  sim.room.stopRace(a, sim.now);
  check(
    "stop: a player who joined during the aborted race still gets FORCE_START_MS to shop",
    sim.room.forceStartAt === joinedAt + FORCE_START_MS && !late.car,
    `forceStartAt ${sim.room.forceStartAt - joinedAt} ms after the join`,
  );
}

function menuRestart(): void {
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  const c = sim.add("Cy");
  a.ammo.rivets = 20;
  a.ammo.mines = 1;
  c.ammo.rivets = 5;
  sim.startRace(a);
  const raceStart0 = sim.room.raceStart;
  const track0 = sim.room.trackId;
  sim.now = sim.room.raceStart + WEAPONS_ARM_MS;
  sim.run(120, (p) => (p === a ? { throttle: 1, fire: true } : { throttle: 1 }));
  // Ann finishes (the grace timer runs), Cy drops (offline: keeps a stale car), Dee joins late.
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  const finishedBefore = a.finished && sim.room.phaseEnds > 0;
  sim.room.unbind(c, sim.now);
  const cStale = !!c.car;
  const d = sim.add("Dee");
  const spentA = `${a.ammo.rivets}/${a.ammo.mines}`;
  const scrap = a.wallet.scrap + b.wallet.scrap + c.wallet.scrap;
  sim.run(1, () => ({ throttle: 1, fire: true })); // a rivet in the air
  const e = sim.room.restartRace(a, sim.now);
  const order = sim.room.gridOrder();
  const onGrid = order.every((p, i) => {
    const g = gridSlot(sim.room.track, i);
    return p.car && Math.hypot(p.car.x - g.x, p.car.y - g.y) < 0.01 && p.car.vx === 0 && p.progress!.lap === 0 && !p.progress!.fin;
  });
  check(
    "restart: a fresh countdown on the same track (new raceStart, every connected player on the grid, ready not required, a late joiner too)",
    e === null &&
      sim.room.phase === "countdown" &&
      sim.room.raceStart === sim.now + COUNTDOWN_MS &&
      sim.room.raceStart > raceStart0 &&
      sim.room.trackId === track0 &&
      order.map((p) => p.name).sort().join() === "Ann,Bo,Dee" &&
      onGrid &&
      !b.ready && !d.ready && !!d.car,
    `${e}; ${sim.room.phase}; grid ${order.map((p) => p.name).join(",")}`,
  );
  check(
    "restart: the old race is cleared first (finish, the grace timer, shots, an offline racer's stale car), no scrap paid",
    finishedBefore && !a.finished && cStale && !c.car && !c.inRace && sim.room.combat.shotSnaps().length === 0 && a.wallet.scrap + b.wallet.scrap + c.wallet.scrap === scrap,
    `finished before ${finishedBefore}, offline car before ${cStale}`,
  );
  check(
    "restart: ammo given back, the offline player's too",
    spentA !== "20/1" && a.ammo.rivets === 20 && a.ammo.mines === 1 && c.ammo.rivets === 5,
    `Ann spent to ${spentA}, back to ${a.ammo.rivets}/${a.ammo.mines}; Cy ${c.ammo.rivets}`,
  );
  sim.rebind(c); // back during the new countdown: sits it out
  while (sim.room.phase !== "racing") sim.run(1);
  const x0 = a.car!.x;
  sim.run(60, () => ({ throttle: 1 }));
  check(
    "restart: the new race runs (no grace timer left, cars drive, the returning offline player sits it out)",
    sim.room.phase === "racing" && sim.room.phaseEnds === 0 && a.car!.x !== x0 && !c.car,
    `phaseEnds ${sim.room.phaseEnds}`,
  );
  // Restart in the countdown: the countdown starts over.
  sim.room.restartRace(a, sim.now);
  sim.run(30);
  const t1 = sim.now;
  const e2 = sim.room.restartRace(a, sim.now);
  check("restart: in the countdown, the countdown starts over", e2 === null && (sim.room.phase as string) === "countdown" && sim.room.raceStart === t1 + COUNTDOWN_MS, `${e2}`);
}

function menuKick(): void {
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [a, b, c] = R.p;
  const sb = R.s[1];
  const bToken = b.token;
  const lines0 = R.room.chatLines.length;
  R.send(0, { t: "kick", id: b.id });
  const last = sb.conn.msgs[sb.conn.msgs.length - 1];
  check(
    "kick: removed at once; the socket is detached, then told kicked, then closed",
    !R.room.players.has(b.id) &&
      sb.room === null && sb.player === null &&
      last?.t === "err" && last.code === "kicked" && last.msg === "You were removed by the host" &&
      sb.conn.closed &&
      lastRoomMsg(R.s[0].conn)!.players.map((p) => p.name).join() === "Ann,Cy",
    `last message ${JSON.stringify(last)}, closed ${sb.conn.closed}`,
  );
  check(
    "kick: one chat line 'Bo was removed', no 'left the room'",
    linesSince(R.room, lines0).join("|") === "removed:Bo was removed",
    linesSince(R.room, lines0).join("|"),
  );
  const lines1 = R.room.chatLines.length;
  R.send(1, { t: "chat", text: "still here?" });
  R.send(1, { t: "ready", ready: true });
  check("kick: the kicked socket cannot chat afterwards", R.room.chatLines.length === lines1, linesSince(R.room, lines1).join("|"));
  const again = R.join("Bo", bToken);
  const againErr = errMsgs(again.conn).pop();
  check(
    "kick: a rejoin with the kicked token is refused (err code kicked), the player is not added",
    againErr?.code === "kicked" && againErr.msg === "You were removed from this room" && !again.room && R.room.players.size === 2,
    JSON.stringify(againErr),
  );
  const fresh = R.join("Bo");
  check(
    "kick: a join without a token is a new player (best effort, documented in PLAN-MENU.md; Lock keeps them out)",
    !!fresh.player && fresh.player.id !== b.id && R.room.players.size === 3,
    `${R.room.players.size} players`,
  );
  const e0 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "kick", id: a.id });
  R.send(0, { t: "kick", id: "nobody" });
  R.send(0, { t: "kick", id: 7 as unknown as string });
  check(
    "kick: the host cannot remove themself; an unknown or non-string id is refused",
    errsOf(R.s[0].conn).slice(e0).join("|") === "You cannot remove yourself|That player is not in the room|That player is not in the room" && R.room.players.has(a.id) && R.room.hostId === a.id,
    errsOf(R.s[0].conn).slice(e0).join("|"),
  );
  // An offline player (in the reconnect grace): removed at once, token blocked.
  R.rooms.onClose(R.s[2], R.clock.now);
  const cOffline = !c.session && R.room.players.has(c.id);
  const lines2 = R.room.chatLines.length;
  R.send(0, { t: "kick", id: c.id });
  const cBack = R.join("Cy", c.token);
  check(
    "kick: an offline player is removed at once (no grace), their token blocked, one removed line",
    cOffline && !R.room.players.has(c.id) && errMsgs(cBack.conn).pop()?.code === "kicked" && linesSince(R.room, lines2).join("|") === "removed:Cy was removed",
    linesSince(R.room, lines2).join("|"),
  );

  // In a race: the car goes, the race goes on.
  const sim = new Sim(1);
  const x = sim.add("Ann");
  const y = sim.add("Bo");
  const z = sim.add("Cy");
  sim.startRace(x);
  sim.run(30, () => ({ throttle: 1 }));
  const ek = sim.room.kick(x, y.id, sim.now);
  sim.run(2, () => ({ throttle: 1 }));
  const snap = sim.conns.get(x.id)!.msgs.filter((m) => m.t === "snap").pop() as Extract<ServerMsg, { t: "snap" }>;
  check(
    "kick: in a race the car leaves the field and the race goes on",
    ek === null && sim.room.phase === "racing" && snap.ents.filter((e) => e.k === "car").length === 2 && !!z.car,
    `${ek}; ${sim.room.phase}; cars ${snap.ents.filter((e) => e.k === "car").length}`,
  );

  // The blocklist is capped (oldest forgotten first); the lines go through the comings budget.
  const C = menuRooms(["Host"]);
  const tokens: string[] = [];
  let removedAll = true;
  const lines3 = C.room.chatLines.length;
  for (let i = 0; i < BLOCKLIST_MAX + 6; i++) {
    const s = C.join(`P${i}`);
    const p = s.player!;
    tokens.push(p.token);
    C.send(0, { t: "kick", id: p.id });
    removedAll &&= !C.room.players.has(p.id) && s.conn.closed;
  }
  const removedLines = C.room.chatLines.slice(lines3).filter((l) => l.kind === "removed").length;
  const firstBack = C.join("P0", tokens[0]);
  const lastBack = C.join("Pn", tokens[tokens.length - 1]);
  check(
    `kick: the blocklist keeps the newest ${BLOCKLIST_MAX} tokens; every kick removes, but lines stop when the comings budget is spent`,
    removedAll && C.room.blockedCount === BLOCKLIST_MAX && !!firstBack.player && errMsgs(lastBack.conn).pop()?.code === "kicked" && removedLines < BLOCKLIST_MAX && removedLines > 0, // join lines share the budget
    `blocked ${C.room.blockedCount}, removed lines ${removedLines} of ${tokens.length} kicks`,
  );
}

function menuLock(): void {
  const R = menuRooms(["Ann", "Bo"]);
  const [, b] = R.p;
  R.send(0, { t: "lock", locked: true });
  const seen = lastRoomMsg(R.s[1].conn)?.locked;
  const nope = R.join("Dee");
  const nopeErr = errMsgs(nope.conn).pop();
  check(
    "lock: everyone's room message says locked; a new join is refused (err code locked) and not added",
    R.room.locked && seen === true && nopeErr?.code === "locked" && nopeErr.msg === "This room is locked" && !nope.room && R.room.players.size === 2,
    JSON.stringify(nopeErr),
  );
  R.rooms.onClose(R.s[1], R.clock.now);
  const back = R.join("Bo", b.token);
  check("lock: a seat rejoin with its token still works", back.player === b && !!b.session && R.room.players.size === 2, `${back.player?.name}`);
  const e0 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "lock", locked: "yes" as unknown as boolean });
  check("lock: a non-boolean is refused", errsOf(R.s[0].conn).slice(e0).join() === "Bad lock request" && R.room.locked, errsOf(R.s[0].conn).slice(e0).join());
  // A blocked token in a locked room hears "kicked", not "locked".
  R.send(0, { t: "kick", id: b.id });
  const bAgain = R.join("Bo", b.token);
  check("lock: a removed player's token gets kicked, not locked", errMsgs(bAgain.conn).pop()?.code === "kicked");
  R.send(0, { t: "lock", locked: false });
  const now = R.join("Dee");
  check("lock: unlocked, new players join again", !R.room.locked && !!now.player && lastRoomMsg(R.s[0].conn)?.locked === false);
}

function menuHandover(): void {
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [a, b, c] = R.p;
  R.send(1, { t: "ready", ready: true });
  const wasReady = b.ready;
  const lines0 = R.room.chatLines.length;
  R.send(0, { t: "host", id: b.id });
  const rm = lastRoomMsg(R.s[2].conn)!;
  check(
    "host: handed over to a connected player: hostId for everyone, their stale ready cleared, one chat line",
    wasReady && R.room.hostId === b.id && rm.hostId === b.id && !b.ready && !a.ready && linesSince(R.room, lines0).join("|") === "host:Bo is now the host",
    linesSince(R.room, lines0).join("|"),
  );
  const e0 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "host", id: a.id });
  R.send(0, { t: "stop" });
  check(
    "host: the old host is a player now (host commands refused)",
    errsOf(R.s[0].conn).slice(e0).join("|") === "Only the host can hand over the host|Only the host can stop the race" && R.room.hostId === b.id,
    errsOf(R.s[0].conn).slice(e0).join("|"),
  );
  R.rooms.onClose(R.s[2], R.clock.now);
  const e1 = errsOf(R.s[1].conn).length;
  R.send(1, { t: "host", id: c.id });
  R.send(1, { t: "host", id: b.id });
  R.send(1, { t: "host", id: "nobody" });
  check(
    "host: refused for an offline player, yourself and an unknown id",
    errsOf(R.s[1].conn).slice(e1).join("|") === "Cy is offline|You are already the host|That player is not in the room" && R.room.hostId === b.id,
    errsOf(R.s[1].conn).slice(e1).join("|"),
  );
  // The new host starts and controls the race; handing over mid-race works.
  R.send(0, { t: "ready", ready: true });
  R.send(1, { t: "start" });
  while (R.room.phase !== "racing") R.step(1);
  R.send(1, { t: "host", id: a.id });
  R.send(0, { t: "stop" });
  check("host: the new host starts; handed back mid-race, that host can stop it", R.room.hostId === a.id && (R.room.phase as string) === "lobby", `${R.room.phase}`);
  // A host flipping it in a loop: the lines are budgeted, the handovers all happen.
  const R2 = menuRooms(["Ann", "Bo"]);
  const lines1 = R2.room.chatLines.length;
  for (let i = 0; i < 30; i++) R2.send(i % 2, { t: "host", id: R2.p[(i + 1) % 2].id });
  const hostLines = R2.room.chatLines.slice(lines1).filter((l) => l.kind === "host").length;
  check("host: handover lines go through the comings budget", R2.room.hostId === R2.p[0].id && hostLines < 30 && hostLines > 0, `${hostLines} lines for 30 handovers`);
}

function menuClient(): void {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock);
  const B = wiredGame(rooms, clock);
  const C = wiredGame(rooms, clock);
  const states = new Map<Game, string[]>();
  for (const W of [A, B, C]) {
    const list: string[] = [];
    states.set(W.game, list);
    W.game.on.connection = (st, r) => list.push(r ? `${st}:${r}` : st);
  }
  const flushAll = () => {
    for (const W of [A, B, C]) W.flush();
  };
  A.game.create("Ann");
  A.open();
  A.flush();
  const code = A.game.code;
  B.game.join(code, "Bo");
  B.open();
  flushAll();
  const room = rooms.rooms.get(code)!;
  const bToken = (B.game as unknown as { tokens: TokenStoreLike }).tokens.get(code);
  A.game.kick(B.game.you);
  flushAll();
  const bState = states.get(B.game)!;
  const intent = (B.game as unknown as { intent: unknown }).intent;
  check(
    "client: kicked -> connection lost 'kicked', no reconnect, the stored token kept",
    bState.join() === "connected,lost:kicked" && !B.game.connected && intent === null && (B.game as unknown as { tokens: TokenStoreLike }).tokens.get(code) === bToken && !!bToken,
    bState.join(),
  );
  check(
    "client: the menu screen says why (kicked, locked)",
    lostMessage("kicked", true) === "You were removed from the room by the host." && lostMessage("locked", false) === "That room is locked: the host is not letting new drivers in.",
  );
  // main.ts leaves on "lost"; typing the code again sends the kept token: refused again, no loop.
  B.game.leave();
  B.game.join(code, "Bo");
  B.open();
  flushAll();
  check("client: retyping the code with the kept token meets the block (lost 'kicked' again)", bState.join() === "connected,lost:kicked,lost:kicked" && !B.game.you && room.players.size === 1, bState.join());
  A.game.setLocked(true);
  flushAll();
  C.game.join(code, "Cy");
  C.open();
  flushAll();
  const cState = states.get(C.game)!;
  check("client: Game.locked follows the room; a join to a locked room -> lost 'locked', no reconnect", A.game.locked && cState.join() === "lost:locked" && !C.game.you, cState.join());
}

interface TokenStoreLike {
  get(code: string): string | null;
}

/**
 * A restart over the wired client: the room message with the new raceStart drops the
 * predicted car, the next snapshot seeds it on the grid, and reconciliation stays small (a
 * car predicted from its old pose would show the teleport as a 100s-of-units error).
 */
function menuRestartClient(): void {
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const H = wiredGame(rooms, clock);
    const G = wiredGame(rooms, clock);
    H.game.create("Host");
    H.open();
    H.flush();
    G.game.join(H.game.code, "Guest");
    G.open();
    G.flush();
    H.flush();
    G.game.setReady(true);
    G.flush();
    H.game.start();
    H.flush();
    G.flush();
    const room = rooms.rooms.get(H.game.code)!;
    const drive = (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.now += 1000 / 60;
        rooms.step(clock.now);
        for (const W of [H, G]) {
          W.flush();
          const on = W.game.raceOn();
          W.game.step(on ? { throttle: 1, steer: 0, fire: false, mine: false } : NO_CONTROLS, 1000 / 60);
        }
      }
    };
    while (room.phase !== "racing") drive(1);
    drive(150);
    const moved = H.game.car ? Math.hypot(H.game.car.x - gridSlot(room.track, 0).x, H.game.car.y - gridSlot(room.track, 0).y) : 0;
    const e0 = [H, G].map((W) => W.game.recErrors.length);
    const start0 = H.game.raceStart;
    H.game.restartRace();
    for (const W of [H, G]) W.flush();
    const dropped = [H, G].every((W) => W.game.car === null && W.game.pending.length === 0 && W.game.raceStart !== start0);
    drive(4);
    const order = room.gridOrder();
    const seeded = [H, G].every((W) => {
      const slot = gridSlot(room.track, order.findIndex((p) => p.id === W.game.you));
      return !!W.game.car && Math.hypot(W.game.car.x - slot.x, W.game.car.y - slot.y) < 1;
    });
    while (room.phase !== "racing") drive(1);
    drive(150);
    const errs = [H, G].flatMap((W, i) => W.game.recErrors.slice(e0[i]));
    const max = Math.max(0, ...errs);
    check(
      "restart client: the new raceStart drops the predicted car, the next snapshot seeds it on the grid, reconciliation stays small (max <= 50)",
      moved > 200 && dropped && seeded && errs.length > 200 && max <= 50 && room.phase === "racing",
      `drove ${moved.toFixed(0)} before; ${errs.length} samples after, max ${max.toFixed(2)}`,
    );
    // Stop: the lobby for both, the cars gone.
    H.game.stopRace();
    for (const W of [H, G]) W.flush();
    drive(4);
    check("stop client: both back in the lobby, no own car", [H, G].every((W) => W.game.phase === "lobby" && !W.game.car && W.game.raceStart === 0));
  } finally {
    performance.now = realNow;
  }
}

// ---- in-game menu: retire to garage (MENU-2, PLAN-MENU.md, 2026-11-18) ------------------

// This section's imports (hoisted like the ones at the top).
import { RESULTS_MS } from "../shared/protocol";
import { PLACE_PAYOUT, WRECK_BONUS } from "../shared/shop";
import { raceDistance } from "../server/race";

type SnapMsg = Extract<ServerMsg, { t: "snap" }>;
type RoomMsg = Extract<ServerMsg, { t: "room" }>;
const lastSnapOf = (c: FakeConn) => c.msgs.filter((m): m is SnapMsg => m.t === "snap").pop();
const snapCars = (m: SnapMsg | undefined) => (m?.ents ?? []).filter((e): e is CarSnap => e.k === "car").map((e) => e.id);
const infoOf = (m: RoomMsg | undefined, id: string) => m?.players.find((p) => p.id === id);
const resultsOf = (c: FakeConn) => c.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results");

function retireRules(): void {
  // Over onMessage (the socket path): racing only, a racer with a car, once.
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [, b] = R.p;
  const e0 = errsOf(R.s[1].conn).length;
  R.send(1, { t: "retire" }); // lobby
  R.send(1, { t: "ready", ready: true });
  R.send(2, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  R.send(1, { t: "retire" }); // countdown
  const notRacing = errsOf(R.s[1].conn).slice(e0);
  check(
    "retire: refused in the lobby and in the countdown (racing only), nothing changes",
    notRacing.join("|") === "You can only retire during a race|You can only retire during a race" && R.p.every((p) => !p.retired && !!p.car) && R.room.phase === "countdown",
    notRacing.join("|"),
  );
  while (R.room.phase !== "racing") R.step(1);
  const late = R.join("Dee"); // joined mid-race: no car in this race
  R.rooms.onMessage(late, { t: "retire" }, R.clock.now);
  check("retire: refused for a mid-race joiner (not in this race)", errsOf(late.conn).pop() === "You are not in this race" && !late.player!.retired, errsOf(late.conn).join("|"));
  const e1 = errsOf(R.s[1].conn).length;
  R.send(1, { t: "retire" });
  const ok = errsOf(R.s[1].conn).length === e1;
  R.send(1, { t: "retire" });
  const seen = [0, 2].map((i) => infoOf(lastRoomMsg(R.s[i].conn), b.id));
  check(
    "retire: accepted over the socket in a race; everyone's room message shows retired (still inRace); a second retire is refused",
    ok && b.retired && !b.car && !!b.progress && errsOf(R.s[1].conn).slice(e1).join("|") === "You already retired" &&
      seen.every((x) => x?.retired === true && x.inRace === true) && infoOf(lastRoomMsg(R.s[0].conn), R.p[0].id)?.retired === false,
    `errors ${errsOf(R.s[1].conn).slice(e1).join("|") || "-"}`,
  );

  // A finished car and the results phase: refused.
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const c = sim.add("Cy");
  sim.startRace(a);
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  const fin = sim.room.retire(a);
  nearFinish(sim, c);
  sim.run(15, (p) => (p === c ? { throttle: 1 } : {}));
  const res = sim.room.retire(c);
  check(
    "retire: refused for a car that already finished, and in the results",
    a.finished && fin === "You already finished" && !a.retired && sim.room.phase === "results" && res === "You can only retire during a race" && !c.retired,
    `${fin}; ${sim.room.phase}: ${res}`,
  );
}

function retireField(): void {
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  const c = sim.add("Cy");
  sim.startRace(a);
  sim.run(60, () => ({ throttle: 1 }));
  const rd0 = raceDistance(track, b.progress!);
  const e = sim.room.retire(b);
  const q0 = b.queue.length;
  sim.room.queueInputs(b, [[9999, 1, 0, 0]]);
  sim.run(2, () => ({ throttle: 1 }));
  const snap = lastSnapOf(sim.conns.get(a.id)!);
  const own = lastSnapOf(sim.conns.get(b.id)!);
  check(
    "retire: the car leaves the field at once (not solid, not stepped, not in anyone's snapshot, inputs ignored); the progress stays",
    e === null && b.retired && !b.car && !solid(b) && q0 === 0 && b.queue.length === 0 &&
      snapCars(snap).sort().join() === [a.id, c.id].sort().join() && !snapCars(own).includes(b.id) &&
      !!b.progress && raceDistance(track, b.progress) === rd0 && rd0 > 0,
    `cars in A's snapshot ${snapCars(snap).length}, B's ${snapCars(own).length}; rd ${rd0.toFixed(0)}`,
  );
  const xa = a.car!.x;
  sim.run(60, () => ({ throttle: 1 }));
  check("retire: the race goes on for the others", sim.room.phase === "racing" && a.car!.x !== xa && !!c.car && !b.car, sim.room.phase);
}

function retireRaceEnd(): void {
  // ---- the last racer still out there retires, someone has finished: results at once ----
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  sim.startRace(a);
  sim.now = sim.room.raceStart + WEAPONS_ARM_MS;
  sim.run(30, () => ({ throttle: 1 }));
  sim.room.combat.damage(a, a.hp, b.id, "rivet"); // Bo wrecks Ann: a wreck bonus for Bo
  const wrecked = (sim.room.combat.wrecksCaused.get(b.id) ?? 0) === 1;
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  const graceOn = a.finished && sim.room.phaseEnds > sim.now && sim.room.phase === "racing";
  const scrap = [a.wallet.scrap, b.wallet.scrap];
  const lines0 = sim.room.chatLines.length;
  sim.room.retire(b);
  const retiredAt = sim.now;
  sim.run(1);
  const rows = resultsOf(sim.conns.get(b.id)!).pop()?.rows ?? [];
  check(
    "retire: the last racer still out there retires with a finisher in -> results on the next tick (no 30 s wait)",
    wrecked && graceOn && sim.room.phase === "results" && sim.now - retiredAt < 50,
    `grace was on ${graceOn}; ${sim.room.phase} ${(sim.now - retiredAt).toFixed(0)} ms after the retire`,
  );
  check(
    "retire: the retired player keeps a DNF row and the wreck bonus (place money only for finishers)",
    rows.map((r) => `${r.name}:${r.timeMs > 0 ? "T" : "DNF"}:${r.earned}`).join() === `Ann:T:${PLACE_PAYOUT[0]},Bo:DNF:${WRECK_BONUS}` &&
      a.wallet.scrap === scrap[0] + PLACE_PAYOUT[0] && b.wallet.scrap === scrap[1] + WRECK_BONUS &&
      sim.lastGarage(b)?.scrap === b.wallet.scrap,
    rows.map((r) => `${r.name} ${r.timeMs} +${r.earned}`).join(", "),
  );
  check("retire: one result line, finishers only", linesSince(sim.room, lines0).join("|") === "result: Race won by Ann", linesSince(sim.room, lines0).join("|"));
  // Results -> lobby: the flag is gone; the next race Bo races again.
  sim.now += RESULTS_MS;
  sim.run(1);
  const lobbyInfo = infoOf(sim.lastRoom(a), b.id);
  sim.startRace(a);
  check(
    "retire: the flag resets on the way to the lobby; the retired player races again next race",
    lobbyInfo?.retired === false && !b.retired && !!b.car && b.inRace && snapCars(lastSnapOf(sim.conns.get(a.id)!)).includes(b.id),
    `lobby info retired=${lobbyInfo?.retired}; car ${!!b.car}`,
  );

  // ---- everyone retires, nobody finished: back to the lobby, no results ----
  const s2 = new Sim(1);
  const x = s2.add("Ann");
  const y = s2.add("Bo");
  s2.startRace(x);
  s2.run(30, () => ({ throttle: 1 }));
  s2.room.combat.wrecksCaused.set(y.id, 1);
  const scrap2 = [x.wallet.scrap, y.wallet.scrap];
  const lines2 = s2.room.chatLines.length;
  s2.room.retire(x);
  s2.run(30, () => ({ throttle: 1 }));
  const stillOn = s2.room.phase === "racing" && !!y.car;
  s2.room.retire(y);
  s2.run(1);
  check(
    "retire: one of two retires -> the race goes on; the last one retires with no finisher -> lobby, no results message, no result line, no scrap",
    stillOn && s2.room.phase === "lobby" && resultsOf(s2.conns.get(x.id)!).length === 0 && s2.room.chatLines.length === lines2 &&
      x.wallet.scrap === scrap2[0] && y.wallet.scrap === scrap2[1] && !x.retired && !y.retired && infoOf(s2.lastRoom(x), y.id)?.retired === false,
    `${s2.room.phase}, results ${resultsOf(s2.conns.get(x.id)!).length}, lines +${s2.room.chatLines.length - lines2}`,
  );

  // ---- DNF order: a retired player ranks among the non-finishers by the distance driven when
  // they retired, like any other DNF (user decision 2026-11-18); finishers first ----
  const s3 = new Sim(1);
  const f = s3.add("Fin");
  const r = s3.add("RetAhead");
  const slow = s3.add("Slow");
  const early = s3.add("RetEarly");
  s3.startRace(f);
  s3.run(30, () => ({ throttle: 1 }));
  s3.room.retire(early); // a short way off the grid
  const rdEarly = raceDistance(track, early.progress!);
  s3.run(60, () => ({ throttle: 1 }));
  s3.place(r, L * 0.6); // far ahead of Slow
  r.progress!.cp = 2;
  s3.run(2);
  const rdAhead = raceDistance(track, r.progress!);
  s3.room.retire(r);
  s3.run(30, (p) => (p === slow ? { throttle: 1 } : {}));
  const rdSlow = raceDistance(track, slow.progress!);
  nearFinish(s3, f);
  s3.run(15, (p) => (p === f ? { throttle: 1 } : {}));
  s3.now = s3.room.phaseEnds; // the finish grace runs out
  s3.run(1);
  const rows3 = resultsOf(s3.conns.get(f.id)!).pop()?.rows ?? [];
  const grid3 = s3.room.gridOrder().map((p) => p.name).join(",");
  check(
    "retire: in the results a retired player ranks among the non-finishers by the distance driven when they retired (finishers first, place money only to finishers)",
    rdAhead > rdSlow && rdSlow > rdEarly && early.progress !== null &&
      rows3.map((x3) => `${x3.name}:${x3.timeMs > 0 ? "T" : "DNF"}:${x3.earned}`).join() === `Fin:T:${PLACE_PAYOUT[0]},RetAhead:DNF:0,Slow:DNF:0,RetEarly:DNF:0`,
    `${rows3.map((x3) => x3.name).join(", ")}; rd ahead ${rdAhead.toFixed(0)}, slow ${rdSlow.toFixed(0)}, early ${rdEarly.toFixed(0)}`,
  );
  check(
    "retire: retiring from ahead does not buy the front of the next (reversed) grid",
    grid3 === "RetEarly,Slow,RetAhead,Fin",
    grid3,
  );
}

function retireGarage(): void {
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  const c = sim.add("Cy");
  b.wallet.scrap = 1000;
  b.ammo.rivets = 10;
  b.ammo.mines = 0;
  c.wallet.scrap = 1000;
  sim.startRace(a);
  sim.now = sim.room.raceStart + WEAPONS_ARM_MS;
  sim.run(60, (p) => (p === b ? { throttle: 1, fire: true } : { throttle: 1 }));
  const used = b.ammo.rivets;
  const racerBuy = sim.room.buy(c, "rivets");
  const early = sim.room.buy(b, "rivets"); // not retired yet
  sim.room.retire(b);
  const g0 = sim.conns.get(b.id)!.msgs.filter((m) => m.t === "garage").length;
  const r1 = sim.room.buy(b, "rivets");
  const r2 = sim.room.buy(b, "mines");
  const r3 = sim.room.buy(b, "nonsense");
  const garages = sim.conns.get(b.id)!.msgs.filter((m) => m.t === "garage").length - g0;
  sim.run(2);
  const snapAmmo = lastSnapOf(sim.conns.get(b.id)!)?.ammo.join();
  check(
    "retire: buy is open for the retired, carless player during the race (refused for racers); garage message and snapshot ammo follow",
    used < 10 && racerBuy === "The garage is closed during a race" && early === racerBuy && c.wallet.scrap === 1000 &&
      r1 === null && r2 === null && r3 === "Unknown item" && garages === 2 &&
      b.wallet.scrap === 1000 - 150 - 200 && b.ammo.rivets === used + 20 && b.ammo.mines === 3 && sim.lastGarage(b)?.scrap === 650 &&
      snapAmmo === `${used + 20},3`,
    `used to ${used}; ${racerBuy}; ${r1}/${r2}/${r3}; scrap ${b.wallet.scrap}, ammo ${b.ammo.rivets}/${b.ammo.mines}, snap ${snapAmmo}`,
  );
  // A stop gives back what the race used, and keeps what the retired player bought.
  sim.room.stopRace(a, sim.now);
  check(
    "retire then stop: lobby, the flag reset; the retired player's ammo = start + bought (the purchase is not undone), the scrap stays spent",
    sim.room.phase === "lobby" && !b.retired && infoOf(sim.lastRoom(a), b.id)?.retired === false &&
      b.ammo.rivets === 10 + 20 && b.ammo.mines === 3 && b.wallet.scrap === 650,
    `ammo ${b.ammo.rivets}/${b.ammo.mines}, scrap ${b.wallet.scrap}`,
  );
  const lobbyBuy = sim.room.buy(b, "rivets");
  check("retire: the lobby garage works as before afterwards", lobbyBuy === null && b.ammo.rivets === 50, `${lobbyBuy}`);

  // Restart: an upgrade bought while retired fits the restarted race; the player races again.
  const s2 = new Sim(1);
  const x = s2.add("Ann");
  const y = s2.add("Bo");
  y.wallet.scrap = 1000;
  s2.startRace(x);
  s2.run(30, () => ({ throttle: 1 }));
  s2.room.retire(y);
  const up = s2.room.buy(y, "engine");
  const capped = s2.room.buy(y, "mines");
  s2.room.restartRace(x, s2.now);
  check(
    "retire then restart: a fresh countdown with the retired player back on the grid (flag reset), upgrades bought while retired fitted, ammo bought kept",
    up === null && capped === null && s2.room.phase === "countdown" && !y.retired && !!y.car && y.inRace &&
      y.levels.engine === 1 && y.stats.accel > BASE_STATS.accel && y.ammo.mines === 3 && infoOf(s2.lastRoom(x), y.id)?.retired === false,
    `${s2.room.phase}, car ${!!y.car}, engine ${y.levels.engine}, mines ${y.ammo.mines}`,
  );
  while (s2.room.phase !== "racing") s2.run(1);
  s2.run(30, () => ({ throttle: 1 }));
  check("retire then restart: buying is closed again for the racer", s2.room.buy(y, "rivets") === "The garage is closed during a race");
}

/**
 * A stop or a restart never costs scrap: the ammo packs a retired player bought are replayed on
 * the start-of-race ammo as if bought in the lobby; a pack the cap leaves no room for there gets
 * its scrap back (reviewer example: 3 mines, drop 1, retire, buy a pack for 200, restart).
 */
function retireRefund(): void {
  const setup = (mines: number, rivets = 0) => {
    const sim = new Sim(1);
    const a = sim.add("Ann");
    const b = sim.add("Bo");
    b.wallet.scrap = 1000;
    b.ammo.mines = mines;
    b.ammo.rivets = rivets;
    sim.startRace(a);
    sim.now = sim.room.raceStart + WEAPONS_ARM_MS;
    sim.run(1, (p) => (p === b ? { throttle: 1, mine: true } : { throttle: 1 }));
    sim.run(20, () => ({ throttle: 1 }));
    return { sim, a, b };
  };

  // The example: 3 mines (the cap), drop 1, retire, buy a pack for 200, the host restarts.
  const { sim, a, b } = setup(3);
  const dropped = b.ammo.mines === 2;
  sim.room.retire(b);
  const e = sim.room.buy(b, "mines");
  const paid = 1000 - b.wallet.scrap;
  const g0 = sim.conns.get(b.id)!.msgs.filter((m) => m.t === "garage").length;
  sim.room.restartRace(a, sim.now);
  const garage = sim.lastGarage(b);
  check(
    "retire refund: 3 mines, drop 1, retire, buy a pack for 200, host restarts -> 3 mines and the 200 back (no loss, no duplicate)",
    dropped && e === null && paid === AMMO.mines.price && b.ammo.mines === 3 && b.wallet.scrap === 1000 &&
      sim.conns.get(b.id)!.msgs.filter((m) => m.t === "garage").length > g0 && garage?.scrap === 1000 && sim.room.phase === "countdown",
    `dropped to 2 ${dropped}, paid ${paid}; after the restart ${b.ammo.mines} mines, scrap ${b.wallet.scrap}, garage says ${garage?.scrap}`,
  );

  // The same with a stop.
  const t = setup(3);
  t.sim.room.retire(t.b);
  t.sim.room.buy(t.b, "mines");
  t.sim.room.stopRace(t.a, t.sim.now);
  check("retire refund: the same with a stop -> 3 mines, scrap unchanged", t.sim.room.phase === "lobby" && t.b.ammo.mines === 3 && t.b.wallet.scrap === 1000, `${t.b.ammo.mines} mines, scrap ${t.b.wallet.scrap}`);

  // Room under the cap: the purchase stands, as it would in the lobby (1 mine + a pack = 3, 200 paid).
  const u = setup(1);
  const uDropped = u.b.ammo.mines === 0;
  u.sim.room.retire(u.b);
  u.sim.room.buy(u.b, "mines");
  u.sim.room.restartRace(u.a, u.sim.now);
  check(
    "retire refund: with room under the cap the purchase stands as in the lobby (1 mine, drop it, buy a pack, restart -> 3 mines, 200 paid)",
    uDropped && u.b.ammo.mines === 3 && u.b.wallet.scrap === 1000 - AMMO.mines.price,
    `${u.b.ammo.mines} mines, scrap ${u.b.wallet.scrap}`,
  );

  // Several packs: as many fit as in the lobby, the rest refunded (90 rivets: one pack fits).
  const v = setup(0, 90);
  v.b.ammo.rivets = 30; // as if 60 were fired: three packs fit now (30 -> 90)
  v.sim.room.retire(v.b);
  const buys = [0, 1, 2].map(() => v.sim.room.buy(v.b, "rivets"));
  const spent = 1000 - v.b.wallet.scrap;
  v.sim.room.stopRace(v.a, v.sim.now);
  check(
    "retire refund: three rivet packs bought (30 -> 90) from a start of 90 -> after a stop 100 rivets, one pack paid (as in the lobby), two refunded",
    buys.every((x) => x === null) && spent === 3 * AMMO.rivets.price && v.b.ammo.rivets === 100 && v.b.wallet.scrap === 1000 - AMMO.rivets.price,
    `spent ${spent}; after the stop ${v.b.ammo.rivets} rivets, scrap ${v.b.wallet.scrap}`,
  );
}

function retireOthers(): void {
  // Kick: a retired player can be removed; the host may retire too and still run the room.
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  const c = sim.add("Cy");
  sim.startRace(a);
  sim.run(30, () => ({ throttle: 1 }));
  sim.room.retire(b);
  const kb = sim.room.kick(a, b.id, sim.now);
  sim.run(2, () => ({ throttle: 1 }));
  const afterKick = sim.room.phase === "racing" && !sim.room.players.has(b.id);
  const ra = sim.room.retire(a); // the host retires
  sim.run(2, () => ({ throttle: 1 }));
  const hostOn = sim.room.phase === "racing" && a.retired && sim.room.hostId === a.id;
  const kc = sim.room.kick(a, c.id, sim.now); // ... and removes the last racer
  sim.run(1);
  check(
    "retire then kick: a retired player is removed as any other; a retired host still runs the room; kicking the last racer -> lobby, no results",
    kb === null && afterKick && ra === null && hostOn && kc === null && sim.room.phase === "lobby" && resultsOf(sim.conns.get(a.id)!).length === 0 && !a.retired,
    `${kb}/${ra}/${kc}; ${sim.room.phase}`,
  );

  // A retired player who drops and rejoins stays retired (no car), and can still shop.
  const s2 = new Sim(1);
  const x = s2.add("Ann");
  const y = s2.add("Bo");
  s2.startRace(x);
  s2.run(30, () => ({ throttle: 1 }));
  s2.room.retire(y);
  s2.room.unbind(y, s2.now);
  s2.run(30, () => ({ throttle: 1 }));
  s2.rebind(y);
  s2.run(2, () => ({ throttle: 1 }));
  check(
    "retire: a retired player who reconnects mid-race is still retired (no car, garage open)",
    y.retired && !y.car && infoOf(s2.lastRoom(y), y.id)?.retired === true && !snapCars(lastSnapOf(s2.conns.get(y.id)!)).includes(y.id) && s2.room.buy(y, "rivets") === null && s2.room.phase === "racing",
    `${s2.room.phase}`,
  );
}

/**
 * "X retired" notices (Game.on.retired -> the toast) only for a retirement seen live: a client
 * joining mid-race or rejoining (a reload) gets none for players already retired.
 */
function retireNotices(): void {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const H = wiredGame(rooms, clock);
  const G = wiredGame(rooms, clock);
  const K = wiredGame(rooms, clock);
  const heard = new Map<Game, string[]>();
  const listen = (g: Game) => {
    const list: string[] = [];
    heard.set(g, list);
    g.on.retired = (p) => list.push(p.name);
  };
  for (const W of [H, G, K]) listen(W.game);
  H.game.create("Host");
  H.open();
  H.flush();
  const code = H.game.code;
  for (const [W, n] of [[G, "Guest"], [K, "Kay"]] as const) {
    W.game.join(code, n);
    W.open();
  }
  const all: { game: Game; flush(): void }[] = [H, G, K];
  const flush = () => {
    for (const W of all) W.flush();
  };
  flush();
  G.game.setReady(true);
  K.game.setReady(true);
  flush();
  H.game.start();
  flush();
  const room = rooms.rooms.get(code)!;
  const step = (n: number) => {
    for (let i = 0; i < n; i++) {
      rooms.step((clock.now += 1000 / 60));
      flush();
    }
  };
  while (room.phase !== "racing") step(1);
  step(10);
  G.game.retire();
  flush();
  step(2);
  const live = [heard.get(H.game)!.join(), heard.get(K.game)!.join(), heard.get(G.game)!.join()];
  // A newcomer mid-race, and the host "reloading" (a new client with the seat token).
  const C = wiredGame(rooms, clock);
  listen(C.game);
  C.game.join(code, "Cee");
  C.open();
  all.push(C);
  const H2 = wiredGame(rooms, clock);
  listen(H2.game);
  (H2.game as unknown as { tokens: { set(c: string, t: string): void } }).tokens.set(code, (H.game as unknown as { tokens: TokenStoreLike }).tokens.get(code)!);
  H2.game.join(code, "Host");
  H2.open();
  all.push(H2);
  flush();
  step(2);
  const quiet = heard.get(C.game)!.length === 0 && heard.get(H2.game)!.length === 0 && H2.game.you === H.game.you && C.game.player(G.game.you)?.retired === true;
  K.game.retire();
  flush();
  step(2);
  check(
    "retire notices: a retirement seen live is announced once (not to the retiree); none for players already retired when a client joins or rejoins mid-race; the next live one reaches them",
    live.join("|") === "Guest|Guest|" && quiet && heard.get(C.game)!.join() === "Kay" && heard.get(H2.game)!.join() === "Kay" && heard.get(G.game)!.join() === "Kay" && room.phase === "racing",
    `live ${live.join("|")}; after join/rejoin C ${heard.get(C.game)!.join() || "-"}, H2 ${heard.get(H2.game)!.join() || "-"}`,
  );
}

/**
 * The wired client: Game.retire() -> the room message drops the predicted car at once and no
 * snapshot brings it back (the engine and the gravel sounds key off it: hasCar false = silent),
 * the garage works, the results show us as DNF, and the next lobby clears the flag.
 */
function retireClient(): void {
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const H = wiredGame(rooms, clock);
    const G = wiredGame(rooms, clock);
    H.game.create("Host");
    H.open();
    H.flush();
    G.game.join(H.game.code, "Guest");
    G.open();
    G.flush();
    H.flush();
    G.game.setReady(true);
    G.flush();
    H.game.start();
    H.flush();
    G.flush();
    const room = rooms.rooms.get(H.game.code)!;
    const drive = (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.now += 1000 / 60;
        rooms.step(clock.now);
        for (const W of [H, G]) {
          W.flush();
          W.game.step(W.game.raceOn() ? { throttle: 1, steer: 0, fire: false, mine: false } : NO_CONTROLS, 1000 / 60);
        }
      }
    };
    while (room.phase !== "racing") drive(1);
    drive(60);
    const before = G.game.canRetire() && !!G.game.car && !G.game.retired();
    G.game.retire();
    G.flush();
    const dropped = G.game.car === null && G.game.retired() && !G.game.canRetire();
    let carBack = false;
    for (let i = 0; i < 60; i++) {
      drive(1);
      carBack ||= G.game.car !== null || !!G.game.ownSnap();
    }
    const st: EngineState = { phase: G.game.phase, hasCar: !!G.game.car, connected: G.game.connected, wreck: 0, fall: 0, air: 0, finished: false, speed: 300, topSpeed: 430, throttle: 1 };
    check(
      "retire client: the room message drops our car at once and no later snapshot brings it back; engine and gravel targets are silent (no car)",
      before && dropped && !carBack && G.game.phase === "racing" && !engineTarget(st).on && !gravelTarget(st, true).on && H.game.player(G.game.you)?.retired === true,
      `before ${before}, dropped ${dropped}, car back ${carBack}`,
    );
    const scrap0 = G.game.scrap;
    G.game.buy("rivets");
    G.flush();
    drive(3);
    check("retire client: the garage buy goes through during the race", G.game.scrap === scrap0 - 150 && G.game.serverAmmo[0] === 20, `scrap ${scrap0} -> ${G.game.scrap}, ammo ${G.game.serverAmmo.join("/")}`);
    // Host finishes (put just before the line on the server): results, Guest DNF.
    const hp = room.players.get(H.game.you)!;
    const pt = pointAt(room.track, room.track.length - 40);
    hp.car = { x: pt.x, y: pt.y, h: pt.h, vx: Math.cos(pt.h) * 300, vy: Math.sin(pt.h) * 300, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    hp.progress = { s: queryTrackNear(room.track, pt.x, pt.y, pt.seg).s, cp: 3, lap: 0, fin: 0 };
    for (let i = 0; i < 30 && room.phase === "racing"; i++) drive(1);
    const rows = G.game.results ?? [];
    check(
      "retire client: the host finishing ends the race at once; the results show the retired player as DNF",
      (room.phase as string) === "results" && G.game.phase === "results" && rows.length === 2 && rows[0].id === H.game.you && rows[1].id === G.game.you && rows[1].timeMs === 0,
      rows.map((r) => `${r.name} ${r.timeMs}`).join(", "),
    );
    clock.now += RESULTS_MS;
    drive(2);
    check("retire client: the next lobby clears the flag (Game.retired() false)", G.game.phase === "lobby" && !G.game.retired() && H.game.player(G.game.you)?.retired === false);
  } finally {
    performance.now = realNow;
  }
}

// ---- lobby Music switch (SND-3, client/audio.ts; a real musicOn flag since SND-4) ---------

// This section's imports (hoisted like the ones at the top).
import { effectiveSound, LEGACY_DEFAULTS, musicHeard, musicIsOn, musicSlid, musicSwitched, PatchThrottle, roomMusicSlid, SliderGrip, storedSoundJson } from "../client/soundlogic";
import { resetLabel, roomTag } from "../client/audio";

/** A fake localStorage for the AudioEngine (no AudioContext: the buses come with the unlock). */
function withStore(run: (store: Map<string, string>) => void): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)) };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  try {
    run(store);
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete g.localStorage;
  }
}

const SOUND_KEY = "scrap-rally:sound";

/**
 * The Music switch: off is musicOn false (the volume stays, so on brings it back), on is
 * musicOn true (the default volume if the volume is 0). Every Music slider shows the heard
 * volume (0 while off); moving one above 0 turns the music on, dragging it to 0 is the switch's
 * off with the volume from before the drag. The master mute (M) is separate. Persisted as own
 * keys (SND-4).
 */
function musicSwitch(): void {
  const off = musicSwitched({ musicOn: true, music: 0.7 });
  const on = musicSwitched({ musicOn: false, music: 0.7 });
  check("music switch: off sets only musicOn false (the volume 0.7 stays); on sets musicOn true", JSON.stringify(off) === '{"musicOn":false}' && JSON.stringify(on) === '{"musicOn":true}', JSON.stringify({ off, on }));
  const fresh = musicSwitched({ musicOn: true, music: 0 });
  check("music switch: on with a volume of 0 (a host's or the sound board's 0) also gives the default volume", fresh.musicOn === true && fresh.music === DEFAULT_SOUND.music && DEFAULT_SOUND.music > 0, JSON.stringify(fresh));
  check(
    "music switch: on/off reads the heard music (musicOn and a volume above 0); the sliders show the heard volume",
    !musicIsOn({ musicOn: false, music: 0.7 }) && !musicIsOn({ musicOn: true, music: 0 }) && musicIsOn({ musicOn: true, music: 0.05 }) &&
      musicHeard({ musicOn: false, music: 0.7 }) === 0 && musicHeard({ musicOn: true, music: 0.4 }) === 0.4,
  );
  const up = musicSlid(0.3, { musicOn: false }, undefined);
  const move = musicSlid(0.3, { musicOn: true }, undefined);
  const down = musicSlid(0, { musicOn: true }, 0.6);
  const downFollow = musicSlid(0, { musicOn: true }, undefined);
  check(
    "music switch: a slider moved above 0 while off turns the music on (SND-3's rule); while on it sets only the volume; dragged to 0 it is off with the volume from before the drag",
    JSON.stringify(up) === '{"musicOn":true,"music":0.3}' && JSON.stringify(move) === '{"music":0.3}' && down.musicOn === false && down.music === 0.6 && downFollow.musicOn === false && downFollow.music === undefined,
    JSON.stringify({ up, move, down, downFollow }),
  );

  withStore((store) => {
    const a = new AudioEngine();
    a.set({ music: 0.6, effects: 0.3 });
    a.toggleMute();
    let changes = 0;
    a.onChange(() => changes++);
    a.toggleMusic();
    const afterOff = { ...a.settings, heard: musicHeard(a.settings) };
    const b = new AudioEngine(); // a reload
    const reloaded = { ...b.settings };
    b.toggleMusic();
    check(
      "music switch: off keeps effects 0.3, the volume 0.6 and the master mute; the switch notifies the controls; off survives a reload; on after the reload brings 0.6 back",
      !afterOff.musicOn && afterOff.heard === 0 && afterOff.music === 0.6 && afterOff.effects === 0.3 && afterOff.muted && changes === 1 &&
        !reloaded.musicOn && reloaded.music === 0.6 && reloaded.effects === 0.3 && reloaded.muted &&
        b.settings.musicOn && musicHeard(b.settings) === 0.6 && b.settings.effects === 0.3 && b.settings.muted,
      `${JSON.stringify(afterOff)} -> reload ${JSON.stringify(reloaded)} -> on ${JSON.stringify(b.settings)}; stored ${store.get(SOUND_KEY)}`,
    );
    // A Music slider dragged down to 0 (one gesture) is off; the switch brings back the volume from before the drag.
    for (const v of [0.45, 0.2, 0.05, 0]) b.slideMusic(v);
    b.slideEnd();
    const viaSlider = musicHeard(b.settings);
    const offViaSlider = !musicIsOn(b.settings);
    b.toggleMusic();
    const back = musicHeard(b.settings);
    // A slider moved above 0 while off turns the music on at that volume.
    b.toggleMusic();
    b.slideMusic(0.25);
    b.slideEnd();
    check(
      "music switch: a slider dragged to 0 reads as off and the switch brings back the volume from before the drag (0.6); a slider moved above 0 while off turns it on at that volume",
      viaSlider === 0 && offViaSlider && back === 0.6 && b.settings.musicOn && musicHeard(b.settings) === 0.25,
      `${viaSlider} -> ${back}; then ${JSON.stringify(b.settings)}`,
    );
    store.set(SOUND_KEY, '{"music":0.4,"effects":0.8,"muted":false,"engine":"v8"}'); // saved before SND-3
    const old = new AudioEngine();
    check(
      "music switch: settings saved before the switch load unchanged (the moved music 0.4 own, the default effects not)",
      old.settings.musicOn && old.settings.music === 0.4 && old.settings.engine === "v8" && JSON.stringify(old.own) === '{"music":0.4}',
      JSON.stringify({ ...old.settings, own: old.own }),
    );
  });
}

// ---- host-set room sound defaults (SND-4, PLAN-SOUND.md, 2026-11-18) --------------------

// This section's imports (hoisted like the ones at the top).
import { BUILTIN_SOUND, DEFAULT_SONG_ID as SHARED_DEFAULT_SONG, RANDOM_SONG, snapVolume, SONG_IDS, type RoomSound } from "../shared/sound";
import { SOUND_BURST, SOUND_PER_SEC } from "../shared/protocol";

/** Legacy entries (every key saved, SND-1..3) -> own only where the value differs from the built-in default. */
function soundMigration(): void {
  const m = (raw: unknown) => {
    const st = parseStoredSound(JSON.stringify(raw));
    return JSON.stringify({ own: st.own, muted: st.muted, engine: st.engine });
  };
  const rows: [string, unknown, string][] = [
    ["an M-only entry (everything default, muted)", { music: 0.5, effects: 0.8, muted: true, engine: "buggy" }, '{"own":{},"muted":true,"engine":"buggy"}'],
    ["default-equal values, another engine", { music: 0.5, effects: 0.8, muted: false, engine: "v8" }, '{"own":{},"muted":false,"engine":"v8"}'],
    ["moved volumes", { music: 0.35, effects: 0.6, muted: false, engine: "buggy" }, '{"own":{"music":0.35,"effects":0.6},"muted":false,"engine":"buggy"}'],
    ["SND-3 off with musicBack 0.7", { music: 0, musicBack: 0.7, effects: 0.8, muted: false, engine: "buggy" }, '{"own":{"musicOn":false,"music":0.7},"muted":false,"engine":"buggy"}'],
    ["SND-3 off with the default musicBack", { music: 0, musicBack: 0.5, effects: 0.8, muted: false, engine: "buggy" }, '{"own":{"musicOn":false},"muted":false,"engine":"buggy"}'],
    ["SND-3 off by the slider (no musicBack)", { music: 0, musicBack: 0, effects: 0.3, muted: true, engine: "four" }, '{"own":{"musicOn":false,"effects":0.3},"muted":true,"engine":"four"}'],
    ["SND-3 on with a stale musicBack", { music: 0.5, musicBack: 0.9, effects: 0.8, muted: false, engine: "buggy" }, '{"own":{},"muted":false,"engine":"buggy"}'],
    ["a legacy music 0.4 (moved: the old default was 0.5)", { music: 0.4, effects: 0.8, muted: false, engine: "buggy" }, '{"own":{"music":0.4},"muted":false,"engine":"buggy"}'],
    ["broken values", { music: "x", effects: null, muted: 1, engine: "jet" }, '{"own":{},"muted":false,"engine":"buggy"}'],
  ];
  const bad = rows.filter(([, raw, want]) => m(raw) !== want);
  check(
    "sound migration: a legacy value counts as own only if it differs from the built-in default; SND-3's music 0 is own musicOn false with musicBack as the volume (by the same rule); mute and engine kept",
    bad.length === 0,
    bad.map(([what, raw]) => `${what}: ${m(raw)}`).join("; ") || rows.map(([w]) => w).join(", "),
  );
  // The default music went from 0.5 to 0.4 (the user, 2026-11-18): a legacy entry saved with the old
  // default 0.5 filled in is untouched and now follows the new default 0.4 (or the host's).
  withStore((store) => {
    store.set(SOUND_KEY, '{"music":0.5,"effects":0.8,"muted":false,"engine":"buggy"}');
    const legacy = new AudioEngine();
    const outside = legacy.settings.music;
    legacy.setRoom({ musicOn: true, music: 0.7, effects: 0.8 });
    check(
      "sound migration: a legacy entry with the old default music 0.5 is untouched: it follows the new default 0.4 outside a room and the host's 0.7 in one (compared with LEGACY_DEFAULTS, not today's)",
      LEGACY_DEFAULTS.music === 0.5 && DEFAULT_SOUND.music === 0.4 && JSON.stringify(legacy.own) === "{}" && outside === 0.4 && legacy.settings.music === 0.7 && !legacy.hasOwn(),
      `own ${JSON.stringify(legacy.own)}, outside ${outside}, in a room ${legacy.settings.music}`,
    );
  });
  withStore((store) => {
    store.set(SOUND_KEY, '{"music":0,"musicBack":0.7,"effects":0.8,"muted":false,"engine":"v8"}');
    const a = new AudioEngine();
    a.toggleMute(); // any save writes the new entry
    const saved = JSON.parse(store.get(SOUND_KEY) ?? "{}") as Record<string, unknown>;
    check(
      "sound migration: the next save writes version 2 with only the own keys, the mute and the engine; musicBack is dropped",
      saved.v === 2 && JSON.stringify(saved.own) === '{"musicOn":false,"music":0.7}' && saved.muted === true && saved.engine === "v8" && !("musicBack" in saved) && !("effects" in saved),
      store.get(SOUND_KEY),
    );
    const again = new AudioEngine();
    check("sound migration: the version-2 entry reads back the same", JSON.stringify(again.own) === '{"musicOn":false,"music":0.7}' && again.settings.muted && again.settings.engine === "v8", JSON.stringify(again.own));
  });
  check(
    "sound migration: storedSoundJson writes only defined own keys",
    storedSoundJson({ own: { music: 0.3, musicOn: undefined }, muted: false, engine: "buggy" }) === '{"v":2,"own":{"music":0.3},"muted":false,"engine":"buggy"}',
  );
}

/** The engine's own + room layers (client/audio.ts AudioEngine, effectiveSound). */
function soundLayers(): void {
  check(
    "sound layers: shared/sound.ts lists client/music.ts's songs (ids and order, the same default); the built-in room defaults are the client's",
    SONG_IDS.join() === SONGS.map((x) => x.id).join() && SHARED_DEFAULT_SONG === DEFAULT_SONG_ID && BUILTIN_SOUND.song === DEFAULT_SONG_ID &&
      BUILTIN_SOUND.musicOn === DEFAULT_SOUND.musicOn && BUILTIN_SOUND.music === DEFAULT_SOUND.music && BUILTIN_SOUND.effects === DEFAULT_SOUND.effects &&
      BUILTIN_SOUND.musicOn && BUILTIN_SOUND.music === 0.4 && BUILTIN_SOUND.effects === 0.8 && BUILTIN_SOUND.song === "neon-tailpipe",
    `${SONG_IDS.join()} vs ${SONGS.map((x) => x.id).join()}`,
  );
  const room = { musicOn: false, music: 0.3, effects: 0.6 };
  check(
    "sound layers: effectiveSound takes each own key, else the room's, else (outside a room) the built-in default",
    JSON.stringify(effectiveSound({}, room)) === '{"musicOn":false,"music":0.3,"effects":0.6}' &&
      JSON.stringify(effectiveSound({ effects: 0.1 }, room)) === '{"musicOn":false,"music":0.3,"effects":0.1}' &&
      JSON.stringify(effectiveSound({ musicOn: true }, null)) === '{"musicOn":true,"music":0.4,"effects":0.8}' &&
      JSON.stringify(effectiveSound({}, null)) === '{"musicOn":true,"music":0.4,"effects":0.8}',
  );
  withStore((store) => {
    const a = new AudioEngine();
    let changes = 0;
    a.onChange(() => changes++);
    a.setRoom({ musicOn: true, music: 0.3, effects: 0.6 });
    a.setRoom({ musicOn: true, music: 0.3, effects: 0.6 }); // polled every frame: no change, no notice
    const follow = { ...a.settings };
    check(
      "sound layers: untouched settings follow the room at once; the same room again changes nothing; no save for a room change",
      follow.musicOn && follow.music === 0.3 && follow.effects === 0.6 && changes === 1 && !store.has(SOUND_KEY) && roomTag(a, "music") === "host's" && roomTag(a, "effects") === "host's" && resetLabel(a) === "",
      `${JSON.stringify(follow)}, ${changes} notices, stored ${store.get(SOUND_KEY)}`,
    );
    // An own value equal to the host's stays pinned when the host changes it.
    a.slideMusic(0.3);
    a.slideEnd();
    a.setRoom({ musicOn: true, music: 0.7, effects: 0.2 });
    check(
      "sound layers: an own value equal to the host's (music 0.3) stays when the host changes; the untouched effects follow (0.2); marks and the reset follow",
      a.settings.music === 0.3 && a.settings.effects === 0.2 && !a.follows("music") && a.follows("effects") && roomTag(a, "music") === "" && roomTag(a, "effects") === "host's" && resetLabel(a) === "Use host's sound",
      JSON.stringify({ ...a.settings, own: a.own }),
    );
    // The host turns the room's music off: a player who only moved the volume hears it off (and the mark says so).
    a.setRoom({ musicOn: false, music: 0.7, effects: 0.2 });
    check("sound layers: the host's music off silences a player who only moved the volume; the Music mark is the host's again", musicHeard(a.settings) === 0 && roomTag(a, "music") === "host's", JSON.stringify(a.settings));
    // Mute and the engine are never room keys.
    store.clear();
    const b = new AudioEngine();
    b.setRoom({ musicOn: true, music: 0.3, effects: 0.6 });
    b.toggleMute();
    b.setEngine("v8");
    const saved = JSON.parse(store.get(SOUND_KEY) ?? "{}") as { own?: object };
    check(
      "sound layers: mute and the engine preset do not make music or effects own (nothing to reset; the save holds no room key)",
      !b.hasOwn() && b.settings.muted && b.settings.engine === "v8" && b.settings.music === 0.3 && JSON.stringify(saved.own) === "{}" && resetLabel(b) === "",
      store.get(SOUND_KEY),
    );
    // Reset: the room keys follow the room again; mute and engine stay.
    b.set({ effects: 0.15 });
    b.toggleMusic();
    const before = { ...b.settings };
    b.useRoomSound();
    check(
      "sound layers: \"Use host's sound\" resets musicOn, music and effects to the room's and keeps the mute and the engine",
      !before.musicOn && before.effects === 0.15 && !b.hasOwn() && b.settings.musicOn && b.settings.music === 0.3 && b.settings.effects === 0.6 && b.settings.muted && b.settings.engine === "v8" && JSON.stringify((JSON.parse(store.get(SOUND_KEY)!) as { own: object }).own) === "{}",
      `${JSON.stringify(before)} -> ${JSON.stringify(b.settings)}`,
    );
    // A second room with other defaults: the untouched keys follow it; own keys stay (per setting and remembered).
    b.set({ effects: 0.4 });
    b.setRoom({ musicOn: true, music: 0.9, effects: 1 });
    const second = { ...b.settings };
    b.setRoom(null);
    const outside = { ...b.settings };
    check(
      "sound layers: in a second room with other defaults the untouched music follows it (0.9) and the own effects stay (0.4); outside a room the built-in defaults stand in (the mark and the reset are relabelled)",
      second.music === 0.9 && second.effects === 0.4 && outside.music === 0.4 && outside.musicOn && outside.effects === 0.4 && roomTag(b, "music") === "" && resetLabel(b) === "Default sound",
      `${JSON.stringify(second)} / ${JSON.stringify(outside)}`,
    );
    b.setRoom({ musicOn: true, music: 0.9, effects: 1 }, true);
    check("sound layers: on the host's own controls the mark reads room and the reset Use room sound", roomTag(b, "music") === "room" && resetLabel(b) === "Use room sound");
  });
  // The host's Room sound throttle: the first send at once, the rest merged into one trailing send.
  let now = 0;
  const sent: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const th = new PatchThrottle<{ music: number; effects: number }>((p) => sent.push(JSON.stringify(p)), 500, () => now, (fn, ms) => timers.push({ at: now + ms, fn }));
  th.push({ music: 0.1 });
  now = 100;
  th.push({ music: 0.2 });
  now = 200;
  th.push({ effects: 0.5 });
  th.push({ music: 0.3 });
  const early = sent.length;
  now = 500;
  for (const t of timers.splice(0)) if (t.at <= now) t.fn();
  now = 2000;
  th.push({ music: 0.4 });
  check(
    "room sound throttle: the first change goes at once; later ones within 500 ms go as one merged trailing send (the last value wins); after a quiet gap at once again",
    early === 1 && sent.join("|") === '{"music":0.1}|{"music":0.3,"effects":0.5}|{"music":0.4}',
    sent.join("|"),
  );
}

/** Room messages a connection received. */
function roomMsgs(c: FakeConn): Extract<ServerMsg, { t: "room" }>[] {
  return c.msgs.filter((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room");
}

function soundServer(): void {
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [, b] = R.p;
  const first = lastRoomMsg(R.s[2].conn)!;
  check(
    "room sound: a new room starts with the built-in defaults (music on 0.4, effects 0.8, Neon Tailpipe) in everyone's room message",
    JSON.stringify(first.soundDefaults) === '{"musicOn":true,"music":0.4,"effects":0.8,"song":"neon-tailpipe"}' && first.song === "neon-tailpipe" && JSON.stringify(R.room.soundDefaults) === JSON.stringify(BUILTIN_SOUND),
    JSON.stringify(first.soundDefaults),
  );
  // Host only.
  const e1 = errsOf(R.s[1].conn).length;
  R.send(1, { t: "soundDefaults", music: 0.2 });
  check("room sound: from anyone but the host it is refused with an err and nothing changes", errsOf(R.s[1].conn).slice(e1).join() === "Only the host can set the room sound" && R.room.soundDefaults.music === BUILTIN_SOUND.music, errsOf(R.s[1].conn).slice(e1).join());
  // A partial patch, snapped to 0.05.
  const n0 = roomMsgs(R.s[1].conn).length;
  R.send(0, { t: "soundDefaults", music: 0.33 });
  const rm = lastRoomMsg(R.s[1].conn)!;
  check(
    "room sound: a partial patch changes only its key, snapped to 0.05 (0.33 -> 0.35), and reaches everyone in one room message",
    rm.soundDefaults.music === 0.35 && rm.soundDefaults.effects === 0.8 && rm.soundDefaults.musicOn && rm.soundDefaults.song === "neon-tailpipe" && roomMsgs(R.s[1].conn).length === n0 + 1 && lastRoomMsg(R.s[2].conn)?.soundDefaults.music === 0.35,
    JSON.stringify(rm.soundDefaults),
  );
  // Wrong types: refused whole, no clamp.
  const e0 = errsOf(R.s[0].conn).length;
  const bad: ClientMsg[] = [
    { t: "soundDefaults", music: NaN },
    { t: "soundDefaults", effects: "0.5" as unknown as number },
    { t: "soundDefaults", musicOn: "yes" as unknown as boolean },
    { t: "soundDefaults", music: 1.5 },
    { t: "soundDefaults", effects: -0.1 },
    { t: "soundDefaults", music: 0.9, effects: null as unknown as number },
    { t: "soundDefaults", song: "gravel-surf" },
    { t: "soundDefaults", effects: 0.1, song: 7 as unknown as string },
  ];
  const n1 = roomMsgs(R.s[1].conn).length;
  for (const m of bad) R.send(0, m);
  const errs = errsOf(R.s[0].conn).slice(e0);
  check(
    "room sound: NaN, a string, a non-boolean musicOn, out-of-range volumes and a bad key next to a good one are refused whole (Bad sound settings); an unknown song id is refused (Unknown song); nothing changes, nothing is sent",
    errs.join("|") === "Bad sound settings|Bad sound settings|Bad sound settings|Bad sound settings|Bad sound settings|Bad sound settings|Unknown song|Unknown song" &&
      JSON.stringify(R.room.soundDefaults) === '{"musicOn":true,"music":0.35,"effects":0.8,"song":"neon-tailpipe"}' && roomMsgs(R.s[1].conn).length === n1,
    errs.join("|"),
  );
  // Unchanged: no broadcast (a snapped value equal to the current one too).
  R.clock.now += 5000;
  R.send(0, { t: "soundDefaults", music: 0.36, musicOn: true });
  R.send(0, { t: "soundDefaults" });
  check("room sound: a request that changes nothing (0.36 snaps to the current 0.35) sends no room message and no err", roomMsgs(R.s[1].conn).length === n1 && errsOf(R.s[0].conn).length === e0 + errs.length, `${roomMsgs(R.s[1].conn).length - n1} room messages`);
  // The rate budget: SOUND_BURST at once, then SOUND_PER_SEC a second.
  R.clock.now += 10000;
  const e2 = errsOf(R.s[0].conn).length;
  for (let i = 0; i < 8; i++) R.send(0, { t: "soundDefaults", effects: (i + 1) / 20 });
  const burst = errsOf(R.s[0].conn).slice(e2);
  const afterBurst = R.room.soundDefaults.effects;
  R.clock.now += 1000;
  for (let i = 0; i < 4; i++) R.send(0, { t: "soundDefaults", effects: (i + 11) / 20 });
  const later = errsOf(R.s[0].conn).slice(e2 + burst.length);
  check(
    `room sound: ${SOUND_BURST} changes at once, then Slow down (nothing changes); a second later ${SOUND_PER_SEC} more`,
    burst.length === 8 - SOUND_BURST && burst.every((e) => e === "Slow down") && afterBurst === SOUND_BURST / 20 && later.length === 4 - SOUND_PER_SEC && R.room.soundDefaults.effects === (10 + SOUND_PER_SEC) / 20,
    `burst errs ${burst.length}, effects ${afterBurst}; later errs ${later.length}, effects ${R.room.soundDefaults.effects}`,
  );
  // A song: the host's pick, everyone plays it; music off; then a handover keeps it all.
  R.clock.now += 10000;
  R.send(0, { t: "soundDefaults", song: "mirrorball", musicOn: false });
  const picked = [0, 1, 2].map((i) => lastRoomMsg(R.s[i].conn)!);
  check(
    "room sound: the host picks a song (and music off): every room message carries the choice and the song to play",
    picked.every((m) => m.soundDefaults.song === "mirrorball" && m.song === "mirrorball" && !m.soundDefaults.musicOn),
    JSON.stringify(picked.map((m) => [m.soundDefaults.song, m.song])),
  );
  const kept = JSON.stringify(R.room.soundDefaults);
  R.send(0, { t: "host", id: b.id });
  const after = lastRoomMsg(R.s[2].conn)!;
  const e3 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "soundDefaults", music: 0.9 });
  R.clock.now += 1000;
  R.send(1, { t: "soundDefaults", music: 0.9 });
  check(
    "room sound: a host handover keeps the defaults and the song; the old host is refused, the new one may change them",
    JSON.stringify(after.soundDefaults) === kept && after.song === "mirrorball" && errsOf(R.s[0].conn).slice(e3).join() === "Only the host can set the room sound" && R.room.soundDefaults.music === 0.9,
    `${JSON.stringify(after.soundDefaults)}; ${errsOf(R.s[0].conn).slice(e3).join()}`,
  );
  // Rejoin: the defaults come with the room message after the welcome.
  R.rooms.onClose(R.s[2], R.clock.now);
  const back = R.join("Cy", R.p[2].token);
  const rj = lastRoomMsg(back.conn)!;
  check("room sound: a rejoin gets the room's defaults and song in its room message", rj.soundDefaults.music === 0.9 && !rj.soundDefaults.musicOn && rj.song === "mirrorball", JSON.stringify(rj.soundDefaults));
  // Gone with the room: a new room starts from the built-in defaults.
  for (const x of [R.s[0], R.s[1], back]) R.rooms.onMessage(x, { t: "leave" }, R.clock.now);
  R.step(1);
  const gone = !R.rooms.rooms.has(R.room.code);
  const R2 = menuRooms(["Dee"]);
  check("room sound: gone with the room; a new room has the built-in defaults", gone && JSON.stringify(R2.room.soundDefaults) === JSON.stringify(BUILTIN_SOUND) && R2.room.song === DEFAULT_SONG_ID, JSON.stringify(R2.room.soundDefaults));
}

/** "random": picked by the server at once and at each race's countdown, never the song just played. */
function soundRandom(): void {
  const R = menuRooms(["Ann", "Bo"]);
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "soundDefaults", song: RANDOM_SONG });
  const m0 = [0, 1].map((i) => lastRoomMsg(R.s[i].conn)!);
  const firstPick = m0[0].song;
  check(
    "random song: picking Random picks a song at once (not the one playing), the same for every client; the choice stays random",
    firstPick !== "neon-tailpipe" && (SONG_IDS as readonly string[]).includes(firstPick) && m0.every((m) => m.song === firstPick && m.soundDefaults.song === RANDOM_SONG),
    JSON.stringify(m0.map((m) => [m.soundDefaults.song, m.song])),
  );
  // Race cycles: stop (straight back to the lobby) and a full race with results.
  const seen: string[] = [firstPick];
  const songsAt: string[] = [];
  let repeats = 0;
  let lobbySwitches = 0;
  let differ = 0;
  for (let cycle = 0; cycle < 24; cycle++) {
    R.clock.now += 2000;
    R.send(1, { t: "ready", ready: true });
    R.send(0, { t: "start" });
    const cd = [0, 1].map((i) => lastRoomMsg(R.s[i].conn)!);
    if (cd[0].phase !== "countdown") break;
    if (cd[0].song !== cd[1].song) differ++;
    if (cd[0].song === seen[seen.length - 1]) repeats++;
    seen.push(cd[0].song);
    songsAt.push(`countdown:${cd[0].song}`);
    R.send(0, { t: "stop" });
    const lobby = lastRoomMsg(R.s[1].conn)!;
    if (lobby.song !== cd[0].song) lobbySwitches++;
  }
  // One race to its results and the lobby after: the song stays the countdown's.
  R.clock.now += 2000;
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  const raceSong = R.room.song;
  if (raceSong === seen[seen.length - 1]) repeats++;
  seen.push(raceSong);
  const resultsSongs = new Set<string>();
  for (let i = 0; i < 60 * 300 && (R.room.phase as string) !== "lobby"; i++) {
    // Everyone over the line at once: the race ends (results), then the lobby opens.
    if (R.room.phase === "racing") for (const p of R.room.players.values()) if (p.progress && !p.progress.fin) p.progress.fin = 1000;
    R.step(1);
    if (R.room.phase === "results" || R.room.phase === "lobby") resultsSongs.add(lastRoomMsg(R.s[1].conn)!.song);
  }
  const distinct = new Set(seen);
  check(
    "random song: a new song at each race's countdown, never the one just played, the same for every client; the lobby after a stop keeps it",
    seen.length === 26 && repeats === 0 && differ === 0 && lobbySwitches === 0 && distinct.size === SONG_IDS.length,
    `${seen.join(" ")}; repeats ${repeats}, client mismatches ${differ}, lobby switches ${lobbySwitches}`,
  );
  check(
    "random song: after a race the results screen and the lobby play the countdown's song (no switch while the music plays)",
    (R.room.phase as string) === "lobby" && resultsSongs.size === 1 && resultsSongs.has(raceSong),
    `phase ${R.room.phase}; results/lobby songs ${[...resultsSongs].join()} vs ${raceSong}`,
  );
  // A fixed song: never re-picked at the countdown.
  R.send(0, { t: "soundDefaults", song: "rust-bucket" });
  R.clock.now += 2000;
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  check("random song: a fixed song is played at every countdown as picked", R.room.song === "rust-bucket" && lastRoomMsg(R.s[1].conn)?.song === "rust-bucket");
  R.send(0, { t: "restart" });
  const fixedRestart = R.room.song;
  R.send(0, { t: "stop" });
  R.send(0, { t: "soundDefaults", song: RANDOM_SONG });
  R.clock.now += 2000;
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  const beforeRestart = R.room.song;
  R.send(0, { t: "restart" });
  check(
    "random song: Random is picked again on a restart (a new countdown, another song), a fixed song is not",
    fixedRestart === "rust-bucket" && R.room.phase === "countdown" && R.room.song !== beforeRestart && lastRoomMsg(R.s[1].conn)?.song === R.room.song,
    `fixed ${fixedRestart}; random ${beforeRestart} -> ${R.room.song}`,
  );
  R.send(0, { t: "stop" });
  // snapVolume: the slider's steps.
  check(
    "room sound: snapVolume gives the slider's own values (k/20 equals 5k/100) and stays in 0..1",
    Array.from({ length: 21 }, (_, k) => snapVolume(k / 20 + 0.012) === (5 * k) / 100).every(Boolean) && snapVolume(1.2) === 1 && snapVolume(-0.3) === 0,
  );
}

/**
 * The host's Room Music slider (client/menu.ts: roomMusicSlid through the 500 ms PatchThrottle)
 * against the server with a 60 ms round trip: the room's musicOn the host last heard lags the
 * sends, so a drag through 0 and back up within one gap must still end with the music on.
 */
function soundRoomDrag(): void {
  const drag = (steps: number[]) => {
    const R = menuRooms(["Ann", "Bo"]);
    const base = R.clock.now;
    let now = 0; // the host client's clock, ms
    const timers: { at: number; seq: number; fn: () => void }[] = [];
    let seq = 0;
    const later = (fn: () => void, ms: number) => timers.push({ at: now + ms, seq: seq++, fn });
    const RTT = 60;
    let heard: RoomSound = R.room.soundDefaults; // the host's game.soundDefaults (room messages, RTT / 2 after the server)
    const sent: string[] = [];
    const th = new PatchThrottle<RoomSound>(
      (p) => {
        sent.push(JSON.stringify(p));
        later(() => {
          R.clock.now = base + now;
          R.send(0, { t: "soundDefaults", ...p });
          const sd = R.room.soundDefaults;
          later(() => (heard = sd), RTT / 2);
        }, RTT / 2);
      },
      500,
      () => now,
      later,
    );
    const run = (until: number) => {
      for (;;) {
        timers.sort((x, y) => x.at - y.at || x.seq - y.seq);
        const t = timers[0];
        if (!t || t.at > until) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = until;
    };
    let start: number | undefined; // set at the drag's first input, as the menu's roomMusicStart
    steps.forEach((v, i) => {
      run(i * 30); // an input every 30 ms
      start ??= heard.music;
      th.push(roomMusicSlid(v, start));
    });
    run(3000);
    return { room: R.room.soundDefaults, bo: lastRoomMsg(R.s[1].conn)!.soundDefaults, heard, sent: sent.join(" ") };
  };
  // The reviewer's drag: 0.45 -> 0 -> 0.3 in ~0.4 s, released at 30.
  const through = drag([0.45, 0.4, 0.3, 0.2, 0.1, 0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
  check(
    "room music slider: a drag 0.45 -> 0 -> 0.3 within one send gap (60 ms round trip) ends with the room's music on at 0.3 for every follower and the host",
    through.room.musicOn && through.room.music === 0.3 && through.bo.musicOn && through.bo.music === 0.3 && through.heard.musicOn && through.heard.music === 0.3,
    `sent ${through.sent}; room ${JSON.stringify(through.room)}`,
  );
  // Dragged down to 0 and released there: the room's music off, its volume as before the drag.
  const down = drag([0.45, 0.3, 0.15, 0]);
  check(
    "room music slider: dragged to 0 and released: the room's music off with the volume from before the drag (the default 0.4), for everyone",
    !down.room.musicOn && down.room.music === 0.4 && !down.bo.musicOn && down.bo.music === 0.4,
    `sent ${down.sent}; room ${JSON.stringify(down.room)}`,
  );
  check(
    "room music slider: roomMusicSlid always gives musicOn (on at v above 0; 0 off with the start volume)",
    JSON.stringify(roomMusicSlid(0.3, 0.5)) === '{"musicOn":true,"music":0.3}' && JSON.stringify(roomMusicSlid(0, 0.5)) === '{"musicOn":false,"music":0.5}',
  );
}

/**
 * SliderGrip (client/soundlogic.ts), behind every volume slider (speaker popover, lobby, Esc menu,
 * sound board): the slider being dragged is left alone; the drag ends on change, blur or
 * pointerup, whichever comes first. WebKit: a mouse drag does not focus a range input and one
 * that ends on its start value fires no change, so pointerup must end it.
 */
function soundSliderGrip(): void {
  const grip = new SliderGrip();
  const a = new EventTarget();
  const b = new EventTarget();
  let endsA = 0;
  grip.watch(a, () => endsA++);
  grip.watch(b);
  const fire = (el: EventTarget, ...types: string[]) => {
    for (const t of types) el.dispatchEvent(new Event(t));
  };
  // WebKit: drag 50 -> 30 -> 50, released on the start value: input, input, pointerup; no change, no blur.
  fire(a, "input", "input");
  const heldInDrag = grip.holds(a);
  fire(a, "pointerup");
  check(
    "slider grip: a WebKit drag that ends on its start value (input, input, pointerup; no change, no blur) is held during the drag and released (gesture ended once) at pointerup",
    heldInDrag && !grip.holds(a) && grip.held === null && endsA === 1,
    `held ${heldInDrag}, after ${grip.holds(a)}, ends ${endsA}`,
  );
  // Chromium: input..., pointerup, change, blur: released; ending again is harmless.
  fire(a, "input", "input", "pointerup", "change", "blur");
  const chrome = !grip.holds(a);
  // Keyboard: each step is input then change.
  fire(a, "input");
  const keyHeld = grip.holds(a);
  fire(a, "change");
  // Another slider's events never release the one being dragged; a focus-only slider is not held.
  fire(a, "input");
  fire(b, "pointerup", "change", "blur");
  const stillA = grip.holds(a);
  fire(a, "blur");
  check(
    "slider grip: released by a Chromium drag's pointerup/change/blur and a keyboard step's change; another slider's events do not release it; focus alone holds nothing",
    chrome && keyHeld && !grip.holds(a) && stillA && grip.held === null && !grip.holds(b),
    `chrome ${chrome}, key ${keyHeld}, other ${stillA}, ends ${endsA}`,
  );
  // With an AudioEngine: the Music gesture ends at pointerup, so the next drag to 0 restores the
  // volume from before that drag, not from the earlier one.
  withStore(() => {
    const eng = new AudioEngine();
    eng.setRoom({ musicOn: true, music: 0.5, effects: 0.8 });
    const g2 = new SliderGrip();
    const el = new EventTarget();
    g2.watch(el, () => eng.slideEnd());
    el.addEventListener("input", (e) => eng.slideMusic((e as CustomEvent<number>).detail));
    const slide = (v: number) => el.dispatchEvent(new CustomEvent("input", { detail: v }));
    slide(0.4);
    slide(0.5); // back on the start value: no change in WebKit
    el.dispatchEvent(new Event("pointerup"));
    slide(0.7);
    el.dispatchEvent(new Event("pointerup"));
    slide(0.3);
    slide(0); // a drag down to 0: off, with the volume from before this drag (0.7)
    el.dispatchEvent(new Event("pointerup"));
    check(
      "slider grip: with the engine, each WebKit drag ends at pointerup; a drag to 0 is off with the volume from before that drag (0.7)",
      !eng.settings.musicOn && eng.settings.music === 0.7 && JSON.stringify(eng.own) === '{"music":0.7,"musicOn":false}',
      JSON.stringify(eng.own),
    );
  });
}

/** The client: Game follows the room's sound; leave() goes back to the built-in defaults. */
function soundClient(): void {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock);
  const B = wiredGame(rooms, clock);
  const flushAll = () => {
    for (const W of [A, B]) W.flush();
  };
  A.game.create("Ann");
  A.open();
  A.flush();
  B.game.join(A.game.code, "Bo");
  B.open();
  flushAll();
  const fresh = JSON.stringify(B.game.soundDefaults) === JSON.stringify(BUILTIN_SOUND) && B.game.song === DEFAULT_SONG_ID;
  A.game.setSoundDefaults({ musicOn: false, effects: 0.25, song: "rust-bucket" });
  flushAll();
  check(
    "room sound client: the host's change over the wire reaches the guest's Game (soundDefaults and song)",
    fresh && !B.game.soundDefaults.musicOn && B.game.soundDefaults.effects === 0.25 && B.game.song === "rust-bucket" && B.game.soundDefaults.song === "rust-bucket" && A.game.song === "rust-bucket",
    JSON.stringify([B.game.soundDefaults, B.game.song]),
  );
  // The guest's AudioEngine as main.ts feeds it (soundFrame): untouched follows, own stays, reset.
  withStore(() => {
    const eng = new AudioEngine();
    eng.set({ effects: 0.7 });
    eng.setRoom(B.game.you ? B.game.soundDefaults : null, B.game.isHost());
    const inRoom = { ...eng.settings };
    A.game.setSoundDefaults({ musicOn: true, music: 0.4 });
    clock.now += 1000;
    flushAll();
    eng.setRoom(B.game.you ? B.game.soundDefaults : null, B.game.isHost());
    const live = { ...eng.settings };
    eng.useRoomSound();
    const reset = { ...eng.settings };
    B.game.leave();
    eng.setRoom(B.game.you ? B.game.soundDefaults : null, B.game.isHost());
    check(
      "room sound client: the guest follows the untouched music live (off, then on 0.4), keeps the own effects (0.7) until the reset (0.25); leave() goes back to the built-in defaults and the default song",
      !inRoom.musicOn && inRoom.effects === 0.7 && live.musicOn && live.music === 0.4 && live.effects === 0.7 && reset.effects === 0.25 &&
        JSON.stringify(B.game.soundDefaults) === JSON.stringify(BUILTIN_SOUND) && B.game.song === DEFAULT_SONG_ID && eng.room === null && eng.settings.music === BUILTIN_SOUND.music,
      `${JSON.stringify(inRoom)} -> ${JSON.stringify(live)} -> reset ${JSON.stringify(reset)}`,
    );
  });
}

// ---- in-game menu: pause for everyone (MENU-3, PLAN-MENU.md, 2026-11-18) -----------------

// This section's imports (hoisted like the ones at the top).
import { PAUSE_COOLDOWN_MS, PAUSE_MAX_MS, PAUSE_RESUME_MS, round } from "../shared/protocol";
import { MINE_LIFE_TICKS } from "../shared/weapons";

const TICK_MS = 1000 / 60;

/** Everything the simulation moves: cars, progress, timers, shots, mines, the race clock. */
function roomDigest(room: Room): string {
  const cars = [...room.players.values()].map((p) => ({ id: p.id, car: p.car, pr: p.progress, hp: p.hp, ghost: p.ghost, cd: p.cooldown, fin: p.finished, ammo: { ...p.wallet.ammo } }));
  return JSON.stringify({ cars, shots: room.combat.shots, mines: room.combat.mines, phase: room.phase, ends: room.phaseEnds, start: room.raceStart });
}

/** A Sim race on one lap, everyone on the field; `ms` of flat-out driving after GO. */
function pauseRace(names: string[], ms = 0): { sim: Sim; p: Player[] } {
  const sim = new Sim(1);
  const p = names.map((n) => sim.add(n));
  sim.startRace(p[0]);
  sim.run(Math.round(ms / TICK_MS), () => ({ throttle: 1 }));
  return { sim, p };
}

/** Tick until the room steps again (the 3-2-1 is over); true if anything moved before that. */
function runPaused(sim: Sim, cmd: (p: Player) => Ctl = () => ({ throttle: 1 })): boolean {
  const d0 = roomDigest(sim.room);
  let moved = false;
  for (let i = 0; i < 60 * 200 && sim.room.paused; i++) {
    sim.run(1, cmd);
    if (sim.room.paused && roomDigest(sim.room) !== d0) moved = true;
  }
  return moved;
}

function pauseRefused(): void {
  const R = menuRooms(["Ann", "Bo"]);
  const e0 = errsOf(R.s[0].conn).length;
  const e1 = errsOf(R.s[1].conn).length;
  R.send(0, { t: "pause" });
  R.send(0, { t: "resume" });
  R.send(1, { t: "pause" });
  R.send(1, { t: "resume" });
  const lobby = [...errsOf(R.s[0].conn).slice(e0), ...errsOf(R.s[1].conn).slice(e1)].join("|");
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  while (R.room.phase !== "racing") R.step(1);
  const f1 = errsOf(R.s[1].conn).length;
  R.send(1, { t: "pause" });
  const guestRefused = errsOf(R.s[1].conn).slice(f1).join("|") === "Only the host can pause the race" && !R.room.paused;
  R.send(0, { t: "pause" });
  const m = lastRoomMsg(R.s[1].conn);
  const f0 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "pause" });
  R.send(1, { t: "resume" });
  const twice = errsOf(R.s[0].conn).slice(f0).join("|");
  const guestResume = errsOf(R.s[1].conn).slice(f1 + 1).join("|");
  check(
    "pause: refused from a non-host (pause and resume) and outside a race; the room message carries paused, pausedBy, pausedAt, resumeAt",
    lobby === "No race to pause|The race is not paused|Only the host can pause the race|Only the host can resume the race" &&
      guestRefused && twice === "The race is already paused" && guestResume === "Only the host can resume the race" &&
      m?.paused === true && m.pausedBy === "Ann" && m.pausedAt === R.clock.now && m.resumeAt === 0 && R.room.paused,
    `lobby: ${lobby}; twice: ${twice}; guest resume: ${guestResume}; room ${m?.paused}/${m?.pausedBy}/${m?.pausedAt}/${m?.resumeAt}`,
  );
  // The results phase: nothing to pause.
  const { sim, p } = pauseRace(["Ann", "Bo"]);
  nearFinish(sim, p[0]);
  sim.run(15, (q) => (q === p[0] ? { throttle: 1 } : {}));
  nearFinish(sim, p[1]);
  sim.run(15, (q) => (q === p[1] ? { throttle: 1 } : {}));
  check("pause: refused in the results", sim.room.phase === "results" && sim.room.pause(p[0], sim.now) === "No race to pause" && !sim.room.paused, sim.room.phase);
}

function pauseFreeze(): void {
  const { sim, p } = pauseRace(["Ann", "Bo", "Cy", "Di"], 500);
  const [a, b, c, d] = p;
  sim.armWeapons();
  sim.place(a, 600, -20, 300);
  sim.place(b, 900, 0, 0);
  sim.place(c, 1200, 0, 250);
  sim.place(d, 1500, 20, 0);
  sim.run(2, () => ({ throttle: 1 }));
  // A rivet in flight and a mine on the track (a's), b wrecked, c in the air and ghosted, d falling.
  sim.run(1, (q) => (q === a ? { throttle: 1, fire: true, mine: true } : { throttle: 1 }));
  sim.run(3, () => ({ throttle: 1 }));
  wreckCar(b.car!);
  c.car!.air = 25;
  c.ghost = 40;
  d.car!.fall = 30;
  sim.run(1, () => ({ throttle: 1 }));
  const shots0 = sim.room.combat.shots.length;
  const mine0 = sim.room.combat.mines[0];
  const age0 = mine0?.age ?? -1;
  const ack0 = a.ack;
  const before = roomDigest(sim.room);
  const conn = sim.conns.get(a.id)!;
  const snaps0 = conn.msgs.filter((m) => m.t === "snap").length;
  if (sim.room.pause(a, sim.now)) throw new Error("pause refused");
  for (let i = 0; i < 300; i++) sim.run(1, (q) => ({ throttle: 1, steer: 0.5, fire: true, mine: i % 40 === 0 && q === a }));
  const after = roomDigest(sim.room);
  const snaps = conn.msgs.filter((m) => m.t === "snap").length - snaps0;
  const last = lastSnapOf(conn);
  const lastCar = last?.ents.find((e): e is CarSnap => e.k === "car" && e.id === a.id);
  check(
    "pause: 5 s paused with every driver on full throttle, the gun held and mines pressed: cars, progress, hp, ghost, wreck/air/fall ticks, the rivet in flight, mine age and ammo do not change",
    before === after && shots0 === 1 && !!mine0 && b.car!.wreck === WRECK_TICKS - 1 && c.car!.air > 0 && c.ghost > 0 && d.car!.fall > 0 && sim.room.paused,
    `shots ${shots0}, mine age ${age0}, wreck ${b.car!.wreck}, air ${c.car!.air}, ghost ${c.ghost}, fall ${d.car!.fall}`,
  );
  const fed = (sim as unknown as { seqs: Map<string, number> }).seqs.get(a.id)! - 1;
  check(
    "pause: inputs are still consumed and thrown away (ack moves on one per tick, one input behind the last as before), snapshots keep flowing with the frozen poses",
    a.ack === ack0 + 300 && a.ack === fed - 1 && snaps >= 145 && !!lastCar && lastCar.x === round(a.car!.x, 2) && lastCar.y === round(a.car!.y, 2) && last?.phase === "racing",
    `ack ${ack0} -> ${a.ack}, last fed ${fed}; ${snaps} snapshots while paused`,
  );
  // Resume: the mine presses and the held gun of the pause do nothing afterwards.
  sim.room.resume(a, sim.now);
  runPaused(sim, () => ({}));
  const mines1 = sim.room.combat.mines.length;
  const age1 = sim.room.combat.mines[0]?.age ?? -1;
  const ammo1 = a.wallet.ammo.mines;
  sim.run(60, () => ({}));
  check(
    "pause: after the resume no mine is dropped for the presses made while paused; mine life goes on from where it stood",
    sim.room.combat.mines.length === mines1 && a.wallet.ammo.mines === ammo1 && age1 === age0 + 1 && sim.room.combat.mines[0]?.age === age1 + 60 && MINE_LIFE_TICKS > age1 + 60,
    `mines ${mines1} -> ${sim.room.combat.mines.length}, age at the pause ${age0}, after the resume tick ${age1}, 60 ticks on ${sim.room.combat.mines[0]?.age}`,
  );
}

function pauseResume(): void {
  const { sim, p } = pauseRace(["Ann", "Bo"], 2000);
  const [a, b] = p;
  sim.grantAmmo();
  const start0 = sim.room.raceStart;
  sim.run(1, () => ({ throttle: 1 }));
  const pausedAt = sim.now;
  sim.room.pause(a, pausedAt);
  sim.run(600, () => ({ throttle: 1 }));
  const call = sim.now;
  const e = sim.room.resume(a, call);
  const resumeAt = sim.room.resumeAt;
  const roomMsg = sim.lastRoom(b);
  const frozen = roomDigest(sim.room);
  const early = runPaused(sim);
  const at = sim.now; // the first tick that stepped again
  const d = at - pausedAt;
  // Inputs went on arriving during the pause (fed every tick): the resume drops what is queued.
  check(
    "pause: at the resume every jitter buffer starts afresh (resetQueue: nothing queued from the pause, buffering, no mine counter, no input to repeat)",
    [a, b].every((q) => q.queue.length === 0 && q.buffering && q.mineBase === null && q.lastInput.throttle === 0 && q.starved === 0),
    [a, b].map((q) => `queue ${q.queue.length}, mineBase ${q.mineBase}, last throttle ${q.lastInput.throttle}`).join("; "),
  );
  check(
    "pause: resume = a 3-2-1 (resumeAt = now + 3000) during which nothing moves; the room steps again at the first tick from resumeAt",
    e === null && resumeAt === call + PAUSE_RESUME_MS && roomMsg?.resumeAt === resumeAt && roomMsg.paused === true && !early && at >= resumeAt && at - resumeAt < TICK_MS + 1e-6 && roomDigest(sim.room) !== frozen,
    `resumeAt ${resumeAt - call} ms after the call; stepped ${(at - resumeAt).toFixed(2)} ms after it`,
  );
  check(
    "pause: on the resume raceStart moves on by the time paused (race time reads on from where it stood); phaseEnds 0 (no winner yet) stays 0",
    Math.abs(sim.room.raceStart - (start0 + d)) < 1e-6 && Math.abs(at - sim.room.raceStart - (pausedAt - start0)) < 1e-6 && sim.room.phaseEnds === 0 && sim.lastRoom(b)?.raceStart === sim.room.raceStart && sim.lastRoom(b)?.paused === false,
    `shift ${d.toFixed(1)} ms, race time at the pause ${(pausedAt - start0).toFixed(1)}, after ${(at - sim.room.raceStart).toFixed(1)}`,
  );
  // The weapons-armed delay counts race time: no rivet before WEAPONS_ARM_MS of it.
  let firstShot = -1;
  for (let i = 0; i < 60 * 10 && firstShot < 0; i++) {
    sim.run(1, () => ({ fire: true }));
    if (sim.room.combat.shots.length) firstShot = sim.now - sim.room.raceStart;
  }
  check(
    "pause: the weapons arm WEAPONS_ARM_MS of race time after GO, the pause not counted",
    firstShot >= WEAPONS_ARM_MS && firstShot < WEAPONS_ARM_MS + 4 * TICK_MS && sim.now - start0 > WEAPONS_ARM_MS + PAUSE_RESUME_MS,
    `first rivet at race time ${firstShot.toFixed(0)} ms (wall clock since GO ${(sim.now - start0).toFixed(0)})`,
  );
  nearFinish(sim, b);
  let fin = 0;
  for (let i = 0; i < 60 && !fin; i++) {
    sim.run(1, (q) => (q === b ? { throttle: 1 } : {}));
    fin = b.progress!.fin;
  }
  check("pause: the finish time excludes the pause", fin > 0 && Math.abs(fin - (sim.now - start0 - d)) <= 1, `fin ${fin} ms, wall clock since GO ${(sim.now - start0).toFixed(0)}, paused ${d.toFixed(0)}`);
}

/** Cars stay put until their driver's inputs are in after a resume (no coasting gap). */
function pauseHold(): void {
  const { sim, p } = pauseRace(["Ann", "Bo"], 1500);
  const [a, b] = p;
  sim.room.pause(a, sim.now);
  sim.run(30, () => ({}));
  sim.room.resume(a, sim.now);
  while (sim.room.paused) sim.tick(); // no inputs during the pause, as a client sends none
  const pos = () => [a, b].map((q) => `${q.car!.x},${q.car!.y}`).join("|");
  const p0 = pos();
  sim.tick(); // nothing queued yet: both wait
  const held = pos() === p0;
  // Bo's inputs come in; Ann (online) sends nothing: hers waits up to RESUME_HOLD (1 s), then coasts.
  let bMoved = -1;
  for (let i = 0; i < 5; i++) {
    sim.feed(b, { throttle: 1 });
    sim.tick();
    if (bMoved < 0 && `${b.car!.x},${b.car!.y}` !== p0.split("|")[1]) bMoved = i;
  }
  const aStill = `${a.car!.x},${a.car!.y}` === p0.split("|")[0];
  for (let i = 0; i < 60; i++) {
    sim.feed(b, { throttle: 1 });
    sim.tick();
  }
  const aCoasted = `${a.car!.x},${a.car!.y}` !== p0.split("|")[0];
  check(
    "pause: after the resume a driver's car waits for their first inputs (QUEUE_START), then drives; one whose inputs never come coasts after the hold (1 s)",
    held && bMoved === 1 && aStill && aCoasted,
    `held ${held}, Bo moved at input ${bMoved}, Ann still at 5 ticks ${aStill}, coasting after the hold ${aCoasted}`,
  );
}

function pauseAuto(): void {
  // 120 s with nobody resuming: the 3-2-1 starts by itself.
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    const pausedAt = sim.now;
    sim.room.pause(p[0], pausedAt);
    let startedAt = 0;
    for (let i = 0; i < 60 * 130 && !startedAt; i++) {
      sim.run(1);
      if (sim.room.resumeAt) startedAt = sim.now;
    }
    const resumeAt = sim.room.resumeAt;
    runPaused(sim);
    check(
      "pause: auto-resume: the 3-2-1 starts by itself PAUSE_MAX_MS (120 s) after the pause, then the race goes on",
      startedAt - pausedAt >= PAUSE_MAX_MS && startedAt - pausedAt < PAUSE_MAX_MS + TICK_MS + 1e-6 && resumeAt === startedAt + PAUSE_RESUME_MS && !sim.room.paused && sim.room.phase === "racing",
      `3-2-1 began ${((startedAt - pausedAt) / 1000).toFixed(3)} s after the pause`,
    );
  }
  // The pausing host's socket drops: the 3-2-1 starts at once (they keep the host for the grace).
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    sim.room.pause(p[0], sim.now);
    sim.run(30);
    sim.room.unbind(p[0], sim.now);
    const m = sim.lastRoom(p[1]);
    check(
      "pause: the pausing host going offline starts the 3-2-1 at once (one room message); they are still the host",
      sim.room.resumeAt === sim.now + PAUSE_RESUME_MS && m?.resumeAt === sim.room.resumeAt && m.paused && sim.room.hostId === p[0].id,
      `resumeAt ${sim.room.resumeAt - sim.now} ms ahead`,
    );
  }
  // The pausing host leaves for good: the new host sees the 3-2-1 already running.
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    sim.room.pause(p[0], sim.now);
    sim.room.leave(p[0], sim.now);
    check("pause: the pausing host leaving starts the 3-2-1 at once", sim.room.resumeAt === sim.now + PAUSE_RESUME_MS && sim.room.hostId === p[1].id);
  }
  // Handed over while paused: the new host resumes, the old one no longer can; removing the
  // player who paused (after a handover) starts the 3-2-1 like their leaving.
  {
    const { sim, p } = pauseRace(["Ann", "Bo", "Cy"], 1000);
    const [a, b] = p;
    sim.room.pause(a, sim.now);
    sim.room.setHost(a, b.id, sim.now);
    const old = sim.room.resume(a, sim.now);
    const stillPaused = sim.room.paused && !sim.room.resumeAt;
    const neu = sim.room.resume(b, sim.now);
    const again = sim.room.resume(b, sim.now + 500);
    check(
      "pause: a new host can resume (the old one is refused); a second resume during the 3-2-1 changes nothing",
      old === "Only the host can resume the race" && stillPaused && neu === null && again === null && sim.room.resumeAt === sim.now + PAUSE_RESUME_MS,
      `old ${old}, new ${neu}`,
    );
  }
  {
    const { sim, p } = pauseRace(["Ann", "Bo", "Cy"], 1000);
    const [a, b] = p;
    sim.room.pause(a, sim.now);
    sim.room.setHost(a, b.id, sim.now);
    sim.run(30);
    sim.room.kick(b, a.id, sim.now);
    check("pause: removing the player who paused (after a handover) starts the 3-2-1", !sim.room.players.has(a.id) && sim.room.resumeAt === sim.now + PAUSE_RESUME_MS);
  }
}

function pauseCooldown(): void {
  const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
  const a = p[0];
  sim.room.pause(a, sim.now);
  sim.room.resume(a, sim.now);
  sim.run(30);
  const during = sim.room.pause(a, sim.now);
  runPaused(sim);
  const back = sim.now;
  sim.run(1);
  const soon = sim.room.pause(a, sim.now);
  let okAt = 0;
  for (let i = 0; i < 60 * 10 && !okAt; i++) {
    sim.run(1);
    if (sim.room.pause(a, sim.now) === null) okAt = sim.now;
  }
  check(
    "pause: re-pause cooldown: refused during the 3-2-1 and for PAUSE_COOLDOWN_MS (5 s) after the room steps again, then accepted",
    during === "The race is already paused" && soon === "You can pause again in 5s" && okAt - back >= PAUSE_COOLDOWN_MS && okAt - back < PAUSE_COOLDOWN_MS + TICK_MS + 1e-6 && sim.room.paused,
    `during: ${during}; soon: ${soon}; accepted ${(okAt - back).toFixed(1)} ms after the resume`,
  );
}

function pauseGrace(): void {
  // During the finish grace: the 30 s stand still, then run on for what was left.
  const { sim, p } = pauseRace(["Ann", "Bo"], 500);
  const [a] = p;
  nearFinish(sim, a);
  for (let i = 0; i < 60 && !a.finished; i++) sim.run(1, (q) => (q === a ? { throttle: 1 } : {}));
  const ends0 = sim.room.phaseEnds;
  sim.run(60);
  const pausedAt = sim.now;
  sim.room.pause(a, pausedAt);
  sim.run(Math.round((FINISH_GRACE_MS + 5000) / TICK_MS));
  const still = sim.room.phase === "racing" && sim.room.phaseEnds === ends0;
  sim.room.resume(a, sim.now);
  runPaused(sim, () => ({}));
  const at = sim.now;
  const shifted = Math.abs(sim.room.phaseEnds - (ends0 + (at - pausedAt))) < 1e-6;
  let endedAt = 0;
  for (let i = 0; i < 60 * 40 && !endedAt; i++) {
    sim.run(1);
    if (sim.room.phase === "results") endedAt = sim.now;
  }
  const left = ends0 - pausedAt;
  check(
    "pause: during the finish grace the grace stands still (35 s paused, still racing); on the resume phaseEnds moves on and the race closes after what was left of it",
    a.finished && ends0 > 0 && still && shifted && endedAt > 0 && Math.abs(endedAt - at - left) <= TICK_MS + 1e-6,
    `grace left at the pause ${left.toFixed(0)} ms; closed ${(endedAt - at).toFixed(0)} ms after the resume`,
  );

  // Grace removal of an offline player keeps running while paused; disconnectedAt is not shifted.
  {
    const { sim, p } = pauseRace(["Ann", "Bo", "Cy"], 500);
    const [a, , c] = p;
    sim.room.pause(a, sim.now);
    sim.run(30);
    const off = sim.now;
    sim.room.unbind(c, off);
    let goneAt = 0;
    for (let i = 0; i < 60 * 30 && !goneAt; i++) {
      sim.run(1);
      if (!sim.room.players.has(c.id)) goneAt = sim.now;
    }
    const lines = sim.room.chatLines.filter((l) => l.name === "Cy").map((l) => l.kind);
    check(
      "pause: an offline player's reconnect grace runs out while paused (removed RECONNECT_GRACE_MS after the drop, a 'leave' line); the race stays paused",
      goneAt - off > RECONNECT_GRACE_MS && goneAt - off <= RECONNECT_GRACE_MS + TICK_MS + 1e-6 && c.disconnectedAt === off && sim.room.paused && !sim.room.resumeAt && lines.join() === "join,leave",
      `removed ${(goneAt - off).toFixed(0)} ms after the drop; lines ${lines.join()}`,
    );
  }
}

function pauseCountdown(): void {
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  sim.readyAll(a);
  sim.room.start(a, sim.now);
  sim.run(90);
  const start0 = sim.room.raceStart;
  sim.room.pause(a, sim.now);
  const grid = roomDigest(sim.room);
  sim.run(600);
  const frozen = sim.room.phase === "countdown" && roomDigest(sim.room) === grid && sim.room.raceStart === start0;
  const call = sim.now;
  const e = sim.room.resume(a, call);
  const m = sim.lastRoom(b);
  const restarted = !sim.room.paused && sim.room.resumeAt === 0 && sim.room.raceStart === call + COUNTDOWN_MS && sim.room.phaseEnds === sim.room.raceStart && m?.paused === false && m.raceStart === sim.room.raceStart;
  let goAt = 0;
  for (let i = 0; i < 60 * 10 && !goAt; i++) {
    sim.run(1);
    if (sim.room.phase === "racing") goAt = sim.now;
  }
  check(
    "pause: in the countdown it stands still; the resume starts the countdown over at once (a full 3 s, no 3-2-1 stacked on what was left of it)",
    e === null && frozen && restarted && goAt - call >= COUNTDOWN_MS && goAt - call < COUNTDOWN_MS + TICK_MS + 1e-6,
    `1.5 s were left at the pause; GO ${(goAt - call).toFixed(0)} ms after the resume`,
  );
  // Auto-resume and the pauser going offline in the countdown: the countdown starts over too.
  const sim2 = new Sim(1);
  const c = sim2.add("Cy");
  sim2.add("Di");
  sim2.readyAll(c);
  sim2.room.start(c, sim2.now);
  sim2.run(30);
  sim2.room.pause(c, sim2.now);
  sim2.room.unbind(c, sim2.now);
  check("pause: the pauser going offline in the countdown starts the countdown over", !sim2.room.paused && sim2.room.phase === "countdown" && sim2.room.raceStart === sim2.now + COUNTDOWN_MS);
}

function pauseControls(): void {
  // Kick while paused: the race stays paused.
  {
    const { sim, p } = pauseRace(["Ann", "Bo", "Cy"], 1000);
    const [a, b, c] = p;
    sim.room.pause(a, sim.now);
    const e = sim.room.kick(a, c.id, sim.now);
    sim.run(30);
    check("pause: a kick works while paused and does not unpause (the others stay frozen)", e === null && !sim.room.players.has(c.id) && sim.room.paused && !sim.room.resumeAt && !!b.car && sim.room.phase === "racing");
  }
  // Retire while paused: the same.
  {
    const { sim, p } = pauseRace(["Ann", "Bo", "Cy"], 1000);
    const [a, b] = p;
    sim.room.pause(a, sim.now);
    const pose = JSON.stringify(a.car);
    const e = sim.room.retire(b);
    sim.run(30);
    check("pause: a retire works while paused and does not unpause", e === null && b.retired && !b.car && sim.room.paused && !sim.room.resumeAt && JSON.stringify(a.car) === pose);
  }
  // Stop and restart while paused: they clear the pause.
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    sim.room.pause(p[0], sim.now);
    const e = sim.room.stopRace(p[0], sim.now);
    const m = sim.lastRoom(p[1]);
    check("pause: Stop while paused -> the lobby, the pause cleared (room message paused false), no results", e === null && sim.room.phase === "lobby" && !sim.room.paused && m?.paused === false && m.pausedBy === "" && !sim.conns.get(p[1].id)!.msgs.some((x) => x.t === "results"));
  }
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    sim.room.pause(p[0], sim.now);
    sim.room.resume(p[0], sim.now);
    const e = sim.room.restartRace(p[0], sim.now);
    const m = sim.lastRoom(p[1]);
    let goAt = 0;
    for (let i = 0; i < 60 * 5 && !goAt; i++) {
      sim.run(1);
      if (sim.room.phase === "racing") goAt = sim.now;
    }
    check(
      "pause: Restart while paused (even during the 3-2-1) -> a fresh countdown, the pause cleared",
      e === null && m?.paused === false && m.resumeAt === 0 && m.phase === "countdown" && goAt > 0 && !sim.room.paused,
      `racing ${goAt ? "after the countdown" : "never"}`,
    );
  }
  // A kick or a retire that leaves nobody to wait for ends the race at once, the pause with it.
  for (const how of ["kick", "retire"] as const) {
    const { sim, p } = pauseRace(["Ann", "Bo"], 500);
    const [a, b] = p;
    nearFinish(sim, a);
    for (let i = 0; i < 60 && !a.finished; i++) sim.run(1, (q) => (q === a ? { throttle: 1 } : {}));
    sim.room.pause(a, sim.now);
    sim.run(10);
    const e = how === "kick" ? sim.room.kick(a, b.id, sim.now) : sim.room.retire(b);
    sim.run(1);
    const rows = sim.conns.get(a.id)!.msgs.filter((x): x is Extract<ServerMsg, { t: "results" }> => x.t === "results").pop()?.rows ?? [];
    check(
      `pause: a ${how} of the last driver still racing (the winner is in) ends the race on the next tick, the pause with it`,
      a.finished && e === null && sim.room.phase === "results" && !sim.room.paused && sim.lastRoom(a)?.paused === false && rows.length === (how === "kick" ? 1 : 2),
      `${sim.room.phase}, rows ${rows.length}`,
    );
  }
  {
    const { sim, p } = pauseRace(["Ann", "Bo"], 1000);
    const [a, b] = p;
    sim.room.pause(a, sim.now);
    sim.room.retire(b);
    sim.room.retire(a);
    sim.run(1);
    check("pause: everyone retiring while paused (no finisher) -> the lobby at once, no results, the pause cleared", sim.room.phase === "lobby" && !sim.room.paused && !sim.conns.get(a.id)!.msgs.some((x) => x.t === "results"));
  }
}

/**
 * Over the wired client (no lag): the pause stops prediction and sending, the race view stands
 * still, engine and gravel go silent, and the countdown cues do not replay: the resume has its
 * own 3-2-1 cues (once), a countdown-phase resume replays the full countdown's. After the
 * resume the predicted car is kept (no reset) and reconciliation stays tiny.
 */
function pauseClient(): void {
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(3);
    const H = wiredGame(rooms, clock);
    const G = wiredGame(rooms, clock);
    H.game.create("Host");
    H.open();
    H.flush();
    G.game.join(H.game.code, "Guest");
    G.open();
    G.flush();
    H.flush();
    G.game.setReady(true);
    G.flush();
    H.game.start();
    H.flush();
    G.flush();
    const room = rooms.rooms.get(H.game.code)!;
    const trig = new SoundTriggers(100);
    const cues: string[] = [];
    let carLost = false;
    let watchCar = false;
    const drive = (n: number) => {
      for (let i = 0; i < n; i++) {
        clock.now += TICK_MS;
        rooms.step(clock.now);
        for (const W of [H, G]) {
          W.flush();
          W.game.step(W.game.raceOn() ? { throttle: 1, steer: 0, fire: true, mine: false } : NO_CONTROLS, TICK_MS);
        }
        const g = G.game;
        const v: SoundView = { ...soundView(g), paused: g.paused, resumeGo: g.resumeGo, raceKey: g.raceId };
        for (const t of trig.frame(v, clock.now, true)) if (t.src === "countdown" || t.src === "resume") cues.push(`${t.src}:${t.kind}`);
        if (watchCar && !g.car) carLost = true;
      }
    };
    while (room.phase !== "racing") drive(1);
    drive(120);
    const startCues = cues.splice(0).join();
    const gs = room.players.get(G.game.you)!;
    const raceId0 = G.game.raceId;
    H.game.pause();
    drive(3); // the in-flight inputs are consumed and acked
    const seq0 = gs.lastQueuedSeq;
    const view0 = { clock: G.game.raceNow() - G.game.raceStart, arms: G.game.armsInMs(), car: JSON.stringify(G.game.car) };
    drive(300);
    const view1 = { clock: G.game.raceNow() - G.game.raceStart, arms: G.game.armsInMs(), car: JSON.stringify(G.game.car) };
    check(
      "pause client: both clients see the pause; nothing is predicted or sent (no new inputs reach the server, nothing pending); raceOn false; the race clock and the arm timer stand still; the car stays where the server froze it",
      G.game.paused && H.game.paused && G.game.pausedBy === "Host" && gs.lastQueuedSeq === seq0 && G.game.pending.length === 0 && !G.game.raceOn() &&
        view0.clock === view1.clock && view0.arms === view1.arms && view1.arms > 0 && view0.car === view1.car &&
        Math.hypot(G.game.car!.x - gs.car!.x, G.game.car!.y - gs.car!.y) < 0.01,
      `clock ${view0.clock.toFixed(0)} -> ${view1.clock.toFixed(0)}, arms ${view0.arms.toFixed(0)} -> ${view1.arms.toFixed(0)}, last seq ${seq0} -> ${gs.lastQueuedSeq}`,
    );
    const st: EngineState = { phase: G.game.phase, hasCar: !!G.game.car, connected: G.game.connected, wreck: 0, fall: 0, air: 0, finished: false, speed: 300, topSpeed: 430, throttle: 1 };
    check(
      "pause client: engine and gravel targets are silent while paused (the same state unpaused drives them)",
      !engineTarget({ ...st, paused: G.game.paused }).on && !gravelTarget({ ...st, paused: G.game.paused }, true).on && engineTarget(st).on && gravelTarget(st, true).on,
    );
    const pausedCues = cues.splice(0).join();
    H.game.resume();
    watchCar = true;
    let e0 = -1;
    let clockBack = NaN;
    for (let i = 0; i < 400 && (G.game.paused || e0 < 0); i++) {
      drive(1);
      if (!G.game.paused && e0 < 0) {
        e0 = G.game.recErrors.length;
        clockBack = G.game.raceNow() - G.game.raceStart;
      }
    }
    const resumeCues = cues.splice(0).join();
    const at = { x: G.game.car!.x, y: G.game.car!.y };
    drive(330); // also past the 5 s re-pause cooldown, for the countdown pause below
    watchCar = false;
    const errs = G.game.recErrors.slice(e0);
    const max = Math.max(0, ...errs);
    check(
      "pause client: the start countdown's cues are not replayed: none while paused, the resume's own 3-2-1 (three beeps and GO) once",
      startCues === "countdown:beep,countdown:beep,countdown:beep,countdown:go" && pausedCues === "" && resumeCues === "resume:beep,resume:beep,resume:beep,resume:go" && cues.join() === "",
      `start: ${startCues}; paused: ${pausedCues || "-"}; resume: ${resumeCues}; after: ${cues.join() || "-"}`,
    );
    check(
      "pause client: on the resume the predicted car is kept (same race id), the race clock reads on from where it stood, the car drives again and reconciliation stays tiny (max < 1)",
      !carLost && G.game.raceId === raceId0 && Math.abs(clockBack - view1.clock) < 2 * TICK_MS && Math.hypot(G.game.car!.x - at.x, G.game.car!.y - at.y) > 50 && errs.length > 150 && max < 1,
      `clock ${view1.clock.toFixed(0)} -> ${clockBack.toFixed(0)}; ${errs.length} samples after, max ${max.toFixed(3)}`,
    );
    // The countdown phase: paused, then the countdown starts over with its own cues.
    H.game.restartRace();
    H.flush();
    G.flush();
    drive(60);
    cues.splice(0);
    H.game.pause();
    const pausedCd = room.paused && (room.phase as string) === "countdown";
    drive(240);
    const cdPaused = cues.splice(0).join();
    const ends = G.game.phaseEnds;
    H.game.resume();
    drive(1);
    const restarted = G.game.phase === "countdown" && !G.game.paused && G.game.phaseEnds === G.game.raceStart && G.game.phaseEnds > ends;
    while (room.phase !== "racing") drive(1);
    drive(30);
    check(
      "pause client: paused in the countdown no cue plays; the resume starts the countdown over and its cues play once (no resume 3-2-1 on top)",
      pausedCd && cdPaused === "" && restarted && cues.join() === "countdown:beep,countdown:beep,countdown:beep,countdown:go",
      `paused: ${cdPaused || "-"}; after: ${cues.join()}`,
    );
  } finally {
    performance.now = realNow;
  }
}

// ---- more songs (SND-5, PLAN-SOUND.md, 2026-11-18): the registry, structure, setSong ------

// This section's imports (hoisted like the ones at the top).
import { DEFAULT_SONG_ID, MusicPlayer, SONG_LIST, SONG_XFADE_S, SONGS, songById, type Song } from "../client/music";

/** The style each song was asked for (ticket SND-5): its BPM range. The user kept two of the four new songs. */
const SONG_BPM: Record<string, [number, number]> = {
  "neon-tailpipe": [110, 128], // synthwave chase, the default (user, 2026-11-18)
  "rust-bucket": [110, 128],
  mirrorball: [118, 124], // 80s disco
};

function songs(): void {
  // The registry: the default first, ids and titles unique, the SND-1 export kept (now the default).
  const ids = SONGS.map((s) => s.id);
  check(
    "songs: a registry of three (Neon Tailpipe the default, SONG points at it; Rust Bucket Shuffle and Mirrorball Pit Stop selectable), unique ids and titles, the picker list matches",
    SONGS.length === 3 && ids[0] === "neon-tailpipe" && DEFAULT_SONG_ID === "neon-tailpipe" && SONG === SONGS[0] && SONG.title === "Neon Tailpipe" &&
      songById("rust-bucket").title === "Rust Bucket Shuffle" && songById("mirrorball").title === "Mirrorball Pit Stop" &&
      new Set(ids).size === 3 && new Set(SONGS.map((s) => s.title)).size === 3 && SONGS.every((s) => s.title.length > 0 && s.title.length <= 24) &&
      SONG_LIST.map((x) => `${x.id}:${x.title}`).join() === SONGS.map((s) => `${s.id}:${s.title}`).join() && Object.keys(SONG_BPM).join() === ids.join(),
    SONGS.map((s) => `${s.id} "${s.title}"`).join(", "),
  );
  check(
    "songs: an unknown, empty or missing id (incl. the two songs the user dropped) falls back to the default, Neon Tailpipe; a known id finds its song",
    [songById("nope"), songById(""), songById(undefined), songById(null), songById("gravel-surf"), songById("grease-monkey")].every((x) => x === SONG && x.id === "neon-tailpipe") &&
      ids.every((id) => songById(id).id === id),
  );

  for (const s of SONGS) {
    const n = s.steps.length;
    const sec = stepSeconds(s.bpm);
    const loop = n * sec;
    const [lo, hi] = SONG_BPM[s.id];
    const covered = s.sections.reduce((at, x) => (x.bar === at && x.bars > 0 ? at + x.bars : -1), 0);
    const names = s.sections.map((x) => x.name);
    let leadEnd = 0;
    let leadOk = true;
    let bassOk = true;
    let chordOk = true;
    let drumOk = true;
    let downbeats = true;
    s.steps.forEach((e, i) => {
      if (e.lead) {
        leadOk &&= i >= leadEnd && Number.isInteger(e.lead.len) && e.lead.len > 0 && i + e.lead.len <= n && e.lead.midi >= midiOf("C4") && e.lead.midi <= midiOf("C6");
        leadEnd = i + e.lead.len;
      }
      if (e.bass) bassOk &&= Number.isInteger(e.bass.len) && e.bass.len > 0 && i + e.bass.len <= n && e.bass.midi >= midiOf("A1") && e.bass.midi <= midiOf("C4");
      if (e.chord) chordOk &&= e.chord.len > 0 && i + e.chord.len <= n && e.chord.vel > 0 && e.chord.midi.length >= 3 && e.chord.midi.every((m) => m >= midiOf("C3") && m <= midiOf("C6"));
      drumOk &&= e.drums.every((d) => d.vel > 0 && d.vel <= 1);
      if (i % s.stepsPerBar === 0) downbeats &&= e.drums.some((d) => d.kind === "kick" || d.kind === "tom");
    });
    check(
      `songs ${s.id}: BPM ${lo}-${hi}; bars x stepsPerBar = steps; A/B sections cover the loop in order; a 50-70 s loop`,
      s.bpm >= lo && s.bpm <= hi && s.stepsPerBar === 16 && n === s.bars * s.stepsPerBar && covered === s.bars && names.includes("A") && names.includes("B") &&
        loop >= 50 && loop <= 70,
      `"${s.title}" ${s.bpm} BPM, ${s.bars} bars x ${s.stepsPerBar} = ${n} steps, sections ${s.sections.map((x) => `${x.name}@${x.bar + 1}`).join(" ")}, loop ${loop.toFixed(1)} s`,
    );
    check(
      `songs ${s.id}: a mono lead C4-C6 and a bass A1-C4 with whole-step lengths inside the loop; chords of 3+ notes; a kick or tom on every downbeat`,
      leadOk && bassOk && chordOk && drumOk && downbeats,
      `lead ${leadOk}, bass ${bassOk}, chords ${chordOk}, drums ${drumOk}, downbeats ${downbeats}`,
    );

    // On the beat grid: the clock hands out every step on the 16th grid of the song's BPM.
    const clock = new StepClock(sec);
    clock.start(7.3);
    const t0 = clock.timeOf(0);
    let now = 7.3;
    const due: { step: number; time: number }[] = [];
    while (due.length < n + 8) {
      now += SEQ_TIMER_MS / 1000;
      due.push(...clock.due(now, true));
    }
    const beat = 60 / s.bpm;
    const grid = due.every((d) => Math.abs(d.time - (t0 + d.step * sec)) < 1e-9) && due.every((d) => d.step % 4 || Math.abs(d.time - (t0 + (d.step / 4) * beat)) < 1e-9);
    check(`songs ${s.id}: every step lands on the ${s.bpm} BPM grid (beats on the beat)`, grid && due.length >= n, `${due.length} steps, grid ${grid}`);
  }

  // The styles asked for (PLAN-SOUND.md SND-5).
  const by = (id: string): Song => songById(id);
  /** The share of the song's steps matching pred (step in bar) that have this drum. */
  const hitsAt = (s: Song, kind: string, pred: (step: number) => boolean) => {
    const at = s.steps.filter((_, i) => pred(i % 16));
    return at.filter((e) => e.drums.some((d) => d.kind === kind)).length / at.length;
  };
  const disco = by("mirrorball");
  const octaves = disco.steps.filter((e, i) => e.bass && disco.steps[i + 2]?.bass && Math.abs(disco.steps[i + 2].bass!.midi - e.bass.midi) === 12).length;
  check(
    "songs mirrorball (80s disco): a kick on every beat, open hats on the off-beat 8ths (the fill bar aside), octave-jumping bass, string-like chord stabs (detuned saws)",
    hitsAt(disco, "kick", (k) => k % 4 === 0) === 1 && hitsAt(disco, "ohat", (k) => k % 4 === 2) >= 0.95 && octaves > disco.bars * 4 &&
      disco.steps.filter((e) => e.chord && !e.chord.swell).length >= 16 && disco.inst.chord.wave === "sawtooth" && (disco.inst.chord.unison ?? 0) > 0,
    `kick on ${(hitsAt(disco, "kick", (k) => k % 4 === 0) * 100).toFixed(0)} % of beats, open hat on ${(hitsAt(disco, "ohat", (k) => k % 4 === 2) * 100).toFixed(1)} % of off-beats, octave jumps ${octaves}, stabs ${disco.steps.filter((e) => e.chord && !e.chord.swell).length}`,
  );
  const synth = by("neon-tailpipe");
  const pulsing = synth.steps.filter((e) => e.bass).length / synth.steps.length;
  check(
    "songs neon-tailpipe (synthwave chase): 16th-note bass arpeggios (root, fifth, octave) most of the time, a bright detuned saw lead with an echo, a gated snare",
    pulsing > 0.9 && new Set(synth.steps.map((e, i) => e.bass && (e.bass.midi - synth.steps[i - (i % 16)].bass!.midi + 120) % 12)).size >= 3 &&
      synth.inst.lead.wave === "sawtooth" && (synth.inst.lead.unison ?? 0) > 0 && !!synth.inst.lead.echo && !!synth.inst.echo && (synth.inst.kit.snare.gate ?? 0) > 0.1,
    `bass on ${(pulsing * 100).toFixed(0)} % of steps`,
  );
}

// A recording stand-in for an AudioContext: every node, connection, start and gain ramp.
class RecParam {
  value = 0;
  readonly events: string[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) { this.events.push(`set ${v} ${t}`); }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(`lin ${v} ${t}`); }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(`exp ${v} ${t}`); }
  setTargetAtTime(v: number, t: number) { this.events.push(`tgt ${v} ${t}`); }
  cancelScheduledValues() {}
}
class RecNode {
  readonly outs = new Set<unknown>();
  readonly gain = new RecParam(1);
  readonly frequency = new RecParam();
  readonly detune = new RecParam();
  readonly Q = new RecParam();
  readonly delayTime = new RecParam();
  type = "";
  buffer: unknown = null;
  loop = false;
  started: number | null = null;
  onended: (() => void) | null = null;
  constructor(readonly kind: string, readonly ctx: RecContext) {
    ctx.nodes.push(this);
  }
  connect<T>(n: T): T { this.outs.add(n); return n; }
  disconnect() { this.outs.clear(); }
  start(t: number) { this.started = t; this.ctx.starts.push({ kind: this.kind, t }); }
  stop() {}
  setPeriodicWave() {}
  addEventListener(_: string, fn: () => void) { this.onended ??= fn; }
}
class RecContext {
  currentTime = 0;
  readonly nodes: RecNode[] = [];
  readonly starts: { kind: string; t: number }[] = [];
  createOscillator() { return new RecNode("osc", this); }
  createGain() { return new RecNode("gain", this); }
  createBiquadFilter() { return new RecNode("biquad", this); }
  createBufferSource() { return new RecNode("noise", this); }
  createDelay() { return new RecNode("delay", this); }
  createPeriodicWave() { return {}; }
}

function songPlayer(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, clearTimeout: g.clearTimeout };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const ctx = new RecContext();
  const fire = () => {
    // Run every timer due by the audio clock (ms timers on the same clock here).
    for (let guard = 0; guard < 1000; guard++) {
      const due = [...timers].filter(([, x]) => x.at <= ctx.currentTime * 1000).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  Object.assign(g, {
    window: { setTimeout: (fn: () => void, ms: number) => (timers.set(nextId, { at: ctx.currentTime * 1000 + ms, fn }), nextId++) },
    clearTimeout: (id: number) => timers.delete(id),
  });
  try {
    const musicBus = new RecNode("bus", ctx);
    let running = true;
    const engine = { ctx, buses: { music: musicBus }, noise: {}, running: () => running } as unknown as AudioEngine;
    const music = new MusicPlayer(engine);
    const advance = (s: number) => {
      const end = ctx.currentTime + s;
      while (ctx.currentTime < end - 1e-9) {
        ctx.currentTime = Math.min(end, ctx.currentTime + SEQ_TIMER_MS / 1000);
        fire();
      }
    };
    const fades = () => ctx.nodes.filter((n) => n.kind === "gain" && n.outs.has(musicBus));

    // Off: the default is picked; setSong only picks the song for the next start.
    const firstPick = music.song === SONG;
    music.setSong("mirrorball");
    const offPick = music.song.id === "mirrorball" && !music.playing && ctx.nodes.length === 1 && timers.size === 0;
    music.forced = true;
    music.update(false, "lobby");
    advance(1);
    const starts0 = ctx.starts.length;
    const run1 = music.playingSong?.id;
    const firstSteps = ctx.starts.filter((x) => x.kind === "osc").map((x) => x.t);
    const gridOk = firstSteps.every((t) => Math.abs(((t - firstSteps[0]) / stepSeconds(120)) - Math.round((t - firstSteps[0]) / stepSeconds(120))) < 1e-6);
    check(
      "songs player: the default is picked at first; setSong while off only picks (no nodes, no timer); the next start plays that song from the top on its own BPM grid",
      firstPick && offPick && run1 === "mirrorball" && music.playing && starts0 > 10 && gridOk && fades().length === 1 && music.position().bar === 0,
      `picked ${offPick}, playing ${run1}, ${starts0} voices in 1 s, bar ${music.position().bar + 1} step ${music.position().step}`,
    );

    // On: a short crossfade, the new song from the top; the old one keeps playing until it is silent.
    const oldFade = fades()[0];
    const switchAt = ctx.currentTime;
    const nodesAtSwitch = ctx.nodes.length;
    music.setSong("neon-tailpipe");
    const newFade = fades().find((n) => n !== oldFade);
    const xOld = oldFade.gain.events.at(-1);
    const xNew = newFade?.gain.events.at(-1);
    const at = (e: string | undefined) => Number(e?.split(" ")[2]);
    advance(SONG_XFADE_S / 2);
    const oldNotesAfter = ctx.nodes.slice(nodesAtSwitch).filter((n) => n.outs.has(oldFade)).length; // the old song still scheduling
    const oldStillScheduled = oldNotesAfter > 0 && fades().length === 2;
    advance(SONG_XFADE_S);
    advance(0.4); // the 300 ms disconnect timer
    check(
      `songs player: setSong while playing crossfades over ${SONG_XFADE_S} s (old ramps to 0, new from 0 to 1, the new song from bar 1); after it only the new song is connected`,
      music.playingSong?.id === "neon-tailpipe" && !!xOld?.startsWith("lin 0 ") && Math.abs(at(xOld) - (switchAt + SONG_XFADE_S)) < 1e-9 && !!xNew?.startsWith("lin 1 ") &&
        Math.abs(at(xNew) - (switchAt + SONG_XFADE_S)) < 1e-9 && oldStillScheduled && fades().length === 1 && fades()[0] === newFade && oldFade.outs.size === 0,
      `old ${xOld}, new ${xNew}, old-song notes during the fade ${oldNotesAfter}, connected fades ${fades().length}`,
    );

    // The echo of the old song (mirrorball's) is disconnected with its run; the new song's (neon's) plays on.
    const delays = ctx.nodes.filter((n) => n.kind === "delay");
    check(
      "songs player: a song's echo goes with its run (the old song's delay loop is disconnected on the switch, the new one's connected)",
      delays.length === 2 && delays[0].outs.size === 0 && delays[1].outs.size > 0,
      `${delays.length} delay nodes, connected ${delays.map((d) => d.outs.size > 0).join("/")}`,
    );

    // The same id again: nothing; another song: a switch; an unknown id: back to the default.
    const before = ctx.nodes.length;
    music.setSong("neon-tailpipe");
    const same = ctx.nodes.length === before;
    music.setSong("rust-bucket");
    const rust = music.playingSong?.id;
    music.setSong("no-such-song");
    check(
      "songs player: picking the playing song again does nothing; an unknown id picks (and switches to) the default, Neon Tailpipe",
      same && rust === "rust-bucket" && music.song === SONG && music.playingSong === SONG && SONG.id === "neon-tailpipe",
      `same ${same}, then ${rust}, now ${music.playingSong?.id}`,
    );

    // Countdown: fading out; a song picked then plays when the lobby comes back (resume -> switch).
    music.forced = undefined;
    advance(1);
    music.update(true, "lobby"); // following the game, in a room: still on
    music.update(true, "countdown");
    const fading = music.director.mode === "fading";
    music.setSong("mirrorball");
    const stillOld = music.playingSong === SONG;
    music.update(true, "lobby");
    check(
      "songs player: a song picked during the fade-out does not cut in; it starts (crossfading) when the lobby comes back",
      fading && stillOld && music.playingSong?.id === "mirrorball" && music.director.mode === "on",
      `fading ${fading}, kept ${stillOld}, then ${music.playingSong?.id}`,
    );

    // Stop: everything disconnects (fades now; each note when it ends).
    music.update(true, "countdown");
    advance(MUSIC_FADE_OUT_S + 0.1);
    music.update(true, "racing");
    advance(0.5);
    for (const n of ctx.nodes) n.onended?.();
    const left = ctx.nodes.filter((n) => n !== musicBus && n.outs.size > 0);
    check(
      "songs player: after the race starts every node is disconnected (fades by the player, notes on ended), no timer left",
      !music.playing && music.director.mode === "off" && left.length === 0 && timers.size === 0,
      `${ctx.nodes.length} nodes, still connected ${left.map((n) => n.kind).join(",") || "none"}, timers ${timers.size}`,
    );

    // Hidden while playing: nothing is scheduled; the next start plays the picked song.
    running = false;
    music.forced = true;
    music.update(false, "lobby");
    const hiddenNone = !music.playing;
    running = true;
    music.update(false, "lobby");
    check("songs player: nothing starts while the tab is hidden; on return the picked song starts", hiddenNone && music.playingSong?.id === "mirrorball", `then ${music.playingSong?.id}`);
    music.forced = false;
    music.update(false, "lobby");
  } finally {
    Object.assign(g, saved);
  }
}

// ---- own rivets after a predicted recovery or respawn (ClickUp 123jpnbfayd, 2026-11-18) ----

// This section's imports (hoisted like the ones at the top).
import { findTrack } from "../shared/tracks";
// The server ghosts a car from its recovery (and after a wreck respawn) and refuses its shots;
// the client must predict that ghost itself, because the latest snapshot still shows the car
// not ghosted for a round trip after the predicted recovery.

/**
 * A client Game on a Rooms server over an in-process link that delays every message by
 * oneWayMs each way (0: inputs reach the server at once, as in wiredGame). up() hands the
 * server the inputs due by now, down() hands the client the messages due by now.
 */
function laggedGame(rooms: Rooms, clock: { now: number }, oneWayMs: number): { game: Game; open(): void; up(): void; down(): void } {
  const toClient: { at: number; m: ServerMsg }[] = [];
  const toServer: { at: number; m: ClientMsg }[] = [];
  const session: Session = { conn: { send: (m) => void toClient.push({ at: clock.now + oneWayMs, m: decode<ServerMsg>(encode(m))! }), close() {} }, room: null, player: null };
  const deliver = (m: ClientMsg) => rooms.onMessage(session, decode<ClientMsg>(encode(m)), clock.now);
  const tr: Transport = {
    send: (m) => (oneWayMs === 0 ? deliver(m) : void toServer.push({ at: clock.now + oneWayMs, m })),
    close() {},
    onOpen() {},
    onMessage() {},
    onClose() {},
  };
  const game = new Game(() => tr, { get: () => null, set() {} });
  return {
    game,
    open: () => tr.onOpen(),
    up: () => {
      while (toServer.length && toServer[0].at <= clock.now) deliver(toServer.shift()!.m);
    },
    down: () => {
      while (toClient.length && toClient[0].at <= clock.now) tr.onMessage(toClient.shift()!.m);
    },
  };
}

interface GhostRivetRun {
  cues: number; // own "shot" cues (step() only)
  drawn: number; // local shots drawn
  fired: number; // rivets the server fired (ammo delta)
  /** Loop ticks of the predicted event (recover cue / respawn), the server's, and the shots. */
  predictedAt: number;
  serverAt: number;
  cueTicks: number[];
  serverTicks: number[];
  recErrs: number;
}

/**
 * One car alone on the T1b track, weapons armed, rivet gun held. "fall": it waits for the
 * weapons, fires 30 ticks standing, then the jump-then-roll-off script drives it into the
 * second gap and through the recovery, still firing, then 150 ticks more. "wreck": it fires
 * standing and the server wrecks it (combat.damage), then 250 ticks more (respawn + ghost).
 * Then the gun is released and every input in flight drains.
 */
function ghostRivetRun(kind: "fall" | "wreck", rttMs: number): GhostRivetRun {
  const realNow = performance.now.bind(performance);
  const clock = { now: realNow() };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const J = laggedGame(rooms, clock, rttMs / 2);
    let i = 0;
    const step = (ctl: Controls) => {
      i++;
      clock.now += 1000 / 60;
      J.up();
      rooms.step(clock.now);
      J.down();
      J.game.step(ctl, 1000 / 60);
    };
    const until = (done: () => boolean, max = 600) => {
      for (let k = 0; k < max && !done(); k++) step(NO_CONTROLS);
    };
    J.game.create("Gunner");
    J.open();
    until(() => !!J.game.you);
    J.game.pickTrack(T1B_ID);
    until(() => J.game.trackId === T1B_ID);
    J.game.start();
    const room = [...rooms.rooms.values()][0];
    until(() => room.phase === "racing" && !!J.game.car);
    const me = room.players.get(J.game.you)!;
    me.ammo.rivets = 200;
    const ammo0 = me.ammo.rivets;
    const script = new JumpFallScript(trackById(T1B_ID));
    const out: GhostRivetRun = { cues: 0, drawn: 0, fired: 0, predictedAt: -1, serverAt: -1, cueTicks: [], serverTicks: [], recErrs: 0 };
    const drawnIds = new Set<number>();
    let stage: "wait" | "stand" | "drive" | "hold" | "drain" | "end" = "wait";
    let n = 0;
    let lastAmmo = me.ammo.rivets;
    let serverFall = false;
    let serverWreck = false;
    let predWreck = false;
    for (let k = 0; k < 60 * 60 && stage !== "end"; k++) {
      const c = J.game.car;
      const drive = stage === "drive" ? script.controls(c) : NO_CONTROLS;
      const wasPredWreck = (c?.wreck ?? 0) > 0;
      step({ ...drive, fire: stage !== "drain" }); // held from the start: the client sends it once armed
      const nc = J.game.car;
      for (const cue of J.game.takeOwnSounds()) {
        if (cue.k === "shot") {
          out.cues++;
          out.cueTicks.push(i);
        } else if (cue.k === "recover" && out.predictedAt < 0) out.predictedAt = i;
      }
      if (kind === "wreck" && wasPredWreck && nc && nc.wreck === 0 && out.predictedAt < 0) out.predictedAt = i;
      predWreck ||= (nc?.wreck ?? 0) > 0;
      for (const s of J.game.localShots) drawnIds.add(s.id);
      if (me.ammo.rivets < lastAmmo) out.serverTicks.push(i);
      lastAmmo = me.ammo.rivets;
      const sc = me.car!;
      if (serverFall && sc.fall === 0 && out.serverAt < 0 && kind === "fall") out.serverAt = i;
      serverFall ||= sc.fall > 0;
      if (serverWreck && sc.wreck === 0 && out.serverAt < 0 && kind === "wreck") out.serverAt = i;
      serverWreck ||= sc.wreck > 0;
      n++;
      if (stage === "wait" && J.game.armed() && J.game.predictedAmmo()[0] > 0) [stage, n] = ["stand", 0];
      else if (stage === "stand" && n >= 30) {
        if (kind === "fall") [stage, n] = ["drive", 0];
        else {
          room.combat.damage(me, me.hp, "nobody", "rivet");
          [stage, n] = ["hold", 0];
        }
      } else if (stage === "drive" && script.done()) [stage, n] = ["hold", 0];
      else if (stage === "hold" && n >= (kind === "fall" ? 150 : 250)) [stage, n] = ["drain", 0];
      else if (stage === "drain" && n >= 60 && J.game.pending.length === 0) stage = "end";
      else if (stage === "drain" && n >= 600) stage = "end";
    }
    out.drawn = drawnIds.size;
    out.fired = ammo0 - me.ammo.rivets;
    out.recErrs = J.game.recStateErrors;
    if (kind === "wreck" && !predWreck) out.predictedAt = -2; // the client never saw the wreck
    return out;
  } finally {
    performance.now = realNow;
  }
}

function ghostRivets(): void {
  if (!findTrack(T1B_ID)) registerTestTrack(T1B_DEF); // jumpsWired registers it first
  for (const rtt of [0, 70]) {
    const r = ghostRivetRun("fall", rtt);
    const inGhost = r.cueTicks.filter((t) => t >= r.predictedAt && t <= r.predictedAt + GHOST_TICKS).length;
    const after = r.cueTicks.filter((t) => t > r.predictedAt + GHOST_TICKS);
    const serverAfter = r.serverTicks.filter((t) => t > r.serverAt).length;
    const detail = `cues ${r.cues}, drawn ${r.drawn}, server fired ${r.fired}; predicted recover @${r.predictedAt}, server @${r.serverAt}; cues in the ghost ${inGhost}, after ${after.length} (first @${after[0] ?? "-"}), server shots after its recover ${serverAfter}`;
    check(
      `ghost rivets ${rtt} ms: holding fire through a fall and recovery, own rivet cues == local shots drawn == rivets the server fired`,
      r.predictedAt > 0 && r.serverAt > 0 && r.cues === r.drawn && r.drawn === r.fired && r.fired > 0,
      detail,
    );
    check(
      `ghost rivets ${rtt} ms: no own shot inside the predicted ghost; firing resumes after it (on both sides)`,
      inGhost === 0 && after.length > 0 && serverAfter > 0 && after[0] - (r.predictedAt + GHOST_TICKS) <= RIVET_COOLDOWN + 2 + Math.ceil((rtt / 1000) * 60) + SNAPSHOT_EVERY,
      detail,
    );
  }
  // The wreck itself comes from the server unannounced (a hit can't be predicted), so shots
  // predicted in the round trip before the client sees it are another gap: compare from the
  // respawn on (the predicted one for the client, the server's for the server).
  for (const rtt of [0, 70]) {
    const r = ghostRivetRun("wreck", rtt);
    const cues = r.cueTicks.filter((t) => t >= r.predictedAt).length;
    const fired = r.serverTicks.filter((t) => t >= r.serverAt).length;
    const inGhost = r.cueTicks.filter((t) => t >= r.predictedAt && t <= r.predictedAt + GHOST_TICKS).length;
    const after = r.cueTicks.filter((t) => t > r.predictedAt + GHOST_TICKS);
    const detail = `all: cues ${r.cues}, drawn ${r.drawn}, server fired ${r.fired}; from the respawn: cues ${cues}, server fired ${fired}; predicted respawn @${r.predictedAt}, server @${r.serverAt}; cues in the ghost ${inGhost}, after ${after.length} (first @${after[0] ?? "-"})`;
    check(
      `ghost rivets ${rtt} ms: holding fire through a wreck respawn, own rivet cues from the respawn == rivets the server fired from its respawn; none in the ghost, firing resumes`,
      r.predictedAt > 0 && r.serverAt > 0 && r.cues === r.drawn && cues === fired && fired > 0 && inGhost === 0 &&
        after[0] - (r.predictedAt + GHOST_TICKS) <= RIVET_COOLDOWN + 2 + Math.ceil((rtt / 1000) * 60) + SNAPSHOT_EVERY,
      detail,
    );
  }
}

// ---- mines stay or fade (MINES-1, ClickUp 123jpnbfdq6, 2026-11-20) -----------------------

// This section's imports (hoisted like the ones at the top).
import { MINES_BURST, MINES_PER_SEC, type MineSnap } from "../shared/protocol";
import { DEFAULT_MINE_MODE, MINE_BLINK_FAST_TICKS, MINE_CAP, MINE_FADE_TICKS, MINE_MODES, MINE_OUT_TICKS, isMineMode, type MineMode } from "../shared/weapons";

const mineSnapsOf = (c: FakeConn) => (lastSnapOf(c)?.ents ?? []).filter((e): e is MineSnap => e.k === "mine");

/**
 * A two-car race on one lap in the given mines mode (set in the lobby), weapons armed, the cars
 * parked far apart and far from where the mines will lie. `ammo`: mines handed to each driver
 * after the start (the garage's cap is 3).
 */
function mineRace(mode: MineMode, ammo = 3): { sim: Sim; a: Player; b: Player } {
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  if (mode !== sim.room.mines && sim.room.setMines(a, mode, sim.now)) throw new Error("setMines refused");
  sim.startRace(a);
  sim.armWeapons();
  a.ammo.mines = b.ammo.mines = ammo;
  sim.place(a, 300, 0);
  sim.place(b, FAR, 0);
  return { sim, a, b };
}

const FAR = 5000; // where the second car waits: far from the mines (they lie from 300 on, 30 apart)

/** Step to a tick that sent a snapshot (every other one). */
function toSnapTick(sim: Sim): void {
  if (sim.tickNo % 2) sim.run(1);
}

/** p drops one mine where it stands (two ticks: the press, then one more for the jitter buffer). */
function dropMine(sim: Sim, p: Player): void {
  sim.run(1, (q) => (q === p ? { mine: true } : {}));
  sim.run(1);
}

/** Park p's car on the spot (x, y) and step once; true if a mine hit it. */
function driveOver(sim: Sim, p: Player, x: number, y: number): boolean {
  const hits = sim.eventsOf("hit").length;
  p.car = { ...p.car!, x, y, vx: 0, vy: 0, seg: queryTrack(sim.room.track, x, y).seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  p.ghost = 0;
  sim.run(1);
  return sim.eventsOf("hit").length > hits;
}

/** The setting: default, the host's command, what is refused, the rate budget, handover, rejoin, a new room. */
function minesSetting(): void {
  const R = menuRooms(["Ann", "Bo", "Cy"]);
  const [, b] = R.p;
  const first = [0, 1, 2].map((i) => lastRoomMsg(R.s[i].conn)!);
  check(
    "mines: a new room starts with Stay, in everyone's room message and for the race's combat",
    DEFAULT_MINE_MODE === "stay" && R.room.mines === "stay" && R.room.combat.mode === "stay" && first.every((m) => m.mines === "stay") && MINE_MODES.join() === "stay,fade",
    first.map((m) => m.mines).join(),
  );
  // Host only.
  const e1 = errsOf(R.s[1].conn).length;
  const n1 = roomMsgs(R.s[2].conn).length;
  R.send(1, { t: "mines", mode: "fade" });
  check(
    "mines: from anyone but the host it is refused with an err; nothing changes, nothing is sent",
    errsOf(R.s[1].conn).slice(e1).join() === "Only the host can set the mines" && R.room.mines === "stay" && roomMsgs(R.s[2].conn).length === n1,
    errsOf(R.s[1].conn).slice(e1).join(),
  );
  // The host: one room message for everyone.
  R.send(0, { t: "mines", mode: "fade" });
  const got = [0, 1, 2].map((i) => lastRoomMsg(R.s[i].conn)!.mines);
  check("mines: the host picks Fade: one room message with it reaches everyone", R.room.mines === "fade" && got.join() === "fade,fade,fade" && roomMsgs(R.s[2].conn).length === n1 + 1 && errsOf(R.s[0].conn).length === 0, got.join());
  // Wrong types and unknown modes: refused, nothing changes, nothing sent.
  const bad: unknown[] = ["blink", "Stay", "", 1, 0, true, null, undefined, ["fade"], { mode: "stay" }];
  const e0 = errsOf(R.s[0].conn).length;
  for (const mode of bad) R.send(0, { t: "mines", mode } as unknown as ClientMsg);
  R.send(0, { t: "mines" } as unknown as ClientMsg);
  const errs = errsOf(R.s[0].conn).slice(e0);
  check(
    "mines: an unknown mode, a wrong case, a number, a boolean, null, an array, an object and no mode at all are refused (Bad mines setting); nothing changes, nothing is sent",
    errs.length === bad.length + 1 && errs.every((e) => e === "Bad mines setting") && R.room.mines === "fade" && roomMsgs(R.s[2].conn).length === n1 + 1 && bad.every((v) => !isMineMode(v)) && isMineMode("stay") && isMineMode("fade"),
    `${errs.length} errs: ${[...new Set(errs)].join("|")}`,
  );
  // Unchanged: no broadcast, no err, and no token taken.
  for (let i = 0; i < 20; i++) R.send(0, { t: "mines", mode: "fade" });
  check("mines: picking the current mode sends no room message and no err (20 times over)", roomMsgs(R.s[2].conn).length === n1 + 1 && errsOf(R.s[0].conn).length === e0 + errs.length);
  // The rate budget: one of MINES_BURST is spent (the pick above, at the room's first tick time).
  R.clock.now += 10000;
  const e2 = errsOf(R.s[0].conn).length;
  const flips: MineMode[] = [];
  const other = (): MineMode => (R.room.mines === "stay" ? "fade" : "stay");
  for (let i = 0; i < 8; i++) {
    R.send(0, { t: "mines", mode: other() });
    flips.push(R.room.mines);
  }
  const burst = errsOf(R.s[0].conn).slice(e2);
  R.clock.now += 1000;
  const before = R.room.mines;
  const n2 = roomMsgs(R.s[2].conn).length;
  for (let i = 0; i < 6; i++) R.send(0, { t: "mines", mode: other() });
  const later = errsOf(R.s[0].conn).slice(e2 + burst.length);
  check(
    `mines: ${MINES_BURST} changes at once, then Slow down (nothing changes); a second later ${MINES_PER_SEC} more`,
    burst.length === 8 - MINES_BURST && burst.every((e) => e === "Slow down") && flips.join() === "stay,fade,stay,fade,fade,fade,fade,fade" &&
      later.length === 6 - MINES_PER_SEC && later.every((e) => e === "Slow down") && roomMsgs(R.s[2].conn).length === n2 + MINES_PER_SEC && R.room.mines === before,
    `burst: ${flips.join()} (${burst.length} errs); later: ${later.length} errs, ${roomMsgs(R.s[2].conn).length - n2} room messages`,
  );
  // A handover keeps it; the old host is refused, the new one may change it.
  R.clock.now += 10000;
  R.send(0, { t: "mines", mode: "fade" });
  R.send(0, { t: "host", id: b.id });
  const after = lastRoomMsg(R.s[2].conn)!;
  const e3 = errsOf(R.s[0].conn).length;
  R.send(0, { t: "mines", mode: "stay" });
  const refused = errsOf(R.s[0].conn).slice(e3).join();
  const kept = R.room.mines;
  R.send(1, { t: "mines", mode: "stay" });
  check(
    "mines: a host handover keeps the setting; the old host is refused, the new one may change it",
    after.hostId === b.id && after.mines === "fade" && refused === "Only the host can set the mines" && kept === "fade" && R.room.mines === "stay" && lastRoomMsg(R.s[0].conn)!.mines === "stay",
    `after the handover ${after.mines}; old host: ${refused}; new host -> ${R.room.mines}`,
  );
  // The host leaves for good: the room's next host inherits the setting too.
  R.clock.now += 10000;
  R.send(1, { t: "mines", mode: "fade" });
  R.send(1, { t: "leave" });
  const inherited = lastRoomMsg(R.s[2].conn)!;
  check("mines: the host leaves: the setting stays with the room and its next host", inherited.hostId !== b.id && inherited.mines === "fade" && R.room.mines === "fade", `${inherited.mines}, host ${inherited.hostId === R.p[0].id ? "Ann" : "Cy"}`);
  // Rejoin: it comes with the room message after the welcome.
  R.rooms.onClose(R.s[2], R.clock.now);
  const back = R.join("Cy", R.p[2].token);
  check("mines: a rejoin gets the setting in its room message", lastRoomMsg(back.conn)?.mines === "fade", String(lastRoomMsg(back.conn)?.mines));
  // Gone with the room.
  for (const x of [R.s[0], back]) R.rooms.onMessage(x, { t: "leave" }, R.clock.now);
  R.step(1);
  const gone = !R.rooms.rooms.has(R.room.code);
  const R2 = menuRooms(["Dee"]);
  check("mines: gone with the room; a new room has Stay again", gone && R2.room.mines === "stay" && lastRoomMsg(R2.s[0].conn)?.mines === "stay", `room gone ${gone}; new room ${R2.room.mines}`);
}

/** Stay: a mine outlives 25 s and still goes off; the snapshot never marks it as on its way out. */
function minesStay(): void {
  const { sim, a, b } = mineRace("stay");
  dropMine(sim, a);
  const m = sim.room.combat.mines[0];
  const conn = sim.conns.get(b.id)!;
  let marked = 0;
  for (let i = 0; i < MINE_LIFE_TICKS + 600; i++) {
    sim.run(1);
    if (mineSnapsOf(conn).some((s) => s.out !== undefined)) marked++;
  }
  const still = sim.room.combat.mines[0];
  const snap = mineSnapsOf(conn);
  check(
    "mines stay: a mine is still on the track 10 s after the 25 s it used to live, armed, and never marked as blinking out",
    !!m && still === m && m.age > MINE_LIFE_TICKS + 590 && sim.room.combat.mode === "stay" && snap.length === 1 && snap[0].id === m.id && snap[0].armed && marked === 0,
    `age ${m?.age} ticks (life in fade ${MINE_LIFE_TICKS}); ${snap.length} in the snapshot, marked in ${marked} ticks`,
  );
  const hp = b.hp;
  const hit = driveOver(sim, b, m.x, m.y);
  check("mines stay: that old mine still goes off under a car (15 damage) and is used up", hit && b.hp === hp - MINE_DAMAGE && sim.room.combat.mines.length === 0, `hit ${hit}, hp ${hp} -> ${b.hp}`);
  // The race over: the results phase keeps the field as before, the lobby clears it.
  dropMine(sim, a);
  nearFinish(sim, a);
  sim.run(15, (p) => (p === a ? { throttle: 1 } : {}));
  nearFinish(sim, b);
  sim.run(15, (p) => (p === b ? { throttle: 1 } : {}));
  const inResults: string = sim.room.phase;
  while (sim.room.phase !== "lobby") sim.run(1);
  check("mines stay: the mines go when the race is over (back in the lobby none is left)", inResults === "results" && sim.room.combat.mines.length === 0 && sim.room.combat.gone.length === 0 && mineSnapsOf(conn).length === 0, `phase ${inResults} -> ${sim.room.phase}`);
}

/** Stay: the 41st mine takes the oldest off the track at once; it blinks out harmlessly. */
function minesCap(): void {
  const { sim, a, b } = mineRace("stay", MINE_CAP + 5);
  const conn = sim.conns.get(b.id)!;
  // Forty mines in a row along the track, 30 units apart.
  for (let i = 0; i < MINE_CAP; i++) {
    sim.place(a, 300 + i * 30, 0);
    dropMine(sim, a);
  }
  toSnapTick(sim);
  const ids = sim.room.combat.mines.map((m) => m.id);
  const oldest = sim.room.combat.mines[0];
  const second = sim.room.combat.mines[1];
  check(
    `mines cap: ${MINE_CAP} mines lie on the track at once, oldest first, none blinking out`,
    ids.length === MINE_CAP && ids.every((id, i) => i === 0 || id > ids[i - 1]) && sim.room.combat.gone.length === 0 && mineSnapsOf(conn).length === MINE_CAP && mineSnapsOf(conn).every((s) => s.out === undefined),
    `${ids.length} mines, ids ${ids[0]}..${ids[ids.length - 1]}`,
  );
  // The 41st: on the tick it is dropped the oldest is off the track.
  sim.place(a, 300 + MINE_CAP * 30, 0);
  sim.run(1, (q) => (q === a ? { mine: true } : {}));
  if (sim.room.combat.mines.length === MINE_CAP && sim.room.combat.gone.length === 0) sim.run(1); // the jitter buffer's tick
  const now = sim.room.combat.mines.map((m) => m.id);
  const gone = sim.room.combat.gone;
  const left0 = gone[0]?.left ?? -1;
  check(
    `mines cap: a ${MINE_CAP + 1}st mine takes the oldest off the track at once; ${MINE_CAP} remain, the 2nd oldest now first, the new one last`,
    now.length === MINE_CAP && !now.includes(oldest.id) && now[0] === second.id && now[now.length - 1] > ids[ids.length - 1] && now.slice(0, -1).join() === ids.slice(1).join() && gone.length === 1 && gone[0].mine === oldest,
    `on the track ${now.length} (ids ${now[0]}..${now[now.length - 1]}), blinking out: ${gone.map((g) => g.mine.id).join()} with ${left0} ticks left`,
  );
  // It is harmless at once, and shown blinking out: not armed, `out` counting down.
  const hp = b.hp;
  const hit = driveOver(sim, b, oldest.x, oldest.y);
  sim.place(b, FAR, 0);
  toSnapTick(sim);
  const shown = mineSnapsOf(conn).find((s) => s.id === oldest.id);
  const others = mineSnapsOf(conn).filter((s) => s.id !== oldest.id);
  const ageOf = new Map(sim.room.combat.mines.map((m) => [m.id, m.age]));
  check(
    "mines cap: the mine taken off is harmless at once (a car on it is not hit) and stays in the snapshots blinking out: not armed, out = the ticks left",
    !hit && b.hp === hp && !!shown && shown.armed === false && shown.out === sim.room.combat.gone[0]?.left && shown.out! > 0 && shown.out! < MINE_OUT_TICKS && others.length === MINE_CAP && others.every((s) => s.out === undefined && s.armed === ageOf.get(s.id)! >= MINE_ARM_TICKS) && others.filter((s) => s.armed).length > 20,
    `hit ${hit}; snapshot: armed ${shown?.armed}, out ${shown?.out} of ${MINE_OUT_TICKS}; ${others.length} others`,
  );
  // out counts down by one a tick; then the mine is gone from the snapshots.
  const outs: number[] = [];
  let lastSeen = -1;
  const t0 = sim.tickNo;
  for (let i = 0; i < MINE_OUT_TICKS + 10; i++) {
    sim.run(1);
    if (sim.tickNo % 2) continue;
    const s = mineSnapsOf(conn).find((x) => x.id === oldest.id);
    if (s) {
      outs.push(s.out!);
      lastSeen = sim.tickNo - t0;
    }
  }
  const steps = outs.every((o, i) => i === 0 || o === outs[i - 1] - 2);
  check(
    `mines cap: it blinks out for ${MINE_OUT_TICKS} ticks (out counts down a tick at a time to 1 or 2), then it is gone from the snapshots; the ${MINE_CAP} on the track are untouched`,
    outs.length > 20 && steps && outs[outs.length - 1] <= 2 && outs[outs.length - 1] >= 1 && sim.room.combat.gone.length === 0 && mineSnapsOf(conn).length === MINE_CAP && sim.room.combat.mines.map((m) => m.id).join() === now.join() && lastSeen + (shown ? MINE_OUT_TICKS - shown.out! : 0) <= MINE_OUT_TICKS,
    `out ${outs[0]}..${outs[outs.length - 1]} in ${outs.length} snapshots, last seen ${lastSeen} ticks on`,
  );
  // Two more: the next oldest go, in order (deterministic); and each of the 40 left still goes off.
  for (let i = 1; i <= 2; i++) {
    sim.place(a, 300 + (MINE_CAP + i) * 30, 0);
    dropMine(sim, a);
  }
  const then = sim.room.combat.mines.map((m) => m.id);
  const out2 = sim.room.combat.gone.map((g) => g.mine.id);
  check(
    "mines cap: two more mines take the next two oldest, in the order they were dropped",
    then.length === MINE_CAP && out2.join() === ids.slice(1, 3).join() && then[0] === ids[3],
    `blinking out ${out2.join()} (dropped 2nd and 3rd: ${ids.slice(1, 3).join()}); first on the track ${then[0]} (4th: ${ids[3]})`,
  );
  sim.place(a, FAR + 400, 0);
  let blasts = 0;
  for (const m of [...sim.room.combat.mines]) {
    b.hp = b.maxHp;
    if (driveOver(sim, b, m.x, m.y)) blasts++;
  }
  check(`mines cap: every one of the ${MINE_CAP} left on the track is live`, blasts === MINE_CAP && sim.room.combat.mines.length === 0, `${blasts} went off`);

  // Fade has no cap: its mines go by themselves.
  const F = mineRace("fade", MINE_CAP + 5);
  for (let i = 0; i < MINE_CAP + 3; i++) {
    F.sim.place(F.a, 300 + i * 30, 0);
    dropMine(F.sim, F.a);
  }
  check("mines cap: Fade takes no mine off the track early (today's rule: each lives its 25 s)", F.sim.room.combat.mines.length === MINE_CAP + 3 && F.sim.room.combat.gone.length === 0, `${F.sim.room.combat.mines.length} on the track`);
}

/** Fade: gone after 25 s as before; the snapshot marks its last 2 s; it is live to the end. */
function minesFade(): void {
  const { sim, a, b } = mineRace("fade");
  const conn = sim.conns.get(b.id)!;
  dropMine(sim, a);
  const m = sim.room.combat.mines[0];
  if (!m) return check("mines fade: a mine was dropped", false);
  const seen: { age: number; out: number | undefined; armed: boolean }[] = [];
  let goneAt = -1;
  for (let i = 0; i < MINE_LIFE_TICKS + 20 && goneAt < 0; i++) {
    const age = m.age;
    sim.run(1);
    if (!sim.room.combat.mines.includes(m)) goneAt = age + 1; // the age the step would have given it
    else if (sim.tickNo % 2 === 0) {
      const s = mineSnapsOf(conn).find((x) => x.id === m.id);
      if (s) seen.push({ age: m.age, out: s.out, armed: s.armed });
    }
  }
  check(
    "mines fade: a mine lives 25 s as before: on the track at age 1500 ticks, gone on the next tick, and gone from the snapshots",
    sim.room.combat.mode === "fade" && goneAt === MINE_LIFE_TICKS + 1 && MINE_LIFE_TICKS === 1500 && sim.room.combat.mines.length === 0 && (sim.run(2), mineSnapsOf(conn).length === 0),
    `gone at age ${goneAt}`,
  );
  const plain = seen.filter((s) => s.out === undefined);
  const marked = seen.filter((s) => s.out !== undefined);
  const exact = marked.every((s) => s.out === MINE_LIFE_TICKS - s.age + 1);
  check(
    "mines fade: the snapshot marks only a mine's last 2 s (out = the ticks until it is gone, 120 down to 1), and the mine stays armed all the way",
    MINE_FADE_TICKS === 120 && plain.length > 600 && plain.every((s) => s.age <= MINE_LIFE_TICKS - MINE_FADE_TICKS) && marked.length >= 59 && marked.length <= 60 && exact &&
      marked[0].out! >= MINE_FADE_TICKS - 1 && marked[0].out! <= MINE_FADE_TICKS && marked[marked.length - 1].out! <= 2 && marked.every((s) => s.armed) && MINE_BLINK_FAST_TICKS < MINE_FADE_TICKS,
    `${plain.length} snapshots without out (ages up to ${plain[plain.length - 1]?.age}), ${marked.length} with out ${marked[0]?.out}..${marked[marked.length - 1]?.out}`,
  );
  // Live to the end: a car over it in its last ticks is hit.
  dropMine(sim, a);
  const m2 = sim.room.combat.mines[0];
  while (m2.age < MINE_LIFE_TICKS - 3) sim.run(1);
  const out = mineSnapsOf(conn).find((x) => x.id === m2.id)?.out;
  const hp = b.hp;
  const hit = driveOver(sim, b, m2.x, m2.y);
  check("mines fade: a blinking mine is live to the end (3 ticks before it goes it still does 15 damage)", hit && b.hp === hp - MINE_DAMAGE && out !== undefined && out <= 5, `out ${out}, hit ${hit}, hp ${hp} -> ${b.hp}`);
  // Not armed yet is not marked either; arming is as before.
  sim.place(b, FAR, 0);
  dropMine(sim, a);
  toSnapTick(sim);
  const fresh = mineSnapsOf(conn)[0];
  check("mines fade: a mine just dropped is not armed and not marked", !!fresh && !fresh.armed && fresh.out === undefined && sim.room.combat.mines[0].age < MINE_ARM_TICKS, JSON.stringify(fresh));
}

/** A race keeps the mode it began with; a change applies from the next race (a restart is one). */
function minesAtStart(): void {
  // Begun in Stay, the host picks Fade during the countdown and again mid-race: still Stay.
  const sim = new Sim(1);
  const a = sim.add("Ann");
  const b = sim.add("Bo");
  sim.readyAll(a);
  sim.room.start(a, sim.now);
  const inCountdown: string = sim.room.phase;
  const e1 = sim.room.setMines(a, "fade", sim.now);
  while (sim.room.phase !== "racing") sim.run(1);
  sim.armWeapons();
  sim.place(a, 300, 0);
  sim.place(b, FAR, 0);
  dropMine(sim, a);
  const m = sim.room.combat.mines[0];
  sim.run(MINE_LIFE_TICKS + 60);
  const conn = sim.conns.get(b.id)!;
  check(
    "mines at the start: Fade picked in the countdown of a race begun in Stay: the room message says Fade, this race stays Stay (its mine outlives 25 s, unmarked)",
    inCountdown === "countdown" && e1 === null && sim.room.mines === "fade" && sim.lastRoom(b)?.mines === "fade" && sim.room.combat.mode === "stay" && sim.room.combat.mines[0] === m && m.age > MINE_LIFE_TICKS && mineSnapsOf(conn)[0]?.out === undefined,
    `setting ${sim.room.mines}, race ${sim.room.combat.mode}, mine age ${m?.age}`,
  );
  // A restart is a new race: it takes the setting, and clears the mines.
  const e2 = sim.room.restartRace(a, sim.now);
  const clearedByRestart = sim.room.combat.mines.length === 0 && sim.room.combat.gone.length === 0;
  while (sim.room.phase !== "racing") sim.run(1);
  sim.armWeapons();
  sim.place(a, 300, 0);
  sim.place(b, FAR, 0);
  dropMine(sim, a);
  const m2 = sim.room.combat.mines[0];
  // Back to Stay mid-race: this race stays Fade.
  sim.now += 10000;
  const e3 = sim.room.setMines(a, "stay", sim.now);
  sim.armWeapons();
  let goneAt = -1;
  for (let i = 0; i < MINE_LIFE_TICKS + 20 && goneAt < 0; i++) {
    const age = m2.age;
    sim.run(1);
    if (!sim.room.combat.mines.includes(m2)) goneAt = age + 1;
  }
  check(
    "mines at the start: the restart clears the mines and begins in the mode set by then (Fade); Stay picked mid-race changes the room message, not this race (its mine goes at 25 s)",
    e2 === null && clearedByRestart && e3 === null && sim.room.mines === "stay" && sim.lastRoom(b)?.mines === "stay" && sim.room.combat.mode === "fade" && goneAt === MINE_LIFE_TICKS + 1,
    `setting ${sim.room.mines}, race ${sim.room.combat.mode}, mine gone at age ${goneAt}`,
  );
  // Stop, then a new race: the setting (Stay) applies.
  dropMine(sim, a);
  const before = sim.room.combat.mines.length;
  const e4 = sim.room.stopRace(a, sim.now);
  const clearedByStop = sim.room.combat.mines.length === 0;
  sim.startRace(a);
  check("mines at the start: after a stop the next race begins in the mode set (Stay)", e4 === null && before === 1 && clearedByStop && sim.room.combat.mode === "stay" && sim.room.phase === "racing", `race ${sim.room.combat.mode}`);
  // A track change in the lobby (a new Combat) does not lose the setting.
  const s2 = new Sim(1);
  const h = s2.add("Ann");
  s2.add("Bo");
  s2.room.setMines(h, "fade", s2.now);
  s2.room.setTrack(h, "crusher-run");
  s2.startRace(h);
  check("mines at the start: the setting survives a track change in the lobby", s2.room.trackId === "crusher-run" && s2.room.mines === "fade" && s2.room.combat.mode === "fade", `${s2.room.trackId}: ${s2.room.combat.mode}`);
}

/** Stop and restart clear the mines in both modes, those blinking out too. */
function minesCleared(): void {
  for (const mode of MINE_MODES) {
    for (const how of ["stop", "restart"] as const) {
      const { sim, a, b } = mineRace(mode, MINE_CAP + 5);
      const conn = sim.conns.get(b.id)!;
      const n = mode === "stay" ? MINE_CAP + 1 : 5;
      for (let i = 0; i < n; i++) {
        sim.place(a, 300 + i * 30, 0);
        dropMine(sim, a);
      }
      if (mode === "fade") while (sim.room.combat.mines[0].age <= MINE_LIFE_TICKS - MINE_FADE_TICKS + 10) sim.run(1);
      toSnapTick(sim);
      const lying = sim.room.combat.mines.length;
      const blinking = mineSnapsOf(conn).filter((s) => s.out !== undefined).length;
      const e = how === "stop" ? sim.room.stopRace(a, sim.now) : sim.room.restartRace(a, sim.now);
      const none = sim.room.combat.mines.length === 0 && sim.room.combat.gone.length === 0;
      sim.run(2);
      const want = how === "stop" ? "lobby" : "countdown";
      check(
        `mines cleared: ${mode}, the host's ${how}: every mine is gone, the blinking ones too (${want}, none in the snapshots)`,
        e === null && lying === (mode === "stay" ? MINE_CAP : 5) && blinking > 0 && none && mineSnapsOf(conn).length === 0 && sim.room.phase === want && sim.room.mines === mode,
        `${lying} lying, ${blinking} blinking out -> ${sim.room.combat.mines.length + sim.room.combat.gone.length}; ammo back: ${a.ammo.mines}`,
      );
    }
  }
}

/** A pause freezes a mine's age (Fade) and a capped mine's blink-out (Stay). */
function minesPaused(): void {
  // Fade: paused inside the last 2 s.
  const { sim, a, b } = mineRace("fade");
  const conn = sim.conns.get(b.id)!;
  dropMine(sim, a);
  const m = sim.room.combat.mines[0];
  while (m.age < MINE_LIFE_TICKS - 50) sim.run(1);
  toSnapTick(sim);
  const age0 = m.age;
  const out0 = mineSnapsOf(conn)[0]?.out;
  if (sim.room.pause(a, sim.now)) throw new Error("pause refused");
  const outs = new Set<number | undefined>();
  for (let i = 0; i < 600; i++) {
    sim.run(1);
    outs.add(mineSnapsOf(conn)[0]?.out);
  }
  check(
    "mines paused: fade, 10 s paused 50 ticks before a mine goes: its age stands still, it stays on the track, and every snapshot carries the same out",
    sim.room.paused && sim.room.combat.mines[0] === m && m.age === age0 && out0 === MINE_LIFE_TICKS - age0 + 1 && outs.size === 1 && outs.has(out0),
    `age ${age0} -> ${m.age}, out ${out0} -> ${[...outs].join()}`,
  );
  sim.room.resume(a, sim.now);
  runPaused(sim, () => ({}));
  let stepped = 0;
  while (sim.room.combat.mines.includes(m) && stepped < 200) {
    sim.run(1);
    stepped++;
  }
  // runPaused's last tick is the first that steps again (age0 + 1).
  check("mines paused: after the resume the mine lives out exactly what was left of its 25 s", !sim.room.combat.mines.includes(m) && stepped === MINE_LIFE_TICKS - age0, `${stepped} more ticks (left at the pause: ${MINE_LIFE_TICKS - age0 + 1}, one of them the resume's tick)`);

  // Stay: paused while a capped mine blinks out.
  const S = mineRace("stay", MINE_CAP + 2);
  const sconn = S.sim.conns.get(S.b.id)!;
  for (let i = 0; i < MINE_CAP + 1; i++) {
    S.sim.place(S.a, 300 + i * 30, 0);
    dropMine(S.sim, S.a);
  }
  S.sim.run(9);
  toSnapTick(S.sim);
  const left0 = S.sim.room.combat.gone[0]?.left ?? -1;
  const ages0 = S.sim.room.combat.mines.map((x) => x.age).join();
  if (S.sim.room.pause(S.a, S.sim.now)) throw new Error("pause refused");
  S.sim.run(300);
  const shown = mineSnapsOf(sconn).filter((s) => s.out !== undefined);
  check(
    "mines paused: stay, 5 s paused while a capped mine blinks out: its countdown and the other mines' ages stand still, it stays in the snapshots",
    left0 > 0 && left0 < MINE_OUT_TICKS && S.sim.room.combat.gone[0]?.left === left0 && S.sim.room.combat.mines.map((x) => x.age).join() === ages0 && shown.length === 1 && shown[0].out === left0,
    `ticks left ${left0} -> ${S.sim.room.combat.gone[0]?.left}; in the snapshot out ${shown[0]?.out}`,
  );
}

/** The client: Game.mines follows the room message, falls back to Stay, and the host's pick is sent. */
function minesClient(): void {
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock);
  const B = wiredGame(rooms, clock);
  const flushAll = () => {
    for (const W of [A, B]) W.flush();
  };
  const errs: string[] = [];
  B.game.on.error = (m) => errs.push(m);
  const fresh = A.game.mines;
  A.game.create("Ann");
  A.open();
  A.flush();
  B.game.join(A.game.code, "Bo");
  B.open();
  flushAll();
  const room = rooms.rooms.get(A.game.code)!;
  const joined = [A.game.mines, B.game.mines].join();
  let roomEvents = 0;
  B.game.on.room = () => roomEvents++;
  A.game.setMines("fade");
  flushAll();
  check(
    "mines client: Stay outside a room and in a new one; the host's setMines reaches the server and both clients' Game.mines (one room event)",
    fresh === "stay" && joined === "stay,stay" && room.mines === "fade" && A.game.mines === "fade" && B.game.mines === "fade" && roomEvents === 1,
    `before ${joined}; after ${A.game.mines},${B.game.mines}; room ${room.mines}; ${roomEvents} room event(s)`,
  );
  B.game.setMines("stay");
  flushAll();
  check("mines client: a guest's setMines is refused with an err (the lobby shows the room's pick again); nothing changes", errs.join() === "Only the host can set the mines" && room.mines === "fade" && B.game.mines === "fade", errs.join());
  // A room message without the field (an older server during a deploy), or with rubbish: Stay.
  const handle = (g: Game, m: unknown) => (g as unknown as { handle(m: unknown): void }).handle(m);
  const base: Record<string, unknown> = {
    t: "room", hostId: A.game.you, phase: "lobby", raceStart: 0, forceStartAt: 0, trackId: room.trackId, locked: false,
    paused: false, pausedBy: "", pausedAt: 0, resumeAt: 0, soundDefaults: room.soundDefaults, song: room.song, mines: room.mines, players: room.info(),
  };
  const without = { ...base };
  delete without.mines;
  handle(B.game, without);
  const older = B.game.mines;
  handle(B.game, { ...base, mines: "fade" });
  const again = B.game.mines;
  handle(B.game, { ...base, mines: "forever" });
  const rubbish = B.game.mines;
  check("mines client: a room message without the setting (an older server) or with an unknown one falls back to Stay", older === "stay" && again === "fade" && rubbish === "stay", `${older}, ${again}, ${rubbish}`);
  // Leaving resets it.
  handle(B.game, { ...base, mines: "fade" });
  B.game.leave();
  check("mines client: leaving the room resets Game.mines to Stay", B.game.mines === "stay" && !B.game.you);
  // The snapshot's out reaches the mines the renderer draws (Game.visibleMines).
  const realNow = performance.now.bind(performance);
  try {
    let t = realNow();
    performance.now = () => t;
    const C = wiredGame(rooms, clock);
    C.game.join(A.game.code, "Cy");
    C.open();
    C.flush();
    A.flush();
    const step = (n: number) => {
      for (let i = 0; i < n; i++) {
        rooms.step((clock.now += TICK_MS));
        t += TICK_MS;
        A.flush();
        C.flush();
        A.game.step(NO_CONTROLS, TICK_MS);
        C.game.step(NO_CONTROLS, TICK_MS);
      }
    };
    C.game.setReady(true);
    A.game.start();
    step(1);
    while (room.phase !== "racing") step(1);
    const host = room.players.get(A.game.you)!;
    room.combat.mines.push({ id: 900, owner: host.id, x: host.car!.x + 200, y: host.car!.y, age: MINE_LIFE_TICKS - 40 });
    room.combat.mines.push({ id: 901, owner: host.id, x: host.car!.x + 260, y: host.car!.y, age: 100 });
    step(20);
    const drawn = C.game.visibleMines();
    const dying = drawn.find((x) => x.id === 900);
    const plain = drawn.find((x) => x.id === 901);
    check(
      "mines client: the mines the renderer draws (Game.visibleMines) carry the snapshot's out for a mine on its way out and none for the others",
      room.combat.mode === "fade" && !!dying && typeof dying.out === "number" && dying.out > 0 && dying.out <= 40 && !!plain && plain.out === undefined && !("out" in plain),
      `dying: out ${dying?.out}; plain: ${JSON.stringify(plain)}`,
    );
  } finally {
    performance.now = realNow;
  }
}

// ---- host-added server bots (M4-BOTS, PLAN-M4.md 2.0, ClickUp 123jpnbffd8, 2026-11-20) ------

// This section's imports (hoisted like the ones at the top).
import { botControls, newBotMem, type BotLevel } from "../shared/botdrive";
import { botShopping } from "../shared/botshop";
import { botTiming, DEFAULT_MAX_BOTS, maxBotsFromEnv } from "../server/bots";
import { MAX_PLAYERS } from "../shared/protocol";
import { CAR_HP } from "../shared/weapons";

/** The bot rows of a room message. */
const botInfos = (m: RoomMsg | undefined) => (m?.players ?? []).filter((p) => p.bot);

/** pointAt as it was before M4-BOTS (a scan from 0): the reference for the binary search. */
function pointAtLinear(t: Track, s: number): { x: number; y: number; h: number; seg: number } {
  const L = t.length;
  s = ((s % L) + L) % L;
  const { pts, cum } = t;
  let i = 0;
  while (i < pts.length - 1 && cum[i + 1] <= s) i++;
  const a = pts[i], b = pts[(i + 1) % pts.length];
  const f = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: Math.atan2(b.y - a.y, b.x - a.x), seg: i };
}

function botsPointAt(): void {
  for (const e of trackList()) {
    const t = trackById(e.id);
    const L = t.length;
    const ss: number[] = [0, L, -L, 2 * L, -1e-9, L - 1e-9, L + 1e-9, -0.5, 1e7 + 0.25, -1e7 - 0.25];
    for (const c of t.cum) ss.push(c, c - 1e-9, c + 1e-9, c - 0.5, c + 0.5);
    let seed = 12345;
    for (let i = 0; i < 20_000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      ss.push((seed / 2147483648) * 3 * L - L);
    }
    let bad = 0, first = "";
    for (const s of ss) {
      const a = pointAt(t, s), b = pointAtLinear(t, s);
      if (a.x !== b.x || a.y !== b.y || a.h !== b.h || a.seg !== b.seg) {
        if (!bad) first = `s=${s}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
        bad++;
      }
    }
    check(`bots pointAt: the binary search equals the linear scan on ${e.id} (every sample, its edges, wraps)`, bad === 0, first || `${ss.length} values of s, ${t.pts.length} samples`);
  }
}

/** A Rooms server (optionally capped at maxBots) with a host Ann and a guest Bo joined over onMessage. */
function botRooms(maxBots = DEFAULT_MAX_BOTS) {
  const rooms = new Rooms(1, CAR_HP, Infinity, maxBots);
  const clock = { now: 1000 };
  const join = (name: string, code?: string, token?: string): MenuSession => {
    const x = menuSession();
    rooms.onMessage(x, code ? (token ? { t: "join", code, name, token } : { t: "join", code, name }) : { t: "create", name }, clock.now);
    return x;
  };
  const ann = join("Ann");
  const room = ann.room!;
  const bo = join("Bo", room.code);
  const send = (s: MenuSession, m: ClientMsg) => rooms.onMessage(s, m, clock.now);
  const step = (n: number) => {
    for (let i = 0; i < n; i++) rooms.step((clock.now += 1000 / 60));
  };
  const bots = () => [...room.players.values()].filter((p) => p.bot);
  return { rooms, room, ann, bo, join, send, step, bots, clock };
}

function botsAdd(): void {
  const R = botRooms();
  const { room, ann, bo, send } = R;
  const from = room.chatLines.length;
  send(bo, { t: "addBot", level: "easy" });
  send(ann, { t: "addBot", level: "insane" as BotLevel }); // a level that does not exist ("hard" exists since M4-HARD)
  check(
    "bots add: a guest's addBot and an unknown level are refused with an err; no bot",
    errMsgs(bo.conn).map((m) => m.msg).join() === "Only the host can add a bot" && errMsgs(ann.conn).map((m) => m.msg).join() === "Unknown bot level" && R.bots().length === 0,
    `${errMsgs(bo.conn).map((m) => m.msg).join()} / ${errMsgs(ann.conn).map((m) => m.msg).join()}`,
  );
  send(ann, { t: "addBot", level: "easy" });
  send(ann, { t: "lock", locked: true });
  send(ann, { t: "addBot", level: "normal" });
  const info = botInfos(lastRoomMsg(bo.conn));
  const lines = linesSince(room, from);
  check(
    "bots add: the host adds an Easy and (room locked) a Normal bot: named by add order, BOT level, connected and ready in the room message, one join line each",
    room.locked && R.bots().length === 2 && info.map((p) => `${p.name}:${p.bot}:${p.connected}:${p.ready}`).join() === "Gasket (bot):easy:true:true,Lugnut (bot):normal:true:true" &&
      lines.join("|") === "join:Gasket (bot) joined the room|join:Lugnut (bot) joined the room" && errMsgs(ann.conn).length === 1,
    `${info.map((p) => `${p.name}:${p.bot}`).join(", ")}; ${lines.join(" | ")}`,
  );
  check(
    "bots add: humans are not marked as bots; a bot's seat token never matches a join",
    lastRoomMsg(bo.conn)!.players.filter((p) => !p.bot).map((p) => p.name).join() === "Ann,Bo" && R.bots().every((b) => room.playerByToken(b.token) === null && b.token.length >= 20 && !b.session),
  );
  // A join carrying a bot's token is a new player (here: refused by the lock), never the bot's seat.
  const t = R.bots()[0].token;
  send(ann, { t: "lock", locked: false });
  const cy = R.join("Cy", room.code, t);
  check("bots add: a join with a bot's token gets a new seat, not the bot", !!cy.player && cy.player !== R.bots()[0] && !cy.player.bot && R.bots().length === 2, cy.player?.name);
  // Fill up: Ann, Bo, Cy + 3 bots = 6 seats.
  send(ann, { t: "addBot", level: "normal" });
  const before = errMsgs(ann.conn).length;
  send(ann, { t: "addBot", level: "normal" });
  check(
    "bots add: bots count toward the 6 seats: one more is refused with Room is full",
    room.players.size === MAX_PLAYERS && R.bots().length === 3 && errMsgs(ann.conn).slice(before).map((m) => m.msg).join() === "Room is full",
    `${room.players.size} seats, ${R.bots().length} bots`,
  );
  // Not in a race: the countdown refuses.
  send(ann, { t: "kick", id: R.bots()[2].id });
  room.setReady(bo.player!, true);
  room.setReady(cy.player!, true);
  send(ann, { t: "start" });
  const n0 = errMsgs(ann.conn).length;
  send(ann, { t: "addBot", level: "easy" });
  check("bots add: refused outside the lobby (the countdown)", room.phase === "countdown" && errMsgs(ann.conn).slice(n0).map((m) => m.msg).join() === "Bots can only be added in the lobby" && R.bots().length === 2, room.phase);

  // The server-wide cap (MAX_BOTS): "Server busy", counted over every room; a removed bot frees its place.
  const S = botRooms(2);
  const other = S.join("Dee");
  S.send(S.ann, { t: "addBot", level: "easy" });
  S.send(other, { t: "addBot", level: "easy" });
  S.send(S.ann, { t: "addBot", level: "normal" });
  const busy = errMsgs(S.ann.conn).map((m) => m.msg).join();
  S.send(other, { t: "kick", id: [...other.room!.players.values()].find((p) => p.bot)!.id });
  S.send(S.ann, { t: "addBot", level: "normal" });
  check(
    "bots add: MAX_BOTS counts every room's bots; one more is refused with Server busy; a removed bot frees its place",
    busy === "Server busy" && S.rooms.botCount() === 2 && S.room.botCount === 2 && errMsgs(S.ann.conn).length === 1,
    `${busy}; ${S.rooms.botCount()} bots`,
  );
  const env = process.env.MAX_BOTS;
  process.env.MAX_BOTS = "3";
  const fromEnv = maxBotsFromEnv();
  process.env.MAX_BOTS = "x";
  const junk = maxBotsFromEnv();
  if (env === undefined) delete process.env.MAX_BOTS;
  else process.env.MAX_BOTS = env;
  check("bots add: MAX_BOTS defaults to 10, and the env setting overrides it", DEFAULT_MAX_BOTS === 10 && new Rooms(1).maxBots === maxBotsFromEnv() && fromEnv === 3 && junk === 10, `env 3 -> ${fromEnv}, junk -> ${junk}`);
}

function botsKickHost(): void {
  const R = botRooms();
  const { room, ann, bo, send } = R;
  send(ann, { t: "addBot", level: "easy" });
  send(ann, { t: "addBot", level: "normal" });
  const [g, l] = R.bots();
  send(ann, { t: "host", id: g.id });
  send(bo, { t: "kick", id: g.id });
  check(
    "bots kick/host: making a bot the host is refused; a guest cannot remove a bot",
    room.hostId === ann.player!.id && errMsgs(ann.conn).map((m) => m.msg).join() === "A bot cannot be the host" && errMsgs(bo.conn).map((m) => m.msg).join() === "Only the host can remove a player" && R.bots().length === 2,
  );
  const from = room.chatLines.length;
  send(ann, { t: "kick", id: g.id });
  check(
    "bots kick/host: the host's kick removes the bot (one removed line, nothing blocked)",
    !room.players.has(g.id) && R.bots().length === 1 && room.blockedCount === 0 && linesSince(room, from).join() === "removed:Gasket (bot) was removed" && botInfos(lastRoomMsg(bo.conn)).length === 1,
    linesSince(room, from).join(),
  );
  // The freed slot is reused: the next bot is Gasket again (names and lanes go by slot).
  send(ann, { t: "addBot", level: "normal" });
  check("bots kick/host: the next bot takes the lowest free slot (Gasket again)", R.bots().map((b) => `${b.name}:${b.bot!.slot}`).join() === "Lugnut (bot):1,Gasket (bot):0", R.bots().map((b) => b.name).join());
  // Bots never time out: long past the reconnect grace they are still there.
  R.step(Math.ceil(RECONNECT_GRACE_MS / (1000 / 60)) + 30);
  check("bots kick/host: bots never time out (no session, no grace)", R.bots().length === 2 && R.rooms.rooms.has(room.code) && l.disconnectedAt === 0);
}

function botsHandover(): void {
  // Ann (host), two bots, then Bo: the map order is Ann, bot, bot, Bo.
  const R = botRooms();
  const { room, ann, send } = R;
  room.leave(R.bo.player!, R.clock.now);
  send(ann, { t: "addBot", level: "easy" });
  send(ann, { t: "addBot", level: "normal" });
  const bo = R.join("Bo", room.code);
  send(ann, { t: "leave" });
  check(
    "bots handover: the host leaves; the next host is the first human (Bo), not a bot ahead of him in the room",
    [...room.players.values()][0].bot !== null && room.hostId === bo.player!.id && lastRoomMsg(bo.conn)?.hostId === bo.player!.id,
    [...room.players.values()].map((p) => p.name).join(),
  );
  // The last human leaves: the room goes, bots and all.
  send(bo, { t: "leave" });
  const emptyNow = room.empty;
  R.step(1);
  check("bots: humans gone (leave): the room is deleted with its bots", emptyNow && room.players.size === 2 && !R.rooms.rooms.has(room.code) && R.rooms.botCount() === 0);
  // Humans gone by the reconnect grace: the room waits for them, then goes.
  const G = botRooms();
  G.room.leave(G.bo.player!, G.clock.now);
  G.send(G.ann, { t: "addBot", level: "easy" });
  G.rooms.onClose(G.ann, G.clock.now);
  G.step(60);
  const kept = G.rooms.rooms.has(G.room.code) && !G.room.empty;
  G.step(Math.ceil(RECONNECT_GRACE_MS / (1000 / 60)) + 2);
  check("bots: humans gone (grace): the room waits out the host's reconnect grace, then is deleted with its bot", kept && !G.rooms.rooms.has(G.room.code));
}

function botsFullRoom(): void {
  const R = botRooms();
  const { room, ann, send } = R;
  room.leave(R.bo.player!, R.clock.now);
  for (let i = 0; i < 5; i++) send(ann, { t: "addBot", level: i % 2 ? "normal" : "easy" });
  const names0 = R.bots().map((b) => b.name).join();
  const from = room.chatLines.length;
  const bo = R.join("Bo", room.code);
  check(
    "bots full room: a human joining a full lobby replaces the last-added bot (its leave line, then the join line)",
    room.players.size === MAX_PLAYERS && !!bo.player && R.bots().map((b) => b.name).join() === "Gasket (bot),Lugnut (bot),Piston (bot),Clutch (bot)" &&
      linesSince(room, from).join("|") === "leave:Axle (bot) left the room|join:Bo joined the room",
    `${names0} -> ${R.bots().map((b) => b.name).join()}; ${linesSince(room, from).join(" | ")}`,
  );
  // The replaced bot was the last ADDED, not the highest slot: remove Gasket, add one (slot 0
  // again, added last), then Cy joins: the new Gasket goes.
  send(ann, { t: "kick", id: R.bots()[0].id });
  send(ann, { t: "addBot", level: "normal" });
  const cy = R.join("Cy", room.code);
  check("bots full room: the bot added last is the one replaced (whatever its slot)", !!cy.player && R.bots().map((b) => b.name).join() === "Lugnut (bot),Piston (bot),Clutch (bot)", R.bots().map((b) => b.name).join());
  // In a race a full room refuses, bots or not.
  send(ann, { t: "kick", id: R.bots()[0].id });
  send(ann, { t: "addBot", level: "normal" });
  room.setReady(bo.player!, true);
  room.setReady(cy.player!, true);
  send(ann, { t: "start" });
  const dee = R.join("Dee", room.code);
  check(
    "bots full room: during the countdown a full room refuses a new human (Room is full); the bots stay",
    room.phase === "countdown" && !dee.player && errMsgs(dee.conn).map((m) => `${m.msg}:${m.code}`).join() === "Room is full:full" && R.bots().length === 3,
  );
}

function botsSoloStart(): void {
  const R = botRooms();
  const { room, ann, send } = R;
  room.leave(R.bo.player!, R.clock.now);
  send(ann, { t: "addBot", level: "easy" });
  send(ann, { t: "addBot", level: "normal" });
  // A track change resets the humans' ready flags, never a bot's (found in the browser: the
  // host's Start said "Waiting for 2 to get ready").
  send(ann, { t: "track", id: "crusher-run" });
  const afterTrack = botInfos(lastRoomMsg(ann.conn));
  check("bots solo start: a track change keeps every bot ready (room message)", room.trackId === "crusher-run" && afterTrack.length === 2 && afterTrack.every((p) => p.ready), afterTrack.map((p) => `${p.name}:${p.ready}`).join());
  send(ann, { t: "start" });
  check(
    "bots solo start: a host alone with bots starts at once (bots never block the ready check); all three are on the grid",
    errMsgs(ann.conn).length === 0 && room.phase === "countdown" && room.notReady().length === 0 && [...room.players.values()].every((p) => p.car && p.inRace),
    errMsgs(ann.conn).map((m) => m.msg).join(),
  );
  check("bots solo start: bots stay ready through the race (beginRace clears humans only)", R.bots().every((b) => b.ready) && botInfos(lastRoomMsg(ann.conn)).every((p) => p.ready));
  send(ann, { t: "stop" });
  send(ann, { t: "start" });
  check("bots solo start: after a stop the host starts again at once", room.phase === "countdown" && errMsgs(ann.conn).length === 0);
}

interface BotRaceOut {
  ticks: number[];
  jumps: number[];
  falls: number[];
  wrecks: number[];
  shots: number[];
  mines: number[];
  wallets: string[];
  order: string[];
  phase: string;
}

/**
 * One race of server bots on a track: a host (who retires at GO) and bots of `levels`, laps
 * long. Per bot, by slot: finish tick, take-offs, falls, wrecks, rivets fired and mines dropped
 * (ammo used), its wallet after the race (payout and shopping), and the results order by name.
 */
function serverBotRace(trackId: string, levels: BotLevel[], laps = 1): BotRaceOut {
  const sim = new Sim(laps);
  const host = sim.add("Host");
  if (sim.room.trackId !== trackId && sim.room.setTrack(host, trackId)) throw new Error("track");
  const bots = levels.map((l) => {
    const b = sim.room.addBot(host, l, sim.now);
    if (typeof b === "string") throw new Error(b);
    return b;
  });
  const e = sim.room.start(host, sim.now);
  if (e) throw new Error(e);
  while (sim.room.phase !== "racing") sim.tick();
  if (sim.room.retire(host)) throw new Error("retire");
  const n = bots.length;
  const out: BotRaceOut = { ticks: Array(n).fill(0), jumps: Array(n).fill(0), falls: Array(n).fill(0), wrecks: Array(n).fill(0), shots: Array(n).fill(0), mines: Array(n).fill(0), wallets: [], order: [], phase: "" };
  const prev = bots.map(() => ({ air: 0, fall: 0, wreck: 0 }));
  const ammo0 = bots.map((b) => ({ ...b.wallet.ammo }));
  const seen = new Set<number>();
  let rt = 0;
  while (sim.room.phase === "racing" && rt < 60 * 150) {
    sim.tick();
    rt++;
    for (const s of sim.room.combat.shots) {
      const k = bots.findIndex((b) => b.id === s.owner);
      if (k >= 0 && !seen.has(s.id)) out.shots[k]++;
      seen.add(s.id);
    }
    for (const m of [...sim.room.combat.mines, ...sim.room.combat.gone.map((g) => g.mine)]) {
      const k = bots.findIndex((b) => b.id === m.owner);
      if (k >= 0 && !seen.has(m.id)) out.mines[k]++;
      seen.add(m.id);
    }
    bots.forEach((b, k) => {
      const c = b.car;
      if (!c) return;
      if (c.air > 0 && prev[k].air === 0) out.jumps[k]++;
      if (c.fall > 0 && prev[k].fall === 0) out.falls[k]++;
      if (c.wreck > 0 && prev[k].wreck === 0) out.wrecks[k]++;
      prev[k] = { air: c.air, fall: c.fall, wreck: c.wreck };
      if (!out.ticks[k] && b.progress?.fin) out.ticks[k] = rt;
    });
  }
  out.wallets = bots.map((b, k) => `${b.wallet.scrap}|${JSON.stringify(b.wallet.levels)}|${b.wallet.ammo.rivets},${b.wallet.ammo.mines}|from ${ammo0[k].rivets},${ammo0[k].mines}`);
  const res = [...sim.conns.get(host.id)!.msgs].reverse().find((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results");
  out.order = res?.rows.map((r) => `${r.name}:${r.earned}`) ?? [];
  out.phase = sim.room.phase;
  return out;
}

// The bounds of the client bot laps (botLaps above): measured 2026-11-17, unchanged.
const BOT_LIMITS: Record<string, { ticks: number; falls: number }> = {
  "rust-bowl": { ticks: 40 * 60, falls: 0 },
  "crusher-run": { ticks: 42 * 60, falls: 1 },
  "overpass-knot": { ticks: 38 * 60, falls: 1 },
};

function botsRace(): void {
  const normal: Record<string, number> = {};
  for (const e of trackList().filter((x) => x.id in BOT_LIMITS)) {
    const t = trackById(e.id);
    const lim = BOT_LIMITS[e.id];
    for (const level of ["normal", "easy"] as BotLevel[]) {
      const a = serverBotRace(e.id, [level, level, level]);
      const b = serverBotRace(e.id, [level, level, level]);
      const falls = a.falls.reduce((x, y) => x + y, 0);
      const secs = a.ticks.map((x) => (x / 60).toFixed(2)).join("/");
      const mean = a.ticks.reduce((x, y) => x + y, 0) / a.ticks.length;
      if (level === "normal") normal[e.id] = mean;
      check(
        `bots race on ${e.id}: 3 ${level} server bots finish within ${lim.ticks / 60} s with <= ${lim.falls} falls, taking every jump`,
        a.phase === "results" && a.ticks.every((x) => x > 0 && x <= lim.ticks) && falls <= lim.falls && a.jumps.every((j) => j >= t.ramps.length),
        `finish ${secs} s, falls ${a.falls.join("/")}, take-offs ${a.jumps.join("/")}, wrecks ${a.wrecks.join("/")}`,
      );
      check(
        `bots race on ${e.id}: ${level}, a rerun is identical (finishes, jumps, falls, wrecks, rivets, mines, wallets, results)`,
        JSON.stringify(a) === JSON.stringify(b),
        `rivets fired ${a.shots.join("/")}, mines ${a.mines.join("/")}; results ${a.order.join(", ")}`,
      );
      if (level === "easy") {
        check(
          `bots race on ${e.id}: Easy never shoots (no rivet, no mine, no ammo bought) and is slower than Normal`,
          a.shots.every((x) => x === 0) && a.mines.every((x) => x === 0) && a.wallets.every((w) => w.includes("|0,0|")) && mean > normal[e.id],
          `Easy mean ${(mean / 60).toFixed(2)} s vs Normal ${(normal[e.id] / 60).toFixed(2)} s; ${a.wallets.join("; ")}`,
        );
      }
    }
  }
  // Normal bots use their weapons: over the shipped tracks they fire rivets and drop mines.
  const runs = trackList().filter((x) => x.id in BOT_LIMITS).map((e) => serverBotRace(e.id, ["normal", "normal", "normal"], 2));
  const shots = runs.reduce((a, r) => a + r.shots.reduce((x, y) => x + y, 0), 0);
  const mines = runs.reduce((a, r) => a + r.mines.reduce((x, y) => x + y, 0), 0);
  check("bots race: Normal bots fire rivets and drop mines (2-lap races on every shipped track)", shots > 0 && mines > 0 && runs.every((r) => r.phase === "results"), `${shots} rivets, ${mines} mines`);
}

function botsShop(): void {
  const w = startingWallet();
  const normal = botShopping(w, "normal"), easy = botShopping(w, "easy");
  const rich = { scrap: 1000, levels: { engine: 0, tyres: 0, welder: 0 }, ammo: { rivets: 40, mines: 3 } };
  check(
    "bots shop: the rule is deterministic: Normal tops up rivets then mines, then upgrades cheapest first; Easy buys upgrades only",
    normal.join() === "rivets,mines" && easy.join() === "welder" && botShopping(rich, "normal").join() === "welder,tyres" && botShopping(rich, "easy").join() === "welder,tyres" &&
      botShopping({ ...rich, scrap: 2000 }, "normal").join() === "welder,tyres,engine" && w.scrap === 400 && botShopping(w, "normal").join() === normal.join(),
    `start: normal ${normal.join()}, easy ${easy.join()}`,
  );
  // In the room: shopped on adding, and after each payout by the same rule.
  const sim = new Sim(1);
  const host = sim.add("Host");
  const n = sim.room.addBot(host, "normal", sim.now) as Player;
  const ez = sim.room.addBot(host, "easy", sim.now) as Player;
  const added = `${n.wallet.scrap}|${n.ammo.rivets},${n.ammo.mines}|${JSON.stringify(n.levels)}; ${ez.wallet.scrap}|${ez.ammo.rivets},${ez.ammo.mines}|${JSON.stringify(ez.levels)}`;
  check(
    "bots shop: a bot shops with its starting scrap when added (Normal: 20 rivets and 3 mines; Easy: the welding rig)",
    added === `50|20,3|{"engine":0,"tyres":0,"welder":0}; 100|0,0|{"engine":0,"tyres":0,"welder":1}` && n.ammo === n.wallet.ammo,
    added,
  );
  // After the payout: both start the race with 500 scrap and no ammo (so nothing is used), and
  // each ends with exactly what the rule buys from 500 + its earnings.
  for (const b of [n, ez]) {
    b.wallet.scrap = 500;
    b.wallet.ammo.rivets = 0;
    b.wallet.ammo.mines = 0;
    b.wallet.levels.welder = 0;
  }
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  for (let i = 0; i < 60 * 60 && sim.room.phase === "racing"; i++) sim.tick();
  const res = sim.conns.get(host.id)!.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
  const want = [n, ez].map((b) => {
    const w = { scrap: 500 + (res?.rows.find((r) => r.id === b.id)?.earned ?? NaN), levels: { engine: 0, tyres: 0, welder: 0 }, ammo: { rivets: 0, mines: 0 } };
    for (const item of botShopping(w, b.bot!.level)) shopBuy(w, item);
    return JSON.stringify(w);
  });
  const got = [n, ez].map((b) => JSON.stringify(b.wallet));
  check(
    "bots shop: after the payout each bot spends its scrap by the rule, exactly",
    (sim.room.phase as string) === "results" && res?.rows.length === 3 && got.join() === want.join() && n.wallet.levels.engine + n.wallet.levels.tyres + n.wallet.levels.welder > 0,
    `${res?.rows.map((r) => `${r.name} +${r.earned}`).join(", ")}; ${got.join(" ")}`,
  );
}

function botsTick(): void {
  // A paused race: bots stand still and take no input; after the resume they drive on at once
  // (no resume hold: a bot has no inputs to wait for).
  const sim = new Sim(1);
  const host = sim.add("Host");
  const b = sim.room.addBot(host, "normal", sim.now) as Player;
  const humans = (n: number) => {
    for (let i = 0; i < n; i++) {
      if (host.car) sim.feed(host);
      sim.tick();
    }
  };
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") humans(1);
  humans(120);
  const before = { ...b.car! };
  sim.room.pause(host, sim.now);
  humans(120);
  const frozen = b.car!.x === before.x && b.car!.y === before.y && b.ack === -1 && b.queue.length === 0;
  sim.room.resume(host, sim.now);
  let moved = -1, stepped = -1;
  for (let i = 0; i < 400 && moved < 0; i++) {
    const x = b.car!.x;
    humans(1);
    if (!sim.room.paused && stepped < 0) stepped = i;
    if (b.car!.x !== x) moved = i;
  }
  check(
    "bots tick: paused, a bot stands still and takes no input; resumed, it drives on the very tick the room steps again (no resume hold)",
    frozen && stepped > 0 && moved === stepped && b.held === 0 && host.held > 0,
    `room stepped again on tick ${stepped}, bot moved on ${moved}; host held ${host.held}`,
  );
  // No rivet before the weapons arm (WEAPONS_ARM_MS), with a target straight ahead.
  const s2 = new Sim(1);
  const h2 = s2.add("Host");
  const shooter = s2.room.addBot(h2, "normal", s2.now) as Player;
  s2.room.start(h2, s2.now);
  while (s2.room.phase !== "racing") s2.run(1);
  // The host's car parked on the bot's line (slot 0: lane -24) 350 ahead; the clock jumped to
  // 100 ms before the weapons arm. The bot has a target from the first tick.
  s2.place(h2, 550, -24);
  s2.place(shooter, 200, -24);
  s2.now = s2.room.raceStart + WEAPONS_ARM_MS - 100;
  let firstShot = 0;
  for (let i = 0; i < 60 && !firstShot; i++) {
    s2.tick();
    if (s2.room.combat.shots.some((x) => x.owner === shooter.id)) firstShot = Math.round(s2.sinceGo());
  }
  check("bots tick: a Normal bot fires at a car ahead, never before the weapons arm (then at once)", firstShot >= WEAPONS_ARM_MS && firstShot < WEAPONS_ARM_MS + 20 && shooter.ammo.rivets === 19, `first rivet ${firstShot} ms after GO`);
}

function botsCpu(): void {
  // 1 human (retired at GO) + 5 bots, 3 laps of Crusher Run (ramps, gaps and holes): each bot step
  // timed (server/bots.ts botTiming) and every room tick.
  const sim = new Sim(3);
  const host = sim.add("Host");
  sim.room.setTrack(host, "crusher-run");
  for (let i = 0; i < 5; i++) sim.room.addBot(host, i % 2 ? "easy" : "normal", sim.now);
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  const tickMs: number[] = [];
  const steps: number[] = [];
  botTiming.samples = steps;
  let ticks = 0;
  try {
    while (sim.room.phase === "racing" && ticks < 60 * 300) {
      sim.tickNo++;
      sim.now += 1000 / 60;
      const t0 = performance.now();
      sim.room.tick(sim.tickNo, sim.now);
      tickMs.push(performance.now() - t0);
      ticks++;
    }
  } finally {
    botTiming.samples = null;
  }
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const med = pct(steps, 0.5), tickMed = pct(tickMs, 0.5);
  console.log(`  CPU: bot step median ${(med * 1000).toFixed(2)} us, p99 ${(pct(steps, 0.99) * 1000).toFixed(2)} us over ${steps.length} steps; room tick with 5 bots median ${(tickMed * 1000).toFixed(2)} us, p99 ${(pct(tickMs, 0.99) * 1000).toFixed(2)} us, max ${(Math.max(...tickMs) * 1000).toFixed(1)} us over ${tickMs.length} ticks`);
  check(
    "bots CPU: the median bot step stays <= 0.05 ms (the gate fails above 0.2 ms); room tick with 5 bots printed",
    steps.length > 5 * 3000 && med <= 0.2 && (sim.room.phase as string) === "results",
    `median bot step ${med.toFixed(5)} ms (${med <= 0.05 ? "within" : "OVER"} the 0.05 ms target); room tick median ${tickMed.toFixed(4)} ms over ${ticks} ticks`,
  );
  // The driver itself, called straight (no room): same order of cost.
  const t = trackById("crusher-run");
  const p = pointAt(t, 500);
  const car: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 300, vy: Math.sin(p.h) * 300, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const mem = newBotMem(0, "normal");
  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) botControls({ car, track: t, stats: BASE_STATS, raceOn: true, raceSteps: i, others: [] }, mem);
  const per = (performance.now() - t0) / 10_000;
  check("bots CPU: botControls alone, 10k calls on Crusher Run, averages under 0.05 ms", per < 0.05, `${(per * 1000).toFixed(2)} us per call`);
}

function botsClient(): void {
  // Over the wire (encode/decode): the host's Game adds a bot, sees it tagged, races it, removes it.
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock);
  A.game.create("Ann");
  A.open();
  A.flush();
  A.game.addBot("easy");
  A.game.addBot("normal");
  A.flush();
  const room = rooms.rooms.get(A.game.code)!;
  const bots = A.game.players.filter((p) => p.bot);
  check(
    "bots client: Game.addBot reaches the server; the room message tags each bot with its level (Game.isBot), and the host waits for nobody",
    bots.map((p) => `${p.name}:${p.bot}`).join() === "Gasket (bot):easy,Lugnut (bot):normal" && bots.every((p) => A.game.isBot(p.id)) && !A.game.isBot(A.game.you) && A.game.waitingFor() === 0 && room.botCount === 2,
    bots.map((p) => `${p.name}:${p.bot}`).join(),
  );
  A.game.pickTrack("overpass-knot");
  A.flush();
  check("bots client: after the host picks another track the Start still waits for nobody (bots stay ready)", A.game.trackId === "overpass-knot" && A.game.waitingFor() === 0, `waiting for ${A.game.waitingFor()}`);
  const realNow = performance.now.bind(performance);
  try {
    let t = realNow();
    performance.now = () => t;
    A.game.start();
    let seenBots = 0;
    for (let i = 0; i < 60 * 8; i++) {
      rooms.step((clock.now += 1000 / 60));
      t += 1000 / 60;
      A.flush();
      A.game.step(NO_CONTROLS, 1000 / 60);
      seenBots = Math.max(seenBots, A.game.otherPoses().filter((o) => A.game.isBot(o.id)).length);
    }
    check("bots client: the bots' cars are in the host's snapshots and drive", room.phase === "racing" && seenBots === 2 && bots.every((p) => (room.players.get(p.id)?.progress?.s ?? 0) > 200), `${seenBots} bot cars seen`);
  } finally {
    performance.now = realNow;
  }
  A.game.stopRace();
  A.game.kick(bots[0].id);
  A.flush();
  check("bots client: Game.kick removes a bot (the lobby's Remove)", A.game.players.filter((p) => p.bot).map((p) => p.name).join() === "Lugnut (bot)" && room.botCount === 1);
}

// ---- car types (M4-CARS, PLAN-M4.md 2.1, ClickUp 123jpnbffdz, 2026-11-20) --------------------

// This section's imports (hoisted like the ones at the top).
import { CAR_TYPES, CARS, DEFAULT_CAR, isCarType, type CarType } from "../shared/cars";
import { CORNER_SCALE, runUpFor } from "../shared/botdrive";
import { botCar } from "../server/bots";

/** The shipped tracks (trackList() also holds the test tracks earlier sections registered). */
const CAR_TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"];
const ALL_LEVELS: { engine: number; tyres: number; welder: number }[] = [];
for (let e = 0; e <= 3; e++) for (let ty = 0; ty <= 3; ty++) for (let w = 0; w <= 3; w++) ALL_LEVELS.push({ engine: e, tyres: ty, welder: w });

function carsTypes(): void {
  const table = CAR_TYPES.map((t) => `${t}:${Object.values(CARS[t].base).join("/")}`).join(" ");
  check(
    "cars: three types in lobby order with PLAN-M4 2.1's base stats (accel/top/grip/turn/dirt drag/dirt grip); top speed 430 for all",
    CAR_TYPES.join() === "sport,racer,truck" && DEFAULT_CAR === "sport" &&
      table === "sport:520/430/7.5/3.3/2.9/0.37 racer:600/430/6/3.45/3.6/0.3 truck:455/430/9/3.1/1.6/0.6",
    table,
  );
  check(
    "cars: the Sport is the car of before M4-CARS (BASE_STATS, the old off-road multipliers 2.9 / 0.37)",
    CARS.sport.base === BASE_STATS && JSON.stringify(BASE_STATS) === JSON.stringify({ accel: 520, topSpeed: 430, grip: 7.5, turn: 3.3, dirtDrag: 2.9, dirtGrip: 0.37 }),
  );
  check(
    "cars: isCarType accepts the three ids only",
    CAR_TYPES.every(isCarType) && ![undefined, null, "", "Sport", "tank", 1, {}].some(isCarType),
  );
  check("cars: every type has a name and a one-line feel for its lobby card", CAR_TYPES.every((t) => CARS[t].name.length > 0 && CARS[t].feel.length > 10 && CARS[t].feel.length <= 60), CAR_TYPES.map((t) => `${CARS[t].name}: ${CARS[t].feel}`).join(" | "));
}

function carsStats(): void {
  // statsFor(type, levels): today's percentages on the type's base; the dirt multipliers are the type's own.
  const bad: string[] = [];
  for (const t of CAR_TYPES) {
    const b = CARS[t].base;
    for (const l of ALL_LEVELS) {
      const s = statsFor(t, l);
      const want = { accel: b.accel * (1 + 0.07 * l.engine), topSpeed: b.topSpeed, grip: b.grip * (1 + 0.1 * l.tyres), turn: b.turn * (1 + 0.04 * l.tyres), dirtDrag: b.dirtDrag, dirtGrip: b.dirtGrip };
      if (JSON.stringify(s) !== JSON.stringify(want)) bad.push(`${t} ${JSON.stringify(l)}`);
    }
  }
  check(`cars: statsFor(type, levels) = the type's base with the upgrade percentages, for 3 types x ${ALL_LEVELS.length} level sets`, bad.length === 0, bad.slice(0, 3).join("; "));
  // The Sport, every level: exactly the formula of before M4-CARS (BASE_STATS, same operations).
  const old = (l: { engine: number; tyres: number }) => ({
    accel: BASE_STATS.accel * (1 + 0.07 * l.engine), topSpeed: BASE_STATS.topSpeed, grip: BASE_STATS.grip * (1 + 0.1 * l.tyres), turn: BASE_STATS.turn * (1 + 0.04 * l.tyres),
  });
  check(
    "cars: statsFor('sport', levels) is bit for bit the stats of before M4-CARS at every level",
    ALL_LEVELS.every((l) => {
      const s = statsFor("sport", l), o = old(l);
      return s.accel === o.accel && s.topSpeed === o.topSpeed && s.grip === o.grip && s.turn === o.turn && s.dirtDrag === 2.9 && s.dirtGrip === 0.37;
    }),
  );
  // Physics per type on a long straight: asphalt top speed 430 for all, dirt top speed topSpeed /
  // dirtDrag (Sport ~148, Racer ~119, Truck ~269), and the Racer pulls away first, the Truck last.
  const flat = buildTrack({
    id: "test-straight-cars",
    name: "Test Straight",
    control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [0, 3000]],
    halfWidth: 64,
    verge: 44,
  });
  const drive = (t: CarType, y: number) => {
    const stats = statsFor(t, { engine: 0, tyres: 0, welder: 0 });
    const c: CarState = { x: 1500, y, h: 0, vx: 0, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 };
    let t300 = -1;
    for (let i = 1; i <= 15 * TICK_HZ && c.x < 11000; i++) {
      stepCar(c, { throttle: 1, steer: 0 }, stats, flat);
      if (t300 < 0 && speedOf(c) >= 300) t300 = i * DT;
    }
    return { v: speedOf(c), t300, y: c.y };
  };
  const road = CAR_TYPES.map((t) => drive(t, 0)), dirt = CAR_TYPES.map((t) => drive(t, 85));
  // stepCar's steady state at full throttle is (top / mult) * (1 - drag * mult * DT), drag = accel / top:
  // a step's drag below the nominal topSpeed / mult (the Sport's 430 shows as ~421 today).
  const steady = (t: CarType, mult: number) => {
    const b = CARS[t].base;
    return (b.topSpeed / mult) * (1 - (b.accel / b.topSpeed) * mult * DT);
  };
  check(
    "cars physics: on asphalt every type tops out at its top speed 430 (less one step's drag); the Racer reaches 300 u/s first, the Truck last",
    CAR_TYPES.every((t, i) => Math.abs(road[i].v - steady(t, 1)) < 0.5) && road[1].t300 < road[0].t300 && road[0].t300 < road[2].t300,
    CAR_TYPES.map((t, i) => `${t} ${road[i].v.toFixed(1)} u/s (steady ${steady(t, 1).toFixed(1)}), 300 at ${road[i].t300.toFixed(3)} s`).join("; "),
  );
  check(
    "cars physics: on the dirt verge each type tops out at topSpeed / dirtDrag (Sport ~148, Racer ~119, Truck ~269, less one step's drag)",
    CAR_TYPES.every((t, i) => Math.abs(dirt[i].v - steady(t, CARS[t].base.dirtDrag)) < 0.5 && Math.abs(dirt[i].y - 85) < 1e-6) && dirt[2].v > 1.7 * dirt[0].v && dirt[1].v < dirt[0].v,
    CAR_TYPES.map((t, i) => `${t} ${dirt[i].v.toFixed(1)} (nominal ${(430 / CARS[t].base.dirtDrag).toFixed(1)}, steady ${steady(t, CARS[t].base.dirtDrag).toFixed(1)})`).join("; "),
  );
}

/** The last garage message a connection got. */
const lastGarage = (c: FakeConn) => c.msgs.filter((m): m is Extract<ServerMsg, { t: "garage" }> => m.t === "garage").pop();

function carsPick(): void {
  const R = menuRooms(["Ann", "Bo"]);
  const [a, b] = R.p;
  const [sa, sb] = R.s;
  check(
    "cars pick: a new driver has the Sport, in their garage message and in the room message",
    a.carType === "sport" && b.carType === "sport" && lastGarage(sb.conn)?.car === "sport" && infoOf(lastRoomMsg(sa.conn), b.id)?.car === "sport",
  );
  const r0 = sa.conn.msgs.length, g0 = sb.conn.msgs.length;
  R.send(1, { t: "car", id: "racer" });
  const garageB = sb.conn.msgs.slice(g0).filter((m) => m.t === "garage");
  check(
    "cars pick: Bo picks the Racer in the lobby: his garage message carries it (his own stats), everyone's room message shows it",
    b.carType === "racer" && garageB.length === 1 && lastGarage(sb.conn)?.car === "racer" && infoOf(lastRoomMsg(sa.conn), b.id)?.car === "racer" &&
      sa.conn.msgs.slice(r0).filter((m) => m.t === "garage").length === 0,
  );
  const r1 = sa.conn.msgs.length;
  R.send(1, { t: "car", id: "racer" });
  check("cars pick: picking the car you have changes nothing (no message)", sa.conn.msgs.length === r1 && errMsgs(sb.conn).length === 0);
  // Refusals: an unknown type, a guest naming a bot, the host naming a human or nobody.
  R.send(0, { t: "addBot", level: "normal" });
  const bot = [...R.room.players.values()].find((p) => p.bot)!;
  const ea = errMsgs(sa.conn).length, eb = errMsgs(sb.conn).length;
  R.send(1, { t: "car", id: "tank" as CarType });
  R.send(1, { t: "car", id: "truck", bot: bot.id });
  R.send(0, { t: "car", id: "truck", bot: b.id });
  R.send(0, { t: "car", id: "truck", bot: "nobody" });
  R.send(0, { t: "car", id: "truck", bot: 7 as unknown as string });
  check(
    "cars pick: refused with an err: an unknown type, a guest naming a bot, the host naming a human, an unknown id or a non-string; nothing changes",
    errMsgs(sb.conn).slice(eb).map((m) => m.msg).join("|") === "Unknown car|Only the host can pick a bot's car" &&
      errMsgs(sa.conn).slice(ea).map((m) => m.msg).join("|") === "That is not a bot in this room|That is not a bot in this room|That is not a bot in this room" &&
      b.carType === "racer" && bot.carType === "sport" && a.carType === "sport",
    [...errMsgs(sb.conn).slice(eb), ...errMsgs(sa.conn).slice(ea)].map((m) => m.msg).join("|"),
  );
  // Locked per race: the stats are set from the car at the start; no change in the countdown, the race or the results.
  R.send(0, { t: "car", id: "truck" });
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  const atStart = { a: { ...a.stats }, b: { ...b.stats }, bot: { ...bot.stats } };
  check(
    "cars lock: the start sets each racer's stats from their car and levels (Ann Truck, Bo Racer, the bot Sport)",
    R.room.phase === "countdown" && JSON.stringify(a.stats) === JSON.stringify(statsFor("truck", a.wallet.levels)) &&
      JSON.stringify(b.stats) === JSON.stringify(statsFor("racer", b.wallet.levels)) && JSON.stringify(bot.stats) === JSON.stringify(statsFor("sport", bot.wallet.levels)),
    `${a.stats.accel}/${b.stats.accel}/${bot.stats.accel}`,
  );
  const tried: string[] = [];
  const tryAll = (phase: string) => {
    const e1 = errMsgs(sb.conn).length, e2 = errMsgs(sa.conn).length;
    R.send(1, { t: "car", id: "sport" });
    R.send(0, { t: "car", id: "racer", bot: bot.id });
    tried.push(`${phase}: ${[...errMsgs(sb.conn).slice(e1), ...errMsgs(sa.conn).slice(e2)].map((m) => m.msg).join("|")}`);
  };
  tryAll("countdown");
  R.step(Math.ceil((COUNTDOWN_MS / 1000) * 60) + 2);
  tryAll(R.room.phase);
  // Everyone off the field: Bo retires (his garage opens), the others are moved to the line.
  R.room.retire(b);
  tryAll("racing, retired");
  for (const p of [a, bot]) {
    const pr = p.progress!;
    pr.lap = 1;
    pr.fin = 1;
    p.finished = true;
  }
  R.step(1);
  tryAll(R.room.phase);
  const want = "Countdown|racing|racing, retired|results".split("|");
  check(
    "cars lock: no change in the countdown, the race (a retired driver's garage too) or the results; the stats stay those of the start",
    R.room.phase === "results" && tried.length === 4 && tried.every((t, i) => t.toLowerCase().startsWith(want[i].toLowerCase()) && t.endsWith("The car can only be changed in the lobby|The car can only be changed in the lobby")) &&
      b.carType === "racer" && bot.carType === "sport" && JSON.stringify(a.stats) === JSON.stringify(atStart.a) && JSON.stringify(bot.stats) === JSON.stringify(atStart.bot),
    tried.join("; "),
  );
  // Back in the lobby: switching is free again; a restart keeps the car (and its stats).
  R.step(Math.ceil((RESULTS_MS / 1000) * 60) + 2);
  R.send(1, { t: "car", id: "truck" });
  R.send(0, { t: "car", id: "racer", bot: bot.id });
  R.send(1, { t: "ready", ready: true });
  R.send(0, { t: "start" });
  R.step(Math.ceil((COUNTDOWN_MS / 1000) * 60) + 2);
  R.send(0, { t: "restart" });
  check(
    "cars lock: back in the lobby the switch is free again; a restart races the same cars",
    R.room.phase === "countdown" && b.carType === "truck" && bot.carType === "racer" &&
      JSON.stringify(b.stats) === JSON.stringify(statsFor("truck", b.wallet.levels)) && JSON.stringify(bot.stats) === JSON.stringify(statsFor("racer", bot.wallet.levels)),
    `${b.carType}, bot ${bot.carType}, phase ${R.room.phase}`,
  );
}

function carsRejoin(): void {
  const R = menuRooms(["Ann", "Bo"]);
  const [, b] = R.p;
  R.send(1, { t: "car", id: "truck" });
  const token = b.token;
  R.rooms.onClose(R.s[1], R.clock.now);
  R.step(60);
  const back = R.join("Bo", token);
  check(
    "cars rejoin: a dropped driver who rejoins with the seat token keeps the car; the garage message after the welcome carries it",
    back.player === b && b.carType === "truck" && lastGarage(back.conn)?.car === "truck" && infoOf(lastRoomMsg(R.s[0].conn), b.id)?.car === "truck",
    `${back.player?.carType}, garage ${lastGarage(back.conn)?.car}`,
  );
  // Dropped and back during a race: the car and the race's stats are unchanged.
  R.rooms.onMessage(back, { t: "ready", ready: true }, R.clock.now);
  R.send(0, { t: "start" });
  R.step(Math.ceil((COUNTDOWN_MS / 1000) * 60) + 30);
  const stats0 = JSON.stringify(b.stats);
  R.rooms.onClose(back, R.clock.now);
  R.step(120);
  const again = R.join("Bo", token);
  check(
    "cars rejoin: mid-race too: the same seat, car and race stats (the Truck's), the garage message says Truck",
    again.player === b && R.room.phase === "racing" && b.carType === "truck" && JSON.stringify(b.stats) === stats0 && stats0 === JSON.stringify(statsFor("truck", b.wallet.levels)) && lastGarage(again.conn)?.car === "truck",
  );
}

function carsBots(): void {
  const R = botRooms();
  const { room, ann, bo, send } = R;
  for (let i = 0; i < 4; i++) send(ann, { t: "addBot", level: i % 2 ? "easy" : "normal" });
  const seat = () => R.bots().map((b) => `${b.name}:${b.carType}`).join(",");
  check(
    "cars bots: a bot's car is round-robin by seat: Sport, Racer, Truck, Sport (the room message shows each)",
    seat() === "Gasket (bot):sport,Lugnut (bot):racer,Piston (bot):truck,Clutch (bot):sport" &&
      botInfos(lastRoomMsg(bo.conn)).map((p) => p.car).join() === "sport,racer,truck,sport" && [0, 1, 2, 3, 4, 5].map(botCar).join() === "sport,racer,truck,sport,racer,truck",
    seat(),
  );
  // A freed seat is taken again by the next bot, with that seat's car.
  send(ann, { t: "kick", id: R.bots()[1].id });
  send(ann, { t: "addBot", level: "normal" });
  check("cars bots: a bot added into a freed seat gets that seat's car (Lugnut's seat: the Racer)", R.bots().map((b) => `${b.name}:${b.carType}`).sort().join() === "Clutch (bot):sport,Gasket (bot):sport,Lugnut (bot):racer,Piston (bot):truck", seat());
  // The host changes a bot's car from its row; the race runs with it (stats and the driver's corner speeds).
  const g = R.bots().find((b) => b.name === "Gasket (bot)")!;
  send(ann, { t: "car", id: "truck", bot: g.id });
  check("cars bots: the host changes a bot's car; the room message shows it", g.carType === "truck" && infoOf(lastRoomMsg(bo.conn), g.id)?.car === "truck" && errMsgs(ann.conn).length === 0);
  room.setReady(bo.player!, true);
  send(ann, { t: "start" });
  check(
    "cars bots: the race sets each bot's stats from its car (Gasket now the Truck)",
    R.bots().every((b) => JSON.stringify(b.stats) === JSON.stringify(statsFor(b.carType, b.wallet.levels))) && g.stats.accel === 455,
    R.bots().map((b) => `${b.name} ${b.carType} accel ${b.stats.accel}`).join(", "),
  );
  check(
    "cars bots: the bot driver's corner speeds follow its car (grip^(1/4) of the Sport's): Sport 1, Racer below, Truck above",
    CORNER_SCALE.sport === 1 && Math.abs(CORNER_SCALE.racer - (6 / 7.5) ** 0.25) < 1e-12 && Math.abs(CORNER_SCALE.truck - (9 / 7.5) ** 0.25) < 1e-12,
    `racer ${CORNER_SCALE.racer.toFixed(4)}, truck ${CORNER_SCALE.truck.toFixed(4)}`,
  );
}

function carsRunUps(): void {
  // Every jump of every shipped track works from rest for every type, with no upgrades and with
  // all of them (the Truck is the worst case: ~45 more units of run-up to 350 u/s than the Sport).
  const rows: string[] = [];
  let errs = 0;
  for (const t of CAR_TYPES) {
    for (const lv of [0, 3]) {
      const st = statsFor(t, { engine: lv, tyres: lv, welder: lv });
      for (const id of CAR_TRACKS) {
        const v = validateRunUps(trackById(id), st);
        errs += v.length;
        if (v.length) rows.push(`${t} L${lv} ${id}: ${v.join("; ")}`);
      }
    }
  }
  const up = (t: CarType) => runUpFor(350, statsFor(t, { engine: 0, tyres: 0, welder: 0 }));
  check(
    `cars run-ups: validateRunUps passes for every type at L0 and L3 on every shipped track (${CAR_TRACKS.join(", ")})`,
    errs === 0 && up("truck") > up("sport") + 30 && up("racer") < up("sport"),
    rows.join(" | ") || `run-up to 350 u/s at L0: sport ${up("sport").toFixed(0)}, racer ${up("racer").toFixed(0)}, truck ${up("truck").toFixed(0)}`,
  );
}

/** One race of a single Normal server bot with car `car` on a track (the host retires at GO): finish tick and falls. */
function soloBotLap(trackId: string, car: CarType, laps = 1): { ticks: number; falls: number; jumps: number } {
  const sim = new Sim(laps);
  const host = sim.add("Host");
  if (sim.room.trackId !== trackId && sim.room.setTrack(host, trackId)) throw new Error("track");
  const b = sim.room.addBot(host, "normal", sim.now);
  if (typeof b === "string") throw new Error(b);
  if (sim.room.setCar(host, car, b.id)) throw new Error("car");
  if (sim.room.start(host, sim.now)) throw new Error("start");
  while (sim.room.phase !== "racing") sim.tick();
  if (sim.room.retire(host)) throw new Error("retire");
  let rt = 0, falls = 0, jumps = 0, pf = 0, pa = 0;
  while (sim.room.phase === "racing" && rt < 60 * 400) {
    sim.tick();
    rt++;
    const c = b.car;
    if (!c) break;
    if (c.fall > 0 && pf === 0) falls++;
    if (c.air > 0 && pa === 0) jumps++;
    pf = c.fall;
    pa = c.air;
    if (b.progress?.fin) return { ticks: rt, falls, jumps };
  }
  return { ticks: 0, falls, jumps };
}

function carsBalance(): void {
  // The bot's lap time with each type at L0, solo (no bumps, no weapons to hit), one lap from the
  // grid and three laps: within about 3 % of the Sport's on every shipped track (PLAN-M4: a guide;
  // the taste gate is the real check). Deterministic: a rerun is identical.
  const table: string[] = [];
  const off: string[] = [];
  let falls = 0, det = true;
  for (const e of CAR_TRACKS.map((id) => ({ id }))) {
    for (const laps of [1, 3]) {
      const r = CAR_TYPES.map((t) => soloBotLap(e.id, t, laps));
      if (laps === 1) det &&= JSON.stringify(soloBotLap(e.id, "truck")) === JSON.stringify(r[2]) && JSON.stringify(soloBotLap(e.id, "racer")) === JSON.stringify(r[1]);
      const pct = (i: number) => ((r[i].ticks / r[0].ticks - 1) * 100);
      falls += r.reduce((x, y) => x + y.falls, 0);
      table.push(`${e.id} ${laps} lap${laps > 1 ? "s" : ""}: sport ${(r[0].ticks / 60).toFixed(2)} s, racer ${(r[1].ticks / 60).toFixed(2)} s (${pct(1) >= 0 ? "+" : ""}${pct(1).toFixed(2)}%), truck ${(r[2].ticks / 60).toFixed(2)} s (${pct(2) >= 0 ? "+" : ""}${pct(2).toFixed(2)}%)`);
      for (const i of [1, 2]) if (!(r[i].ticks > 0) || Math.abs(pct(i)) > 3) off.push(`${e.id} ${CAR_TYPES[i]} ${laps}: ${pct(i).toFixed(2)}%`);
      if (r.some((x) => x.jumps < trackById(e.id).ramps.length * laps)) off.push(`${e.id} ${laps}: a jump not taken`);
    }
  }
  for (const line of table) console.log(`  lap time: ${line}`);
  check(
    "cars balance: at L0 the bot's lap with the Racer and with the Truck is within 3% of the Sport's on every shipped track (1 and 3 laps, solo, Normal), every jump taken, no fall",
    off.length === 0 && falls === 0,
    off.join("; ") || `${table.length} rows, printed above`,
  );
  check("cars balance: the solo laps are deterministic (a rerun is identical)", det);
}

/** Bends of a track: stretches of s whose heading turns more than 0.35 rad over 120 units, with the turn's side (+1 right). */
function carBends(t: Track): { s0: number; s1: number; side: number }[] {
  const out: { s0: number; s1: number; side: number }[] = [];
  let cur: { s0: number; s1: number; side: number } | null = null;
  for (let s = 0; s < t.length; s += 10) {
    const d = angleDiff(pointAt(t, s - 60).h, pointAt(t, s + 60).h);
    if (Math.abs(d) <= 0.35) continue;
    const side = Math.sign(d);
    if (cur && cur.side === side && s - cur.s1 <= 20) cur.s1 = s;
    else out.push((cur = { s0: s, s1: s, side }));
  }
  return out;
}

/**
 * A solo bot's flying lap (the second of two, from rest on the start line, no weapons) with car
 * `car`; while inside `cut` (a bend, from 80 before it to 40 after it) its racing line moves to
 * `lane` units on the inside of the bend. Ticks for the lap, and ticks spent on the dirt.
 */
function cutLap(t: Track, car: CarType, cut: { s0: number; s1: number; side: number } | null, lane: number): { ticks: number; dirt: number; falls: number } {
  const stats = statsFor(car, { engine: 0, tyres: 0, welder: 0 });
  const mem = newBotMem(0, "normal");
  mem.weapons = false;
  const p = pointAt(t, 0);
  const c: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const L = t.length;
  const inCut = (s: number) => !!cut && [s, s + L].some((x) => x >= cut.s0 - 80 && x <= cut.s1 + 40);
  let dist = 0, prev = 0, t1 = 0, dirt = 0, falls = 0, i = 0;
  for (; i < 60 * 200 && dist < 2 * L; i++) {
    const q = queryTrackNear(t, c.x, c.y, c.seg);
    mem.lateral = dist >= L && inCut(q.s) ? cut!.side * lane : 0;
    const ev = stepRaceCar(c, botControls({ car: c, track: t, stats, raceOn: true, raceSteps: i, others: [], carType: car }, mem), stats, raceEnv(t));
    if (ev === "fall") falls++;
    const q2 = queryTrackNear(t, c.x, c.y, c.seg);
    if (dist >= L && c.air === 0 && q2.dist > t.def.halfWidth) dirt++;
    let ds = q2.s - prev;
    if (ds < -L / 2) ds += L;
    if (ds > L / 2) ds -= L;
    if (c.fall === 0) dist += ds;
    prev = q2.s;
    if (dist >= L && !t1) t1 = i;
  }
  return { ticks: i - t1, dirt, falls };
}

function carsCut(): void {
  // The Truck's dirt top speed is ~269 u/s against the Sport's ~148 (advisor: show that cutting a
  // corner through the dirt verge is no free win). Per bend of every shipped track, a lap whose
  // line moves onto the inside for that bend only: on the asphalt (lanes 0, 56, 64) or into the
  // dirt (72, 84, 96), at the bot's own pace and flat out (no braking at all). The best line
  // through the dirt is never faster than the best line on the asphalt (1 tick = rounding).
  const ASPHALT = [0, 56, 64], DIRT = [72, 84, 96];
  const saved = CORNER_SCALE.truck;
  const worst: string[] = [];
  let bends = 0, cuts = 0, maxGain = -Infinity;
  try {
    for (const pace of ["bot", "flat"] as const) {
      CORNER_SCALE.truck = pace === "flat" ? 3 : saved;
      for (const e of CAR_TRACKS.map((id) => ({ id }))) {
        const t = trackById(e.id);
        const base = cutLap(t, "truck", null, 0);
        const lines: string[] = [];
        for (const b of carBends(t)) {
          bends++;
          const asphalt = Math.min(...ASPHALT.map((ln) => (ln === 0 ? base : cutLap(t, "truck", b, ln)).ticks));
          const dirty = DIRT.map((ln) => cutLap(t, "truck", b, ln)).filter((r) => r.dirt > 0 && r.falls === 0);
          if (!dirty.length) continue;
          cuts++;
          const best = Math.min(...dirty.map((r) => r.ticks));
          maxGain = Math.max(maxGain, asphalt - best);
          lines.push(`${b.s0}-${b.s1}${b.side > 0 ? "R" : "L"} ${best - base.ticks >= 0 ? "+" : ""}${best - base.ticks}/${asphalt - base.ticks >= 0 ? "+" : ""}${asphalt - base.ticks}`);
          if (best < asphalt - 1) worst.push(`${pace} ${e.id} bend ${b.s0}-${b.s1}: dirt ${best} vs asphalt ${asphalt} ticks`);
        }
        console.log(`  truck cut (${pace}) ${e.id}: lap ${(base.ticks / 60).toFixed(2)} s; per bend, best dirt / best asphalt line, ticks vs the bot's line: ${lines.join(", ")}`);
      }
    }
  } finally {
    CORNER_SCALE.truck = saved;
  }
  check(
    "cars cut: on every shipped track the Truck never gains by cutting a bend through the dirt verge (best dirt line vs best asphalt line, bot pace and flat out)",
    worst.length === 0 && cuts > 10,
    worst.join("; ") || `${cuts} cuts that reach the dirt over ${bends} bends; best dirt line at most ${maxGain} tick(s) ahead of the best asphalt line`,
  );
}

/**
 * Three client bots (lanes -24, 0, 24), one per car type, race a lap of a track through the real
 * client Game against a Rooms server on the sim clock (no sockets, no lag), weapons off: each
 * one's prediction stats are the server's, and its prediction matches the server.
 */
function carsClientLap(id: string): { ticks: number[]; stateErrs: number; samples: number; large: number; maxErr: number; same: boolean } {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const lanes = [-24, 0, 24];
    const ws = lanes.map(() => wiredGame(rooms, clock));
    ws[0].game.create("Car0");
    ws[0].open();
    ws[0].flush();
    ws[0].game.pickTrack(id);
    ws[0].flush();
    const room = [...rooms.rooms.values()][0];
    ws.slice(1).forEach((w, i) => {
      w.game.join(room.code, `Car${i + 1}`);
      w.open();
    });
    for (const w of ws) w.flush();
    ws.forEach((w, i) => w.game.pickCar(CAR_TYPES[i]));
    for (const w of ws.slice(1)) w.game.setReady(true);
    for (const w of ws) w.flush();
    ws[0].game.start();
    ws[0].flush();
    const drivers = ws.map((w, i) => {
      const d = new BotDriver(w.game, lanes[i]);
      d.weapons = false;
      return d;
    });
    const ticks = ws.map(() => 0);
    let raceTicks = 0, same = true;
    for (let i = 0; i < 60 * 120 && ticks.some((x) => x === 0); i++) {
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      for (const w of ws) w.flush();
      ws.forEach((w, k) => w.game.step(drivers[k].controls(), 1000 / 60));
      if (room.phase === "racing") raceTicks++;
      ws.forEach((w, k) => {
        const p = room.players.get(w.game.you)!;
        if (raceTicks === 1) same &&= w.game.carType === CAR_TYPES[k] && p.carType === CAR_TYPES[k] && JSON.stringify(p.stats) === JSON.stringify(w.game.stats);
        if (!ticks[k] && p.progress?.fin) ticks[k] = raceTicks; // the last one on the tick the race ends
      });
    }
    const errs = ws.flatMap((w) => w.game.recErrors);
    return {
      ticks,
      stateErrs: ws.reduce((a, w) => a + w.game.recStateErrors, 0),
      samples: errs.length,
      large: errs.filter((x) => x > LARGE_ERR).length,
      maxErr: errs.length ? Math.max(...errs) : NaN,
      same,
    };
  } finally {
    performance.now = realNow;
  }
}

function carsClient(): void {
  // Over the wire: Game.pickCar and the garage message; the host's Game.pickBotCar; carOf.
  const rooms = new Rooms(1);
  const clock = { now: 1000 };
  const A = wiredGame(rooms, clock), B = wiredGame(rooms, clock);
  A.game.create("Ann");
  A.open();
  A.flush();
  B.game.join(A.game.code, "Bo");
  B.open();
  B.flush();
  A.flush();
  const fresh = B.game.carType === "sport" && JSON.stringify(B.game.stats) === JSON.stringify(statsFor("sport", B.game.levels));
  B.game.pickCar("truck");
  A.game.addBot("normal");
  A.flush();
  B.flush();
  const bot = A.game.players.find((p) => p.bot)!;
  A.game.pickBotCar(bot.id, "racer");
  A.flush();
  B.flush();
  check(
    "cars client: Game.pickCar reaches the server; the garage message sets carType and the stats (statsFor(car, levels)); everyone's carOf shows each car, the host's pickBotCar too",
    fresh && B.game.carType === "truck" && JSON.stringify(B.game.stats) === JSON.stringify(statsFor("truck", B.game.levels)) &&
      A.game.carOf(B.game.you) === "truck" && B.game.carOf(bot.id) === "racer" && A.game.carOf(A.game.you) === "sport" && A.game.carType === "sport",
    `B ${B.game.carType}; A sees B ${A.game.carOf(B.game.you)}, B sees the bot ${B.game.carOf(bot.id)}`,
  );
  // An older server's messages (no car): the Sport.
  const g = new Game(() => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }), { get: () => null, set() {} });
  g.carType = "truck" as CarType; // as if left from an earlier room
  (g as unknown as { handle(m: ServerMsg): void }).handle({ t: "garage", scrap: 0, levels: { engine: 1, tyres: 0, welder: 0 } });
  check(
    "cars client: an older server's garage message (no car) means the Sport, and so does a player the room message names no car for",
    g.carType === "sport" && JSON.stringify(g.stats) === JSON.stringify(statsFor("sport", { engine: 1, tyres: 0, welder: 0 })) && g.carOf("x") === "sport",
  );

  // Prediction per type: one client bot of each type laps every shipped track (deterministic,
  // no lag): the stats are the server's and the prediction has no state mismatch and no large error.
  for (const e of CAR_TRACKS.map((id) => ({ id }))) {
    const a = carsClientLap(e.id), b = carsClientLap(e.id);
    check(
      `cars client: on ${e.id} a Sport, a Racer and a Truck (client Game) finish with the server's stats; prediction matches (no state mismatch, no error > ${LARGE_ERR}); a rerun is identical`,
      a.same && a.ticks.every((x) => x > 0) && a.samples > 1000 && a.stateErrs === 0 && a.large === 0 && JSON.stringify(a) === JSON.stringify(b),
      `finish ${a.ticks.map((x) => (x / 60).toFixed(2)).join("/")} s (sport/racer/truck); ${a.stateErrs} state mismatches, ${a.large} errors > ${LARGE_ERR} of ${a.samples}, max ${a.maxErr.toFixed(3)}`,
    );
  }
}

// ---- race tick, step env, boost plumbing (M4-ENV, PLAN-M4.md 3, ClickUp 123jpnbffe0, 2026-11-20) ----

// This section's imports (hoisted like the ones at the top).
import { rtAt, type Snapshot } from "../client/game";

/** The rt of the last snapshot a connection got. */
const lastRt = (c: FakeConn) => c.msgs.filter((m): m is SnapMsg => m.t === "snap").pop()?.rt;

function envRt(): void {
  // The server's race tick: 0 in the lobby and the countdown, +1 per racing tick, frozen while
  // paused (the resume's hold ticks count: the room simulates them), in every snapshot, back to
  // 0 for a restart and in the lobby.
  const sim = new Sim(1);
  const a = sim.add("Ann"), b = sim.add("Bo");
  sim.run(2);
  const lobby = lastRt(sim.conns.get(a.id)!);
  sim.readyAll(a);
  sim.room.start(a, sim.now);
  const inCountdown: number[] = [];
  while (sim.room.phase === "countdown") {
    sim.run(1, () => ({ throttle: 1 }));
    if (sim.room.phase === "countdown") inCountdown.push(sim.room.rt);
  }
  const first = sim.room.rt;
  sim.run(99, () => ({ throttle: 1 }));
  const snaps = sim.conns.get(b.id)!.msgs.filter((m): m is SnapMsg => m.t === "snap");
  check(
    "env rt: 0 in the lobby and the countdown, 1 on the first racing tick, +1 per racing tick; every snapshot carries the room's rt",
    lobby === 0 && inCountdown.length > 100 && inCountdown.every((x) => x === 0) && first === 1 && sim.room.rt === 100 &&
      snaps.every((m) => typeof m.rt === "number") && snaps[snaps.length - 1].rt === (sim.tickNo % 2 === 0 ? 100 : 99),
    `lobby ${lobby}, countdown ${inCountdown.length} ticks at 0, first racing tick ${first}, after 100 racing ticks ${sim.room.rt}, last snapshot ${snaps[snaps.length - 1].rt}`,
  );
  sim.room.pause(a, sim.now);
  sim.run(120, () => ({ throttle: 1 }));
  const paused = sim.room.rt;
  sim.room.resume(a, sim.now);
  let ticks = 0;
  while (sim.room.paused) {
    sim.run(1, () => ({ throttle: 1 }));
    ticks++;
  }
  check(
    "env rt: paused ticks (the pause and its 3-2-1) do not count; it counts on from where it stood",
    paused === 100 && sim.room.rt === 101 && ticks > 100,
    `rt ${paused} through ${120 + ticks} paused ticks, ${sim.room.rt} on the first tick after`,
  );
  sim.room.restartRace(a, sim.now);
  const restarted = sim.room.rt;
  sim.run(1);
  check("env rt: a restart starts it over at 0 (its countdown)", restarted === 0 && sim.room.rt === 0 && lastRt(sim.conns.get(a.id)!) === 0);
  sim.room.stopRace(a, sim.now);
  sim.run(2);
  check("env rt: back in the lobby it is 0", sim.room.phase === "lobby" && sim.room.rt === 0 && lastRt(sim.conns.get(a.id)!) === 0);
}

function envStep(): void {
  // stepRaceCar(c, input, stats, env): nothing reads env.rt or env.draft yet, so any race tick or
  // slipstream steps a car exactly as rt 0 / draft 0 (no behaviour change), through a jump, a
  // roll-off fall and the recovery on the T1b straight.
  const t = buildTrack(T1B_DEF);
  const p = pointAt(t, 600);
  const start: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const run = (rt: (i: number) => number, draft: number) => {
    const c = cloneCar(start);
    const evs: string[] = [];
    const env = raceEnv(t, 0, draft);
    for (let i = 0; i < 60 * 30; i++) {
      env.rt = rt(i);
      const slow = i > 260 && speedOf(c) > 150;
      const ev = stepRaceCar(c, { throttle: slow ? -1 : 1, steer: 0 }, BASE_STATS, env);
      if (ev) evs.push(ev);
    }
    return JSON.stringify([c, evs]);
  };
  const ref = run(() => 0, 0);
  check(
    "env step: any race tick steps a car exactly as rt 0 (jump, fall and recovery included); a slipstream (M4-DRAFT) does change it",
    ref.includes("takeoff") && ref.includes("fall") && ref.includes("recover") && run((i) => i + 1, 0) === ref && run((i) => 7 * i + 12345, 0) === ref && run(() => 0, 0.8) !== ref,
    JSON.parse(ref)[1].join(","),
  );
  check(
    "env step: validateRunUps gives the same verdicts (it steps through stepRaceCar with rt counting from 1)",
    ["rust-bowl", "crusher-run", "overpass-knot"].every((id) => validateRunUps(trackById(id)).length === 0) && validateRunUps(t).join() === validateRunUps(t, BASE_STATS).join(),
  );
  // boost: in CarState, cloneCar, the snapshots (0 for now); the client's sameState compares it.
  const src: CarState = { ...start, boost: 37 };
  const cl = cloneCar(src);
  const sim = new Sim(1);
  const a = sim.add("Ann");
  sim.startRace(a);
  sim.run(10, () => ({ throttle: 1 }));
  const cars = sim.conns.get(a.id)!.msgs.filter((m): m is SnapMsg => m.t === "snap").flatMap((m) => m.ents.filter((e): e is CarSnap => e.k === "car"));
  check(
    "env boost: CarState carries boost; cloneCar copies it; every car in a snapshot has boost 0 off the start (no cell there)",
    cl.boost === 37 && cl !== src && cars.length > 3 && cars.every((e) => e.boost === 0) && a.car!.boost === 0,
    `${cars.length} car snapshots`,
  );
}

/**
 * One client (no lag) races a lap through the real client Game on the sim clock; the server's
 * rt for every input it applied is noted. stall: [race tick, ticks] the client sends nothing
 * (an underrun); pauseAt: the host pauses at this race tick and resumes at once.
 */
function rtRun(opts: { stall?: [number, number]; pauseAt?: number; ticks?: number } = {}): { skew: number[]; live: number[]; truth: Map<number, number>; log: [number, number, number][]; countdown: number } {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const A = wiredGame(rooms, clock);
    A.game.create("Ann");
    A.open();
    A.flush();
    const room = [...rooms.rooms.values()][0];
    A.game.start();
    A.flush();
    const d = new BotDriver(A.game, 0);
    d.weapons = false;
    const truth = new Map<number, number>();
    let last = -1, countdown = 0, stalled = 0, paused = false;
    for (let i = 0; i < (opts.ticks ?? 60 * 20); i++) {
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      const p = room.players.get(A.game.you)!;
      if (p.ack !== last) {
        last = p.ack;
        if (!room.paused) truth.set(p.ack, room.rt); // applied at this race tick (thrown away while paused)
        if (room.phase === "countdown") countdown++;
      }
      if (opts.pauseAt !== undefined && !paused && room.rt >= opts.pauseAt) {
        paused = true;
        room.pause(p, clock.now);
        room.resume(p, clock.now);
      }
      A.flush();
      if (opts.stall && room.rt >= opts.stall[0] && stalled < opts.stall[1]) {
        stalled++;
        continue;
      }
      A.game.step(d.controls(), 1000 / 60);
    }
    const log = A.game.rtLog.filter(([seq]) => truth.has(seq));
    return { skew: log.map(([seq, , rt]) => rt - truth.get(seq)!), live: log.map(([seq, rt0]) => rt0 - truth.get(seq)!), truth, log, countdown };
  } finally {
    performance.now = realNow;
  }
}

function envClient(): void {
  // rtAt: the step i after a snapshot runs at rt + i + 1 while racing; in the countdown at 0
  // until GO (the clamp), then 1, 2, ...; in the results the race tick stands.
  const snap = (rtBase: number, rtOpen: boolean): Snapshot => ({ time: 0, rtBase, rtOpen, cars: new Map(), shots: new Map(), mines: [] });
  check(
    "env client: rtAt counts on from a racing snapshot, clamps at GO from a countdown one, stands still after the race",
    [0, 1, 5].map((i) => rtAt(snap(40, true), i)).join() === "41,42,46" && [0, 1, 2, 3, 4].map((i) => rtAt(snap(-2, true), i)).join() === "0,0,1,2,3" &&
      rtAt(snap(900, false), 7) === 900,
  );
  // No lag: every step the server applied was predicted at exactly its race tick, live and after
  // the last replay, through the countdown (rt 0) and GO. At GO itself one tick either way: the
  // client works out the GO tick from the snapshot's clock (phaseEnds - time), the server's tick
  // clock decides it (here a float sum of 1000/60 steps landing a hair before phaseEnds).
  const r = rtRun();
  const offs = r.log.map(([seq, rt0, rt]) => ({ seq, rt0, rt, t: r.truth.get(seq)! })).filter((x) => x.rt0 !== x.t || x.rt !== x.t);
  const zeros = r.log.filter(([seq]) => r.truth.get(seq) === 0).length;
  check(
    "env client: no lag: each applied input's predicted race tick (live and replayed) is the server's, countdown inputs at 0 (the clamp at GO), then 1, 2, ...; at GO at most one tick off",
    offs.every((x) => x.t <= 1 && Math.abs(x.rt0 - x.t) <= 1 && Math.abs(x.rt - x.t) <= 1) && zeros > 100 && r.log.length > 1000 && r.log.some(([seq]) => r.truth.get(seq) === 1),
    `${r.log.length} steps, ${zeros} in the countdown; off (seq/live/replayed/server): ${offs.map((x) => `${x.seq}/${x.rt0}/${x.rt}/${x.t}`).join(" ") || "none"}`,
  );
  // An underrun (the client sends nothing for 20 ticks) and a pause with its resume: the skew is
  // bounded and corrected by the next snapshots (it is back to 0 after each).
  const u = rtRun({ stall: [300, 20], pauseAt: 700, ticks: 60 * 30 });
  const off = u.log.map(([seq, rt0, rt], k) => ({ seq, at: u.truth.get(seq)!, live: u.live[k], fin: u.skew[k], rt0, rt })).filter((x) => x.live !== 0 || x.fin !== 0);
  const maxLive = Math.max(0, ...u.live.map(Math.abs)), maxFin = Math.max(0, ...u.skew.map(Math.abs));
  const tail = u.log.filter(([seq]) => u.truth.get(seq)! > 1000).length;
  check(
    "env client: an underrun (20 ticks without input) and a pause/resume skew the predicted race tick by a bounded amount (live <= 3, after replays <= 1), exact again after each",
    maxLive <= 3 && maxFin <= 1 && tail > 50 && off.every((x) => x.at <= 1 || (x.at >= 300 && x.at <= 330) || (x.at >= 700 && x.at <= 710)),
    `${off.length} of ${u.log.length} steps off; max live ${maxLive}, max after replay ${maxFin}; off at rt ${[...new Set(off.map((x) => x.at))].slice(0, 12).join(",")}`,
  );
}

// ---- slipstream (M4-DRAFT, PLAN-M4.md 2.8, ClickUp 123jpnbfffj, 2026-11-20) ----------------------

// This section's imports (hoisted like the ones at the top).
import {
  DRAFT_DRAG_CUT,
  DRAFT_FAR,
  DRAFT_FULL,
  DRAFT_LEAD_MIN_SPEED,
  DRAFT_NEAR,
  DRAFT_SHAPE,
  DRAFT_TAPER,
  DRAFT_WIDTH,
  DRAFT_SPREAD,
  draftFrom,
  draftsFor,
  draftTopSpeed,
  givesDraft,
  takesDraft,
  type DraftEntry,
} from "../shared/catchup";
import { validateJumpSweep } from "../shared/weapons";
import { DRAFT_STRAIGHT } from "../tools/debug/draft-tune";
import { draftRace, type DraftRaceOut } from "../tools/debug/draft-race";

/** Run fn with the slipstream switched off (DRAFT_SHAPE.far = 0: nobody is ever in a wake). */
function withoutDraft<T>(fn: () => T): T {
  const far = DRAFT_SHAPE.far;
  DRAFT_SHAPE.far = 0;
  try {
    return fn();
  } finally {
    DRAFT_SHAPE.far = far;
  }
}

function draftRule(): void {
  // Geometry: a leader at the origin heading +x, the follower d behind and lat across.
  const at = (d: number, lat = 0) => draftFrom(-d, lat, 0, 0, 0);
  check(
    `draft rule: none up to ${DRAFT_NEAR} behind (alongside), full from there to ${DRAFT_FULL}, falling linearly to 0 at ${DRAFT_FAR}; none ahead`,
    at(10) === 0 && at(DRAFT_NEAR) === 0 && at(DRAFT_NEAR + 0.5) === 1 && at(DRAFT_FULL) === 1 && Math.abs(at(120) - 0.5) < 1e-9 && at(DRAFT_FAR) === 0 && at(DRAFT_FAR + 20) === 0 && at(-50) === 0,
    [10, 20, 21, 60, 120, 179, 180].map((d) => `${d}:${at(d).toFixed(3)}`).join(" "),
  );
  // Across the wake: full within DRAFT_TAPER inside the edge (DRAFT_WIDTH + DRAFT_SPREAD * d), 0
  // DRAFT_TAPER outside it, linear between (no hard edge: advisor change 8), the same either side.
  const edge = DRAFT_WIDTH + DRAFT_SPREAD * 50;
  let maxStep = 0;
  for (let lat = 0; lat < 45; lat += 0.01) maxStep = Math.max(maxStep, Math.abs(at(50, lat + 0.01) - at(50, lat)));
  check(
    "draft rule: tapered across the wake (full near its line, half at its edge, none past it, no step anywhere), the same on both sides",
    at(50, edge - DRAFT_TAPER) === 1 && Math.abs(at(50, edge) - 0.5) < 1e-9 && at(50, edge + DRAFT_TAPER) === 0 && at(50, -edge) === at(50, edge) &&
      maxStep <= 0.01 / (2 * DRAFT_TAPER) + 1e-9,
    `edge at 50 behind: ${edge}; largest change per 0.01 across: ${maxStep.toFixed(5)}`,
  );
  const car = (o: Partial<CarState> = {}): CarState => ({ x: 0, y: 0, h: 0, vx: DRAFT_LEAD_MIN_SPEED, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0, ...o });
  check(
    `draft rule: a draft only from a car on the ground, not wrecked, ghosted or finished, at ${DRAFT_LEAD_MIN_SPEED} u/s or more; only for a car on the ground`,
    givesDraft(car(), false, false) && !givesDraft(car({ vx: DRAFT_LEAD_MIN_SPEED - 1 }), false, false) && !givesDraft(car(), true, false) && !givesDraft(car(), false, true) &&
      !givesDraft(car({ air: 5 }), false, false) && givesDraft(car({ air: 5 }), false, false, 0) && !givesDraft(car({ fall: 9 }), false, false) && !givesDraft(car({ wreck: 9 }), false, false) &&
      takesDraft(car()) && !takesDraft(car({ air: 1 })) && !takesDraft(car({ fall: 1 })) && !takesDraft(car({ wreck: 1 })),
  );
  // draftsFor: the strongest wake a car is in, never its own, nothing from a car behind.
  const field: DraftEntry[] = [
    { car: car({ x: 0, vx: 430 }), ghost: false, finished: false }, // the leader
    { car: car({ x: -120, vx: 430 }), ghost: false, finished: false }, // 120 behind it: 0.5
    { car: car({ x: -160, vx: 430 }), ghost: false, finished: false }, // 40 behind the second: 1
    { car: car({ x: -100, y: 200, vx: 430 }), ghost: false, finished: false }, // off to the side: none
  ];
  const out = draftsFor(field, []);
  const ghosted = draftsFor(field.map((f, i) => (i === 1 ? { ...f, ghost: true } : f)), []);
  check(
    "draft rule: draftsFor gives each car the strongest wake it is in (never its own; nothing from a car behind or a ghost)",
    out.join() === "0,0.5,1,0" && ghosted.join() === `0,0.5,${draftFrom(-160, 0, 0, 0, 0)},0`,
    `${out.join(",")} / with the second ghosted ${ghosted.join(",")}`,
  );
  // stepCar: the drag cut; draft 0 is exactly the step without it; full draft tops out at ~+10 %.
  const t = buildTrack(DRAFT_STRAIGHT);
  const drive = (draft: number | null, ticks: number) => {
    const p = pointAt(t, 1000);
    const c: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    for (let i = 0; i < ticks; i++) {
      if (draft === null) stepCar(c, { throttle: 1, steer: 0 }, BASE_STATS, t);
      else stepCar(c, { throttle: 1, steer: 0 }, BASE_STATS, t, draft);
    }
    return c;
  };
  const full = speedOf(drive(1, 420)), none = speedOf(drive(0, 420)), half = speedOf(drive(0.5, 420));
  // The fixed step's terminal speed: v = a (1 - k DT) / k for drag k (421.3 u/s for the Sport's nominal 430).
  const k = BASE_STATS.accel / BASE_STATS.topSpeed;
  const term = (kk: number) => (BASE_STATS.accel * (1 - kk * DT)) / kk;
  check(
    `draft physics: drag x (1 - ${DRAFT_DRAG_CUT} w): full draft tops out ~+10 % faster (nominal ${draftTopSpeed(430).toFixed(1)} u/s for 430), half way between; draft 0 is bit for bit the step without it`,
    JSON.stringify(drive(0, 300)) === JSON.stringify(drive(null, 300)) && Math.abs(none - term(k)) < 0.5 && Math.abs(full - term(k * (1 - DRAFT_DRAG_CUT))) < 0.5 &&
      full / none > 1.095 && full / none < 1.105 && half > none + 15 && half < full - 15,
    `after 7 s flat out on the straight: alone ${none.toFixed(1)}, half draft ${half.toFixed(1)}, full ${full.toFixed(1)} u/s (+${(100 * (full / none - 1)).toFixed(1)} %)`,
  );
}

const DRAFT_ID = DRAFT_STRAIGHT.id;

/** Steer at a point ahead on the lane `lat` units right of the centerline (the A4 drivers). */
function laneSteer(t: Track, c: CarState, lat: number): number {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  const p = pointAt(t, q.s + 60 + speedOf(c) * 0.2);
  const tx = p.x - Math.sin(p.h) * lat, ty = p.y + Math.cos(p.h) * lat;
  return clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
}

/**
 * Two cars on the draft straight, through the real room (its draft pass, the jitter buffer):
 * cars[i] = [s, lane]; all at v0, full throttle, holding their lanes. Returns per tick each
 * car's s and pose. Without `cars[1]` the first car drives alone.
 */
function straightRun(cars: [number, number][], ticks: number, v0 = 430): { s: number[][]; pose: string[][] } {
  const t = trackById(DRAFT_ID);
  const sim = new Sim(1);
  const ps = cars.map((_, i) => sim.add(`D${i}`));
  if (sim.room.setTrack(ps[0], DRAFT_ID)) throw new Error("track");
  sim.startRace(ps[0]);
  cars.forEach(([s0, lat], i) => {
    const pt = pointAt(t, s0);
    const x = pt.x - Math.sin(pt.h) * lat, y = pt.y + Math.cos(pt.h) * lat;
    ps[i].car = { x, y, h: pt.h, vx: Math.cos(pt.h) * v0, vy: Math.sin(pt.h) * v0, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    ps[i].progress = { s: s0, cp: 1, lap: 0, fin: 0 };
  });
  const out = { s: cars.map(() => [] as number[]), pose: cars.map(() => [] as string[]) };
  for (let k = 0; k < ticks; k++) {
    sim.run(1, (p) => ({ throttle: 1, steer: laneSteer(t, p.car!, cars[ps.indexOf(p)][1]) }));
    ps.forEach((p, i) => {
      const c = p.car!;
      out.s[i].push(queryTrackNear(t, c.x, c.y, c.seg).s);
      out.pose[i].push(`${c.x},${c.y},${c.h},${c.vx},${c.vy}`);
    });
  }
  return out;
}

function draftStraight(): void {
  // PLAN-M4 2.8's test, through the server: a follower 50 behind the leader at 430 u/s, 18 across
  // (in the wake, clear of its side: side by side the capsules touch at 16). With the draft its
  // centre gets ahead of the leader's within 4 s and stays there (the passed car is beside it, not
  // in its wake: no tug of war); with no draft the gap stays within +-1. Getting a whole car length
  // ahead takes the next bend: the extra speed (<= ~43 u/s) dies out in ~0.8 s (draft-tune.ts).
  registerTestTrack(DRAFT_STRAIGHT);
  const lead = 1500, gap = 50, lane = 18;
  const on = straightRun([[lead, 0], [lead - gap, lane]], 240);
  const ahead = on.s[1].map((s, k) => s - on.s[0][k]); // the follower's lead (+ = ahead)
  const first = ahead.findIndex((a) => a > 0);
  const best = Math.max(...ahead);
  check(
    "draft straight: a follower 50 behind at 430 u/s (in the wake, 18 across) gets its centre ahead of the leader's within 4 s, and is still ahead at 4 s",
    first >= 0 && first < 240 && ahead[239] > 0,
    `centre ahead after ${((first + 1) / 60).toFixed(2)} s, best lead ${best.toFixed(1)}, at 4 s ${ahead[239].toFixed(1)} units (a car length ahead: the next bend)`,
  );
  const off = withoutDraft(() => straightRun([[lead, 0], [lead - gap, lane]], 240));
  const gaps = off.s[0].map((s, k) => s - off.s[1][k]);
  check(
    "draft straight: with no draft the same two cars keep their gap within +-1 for 4 s",
    gaps.every((g) => Math.abs(g - gap) <= 1),
    `gap ${Math.min(...gaps).toFixed(2)}..${Math.max(...gaps).toFixed(2)}`,
  );
  // A car 250 behind is in no wake: it drives exactly as it does alone, bit for bit.
  const far = straightRun([[lead - 250, 0], [lead, 0]], 300);
  const alone = straightRun([[lead - 250, 0]], 300);
  check(
    "draft straight: a car 250 behind another drives exactly as it does alone (every pose, bit for bit, for 5 s)",
    far.pose[0].join("|") === alone.pose[0].join("|"),
    `last speed ${Math.hypot(...far.pose[0][299].split(",").slice(3).map(Number) as [number, number]).toFixed(2)} u/s`,
  );
}

/**
 * The own car's draft over a lagged in-process link (oneWayMs each way): a client driven by the
 * socket bots' BotDriver (a Normal driver: it tucks in behind the car ahead and passes) and an
 * Easy server bot on Rust Bowl (no weapons either). Per applied input: the server's draft for
 * the client's car, and the client's prediction live and after the last replay; and the reconcile
 * errors.
 */
function draftClientRun(oneWayMs: number, ticks = 60 * 70): { truth: Map<number, number>; log: [number, number, number][]; errs: number[]; stateErrs: number; drafted: number } {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const A = laggedGame(rooms, clock, oneWayMs);
    A.game.create("Ann");
    A.open();
    const settle = () => {
      for (let i = 0; i < 30; i++) {
        clock.now += 1000 / 60;
        A.up();
        rooms.step(clock.now);
        A.down();
      }
    };
    settle();
    const room = [...rooms.rooms.values()][0];
    A.game.addBot("easy"); // slower (throttle 0.85: ~365 u/s): the client catches it, tucks in and passes
    settle();
    A.game.start();
    const d = new BotDriver(A.game, 0);
    d.weapons = false;
    const truth = new Map<number, number>();
    let last = -1, drafted = 0, racing = 0;
    const drafts = (room as unknown as { drafts: number[] }).drafts;
    for (let i = 0; i < ticks; i++) {
      clock.now += 1000 / 60;
      A.up();
      rooms.step(clock.now);
      const p = room.players.get(A.game.you)!;
      if (p.car && p.ack !== last && room.phase === "racing") {
        last = p.ack;
        const k = [...room.players.values()].filter((q) => q.car).indexOf(p);
        truth.set(p.ack, drafts[k]);
        if (drafts[k] > 0) drafted++;
      }
      A.down();
      if (room.phase === "racing") racing++;
      const ctl = d.controls();
      A.game.step(racing < 240 ? { ...ctl, throttle: 0 } : ctl, 1000 / 60); // 4 s on the line: the bot gets ahead
    }
    return { truth, log: A.game.draftLog.filter(([seq]) => truth.has(seq)), errs: A.game.recErrors, stateErrs: A.game.recStateErrors, drafted };
  } finally {
    performance.now = realNow;
  }
}

function draftClient(): void {
  // Contacts.draft: the own car's draft at step k from the others' poses at k - 1; none past the cap.
  const cap = Math.round((PREDICT_MAX_MS * TICK_HZ) / 1000);
  const ct = new Contacts();
  const lead: CarSnap = { ...snapCar("L", { x: 1000, y: 0, h: 0, vx: 430, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 }) };
  ct.setBase({ cars: new Map([["L", lead], ["Me", snapCar("Me", { x: 950, y: 0, h: 0, vx: 430, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 })]]) }, "Me");
  const me = (x: number): CarState => ({ x, y: 0, h: 0, vx: 430, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 });
  // At step k the leader is predicted (k - 1) * 430 / 60 further on.
  const kAt = 10, lx = 1000 + ((kAt - 1) * 430) / 60;
  check(
    "draft client: the own car's draft for step k is taken from the others' poses predicted k - 1 steps on; none past CAP_STEPS, none in the air",
    ct.draft(me(lx - 50), kAt) === 1 && ct.draft(me(lx - 120), kAt) === draftFrom(lx - 120, 0, lx, 0, 0) && ct.draft(me(1000 + (cap * 430) / 60 - 50), cap + 1) === 0 &&
      ct.draft({ ...me(lx - 50), air: 3 }, kAt) === 0,
    `cap ${cap} steps`,
  );
  // Over a lagged link the prediction (after the replay) matches the server's draft closely, and
  // the reconcile stays small while drafting (PLAN-M4 section 3: "small and continuous").
  for (const ms of [0, 50, 90]) {
    const r = draftClientRun(ms);
    const diffs = r.log.map(([seq, , rep]) => Math.abs(rep - r.truth.get(seq)!));
    const live = r.log.map(([seq, l]) => Math.abs(l - r.truth.get(seq)!));
    const inDraft = r.log.filter(([seq]) => r.truth.get(seq)! > 0).length;
    const sorted = [...r.errs].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? NaN, p95 = sorted[Math.floor(sorted.length * 0.95)] ?? NaN, max = sorted[sorted.length - 1] ?? NaN;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    console.log(
      `      lag ${ms} ms each way: ${r.log.length} inputs, ${inDraft} in a draft; |predicted - server draft| after replay mean ${mean(diffs).toFixed(4)} max ${Math.max(0, ...diffs).toFixed(3)}, live mean ${mean(live).toFixed(4)} max ${Math.max(0, ...live).toFixed(3)}; ` +
        `reconcile error median ${med.toFixed(3)} p95 ${p95.toFixed(3)} max ${max.toFixed(2)}; state mismatches ${r.stateErrs}`,
    );
    check(
      `draft client: lag ${ms} ms each way: the client predicts its own draft (after its replay within 0.05 of the server's for >= 95% of its inputs), and its reconcile error stays small (median < 0.5, p95 < ${LARGE_ERR}, max <= 15)`,
      r.log.length > 2000 && inDraft > 100 && diffs.filter((x) => x <= 0.05).length >= 0.95 * diffs.length && med < 0.5 && p95 < LARGE_ERR && max <= 15,
      `${inDraft} drafted inputs; within 0.05: ${((100 * diffs.filter((x) => x <= 0.05).length) / Math.max(1, diffs.length)).toFixed(1)}%; reconcile median ${med.toFixed(3)} p95 ${p95.toFixed(3)} max ${max.toFixed(2)}`,
    );
  }
}

function draftJumps(): void {
  // A3 (advisor change 7): every jump on every shipped track lands from its slowest landing speed
  // up to the full-draft top speed, for every car type at L0 and L3 (the flight is frozen: the
  // type only drives the roll-out). And a track built to fail it does.
  const top = draftTopSpeed(430);
  const rows: string[] = [];
  let ok = true;
  for (const id of CAR_TRACKS) {
    for (const car of CAR_TYPES) {
      for (const lv of [0, 3]) {
        const e = validateJumpSweep(trackById(id), top, statsFor(car, { engine: lv, tyres: lv, welder: lv }));
        if (e.length) {
          ok = false;
          rows.push(`${id} ${car} L${lv}: ${e.join("; ")}`);
        }
      }
    }
    rows.push(`${id}: ${trackById(id).ramps.length} lips ok; strict (asphalt only): ${validateJumpSweep(trackById(id), top, BASE_STATS, true).length} problems`);
  }
  check(`draft jumps: on every shipped track every jump lands at every arrival speed up to ${top.toFixed(1)} u/s (full draft), for all car types at L0 and L3`, ok, rows.join(" | "));
  // A straight with a 120-unit gap and a pit on the left lane right where a 473 u/s flight comes
  // down (~450 past the lip): from rest the car lands short of it and drives around it; at full
  // draft on that lane it lands in it.
  const lip = 2000 + 80;
  const bad = buildTrack({
    ...DRAFT_STRAIGHT,
    id: "draft-pit",
    features: [{ k: "ramp", s: 2000, len: 80 }, { k: "gap", s0: lip, s1: lip + 120 }, { k: "hole", s: lip + 450, lat: -32, r: 26 }],
    recovery: [0, 1500],
  });
  const errs = validateJumpSweep(bad, top), at400 = validateJumpSweep(bad, 400), fromRest = validateRunUps(bad);
  check(
    "draft jumps: the sweep catches a jump that only fails at overspeed (a pit where a full-draft flight lands), which the run-up check from rest passes",
    fromRest.length === 0 && errs.some((e) => e.includes("lane -32") && e.includes("falls")) && at400.length === 0,
    `up to ${top.toFixed(0)}: ${errs.join(" | ")}; up to 400: ${at400.join(" | ") || "none"}; from rest: ${fromRest.join(" | ") || "none"}`,
  );
}

function draftBots(): void {
  // Two Normal server bots (as added: a Sport and a Racer) on Rust Bowl over 3 laps: with the
  // slipstream (and Normal bots using it) the lead changes hands 1-4 times a lap on average and
  // never more than 4 times in a lap (no tug of war); before M4-DRAFT (no draft, every bot on its
  // lane) it did not change at all. Counted when the new leader is a car length clear.
  const after = draftRace({ track: "rust-bowl", levels: ["normal", "normal"], laps: 3 });
  const before = draftRace({ track: "rust-bowl", levels: ["normal", "normal"], laps: 3, nodraft: true, nowake: true });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  check(
    "draft bots: two Normal server bots, Rust Bowl, 3 laps: 1-4 lead changes per lap on average, never more than 4 in a lap (with the draft); a rerun is identical",
    sum(after.changes) >= 3 && sum(after.changes) <= 12 && after.changes.every((n) => n <= 4) && JSON.stringify(after) === JSON.stringify(draftRace({ track: "rust-bowl", levels: ["normal", "normal"], laps: 3 })),
    `per lap ${after.changes.join(",")} (before M4-DRAFT: ${before.changes.join(",")}); finish ${after.finish.map((f) => (f / 60).toFixed(2)).join("/")} s (before ${before.finish.map((f) => (f / 60).toFixed(2)).join("/")} s)`,
  );
  // Crashes (contacts closing at >= IMPACT_MIN_SPEED), wall hits and wrecks, before and after, on
  // every shipped track: two Normal bots, and the autopilot (a zero-lag Normal driver on the
  // centre line, weapons off) with three Normal bots.
  const tot = (rs: DraftRaceOut[]) => ({
    crashes: sum(rs.map((r) => r.crashes)), contacts: sum(rs.map((r) => r.contacts)), walls: sum(rs.map((r) => r.walls)), mineWalls: sum(rs.map((r) => r.mineWalls)),
    wrecks: sum(rs.map((r) => r.wrecks)), falls: sum(rs.map((r) => r.falls)),
  });
  const runs = (b: boolean) =>
    CAR_TRACKS.flatMap((track) => [
      draftRace({ track, levels: ["normal", "normal"], laps: 3, nodraft: b, nowake: b }),
      draftRace({ track, levels: ["normal", "normal", "normal"], laps: 3, pilot: true, nodraft: b, nowake: b }),
    ]);
  const b = tot(runs(true)), a = tot(runs(false));
  const fmt = (t: ReturnType<typeof tot>) => `crashes ${t.crashes} (contacts ${t.contacts}), wall hits ${t.walls} (+${t.mineWalls} sliding after a mine), wrecks ${t.wrecks}, falls ${t.falls}`;
  check(
    "draft bots: no more crashes, wall hits (other than a car a mine spun) or falls than before M4-DRAFT over 6 races on the shipped tracks",
    a.crashes <= b.crashes && a.walls <= b.walls && a.falls <= b.falls,
    `before: ${fmt(b)}; after: ${fmt(a)} (wrecks are rivets and mines: closer racing, more hits)`,
  );
  // The wake: Normal bots tuck in and pass; Easy bots never do.
  const easy = draftRace({ track: "rust-bowl", levels: ["easy", "easy"], laps: 1 });
  const normal = draftRace({ track: "rust-bowl", levels: ["normal", "normal", "normal"], laps: 3, pilot: true });
  check(
    "draft bots: Normal bots use the wake (tuck in, pass); Easy bots never do",
    normal.wake.tuck > 60 && normal.wake.passes > 0 && easy.wake.tuck === 0 && easy.wake.pass === 0,
    `Normal: tuck ${(normal.wake.tuck / 60).toFixed(1)} s, pass ${(normal.wake.pass / 60).toFixed(1)} s, ${normal.wake.passes} passes (${normal.wake.done} done, ${normal.wake.gaveUp} given up); Easy: ${easy.wake.tuck}/${easy.wake.pass}`,
  );
}

// ---- lightning cells and the boost (M4-CELLS, PLAN-M4.md 2.5, ClickUp 123jpnbfffk, 2026-11-20) ----

// This section's imports (hoisted like the ones at the top).
import {
  BOOST_ACCEL,
  BOOST_LEADER_TICKS,
  BOOST_TOP,
  boostOffer,
  boostTicksFor,
  boostTopSpeed,
  CELL_AIR_HEIGHT,
  CELL_RADIUS,
  CELL_RESPAWN,
  CELL_TOUCH,
  cellOpen,
  cellTouch,
} from "../shared/catchup";
import { airCellReach, cellReach, validateCells } from "../shared/weapons";
import { CAR_RADIUS } from "../shared/physics";
import { CELL_KERB } from "../shared/track";

/**
 * The cells test track: the draft straight (dead straight, heading +x, lat + = +y, from s ~ 1000
 * to 6000) with a kerb cell at s 2000 (lat 58), a jump (ramp 3000-3080, gap to 3200) with a low air
 * cell 4 past the lip (no car is ever high enough there) and a high one at 3150 (lat 20), an air
 * cell over solid ground at 4500 and a cell in the dirt at 5000 (lat 80).
 */
const CELLS_ID = "cells-test";
const CELLS_DEF: TrackDef = {
  ...DRAFT_STRAIGHT,
  id: CELLS_ID,
  name: "Cells Test",
  features: [
    { k: "cell", s: 2000, lat: 58 },
    { k: "ramp", s: 3000, len: 80 },
    { k: "gap", s0: 3080, s1: 3200 },
    { k: "cell", s: 3084, lat: 0, air: true },
    { k: "cell", s: 3150, lat: 20, air: true },
    { k: "cell", s: 4500, lat: 0, air: true },
    { k: "cell", s: 5000, lat: 80 },
  ],
  recovery: [0, 2600],
};

function cellsRule(): void {
  check(
    "cells rule: a cell is touched when a car's centre comes within its radius plus the car's (14 + 13); cellTouch is the earliest fraction of the tick, -1 for a miss",
    CELL_TOUCH === CELL_RADIUS + CAR_RADIUS && Math.abs(cellTouch(-50, 0, 0, 0, 0, 0) - (50 - CELL_TOUCH) / 50) < 1e-12 && cellTouch(-100, 0, -60, 0, 0, 0) === -1 &&
      cellTouch(-5, 0, 5, 0, 0, 0) === 0 && cellTouch(-30, CELL_TOUCH + 0.01, 30, CELL_TOUCH + 0.01, 0, 0) === -1 && cellTouch(-30, CELL_TOUCH - 0.1, 30, CELL_TOUCH - 0.1, 0, 0) > 0,
  );
  check(
    "cells rule: boost by the gap to the leader: leader 36 ticks, up to 400 behind 54, up to 1200 behind 72, further 90",
    [-5, 0, 1, 400, 401, 1200, 1201, 5000].map(boostTicksFor).join() === "36,36,54,54,72,72,90,90",
  );
  const field = [{ rd: 5000, fin: true }, { rd: 3000, fin: false }, { rd: 2500, fin: false }, { rd: 1500, fin: false }];
  check(
    "cells rule: the leader is the leading car that has not finished (a finisher far ahead does not count)",
    boostOffer(3000, field) === BOOST_LEADER_TICKS && boostOffer(2700, field) === 54 && boostOffer(2500, field) === 72 && boostOffer(1500, field) === 90 &&
      boostOffer(100, [{ rd: 100, fin: false }]) === BOOST_LEADER_TICKS,
  );
  check("cells rule: a cell is there at race tick rt when its back tick is 0 or reached", cellOpen(0, 0) && cellOpen(0, 999) && !cellOpen(500, 499) && cellOpen(500, 500));
  // cellReach: ground cells for cars on the ground, air cells for cars high in a jump; never a car
  // wrecked or falling (now or at the start of the tick).
  const t = buildTrack(CELLS_DEF);
  const [kerb, low, high, overGround] = t.cells;
  const at = (cell: typeof kerb, o: Partial<CarState>): CarState => ({ x: cell.x, y: cell.y, h: 0, vx: 400, vy: 0, seg: cell.seg, wreck: 0, air: 0, fall: 0, boost: 0, ...o });
  const flying = (cell: typeof kerb, air: number): CarState => at(cell, { air }); // 400 u/s: 48 air ticks in all
  check(
    `cells rule: a ground cell for a car on the ground only, an air cell only at airHeight >= ${CELL_AIR_HEIGHT}; nothing for a car wrecked or falling now or at the start of the tick`,
    cellReach(kerb, kerb.x - 5, kerb.y, false, at(kerb, {})) >= 0 && cellReach(kerb, kerb.x - 5, kerb.y, false, flying(kerb, 24)) === -1 &&
      cellReach(overGround, overGround.x - 5, overGround.y, false, at(overGround, {})) === -1 && cellReach(high, high.x - 5, high.y, false, flying(high, 24)) >= 0 &&
      airHeight(flying(high, 46)) < CELL_AIR_HEIGHT && cellReach(high, high.x - 5, high.y, false, flying(high, 46)) === -1 &&
      cellReach(kerb, kerb.x - 5, kerb.y, true, at(kerb, {})) === -1 && cellReach(kerb, kerb.x - 5, kerb.y, false, at(kerb, { wreck: 5 })) === -1 &&
      cellReach(kerb, kerb.x - 5, kerb.y, false, at(kerb, { fall: 5 })) === -1 && !!low,
  );
}

function boostPhysics(): void {
  // Boosted: accel x1.6, top speed x1.25 (the fixed step's terminal speed a (1 - k DT) / k, k the
  // boosted drag); no slipstream on top; it counts down every driving and flying tick, a wreck, a
  // fall and a recovery end it; the extra speed dies away over ~0.8 s afterwards.
  const t = buildTrack(DRAFT_STRAIGHT);
  const p = pointAt(t, 1200);
  const fresh = (boost: number): CarState => ({ x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost });
  const held = (draft: number) => {
    const c = fresh(1);
    for (let i = 0; i < 420; i++) stepCar(c, { throttle: 1, steer: laneSteer(t, c, 0) }, BASE_STATS, t, draft); // stepCar does not count it down
    return c;
  };
  const kb = (BASE_STATS.accel * BOOST_ACCEL) / (BASE_STATS.topSpeed * BOOST_TOP);
  const term = (BASE_STATS.accel * BOOST_ACCEL * (1 - kb * DT)) / kb;
  const one = fresh(1), plain = fresh(0);
  stepCar(one, { throttle: 1, steer: 0 }, BASE_STATS, t);
  stepCar(plain, { throttle: 1, steer: 0 }, BASE_STATS, t);
  check(
    `boost physics: accel x${BOOST_ACCEL}, top speed x${BOOST_TOP} (nominal ${boostTopSpeed(430).toFixed(1)} u/s), no slipstream on top`,
    Math.abs(speedOf(held(0)) - term) < 0.5 && Math.abs(speedOf(held(0)) / 421.33 - BOOST_TOP) < 0.01 && JSON.stringify(held(1)) === JSON.stringify(held(0)) &&
      Math.abs(speedOf(one) / speedOf(plain) - BOOST_ACCEL * (1 - kb * DT) / (1 - (BASE_STATS.accel / BASE_STATS.topSpeed) * DT)) < 1e-9,
    `boosted top ${speedOf(held(0)).toFixed(1)} u/s (unboosted 421.3); first tick ${speedOf(one).toFixed(3)} vs ${speedOf(plain).toFixed(3)}`,
  );
  // Countdown and the decay after it.
  const c = fresh(0);
  const env = raceEnv(t);
  const go = () => stepRaceCar(c, { throttle: 1, steer: laneSteer(t, c, 0) }, BASE_STATS, env);
  for (let i = 0; i < 300; i++) go();
  c.boost = 90;
  const v0 = speedOf(c);
  let ticks = 0;
  while (c.boost > 0 && ticks < 200) {
    go();
    ticks++;
  }
  const peak = speedOf(c);
  for (let i = 0; i < 50; i++) go(); // ~0.83 s
  const after = speedOf(c);
  const air = { ...fresh(30), air: 10, vx: 400 };
  stepRaceCar(air, NO_COMMAND, BASE_STATS, env);
  const wrecked = fresh(40);
  wreckCar(wrecked);
  check(
    "boost physics: 90 ticks of boost last 90 driving ticks (the car gains ~100 u/s), count down in flight too, end with a wreck; the extra speed then dies away with the car's own drag (about 1/e in 0.83 s)",
    ticks === 90 && peak > v0 + 80 && after - 421.33 < (peak - 421.33) / Math.E + 3 && after > 421.33 && air.boost === 29 && wrecked.boost === 0,
    `${v0.toFixed(1)} -> ${peak.toFixed(1)} u/s after the boost, ${after.toFixed(1)} u/s 50 ticks later`,
  );
}

/**
 * A room on the cells test track (racing, weapons cold) with cars placed by hand: cars[i] = [s,
 * lat, speed, progress s]. Ticks are fed full throttle straight on (heading +x).
 */
function cellsSim(cars: [number, number, number, number][]): { sim: Sim; ps: Player[]; t: Track } {
  const t = trackById(CELLS_ID);
  const sim = new Sim(1);
  const ps = cars.map((_, i) => sim.add(`C${i}`));
  if (sim.room.setTrack(ps[0], CELLS_ID)) throw new Error("track");
  sim.startRace(ps[0]);
  cars.forEach(([s0, lat, v, ps0], i) => {
    const pt = pointAt(t, s0);
    ps[i].car = { x: pt.x - Math.sin(pt.h) * lat, y: pt.y + Math.cos(pt.h) * lat, h: pt.h, vx: Math.cos(pt.h) * v, vy: Math.sin(pt.h) * v, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    ps[i].progress = { s: ps0, cp: 1, lap: 0, fin: 0 };
  });
  return { sim, ps, t };
}

/** Run until some car has a boost (or n ticks); the cars in `go` (default all) fed full throttle straight on, the rest idle. */
function runToPickup(sim: Sim, ps: Player[], n = 120, go: Player[] = ps): number {
  for (let i = 0; i < n; i++) {
    sim.run(1, (p) => ({ throttle: go.includes(p) ? 1 : 0, steer: 0 }));
    if (ps.some((p) => p.car!.boost > 0)) return i + 1;
  }
  return -1;
}

function cellsServer(): void {
  registerTestTrack(CELLS_DEF);
  // Ties: two cars mirrored about the dirt cell's line (lat 80 -+ 10, both in the dirt, clear of
  // each other), the same distance before it at the same speed, touch it at exactly the same
  // fraction of the same tick. The one further behind (lower race distance) takes it; with equal
  // race distances the one that joined first. (Their progress is set each tick: it is the tie-break.)
  const tie = (rdA: number, rdB: number) => {
    const { sim, ps } = cellsSim([[4950, 70, 300, rdA], [4950, 90, 300, rdB]]);
    for (let i = 0; i < 60 && ps.every((p) => p.car!.boost === 0); i++) {
      ps[0].progress!.s = rdA;
      ps[1].progress!.s = rdB;
      sim.run(1, () => ({ throttle: 1, steer: 0 }));
    }
    return ps.map((p) => p.car!.boost);
  };
  const lowB = tie(4950, 4949), lowA = tie(4949, 4950), same = tie(4950, 4950);
  check(
    "cells server: a tie (the same touch fraction) goes to the car further behind (lower race distance), then to the one that joined first; the other gets nothing",
    lowB[0] === 0 && lowB[1] > 0 && lowA[0] > 0 && lowA[1] === 0 && same[0] > 0 && same[1] === 0,
    `B behind: ${lowB.join("/")}; A behind: ${lowA.join("/")}; level: ${same.join("/")}`,
  );
  // The earliest touch wins, whoever is behind.
  const e = cellsSim([[1910, 46, 400, 2000], [1890, 70, 400, 1500]]);
  runToPickup(e.sim, e.ps);
  check("cells server: the car that touches it earliest in the tick takes it, even ahead in the race", e.ps[0].car!.boost > 0 && e.ps[1].car!.boost === 0, e.ps.map((p) => p.car!.boost).join("/"));
  // Respawn: back CELL_RESPAWN race ticks after it was taken; a car standing on it takes it at that
  // tick and not one before. The snapshot carries the tick it comes back.
  const r = cellsSim([[1900, 58, 400, 1900], [5500, 0, 0, 1000]]);
  runToPickup(r.sim, r.ps, 120, [r.ps[0]]);
  const takenAt = r.sim.room.rt;
  for (let i = 0; i < 30; i++) r.sim.run(1, (p) => ({ throttle: p === r.ps[0] ? 1 : 0, steer: 0 })); // the taker drives on, clear of the cell
  const shown = lastSnapOf(r.sim.conns.get(r.ps[0].id)!);
  const cell = trackById(CELLS_ID).cells[0];
  const [bx, by] = [cell.x, cell.y];
  r.ps[1].car = { ...r.ps[1].car!, x: bx, y: by, vx: 0, vy: 0, seg: cell.seg }; // parked on the cell
  let gotAt = -1;
  for (let i = 0; i < CELL_RESPAWN + 20 && gotAt < 0; i++) {
    r.sim.run(1, (p) => ({ throttle: p === r.ps[0] ? 1 : 0, steer: 0 }));
    if (r.ps[1].car!.boost > 0) gotAt = r.sim.room.rt;
  }
  check(
    `cells server: a taken cell is back ${CELL_RESPAWN} race ticks later (the snapshot says when), not a tick sooner`,
    r.sim.room.cells[0] === gotAt + CELL_RESPAWN && gotAt === takenAt + CELL_RESPAWN && shown?.cells?.[0] === takenAt + CELL_RESPAWN,
    `taken at rt ${takenAt}, snapshot ${shown?.cells?.join(",")}, taken again at rt ${gotAt}`,
  );
  // Air cells: only in flight and high enough. A car driving on the ground through the air cell over
  // solid ground (s 4500) does not take it; a car jumping at 400 u/s on lane 20 takes the high one
  // over the gap and never the low one just past the lip (it is too low there).
  const g = cellsSim([[4400, 0, 400, 4400]]);
  for (let i = 0; i < 40; i++) g.sim.run(1, () => ({ throttle: 1, steer: 0 }));
  const j = cellsSim([[2900, 20, 400, 2900], [2900, 0, 400, 2900]]);
  const jumped: number[][] = [];
  const peak = [0, 0];
  for (let i = 0; i < 90; i++) {
    j.sim.run(1, () => ({ throttle: 1, steer: 0 }));
    jumped.push(j.ps.map((p) => (p.car!.air > 0 ? 1 : 0)));
    j.ps.forEach((p, k) => (peak[k] = Math.max(peak[k], p.car!.boost)));
  }
  const cellsJ = j.sim.room.cells;
  check(
    "cells server: an air cell is taken only in the air and high in the jump: a car driving through one over solid ground does not take it; a jump on its lane takes the high one; nobody takes the low one at the lip",
    g.ps[0].car!.boost === 0 && g.sim.room.cells[3] === 0 && peak[0] > 0 && peak[1] === 0 && cellsJ[2] > 0 && cellsJ[1] === 0 && jumped.some((x) => x[0] === 1 && x[1] === 1),
    `ground through ${g.ps[0].car!.boost}; jump on lane 20: boost ${peak[0]}, lane 0: ${peak[1]}; cells ${cellsJ.join(",")}`,
  );
  // Ghosted and finished cars take nothing.
  const gh = cellsSim([[1900, 58, 400, 1900]]);
  gh.ps[0].ghost = 60;
  const fin = cellsSim([[1900, 58, 400, 1900]]);
  fin.ps[0].finished = true;
  check(
    "cells server: a ghosted or a finished car takes no cell",
    runToPickup(gh.sim, gh.ps, 40) === -1 && runToPickup(fin.sim, fin.ps, 40) === -1 && gh.sim.room.cells[0] === 0 && fin.sim.room.cells[0] === 0,
  );
  // The boost by the taker's gap to the leading unfinished car (a finished car further ahead does not count).
  const byGap = (gap: number) => {
    // The rival stands on the centre line `gap` ahead of the taker's start; a finisher far ahead.
    const b = cellsSim([[1900, 58, 400, 1900], [1900 + gap, 0, 0, 1900 + gap], [9000, 0, 0, 9000]]);
    b.ps[2].progress!.fin = 1234;
    b.ps[2].finished = true;
    runToPickup(b.sim, b.ps, 120, [b.ps[0]]);
    return b.ps[0].car!.boost;
  };
  const gaps = [-50, 200, 800, 1500].map(byGap);
  check(
    "cells server: the boost goes by the taker's gap to the leading car that has not finished: leader 36, ~150 behind 54, ~750 behind 72, ~1450 behind 90",
    gaps.join() === "36,54,72,90",
    gaps.join(","),
  );
  // A boost runs out and the car slows back down; a wreck ends it at once.
  const w = cellsSim([[1900, 58, 400, 1900]]);
  runToPickup(w.sim, w.ps);
  wreckCar(w.ps[0].car!);
  check("cells server: a wreck ends the boost", w.ps[0].car!.boost === 0);
}

/**
 * The own car's pickups predicted over a lagged in-process link: client A (oneWayMs each way)
 * drives the cells track on the kerb cell's lane, flat out; client B (no lag) optionally drives the
 * same lane `ahead` units in front of it, taking the cell first. Returns A's errors, whether A ever
 * predicted a boost the server did not give, and both server boosts after the cell.
 */
function cellsClientRun(oneWayMs: number, rival: boolean): { errs: number[]; stateErrs: number; predictedA: number; serverA: number; serverB: number; endA: number; logged: number } {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(1);
    const A = laggedGame(rooms, clock, oneWayMs), B = laggedGame(rooms, clock, 0);
    A.game.create("Ann");
    A.open();
    const tick = (stepA: boolean, stepB: boolean) => {
      clock.now += 1000 / 60;
      A.up();
      B.up();
      rooms.step(clock.now);
      A.down();
      B.down();
      if (stepA) A.game.step(drive(A.game), 1000 / 60);
      if (stepB) B.game.step(drive(B.game), 1000 / 60);
    };
    const t = trackById(CELLS_ID);
    const drive = (g: Game) => ({ throttle: 1, steer: g.car ? laneSteer(t, g.car, 58) : 0, fire: false, mine: false });
    for (let i = 0; i < 20; i++) tick(false, false);
    const room = [...rooms.rooms.values()][0];
    A.game.pickTrack(CELLS_ID);
    if (rival) {
      B.game.join(room.code, "Bo");
      B.open();
    }
    for (let i = 0; i < 20; i++) tick(false, false);
    if (rival) B.game.setReady(true);
    for (let i = 0; i < 20; i++) tick(false, false);
    A.game.start();
    while (room.phase !== "racing") tick(true, rival);
    // Put the cars on the straight, A at s 1500 and B 30 in front of it, both on the cell's lane.
    const place = (p: Player, s0: number) => {
      const pt = pointAt(t, s0);
      p.car = { x: pt.x, y: pt.y + 58, h: pt.h, vx: 400, vy: 0, seg: pt.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
      p.progress = { s: s0, cp: 1, lap: 0, fin: 0 };
    };
    place(room.players.get(A.game.you)!, 1500);
    if (rival) place(room.players.get(B.game.you)!, 1530);
    const e0 = A.game.recErrors.length;
    for (let i = 0; i < 30; i++) tick(true, rival); // the client takes on the new pose
    let predictedA = 0, serverA = 0, serverB = 0, endA = 0;
    const pa = room.players.get(A.game.you)!, pb = rival ? room.players.get(B.game.you)! : null;
    for (let i = 0; i < 150; i++) {
      tick(true, rival);
      if ((A.game.car?.boost ?? 0) > 0) predictedA++;
      serverA = Math.max(serverA, pa.car!.boost);
      serverB = Math.max(serverB, pb?.car?.boost ?? 0);
      endA = A.game.car?.boost ?? 0;
    }
    return { errs: A.game.recErrors.slice(e0 + 4), stateErrs: A.game.recStateErrors, predictedA, serverA, serverB, endA, logged: A.game.recErrors.length - e0 };
  } finally {
    performance.now = realNow;
  }
}

function cellsClient(): void {
  for (const ms of [0, 50]) {
    const r = cellsClientRun(ms, false);
    const max = Math.max(0, ...r.errs);
    check(
      `cells client: lag ${ms} ms each way: the client predicts its own pickup (its boost while the server gives it), with no boost state mismatch and no error > ${LARGE_ERR}`,
      r.predictedA > 30 && r.serverA > 0 && r.stateErrs === 0 && max <= LARGE_ERR,
      `predicted boost for ${r.predictedA} steps; state mismatches ${r.stateErrs}; max error ${max.toFixed(3)} over ${r.errs.length}`,
    );
  }
  // A car 30 in front takes it first: the lagged client may predict the pickup, but the replay
  // takes the boost away again (the snapshot says the cell is gone and its car has none).
  const c = cellsClientRun(50, true);
  check(
    "cells client: a rival takes the cell first: the server gives the lagged client nothing, and its prediction ends without a boost (the replay removed it); errors stay small",
    c.serverB > 0 && c.serverA === 0 && c.endA === 0 && Math.max(0, ...c.errs) <= 10,
    `rival boost ${c.serverB}; the client predicted a boost for ${c.predictedA} steps; max error ${Math.max(0, ...c.errs).toFixed(2)}; state mismatches ${c.stateErrs}`,
  );
}

function cellsValidate(): void {
  // B3: the shipped tracks' cells: Rust Bowl's three on the kerbs, an air cell over the Crusher Run
  // chasm and over the Overpass Knot crossing, all valid; their air cells reachable; and a boosted
  // jump (up to 537 u/s) still lands everywhere, for every car type at L0 and L3.
  const top = boostTopSpeed(430);
  const rows: string[] = [];
  let ok = true;
  for (const id of CAR_TRACKS) {
    const t = trackById(id);
    const errs = [...validateTrack(t), ...validateCells(t, top)];
    for (const car of CAR_TYPES) for (const lv of [0, 3]) errs.push(...validateJumpSweep(t, top, statsFor(car, { engine: lv, tyres: lv, welder: lv })));
    if (errs.length) ok = false;
    const reach = t.cells.filter((c) => c.air).map((c) => {
      const r = airCellReach(t, c, top);
      return r ? `air s ${c.s} lat ${c.lat}: from ${r.min} u/s, ${r.lanes} lanes of 4` : `air s ${c.s}: unreachable`;
    });
    rows.push(`${id}: ${t.cells.map((c) => `${c.air ? "air" : "kerb"}@${c.s}/${c.lat}`).join(" ")}${reach.length ? `; ${reach.join("; ")}` : ""}${errs.length ? `; ERRORS ${errs.join(" | ")}` : ""}`);
  }
  const rb = trackById("rust-bowl").cells, cr = trackById("crusher-run").cells, ok3 = trackById("overpass-knot").cells;
  check(
    "cells validate: the seeds (Rust Bowl kerbs, the Crusher Run chasm and the Overpass Knot crossing in the air) are valid, the air cells reachable, and every jump lands boosted up to 537 u/s for all types at L0 and L3",
    ok && rb.length === 3 && rb.every((c) => !c.air && Math.abs(c.lat) >= 64 - CELL_KERB) && cr.length === 1 && !!cr[0].air && trackById("crusher-run").gaps.some((g) => cr[0].s > g.s0 && cr[0].s < g.s1) &&
      ok3.length === 1 && !!ok3[0].air && trackById("overpass-knot").gaps.some((g) => ok3[0].s > g.s0 && ok3[0].s < g.s1) && Math.abs(cr[0].lat) > 30 && Math.abs(ok3[0].lat) > 30,
    rows.join(" || "),
  );
  // Each placement rule rejects a bad cell.
  const base = (cells: TrackDef["features"]) => buildTrack({ ...CELLS_DEF, id: "cells-bad", features: [...CELLS_DEF.features!.filter((f) => f.k !== "cell"), ...cells!] });
  const v = (cells: TrackDef["features"]) => validateTrack(base(cells)).join(" | ");
  const open = v([{ k: "cell", s: 2000, lat: 20 }]);
  const inGap = v([{ k: "cell", s: 3150, lat: 60 }]);
  const pit = buildTrack({ ...CELLS_DEF, id: "cells-pit", features: [{ k: "hole", s: 2000, lat: 50, r: 20 }, { k: "cell", s: 2000, lat: 58 }] });
  const startZone = v([{ k: "cell", s: 100, lat: 60 }]);
  const wall = v([{ k: "cell", s: 2000, lat: 100 }]);
  const far = validateCells(base([{ k: "cell", s: 4500, lat: 0, air: true }]), top).join(" | ");
  const fine = validateTrack(base([{ k: "cell", s: 2000, lat: 58 }, { k: "cell", s: 2100, lat: -80 }, { k: "cell", s: 3150, lat: 34, air: true }])).concat(
    validateCells(base([{ k: "cell", s: 3150, lat: 34, air: true }]), top),
  );
  check(
    "cells validate: rejected: a ground cell on the open road, in a gap, over a hole, in the start zone, past the wall, and an air cell no jump reaches; accepted: kerb, dirt and an air cell over a jump",
    open.includes("open road") && inGap.includes("in a gap") && validateTrack(pit).some((x) => x.includes("over a hole")) && startZone.includes("start zone") && wall.includes("past the wall") &&
      far.includes("not on the arc") && fine.length === 0,
    [open, inGap, validateTrack(pit).join(" | "), startZone, wall, far].join(" || "),
  );
  // The boost sweep catches a jump that only a boosted car overshoots (a pit where a 537 u/s flight comes down).
  const lip = 2080;
  const boosted = buildTrack({
    ...DRAFT_STRAIGHT,
    id: "boost-pit",
    features: [{ k: "ramp", s: 2000, len: 80 }, { k: "gap", s0: lip, s1: lip + 120 }, { k: "hole", s: lip + 525, lat: -32, r: 26 }],
    recovery: [0, 1500],
  });
  check(
    "cells validate: the boost sweep (537 u/s) catches a jump only a boosted car overshoots into a pit; at full draft (473) it lands",
    validateJumpSweep(boosted, top).some((x) => x.includes("lane -32") && x.includes("falls")) && validateJumpSweep(boosted, draftTopSpeed(430)).length === 0 && validateRunUps(boosted).length === 0,
    validateJumpSweep(boosted, top).join(" | "),
  );
}

/** One server race of bots of `levels` (the host retires at GO): boosts begun per bot (cells taken). */
function cellBotRace(track: string, levels: BotLevel[], laps: number): { pickups: number[]; ticks: number[] } {
  const sim = new Sim(laps);
  const host = sim.add("Host");
  if (sim.room.trackId !== track && sim.room.setTrack(host, track)) throw new Error("track");
  const bots = levels.map((l) => sim.room.addBot(host, l, sim.now) as Player);
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  const pickups = bots.map(() => 0), ticks = bots.map(() => 0), last = bots.map(() => 0);
  let rt = 0;
  while (sim.room.phase === "racing" && rt < 60 * 60 * 4) {
    sim.tick();
    rt++;
    bots.forEach((b, k) => {
      const v = b.car?.boost ?? 0;
      if (v > last[k]) pickups[k]++;
      last[k] = v;
      if (!ticks[k] && b.progress?.fin) ticks[k] = rt;
    });
  }
  return { pickups, ticks };
}

function cellsBots(): void {
  // B4: Normal bots take cells near their lane (kerb cells when their lane brings them there,
  // air cells over the jumps they take); Easy bots never do.
  const rows: string[] = [];
  let normal = 0;
  for (const id of CAR_TRACKS) {
    const n = cellBotRace(id, ["normal", "normal", "normal"], 3), e = cellBotRace(id, ["easy", "easy", "easy"], 1);
    normal += n.pickups.reduce((a, b) => a + b, 0);
    rows.push(`${id}: Normal ${n.pickups.join("/")} (finish ${n.ticks.map((x) => (x / 60).toFixed(1)).join("/")} s), Easy ${e.pickups.join("/")}`);
  }
  // Easy bots never steer for one (they pick one up only when it lies on their own line); Normal
  // bots do, within 30 of their lane, and not further.
  const t = trackById(CELLS_ID);
  const steerFor = (level: BotLevel, lateral: number) => {
    const p = pointAt(t, 1850);
    const car: CarState = { x: p.x, y: p.y + lateral, h: 0, vx: 400, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const mem = newBotMem(lateral, level);
    const view = (cells: number[] | undefined) => ({ car, track: t, stats: BASE_STATS, raceOn: true, raceSteps: 100, others: [], cells, rt: 10 });
    return [botControls(view(t.cells.map(() => 0)), mem).steer, botControls(view(undefined), newBotMem(lateral, level)).steer];
  };
  const n30 = steerFor("normal", 30), n24 = steerFor("normal", 24), e30 = steerFor("easy", 30), taken = (() => {
    const p = pointAt(t, 1850);
    const car: CarState = { x: p.x, y: p.y + 30, h: 0, vx: 400, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const view = { car, track: t, stats: BASE_STATS, raceOn: true, raceSteps: 100, others: [], cells: t.cells.map((_, i) => (i === 0 ? 400 : 0)), rt: 10 };
    return botControls(view, newBotMem(30, "normal")).steer === botControls({ ...view, cells: undefined }, newBotMem(30, "normal")).steer;
  })();
  check(
    "cells bots: Normal bots take cells (3-lap races, every shipped track) and steer for one within 30 of their lane (not 34 away, not one that is gone); Easy bots never steer for one",
    normal > 0 && n30[0] > n30[1] && n24[0] === n24[1] && e30[0] === e30[1] && taken,
    `${rows.join("; ")} (Easy ones only where a cell lies on their own line); steer to the kerb cell from lane 30: Normal ${n30.map((x) => x.toFixed(2)).join(" vs ")}, from lane 24: ${n24.map((x) => x.toFixed(2)).join(" vs ")}; Easy from 30: ${e30.map((x) => x.toFixed(2)).join(" vs ")}`,
  );
}

// ---- air cells off-centre (M4-CELLS follow-up: the gameplay review's N1, 2026-11-21) ----

// This section's imports (hoisted like the ones at the top).
import { CELL_AIR_OFF } from "../shared/track";

function cellsOffCentre(): void {
  // An air cell sits off the centre line (|lat| >= CELL_AIR_OFF), or every car that flies the jump
  // down the middle (the lane-0 bot) takes it. The cells test track's jump with one air cell at s 3150.
  const one = (lat: number) => buildTrack({ ...CELLS_DEF, id: "cells-centre", features: [...CELLS_DEF.features!.filter((f) => f.k !== "cell"), { k: "cell", s: 3150, lat, air: true }] });
  const v = (lat: number) => validateTrack(one(lat)).join(" | ");
  const lats = [0, CELL_AIR_OFF - 1, -(CELL_AIR_OFF - 1), CELL_AIR_OFF, -CELL_AIR_OFF, 34];
  const [centre, near, nearL, edge, edgeL, off] = lats.map(v);
  check(
    `cells off-centre: validation rejects an air cell at lat 0 and at |lat| ${CELL_AIR_OFF - 1} (either side), accepts |lat| ${CELL_AIR_OFF} and 34`,
    centre.includes("on the centre line") && near.includes("on the centre line") && nearL.includes("on the centre line") && edge === "" && edgeL === "" && off === "" &&
      validateCells(one(34), boostTopSpeed(430)).length === 0,
    lats.map((lat, i) => `lat ${lat}: ${[centre, near, nearL, edge, edgeL, off][i] || "ok"}`).join(" || "),
  );
  // Why that minimum: a car high in its jump flying straight along the centre line touches an air
  // cell just inside a touch's reach (CELL_TOUCH, inclusive) and passes one at CELL_AIR_OFF by.
  const t = one(34);
  const p = pointAt(t, 3150);
  const flight = (lat: number) =>
    cellReach({ k: "cell", s: 3150, lat, air: true, x: p.x, y: p.y + lat, seg: p.seg }, p.x - 10, p.y, false, { x: p.x + 10, y: p.y, h: 0, vx: 400, vy: 0, seg: p.seg, wreck: 0, air: 24, fall: 0, boost: 0 });
  const inside = CELL_TOUCH - 0.5;
  check(
    `cells off-centre: CELL_AIR_OFF ${CELL_AIR_OFF} = CELL_TOUCH ${CELL_TOUCH} + 1: a flight down the centre line takes an air cell at |lat| ${inside}, not one at ${CELL_AIR_OFF}`,
    CELL_AIR_OFF === CELL_TOUCH + 1 && flight(inside) >= 0 && flight(-inside) >= 0 && flight(CELL_AIR_OFF) === -1 && flight(-CELL_AIR_OFF) === -1,
    `touch at lat ${inside}: ${flight(inside).toFixed(3)} / ${flight(-inside).toFixed(3)}; at ${CELL_AIR_OFF}: ${flight(CELL_AIR_OFF)} / ${flight(-CELL_AIR_OFF)}`,
  );
  // The shipped air cells keep to it.
  const shipped = CAR_TRACKS.flatMap((id) => trackById(id).cells.filter((c) => c.air).map((c) => ({ id, lat: c.lat })));
  check(
    "cells off-centre: every shipped air cell is off-centre",
    shipped.length >= 2 && shipped.every((c) => Math.abs(c.lat) >= CELL_AIR_OFF),
    shipped.map((c) => `${c.id} lat ${c.lat}`).join(", "),
  );
}

// ---- Hard bot level (M4-HARD, PLAN-M4.md addendum 2026-11-21, ClickUp 123jpnbffqh, 2026-11-21) ----

// This section's imports (hoisted like the ones at the top).
import { goldenAll, goldenClient, HARD_TRACKS, pace, runRaces, traffic, withHard, type CarRow } from "../tools/debug/hard-tune";
import { apexLane, BOT_LEVELS, HARD, isBotLevel, resetBotMem, type BotMem, type BotMine, type BotOther } from "../shared/botdrive";
import { HARD_UPGRADES } from "../shared/botshop";
import { RIVET_SPEED } from "../shared/weapons";

/** When the M4-HARD sections began (their added runtime is printed at the end). */
const hardClock = { t0: 0 };

/**
 * Easy and Normal byte-identity (M4-HARD advisor change 3): the hashes tools/debug/hard-tune.ts
 * --golden printed on main at a7fa942, BEFORE shared/botdrive.ts was touched: every tick's
 * throttle/steer/fire/mine and car state (full float64 bits) and the wallets; server bots, every
 * shipped track, 3 bots, two 3-lap races; and one client (socket-bot path) race.
 */
const HARD_GOLDEN: Record<string, string> = {
  "rust-bowl easy": "18c705b27b88a5f7ac751b4ec55fc1ac596e2cf87b981997abb375625641e38c",
  "rust-bowl normal": "66296aa9e346580c4856ab4d4a64e9ae9306e4a4d5dabc2bf6d37ff146f6e471",
  "crusher-run easy": "962a1ab5523d30431f391cabf4d0cb1baff389febe48c4c5c7ee8261287bf8eb",
  "crusher-run normal": "2292d28aad4e16ffd00c18fc281812c0834406964eedafdbd28b2c40a3d4e9f2",
  "overpass-knot easy": "030246f58700d25177ae43ab8a9bb87ebaecd7600fef2f8a764f215fa33620e4",
  "overpass-knot normal": "4841eb7a9aff30cd4cd3ac02fdecbe8e82f035567bcebfbe0eedc060ade1370d",
  "client crusher-run": "af5b555839a4d32c11a32179850e7319179dc0bedc22a8a219d39e12e2244f4c",
};

function hardGolden(): void {
  hardClock.t0 = performance.now();
  const all = goldenAll();
  const bad = Object.keys(HARD_GOLDEN).filter((k) => all[k]?.hash !== HARD_GOLDEN[k]);
  check(
    "hard golden: Easy and Normal bots drive, shoot and shop byte-identically to before M4-HARD (server bots on every shipped track, two races; the client bot path)",
    bad.length === 0 && Object.keys(all).length === Object.keys(HARD_GOLDEN).length,
    bad.map((k) => `${k}: ${all[k]?.hash.slice(0, 12)} != ${HARD_GOLDEN[k].slice(0, 12)}`).join("; ") || `${Object.keys(all).length} hashes match`,
  );
}

function hardLevels(): void {
  check(
    "hard levels: \"hard\" is a bot level (isBotLevel, BOT_LEVELS in order); a made-up one is not",
    isBotLevel("hard") && !isBotLevel("insane") && !isBotLevel("Hard") && BOT_LEVELS.join() === "easy,normal,hard",
    BOT_LEVELS.join(),
  );
  const m = newBotMem(-24, "hard");
  m.lastMine = 900;
  const lastBefore = m.lastMine;
  resetBotMem(m);
  check(
    "hard levels: a Hard bot gets weapons and the slipstream (as Normal, not Easy); its last-mine step is in BotMem and resetBotMem forgets it",
    m.weapons && m.useWake && m.level === "hard" && lastBefore === 900 && m.lastMine === -Infinity && newBotMem(0, "hard").lastMine === -Infinity && !newBotMem(0, "easy").weapons,
  );
  // addBot "hard": accepted from the host, tagged in the room message; a wrong level and a guest refused.
  const R = botRooms();
  const { room, ann, bo, send } = R;
  send(ann, { t: "addBot", level: "hard" });
  send(ann, { t: "addBot", level: "extreme" as BotLevel });
  send(bo, { t: "addBot", level: "hard" });
  const infos = botInfos(lastRoomMsg(bo.conn));
  check(
    "hard levels: the host's addBot \"hard\" is accepted (the room message tags the bot \"hard\"); a wrong level and a guest's Hard are refused",
    R.bots().length === 1 && R.bots()[0].bot!.level === "hard" && infos.length === 1 && infos[0].bot === "hard" &&
      errMsgs(ann.conn).map((x) => x.msg).join() === "Unknown bot level" && errMsgs(bo.conn).map((x) => x.msg).join() === "Only the host can add a bot",
    `${infos.map((p) => `${p.name}:${p.bot}`).join()}; host errs ${errMsgs(ann.conn).map((x) => x.msg).join()}; guest errs ${errMsgs(bo.conn).map((x) => x.msg).join()}`,
  );
  // A human joining a full lobby replaces the last-added bot, here a Hard one.
  room.leave(bo.player!, R.clock.now);
  for (let i = 0; i < 3; i++) send(ann, { t: "addBot", level: i % 2 ? "easy" : "normal" });
  send(ann, { t: "addBot", level: "hard" });
  const before = R.bots().map((b) => `${b.name}:${b.bot!.level}`).join();
  const from = room.chatLines.length;
  const cy = R.join("Cy", room.code);
  check(
    "hard levels: a human joining a full room replaces the last-added bot, a Hard one (its leave line, then the join line)",
    before === "Gasket (bot):hard,Lugnut (bot):normal,Piston (bot):easy,Clutch (bot):normal,Axle (bot):hard" && !!cy.player &&
      R.bots().map((b) => `${b.name}:${b.bot!.level}`).join() === "Gasket (bot):hard,Lugnut (bot):normal,Piston (bot):easy,Clutch (bot):normal" &&
      linesSince(room, from).join("|") === "leave:Axle (bot) left the room|join:Cy joined the room",
    `${before} -> ${R.bots().map((b) => `${b.name}:${b.bot!.level}`).join()}; ${linesSince(room, from).join(" | ")}`,
  );
  // Over the wire: the host's Game adds a Hard bot and sees it tagged.
  const rooms = new Rooms(1);
  const A = wiredGame(rooms, { now: 1000 });
  A.game.create("Ann");
  A.open();
  A.flush();
  A.game.addBot("hard");
  A.flush();
  const hb = A.game.players.filter((p) => p.bot);
  check("hard levels: Game.addBot(\"hard\") over the wire: the bot is tagged hard (the lobby's \"hard bot\")", hb.length === 1 && hb[0].bot === "hard" && A.game.isBot(hb[0].id), hb.map((p) => `${p.name}:${p.bot}`).join());
}

function hardShop(): void {
  // Ammo to a floor of 20 rivets and 2 mines, then engine, welder, tyres (one level each), then
  // Normal's top-up (40 rivets, 3 mines), all while affordable (M4-HARD advisor change 8).
  const w = (scrap: number, rivets: number, mines: number, lv = { engine: 0, tyres: 0, welder: 0 }) => ({ scrap, levels: { ...lv }, ammo: { rivets, mines } });
  const cases: [string, ReturnType<typeof w>, string, string][] = [
    ["start (400)", startingWallet(), "rivets,mines", "rivets,mines"],
    ["500, 20 rivets, 2 mines", w(500, 20, 2), "engine", "rivets,mines"],
    ["1000, full ammo", w(1000, 40, 3), "engine,welder", "welder,tyres"],
    ["2000, no ammo", w(2000, 0, 0), "rivets,mines,engine,welder,tyres,rivets", "rivets,mines,welder,tyres,engine"],
    ["900, 0 rivets, 3 mines, engine 1", w(900, 0, 3, { engine: 1, tyres: 0, welder: 0 }), "rivets,welder,tyres", "rivets,welder,tyres"],
  ];
  const got = cases.map(([, wal]) => botShopping(wal, "hard").join());
  const gotN = cases.map(([, wal]) => botShopping(wal, "normal").join());
  check(
    "hard shop: Hard buys ammo to 20 rivets / 2 mines, then engine, welder, tyres, then tops ammo up as Normal (Normal's rule unchanged)",
    HARD_UPGRADES.join() === "engine,welder,tyres" && cases.every((c, i) => got[i] === c[2] && gotN[i] === c[3]),
    cases.map((c, i) => `${c[0]}: hard ${got[i]} (normal ${gotN[i]})`).join("; "),
  );
  // In the room: after the payout a Hard bot spends its scrap by its rule, exactly.
  const sim = new Sim(1);
  const host = sim.add("Host");
  const h = sim.room.addBot(host, "hard", sim.now) as Player;
  const added = `${h.wallet.scrap}|${h.ammo.rivets},${h.ammo.mines}`;
  h.wallet.scrap = 800;
  h.wallet.ammo.rivets = 0;
  h.wallet.ammo.mines = 0;
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  for (let i = 0; i < 60 * 60 && sim.room.phase === "racing"; i++) sim.tick();
  const res = sim.conns.get(host.id)!.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
  const want = { scrap: 800 + (res?.rows.find((r) => r.id === h.id)?.earned ?? NaN), levels: { engine: 0, tyres: 0, welder: 0 }, ammo: { rivets: 0, mines: 0 } };
  for (const item of botShopping(want, "hard")) shopBuy(want, item);
  check(
    "hard shop: a Hard bot shops with its starting scrap when added (20 rivets, 3 mines) and after the payout by its rule, exactly",
    added === "50|20,3" && JSON.stringify(h.wallet) === JSON.stringify(want) && h.wallet.levels.engine === 1,
    `added ${added}; after the race ${JSON.stringify(h.wallet)}`,
  );
}

/** A straight (DRAFT_STRAIGHT, s ~ x, lateral = y) for the gate tests: a car at s, lane, heading +x at v. */
const HARD_STRAIGHT = buildTrack(DRAFT_STRAIGHT);
function straightCar(s: number, lane: number, vx = 400, vy = 0): CarState {
  const p = pointAt(HARD_STRAIGHT, s);
  return { x: p.x, y: p.y + lane, h: 0, vx, vy, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
}

function hardWeapons(): void {
  // Rivets: a fire gate on relative velocity (the rivet flies along the heading with the car's
  // velocity, weapons.ts spawnShot); the bot never steers to aim. The slipstream is off here so
  // the line is the bot's own.
  const me = straightCar(2000, 0);
  const shoot = (level: BotLevel, o: CarState | null, raceSteps = 600) => {
    const mem = newBotMem(0, level);
    mem.useWake = false;
    const others = o ? [{ x: o.x, y: o.y, solid: true, id: "t", vx: o.vx, vy: o.vy }] : [];
    return botControls({ car: { ...me }, track: HARD_STRAIGHT, stats: BASE_STATS, raceOn: true, raceSteps, others, mines: [] }, mem);
  };
  // Crossing: 150 ahead and 40 to the left, moving right so it meets the rivet (900 u/s relative,
  // 131 from the nose: 0.1456 s), or not moving across, or moving away.
  const tCross = (150 - 19) / RIVET_SPEED;
  const cases: [string, CarState, boolean, boolean][] = [
    ["150 ahead on its line, same speed", straightCar(2150, 0), true, true],
    ["150 ahead, 30 across", straightCar(2150, 30), false, true],
    ["150 ahead, 40 left, crossing into the shot", straightCar(2150, -40, 400, 40 / tCross), true, true],
    ["150 ahead, 40 left, not crossing", straightCar(2150, -40), false, true],
    ["150 ahead, 40 left, moving away", straightCar(2150, -40, 400, -40 / tCross), false, true],
    ["600 ahead on its line (past the range once it flies)", straightCar(2600, 0, 400), false, false],
    ["100 behind", straightCar(1900, 0), false, false],
  ];
  const rows = cases.map(([what, o, wantH, wantN]) => {
    const h = shoot("hard", o), n = shoot("normal", o);
    return { what, ok: h.fire === wantH && n.fire === wantN, sameSteer: h.steer === shoot("hard", null).steer, h: h.fire, n: n.fire };
  });
  check(
    "hard weapons: Hard fires only when the rivet (along its heading, with its velocity) would pass the target within a hit plus HARD.rivetSlack, leading a crossing car; Normal's 15-degree cone fires at more",
    rows.every((r) => r.ok),
    rows.map((r) => `${r.what}: hard ${r.h} normal ${r.n}${r.ok ? "" : " WRONG"}`).join("; "),
  );
  check("hard weapons: Hard never steers to aim (its steer is the same with each target as with none)", rows.every((r) => r.sameSteer));
  check("hard weapons: no Hard rivet before the weapons arm (8 s: raceSteps 481 and less)", !shoot("hard", straightCar(2150, 0), 481).fire && shoot("hard", straightCar(2150, 0), 482).fire);
  // Mines: a follower on its line at 0.4 x its speed + 10 to 300 behind; 240 steps apart; after the arming.
  const drop = (mem: BotMem, o: CarState, raceSteps = 600) =>
    botControls({ car: { ...me }, track: HARD_STRAIGHT, stats: BASE_STATS, raceOn: true, raceSteps, others: [{ x: o.x, y: o.y, solid: true, id: "f", vx: o.vx, vy: o.vy }], mines: [] }, mem).mine;
  const fresh = () => {
    const m = newBotMem(0, "hard");
    m.useWake = false;
    return m;
  };
  const near = 0.4 * 400 + HARD.mineNear; // 170 at 400 u/s
  const mineCases: [string, CarState, number, boolean][] = [
    [`${near + 1} behind at 400 u/s`, straightCar(2000 - near - 1, 0), 600, true],
    ["250 behind", straightCar(1750, 0), 600, true],
    [`${near - 5} behind (it would be over the mine before it arms)`, straightCar(2000 - near + 5, 0), 600, false],
    ["310 behind", straightCar(1690, 0), 600, false],
    ["250 behind, 20 across", straightCar(1750, 20), 600, false],
    ["250 behind, 12 across", straightCar(1750, 12), 600, true],
    ["250 behind at 50 u/s (stopped)", straightCar(1750, 0, 50), 600, false],
    ["250 behind, before the weapons arm", straightCar(1750, 0), 470, false],
  ];
  const mrows = mineCases.map(([what, o, steps, want]) => ({ what, got: drop(fresh(), o, steps), want }));
  const m = fresh();
  const seq = [600, 601, 839, 840].map((st) => drop(m, straightCar(1750, 0), st));
  check(
    "hard weapons: Hard drops a mine when a solid car follows on its line between 0.4 x its speed + 10 and 300 behind (it reaches the mine as it arms), after the 8 s arming, then not for 240 steps",
    mrows.every((r) => r.got === r.want) && seq.join() === "true,false,false,true" && m.lastMine === 840,
    mrows.map((r) => `${r.what}: ${r.got}${r.got === r.want ? "" : " WRONG"}`).join("; ") + `; steps 600/601/839/840: ${seq.join("/")}`,
  );
}

function hardApex(): void {
  // The apex lane: by seat (each bot moves its own line), towards the inside, kept on the asphalt.
  const lanes = [-24, 24, 0, -12, 12].map((l) => apexLane(l, 1.2, 64));
  check(
    "hard apex: each seat's line moves the same way by HARD.apex (20) into a sharp bend (no convergence on one inside lane), half of it at a mild bend, none on a straight, kept 6 inside the asphalt",
    lanes.join() === "-4,44,20,8,32" && apexLane(24, -1.2, 64) === 4 && Math.abs(apexLane(0, 0.6, 64) - 10) < 1e-9 && apexLane(0, 0.25, 64) === 0 && apexLane(40, 1.2, 64) === 50 && apexLane(-40, -1.2, 64) === -50,
    `lanes -24,24,0,-12,12 -> ${lanes.join()}`,
  );
  // In a bend of Rust Bowl: the bias moves the aim (steer differs from apex 0) but never mem.lateral;
  // a mine on the apex path, or a running pass (the slipstream), keeps the bot on its own line.
  const t = trackById("rust-bowl");
  let s0 = -1, turn = 0;
  for (let s = 0; s < t.length && s0 < 0; s += 10) {
    const near = pointAt(t, s + 20).h, far = pointAt(t, s + 20 + 360 * HARD.bendLook).h;
    if (Math.abs(angleDiff(near, far)) > HARD.apexFull + 0.1 && Math.abs(angleDiff(pointAt(t, s).h, near)) < 0.05) {
      s0 = s;
      turn = angleDiff(near, far);
    }
  }
  const p = pointAt(t, s0);
  const car: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 300, vy: Math.sin(p.h) * 300, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const steer = (apex: number, extra: { mines?: BotMine[]; pass?: boolean } = {}) =>
    withHard({ apex }, () => {
      const mem = newBotMem(0, "hard");
      const others: BotOther[] = [];
      if (extra.pass) {
        const q = pointAt(t, s0 + 15);
        others.push({ x: q.x, y: q.y, solid: true, id: "p", vx: car.vx, vy: car.vy });
        mem.wake = { id: "p", pass: true, side: Math.sign(turn), steps: 10 };
      }
      const out = botControls({ car: { ...car }, track: t, stats: BASE_STATS, raceOn: true, raceSteps: 600, others, mines: extra.mines ?? [] }, mem);
      return { steer: out.steer, lateral: mem.lateral };
    });
  const inside = Math.sign(turn);
  const mineAt = (lat: number) => {
    const q = pointAt(t, s0 + 90);
    return [{ x: q.x - Math.sin(q.h) * lat, y: q.y + Math.cos(q.h) * lat }];
  };
  const a0 = steer(0), a20 = steer(20), blocked = steer(20, { mines: mineAt(inside * 12) }), blocked0 = steer(0, { mines: mineAt(inside * 12) });
  const outside = steer(20, { mines: mineAt(-inside * 40) }), pass20 = steer(20, { pass: true }), pass0 = steer(0, { pass: true });
  // A mine behind (review 2026-11-21): put in track coordinates from behind the car too, so one on
  // the apex lane 200-355 behind (the bot's own fresh mine, say) never switches the apex off.
  const behind = (d: number) => {
    const q = pointAt(t, s0 - d);
    return steer(20, { mines: [{ x: q.x - Math.sin(q.h) * inside * 12, y: q.y + Math.cos(q.h) * inside * 12 }] }).steer;
  };
  const behindOk = [200, 280, 300, 320, 340, 355].every((d) => behind(d) === a20.steer);
  check(
    "hard apex: in a Rust Bowl bend the bias steers the bot further to the inside without changing mem.lateral; a mine on the apex path or a running pass keeps it on its own line; a mine on the far side or behind the car does not",
    s0 >= 0 && Math.sign(a20.steer - a0.steer) === inside && a20.lateral === 0 && blocked.steer === blocked0.steer && outside.steer === a20.steer && pass20.steer === pass0.steer && behindOk,
    `bend at s ${s0} (turn ${turn.toFixed(2)}): steer apex 0 ${a0.steer.toFixed(3)}, apex 20 ${a20.steer.toFixed(3)}; mine on the path ${blocked.steer.toFixed(3)} (vs ${blocked0.steer.toFixed(3)}); mine outside ${outside.steer.toFixed(3)}; pass ${pass20.steer.toFixed(3)} vs ${pass0.steer.toFixed(3)}; mines 200-355 behind on the apex lane ${behindOk ? "ignored" : "SWITCH IT OFF"}`,
  );
  // Cells: within HARD.cellLane (45) of its lane, below 58 (lane 0 never reaches both kerbs).
  const cs = (level: BotLevel, lane: number) => {
    const q = pointAt(t, 2000);
    const c: CarState = { x: q.x - Math.sin(q.h) * lane, y: q.y + Math.cos(q.h) * lane, h: q.h, vx: Math.cos(q.h) * 400, vy: Math.sin(q.h) * 400, seg: q.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const v = (cells?: number[]) => botControls({ car: { ...c }, track: t, stats: BASE_STATS, raceOn: true, raceSteps: 600, others: [], cells, rt: 10 }, newBotMem(lane, level)).steer;
    return v(t.cells.map(() => 0)) !== v(undefined);
  };
  const kerb = Math.min(...HARD_TRACKS.flatMap((id) => trackById(id).cells.filter((c) => !c.air).map((c) => Math.abs(c.lat))));
  check(
    `hard apex: Hard goes for a kerb cell within HARD.cellLane (${HARD.cellLane}) of its lane (Rust Bowl's at lat -58 from lane -24, 34 away, where Normal does not), not from lane 0 or 12; HARD.cellLane < ${kerb} (no lane-0 bot reaches both kerbs)`,
    cs("hard", -24) && !cs("normal", -24) && !cs("hard", 0) && !cs("hard", -12) && HARD.cellLane < kerb,
  );
}

function hardPace(): void {
  // The band the user picked (2026-11-21): on every shipped track and car type, Hard closes 40-55 %
  // of the gap between Normal's lap and the flat-out ceiling (a lone bot, weapons off, lanes
  // -24/0/24, median of 3 laps), with no fall, wall contact or dirt.
  const rows = pace();
  for (const r of rows) {
    console.log(`  pace ${r.track} ${r.car}: Normal ${(r.normal / 60).toFixed(2)} s, flat-out ${(r.flat / 60).toFixed(2)} s, Hard ${(r.hard / 60).toFixed(2)} s (${((1 - r.hard / r.normal) * 100).toFixed(1)}% faster than Normal): closes ${(r.share * 100).toFixed(1)}% of the gap`);
  }
  const off = rows.filter((r) => !(r.share >= 0.4 && r.share <= 0.55));
  check(
    "hard pace: on every shipped track and car type Hard's lap closes 40-55% of the Normal-to-flat-out gap (the band the user picked), with no fall, wall contact or dirt",
    rows.length === 9 && off.length === 0 && rows.every((r) => r.falls[2] + r.walls[2] + r.dirt[2] === 0),
    off.map((r) => `${r.track} ${r.car} ${(r.share * 100).toFixed(1)}%`).join("; ") || `closes ${(Math.min(...rows.map((r) => r.share)) * 100).toFixed(1)}-${(Math.max(...rows.map((r) => r.share)) * 100).toFixed(1)}%`,
  );
}

function hardTraffic(): void {
  // 3-lap races of 3 bots of one level in traffic (slipstream to 473 u/s, cells to 537, weapons):
  // every shipped track, with the mix and all-Sport, all-Racer, all-Truck.
  const n = traffic("normal"), h = traffic("hard"), h2 = traffic("hard");
  const sum = (xs: { rows: CarRow[] }[], f: (r: CarRow) => number) => xs.reduce((a, x) => a + x.rows.reduce((b, r) => b + f(r), 0), 0);
  const worse: string[] = [];
  for (const id of HARD_TRACKS) {
    const on = (xs: typeof n) => xs.filter((x) => x.key.startsWith(`${id} `));
    const [fn, fh, wn, wh] = [sum(on(n), (r) => r.falls), sum(on(h), (r) => r.falls), sum(on(n), (r) => r.walls), sum(on(h), (r) => r.walls)];
    console.log(`  traffic ${id}: falls Normal ${fn} Hard ${fh}; wall contacts Normal ${wn} Hard ${wh}; after a mine spin Normal ${sum(on(n), (r) => r.mineWalls)} Hard ${sum(on(h), (r) => r.mineWalls)}; wrecks Normal ${sum(on(n), (r) => r.wrecks)} Hard ${sum(on(h), (r) => r.wrecks)}`);
    if (fh > fn || wh > wn) worse.push(`${id}: falls ${fh} vs ${fn}, walls ${wh} vs ${wn}`);
  }
  check("hard traffic: in traffic Hard has no more falls and wall contacts than Normal on any shipped track (4 races of 3 bots each)", worse.length === 0, worse.join("; ") || `falls Normal ${sum(n, (r) => r.falls)} Hard ${sum(h, (r) => r.falls)}`);
  const finished = h.every((x) => x.rows.every((r) => r.finish[0] > 0));
  check(
    "hard traffic: 3 Hard bots finish every shipped track with every car type (all Sport, all Racer, all Truck, and the mix), identically on a rerun",
    finished && JSON.stringify(h) === JSON.stringify(h2),
    h.map((x) => `${x.key} ${x.rows.map((r) => (r.finish[0] / 60).toFixed(1)).join("/")} s`).join("; "),
  );
  const rate = (xs: typeof n, hit: (r: CarRow) => number, all: (r: CarRow) => number) => sum(xs, hit) / Math.max(1, sum(xs, all));
  const hr = rate(h, (r) => r.rivetHits, (r) => r.rivets), nr = rate(n, (r) => r.rivetHits, (r) => r.rivets);
  const hm = rate(h, (r) => r.mineHits, (r) => r.mines), nm = rate(n, (r) => r.mineHits, (r) => r.mines);
  console.log(`  traffic: rivets that hit (of fired): Hard ${(hr * 100).toFixed(0)}% (${sum(h, (r) => r.rivetHits)}/${sum(h, (r) => r.rivets)}), Normal ${(nr * 100).toFixed(0)}% (${sum(n, (r) => r.rivetHits)}/${sum(n, (r) => r.rivets)}); mines that hit: Hard ${(hm * 100).toFixed(0)}% (${sum(h, (r) => r.mineHits)}/${sum(h, (r) => r.mines)}), Normal ${(nm * 100).toFixed(0)}% (${sum(n, (r) => r.mineHits)}/${sum(n, (r) => r.mines)})`);
  check("hard traffic: Hard's rivets hit 70-80% of the shots it fires (\"a little miss\", the user 2026-11-21)", hr >= 0.7 && hr <= 0.8, `Hard ${(hr * 100).toFixed(1)}%, Normal ${(nr * 100).toFixed(1)}%`);
}

function hardVs(): void {
  // REPORT (not a gate): 3 Hard against 3 Normal in one room (the host's seat drives as the sixth
  // bot, a tool-only trick), 3 races of 3 laps per track, Hard on the first three seats and then
  // on the last three; races won, and each level's scrap earned over the 3 races (the snowball).
  const lines: string[] = [];
  let ok = true;
  for (const id of HARD_TRACKS) {
    for (const hardFirst of [true, false]) {
      const levels: BotLevel[] = hardFirst ? ["hard", "hard", "hard", "normal", "normal"] : ["normal", "normal", "normal", "hard", "hard"];
      const rows = runRaces({ track: id, levels, hostBot: hardFirst ? "normal" : "hard", races: 3 });
      ok &&= rows.every((r) => r.place.length === 3 && r.place.every((p) => p > 0));
      const of = (l: BotLevel) => rows.filter((r) => r.level === l);
      const wins = (l: BotLevel) => of(l).reduce((a, r) => a + r.place.filter((x) => x === 1).length, 0);
      const earned = (l: BotLevel) => of(l).map((r) => r.earned.reduce((a, b) => a + b, 0));
      const wrecks = (l: BotLevel) => of(l).reduce((a, r) => a + r.wrecks, 0);
      lines.push(`${id} (Hard ${hardFirst ? "first" : "last"}): races won Hard ${wins("hard")} Normal ${wins("normal")}; scrap earned over 3 races Hard ${earned("hard").join("/")}, Normal ${earned("normal").join("/")}; wrecks Hard ${wrecks("hard")} Normal ${wrecks("normal")}`);
    }
  }
  for (const l of lines) console.log(`  vs ${l}`);
  check("hard vs: 3 Hard against 3 Normal, 3 races per track, both seatings: every race ends with all six placed (report printed above)", ok, `${lines.length} series`);
}

function hardClient(): void {
  // The socket bots' path (BotDriver over the client Game, as botplay --level hard): three Hard
  // client bots finish, the prediction matches the server, a rerun is identical.
  const rows = ["crusher-run", "overpass-knot"].map((id) => ({ id, a: goldenClient(id, 2, "hard"), b: goldenClient(id, 2, "hard") }));
  check(
    "hard client: three Hard client bots (BotDriver over the Game) finish 2 laps of Crusher Run and Overpass Knot, no air/fall state mismatch, identically on a rerun",
    rows.every((r) => r.a.finish[0].every((f) => f > 0) && r.a.stateErrs === 0 && r.a.hash === r.b.hash),
    rows.map((r) => `${r.id}: finish ${r.a.finish[0].map((f) => (f / 1000).toFixed(2)).join("/")} s, state mismatches ${r.a.stateErrs}`).join("; "),
  );
  // Race after race (review 2026-11-21): the driver's race steps start over between races and so
  // must its last-mine step, or the mine gap holds every mine back after race 1. Three 1-lap races
  // of Crusher Run, each bot shopping by the Hard rule before each (as botplay --level hard does);
  // before the fix: 0/3/3 mines in race 1, then 0/0/0.
  const m = goldenClient("crusher-run", 1, "hard", 3, true);
  const per = (xs: number[][] | undefined) => (xs ?? []).map((r) => r.reduce((a, b) => a + b, 0));
  check(
    "hard client: Hard client bots drop mines in every race, not only the first (3 races in one room, botplay's driver and shop rule)",
    m.dropped!.length === 3 && per(m.dropped).every((x) => x > 0) && per(m.presses).every((x) => x > 0) && m.finish.every((f) => f.every((x) => x > 0)),
    `mines dropped per race (bots on lanes -24/0/24): ${m.dropped!.map((r) => r.join("/")).join(", ")}; presses ${m.presses!.map((r) => r.join("/")).join(", ")}`,
  );
}

function hardCpu(): void {
  // 1 human (retired at GO) + 5 Hard bots, 3 laps of Crusher Run (ramps, gaps, holes, mines on the
  // track): each bot step and every room tick timed.
  const sim = new Sim(3);
  const host = sim.add("Host");
  sim.room.setTrack(host, "crusher-run");
  for (let i = 0; i < 5; i++) sim.room.addBot(host, "hard", sim.now);
  sim.room.start(host, sim.now);
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  const tickMs: number[] = [];
  const steps: number[] = [];
  botTiming.samples = steps;
  let ticks = 0;
  try {
    while (sim.room.phase === "racing" && ticks < 60 * 300) {
      sim.tickNo++;
      sim.now += 1000 / 60;
      const t0 = performance.now();
      sim.room.tick(sim.tickNo, sim.now);
      tickMs.push(performance.now() - t0);
      ticks++;
    }
  } finally {
    botTiming.samples = null;
  }
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const med = pct(steps, 0.5), tickMed = pct(tickMs, 0.5);
  console.log(`  CPU: Hard bot step median ${(med * 1000).toFixed(2)} us, p99 ${(pct(steps, 0.99) * 1000).toFixed(2)} us over ${steps.length} steps; room tick with 5 Hard bots median ${(tickMed * 1000).toFixed(2)} us, p99 ${(pct(tickMs, 0.99) * 1000).toFixed(2)} us, max ${(Math.max(...tickMs) * 1000).toFixed(1)} us over ${tickMs.length} ticks`);
  check(
    "hard CPU: the median Hard bot step stays <= 0.05 ms (the gate fails above 0.2 ms); room tick with 5 Hard bots printed",
    steps.length > 5 * 3000 && med <= 0.2 && (sim.room.phase as string) === "results",
    `median bot step ${med.toFixed(5)} ms (${med <= 0.05 ? "within" : "OVER"} the 0.05 ms target); room tick median ${tickMed.toFixed(4)} ms over ${ticks} ticks`,
  );
  const added = (performance.now() - hardClock.t0) / 1000;
  console.log(`  M4-HARD sections' runtime (hardGolden .. hardCpu): ${added.toFixed(1)} s`);
  check("hard CPU: the M4-HARD sim-test sections add at most 30 s (printed)", added <= 30, `${added.toFixed(1)} s`);
}

// ---- track feature schema (M4-SCHEMA, PLAN-M4.md 2.2-2.6, ClickUp 123jpnbffqj, 2026-11-21) ----
// Data only: the M4 surfaces, obstacles and split lanes are typed, placed by buildTrack and checked
// by validateTrack; physics, bots and collisions do not read them yet (M4-SURF, M4-MOVE).

// This section's imports (hoisted like the ones at the top).
import {
  BARREL_R,
  barrelLat,
  curvatureAt,
  DRY_LANE_MIN,
  GRID_SLOTS,
  gridSlotSL,
  halfAt,
  LANE_MIN,
  PRESS_DOWN,
  PRESS_UP,
  PRESS_WARN_TICKS,
  PRESS_WARNING,
  pressDown,
  pressState,
  SOLID_CLEAR,
  TRUCK_BAND,
  TRUCK_CAB,
  TRUCK_HALF,
  TRUCK_MIN_SPEED,
  truckLipAt,
  wallAt,
  WIDEN_TAPER,
  widenAt,
  type Feature,
} from "../shared/track";
import { PREVIEW_YARD, TEST_TRACKS, testTrack } from "../shared/testtracks";
import { isTrackId } from "../shared/tracks";
import { CAR_LENGTH } from "../shared/physics";

/** The preview yard's loop with no features: one feature at a time goes on it. */
const SCHEMA_LOOP: TrackDef = { ...PREVIEW_YARD, id: "schema-loop", features: [], recovery: [0, 3200, 5500] };

/** The preview yard with `extra` features added (and those `drop` picks removed): validateTrack's messages, joined. */
function schemaErrs(extra: Feature[], drop: (f: Feature) => boolean = () => false): string {
  const features = [...PREVIEW_YARD.features!.filter((f) => !drop(f)), ...extra];
  return validateTrack(buildTrack({ ...PREVIEW_YARD, id: "schema-bad", features })).join(" | ");
}

/** A minimal valid placement of every M4 feature type (the island with the widen it needs). */
const SCHEMA_ONE: Record<string, Feature[]> = {
  water: [{ k: "water", s0: 1450, s1: 1620, lat0: -64, lat1: 64 }],
  dirt: [{ k: "dirt", s0: 6000, s1: 6750, lat0: 28, lat1: 108 }],
  belt: [{ k: "belt", s0: 8800, s1: 9100, lat0: -64, lat1: 64, vx: -60 }],
  tyres: [{ k: "tyres", s: 880, lat: 32, r: 26 }],
  barrels: [{ k: "barrels", s: 1260, n: 3, period: 240, speed: 110 }],
  truck: [{ k: "truck", s: 3450, lat: 30, len: 110 }],
  press: [{ k: "press", s: 6820, lat0: 0, lat1: 64, period: 180, down: 60 }],
  widen: [{ k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 }],
  island: [{ k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 }, { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 }],
};

function schemaTypes(): void {
  // Each feature type parses (buildTrack puts it in its own array, placed) and validates, alone on the loop.
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  for (const [kind, features] of Object.entries(SCHEMA_ONE)) {
    const t = buildTrack({ ...SCHEMA_LOOP, id: `schema-${kind}`, features });
    const errs = validateTrack(t);
    const f = features[features.length - 1];
    let placed = false, detail = "";
    switch (f.k) {
      case "water":
        placed = t.water.length === 1 && t.water[0].s0 === f.s0 && t.water[0].lat1 === f.lat1;
        break;
      case "dirt":
        placed = t.dirt.length === 1 && t.dirt[0].s1 === f.s1;
        break;
      case "belt":
        placed = t.belts.length === 1 && t.belts[0].vx === f.vx;
        break;
      case "tyres": {
        const p = pointAt(t, f.s), m = t.tyres[0];
        placed = t.tyres.length === 1 && near(m.x, p.x - Math.sin(p.h) * f.lat) && near(m.y, p.y + Math.cos(p.h) * f.lat) && m.seg === p.seg;
        detail = `at ${m.x.toFixed(1)},${m.y.toFixed(1)}`;
        break;
      }
      case "barrels": {
        const b = t.barrels[0];
        const span = 2 * t.wall - 2 * BARREL_R;
        placed = t.barrels.length === 1 && b.lat0 === -t.wall + BARREL_R && b.lat1 === t.wall - BARREL_R && b.offsets.join() === "0,80,160" &&
          near(b.roll, (span / 110) * TICK_HZ) && near(b.nx, -Math.sin(b.h)) && near(b.ny, Math.cos(b.h));
        detail = `run ${b.lat0}..${b.lat1}, offsets ${b.offsets.join("/")}, a crossing ${b.roll.toFixed(1)} ticks`;
        break;
      }
      case "truck": {
        const k = t.trucks[0];
        const a = pointAt(t, f.s + TRUCK_HALF), z = pointAt(t, f.s + f.len - TRUCK_HALF);
        placed = t.trucks.length === 1 && k.lip === f.s + f.len - TRUCK_CAB && k.band0 === f.lat - TRUCK_BAND && k.band1 === f.lat + TRUCK_BAND &&
          near(k.x0, a.x - Math.sin(a.h) * f.lat) && near(k.y1, z.y + Math.cos(z.h) * f.lat);
        detail = `lip ${k.lip}, band ${k.band0}..${k.band1}`;
        break;
      }
      case "press": {
        const p = pointAt(t, f.s), m = t.presses[0];
        placed = t.presses.length === 1 && m.x === p.x && m.y === p.y && m.h === p.h && m.seg === p.seg;
        break;
      }
      case "widen":
        placed = t.widens.length === 1 && t.halfL.some((h) => h === 64 + 60) && t.wallR.some((w) => w === 64 + 60 + 44);
        break;
      case "island":
        placed = t.islands.length === 1 && t.islands[0].lat0 === -28 && t.widens.length === 1;
        break;
    }
    const others = (["water", "dirt", "belts", "tyres", "barrels", "trucks", "presses", "widens", "islands"] as const).filter((key) => t[key].length > 0);
    check(`schema types: a ${kind} parses (placed by buildTrack: ${others.join(", ")}) and validates alone on the loop`, placed && errs.length === 0, `${detail}${errs.length ? ` errors: ${errs.join(" | ")}` : ""}`);
  }
}

function schemaArrays(): void {
  // Per-sample half-widths and walls: today's halfWidth and wall everywhere on the shipped tracks
  // (no widen), and none of the new features on them.
  const shipped = trackList().filter((e) => CAR_TRACKS.includes(e.id)).map((e) => buildTrack(e.def));
  const flat = shipped.every((t) => {
    const n = t.pts.length;
    return [t.halfL, t.halfR, t.wallL, t.wallR].every((a) => a.length === n) &&
      t.halfL.every((h, i) => h === t.def.halfWidth && t.halfR[i] === t.def.halfWidth && t.wallL[i] === t.wall && t.wallR[i] === t.wall) &&
      t.water.length + t.dirt.length + t.belts.length + t.tyres.length + t.barrels.length + t.trucks.length + t.presses.length + t.widens.length + t.islands.length === 0;
  });
  check("schema arrays: on every shipped track halfL = halfR = halfWidth and wallL = wallR = wall at every sample; no new features", flat && shipped.length === 3, shipped.map((t) => `${t.def.id}: ${t.pts.length} samples`).join(", "));

  // A widen: 0 at s0, half at s0 + taper/2, full from s0 + taper to s1 - taper, back to 0 at s1; the
  // per-sample arrays are halfAt/wallAt at each sample.
  const w = { s0: 5750, s1: 7050, left: 60, right: 40 };
  const t = buildTrack({ ...SCHEMA_LOOP, id: "schema-widen", features: [{ k: "widen", ...w }] });
  const at = (s: number) => [halfAt(t, s, -1), halfAt(t, s, 1)].join("/");
  const ok =
    at(w.s0) === "64/64" && at(w.s0 - 1) === "64/64" && at(w.s0 + WIDEN_TAPER / 2) === "94/84" && at(w.s0 + WIDEN_TAPER) === "124/104" &&
    at((w.s0 + w.s1) / 2) === "124/104" && at(w.s1 - WIDEN_TAPER) === "124/104" && at(w.s1 - WIDEN_TAPER / 2) === "94/84" && at(w.s1) === "64/64" &&
    wallAt(t, 6400, -1) === 124 + 44 && wallAt(t, 6400, 1) === 104 + 44 && widenAt(t, 6400 + t.length, -1) === 60 &&
    t.halfL.every((h, i) => h === halfAt(t, t.cum[i], -1) && t.halfR[i] === halfAt(t, t.cum[i], 1) && t.wallL[i] === h + 44 && t.wallR[i] === t.halfR[i] + 44);
  const inWiden = t.cum.map((c, i) => ({ c, i })).filter((x) => x.c > w.s0 && x.c < w.s1);
  check(
    "schema arrays: a widen (left 60, right 40) tapers over 120 at each end; halfL/halfR/wallL/wallR are its widths at every sample",
    ok && inWiden.length > 10,
    `${inWiden.length} samples inside; s0+60: ${at(w.s0 + 60)}, middle: ${at(6400)}, s1: ${at(w.s1)}`,
  );

  // The corridor check reads the per-sample walls: a widen that pushes the bottom straight's right
  // wall up to the top straight (2000 away) is rejected; a smaller one is not.
  const corridor = (right: number) => validateTrack(buildTrack({ ...SCHEMA_LOOP, id: "schema-corridor", features: [{ k: "widen", s0: 5750, s1: 7050, left: 0, right }] })).join(" | ");
  const wide = corridor(1900), fine = corridor(1500);
  check("schema arrays: the corridor check uses the per-sample walls (a widen reaching another section is rejected)", wide.includes("ground corridors overlap") && fine === "", `right 1900: ${wide || "ok"}; right 1500: ${fine || "ok"}`);
}

function schemaLateral(): void {
  // nearest() returns the signed lateral offset: + right of travel, - left, |lat| = dist exactly.
  let worst = 0, worstFar = 0, bad = 0, samples = 0;
  for (const id of CAR_TRACKS) {
    const t = trackById(id);
    for (let i = 0; i < t.pts.length; i += 3) {
      const p = pointAt(t, t.cum[i] + 1.3);
      for (const lat of [-100, -40, -2, 2, 40, 100]) {
        const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
        const q = queryTrackNear(t, x, y, p.seg), g = queryTrack(t, x, y);
        samples++;
        if (Math.abs(q.lat) !== q.dist || Math.sign(q.lat) !== Math.sign(lat) || (g.seg === q.seg && g.lat !== q.lat)) bad++;
        if (Math.abs(lat) <= 40) worst = Math.max(worst, Math.abs(q.lat - lat));
        else worstFar = Math.max(worstFar, Math.abs(q.lat - lat));
      }
    }
  }
  check(
    "schema lateral: queryTrackNear/queryTrack give the signed lateral offset (+ right of travel, |lat| = dist) on every shipped track",
    bad === 0 && samples > 1000 && worst < 1,
    `${samples} points, ${bad} wrong; the most |lat - offset| up to 40 off ${worst.toFixed(4)}, at 100 off ${worstFar.toFixed(2)} (points placed along a segment's normal; 100 off on the inside of a bend tighter than that is nearer another segment)`,
  );
}

function schemaRt(): void {
  // The moving obstacles are pure functions of the race tick: periodic, the same from any call
  // order and from a second build of the same track (server, client and renderer agree).
  const t = testTrack(PREVIEW_YARD.id)!, t2 = buildTrack(PREVIEW_YARD);
  const b = t.barrels[0], b2 = t2.barrels[0];
  const same = (u: number, v: number) => Object.is(u, v);
  let periodic = true, determ = true, stagger = true;
  for (let k = 0; k < b.n; k++) {
    for (let rt = 0; rt < 3 * b.period; rt++) {
      const v = barrelLat(b, k, rt);
      periodic &&= same(v, barrelLat(b, k, rt + b.period)) && same(v, barrelLat(b, k, rt + 9 * b.period));
      determ &&= same(v, barrelLat(b2, k, rt));
      stagger &&= same(v, barrelLat(b, 0, rt + b.offsets[k]));
    }
  }
  const shuffled = [517, 3, 240, 1, 999, 0, 77].map((rt) => barrelLat(b, 1, rt)).join();
  const again = [517, 3, 240, 1, 999, 0, 77].map((rt) => barrelLat(b, 1, rt)).join();
  // One cycle of barrel 0: from the left wall at |speed| per second, to the right wall, then the gutter.
  const step = Math.abs(b.speed) / TICK_HZ;
  const cycle = Array.from({ length: b.period }, (_, rt) => barrelLat(b, 0, rt));
  const onRoad = cycle.filter((v) => !Number.isNaN(v));
  const steady = onRoad.every((v, i) => i === 0 || Math.abs(v - onRoad[i - 1] - step) < 1e-9);
  const gutter = cycle.slice(onRoad.length).every((v) => Number.isNaN(v));
  const rev = buildTrack({ ...SCHEMA_LOOP, id: "schema-rev", features: [{ k: "barrels", s: 1260, n: 2, period: 200, speed: -90 }] }).barrels[0];
  check(
    "schema rt: a barrel's lateral position is periodic in its period, staggered by floor(k * period / n), deterministic (two builds, any call order)",
    periodic && determ && stagger && shuffled === again,
    `row of ${b.n}, period ${b.period}, offsets ${b.offsets.join("/")}`,
  );
  check(
    "schema rt: a barrel rolls from the near wall to the far one at |speed| per second, then sits in the gutter (NaN) until its cycle starts again; speed < 0 rolls the other way",
    steady && gutter && onRoad[0] === b.lat0 && onRoad.length === Math.floor(b.roll) + 1 && onRoad[onRoad.length - 1] <= b.lat1 &&
      barrelLat(rev, 0, 0) === rev.lat1 && barrelLat(rev, 0, 1) < rev.lat1,
    `on the road ${onRoad.length} ticks (${onRoad[0]} .. ${onRoad[onRoad.length - 1].toFixed(2)}), in the gutter ${b.period - onRoad.length}; reversed starts at ${rev.lat1}`,
  );

  // The press: up, then PRESS_WARN_TICKS of warning, then `down` ticks down, every period.
  const p = t.presses[0], p2 = t2.presses[0];
  const states = Array.from({ length: p.period }, (_, rt) => pressState(p, rt));
  const count = (v: number) => states.filter((x) => x === v).length;
  const firstDown = states.indexOf(PRESS_DOWN), firstWarn = states.indexOf(PRESS_WARNING);
  let pPeriodic = true;
  for (let rt = 0; rt < 4 * p.period; rt++) {
    pPeriodic &&= pressState(p, rt) === pressState(p, rt + p.period) && pressState(p, rt) === pressState(p2, rt) && pressDown(p, rt) === (pressState(p, rt) === PRESS_DOWN);
  }
  check(
    `schema rt: a press is down for its last \`down\` ticks of each period, its shadow warns for the ${PRESS_WARN_TICKS} ticks (0.5 s) before, periodic and deterministic`,
    pPeriodic && count(PRESS_DOWN) === p.down && count(PRESS_WARNING) === PRESS_WARN_TICKS && count(PRESS_UP) === p.period - p.down - PRESS_WARN_TICKS &&
      firstDown === p.period - p.down && firstWarn === firstDown - PRESS_WARN_TICKS && states.slice(firstWarn, firstDown).every((v) => v === PRESS_WARNING) && pressState(p, -1) === pressState(p, p.period - 1),
    `period ${p.period}: up ${count(PRESS_UP)}, warning ${count(PRESS_WARNING)} from tick ${firstWarn}, down ${count(PRESS_DOWN)} from tick ${firstDown}`,
  );

  // The truck's lateral lip test: inside the band and the take-off zone only.
  const k = t.trucks[0];
  check(
    "schema rt: truckLipAt is the lateral lip test (the band's take-off zone [lip, lip + LIP_ZONE), lat within the band); TRUCK_MIN_SPEED = MIN_TAKEOFF_SPEED",
    truckLipAt(t, k.lip, k.lat) === k && truckLipAt(t, k.lip + LIP_ZONE - 0.01, k.band1) === k && truckLipAt(t, k.lip + LIP_ZONE, k.lat) === null &&
      truckLipAt(t, k.lip - 0.01, k.lat) === null && truckLipAt(t, k.lip, k.band1 + 0.01) === null && truckLipAt(t, k.lip, k.band0 - 0.01) === null &&
      TRUCK_MIN_SPEED === MIN_TAKEOFF_SPEED,
    `lip ${k.lip}, band ${k.band0}..${k.band1}`,
  );
}

function schemaValidate(): void {
  // Each structural rule rejects a broken placement (on the valid preview yard), and the near miss passes.
  const rule = (name: string, bad: string, want: string | string[], good?: string) => {
    const wants = Array.isArray(want) ? want : [want];
    check(`schema validate: ${name}`, wants.every((w) => bad.includes(w)) && (good === undefined || good === ""), `broken: ${bad || "accepted"}${good === undefined ? "" : ` || near miss: ${good || "accepted"}`}`);
  };
  const noWiden = (f: Feature) => f.k === "widen" || f.k === "island" || (f.k === "water" && f.lat0 === -124) || (f.k === "dirt" && f.lat1 === 124) || f.k === "press";
  check("schema validate: the preview yard is valid as it is", schemaErrs([]) === "", schemaErrs([]));

  // Ranges.
  rule("a rectangle needs s1 > s0 and lat1 > lat0", schemaErrs([{ k: "water", s0: 4600, s1: 4500, lat0: 10, lat1: -10 }]), ["water 4600.0..4500.0: s1 must be > s0", "lat1 must be > lat0"]);
  rule("surfaces stay inside the walls (dirt to the wall passes)", schemaErrs([{ k: "dirt", s0: 4600, s1: 4700, lat0: 0, lat1: 109 }]), "dirt 4600.0..4700.0: reaches past the wall", schemaErrs([{ k: "dirt", s0: 4600, s1: 4700, lat0: 0, lat1: 108 }]));
  rule("a belt's drift is 0 < |vx| <= 200", schemaErrs([{ k: "belt", s0: 4600, s1: 4700, lat0: -64, lat1: 64, vx: 0 }]) + schemaErrs([{ k: "belt", s0: 4600, s1: 4700, lat0: -64, lat1: 64, vx: -201 }]), ["drift vx 0 outside", "drift vx -201 outside"], schemaErrs([{ k: "belt", s0: 4600, s1: 4700, lat0: -64, lat1: 64, vx: -200 }]));
  rule("a tyre mound's radius is 18..30", schemaErrs([{ k: "tyres", s: 4600, lat: 0, r: 17 }]) + schemaErrs([{ k: "tyres", s: 4600, lat: 0, r: 31 }]), ["radius 17 outside 18..30", "radius 31 outside 18..30"], schemaErrs([{ k: "tyres", s: 4600, lat: 0, r: 18 }, { k: "tyres", s: 4700, lat: 0, r: 30 }]));
  rule("a tyre mound stays inside the walls", schemaErrs([{ k: "tyres", s: 4600, lat: 80, r: 30 }]), "tyres at s=4600.0: reaches past the wall", schemaErrs([{ k: "tyres", s: 4600, lat: 78, r: 30 }]));
  rule(
    "barrels: n a whole 1..6, period whole ticks, |speed| 40..240",
    schemaErrs([{ k: "barrels", s: 4600, n: 0, period: 240, speed: 110 }]) + schemaErrs([{ k: "barrels", s: 4600, n: 2.5, period: 240.5, speed: 110 }]) + schemaErrs([{ k: "barrels", s: 4600, n: 7, period: 900, speed: -39 }]),
    ["n 0 is not a whole number 1..6", "n 2.5 is not", "period 240.5 is not a whole number of ticks", "n 7 is not", "speed -39 outside 40..240"],
    schemaErrs([{ k: "barrels", s: 4600, n: 6, period: 900, speed: -40 }]),
  );
  // A crossing at 110 u/s is 108 ticks (198 units wall to wall): ticks 0..108 are on the road, so a
  // period of 108 or 109 leaves no tick in the gutter and 110 leaves one; at 97 u/s (122.5 ticks) 123 none, 124 one.
  const barrelRow = (period: number, speed: number) => schemaErrs([{ k: "barrels", s: 4600, n: 1, period, speed }]);
  rule(
    "barrels: a cycle of a crossing plus at least one tick in the gutter, and a row whose barrels do not overlap",
    barrelRow(108, 110) + barrelRow(109, 110) + barrelRow(123, 97) + schemaErrs([{ k: "barrels", s: 4600, n: 6, period: 53, speed: 120 }]),
    ["period 108 leaves no tick in the gutter (a crossing takes 108.0 ticks)", "period 109 leaves no tick in the gutter", "period 123 leaves no tick in the gutter (a crossing takes 122.5 ticks)", "the barrels of the row overlap each other"],
    barrelRow(110, 110) + barrelRow(124, 97),
  );
  const gutter = (period: number, speed: number) => {
    const b = buildTrack({ ...SCHEMA_LOOP, id: "schema-gutter", features: [{ k: "barrels", s: 4600, n: 1, period, speed }] }).barrels[0];
    return Array.from({ length: period }, (_, rt) => barrelLat(b, 0, rt)).filter((v) => Number.isNaN(v)).length;
  };
  check(
    "schema validate: the gutter rule is barrelLat's own (the accepted near misses have exactly one gutter tick, the rejected periods none)",
    gutter(110, 110) === 1 && gutter(124, 97) === 1 && gutter(109, 110) === 0 && gutter(123, 97) === 0,
    `gutter ticks: 109/110 u/s ${gutter(109, 110)}, 110/110 ${gutter(110, 110)}, 123/97 ${gutter(123, 97)}, 124/97 ${gutter(124, 97)}`,
  );
  rule("a truck's length is 80..160", schemaErrs([{ k: "truck", s: 4600, lat: 0, len: 79 }]) + schemaErrs([{ k: "truck", s: 4600, lat: 0, len: 161 }]), ["length 79 outside 80..160", "length 161 outside"], schemaErrs([{ k: "truck", s: 4600, lat: 0, len: 160 }]));
  rule("a truck's body stays inside the walls", schemaErrs([{ k: "truck", s: 4600, lat: -89, len: 110 }]), "truck at s=4600.0: reaches past the wall", schemaErrs([{ k: "truck", s: 4600, lat: -88, len: 110 }]));
  rule(
    "a press: whole ticks, down >= 1, the 30-tick warning inside the up time, lat1 > lat0",
    schemaErrs([{ k: "press", s: 4600, lat0: 0, lat1: 64, period: 90, down: 61 }]) + schemaErrs([{ k: "press", s: 4600, lat0: 0, lat1: 64, period: 90, down: 0 }]) + schemaErrs([{ k: "press", s: 4600, lat0: 64, lat1: 0, period: 90.5, down: 10 }]),
    ["period 90 / down 61 must be whole ticks", "period 90 / down 0", "period 90.5 / down 10", "press at s=4600.0: lat1 must be > lat0"],
    schemaErrs([{ k: "press", s: 4600, lat0: 0, lat1: 64, period: 90, down: 60 }]),
  );
  rule(
    "a widen: at least 2 * 120 long, left and right >= 0 and not both 0",
    schemaErrs([{ k: "widen", s0: 4500, s1: 4739, left: 20, right: 20 }]) + schemaErrs([{ k: "widen", s0: 4500, s1: 4800, left: -1, right: 20 }]) + schemaErrs([{ k: "widen", s0: 4500, s1: 4800, left: 0, right: 0 }]),
    ["widen 4500.0..4739.0: shorter than its two tapers (240)", "left -1 / right 20 must be >= 0", "left 0 / right 0 must be >= 0 and not both 0"],
    schemaErrs([{ k: "widen", s0: 4500, s1: 4740, left: 0, right: 20 }]),
  );
  rule("every new feature stays off the start zone", schemaErrs([{ k: "dirt", s0: 100, s1: 200, lat0: -64, lat1: 64 }]) + schemaErrs([{ k: "tyres", s: 9900, lat: 60, r: 20 }]), ["dirt 100.0..200.0: in the start zone", "tyres at s=9900.0: in the start zone"]);

  // Overlaps.
  rule("surfaces do not overlap each other (side by side passes)", schemaErrs([{ k: "dirt", s0: 1500, s1: 1700, lat0: 0, lat1: 64 }]), "water 1450.0..1620.0 overlaps dirt 1500.0..1700.0 (one surface at a time)", schemaErrs([{ k: "dirt", s0: 3800, s1: 4100, lat0: 0, lat1: 64 }]));
  rule("solids do not overlap each other", schemaErrs([{ k: "tyres", s: 1250, lat: 0, r: 20 }]) + schemaErrs([{ k: "truck", s: 860, lat: 40, len: 100 }]), ["tyres at s=1250.0 overlaps barrels at s=1260.0", "tyres at s=880.0 overlaps truck at s=860.0"]);
  rule(
    "tyre mounds: circles whose boxes overlap diagonally overlap only if the circles do",
    schemaErrs([{ k: "tyres", s: 1060 + 30, lat: -20 + 30, r: 23 }]),
    "tyres at s=1060.0 overlaps tyres at s=1090.0",
    schemaErrs([{ k: "tyres", s: 1060 + 30, lat: -20 + 30, r: Math.hypot(30, 30) - 20 - 0.01 }]),
  );
  const lip = 4500 + 80;
  const jumpBase: Feature[] = [{ k: "ramp", s: 4500, len: 80 }, { k: "gap", s0: lip, s1: lip + 150 }, { k: "hole", s: 5000, lat: 30, r: 20 }, { k: "cell", s: 5200, lat: 60 }];
  rule(
    "solids do not overlap a gap, a ramp (take-off zone included), a hole or a ground cell",
    schemaErrs([...jumpBase, { k: "tyres", s: lip + 100, lat: 0, r: 20 }]) + schemaErrs([...jumpBase, { k: "press", s: lip + 6, lat0: -64, lat1: 0, period: 120, down: 30 }]) +
      schemaErrs([...jumpBase, { k: "tyres", s: 5000, lat: -8, r: 20 }]) + schemaErrs([...jumpBase, { k: "truck", s: 5150, lat: 40, len: 100 }]),
    ["tyres at s=4680.0 overlaps gap 4580.0..4730.0", "press at s=4586.0 overlaps ramp at s=4500.0", "tyres at s=5000.0 overlaps hole at s=5000.0", "truck at s=5150.0 overlaps ground cell at s=5200.0"],
    schemaErrs([...jumpBase, { k: "tyres", s: 5000, lat: -18, r: 20 }]),
  );
  rule(
    "widens do not overlap each other, a ramp or a gap",
    schemaErrs([{ k: "widen", s0: 6900, s1: 7300, left: 0, right: 30 }]) + schemaErrs([...jumpBase.slice(0, 2), { k: "widen", s0: 4300, s1: 4590, left: 30, right: 0 }]),
    ["widen 5750.0..7050.0 overlaps widen 6900.0..7300.0", "widen 4300.0..4590.0 overlaps ramp at s=4500.0 (a widened road has no jumps)", "overlaps gap 4580.0..4730.0"],
    schemaErrs([...jumpBase.slice(0, 2), { k: "widen", s0: 4200, s1: 4500, left: 30, right: 0 }]),
  );

  // Split lanes: each lane at least 72 wide (asphalt edge to island) at every s the island covers.
  rule(
    `split lanes: each lane >= ${LANE_MIN} at every s (the island running into the taper narrows a lane)`,
    schemaErrs([{ k: "island", s0: 5900, s1: 6900, lat0: -53, lat1: 28 }], (f) => f.k === "island" && f.s0 === 5900) +
      schemaErrs([{ k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 53 }], (f) => (f.k === "island" && f.s0 === 5900) || f.k === "press") +
      schemaErrs([{ k: "island", s0: 5800, s1: 6900, lat0: -28, lat1: 28 }], (f) => f.k === "island" && f.s0 === 5900),
    ["island 5900.0..6900.0: the left lane is 71.0 wide", "the right lane is 71.0 wide", "island 5800.0..6900.0: the left lane is"],
    schemaErrs([{ k: "island", s0: 5900, s1: 6900, lat0: -52, lat1: 28 }], (f) => f.k === "island" && f.s0 === 5900),
  );

  // Advisor change 13: widening the inside of a bend so far that a car centre (the wall less half a
  // car: 64 + 44 - 8 = 100 plus the widen) passes the local radius. The yard's tightest bend (a
  // right-hander near s 2950: the inside is the right) has a radius of about 400. A widen whose
  // asphalt stays below the radius but whose verge does not (half 376, wall 420) is rejected too.
  const bend = buildTrack(SCHEMA_LOOP);
  let tight = 0;
  for (let i = 0; i < bend.pts.length; i++) if (Math.abs(curvatureAt(bend, i)) > Math.abs(curvatureAt(bend, tight))) tight = i;
  const radius = 1 / Math.abs(curvatureAt(bend, tight)), sB = bend.cum[tight];
  const inside = (right: number, left: number) => schemaErrs([{ k: "widen", s0: sB - 200, s1: sB + 200, left, right }]);
  const reachOf = (right: number) => `a car centre reaches ${(64 + right + 44 - CAR_WIDTH / 2).toFixed(1)}`;
  const verge = Math.floor(radius - 64) - 20, past = Math.ceil(radius - 100) + 1, fits = Math.floor(radius - 100) - 1;
  const degen = (e: string) => (e.includes("degenerates") ? e : "");
  rule(
    "widen in a bend (advisor change 13): a car centre on the widened inside (the wall less half a car) stays below the local radius, verge included; the outside is not limited by it",
    inside(verge, 0) + inside(past, 0),
    [`${reachOf(verge)} (the wall ${(64 + verge + 44).toFixed(1)} less half a car)`, reachOf(past), "not below the local radius", "(nearest() degenerates)"],
    degen(inside(fits, 0)) + degen(inside(0, Math.ceil(radius - 64) + 50)),
  );
  check(
    "schema validate: the advisor-13 near misses straddle the radius (a centre reaching just under it passes, just over it fails)",
    64 + verge < radius && 64 + verge + 44 - 8 > radius && 100 + past > radius && 100 + fits < radius,
    `radius ${radius.toFixed(1)} at s=${sB.toFixed(1)}; asphalt-only widen ${verge}: half ${64 + verge}, reach ${100 + verge}; ${past}: reach ${100 + past}; passing ${fits}: reach ${100 + fits}`,
  );

  // Solids keep 40 from recovery points (3200 here) and the grid's slots.
  rule(
    `solids keep >= ${SOLID_CLEAR} from a recovery point (edge to point)`,
    schemaErrs([{ k: "tyres", s: 3200 + 20 + SOLID_CLEAR - 0.5, lat: 0, r: 20 }]) + schemaErrs([{ k: "press", s: 3200 + 30, lat0: 10, lat1: 60, period: 120, down: 30 }]),
    ["tyres at s=3259.5: 39.5 from recovery point s=3200.0", "press at s=3230.0: 20.6 from recovery point s=3200.0"],
    schemaErrs([{ k: "tyres", s: 3200 + 20 + SOLID_CLEAR, lat: 0, r: 20 }]) + schemaErrs([{ k: "press", s: 3200 + 12 + SOLID_CLEAR, lat0: 0, lat1: 60, period: 120, down: 30 }]),
  );
  const slot = gridSlotSL(buildTrack(SCHEMA_LOOP), 5);
  rule(`solids keep >= ${SOLID_CLEAR} from every grid slot`, schemaErrs([{ k: "tyres", s: slot.s + 30, lat: slot.lat, r: 20 }]), "from grid slot 5 (solids keep >= 40)");

  // Water: off take-off zones (a ramp's; a truck's band, only laterally inside it) and recovery points.
  rule(
    "no water on a ramp's take-off zone",
    schemaErrs([...jumpBase.slice(0, 2), { k: "water", s0: lip - 40, s1: lip + 1, lat0: 30, lat1: 60 }]),
    "water 4540.0..4581.0: on the take-off zone of the ramp at s=4500.0",
    schemaErrs([...jumpBase.slice(0, 2), { k: "water", s0: lip - 40, s1: lip, lat0: 30, lat1: 60 }]),
  );
  const tk = testTrack(PREVIEW_YARD.id)!.trucks[0];
  rule(
    "no water on a truck's take-off zone (inside its band; beside the band is fine)",
    schemaErrs([{ k: "water", s0: tk.lip + 2, s1: tk.lip + 60, lat0: tk.band1 - 1, lat1: tk.band1 + 30 }]),
    `on the take-off zone of the truck at s=${tk.s.toFixed(1)}`,
    schemaErrs([{ k: "water", s0: tk.lip + 2, s1: tk.lip + 60, lat0: tk.band1, lat1: tk.band1 + 30 }]),
  );
  rule(
    "no water on a recovery point (where a car put back there would touch it: half a car's length and width)",
    schemaErrs([{ k: "water", s0: 3200 + CAR_LENGTH / 2, s1: 3300, lat0: -64, lat1: 0 }]) + schemaErrs([{ k: "water", s0: 3150, s1: 3250, lat0: CAR_WIDTH / 2, lat1: 60 }]),
    ["water 3215.0..3300.0: on recovery point s=3200.0", "water 3150.0..3250.0: on recovery point s=3200.0"],
    schemaErrs([{ k: "water", s0: 3200 + CAR_LENGTH / 2 + 0.01, s1: 3300, lat0: -64, lat1: 0 }, { k: "water", s0: 3100, s1: 3180, lat0: CAR_WIDTH / 2 + 0.01, lat1: 60 }]),
  );

  // A dry lane >= 48 at every s of a pool, or the pool lies on a straight.
  const pool = (lat0: number, lat1: number) => schemaErrs([{ k: "water", s0: 3800, s1: 4100, lat0, lat1 }], (f) => f.k === "water" && f.s0 === 3800);
  rule(
    `a pool in a bend leaves a dry lane >= ${DRY_LANE_MIN}, or lies on a straight (the yard's full-width pool on the top straight passes)`,
    pool(-64, 64 - DRY_LANE_MIN + 0.5) + pool(-64, 64),
    [`water 3800.0..4100.0: no dry lane of ${DRY_LANE_MIN}`, "(the widest is 47.5)", "and not on a straight (the road turns", "(the widest is 0.0)"],
    pool(-64, 64 - DRY_LANE_MIN) + schemaErrs([{ k: "water", s0: 6000, s1: 6800, lat0: -64, lat1: 64 }], noWiden),
  );
  rule(
    "in a bend one dry split lane is enough; an island or a truck is not a dry lane",
    schemaErrs([{ k: "water", s0: 7900, s1: 8200, lat0: -104, lat1: -24 }, { k: "water", s0: 7900, s1: 8200, lat0: 24, lat1: 104 }]) + schemaErrs([{ k: "truck", s: 3850, lat: 30, len: 110 }]),
    ["water 7900.0..8200.0: no dry lane of 48", "(the widest is 0.0)", "water 3800.0..4100.0: no dry lane of 48", "(the widest is 14.0)"],
    schemaErrs([{ k: "water", s0: 7900, s1: 8200, lat0: -104, lat1: -24 }]),
  );
}

function schemaPreview(): void {
  // The preview test tracks: every M4 feature type, valid, and hidden from the lobby and every client message.
  const built = TEST_TRACKS.map((d) => testTrack(d.id)!);
  const kinds = (["water", "dirt", "belts", "tyres", "barrels", "trucks", "presses", "widens", "islands"] as const).filter((k) => built.some((t) => t[k].length > 0));
  const errs = built.flatMap((t) => validateTrack(t).map((e) => `${t.def.id}: ${e}`));
  check(
    "schema preview: the preview test tracks hold every M4 feature type, build and pass validateTrack (and validateRunUps)",
    kinds.length === 9 && errs.length === 0 && built.every((t) => validateRunUps(t).length === 0) && testTrack(PREVIEW_YARD.id) === built[0] && testTrack("rust-bowl") === null,
    `${TEST_TRACKS.map((d) => d.id).join(", ")}: ${kinds.join(", ")}${errs.length ? `; ${errs.join(" | ")}` : ""}`,
  );
  const ids = TEST_TRACKS.map((d) => d.id);
  const listed = trackList().map((e) => e.id);
  const sim = new Sim();
  const host = sim.add("Host");
  const direct = ids.map((id) => sim.room.setTrack(host, id));
  const m = menuRooms(["Host", "B"]);
  for (const id of ids) m.send(0, { t: "track", id });
  const refused = errMsgs(m.s[0].conn).map((e) => e.msg);
  check(
    "schema preview: the test tracks are not in the lobby track list, unknown to isTrackId/findTrack, and a room refuses them (setTrack and the {t:\"track\"} message)",
    ids.every((id) => !listed.includes(id) && !isTrackId(id) && findTrack(id) === null) && direct.every((e) => e === "Unknown track") && sim.room.trackId === DEFAULT_TRACK_ID &&
      refused.length === ids.length && refused.every((e) => e === "Unknown track") && m.room.trackId === DEFAULT_TRACK_ID,
    `lobby list: ${listed.join(", ")}; setTrack: ${direct.join(", ")}; message: ${refused.join(", ")}`,
  );
}

function schemaDataOnly(): void {
  // Data only, until M4-MOVE: the preview yard's barrels, truck and press act now (M4-MOVE's own
  // section, at the end); this check proves the truck does. (Water, dirt, belts and tyre mounds act since
  // M4-SURF part 1, widens and islands since M4-SURF part 2: their own sections, below; they are left
  // off the yard for this run.)
  const acts = (f: Feature) => f.k === "water" || f.k === "dirt" || f.k === "belt" || f.k === "tyres" || f.k === "widen" || f.k === "island";
  const yard = buildTrack({ ...PREVIEW_YARD, id: "schema-inert", features: PREVIEW_YARD.features!.filter((f) => !acts(f)) }), bare = buildTrack(SCHEMA_LOOP);
  const run = (t: Track) => {
    const p = pointAt(t, 500);
    const c: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const env = raceEnv(t);
    const out: number[] = [];
    for (let rt = 1; rt <= 60 * 28; rt++) {
      env.rt = rt;
      const q = queryTrackNear(t, c.x, c.y, c.seg);
      const aim = pointAt(t, q.s + 60);
      stepRaceCar(c, { throttle: 0.8, steer: clamp(angleDiff(c.h, Math.atan2(aim.y - c.y, aim.x - c.x)) * 2, -1, 1) }, BASE_STATS, env);
      out.push(c.x, c.y, c.h, c.vx, c.vy, c.seg, c.air, c.fall);
    }
    return out;
  };
  const a = run(yard), b = run(bare);
  const s = queryTrackNear(yard, a[a.length - 8], a[a.length - 7], a[a.length - 3]).s;
  // M4-MOVE: they act now. The same drive up the truck's ramp band (its lat) takes off from the truck on
  // the yard (an air tick) and not on the bare loop, so the two runs part there.
  const band = (t: Track) => {
    const tk = yard.trucks[0];
    const p = pointAt(t, tk.s - 300);
    const c: CarState = { x: p.x - Math.sin(p.h) * tk.lat, y: p.y + Math.cos(p.h) * tk.lat, h: p.h, vx: Math.cos(p.h) * 330, vy: Math.sin(p.h) * 330, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const env = raceEnv(t);
    let air = 0;
    for (let rt = 1; rt <= 90; rt++) {
      env.rt = rt;
      // Along the band's lane (the truck stands in a gentle bend): aim 60 ahead on it.
      const q = queryTrackNear(t, c.x, c.y, c.seg);
      const aim = pointAt(t, q.s + 60), ax = aim.x - Math.sin(aim.h) * tk.lat, ay = aim.y + Math.cos(aim.h) * tk.lat;
      stepRaceCar(c, { throttle: 1, steer: c.air > 0 ? 0 : clamp(angleDiff(c.h, Math.atan2(ay - c.y, ax - c.x)) * 2, -1, 1) }, BASE_STATS, env);
      if (c.air > 0) air++;
    }
    return { air, x: c.x, y: c.y };
  };
  const ya = band(yard), ba = band(bare);
  check(
    "schema data only (M4-MOVE: they act now): driven up the preview yard's truck band at speed a car takes off from the truck, on the bare loop it does not, and the runs part; the centre-line run still reaches past the belt",
    ya.air > 20 && ba.air === 0 && Math.hypot(ya.x - ba.x, ya.y - ba.y) > 1 && s > 9200 && s < 9800 && a.length === b.length,
    `${ya.air} air ticks on the yard, ${ba.air} on the bare loop; 28 s at 0.8 throttle from s=500 along the centre line ended at s=${s.toFixed(0)} (past the belt)`,
  );
  check("schema data only: GRID_SLOTS = MAX_PLAYERS; gridSlotSL is where gridSlot puts each slot", GRID_SLOTS === MAX_PLAYERS && Array.from({ length: GRID_SLOTS }, (_, k) => {
    const g = gridSlot(yard, k), sl = gridSlotSL(yard, k), p = pointAt(yard, sl.s);
    return Math.hypot(p.x - Math.sin(p.h) * sl.lat - g.x, p.y + Math.cos(p.h) * sl.lat - g.y) < 1e-6;
  }).every(Boolean));
}

// ---- touch controls (TOUCH-1, TOUCH-2, PLAN-TOUCH: client/input.ts reducePad, the stick, mergeControls) ----

import {
  isDriveKey,
  mergeControls,
  PAD_IDLE,
  padControls,
  readPad,
  reducePad,
  STICK_DEFAULTS,
  stickCentre,
  stickControls,
  stickKnob,
  type PadEvent,
  type PadGeometry,
  type PadState,
  type StickParams,
} from "../client/input";

// A phone in portrait: the screen 390 x 844, FIRE 72 under MINE 60 at the bottom left; the stick's
// zone is the right half (the DOM decides that: a finger landing there arrives as cluster "stick").
const TOUCH_GEO: PadGeometry = {
  screen: { left: 0, top: 0, width: 390, height: 844 },
  fire: { left: 16, top: 748, width: 72, height: 72 },
  mine: { left: 16, top: 680, width: 60, height: 60 },
};
// Rate mode (TOUCH-2 to TOUCH-4): these tests are its, unchanged; point mode (TOUCH-5, the default) has its own section below.
const SP: StickParams = { ...STICK_DEFAULTS, mode: "rate" };
function touchRun(events: PadEvent[], s: PadState = PAD_IDLE, p: StickParams = SP): PadState {
  for (const e of events) s = reducePad(s, e, TOUCH_GEO, p);
  return s;
}
/** A thumb down in the stick's zone at (x, y), and moved to (x, y). */
const stickDown = (id: number, x: number, y: number): PadEvent => ({ t: "down", id, cluster: "stick", x, y });
const stickMove = (id: number, x: number, y: number): PadEvent => ({ t: "move", id, x, y });
const fireDown = (id: number): PadEvent => ({ t: "down", id, cluster: "weapons", x: TOUCH_GEO.fire.left + 36, y: TOUCH_GEO.fire.top + 36 });
const mineDown = (id: number): PadEvent => ({ t: "down", id, cluster: "weapons", x: TOUCH_GEO.mine.left + 30, y: TOUCH_GEO.mine.top + 30 });
const ctlText = (s: PadState, p: StickParams = SP) => {
  const c = padControls(s, p);
  return `t${c.throttle} s${c.steer}${c.fire ? " fire" : ""}${c.mine ? " mine" : ""}`;
};
/** The stick's output for a thumb dx, dy from where it landed (well away from every edge). */
const at = (dx: number, dy: number, p: StickParams = SP) => padControls(touchRun([stickDown(1, 290, 560), stickMove(1, 290 + dx, 560 + dy)], PAD_IDLE, p), p);

function touchStickCentre(): void {
  // A thumb landing in the zone sets the centre right there: nothing yet; the knob sits on it.
  const s = touchRun([stickDown(1, 290, 560)]);
  const st = s.stick!;
  check(
    "touch stick: a thumb landing in the zone puts the centre where it landed; nothing is held yet (no gas, no steer)",
    st.id === 1 && st.cx === 290 && st.cy === 560 && st.x === 290 && st.y === 560 && ctlText(s) === "t0 s0" && stickKnob(st, SP).join(",") === "0,0",
    JSON.stringify(st),
  );
  // Near the right and the bottom edge the centre moves in just as far as full lock (0.9 R + 8 px)
  // and the gas/brake dead zone (0.3 R + 8 px) need: from there both are still reachable on screen.
  const lockIn = SP.radius * SP.steerLock + 8; // R 67: 68.3 px
  const gasIn = SP.radius * SP.throttleDead + 8; // R 67: 28.1 px
  const right = touchRun([stickDown(2, 385, 560)]).stick!;
  const bottom = touchRun([stickDown(3, 290, 842)]).stick!;
  const corner = touchRun([stickDown(4, 389, 843)]).stick!;
  const [ix, iy] = [Math.floor(390 - lockIn) - 1, Math.floor(844 - gasIn) - 1]; // just inside both reaches: no shift
  const inside = touchRun([stickDown(5, ix, iy)]).stick!;
  check(
    `touch stick: a thumb landing near the right or bottom edge moves the centre in (right: to 390 - ${lockIn.toFixed(1)}; bottom: to 844 - ${gasIn.toFixed(1)}; a corner: both); further in it stays`,
    right.cx === 390 - lockIn && right.cy === 560 && bottom.cx === 290 && bottom.cy === 844 - gasIn && corner.cx === 390 - lockIn && corner.cy === 844 - gasIn && inside.cx === ix && inside.cy === iy,
    `right ${right.cx},${right.cy}; bottom ${bottom.cx},${bottom.cy}; corner ${corner.cx},${corner.cy}; inside ${inside.cx},${inside.cy}`,
  );
  // From the shifted centre the screen's last pixels still give full lock and brake.
  const lock = padControls(touchRun([stickDown(2, 385, 560), stickMove(2, 389, 560)]), SP);
  const brake = padControls(touchRun([stickDown(3, 290, 842), stickMove(3, 290, 843)]), SP);
  const shifted = stickCentre(385, 560, TOUCH_GEO.screen, SP);
  check(
    "touch stick: from an edge-shifted centre full lock toward that edge and brake at the bottom stay reachable on screen (stickCentre is what the reducer uses)",
    lock.steer === 1 && brake.throttle === -1 && shifted.join(",") === `${390 - lockIn},560`,
    `right edge: ${JSON.stringify(lock)}; bottom edge: ${JSON.stringify(brake)}`,
  );
  // The phone sizes (TOUCH-3, the shipped R): from any landing point in the stick's zone (right of
  // the split, from --touch-top = 92 px to the bottom; its corners, edge middles and middle) the
  // thumb still reaches full lock both ways, gas and brake on screen (x 0..w-1, y 0..h-1).
  const unreached: string[] = [];
  let landings = 0;
  for (const [w, h] of [[390, 844], [844, 390], [360, 740]]) {
    const geo: PadGeometry = { ...TOUCH_GEO, screen: { left: 0, top: 0, width: w, height: h } };
    const [zl, zt] = [w * SP.split, 92];
    for (const x of [zl, (zl + w - 1) / 2, w - 1]) {
      for (const y of [zt, (zt + h - 1) / 2, h - 1]) {
        landings++;
        const s = reducePad(PAD_IDLE, stickDown(1, x, y), geo, SP);
        const { cx, cy } = s.stick!;
        const to = (tx: number, ty: number) => padControls(reducePad(s, stickMove(1, Math.max(0, Math.min(w - 1, tx)), Math.max(0, Math.min(h - 1, ty))), geo, SP), SP);
        const [l, r, g, b] = [to(cx - SP.radius, cy), to(cx + SP.radius, cy), to(cx, cy - SP.radius), to(cx, cy + SP.radius)];
        if (!(l.steer === -1 && r.steer === 1 && g.throttle === 1 && b.throttle === -1)) unreached.push(`${w}x${h} at ${x},${y}: centre ${cx},${cy}: left ${l.steer}, right ${r.steer}, gas ${g.throttle}, brake ${b.throttle}`);
      }
    }
  }
  check(
    `touch stick: at 390x844, 844x390 and 360x740 (R ${SP.radius}) a thumb landing anywhere in the zone (corners, edges, middle) reaches full lock both ways, gas and brake on screen`,
    landings === 27 && unreached.length === 0,
    unreached.join(" | ") || `${landings} landings`,
  );
  // A screen too small for the reach both ways (a tiny window) puts the centre in its middle.
  const tiny = stickCentre(5, 5, { left: 0, top: 0, width: 60, height: 30 }, SP);
  check("touch stick: a screen narrower than the reach both ways centres the stick (no flipping past the middle)", tiny.join(",") === "30,15", tiny.join(","));
}

function touchStickClamp(): void {
  // The knob follows the thumb but stays within R; the output caps at full lock and full gas.
  const far = touchRun([stickDown(1, 290, 560), stickMove(1, 290 + 200, 560 - 200)]);
  const [kx, ky] = stickKnob(far.stick!, SP);
  const near = touchRun([stickDown(1, 290, 560), stickMove(1, 290 + 30, 560 - 20)]);
  const [nx, ny] = stickKnob(near.stick!, SP);
  check(
    "touch stick: the knob follows the thumb inside R and stops on R past it (along the thumb's direction); the output caps at full gas and steer 1",
    Math.abs(Math.hypot(kx, ky) - SP.radius) < 1e-9 && Math.abs(kx + ky) < 1e-9 && nx === 30 && ny === -20 && ctlText(far) === "t1 s1",
    `far knob ${kx.toFixed(2)},${ky.toFixed(2)} (|${Math.hypot(kx, ky).toFixed(2)}|), near ${nx},${ny}; far ${ctlText(far)}`,
  );
  // A thumb far up keeps its steer (sideways offset, capped at R), as a thumb holding gas drifts up.
  const R = SP.radius;
  const sideways = Math.round(0.75 * R); // R 67: 50 px, about 0.52 steer on curve 3
  const highRight = at(sideways, -2.5 * R);
  check(
    "touch stick: a thumb pushed far up still steers by its sideways offset (gas held, the thumb drifting up)",
    highRight.throttle === 1 && highRight.steer === at(sideways, -R / 2).steer && highRight.steer > 0.4 && highRight.steer < 1,
    JSON.stringify(highRight),
  );
}

// The tests below put the thumb at shares of R (the stick's feel is in shares of R), so they hold
// for any shipped R; the labels name the pixels at the shipped one.
function touchStickDead(): void {
  // Steer dead zone: 0.12 R each way. The curve (3) is so flat at its start that just past the dead
  // zone the steer still rounds to 0; on a linear curve 0.14 R gives a little, so the dead zone
  // itself ends at 0.12 R. On the shipped curve the first steer (0.01) comes further out.
  const R = SP.radius;
  const dz = R * SP.steerDead;
  const linear = { ...SP, steerCurve: 1 };
  const steers = [0, dz / 2, dz - 0.2, dz, -(dz - 0.2), -dz].map((dx) => at(dx, 0).steer);
  const lin = [dz, 0.14 * R, -0.14 * R].map((dx) => at(dx, 0, linear).steer);
  let first = 0;
  for (let dx = 0; dx <= R && first === 0; dx += 0.5) if (at(dx, 0).steer !== 0) first = dx;
  check(
    `touch stick: steer dead zone: nothing within 0.12 R (${dz} px) either way; past it a little (linear: at 0.14 R); on curve 3 the first steer, 0.01, at ${first} px`,
    steers.every((v) => v === 0) && lin[0] === 0 && lin[1] > 0 && lin[1] < 0.05 && lin[2] === -lin[1] && first > dz && at(first, 0).steer === 0.01 && at(-first, 0).steer === -0.01,
    `${steers.join(", ")}; linear ${lin.join(", ")}; first ${first} px`,
  );
  // Throttle dead zone: 0.3 R up or down; past it full gas or brake, nothing in between.
  const td = R * SP.throttleDead;
  // Exactly at 0.3 R the offset goes to stickControls as it is: through the reducer's screen point
  // (560 - td) it comes back 2e-14 px further out at R 67 (20.1 px is not exact in binary; R 95's 28.5 was).
  const thr = [-td / 2, -td, -(td + 1), -R, td / 2, td, td + 1, R].map((dy) => (Math.abs(dy) === td ? stickControls(0, dy, SP)[0] : at(0, dy).throttle));
  check(`touch stick: throttle dead zone: nothing within 0.3 R (${td} px) up or down; past it up is full gas (1), down brake/reverse (-1), never a fraction`, thr.join(",") === "0,0,1,1,0,0,-1,-1", thr.join(","));
  // Sideways only (past full lock), with a little vertical wobble inside the dead zone: steer, no gas or brake.
  const side = [at(R * SP.steerLock + 2, td / 2), at(-(R * SP.steerLock + 2), -td / 2)];
  check("touch stick: a sideways push with a little up/down wobble steers only", side[0].throttle === 0 && side[0].steer > 0.9 && side[1].throttle === 0 && side[1].steer < -0.9, JSON.stringify(side));
}

function touchStickCurve(): void {
  // Between the dead zone (0.12 R) and full lock (0.9 R): ((d / R - 0.12) / 0.78) ^ 3, rising.
  const R = SP.radius;
  const dz = R * SP.steerDead;
  const lock = R * SP.steerLock;
  const span = lock - dz;
  const xs: number[] = [];
  for (let dx = Math.ceil(dz) + 0.5; dx <= R; dx += 0.5) xs.push(dx); // halves: 290 +- dx is exact
  const ys = xs.map((dx) => at(dx, 0).steer);
  const rising = ys.every((v, i) => i === 0 || v >= ys[i - 1]);
  const quarter = at(dz + span / 4, 0).steer; // a quarter of the way: 0.25 ^ 3 = 0.016
  const threeQ = at(dz + (3 * span) / 4, 0).steer; // three quarters: 0.75 ^ 3 = 0.42
  const lockAt = at(lock, 0).steer;
  const past = at((lock + R) / 2, 0).steer; // between full lock and R (R 67: 6.7 px apart)
  const symmetric = xs.every((dx) => at(-dx, 0).steer === -at(dx, 0).steer);
  check(
    `touch stick: steer rises with the sideways offset up the curve (a quarter of the way 0.25^3 = 0.02, three quarters 0.75^3 = 0.42), full lock (1, the keyboard's) at 0.9 R = ${lock.toFixed(1)} px, inside R and held out to R; left mirrors right`,
    rising && quarter === 0.02 && threeQ === 0.42 && lockAt === 1 && past === 1 && lock < R && symmetric,
    `quarter ${quarter}, three quarters ${threeQ}, at ${lock.toFixed(1)} px ${lockAt}, at ${((lock + R) / 2).toFixed(2)} px ${past}; rising ${rising}, symmetric ${symmetric}`,
  );
  // The curve and the lock are parameters: linear halfway is 0.5; a lock at 0.5 R gives 1 at 0.5 R.
  const linear = { ...SP, steerCurve: 1 };
  const short = { ...SP, steerLock: 0.5 };
  const lin = at(dz + span / 2, 0, linear).steer;
  const early = at(R / 2, 0, short).steer;
  // A lock at or inside the dead zone: past the dead zone it is full lock at once (no division by 0).
  const odd = { ...SP, steerDead: 0.2, steerLock: 0.1 };
  const flat = at(0.16 * R, 0, odd).steer;
  check(
    `touch stick: curve 1 is linear (halfway 0.5); full lock moves with steerLock (0.5 R: 1 at ${R / 2} px); a lock inside the dead zone steps to 1`,
    lin === 0.5 && early === 1 && flat === 0 && at(0.22 * R, 0, odd).steer === 1,
    `linear ${lin}, lock 0.5 R at ${R / 2} px ${early}, odd params ${flat}`,
  );
}

function touchStickOutput(): void {
  // The user's ask: push up and to the side, gas and steer at once, from one finger.
  const R = SP.radius;
  const [sx, sy] = [Math.round(0.4 * R), Math.round(0.5 * R)];
  const upRight = at(sx, -sy);
  const upLeft = at(-sx, -sy);
  const downRight = at(sx, sy);
  const downLeft = at(-sx, sy);
  const frac = (v: number) => v !== 0 && Math.abs(v) < 1;
  check(
    "touch stick: one finger up and to the right gives full gas (throttle 1) and a fractional steer right at once; up-left the same to the left",
    upRight.throttle === 1 && frac(upRight.steer) && upRight.steer > 0 && upLeft.throttle === 1 && upLeft.steer === -upRight.steer && !upRight.fire && !upRight.mine,
    `up-right ${JSON.stringify(upRight)}, up-left ${JSON.stringify(upLeft)}`,
  );
  check(
    "touch stick: diagonals down: brake/reverse (-1) with a fractional steer; straight up, down, left, right: one control each",
    downRight.throttle === -1 && frac(downRight.steer) && downRight.steer > 0 && downLeft.throttle === -1 && downLeft.steer < 0 &&
      ctlText(touchRun([stickDown(1, 290, 560), stickMove(1, 290, 560 - R)])) === "t1 s0" &&
      ctlText(touchRun([stickDown(1, 290, 560), stickMove(1, 290, 560 + R)])) === "t-1 s0" &&
      ctlText(touchRun([stickDown(1, 290, 560), stickMove(1, 290 - R, 560)])) === "t0 s-1" &&
      ctlText(touchRun([stickDown(1, 290, 560), stickMove(1, 290 + R, 560)])) === "t0 s1",
    `down-right ${JSON.stringify(downRight)}, down-left ${JSON.stringify(downLeft)}`,
  );
  // A thumb that slides round: up, up-right, right, down-right, down, back to the centre.
  const g = Math.round((2 * R) / 3);
  const path: [number, number][] = [[0, -g], [sy, -g], [g, 0], [sy, g], [0, g], [0, 0]];
  let s = touchRun([stickDown(7, 290, 560)]);
  const seen: string[] = [];
  for (const [dx, dy] of path) {
    s = reducePad(s, stickMove(7, 290 + dx, 560 + dy), TOUCH_GEO, SP);
    seen.push(ctlText(s));
  }
  const rightOnly = Math.round(((g / R - SP.steerDead) / (SP.steerLock - SP.steerDead)) ** SP.steerCurve * 100) / 100;
  check(
    "touch stick: one finger slides gas -> gas+right -> right -> brake+right -> brake -> centre (nothing); the centre stays where it landed",
    seen[0] === "t1 s0" && seen[1].startsWith("t1 s0.") && seen[2] === `t0 s${rightOnly}` && seen[3].startsWith("t-1 s0.") && seen[4] === "t-1 s0" && seen[5] === "t0 s0" && s.stick!.cx === 290 && s.stick!.cy === 560,
    seen.join(" | "),
  );
  // A move to the same point returns the same state (no DOM write); lifting lets go of everything.
  const before = touchRun([stickDown(2, 290, 560), stickMove(2, 300, 540)]);
  const same = reducePad(before, stickMove(2, 300, 540), TOUCH_GEO, SP);
  const lifted = reducePad(before, { t: "up", id: 2 }, TOUCH_GEO, SP);
  check("touch stick: a move to the same point returns the same state; lifting the thumb takes the stick away (no output)", same === before && lifted.stick === null && ctlText(lifted) === "t0 s0", ctlText(lifted));
}

function touchStickRounding(): void {
  // Game.step rounds throttle and steer to 2 decimals before it predicts and sends (client/game.ts),
  // and the input goes as JSON: the stick's numbers must come through both unchanged, so the
  // prediction, the replay and the server step with exactly what the stick gave.
  const paramSets: StickParams[] = [SP, { ...SP, steerCurve: 1 }, { ...SP, steerCurve: 2.35, steerDead: 0.07, steerLock: 0.93, radius: 47 }, { ...SP, radius: 113, steerCurve: 1.15 }];
  let n = 0;
  const bad: string[] = [];
  const values = new Set<number>();
  for (const p of paramSets) {
    for (let dx = -130; dx <= 130; dx += 0.37) {
      for (const dy of [-70, -p.radius * p.throttleDead - 0.5, 0, 40]) {
        const c = padControls(touchRun([stickDown(1, 250, 500), stickMove(1, 250 + dx, 500 + dy)], PAD_IDLE, p), p);
        const merged = mergeControls({ throttle: 0, steer: 0, fire: false, mine: false }, c);
        for (const v of [c.throttle, c.steer, merged.steer]) {
          n++;
          values.add(v);
          const wire = JSON.parse(JSON.stringify({ v })).v;
          if (round(v, 2) !== v || wire !== v || Object.is(v, -0) || v < -1 || v > 1) bad.push(`${v} (dx ${dx.toFixed(2)})`);
        }
      }
    }
  }
  const tuples = JSON.parse(JSON.stringify([[1, at(25, -30).throttle, at(25, -30).steer, 0]]));
  check(
    "touch stick: every throttle and steer the stick gives (4 parameter sets, a sweep of offsets) survives game.ts's round(v, 2) and a JSON round trip unchanged, never -0, within -1..1",
    bad.length === 0 && values.size > 150 && tuples[0][2] === at(25, -30).steer,
    `${n} values, ${values.size} distinct${bad.length ? `; bad: ${bad.slice(0, 5).join(", ")}` : ""}`,
  );
}

function touchStickOwner(): void {
  // The first finger down in the zone owns the stick; a second one there is ignored (its down, its
  // moves, its lift), and does not take over when the first lifts; a fresh finger after that does.
  const one = touchRun([stickDown(1, 290, 560), stickMove(1, 290, 520)]);
  const two = reducePad(one, stickDown(2, 340, 700), TOUCH_GEO, SP);
  const twoMoved = reducePad(two, stickMove(2, 380, 600), TOUCH_GEO, SP);
  const twoUp = reducePad(twoMoved, { t: "up", id: 2 }, TOUCH_GEO, SP);
  check(
    "touch stick owner: a second finger landing in the zone while the first holds the stick changes nothing (same state); its moves and lift neither",
    two === one && twoMoved === one && twoUp === one && ctlText(one) === "t1 s0",
    ctlText(twoUp),
  );
  const firstUp = touchRun([stickDown(2, 340, 700), { t: "up", id: 1 }, stickMove(2, 380, 650)], one);
  const fresh = touchRun([stickDown(3, 280, 600)], firstUp); // clear of the right edge's shift (from 321.7 at R 67)
  check(
    "touch stick owner: when the first finger lifts the stick is gone; a finger that landed while it was owned stays ignored; a new finger takes the stick at its own point",
    firstUp.stick === null && ctlText(firstUp) === "t0 s0" && fresh.stick?.id === 3 && fresh.stick.cx === 280 && fresh.stick.cy === 600,
    `${ctlText(firstUp)}; then ${JSON.stringify(fresh.stick)}`,
  );
  // A pointer id that goes down again (reused) starts afresh at its new point.
  const reused = touchRun([stickDown(6, 290, 560), stickMove(6, 290, 500), stickDown(6, 270, 700)]);
  check("touch stick owner: a pointer id that goes down again sets a new centre where it lands (nothing held)", reused.stick?.cx === 270 && reused.stick.cy === 700 && ctlText(reused) === "t0 s0", JSON.stringify(reused.stick));
}

function touchMulti(): void {
  // Right thumb on the stick (gas + right), left thumb on FIRE: both at once (the keyboard's up + right + Space).
  let s = touchRun([stickDown(1, 290, 560), stickMove(1, 315, 520), fireDown(2)]);
  const both = padControls(s, SP);
  // The stick thumb slides on while FIRE stays held.
  s = reducePad(s, stickMove(1, 250, 600), TOUCH_GEO, SP);
  const slid = padControls(s, SP);
  // The FIRE finger slides onto MINE: it keeps FIRE (a weapon finger is bound to its button) and drops nothing.
  s = reducePad(s, { t: "move", id: 2, x: TOUCH_GEO.mine.left + 30, y: TOUCH_GEO.mine.top + 30 }, TOUCH_GEO, SP);
  const stuck = padControls(s, SP);
  // A third finger taps MINE: the latch, FIRE and the stick still held.
  s = touchRun([mineDown(3), { t: "up", id: 3 }], s);
  const tapped = padControls(s, SP);
  // The stick thumb lifts: FIRE stays; then FIRE lifts.
  s = reducePad(s, { t: "up", id: 1 }, TOUCH_GEO, SP);
  const stickUp = padControls(s, SP);
  s = reducePad(s, { t: "up", id: 2 }, TOUCH_GEO, SP);
  check(
    "touch multi: the stick (gas + right) and FIRE held at once by two thumbs; the stick slides on (brake + left) while FIRE holds; a FIRE finger moved onto MINE keeps FIRE",
    both.throttle === 1 && both.steer > 0 && both.steer < 1 && both.fire && slid.throttle === -1 && slid.steer < 0 && slid.fire && stuck.fire && !stuck.mine && stuck.steer === slid.steer,
    `both ${JSON.stringify(both)}, slid ${JSON.stringify(slid)}, moved ${JSON.stringify(stuck)}`,
  );
  check(
    "touch multi: a third finger's MINE tap latches a mine with the stick and FIRE still held; each finger lets go of its own control",
    tapped.mine && tapped.fire && tapped.throttle === -1 && stickUp.fire && stickUp.throttle === 0 && stickUp.steer === 0 && ctlText(s) === "t0 s0 mine",
    `tap ${JSON.stringify(tapped)}, stick up ${JSON.stringify(stickUp)}, end ${ctlText(s)}`,
  );
  // A move or lift of a finger the controls never saw go down changes nothing.
  const idle = touchRun([stickMove(9, 300, 500), { t: "up", id: 9 }]);
  check("touch multi: a stranger finger's move and lift are ignored", idle === PAD_IDLE, ctlText(idle));
}

function touchRelease(): void {
  const held = touchRun([stickDown(1, 290, 560), stickMove(1, 260, 520), fireDown(2), mineDown(3)]);
  // pointercancel and lostpointercapture come in as "up" for their finger.
  const cancelled = touchRun([{ t: "up", id: 1 }, { t: "up", id: 2 }], held);
  check("touch release: pointercancel / lostpointercapture (an up of that finger) let go of the stick and FIRE", ctlText(cancelled) === "t0 s0 mine" && cancelled.stick === null && cancelled.fire.length === 0, ctlText(cancelled));
  // Window blur, the page hidden: every finger let go, a mine tapped just before still drops (as the keyboard's blur).
  const blurred = reducePad(held, { t: "release" }, TOUCH_GEO, SP);
  check("touch release: window blur / visibilitychange let go of every finger (no stuck gas or steer) and keep the mine latch", ctlText(blurred) === "t0 s0 mine" && blurred.stick === null && blurred.mineHeld.length === 0, ctlText(blurred));
  // Chat focus, menu open, the controls hidden: everything, the mine latch too (as Keyboard.clear); the stick goes (TouchPad hides the knob).
  const cleared = reducePad(held, { t: "clear" }, TOUCH_GEO, SP);
  check("touch release: clear (chat focus, menu open, every hide) drops every finger, the stick and the mine latch", cleared === PAD_IDLE && cleared.stick === null && ctlText(cleared) === "t0 s0");
  // After a release the fingers' later moves and lifts change nothing (they must go down again).
  const later = touchRun([stickMove(1, 290, 480), { t: "up", id: 1 }], cleared);
  check("touch release: a released thumb that moves on does not drive until it goes down again", later === PAD_IDLE, ctlText(later));
}

function touchMine(): void {
  // A tap shorter than a step: down and up before the step reads it, still one mine.
  let s = touchRun([mineDown(1), { t: "up", id: 1 }]);
  let c: ReturnType<typeof padControls>;
  [c, s] = readPad(s, SP);
  const first = c.mine;
  [c, s] = readPad(s, SP);
  const second = c.mine;
  // Held across steps: one mine (only the press counts), as a held X key.
  s = touchRun([mineDown(2)], s);
  const reads: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    [c, s] = readPad(s, SP);
    reads.push(c.mine);
  }
  s = touchRun([{ t: "up", id: 2 }, mineDown(3)], s);
  [c, s] = readPad(s, SP);
  check(
    "touch mine: a tap shorter than a step is latched and read once; a held MINE is one mine; the next tap another",
    first && !second && reads.join(",") === "true,false,false" && c.mine,
    `tap ${first}/${second}, held ${reads.join(",")}, again ${c.mine}`,
  );
  // FIRE is held, not latched: it reads true every step while held, false after the lift.
  s = touchRun([fireDown(4)]);
  const fires: boolean[] = [];
  for (let i = 0; i < 2; i++) {
    [c, s] = readPad(s, SP);
    fires.push(c.fire);
  }
  s = reducePad(s, { t: "up", id: 4 }, TOUCH_GEO, SP);
  [c, s] = readPad(s, SP);
  fires.push(c.fire);
  // The gap between FIRE and MINE is no dead spot: a finger there gets the nearer one.
  const nearMine = touchRun([{ t: "down", id: 5, cluster: "weapons", x: 40, y: 743 }]);
  const nearFire = touchRun([{ t: "down", id: 6, cluster: "weapons", x: 40, y: 746 }]);
  check(
    "touch mine: FIRE reads held every step until lifted; a finger in the gap between FIRE and MINE gets the nearer button",
    fires.join(",") === "true,true,false" && nearMine.mine && nearMine.fire.length === 0 && nearFire.fire.length === 1 && !nearFire.mine,
    `fire ${fires.join(",")}; gap y743 -> ${ctlText(nearMine)}, y746 -> ${ctlText(nearFire)}`,
  );
  // The read takes the latch and nothing else (a state without a latch is returned as is), and reads the stick.
  const plain = touchRun([stickDown(8, 290, 560), stickMove(8, 330, 520)]);
  const [pc, ps] = readPad(plain, SP);
  check("touch mine: a read with no mine pending returns the same state, with the stick's controls", ps === plain && pc.throttle === 1 && pc.steer > 0, JSON.stringify(pc));
}

function touchMerge(): void {
  const T = (throttle: number, steer: number, fire = false, mine = false) => ({ throttle, steer, fire, mine });
  const cases: [string, ReturnType<typeof T>, ReturnType<typeof T>, ReturnType<typeof T>][] = [
    ["keys only", T(1, -1, true, false), T(0, 0), T(1, -1, true, false)],
    ["touch only", T(0, 0), T(-1, 0.43, false, true), T(-1, 0.43, false, true)],
    ["both gas: clamped to 1", T(1, 1), T(1, 0.6), T(1, 1)],
    ["key up + touch brake: 0", T(1, -1), T(-1, 1), T(0, 0)],
    ["key left + stick 0.4 right: -0.6", T(0, -1), T(0, 0.4), T(0, -0.6)],
    ["fire either, mine either", T(0, 0, true, false), T(0, 0, false, true), T(0, 0, true, true)],
  ];
  const bad = cases.filter(([, a, b, want]) => JSON.stringify(mergeControls(a, b)) !== JSON.stringify(want)).map(([n]) => n);
  check("touch merge: throttle and steer = clamp(sum) (a fractional stick steer with a key too), fire = OR, mine = OR", bad.length === 0, bad.join(", ") || cases.map(([n]) => n).join("; "));
  // With the real Keyboard: arrow up held and the stick's brake = 0; the keyboard's mine and FIRE both reach the step.
  const g = globalThis as unknown as Record<string, unknown>;
  const stubbed = !g.HTMLInputElement;
  if (stubbed) {
    g.HTMLInputElement = class {};
    g.HTMLTextAreaElement = class {};
  }
  try {
    const handlers = new Map<string, (e: unknown) => void>();
    const kb = new Keyboard({ addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn) } as unknown as Window);
    const key = (code: string, on: unknown = null) => handlers.get("keydown")!({ code, key: code, repeat: false, target: on, preventDefault() {} });
    key("ArrowUp");
    key("KeyX");
    let s = touchRun([stickDown(1, 290, 560), stickMove(1, 290, 620), fireDown(2)]);
    const [tc, next] = readPad(s, SP);
    s = next;
    const merged = mergeControls(kb.read(), tc);
    const after = mergeControls(kb.read(), readPad(s, SP)[0]);
    check(
      "touch merge: Keyboard.read + the stick: the up key and the stick's brake cancel, the X key's mine and FIRE both drive; each latch is read once",
      merged.throttle === 0 && merged.steer === 0 && merged.fire && merged.mine && after.throttle === 0 && after.fire && !after.mine,
      `${JSON.stringify(merged)} then ${JSON.stringify(after)}`,
    );
    // A driving key hides the controls (isDriveKey); typing in a field or another key does not.
    const ev = (code: string, target: unknown = null) => ({ code, key: code, target }) as unknown as KeyboardEvent;
    const field = new (g.HTMLInputElement as new () => object)();
    const drive = ["ArrowUp", "KeyW", "KeyS", "KeyA", "KeyD", "Space", "KeyZ", "KeyJ", "KeyX", "KeyK"].every((k) => isDriveKey(ev(k)));
    const not = [ev("KeyW", field), ev("Escape"), ev("KeyM"), ev("Enter")].every((e) => !isDriveKey(e));
    check("touch merge: driving keys (arrows/WASD, Space/Z/J, X/K) count as keyboard driving; typing in a field, Esc, M, Enter do not", drive && not);
  } finally {
    if (stubbed) {
      delete g.HTMLInputElement;
      delete g.HTMLTextAreaElement;
    }
  }
  // The defaults: point mode (TOUCH-5) with its values, R 67 (TOUCH-6: the user's point-mode tuning),
  // and rate mode's the user's (TOUCH-4), full lock inside R; in rate mode the stick's direct
  // function agrees with the reducer.
  const direct = stickControls(40, -30, SP);
  const viaPad = at(40, -30);
  check(
    "touch merge: the defaults are point mode (TOUCH-5: dead zone 0.3 R, full lock 35° off, brake past 110°) at R 67 (TOUCH-6) and the user's TOUCH-4 rate values (full lock inside R, 0.9 R, past a small dead zone); stickControls is what the reducer reads in rate mode",
    JSON.stringify(STICK_DEFAULTS) === '{"mode":"point","radius":67,"steerDead":0.12,"steerLock":0.9,"steerCurve":3,"throttleDead":0.3,"split":0.5,"pointDead":0.3,"aimFull":35,"brakeAngle":110}' &&
      STICK_DEFAULTS.steerLock < 1 && STICK_DEFAULTS.steerDead < STICK_DEFAULTS.steerLock && direct[0] === viaPad.throttle && direct[1] === viaPad.steer && direct[1] > 0,
    JSON.stringify(STICK_DEFAULTS),
  );
}

// ---- touch point to steer (TOUCH-5, PLAN-TOUCH addendum 2026-11-22 + advisor changes: client/input.ts point mode) ----
// Point mode: the stick's direction is where the car should face. Pure functions first (the aim, the
// steer, the throttle's rules, the dead zone, rate mode untouched), then closed loops through the
// real physics: turns per car type (dry and on water), a lap of Rust Bowl by a look-ahead pointer
// with a human's lag, and a head-on wall escape.

// This section's imports (hoisted like the ones at the top; distinct names).
import {
  POINT_IDLE,
  POINT_RULES,
  pointAim,
  pointControls,
  pointSteer,
  pointThrottle,
  stickOutput,
  type PadCar,
  type PointMemo,
  type Stick,
} from "../client/input";
import { wrapAngle as touchWrap } from "../shared/physics";
import { SURF_WATER as TOUCH_WATER, surfaceAt as touchSurfaceAt } from "../shared/track";

const PT: StickParams = { ...STICK_DEFAULTS, mode: "point" };
const TDEG = Math.PI / 180;
/** A car for point mode: heading (degrees), forward speed, live. */
const pcar = (hDeg: number, vf = 0, live = true): PadCar => ({ h: hDeg * TDEG, vf, live });
/** The thumb's offset pointing at `deg` (screen axes: 0 right, 90 down), `share` of R out. */
const thumb = (deg: number, share = 0.8, p: StickParams = PT): [number, number] => [share * p.radius * Math.cos(deg * TDEG), share * p.radius * Math.sin(deg * TDEG)];
/** Game.step's rounding (client/game.ts round(v, 2)). */
const r100 = (v: number) => Math.round(v * 100) / 100;

function touchPointAim(): void {
  // Screen axes are world axes (the camera only translates, client/render.ts): right 0, down +90°
  // (y grows downward, as the heading grows clockwise on screen), left 180°, up -90°.
  const dirs: [string, number, number, number][] = [["right", 50, 0, 0], ["down", 0, 50, 90], ["left", -50, 0, 180], ["up", 0, -50, -90], ["down-right", 40, 40, 45], ["up-left", -40, -40, -135]];
  const bad = dirs.filter(([, dx, dy, deg]) => Math.abs(pointAim(dx, dy, PT)! - deg * TDEG) > 1e-12).map(([n]) => n);
  // A car heading where the stick points moves that way on screen: its velocity (Math.cos/sin(h),
  // shared/physics.ts) has the thumb's signs, from rest under gas.
  const moved: string[] = [];
  for (const [name, dx, dy] of dirs) {
    const h = pointAim(dx, dy, PT)!;
    const c: CarState = { x: 0, y: 0, h, vx: 0, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0, boost: 0 };
    const vx = Math.cos(c.h) * 100, vy = Math.sin(c.h) * 100;
    if (Math.abs(Math.atan2(vy, vx) - Math.atan2(dy, dx)) > 1e-9) moved.push(name);
  }
  check(
    "touch point: the aim is atan2(dy, dx) of the thumb's offset (screen axes = world axes: right 0, down +90°, left 180°, up -90°); a car heading there moves the thumb's way (cos/sin of the heading)",
    bad.length === 0 && moved.length === 0,
    [...bad, ...moved].join(", ") || dirs.map(([n, , , d]) => `${n} ${d}°`).join(", "),
  );
  // The dead zone: up to pointDead x R (0.3 x 67 = 20.1 px) no aim; just past it, an aim.
  const dz = PT.pointDead * PT.radius;
  const inside = [[dz, 0], [0, -dz], [-dz * 0.7, dz * 0.7], [0, 0]].every(([dx, dy]) => pointAim(dx, dy, PT) === null);
  const past = pointAim(dz + 0.5, 0, PT) === 0 && pointAim(0, -(dz + 0.5), PT) === -Math.PI / 2;
  check(`touch point: no aim inside the dead zone (up to ${dz.toFixed(1)} px, every way); just past it the thumb's direction`, inside && past);
}

function touchPointSteer(): void {
  const A = PT.aimFull; // 35°
  const at = (errDeg: number, vf = 0) => pointSteer(errDeg * TDEG, vf, PT);
  const rows = [0, 3.5, A / 2, A, 2 * A, 90, 180].map((e) => [e, at(e)] as const);
  check(
    `touch point steer: aligned gives 0; in proportion to the error (half of aimFull ${A}°: 0.5); full lock (1) at aimFull and past it`,
    at(0) === 0 && at(3.5) === 0.1 && at(A / 2) === 0.5 && at(A) === 1 && at(2 * A) === 1 && at(90) === 1 && at(180) === 1,
    rows.map(([e, s]) => `${e}°: ${s}`).join(", "),
  );
  // Symmetric: -err gives -steer, for a sweep of errors (and speeds both ways of flipSpeed).
  let sym = true;
  for (let e = -180; e <= 180; e += 0.5) for (const vf of [0, 140, -40]) sym &&= at(-e, vf) === -at(e, vf) || (at(e, vf) === 0 && at(-e, vf) === 0);
  check("touch point steer: symmetric (an error to the left steers left exactly as much), every 0.5° from -180° to 180°", sym);
  // Wraps at ±π: a car heading 175° (left, a little down) and a thumb pointing -175° (left, a little
  // up) is 10° off the short way (clockwise past 180°), not 350°.
  const [tx, ty] = thumb(-175);
  const [, wrapSteer] = pointControls(tx, ty, pcar(175, 140), POINT_IDLE, PT);
  const [, wrapBack] = pointControls(...thumb(175), pcar(-175, 140), POINT_IDLE, PT);
  check(
    "touch point steer: the error wraps at ±180° (heading 175°, aim -175°: 10° off, the short way round: +0.29; mirrored -0.29)",
    wrapSteer === r100(10 / A) && wrapBack === -r100(10 / A),
    `${wrapSteer} / ${wrapBack}`,
  );
  // Rolling backward faster than flipSpeed (20 u/s) the steer flips, so the nose still swings toward the aim.
  const F = POINT_RULES.flipSpeed;
  check(
    `touch point steer: flipped while rolling backward faster than ${F} u/s (vf ${-F - 1}: -0.5 for a 17.5° error), not at ${-F} or forward`,
    at(A / 2, -F - 1) === -0.5 && at(A / 2, -F) === 0.5 && at(A / 2, 300) === 0.5 && at(-A, -200) === 1,
    `${at(A / 2, -F - 1)}, ${at(A / 2, -F)}, ${at(A / 2, 300)}, ${at(-A, -200)}`,
  );
  // In hundredths (Game.step's rounding leaves it as it is), never -0, within -1..1; and the JSON round trip.
  let exact = true;
  for (let e = -180; e <= 180; e += 0.37) {
    for (const vf of [-100, 0, 100]) {
      const s = at(e, vf);
      exact &&= r100(s) === s && JSON.parse(JSON.stringify(s)) === s && !Object.is(s, -0) && s >= -1 && s <= 1;
    }
  }
  check("touch point steer: every steer is in hundredths, survives round(v, 2) and a JSON round trip, never -0, within -1..1", exact);
}

function touchPointDead(): void {
  // Inside the dead zone: no gas, no steer (the car coasts), and the memo afresh, whatever was latched.
  const latched: PointMemo = { rev: 1, stuck: 12, brake: 2 };
  const [t0, s0, m0] = pointControls(10, -10, pcar(0, 200), latched, PT);
  // No car (between races): nothing.
  const [t1, s1, m1] = pointControls(...thumb(90), null, latched, PT);
  // Through the reducer and padControls: a thumb landing and held inside the dead zone gives nothing; pushed out it drives.
  const s = touchRun([stickDown(1, 290, 560), stickMove(1, 300, 570)], PAD_IDLE, PT);
  const held = padControls(s, PT, pcar(0, 100));
  const out = padControls(touchRun([stickMove(1, 290 + 60, 560)], s, PT), PT, pcar(0, 100));
  const none = padControls(PAD_IDLE, PT, pcar(0, 100));
  check(
    "touch point: inside the dead zone throttle 0 and steer 0 (coast) and the memo starts afresh; with no car nothing; no thumb nothing; past the dead zone along the car: gas, no steer",
    t0 === 0 && s0 === 0 && m0 === POINT_IDLE && t1 === 0 && s1 === 0 && m1 === POINT_IDLE && held.throttle === 0 && held.steer === 0 && out.throttle === 1 && out.steer === 0 && none.throttle === 0 && none.steer === 0,
    `dead ${t0}/${s0} ${JSON.stringify(m0)}; no car ${t1}/${s1}; held ${JSON.stringify(held)}; out ${JSON.stringify(out)}`,
  );
  // Rate mode is TOUCH-4 exactly: stickOutput in rate mode is stickControls for every offset, whatever the car and memo.
  let same = true;
  for (let dx = -110; dx <= 110; dx += 7) {
    for (let dy = -110; dy <= 110; dy += 7) {
      const st: Stick = { id: 1, cx: 200, cy: 500, x: 200 + dx, y: 500 + dy };
      const [rt, rs, rm] = stickOutput(st, SP, pcar(37, -50), { rev: 2, stuck: 30, brake: 1 });
      const [et, es] = stickControls(dx, dy, SP);
      same &&= rt === et && rs === es && rm === POINT_IDLE;
    }
  }
  const viaRead = readPad(touchRun([stickDown(1, 290, 560), stickMove(1, 330, 520)]), SP, pcar(90, 0));
  check(
    "touch point: rate mode is unchanged (TOUCH-4): its output is stickControls of the offset for every offset, whatever the car (and it keeps no memo); readPad in rate mode too",
    same && viaRead[0].throttle === 1 && viaRead[0].steer === stickControls(40, -40, SP)[1] && viaRead[2] === POINT_IDLE,
    JSON.stringify(viaRead[0]),
  );
  // The centre near an edge in point mode keeps pointDead x R + 8 px from every edge, so every
  // direction can be pointed past the dead zone on screen, from any landing in the zone (TOUCH-6:
  // every whole degree from the zone's corners, edge middles and middle; the thumb as far along that
  // direction as the screen (x 0..w-1, y 0..h-1) and R allow must be past the dead zone and point
  // exactly that way).
  const keep = PT.pointDead * PT.radius + 8; // R 67: 28.1 px
  const corner = stickCentre(389, 843, TOUCH_GEO.screen, PT);
  const topLeft = stickCentre(1, 1, TOUCH_GEO.screen, PT);
  const unreached: string[] = [];
  let rays = 0, shortest = Infinity;
  for (const [w, h] of [[390, 844], [844, 390], [360, 740]]) {
    const geo: PadGeometry = { ...TOUCH_GEO, screen: { left: 0, top: 0, width: w, height: h } };
    const [zl, zt] = [w * PT.split, 92];
    for (const x of [zl, (zl + w - 1) / 2, w - 1]) {
      for (const y of [zt, (zt + h - 1) / 2, h - 1]) {
        const st = reducePad(PAD_IDLE, stickDown(1, x, y), geo, PT).stick!;
        for (let deg = -180; deg < 180; deg++) {
          const [ux, uy] = [Math.cos(deg * TDEG), Math.sin(deg * TDEG)];
          const run = (c: number, u: number, hi: number) => (u > 1e-12 ? (hi - c) / u : u < -1e-12 ? -c / u : Infinity); // to the screen's edge
          const t = Math.min(PT.radius, run(st.cx, ux, w - 1), run(st.cy, uy, h - 1));
          rays++;
          shortest = Math.min(shortest, t);
          const aim = pointAim(t * ux, t * uy, PT);
          if (aim === null || Math.abs(touchWrap(aim - deg * TDEG)) > 1e-9) unreached.push(`${w}x${h} ${x},${y} ${deg}°: ${t.toFixed(1)} px`);
        }
      }
    }
  }
  check(
    `touch point: a thumb landing at an edge puts the centre ${keep.toFixed(1)} px in (the dead zone + 8 px) on every side; from the zone's corners, edge middles and middle at 390x844, 844x390 and 360x740 every whole degree can be pointed on screen past the dead zone (${(PT.pointDead * PT.radius).toFixed(1)} px)`,
    corner.join(",") === `${390 - keep},${844 - keep}` && topLeft.join(",") === `${keep},${keep}` && rays === 3 * 9 * 360 && unreached.length === 0 && shortest > PT.pointDead * PT.radius,
    `corner ${corner.map((v) => v.toFixed(1)).join(",")}, top-left ${topLeft.map((v) => v.toFixed(1)).join(",")}; ${rays} directions, the shortest on-screen reach ${shortest.toFixed(1)} px${unreached.length ? `; unreached ${unreached.slice(0, 6).join(" | ")}` : ""}`,
  );
}

function touchPointThrottle(): void {
  const R = POINT_RULES;
  const thr = (off: number, vf: number, memo: PointMemo = POINT_IDLE, live = true) => pointThrottle(off * TDEG, { h: 0, vf, live }, memo, PT);
  // Pointed within brakeAngle (110°): gas at every speed, forward or backward (gas while rolling backward brakes).
  const gas = [0, 45, 90, 110].every((off) => [-300, -21, 0, 29, 151, 430].every((vf) => thr(off, vf)[0] === 1 && thr(off, vf)[1].rev === 0));
  // Pointed past it (a new turn): brake above brakeSpeed + brakeHyst (180), gas from there down to
  // just above revSpeed (30), reverse to turn round (latch 1) at 30 and under, any backward speed too.
  const rows = [430, 181, 180, 151, 100, 31, 30, 10, 0, -50, -300].map((vf) => [vf, ...thr(170, vf)] as const);
  const want = [-1, -1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
  const behindOk = rows.every(([vf, t, m], i) => t === want[i] && m.rev === (vf <= R.revSpeed ? 1 : 0)) && thr(111, 0)[0] === -1 && thr(-111, 0)[0] === -1 && thr(-170, 200)[0] === -1;
  check(
    `touch point throttle: within ${PT.brakeAngle}° gas at any speed; past it (a new turn) brake above ${R.brakeSpeed + R.brakeHyst} u/s, gas down to ${R.revSpeed + 1}, reverse at ${R.revSpeed} and under (also rolling backward); both sides`,
    gas && behindOk,
    rows.map(([vf, t, m]) => `${vf}: ${t}${m.rev ? " rev" : ""}`).join(", "),
  );
  // The reverse to turn round lasts until under brakeAngle - revHyst (80°): no chatter between
  // reverse and gas as the nose comes round (gas at vf < 0 brakes); it is not entered again until
  // past brakeAngle again. A sweep of the error 170° -> 0 at a backward speed, and back up.
  let m: PointMemo = POINT_IDLE;
  const trace: string[] = [];
  let changes = 0, last = 0;
  const sweep = [...Array.from({ length: 171 }, (_, i) => 170 - i), ...Array.from({ length: 100 }, (_, i) => i + 1)];
  for (const off of sweep) {
    const [t, next] = thr(off, -60, m);
    if (t !== last) {
      changes++;
      trace.push(`${off}°: ${t}`);
    }
    last = t;
    m = next;
  }
  check(
    `touch point throttle: a reverse to turn round ends only under ${PT.brakeAngle - R.revHyst}° (hysteresis ${R.revHyst}°): the error swept 170° -> 0° -> 100° while rolling back gives reverse then gas once, no flicker; not entered again under ${PT.brakeAngle}°`,
    changes === 2 && trace.join(", ") === "170°: -1, 79°: 1",
    trace.join(", "),
  );
  // Stuck (nose in a wall, thumb along the track, ~90° off: under brakeAngle, so plain gas forever):
  // the throttle on with |vf| under stuckSpeed (15) for stuckTicks (30) driving steps, more than
  // aimFull (35°) off -> reverse out (latch 2), until under aimFull / 2 off.
  const steps = (n: number, off: number, vf: number, memo: PointMemo = POINT_IDLE, live = true) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const [t, next] = thr(off, vf, memo, live);
      out.push(t);
      memo = next;
    }
    return { out, memo };
  };
  const stuck = steps(32, 90, 3);
  const firstRev = stuck.out.indexOf(-1);
  const near = steps(60, 30, 3); // 30° off: under aimFull, the rule does not reverse
  const dead = steps(60, 90, 3, POINT_IDLE, false); // not driving (the countdown, a wreck): never counts
  const moving = steps(60, 90, R.stuckSpeed); // |vf| at the threshold: moving, never stuck
  const backward = steps(32, 90, -3); // |vf| counts both ways
  const out1 = thr(18, -40, { rev: 2, stuck: 0, brake: 0 }); // 18° off: still reversing (aimFull / 2 = 17.5)
  const out2 = thr(17, -40, { rev: 2, stuck: 0, brake: 0 });
  check(
    `touch point throttle: stuck (gas, |vf| < ${R.stuckSpeed} for ${R.stuckTicks} driving steps, > ${PT.aimFull}° off) reverses out from the next step; not under ${PT.aimFull}° off, not while the car does not drive, not at |vf| ${R.stuckSpeed}; rolling back slowly counts too; the reverse out lasts until under ${PT.aimFull / 2}° off`,
    firstRev === R.stuckTicks && stuck.out.slice(firstRev).every((t) => t === -1) && stuck.memo.rev === 2 && near.out.every((t) => t === 1) && near.memo.stuck === R.stuckTicks &&
      dead.out.every((t) => t === 1) && dead.memo.stuck === 0 && moving.out.every((t) => t === 1) && moving.memo.stuck === 0 && backward.out.indexOf(-1) === R.stuckTicks &&
      out1[0] === -1 && out1[1].rev === 2 && out2[0] === 1 && out2[1].rev === 0,
    `first reverse at step ${firstRev}; near ${near.memo.stuck}; not driving ${dead.memo.stuck}; at ${R.stuckSpeed} ${moving.memo.stuck}; 18° ${out1[0]}, 17° ${out2[0]}`,
  );
  // Stuck reversing (backed into something): gas (latch 3), and no reverse to turn round, even
  // pointed behind, until it rolls forward faster than revSpeed; stuck again under gas: reverse again.
  const backedIn = steps(32, 90, 2, { rev: 2, stuck: 0, brake: 0 });
  const after = steps(5, 170, 10, backedIn.memo);
  const freed = thr(170, R.revSpeed + 1, after.memo);
  const wiggle = steps(32, 90, 2, { rev: 3, stuck: 0, brake: 0 });
  check(
    `touch point throttle: stuck while reversing out drives forward (gas) and stays forward pointed behind until faster than ${R.revSpeed} u/s; stuck again under gas reverses again`,
    backedIn.out.indexOf(1) === R.stuckTicks && backedIn.memo.rev === 3 && after.out.every((t) => t === 1) && after.memo.rev === 3 && freed[1].rev === 0 && wiggle.memo.rev === 2 && wiggle.out.indexOf(-1) === R.stuckTicks,
    `backed in: gas from step ${backedIn.out.indexOf(1)} (latch ${backedIn.memo.rev}); pointed behind ${after.out.join("")}; freed latch ${freed[1].rev}; wiggle latch ${wiggle.memo.rev}`,
  );
  // One total function: every error (1° steps), speed (-400..450 u/s), memo and live gives gas or
  // brake/reverse, a steer in -1..1 in hundredths and a valid memo, the same every time.
  let total = true, n = 0;
  for (let off = -180; off <= 180; off += 2) {
    for (let vf = -400; vf <= 450; vf += 10) {
      for (const rev of [0, 1, 2, 3] as const) {
        for (const st of [0, 15, R.stuckTicks]) {
          for (const [live, brake] of [[true, 0], [true, 1], [true, 2], [false, 0], [false, 1], [false, 2]] as const) {
            const memo: PointMemo = { rev, stuck: st, brake };
            const car = { h: 0.3, vf, live };
            const [tx, ty] = thumb(off + 0.3 / TDEG);
            const a = pointControls(tx, ty, car, memo, PT);
            const b = pointControls(tx, ty, car, memo, PT);
            n++;
            total &&= (a[0] === 1 || a[0] === -1) && a[1] >= -1 && a[1] <= 1 && r100(a[1]) === a[1] && [0, 1, 2, 3].includes(a[2].rev) && [0, 1, 2].includes(a[2].brake) && a[2].stuck >= 0 && a[2].stuck <= R.stuckTicks && JSON.stringify(a) === JSON.stringify(b);
          }
        }
      }
    }
  }
  check(`touch point throttle: one total function: ${n} cases (every error in 2° steps, speed, memo incl. the brake latch, live) give gas or brake/reverse, a steer in hundredths and a valid memo, the same twice`, total);
}

function touchPointBrake(): void {
  // The brake for a turn pointed behind, once a turn with a speed hysteresis (review F2: around
  // brakeSpeed 150 the throttle blipped brake for single steps). A turn starting above brakeSpeed +
  // brakeHyst (180) brakes down to brakeSpeed (150), then gas until it no longer points behind; one
  // starting slower is gas throughout.
  const R = POINT_RULES;
  const thr = (off: number, vf: number, memo: PointMemo = POINT_IDLE) => pointThrottle(off * TDEG, { h: 0, vf, live: true }, memo, PT);
  const braking: PointMemo = { rev: 0, stuck: 0, brake: 1 };
  const spent: PointMemo = { rev: 0, stuck: 0, brake: 2 };
  const unit = [
    ["new turn at 181: brake", thr(170, 181), -1, 1],
    ["new turn at 180: gas, no brake this turn", thr(170, 180), 1, 2],
    ["braking at 151: still", thr(170, 151, braking), -1, 1],
    ["braking at 150: gas", thr(170, 150, braking), 1, 2],
    ["braked, at 400 still behind: gas", thr(170, 400, spent), 1, 2],
    ["braked, no longer behind: the turn is over", thr(100, 400, spent), 1, 0],
    ["braking, then reversing (at 30): no brake latch", thr(170, 30, braking), -1, 0],
  ] as const;
  const bad = unit.filter(([, [t, m], wt, wb]) => t !== wt || m.brake !== wb).map(([n, [t, m]]) => `${n}: got ${t} brake ${m.brake}`);
  check(`touch point brake: a turn pointed behind brakes from above ${R.brakeSpeed + R.brakeHyst} u/s down to ${R.brakeSpeed}, once a turn; a turn starting slower is gas`, bad.length === 0, bad.join(" | ") || unit.map(([n]) => n).join("; "));
  // Closed loops: the throttle's sign changes over a whole turn (open field), each car type (and the
  // Racer with tyres 3), from 140 to 430 u/s, 115° to 180° off both ways, dry and wet: at most once.
  const seqOf = (f: ReturnType<typeof pointField>, stats: ReturnType<typeof statsFor>, v0: number, off: number, n: number) => {
    const c: CarState = { x: f.x, y: f.y, h: 0, vx: v0, vy: 0, seg: f.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const [dx, dy] = thumb(off);
    let memo: PointMemo = POINT_IDLE, seq = "";
    for (let t = 0; t < n; t++) {
      const vf = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
      const [throttle, steer, next] = pointControls(dx, dy, { h: c.h, vf, live: true }, memo, PT);
      memo = next;
      seq += throttle > 0 ? "+" : "-";
      stepCar(c, { throttle: r100(throttle), steer: r100(steer) }, stats, f.track);
    }
    return seq;
  };
  const changes = (seq: string) => [...seq].filter((ch, i) => i > 0 && ch !== seq[i - 1]).length;
  const dry = pointField(false);
  const racer = POINT_CARS[1][1];
  const r160 = seqOf(dry, racer, 160, 170, 24), r300 = seqOf(dry, racer, 300, 170, 24);
  const hist = new Map<number, number>();
  let worst = "", most = 0;
  for (const water of [false, true]) {
    const f = water ? pointField(true) : dry;
    for (const [name, stats] of POINT_CARS) {
      for (let v0 = 140; v0 <= 430; v0 += 30) {
        for (const off of [115, 125, 135, 145, 155, 165, 175, 180]) {
          for (const side of [1, -1]) {
            const seq = seqOf(f, stats, v0, side * off, 150);
            const k = changes(seq);
            hist.set(k, (hist.get(k) ?? 0) + 1);
            if (k > most) [most, worst] = [k, `${water ? "wet " : ""}${name} ${v0} u/s ${side * off}°: ${seq.slice(0, 40)}`];
          }
        }
      }
    }
  }
  check(
    "touch point brake: over a whole turn the throttle changes sign at most once (brake, then gas): the Racer from 160 u/s 170° off (was -++-++++-+++++++-) and from 300; every car type, 140-430 u/s, 115-180° off both ways, dry and wet",
    changes(r160) <= 1 && changes(r300) === 1 && r300.startsWith("-") && most <= 1,
    `Racer 160: ${r160}, Racer 300: ${r300}; changes per turn ${[...hist].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}: ${n} turns`).join(", ")}${most > 1 ? `; worst ${worst}` : ""}`,
  );
}

/** A wide open field (a 3000 half-width loop) for turns with no wall near, optionally all water there. */
function pointField(water: boolean): { track: Track; x: number; y: number; seg: number } {
  const def: TrackDef = { id: "point-field", name: "Point Field", control: [[0, 0], [40000, 0], [40000, 16000], [0, 16000]], halfWidth: 3000, verge: 44 };
  const dry = buildTrack(def);
  const q = queryTrack(dry, 20000, 0);
  const track = water ? buildTrack({ ...def, features: [{ k: "water", s0: q.s - 12000, s1: q.s + 12000, lat0: -3000, lat1: 3000 }] }) : dry;
  return { track, x: 20000, y: 0, seg: q.seg };
}

/** A closed loop: the car at speed v0 heading 0, the thumb held toward `off` degrees; ticks until the heading stays within 3°, the overshoot past it (degrees), latch changes, brake steps. */
function pointTurn(f: ReturnType<typeof pointField>, stats: ReturnType<typeof statsFor>, v0: number, off: number): { settle: number; over: number; latches: number; brakes: number; revs: number; wet: boolean | null } {
  const c: CarState = { x: f.x, y: f.y, h: 0, vx: v0, vy: 0, seg: f.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const [dx, dy] = thumb(off);
  let memo: PointMemo = POINT_IDLE;
  let last = -1, over = 0, latches = 0, brakes = 0, revs = 0;
  const wetAt: boolean[] = [];
  for (let t = 0; t < 400; t++) {
    // 400 ticks (6.7 s): every turn has settled long before, and the field's walls are still far.
    const q = queryTrackNear(f.track, c.x, c.y, c.seg);
    wetAt.push(touchSurfaceAt(f.track, q.seg, q.s, q.lat)?.kind === TOUCH_WATER);
    const vf = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
    const [throttle, steer, next] = pointControls(dx, dy, { h: c.h, vf, live: true }, memo, PT);
    if (next.rev !== memo.rev) latches++;
    if (next.rev === 1 || next.rev === 2) revs++;
    else if (throttle < 0) brakes++;
    memo = next;
    stepCar(c, { throttle: r100(throttle), steer: r100(steer) }, stats, f.track);
    const err = touchWrap(off * TDEG - c.h) / TDEG;
    if (Math.abs(err) > 3) last = t;
    over = Math.max(over, -Math.sign(off) * err);
  }
  const turning = wetAt.slice(0, last + 2);
  const wet = turning.every((w) => w) ? true : turning.every((w) => !w) ? false : null;
  return { settle: last + 1, over, latches, brakes, revs, wet };
}

const POINT_CARS: [string, ReturnType<typeof statsFor>][] = [
  ["sport", statsFor("sport", { engine: 0, tyres: 0, welder: 0 })],
  ["racer", statsFor("racer", { engine: 0, tyres: 0, welder: 0 })],
  ["truck", statsFor("truck", { engine: 0, tyres: 0, welder: 0 })],
  ["racer tyres 3", statsFor("racer", { engine: 0, tyres: 3, welder: 0 })], // the quickest heading loop (advisor: gain ~0.105 a step)
];

function pointTurns(water: boolean, bound: number): void {
  const f = pointField(water);
  const rows: string[] = [];
  let ok = true, worst = 0, worstOver = 0, wetAll = true;
  for (const [name, stats] of POINT_CARS) {
    const cells: string[] = [];
    for (const v0 of [0, 140, stats.topSpeed]) {
      for (const off of [90, 170, -90, -170]) {
        const r = pointTurn(f, stats, v0, off);
        ok &&= r.settle <= bound && r.over < 5 && r.latches <= 2;
        wetAll &&= r.wet === water;
        worst = Math.max(worst, r.settle);
        worstOver = Math.max(worstOver, r.over);
        if (off > 0) cells.push(`${v0}/${off}°: ${r.settle}t${r.revs ? ` rev ${r.revs}` : ""}${r.brakes ? ` brake ${r.brakes}` : ""}${r.over > 0 ? ` over ${r.over.toFixed(2)}°` : ""}`);
      }
    }
    rows.push(`${name} ${cells.join(", ")}`);
  }
  check(
    `touch point loop${water ? " on water" : ""}: per car type (and the Racer with tyres 3), from rest, 140 u/s and top speed, the thumb held 90° and 170° off (both sides): the heading settles within 3° in at most ${bound} ticks (${(bound / 60).toFixed(1)} s; worst ${worst}), overshoot under 5° (worst ${worstOver.toFixed(2)}°), at most one reverse in and out`,
    ok && wetAll,
    `${rows.join(" | ")}${wetAll ? "" : " (NOT all on the intended surface)"}`,
  );
}

function touchPointTurns(): void {
  pointTurns(false, 120);
}

function touchPointWater(): void {
  // Water halves the steering (WATER_TURN) and cuts every force along the car (WATER_FORCE): slower, still no overshoot.
  pointTurns(true, 300);
}

function touchPointLap(): void {
  // A scripted thumb drives a lap of Rust Bowl: it points at the centre line ahead of the car (a
  // look-ahead aim; a tangent aim runs wide), updated 10 times a second from where the car was
  // 150 ms before (a human's lag). Wall hits: steps that end at the wall moving into it at
  // WALL_HIT_MIN (50 u/s, the game's wall-hit cue) or more.
  const t = buildTrack(RUST_BOWL);
  const env = raceEnv(t);
  const BOUND = 4;
  const rows: string[] = [];
  let ok = true;
  for (const [look0, lookK] of [[120, 0.3], [90, 0.25]]) {
    for (const [name, stats] of POINT_CARS.slice(0, 3)) {
      const p0 = pointAt(t, 0);
      const c: CarState = { x: p0.x, y: p0.y, h: p0.h, vx: 0, vy: 0, seg: p0.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
      const hist: CarState[] = [];
      let memo: PointMemo = POINT_IDLE;
      let dx = 0, dy = 0, prog = 0, lastS = queryTrackNear(t, c.x, c.y, c.seg).s, hits = 0, maxInto = 0, revs = 0, tick = 0;
      for (; tick < 60 * 90 && prog < t.length; tick++) {
        hist.push(cloneCar(c));
        if (tick % 6 === 0) {
          const seen = hist[Math.max(0, hist.length - 1 - 9)];
          const q = queryTrackNear(t, seen.x, seen.y, seen.seg);
          const aim = pointAt(t, q.s + look0 + lookK * speedOf(seen));
          [dx, dy] = thumb(Math.atan2(aim.y - seen.y, aim.x - seen.x) / TDEG);
        }
        const vf = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
        const [throttle, steer, next] = pointControls(dx, dy, { h: c.h, vf, live: c.wreck === 0 && c.air === 0 && c.fall === 0 }, memo, PT);
        if (next.rev && !memo.rev) revs++;
        memo = next;
        const before = { vx: c.vx, vy: c.vy };
        stepRaceCar(c, { throttle: r100(throttle), steer: r100(steer) }, stats, env);
        const into = c.wreck === 0 && c.air === 0 && c.fall === 0 ? wallHitSpeed(before, c, t) : 0;
        if (into >= WALL_HIT_MIN) hits++;
        maxInto = Math.max(maxInto, into);
        const s = queryTrackNear(t, c.x, c.y, c.seg).s;
        let ds = s - lastS;
        if (ds > t.length / 2) ds -= t.length;
        if (ds < -t.length / 2) ds += t.length;
        prog += ds;
        lastS = s;
      }
      const done = prog >= t.length;
      ok &&= done && hits <= BOUND && tick <= 60 * 45;
      rows.push(`${name} look ${look0}+${lookK}v: ${done ? `${(tick / 60).toFixed(1)} s` : `NOT round (${Math.round(prog)}/${Math.round(t.length)})`}, ${hits} hits (max ${maxInto.toFixed(0)} u/s), ${revs} reverses`);
    }
  }
  check(
    `touch point lap: a look-ahead thumb (10 Hz, 150 ms lag; two look-aheads) drives a lap of Rust Bowl in point mode for every car type within 45 s, at most ${BOUND} wall hits (>= ${WALL_HIT_MIN} u/s) a lap`,
    ok,
    rows.join(" | "),
  );
}

function touchPointWall(): void {
  // Nose against a straight wall, exactly square to it, the thumb along the track (90° off: under
  // brakeAngle, so gas): the stuck rule backs the car out (latch 2) and it drives on along the track.
  // A test track with straight walls (collinear control points: a straight centre line, no slide off a curve).
  const def: TrackDef = { id: "point-wall", name: "Point Wall", control: [[0, 0], [800, 0], [1600, 0], [2400, 0], [3200, 0], [3200, 1600], [0, 1600]], halfWidth: 64, verge: 44 };
  const t = buildTrack(def);
  const env = raceEnv(t);
  const lim = def.halfWidth + def.verge;
  const rows: string[] = [];
  let ok = true, worst = 0;
  for (const [name, stats] of POINT_CARS.slice(0, 3)) {
    for (const side of [1, -1]) {
      for (const v0 of [0, 200]) {
        const y = side * (lim - 16); // the nose (15 ahead of the centre) at the wall
        const h = side * Math.PI / 2; // square to the wall (+y is right of travel)
        const q0 = queryTrack(t, 1500, y);
        const c: CarState = { x: 1500, y, h, vx: Math.cos(h) * v0, vy: Math.sin(h) * v0, seg: q0.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
        const [dx, dy] = thumb(0); // along the track (+x)
        let memo: PointMemo = POINT_IDLE;
        let escaped = -1, backed = false;
        for (let tick = 0; tick < 300; tick++) {
          const vf = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
          const [throttle, steer, next] = pointControls(dx, dy, { h: c.h, vf, live: true }, memo, PT);
          backed ||= next.rev === 2;
          memo = next;
          stepRaceCar(c, { throttle: r100(throttle), steer: r100(steer) }, stats, env);
          if (escaped < 0 && Math.abs(touchWrap(c.h)) < 15 * TDEG && c.x - 1500 > 150) escaped = tick;
        }
        const clear = lim - Math.abs(c.y);
        // Parked (the stuck case) it backs out and ends clear of the wall; hitting it at speed the
        // bounce may roll it free without the stuck rule (the flipped steer swings the nose round).
        ok &&= escaped >= 0 && escaped <= 200 && Math.abs(touchWrap(c.h)) < 5 * TDEG && (v0 > 0 || (backed && clear >= 20));
        worst = Math.max(worst, escaped < 0 ? 999 : escaped);
        rows.push(`${name} ${side > 0 ? "right" : "left"} wall from ${v0}: ${escaped}t${backed ? " (backed out)" : ""}, ${clear.toFixed(0)} u clear at 5 s`);
      }
    }
  }
  check(
    "touch point wall: nose square against a straight wall (parked, and hitting it at 200 u/s), thumb along the track: every car type gets out and on (heading within 15° of the track, 150 u on) within 200 ticks (worst " + worst + ") and at 5 s heads along the track; parked, it backs out (the stuck rule) and is at least 20 u off the wall",
    ok,
    rows.join(" | "),
  );
}

// ---- surfaces and tyre mounds (M4-SURF part 1, PLAN-M4.md 2.2-2.4, ClickUp 123jpnbffyz, 2026-11-21) ----
// Water, dirt patches, conveyor belts and tyre mounds act: shared/physics.ts stepCar (per-segment
// buckets from buildTrack), rivets die on mounds, respawns and recoveries take the nearest clear
// lane, validateRunUps drives through any pool in a run-up, short and wall-to-wall-in-a-bend belts
// are rejected, and the bots' lane-cost search (shared/botdrive.ts laneFor) replaces holeLane.
// Proven on the Surf Yard test track (shared/testtracks.ts), picked with the dev flag SCRAP_DEV_TRACK.

// This section's imports (hoisted like the ones at the top; namespaces, so no name clashes).
import { execFileSync as surfExec } from "node:child_process";
import * as surfPuddle from "../client/gfx/puddle-shape";
import * as surfPhys from "../shared/physics";
import * as surfTrack from "../shared/track";
import * as surfW from "../shared/weapons";
import * as surfBot from "../shared/botdrive";
import * as surfRoom from "../server/room";
import * as surfTune from "../tools/debug/surf-tune";
import * as surfServerBots from "../server/bots";
import { readFileSync as surfRead } from "node:fs";
import { SURF_YARD } from "../shared/testtracks";

const surfClock = { t0: 0 };

/**
 * The Hard bots' control-stream hashes on the shipped tracks (tools/debug/surf-tune.ts --golden =
 * hard-tune.ts goldenServer with 3 Hard bots, two 3-lap races, and goldenClient on Overpass Knot)
 * printed on the branch's base d6f8e5e BEFORE M4-SURF touched shared/botdrive.ts. With the Easy and
 * Normal ones (HARD_GOLDEN above) and tools/debug/schema-hash.ts --check: the shipped tracks drive
 * exactly as before.
 */
const SURF_HARD_GOLDEN: Record<string, string> = {
  "rust-bowl hard": "e0f1ea47119cadc91a558b1173d68c83064475606605c7e2934f3baf7ba876e4",
  "crusher-run hard": "1b825b94bd9abd7cfc07cef84c223fc126208cfbc82996dc590d4cc44ef8304b",
  "overpass-knot hard": "01ff9a07ed19d599cece47bb540d746aff6b83cbdbf02db9bd3bc0ed06be29f0",
  "client overpass-knot hard": "32dac062df09e77728e9545c1339b0b1f26349c974d371c7c27d1c864e3ca9ec",
};

/** Run fn with the dev flag SCRAP_DEV_TRACK set to id (undefined = unset), then put it back. */
function withDevTrack<T>(id: string | undefined, fn: () => T): T {
  const old = process.env.SCRAP_DEV_TRACK;
  if (id === undefined) delete process.env.SCRAP_DEV_TRACK;
  else process.env.SCRAP_DEV_TRACK = id;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.SCRAP_DEV_TRACK;
    else process.env.SCRAP_DEV_TRACK = old;
  }
}

/** A car at s, lat on track t, heading along the track (+ dh), at speed v along its heading. */
function surfCar(t: Track, s: number, lat: number, v: number, dh = 0): CarState {
  const p = pointAt(t, s);
  const h = p.h + dh;
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h, vx: Math.cos(h) * v, vy: Math.sin(h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
}

const surfYard = () => testTrack(SURF_YARD.id)!;
/** The Surf Yard with its surfaces and mounds taken off (the same loop, ramp, gap and hole). */
const surfDry = () => surfTune.yardWith(SURF_YARD.features!.filter((f) => f.k !== "water" && f.k !== "dirt" && f.k !== "belt" && f.k !== "tyres"));

function surfTraction(): void {
  surfClock.t0 = performance.now();
  // Moved from client/gfx/puddle-shape.ts into shared/track.ts unchanged: the constant, the function,
  // and the re-export the debug tools import (one function object, not a copy).
  const old = (f: { s0: number; s1: number; lat0: number; lat1: number }) => {
    const long = f.s1 - f.s0 >= 24, wide = f.lat1 - f.lat0 >= 24;
    const s = (f.s0 + f.s1) / 2, lat = (f.lat0 + f.lat1) / 2;
    return { s0: long ? f.s0 + 12 : s, s1: long ? f.s1 - 12 : s, lat0: wide ? f.lat0 + 12 : lat, lat1: wide ? f.lat1 - 12 : lat };
  };
  const rects = [{ s0: 1450, s1: 1620, lat0: -64, lat1: 64 }, { s0: 0, s1: 23.9, lat0: -5, lat1: 30 }, { s0: 10, s1: 34, lat0: 0, lat1: 24 }, { s0: 5, s1: 9, lat0: -1, lat1: 1 }];
  check(
    "surf traction: PUDDLE_TRACTION_INSET (12) and tractionRect now live in shared/track.ts, unchanged (the M4-WORLD formula, its degenerate lines included); client/gfx/puddle-shape.ts re-exports the same function",
    surfTrack.PUDDLE_TRACTION_INSET === 12 && surfPuddle.PUDDLE_TRACTION_INSET === 12 && surfPuddle.tractionRect === surfTrack.tractionRect &&
      rects.every((r) => JSON.stringify(surfTrack.tractionRect(r)) === JSON.stringify(old(r))),
    rects.map((r) => JSON.stringify(surfTrack.tractionRect(r))).join(" "),
  );
  // What a car feels: a pool's and a patch's traction rectangle, a belt's declared one.
  const t = surfYard();
  const felt = t.surfaces.map((f) => `${f.kind}:${f.s0}..${f.s1}x${f.lat0}..${f.lat1}${f.vx ? ` vx ${f.vx}` : ""}`);
  const want = [
    ...t.water.map((w) => ({ kind: surfTrack.SURF_WATER, ...surfTrack.tractionRect(w), vx: 0 })),
    ...t.dirt.map((d) => ({ kind: surfTrack.SURF_DIRT, ...surfTrack.tractionRect(d), vx: 0 })),
    ...t.belts.map((b) => ({ kind: surfTrack.SURF_BELT, s0: b.s0, s1: b.s1, lat0: b.lat0, lat1: b.lat1, vx: b.vx })),
  ].sort((a, b) => a.s0 - b.s0 || a.lat0 - b.lat0);
  check(
    "surf traction: Track.surfaces holds every pool and dirt patch by its traction rectangle and every belt by its declared one, sorted by s",
    JSON.stringify(t.surfaces) === JSON.stringify(want) && t.surfaces.length === 9,
    felt.join(", "),
  );
}

function surfBuckets(): void {
  // surfaceAt (one segment's bucket) against a scan of every surface; the mound buckets hold every
  // mound a car capsule (any heading) or a rivet's swept tick near that segment can touch.
  let bad = 0, pts = 0, on = 0, first = "";
  let missed = 0, touches = 0, rivetMiss = 0;
  for (const t of [surfYard(), testTrack(PREVIEW_YARD.id)!]) {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 40_000; i++) {
      const s = rnd() * t.length, lat = (rnd() * 2 - 1) * (t.wall - 8);
      const p = pointAt(t, s);
      const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
      const q = queryTrackNear(t, x, y, p.seg);
      const got = surfTrack.surfaceAt(t, q.seg, q.s, q.lat);
      const brute = t.surfaces.find((f) => q.s > f.s0 && q.s < f.s1 && q.lat > f.lat0 && q.lat < f.lat1) ?? null;
      pts++;
      if (got) on++;
      if (got !== brute) {
        bad++;
        if (!first) first = `${t.def.id} s=${q.s.toFixed(2)} lat=${q.lat.toFixed(2)}`;
      }
      // A capsule at a random heading: every mound it overlaps is in its segment's bucket.
      const h = rnd() * 2 * Math.PI, ux = Math.cos(h), uy = Math.sin(h);
      for (const m of t.tyres) {
        const k = clamp((m.x - x) * ux + (m.y - y) * uy, -surfPhys.CAPSULE_HALF, surfPhys.CAPSULE_HALF);
        if (Math.hypot(x + ux * k - m.x, y + uy * k - m.y) >= m.r + surfPhys.CAPSULE_R + 9) continue; // + a tick at 537 u/s
        touches++;
        if (!t.tyresAt[q.seg].includes(m)) missed++;
      }
      // A rivet's tick (900 u/s plus a car's 537) ending here: every mound its sweep touches.
      const bx = x - ux * 24, by = y - uy * 24;
      for (const m of t.tyres) {
        const dx = x - bx, dy = y - by;
        const f = clamp(((m.x - bx) * dx + (m.y - by) * dy) / (dx * dx + dy * dy), 0, 1);
        if (Math.hypot(bx + dx * f - m.x, by + dy * f - m.y) <= m.r + surfW.RIVET_RADIUS && !t.tyresAt[q.seg].includes(m)) rivetMiss++;
      }
    }
  }
  check(
    "surf buckets: surfaceAt (the car's segment's bucket, strictly inside) equals a scan of every surface at 80k points of the Surf Yard and the Preview Yard",
    bad === 0 && on > 1000,
    `${pts} points, ${on} on a surface${first ? `; first mismatch ${first}` : ""}`,
  );
  check(
    "surf buckets: every tyre mound a car capsule (any heading, plus a tick) or a rivet's swept tick can touch is in that segment's bucket",
    missed === 0 && rivetMiss === 0 && touches > 100,
    `${touches} capsule touches checked; missing ${missed}, rivet sweeps missing ${rivetMiss}`,
  );
  // The shipped tracks: no surface, no mound, every bucket empty (one shared frozen list).
  const shipped = trackList().filter((e) => CAR_TRACKS.includes(e.id)).map((e) => trackById(e.id));
  const empty = shipped.every((t) => t.surfaces.length === 0 && t.surfAt.every((b) => b.length === 0 && b === t.surfAt[0]) && t.tyresAt.every((b) => b.length === 0 && b === t.tyresAt[0]) && Object.isFrozen(t.surfAt[0]));
  const y = surfYard();
  const sizes = `Surf Yard: ${y.surfAt.filter((b) => b.length).length} of ${y.pts.length} segments with a surface (at most ${Math.max(...y.surfAt.map((b) => b.length))}), ${y.tyresAt.filter((b) => b.length).length} with a mound (at most ${Math.max(...y.tyresAt.map((b) => b.length))})`;
  check("surf buckets: on the shipped tracks every bucket is the one shared empty list (a lookup costs one array read)", empty && shipped.length === 3, sizes);
}

function surfWater(): void {
  // One water step against the model: every force along the car x WATER_FORCE, grip x dirtGrip / 3, turn x 0.5.
  const t = surfYard();
  const rows: string[] = [];
  let unit = true;
  for (const type of CAR_TYPES) {
    const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
    for (const [thr, steer] of [[1, 0.6], [-1, -0.3], [0, 1]] as const) {
      const c = surfCar(t, 1535, 5, 300, 0.2); // in the straight pool (felt 1462..1608), sliding 0.2 rad
      const p = pointAt(t, 1535);
      const cos = Math.cos(c.h), sin = Math.sin(c.h);
      let vf = c.vx * cos + c.vy * sin, vl = -c.vx * sin + c.vy * cos;
      const drag = (st.accel / st.topSpeed) * surfPhys.WATER_FORCE;
      if (thr > 0) vf += st.accel * surfPhys.WATER_FORCE * thr * DT;
      else if (thr < 0) vf -= 900 * surfPhys.WATER_FORCE * -thr * DT;
      else vf -= 60 * surfPhys.WATER_FORCE * DT;
      vf -= vf * drag * DT;
      vl *= Math.exp(-st.grip * st.dirtGrip * surfPhys.WATER_GRIP_OF_DIRT * DT);
      const h = c.h + steer * st.turn * surfPhys.WATER_TURN * clamp(vf / 140, -1, 1) * DT;
      stepCar(c, { throttle: thr, steer }, st, t);
      const ok = Math.abs(c.vx - (vf * cos - vl * sin)) < 1e-9 && Math.abs(c.vy - (vf * sin + vl * cos)) < 1e-9 && Math.abs(angleDiff(c.h, h)) < 1e-12;
      unit &&= ok && Math.abs(p.h) < 1e-9;
    }
    rows.push(`${type} grip x${(st.dirtGrip * surfPhys.WATER_GRIP_OF_DIRT).toFixed(3)}`);
  }
  check(
    `surf water: one step on water is the model exactly (throttle, brake, roll and drag x ${surfPhys.WATER_FORCE}, sideways grip x dirtGrip x ${surfPhys.WATER_GRIP_OF_DIRT.toFixed(3)}, steering x ${surfPhys.WATER_TURN}) for every type`,
    unit,
    rows.join(", "),
  );
  // Advisor change 4, measured: a pool on a straight costs little (the top speed is unchanged); a
  // pool in a bend throws you wide (on the line a dry car holds at the same speed).
  const dry = surfDry();
  const out: string[] = [];
  let straight = true, bend = true;
  for (const type of CAR_TYPES) {
    const lost = [430, 300].map((v) => {
      const a = surfTune.passes(t, surfTune.laneRun(t, type, 1300, v, 0, 120).states, 1700).tick, b = surfTune.passes(dry, surfTune.laneRun(dry, type, 1300, v, 0, 120).states, 1700).tick;
      return a - b;
    });
    const wide = (tt: Track) => Math.min(...surfTune.laneRun(tt, type, 2780, 330, -32, 110).states.map((c) => surfTune.sOf(tt, c).lat));
    const w = wide(t), d = wide(dry);
    straight &&= lost[0] <= 1 && lost[1] <= 3;
    bend &&= w < d - 10;
    out.push(`${type}: straight pool 1450..1620 costs ${lost[0]} ticks from 430 u/s, ${lost[1]} from 300; the bend pool at 330 u/s on lane -32 takes it to lat ${w.toFixed(1)} (dry ${d.toFixed(1)})`);
  }
  console.log(`  ${out.join("\n  ")}`);
  check("surf water: a pool on a straight costs little (<= 1 tick from top speed, <= 3 from 300 u/s, every type)", straight, out.map((x) => x.split(";")[0]).join("; "));
  check("surf water: a pool in a bend throws you wide (at least 10 units wider than the same line dry, every type)", bend, out.map((x) => x.split("; ")[1]).join("; "));
  // The type's grip on water follows its dirt grip: the Truck holds best, the Racer least.
  const g = CAR_TYPES.map((x) => CARS[x].base.grip * CARS[x].base.dirtGrip * surfPhys.WATER_GRIP_OF_DIRT);
  check("surf water: by car type, sideways grip on water Truck > Sport > Racer", g[2] > g[0] && g[0] > g[1], g.map((x) => x.toFixed(2)).join(" / "));
}

function surfDirt(): void {
  // A dirt patch on the asphalt is the verge's dirt by car type: the same step as a car on the verge.
  const t = surfYard(), dry = surfDry();
  let same = true;
  const rows: string[] = [];
  for (const type of CAR_TYPES) {
    const st = statsFor(type, { engine: 2, tyres: 1, welder: 0 });
    const a = surfCar(t, 1320, 40, 380, 0.15); // in the patch (felt 1252..1388 x 28..52), on asphalt
    const b = surfCar(dry, 1320, 85, 380, 0.15); // on the verge of the same straight, no patch
    const a0 = { vx: a.vx, vy: a.vy, h: a.h };
    stepCar(a, { throttle: 1, steer: 0.4 }, st, t);
    stepCar(b, { throttle: 1, steer: 0.4 }, st, dry);
    same &&= Math.abs(a.vx - b.vx) < 1e-9 && Math.abs(a.vy - b.vy) < 1e-9 && Math.abs(a.h - b.h) < 1e-12 && (a.vx !== a0.vx || a.h !== a0.h);
    // Off the patch (lat 20, beside it): plain asphalt.
    const c = surfCar(t, 1320, 20, 380, 0.15), d = surfCar(dry, 1320, 20, 380, 0.15);
    stepCar(c, { throttle: 1, steer: 0.4 }, st, t);
    stepCar(d, { throttle: 1, steer: 0.4 }, st, dry);
    same &&= c.vx === d.vx && c.vy === d.vy && c.h === d.h;
    rows.push(`${type}: on the patch ${speedOf(a).toFixed(2)} u/s after a step from 380 (asphalt ${speedOf(c).toFixed(2)})`);
  }
  check("surf dirt: a dirt patch steps a car exactly as the dirt verge (the type's dirtDrag and dirtGrip); beside the patch it is plain asphalt", same, rows.join("; "));
  const out: string[] = [];
  for (const type of CAR_TYPES) {
    const a = surfTune.passes(t, surfTune.laneRun(t, type, 1100, 380, 40, 150).states, 1420), b = surfTune.passes(dry, surfTune.laneRun(dry, type, 1100, 380, 40, 150).states, 1420);
    out.push(`${type} +${a.tick - b.tick} ticks, out at ${a.v.toFixed(0)} u/s (dry ${b.v.toFixed(0)})`);
  }
  console.log(`  dirt patch 1240..1400 on lane 40 from 380 u/s: ${out.join(", ")}`);
}

function surfBelt(): void {
  // A belt moves a grounded car by vx * DT toward the right of travel each tick; velocity unchanged.
  const t = surfYard(), dry = surfDry();
  const belt = t.belts[0];
  const a = surfCar(t, 2400, 10, 300, 0.05), b = surfCar(dry, 2400, 10, 300, 0.05);
  stepCar(a, { throttle: 1, steer: 0.2 }, BASE_STATS, t);
  stepCar(b, { throttle: 1, steer: 0.2 }, BASE_STATS, dry);
  const d = surfTrack.segDir(t, queryTrackNear(t, surfCar(t, 2400, 10, 0).x, surfCar(t, 2400, 10, 0).y, pointAt(t, 2400).seg).seg);
  const nx = -d.y, ny = d.x;
  const moved = (a.x - b.x) * nx + (a.y - b.y) * ny, along = (a.x - b.x) * ny - (a.y - b.y) * nx;
  check(
    `surf belt: a grounded car on a belt is moved its drift (vx ${belt.vx} u/s = ${(belt.vx * DT).toFixed(3)} a tick) toward the right of travel, velocity and heading as without it`,
    Math.abs(moved - belt.vx * DT) < 1e-9 && Math.abs(along) < 1e-9 && a.vx === b.vx && a.vy === b.vy && a.h === b.h,
    `moved ${moved.toFixed(6)} across, ${along.toExponential(1)} along`,
  );
  // Airborne over the belt: no drift (a flight is committed).
  const fa = { ...surfCar(t, 2400, 10, 300), air: 20 }, fb = { ...surfCar(dry, 2400, 10, 300), air: 20 };
  for (let i = 0; i < 10; i++) {
    stepRaceCar(fa, { throttle: 1, steer: 1 }, BASE_STATS, raceEnv(t));
    stepRaceCar(fb, { throttle: 1, steer: 1 }, BASE_STATS, raceEnv(dry));
  }
  check("surf belt: an airborne car over a belt is not moved by it", fa.x === fb.x && fa.y === fb.y && fa.air === 10, `${fa.x.toFixed(3)},${fa.y.toFixed(3)}`);
  const n = surfTune.waterNumbers().find((l) => l.startsWith("belt"));
  console.log(`  ${n}`);
}

function surfMounds(): void {
  const t = surfYard();
  const m = t.tyres[0]; // s 700, lat -30, r 24
  const reach = m.r + surfPhys.CAPSULE_R;
  // collideTyres on a car overlapping the mound, cases by the speed into it.
  const gap = (c: CarState) => {
    const ux = Math.cos(c.h), uy = Math.sin(c.h);
    const k = clamp((m.x - c.x) * ux + (m.y - c.y) * uy, -surfPhys.CAPSULE_HALF, surfPhys.CAPSULE_HALF);
    return Math.hypot(c.x + ux * k - m.x, c.y + uy * k - m.y) - reach;
  };
  const p = pointAt(t, m.s);
  const cases: { name: string; vn: number; vt: number }[] = [
    { name: "fast head-on", vn: -300, vt: 40 },
    { name: "slow", vn: -50, vt: 120 },
    { name: "leaving slowly", vn: 30, vt: 200 },
    { name: "leaving fast", vn: 150, vt: 50 },
  ];
  const rows: string[] = [];
  let ok = true;
  for (const cs of cases) {
    // The car sits beside the mound (on its right of travel), overlapping by 5, heading along the road.
    const nx = -Math.sin(p.h), ny = Math.cos(p.h); // right of travel: from the mound towards the car
    const c: CarState = {
      x: m.x + nx * (reach - 5), y: m.y + ny * (reach - 5), h: p.h,
      vx: nx * cs.vn + Math.cos(p.h) * cs.vt, vy: ny * cs.vn + Math.sin(p.h) * cs.vt, seg: m.seg, wreck: 0, air: 0, fall: 0, boost: 0,
    };
    surfPhys.collideTyres(c, t.tyresAt[m.seg]);
    const vn = c.vx * nx + c.vy * ny, vt = c.vx * Math.cos(p.h) + c.vy * Math.sin(p.h);
    const wantN = cs.vn < surfPhys.TYRES_MIN_OUT ? Math.max(-surfPhys.TYRES_RESTITUTION * cs.vn, surfPhys.TYRES_MIN_OUT) : cs.vn;
    const wantT = cs.vn < surfPhys.TYRES_MIN_OUT ? cs.vt * surfPhys.TYRES_TANGENT : cs.vt;
    const good = Math.abs(gap(c)) < 1e-9 && Math.abs(vn - wantN) < 1e-9 && Math.abs(vt - wantT) < 1e-9;
    ok &&= good;
    rows.push(`${cs.name} (${cs.vn}, along ${cs.vt}) -> out ${vn.toFixed(1)}, along ${vt.toFixed(1)}`);
  }
  check(
    `surf mounds: a car capsule is pushed fully out of a tyre mound (touching after); into it or out slower than ${surfPhys.TYRES_MIN_OUT}: out at max(${surfPhys.TYRES_RESTITUTION} x in, ${surfPhys.TYRES_MIN_OUT}) u/s, along it x ${surfPhys.TYRES_TANGENT}; leaving fast: only pushed`,
    ok,
    rows.join("; "),
  );
  // Through stepRaceCar: a driving car never ends inside a mound; an airborne one passes over it.
  let inside = 0, contacts = 0;
  for (const lat of [-50, -38, -30, -22, -10]) {
    for (const v of [120, 300, 430]) {
      const c = surfCar(t, m.s - 120, lat, v);
      for (let i = 0; i < 90; i++) {
        stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(t));
        if (surfTune.touchesMound(t, c)) contacts++;
        if (gap(c) < -1e-6) inside++;
      }
    }
  }
  const fa = { ...surfCar(t, m.s - 40, m.lat, 400), air: 30 }, fb = { ...surfCar(surfDry(), m.s - 40, m.lat, 400), air: 30 };
  for (let i = 0; i < 6; i++) {
    stepRaceCar(fa, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(t));
    stepRaceCar(fb, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(surfDry()));
  }
  check(
    "surf mounds: driven straight at a mound from 15 lanes and speeds, a car is never left overlapping it (contacts happen); an airborne car flies over it untouched",
    inside === 0 && contacts > 10 && fa.x === fb.x && fa.y === fb.y && gap(fa) < 0,
    `${contacts} contact ticks, ${inside} overlapping; the flight passes over the mound (gap ${gap(fa).toFixed(1)})`,
  );
  const lines = surfTune.waterNumbers().filter((l) => l.startsWith("mound"));
  console.log(`  ${lines.join("\n  ")}`);
}

function surfRivets(): void {
  // Rivets die on a tyre mound (a swept test), and pass one they miss; on a mound-less track moveShot is as before.
  const t = surfYard();
  const m = t.tyres[1]; // s 880, lat 32, r 26
  const shoot = (lat: number) => {
    const c = surfCar(t, m.s - 200, lat, 0);
    const s = surfW.spawnShot(c, 1, "a");
    let ticks = 0;
    while (ticks < 40 && surfW.moveShot(s, t, 0)) ticks++; // rt: no barrels or presses here
    return { ticks, s: queryTrackNear(t, s.x, s.y, s.seg).s };
  };
  const hit = shoot(m.lat), edge = shoot(m.lat + m.r + surfW.RIVET_RADIUS - 0.5), past = shoot(m.lat - m.r - surfW.RIVET_RADIUS - 1);
  check(
    "surf rivets: a rivet dies on a tyre mound (straight at it, and grazing its edge), and flies on past one it misses by a unit",
    hit.s < m.s && hit.s > m.s - m.r - 20 && edge.s < m.s + 5 && past.s > m.s + 100,
    `at the centre: died at s=${hit.s.toFixed(1)} after ${hit.ticks} ticks; grazing: s=${edge.s.toFixed(1)}; a unit past the edge: s=${past.s.toFixed(1)} after ${past.ticks} ticks`,
  );
}

function surfRespawn(): void {
  const t = surfYard();
  // A car wrecked on a mound respawns on the nearest clear lane at its s (not inside it); one wrecked
  // clear of every mound respawns on the centerline as before.
  const rows: string[] = [];
  let ok = true;
  for (const m of t.tyres) {
    const c = surfCar(t, m.s, m.lat, 0);
    c.wreck = 1;
    stepRaceCar(c, surfPhys.NO_INPUT, BASE_STATS, raceEnv(t));
    const at = surfTune.sOf(t, c);
    const good = c.wreck === 0 && !surfTune.touchesMound(t, c) && Math.abs(at.lat) <= t.def.halfWidth - CAR_WIDTH / 2 && Math.abs(at.s - m.s) < 1;
    ok &&= good;
    rows.push(`mound s ${m.s} lat ${m.lat}: lane ${at.lat.toFixed(0)}`);
  }
  const free = surfCar(t, 2000, 30, 0);
  free.wreck = 1;
  stepRaceCar(free, surfPhys.NO_INPUT, BASE_STATS, raceEnv(t));
  const fp = pointAt(t, surfTune.sOf(t, free).s);
  check(
    "surf respawn: a car wrecked on each tyre mound respawns on the nearest clear lane at its s (asphalt, touching no mound); clear of mounds it respawns on the centerline as before",
    ok && Math.hypot(free.x - fp.x, free.y - fp.y) < 1e-9 && surfTrack.clearLaneAt(t, 2000) === 0,
    rows.join(", "),
  );
  // A fall goes to the recovery point on its clear lane: the centerline (solids keep SOLID_CLEAR from it).
  const f = surfCar(t, 5000, 26, 0); // in the pit
  f.fall = 1;
  stepRaceCar(f, surfPhys.NO_INPUT, BASE_STATS, raceEnv(t));
  const rp = pointAt(t, 3300);
  check(
    "surf respawn: a recovery is on the recovery point's clear lane (the centerline there), and clearLaneAt is 0 at every recovery point of the test tracks",
    Math.hypot(f.x - rp.x, f.y - rp.y) < 1e-9 && TEST_TRACKS.every((d) => testTrack(d.id)!.recovery.every((r) => surfTrack.clearLaneAt(testTrack(d.id)!, r) === 0)),
    `recovered at ${f.x.toFixed(1)},${f.y.toFixed(1)}`,
  );
}

function surfValidate(): void {
  const rule = (name: string, bad: string, want: string[], good: string) =>
    check(`surf validate: ${name}`, want.every((w) => bad.includes(w)) && good === "", `broken: ${bad || "accepted"} || near miss: ${good || "accepted"}`);
  const loop = (features: Feature[], recovery = [0, 3200, 5500]) => buildTrack({ ...SCHEMA_LOOP, id: "surf-v", features, recovery });
  const errs = (features: Feature[], recovery?: number[]) => validateTrack(loop(features, recovery)).join(" | ");
  // Belts: at least 48 long; wall to wall only on a straight.
  rule(
    `a belt is at least ${surfTrack.BELT_LEN_MIN} long`,
    errs([{ k: "belt", s0: 1200, s1: 1247.9, lat0: -64, lat1: 64, vx: 50 }]),
    ["belt 1200.0..1247.9: 47.9 long, shorter than 48"],
    errs([{ k: "belt", s0: 1200, s1: 1248, lat0: -64, lat1: 64, vx: 50 }]),
  );
  rule(
    "a wall-to-wall belt in a bend is rejected (on a straight it passes, and a bend belt that leaves a wall free passes)",
    errs([{ k: "belt", s0: 2300, s1: 2520, lat0: -108, lat1: 108, vx: 50 }]),
    ["belt 2300.0..2520.0: runs wall to wall in a bend"],
    errs([{ k: "belt", s0: 1000, s1: 1300, lat0: -108, lat1: 108, vx: 50 }]) + errs([{ k: "belt", s0: 2300, s1: 2520, lat0: -108, lat1: 107, vx: 50 }]),
  );
  // Run-ups through water: a chasm on the bottom straight that a dry run-up from 5850 clears; a pool
  // on the left half of the run-up (the centre lane misses it) is driven through and leaves the car
  // short; the same pool past the landing is not in the run-up.
  const jump = (extra: Feature[]) => buildTrack({ ...PREVIEW_YARD, id: "surf-ru", features: [{ k: "ramp", s: 6400, len: 80 }, { k: "gap", s0: 6480, s1: 6750 }, ...extra], recovery: [0, 3200, 5850] });
  const pool = (s0: number, s1: number): Feature => ({ k: "water", s0, s1, lat0: -64, lat1: 0 });
  const dryRun = validateRunUps(jump([])).join(" | ");
  const wet = jump([pool(5950, 6350)]);
  const wetRun = CAR_TYPES.map((type) => `${type}: ${validateRunUps(wet, statsFor(type, { engine: 0, tyres: 0, welder: 0 })).join(" | ") || "passes"}`).join(" || ");
  const after = validateRunUps(jump([pool(6790, 6960)])).join(" | ");
  const sportWet = validateRunUps(wet);
  check(
    "surf validate: the run-up validator drives a lane through any pool in a run-up (a pool beside the centre lane that leaves a Sport short of the chasm is rejected, though the centre-lane run clears it; dry, or the pool past the landing, it passes)",
    dryRun === "" && after === "" && sportWet.length === 1 && sportWet[0].includes("driven through the water 5950.0..6350.0 at lat -32.0") && sportWet[0].includes("lands short in a gap") && validateTrack(wet).length === 0,
    `wet, per type: ${wetRun}`,
  );
  // The Surf Yard passes every check for every type at L0 and L3, and the overspeed sweep.
  const t = surfYard();
  const all = [...validateTrack(t), ...CAR_TYPES.flatMap((type) => [0, 3].flatMap((lv) => validateRunUps(t, statsFor(type, { engine: lv, tyres: lv, welder: lv })))), ...validateJumpSweep(t, 537)];
  check("surf validate: the Surf Yard validates (validateTrack, validateRunUps for every type at L0 and L3 incl. the pool in its jump's run-up, the 537 u/s jump sweep)", all.length === 0, all.join(" | "));
}

function surfLanes(): void {
  // laneFor: with neither a mound nor a surface ahead it is holeLane exactly (the three original shipped
  // tracks; M4-TRACKS: the long tracks have mounds and surfaces).
  let diff = 0, n = 0;
  for (const id of ["rust-bowl", "crusher-run", "overpass-knot"]) {
    const t = trackById(id);
    for (let s = 0; s < t.length; s += 13) {
      const p = pointAt(t, s);
      for (const [look, pref] of [[200, 0], [400, -24], [330, 30]]) {
        const a = surfBot.laneFor(t, s, p.seg, look, pref, pref, BASE_STATS), b = holeLane(t, s, look, pref);
        n++;
        if (a.lane !== b.lane || a.holes !== b.holes || a.dodge) diff++;
      }
    }
  }
  check("surf lanes: on the shipped tracks laneFor is holeLane exactly (no mound, no surface: no dodge)", diff === 0 && n > 2000, `${n} queries, ${diff} differ`);
  // Costs by car type: a road split into water (left) and dirt (right): the Sport and the Racer take
  // the water, the Truck the dirt; with the dirt gone, all three take the dry half.
  // (Overlapping rectangles out to the walls, so their traction areas leave no dry lane: laneFor does not validate.)
  const split = buildTrack({ ...SCHEMA_LOOP, id: "surf-split", features: [{ k: "water", s0: 1200, s1: 1500, lat0: -108, lat1: 12 }, { k: "dirt", s0: 1200, s1: 1500, lat0: -12, lat1: 108 }] });
  const wetOnly = buildTrack({ ...SCHEMA_LOOP, id: "surf-wet", features: [{ k: "water", s0: 1200, s1: 1500, lat0: -64, lat1: 0 }] });
  const pick = (t: Track, type: CarType, racing: number) => surfBot.laneFor(t, 1100, pointAt(t, 1100).seg, 300, racing, racing, statsFor(type, { engine: 0, tyres: 0, welder: 0 }));
  const lanes = CAR_TYPES.map((type) => pick(split, type, -24).lane);
  const dryLanes = CAR_TYPES.map((type) => pick(wetOnly, type, -24));
  const costs = CAR_TYPES.map((type) => `${type} water ${surfBot.laneCost(surfTrack.SURF_WATER, statsFor(type, { engine: 0, tyres: 0, welder: 0 })).toFixed(2)} dirt ${surfBot.laneCost(surfTrack.SURF_DIRT, statsFor(type, { engine: 0, tyres: 0, welder: 0 })).toFixed(2)}`);
  check(
    "surf lanes: water and dirt cost by car type: on a road all pool on the left and all dirt on the right the Sport and the Racer keep to the pool, the Truck crosses to the dirt; with a dry half every type leaves its line (-24) for it (past the pool's felt edge -12, by the margin)",
    lanes[0] < 0 && lanes[1] < 0 && lanes[2] > 0 && dryLanes.every((x) => x.dodge && x.lane >= -8),
    `split: ${lanes.join("/")}; pool + dry: ${dryLanes.map((x) => x.lane).join("/")}; ${costs.join("; ")}`,
  );
  // Mounds are blocked like holes: in the chicane the lane clears the next mound by a car's width.
  const t = surfYard();
  const rows: string[] = [];
  let clears = true;
  for (const m of t.tyres.slice(0, 3)) {
    const s = m.s - 150;
    const r = surfBot.laneFor(t, s, pointAt(t, s).seg, 300, 0, 0, BASE_STATS);
    clears &&= r.holes > 0 && Math.abs(r.lane - m.lat) > m.r + CAR_WIDTH / 2 + 8;
    rows.push(`150 before the mound at s ${m.s} (lat ${m.lat}, r ${m.r}): lane ${r.lane}`);
  }
  check("surf lanes: a tyre mound ahead is blocked as a hole is (the lane clears it by half a car + 8)", clears, rows.join("; "));
}

function surfBots(): void {
  // Easy, Normal and Hard: three server bots each (Sport, Racer, Truck by seat), 3 laps of the Surf
  // Yard: all finish, no fall, identically on a rerun.
  const rows: string[] = [];
  let ok = true, met = { water: 0, dirt: 0, belt: 0, mounds: 0 };
  for (const level of BOT_LEVELS) {
    const a = surfTune.surfRace(level), b = surfTune.surfRace(level);
    const good = a.phase === "results" && a.finish.length === 3 && a.falls.every((x) => x === 0) && a.digest === b.digest && JSON.stringify(a.finish) === JSON.stringify(b.finish);
    ok &&= good;
    for (const o of a.on) {
      met.water += o.water;
      met.dirt += o.dirt;
      met.belt += o.belt;
    }
    met.mounds += a.mounds.reduce((x, y) => x + y, 0);
    rows.push(`${level}: ${a.finish.join(", ")}; falls ${a.falls.join("/")}; wall-hit ticks ${a.walls.join("/")}; mound-contact ticks ${a.mounds.join("/")}; water/dirt/belt ticks ${a.on.map((o) => `${o.water}/${o.dirt}/${o.belt}`).join(" ")}; rerun ${a.digest === b.digest ? "identical" : "DIFFERS"}`);
  }
  console.log(`  ${rows.join("\n  ")}`);
  check("surf bots: Easy, Normal and Hard bots (Sport, Racer, Truck) all finish 3 laps of the Surf Yard (every surface and mound) with no fall, identically on a rerun", ok, rows.map((r) => r.split(";")[0]).join(" | "));
  // M4-SURF part 2 (the review's F1): the bots now keep clear of the mounds (splitMounds, below: at most
  // the branch's contact ticks; measured 0 or 1), so the meeting is the belts', the mounds' a bound.
  check("surf bots: the bots meet the features (belt ticks), touch the mounds no more than on the M4-SURF-1 branch (F1, 113 ticks in all) and mostly keep off water and dirt", met.belt > 300 && met.mounds <= 113, JSON.stringify(met));
}

function surfShipped(): void {
  // The shipped tracks drive exactly as before M4-SURF: schema-hash (built arrays, queries and
  // validators, server bots, a room race, wall contacts) and the Hard bots' streams.
  let out = "";
  let ok = true;
  try {
    out = surfExec(process.execPath, ["--import", "tsx", "tools/debug/schema-hash.ts", "--check"], { encoding: "utf8" });
  } catch (e) {
    ok = false;
    out = String((e as { stdout?: string }).stdout ?? e);
  }
  // The rule shared with M4-TRACKS (coordinator, 2026-11-22): every line of the three original tracks
  // present and SAME; every other line SAME or NEW (tracks added since, e.g. BR-SCHEMA's Branch Yard).
  const lines = out.split("\n").filter((l) => /^(SAME|DIFF|NEW |GONE) /.test(l));
  const originals = ["rust-bowl", "crusher-run", "overpass-knot"].flatMap((id) => ["built", "queries", "botsDirect", "room", "walls"].map((part) => `SAME  ${id} ${part}`));
  const others = lines.filter((l) => !/^\S+\s+(rust-bowl|crusher-run|overpass-knot) /.test(l));
  check(
    "surf shipped: tools/debug/schema-hash.ts --check: every part SAME on the three original tracks (built, queries, botsDirect, room, walls), against the golden recorded before M4-SURF changed physics; every other line SAME or NEW",
    ok && originals.every((o) => lines.includes(o)) && others.every((l) => l.startsWith("SAME") || l.startsWith("NEW ")),
    lines.filter((l) => !l.startsWith("SAME")).join("; ") || `${lines.length} parts SAME`,
  );
  const got = surfTune.hardHashes();
  const bad = Object.keys(SURF_HARD_GOLDEN).filter((k) => got[k] !== SURF_HARD_GOLDEN[k]);
  check(
    "surf shipped: Hard bots drive, shoot and shop byte-identically to before M4-SURF (server bots on every shipped track, two races; the client bot path); Easy and Normal: hard golden above",
    bad.length === 0,
    bad.map((k) => `${k}: ${got[k]?.slice(0, 12)} != ${SURF_HARD_GOLDEN[k].slice(0, 12)}`).join("; ") || `${Object.keys(got).length} hashes match`,
  );
}

function surfParity(): void {
  // stepRaceCar on a clone equals the server's pose exactly, tick by tick, for a lone server bot of
  // each level and car type over 2 laps of the Surf Yard (belts, pools, dirt, mounds, the jump).
  const rows: string[] = [];
  let all = true;
  withDevTrack(SURF_YARD.id, () => {
    for (const [level, car] of [["easy", "sport"], ["normal", "racer"], ["hard", "truck"]] as const) {
      const sim = new Sim(2);
      const host = sim.add("Host");
      if (sim.room.setTrack(host, SURF_YARD.id)) throw new Error("dev track refused");
      const b = sim.room.addBot(host, level, sim.now) as Player;
      if (sim.room.setCar(host, car, b.id)) throw new Error("car");
      b.wallet.ammo.rivets = 0; // no mines of its own to drive over on lap 2 (a spin-out is combat, not the step)
      b.wallet.ammo.mines = 0;
      sim.room.start(host, sim.now);
      while (sim.room.phase !== "racing") sim.tick();
      sim.room.retire(host);
      const t = sim.room.track;
      let ctl: surfBot.BotControls | null = null;
      surfServerBots.botTrace.fn = (p, c) => {
        if (p === b) ctl = c;
      };
      let ticks = 0, mismatch = 0, first = "", contacts = 0, wet = 0, dirt = 0, belt = 0;
      try {
        while (sim.room.phase === "racing" && ticks < 60 * 120) {
          const clone = cloneCar(b.car!);
          sim.tick();
          ticks++;
          if (!b.car || sim.room.phase !== "racing") break;
          const c = ctl as surfBot.BotControls | null;
          stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, raceEnv(t, sim.room.rt, 0));
          const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
          if (!keys.every((k) => Object.is(clone[k], b.car![k]))) {
            mismatch++;
            if (!first) first = `tick ${ticks}: ${keys.filter((k) => !Object.is(clone[k], b.car![k])).join(",")}`;
          }
          if (surfTune.touchesMound(t, b.car!)) contacts++;
          const q = queryTrackNear(t, clone.x, clone.y, clone.seg);
          const f = surfTrack.surfaceAt(t, q.seg, q.s, q.lat);
          if (f?.kind === surfTrack.SURF_WATER) wet++;
          else if (f?.kind === surfTrack.SURF_DIRT) dirt++;
          else if (f?.kind === surfTrack.SURF_BELT) belt++;
        }
      } finally {
        surfServerBots.botTrace.fn = null;
      }
      const good = mismatch === 0 && ticks > 60 * 30 && b.hp === CAR_HP && b.progress!.fin > 0;
      all &&= good;
      rows.push(`${level} ${car}: ${ticks} ticks, ${mismatch} mismatches${first ? ` (${first})` : ""}; belt ${belt}, water ${wet}, dirt ${dirt}, mound-contact ${contacts} ticks; HP ${b.hp}`);
    }
  });
  console.log(`  ${rows.join("\n  ")}`);
  check("surf parity: stepRaceCar on a clone equals the server's pose bit for bit every tick (a lone server bot per level and type, 2 laps of the Surf Yard); mounds do no damage", all, rows.join(" | "));
  // The client's prediction (reconcile and replay through stepRaceCar) over the wire, no lag: three
  // socket-bot cars (Sport, Racer, Truck) race 1 lap of the Surf Yard.
  const r = withDevTrack(SURF_YARD.id, () => carsClientLap(SURF_YARD.id));
  check(
    `surf parity: three client cars (Sport, Racer, Truck) racing the Surf Yard over the wire predict it exactly: no state mismatch, no error > ${LARGE_ERR}`,
    r.ticks.every((x) => x > 0) && r.stateErrs === 0 && r.large === 0 && r.samples > 500 && r.same,
    `laps ${r.ticks.map((x) => (x / 60).toFixed(1)).join("/")} s; ${r.samples} samples, ${r.stateErrs} state mismatches, ${r.large} > ${LARGE_ERR}, max ${r.maxErr.toFixed(4)}`,
  );
}

function surfCpu(): void {
  // 1 human (retired at GO) + 5 bots (Easy, Normal, Hard, Normal, Hard), 3 laps of the Surf Yard: every bot step and room tick timed.
  const r = withDevTrack(SURF_YARD.id, () => {
    const sim = new Sim(3);
    const host = sim.add("Host");
    sim.room.setTrack(host, SURF_YARD.id);
    for (const l of ["easy", "normal", "hard", "normal", "hard"] as BotLevel[]) sim.room.addBot(host, l, sim.now);
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const tickMs: number[] = [];
    const steps: number[] = [];
    botTiming.samples = steps;
    let ticks = 0;
    try {
      while (sim.room.phase === "racing" && ticks < 60 * 300) {
        sim.tickNo++;
        sim.now += 1000 / 60;
        const t0 = performance.now();
        sim.room.tick(sim.tickNo, sim.now);
        tickMs.push(performance.now() - t0);
        ticks++;
      }
    } finally {
      botTiming.samples = null;
    }
    return { tickMs, steps, phase: sim.room.phase as string };
  });
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const med = pct(r.steps, 0.5), tickMed = pct(r.tickMs, 0.5);
  console.log(`  CPU (Surf Yard): bot step median ${(med * 1000).toFixed(2)} us, p99 ${(pct(r.steps, 0.99) * 1000).toFixed(2)} us over ${r.steps.length} steps; room tick with 5 bots median ${(tickMed * 1000).toFixed(2)} us, p99 ${(pct(r.tickMs, 0.99) * 1000).toFixed(2)} us, max ${(Math.max(...r.tickMs) * 1000).toFixed(1)} us over ${r.tickMs.length} ticks`);
  check(
    "surf CPU: on the Surf Yard the median bot step stays <= 0.05 ms (the M4-BOTS gate fails above 0.2 ms); room tick with 5 bots printed",
    r.steps.length > 5 * 3000 && med <= 0.2 && r.phase === "results",
    `median bot step ${med.toFixed(5)} ms (${med <= 0.05 ? "within" : "OVER"} the 0.05 ms target); room tick median ${tickMed.toFixed(4)} ms`,
  );
  // The surface lookup in stepCar: a step on a track with surfaces costs about what one on a plain track does.
  const time = (t: Track, s: number, lat: number) => {
    const c = surfCar(t, s, lat, 300);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const d = { ...c };
      stepCar(d, { throttle: 1, steer: 0.1 }, BASE_STATS, t);
    }
    return ((performance.now() - t0) / 20_000) * 1000;
  };
  const plain = time(trackById("rust-bowl"), 3000, 0), surf = time(surfYard(), 1535, 0), mound = time(surfYard(), 690, 10);
  console.log(`  stepCar: ${plain.toFixed(3)} us on Rust Bowl, ${surf.toFixed(3)} us in a Surf Yard pool, ${mound.toFixed(3)} us beside a mound`);
  const added = (performance.now() - surfClock.t0) / 1000;
  console.log(`  M4-SURF sim-test sections' runtime (surfTraction .. surfCpu): ${added.toFixed(1)} s`);
}

function surfDevFlag(): void {
  // Off (unset, the default; also on Render): new rooms on Rust Bowl, the test tracks refused.
  const off = withDevTrack(undefined, () => {
    const rooms = new Rooms(1);
    const x = { conn: new FakeConn(), room: null, player: null } as Session;
    rooms.onMessage(x, { t: "create", name: "Ann" }, 1000);
    const room = x.room!;
    return { id: room.trackId, flag: surfRoom.devTrackId(), refuse: [room.setTrack(x.player!, SURF_YARD.id), room.setTrack(x.player!, PREVIEW_YARD.id)] };
  });
  const bogus = withDevTrack("rust-bowl", () => surfRoom.devTrackId()) ?? withDevTrack("nope", () => surfRoom.devTrackId()) ?? withDevTrack("", () => surfRoom.devTrackId());
  // On: a new room starts on the named test track; the host picks the other one and a shipped one; an unknown id is still refused.
  const on = withDevTrack(SURF_YARD.id, () => {
    const rooms = new Rooms(1);
    const x = { conn: new FakeConn(), room: null, player: null } as Session;
    rooms.onMessage(x, { t: "create", name: "Ann" }, 1000);
    const room = x.room!;
    const first = room.trackId;
    const yard = room.track === testTrack(SURF_YARD.id);
    rooms.onMessage(x, { t: "track", id: PREVIEW_YARD.id }, 1000);
    const second = room.trackId;
    const msgOk = room.track === testTrack(PREVIEW_YARD.id);
    const shipped = room.setTrack(x.player!, "crusher-run");
    const third = room.trackId;
    const unknown = room.setTrack(x.player!, "nope");
    return { first, yard, second, msgOk, shipped, third, unknown };
  });
  check(
    "surf dev flag: SCRAP_DEV_TRACK unset (the default, and on Render): new rooms start on Rust Bowl and the test tracks are refused as unknown; a value that is not a test track's id is off too",
    off.id === DEFAULT_TRACK_ID && off.flag === null && off.refuse.every((e) => e === "Unknown track") && bogus === null,
    JSON.stringify(off),
  );
  check(
    "surf dev flag: SCRAP_DEV_TRACK=surf-yard: a new room starts on the Surf Yard, the host picks the Preview Yard by a {t:\"track\"} message and a shipped track as ever; an unknown id is still refused",
    on.first === SURF_YARD.id && on.yard && on.second === PREVIEW_YARD.id && on.msgOk && on.shipped === null && on.third === "crusher-run" && on.unknown === "Unknown track",
    JSON.stringify(on),
  );
  // The client builds a test track's id it is sent (Game.useTrack), and the render.yaml sets no such variable.
  const yaml = surfRead("render.yaml", "utf8");
  check("surf dev flag: render.yaml does not set SCRAP_DEV_TRACK (off on Render)", !yaml.includes("SCRAP_DEV_TRACK"));
}

// ---- split lanes (M4-SURF part 2, PLAN-M4.md 2.6 B, advisor changes 2, 11, 13; ClickUp 123jpnbffz4, 2026-11-21) ----
// The road widens round an island into two lanes and narrows again past it. The walls are per
// sample (shared/track.ts halfOf / wallOf: halfAt's value at a query's s and side, through its
// segment's widens) in physics, isLost, the on-road test, landings, rivets, recovery, the bots and
// the client's wallHitSpeed; an island is solid for a car on the ground (shared/physics.ts
// collideIslands: its sides a wall, its noses a tyre mound's bounce); s, checkpoints, laps and
// positions are unchanged; validateRunUps drives a split once per lane; the bots take a lane per
// seat and car type (shared/botdrive.ts splitFor). Plus the M4-SURF-1 review's F1 and F2 (laneFor's
// side locks round mounds, and its look round the lap). Proven on the Split Yard test track
// (shared/testtracks.ts), picked with the dev flag SCRAP_DEV_TRACK=split-yard.

// This section's imports (hoisted like the ones at the top; namespaces, so no name clashes).
import * as splitPhys from "../shared/physics";
import * as splitTrack from "../shared/track";
import * as splitW from "../shared/weapons";
import * as splitBot from "../shared/botdrive";
import * as splitTune from "../tools/debug/split-tune";
import * as splitProg from "../server/race";
import { SPLIT_YARD } from "../shared/testtracks";
import { readFileSync as splitRead } from "node:fs";

const splitClock = { t0: 0 };
const splitYard = () => testTrack(SPLIT_YARD.id)!;
/** The Split Yard's loop with no features: the plain road the splits are compared with. */
const splitBare = () => buildTrack({ ...SPLIT_YARD, id: "split-bare", features: [] });

/** The point `lat` right of the centerline at s, and its query from that segment. */
function splitQuery(t: Track, s: number, lat: number): ReturnType<typeof queryTrackNear> {
  const p = pointAt(t, s);
  return queryTrackNear(t, p.x - Math.sin(p.h) * lat, p.y + Math.cos(p.h) * lat, p.seg);
}

/** A car's (or a rivet's) track coordinates. */
function splitSL(t: Track, c: { x: number; y: number; seg: number }): { s: number; lat: number } {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  return { s: q.s, lat: q.lat };
}

function splitWalls(): void {
  splitClock.t0 = performance.now();
  // Shipped tracks (no widen): the per-sample walls are the constants, exactly (the three original ones;
  // M4-TRACKS: the long tracks have widens).
  let n = 0, diff = 0;
  for (const id of ["rust-bowl", "crusher-run", "overpass-knot"]) {
    const t = trackById(id);
    for (let i = 0; i < t.pts.length; i += 3) {
      for (let lat = -230; lat <= 230; lat += 23) {
        const q = splitQuery(t, t.cum[i] + 5.3, lat);
        n++;
        if (!Object.is(splitTrack.halfOf(t, q), t.def.halfWidth) || !Object.is(splitTrack.wallOf(t, q), t.wall) ||
            !Object.is(splitPhys.wallLimit(t, q), splitPhys.wallLimit(t)) || splitTrack.isLost(t, q) !== q.dist > t.wall * 2) diff++;
      }
    }
  }
  check(
    "split walls: on the shipped tracks (no widen) the per-sample walls are today's constants exactly: halfOf = def.halfWidth, wallOf = track.wall, wallLimit(track, q) = wallLimit(track), isLost = dist > 2 * wall",
    diff === 0 && n > 3000,
    `${n} queries, ${diff} differ`,
  );
  // The test tracks: halfOf / wallOf are the walls as the bake draws them (client/gfx/world.ts): each
  // centreline segment's widening at its two ends (widenAt), linear in the query's place along it;
  // buildTrack's halfL / halfR / wallL / wallR are the per-sample values. And the bake's own rule re-done
  // round every widen (tools/debug/split-tune.ts drawnGaps): the physics wall and kerb are where the
  // drawing has them (the exact taper, widenAt at the query's s, was off by up to ~4.8 units).
  let m = 0, off = 0, arr = 0;
  for (const d of TEST_TRACKS) {
    const t = testTrack(d.id)!;
    for (const w of t.widens) {
      for (let s = w.s0 - 40; s <= w.s1 + 40; s += 3.1) {
        for (const lat of [-170, -90, -30, 30, 90, 170]) {
          const q = splitQuery(t, s, lat);
          const k = (q.s - t.cum[q.seg]) / (t.cum[q.seg + 1] - t.cum[q.seg]);
          const w0 = splitTrack.widenAt(t, t.cum[q.seg], q.side), w1 = splitTrack.widenAt(t, t.cum[q.seg + 1], q.side);
          const drawn = t.def.halfWidth + w0 + (w1 - w0) * k;
          m++;
          if (Math.abs(splitTrack.halfOf(t, q) - drawn) > 1e-9 || Math.abs(splitTrack.wallOf(t, q) - (drawn + t.def.verge)) > 1e-9) off++;
        }
      }
    }
    t.pts.forEach((_, i) => {
      if (!Object.is(t.halfL[i], splitTrack.halfAt(t, t.cum[i], -1)) || !Object.is(t.halfR[i], splitTrack.halfAt(t, t.cum[i], 1)) ||
          !Object.is(t.wallL[i], t.halfL[i] + t.def.verge) || !Object.is(t.wallR[i], t.halfR[i] + t.def.verge)) arr++;
    });
  }
  const gaps = splitTune.drawnGaps();
  check(
    "split walls: on the test tracks halfOf / wallOf are the walls the bake draws (each segment's widening at its ends, linear along it; halfL / halfR / wallL / wallR the per-sample values), and round every widen the bake's own rule puts the wall and the kerb where the physics does (<= 0.01; the exact taper was further off)",
    off === 0 && arr === 0 && m > 2000 && gaps.length === 5 && gaps.every((g) => g.now <= 0.01 && g.points > 4000) && Math.max(...gaps.map((g) => g.exact)) > 2,
    `${m} queries round the widens, ${off} differ; ${arr} samples differ; drawn vs physics per widen: ${gaps.map((g) => `${g.track} ${g.widen.split(" ")[0]} ${g.now.toFixed(4)} (exact taper ${g.exact.toFixed(2)})`).join(", ")}`,
  );
  // Driven: a car steered into the left wall beside island A (widened 48) stops at the widened wall
  // less half a car, and the client's wall cue hears it; on the bare loop it stops at track.wall - 8.
  const yard = splitYard(), bare = splitBare();
  const into = (t: Track) => {
    const c = surfCar(t, 1000, -60, 300, -0.5);
    const env = raceEnv(t);
    let widest = 0, cue = 0;
    for (let k = 0; k < 60; k++) {
      const before = { vx: c.vx, vy: c.vy };
      env.rt = k + 1;
      stepRaceCar(c, { throttle: 1, steer: -1 }, BASE_STATS, env);
      widest = Math.min(widest, splitSL(t, c).lat);
      cue = Math.max(cue, wallHitSpeed(before, c, t));
    }
    return { widest, cue };
  };
  const wide = into(yard), plain = into(bare);
  const limit = splitTrack.wallAt(yard, 1000, -1) - CAR_WIDTH / 2;
  check(
    "split walls: a car steered into the widened left wall beside island A stops at the widened wall less half a car (148, not 100) and the client's wall cue hears it; on the bare loop at track.wall - 8",
    Math.abs(wide.widest + limit) < 0.01 && limit === 148 && wide.cue >= WALL_HIT_MIN && Math.abs(plain.widest + (bare.wall - CAR_WIDTH / 2)) < 0.01,
    `widest lat ${wide.widest.toFixed(3)} (limit -${limit}), cue ${wide.cue.toFixed(0)} u/s; bare ${plain.widest.toFixed(3)}`,
  );
  // The on-road test: on the widened asphalt (lat -95 beside island A, asphalt to -112) a car keeps a
  // road car's speed bit for bit (the same as on the bare loop's centre line); on the bare loop -95 is the verge.
  const speed = (t: Track, lat: number) => {
    const c = surfCar(t, 900, lat, 200);
    for (let k = 0; k < 60; k++) stepCar(c, { throttle: 1, steer: 0 }, BASE_STATS, t);
    return { v: speedOf(c), vx: c.vx, vy: c.vy };
  };
  const onWide = speed(yard, -95), onCentre = speed(bare, 0), onVerge = speed(bare, -95);
  check(
    "split walls: the on-road test is per sample: at lat -95 beside island A (widened asphalt) a car runs exactly as on the bare loop's centre line; at lat -95 on the bare loop it is on the verge (slower)",
    Object.is(onWide.vx, onCentre.vx) && Object.is(onWide.vy, onCentre.vy) && onVerge.v < onCentre.v - 20,
    `after 1 s: ${onWide.v.toFixed(2)} vs ${onCentre.v.toFixed(2)} u/s; verge ${onVerge.v.toFixed(2)}`,
  );
  // The gravel sound (client/sfx.ts updateGravel: onGravel with the per-sample asphalt, halfOf): no
  // gravel on the widened asphalt beside island A, gravel at the same offset on the bare loop's verge;
  // on the shipped tracks halfOf is def.halfWidth exactly (above), so their sound is unchanged.
  const sfxSrc = splitRead("client/sfx.ts", "utf8");
  const gravel = (t: Track, lat: number) => {
    const q = splitQuery(t, 1000, lat);
    return onGravel(q.dist, splitTrack.halfOf(t, q));
  };
  check(
    "split walls: the gravel sound reads the per-sample asphalt (client/sfx.ts: onGravel(q.dist, halfOf(g.track, q))): none at lat -95 beside island A (widened asphalt), gravel at -95 on the bare loop and at -120 beside the island (its verge)",
    sfxSrc.includes("onGravel(q.dist, halfOf(g.track, q))") && !sfxSrc.includes("g.track.def.halfWidth") && !gravel(yard, -95) && gravel(bare, -95) && gravel(yard, -120),
    `yard -95: ${gravel(yard, -95)}, bare -95: ${gravel(bare, -95)}, yard -120: ${gravel(yard, -120)}`,
  );
  // isLost, a landing and a rivet read the widened wall on their side.
  const lost = (t: Track, lat: number) => splitTrack.isLost(t, splitQuery(t, 1000, lat));
  const land = (t: Track) => {
    const c = surfCar(t, 1000, -140, 300);
    c.air = 1;
    return stepRaceCar(c, NO_INPUT_SPLIT, BASE_STATS, raceEnv(t));
  };
  const rivet = (t: Track) => {
    const p = pointAt(t, 1000);
    const s: splitW.Shot = { id: 1, owner: "x", x: p.x - Math.sin(p.h) * -130, y: p.y + Math.cos(p.h) * -130, vx: Math.cos(p.h) * 900, vy: Math.sin(p.h) * 900, seg: p.seg, travelled: 0 };
    return splitW.moveShot(s, t, 0); // rt: no barrels or presses here
  };
  check(
    "split walls: isLost, a landing and a rivet read the widened wall (156 beside island A): lat -250 is not lost (2 x 156), a car landing at -140 lands and a rivet at -130 flies on; on the bare loop (wall 108) all three end",
    !lost(yard, -250) && lost(yard, -320) && lost(bare, -250) && land(yard) === null && land(bare) === "fall" && rivet(yard) && !rivet(bare),
    `lost -250: ${lost(yard, -250)} / bare ${lost(bare, -250)}; landing at -140: ${land(yard)} / bare ${land(bare)}; rivet at -130: ${rivet(yard)} / bare ${rivet(bare)}`,
  );
}
const NO_INPUT_SPLIT = { throttle: 0, steer: 0 };

/** Island A of the Split Yard (820..1580 by -22..22 on the top straight), B (water | dirt) and C (the bend). */
const splitIsle = (k: number) => splitYard().islands[k];

function splitIslands(): void {
  const yard = splitYard(), bare = splitBare();
  // The outline is the drawing's: world.ts's NOSE and TYRE are ISLAND_NOSE and ISLAND_NOSE_ROUND; every
  // drawn tyre stack of every nose (world.ts's rows) lies inside the nose's outline (its centre on the
  // core, so the whole stack within ISLAND_NOSE_ROUND of it), and the barrier posts inside the rectangle.
  const src = splitRead("client/gfx/world.ts", "utf8");
  const NOSE = Number(/const NOSE = ([\d.]+);/.exec(src)?.[1]), TYRE = Number(/const TYRE = ([\d.]+);/.exec(src)?.[1]);
  const postsAt = src.includes("for (const lat of [isle.lat0 + 3.2, isle.lat1 - 3.2])");
  let stacks = 0, outside = 0, worst = 0;
  for (const d of TEST_TRACKS) {
    const t = testTrack(d.id)!;
    for (const isle of t.islands) {
      const width = isle.lat1 - isle.lat0, mid = (isle.lat0 + isle.lat1) / 2;
      const across = Math.max(2, Math.round(width / (TYRE * 1.8)));
      for (const end of [0, 1]) {
        const core = end ? isle.tail : isle.head;
        for (let row = 1; row >= 0; row--) {
          const count = across - row;
          const s = end ? isle.s1 - TYRE - row * TYRE * 1.9 : isle.s0 + TYRE + row * TYRE * 1.9;
          for (let j = 0; j < count; j++) {
            const p = pointAt(t, s), lat = mid + (j - (count - 1) / 2) * ((width - 2 * TYRE) / Math.max(1, across - 1));
            const d0 = splitQuadDist(core, p.x - Math.sin(p.h) * lat, p.y + Math.cos(p.h) * lat);
            stacks++;
            worst = Math.max(worst, d0);
            if (d0 > 0.1) outside++;
          }
        }
      }
    }
  }
  check(
    "split islands: the outline is the M4-WORLD drawing's: NOSE 26 = ISLAND_NOSE and TYRE 6.5 = ISLAND_NOSE_ROUND (client/gfx/world.ts), every drawn tyre stack of every nose lies inside the nose's outline (its centre on the core), and the barrier posts (lat0 + 3.2, lat1 - 3.2) inside the island",
    NOSE === splitTrack.ISLAND_NOSE && TYRE === splitTrack.ISLAND_NOSE_ROUND && postsAt && stacks > 50 && outside === 0,
    `NOSE ${NOSE}, TYRE ${TYRE}; ${stacks} stacks, ${outside} outside, the farthest centre ${worst.toFixed(3)} off its core`,
  );
  // The sides are a wall: a car into island A's left side from the left lane moves exactly as the same
  // car into the right wall from as far away (same angle, speed, bounce and scrape) of the loop with no
  // verge (asphalt up to the wall, as up to the island).
  const A = splitIsle(0);
  const flat = buildTrack({ ...SPLIT_YARD, id: "split-flat", verge: 0, features: [] });
  const a = surfCar(yard, 1000, A.lat0 - CAR_WIDTH / 2 - 40, 300, 0.4), b = surfCar(flat, 1000, flat.wall - CAR_WIDTH / 2 - 40, 300, 0.4);
  let dv = 0, dgap = 0, touched = 0;
  for (let k = 0; k < 40; k++) {
    stepRaceCar(a, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(yard));
    stepRaceCar(b, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(flat));
    dv = Math.max(dv, Math.abs(a.vx - b.vx), Math.abs(a.vy - b.vy));
    const ga = A.lat0 - CAR_WIDTH / 2 - splitSL(yard, a).lat, gb = flat.wall - CAR_WIDTH / 2 - splitSL(flat, b).lat;
    dgap = Math.max(dgap, Math.abs(ga - gb));
    if (ga < 1e-6) touched++;
  }
  check(
    "split islands: an island's side is a wall: a car steered into island A's left side moves exactly as one into the right wall of the loop without a verge from as far (the same bounce WALL_BOUNCE and scrape WALL_SCRAPE)",
    dv < 1e-6 && dgap < 1e-6 && touched > 10,
    `largest velocity difference ${dv.toExponential(2)}, gap difference ${dgap.toExponential(2)}; ${touched} ticks against it`,
  );
  // The nose is a tyre mound's solid: head-on down island A's middle at full throttle it bounces the car
  // back at TYRES_RESTITUTION of the speed it hit it with (that tick's speed on the bare loop); the capsule
  // never overlaps it.
  const h = surfCar(yard, 700, 0, 300);
  let vIn = 0, vOut = 0, minGap = Infinity;
  for (let k = 0; k < 40; k++) {
    const ref = cloneCar(h);
    stepRaceCar(ref, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(bare));
    stepRaceCar(h, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(yard));
    const after = splitAlong(yard, h);
    if (after < 0 && !vIn) {
      vIn = splitAlong(bare, ref);
      vOut = -after;
    }
    minGap = Math.min(minGap, splitTune.noseGap(A, h));
  }
  check(
    "split islands: a nose bounces as a tyre mound (the M4-SURF-1 contact): head-on down island A's middle at full throttle the car comes back at TYRES_RESTITUTION (0.8) of the speed it hit it with, and its capsule never overlaps the nose",
    vIn > 250 && Math.abs(vOut - splitPhys.TYRES_RESTITUTION * vIn) < 0.5 && minGap > -0.01,
    `in ${vIn.toFixed(1)} u/s, out ${vOut.toFixed(1)} (x${(vOut / vIn).toFixed(3)}); smallest gap to the nose ${minGap.toFixed(3)}`,
  );
  // A car that clips a nose's corner (its line 3 outside the island's left edge: its side 5 into it) is
  // turned into the left lane.
  const g = surfCar(yard, 700, A.lat0 - 3, 300);
  let inside = 0;
  for (let k = 0; k < 90; k++) {
    stepRaceCar(g, { throttle: 0.6, steer: 0 }, BASE_STATS, raceEnv(yard));
    const sl = splitSL(yard, g);
    if (sl.s >= A.s0 && sl.s <= A.s1 && sl.lat > A.lat0 - CAR_WIDTH / 2 + 0.01 && sl.lat < A.lat1 + CAR_WIDTH / 2 - 0.01) inside++;
  }
  const gEnd = splitSL(yard, g);
  check(
    "split islands: a car clipping a nose's corner (its line 3 outside the island's edge) is turned into the lane beside it and drives on past",
    inside === 0 && gEnd.s > A.s0 + 60 && gEnd.lat < A.lat0 - CAR_WIDTH / 2 && splitAlong(yard, g) > 100,
    `after 1.5 s at s ${gEnd.s.toFixed(0)} lat ${gEnd.lat.toFixed(1)}, ${splitAlong(yard, g).toFixed(0)} u/s along the track; ${inside} ticks inside the island's band`,
  );
  // A sweep (as schema-hash's walls): cars into every island's sides and noses at a spread of angles and
  // speeds: after every step no car centre is inside an island's band and no capsule overlaps a nose.
  let runs = 0, bad = 0, contacts = 0;
  const firstBad: string[] = [];
  for (const d of TEST_TRACKS) {
    const t = testTrack(d.id)!;
    for (const isle of t.islands) {
      const starts: [number, number, number][] = [];
      for (const s of [isle.s0 - 90, isle.s0 - 50]) for (const lat of [isle.lat0 - 2, isle.mid, isle.lat1 + 2, isle.lat0 + 3, isle.lat1 - 3]) for (const dh of [-0.4, 0, 0.4]) starts.push([s, lat, dh]);
      for (let s = isle.s0 + 40; s < isle.s1 - 40; s += 90) for (const side of [-1, 1]) for (const dh of [0.2, 0.6, 1.2]) starts.push([s, side < 0 ? isle.lat0 - 40 : isle.lat1 + 40, -side * dh]);
      for (const [s, lat, dh] of starts) {
        for (const v of [140, 300, 430]) {
          const c = surfCar(t, s, lat, v, dh);
          runs++;
          for (let k = 0; k < 50; k++) {
            stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, raceEnv(t));
            if (c.air || c.fall || c.wreck) break;
            const q = queryTrackNear(t, c.x, c.y, c.seg);
            const hit = splitTune.islandContact(t, c);
            if (hit) contacts++;
            const inBand = q.s >= isle.s0 + splitPhys.NOSE_MID && q.s <= isle.s1 - splitPhys.NOSE_MID && q.lat > isle.lat0 - CAR_WIDTH / 2 + 0.01 && q.lat < isle.lat1 + CAR_WIDTH / 2 - 0.01;
            const onRect = q.s >= isle.s0 && q.s <= isle.s1 && q.lat >= isle.lat0 && q.lat <= isle.lat1;
            // A nose's rule where it applies (the centre before the head's middle or past the tail's);
            // between them the sides' wall rule holds the centre, as the track's walls do.
            const atNose = q.s < isle.s0 + splitPhys.NOSE_MID || q.s > isle.s1 - splitPhys.NOSE_MID;
            if (inBand || onRect || (atNose && splitTune.noseGap(isle, c) < -0.01)) {
              bad++;
              if (firstBad.length < 3) firstBad.push(`${d.id} isle ${isle.s0}: start ${s},${lat},${dh} v${v} tick ${k} at ${q.s.toFixed(1)},${q.lat.toFixed(1)} gap ${splitTune.noseGap(isle, c).toFixed(2)}`);
              break;
            }
          }
        }
      }
    }
  }
  check(
    "split islands: a sweep of cars into every island's sides and noses (5 lanes x 3 angles at 2 distances before each head, both sides every 90 units at 3 angles, 140 / 300 / 430 u/s): no car centre ever inside an island's band or on it, no capsule overlapping a nose where the nose's rule holds it",
    bad === 0 && runs > 500 && contacts > 1000,
    `${runs} runs, ${contacts} contact ticks, ${bad} bad${firstBad.length ? `: ${firstBad.join("; ")}` : ""}`,
  );
  // Airborne: a flight passes over an island (nothing touches it), and a car that lands on one is put
  // back in the nearer lane by its next driving step, without a fall (the plan's default rule).
  const fly = surfCar(yard, 780, 0, 400);
  fly.air = 30;
  const x0 = fly.x, y0 = fly.y;
  for (let k = 0; k < 20; k++) stepRaceCar(fly, NO_INPUT_SPLIT, BASE_STATS, raceEnv(yard));
  let ex = x0, ey = y0;
  for (let k = 0; k < 20; k++) {
    ex += fly.vx * DT;
    ey += fly.vy * DT;
  }
  const flewOver = fly.air === 10 && Object.is(fly.x, ex) && Object.is(fly.y, ey) && splitSL(yard, fly).s > A.s0 + 20;
  const landOn = (lat: number) => {
    const c = surfCar(yard, 1100, lat, 300);
    c.air = 1;
    const ev1 = stepRaceCar(c, NO_INPUT_SPLIT, BASE_STATS, raceEnv(yard));
    const at1 = splitSL(yard, c).lat;
    const ev2 = stepRaceCar(c, NO_INPUT_SPLIT, BASE_STATS, raceEnv(yard));
    return { ev: `${ev1}/${ev2}`, at1, at2: splitSL(yard, c).lat, fall: c.fall };
  };
  const right = landOn(5), left = landOn(-5);
  check(
    "split islands: a flight passes over an island; a car landing on one lands (no fall) and its next driving step puts it beside the nearer side (lat 5 -> 30, lat -5 -> -30): islands are solid for grounded cars only",
    flewOver && right.fall === 0 && left.fall === 0 && Math.abs(right.at2 - (A.lat1 + CAR_WIDTH / 2)) < 1e-6 && Math.abs(left.at2 + (A.lat1 + CAR_WIDTH / 2)) < 1e-6 && right.ev === "null/null",
    `flew to s ${splitSL(yard, fly).s.toFixed(0)}, air ${fly.air}; landing at 5: ${right.ev}, lat ${right.at1.toFixed(1)} -> ${right.at2.toFixed(3)}; at -5: ${left.at1.toFixed(1)} -> ${left.at2.toFixed(3)}`,
  );
  // Rivets die on islands and their noses: fired across island A from the left lane, and head-on into
  // its head; one fired down the lane flies its full range; on the bare loop the first two fly on.
  const shoot = (t: Track, s: number, lat: number, dh: number) => {
    const p = pointAt(t, s), hh = p.h + dh;
    const sh: splitW.Shot = { id: 1, owner: "x", x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, vx: Math.cos(hh) * 900, vy: Math.sin(hh) * 900, seg: p.seg, travelled: 0 };
    let k = 0;
    while (k < 60 && splitW.moveShot(sh, t, 0)) k++; // rt: no barrels or presses here
    return { k, at: splitSL(t, sh), far: sh.travelled };
  };
  const across = shoot(yard, 1000, -80, Math.PI / 2), acrossBare = shoot(bare, 1000, -80, Math.PI / 2);
  const headOn = shoot(yard, 700, 0, 0), headOnBare = shoot(bare, 700, 0, 0);
  const lane = shoot(yard, 860, -70, 0);
  check(
    "split islands: rivets die on islands and noses: fired across island A from the left lane it dies at its side, head-on it dies at its nose; down the lane it flies its full range; on the bare loop the first two fly on",
    across.at.lat > A.lat0 - 26 && across.at.lat < A.lat0 + 26 && across.far < 80 && headOn.at.s > A.s0 - 26 && headOn.at.s < A.s0 + 26 &&
      acrossBare.far > 150 && headOnBare.far > 600 && lane.far > splitW.RIVET_RANGE,
    `across: died after ${across.far.toFixed(0)} at lat ${across.at.lat.toFixed(1)} (bare ${acrossBare.far.toFixed(0)}); head-on: at s ${headOn.at.s.toFixed(1)} (bare ${headOnBare.far.toFixed(0)}); down the lane ${lane.far.toFixed(0)}`,
  );
  // Mines dropped on an island (they do not know the track, as ever): a mine stays where it lands. A car
  // scraping the island's side reaches one up to 14 inside its edge (CAR_RADIUS + MINE_RADIUS from a
  // centre held CAR_WIDTH / 2 off the edge), never one 16 inside.
  const mineAt = (inside: number) => {
    const p = pointAt(yard, 1200), lat = A.lat0 + inside;
    return { id: 1, owner: "x", x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, age: 0 };
  };
  const scraper = surfCar(yard, 950, A.lat0 - CAR_WIDTH / 2 - 2, 250, 0.05);
  const near = mineAt(10), deep = mineAt(16);
  let hitNear = false, hitDeep = false, scraped = 0;
  for (let k = 0; k < 150; k++) {
    stepRaceCar(scraper, { throttle: 0.7, steer: 0.02 }, BASE_STATS, raceEnv(yard));
    if (splitTune.islandContact(yard, scraper) === "side") scraped++;
    hitNear ||= splitW.mineHits(near, scraper);
    hitDeep ||= splitW.mineHits(deep, scraper);
  }
  check(
    "split islands: a mine dropped on an island stays there; a car scraping its side sets off one 10 inside the edge, never one 16 inside (reach 22 from a centre 8 off the edge)",
    hitNear && !hitDeep && scraped > 60 && splitSL(yard, scraper).s > 1250,
    `scraped ${scraped} ticks; near ${hitNear}, deep ${hitDeep}`,
  );
  // A wreck in a split lane respawns in that lane (clearLaneAt's side: the car's own), never in the island.
  const B = splitIsle(1);
  const wreckAt = (lat: number) => {
    const c = surfCar(yard, 6400, lat, 0);
    splitW.wreckCar(c);
    for (let k = 0; k < splitW.WRECK_TICKS; k++) stepRaceCar(c, NO_INPUT_SPLIT, BASE_STATS, raceEnv(yard));
    return splitSL(yard, c);
  };
  const wr = wreckAt(76), wl = wreckAt(-76);
  check(
    "split islands: a car wrecked in a split lane respawns at its s in that lane (the right lane's clear lane nearest the centre, the left one's), never in the island",
    Math.abs(wr.s - 6400) < 0.5 && Math.abs(wl.s - 6400) < 0.5 && wr.lat >= B.lat1 + CAR_WIDTH / 2 + 4 && wr.lat < B.lat1 + 20 && wl.lat <= B.lat0 - CAR_WIDTH / 2 - 4 && wl.lat > B.lat0 - 20,
    `right lane -> s ${wr.s.toFixed(1)} lat ${wr.lat.toFixed(1)}; left lane -> s ${wl.s.toFixed(1)} lat ${wl.lat.toFixed(1)}`,
  );
}

/** The car's velocity along the track's direction at its segment. */
function splitAlong(t: Track, c: CarState): number {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  const d = segDirSplit(t, q.seg);
  return c.vx * d.x + c.vy * d.y;
}
const segDirSplit = (t: Track, seg: number) => splitTrack.segDir(t, seg);

/** Distance from (x, y) to the convex quad (0 inside it). */
function splitQuadDist(quad: readonly { x: number; y: number }[], x: number, y: number): number {
  let sign = 0, inside = true, best = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = quad[k], b = quad[(k + 1) % 4];
    const ex = b.x - a.x, ey = b.y - a.y;
    const cross = ex * (y - a.y) - ey * (x - a.x);
    if (Math.abs(cross) > 1e-9) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) inside = false;
    }
    const t = clamp(((x - a.x) * ex + (y - a.y) * ey) / (ex * ex + ey * ey || 1), 0, 1);
    best = Math.min(best, Math.hypot(x - a.x - ex * t, y - a.y - ey * t));
  }
  return inside ? 0 : best;
}

/**
 * A lap of `t` (and a bit) by a plain lane follower: on the centre line, and from 250 before each
 * island to just past it in the middle of its lane on `side`; the race progress (server/race.ts)
 * every tick. The checkpoint and lap events (with the s each happened at), the side it was on at each
 * island's middle, and whether its distance raced ever went back.
 */
function splitLap(t: Track, side: number): { events: string[]; sides: string; back: number; ticks: number } {
  const p0 = pointAt(t, -60);
  const c: CarState = { x: p0.x, y: p0.y, h: p0.h, vx: 0, vy: 0, seg: p0.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const prog = splitProg.newProgress(t, c);
  const env = raceEnv(t);
  const events: string[] = [];
  let sides = "", back = 0, ticks = 0, last = splitProg.raceDistance(t, prog);
  for (; ticks < 60 * 90 && prog.lap < 1; ticks++) {
    const q = queryTrackNear(t, c.x, c.y, c.seg);
    const isle = t.islands.find((f) => q.s > f.s0 - 250 && q.s < f.s1 + 40);
    const lat = isle ? (side < 0 ? (isle.lat0 - isle.outL) / 2 : (isle.lat1 + isle.outR) / 2) : 0;
    const a = pointAt(t, q.s + 60 + speedOf(c) * 0.2);
    const tx = a.x - Math.sin(a.h) * lat, ty = a.y + Math.cos(a.h) * lat;
    env.rt = ticks + 1;
    stepRaceCar(c, { throttle: 0.75, steer: clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1) }, BASE_STATS, env);
    const s0 = prog.s, cp0 = prog.cp, lap0 = prog.lap;
    splitProg.advance(t, prog, c);
    if (prog.cp !== cp0 || prog.lap !== lap0) events.push(`${prog.lap ? "lap" : `cp${prog.cp}`}@${prog.lap ? Math.round(prog.s) : Math.round((s0 + prog.s) / 2)}`);
    for (const f of t.islands) {
      const m = (f.s0 + f.s1) / 2;
      if (s0 < m && prog.s >= m) sides += splitSL(t, c).lat < f.mid ? "L" : "R";
    }
    const now = splitProg.raceDistance(t, prog);
    if (now < last - 1e-9) back++;
    last = now;
  }
  return { events, sides, back, ticks };
}

function splitProgress(): void {
  // s, checkpoints, laps and positions are those of the one road: a lap through every left lane and a
  // lap through every right lane cross the same checkpoints in the same order at the same s, and the
  // distance raced never goes back. On a Split Yard with a split over the half-lap checkpoint too.
  const yard = splitYard();
  const over = buildTrack({ ...SPLIT_YARD, id: "split-cp", features: [...SPLIT_YARD.features!, { k: "widen", s0: 4700, s1: 5500, left: 40, right: 40 }, { k: "island", s0: 4850, s1: 5350, lat0: -24, lat1: 24 }] });
  const rows: string[] = [];
  let ok = validateTrack(over).length === 0 && over.checkpoints[1] > 4850 && over.checkpoints[1] < 5350;
  for (const t of [yard, over]) {
    const l = splitLap(t, -1), r = splitLap(t, 1);
    const names = (x: { events: string[] }) => x.events.map((e) => e.split("@")[0]).join();
    const near = (x: { events: string[] }) => x.events.every((e, i) => Math.abs(Number(e.split("@")[1]) - (i < 3 ? t.checkpoints[i] : 0)) < 12);
    const good = names(l) === "cp1,cp2,cp3,lap" && names(r) === names(l) && near(l) && near(r) && l.sides === "L".repeat(t.islands.length) && r.sides === "R".repeat(t.islands.length) && l.back === 0 && r.back === 0;
    ok &&= good;
    rows.push(`${t.def.id}: left lanes ${l.sides} ${l.events.join(" ")} in ${l.ticks} ticks; right lanes ${r.sides} ${r.events.join(" ")} in ${r.ticks} ticks (the shorter lane is faster where one is)`);
  }
  check(
    "split progress: s, checkpoints, laps and positions are the one road's: a lap through every left lane and one through every right lane cross the same checkpoints in the same order at the same s (one inside a split), the distance raced never going back",
    ok,
    rows.join(" | "),
  );
}

function splitValidate(): void {
  // Each lane >= 72 (M4-SCHEMA's rule); an island at least its noses wide and twice as long; advisor
  // change 13 (the inside of a bend); recovery points and grid slots >= 40 from islands and their noses
  // (the noses lie inside the island's rectangle, so the solids' rule covers them).
  const errs = (extra: Feature[], recovery = SPLIT_YARD.recovery) => validateTrack(buildTrack({ ...SPLIT_YARD, id: "split-bad", features: [...SPLIT_YARD.features!, ...extra], recovery })).join(" | ");
  const narrow = errs([{ k: "widen", s0: 3300, s1: 4500, left: 50, right: 50 }, { k: "island", s0: 3500, s1: 4300, lat0: -10, lat1: 10 }]);
  const short = errs([{ k: "widen", s0: 3300, s1: 4500, left: 50, right: 50 }, { k: "island", s0: 3800, s1: 3840, lat0: -20, lat1: 20 }]);
  const lane = errs([{ k: "widen", s0: 3300, s1: 4500, left: 20, right: 50 }, { k: "island", s0: 3500, s1: 4300, lat0: -20, lat1: 20 }]);
  const bend = validateTrack(buildTrack({ ...SPLIT_YARD, id: "split-bend", features: SPLIT_YARD.features!.map((f) => (f.k === "widen" && f.s0 === 7800 ? { ...f, right: 400 } : f)) })).join(" | ");
  const nearRec = errs([], [0, 5870]); // 30 before island B's head
  const nearNose = errs([], [0, 1605]); // 25 past island A's tail
  const yardOk = validateTrack(splitYard()).length === 0 && validateRunUps(splitYard()).length === 0;
  check(
    "split validate: the Split Yard is valid; an island narrower than its noses (26), shorter than two noses, or leaving a lane < 72 is refused; a widen whose inside in a bend reaches past the radius is refused (advisor change 13); a recovery point < 40 from an island's nose (either end) is refused",
    yardOk && narrow.includes("narrower than its noses (26)") && short.includes("shorter than its two noses (52)") && lane.includes("lane is") && lane.includes("(a split lane is >= 72)") &&
      bend.includes("nearest() degenerates") && nearRec.includes("from recovery point s=5870.0") && nearNose.includes("from recovery point s=1605.0"),
    [narrow, short, lane, bend, nearRec, nearNose].map((e) => e.slice(0, 110)).join(" || "),
  );
  // Run-ups once per lane: a split before a jump with dirt filling its right lane: driven through the
  // left lane the run-up makes the jump, through the right lane (slowed in the dirt) it lands short. The
  // same split without the dirt passes both ways.
  const jump = (dirt: boolean) => {
    const f: Feature[] = [
      { k: "widen", s0: 5300, s1: 6100, left: 40, right: 40 },
      { k: "island", s0: 5450, s1: 5950, lat0: -24, lat1: 24 },
      { k: "ramp", s: 6250, len: 80 },
      { k: "gap", s0: 6330, s1: 6610 },
    ];
    if (dirt) f.push({ k: "dirt", s0: 5450, s1: 5950, lat0: 24, lat1: 104 });
    const t = buildTrack({ ...SPLIT_YARD, id: "split-jump", features: f, recovery: [0, 5100] });
    return { valid: validateTrack(t), runs: validateRunUps(t) };
  };
  const dry = jump(false), dirty = jump(true);
  check(
    "split validate: run-ups are driven once per lane: with dirt filling a split's right lane before a jump the run-up through the right lane lands short and the one through the left lane makes it; without the dirt both make it",
    dry.valid.length === 0 && dry.runs.length === 0 && dirty.valid.length === 0 && dirty.runs.length === 1 && dirty.runs[0].includes("through the right lane of the split") && dirty.runs[0].includes("lands short"),
    `without dirt: ${dry.runs.length} errors; with dirt: ${dirty.runs.join(" | ")}`,
  );
}

function splitBots(): void {
  // Easy, Normal and Hard: three server bots each (Sport, Racer, Truck by seat), 3 laps of the Split
  // Yard, and five mixed: all finish, no fall, identically on a rerun (bot ids are random per room, so a
  // rerun that matches shows nothing is keyed by the id). The lane per seat and car type: the plain
  // split by the seat's racing line (left for a line left of centre), the water | dirt split by car type
  // (the truck the dirt, the Sport and the Racer the water), the bend split by its shorter inside lane.
  const runs: [string, BotLevel[]][] = [["easy", ["easy", "easy", "easy"]], ["normal", ["normal", "normal", "normal"]], ["hard", ["hard", "hard", "hard"]], ["mixed", ["easy", "normal", "hard", "normal", "hard"]]];
  const lanesOf = [-24, 24, 0, -12, 12]; // server/bots.ts LANES by seat
  const rows: string[] = [];
  let ok = true, lanesOk = true, worst = 0;
  for (const [name, levels] of runs) {
    const a = splitTune.splitRace(levels), b = splitTune.splitRace(levels);
    const good = a.phase === "results" && a.finish.length === levels.length && a.falls.every((x) => x === 0) && a.digest === b.digest && JSON.stringify(a.finish) === JSON.stringify(b.finish);
    ok &&= good;
    a.lanes.forEach((l, k) => {
      const want = [(lanesOf[k] >= 0 ? "R" : "L").repeat(3), (a.cars[k] === "truck" ? "R" : "L").repeat(3), "RRR"];
      lanesOk &&= JSON.stringify(l) === JSON.stringify(want);
      worst = Math.max(worst, a.sides[k] + a.noses[k]);
    });
    rows.push(`${name}: ${a.finish.join(", ")}; falls ${a.falls.join("/")}; island side/nose ticks ${a.sides.map((x, k) => `${x}/${a.noses[k]}`).join(" ")}; lanes ${a.lanes.map((l, k) => `${a.cars[k]}:${l.map((x) => x[0]).join("")}`).join(" ")}; rerun ${a.digest === b.digest ? "identical" : "DIFFERS"}`);
  }
  console.log(`  ${rows.join("\n  ")}`);
  check("split bots: Easy, Normal and Hard bots (Sport, Racer, Truck by seat; and five mixed) all finish 3 laps of the Split Yard with no fall, identically on a rerun", ok, rows.map((r) => r.split(";")[0]).join(" | "));
  check(
    "split bots: a lane per seat and car type, every lap: the plain split by the seat's line (seats -24, -12 left; 0, 12, 24 right), the water | dirt split by type (Truck the dirt lane, Sport and Racer the water), the bend split's shorter inside lane for all",
    lanesOk,
    rows.map((r) => r.split("; lanes ")[1]?.split(";")[0]).join(" | "),
  );
  // Never into an island or a nose: with weapons off (no spin-outs) not one tick against an island at
  // any level; with weapons (Normal and Hard shoot and drop mines) at most SPLIT_HIT_BOUND ticks per bot
  // in 3 laps (a spun car sliding into one).
  let off = 0;
  for (const level of BOT_LEVELS) {
    const r = splitTune.splitRace([level, level, level], 3, SPLIT_YARD.id, false);
    off += r.sides.reduce((x, y) => x + y, 0) + r.noses.reduce((x, y) => x + y, 0) + r.walls.reduce((x, y) => x + y, 0);
  }
  check(
    `split bots: bots never drive into an island or a nose: weapons off, Easy, Normal and Hard touch no island and no wall in 3 laps; weapons on, at most ${SPLIT_HIT_BOUND} island-contact ticks per bot (after a spin-out)`,
    off === 0 && worst <= SPLIT_HIT_BOUND,
    `weapons off: ${off} island or wall ticks; weapons on: the most per bot ${worst}`,
  );
  // splitSide: by cost (lane length + the surfaces that leave no dry line), the seat on a tie.
  const yard = splitYard();
  const [A, B, C] = yard.islands;
  const st = (type: CarType) => statsFor(type, { engine: 0, tyres: 0, welder: 0 });
  const sides = {
    tie: [-24, -1, 0, 12].map((lat) => splitBot.splitSide(A, st("sport"), lat)),
    types: CAR_TYPES.map((type) => splitBot.splitSide(B, st(type), -24)),
    bend: CAR_TYPES.map((type) => splitBot.splitSide(C, st(type), -24)),
  };
  check(
    "split bots: splitSide: equal lanes go by the seat's line (left of centre left, the centre and right of it right); water | dirt: the Sport and the Racer the water (left), the Truck the dirt (right); the bend's inside lane (89 units shorter) for every type",
    JSON.stringify(sides) === JSON.stringify({ tie: [-1, -1, 1, 1], types: [-1, -1, 1], bend: [1, 1, 1] }) && C.lenL - C.lenR > 80,
    JSON.stringify(sides) + ` (bend lanes ${C.lenL.toFixed(1)} / ${C.lenR.toFixed(1)})`,
  );
  // On a plain track there is no split: splitFor is null, laneFor's span path never runs (the three
  // original shipped tracks; M4-TRACKS: the long tracks have splits).
  const none = ["rust-bowl", "crusher-run", "overpass-knot"].every((id) => {
    const t = trackById(id);
    return t.islands.length === 0 && splitBot.splitFor(t, 100, 3, 0, 400, 0, BASE_STATS) === null;
  });
  check("split bots: on the shipped tracks there is no island and splitFor is null (the bots drive as before)", none);
}
/** The most island-contact ticks a bot may have in 3 laps of the Split Yard with weapons on (spun by a mine or rivets). */
const SPLIT_HIT_BOUND = 8;

function splitParity(): void {
  // stepRaceCar on a clone equals the server's pose bit for bit every tick: a lone server bot of each
  // level and car type over 2 laps of the Split Yard (both lanes of the plain split by seat, water and
  // dirt by type), and a scripted player driven into island A's side and head-on into its nose.
  const rows: string[] = [];
  let all = true;
  withDevTrack(SPLIT_YARD.id, () => {
    for (const [level, car, slot] of [["easy", "sport", 0], ["normal", "racer", 1], ["hard", "truck", 2]] as const) {
      const sim = new Sim(2);
      const host = sim.add("Host");
      if (sim.room.setTrack(host, SPLIT_YARD.id)) throw new Error("dev track refused");
      const bots: Player[] = [];
      for (let k = 0; k <= slot; k++) bots.push(sim.room.addBot(host, level, sim.now) as Player);
      const b = bots[slot];
      for (const o of bots) if (o !== b) sim.room.kick(host, o.id, sim.now);
      if (sim.room.setCar(host, car, b.id)) throw new Error("car");
      b.wallet.ammo.rivets = 0;
      b.wallet.ammo.mines = 0;
      sim.room.start(host, sim.now);
      while (sim.room.phase !== "racing") sim.tick();
      sim.room.retire(host);
      const t = sim.room.track;
      let ctl: splitBot.BotControls | null = null;
      surfServerBots.botTrace.fn = (p, c) => {
        if (p === b) ctl = c;
      };
      let ticks = 0, mismatch = 0, first = "", lanes = "";
      try {
        while (sim.room.phase === "racing" && ticks < 60 * 120) {
          const clone = cloneCar(b.car!);
          const s0 = splitSL(t, clone).s;
          sim.tick();
          ticks++;
          if (!b.car || sim.room.phase !== "racing") break;
          const c = ctl as splitBot.BotControls | null;
          stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, raceEnv(t, sim.room.rt, 0));
          const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
          if (!keys.every((k) => Object.is(clone[k], b.car![k]))) {
            mismatch++;
            if (!first) first = `tick ${ticks}: ${keys.filter((k) => !Object.is(clone[k], b.car![k])).join(",")}`;
          }
          const s1 = splitSL(t, b.car!);
          for (const f of t.islands) if (s0 < (f.s0 + f.s1) / 2 && s1.s >= (f.s0 + f.s1) / 2) lanes += s1.lat < f.mid ? "L" : "R";
        }
      } finally {
        surfServerBots.botTrace.fn = null;
      }
      const good = mismatch === 0 && ticks > 60 * 30 && b.progress!.fin > 0 && lanes.length === 6;
      all &&= good;
      rows.push(`${level} ${car} (seat ${slot}): ${ticks} ticks, ${mismatch} mismatches${first ? ` (${first})` : ""}; lanes ${lanes}`);
    }
    // A lone server bot thrown at island A: its car put in the left lane aimed into the side, in front of
    // the head nose aimed at it (down the middle and at its corner), and in the right lane aimed into the
    // side; then the bot drives (its controls, botTrace, are what the server applied).
    const sim = new Sim(1);
    const host = sim.add("Host");
    if (sim.room.setTrack(host, SPLIT_YARD.id)) throw new Error("dev track refused");
    const b = sim.room.addBot(host, "normal", sim.now) as Player;
    b.wallet.ammo.rivets = 0;
    b.wallet.ammo.mines = 0;
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const t = sim.room.track;
    const A = t.islands[0];
    let ctl: splitBot.BotControls | null = null;
    surfServerBots.botTrace.fn = (p, c) => {
      if (p === b) ctl = c;
    };
    let mismatch = 0, sides = 0, noses = 0;
    try {
      for (const [s, lat, dh] of [[950, -60, 1.1], [1100, -45, 0.9], [760, 0, 0], [760, A.lat0 - 3, 0], [1300, 60, -1.1], [1450, 45, -0.9]] as const) {
        const p = pointAt(t, s), h = p.h + dh;
        b.car = { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h, vx: Math.cos(h) * 320, vy: Math.sin(h) * 320, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
        for (let k = 0; k < 40; k++) {
          const clone = cloneCar(b.car);
          sim.tick();
          const c = ctl as splitBot.BotControls | null;
          stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, raceEnv(t, sim.room.rt, 0));
          const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
          if (!keys.every((kk) => Object.is(clone[kk], b.car![kk]))) mismatch++;
          const hit = splitTune.islandContact(t, b.car!);
          if (hit === "side") sides++;
          else if (hit === "nose") noses++;
        }
      }
    } finally {
      surfServerBots.botTrace.fn = null;
    }
    all &&= mismatch === 0 && sides > 0 && noses > 0;
    rows.push(`a bot thrown at island A: ${mismatch} mismatches; ${sides} ticks against its sides, ${noses} on its nose`);
  });
  console.log(`  ${rows.join("\n  ")}`);
  check("split parity: stepRaceCar on a clone equals the server's pose bit for bit every tick: a lone server bot per level and type, 2 laps of the Split Yard through both lanes, and one thrown at an island's sides and its nose", all, rows.join(" | "));
  // The client's prediction over the wire, no lag: three socket-bot cars (Sport, Racer, Truck on lines
  // -24, 0, 24: both lanes of the plain split) race 1 lap of the Split Yard.
  const r = withDevTrack(SPLIT_YARD.id, () => carsClientLap(SPLIT_YARD.id));
  check(
    `split parity: three client cars (Sport, Racer, Truck) racing the Split Yard over the wire predict it exactly: no state mismatch, no error > ${LARGE_ERR}`,
    r.ticks.every((x) => x > 0) && r.stateErrs === 0 && r.large === 0 && r.samples > 500 && r.same,
    `laps ${r.ticks.map((x) => (x / 60).toFixed(1)).join("/")} s; ${r.samples} samples, ${r.stateErrs} state mismatches, ${r.large} > ${LARGE_ERR}, max ${r.maxErr.toFixed(4)}`,
  );
}

function splitCpu(): void {
  // No scan per tick: islands and widens in per-segment buckets. Five server bots (Easy, Normal, Hard,
  // Normal, Hard), 3 laps of the Split Yard: the median bot step and room tick (the M4-SURF-1 numbers
  // on the Surf Yard: bot step 0.00133 ms, room tick 0.0135 ms).
  const r = withDevTrack(SPLIT_YARD.id, () => {
    const sim = new Sim(3);
    const host = sim.add("Host");
    sim.room.setTrack(host, SPLIT_YARD.id);
    for (const l of ["easy", "normal", "hard", "normal", "hard"] as BotLevel[]) sim.room.addBot(host, l, sim.now);
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const tickMs: number[] = [];
    const steps: number[] = [];
    botTiming.samples = steps;
    let ticks = 0;
    try {
      while (sim.room.phase === "racing" && ticks < 60 * 300) {
        sim.tickNo++;
        sim.now += 1000 / 60;
        const t0 = performance.now();
        sim.room.tick(sim.tickNo, sim.now);
        tickMs.push(performance.now() - t0);
        ticks++;
      }
    } finally {
      botTiming.samples = null;
    }
    return { tickMs, steps, phase: sim.room.phase as string };
  });
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const med = pct(r.steps, 0.5), tickMed = pct(r.tickMs, 0.5);
  console.log(`  CPU (Split Yard): bot step median ${med.toFixed(5)} ms, p99 ${pct(r.steps, 0.99).toFixed(5)} ms over ${r.steps.length} steps; room tick with 5 bots median ${tickMed.toFixed(4)} ms, p99 ${pct(r.tickMs, 0.99).toFixed(4)} ms (M4-SURF-1 on the Surf Yard: bot step 0.00133 ms, room tick 0.0135 ms)`);
  check(
    "split CPU: on the Split Yard the median bot step stays within the M4-BOTS bound (0.2 ms; target 0.05) and the room tick with 5 bots is printed beside the M4-SURF-1 numbers",
    r.steps.length > 5 * 3000 && med <= 0.05 && r.phase === "results",
    `median bot step ${med.toFixed(5)} ms; room tick median ${tickMed.toFixed(4)} ms`,
  );
  // stepCar beside an island and on its nose costs about what a step on a plain track does.
  const time = (t: Track, s: number, lat: number) => {
    const c = surfCar(t, s, lat, 300);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const d = { ...c };
      stepCar(d, { throttle: 1, steer: 0.1 }, BASE_STATS, t);
    }
    return ((performance.now() - t0) / 20_000) * 1000;
  };
  const plain = time(trackById("rust-bowl"), 3000, 0), side = time(splitYard(), 1000, -31), nose = time(splitYard(), 795, 0);
  console.log(`  stepCar: ${plain.toFixed(3)} us on Rust Bowl, ${side.toFixed(3)} us against an island's side, ${nose.toFixed(3)} us on a nose`);
  const added = (performance.now() - splitClock.t0) / 1000;
  console.log(`  M4-SURF part 2 sim-test sections' runtime (splitWalls .. splitCpu): ${added.toFixed(1)} s`);
}

function splitMounds(): void {
  // The M4-SURF-1 review's F1: the mound side locks (MOUNDS: a bot keeps its side of a mound from
  // MOUNDS.commit before it until MOUNDS.hold past its edge, and sees the mounds after it all the while).
  // On the Surf Yard every seat's mound-contact ticks are at most the M4-SURF-1 branch's (Easy 17/9/8,
  // Normal 18/9/10, Hard 18/13/11), with no fall.
  const branch: Record<BotLevel, number[]> = { easy: [17, 9, 8], normal: [18, 9, 10], hard: [18, 13, 11] };
  const rows: string[] = [];
  let ok = true;
  for (const level of BOT_LEVELS) {
    const r = surfTune.surfRace(level);
    ok &&= r.mounds.every((x, k) => x <= branch[level][k]) && r.falls.every((x) => x === 0) && r.phase === "results";
    rows.push(`${level} ${r.mounds.join("/")} (branch ${branch[level].join("/")}), falls ${r.falls.join("/")}`);
  }
  check("split mounds (F1): on the Surf Yard no seat touches the mounds more than on the M4-SURF-1 branch, with no fall", ok, rows.join("; "));
  // F2: laneFor looks round the lap past the finish line for mounds and surfaces, as for holes.
  const L = splitBare().length;
  const near = (features: Feature[]) => {
    const t = buildTrack({ ...SPLIT_YARD, id: "split-wrap", features });
    const s = L - 150;
    return splitBot.laneFor(t, s, pointAt(t, s).seg, 600, -24, -24, BASE_STATS);
  };
  const mound = near([{ k: "tyres", s: 330, lat: -24, r: 22 }]), pool = near([{ k: "water", s0: 320, s1: 460, lat0: -64, lat1: 8 }]);
  check(
    "split mounds (F2): 150 before the finish line a bot on line -24 sees a mound and a pool just past the line (look 600): its lane clears the mound, and leaves the pool's side",
    mound.holes === 1 && Math.abs(mound.lane + 24) > 22 + CAR_WIDTH / 2 + 8 && pool.dodge && pool.lane >= 0,
    `mound: lane ${mound.lane}, ${mound.holes} blocker(s); pool: lane ${pool.lane}, dodge ${pool.dodge}`,
  );
}

function splitDevFlag(): void {
  // SCRAP_DEV_TRACK=split-yard: a new room starts on the Split Yard; unset, it is refused as unknown.
  const on = withDevTrack(SPLIT_YARD.id, () => {
    const rooms = new Rooms(1);
    const x = { conn: new FakeConn(), room: null, player: null } as Session;
    rooms.onMessage(x, { t: "create", name: "Ann" }, 1000);
    return { id: x.room!.trackId, same: x.room!.track === testTrack(SPLIT_YARD.id), flag: surfRoom.devTrackId() };
  });
  const off = withDevTrack(undefined, () => {
    const sim = new Sim();
    const host = sim.add("Host");
    return sim.room.setTrack(host, SPLIT_YARD.id);
  });
  check(
    "split dev flag: SCRAP_DEV_TRACK=split-yard starts a new room on the Split Yard; unset (the default, and on Render) the host cannot pick it",
    on.id === SPLIT_YARD.id && on.same && on.flag === SPLIT_YARD.id && off === "Unknown track",
    `${JSON.stringify(on)}; unset: ${off}`,
  );
}

for (const t of [rivets, gating, mines, wrecks, finishing, garage, armDelay, engine, readyCheck, collisions, trackFeatures, roomTrack, jumpsWired, shippedTracks, botDriver, botLaps, mineCap, chatRoom, chatClient, sound, raceSounds, surfaceSounds, audioUnlock, menuHostOnly, menuStop, menuRestart, menuKick, menuLock, menuHandover, menuClient, menuRestartClient, retireRules, retireField, retireRaceEnd, retireGarage, retireRefund, retireOthers, retireNotices, retireClient, pauseRefused, pauseFreeze, pauseResume, pauseHold, pauseAuto, pauseCooldown, pauseGrace, pauseCountdown, pauseControls, pauseClient, musicSwitch, soundMigration, soundLayers, soundServer, soundRandom, soundRoomDrag, soundSliderGrip, soundClient, songs, songPlayer, ghostRivets, minesSetting, minesStay, minesCap, minesFade, minesAtStart, minesCleared, minesPaused, minesClient, botsPointAt, botsAdd, botsKickHost, botsHandover, botsFullRoom, botsSoloStart, botsRace, botsShop, botsTick, botsCpu, botsClient, carsTypes, carsStats, carsPick, carsRejoin, carsBots, carsRunUps, carsBalance, carsCut, carsClient, envRt, envStep, envClient, draftRule, draftStraight, draftClient, draftJumps, draftBots, cellsRule, boostPhysics, cellsServer, cellsClient, cellsValidate, cellsBots, cellsOffCentre, schemaTypes, schemaArrays, schemaLateral, schemaRt, schemaValidate, schemaPreview, schemaDataOnly, hardGolden, hardLevels, hardShop, hardWeapons, hardApex, hardPace, hardTraffic, hardVs, hardClient, hardCpu, touchStickCentre, touchStickClamp, touchStickDead, touchStickCurve, touchStickOutput, touchStickRounding, touchStickOwner, touchMulti, touchRelease, touchMine, touchMerge, touchPointAim, touchPointSteer, touchPointDead, touchPointThrottle, touchPointBrake, touchPointTurns, touchPointWater, touchPointLap, touchPointWall, surfTraction, surfBuckets, surfWater, surfDirt, surfBelt, surfMounds, surfRivets, surfRespawn, surfValidate, surfLanes, surfBots, surfShipped, surfParity, surfCpu, surfDevFlag, splitWalls, splitIslands, splitProgress, splitValidate, splitBots, splitParity, splitCpu, splitMounds, splitDevFlag]) {
  console.log(`\n# ${t.name}`);
  try {
    t();
  } catch (e) {
    check(`${t.name} threw`, false, String(e));
  }
}
// ---- rolling barrels, crusher presses, the parked ramp truck (M4-MOVE, PLAN-M4.md 2.3, 2.4, section 3, advisor changes 5-7 and 9; ClickUp 123jpnbffz5, 2026-11-22) ----

// This section's imports (hoisted like the ones at the top).
import * as movePhys from "../shared/physics";
import * as moveTrack from "../shared/track";
import * as moveW from "../shared/weapons";
import * as moveBot from "../shared/botdrive";
import * as moveTune from "../tools/debug/move-tune";
import { MOVE_YARD } from "../shared/testtracks";
import { CAR_TYPES as MOVE_CAR_TYPES } from "../shared/cars";
import { statsFor as moveStatsFor } from "../shared/shop";

const moveClock = { t0: 0 };
const moveYard = () => testTrack(MOVE_YARD.id)!;
/** The Move Yard's loop with `features` instead of its own. */
const moveWith = (features: Feature[], recovery: number[] = [0]) => buildTrack({ ...MOVE_YARD, id: "move-test", features, recovery });
/** How far the car's capsule is from barrel k of row b at rt (< 0 = overlapping; NaN: in the gutter). */
function moveBarrelGap(b: moveTrack.PlacedBarrels, k: number, rt: number, c: CarState): number {
  const lat = moveTrack.barrelLat(b, k, rt);
  if (lat !== lat) return NaN;
  const bx = b.x + b.nx * lat, by = b.y + b.ny * lat, ux = Math.cos(c.h), uy = Math.sin(c.h);
  const t = clamp((bx - c.x) * ux + (by - c.y) * uy, -movePhys.CAPSULE_HALF, movePhys.CAPSULE_HALF);
  return Math.hypot(c.x + ux * t - bx, c.y + uy * t - by) - moveTrack.BARREL_R - movePhys.CAPSULE_R;
}
/** The first race tick >= from at which press p is in state `state`. */
function moveTickOf(p: moveTrack.Press, state: number, from = 0): number {
  let rt = from;
  while (moveTrack.pressState(p, rt) !== state) rt++;
  return rt;
}

function moveBarrels(): void {
  moveClock.t0 = performance.now();
  const t = moveYard(), b = t.barrels[0];
  const reach = moveTrack.BARREL_R + movePhys.CAPSULE_R;
  // Push-out and bounce: cars overlapping barrel 0 at rt 30 from 24 directions and 4 headings, at rest
  // or moving: after collideBarrels the capsule just touches it, the speed into the barrel relative to
  // it comes back out x BARREL_RESTITUTION, along it unchanged, the heading never changes.
  const rt = 30, lat = moveTrack.barrelLat(b, 0, rt), bx = b.x + b.nx * lat, by = b.y + b.ny * lat;
  const vbx = b.nx * b.speed, vby = b.ny * b.speed;
  let worst = 0, worstV = 0, cases = 0, heading = true;
  for (let a = 0; a < 24; a++) {
    for (const dh of [0, 0.7, 1.57, 2.6]) {
      for (const v of [0, 250]) {
        const ang = (a / 24) * 2 * Math.PI, d = reach - 4;
        const h = ang + dh;
        const c: CarState = { x: bx + Math.cos(ang) * d, y: by + Math.sin(ang) * d, h, vx: -Math.cos(ang) * v, vy: -Math.sin(ang) * v, seg: b.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
        if (moveBarrelGap(b, 0, rt, c) >= 0) continue;
        const v0x = c.vx, v0y = c.vy;
        movePhys.collideBarrels(c, [b], rt);
        cases++;
        worst = Math.max(worst, Math.abs(moveBarrelGap(b, 0, rt, c)));
        heading &&= c.h === h;
        // The normal: from the barrel to the closest point of the car's axis after the push.
        const ux = Math.cos(c.h), uy = Math.sin(c.h);
        const k = clamp((bx - c.x) * ux + (by - c.y) * uy, -movePhys.CAPSULE_HALF, movePhys.CAPSULE_HALF);
        let nx = c.x + ux * k - bx, ny = c.y + uy * k - by;
        const nl = Math.hypot(nx, ny);
        nx /= nl;
        ny /= nl;
        const in0 = (v0x - vbx) * nx + (v0y - vby) * ny, out = (c.vx - vbx) * nx + (c.vy - vby) * ny;
        const tan0 = -(v0x - vbx) * ny + (v0y - vby) * nx, tan1 = -(c.vx - vbx) * ny + (c.vy - vby) * nx;
        const want = in0 < 0 ? -movePhys.BARREL_RESTITUTION * in0 : in0;
        worstV = Math.max(worstV, Math.abs(out - want), Math.abs(tan1 - tan0));
      }
    }
  }
  check(
    `move barrels: a car capsule is pushed fully out of a barrel (touching after), its speed into it relative to the rolling barrel comes back out x ${movePhys.BARREL_RESTITUTION} (the barrel's velocity is added), along it unchanged; no yaw kick: the heading never changes`,
    cases > 150 && worst < 1e-6 && worstV < 1e-6 && heading,
    `${cases} overlapping cases; largest gap after ${worst.toExponential(2)}, largest velocity error ${worstV.toExponential(2)}`,
  );
  // A barrel is never pushed: its place is barrelLat(rt) alone, before and after cars hit it.
  const before = Array.from({ length: 240 }, (_, r) => moveTrack.barrelLat(b, 0, r));
  const sim = withDevTrack(MOVE_YARD.id, () => moveTune.moveRace(["normal", "normal"], 1, false));
  const after = Array.from({ length: 240 }, (_, r) => moveTrack.barrelLat(b, 0, r));
  check("move barrels: a barrel is never pushed: barrelLat is the same before and after a race of cars", before.every((v, i) => Object.is(v, after[i])) && sim.phase === "results", `race ${sim.phase}`);

  // Advisor change 6, a pinned car: stopped against the right wall at the row of barrels rolling right,
  // every barrel of 3 cycles reaches it. It is squeezed (pushed along the road out of the row), never
  // left overlapping a barrel at the end of a tick, never turned (steer 0, no yaw kick), and never faster
  // than (1 + restitution) x the barrel's speed; it never passes through (its centre stays on its side).
  let overlap = Infinity, maxV = 0, turned = 0, squeezed = 0, flipped = 0, runs = 0;
  for (const ds of [0, 4, -4, 9, -9]) {
    for (const dh of [0, 0.5, -0.5, Math.PI / 2, Math.PI]) {
      const wall = t.wallR[pointAt(t, b.s).seg];
      const c = surfCar(t, b.s + ds, wall - movePhys.CAR_WIDTH / 2, 0, dh);
      const h0 = c.h, side0 = Math.sign(ds || -1);
      const env = moveW.raceEnv(t);
      runs++;
      for (let r = 1; r <= 3 * b.period; r++) {
        env.rt = r;
        const x0 = c.x, y0 = c.y;
        moveW.stepRaceCar(c, { throttle: 0, steer: 0 }, BASE_STATS, env);
        for (let k = 0; k < b.n; k++) {
          const g = moveBarrelGap(b, k, r, c);
          if (g === g) overlap = Math.min(overlap, g);
        }
        maxV = Math.max(maxV, speedOf(c));
        if (c.h !== h0) turned++;
        const q = queryTrackNear(t, c.x, c.y, c.seg);
        if (Math.hypot(c.x - x0, c.y - y0) > 3) squeezed++;
        if (ds !== 0 && Math.sign(q.s - b.s) !== side0) flipped++;
      }
    }
  }
  check(
    "move barrels: a car pinned against the wall where the barrels reach it is squeezed out along the road: never left overlapping a barrel, never turned (no yaw kick spins it up), never faster than twice the barrel's speed (no explosion), never through to the row's other side",
    overlap > -1e-6 && turned === 0 && maxV <= 2 * Math.abs(b.speed) && squeezed > 0 && flipped === 0,
    `${runs} runs of 3 cycles: closest ${overlap.toFixed(6)} (0 = touching), turned ${turned} ticks, top speed ${maxV.toFixed(1)} u/s (barrel ${Math.abs(b.speed)}), ${squeezed} ticks pushed > 3 units, ${flipped} through`,
  );
  // Driven straight at a row from 9 lanes x 12 start ticks at 200..500 u/s: never left overlapping a barrel.
  let worstDrive = Infinity, hits = 0;
  for (let lane = -64; lane <= 64; lane += 16) {
    for (let r0 = 0; r0 < b.period; r0 += 20) {
      for (const v of [200, 350, 500]) {
        const c = surfCar(t, b.s - 120, lane, v);
        const env = moveW.raceEnv(t);
        for (let i = 0; i < 70; i++) {
          env.rt = r0 + i;
          const v0 = speedOf(c);
          moveW.stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, env);
          if (speedOf(c) < v0 - 30) hits++;
          for (let k = 0; k < b.n; k++) {
            const g = moveBarrelGap(b, k, env.rt, c);
            if (g === g) worstDrive = Math.min(worstDrive, g);
          }
        }
      }
    }
  }
  check("move barrels: driven at a row of barrels from 9 lanes, 12 start ticks and 3 speeds, a car is never left overlapping one (hits happen)", worstDrive > -1e-6 && hits > 20, `${hits} hits; closest ${worstDrive.toFixed(6)}`);
}

function moveSolids(): void {
  const t = moveYard();
  // The press: solid only while down. A car at 300 u/s into its middle: while it is down it bounces off
  // the back face with the wall's rule (WALL_BOUNCE, WALL_SCRAPE); while it is up it drives through.
  const g = t.presses[0];
  const into = (rt0: number) => {
    const c = surfCar(t, g.s - 60, -30, 300);
    const env = moveW.raceEnv(t);
    let vMin = Infinity;
    for (let i = 0; i < 30; i++) {
      env.rt = rt0 + i;
      moveW.stepRaceCar(c, { throttle: 0, steer: 0 }, BASE_STATS, env);
      vMin = Math.min(vMin, (c.vx * Math.cos(g.h) + c.vy * Math.sin(g.h)));
    }
    return { s: splitSL(t, c).s, vMin };
  };
  const down = moveTickOf(g, moveTrack.PRESS_DOWN), up = moveTickOf(g, moveTrack.PRESS_UP, down);
  const shut = into(down), open = into(up);
  // The bounce's numbers: a car moving into its back face at v (along the press's heading) comes out at WALL_BOUNCE x v, times the scrape.
  const back = moveTrack.PRESS_DEPTH / 2 + movePhys.CAPSULE_HALF + movePhys.CAPSULE_R - 2, gx = Math.cos(g.h), gy = Math.sin(g.h);
  const c0: CarState = { x: g.x - gx * back + g.nx * -30, y: g.y - gy * back + g.ny * -30, h: g.h, vx: gx * 200, vy: gy * 200, seg: g.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  movePhys.collidePresses(c0, [g], down);
  const vOut = -(c0.vx * Math.cos(g.h) + c0.vy * Math.sin(g.h));
  check(
    `move press: down it is solid (a car bounces off its face: the speed into it back x ${0.35}, then x ${0.97}, as at a wall); up it is not there`,
    shut.s < g.s - moveTrack.PRESS_DEPTH / 2 && shut.vMin < 0 && open.s > g.s + moveTrack.PRESS_DEPTH / 2 + 20 && Math.abs(vOut - 200 * 0.35 * 0.97) < 1e-6,
    `down: stopped at s=${shut.s.toFixed(1)} (face ${g.s - moveTrack.PRESS_DEPTH / 2}), bounced back at ${(-shut.vMin).toFixed(0)} u/s; up: through to s=${open.s.toFixed(0)}; out at ${vOut.toFixed(3)} u/s from 200`,
  );
  // It comes down on a car: every pose under it (along x across x heading) is pushed out to the nearer
  // open side along the road (in front of it or behind it), all the way out, never left inside.
  let trapped = 0, poses = 0, behind = 0, ahead = 0, worstMove = 0;
  for (let ds = -moveTrack.PRESS_DEPTH / 2 - 10; ds <= moveTrack.PRESS_DEPTH / 2 + 10; ds += 2) {
    for (let lat = g.lat0 - 10; lat <= g.lat1 + 10; lat += 6) {
      for (const dh of [0, 0.4, 1.2, Math.PI / 2, 2.5, Math.PI]) {
        const c = surfCar(t, g.s + ds, lat, 0, dh);
        const env = moveW.raceEnv(t, down);
        const x0 = c.x, y0 = c.y;
        moveW.stepRaceCar(c, { throttle: 0, steer: 0 }, BASE_STATS, env);
        poses++;
        const p = moveTune.moveContact(t, c, down, -1e-6);
        if (p === "press") trapped++;
        const q = splitSL(t, c);
        if (Math.hypot(c.x - x0, c.y - y0) > 0.01) {
          if (q.s < g.s) behind++;
          else ahead++;
          worstMove = Math.max(worstMove, Math.hypot(c.x - x0, c.y - y0));
        }
      }
    }
  }
  check(
    "move press: coming down on a car anywhere under it (or partly), any heading, it pushes the car out to the nearer open side (behind it or in front), all the way: never trapped inside",
    trapped === 0 && behind > 50 && ahead > 50,
    `${poses} poses: trapped ${trapped}; pushed behind ${behind}, in front ${ahead}; the largest push ${worstMove.toFixed(1)} units`,
  );

  // The truck: a solid capsule (side hits pushed sideways), its band rides at TRUCK_MIN_SPEED or more.
  const tk = t.trucks[0];
  const run = (lat: number, v: number, throttle: number, ticks = 120) => {
    const c = surfCar(t, tk.s - 150, lat, v);
    const env = moveW.raceEnv(t);
    const evs: string[] = [];
    let air = 0, sideMin = Infinity, vOff = 0;
    for (let i = 0; i < ticks; i++) {
      env.rt = i + 1;
      const v0 = speedOf(c);
      const ev = moveW.stepRaceCar(c, { throttle, steer: 0 }, BASE_STATS, env);
      if (ev) evs.push(ev);
      if (ev === "takeoff") vOff = v0;
      if (c.air > 0 && air === 0) air = c.air;
      const q = splitSL(t, c);
      if (c.air === 0 && q.s > tk.s && q.s < tk.s + tk.len) sideMin = Math.min(sideMin, Math.abs(q.lat - tk.lat));
    }
    return { evs, air, end: splitSL(t, c), sideMin, c, vOff };
  };
  const fast = run(tk.lat, 330, 1), slow = run(tk.lat, 150, 0.2), beside = run(tk.lat + moveTrack.TRUCK_HALF + 2, 330, 1);
  check(
    `move truck: in its band at ${moveTrack.TRUCK_MIN_SPEED} u/s or more a car rides up and takes off at the lip (an ordinary jump: airTicksFor its speed, no x1.3 and no air-total field in CarState); slower the band is solid (it stops at the rear); beside the band its body pushes the car out sideways`,
    fast.evs[0] === "takeoff" && fast.air === moveW.airTicksFor(fast.vOff) - 1 && fast.end.s > tk.s + tk.len + 150 &&
      slow.evs.length === 0 && slow.end.s < tk.s && speedOf(slow.c) < 5 &&
      beside.evs.length === 0 && beside.end.s > tk.s + tk.len && beside.sideMin >= moveTrack.TRUCK_HALF + movePhys.CAR_WIDTH / 2 - 0.5,
    `fast: ${fast.evs.join(",")} at ${fast.vOff.toFixed(0)} u/s (air ${fast.air + 1} ticks = airTicksFor), at s=${fast.end.s.toFixed(0)}; slow: stopped at s=${slow.end.s.toFixed(1)} (rear ${tk.s}); beside: kept ${beside.sideMin.toFixed(1)} off its axis, at s=${beside.end.s.toFixed(0)}`,
  );
  // The band below 220: a car riding up that slows under TRUCK_MIN_SPEED on the band (brakes) is
  // pushed off sideways (the band is solid), never left inside the body. And the lateral lip test: a
  // car at speed just outside the band (truckLipAt false) does not take off, it is a side hit.
  const braked = (() => {
    const c = surfCar(t, tk.s + 10, tk.lat + 3, 235);
    const env = moveW.raceEnv(t);
    const evs: string[] = [];
    for (let i = 0; i < 40; i++) {
      env.rt = i + 1;
      const ev = moveW.stepRaceCar(c, { throttle: -1, steer: 0 }, BASE_STATS, env);
      if (ev) evs.push(ev);
    }
    return { evs, gap: moveTune.moveContact(t, c, 41, -1e-6), lat: splitSL(t, c).lat };
  })();
  const edge = run(tk.band1 + 1, 330, 1);
  check(
    "move truck: the band below 220 u/s is solid: a car braking on it is pushed out of the body sideways (never left inside); a lateral lip test: just outside the band at speed it does not take off",
    braked.evs.length === 0 && braked.gap !== "truck" && Math.abs(braked.lat - tk.lat) >= moveTrack.TRUCK_HALF + movePhys.CAPSULE_R - 0.5 &&
      !moveTrack.truckLipAt(t, tk.lip + 1, tk.band1 + 1) && !!moveTrack.truckLipAt(t, tk.lip + 1, tk.band1) && !edge.evs.includes("takeoff"),
    `braked: ${braked.evs.join(",") || "no event"}, ended ${Math.abs(braked.lat - tk.lat).toFixed(1)} off its axis; at lat ${tk.band1 + 1}: ${edge.evs.join(",") || "no take-off"}`,
  );
  // Airborne cars pass over everything: a flight's velocity is unchanged over a barrel row, a press
  // that is down and the truck (a car launched over each, in the air the whole way).
  const over = (s: number, lat: number, rt0: number) => {
    const c = surfCar(t, s - 60, lat, 400);
    c.air = 40;
    const env = moveW.raceEnv(t);
    const v0 = [c.vx, c.vy];
    for (let i = 0; i < 25; i++) {
      env.rt = rt0 + i;
      moveW.stepRaceCar(c, movePhys.NO_INPUT, BASE_STATS, env);
    }
    return c.vx === v0[0] && c.vy === v0[1] && c.air === 15;
  };
  const b = t.barrels[0];
  check("move air: a car in the air passes over a row of barrels, a press that is down and the truck untouched", over(b.s, 0, 20) && over(b.s, 30, 70) && over(g.s, -30, down - 10) && over(tk.s + 40, tk.lat, 1));
}

function moveLandings(): void {
  // M4-MOVE owns the landing over a solid: a flight that comes down overlapping a solid is not a fall;
  // the next driving step's contact puts the car out of it (never left inside, no speed explosion):
  // a truck (sideways off its body), an island (into the nearer lane: M4-SURF part 2's rule), a tyre
  // mound (pushed out of the circle), a barrel (the same, at the tick it lands), a press that is down
  // (along the road to the nearer open side).
  const yard = moveYard();
  const solids = moveWith([
    { k: "tyres", s: 1000, lat: 0, r: 24 },
    { k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 },
    { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 },
  ]);
  const g = yard.presses[0], tk = yard.trucks[0], b = yard.barrels[0];
  const down = moveTickOf(g, moveTrack.PRESS_DOWN);
  // The barrel at the tick the flight lands (rt 31): where it is then.
  const bl = moveTrack.barrelLat(b, 0, 31);
  const cases: { what: string; t: Track; s: number; lat: number; rt: number; probe: (c: CarState, rt: number) => boolean }[] = [
    { what: "truck (beside its band)", t: yard, s: tk.s + tk.len / 2, lat: tk.band1 + 3, rt: 1, probe: (c, rt) => moveTune.moveContact(yard, c, rt, -1e-6) === "truck" },
    { what: "island", t: solids, s: 6400, lat: 5, rt: 1, probe: (c) => splitTune.islandContact(solids, c) !== null && Math.abs(splitSL(solids, c).lat) < 28 + movePhys.CAR_WIDTH / 2 - 0.01 },
    { what: "tyre mound", t: solids, s: 1000, lat: 3, rt: 1, probe: (c) => surfTune.touchesMound(solids, c) && Math.hypot(c.x - solids.tyres[0].x, c.y - solids.tyres[0].y) < 24 + 8 - 0.01 },
    { what: "barrel", t: yard, s: b.s, lat: bl, rt: 31, probe: (c, rt) => moveTune.moveContact(yard, c, rt, -1e-6) === "barrel" },
    { what: "press", t: yard, s: g.s, lat: -30, rt: down + 2, probe: (c, rt) => moveTune.moveContact(yard, c, rt, -1e-6) === "press" },
  ];
  const rows: string[] = [];
  let ok = true;
  for (const k of cases) {
    // In the air for its last tick, landing on the solid's middle at 300 u/s along the road.
    const c = surfCar(k.t, k.s - 5, k.lat, 300);
    c.air = 1;
    const env = moveW.raceEnv(k.t, k.rt - 1);
    let ev = moveW.stepRaceCar(c, movePhys.NO_INPUT, BASE_STATS, env);
    const landed = c.air === 0 && c.fall === 0 && ev === null, inside = k.probe(c, env.rt);
    let maxV = speedOf(c), outAfter = -1;
    for (let i = 1; i <= 6; i++) {
      env.rt = k.rt - 1 + i;
      ev = moveW.stepRaceCar(c, movePhys.NO_INPUT, BASE_STATS, env);
      maxV = Math.max(maxV, speedOf(c));
      if (outAfter < 0 && !k.probe(c, env.rt)) outAfter = i;
    }
    const good = landed && inside && outAfter === 1 && !k.probe(c, env.rt) && c.fall === 0 && maxV <= 300 * 1.01;
    ok &&= good;
    rows.push(`${k.what}: landed on it ${landed && inside}, out after ${outAfter} driving step(s), top speed ${maxV.toFixed(0)}`);
  }
  // Landing in a truck's band at speed is on its ramp: it rides on and takes off at the lip again.
  const deck = surfCar(yard, tk.s + 30, tk.lat, 300);
  deck.air = 1;
  const env = moveW.raceEnv(yard);
  const evs: string[] = [];
  for (let i = 0; i < 20; i++) {
    env.rt = i + 1;
    const ev = moveW.stepRaceCar(deck, movePhys.NO_INPUT, BASE_STATS, env);
    if (ev) evs.push(ev);
  }
  rows.push(`in the truck's band at 300 u/s: ${evs.join(",")}`);
  check("move landings: a flight that lands overlapping a solid (a truck beside its band, an island, a tyre mound, a barrel, a press that is down) is not a fall; the next driving step puts the car out of it for good, no faster than it came; landing in a truck's band at speed rides its ramp to the lip", ok && evs.join() === "takeoff", rows.join("; "));
}

function moveRivets(): void {
  // Rivets die on solids (PLAN-M4 2.3): on a barrel where barrelLat puts it at the shot's race tick (one
  // that is in the gutter is not there), on a press while it is down (not while it is up), on a truck's body.
  const t = moveYard(), b = t.barrels[0], g = t.presses[0], tk = t.trucks[0];
  const fly = (s: number, lat: number, rt0: number) => {
    const p = pointAt(t, s);
    const sh: moveW.Shot = { id: 1, owner: "x", x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, vx: Math.cos(p.h) * 900, vy: Math.sin(p.h) * 900, seg: p.seg, travelled: 0 };
    let k = 0;
    while (k < 40 && moveW.moveShot(sh, t, rt0 + k)) k++;
    return splitSL(t, sh).s;
  };
  // Barrel 0 near the middle of its run at rt 54 (it has rolled 99 of 198): a rivet aimed at where it
  // will be when the rivet gets there, and one at a tick it is in the gutter.
  const rtHit = 54, latHit = moveTrack.barrelLat(b, 0, rtHit + 6);
  let gutter = 0;
  while (moveTrack.barrelLat(b, 0, gutter + 6) === moveTrack.barrelLat(b, 0, gutter + 6) || [1, 2].some((k) => moveTrack.barrelLat(b, k, gutter + 6) === moveTrack.barrelLat(b, k, gutter + 6) && Math.abs(moveTrack.barrelLat(b, k, gutter + 6) - latHit) < 30)) gutter++;
  const hitB = fly(b.s - 90, latHit, rtHit), missB = fly(b.s - 90, latHit, gutter);
  const down = moveTickOf(g, moveTrack.PRESS_DOWN), up = moveTickOf(g, moveTrack.PRESS_UP, down);
  const hitP = fly(g.s - 120, -30, down), missP = fly(g.s - 120, -30, up);
  const hitT = fly(tk.s - 100, tk.lat, 1);
  check(
    "move rivets: a rivet dies on a barrel where it is at the shot's race tick (passes where it is in the gutter), on a press while it is down (passes while it is up), on a truck's body",
    hitB < b.s + 15 && missB > b.s + 50 && hitP < g.s + 15 && missP > g.s + 50 && hitT < tk.s + 15,
    `barrel: died at s=${hitB.toFixed(0)} (row ${b.s}), gutter: on to ${missB.toFixed(0)}; press down: ${hitP.toFixed(0)}, up: ${missP.toFixed(0)} (at ${g.s}); truck: ${hitT.toFixed(0)} (rear ${tk.s})`,
  );
  // No damage: a race on the Move Yard with weapons off has no hit and no wreck event.
  const evs: GameEvent[] = [];
  withDevTrack(MOVE_YARD.id, () => {
    const sim = new Sim(1);
    const host = sim.add("Host");
    if (sim.room.setTrack(host, MOVE_YARD.id)) throw new Error("dev track refused");
    for (const l of ["normal", "hard"] as BotLevel[]) (sim.room.addBot(host, l, sim.now) as Player).bot!.mem.weapons = false;
    moveBot.MOVE.see = false; // blind: they hit the barrels and presses
    try {
      sim.room.start(host, sim.now);
      while (sim.room.phase !== "racing") sim.tick();
      sim.room.retire(host);
      let n = 0;
      while (sim.room.phase === "racing" && n++ < 60 * 120) sim.tick();
    } finally {
      moveBot.MOVE.see = true;
    }
    evs.push(...sim.events);
  });
  check("move rivets: no damage: two bots blind to the barrels and presses race the Move Yard with weapons off: no hit, no wreck", evs.filter((e) => e.k === "hit" || e.k === "wreck").length === 0 && evs.some((e) => e.k === "finish"), `${evs.length} events: ${[...new Set(evs.map((e) => e.k))].join(",")}`);
}

function moveRespawn(): void {
  // Respawns and recoveries pick the nearest clear lane, away from the barrels' path, the presses and
  // the trucks (clearSpot): a car wrecked anywhere round each is put down clear of it; validation keeps
  // them >= 40 from the recovery points and the grid.
  const t = moveYard();
  const rows: string[] = [];
  let bad = 0, n = 0, moved = 0;
  const clear = (c: CarState) => {
    const box = (s0: number, s1: number, lat0: number, lat1: number) => {
      const q = splitSL(t, c);
      return q.s + 15 > s0 && q.s - 15 < s1 && q.lat + 8 > lat0 && q.lat - 8 < lat1;
    };
    for (const b of t.barrels) if (box(b.s - moveTrack.BARREL_R, b.s + moveTrack.BARREL_R, -Infinity, Infinity)) return false;
    for (const g of t.presses) if (box(g.s - moveTrack.PRESS_DEPTH / 2, g.s + moveTrack.PRESS_DEPTH / 2, g.lat0, g.lat1)) return false;
    for (const k of t.trucks) if (box(k.s, k.s + k.len, k.lat - moveTrack.TRUCK_HALF, k.lat + moveTrack.TRUCK_HALF)) return false;
    return true;
  };
  for (const [what, s0, s1] of [["barrels", t.barrels[0].s - 30, t.barrels[0].s + 30], ["press", t.presses[0].s - 30, t.presses[0].s + 30], ["truck", t.trucks[0].s - 20, t.trucks[0].s + t.trucks[0].len + 20]] as const) {
    let ok = 0, tried = 0;
    for (let s = s0; s <= s1; s += 3) {
      for (const lat of [-50, -20, 0, 20, 50]) {
        const c = surfCar(t, s, lat, 0);
        moveW.wreckCar(c);
        c.wreck = 1;
        moveW.stepRaceCar(c, movePhys.NO_INPUT, BASE_STATS, moveW.raceEnv(t));
        tried++;
        n++;
        if (clear(c) && c.wreck === 0 && Math.abs(splitSL(t, c).lat) <= 64 - 8) ok++;
        else bad++;
        if (Math.abs(splitSL(t, c).s - s) > 1) moved++;
      }
    }
    rows.push(`${what}: ${ok}/${tried} clear`);
  }
  // On a track without them: clearSpot is s and clearLaneAt(s), exactly (shipped tracks and the Surf Yard).
  let same = true;
  for (const tr of [trackById("rust-bowl"), trackById("crusher-run"), surfYard(), splitYard()]) {
    for (let s = 0; s < tr.length; s += 37) same &&= JSON.stringify(moveTrack.clearSpot(tr, s, 4, 20)) === JSON.stringify({ s, lat: moveTrack.clearLaneAt(tr, s, 4, 20) });
  }
  // A recovery: a car that fell is put at the recovery point's clear lane.
  const fell = surfCar(t, 3000, 0, 0);
  fell.fall = 1;
  moveW.stepRaceCar(fell, movePhys.NO_INPUT, BASE_STATS, moveW.raceEnv(t));
  check(
    "move respawn: a car wrecked in a barrel row's path, under a press or at the truck respawns clear of them (on a clear lane, or just behind a row that leaves none); without them clearSpot is clearLaneAt exactly",
    bad === 0 && moved > 20 && same && clear(fell) && Math.hypot(fell.x - pointAt(t, 0).x, fell.y - pointAt(t, 0).y) < 1e-9,
    `${rows.join("; ")} (${moved} of ${n} moved back along the road); the fall recovered at the recovery point s=0`,
  );
  // Validation: what moves keeps SOLID_CLEAR from the recovery points and the grid, and MOVER_CLEAR along
  // the track from every other solid (a press may sit beside an island).
  const errs = (features: Feature[], recovery = [0]) => validateTrack(moveWith(features, recovery)).join(" | ");
  const nearRec = errs([{ k: "barrels", s: 1000, n: 2, period: 200, speed: 100 }], [0, 1030]);
  const nearPress = errs([{ k: "press", s: 3000, lat0: -64, lat1: 0, period: 150, down: 40 }], [0, 2975]);
  const nearTruck = errs([{ k: "truck", s: 5950, lat: 0, len: 110 }], [0, 5930]);
  const rowMound = errs([{ k: "barrels", s: 1000, n: 2, period: 200, speed: 100 }, { k: "tyres", s: 1060, lat: 30, r: 20 }]);
  const pressIsland = errs([{ k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 }, { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 }, { k: "press", s: 6500, lat0: 28, lat1: 124, period: 180, down: 60 }]);
  const pressGap = errs([{ k: "press", s: 3000, lat0: -64, lat1: 95, period: 150, down: 40 }]), pressWall = errs([{ k: "press", s: 3000, lat0: -64, lat1: 108, period: 150, down: 40 }]);
  const rowIsland = errs([{ k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 }, { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 }, { k: "barrels", s: 6940, n: 2, period: 260, speed: 100 }]);
  check(
    `move validate: a barrel row, a press or a truck within ${moveTrack.SOLID_CLEAR} of a recovery point is refused; a row within ${moveTrack.MOVER_CLEAR} along the track of a mound or an island is refused; a press beside an island is fine; a press side short of the wall by less than ${moveTrack.PRESS_SIDE_GAP} is refused, one at the wall is fine; the Move Yard is valid`,
    nearRec.includes("from recovery point") && nearPress.includes("from recovery point") && nearTruck.includes("from recovery point") && rowMound.includes("along the track from tyres") &&
      pressIsland === "" && rowIsland.includes("along the track from island") && pressGap.includes("leaves a gap of 13.0") && pressWall === "" &&
      validateTrack(moveYard()).length === 0 && moveW.validateRunUps(moveYard()).length === 0,
    `row: ${nearRec}; press: ${nearPress}; truck: ${nearTruck}; row by a mound: ${rowMound}; press by an island: ${pressIsland || "valid"}; row past an island: ${rowIsland}; press 13 short of the wall: ${pressGap}; press to the wall: ${pressWall || "valid"}`,
  );
}

function moveSweep(): void {
  // Advisor change 7: the overspeed sweep covers the truck's lip at 473 (the draft) and 537 u/s (a
  // boost) for every car type, at L0 and L3, on the Move Yard and the Preview Yard; and it catches a
  // truck whose boosted flight lands past a bend's wall.
  const rows: string[] = [];
  let ok = true;
  for (const tr of [moveYard(), testTrack(PREVIEW_YARD.id)!]) {
    for (const v of [473, 537]) {
      for (const car of MOVE_CAR_TYPES) {
        for (const lv of [0, 3]) {
          const e = moveW.validateJumpSweep(tr, v, moveStatsFor(car, { engine: lv, tyres: lv, welder: lv }));
          if (e.length) {
            ok = false;
            rows.push(`${tr.def.id} ${v} ${car} L${lv}: ${e.join("; ")}`);
          }
        }
      }
    }
  }
  // A truck left of the centre at the start of the bend into the left-hand side: a fast flight comes
  // down past the bend's wall (from ~456 u/s), a slow one lands.
  const bad = moveWith([{ k: "truck", s: 7300, lat: -30, len: 110 }]);
  const e537 = moveW.validateJumpSweep(bad, 537), e300 = moveW.validateJumpSweep(bad, 300);
  check(
    "move sweep: every truck jump on the Move Yard and the Preview Yard lands at every arrival speed up to 473 and 537 u/s, every car type at L0 and L3; a truck whose boosted flight lands past a wall is caught",
    ok && e537.some((e) => e.includes("truck jump") && e.includes("but not at")) && e300.length === 0,
    `${rows.join(" | ") || "all land"}; a truck at s=7300 lat -30: up to 537: ${e537[0] ?? "none"}; up to 300: ${e300.length} problems`,
  );
}

function moveBuckets(): void {
  // Every barrel row, press and truck a car capsule (any heading, plus a tick) or a rivet's swept tick
  // can touch is in that segment's bucket; on the shipped tracks every bucket is the one frozen empty list.
  const t = moveYard();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let missed = 0, touches = 0;
  for (let i = 0; i < 60_000; i++) {
    const f = [t.barrels[0].s, t.barrels[1].s, t.presses[0].s, t.presses[1].s, t.trucks[0].s, t.trucks[0].s + t.trucks[0].len][i % 6];
    const s = f + (rnd() * 2 - 1) * 60, lat = (rnd() * 2 - 1) * (t.wall - 8);
    const p = pointAt(t, s);
    const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
    const q = queryTrackNear(t, x, y, p.seg);
    const h = rnd() * 2 * Math.PI, ux = Math.cos(h), uy = Math.sin(h);
    const c: CarState = { x, y, h, vx: 0, vy: 0, seg: q.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    for (const b of t.barrels) {
      for (let r = 0; r < b.period; r += 7) {
        for (let k = 0; k < b.n; k++) {
          const g = moveBarrelGap(b, k, r, c);
          if (!(g < 9)) continue; // + a tick at 537 u/s
          touches++;
          if (!t.barrelsAt[q.seg].includes(b)) missed++;
        }
      }
    }
    // A press: the car's capsule plus a tick (or a rivet's swept tick ending here, 24 + its radius) within its box.
    const sq = splitSL(t, c).s;
    for (const g of t.presses) {
      const near = Math.abs(sq - g.s) < moveTrack.PRESS_DEPTH / 2 + Math.max(movePhys.CAPSULE_HALF + movePhys.CAPSULE_R + 9, 24 + moveW.RIVET_RADIUS) && lat > g.lat0 - 40 && lat < g.lat1 + 40;
      if (near && !t.pressesAt[q.seg].includes(g)) missed++;
      if (near) touches++;
    }
    // A truck: a point of the car's axis within its body plus the car's radius and a tick, or a rivet's
    // swept tick (from 24 back along a random heading to here) within its body plus the rivet's radius.
    for (const k of t.trucks) {
      const e = { x: k.x1 - k.x0, y: k.y1 - k.y0 };
      const dist = (px: number, py: number) => {
        const m = clamp(((px - k.x0) * e.x + (py - k.y0) * e.y) / (e.x * e.x + e.y * e.y), 0, 1);
        return Math.hypot(px - k.x0 - e.x * m, py - k.y0 - e.y * m);
      };
      let near = false;
      for (let a = -1; a <= 1 && !near; a += 0.25) near = dist(x + ux * a * movePhys.CAPSULE_HALF, y + uy * a * movePhys.CAPSULE_HALF) < moveTrack.TRUCK_HALF + movePhys.CAPSULE_R + 9;
      for (let a = 0; a <= 1 && !near; a += 0.05) near = dist(x - ux * 24 * a, y - uy * 24 * a) < moveTrack.TRUCK_HALF + moveW.RIVET_RADIUS;
      if (near) {
        touches++;
        if (!t.trucksAt[q.seg].includes(k)) missed++;
      }
    }
    // A barrel: a rivet's swept tick ending here (24 back along the heading) within its radius plus the rivet's.
    for (const b of t.barrels) {
      for (let r = 0; r < b.period; r += 7) {
        for (let k = 0; k < b.n; k++) {
          const bl = moveTrack.barrelLat(b, k, r);
          if (bl !== bl) continue;
          const bx = b.x + b.nx * bl, by = b.y + b.ny * bl;
          let hit = false;
          for (let a = 0; a <= 1 && !hit; a += 0.05) hit = Math.hypot(x - ux * 24 * a - bx, y - uy * 24 * a - by) <= moveTrack.BARREL_R + moveW.RIVET_RADIUS;
          if (!hit) continue;
          touches++;
          if (!t.barrelsAt[q.seg].includes(b)) missed++;
        }
      }
    }
  }
  const shipped = ["rust-bowl", "crusher-run", "overpass-knot"].map((id) => trackById(id));
  const empty = shipped.every((tr) => [tr.barrelsAt, tr.pressesAt, tr.trucksAt].every((at) => at.every((x) => x.length === 0 && x === at[0]) && Object.isFrozen(at[0])));
  check(
    "move buckets: every barrel row, press and truck a car capsule (any heading, plus a tick) or a rivet's swept tick can touch is in that segment's bucket; on the shipped tracks every bucket is one frozen empty list",
    missed === 0 && touches > 1000 && empty,
    `${touches} touches checked, ${missed} missing; shipped empty ${empty}`,
  );
  // The bucketed take-off test (stepRaceCar's) is truckLipAt's: at every point of the band's take-off zone and round it.
  let diff = 0, inZone = 0;
  const tk = t.trucks[0];
  for (let s = tk.lip - 6; s < tk.lip + moveTrack.LIP_ZONE + 6; s += 0.5) {
    for (let lat = tk.band0 - 4; lat <= tk.band1 + 4; lat += 1) {
      const c = surfCar(t, s, lat, 300);
      const q = queryTrackNear(t, c.x, c.y, c.seg);
      const env = moveW.raceEnv(t);
      const ev = moveW.stepRaceCar(cloneCar(c), movePhys.NO_INPUT, BASE_STATS, env);
      const want = !!moveTrack.truckLipAt(t, q.s, q.lat);
      if (want) inZone++;
      if ((ev === "takeoff") !== want) diff++;
    }
  }
  check("move buckets: stepRaceCar takes off from a truck exactly where truckLipAt says (its take-off zone x its band)", diff === 0 && inZone > 200, `${inZone} points in the zone, ${diff} differ`);
}

function moveParity(): void {
  // stepRaceCar on a clone equals the server's pose bit for bit every tick at the room's race tick:
  // lone server bots (each level and type) over 2 laps of the Move Yard, seeing and blind to the barrels
  // and presses (blind: they hit them), and one thrown at a barrel row, a press while it is down and the truck.
  const rows: string[] = [];
  let all = true, contacts = 0;
  withDevTrack(MOVE_YARD.id, () => {
    for (const see of [true, false]) {
      for (const [level, car, slot] of [["easy", "sport", 0], ["normal", "racer", 1], ["hard", "truck", 2]] as const) {
        const sim = new Sim(2);
        const host = sim.add("Host");
        if (sim.room.setTrack(host, MOVE_YARD.id)) throw new Error("dev track refused");
        const bots: Player[] = [];
        for (let k = 0; k <= slot; k++) bots.push(sim.room.addBot(host, level, sim.now) as Player);
        const b = bots[slot];
        for (const o of bots) if (o !== b) sim.room.kick(host, o.id, sim.now);
        if (sim.room.setCar(host, car, b.id)) throw new Error("car");
        b.wallet.ammo.rivets = 0;
        b.wallet.ammo.mines = 0;
        sim.room.start(host, sim.now);
        while (sim.room.phase !== "racing") sim.tick();
        sim.room.retire(host);
        const t = sim.room.track;
        let ctl: moveBot.BotControls | null = null;
        surfServerBots.botTrace.fn = (p, c) => {
          if (p === b) ctl = c;
        };
        moveBot.MOVE.see = see;
        let ticks = 0, mismatch = 0, first = "", hit = 0;
        try {
          while (sim.room.phase === "racing" && ticks < 60 * 120) {
            const clone = cloneCar(b.car!);
            sim.tick();
            ticks++;
            if (!b.car || sim.room.phase !== "racing") break;
            const c = ctl as moveBot.BotControls | null;
            moveW.stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, moveW.raceEnv(t, sim.room.rt, 0));
            const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
            if (!keys.every((k) => Object.is(clone[k], b.car![k]))) {
              mismatch++;
              if (!first) first = `tick ${ticks}: ${keys.filter((k) => !Object.is(clone[k], b.car![k])).join(",")}`;
            }
            if (b.car.air === 0 && moveTune.moveContact(t, b.car, sim.room.rt)) hit++;
          }
        } finally {
          surfServerBots.botTrace.fn = null;
          moveBot.MOVE.see = true;
        }
        contacts += hit;
        const good = mismatch === 0 && ticks > 60 * 30 && b.progress!.fin > 0;
        all &&= good;
        rows.push(`${see ? "seeing" : "blind"} ${level} ${car}: ${ticks} ticks, ${mismatch} mismatches${first ? ` (${first})` : ""}, ${hit} contact ticks`);
      }
    }
    // A lone server bot thrown at a row of barrels (at a tick a barrel crosses its lane), a press as it
    // comes down and the truck's band slow and fast, and at its side.
    const sim = new Sim(1);
    const host = sim.add("Host");
    if (sim.room.setTrack(host, MOVE_YARD.id)) throw new Error("dev track refused");
    const b = sim.room.addBot(host, "normal", sim.now) as Player;
    b.wallet.ammo.rivets = 0;
    b.wallet.ammo.mines = 0;
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const t = sim.room.track;
    let ctl: moveBot.BotControls | null = null;
    surfServerBots.botTrace.fn = (p, c) => {
      if (p === b) ctl = c;
    };
    let mismatch = 0, hits = 0;
    try {
      const tk = t.trucks[0];
      for (const [s, lat, v, dh] of [[t.barrels[0].s - 40, 30, 300, 0], [t.barrels[1].s - 30, -20, 250, 0.3], [t.presses[0].s - 30, -30, 200, 0], [t.presses[1].s - 10, 30, 100, 0], [tk.s - 30, tk.lat, 150, 0], [tk.s - 30, tk.lat, 350, 0], [tk.s + 30, tk.lat + 40, 200, -0.8]] as const) {
        const p = pointAt(t, s), h = p.h + dh;
        b.car = { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h, vx: Math.cos(h) * v, vy: Math.sin(h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
        moveBot.MOVE.see = false;
        for (let k = 0; k < 60; k++) {
          const clone = cloneCar(b.car);
          sim.tick();
          const c = ctl as moveBot.BotControls | null;
          moveW.stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, moveW.raceEnv(t, sim.room.rt, 0));
          const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
          if (!keys.every((kk) => Object.is(clone[kk], b.car![kk]))) mismatch++;
          if (b.car.air === 0 && moveTune.moveContact(t, b.car, sim.room.rt)) hits++;
        }
      }
    } finally {
      surfServerBots.botTrace.fn = null;
      moveBot.MOVE.see = true;
    }
    all &&= mismatch === 0 && hits > 0;
    rows.push(`a bot thrown at the barrels, the presses and the truck: ${mismatch} mismatches, ${hits} contact ticks`);
  });
  console.log(`  ${rows.join("\n  ")}`);
  check("move parity: stepRaceCar on a clone at the room's race tick equals the server's pose bit for bit every tick: a lone server bot per level and type over 2 laps of the Move Yard, seeing and blind to the barrels and presses, and one thrown at each", all && contacts > 0, rows.join(" | "));
  // The client's prediction over the wire, no lag: three socket-bot cars (Sport, Racer, Truck on lines
  // -24, 0, 24) race 1 lap of the Move Yard at their predicted race tick.
  const r = withDevTrack(MOVE_YARD.id, () => carsClientLap(MOVE_YARD.id));
  check(
    `move parity: three client cars (Sport, Racer, Truck) racing the Move Yard over the wire predict it exactly (barrels and presses at their predicted race tick): no state mismatch, no error > ${LARGE_ERR}`,
    r.ticks.every((x) => x > 0) && r.stateErrs === 0 && r.large === 0 && r.samples > 500 && r.same,
    `laps ${r.ticks.map((x) => (x / 60).toFixed(1)).join("/")} s; ${r.samples} samples, ${r.stateErrs} state mismatches, ${r.large} > ${LARGE_ERR}, max ${r.maxErr.toFixed(4)}`,
  );
}

/** The bounds on the Move Yard's bot races (moveBots): per bot, weapons off, then on (a mine or a rivet can spin a bot into one). */
const MOVE_BOUNDS = { off: { barrel: 0, press: 0, truck: 0 }, on: { barrel: 4, press: 4, truck: 4 } };

function moveBots(): void {
  // Easy, Normal and Hard (Sport, Racer, Truck by add order) race 3 laps of the Move Yard: every bot
  // finishes with no fall, contacts within MOVE_BOUNDS, identically on a rerun. The bot on the seat whose
  // line is in the truck's band jumps it every lap, the others go round; with the barrels and presses
  // unseen (MOVE.see false) they hit them (the baseline the dodging is measured against).
  const rows: string[] = [];
  let ok = true;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  for (const weapons of [false, true]) {
    const bound = weapons ? MOVE_BOUNDS.on : MOVE_BOUNDS.off;
    for (const level of ["easy", "normal", "hard"] as BotLevel[]) {
      const a = moveTune.moveRace([level, level, level], 3, weapons), b = moveTune.moveRace([level, level, level], 3, weapons);
      const good = a.phase === "results" && a.finish.length === 3 && a.falls.every((x) => x === 0) && a.digest === b.digest &&
        a.barrels.every((x) => x <= bound.barrel) && a.presses.every((x) => x <= bound.press) && a.trucks.every((x) => x <= bound.truck) &&
        a.jumps[1] >= 3 && a.jumps[0] === 0 && a.jumps[2] === 0;
      ok &&= good;
      rows.push(`${level}${weapons ? " +weapons" : ""}: ${a.finish.join(" ")}, falls ${sum(a.falls)}, barrel ${a.barrels.join("/")} press ${a.presses.join("/")} truck ${a.trucks.join("/")}, jumps ${a.jumps.join("/")}${a.digest === b.digest ? "" : " RERUN DIFFERS"}`);
    }
  }
  const five = moveTune.moveRace(["hard", "normal", "easy", "hard", "normal"], 3, true);
  const fiveOk = five.phase === "results" && five.finish.length === 5 && five.falls.every((x) => x === 0) && five.digest === moveTune.moveRace(["hard", "normal", "easy", "hard", "normal"], 3, true).digest &&
    five.barrels.every((x) => x <= MOVE_BOUNDS.on.barrel) && five.presses.every((x) => x <= MOVE_BOUNDS.on.press) && five.trucks.every((x) => x <= MOVE_BOUNDS.on.truck);
  rows.push(`5 bots +weapons: falls ${sum(five.falls)}, barrel ${five.barrels.join("/")} press ${five.presses.join("/")} truck ${five.trucks.join("/")}, jumps ${five.jumps.join("/")}`);
  moveBot.MOVE.see = false;
  let blind: moveTune.MoveRace;
  try {
    blind = moveTune.moveRace(["normal", "normal", "normal"], 3, false);
  } finally {
    moveBot.MOVE.see = true;
  }
  console.log(`  ${rows.join("\n  ")}\n  blind normal: barrel ${blind.barrels.join("/")} press ${blind.presses.join("/")}`);
  check(
    `move bots: Easy, Normal and Hard finish 3 laps of the Move Yard with no fall, identically on a rerun; per bot at most ${MOVE_BOUNDS.off.barrel}/${MOVE_BOUNDS.off.press}/${MOVE_BOUNDS.off.truck} barrel/press/truck contact ticks with weapons off, ${MOVE_BOUNDS.on.barrel}/${MOVE_BOUNDS.on.press}/${MOVE_BOUNDS.on.truck} with them on (5 bots too); the seat on the truck's band jumps it every lap, the others go round`,
    ok && fiveOk,
    rows.join(" | "),
  );
  check("move bots: blind to the barrels and presses (MOVE.see false) Normal bots hit them: the dodging and the timing are what keeps the seeing bots off them", sum(blind.barrels) > 0 && sum(blind.presses) > 0, `barrel ${blind.barrels.join("/")}, press ${blind.presses.join("/")}`);
  // Wait at a press that leaves no lane (wall to wall): a lone bot stops short of it while it is down and
  // drives through once it is up, without touching it.
  const t = moveWith([{ k: "press", s: 3000, lat0: -108, lat1: 108, period: 200, down: 90 }]);
  const run = (rt0: number) => {
    const c = surfCar(t, 2400, 0, 380);
    const mem = moveBot.newBotMem(0, "normal");
    mem.weapons = false;
    const env = moveW.raceEnv(t);
    let touched = 0, stood = 0, passed = -1;
    for (let i = 0; i < 600 && passed < 0; i++) {
      env.rt = rt0 + i;
      const ctl = moveBot.botControls({ car: c, track: t, stats: BASE_STATS, raceOn: true, raceSteps: i, others: [], rt: env.rt }, mem);
      moveW.stepRaceCar(c, ctl, BASE_STATS, env);
      if (moveTune.moveContact(t, c, env.rt)) touched++;
      if (speedOf(c) < 20) stood++;
      if (splitSL(t, c).s > 3040) passed = env.rt;
    }
    return { touched, stood, passed };
  };
  const waits = [0, 40, 80, 120, 160].map(run);
  check(
    "move bots: at a press across the whole road a bot brakes and waits short of it while it will be down, then drives through: never touching it, from 5 start ticks",
    waits.every((w) => w.touched === 0 && w.passed > 0) && waits.some((w) => w.stood > 20),
    waits.map((w) => `stood ${w.stood} ticks, through at rt ${w.passed}, touched ${w.touched}`).join("; "),
  );
}

function moveShipped(): void {
  // The shipped tracks: no barrels, presses or trucks, so nothing about them changes (schema-hash
  // --check, surfShipped above, holds every part SAME); the preview test tracks still validate with
  // what moves now solid; the Preview Yard keeps its features (M4-WORLD draws them).
  const shipped = ["rust-bowl", "crusher-run", "overpass-knot"].map((id) => trackById(id));
  check(
    "move shipped: no shipped track has a barrel, a press or a truck; every test track validates and its run-ups work",
    shipped.every((t) => t.barrels.length + t.presses.length + t.trucks.length === 0) && TEST_TRACKS.every((d) => validateTrack(testTrack(d.id)!).length === 0 && moveW.validateRunUps(testTrack(d.id)!).length === 0),
  );
}

function moveCpu(): void {
  // No scan per tick: barrels, presses and trucks in per-segment buckets. Five server bots (Easy, Normal,
  // Hard, Normal, Hard), 3 laps of the Move Yard: the median bot step and room tick beside the
  // M4-SURF-2 numbers (bot step 0.00129 ms, room tick 0.0134 ms on the Split Yard).
  const r = withDevTrack(MOVE_YARD.id, () => {
    const sim = new Sim(3);
    const host = sim.add("Host");
    sim.room.setTrack(host, MOVE_YARD.id);
    for (const l of ["easy", "normal", "hard", "normal", "hard"] as BotLevel[]) sim.room.addBot(host, l, sim.now);
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const tickMs: number[] = [];
    const steps: number[] = [];
    botTiming.samples = steps;
    let ticks = 0;
    try {
      while (sim.room.phase === "racing" && ticks < 60 * 300) {
        sim.tickNo++;
        sim.now += 1000 / 60;
        const t0 = performance.now();
        sim.room.tick(sim.tickNo, sim.now);
        tickMs.push(performance.now() - t0);
        ticks++;
      }
    } finally {
      botTiming.samples = null;
    }
    return { tickMs, steps, phase: sim.room.phase as string };
  });
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const med = pct(r.steps, 0.5), tickMed = pct(r.tickMs, 0.5);
  console.log(`  CPU (Move Yard): bot step median ${med.toFixed(5)} ms, p99 ${pct(r.steps, 0.99).toFixed(5)} ms over ${r.steps.length} steps; room tick with 5 bots median ${tickMed.toFixed(4)} ms, p99 ${pct(r.tickMs, 0.99).toFixed(4)} ms (M4-SURF-2 on the Split Yard: bot step 0.00129 ms, room tick 0.0134 ms)`);
  check(
    "move CPU: on the Move Yard the median bot step stays within the M4-BOTS bound (0.2 ms; target 0.05) and the room tick with 5 bots is printed beside the M4-SURF-2 numbers",
    r.steps.length > 5 * 3000 && med <= 0.05 && r.phase === "results",
    `median bot step ${med.toFixed(5)} ms; room tick median ${tickMed.toFixed(4)} ms`,
  );
  // stepCar at a barrel row, a press that is down and the truck costs about what a step on a plain track does.
  const t = moveYard(), g = t.presses[0];
  const down = moveTickOf(g, moveTrack.PRESS_DOWN);
  const time = (tr: Track, s: number, lat: number, rt: number) => {
    const c = surfCar(tr, s, lat, 300);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const d = { ...c };
      stepCar(d, { throttle: 1, steer: 0.1 }, BASE_STATS, tr, 0, rt);
    }
    return ((performance.now() - t0) / 20_000) * 1000;
  };
  const plain = time(trackById("rust-bowl"), 3000, 0, 0), row = time(t, t.barrels[0].s - 20, 0, 30), press = time(t, g.s - 30, -30, down), truck = time(t, t.trucks[0].s + 50, t.trucks[0].lat + 30, 0);
  console.log(`  stepCar: ${plain.toFixed(3)} us on Rust Bowl, ${row.toFixed(3)} us at a barrel row, ${press.toFixed(3)} us at a press that is down, ${truck.toFixed(3)} us beside the truck`);
  console.log(`  M4-MOVE sim-test sections' runtime (moveBarrels .. moveDevFlag): ${((performance.now() - moveClock.t0) / 1000).toFixed(1)} s`);
}

function moveDevFlag(): void {
  // SCRAP_DEV_TRACK=move-yard: a new room starts on the Move Yard; unset, it is refused as unknown.
  const on = withDevTrack(MOVE_YARD.id, () => {
    const rooms = new Rooms(1);
    const x = { conn: new FakeConn(), room: null, player: null } as Session;
    rooms.onMessage(x, { t: "create", name: "Ann" }, 1000);
    return { id: x.room!.trackId, same: x.room!.track === testTrack(MOVE_YARD.id), flag: surfRoom.devTrackId() };
  });
  const off = withDevTrack(undefined, () => {
    const sim = new Sim();
    const host = sim.add("Host");
    return sim.room.setTrack(host, MOVE_YARD.id);
  });
  check(
    "move dev flag: SCRAP_DEV_TRACK=move-yard starts a new room on the Move Yard; unset (the default, and on Render) the host cannot pick it",
    on.id === MOVE_YARD.id && on.same && on.flag === MOVE_YARD.id && off === "Unknown track",
    `${JSON.stringify(on)}; unset: ${off}`,
  );
}

function moveDraw(): void {
  // Where what moves is drawn (PLAN-M4 section 3): Game.drawTick, the race tick main.ts gives the
  // renderer (WorldFx.rt), is the race tick the server applies the step that made the drawn own car
  // at (zero lag, over the wire: every frame of a lap of the Move Yard); a spectator (retired, no car)
  // gets the latest snapshot's; before the first snapshot there is none (a still picture).
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const out = withDevTrack(MOVE_YARD.id, () => {
      const rooms = new Rooms(1);
      const ws = [wiredGame(rooms, clock), wiredGame(rooms, clock)];
      const before = ws[0].game.drawTick();
      ws[0].game.create("Car0");
      ws[0].open();
      ws[0].flush();
      const room = [...rooms.rooms.values()][0];
      ws[1].game.join(room.code, "Car1");
      ws[1].open();
      for (const w of ws) w.flush();
      ws[1].game.setReady(true);
      for (const w of ws) w.flush();
      ws[0].game.start();
      ws[0].flush();
      const driver = new BotDriver(ws[1].game, 0);
      driver.weapons = false;
      // The server's race tick for each of Car1's inputs (by seq, at the tick it applied it).
      const truth = new Map<number, number>();
      const tick = room.tick.bind(room);
      let last = -1;
      room.tick = (t: number, now: number) => {
        tick(t, now);
        const p = room.players.get(ws[1].game.you);
        if (p && p.car && p.ack !== last && room.phase === "racing") {
          last = p.ack;
          truth.set(p.ack, room.rt);
        }
      };
      const drawn = new Map<number, number | undefined>();
      let retired = false, spectator = 0, spectatorOk = 0;
      for (let i = 0; i < 60 * 60 && !room.players.get(ws[1].game.you)?.progress?.fin; i++) {
        clock.now += 1000 / 60;
        rooms.step(clock.now);
        for (const w of ws) w.flush();
        ws[0].game.step(NO_CONTROLS, 1000 / 60);
        ws[1].game.step(driver.controls(), 1000 / 60);
        if (room.phase === "racing") drawn.set(ws[1].game.seq - 1, ws[1].game.drawTick());
        if (room.phase === "racing" && !retired && room.rt > 30) {
          ws[0].game.retire();
          retired = true;
        }
        if (retired && !ws[0].game.car && ws[0].game.latest) {
          spectator++;
          if (ws[0].game.drawTick() === ws[0].game.latest.rtBase) spectatorOk++;
        }
      }
      let same = 0, n = 0;
      for (const [seq, rt] of truth) {
        if (!drawn.has(seq)) continue;
        n++;
        if (drawn.get(seq) === rt) same++;
      }
      return { before, same, n, spectator, spectatorOk };
    });
    check(
      "move draw: Game.drawTick (WorldFx.rt) is the race tick the server applied the step that made the drawn own car at, every frame of a lap (zero lag); a spectator's is the latest snapshot's; none before a snapshot",
      out.before === undefined && out.n > 1000 && out.same === out.n && out.spectator > 100 && out.spectatorOk === out.spectator,
      `${out.same}/${out.n} frames; spectator ${out.spectatorOk}/${out.spectator}`,
    );
  } finally {
    performance.now = realNow;
  }
}

function moveReview1(): void {
  // M4-MOVE review 1 (part 1, dc42d82): its findings' repros, now refused or handled.
  // F1: a press 18 before an island's nose (Split Yard, island A at s 820) is refused; one beside an island still validates.
  const split = (features: Feature[]) => validateTrack(buildTrack({ ...SPLIT_YARD, id: "move-r1-split", features: [...SPLIT_YARD.features!, ...features] })).join(" | ");
  const before = split([{ k: "press", s: 790, lat0: -30, lat1: 30, period: 160, down: 50 }]);
  const beside = split([{ k: "press", s: 1200, lat0: 22, lat1: 112, period: 160, down: 50 }]);
  check(
    "move review F1: a press 18 before an island (Split Yard, island at s 820) is refused (MOVER_CLEAR along the track); one beside an island (sharing its s) still validates",
    before.includes("press at s=790.0") && before.includes("along the track from island") && beside === "",
    `before: ${before}; beside: ${beside || "valid"}`,
  );
  // F2: Move Yard + a hole r14 at s 760/770/775 (it validates): a car wrecked in the s 800 row's path
  // respawns off the hole (the recovery point), and does not fall on its next steps.
  const rows: string[] = [];
  let f2 = true;
  for (const hs of [760, 770, 775]) {
    const t = moveWith([...MOVE_YARD.features!, { k: "hole", s: hs, lat: 0, r: 14 }]);
    const valid = validateTrack(t).length === 0;
    const c = surfCar(t, 800, 0, 0);
    moveW.wreckCar(c);
    c.wreck = 1;
    const env = moveW.raceEnv(t);
    moveW.stepRaceCar(c, movePhys.NO_INPUT, BASE_STATS, env);
    const at = splitSL(t, c);
    const over = moveTrack.overHazard(t, c.x, c.y, at.s);
    let fell = false;
    for (let i = 0; i < 30; i++) {
      env.rt = i + 1;
      if (moveW.stepRaceCar(c, { throttle: 0.3, steer: 0 }, BASE_STATS, env) === "fall") fell = true;
    }
    f2 &&= valid && !over && !fell;
    rows.push(`hole at s ${hs}: valid ${valid}, respawned at s=${at.s.toFixed(1)} lat ${at.lat.toFixed(1)}, over a hazard ${over}, fell ${fell}`);
  }
  check("move review F2: with a hole just behind a barrel row (it validates), a car wrecked in the row's path is never put back over the hole (the recovery point instead) and does not fall", f2, rows.join("; "));
  // F3: a rivet fired from a car riding the truck's band passes the truck (as the car does); one fired from
  // behind the truck, or from a car nosing into its side, dies on it.
  const yard = moveYard(), tk = yard.trucks[0];
  const fire = (s: number, lat: number, dh = 0) => {
    const c = surfCar(yard, s, lat, 330, dh);
    const sh = moveW.spawnShot(c, 1, "x");
    let k = 0;
    while (k < 60 && moveW.moveShot(sh, yard, 100 + k)) k++;
    return { k, s: splitSL(yard, sh).s, far: sh.travelled };
  };
  const band = [-10, 10, 40, 70].map((d) => fire(tk.s + d, tk.lat)); // a car on the band (rear +d)
  const behind = fire(tk.s - 80, tk.lat), side = fire(tk.s + 50, tk.lat + moveTrack.TRUCK_HALF + 16, -1.2);
  // Review 2 (F3-edge): rivets fired from behind straight along the truck's axis, at every lane across
  // -16..16 (truck frame, step 0.5) and 30 phases (100-115 behind its rear): none passes the truck (before
  // the fix, ones at |across| 9.5-14 came round the body's round rear corner into the band and passed).
  const ex = tk.x1 - tk.x0, ey = tk.y1 - tk.y0, el = Math.hypot(ex, ey), tux = ex / el, tuy = ey / el;
  const rx = tk.x0 - tux * moveTrack.TRUCK_HALF, ry = tk.y0 - tuy * moveTrack.TRUCK_HALF; // the rear's middle
  let edgePass = 0, edgeRuns = 0;
  for (let c = -16; c <= 16; c += 0.5) {
    for (let ph = 0; ph < 15; ph += 0.5) {
      const back = 100 + ph, x = rx - tux * back - tuy * c, y = ry - tuy * back + tux * c;
      const sh: moveW.Shot = { id: 1, owner: "x", x, y, vx: tux * 900, vy: tuy * 900, seg: queryTrackNear(yard, x, y, pointAt(yard, tk.s - back).seg).seg, travelled: 0 };
      let k = 0;
      while (k < 40 && moveW.moveShot(sh, yard, 100 + k)) k++;
      edgeRuns++;
      if ((sh.x - rx) * tux + (sh.y - ry) * tuy > tk.len + 10) edgePass++;
    }
  }
  // A rivet fired back at the truck's front from ahead of it, down the band's lane: dies on the truck.
  const ahead = (() => {
    const c = surfCar(yard, tk.s + tk.len + 60, tk.lat, 0, Math.PI);
    const sh = moveW.spawnShot(c, 1, "x");
    let k = 0;
    while (k < 60 && moveW.moveShot(sh, yard, 100 + k)) k++;
    return { k, s: splitSL(yard, sh).s };
  })();
  check(
    "move review F3: a rivet fired from a car riding the truck's band passes the truck (from rear -10, +10, +40, +70 it flies its range); one fired from 80 behind, from behind at any lane across -16..16 (the round rear corners: review 2), from a car nosing into its side, or back at its front from ahead dies on the truck",
    band.every((b) => b.s > tk.s + tk.len + 20 && b.far > 300) && behind.k <= 6 && behind.s < tk.s + 15 && side.k <= 2 && ahead.k <= 6 && ahead.s > tk.s + tk.len - 15 &&
      edgeRuns === 1950 && edgePass === 0,
    `band: ${band.map((b) => `${b.k} ticks to s=${b.s.toFixed(0)}`).join(", ")}; behind: ${behind.k} ticks to s=${behind.s.toFixed(0)}; side: ${side.k} ticks; back at its front from ahead: ${ahead.k} ticks to s=${ahead.s.toFixed(0)}; from behind at every lane across -16..16 x 30 phases: ${edgePass}/${edgeRuns} pass`,
  );
  // F4: a truck whose side leaves a gap to the wall narrower than TRUCK_SIDE_GAP is refused (14, 6, 18);
  // one reaching the wall, or leaving 24, validates.
  const truckAt = (lat: number) => validateTrack(moveWith([{ k: "truck", s: 5950, lat, len: 110 }])).join(" | ");
  const wall = moveYard().wall; // 108 on the plain road there
  const gaps = [14, 6, 18, 0, 24].map((g) => ({ g, e: truckAt(wall - moveTrack.TRUCK_HALF - g) }));
  check(
    `move review F4: a truck side short of the wall by less than ${moveTrack.TRUCK_SIDE_GAP} is refused (gaps 14, 6, 18), one reaching the wall or leaving ${moveTrack.TRUCK_SIDE_GAP} validates`,
    gaps.slice(0, 3).every((x) => x.e.includes(`leaves a gap of ${x.g}.0`)) && gaps.slice(3).every((x) => x.e === ""),
    gaps.map((x) => `gap ${x.g}: ${x.e || "valid"}`).join("; "),
  );
  // Note (botdrive): the band takes one car at a time. Two bots on lines 24 and 12 (both in the band)
  // side by side on the approach: the one behind gives the jump up and goes round; with the yield off
  // (MOVE.truckYield huge) both go for the band.
  const pair = (yieldOn: boolean) => {
    const was = moveBot.MOVE.truckYield;
    if (!yieldOn) moveBot.MOVE.truckYield = 1e9;
    try {
      const a = surfCar(yard, tk.s - 480, 24, 400), b = surfCar(yard, tk.s - 515, 12, 400); // 35 apart: not touching at the start
      const ma = moveBot.newBotMem(24, "normal"), mb = moveBot.newBotMem(12, "normal");
      ma.weapons = mb.weapons = false;
      const env = moveW.raceEnv(yard);
      let jumps = 0, truck = 0, bump = 0;
      for (let i = 0; i < 150; i++) {
        env.rt = 500 + i;
        const view = (c: CarState, o: CarState) => ({ car: c, track: yard, stats: BASE_STATS, raceOn: true, raceSteps: 500 + i, others: [{ x: o.x, y: o.y, solid: o.air === 0, id: "o", vx: o.vx, vy: o.vy }], rt: env.rt });
        const ca = moveBot.botControls(view(a, b), ma), cb = moveBot.botControls(view(b, a), mb);
        for (const [c, ctl] of [[a, ca], [b, cb]] as const) if (moveW.stepRaceCar(c, ctl, BASE_STATS, env) === "takeoff") jumps++;
        if (a.air === 0 && b.air === 0 && collideCars(a, b)) bump++;
        for (const c of [a, b]) if (c.air === 0 && moveTune.moveContact(yard, c, env.rt) === "truck") truck++;
      }
      return { jumps, truck, bump, s: [splitSL(yard, a).s, splitSL(yard, b).s] };
    } finally {
      moveBot.MOVE.truckYield = was;
    }
  };
  const on = pair(true), off = pair(false);
  check(
    "move review note: two bots whose lines are both in the truck's band arriving together: the one behind gives the jump up and goes round (one take-off, no truck contact, no bump); with the yield off both go for the band",
    on.jumps === 1 && on.truck === 0 && on.bump === 0 && on.s.every((x) => x > tk.s + tk.len) && off.jumps + off.truck + off.bump > on.jumps,
    `yield on: ${on.jumps} take-off(s), truck contacts ${on.truck}, bumps ${on.bump}; off: ${off.jumps} take-offs, truck contacts ${off.truck}, bumps ${off.bump}`,
  );
  // Note (game.ts): a spectator's drawTick is clamped at 0 in the countdown (the own car's already was).
  const g = new Game(() => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }) as unknown as Transport, { get: () => null, set() {} });
  g.latest = { time: 0, rtBase: -95, rtOpen: true, cars: new Map(), shots: new Map(), mines: [] };
  const countdown = g.drawTick();
  g.latest.rtBase = 37;
  const racing = g.drawTick();
  check("move review note: a spectator's drawTick is 0 in the countdown (rtBase < 0) and the snapshot's race tick while racing", countdown === 0 && racing === 37, `countdown ${countdown}, racing ${racing}`);
}

for (const t of [moveBarrels, moveSolids, moveLandings, moveRivets, moveRespawn, moveSweep, moveBuckets, moveParity, moveBots, moveShipped, moveDraw, moveReview1, moveCpu, moveDevFlag]) {
  console.log(`\n# ${t.name}`);
  try {
    t();
  } catch (e) {
    check(`${t.name} threw`, false, String(e));
  }
}

// ---- branch roads as data (BR-SCHEMA, PLAN-BRANCH.md 2.1-2.5, 2.8-2.10, advisor changes 1-3, 7, 8; ClickUp 123jpnbfgh9, 2026-11-22) ----

// This section's imports (hoisted like the ones at the top).
import * as brT from "../shared/track";
import * as brPhys from "../shared/physics";
import { BRANCH_YARD } from "../shared/testtracks";
import { unionProbe as brUnion } from "../tools/debug/branch-yard";

const brClock = { t0: 0 };
const brYard = () => testTrack(BRANCH_YARD.id)!;
const brShippedIds = ["rust-bowl", "crusher-run", "overpass-knot", "slag-harbour", "breakers-mile"]; // M4-TRACKS added the last two
/** Branch Yard's three branches as declared: the dirt cut, the jump cut, the narrow cut. */
const brDefs = () => BRANCH_YARD.features!.filter((f): f is brT.Branch => f.k === "branch");
/** Branch Yard's loop with these branches and main-road features (and its own recovery points, or these). */
const brWith = (branches: brT.Branch[], main: Feature[] = [], recovery = BRANCH_YARD.recovery) =>
  buildTrack({ ...BRANCH_YARD, id: "branch-test", features: [...main, ...branches], recovery });
const brErrs = (branches: brT.Branch[], main: Feature[] = [], recovery = BRANCH_YARD.recovery) => validateTrack(brWith(branches, main, recovery)).join(" | ");
const brF = (v: number) => v.toFixed(1);

function brTypes(): void {
  brClock.t0 = performance.now();
  // Criterion 1: the types. Every track without a branch: none, no mouthAt, road 0 (shipped and test tracks).
  const plain = [...brShippedIds.map((id) => trackById(id)), ...TEST_TRACKS.filter((d) => d.id !== BRANCH_YARD.id).map((d) => testTrack(d.id)!)];
  const plainErrs = plain.flatMap((t) => validateTrack(t).map((e) => `${t.def.id}: ${e}`));
  check(
    "branch types: every track without a branch (the five shipped ones, Slag Harbour and Breaker's Mile included, and the other test tracks) has branches [], mouthAt [] and roadNo 0, its queries road 0, and validateTrack (with the branch checks) accepts it",
    plain.every((t) => t.branches.length === 0 && t.mouthAt.length === 0 && t.roadNo === 0 && queryTrack(t, t.pts[5].x + 3, t.pts[5].y).road === 0) &&
      plainErrs.length === 0 && brShippedIds.every((id) => trackList().some((e) => e.id === id)),
    `${plain.map((t) => t.def.id).join(", ")}${plainErrs.length ? `; ${plainErrs.join(" | ")}` : ""}`,
  );
  const t = brYard();
  const n = t.pts.length;
  let base = n;
  const shape = t.branches.map((b, k) => {
    const r = b.road, m = r.pts.length, segs = m - 1;
    const ok = b.base === base && r.roadNo === k + 1 && r.branches.length === 0 && r.cum.length === m && r.halfL.length === m && r.wallR.length === m &&
      r.surfAt.length === segs && r.tyresAt.length === segs && r.islandsAt.length === segs && r.barrelsAt.length === segs && r.trucksAt.length === segs &&
      brT.segCount(r) === segs && b.mapS.length === m && b.forkGore !== null && b.mergeGore !== null && b.side === 1 && b.s0 === brDefs()[k].s0 && b.s1 === brDefs()[k].s1;
    base += segs;
    return { ok, segs };
  });
  check(
    "branch types: Branch Yard has 3 PlacedBranch {road, base, s0, s1, side, forkGore, mergeGore, mapS}; each road is an open Track (roadNo k + 1, m samples, m - 1 segments in every per-segment list); bases follow the main road's n segments",
    t.branches.length === 3 && shape.every((x) => x.ok) && t.mouthAt.length === base,
    `n ${n}, bases ${t.branches.map((b) => b.base).join(", ")}, segments ${shape.map((x) => x.segs).join(", ")}, global ${t.mouthAt.length}`,
  );
  // Branch cells after the main road's (the snapshot order: shipped indices never move).
  const [a] = brDefs();
  const ct = brWith([{ ...a, features: [...a.features!, { k: "cell", s: 1700, lat: 50 }] }], [{ k: "cell", s: 2000, lat: -58 }]);
  const own = ct.branches[0].road.cells[0], app = ct.cells[1];
  check(
    "branch types: a branch's cells come after the main road's in track.cells (road = its road, seg = its global segment, s in u); the branch road keeps its own (seg on it); the main road's cell stays index 0",
    ct.cells.length === 2 && ct.cells[0].s === 2000 && ct.cells[0].road === undefined && app.road === 1 && app.s === 1700 && app.seg === ct.branches[0].base + own.seg && app.x === own.x && app.y === own.y && own.road === undefined && validateTrack(ct).length === 0,
    `cells ${ct.cells.map((c) => `${c.road ?? 0}:${c.s}@${c.seg}`).join(", ")}; the branch's own ${own.s}@${own.seg}; ${validateTrack(ct).join(" | ") || "valid"}`,
  );
}

function brBuild(): void {
  const t = brYard();
  // Criterion 2: the curve through main(s0 - 100), main(s0), the control points, main(s1), main(s1 + 100).
  const curve = t.branches.map((b, k) => {
    const r = b.road, d = brDefs()[k], f = pointAt(t, b.s0), m = pointAt(t, b.s1), last = r.pts[r.pts.length - 1];
    const ends = r.pts[0].x === f.x && r.pts[0].y === f.y && last.x === m.x && last.y === m.y;
    const through = d.control.every((c, i) => r.pts[16 * (i + 1)].x === c[0] && r.pts[16 * (i + 1)].y === c[1]);
    return ends && through && r.pts.length === 16 * (d.control.length + 1) + 1;
  });
  check("branch build: each branch's centreline starts at main(s0) and ends at main(s1) exactly, passes through its control points (16 samples a span), open", curve.every(Boolean), curve.join(","));
  // Open road: s clamps (no wrap), the window clamps, the last sample's direction is the last segment's.
  const r = t.branches[0].road, m = r.pts.length;
  const pa = pointAt(r, -80), pb = pointAt(r, r.length + 80), q = queryTrack(r, r.pts[m - 1].x + 60, r.pts[m - 1].y + 5);
  const qn = queryTrackNear(r, r.pts[m - 1].x, r.pts[m - 1].y, m + 30), d0 = brT.segDir(r, m - 1), d1 = brT.segDir(r, m - 2);
  check(
    "branch build: an open road never wraps: pointAt before 0 / past its length is its first / last point, a query past its end stays on its last segment (no closing segment), a window past the end is clamped, segDir of the last sample is the last segment's",
    pa.x === r.pts[0].x && pa.y === r.pts[0].y && pa.seg === 0 && pb.x === r.pts[m - 1].x && pb.seg === m - 2 && q.seg === m - 2 && q.road === 1 && qn.seg === m - 2 && d0.x === d1.x && d0.y === d1.y,
    `pointAt(-80) seg ${pa.seg}, pointAt(L + 80) seg ${pb.seg}, query past the end seg ${q.seg} (s ${brF(q.s)} of ${brF(r.length)}), window seg ${qn.seg}`,
  );
  // Equal mouth widths to the gore, a WIDEN_TAPER taper, then its own width (advisor 2: halfOf / wallOf read them).
  const widths = t.branches.map((b) => {
    const r = b.road, fg = b.forkGore!, mg = b.mergeGore!, own = r.def.halfWidth, main = t.def.halfWidth;
    let mouth = true, middle = true, taper = true;
    for (let i = 0; i < r.pts.length; i++) {
      const u = r.cum[i];
      const hs = [r.halfL[i], r.halfR[i]], ws = [r.wallL[i], r.wallR[i]];
      if (u <= fg.u || u >= mg.u) mouth &&= hs.every((h) => h === main) && ws.every((w) => w === t.wall);
      else if (u >= fg.u + brT.WIDEN_TAPER && u <= mg.u - brT.WIDEN_TAPER) middle &&= hs.every((h) => h === own) && ws.every((w) => w === own + t.def.verge);
      else taper &&= hs.every((h) => h <= main && h >= own);
    }
    const qm = queryTrackNear(r, r.pts[3].x + 2, r.pts[3].y + 30, 3), mid = r.pts.length >> 1, qo = queryTrackNear(r, r.pts[mid].x + 2, r.pts[mid].y + 2, mid);
    const reads = brT.halfOf(r, qm) === main && brT.wallOf(r, qm) === t.wall && brT.halfOf(r, qo) === own && brT.wallOf(r, qo) === own + t.def.verge;
    return { ok: mouth && middle && taper && reads && r.widens.length >= 2, own, w: `${brF(brT.halfOf(r, qm))}/${brF(brT.halfOf(r, qo))}` };
  });
  check(
    "branch build: in each mouth (fork to gore, gore to merge) the branch's half-widths and walls equal the main road's (64, 108) at every sample; past the gores' tapers its own (56, 56, 40); halfOf / wallOf of a query read them (non-empty widens)",
    widths.every((x) => x.ok),
    widths.map((x) => `own ${x.own}: halfOf mouth/middle ${x.w}`).join("; "),
  );
  // The gores' noses: a tyre stack in both roads' buckets, in neither road's tyres list.
  const noses = t.branches.flatMap((b) => [b.forkGore!, b.mergeGore!].map((g) => {
    const inMain = t.tyresAt.filter((l) => l.includes(g.noseMain)).length, inBranch = b.road.tyresAt.filter((l) => l.includes(g.noseBranch)).length;
    const same = g.noseMain.x === g.noseBranch.x && g.noseMain.y === g.noseBranch.y && g.noseMain.r === brT.GORE_NOSE_R && g.noseBranch.r === brT.GORE_NOSE_R;
    return { ok: inMain > 0 && inBranch > 0 && same && !t.tyres.includes(g.noseMain) && !b.road.tyres.includes(g.noseBranch) && Math.abs(g.noseMain.lat - b.side * t.wall) < 2, inMain, inBranch, lat: g.noseMain.lat };
  }));
  check(
    "branch build: each gore has a tyre-stack nose (radius GORE_NOSE_R, half-way between the centrelines: at the main road's wall on the branch's side) in both roads' tyre buckets and in neither road's tyres list",
    noses.length === 6 && noses.every((x) => x.ok),
    noses.map((x) => `${x.inMain}/${x.inBranch} segs, lat ${brF(x.lat)}`).join("; "),
  );
  // A nose is a mound to the physics: a car driving into it is pushed out (collideTyres on the bucket).
  const g = t.branches[0].forkGore!, at = t.tyresAt.findIndex((l) => l.includes(g.noseMain));
  const c: CarState = { x: g.x - 30, y: g.y - 6, h: 0, vx: 200, vy: 0, seg: at, wreck: 0, air: 0, fall: 0, boost: 0 };
  let hit = 0;
  for (let k = 0; k < 20; k++) {
    c.x += c.vx * DT;
    hit += brPhys.collideTyres(c, t.tyresAt[at]) > 0 ? 1 : 0;
  }
  check("branch build: a car driven into a gore's nose bounces off it (collideTyres on the main road's bucket)", hit > 0 && Math.hypot(c.x - g.x, c.y - g.y) >= g.noseMain.r + brPhys.CAPSULE_R - 1e-6, `hits ${hit}, ends ${brF(Math.hypot(c.x - g.x, c.y - g.y))} from its centre`);
}

function brMaps(): void {
  const t = brYard();
  // Criterion 3: mapS, mainS, mouthAt, queryRoads, recoveryAt / recoveryFor.
  const maps = t.branches.map((b) => {
    const r = b.road, fg = b.forkGore!, mg = b.mergeGore!;
    let inc = true, proj = 0, lin = 0, hint = pointAt(t, b.s0).seg;
    for (let i = 1; i < b.mapS.length; i++) inc &&= b.mapS[i] > b.mapS[i - 1];
    for (let i = 0; i < r.pts.length; i++) {
      const u = r.cum[i];
      const q = queryTrackNear(t, r.pts[i].x, r.pts[i].y, hint);
      hint = q.seg;
      if (u <= fg.u && i > 0) proj = Math.max(proj, Math.abs(b.mapS[i] - q.s));
      else if (u > fg.u && u < mg.u) lin = Math.max(lin, Math.abs(b.mapS[i] - (fg.s + ((u - fg.u) * (mg.s - fg.s)) / (mg.u - fg.u))));
    }
    return { ok: inc && b.mapS[0] === b.s0 && b.mapS[b.mapS.length - 1] === b.s1 && proj === 0 && lin < 1e-9, proj, lin };
  });
  check(
    "branch mapS: strictly increasing, s0 at the fork and s1 at the merge, the main road's projection in the fork mouth (exactly), linear in u between the gores",
    maps.every((x) => x.ok),
    maps.map((x) => `projection off ${x.proj}, linear off ${x.lin.toExponential(1)}`).join("; "),
  );
  // mainS: q.s on the main road; on a branch mapS interpolated, so in a mouth (its segments wholly before
  // the gore) it is within a unit of the main road's own query there (the projection; between samples a
  // chord's). In the gore's own segment it runs on toward the linear part (advisor change 9: a road flip
  // moves s a little); along the whole branch it never goes back and never jumps.
  let worst = 0, mainSame = true, steps = 0, back = 0, leap = 0;
  for (const b of t.branches) {
    const r = b.road;
    let prev = -Infinity;
    for (let u = 0; u <= r.length; u += 3) {
      const p = pointAt(r, u), s = brT.mainS(t, queryTrackNear(r, p.x, p.y, p.seg));
      if (s < prev) back++;
      if (prev > -Infinity) leap = Math.max(leap, s - prev);
      prev = s;
    }
    for (let u = 1; r.cum[pointAt(r, u).seg + 1] <= b.forkGore!.u; u += 7) {
      const p = pointAt(r, u);
      const qb = queryTrackNear(r, p.x, p.y, p.seg), qm = queryTrackNear(t, p.x, p.y, pointAt(t, b.s0 + u).seg);
      worst = Math.max(worst, Math.abs(brT.mainS(t, qb) - qm.s));
      mainSame &&= brT.mainS(t, qm) === qm.s;
      steps++;
    }
  }
  check(
    "branch mainS: q.s on the main road; on a branch in a mouth within 1 of the main road's own s at that point; along a whole branch never back, never more than 6 in 3 units of u",
    worst < 1 && mainSame && back === 0 && leap <= 6,
    `${steps} mouth points, worst ${worst.toFixed(4)}; along the branches ${back} steps back, largest step ${leap.toFixed(2)}`,
  );
  // mouthAt: -1 away from mouths, the other road's segment near them; no mouth window shared.
  const n = t.pts.length;
  const far = [pointAt(t, 1000).seg, pointAt(t, 14000).seg, ...t.branches.map((b) => b.base + (brT.segCount(b.road) >> 1))];
  let pairs = 0, near = true;
  for (let g = 0; g < t.mouthAt.length; g++) {
    const o = t.mouthAt[g];
    if (o < 0) continue;
    pairs++;
    const ra = brT.roadOfSeg(t, g), rb = brT.roadOfSeg(t, o);
    const pa = brT.roadOf(t, ra).pts[brT.localSeg(t, g)], pb = brT.roadOf(t, rb).pts[brT.localSeg(t, o)];
    near &&= (ra === 0) !== (rb === 0) && Math.hypot(pa.x - pb.x, pa.y - pb.y) < 2 * brT.LOCAL_WINDOW * 60;
  }
  const mouthMain = t.branches.every((b) => t.mouthAt[pointAt(t, b.s0 + 50).seg] >= b.base && t.mouthAt[pointAt(t, b.s1 - 50).seg] >= b.base && t.mouthAt[b.base + 1] >= 0 && t.mouthAt[b.base] < n);
  check(
    "branch mouthAt: one entry per global segment; -1 far from every mouth; a fork's and a merge's segments (and LOCAL_WINDOW round them) on either road point at a segment of the other road nearby",
    far.every((g) => t.mouthAt[g] === -1) && mouthMain && near && pairs > 0,
    `${pairs} segments in mouth windows of ${t.mouthAt.length}; far ones ${far.map((g) => t.mouthAt[g]).join(",")}`,
  );
  // queryRoads without branches is today's query exactly.
  let same = 0, differ = 0;
  for (const id of brShippedIds) {
    const s = trackById(id);
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i].x + 37.3, y = s.pts[i].y - 21.1;
      const a = queryTrackNear(s, x, y, i), b = brT.queryRoads(s, x, y, i), c = queryTrack(s, x, y), d = brT.queryRoads(s, x, y);
      const eq = a.dist === b.dist && a.s === b.s && a.seg === b.seg && a.nx === b.nx && a.side === b.side && c.dist === d.dist && c.seg === d.seg && c.s === d.s;
      if (eq) same++;
      else differ++;
    }
  }
  check("branch queryRoads: on a track without branches it is queryTrackNear (with a hint) and queryTrack (without) exactly", differ === 0 && same > 0, `${same} points the same, ${differ} differ`);
  // On Branch Yard: without a hint the nearer road; with a hint on either road near a mouth (the branch's
  // segment, or the main road's beside it) the same road and distance: physics and the bake agree.
  let pts = 0, agree = 0, nearest = 0;
  const bad: string[] = [];
  for (const b of t.branches) {
    const r = b.road;
    for (const [u0, u1] of [[0, b.forkGore!.u + 250], [b.mergeGore!.u - 250, r.length]]) {
      for (let u = u0; u <= u1; u += 9) {
        const p = pointAt(r, u);
        for (let lat = -150; lat <= 150; lat += 10) {
          const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
          const g = brT.queryRoads(t, x, y);
          const qm = queryTrack(t, x, y), qb = queryTrack(r, x, y);
          if (g.dist === Math.min(qm.dist, qb.dist)) nearest++;
          const hints = [b.base + p.seg, pointAt(t, brT.mainS(t, queryTrackNear(r, x, y, p.seg))).seg];
          for (const h of hints) {
            const q = brT.queryRoads(t, x, y, h);
            pts++;
            // On an exact tie (the fork and merge points lie on both roads) the hint's road keeps it.
            const tie = queryTrack(t, x, y).dist === queryTrack(r, x, y).dist;
            if ((q.road === g.road || tie) && Math.abs(q.dist - g.dist) < 1e-9) agree++;
            else if (bad.length < 3) bad.push(`u ${brF(u)} lat ${lat} hint ${h}: road ${q.road} ${brF(q.dist)} vs ${g.road} ${brF(g.dist)}`);
          }
        }
      }
    }
  }
  check(
    "branch queryRoads: round every mouth (to 250 past each gore) the hinted query, from the branch's segment or the main road's beside it, finds the same road (on an exact tie the hint's) and distance as the whole-track one (the nearer centreline)",
    agree === pts && pts > 0 && nearest === pts / 2,
    `${agree}/${pts} hinted queries agree, ${nearest} nearest${bad.length ? `; ${bad.join("; ")}` : ""}`,
  );
  // recoveryAt on an open road (advisor 3): no undefined, no wrap; recoveryFor (user decision 6).
  const jump = t.branches[1], jr = jump.road, dirt = t.branches[0].road;
  const ra = [brT.recoveryAt(dirt, 1000), brT.recoveryAt(jr, 100), brT.recoveryAt(jr, 900), brT.recoveryAt(jr, jr.length + 500), brT.recoveryAt(jr, -40)];
  const mainBefore = brT.recoveryAt(t, jump.s0);
  const rf = [brT.recoveryFor(t, 2, 100), brT.recoveryFor(t, 2, 1500), brT.recoveryFor(t, 1, 1500), brT.recoveryFor(t, 0, 9000)];
  check(
    "branch recovery: on an open road recoveryAt is the last point at or before u, -1 when none is (none at all, or u before the first; never undefined, never the last one wrapped); recoveryFor goes back to the main road's recovery point before the fork then (user decision 6)",
    ra.join() === "-1,-1,850,850,-1" && rf[0].road === 0 && rf[0].s === mainBefore && mainBefore > 0 && mainBefore < jump.s0 && rf[1].road === 2 && rf[1].s === 850 &&
      rf[2].road === 0 && rf[2].s === recoveryAt(t, t.branches[0].s0) && rf[3].road === 0 && rf[3].s === recoveryAt(t, 9000),
    `recoveryAt ${ra.join(", ")}; recoveryFor ${rf.map((x) => `${x.road}:${x.s}`).join(", ")}`,
  );
  // The union (advisor 1): a point is inside the nearer road's wall exactly when it is inside either corridor.
  const u = brUnion(t);
  check("branch union: round every mouth of Branch Yard, a point is inside the nearer road's wall (queryRoads) exactly when it is inside either road's corridor", u.wrong === 0 && u.probes > 100000, `${u.probes} points, ${u.wrong} disagree${u.first.length ? `: ${u.first.join("; ")}` : ""}`);
}

function brRules(): void {
  // Criterion 4: one def per rule that breaks it; Branch Yard and each of its branches alone validate.
  const [a, b, c] = brDefs();
  const good = [brErrs([a]), brErrs([b]), brErrs([c]), validateTrack(brYard()).join(" | ")];
  check("branch rules: Branch Yard and each of its three branches alone validate", good.every((e) => e === ""), good.map((e) => e || "valid").join(" / "));
  const rule = (name: string, bad: string, want: string) => check(`branch rule: ${name}`, bad.includes(want), bad.slice(0, 600));
  rule("a branch not shorter than the main road from its fork to its merge is refused",
    brErrs([{ ...a, control: [[5000, 680], [5250, 820], [5600, 1030], [5000, 2600], [6170, 1600], [6380, 1950], [6520, 2200]] }]), "not shorter than the main road's 3408.9");
  rule("a branch narrower than BRANCH_HALF_MIN (36) is refused", brErrs([{ ...a, halfWidth: 30 }]), "half-width 30 is narrower than 36");
  rule("centrelines meeting at more than GORE_ANGLE_MAX (35 degrees) at a gore are refused", brErrs([{ ...a, control: [[4950, 720], [5150, 900], ...a.control.slice(2)] }]), "meet at 47.1 degrees at its fork gore");
  rule("a mouth longer than MOUTH_LEN_MAX (600) is refused", brErrs([{ ...a, control: [[5100, 640], [5400, 700], [5800, 860], ...a.control.slice(3)] }]), "its fork mouth is 984.2 long");
  rule("a mapS that is not strictly increasing is refused (a branch that starts backwards)", brErrs([{ ...a, control: [[4700, 760], ...a.control.slice(1)] }]), "mapS is not strictly increasing at branch sample 1");
  rule("corridors of different roads that overlap outside a mouth are refused",
    brErrs([{ ...a, control: [[5000, 680], [5250, 820], [5600, 1030], [6000, 760], [6170, 1600], [6380, 1950], [6520, 2200]] }]), "their corridors overlap (by 7.6) outside a mouth");
  rule("corridors of different roads less than BRANCH_SEP (40) apart outside the mouths and noses are refused",
    brErrs([{ ...a, control: [[5000, 680], [5250, 820], [5600, 1030], [6330, 1450], [6380, 1950], [6520, 2200]] }]), "their corridors are 32.0 apart, less than 40 (outside the mouths and the gores' noses)");
  rule("a corridor not BRANCH_SEP clear within MOUTH_CLEAR past its gore is refused (the nose zone is bounded)",
    brErrs([{ ...a, control: [[5000, 680], [5250, 820], [5600, 836], [6000, 836], [6170, 1600], [6380, 1950], [6520, 2200]] }]), "is not 40 clear of the main road's within 300 past its fork gore");
  const wide = brWith([{ ...a, halfWidth: 120, features: [] }]);
  const wideUnion = brUnion(wide);
  rule(`past a gore a gap between the corridors under the walls' difference is refused (advisor 1; a 240-wide branch: ${wideUnion.wrong} of ${wideUnion.probes} union probes disagree)`,
    validateTrack(wide).join(" | ") + (wideUnion.wrong > 0 ? "" : " (NO UNION DISAGREEMENT)"), "past a gore their corridors are 28.0 apart, less than the walls' difference 46.6");
  rule("a branch feature within MOUTH_CLEAR (300) of a gore is refused", brErrs([{ ...a, features: [{ k: "dirt", s0: 600, s1: 780, lat0: -56, lat1: 56 }] }]), "dirt 600.0..780.0: outside u 794.3..1836.0");
  rule("a branch recovery point in a mouth is refused", brErrs([{ ...a, recovery: [300] }]), "recovery point u=300.0 is in a mouth");
  rule("a main-road feature in a mouth or within MOUTH_CLEAR of its gore is refused (advisor 7)",
    brErrs([a], [{ k: "tyres", s: 4200, lat: 0, r: 20 }, { k: "dirt", s0: 4500, s1: 4600, lat0: -64, lat1: 64 }]), "tyres at s=4200.0: in a mouth of branch 1 or within 300 of its gore");
  rule("past the gore too (a main-road dirt patch past the fork gore, within MOUTH_CLEAR)", brErrs([a], [{ k: "dirt", s0: 4500, s1: 4600, lat0: -64, lat1: 64 }]), "dirt 4500.0..4600.0: in a mouth of branch 1 or within 300 of its gore");
  rule("a branch without a recovery point before its first hazard is refused", brErrs([{ ...b, recovery: [1500] }]), "no recovery point before its first hazard at u=1150.0");
  rule("a branch solid within SOLID_CLEAR (40) of a branch recovery point is refused",
    brErrs([{ ...c, features: [...c.features!, { k: "tyres", s: 900, lat: 0, r: 20 }] }]), "tyres at s=900.0: 30.0 from recovery point s=850.0 (solids keep >= 40)");
  rule("a branch that leaves on the other side than its declared side is refused", brErrs([{ ...a, side: -1 }]), "it leaves the main road on its right at its fork, not on side -1");
  rule("a branch whose corridor never parts from the main road's is refused",
    brErrs([{ k: "branch", s0: 3000, s1: 4300, side: 1, halfWidth: 56, control: [[3500, 650], [3900, 650]] }]), "its corridor never parts from the main road's past its fork");
  rule("two mouths within a search window of each other are refused (mouthAt has one answer)",
    brErrs([a, { ...b, s0: 7700, control: [[6520, 2900], ...b.control.slice(1)] }]), "the merge of branch 1 and the fork of branch 2 are within 12 segments of each other on the main road");
  rule("a fork in the start zone is refused", brErrs([{ ...a, s0: 100 }]), "its fork or merge is in the start zone or off the lap");
  // Review 1: a branch road gets the crossing checks too (no wrap on an open road), and no bend tighter than
  // its inside's reach (the reviewer's repro, a fold: samples u 1303.2 and u 1707.1 are 123.2 apart with
  // walls 100; its overlapping corridor pieces all lie within 378 along it, under the crossing check's
  // SAME_SECTION reach of 400, so the bend rule is what refuses it).
  rule("a branch whose corridor folds over itself (a bend tighter than its inside's reach) is refused (review 1's repro)",
    brErrs([{ ...a, features: [], control: [[5000, 680], [5250, 820], [5600, 1030], [5950, 1400], [5850, 1350], [6100, 1420], [6380, 1950], [6520, 2200]] }]),
    "a car centre reaches 92.0 (the wall less half a car) on the inside of the bend at u=1430.9, not below the local radius 21.1 (its corridor folds over itself)");
  rule("a branch that crosses itself is refused (the crossing check on each branch road, u not wrapped)",
    brErrs([{ ...a, features: [], control: [[5000, 680], [5250, 820], [5600, 1030], [6150, 1400], [6100, 1900], [5700, 1950], [5550, 1550], [5950, 1350], [6350, 1700], [6520, 2200]] }]),
    "ground corridors overlap at u=1160.0 and u=3300.8 (cover one with a gap)");
}

function brYardCheck(): void {
  // Criterion 5: Branch Yard: a dirt cut (<= ~350 of dirt), a jump cut, a narrow cut with holes; one out of
  // sight; plain road between; validates; picked with SCRAP_DEV_TRACK=branch-yard.
  const t = brYard();
  const [dirt, jump, narrow] = t.branches;
  const far = t.branches.map((b) => {
    const r = b.road;
    let out = 0;
    for (let i = 1; i < r.pts.length; i++) if (queryTrack(t, r.pts[i].x, r.pts[i].y).dist > 450) out += r.cum[i] - r.cum[i - 1];
    return out;
  });
  const gains = t.branches.map((b) => b.s1 - b.s0 - b.road.length);
  const dirtLen = dirt.road.dirt.map((d) => d.s1 - d.s0);
  const ok =
    t.def.features!.every((f) => f.k === "branch") &&
    dirt.road.dirt.length === 1 && dirtLen[0] <= 350 && dirt.road.dirt[0].lat0 <= -dirt.road.def.halfWidth && dirt.road.dirt[0].lat1 >= dirt.road.def.halfWidth &&
    jump.road.ramps.length === 1 && jump.road.gaps.length === 1 && jump.road.recovery.some((r) => r < jump.road.ramps[0].s) &&
    narrow.road.def.halfWidth < t.def.halfWidth && narrow.road.def.halfWidth >= brT.BRANCH_HALF_MIN && narrow.road.holes.length >= 2 &&
    gains.every((g) => g > 0) && far.some((f) => f > 0) && validateTrack(t).length === 0 && validateRunUps(t).length === 0;
  check(
    "branch yard: three shortcuts (a dirt cut with one 340 stretch of dirt across it, a jump cut with a recovery point before its ramp, a 80-wide cut with pits), all shorter, out of sight of the main road in their middles, nothing on the main road; validateTrack and validateRunUps pass",
    ok,
    `gains ${gains.map(brF).join(", ")} units; dirt ${dirtLen.map(brF).join(",")}; out of sight (> 450 from the main centreline) ${far.map(brF).join(", ")} units; half-widths ${t.branches.map((b) => b.road.def.halfWidth).join(", ")}`,
  );
  const on = withDevTrack(BRANCH_YARD.id, () => {
    const rooms = new Rooms(1);
    const x = { conn: new FakeConn(), room: null, player: null } as Session;
    rooms.onMessage(x, { t: "create", name: "Ann" }, 1000);
    return { id: x.room!.trackId, same: x.room!.track === testTrack(BRANCH_YARD.id), flag: surfRoom.devTrackId() };
  });
  const off = withDevTrack(undefined, () => {
    const sim = new Sim();
    const host = sim.add("Host");
    return sim.room.setTrack(host, BRANCH_YARD.id);
  });
  check(
    "branch yard: SCRAP_DEV_TRACK=branch-yard starts a new room on Branch Yard; unset (the default, and on Render) the host cannot pick it; it is not in the lobby's list",
    on.id === BRANCH_YARD.id && on.same && on.flag === BRANCH_YARD.id && off === "Unknown track" && !trackList().some((e) => e.id === BRANCH_YARD.id),
    `${JSON.stringify(on)}; unset: ${off}`,
  );
  console.log(`  BR-SCHEMA sim-test sections' runtime (brTypes .. brYardCheck): ${((performance.now() - brClock.t0) / 1000).toFixed(1)} s`);
}

for (const t of [brTypes, brBuild, brMaps, brRules, brYardCheck]) {
  console.log(`\n# ${t.name}`);
  try {
    t();
  } catch (e) {
    check(`${t.name} threw`, false, String(e));
  }
}

// ---- M4-TRACKS (ClickUp 123jpnbffz6): the two long tracks, Slag Harbour and Breaker's Mile ----------
// This section's imports (hoisted like the ones at the top).
import { BREAKERS_MILE, SLAG_HARBOUR } from "../shared/longtracks";
import * as longW from "../shared/weapons";
import * as longDensity from "../tools/debug/track-density";
import * as longBot from "../shared/botdrive";
import { CAR_TYPES as LONG_CAR_TYPES } from "../shared/cars";
import { statsFor as longStatsFor } from "../shared/shop";
import { isTrackId as longIsTrackId, trackName as longTrackName } from "../shared/tracks";
import { draftTopSpeed as longDraftTop, boostTopSpeed as longBoostTop } from "../shared/catchup";

const LONG_IDS = ["slag-harbour", "breakers-mile"];
const longClock = { t0: 0 };

function longRegistry(): void {
  longClock.t0 = performance.now();
  // Both in the registry after the three shipped tracks (their order and ids stay), with their names
  // (the lobby lists trackList()'s names), and a host can pick them with no dev flag.
  const list = trackList();
  const ids = list.map((e) => e.id);
  const okOrder = ids.indexOf("slag-harbour") === 3 && ids.indexOf("breakers-mile") === 4 && ids.slice(0, 3).join() === "rust-bowl,crusher-run,overpass-knot";
  const named = list[3]?.name === "Slag Harbour" && list[4]?.name === "Breaker's Mile" && longTrackName("slag-harbour") === "Slag Harbour" && longTrackName("breakers-mile") === "Breaker's Mile";
  const defs = trackById("slag-harbour").def === SLAG_HARBOUR && trackById("breakers-mile").def === BREAKERS_MILE;
  const picked = withDevTrack(undefined, () => {
    const sim = new Sim(1);
    const host = sim.add("Host");
    const out = LONG_IDS.map((id) => {
      const e = sim.room.setTrack(host, id);
      return `${id}: ${e ?? `room on ${sim.room.trackId}`}`;
    });
    return out;
  });
  check(
    "long tracks: Slag Harbour and Breaker's Mile are in the registry after the three shipped tracks (order and ids kept), named in the lobby's list, and a host picks them with no dev flag",
    okOrder && named && defs && LONG_IDS.every(longIsTrackId) && picked.every((m, i) => m === `${LONG_IDS[i]}: room on ${LONG_IDS[i]}`),
    `${ids.join(", ")}; ${list.map((e) => e.name).join(", ")}; ${picked.join("; ")}`,
  );
}

function longValidate(): void {
  // Every car type at L0 and L3: the layout (validateTrack: the schema rules for surfaces, mounds, splits,
  // barrels, the press and the truck), the run-ups from rest (validateRunUps, through every pool in a
  // run-up and each split lane), every jump and the truck's at overspeed (validateJumpSweep at the
  // slipstream's 473 and a boost's 537 u/s), the air cells reachable (validateCells up to 537).
  const draft = longDraftTop(430), boost = longBoostTop(430);
  const rows: string[] = [];
  let ok = true;
  for (const id of LONG_IDS) {
    const t = trackById(id);
    const errs = [...validateTrack(t), ...longW.validateCells(t, boost)];
    for (const car of LONG_CAR_TYPES) {
      for (const lv of [0, 3]) {
        const st = longStatsFor(car, { engine: lv, tyres: lv, welder: lv });
        errs.push(...longW.validateRunUps(t, st).map((m) => `${car} L${lv}: ${m}`));
        for (const v of [draft, 473, 537, boost]) errs.push(...longW.validateJumpSweep(t, v, st).map((m) => `${car} L${lv} at ${v.toFixed(1)}: ${m}`));
      }
    }
    ok &&= errs.length === 0;
    rows.push(`${id}: length ${t.length.toFixed(0)}, ${t.ramps.length} ramp(s), ${t.trucks.length} truck(s), ${t.islands.length} split(s), ${t.cells.length} cells; ${errs.length ? errs.join(" | ") : "valid"}`);
  }
  check(
    `long tracks validate for every car type at L0 and L3: validateTrack, validateRunUps, validateJumpSweep at ${draft.toFixed(1)} and 473 (slipstream), 537 and ${boost.toFixed(1)} u/s (boost) (ramps and the truck), validateCells up to ${boost.toFixed(1)}`,
    ok && Math.round(draft) === 473 && Math.floor(boost) === 537,
    rows.join("; "),
  );
  // Recovery points: the start line listed, one before every hazard (each jump and each pit is driven
  // from the one before it by validateRunUps), and none on a solid or in the water (validateTrack).
  const rec = LONG_IDS.map((id) => {
    const t = trackById(id);
    const hazards = [...t.ramps.map((r) => r.s), ...t.holes.map((h) => h.s - h.r)];
    const before = hazards.every((s) => t.recovery.some((r) => r < s && s - r < 1500));
    return { id, ok: t.def.recovery?.[0] === 0 && before && t.recovery.length >= 4, rec: t.recovery.join(",") };
  });
  check("long tracks: recovery points: the start line listed, one within 1500 before every jump and pit, at least four round the lap", rec.every((r) => r.ok), rec.map((r) => `${r.id} ${r.rec}`).join("; "));
}

function longTruckCell(): void {
  // airCellReach flies a ramp truck's lip too (coordinator's Q1 A): on the Move Yard an air cell over
  // the truck's flight validates; the same cell with the truck taken away, one far past the flight
  // and one off the band's side are refused. Slag Harbour's cell over its truck is reachable.
  const base = MOVE_YARD.features ?? [];
  const tk = trackById("slag-harbour").trucks[0];
  const yard = (extra: moveTrack.Feature[], keepTruck = true) =>
    buildTrack({ ...MOVE_YARD, id: "long-cell-yard", features: [...base.filter((f) => keepTruck || f.k !== "truck"), ...extra] });
  const mt = yard([]).trucks[0];
  const over = { k: "cell" as const, s: mt.lip + 160, lat: mt.lat + 10, air: true };
  const boost = longBoostTop(430);
  const good = longW.validateCells(yard([over]), boost);
  const noTruck = longW.validateCells(yard([over], false), boost);
  const far = longW.validateCells(yard([{ ...over, s: mt.lip + 900 }]), boost);
  const side = longW.validateCells(yard([{ ...over, lat: -40 }]), boost);
  const reach = longW.airCellReach(yard([over]), yard([over]).cells[0], boost);
  const slag = trackById("slag-harbour");
  const slagCell = slag.cells.find((c) => c.air)!;
  const slagReach = longW.airCellReach(slag, slagCell, boost);
  check(
    "long tracks: an air cell over a ramp truck's flight validates (airCellReach flies the truck's lip across its band); with no truck, far past the flight or off the band's side it is refused; Slag Harbour's air cell over its truck is reachable",
    good.length === 0 && noTruck.length === 1 && far.length === 1 && side.length === 1 && !!reach && reach.min >= longW.CELL_MIN_TAKEOFF && !!slagReach && slagCell.s > tk.lip && slagCell.lat >= tk.band0 && slagCell.lat <= tk.band1,
    `Move Yard truck lip ${mt.lip.toFixed(0)}, cell s ${over.s.toFixed(0)} lat ${over.lat}: ${good.join(" | ") || `valid, from ${reach?.min}..${reach?.max} u/s on ${reach?.lanes} lanes`}; no truck: ${noTruck.length}; far: ${far.length}; side: ${side.length}; Slag Harbour cell s ${slagCell.s} lat ${slagCell.lat}: ${slagReach ? `${slagReach.min}..${slagReach.max} u/s on ${slagReach.lanes} lanes` : "unreachable"}`,
  );
}

function longDensityRules(): void {
  // The user's rules (PLAN-M4 "User feedback for M4-TRACKS" and "Mud length"), measured by
  // tools/debug/track-density.ts: obstacle groups spaced (no two kinds back to back: no mixed group;
  // at least 1000 units of obstacle-free road between two groups and between two obstacles of
  // different kinds), most of the lap plain, and no dirt stretch longer than 350.
  const rows: string[] = [];
  let ok = true;
  for (const id of LONG_IDS) {
    const d = longDensity.densityOf(trackById(id));
    const good = d.mixed.length === 0 && d.shortestGap >= 1000 && d.breather.gap >= 1000 && d.clear >= 0.85 && d.mud.every((m) => m.length <= 350);
    ok &&= good;
    rows.push(`${id}: ${d.groups.length} groups, shortest gap ${d.shortestGap.toFixed(0)}, breather ${d.breather.gap.toFixed(0)}, plain ${(d.plain * 100).toFixed(1)} % (obstacle-free ${(d.clear * 100).toFixed(1)} %), mixed ${d.mixed.length}, dirt ${d.mud.map((m) => m.length.toFixed(0)).join("/") || "none"}`);
  }
  check("long tracks density: no two obstacle kinds back to back, >= 1000 of clear road between obstacle groups and between kinds, >= 85 % of the lap obstacle-free, every dirt stretch <= 350", ok, rows.join("; "));
}

function longFeatures(): void {
  // PLAN-M4 2.7 as the ticket asks, adapted to the density and mud rules.
  const sh = trackById("slag-harbour"), bm = trackById("breakers-mile");
  const shorterSide = (i: moveTrack.PlacedIsland) => (i.lenL < i.lenR ? -1 : 1);
  const inLane = (i: moveTrack.PlacedIsland, f: { lat0: number; lat1: number }, side: number) => (side < 0 ? f.lat1 <= i.lat0 : f.lat0 >= i.lat1);
  // Slag Harbour: the split with the flooded short lane (a ground cell in the pool) and the dry long one.
  const si = sh.islands[0];
  const pool = sh.water.find((w) => w.s0 < si.s1 && w.s1 > si.s0);
  const sSide = shorterSide(si);
  const poolCell = pool && sh.cells.find((c) => !c.air && c.s > pool.s0 && c.s < pool.s1 && c.lat > pool.lat0 && c.lat < pool.lat1);
  const dryLong = (sSide < 0 ? si.surfR : si.surfL).length === 0;
  const chicane = sh.tyres.length >= 3 && sh.tyres.every((m, k) => k === 0 || Math.sign(m.lat) !== Math.sign(sh.tyres[k - 1].lat));
  const slag = sh.islands.length === 1 && !!pool && inLane(si, pool, sSide) && !!poolCell && dryLong && sh.barrels.length >= 1 && sh.trucks.length === 1 && sh.cells.some((c) => c.air && c.s > sh.trucks[0].lip && c.s - sh.trucks[0].lip < 600) && chicane && sh.belts.length >= 1;
  check(
    "long tracks: Slag Harbour has barrels off the quay, a split whose shorter lane is flooded (a ground cell in the pool) and whose longer lane is dry, a ramp truck with an air cell over its flight, a tyre-mound chicane and a belt",
    slag,
    `split ${si.s0}..${si.s1} lanes ${si.lenL.toFixed(0)} / ${si.lenR.toFixed(0)}, the ${sSide < 0 ? "left" : "right"} shorter, pool ${pool?.s0}..${pool?.s1}, cell in it ${poolCell ? `${poolCell.s}/${poolCell.lat}` : "none"}; barrels ${sh.barrels.length}; truck ${sh.trucks.length}; mounds ${sh.tyres.map((m) => m.lat).join(",")}; belts ${sh.belts.length}`,
  );
  // Breaker's Mile: two plain straights of >= 1500, a dirt shortcut split (the dirt in the shorter
  // lane, <= 350, the longer lane clean), a crusher press, a chasm jump with an air cell over it, a pit pair.
  const d = longDensity.densityOf(bm);
  const plainStraights = d.straights.filter((s) => s.plain >= 1500);
  const bi = bm.islands[0];
  const dirt = bm.dirt.find((f) => f.s0 < bi.s1 && f.s1 > bi.s0);
  const bSide = shorterSide(bi);
  const gap = bm.gaps[0];
  const mile = plainStraights.length >= 2 && bm.islands.length === 1 && !!dirt && inLane(bi, dirt, bSide) && dirt.s1 - dirt.s0 <= 350 &&
    (bSide < 0 ? bi.surfR : bi.surfL).length === 0 && bm.presses.length >= 1 && bm.ramps.length === 1 && !!gap &&
    bm.cells.some((c) => c.air && c.s > gap.s0 && c.s < gap.s1) && bm.holes.length === 2;
  check(
    "long tracks: Breaker's Mile has two plain straights of >= 1500 for drafting, a dirt shortcut split (the dirt, <= 350, in the shorter lane), a crusher press, a chasm jump with an air cell over it and a pit pair",
    mile,
    `straights ${d.straights.map((s) => `${s.s0.toFixed(0)}..${s.s1.toFixed(0)} plain ${s.plain.toFixed(0)}`).join(", ")}; split lanes ${bi.lenL.toFixed(0)} / ${bi.lenR.toFixed(0)}, dirt ${dirt?.s0}..${dirt?.s1}; presses ${bm.presses.length}; gap ${gap?.s0}..${gap?.s1}; pits ${bm.holes.length}`,
  );
}

/**
 * The stated bounds on the long tracks' bot races (longBots): per bot per race, ticks touching (walls:
 * hit at >= 50 u/s), weapons off, then on (a mine or a rivet can spin a bot into one). Measured
 * 2026-11-22: weapons off all 0; on at most walls 3, mound 1, island 2, truck 1.
 */
const LONG_BOUNDS = {
  off: { walls: 2, mound: 2, island: 2, barrel: 0, press: 0, truck: 0 },
  on: { walls: 8, mound: 6, island: 6, barrel: 4, press: 4, truck: 4 },
};

function longBots(): void {
  // Server bots, 3 laps, per level (Easy, Normal, Hard; Sport, Racer, Truck by add order), weapons off
  // and on, and five mixed bots with weapons: every bot finishes, Normal laps 50-60 s each, at most one
  // fall per bot per race, contacts within LONG_BOUNDS, and a rerun is identical.
  const rows: string[] = [];
  let ok = true;
  for (const id of LONG_IDS) {
    for (const r of longDensity.raceSet(id)) {
      const a = r.a;
      const on = r.name.includes("weapons");
      const b = on ? LONG_BOUNDS.on : LONG_BOUNDS.off;
      const n = a.cars.length;
      const within = [...Array(n).keys()].every((k) => a.walls[k] <= b.walls && a.mounds[k] <= b.mound && a.sides[k] + a.noses[k] <= b.island && a.barrels[k] <= b.barrel && a.presses[k] <= b.press && a.trucks[k] <= b.truck);
      const finished = a.phase === "results" && a.laps.every((l) => l.length === 3);
      const normalLaps = !r.name.startsWith("normal") || a.laps.every((l) => l.every((x) => x >= 50 && x <= 60));
      const good = finished && normalLaps && a.falls.every((f) => f <= 1) && within && r.same;
      ok &&= good;
      rows.push(`${id} ${r.name}: ${good ? "" : "FAIL "}laps ${a.laps.map((l) => l.map((x) => x.toFixed(1)).join(",")).join(" | ")}; falls ${a.falls.join("/")}; walls ${a.walls.join("/")} mound ${a.mounds.join("/")} island ${a.sides.map((x, k) => x + a.noses[k]).join("/")} barrel ${a.barrels.join("/")} press ${a.presses.join("/")} truck ${a.trucks.join("/")}; ${r.same ? "rerun same" : "RERUN DIFFERS"}`);
    }
  }
  console.log(`  ${rows.join("\n  ")}`);
  check(
    "long tracks bots: Easy, Normal and Hard server bots (and five mixed) finish 3 laps on both tracks, weapons off and on, Normal laps 50-60 s each, <= 1 fall per bot per race, contacts within LONG_BOUNDS, identically on a rerun",
    ok,
    rows.filter((r) => r.includes("FAIL")).join("; ") || `${rows.length} races`,
  );
}

function longParity(): void {
  // stepRaceCar on a clone at the room's race tick equals the server's pose bit for bit every tick: a
  // lone server bot per level and type over a lap of each track (barrels and the truck's band at the race
  // tick, the pools, the belt, the mounds, the splits, the press, the jump and the pits); and three client
  // cars over the wire, no lag, predict each track exactly.
  const rows: string[] = [];
  let all = true;
  for (const id of LONG_IDS) {
    for (const [level, car, slot] of [["easy", "sport", 0], ["normal", "racer", 1], ["hard", "truck", 2]] as const) {
      const sim = new Sim(1);
      const host = sim.add("Host");
      if (sim.room.setTrack(host, id)) throw new Error("track refused");
      const bots: Player[] = [];
      for (let k = 0; k <= slot; k++) bots.push(sim.room.addBot(host, level, sim.now) as Player);
      const b = bots[slot];
      for (const o of bots) if (o !== b) sim.room.kick(host, o.id, sim.now);
      if (sim.room.setCar(host, car, b.id)) throw new Error("car");
      b.wallet.ammo.rivets = 0;
      b.wallet.ammo.mines = 0;
      sim.room.start(host, sim.now);
      while (sim.room.phase !== "racing") sim.tick();
      sim.room.retire(host);
      const t = sim.room.track;
      let ctl: longBot.BotControls | null = null;
      surfServerBots.botTrace.fn = (p, c) => {
        if (p === b) ctl = c;
      };
      let ticks = 0, mismatch = 0, first = "", cells = 0;
      try {
        while (sim.room.phase === "racing" && ticks < 60 * 120) {
          const clone = cloneCar(b.car!);
          sim.tick();
          ticks++;
          if (!b.car || sim.room.phase !== "racing") break;
          const c = ctl as longBot.BotControls | null;
          longW.stepRaceCar(clone, { throttle: c?.throttle ?? 0, steer: c?.steer ?? 0 }, b.stats, longW.raceEnv(t, sim.room.rt, 0));
          // A lightning cell is taken by the room after the step (room.ts: boost = max(boost, offer)), not by stepRaceCar.
          if (b.car.boost > clone.boost) {
            clone.boost = Math.max(clone.boost, b.car.boost);
            cells++;
          }
          const keys = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall", "boost"] as const;
          if (!keys.every((k) => Object.is(clone[k], b.car![k]))) {
            mismatch++;
            if (!first) first = `tick ${ticks}: ${keys.filter((k) => !Object.is(clone[k], b.car![k])).join(",")}`;
          }
        }
      } finally {
        surfServerBots.botTrace.fn = null;
      }
      const good = mismatch === 0 && ticks > 60 * 40;
      all &&= good;
      rows.push(`${id} ${level} ${car}: ${ticks} ticks, ${mismatch} mismatches${first ? ` (${first})` : ""}, ${cells} cells taken`);
    }
  }
  check("long tracks parity: stepRaceCar on a clone at the room's race tick equals the server's pose bit for bit every tick (a cell's boost set by the room as it does), a lone server bot per level and type over a lap of each long track", all, rows.join("; "));
  for (const id of LONG_IDS) {
    const r = carsClientLap(id);
    check(
      `long tracks parity: three client cars (Sport, Racer, Truck) racing ${id} over the wire predict it exactly: no state mismatch, no error > ${LARGE_ERR}`,
      r.ticks.every((x) => x > 0) && r.stateErrs === 0 && r.large === 0 && r.samples > 500 && r.same,
      `laps ${r.ticks.map((x) => (x / 60).toFixed(1)).join("/")} s; ${r.samples} samples, ${r.stateErrs} state mismatches, ${r.large} > ${LARGE_ERR}, max ${r.maxErr.toFixed(4)}`,
    );
  }
}

function longCpu(): void {
  // Five Hard server bots, 3 laps of each long track: the median bot step and room tick beside the
  // M4-MOVE numbers (bot step 0.00137 ms, room tick 0.0134 ms with 5 mixed bots on the Move Yard).
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
  const rows: string[] = [];
  let ok = true;
  for (const id of LONG_IDS) {
    const sim = new Sim(3);
    const host = sim.add("Host");
    sim.room.setTrack(host, id);
    for (let k = 0; k < 5; k++) sim.room.addBot(host, "hard", sim.now);
    sim.room.start(host, sim.now);
    while (sim.room.phase !== "racing") sim.tick();
    sim.room.retire(host);
    const tickMs: number[] = [];
    const steps: number[] = [];
    botTiming.samples = steps;
    let ticks = 0;
    try {
      while (sim.room.phase === "racing" && ticks < 60 * 300) {
        sim.tickNo++;
        sim.now += 1000 / 60;
        const t0 = performance.now();
        sim.room.tick(sim.tickNo, sim.now);
        tickMs.push(performance.now() - t0);
        ticks++;
      }
    } finally {
      botTiming.samples = null;
    }
    const med = pct(steps, 0.5), tickMed = pct(tickMs, 0.5);
    ok &&= steps.length > 5 * 5000 && med <= 0.05 && (sim.room.phase as string) === "results";
    rows.push(`${id}: bot step median ${med.toFixed(5)} ms (p99 ${pct(steps, 0.99).toFixed(5)}) over ${steps.length} steps; room tick with 5 Hard bots median ${tickMed.toFixed(4)} ms (p99 ${pct(tickMs, 0.99).toFixed(4)}) over ${ticks} ticks`);
  }
  console.log(`  CPU: ${rows.join("\n  CPU: ")}\n  (M4-MOVE on the Move Yard, 5 mixed bots: bot step 0.00137 ms, room tick 0.0134 ms)`);
  check("long tracks CPU: the median bot step stays within the M4-BOTS bound (0.2 ms; target 0.05) with 5 Hard bots on each long track; room tick printed beside the M4-MOVE numbers", ok, rows.join("; "));
  console.log(`  M4-TRACKS sim-test sections' runtime (longRegistry .. longCpu): ${((performance.now() - longClock.t0) / 1000).toFixed(1)} s`);
}

for (const t of [longRegistry, longValidate, longTruckCell, longDensityRules, longFeatures, longBots, longParity, longCpu]) {
  console.log(`\n# ${t.name}`);
  try {
    t();
  } catch (e) {
    check(`${t.name} threw`, false, String(e));
  }
}

// ---- HARD-2: Hard bots make human mistakes + a dev Bot tune knob (PLAN-M4.md addendum 2026-11-22 and its binding advisor changes, ClickUp 123jpnbfghz, 2026-11-22) ----

// This section's imports (hoisted like the ones at the top).
import * as h2Bot from "../shared/botdrive";
import * as h2Tune from "../tools/debug/hard-tune";
import * as h2Seat from "../server/bots";
import { devBotsOn as h2DevBotsOn } from "../server/room";
import { testTrack as h2TestTrack } from "../shared/testtracks";
import { readFileSync as h2Read } from "node:fs";

/** When the HARD-2 sections began (their runtime is printed and bounded at the end). */
const h2Clock = { t0: 0 };

/** The races of the HARD-2 sections, run once per label (the table reuses the gate's runs). */
const h2Memo = new Map<string, ReturnType<typeof h2Tune.tuneTraffic>>();
function h2Traffic(label: string, tune: h2Bot.BotTune | undefined, tracks: readonly string[], levels: BotLevel[], weapons: boolean): ReturnType<typeof h2Tune.tuneTraffic> {
  const key = `${label}|${JSON.stringify(tune)}|${tracks.join()}|${levels.join()}|${weapons}`;
  let r = h2Memo.get(key);
  if (!r) h2Memo.set(key, (r = h2Tune.tuneTraffic(label, tune, tracks, levels, weapons)));
  return r;
}

const H2_3 = ["hard", "hard", "hard"] as BotLevel[];
const H2_5 = ["hard", "hard", "hard", "hard", "hard"] as BotLevel[];

function hard2Params(): void {
  h2Clock.t0 = performance.now();
  const H = h2Bot.HARD;
  const before = JSON.stringify(H);
  const def = h2Bot.botTuneDefaults();
  const p1 = h2Bot.hardParams(def), p0 = h2Bot.hardParams({ ...def, pace: 0 }), ph = h2Bot.hardParams({ ...def, pace: 0.5 });
  const moved = (p: h2Bot.HardParams) => (Object.keys(H) as (keyof h2Bot.HardParams)[]).filter((k) => !Object.is(p[k], H[k])).join();
  check(
    "hard2 params: BotMem.hard is HARD itself by default (every level); mistakeRate 0 by default; the knob's defaults are today's Hard (rate 0, pace 1, aim = rivetSlack); hardParams never changes HARD",
    newBotMem(0, "hard").hard === H && newBotMem(-24, "normal").hard === H && newBotMem(12, "easy").hard === H && h2Seat.newBotSeat("hard", 3, 1).mem.hard === H &&
      H.mistakeRate === 0 && def.rate === 0 && def.pace === 1 && def.aim === H.rivetSlack && def.size === H.mistakeSize && JSON.stringify(H) === before,
    `defaults ${JSON.stringify(def)}`,
  );
  check(
    "hard2 params: pace 1 is HARD's corner, brakeBand and bendLook themselves (Object.is, no interpolation); pace 0 is Normal's 1, 25, 1; the pace knob moves only those three (apex, cells, weapons, mines stay Hard's)",
    Object.is(p1.corner, H.corner) && Object.is(p1.brakeBand, H.brakeBand) && Object.is(p1.bendLook, H.bendLook) && moved(p1) === "" && p1 !== H &&
      p0.corner === 1 && p0.brakeBand === 25 && p0.bendLook === 1 && moved(p0) === "corner,brakeBand,bendLook" && moved(ph) === "corner,brakeBand,bendLook" &&
      ph.corner > 1 && ph.corner < H.corner && ph.brakeBand > H.brakeBand && ph.brakeBand < 25 && ph.bendLook > H.bendLook && ph.bendLook < 1 &&
      moved(h2Bot.hardParams({ ...def, rate: 2, size: 0.8, aim: 9 })) === "rivetSlack,mistakeRate,mistakeSize",
    `pace 0: ${p0.corner}/${p0.brakeBand}/${p0.bendLook}; 0.5: ${ph.corner.toFixed(4)}/${ph.brakeBand}/${ph.bendLook}; 1: ${p1.corner}/${p1.brakeBand}/${p1.bendLook}`,
  );
  // withHard (the tuner) still sweeps: the default reference is HARD, so a change to it is the bot's.
  const swept = h2Tune.withHard({ apex: 0, mistakeRate: 2 }, () => {
    const m = newBotMem(0, "hard");
    return `${m.hard.apex},${m.hard.mistakeRate}`;
  });
  check("hard2 params: withHard (tools/debug/hard-tune.ts) still sweeps a bot's constants (its BotMem.hard is HARD)", swept === "0,2" && H.apex === 20 && H.mistakeRate === 0, swept);
  // The seed: a server seat's slot; a socket bot's from its lane, signed (mirrored lanes differ).
  const seeds = [0, 1, 2, 3, 4, 5].map((slot) => h2Seat.newBotSeat("hard", slot, slot + 1).mem.seed);
  check(
    "hard2 params: the mistakes' seed is the server seat's slot; a socket bot's comes from its lane (mirrored lanes -24 and 24 differ), as the mine offset",
    seeds.join() === "0,1,2,3,4,5" && newBotMem(24).seed === 168 && newBotMem(-24).seed === -168 && newBotMem(0).seed === 0,
    `slots -> ${seeds.join()}; lanes -24/0/24 -> ${[-24, 0, 24].map((l) => newBotMem(l).seed).join("/")}`,
  );
  // The draw: deterministic, in [0, 1), spread.
  const draws: number[] = [];
  for (let seed = 0; seed < 6; seed++) for (let lap = 0; lap < 3; lap++) for (let seg = 0; seg < 400; seg += 7) draws.push(h2Bot.mistakeDraw(seed, lap, seg, 4));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  const low = draws.filter((x) => x < 0.25).length / draws.length;
  check(
    "hard2 params: mistakeDraw is deterministic (same inputs, same value), in [0, 1) and spread (mean ~0.5, a quarter below 0.25)",
    draws.every((x, i) => x >= 0 && x < 1 && x === h2Bot.mistakeDraw(Math.floor(i / 174), Math.floor((i % 174) / 58), (i % 58) * 7, 4)) && Math.abs(mean - 0.5) < 0.05 && Math.abs(low - 0.25) < 0.05,
    `${draws.length} draws: mean ${mean.toFixed(3)}, below 0.25 ${(low * 100).toFixed(1)}%`,
  );
}

function hard2Identity(): void {
  // Rate 0 through the knob (the dev message, flag on, today's values): the Hard streams are today's
  // (SURF_HARD_GOLDEN); a knob far from today's leaves Easy and Normal byte-identical (HARD_GOLDEN).
  const def = h2Bot.botTuneDefaults();
  const wild = { rate: 3, size: 1, pace: 0, aim: 20 };
  const got: Record<string, string> = {};
  for (const t of HARD_TRACKS) got[`${t} hard`] = h2Tune.goldenServer(t, H2_3, 2, 3, def).hash;
  got["client overpass-knot hard"] = h2Tune.goldenClient("overpass-knot", 2, "hard", 1, false, def).hash;
  const bad = Object.keys(SURF_HARD_GOLDEN).filter((k) => got[k] !== SURF_HARD_GOLDEN[k]);
  check(
    "hard2 identity: with the dev flag on and the knob at today's values (rate 0, pace 1) sent by the host, Hard bots drive, shoot and shop byte-identically to today (SURF_HARD_GOLDEN: server bots on every shipped track, two races; the socket-bot path)",
    bad.length === 0 && Object.keys(got).length === 4,
    bad.map((k) => `${k}: ${got[k]?.slice(0, 12)} != ${SURF_HARD_GOLDEN[k].slice(0, 12)}`).join("; ") || "4 hashes match",
  );
  const en: string[] = [];
  for (const t of HARD_TRACKS) {
    for (const level of ["easy", "normal"] as BotLevel[]) {
      const h = h2Tune.goldenServer(t, [level, level, level], 2, 3, wild).hash;
      if (h !== HARD_GOLDEN[`${t} ${level}`]) en.push(`${t} ${level}: ${h.slice(0, 12)} != ${HARD_GOLDEN[`${t} ${level}`].slice(0, 12)}`);
    }
  }
  check("hard2 identity: with the knob at rate 3, size 1, pace 0, aim 20, Easy and Normal bots drive byte-identically to before M4-HARD (HARD_GOLDEN, every shipped track, two races)", en.length === 0, en.join("; ") || "6 hashes match");
  // Mistakes do change Hard (else the identity above proves nothing), the same way on a rerun.
  const on = { ...def, rate: 3, size: 1 };
  const a = h2Tune.goldenServer("rust-bowl", H2_3, 1, 3, on).hash, b = h2Tune.goldenServer("rust-bowl", H2_3, 1, 3, on).hash;
  check(
    "hard2 identity: with mistakes on (rate 3) a Hard race's stream differs from today's, and is identical on a rerun",
    a === b && a !== h2Tune.goldenServer("rust-bowl", H2_3, 1, 3, def).hash,
    `${a.slice(0, 12)} (rerun ${b.slice(0, 12)})`,
  );
}

function hard2Mistakes(): void {
  // Falls 0 in traffic (advisor change 10): 3 and 5 Hard bots (seats 0-4), 3 laps, every shipped
  // track and the Surf, Split and Move Yards, every car set (the mix, all Sport, Racer, Truck).
  const cfgs: [string, h2Bot.BotTune][] = [["rate 1 size 0.5", h2Tune.tuneOf({ rate: 1, size: 0.5 })], ["rate 3 size 1", h2Tune.tuneOf({ rate: 3, size: 1 })]];
  const kinds = { "late-brake": 0, wide: 0, wobble: 0, hesitate: 0 } as Record<h2Bot.MistakeKind, number>;
  const lines: string[] = [];
  let offOk = true, onOk = true, zones = 0;
  for (const levels of [H2_3, H2_5]) {
    for (const [label, tune] of cfgs) {
      for (const weapons of [false, true]) {
        const r = h2Traffic(`${label} ${levels.length}H ${weapons ? "weapons" : "no weapons"}`, tune, h2Tune.MISTAKE_TRACKS, levels, weapons).row;
        for (const k of h2Bot.MISTAKE_KINDS) kinds[k] += r.mistakes[k];
        zones += r.badZone;
        if (weapons) onOk &&= r.falls - r.hitFalls === 0 && r.mistakeFalls === 0;
        else offOk &&= r.falls === 0;
        lines.push(`${r.label}: falls ${r.falls} (${r.hitFalls} within 3 s of being hit, ${r.mistakeFalls} within 3 s of a mistake), ${r.perLap.toFixed(2)} mistakes/lap, ${r.wrecks} wrecks`);
      }
    }
  }
  for (const l of lines) console.log(`  ${l}`);
  check(
    "hard2 mistakes: falls 0 with mistakes on in traffic, weapons off: 3 and 5 Hard bots, 3 laps, the shipped tracks and the Surf, Split and Move Yards, every car set, rate 1 size 0.5 and rate 3 size 1",
    offOk,
    lines.filter((l) => l.includes("no weapons")).join("; "),
  );
  check(
    "hard2 mistakes: with weapons on as well, no fall but after being hit by a rivet or a mine (the weapons' falls, as at rate 0), none within 3 s of a mistake",
    onOk,
    lines.filter((l) => !l.includes("no weapons")).join("; "),
  );
  check(
    "hard2 mistakes: every kind fires when the rate is above 0 (late brake, wide line, wobble after a landing, hesitation after a pass or a hit), counted per kind",
    h2Bot.MISTAKE_KINDS.every((k) => kinds[k] > 0),
    h2Bot.MISTAKE_KINDS.map((k) => `${k} ${kinds[k]}`).join(", "),
  );
  check(
    "hard2 mistakes: no step of a mistake in an excluded zone (independent check: a feature from 15 behind to 650 ahead, the slipstream, a back-up, reversing, backing off an island)",
    zones === 0,
    `${zones} steps`,
  );
  // Rerun identical (the gate's heaviest run, weapons on).
  const again = h2Tune.tuneTraffic("rerun", cfgs[1][1], h2Tune.MISTAKE_TRACKS, H2_5, true);
  const first = h2Traffic(`rate 3 size 1 5H weapons`, cfgs[1][1], h2Tune.MISTAKE_TRACKS, H2_5, true);
  check("hard2 mistakes: a rerun is identical (5 Hard bots, weapons on, rate 3 size 1, every track and car set: every tally, lap and mistake)", JSON.stringify(again.runs) === JSON.stringify(first.runs));
  // The lap from both adapters: the server's bots err on every lap of a 3-lap race; the socket bots
  // (BotDriver over the Game, the lap from its snapshots) too, identically on a rerun, no state mismatch.
  const laps = new Set<number>();
  {
    // A 3-lap room race of 3 Hard bots on Rust Bowl: onMistake's lap argument.
    const room = new Room("H2LP", 3, CAR_HP);
    const host = room.addPlayer("Host", { conn: { send() {}, close() {} }, room: null, player: null } as Session, 1000) as Player;
    const bots = [0, 1, 2].map(() => room.addBot(host, "hard", 1000) as Player);
    let now = 1000, tick = 0;
    h2Tune.withDevBots(() => room.setBotTune(host, cfgs[1][1]) ?? room.start(host, now));
    for (const b of bots) b.bot!.mem.onMistake = (_k, _z, _s, lap) => void laps.add(lap);
    while (room.phase !== "racing") room.tick(++tick, (now += 1000 / 60));
    room.retire(host);
    for (let i = 0; i < 60 * 300 && room.phase === "racing"; i++) room.tick(++tick, (now += 1000 / 60));
  }
  const ca = h2Tune.goldenClient("rust-bowl", 2, "hard", 1, false, cfgs[1][1]), cb = h2Tune.goldenClient("rust-bowl", 2, "hard", 1, false, cfgs[1][1]);
  const cl = new Set(ca.mistakes!.map((m) => m.lap));
  check(
    "hard2 mistakes: the lap reaches the draw from both adapters: server bots err on laps 1, 2 and 3; socket bots (BotDriver, the lap from the snapshots) on laps 1 and 2 of a 2-lap race, all finish, no state mismatch, identically on a rerun",
    [0, 1, 2].every((l) => laps.has(l)) && cl.has(0) && cl.has(1) && ca.finish[0].every((f) => f > 0) && ca.stateErrs === 0 && ca.hash === cb.hash && ca.mistakes!.length > 0,
    `server laps ${[...laps].sort().map((l) => l + 1).join(",")}; socket: ${ca.mistakes!.length} mistakes on laps ${[...cl].sort().map((l) => l + 1).join(",")} (${h2Bot.MISTAKE_KINDS.map((k) => `${k} ${ca.mistakes!.filter((m) => m.kind === k).length}`).join(", ")}), finish ${ca.finish[0].map((f) => (f / 1000).toFixed(2)).join("/")} s, state mismatches ${ca.stateErrs}`,
  );
}

/** A Hard bot's memory with mistakes certain (chance 1) and a mistake under way. */
function h2Mem(lane = 0): BotMem {
  const m = newBotMem(lane, "hard");
  m.hard = { ...h2Bot.HARD, mistakeRate: 100, mistakeSize: 1 };
  m.useWake = false;
  m.weapons = false;
  return m;
}

function hard2Latch(): void {
  // Cleared in resetBotMem, in the air/fall/wreck return and by the socket bot between races.
  const t = trackById("rust-bowl");
  const p = pointAt(t, 1000);
  const car = (extra: Partial<CarState> = {}): CarState => ({ x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 400, vy: Math.sin(p.h) * 400, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0, ...extra });
  const busy = (): h2Bot.Mistake => ({ kind: "wide", size: 0.5, from: 0, end: 400, delay: 0, t: 3, n: 360, sign: 1 });
  const m = h2Mem();
  m.mistake = busy();
  m.inBend = true;
  m.flew = true;
  m.hp = 50;
  resetBotMem(m);
  const reset = m.mistake === null && !m.inBend && !m.flew && m.hp === -1 && m.seed === 0 && m.hard.mistakeRate === 100;
  const airs = (["air", "fall", "wreck"] as const).map((k) => {
    const mm = h2Mem();
    mm.mistake = busy();
    botControls({ car: car({ [k]: 10 }), track: t, stats: BASE_STATS, raceOn: true, raceSteps: 600, others: [] }, mm);
    return mm.mistake === null && mm.flew === (k === "air");
  });
  const g = new Game(() => ({ send() {}, close() {}, onOpen() {}, onMessage() {}, onClose() {} }) as unknown as Transport, { get: () => null, set() {} });
  const d = new BotDriver(g, 24, "hard");
  const dm = (d as unknown as { mem: BotMem }).mem;
  dm.mistake = busy();
  dm.inBend = true;
  dm.flew = true;
  dm.hp = 40;
  d.controls(); // no car: between races
  check(
    "hard2 latch: a mistake (and the bend latch, the landing edge, the hit edge) is forgotten by resetBotMem (the settings stay), in the air/fall/wreck return (in the air the landing edge is set), and by the socket bot between races",
    reset && airs.every(Boolean) && dm.mistake === null && !dm.inBend && !dm.flew && dm.hp === -1 && dm.seed === 168,
    `reset ${reset}; air/fall/wreck ${airs.join("/")}; socket bot ${dm.mistake === null && dm.hp === -1}`,
  );
  // Triggers, directly (chance 1): a bend entry, a landing, a hit (BotView.hp from both adapters:
  // botStep passes the player's hp, BotDriver the snapshot's), each only when free; never in the
  // first 3 s; and a hesitation is a lift that a ramp approach still beats (throttle 1).
  let s0 = -1;
  for (let s = 200; s < t.length && s0 < 0; s += 10) {
    const b = Math.abs(angleDiff(pointAt(t, s + 20).h, pointAt(t, s + 20 + Math.max(120, 360) * h2Bot.HARD.bendLook).h));
    if (b < 0.1 && h2Bot.mistakeClear(t, s)) s0 = s;
  }
  const q = pointAt(t, s0);
  const straight: CarState = { x: q.x, y: q.y, h: q.h, vx: Math.cos(q.h) * 400, vy: Math.sin(q.h) * 400, seg: q.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const view = (hp: number, steps = 600) => ({ car: { ...straight }, track: t, stats: BASE_STATS, raceOn: true, raceSteps: steps, others: [], hp, lap: 1 });
  const seen: string[] = [];
  const hm = h2Mem();
  hm.onMistake = (k, _z, s, lap) => void seen.push(`${k}@lap${lap}`);
  const t1 = botControls(view(100), hm).throttle;
  const t2 = botControls(view(80), hm).throttle; // hit
  const early = h2Mem();
  botControls(view(100, 100), early);
  botControls(view(80, 100), early);
  const landed = h2Mem();
  botControls({ ...view(100), car: { ...straight, air: 5 } }, landed);
  botControls(view(100), landed);
  // botStep (the server adapter) passes p.hp and the lap.
  const seat = h2Seat.newBotSeat("hard", 2, 1);
  seat.mem.hard = hm.hard;
  seat.steps = 600;
  const laps: number[] = [];
  seat.mem.onMistake = (k, _z, _s, lap) => void laps.push(lap);
  const fighter = { id: "b", car: { ...straight }, finished: false, hp: 100, maxHp: 100, ghost: 0, cooldown: 0, ammo: { rivets: 0, mines: 0 }, levels: { engine: 0, tyres: 0, welder: 0 }, stats: BASE_STATS, bot: seat, carType: "sport" as CarType };
  h2Seat.botStep(fighter, [fighter], t, true, [], undefined, 0, 2);
  fighter.hp = 70;
  fighter.car = { ...straight };
  h2Seat.botStep(fighter, [fighter], t, true, [], undefined, 0, 2);
  // BotDriver (the socket adapter) passes the snapshot's hp and lap.
  const sg = { car: { ...straight }, track: t, stats: { ...BASE_STATS }, raceOn: () => true, otherPoses: () => [], visibleMines: () => [], raceTickNow: () => 0, you: "me", latest: { time: 0, cars: new Map([["me", { hp: 100, lap: 1 }]]), shots: new Map(), mines: [] } } as unknown as Game;
  const sd = new BotDriver(sg, 0, "hard");
  sd.tune({ rate: 100, size: 1, pace: 1, aim: h2Bot.HARD.rivetSlack });
  const sk: string[] = [];
  sd.onMistake = (k, _z, _s, lap) => void sk.push(`${k}@lap${lap}`);
  for (let i = 0; i < 200; i++) sd.controls(); // past the first 3 s of its race steps
  (sg.latest!.cars.get("me") as unknown as { hp: number }).hp = 60;
  sd.controls();
  check(
    "hard2 latch: a hit (hp drop) begins a hesitation (a lift: throttle 1 -> 0) when free; not in the first 3 s after GO; a landing (the c.air edge) begins a wobble; both adapters feed hp and the lap (botStep: the player's; BotDriver: the snapshot's)",
    s0 >= 0 && seen.join() === "hesitate@lap1" && t1 === 1 && t2 === 0 && early.mistake === null && landed.mistake?.kind === "wobble" && laps.join() === "2" && sk.join() === "hesitate@lap1",
    `straight at s ${s0}; direct ${seen.join() || "none"}, throttle ${t1} -> ${t2}; early ${early.mistake?.kind ?? "none"}; landing ${landed.mistake?.kind ?? "none"}; botStep laps ${laps.join() || "none"}; BotDriver ${sk.join() || "none"}`,
  );
  // A wide line is reported (onMistake: the server log, the counts) only once it is driven: at a bend
  // entry whose draw is "wide", a mine on the outside lane leaves it nowhere to run wide, so no mistake
  // begins and none is reported; without the mine the same bend reports "wide" (review nit 2).
  let e0 = -1;
  for (let s = 200; s < t.length && e0 < 0; s += 5) {
    const at = (x: number) => Math.abs(angleDiff(pointAt(t, x + 20).h, pointAt(t, x + 20 + 360 * h2Bot.HARD.bendLook).h));
    if (at(s) > 0.5 && at(s - 5) <= 0.5 && h2Bot.mistakeClear(t, s)) e0 = s;
  }
  const ep = pointAt(t, e0);
  const eturn = angleDiff(pointAt(t, e0 + 20).h, pointAt(t, e0 + 20 + 360 * h2Bot.HARD.bendLook).h);
  const entry: CarState = { x: ep.x, y: ep.y, h: ep.h, vx: Math.cos(ep.h) * 400, vy: Math.sin(ep.h) * 400, seg: ep.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const mq = pointAt(t, e0 + 100), out = -Math.sign(eturn) * 20;
  const wideAt = (seed: number, mine: boolean) => {
    const m = h2Mem();
    m.seed = seed;
    const said: string[] = [];
    m.onMistake = (k) => void said.push(k);
    const mines = mine ? [{ x: mq.x - Math.sin(mq.h) * out, y: mq.y + Math.cos(mq.h) * out }] : [];
    botControls({ car: { ...entry }, track: t, stats: BASE_STATS, raceOn: true, raceSteps: 600, others: [], mines, lap: 1 }, m);
    return { said: said.join(), kind: m.mistake?.kind ?? "none" };
  };
  let wseed = -1;
  for (let seed = 0; seed < 64 && wseed < 0; seed++) if (wideAt(seed, false).said === "wide") wseed = seed;
  const free = wseed >= 0 ? wideAt(wseed, false) : null, blocked = wseed >= 0 ? wideAt(wseed, true) : null;
  check(
    "hard2 latch: a wide line is reported only once it is driven: with a mine on the outside lane no mistake begins and none is reported; the same bend entry without it reports \"wide\" (review nit 2)",
    e0 >= 0 && !!free && !!blocked && free.said === "wide" && free.kind === "wide" && blocked.said === "" && blocked.kind === "none",
    `bend entry at s ${e0} (turn ${eturn.toFixed(2)}), seed ${wseed}: free ${free?.said || "none"} / ${free?.kind}; mine on the outside lane ${blocked?.said || "nothing reported"} / ${blocked?.kind}`,
  );
  // Exclusions: mistakeClear holds nowhere a feature lies within MISTAKE_LOOK ahead (or beside), and
  // the start of a mistake needs it. Crusher Run: before its ramps and holes, no; far from them, yes.
  const cr = trackById("crusher-run");
  const lip = cr.ramps[0].s + cr.ramps[0].len;
  const crClear = [1000, lip - h2Bot.MISTAKE_LOOK + 10, lip - 300, cr.holes[0].s, cr.holes[0].s - 900].map((s) => h2Bot.mistakeClear(cr, s));
  const share = (id: string) => {
    const tt = h2TestTrack(id) ?? trackById(id);
    let n = 0, k = 0;
    for (let s = 0; s < tt.length; s += 25, k++) if (h2Bot.mistakeClear(tt, s)) n++;
    return `${id} ${((n / k) * 100).toFixed(0)}%`;
  };
  check(
    `hard2 latch: mistakeClear (MISTAKE_LOOK ${h2Bot.MISTAKE_LOOK} = RAMP_APPROACH 650 + a mistake's 500) is false within that look before Crusher Run's first ramp or a hole, true far from them`,
    h2Bot.MISTAKE_LOOK > 650 && crClear.join() === "true,false,false,false,false",
    `s 1000 / lip - ${h2Bot.MISTAKE_LOOK - 10} / lip - 300 / at a hole / 900 before it: ${crClear.join("/")}; share of the lap where one may begin: ${["rust-bowl", ...h2Tune.MISTAKE_TRACKS.slice(1)].map(share).join(", ")}`,
  );
}

function hard2Table(): void {
  // REPORT + gate: lap-time loss and wall/obstacle contacts per rate (sizes 0.5 and 1) and per pace
  // (0, 0.25, 0.5, 0.75, 1), 3 Hard bots in traffic (weapons off, so the driving alone shows), every
  // track and car set; and a lone bot's lap per pace on the shipped tracks (every type, lanes -24/0/24).
  const tracks = h2Tune.MISTAKE_TRACKS;
  const base = h2Traffic("rate 0 (today's Hard)", undefined, tracks, H2_3, false).row;
  const rows: h2Tune.TuneRow[] = [];
  for (const size of [0.5, 1]) for (const rate of [0.5, 1, 2, 3]) rows.push(h2Traffic(`rate ${rate} size ${size}`, h2Tune.tuneOf({ rate, size }), tracks, H2_3, false).row);
  console.log(`  per rate (3 Hard bots, weapons off, ${tracks.length} tracks x 4 car sets, 3 laps):`);
  console.log(`  ${h2Tune.tuneLine(base, base)}`);
  for (const r of rows) console.log(`  ${h2Tune.tuneLine(r, base)}`);
  const paces = [0, 0.25, 0.5, 0.75, 1];
  const prow = paces.map((pace) => h2Traffic(`pace ${pace} rate 0`, pace === 1 ? undefined : h2Tune.tuneOf({ pace }), tracks, H2_3, false).row);
  const solo = paces.map((pace) => {
    let lap = 0, n = 0, falls = 0, walls = 0, dirt = 0;
    for (const track of HARD_TRACKS) {
      for (const car of CAR_TYPES) {
        for (const lane of [-24, 0, 24]) {
          const [r] = h2Tune.runRaces({ track, levels: ["hard"], cars: [car], lanes: [lane], weapons: false, tune: h2Tune.tuneOf({ pace }) });
          lap += r.lapTicks.reduce((a, b) => a + b, 0);
          n += r.lapTicks.length;
          falls += r.falls;
          walls += r.walls;
          dirt += r.dirt;
        }
      }
    }
    return { pace, lap: lap / n, falls, walls, dirt };
  });
  console.log("  per pace (rate 0): a lone bot's mean lap on the shipped tracks (every type, lanes -24/0/24) | traffic as above:");
  paces.forEach((pace, i) => console.log(`  pace ${pace.toFixed(2)}: solo ${(solo[i].lap / 60).toFixed(3)} s (+${((solo[i].lap / solo[4].lap - 1) * 100).toFixed(2)}% on pace 1), falls ${solo[i].falls}, walls ${solo[i].walls}, dirt ${solo[i].dirt} | ${h2Tune.tuneLine(prow[i], prow[4])}`));
  const all = [base, ...rows, ...prow];
  const loss = (r: h2Tune.TuneRow) => r.lap / base.lap - 1;
  check(
    "hard2 table: every rate and every pace drives without a fall (traffic, weapons off, every track and car set); mistakes cost lap time (rate 1 and up, both sizes, more at size 1 than 0.5 for rates 2 and 3)",
    all.every((r) => r.falls === 0 && r.badZone === 0) && rows.filter((_, i) => i % 4 >= 1).every((r) => loss(r) > 0) && loss(rows[6]) > loss(rows[2]) && loss(rows[7]) > loss(rows[3]),
    rows.map((r) => `${r.label} ${(loss(r) * 100).toFixed(2)}%`).join(", "),
  );
  check(
    "hard2 table: the pace knob slows the bends step by step from today's Hard (1) to Normal's bend pace (0), no fall or wall contact alone",
    solo.every((r, i) => r.falls === 0 && r.walls === 0 && (i === 0 || r.lap < solo[i - 1].lap)),
    solo.map((r) => `${r.pace}: ${(r.lap / 60).toFixed(3)} s`).join(", "),
  );
}

function hard2Knob(): void {
  // The dev message: refused without the flag (unset, or anything but "1"), from a guest, outside the
  // lobby and with a value that is not a finite number; clamped; the room message carries botTune only
  // under the flag; a race snapshots it at beginRace (HARD itself without one).
  const msg = (v: Partial<Record<keyof h2Bot.BotTune, unknown>>) => ({ t: "botTune", rate: 1, size: 0.5, pace: 1, aim: 2.5, ...v }) as unknown as ClientMsg;
  const off = ["", "0", "true", undefined].map((flag) =>
    h2Tune.withEnv("SCRAP_DEV_BOTS", flag, () => {
      const R = botRooms();
      R.send(R.ann, msg({}));
      const m = lastRoomMsg(R.ann.conn);
      return { on: h2DevBotsOn(), errs: errMsgs(R.ann.conn).map((x) => x.msg).join(), field: !!m && "botTune" in m };
    }),
  );
  check(
    "hard2 knob: without the flag (unset, empty, \"0\", \"true\": only SCRAP_DEV_BOTS=1 is on) the host's botTune is refused and the room message has no botTune",
    off.every((x) => !x.on && x.errs === "Bot tuning is off on this server" && !x.field),
    off.map((x) => `${x.errs || "accepted"}, field ${x.field}`).join("; "),
  );
  h2Tune.withDevBots(() => {
    const R = botRooms();
    const { room, ann, bo, send } = R;
    send(ann, { t: "addBot", level: "hard" });
    send(ann, { t: "addBot", level: "normal" });
    const first = lastRoomMsg(bo.conn)?.botTune;
    send(bo, msg({ rate: 2 }));
    const guest = errMsgs(bo.conn).map((x) => x.msg).join();
    const bads = [{ rate: NaN }, { size: Infinity }, { pace: "1" }, { aim: null }, { rate: undefined }].map((v) => {
      const n = errMsgs(ann.conn).length;
      send(ann, msg(v));
      return errMsgs(ann.conn).slice(n).map((x) => x.msg).join();
    });
    send(ann, msg({ rate: 99, size: -1, pace: 0.5, aim: 7 }));
    const clamped = lastRoomMsg(bo.conn)?.botTune;
    check(
      "hard2 knob: with SCRAP_DEV_BOTS=1 a new room shows today's values; a guest's botTune is refused; NaN, Infinity, a string, null or a missing value is refused; the host's is clamped (rate 99 -> 3, size -1 -> 0) and goes to everyone in the room message",
      JSON.stringify(first) === JSON.stringify(h2Bot.botTuneDefaults()) && guest === "Only the host can tune the bots" && bads.every((b) => b === "Bad bot tune") &&
        JSON.stringify(clamped) === JSON.stringify({ rate: 3, size: 0, pace: 0.5, aim: 7 }),
      `new room ${JSON.stringify(first)}; guest: ${guest}; bad: ${bads.join(" | ")}; clamped ${JSON.stringify(clamped)}`,
    );
    send(bo, { t: "ready", ready: true });
    send(ann, { t: "start" });
    R.step(1);
    const bots = R.bots();
    const snap = bots.map((b) => b.bot!.mem.hard);
    const params = snap[0];
    let racing = 0;
    while (room.phase !== "racing" && racing++ < 400) R.step(1);
    const n = errMsgs(ann.conn).length;
    send(ann, msg({ rate: 1 }));
    const inRace = errMsgs(ann.conn).slice(n).map((x) => x.msg).join();
    check(
      "hard2 knob: the race begins with the knob (beginRace: every bot's BotMem.hard one new object with rate 3, size 0, the pace-0.5 constants, rivetSlack 7; HARD unchanged; the server's mistake log on); in a race the message is refused",
      room.phase === "racing" && snap.every((h) => h === params) && params !== h2Bot.HARD && params.mistakeRate === 3 && params.mistakeSize === 0 && params.rivetSlack === 7 &&
        params.corner === h2Bot.hardParams({ rate: 3, size: 0, pace: 0.5, aim: 7 }).corner && h2Bot.HARD.mistakeRate === 0 && h2Bot.HARD.rivetSlack === 2.5 &&
        bots.every((b) => b.bot!.mem.onMistake !== null) && inRace === "The bots can only be tuned in the lobby",
      `phase ${room.phase}; params ${JSON.stringify({ rate: params.mistakeRate, size: params.mistakeSize, corner: params.corner, slack: params.rivetSlack })}; in a race: ${inRace}`,
    );
  });
  // A race without a knob (or the flag off) runs with HARD itself.
  {
    const sim = new Sim(1);
    const host = sim.add("Host");
    const b = sim.room.addBot(host, "hard", sim.now) as Player;
    b.bot!.mem.hard = h2Bot.hardParams(h2Tune.tuneOf({ rate: 2 })); // left over: beginRace puts HARD back
    sim.room.start(host, sim.now);
    check("hard2 knob: a race with no knob set runs its bots with HARD itself and no mistake log", b.bot!.mem.hard === h2Bot.HARD && b.bot!.mem.onMistake === null);
  }
  // The server log under the flag: each mistake one line (seat, lap, s, kind); none without the flag.
  const logRace = (flag: boolean) => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      const run = () => {
        const sim = new Sim(1);
        const host = sim.add("Host");
        for (let i = 0; i < 3; i++) sim.room.addBot(host, "hard", sim.now);
        if (flag) sim.room.setBotTune(host, h2Tune.tuneOf({ rate: 3, size: 1 }));
        sim.room.start(host, sim.now);
        while (sim.room.phase !== "racing") sim.tick();
        sim.room.retire(host);
        for (let i = 0; i < 60 * 120 && sim.room.phase === "racing"; i++) sim.tick();
      };
      if (flag) h2Tune.withDevBots(run);
      else h2Tune.withEnv("SCRAP_DEV_BOTS", undefined, run);
    } finally {
      console.log = log;
    }
    return lines.filter((l) => l.startsWith("[bots] "));
  };
  const on = logRace(true), quiet = logRace(false);
  const shape = /^\[bots\] room TEST race tick \d+: (Gasket|Lugnut|Piston) \(bot\) seat [0-2] lap 1 s \d+: (late-brake|wide|wobble|hesitate) \(size \d\.\d\d\)$/;
  check(
    "hard2 knob: under the flag each mistake is one server log line (room, race tick, bot, seat, lap, s, kind, size); without it none",
    on.length > 0 && on.every((l) => shape.test(l)) && quiet.length === 0,
    `${on.length} lines, e.g. "${on[0] ?? ""}"; without the flag ${quiet.length}`,
  );
  // Over the wire: the Game learns the flag from the room message and Game.tuneBots sends the knob.
  const wire = (flag: boolean) =>
    h2Tune.withEnv("SCRAP_DEV_BOTS", flag ? "1" : undefined, () => {
      const rooms = new Rooms(1);
      const A = wiredGame(rooms, { now: 1000 });
      A.game.create("Ann");
      A.open();
      A.flush();
      const seen = A.game.botTune ? { ...A.game.botTune } : null;
      A.game.tuneBots({ rate: 1.5, size: 0.25, pace: 0.75, aim: 4 });
      A.flush();
      const after = A.game.botTune;
      A.game.leave();
      return { seen, after, left: A.game.botTune };
    });
  const won = wire(true), woff = wire(false);
  check(
    "hard2 knob: over the wire the Game learns the knob from the room message only under the flag (null without), Game.tuneBots sets it, and leaving the room forgets it",
    JSON.stringify(won.seen) === JSON.stringify(h2Bot.botTuneDefaults()) && JSON.stringify(won.after) === JSON.stringify({ rate: 1.5, size: 0.25, pace: 0.75, aim: 4 }) && won.left === null &&
      woff.seen === null && woff.after === null,
    `flag on: ${JSON.stringify(won.seen)} -> ${JSON.stringify(won.after)}; off: ${JSON.stringify(woff.seen)} -> ${JSON.stringify(woff.after)}`,
  );
  const yaml = h2Read("render.yaml", "utf8"), docker = h2Read("Dockerfile", "utf8");
  check("hard2 knob: render.yaml and the Dockerfile set no SCRAP_ variable (the knob is off on Render)", !yaml.includes("SCRAP_") && !docker.includes("SCRAP_"));
}

function hard2Cpu(): void {
  // 1 human (retired at GO) + 5 Hard bots with mistakes on (rate 3, size 1), 3 laps of Crusher Run.
  const sim = new Sim(3);
  const host = sim.add("Host");
  sim.room.setTrack(host, "crusher-run");
  for (let i = 0; i < 5; i++) sim.room.addBot(host, "hard", sim.now);
  h2Tune.withDevBots(() => sim.room.setBotTune(host, h2Tune.tuneOf({ rate: 3, size: 1 })) ?? sim.room.start(host, sim.now));
  for (const p of sim.room.players.values()) if (p.bot) p.bot.mem.onMistake = null;
  while (sim.room.phase !== "racing") sim.tick();
  sim.room.retire(host);
  const steps: number[] = [];
  botTiming.samples = steps;
  try {
    for (let i = 0; i < 60 * 300 && sim.room.phase === "racing"; i++) sim.tick();
  } finally {
    botTiming.samples = null;
  }
  const med = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
  const p99 = [...steps].sort((a, b) => a - b)[Math.floor(steps.length * 0.99)];
  console.log(`  CPU: Hard bot step with mistakes on, median ${(med * 1000).toFixed(2)} us, p99 ${(p99 * 1000).toFixed(2)} us over ${steps.length} steps (hard CPU above: the same without)`);
  check(
    "hard2 CPU: with mistakes on (rate 3, size 1) the median Hard bot step stays <= 0.05 ms (the M4-BOTS gate fails above 0.2 ms)",
    steps.length > 5 * 3000 && med <= 0.2 && (sim.room.phase as string) === "results",
    `median bot step ${med.toFixed(5)} ms (${med <= 0.05 ? "within" : "OVER"} the 0.05 ms target)`,
  );
  const added = (performance.now() - h2Clock.t0) / 1000;
  console.log(`  HARD-2 sections' runtime (hard2Params .. hard2Cpu): ${added.toFixed(1)} s`);
  check("hard2 CPU: the HARD-2 sim-test sections add at most 90 s (printed)", added <= 90, `${added.toFixed(1)} s`);
}

for (const t of [hard2Params, hard2Identity, hard2Mistakes, hard2Latch, hard2Table, hard2Knob, hard2Cpu]) {
  console.log(`\n# ${t.name}`);
  try {
    t();
  } catch (e) {
    check(`${t.name} threw`, false, String(e));
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
