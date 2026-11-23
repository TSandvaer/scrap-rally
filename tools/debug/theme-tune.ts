// theme-tune (THEME-SURF, PLAN-THEMES.md 2.3 and advisor change 6, ClickUp 123jpnbfgj3): the numbers
// behind sand, oil and fords, no browser.
//   --numbers  per car type at L0 and L3: the model's factors (shared/physics.ts themeDrag, themeGrip,
//              OIL_TURN), the top speed on sand and in a ford (stats / drag factor, and measured on a long
//              strip) and the grip on oil, beside PLAN-THEMES 2.3's targets; the bots' lane costs.
//   --ab       oil against water (advisor change 6: "oil is nearly water"), per car type: the same patch
//              in the theme yards' tightest bend (s 4000-4180, the outside half, lane -32) and on the top
//              straight (s 800-980, full width, a lane change to +30 asked at its start): the slip angle
//              (velocity against heading) and the speed at its exit, the speed lost over it, and the
//              lateral offset against the same run dry (at the exit and the widest in the 0.5 s after); and the
//              braking distance from 400 to 100 u/s on the straight's patch (oil's brakes are the asphalt's).
//   --ford     a car crossing Canopy Yard's first ford (vx 60, 140 long) from 380 u/s at full throttle on lane 0,
//              steering at the bots' look-ahead: how far the drift takes it holding its lane by pursuit only,
//              and with the bots' upstream aim (fordAim); and a server bot (botStep) made to cross a ford (declared
//              wider than the asphalt, so no dry edge: not a valid track), with the aim and without (FORD_AIM.gain 0).
//   --race     server bots on each theme yard, 3 laps, 3 bots per level (Easy, Normal, Hard) and car type
//              (Sport, Racer, Truck): finish times, falls, wall-hit ticks, ticks on the theme surface;
//              run twice (identical = deterministic). --race <yard-id> for one yard.
//
//   npx tsx tools/debug/theme-tune.ts --numbers | --ab | --ford | --race [yard-id]

import { FORD_AIM, fordAim, laneCost, type BotLevel } from "../../shared/botdrive";
import { CAR_TYPES, CARS, type CarType } from "../../shared/cars";
import { angleDiff, clamp, DT, OIL_TURN, speedOf, themeDrag, themeGrip, WATER_GRIP_OF_DIRT, WATER_TURN, type CarState, type CarStats } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { CANOPY_YARD, THEME_LOOP, THEME_YARDS } from "../../shared/testtracks";
import type { Theme } from "../../shared/theme";
import { buildTrack, pointAt, queryTrackNear, SURF_FORD, SURF_OIL, SURF_SAND, SURF_WATER, surfaceAt, type Feature, type Track } from "../../shared/track";
import { CAR_HP, raceEnv, stepRaceCar } from "../../shared/weapons";
import { wallHitSpeed } from "../../client/game";
import { botStep, newBotSeat } from "../../server/bots";
import { Room, type Conn, type Player, type Session } from "../../server/room";

const f1 = (v: number) => v.toFixed(1);
const LEVELS: readonly BotLevel[] = ["easy", "normal", "hard"];

/** PLAN-THEMES 2.3's targets (Sport / Racer / Truck, no upgrades). */
export const TARGETS: Record<CarType, { sandTop: number; fordTop: number; oilGrip: number }> = {
  sport: { sandTop: 210, fordTop: 274, oilGrip: 0.093 },
  racer: { sandTop: 177, fordTop: 242, oilGrip: 0.075 },
  truck: { sandTop: 323, fordTop: 364, oilGrip: 0.15 },
};

/** THEME_LOOP with this theme and these features (not validated: a measuring track). */
export function loopWith(theme: Theme | undefined, features: Feature[]): Track {
  return buildTrack({ id: "theme-tune", name: "Theme Tune", ...(theme ? { theme } : {}), control: THEME_LOOP, halfWidth: 64, verge: 44, features, recovery: [0] });
}

