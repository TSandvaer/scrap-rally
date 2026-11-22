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
// Normal, Easy, Normal, Hard on seats 0..4), weapons on, 3 laps, each run twice: finishes, laps, falls
// per bot, wall and obstacle (mound, gore nose, island, mover) contacts, ticks per shortcut, the plan
// per seat, and whether the rerun is identical (a SHA-256 over every tick's controls and car state).
//
// --mistakes: 3 Hard bots with the Bot tune knob at rate 3, size 1 (weapons off and on): the mistakes
// begun, and any step of one inside a mouth (fork or merge to MOUTH_CLEAR past its gore, on either road)
// or within a shortcut hazard's zone (650 before a ramp, gap, hole or dirt patch on a branch to 15 past it).
//
// --cpu: 5 Hard bots, 3 laps: the median and p99 bot step and room tick.
//
// The race runner (branchRace) is used by scripts/sim-test.ts (section BR-BOTS).

import { createHash } from "node:crypto";
import { botTiming, botTrace } from "../../server/bots";
import { Room, type Player, type Session } from "../../server/room";
import { BOT_LANES, routePlan, type BotLevel, type BotTune, type MistakeKind } from "../../shared/botdrive";
import { CAR_TYPES, type CarType } from "../../shared/cars";
import { wallLimit } from "../../shared/physics";
import type { GameEvent, ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { MOUTH_CLEAR, queryTrackNear, roadOfSeg, type Track } from "../../shared/track";
import { CAR_HP } from "../../shared/weapons";
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
    onBranch: new Array<number>(nb).fill(0), mistakes: { "late-brake": 0, wide: 0, wobble: 0, hesitate: 0 }, mistakeSteps: 0, badMouth: 0, badHazard: 0,
  }));
  const h = createHash("sha256");
  const idx = new Map(bots.map((p, k) => [p.id, k]));
  botTrace.fn = (p, ctl) => {
    const k = idx.get(p.id);
    if (k === undefined) return;
    const c = p.car;
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
    while (room.phase === "racing" && rt < 60 * 600) {
      step();
      rt++;
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
      `  seat ${x.seat} ${x.level.padEnd(6)} ${x.car.padEnd(5)} route ${maskText(r.track, x.plan)}  finish ${x.finish ? f2(x.finish / 60) + " s" : "DNF"}  laps ${x.lapTicks.map((l) => f2(l / 60)).join(" ")}  ` +
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
  { label: "mixed 5", levels: ["hard", "normal", "easy", "normal", "hard"] },
];

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
      const r1 = branchRace({ track: id, levels: a.levels }), r2 = branchRace({ track: id, levels: a.levels });
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
