// branch-tune (BR-BOTS, PLAN-BRANCH.md 2.6, its advisor changes 4 and 6, user decision 3; ClickUp 123jpnbfghc):
// the bots on shortcut roads, with no browser and no sockets (server bots in a Room on the sim clock).
//
// --plan: per seat (0..5), level and car type, the shortcuts it takes (shared/botdrive.ts routePlan, at
// L0 and L3 upgrades): each branch's kind, the shortcut's cost against the main road's and the verdict.
//
//   npx tsx tools/debug/branch-tune.ts --plan [--track branch-yard]
//
// --gain: per level and car type, one bot alone (weapons off, seat 2's lane 0), 3 laps on each route
// forced (the main road, each shortcut alone, all of them): the median lap, its falls, wall and obstacle
// contacts, and the time each route gains on the main road (s a lap).
//
// --races: the acceptance races (BR-BOTS criterion 4): 3 bots of each level, and the mixed 5 (Hard,
// Normal, Easy, Hard, Normal on seats 0..4, M4-TRACKS' long-track field), weapons on, 3 laps, each run
// twice, the race kept open until every bot has finished (grace: false): finishes (and whether within the
// game's 30 s after the winner), laps, falls per bot, wall and obstacle (mound, gore nose, island, mover)
// contacts, ticks per shortcut, the plan per seat, and whether the rerun is identical (a SHA-256 over every
// tick's controls and car state).
//
// --mistakes: 3 Hard bots with the Bot tune knob at rate 3, size 1 (weapons off and on): the mistakes
// begun, and any step of one inside a mouth (fork or merge to MOUTH_CLEAR past its gore, on either road)
// or within a shortcut hazard's zone (650 before a ramp, gap, hole or dirt patch on a branch to 15 past it).
//
// --cpu: 5 Hard bots, 3 laps: the median and p99 bot step and room tick.
//
// --gores (the BR-BOTS review 1 probe): past a gore the route must take the car's own road at once.
// (1) one botControls step per point on every road every 10 units, lanes 12 apart across the car-centre
// corridor, for each of the 8 routes (a Hard Sport at 300 u/s along the road, committed at every fork): the
// (point, route) pairs past a gore whose route's ring after the step is not on the car's road there; (2) 120
// drives from 1..28 past each fork gore on the main road with route 7 (2 speeds, 2 lanes): steps the route
// still holds the cut, the closest the car comes to its wall; (3) 72 drives from 20/50/80 % of each fork
// mouth to its gore with a route taking that cut (4 lanes, 320 u/s): wall contacts.
//
// The race runner (branchRace) is used by scripts/sim-test.ts (section BR-BOTS).

