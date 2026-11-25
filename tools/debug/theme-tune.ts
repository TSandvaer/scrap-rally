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
//   --tracks   THEME-TRACKS (ClickUp 123jpnbfgj5): the theme surfaces of the shipped tracks (Breaker's Mile's sand
//              drifts, Slag Harbour's oil slick). Per patch: the ticks the bots spend on it (by its traction rectangle) in
//              tools/debug/track-density.ts's races (raceSet: 3 bots per level, Sport / Racer / Truck, weapons off and on,
//              and five mixed), per race summed over the bots; and what it costs a clean lap per car type: one server bot
//              alone (Normal and Hard; seat 0, 1 and 2, its lane -24, 24 and 0), weapons off, 3 laps, the mean of laps 2
//              and 3, on the track with only that patch ("round": the bot keeps off it where it can) and with only that
//              patch made wall to wall ("through": no lane round it, the bot drives its line through it), each against the
//              track with no theme surface; and the track as shipped against none. --tracks <track-id> for one track.
//
//   --ford <track-id>  TRACK3: every ford of a shipped track on its own road (a shortcut's too), per drift tried (see below).
//
//   npx tsx tools/debug/theme-tune.ts --numbers | --ab | --ford [track-id] | --race [yard-id] | --tracks [track-id]

import { FORD_AIM, fordAim, laneCost, type BotLevel } from "../../shared/botdrive";
import { CAR_TYPES, CARS, type CarType } from "../../shared/cars";
import { angleDiff, CAR_WIDTH, clamp, DT, OIL_TURN, speedOf, themeDrag, themeGrip, WATER_GRIP_OF_DIRT, WATER_TURN, type CarState, type CarStats } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { CANOPY_YARD, THEME_LOOP, THEME_YARDS } from "../../shared/testtracks";
import type { Theme } from "../../shared/theme";
import { buildTrack, pointAt, queryTrackNear, roadOfSeg, SURF_FORD, SURF_OIL, SURF_SAND, SURF_WATER, surfaceAt, tractionRect, type Feature, type Track, type TrackDef } from "../../shared/track";
import { CAR_HP, raceEnv, stepRaceCar } from "../../shared/weapons";
import { wallHitSpeed } from "../../client/game";
import { botStep, newBotSeat } from "../../server/bots";
import { Room, type Conn, type Player, type Session } from "../../server/room";
import { registerTestTrack, trackById } from "../../shared/tracks";
import { branchRace } from "./branch-tune";
import { raceSet } from "./track-density";

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

// ---- THEME-TRACKS (ClickUp 123jpnbfgj5): the shipped tracks' theme surfaces in numbers ----------------------

/** The shipped tracks with theme surfaces (THEME-TRACKS; TRACK3 added Rootwater Run, its main road's ford here). */
export const THEME_TRACK_IDS = ["slag-harbour", "breakers-mile", "rootwater-run"];

type ThemePatchDef = Extract<Feature, { k: "sand" | "oil" | "ford" }>;
const isThemePatch = (f: Feature): f is ThemePatchDef => f.k === "sand" || f.k === "oil" || f.k === "ford";

/** The shipped track `id` with only the theme surfaces `keep` (indices into its def's theme patches, in def order); `wall`: that one made wall to wall. Not validated: a measuring track. */
export function themeVariant(id: string, keep: number[], wall = -1): Track {
  const def = trackById(id).def;
  const t0 = trackById(id);
  const reach = t0.wall + 40; // past the walls: its traction rectangle covers every lane, the verge's too
  let k = -1;
  const features = (def.features ?? []).flatMap((f): Feature[] => {
    if (!isThemePatch(f)) return [f];
    k++;
    if (!keep.includes(k)) return [];
    return [k === wall ? { ...f, lat0: -reach, lat1: reach } : f];
  });
  return buildTrack({ ...def, features });
}

/** The theme patches of a shipped track's def, in def order. */
export function themePatches(id: string): ThemePatchDef[] {
  return (trackById(id).def.features ?? []).filter(isThemePatch);
}

export interface SoloLaps {
  laps: number[]; // each lap's time (s)
  clean: number; // the mean of laps 2 and 3
  falls: number;
  walls: number; // wall-hit ticks (>= 50 u/s into the wall, client/game.ts wallHitSpeed), as track-density counts them
  on: number; // ticks on a theme surface (its traction rectangle), main road
}