function carAt(t: Track, s: number, lat: number, v: number): CarState {
  const p = pointAt(t, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
}

function where(t: Track, c: CarState): { s: number; lat: number } {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  return { s: q.s, lat: q.lat };
}

/** The steering toward `lat` at a point `look` ahead (default 60 + v / 5: the tools' pursuit driver), with an extra aim shift. */
function pursue(t: Track, c: CarState, lat: number, shift = 0, look = 60 + speedOf(c) * 0.2): number {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  const a = pointAt(t, q.s + look);
  const l = lat + shift;
  const tx = a.x - Math.sin(a.h) * l, ty = a.y + Math.cos(a.h) * l;
  return clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
}

/** The speed at full throttle at the end of a long strip of `kind` (sand or a ford across the top straight, 700-3000), from 430 u/s: its steady speed. */
export function measuredTop(kind: "sand" | "ford", stats: CarStats): number {
  const t = kind === "sand"
    ? loopWith("desert", [{ k: "sand", s0: 700, s1: 3000, lat0: -64, lat1: 64 }])
    : loopWith("jungle", [{ k: "ford", s0: 700, s1: 3000, lat0: -64, lat1: 64, vx: 20 }]);
  const c = carAt(t, 600, 0, 430);
  const env = raceEnv(t);
  let v = 0;
  for (let i = 0; i < 900; i++) {
    env.rt = i + 1;
    stepRaceCar(c, { throttle: 1, steer: pursue(t, c, 0) }, stats, env);
    if (where(t, c).s > 2900) break; // ~2200 units on it: settled (the Truck's time constant, the slowest, is 0.7 s)
    v = speedOf(c);
  }
  return v;
}

/** --numbers: the per-type factors, top speeds and grip beside the targets, and the bots' lane costs. */
export function themeNumbers(): string[] {
  const out: string[] = [];
  const base = statsFor("sport", { engine: 0, tyres: 0, welder: 0 });
  const d0 = base.accel / base.topSpeed;
  out.push(`(top speed = topSpeed / drag factor; "driven" = the speed a car settles at, a (1 - d DT) / d per tick: the asphalt's ${base.topSpeed} is ${f1((base.accel * (1 - d0 * DT)) / d0)} the same way)`);
  for (const lv of [0, 3]) {
    for (const type of CAR_TYPES) {
      const st = statsFor(type, { engine: lv, tyres: lv, welder: lv });
      const sd = themeDrag(SURF_SAND, st), fd = themeDrag(SURF_FORD, st);
      const sandTop = st.topSpeed / sd, fordTop = st.topSpeed / fd;
      const tg = TARGETS[type];
      const want = lv === 0 ? ` (target ${tg.sandTop} / ${tg.fordTop} / x${tg.oilGrip})` : "";
      out.push(
        `${CARS[type].name} L${lv}: sand drag x${sd.toFixed(3)} top ${f1(sandTop)} u/s (driven: ${f1(measuredTop("sand", st))} per-tick steady), grip x${themeGrip(SURF_SAND, st)}; ` +
          `ford drag x${fd.toFixed(3)} top ${f1(fordTop)} u/s (driven: ${f1(measuredTop("ford", st))}), grip x${themeGrip(SURF_FORD, st)}; ` +
          `oil grip x${themeGrip(SURF_OIL, st).toFixed(4)} (${(st.grip * themeGrip(SURF_OIL, st)).toFixed(3)}/s of ${st.grip}/s; water x${(st.dirtGrip * WATER_GRIP_OF_DIRT).toFixed(4)}), turn x${OIL_TURN} (water x${WATER_TURN})${want}; ` +
          `lane cost sand ${laneCost(SURF_SAND, st).toFixed(3)}, ford ${laneCost(SURF_FORD, st).toFixed(3)}, oil ${laneCost(SURF_OIL, st).toFixed(3)} (water ${laneCost(SURF_WATER, st).toFixed(3)})`,
      );
    }
  }
  return out;
}

export interface AbRow {
  type: CarType;
  where: "bend" | "straight";
  kind: "oil" | "water";
  slipDeg: number; // the slip angle at the patch's exit (degrees, velocity against heading)
  vIn: number; // at its traction s0
  vOut: number; // at its traction s1
  dryOut: number; // the dry run's speed at s1
  lat: number; // lateral offset at s1 against the dry run (+ = right)
  widest: number; // the largest |lateral offset| against the dry run from s1 to 0.5 s after
}

/** One A/B run: a speed-holding pursuit driver on `lane` (from `turnTo` at the patch's start), through `patch` of `kind` and dry. */
function abRun(type: CarType, where0: AbRow["where"], kind: "oil" | "water", patch: { s0: number; s1: number; lat0: number; lat1: number }, lane: number, turnTo: number, v0: number): AbRow {
  const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
  const wet = loopWith(kind === "oil" ? "city" : undefined, [{ k: kind, ...patch } as Feature]);
  const dry = loopWith(undefined, []);
  const felt = { s0: patch.s0 + 12, s1: patch.s1 - 12 };
  const drive = (t: Track) => {
    const c = carAt(t, patch.s0 - 250, lane, v0);
    const env = raceEnv(t);
    const rows: { s: number; lat: number; v: number; slip: number }[] = [];
    for (let i = 0; i < 240; i++) {
      const w = where(t, c);
      const lat = w.s >= patch.s0 ? turnTo : lane;
      env.rt = i + 1;
      stepRaceCar(c, { throttle: speedOf(c) < v0 ? 1 : 0, steer: pursue(t, c, lat) }, st, env);
      const vh = Math.atan2(c.vy, c.vx);
      rows.push({ ...where(t, c), v: speedOf(c), slip: Math.abs(angleDiff(c.h, vh)) * (180 / Math.PI) });
    }
    return rows;
  };
  const a = drive(wet), b = drive(dry);
  const at = (rows: typeof a, s: number) => rows.findIndex((r) => r.s >= s);
  const iIn = at(a, felt.s0), iOut = at(a, felt.s1), jOut = at(b, felt.s1);
  let widest = 0;
  for (let k = 0; k <= 30; k++) {
    const ra = a[iOut + k], rb = b[jOut + k];
    if (ra && rb) widest = Math.max(widest, Math.abs(ra.lat - rb.lat));
  }
  return { type, where: where0, kind, slipDeg: a[iOut].slip, vIn: a[iIn].v, vOut: a[iOut].v, dryOut: b[jOut].v, lat: a[iOut].lat - b[jOut].lat, widest };
}

/** --ab: oil against water per type, in the bend and on the straight. */
export function abRows(): AbRow[] {
  const rows: AbRow[] = [];
  for (const type of CAR_TYPES) {
    for (const kind of ["oil", "water"] as const) {
      rows.push(abRun(type, "bend", kind, { s0: 4000, s1: 4180, lat0: -64, lat1: 0 }, -32, -32, 300));
      rows.push(abRun(type, "straight", kind, { s0: 800, s1: 980, lat0: -64, lat1: 64 }, 0, 30, 400));
    }
  }
  return rows;
}

/** The braking A/B: full brake from 400 u/s at the start of the straight's patch (800-980, full width) down to 100 u/s: how far it takes, on oil, in water and dry. */
export function brakeRows(): string[] {
  const out: string[] = [];
  for (const type of CAR_TYPES) {
    const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
    const dist = (t: Track) => {
      const c = carAt(t, 600, 0, 400);
      const env = raceEnv(t);
      let from = NaN;
      for (let i = 0; i < 400; i++) {
        const w = where(t, c);
        if (from !== from && w.s >= 812) from = w.s; // the traction rectangle's start
        env.rt = i + 1;
        stepRaceCar(c, { throttle: from === from ? -1 : speedOf(c) < 400 ? 1 : 0, steer: pursue(t, c, 0) }, st, env); // 400 held up to it
        if (from === from && speedOf(c) <= 100) return where(t, c).s - from;
      }
      return NaN;
    };
    const oil = dist(loopWith("city", [{ k: "oil", s0: 800, s1: 980, lat0: -64, lat1: 64 }]));
    const water = dist(loopWith(undefined, [{ k: "water", s0: 800, s1: 980, lat0: -64, lat1: 64 }]));
    const dry = dist(loopWith(undefined, []));
    out.push(`${CARS[type].name.padEnd(5)} brake    400 -> 100 u/s from the patch's start: oil ${f1(oil)}, water ${f1(water)}, dry ${f1(dry)} units`);
  }
  return out;
}

export function abLines(rows: AbRow[]): string[] {
  return rows.map((r) =>
    `${CARS[r.type].name.padEnd(5)} ${r.where.padEnd(8)} ${r.kind.padEnd(5)}: exit slip ${f1(r.slipDeg)} deg; speed ${f1(r.vIn)} -> ${f1(r.vOut)} u/s over it (lost ${f1(r.vIn - r.vOut)}; dry exits at ${f1(r.dryOut)}); lateral offset vs dry ${f1(r.lat)} at the exit, widest ${f1(r.widest)} in the 0.5 s after`,
  );
}

/** --ford: Canopy Yard's first ford (800-940, vx 60) at a bot's speed on lane 0: pursuit only, and with fordAim. */
export function fordCross(): string[] {
  const t = buildTrack(CANOPY_YARD);
  const out: string[] = [];
  for (const type of CAR_TYPES) {
    const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
    for (const aim of [false, true]) {
      const c = carAt(t, 600, 0, 380);
      const env = raceEnv(t);
      let worst = 0, outLat = NaN, vMin = Infinity;
      for (let i = 0; i < 120; i++) {
        const q = queryTrackNear(t, c.x, c.y, c.seg);
        const look = 55 + speedOf(c) * 0.3; // the bots' aim look-ahead off holes (botControls)
        env.rt = i + 1;
        stepRaceCar(c, { throttle: 1, steer: pursue(t, c, 0, aim ? fordAim(t, q.s, q.seg, look, speedOf(c), 0) : 0, look) }, st, env);
        const w = where(t, c);
        if (w.s > 800 && w.s < 1200) worst = Math.max(worst, Math.abs(w.lat));
        if (w.s > 800 && w.s < 940) vMin = Math.min(vMin, speedOf(c));
        if (outLat !== outLat && w.s >= 940) outLat = w.lat;
      }
      out.push(`${CARS[type].name.padEnd(5)} ${aim ? "aim upstream" : "pursuit only"}: at the ford's end lat ${f1(outLat)}, the widest |lat| from 800 to 1200 ${f1(worst)}, slowest in it ${f1(vMin)} u/s`);
    }
  }
  return out;
}

export interface FordBot {
  type: CarType;
  vx: number;
  gain: number;
  entry: number; // lat at the ford's traction s0
  exit: number; // lat at its s1
  widest: number; // the largest |lat - entry| from s0 to 0.5 s past s1
  vIn: number;
}

/**
 * A server bot (botStep, seat 2: racing line 0) made to cross a ford: THEME_LOOP (jungle, not validated) with a
 * ford 800-940 drifting vx declared wider than the asphalt (lat -80..80: its traction rectangle covers every
 * lane, so the lane search has no dry edge to go round it on). `gain` is set as FORD_AIM.gain for the run (the
 * bots' shipped upstream aim is FORD_AIM.gain, 1.5; 0: none) and put back after.
 */
export function fordBot(type: CarType, vx: number, gain: number): FordBot {
  const t = loopWith("jungle", [
    { k: "ford", s0: 800, s1: 940, lat0: -80, lat1: 80, vx },
  ]);
  const old = FORD_AIM.gain;
  FORD_AIM.gain = gain;
  try {
    const p = pointAt(t, 300);
    const stats = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
    const me = {
      id: "b", car: { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 300, vy: Math.sin(p.h) * 300, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 } as CarState,
      finished: false, hp: CAR_HP, maxHp: CAR_HP, ghost: 0, cooldown: 0, ammo: { rivets: 0, mines: 0 }, levels: { engine: 0, tyres: 0, welder: 0 },
      stats, bot: newBotSeat("normal", 2, 0), carType: type,
    };
    me.bot.mem.weapons = false;
    const env = raceEnv(t);
    const felt = { s0: 812, s1: 928 };
    let entry = NaN, exit = NaN, widest = 0, vIn = 0;
    for (let rt = 1; rt < 400; rt++) {
      const cmd = botStep(me, [me], t, true, [], [], rt).cmd;
      env.rt = rt;
      stepRaceCar(me.car, cmd, stats, env);
      const w = where(t, me.car);
      if (entry !== entry && w.s >= felt.s0) {
        entry = w.lat;
        vIn = speedOf(me.car);
      }
      if (exit !== exit && w.s >= felt.s1) exit = w.lat;
      if (entry === entry && w.s < felt.s1 + 0.5 * vIn) widest = Math.max(widest, Math.abs(w.lat - entry));
      if (w.s > felt.s1 + vIn) break;
    }
    return { type, vx, gain, entry, exit, widest, vIn };
  } finally {
    FORD_AIM.gain = old;
  }
}

export function fordBotLines(): string[] {
  const out: string[] = [];
  for (const vx of [60, -100]) {
    for (const type of CAR_TYPES) {
      const on = fordBot(type, vx, FORD_AIM.gain), off = fordBot(type, vx, 0); // the shipped aim against none
      out.push(`bot through a ford (vx ${vx}): ${CARS[type].name.padEnd(5)} at ${f1(on.vIn)} u/s: aim upstream lat ${f1(on.entry)} -> ${f1(on.exit)} (widest off its entry ${f1(on.widest)}); no aim ${f1(off.entry)} -> ${f1(off.exit)} (widest ${f1(off.widest)})`);
    }
  }
  return out;
}

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results") this.msgs.push(m);
  }
  close(): void {}
}