import { createHash } from "node:crypto";
import { botTiming, botTrace } from "../../server/bots";
import { Room, type Player, type Session } from "../../server/room";
import { BOT_LANES, botControls, newBotMem, routeOf, routePlan, type BotControls, type BotLevel, type BotMem, type BotTune, type MistakeKind } from "../../shared/botdrive";
import { CAR_TYPES, type CarType } from "../../shared/cars";
import { wallLimit, type CarState } from "../../shared/physics";
import { FINISH_GRACE_MS, type GameEvent, type ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { globalSeg, MOUTH_CLEAR, pointAt, queryTrackNear, roadOf, roadOfSeg, type Track, type TrackQuery } from "../../shared/track";
import { CAR_HP, raceEnv, stepRaceCar } from "../../shared/weapons";
import { testTrack } from "../../shared/testtracks";
import { tuneOf, withDevBots, withEnv } from "./hard-tune";
import { moveContact } from "./move-tune";
import { islandContact } from "./split-tune";
import { touchesMound } from "./surf-tune";

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

export interface BranchRaceOpts {
  track?: string; // a test track with branches (default branch-yard)
  levels: BotLevel[]; // the bots by seat (slot 0..)
  cars?: CarType[]; // per bot (default: by seat, sport, racer, truck, ...)
  laps?: number; // default 3
  weapons?: boolean; // default true
  force?: (number | undefined)[]; // per bot: its route forced to this mask (else its plan)
  tune?: BotTune; // the room's Bot tune knob (HARD-2; the dev flag on for it)
  observe?: (k: number, car: CarState, ctl: BotControls) => void; // told of every bot step (bot k, its car before the step, its controls)
  /**
   * false: the race stays open until every bot has finished (the harness clears the room's finish deadline,
   * Room.phaseEnds, each tick), so a slow bot's 3 laps are measured past FINISH_GRACE_MS (30 s after the
   * winner, the game's rule); BranchRow.inGrace says whether it made the game's deadline. Default true.
   */
  grace?: boolean;
}

export interface BranchRow {
  name: string;
  seat: number;
  level: BotLevel;
  car: CarType;
  plan: number; // the route it took the race with (bit b: branch b)
  lapTicks: number[];
  finish: number; // race ticks (0: did not finish)
  falls: number;
  walls: number; // wall contacts begun
  obstacles: number; // contacts begun with a mound or a gore's nose, an island, a barrel, a press or a truck
  onBranch: number[]; // ticks on each branch
  mistakes: Record<MistakeKind, number>;
  mistakeSteps: number;
  badMouth: number; // mistake steps inside a mouth zone
  badHazard: number; // ... within a shortcut hazard's zone
  inGrace: boolean; // finished within FINISH_GRACE_MS of the winner (the game's deadline)
}

/** A track's mouth zones per road: [road, from, to] (main s, or u on a branch): the fork or merge to MOUTH_CLEAR past its gore. */
export function mouthZones(t: Track): [number, number, number][] {
  const out: [number, number, number][] = [];
  t.branches.forEach((b, k) => {
    const fg = b.forkGore, mg = b.mergeGore, r = k + 1;
    if (!fg || !mg) {
      out.push([0, b.s0, b.s1], [r, 0, b.road.length]);
      return;
    }
    out.push([0, b.s0, fg.s + MOUTH_CLEAR], [0, mg.s - MOUTH_CLEAR, b.s1], [r, 0, fg.u + MOUTH_CLEAR], [r, mg.u - MOUTH_CLEAR, b.road.length]);
  });
  return out;
}

/** A track's shortcut hazard zones: [road, from, to] (u): 650 before a ramp, gap, hole or dirt patch on a branch to 15 past it (HARD-2's test zone). */
export function hazardZones(t: Track): [number, number, number][] {
  const out: [number, number, number][] = [];
  t.branches.forEach((b, k) => {
    const r = b.road, n = k + 1;
    for (const x of r.ramps) out.push([n, x.s - 650, x.s + x.len + 15]);
    for (const g of r.gaps) out.push([n, g.s0 - 650, g.s1 + 15]);
    for (const h of r.holes) out.push([n, h.s - h.r - 650, h.s + h.r + 15]);
    for (const f of r.surfaces) out.push([n, f.s0 - 650, f.s1 + 15]);
  });
  return out;
}

/** Races of server bots on a track with branches on the sim clock (deterministic): per bot its row; hash: every tick's controls and car states. */
export function branchRace(o: BranchRaceOpts): { rows: BranchRow[]; hash: string; track: Track; ticks: number } {
  const id = o.track ?? "branch-yard";
  const laps = o.laps ?? 3;
  const events: GameEvent[] = [];
  const conn = { send: (m: ServerMsg) => void (m.t === "ev" && events.push(m.ev)), close(): void {} };
  const room = new Room("BRTUNE", laps, CAR_HP);
  let now = 1000, tick = 0;
  const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
  const e0 = withEnv("SCRAP_DEV_TRACK", id, () => room.setTrack(host, id));
  if (e0) throw new Error(e0);
  const t = room.track;
  const bots = o.levels.map((l, i) => {
    const b = room.addBot(host, l, now);
    if (typeof b === "string") throw new Error(b);
    const car = o.cars?.[i];
    if (car && room.setCar(host, car, b.id)) throw new Error("car");
    if (o.weapons === false) b.bot!.mem.weapons = false;
    return b;
  });
  const nb = t.branches.length;
  const rows: BranchRow[] = bots.map((p) => ({
    name: p.name, seat: p.bot!.slot, level: p.bot!.level, car: p.carType, plan: -1, lapTicks: [], finish: 0, falls: 0, walls: 0, obstacles: 0,
    onBranch: new Array<number>(nb).fill(0), mistakes: { "late-brake": 0, wide: 0, wobble: 0, hesitate: 0 }, mistakeSteps: 0, badMouth: 0, badHazard: 0, inGrace: false,
  }));
  const h = createHash("sha256");
  const idx = new Map(bots.map((p, k) => [p.id, k]));
  botTrace.fn = (p, ctl) => {
    const k = idx.get(p.id);
    if (k === undefined) return;
    const c = p.car;
    if (c && o.observe) o.observe(k, c, ctl);
    h.update(new Uint8Array(new Float64Array([k, ctl.throttle, ctl.steer, ctl.fire ? 1 : 0, ctl.mine ? 1 : 0, ...(c ? [c.x, c.y, c.h, c.vx, c.vy, c.seg, c.wreck, c.air, c.fall, c.boost] : [0])]).buffer));
  };
  const step = () => {
    tick++;
    now += 1000 / 60;
    room.tick(tick, now);
  };
  const mz = mouthZones(t), hz = hazardZones(t);
  const inZone = (zs: [number, number, number][], road: number, s: number) => zs.some(([r, a, b]) => r === road && s >= a && s <= b);
  let rt = 0;
  try {
    const e = o.tune ? withDevBots(() => room.setBotTune(host, o.tune) ?? room.start(host, now)) : room.start(host, now);
    if (e) throw new Error(e);
    bots.forEach((p, k) => {
      const m = p.bot!.mem;
      m.onMistake = (kind) => void rows[k].mistakes[kind]++;
      const f = o.force?.[k];
      if (f !== undefined) {
        m.plan = f;
        m.planTrack = t;
        m.route = f;
        m.forkDone = 0;
      }
    });
    while (room.phase !== "racing") step();
    if (room.retire(host)) throw new Error("retire");
    bots.forEach((p, k) => (rows[k].plan = p.bot!.mem.plan));
    const prev = bots.map(() => ({ fall: 0, lap: 0, lapAt: 0, wall: false, obstacle: false }));
    events.length = 0;
    const open = o.grace === false;
    while (room.phase === "racing" && rt < 60 * 600) {
      step();
      rt++;
      if (open && room.phase === "racing" && bots.some((p) => !p.progress?.fin)) room.phaseEnds = 0; // open-ended until every bot finishes
      events.length = 0;
      bots.forEach((p, k) => {
        const c = p.car, pr = p.progress, was = prev[k], row = rows[k];
        if (!c || !pr || row.finish > 0) return;
        if (c.fall > 0 && was.fall === 0) row.falls++;
        was.fall = c.fall;
        const road = roadOfSeg(t, c.seg);
        if (road > 0) row.onBranch[road - 1]++;
        if (c.air === 0 && c.fall === 0) {
          const q = queryTrackNear(t, c.x, c.y, c.seg);
          const atWall = q.dist >= wallLimit(t, q) - 0.01;
          if (atWall && !was.wall) row.walls++;
          was.wall = atWall;
          const hit = touchesMound(t, c) || islandContact(t, c) !== null || moveContact(t, c, room.rt) !== null;
          if (hit && !was.obstacle) row.obstacles++;
          was.obstacle = hit;
          if (p.bot!.mem.mistake) {
            row.mistakeSteps++;
            if (inZone(mz, q.road, q.s)) row.badMouth++;
            if (inZone(hz, q.road, q.s)) row.badHazard++;
          }
        }
        if (pr.lap > was.lap) {
          row.lapTicks.push(rt - was.lapAt);
          was.lap = pr.lap;
          was.lapAt = rt;
        }
        if (pr.fin) row.finish = rt; // the tick it crossed the line the last time (its last lap counted above)
      });
    }
  } finally {
    botTrace.fn = null;
  }
  const first = Math.min(...rows.map((x) => (x.finish > 0 ? x.finish : Infinity)));
  for (const x of rows) x.inGrace = x.finish > 0 && x.finish - first <= (FINISH_GRACE_MS * 60) / 1000;
  return { rows, hash: h.digest("hex"), track: t, ticks: rt };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};
const maskText = (t: Track, m: number) => (m < 0 ? "?" : t.branches.map((_, k) => ((m >> k) & 1 ? `${k + 1}` : "-")).join("")) || "-";

/** --plan: the shortcuts per seat, level and car type (L0 and L3). */
export function planTable(id = "branch-yard"): string[] {
  const t = withEnv("SCRAP_DEV_TRACK", id, () => {
    const room = new Room("BRPLAN", 1, CAR_HP);
    const host = room.addPlayer("Host", { conn: { send() {}, close() {} }, room: null, player: null } as Session, 0) as Player;
    const e = room.setTrack(host, id);
    if (e) throw new Error(e);
    return room.track;
  });
  const out: string[] = [];
  for (const lv of [0, 3]) {
    for (const level of ["easy", "normal", "hard"] as BotLevel[]) {
      for (let seat = 0; seat < BOT_LANES.length; seat++) {
        for (const car of CAR_TYPES) {
          const p = routePlan(t, level, seat, car, statsFor(car, { engine: lv, tyres: lv, welder: lv }));
          const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : "never");
          out.push(`L${lv} ${level.padEnd(6)} seat ${seat} ${car.padEnd(5)} route ${maskText(t, p.mask)}  ` + p.rows.map((r) => `b${r.branch} ${r.kind}: ${r.take ? "TAKE" : "main"} ${fmt(r.cost)}/${fmt(r.main)}`).join("  "));
        }
      }
    }
  }
  return out;
}