/** One server bot alone on `track` (a Room on its def's id, the track swapped in before the race), seat `seat`, weapons off, 3 laps. */
export function soloLaps(track: Track, level: BotLevel, car: CarType, seat: number): SoloLaps {
  const room = new Room("THEMETR", 3, CAR_HP, track.def.id);
  const inner = room as unknown as { _track: Track; _combat: unknown; newCombat(): unknown };
  inner._track = track; // the measuring track (Room builds its own from the registry); in the lobby, no shots or mines yet
  inner._combat = inner.newCombat();
  let now = 1000, tick = 0;
  const conn = new HostConn();
  const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
  const added: Player[] = [];
  for (let k = 0; k <= seat; k++) {
    const b = room.addBot(host, level, now);
    if (typeof b === "string") throw new Error(b);
    added.push(b);
  }
  for (const b of added.slice(0, seat)) {
    const e = room.kick(host, b.id, now);
    if (e) throw new Error(e);
  }
  const me = added[seat];
  if (me.bot!.slot !== seat) throw new Error(`seat ${me.bot!.slot}, not ${seat}`);
  const e0 = room.setCar(host, car, me.id);
  if (e0) throw new Error(e0);
  me.bot!.mem.weapons = false;
  const e = room.start(host, now);
  if (e) throw new Error(e);
  const step = () => {
    tick++;
    now += 1000 / 60;
    room.tick(tick, now);
  };
  while (room.phase !== "racing") step();
  if (room.retire(host)) throw new Error("retire");
  const out: SoloLaps = { laps: [], clean: NaN, falls: 0, walls: 0, on: 0 };
  let lap = 0, lapRt = 0;
  let prev = { ...me.car! };
  while (room.phase === "racing" && room.rt < 60 * 400) {
    step();
    const c = me.car;
    if (!c) break;
    if (me.progress && me.progress.lap > lap) {
      out.laps.push((room.rt - lapRt) / 60);
      lap = me.progress.lap;
      lapRt = room.rt;
    }
    if (c.fall > 0 && prev.fall === 0) out.falls++;
    if (me.progress?.fin) break;
    if (c.air === 0 && c.fall === 0 && c.wreck === 0 && prev.air === 0) {
      if (wallHitSpeed(prev, c, track) >= 50) out.walls++;
      if (roadOfSeg(track, c.seg) === 0) {
        const q = queryTrackNear(track, c.x, c.y, c.seg);
        const f = surfaceAt(track, q.seg, q.s, q.lat);
        if (f && (f.kind === SURF_SAND || f.kind === SURF_OIL || f.kind === SURF_FORD)) out.on++;
      }
    }
    prev = { ...c };
  }
  out.clean = out.laps.length >= 3 ? (out.laps[1] + out.laps[2]) / 2 : NaN;
  return out;
}

const TRACK_LEVELS: readonly BotLevel[] = ["normal", "hard"];
/** The seats a lone bot is measured from (BOT_LANES: lanes -24, 24 and 0). */
const TRACK_SEATS = [0, 1, 2];

/** One lone-bot measurement against the track with no theme surface: per seat, the clean lap's change (s), ticks on a theme surface, wall-hit ticks and falls. */
export interface LapCost {
  d: number[];
  on: number[];
  walls: number[];
  falls: number;
}

export interface TrackCosts {
  id: string;
  patches: ThemePatchDef[];
  /** track-density's races (raceSet): per race, per patch, each bot's ticks on it (by its traction rectangle). */
  races: { name: string; cars: string[]; ticks: number[][]; falls: number[]; laps: number[][]; same: boolean }[];
  /** [level][car]: the clean laps with no theme surface (per seat), as shipped, and per patch round and through. */
  cost: Record<string, Record<string, { base: number[]; shipped: LapCost; round: LapCost[]; through: LapCost[] }>>;
}

