// Deterministic server simulation test: drives a Room directly with fake connections and
// scripted inputs (no sockets, no wall clock). Covers weapons, wrecks, the garage and
// payouts. Run: npx tsx scripts/sim-test.ts

import { BASE_STATS, cloneCar, DT } from "../shared/physics";
import type { GameEvent, ServerMsg } from "../shared/protocol";
import { payouts, startingWallet, buy as shopBuy, statsFor } from "../shared/shop";
import { buildTrack, pointAt, queryTrackNear, RUST_BOWL } from "../shared/track";
import {
  BTN_RIVET,
  GHOST_TICKS,
  makeButtons,
  shotHits,
  spinOut,
  SPIN_KICK,
  stepRaceCar,
  WRECK_TICKS,
  type Command,
} from "../shared/weapons";
import { Room, type Conn, type Player, type Session } from "../server/room";

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

class Sim {
  readonly room: Room;
  readonly conns = new Map<string, FakeConn>();
  readonly events: GameEvent[] = [];
  private readonly seqs = new Map<string, number>();
  private readonly mineCounts = new Map<string, number>();
  now = 1000;
  tickNo = 0;

  constructor(laps = 1, hp?: number) {
    this.room = new Room("TEST", track, laps, hp);
  }

  add(name: string): Player {
    const conn = new FakeConn();
    const session: Session = { conn, room: null, player: null };
    const p = this.room.addPlayer(name, session) as Player;
    this.conns.set(p.id, conn);
    this.seqs.set(p.id, 0);
    this.mineCounts.set(p.id, 0);
    return p;
  }