/** --gain: one bot alone per level and car type on each forced route: median lap and the gain on the main road. */
export function gainTable(id = "branch-yard"): { lines: string[]; gains: { level: BotLevel; car: CarType; route: number; gain: number; falls: number }[] } {
  const lines: string[] = [], gains: { level: BotLevel; car: CarType; route: number; gain: number; falls: number }[] = [];
  const probe = branchRace({ track: id, levels: ["normal"], laps: 1, weapons: false, force: [0] }).track;
  const routes = [0, ...probe.branches.map((_, k) => 1 << k), (1 << probe.branches.length) - 1];
  for (const level of ["easy", "normal", "hard"] as BotLevel[]) {
    for (const car of CAR_TYPES) {
      let base = NaN;
      const parts: string[] = [];
      for (const r of routes) {
        // Seat 2 (lane 0): the bot alone; its levels are a single bot's.
        const levels: BotLevel[] = [level, level, level], cars: CarType[] = [car, car, car];
        const res = branchRace({ track: id, levels: levels.slice(0, 1), cars: cars.slice(0, 1), laps: 3, weapons: false, force: [r] });
        const row = res.rows[0], lap = median(row.lapTicks) / 60;
        if (r === 0) base = lap;
        const gain = base - lap;
        if (r !== 0) gains.push({ level, car, route: r, gain, falls: row.falls });
        parts.push(`${maskText(probe, r)} ${f2(lap)} s${r ? ` (${gain >= 0 ? "+" : ""}${f2(gain)})` : ""} falls ${row.falls} walls ${row.walls} obst ${row.obstacles}${row.finish ? "" : " DNF"}`);
      }
      lines.push(`${level.padEnd(6)} ${car.padEnd(5)}  ${parts.join("  |  ")}`);
    }
  }
  return { lines, gains };
}