/** --tracks: the numbers for track `id` (see the top of this file). */
export function themeTrackCosts(id: string): TrackCosts {
  const t = trackById(id);
  const patches = themePatches(id);
  const idxOf = patches.map((p) => {
    const r = tractionRect(p);
    return t.themeSurfaces.findIndex((f) => f.s0 === r.s0 && f.s1 === r.s1 && f.lat0 === r.lat0 && f.lat1 === r.lat1);
  });
  const races = raceSet(id).map((r) => ({
    name: r.name, cars: r.a.cars, ticks: patches.map((_, i) => r.a.themes.map((bot) => bot[idxOf[i]] ?? 0)), falls: r.a.falls, laps: r.a.laps, same: r.same,
  }));
  const none = themeVariant(id, []);
  const all = patches.map((_, i) => i);
  const cost: TrackCosts["cost"] = {};
  for (const level of TRACK_LEVELS) {
    cost[level] = {};
    for (const car of CAR_TYPES) {
      const base = TRACK_SEATS.map((seat) => soloLaps(none, level, car, seat));
      const against = (track: Track): LapCost => {
        const runs = TRACK_SEATS.map((seat) => soloLaps(track, level, car, seat));
        return { d: runs.map((r, k) => r.clean - base[k].clean), on: runs.map((r) => r.on), walls: runs.map((r) => r.walls), falls: runs.reduce((a, r) => a + r.falls, 0) };
      };
      cost[level][car] = {
        base: base.map((b) => b.clean),
        shipped: against(themeVariant(id, all)),
        round: patches.map((_, i) => against(themeVariant(id, [i]))),
        through: patches.map((_, i) => against(themeVariant(id, [i], i))),
      };
    }
  }
  return { id, patches, races, cost };
}

/** --tracks: the report lines. */
export function themeTrackLines(c: TrackCosts): string[] {
  const out: string[] = [];
  const t = trackById(c.id);
  const sg = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);
  const name = (p: ThemePatchDef, i: number) => `#${i + 1} ${p.k} s ${p.s0}..${p.s1} lat ${p.lat0}..${p.lat1}`;
  const cell = (x: LapCost) => `${x.d.map(sg).join("/")}${x.walls.some((w) => w > 0) ? ` (walls ${x.walls.join("/")})` : ""}${x.falls ? ` (falls ${x.falls})` : ""}`;
  out.push(`## ${t.def.name} (${c.id}): ${c.patches.length} theme surface(s): ${c.patches.map((p, i) => `${name(p, i)} (${p.s1 - p.s0} long)`).join("; ")}`);
  out.push(`races (track-density raceSet, 3 laps): ${c.races.map((r) => `${r.name} (${r.cars.join("/")}) laps ${r.laps.map((l) => l.map((x) => x.toFixed(2)).join(",")).join(" | ")}, falls ${r.falls.join("/")}, rerun ${r.same ? "SAME" : "DIFFERS"}`).join("; ")}`);
  for (const lv of TRACK_LEVELS) {
    const row = c.cost[lv];
    out.push(`${lv} alone, clean lap (mean of laps 2-3) with no theme surface, seats ${TRACK_SEATS.join("/")}: ${CAR_TYPES.map((car) => `${CARS[car].name} ${row[car].base.map((x) => x.toFixed(2)).join("/")}`).join(", ")} s; as shipped, its change: ${CAR_TYPES.map((car) => `${CARS[car].name} ${cell(row[car].shipped)}`).join(", ")} s`);
  }
  c.patches.forEach((p, i) => {
    out.push(`${name(p, i)}: on it per race (ticks, all bots; per bot): ${c.races.map((r) => `${r.name} ${r.ticks[i].reduce((a, b) => a + b, 0)} (${r.ticks[i].join("/")})`).join(", ")}`);
    for (const lv of TRACK_LEVELS) {
      const row = c.cost[lv];
      out.push(`  ${lv} alone, its lap cost per seat (s): round ${CAR_TYPES.map((car) => `${CARS[car].name} ${cell(row[car].round[i])}`).join(", ")}; through (wall to wall) ${CAR_TYPES.map((car) => `${CARS[car].name} ${cell(row[car].through[i])}`).join(", ")}`);
    }
  });
  return out;
}

// ---- TRACK3 (ClickUp 123jpnbfp0e; PLAN-TRACK3 advisor change 4): a shipped track's fords, each on its own road ----------
// `--ford <track-id>`: every ford of the track, on the main road or on a shortcut (a shortcut's road is narrower: Rootwater
// Run's 48 half-width against the 64 FORD_AIM.gain was tuned at), at its declared drift and at FORD_VX_TRY's (its sign):
// - per car type (L0), a scripted car on lane 0 from FORD_RUN_IN before it at FORD_V0 u/s, full throttle, steering by pursuit
//   at the bots' look-ahead on that road (as fordCross), without and with the upstream aim (fordAim on that road): its lat at
//   the ford's end, the widest |lat| from its start to FORD_AFTER past its end, the slowest speed in it, and the margin the
//   widest leaves to the asphalt's edge less half a car (halfWidth - CAR_WIDTH / 2 - widest: < 0 = a wheel off the asphalt);
// - per car type, a Hard server bot alone, weapons off, its route forced onto that road (a shortcut's mask; the main road 0),
//   3 laps on the track with that ford's drift (a registered variant): the lat at which it enters and leaves the ford's
//   traction rectangle each lap (on that road), the widest |lat| off its entry from there to half a second past its end, and
//   its falls.

