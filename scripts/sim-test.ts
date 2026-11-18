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
import {
  DEFAULT_SOUND,
  isMuteKey,
  MUSIC_FADE_OUT_S,
  MusicDirector,
  musicWanted,
  parseSoundSettings,
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
    id: "test-straight",
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
  p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0, air: 0, fall: 0 };
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
    "track: the registry ships rust-bowl (first, the default), crusher-run and overpass-knot, keyed by TrackDef.id",
    trackList().map((e) => e.id).join() === `${DEFAULT_TRACK_ID},crusher-run,overpass-knot,${LOOP}` &&
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
    g.latest = { time: 0, cars: new Map([["me", snapCar("me", car)]]), shots: new Map(), mines: [] };
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
    const snapOf = (time: number, s: CarSnap) => ({ time, cars: new Map([["o", s]]), shots: new Map(), mines: [] });
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

const MAX_UPGRADES = statsFor({ engine: 3, tyres: 3, welder: 3 });
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
  const c: CarState = { x, y, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0 };
  let fell = false;
  for (let i = 0; i < 200; i++) {
    const ev = stepRaceCar(c, NO_COMMAND, BASE_STATS, t);
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
    const car: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 120, vy: Math.sin(p.h) * 120, seg: p.seg, wreck: 0, air: 0, fall: 0 };
    const bot = new BotDriver(stubGame(knot, car), 0);
    bot.weapons = false;
    let reversed = false, fell = false, took = 0;
    for (let i = 0; i < 60 * 20 && !fell; i++) {
      const ctl = backUp ? bot.controls() : { throttle: 1, steer: 0 };
      if (ctl.throttle < 0 && speedOf(car) > 5 && car.vx * Math.cos(car.h) + car.vy * Math.sin(car.h) < 0) reversed = true;
      const v0 = speedOf(car);
      const ev = stepRaceCar(car, ctl, BASE_STATS, knot);
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
      const car: CarState = { x: g.x, y: g.y, h: g.h, vx: 0, vy: 0, seg: g.seg, wreck: 0, air: 0, fall: 0 };
      const bot = new BotDriver(stubGame(rust, car), lane);
      bot.weapons = false;
      let off = 0, n = 0, dist = 0, prev = queryTrackNear(rust, car.x, car.y, car.seg).s;
      for (let i = 0; i < 60 * 60 && dist < rust.length; i++) {
        stepRaceCar(car, bot.controls(), BASE_STATS, rust);
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
  const me: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0 };
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
    stepRaceCar(fc, NO_COMMAND, BASE_STATS, knot);
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
  // Settings: defaults, clamping, broken storage.
  const d = parseSoundSettings(null);
  const broken = parseSoundSettings("{not json");
  const clamped = parseSoundSettings(JSON.stringify({ music: 2, effects: -1, muted: "yes" }));
  const kept = parseSoundSettings(JSON.stringify({ music: 0.3, effects: 0.65, muted: true }));
  const partial = parseSoundSettings(JSON.stringify({ effects: 0.2 }));
  check(
    "sound settings: defaults music 0.5, effects 0.8, unmuted; broken or missing values fall back; out of range clamps",
    d.music === 0.5 && d.effects === 0.8 && !d.muted && JSON.stringify(broken) === JSON.stringify(DEFAULT_SOUND) &&
      clamped.music === 1 && clamped.effects === 0 && clamped.muted === false &&
      kept.music === 0.3 && kept.effects === 0.65 && kept.muted && partial.music === 0.5 && partial.effects === 0.2,
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
  const stored = parseSoundSettings(JSON.stringify({ engine: "v8" })).engine;
  const unknown = parseSoundSettings(JSON.stringify({ engine: "electric" })).engine;
  check(
    "sfx engine presets: 3 distinct petrol engines, idle firing 25-40 Hz up to 150-220 Hz at top speed; the choice is a stored sound setting (unknown -> the default)",
    ENGINE_PRESETS.length === 3 && rangesOk && distinct && stored === "v8" && unknown === DEFAULT_SOUND.engine && ENGINE_PRESETS.includes(DEFAULT_SOUND.engine) &&
      parseSoundSettings(null).engine === DEFAULT_SOUND.engine,
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
    const c: CarState = { x: 3000, y: limit - 1, h: 0.3, vx: 250, vy, seg: pointAt(t1b, 3000).seg, wreck: 0, air: 0, fall: 0 };
    const before = cloneCar(c);
    stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, t1b);
    return { speed: wallHitSpeed(before, c, t1b), vyAfter: c.vy, atWall: Math.abs(c.y - limit) < 0.02 };
  };
  const hard = into(180);
  const soft = into(30);
  const away = into(-80);
  const free = { ...into(0) };
  const mid: CarState = { x: 3000, y: 0, h: 0, vx: 250, vy: 120, seg: pointAt(t1b, 3000).seg, wreck: 0, air: 0, fall: 0 };
  const midBefore = cloneCar(mid);
  stepRaceCar(mid, { throttle: 1, steer: 0 }, BASE_STATS, t1b);
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
    hp.car = { x: pt.x, y: pt.y, h: pt.h, vx: Math.cos(pt.h) * 300, vy: Math.sin(pt.h) * 300, seg: pt.seg, wreck: 0, air: 0, fall: 0 };
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

// ---- more songs (SND-5, PLAN-SOUND.md, 2026-11-18): the registry, structure, setSong ------

// This section's imports (hoisted like the ones at the top).
import { DEFAULT_SONG_ID, MusicPlayer, SONG_LIST, SONG_XFADE_S, SONGS, songById, SongVoices, swingOffset, type Song } from "../client/music";

/** The style each song was asked for (ticket SND-5): its BPM range. */
const SONG_BPM: Record<string, [number, number]> = {
  "rust-bucket": [110, 128],
  mirrorball: [118, 124], // 80s disco
  "neon-tailpipe": [110, 128], // synthwave chase
  "gravel-surf": [150, 170], // surf-rock chiptune
  "grease-monkey": [95, 110], // funky garage groove
};

function songs(): void {
  // The registry: the default first, ids and titles unique, the SND-1 export kept.
  const ids = SONGS.map((s) => s.id);
  check(
    "songs: a registry of five (Rust Bucket Shuffle the default, SONG still points at it), unique ids and titles, the picker list matches",
    SONGS.length === 5 && ids[0] === "rust-bucket" && DEFAULT_SONG_ID === "rust-bucket" && SONG === SONGS[0] && SONG.title === "Rust Bucket Shuffle" &&
      new Set(ids).size === 5 && new Set(SONGS.map((s) => s.title)).size === 5 && SONGS.every((s) => s.title.length > 0 && s.title.length <= 24) &&
      SONG_LIST.map((x) => `${x.id}:${x.title}`).join() === SONGS.map((s) => `${s.id}:${s.title}`).join() && Object.keys(SONG_BPM).join() === ids.join(),
    SONGS.map((s) => `${s.id} "${s.title}"`).join(", "),
  );
  check(
    "songs: an unknown, empty or missing id falls back to the default; a known id finds its song",
    songById("nope") === SONG && songById("") === SONG && songById(undefined) === SONG && songById(null) === SONG && ids.every((id) => songById(id).id === id),
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
      if (e.bass) bassOk &&= Number.isInteger(e.bass.len) && e.bass.len > 0 && i + e.bass.len <= n && e.bass.midi >= midiOf("A1") && e.bass.midi <= midiOf("C4") && (e.bass.vel ?? 1) > 0;
      if (e.chord) chordOk &&= e.chord.len > 0 && i + e.chord.len <= n && e.chord.vel > 0 && e.chord.midi.length >= 3 && e.chord.midi.every((m) => m >= midiOf("C3") && m <= midiOf("C6"));
      drumOk &&= e.drums.every((d) => d.vel > 0 && d.vel <= 1);
      if (i % s.stepsPerBar === 0) downbeats &&= e.drums.some((d) => d.kind === "kick" || d.kind === "tom");
    });
    check(
      `songs ${s.id}: BPM ${lo}-${hi}; bars x stepsPerBar = steps; A/B sections cover the loop in order; a ${n < 1 ? "" : "50-70"} s loop`,
      s.bpm >= lo && s.bpm <= hi && s.stepsPerBar === 16 && n === s.bars * s.stepsPerBar && covered === s.bars && names.includes("A") && names.includes("B") &&
        (s.id === "rust-bucket" || (loop >= 50 && loop <= 70)),
      `"${s.title}" ${s.bpm} BPM, ${s.bars} bars x ${s.stepsPerBar} = ${n} steps, sections ${s.sections.map((x) => `${x.name}@${x.bar + 1}`).join(" ")}, loop ${loop.toFixed(1)} s`,
    );
    check(
      `songs ${s.id}: a mono lead C4-C6 and a bass A1-C4 with whole-step lengths inside the loop; chords of 3+ notes; a kick or tom on every downbeat`,
      leadOk && bassOk && chordOk && drumOk && downbeats,
      `lead ${leadOk}, bass ${bassOk}, chords ${chordOk}, drums ${drumOk}, downbeats ${downbeats}`,
    );

    // On the beat grid: the clock hands out every step on the straight 16th grid of the song's
    // BPM; the swing (if any) delays only the off 16ths, by less than half a step.
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
    const swungOk = due.every((d) => {
      const off = swingOffset(s, d.step % n);
      return d.step % 2 === 0 ? off === 0 : Math.abs(off - s.swing * sec) < 1e-12 && off < sec / 2;
    });
    check(
      `songs ${s.id}: every step lands on the ${s.bpm} BPM grid (beats on the beat); swing ${s.swing} delays only the off 16ths, under half a step`,
      grid && swungOk && s.swing >= 0 && s.swing < 0.5 && due.length >= n,
      `${due.length} steps, grid ${grid}, swing ${swungOk}`,
    );
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
  const surf = by("gravel-surf");
  const gallops = surf.steps.filter((e, i) => i % 4 === 0 && [0, 2, 3].every((d) => surf.steps[i + d]?.drums.some((x) => x.kind === "hat" || x.kind === "tom")) && !surf.steps[i + 1]?.drums.some((x) => x.kind === "hat" || x.kind === "tom")).length;
  const tremolo = surf.steps.filter((e, i) => e.lead && e.lead.len === 1 && surf.steps[i + 1]?.lead?.midi === e.lead.midi).length;
  check(
    "songs gravel-surf (surf-rock chiptune): 150-170 BPM, a galloping beat (x.xx), a twangy lead (a scoop into notes, vibrato, a springy echo) with tremolo picking",
    gallops >= surf.bars && !!surf.inst.lead.slide && !!surf.inst.lead.vibrato && !!surf.inst.lead.echo && tremolo >= 32,
    `gallops ${gallops}, tremolo repeats ${tremolo}`,
  );
  const funk = by("grease-monkey");
  const ghosts = funk.steps.filter((e) => e.bass && (e.bass.vel ?? 1) < 1).length;
  const pops = funk.steps.filter((e) => e.bass && (e.bass.vel ?? 1) > 1).length;
  check(
    "songs grease-monkey (funky garage groove): 95-110 BPM, swung 16ths, slap-style bass (ghost notes and popped octaves), wah lead stabs (a band-pass sweeping up and back)",
    funk.swing > 0 && ghosts > 20 && pops > 20 && funk.inst.lead.filter?.type === "bandpass" && (funk.inst.lead.filter.to ?? 0) > funk.inst.lead.filter.from && !!funk.inst.lead.filter.back &&
      funk.steps.filter((e) => e.lead && e.lead.len <= 2).length > funk.steps.filter((e) => e.lead).length / 2,
    `ghosts ${ghosts}, pops ${pops}, swing ${funk.swing}`,
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

    // Off: setSong only picks the song for the next start.
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
      "songs player: setSong while off only picks (no nodes, no timer); the next start plays that song from the top on its own BPM grid",
      offPick && run1 === "mirrorball" && music.playing && starts0 > 10 && gridOk && fades().length === 1 && music.position().bar === 0,
      `picked ${offPick}, playing ${run1}, ${starts0} voices in 1 s, bar ${music.position().bar + 1} step ${music.position().step}`,
    );

    // On: a short crossfade, the new song from the top; the old one keeps playing until it is silent.
    const oldFade = fades()[0];
    const switchAt = ctx.currentTime;
    const nodesAtSwitch = ctx.nodes.length;
    music.setSong("gravel-surf");
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
      music.playingSong?.id === "gravel-surf" && !!xOld?.startsWith("lin 0 ") && Math.abs(at(xOld) - (switchAt + SONG_XFADE_S)) < 1e-9 && !!xNew?.startsWith("lin 1 ") &&
        Math.abs(at(xNew) - (switchAt + SONG_XFADE_S)) < 1e-9 && oldStillScheduled && fades().length === 1 && fades()[0] === newFade && oldFade.outs.size === 0,
      `old ${xOld}, new ${xNew}, old-song notes during the fade ${oldNotesAfter}, connected fades ${fades().length}`,
    );

    // The echo of the old song (mirrorball's) is disconnected with its run; the new song's (surf's) plays on.
    const delays = ctx.nodes.filter((n) => n.kind === "delay");
    check(
      "songs player: a song's echo goes with its run (the old song's delay loop is disconnected on the switch, the new one's connected)",
      delays.length === 2 && delays[0].outs.size === 0 && delays[1].outs.size > 0,
      `${delays.length} delay nodes, connected ${delays.map((d) => d.outs.size > 0).join("/")}`,
    );

    // The same id again: nothing; an unknown id: the default (and a switch, as it differs).
    const before = ctx.nodes.length;
    music.setSong("gravel-surf");
    const same = ctx.nodes.length === before;
    music.setSong("no-such-song");
    check(
      "songs player: picking the playing song again does nothing; an unknown id picks (and switches to) the default",
      same && music.song === SONG && music.playingSong === SONG,
      `same ${same}, now ${music.playingSong?.id}`,
    );

    // Countdown: fading out; a song picked then plays when the lobby comes back (resume -> switch).
    music.forced = undefined;
    advance(1);
    music.update(true, "lobby"); // following the game, in a room: still on
    music.update(true, "countdown");
    const fading = music.director.mode === "fading";
    music.setSong("neon-tailpipe");
    const stillOld = music.playingSong === SONG;
    music.update(true, "lobby");
    check(
      "songs player: a song picked during the fade-out does not cut in; it starts (crossfading) when the lobby comes back",
      fading && stillOld && music.playingSong?.id === "neon-tailpipe" && music.director.mode === "on",
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
    check("songs player: nothing starts while the tab is hidden; on return the picked song starts", hiddenNone && music.playingSong?.id === "neon-tailpipe", `then ${music.playingSong?.id}`);
    music.forced = false;
    music.update(false, "lobby");
  } finally {
    Object.assign(g, saved);
  }

  // The swing lands in the voices: off 16ths start late by swing x step, the rest on the grid.
  const funk = songById("grease-monkey");
  const vctx = new RecContext();
  const v = new SongVoices(vctx as unknown as BaseAudioContext, new RecNode("out", vctx) as unknown as AudioNode, {} as AudioBuffer, funk);
  const sec = stepSeconds(funk.bpm);
  let swingOk = true;
  for (let k = 0; k < 64; k++) {
    const from = vctx.starts.length;
    v.step(k, 10 + k * sec);
    const want = 10 + k * sec + (k % 2 ? funk.swing * sec : 0);
    swingOk &&= vctx.starts.slice(from).every((x) => Math.abs(x.t - want) < 1e-9);
  }
  check("songs voices: Grease Monkey Strut's off 16ths start swing x step late, the on-beat ones on the grid", swingOk && vctx.starts.length > 100, `${vctx.starts.length} sources started`);
}

for (const t of [rivets, gating, mines, wrecks, finishing, garage, armDelay, engine, readyCheck, collisions, trackFeatures, roomTrack, jumpsWired, shippedTracks, botDriver, botLaps, mineCap, chatRoom, chatClient, sound, raceSounds, surfaceSounds, audioUnlock, menuHostOnly, menuStop, menuRestart, menuKick, menuLock, menuHandover, menuClient, menuRestartClient, retireRules, retireField, retireRaceEnd, retireGarage, retireRefund, retireOthers, retireNotices, retireClient, songs, songPlayer]) {
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