/** One acceptance race as lines (per bot: plan, laps, finish, falls, contacts, ticks per branch). */
export function raceLines(label: string, r: ReturnType<typeof branchRace>): string[] {
  const out = [`${label}: ${r.ticks} race ticks, hash ${r.hash.slice(0, 16)}`];
  for (const x of r.rows) {
    out.push(
      `  seat ${x.seat} ${x.level.padEnd(6)} ${x.car.padEnd(5)} route ${maskText(r.track, x.plan)}  finish ${x.finish ? f2(x.finish / 60) + " s" + (x.inGrace ? "" : " (past the 30 s grace)") : "DNF"}  laps ${x.lapTicks.map((l) => f2(l / 60)).join(" ")}  ` +
        `falls ${x.falls}  walls ${x.walls}  obstacles ${x.obstacles}  on branches ${x.onBranch.join("/")}`,
    );
  }
  return out;
}

/** The acceptance races (criterion 4): 3 per level and the mixed 5, each twice. */
export const ACCEPT_RACES: { label: string; levels: BotLevel[] }[] = [
  { label: "3 Easy", levels: ["easy", "easy", "easy"] },
  { label: "3 Normal", levels: ["normal", "normal", "normal"] },
  { label: "3 Hard", levels: ["hard", "hard", "hard"] },
  { label: "mixed 5", levels: ["hard", "normal", "easy", "hard", "normal"] }, // M4-TRACKS' mixed field on the long tracks (track-density.ts raceSet)
];