/** The drifts tried beside a ford's own (|vx|, its sign). */
export const FORD_VX_TRY = [40, 55, 70, 85, 100];
const FORD_RUN_IN = 300;
const FORD_V0 = 380;
const FORD_AFTER = 400;

/** Every ford of a track: road 0 the main road's, k its branch k - 1's (its road's fords, in its own u). */
export function trackFords(t: Track): { road: number; r: Track; f: Track["fords"][number]; name: string }[] {
  const out: { road: number; r: Track; f: Track["fords"][number]; name: string }[] = t.fords.map((f) => ({ road: 0, r: t, f, name: `main ford s ${f.s0}..${f.s1}` }));
  t.branches.forEach((b, k) => {
    for (const f of b.road.fords) out.push({ road: k + 1, r: b.road, f, name: `shortcut ${k + 1} ford u ${f.s0}..${f.s1}` });
  });
  return out;
}

/** `def` with ford `n` of road `road` (trackFords' order on that road) drifting at vx. */
function fordVariant(def: TrackDef, road: number, n: number, vx: number, id: string): TrackDef {
  const swap = <F extends Feature>(fs: readonly F[]): F[] => {
    let k = -1;
    return fs.map((f) => (f.k === "ford" && ++k === n ? { ...f, vx } : f));
  };
  let b = 0;
  const features = road === 0 ? swap(def.features ?? []) : (def.features ?? []).map((f) => (f.k === "branch" && ++b === road ? { ...f, features: swap(f.features ?? []) } : f));
  return { ...def, id, features };
}

export interface RoadFordCross { exit: number; widest: number; vMin: number; margin: number }

/** The scripted crossing (see above) of ford f on road r of track t. */
export function roadFordCross(t: Track, road: number, r: Track, f: Track["fords"][number], type: CarType, aim: boolean): RoadFordCross {
  const base = road === 0 ? 0 : t.branches[road - 1].base;
  const p = pointAt(r, f.s0 - FORD_RUN_IN);
  const c: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * FORD_V0, vy: Math.sin(p.h) * FORD_V0, seg: base + p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
  const env = raceEnv(t);
  let exit = NaN, widest = 0, vMin = Infinity;
  for (let i = 0; i < 240; i++) {
    const q = queryTrackNear(r, c.x, c.y, c.seg - base);
    const look = 55 + speedOf(c) * 0.3; // the bots' aim look-ahead (as fordCross)
    env.rt = i + 1;
    stepRaceCar(c, { throttle: 1, steer: pursue(r, { ...c, seg: c.seg - base }, 0, aim ? fordAim(r, q.s, q.seg, look, speedOf(c), 0) : 0, look) }, st, env);
    const w = queryTrackNear(r, c.x, c.y, c.seg - base);
    if (w.s >= f.s0 && w.s <= f.s1 + FORD_AFTER) widest = Math.max(widest, Math.abs(w.lat));
    if (w.s >= f.s0 && w.s <= f.s1) vMin = Math.min(vMin, speedOf(c));
    if (exit !== exit && w.s >= f.s1) exit = w.lat;
    if (w.s > f.s1 + FORD_AFTER) break;
  }
  return { exit, widest, vMin, margin: r.def.halfWidth - CAR_WIDTH / 2 - widest };
}

export interface RoadFordBot { entry: number[]; exit: number[]; widest: number; falls: number; laps: number }