  /** Queue one input for p (one per tick keeps the jitter buffer steady). */
  feed(p: Player, cmd: Partial<Command> & { mine?: boolean } = {}): void {
    if (cmd.mine) this.mineCounts.set(p.id, (this.mineCounts.get(p.id)! + 1) & 7);
    const buttons = cmd.buttons ?? makeButtons(false, 0) | ((this.mineCounts.get(p.id)! & 7) << 1);
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
  run(n: number, cmd: (p: Player) => Partial<Command> & { mine?: boolean } = () => ({})): void {
    for (let i = 0; i < n; i++) {
      for (const p of this.room.players.values()) if (p.car) this.feed(p, cmd(p));
      this.tick();
    }
  }

  startRace(host: Player): void {
    const e = this.room.start(host, this.now);
    if (e) throw new Error(e);
    while (this.room.phase !== "racing") this.run(1);
  }

  /** Put a car on the track at distance s, `lateral` units sideways, facing along the track. */
  place(p: Player, s: number, lateral = 0, speed = 0): void {
    const pt = pointAt(track, s);
    const x = pt.x - Math.sin(pt.h) * lateral;
    const y = pt.y + Math.cos(pt.h) * lateral;
    p.car = { x, y, h: pt.h, vx: Math.cos(pt.h) * speed, vy: Math.sin(pt.h) * speed, seg: pt.seg, wreck: 0 };
    p.progress = { s: queryTrackNear(track, x, y, pt.seg).s, cp: 1, lap: 0, fin: 0 };
  }

  eventsOf(k: GameEvent["k"]): GameEvent[] {
    return this.events.filter((e) => e.k === k);
  }

  lastGarage(p: Player): Extract<ServerMsg, { t: "garage" }> | undefined {
    return this.conns.get(p.id)!.msgs.filter((m) => m.t === "garage").pop() as Extract<ServerMsg, { t: "garage" }>;
  }
}

// ---- tests --------------------------------------------------------------------------

function rivets(): void {
  const sim = new Sim();
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
  sim.place(a, 200, 0);
  sim.place(b, 320, 0);
  const ammo0 = a.ammo.rivets;
  sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  sim.run(20);
  const hits = sim.eventsOf("hit");
  check(
    "rivet hits the car ahead for 8",
    hits.length === 1 && b.hp === 92 && hits[0].k === "hit" && hits[0].by === a.id && hits[0].w === "rivet",
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
  sim.room.start(a, sim.now);
  let ammo = a.ammo.rivets;
  for (let i = 0; i < 60; i++) sim.run(1, (p) => (p === a ? { buttons: sim.rivet(a) } : {}));
  check("no firing during the countdown", a.ammo.rivets === ammo && sim.room.combat.shots.length === 0);
  while (sim.room.phase !== "racing") sim.run(1);
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
  sim.place(a, 300, 0);
  sim.place(b, 1500, 0);
  sim.run(1, (p) => (p === a ? { mine: true } : {}));
  sim.run(1);
  const m = sim.room.combat.mines[0];
  check("mine dropped behind the car", !!m && m.owner === a.id, m ? `at ${m.x.toFixed(0)},${m.y.toFixed(0)}` : "none");
  if (!m) return;
  // B parks 2 units off the mine, before it arms.
  const pt = pointAt(track, 0);
  b.car = { x: m.x, y: m.y + 2, h: pt.h, vx: 0, vy: 0, seg: a.car!.seg, wreck: 0 };
  const h0 = b.car.h;
  let hitAt = -1;
  for (let i = 0; i < 40 && hitAt < 0; i++) {
    sim.run(1);
    if (sim.eventsOf("hit").length) hitAt = i;
  }
  check("mine is harmless until armed (~0.4 s), then hits", hitAt >= 18 && hitAt <= 26, `hit after ${hitAt} ticks`);
  check("mine does 30 damage and spins the car", b.hp === 70 && Math.abs(Math.abs(b.car.h - h0) - SPIN_KICK) < 1e-9, `hp=${b.hp}`);
  check("mine is used up", sim.room.combat.mines.length === 0);

  // Owner drives back over its own armed mine.
  sim.place(a, 600, 0);
  sim.run(1, (p) => (p === a ? { mine: true } : {}));
  sim.run(40);
  const own = sim.room.combat.mines[0];
  a.car!.x = own.x;
  a.car!.y = own.y;
  sim.run(2);
  check("an armed mine also hits its owner", a.hp === 70, `a.hp=${a.hp}`);
  check("no wreck credit for hurting yourself", !sim.room.combat.wrecksCaused.has(a.id));

  const c = { x: 0, y: 0, h: 0, vx: 100, vy: 0, seg: 0, wreck: 0 };
  spinOut(c, 0, 10);
  check("spin-out is deterministic: away from the mine, speed x0.3", c.h === -SPIN_KICK && Math.abs(c.vx - 30) < 1e-9);
}

function wrecks(): void {
  const sim = new Sim(1, 8); // 8 HP: one rivet wrecks
  const a = sim.add("A");
  const b = sim.add("B");
  sim.startRace(a);
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
  check("finished cars cannot fire", a.ammo.rivets === ammo);
  a.car!.vx = a.car!.vy = 0;
  const s = queryTrackNear(track, a.car!.x, a.car!.y, a.car!.seg).s;
  sim.place(b, s - 120, 0);
  b.progress!.cp = 1;
  sim.run(1, (p) => (p === b ? { buttons: sim.rivet(b) } : {}));
  sim.run(15);
  check("finished cars are ghosted (rivets pass through)", a.hp === 100 && sim.eventsOf("hit").length === 0);

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

function garage(): void {
  const sim = new Sim();
  const a = sim.add("A");
  sim.add("B");
  const g0 = sim.lastGarage(a);
  check("garage sent on join with the starting kit", g0?.scrap === 400 && a.ammo.rivets === 40 && a.ammo.mines === 3);
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
  check("upgrades change the stats the car steps with", a.stats.topSpeed === statsFor(a.levels).topSpeed && a.stats.topSpeed > BASE_STATS.topSpeed * 1.069);

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
  check("shop.buy is pure on the wallet", shopBuy(w, "mines") === null && w.ammo.mines === 6 && w.scrap === 200);
  check("DT sanity", Math.abs(DT - 1 / 60) < 1e-12);
}

for (const t of [rivets, gating, mines, wrecks, finishing, garage]) {
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