/** Is a query (the car's road and s) between its road's two gores of some branch (the corridors apart)? */
function pastAGore(t: Track, q: TrackQuery): boolean {
  return t.branches.some((b, k) => {
    const fg = b.forkGore, mg = b.mergeGore;
    if (!fg || !mg) return false;
    return q.road === 0 ? q.s > fg.s && q.s < mg.s : q.road === k + 1 && q.s > fg.u && q.s < mg.u;
  });
}

/** The road a route's ring puts a car at (x, y, its global segment seg) on. */
function ringRoad(t: Track, mask: number, x: number, y: number, seg: number): number {
  const r = routeOf(t, mask);
  return r.segRoad[queryTrackNear(r.ring, x, y, r.hint[seg]).seg];
}

/** A Hard Sport bot's memory driving route `mask`, committed at every fork. */
function goreMem(t: Track, mask: number, lane = BOT_LANES[0]): BotMem {
  const m = newBotMem(lane, "hard", 0, 0, 0);
  m.weapons = false;
  m.plan = m.route = mask;
  m.planTrack = t;
  m.forkDone = (1 << t.branches.length) - 1;
  return m;
}

/** A car at (road, s, lat) of t heading along it at v, its seg the physics' (queryTrackNear round its road's segment). */
function goreCar(t: Track, road: number, s: number, lat: number, v: number): CarState {
  const r = roadOf(t, road), p = pointAt(r, s);
  const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
  const hint = road === 0 ? p.seg : t.branches[road - 1].base + p.seg;
  return { x, y, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: globalSeg(t, queryTrackNear(t, x, y, hint)), wreck: 0, air: 0, fall: 0, boost: 0 };
}

export interface GoreProbe {
  pairs: number; // (point, route) pairs stepped
  past: number; // ... of them past a gore
  wrong: number; // ... whose route's ring is not on the car's road after the step
  first: string[];
  drives: number; // probe 2
  held: number; // steps past a gore with the ring on the other road (summed)
  heldMax: number; // most in one drive
  heldWorst: string;
  closest: number; // the closest any of them came to its wall (car-centre limit - distance)
  walls2: number; // wall contacts begun in probe 2
  mouthDrives: number; // probe 3
  walls3: number; // wall contacts begun in probe 3
}

