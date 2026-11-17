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
    p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0, air: 0, fall: 0 };
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
  b.car = { x: m.x, y: m.y + 2, h: pt.h, vx: 0, vy: 0, seg: a.car!.seg, wreck: 0, air: 0, fall: 0 };
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

  const c = { x: 0, y: 0, h: 0, vx: 100, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0 };
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
  for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(clone, { throttle: 1, steer: 0 }, b.stats, track);
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
    a.stats.accel === statsFor(a.levels).accel && a.stats.accel > BASE_STATS.accel * 1.069 && a.stats.topSpeed === BASE_STATS.topSpeed,
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

const body = (x: number, y: number, h: number, vx = 0, vy = 0): CarState => ({ x, y, h, vx, vy, seg: 0, wreck: 0, air: 0, fall: 0 });

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
  return { k: "car", id, x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, seg: 0, lap: 0, rd: 0, fin: 0, hp: 100, maxHp: 100, wreck: c.wreck, air: c.air, fall: c.fall, ghost: false, ...extra };
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
    const s = statsFor({ engine: e, tyres: 0, welder: 0 });
    return s.topSpeed === BASE_STATS.topSpeed && Math.abs(s.accel - BASE_STATS.accel * (1 + 0.07 * e)) < 1e-9;
  });
  check("engine L0-L3: accel +7% per level, top speed always the base value", ok);
  const t2 = statsFor({ engine: 3, tyres: 2, welder: 1 });
  check("tyres still scale grip and turn", Math.abs(t2.grip - BASE_STATS.grip * 1.2) < 1e-9 && Math.abs(t2.turn - BASE_STATS.turn * 1.08) < 1e-9);

  // A long closed loop whose bottom edge is a 12 000 u straight (collinear control points keep
  // the spline exactly on y = 0 there). The car starts at x = 1500 on the centerline, heading +x.
  const straight: TrackDef = {
    name: "Test Straight",
    control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [0, 3000]],
    halfWidth: 64,
    verge: 44,
  };
  const flat = buildTrack(straight);
  const SECONDS = 8;
  const drive = (level: number) => {
    const stats = statsFor({ engine: level, tyres: 0, welder: 0 });
    const c: CarState = { x: 1500, y: 0, h: 0, vx: 0, vy: 0, seg: 0, wreck: 0, air: 0, fall: 0 };
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
    x, y, h, vx: Math.cos(h) * speed, vy: Math.sin(h) * speed, seg: queryTrack(t, x, y).seg, wreck: 0, air: 0, fall: 0,
  });
  type Ev = { i: number; ev: RaceStepEvent; x: number; y: number; v: number };
  /** Step n ticks; returns the events with the pose after the step and the speed before it. */
  const run = (t: Track, c: CarState, n: number, input = { throttle: 1, steer: 0 }, until?: (e: Ev) => boolean) => {
    const evs: Ev[] = [];
    for (let i = 0; i < n; i++) {
      const v = speedOf(c);
      const ev = stepRaceCar(c, input, BASE_STATS, t);
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
      stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, jt);
      stepRaceCar(twin, { throttle: -1, steer: 1 }, BASE_STATS, jt);
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
      ev = stepRaceCar(c, { throttle: 1, steer: 1 }, BASE_STATS, jt);
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
    const ef = stepRaceCar(fwd, NO_COMMAND, BASE_STATS, jt), eb = stepRaceCar(back, NO_COMMAND, BASE_STATS, jt);
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
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, jt);
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
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, jt);
    check("precedence: a wreck beats fall and air (only the wreck counts down)", ev === null && c.wreck === 2 && c.fall === 50 && c.air === 10 && c.x === 3000);
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, jt);
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, jt);
    check("precedence: the respawn clears fall and air", c.wreck === 0 && c.fall === 0 && c.air === 0 && Math.abs(c.y) < 1e-9);
    const f = carAt(jt, 3000, 0, 200);
    f.fall = 10;
    f.air = 10;
    const e2 = stepRaceCar(f, { throttle: 1, steer: 0 }, BASE_STATS, jt);
    check("precedence: a fall beats air (frozen, no flight)", e2 === null && f.fall === 9 && f.air === 10 && f.x === 3000 && f.vx === 0);
    // A wreck respawn over a gap goes to the recovery point; on the road it stays put.
    const w = carAt(jt, 2600, 0, 0);
    wreckCar(w);
    for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(w, NO_COMMAND, BASE_STATS, jt);
    const rec = pointAt(jt, sx(2000));
    const r = carAt(jt, 3000, 20, 0);
    wreckCar(r);
    for (let i = 0; i < WRECK_TICKS; i++) stepRaceCar(r, NO_COMMAND, BASE_STATS, jt);
    check(
      "wreck respawn onto a gap goes to the recovery point",
      w.wreck === 0 && Math.abs(w.x - rec.x) < 1e-9 && Math.abs(r.x - 3000) < 1e-6 && Math.abs(r.y) < 1e-9,
      `gap wreck -> x=${w.x.toFixed(1)}, road wreck -> x=${r.x.toFixed(1)}`,
    );
    const a = carAt(jt, 2503, 0, 300);
    stepRaceCar(a, NO_COMMAND, BASE_STATS, jt);
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
      const ev = stepRaceCar(ref, inp, BASE_STATS, jt);
      if (ev) evs.push(ev);
      states.push(cloneCar(ref));
    }
    const fields = ["x", "y", "h", "vx", "vy", "seg", "wreck", "air", "fall"] as const;
    let mismatches = 0, starts = 0;
    for (let k = 0; k < inputs.length; k += 7) {
      const c = cloneCar(states[k]);
      starts++;
      for (let i = k; i < inputs.length; i++) {
        stepRaceCar(c, inputs[i], BASE_STATS, jt);
        if (fields.some((f) => c[f] !== states[i + 1][f])) mismatches++;
      }
    }
    check(
      "prediction parity: stepRaceCar on a clone == reference run through jump, fall and recovery",
      mismatches === 0 && evs.includes("takeoff") && evs.includes("fall") && evs.includes("recover"),
      `${starts} clones, events ${evs.join(",")}, ${mismatches} mismatches`,
    );
    const src: CarState = { x: 1, y: 2, h: 3, vx: 4, vy: 5, seg: 6, wreck: 0, air: 7, fall: 8 };
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
    const c: CarState = { x: rec.x, y: rec.y, h: rec.h, vx: 0, vy: 0, seg: rec.seg, wreck: 0, air: 0, fall: 0 };
    const segs: number[] = [];
    const evs: RaceStepEvent[] = [];
    for (let i = 0; i < 300; i++) {
      const q = queryTrackNear(good, c.x, c.y, c.seg);
      const t = pointAt(good, q.s + 60 + speedOf(c) * 0.25);
      const steer = clamp(angleDiff(c.h, Math.atan2(t.y - c.y, t.x - c.x)) * 2.2, -1, 1);
      const ev = stepRaceCar(c, { throttle: 1, steer }, BASE_STATS, good);
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
    const d: CarState = { x: lp.x, y: lp.y, h: lp.h, vx: Math.cos(lp.h) * 250, vy: Math.sin(lp.h) * 250, seg: lp.seg, wreck: 0, air: 0, fall: 0 };
    const devs: RaceStepEvent[] = [];
    const dsegs: number[] = [];
    for (let i = 0; i < 150; i++) {
      const q = queryTrackNear(good, d.x, d.y, d.seg);
      const t = pointAt(good, q.s + 60 + speedOf(d) * 0.25);
      const ev = stepRaceCar(d, { throttle: 0.6, steer: clamp(angleDiff(d.h, Math.atan2(t.y - d.y, t.x - d.x)) * 2.2, -1, 1) }, BASE_STATS, good);
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
    const clip = buildTrack({ name: "Test Clip", halfWidth: 64, verge: 44, control: [[0, 0], [3000, 0], [3000, 200], [0, 200]] });
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
import { gridSlot } from "../shared/track";
import { DEFAULT_TRACK_ID, registerTestTrack, trackById, trackList } from "../shared/tracks";

/** Sim.place on any track (Sim.place uses the default track). */
function placeOn(t: Track, p: Player, s: number, lateral = 0, speed = 0): void {
  const pt = pointAt(t, s);
  const x = pt.x - Math.sin(pt.h) * lateral;
  const y = pt.y + Math.cos(pt.h) * lateral;
  p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0, air: 0, fall: 0 };
  p.progress = { s: queryTrackNear(t, x, y, pt.seg).s, cp: 1, lap: 0, fin: 0 };
}

function roomTrack(): void {
  // A second track for this test only (the shipped registry has one), far away from Rust
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
    "track: the registry ships rust-bowl only, keyed by TrackDef.id",
    trackList().map((e) => e.id).join() === `${DEFAULT_TRACK_ID},${LOOP}` && rust.def === RUST_BOWL && trackList()[0].name === RUST_BOWL.name,
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

for (const t of [rivets, gating, mines, wrecks, finishing, garage, armDelay, engine, readyCheck, collisions, trackFeatures, roomTrack]) {
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