/** A Hard bot alone, weapons off, route forced onto `road`, 3 laps on registered track `id`: its crossings of that road's ford n. */
export function roadFordBot(id: string, road: number, n: number, type: CarType): RoadFordBot {
  const t = trackById(id), r = road === 0 ? t : t.branches[road - 1].road, f = r.fords[n], tr = tractionRect(f);
  const out: RoadFordBot = { entry: [], exit: [], widest: 0, falls: 0, laps: 0 };
  let inIt = false, entry = NaN, until = -Infinity, fell = false;
  const res = branchRace({
    track: id, levels: ["hard"], cars: [type], laps: 3, weapons: false, force: [road === 0 ? 0 : 1 << (road - 1)],
    observe: (_k, c) => {
      if (c.fall > 0 && !fell) out.falls++;
      fell = c.fall > 0;
      if (roadOfSeg(t, c.seg) !== road) {
        inIt = false;
        return;
      }
      const base = road === 0 ? 0 : t.branches[road - 1].base;
      const q = queryTrackNear(r, c.x, c.y, c.seg - base);
      const on = q.s >= tr.s0 && q.s <= tr.s1;
      if (on && !inIt) {
        entry = q.lat;
        out.entry.push(q.lat);
        until = tr.s1 + 0.5 * speedOf(c);
      }
      if (!on && inIt && q.s > tr.s1) out.exit.push(q.lat);
      if (entry === entry && q.s >= tr.s0 && q.s <= until) out.widest = Math.max(out.widest, Math.abs(q.lat - entry));
      inIt = on;
    },
  });
  out.laps = res.rows[0].lapTicks.length;
  return out;
}

const fordVariants = new Set<string>();

/** --ford <track-id>: the lines (see above). */
export function trackFordLines(id: string): string[] {
  const t = trackById(id), out: string[] = [];
  const fords = trackFords(t);
  const perRoad = new Map<number, number>();
  for (const { road, r, f, name } of fords) {
    const n = perRoad.get(road) ?? 0;
    perRoad.set(road, n + 1);
    const sign = Math.sign(f.vx);
    const vxs = [f.vx, ...FORD_VX_TRY.map((v) => sign * v).filter((v) => v !== f.vx)];
    out.push(`## ${t.def.name} ${name} (declared vx ${f.vx}, ${f.s1 - f.s0} long, lat ${f.lat0}..${f.lat1}; its road's half-width ${r.def.halfWidth}, a car centre keeps ${r.def.halfWidth - CAR_WIDTH / 2} of the asphalt)`);
    for (const vx of vxs) {
      const vid = `${id}-ford${road}-${n}-vx${vx}`;
      const def = fordVariant(t.def, road, n, vx, vid);
      if (!fordVariants.has(vid)) {
        registerTestTrack(def);
        fordVariants.add(vid);
      }
      const tv = trackById(vid), rv = road === 0 ? tv : tv.branches[road - 1].road, fv = rv.fords[n];
      for (const type of CAR_TYPES) {
        const a = roadFordCross(tv, road, rv, fv, type, false), b = roadFordCross(tv, road, rv, fv, type, true);
        const bot = roadFordBot(vid, road, n, type);
        const list = (x: number[]) => x.map((v) => v.toFixed(0)).join(",");
        out.push(`  vx ${String(vx).padStart(4)} ${CARS[type].name.padEnd(5)}: pursuit only lat ${f1(a.exit)} at its end, widest ${f1(a.widest)} (margin ${f1(a.margin)}), slowest ${f1(a.vMin)}; aim upstream ${f1(b.exit)}, widest ${f1(b.widest)} (margin ${f1(b.margin)}); Hard bot ${bot.laps} laps: entry ${list(bot.entry)}, exit ${list(bot.exit)}, widest off its entry ${f1(bot.widest)}, falls ${bot.falls}`);
      }
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("theme-tune.ts")) {
  const arg = process.argv;
  if (arg.includes("--numbers")) for (const l of themeNumbers()) console.log(l);
  else if (arg.includes("--ab")) for (const l of [...abLines(abRows()), ...brakeRows()]) console.log(l);
  else if (arg.includes("--ford")) {
    const id = arg[arg.indexOf("--ford") + 1];
    for (const l of id && !id.startsWith("--") ? trackFordLines(id) : [...fordCross(), ...fordBotLines()]) console.log(l);
  }
  else if (arg.includes("--race")) {
    const only = arg[arg.indexOf("--race") + 1];
    for (const r of themeRaces(only && !only.startsWith("--") ? only : undefined)) console.log(raceLine(r));
  } else if (arg.includes("--tracks")) {
    const only = arg[arg.indexOf("--tracks") + 1];
    for (const id of THEME_TRACK_IDS) if (!only || only.startsWith("--") || only === id) for (const l of themeTrackLines(themeTrackCosts(id))) console.log(l);
  } else console.log("Usage: npx tsx tools/debug/theme-tune.ts --numbers | --ab | --ford [track-id] | --race [yard-id] | --tracks [track-id]");
}