export interface ThemeRace {
  track: string;
  level: BotLevel;
  car: CarType;
  phase: string;
  ticks: number;
  finished: number; // bots with a finish time
  finish: string[]; // name:seconds, in finish order (0 = did not finish)
  falls: number[];
  walls: number[]; // wall-hit ticks (>= 50 u/s into the wall) per bot
  on: number[]; // ticks on the yard's theme surface per bot
  digest: string; // every tick's car states, for the rerun check
}

/** A `laps`-lap Room race of three server bots of `level`, each in a `car`, on `trackId` (the dev flag on), the host retired at GO. */
export function themeRace(trackId: string, level: BotLevel, car: CarType, laps = 3): ThemeRace {
  const old = process.env.SCRAP_DEV_TRACK;
  process.env.SCRAP_DEV_TRACK = trackId;
  try {
    const room = new Room("THEME", laps, CAR_HP, trackId);
    let now = 1000, tick = 0;
    const conn = new HostConn();
    const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
    const bots = [0, 1, 2].map(() => {
      const b = room.addBot(host, level, now);
      if (typeof b === "string") throw new Error(b);
      const e = room.setCar(host, car, b.id);
      if (e) throw new Error(e);
      return b;
    });
    const e = room.start(host, now);
    if (e) throw new Error(e);
    const step = () => {
      tick++;
      now += 1000 / 60;
      room.tick(tick, now);
    };
    while (room.phase !== "racing") step();
    if (room.retire(host)) throw new Error("retire");
    const t = room.track;
    const out: ThemeRace = { track: trackId, level, car, phase: "", ticks: 0, finished: 0, finish: [], falls: [0, 0, 0], walls: [0, 0, 0], on: [0, 0, 0], digest: "" };
    const prev = bots.map((b) => ({ ...b.car! }));
    let h = 0;
    while (room.phase === "racing" && out.ticks < 60 * 60 * 6) {
      step();
      out.ticks++;
      bots.forEach((b, k) => {
        const c = b.car;
        if (!c) return;
        const p = prev[k];
        if (c.fall > 0 && p.fall === 0) out.falls[k]++;
        if (c.air === 0 && c.fall === 0 && c.wreck === 0 && p.air === 0) {
          if (wallHitSpeed(p, c, t) >= 50) out.walls[k]++;
          const q = queryTrackNear(t, p.x, p.y, p.seg);
          const f = surfaceAt(t, q.seg, q.s, q.lat);
          if (f && (f.kind === SURF_SAND || f.kind === SURF_OIL || f.kind === SURF_FORD)) out.on[k]++;
        }
        for (const v of [c.x, c.y, c.vx, c.vy]) h = (Math.imul(h ^ Math.floor(v * 1e6), 16777619) + 1) | 0;
        prev[k] = { ...c };
      });
    }
    out.phase = room.phase;
    const res = conn.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
    const rows = res ? res.rows.filter((r) => r.name !== "Host") : [];
    out.finished = rows.filter((r) => r.timeMs > 0).length;
    out.finish = rows.map((r) => `${r.name}:${(r.timeMs / 1000).toFixed(2)}`);
    out.digest = (h >>> 0).toString(16);
    return out;
  } finally {
    if (old === undefined) delete process.env.SCRAP_DEV_TRACK;
    else process.env.SCRAP_DEV_TRACK = old;
  }
}