/** The review-1 probe (see --gores at the top). */
export function goreProbe(t: Track = testTrack("branch-yard")!): GoreProbe {
  const sport = statsFor("sport", { engine: 0, tyres: 0, welder: 0 });
  const nb = t.branches.length, routes = 1 << nb;
  const out: GoreProbe = { pairs: 0, past: 0, wrong: 0, first: [], drives: 0, held: 0, heldMax: 0, heldWorst: "", closest: Infinity, walls2: 0, mouthDrives: 0, walls3: 0 };
  // (1) One step per point and route.
  for (let road = 0; road <= nb; road++) {
    const r = roadOf(t, road);
    for (let s = 5; s < r.length; s += 10) {
      for (let lat = -96; lat <= 96; lat += 12) {
        const c0 = goreCar(t, road, s, lat, 300);
        const q = queryTrackNear(t, c0.x, c0.y, c0.seg);
        if (q.dist > wallLimit(t, q)) continue; // outside the corridor
        const past = pastAGore(t, q);
        for (let mask = 0; mask < routes; mask++) {
          const m = goreMem(t, mask), c = { ...c0 };
          botControls({ car: c, track: t, stats: sport, raceOn: true, raceSteps: 600, others: [], carType: "sport" }, m);
          out.pairs++;
          if (!past) continue;
          out.past++;
          const rr = ringRoad(t, m.route, c.x, c.y, c.seg);
          if (rr !== q.road) {
            out.wrong++;
            if (out.first.length < 4) out.first.push(`road ${q.road} s ${q.s.toFixed(0)} lat ${q.lat.toFixed(0)} route ${mask} -> ring road ${rr}`);
          }
        }
      }
    }
  }
  // Drive one bot for n ticks; per tick told the car (after the step) and the bot's memory.
  const drive = (c: CarState, m: BotMem, n: number, on: (c: CarState, m: BotMem) => void) => {
    for (let rt = 1; rt <= n; rt++) {
      const ctl = botControls({ car: c, track: t, stats: sport, raceOn: true, raceSteps: 600 + rt, others: [], carType: "sport" }, m);
      stepRaceCar(c, { throttle: ctl.throttle, steer: ctl.steer }, sport, raceEnv(t, rt));
      on(c, m);
    }
  };
  const wallTracker = () => {
    let was = false, n = 0;
    return {
      step(c: CarState): number {
        if (c.air > 0 || c.fall > 0) return Infinity;
        const q = queryTrackNear(t, c.x, c.y, c.seg), room = wallLimit(t, q) - q.dist;
        const at = room <= 0.01;
        if (at && !was) n++;
        was = at;
        return room;
      },
      get n() {
        return n;
      },
    };
  };
  // (2) From 1..28 past each fork gore on the main road, route 7.
  for (const b of t.branches) {
    const fg = b.forkGore;
    if (!fg) continue;
    for (let d = 1; d <= 28; d += 3) {
      for (const v of [250, 400]) {
        for (const lane of [-24, 24]) {
          const c = goreCar(t, 0, fg.s + d, lane, v), m = goreMem(t, routes - 1, lane), w = wallTracker();
          let held = 0;
          drive(c, m, 90, (car, mm) => {
            out.closest = Math.min(out.closest, w.step(car));
            const q = queryTrackNear(t, car.x, car.y, car.seg);
            if (pastAGore(t, q) && ringRoad(t, mm.route, car.x, car.y, car.seg) !== q.road) held++;
          });
          out.drives++;
          out.held += held;
          out.walls2 += w.n;
          if (held > out.heldMax) {
            out.heldMax = held;
            out.heldWorst = `fork gore s ${fg.s.toFixed(1)} + ${d}, ${v} u/s, lane ${lane}`;
          }
        }
      }
    }
  }
  // (3) From 20/50/80 % of each fork mouth to its gore, a route taking that cut (alone, and all three).
  t.branches.forEach((b, k) => {
    const fg = b.forkGore;
    if (!fg) return;
    for (const f of [0.2, 0.5, 0.8]) {
      for (const lane of [-36, -12, 12, 36]) {
        for (const mask of [1 << k, routes - 1]) {
          const c = goreCar(t, 0, b.s0 + f * (fg.s - b.s0), lane, 320), w = wallTracker();
          drive(c, goreMem(t, mask, lane), 240, (car) => void w.step(car));
          out.mouthDrives++;
          out.walls3 += w.n;
        }
      }
    }
  });
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const id = arg("--track") ?? "branch-yard";
  if (args.includes("--plan")) for (const l of planTable(id)) console.log(l);
  if (args.includes("--gain")) for (const l of gainTable(id).lines) console.log(l);
  if (args.includes("--races")) {
    for (const a of ACCEPT_RACES) {
      const r1 = branchRace({ track: id, levels: a.levels, grace: false }), r2 = branchRace({ track: id, levels: a.levels, grace: false });
      for (const l of raceLines(a.label, r1)) console.log(l);
      console.log(`  rerun ${r1.hash === r2.hash ? "identical" : "DIFFERS"}`);
    }
  }
  if (args.includes("--mistakes")) {
    for (const weapons of [false, true]) {
      for (const cars of [undefined, ...CAR_TYPES.map((c) => [c, c, c])]) {
        const r = branchRace({ track: id, levels: ["hard", "hard", "hard"], cars, weapons, tune: tuneOf({ rate: 3, size: 1 }) });
        const n = r.rows.reduce((a, x) => a + Object.values(x.mistakes).reduce((p, q) => p + q, 0), 0);
        console.log(
          `weapons ${weapons ? "on " : "off"} ${cars ? cars[0] : "mix  "}: ${n} mistakes begun (${r.rows.map((x) => JSON.stringify(x.mistakes)).join(" ")}), ${r.rows.reduce((a, x) => a + x.mistakeSteps, 0)} steps, ` +
            `in a mouth ${r.rows.reduce((a, x) => a + x.badMouth, 0)}, in a hazard zone ${r.rows.reduce((a, x) => a + x.badHazard, 0)}; falls ${r.rows.map((x) => x.falls).join("/")}, finish ${r.rows.map((x) => (x.finish ? f1(x.finish / 60) : "DNF")).join("/")}`,
        );
      }
    }
  }
  if (args.includes("--gores")) {
    const g = goreProbe();
    console.log(`(1) ${g.pairs} (point, route) pairs, ${g.past} past a gore: ${g.wrong} keep a ring road that is not the car's${g.first.length ? ` (${g.first.join("; ")})` : ""}`);
    console.log(`(2) ${g.drives} drives from fork gore + 1..28 with route 7: ${g.held} steps holding the other road, most ${g.heldMax}${g.heldWorst ? ` (${g.heldWorst})` : ""}; closest to the wall ${g.closest.toFixed(1)}; wall contacts ${g.walls2}`);
    console.log(`(3) ${g.mouthDrives} drives from 20/50/80 % of a fork mouth with a route taking the cut: wall contacts ${g.walls3}`);
  }
  if (args.includes("--cpu")) {
    const steps: number[] = [];
    botTiming.samples = steps;
    let r: ReturnType<typeof branchRace>;
    try {
      r = branchRace({ track: id, levels: ["hard", "hard", "hard", "hard", "hard"] });
    } finally {
      botTiming.samples = null;
    }
    const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
    console.log(`5 Hard bots: bot step median ${(pct(steps, 0.5) * 1000).toFixed(2)} us, p99 ${(pct(steps, 0.99) * 1000).toFixed(2)} us over ${steps.length}; on branches ${r.rows.map((x) => x.onBranch.join("/")).join(" ")}`);
  }
}

if (process.argv[1]?.endsWith("branch-tune.ts")) main();