/** Every theme yard (or one) x level x car type, raced twice. */
export function themeRaces(only?: string): { a: ThemeRace; same: boolean }[] {
  const out: { a: ThemeRace; same: boolean }[] = [];
  for (const def of THEME_YARDS) {
    if (only && def.id !== only) continue;
    for (const level of LEVELS) {
      for (const car of CAR_TYPES) {
        const a = themeRace(def.id, level, car), b = themeRace(def.id, level, car);
        out.push({ a, same: a.digest === b.digest && a.finish.join() === b.finish.join() });
      }
    }
  }
  return out;
}

export function raceLine(r: { a: ThemeRace; same: boolean }): string {
  const a = r.a;
  return `${a.track.padEnd(11)} ${a.level.padEnd(6)} ${a.car.padEnd(5)}: ${a.phase} after ${a.ticks} ticks, ${a.finished}/3 finished (${a.finish.join(", ")}); falls ${a.falls.join("/")}; wall-hit ticks ${a.walls.join("/")}; on the theme surface ${a.on.join("/")} ticks; rerun ${r.same ? "identical" : "DIFFERS"}`;
}

if (process.argv[1]?.endsWith("theme-tune.ts")) {
  const arg = process.argv;
  if (arg.includes("--numbers")) for (const l of themeNumbers()) console.log(l);
  else if (arg.includes("--ab")) for (const l of [...abLines(abRows()), ...brakeRows()]) console.log(l);
  else if (arg.includes("--ford")) for (const l of [...fordCross(), ...fordBotLines()]) console.log(l);
  else if (arg.includes("--race")) {
    const only = arg[arg.indexOf("--race") + 1];
    for (const r of themeRaces(only && !only.startsWith("--") ? only : undefined)) console.log(raceLine(r));
  } else console.log("Usage: npx tsx tools/debug/theme-tune.ts --numbers | --ab | --ford | --race [yard-id]");
}
