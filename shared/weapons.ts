// Weapons, damage states and the race-car step. Pure and shared: the server runs it
// authoritatively and the client uses the same code to predict its own car (wreck freeze
// and respawn included) and to draw its own shots without waiting for the server.

import {
  angleDiff,
  BASE_STATS,
  CAR_LENGTH,
  CAR_RADIUS,
  CAR_WIDTH,
  clamp,
  DT,
  speedOf,
  stepCar,
  wallLimit,
  type CarState,
  type CarStats,
  type Input,
} from "./physics";
import {
  gapAt,
  isLost,
  LIP_ZONE,
  lipAt,
  overHazard,
  pointAt,
  queryTrackNear,
  recoveryAt,
  segDir,
  clearLaneAt,
  tractionRect,
  type PlacedCell,
  type PlacedTyres,
  type Track,
  type TrackQuery,
} from "./track";
import { CELL_AIR_HEIGHT, cellTouch } from "./catchup";

// Nobody can fire or drop a mine until this long after the start (GO), in ms of server
// time. A mine press inside the window is discarded, not saved for later.
export const WEAPONS_ARM_MS = 8000;

// All other timers are in ticks (60 per second).
export const CAR_HP = 100;
export const WRECK_TICKS = 90;
export const GHOST_TICKS = 60;

// Jumps and falls. A grounded car in a ramp's take-off zone moving forward (along the track)
// at MIN_TAKEOFF_SPEED or more takes off for airTicksFor(speed) ticks; slower, it rolls off.
export const MIN_TAKEOFF_SPEED = 220;
export const AIR_TICKS_PER_SPEED = 0.12; // ticks in the air per unit/s of speed at take-off
export const MIN_AIR_TICKS = 20;
export const MAX_AIR_TICKS = 60;
export const FALL_TICKS = 90; // frozen and blinking, then placed at the recovery point

export const RIVET_SPEED = 900;
export const RIVET_RANGE = 650;
export const RIVET_DAMAGE = 4;
export const RIVET_COOLDOWN = 9;
export const RIVET_RADIUS = 2;

export const MINE_ARM_TICKS = 24;
export const MINE_LIFE_TICKS = 25 * 60; // "fade" only: a mine's life
export const MINE_DAMAGE = 15;
export const MINE_RADIUS = 9;
// The room's mines setting (MINES-1): the host picks it; a race uses the one set as it begins.
// - "stay" (the default): a mine lies until it is hit or the race is over, stopped or restarted.
//   At most MINE_CAP lie on the track: one more dropped takes the oldest off it, which is
//   harmless from then on and shown blinking out for MINE_OUT_TICKS.
// - "fade": a mine is gone after MINE_LIFE_TICKS; it blinks over its last MINE_FADE_TICKS and
//   is live to the end.
export const MINE_MODES = ["stay", "fade"] as const;
export type MineMode = (typeof MINE_MODES)[number];
export const DEFAULT_MINE_MODE: MineMode = "stay";
export const MINE_CAP = 40;
export const MINE_FADE_TICKS = 2 * 60;
export const MINE_OUT_TICKS = 60;
// A mine blinking out blinks faster over its last MINE_BLINK_FAST_TICKS (client/gfx/actors.ts).
export const MINE_BLINK_FAST_TICKS = 60;

export function isMineMode(v: unknown): v is MineMode {
  return typeof v === "string" && (MINE_MODES as readonly string[]).includes(v);
}

export const SPIN_KICK = 1.6; // radians
export const SPIN_SPEED = 0.3; // speed kept after a spin-out

// Input buttons: bit 0 = rivet gun held, bits 1-3 = mine press counter (mod 8). A counter
// instead of an edge means a tap survives dropped or repeated inputs.
export const BTN_RIVET = 1;

export interface Command extends Input {
  buttons: number;
}

export const NO_COMMAND: Command = { throttle: 0, steer: 0, buttons: 0 };

export function makeButtons(rivet: boolean, mineCount: number): number {
  return (rivet ? BTN_RIVET : 0) | ((mineCount & 7) << 1);
}

export function mineCount(buttons: number): number {
  return (buttons >> 1) & 7;
}

export interface Shot {
  id: number;
  owner: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  seg: number;
  travelled: number;
}

export interface Mine {
  id: number;
  owner: string;
  x: number;
  y: number;
  age: number;
}

/**
 * What a race step needs besides the car, its input and its stats (M4-ENV, PLAN-M4 3): the
 * track, the race tick and the slipstream. Server and client build it the same way, so time-
 * and draft-dependent rules (moving obstacles, boosts, drafting) predict exactly.
 * - rt: the race tick this step runs at: 1 = the first tick after GO, counted while racing and
 *   not paused (server/room.ts); 0 = before GO (the countdown). The client predicts it from the
 *   latest snapshot's rt (game.ts rtAt). Nothing reads it yet.
 * - draft: this car's slipstream strength 0..1 this tick (M4-DRAFT, shared/catchup.ts): the server
 *   works it out from the start-of-tick poses (draftsFor), the client predicts its own from the
 *   predicted poses (client/contact.ts draft). Applied only to a driving step (stepCar).
 */
export interface RaceEnv {
  track: Track;
  rt: number;
  draft: number;
}

/** A RaceEnv (no slipstream unless given). */
export function raceEnv(track: Track, rt = 0, draft = 0): RaceEnv {
  return { track, rt, draft };
}

/** What stepRaceCar did this tick, beyond driving: the server sets the ghost on "recover". */
export type RaceStepEvent = "takeoff" | "fall" | "recover";

/** Ticks in the air for a jump taken at this speed. */
export function airTicksFor(speed: number): number {
  return clamp(Math.round(speed * AIR_TICKS_PER_SPEED), MIN_AIR_TICKS, MAX_AIR_TICKS);
}

/**
 * Height of an airborne car for drawing, 0 (ground) .. 1 (top of the arc). The jump's total
 * air time is derived from the frozen speed, so CarState needs only `air`.
 */
export function airHeight(c: CarState): number {
  const air = c.air ?? 0;
  if (air <= 0) return 0;
  const total = Math.max(air, airTicksFor(speedOf(c)));
  const t = (total - air) / total;
  return 4 * t * (1 - t);
}

/** Velocity along the track's direction of travel at the car's segment. */
function forwardSpeed(c: CarState, track: Track, q: TrackQuery): number {
  const d = segDir(track, q.seg);
  return c.vx * d.x + c.vy * d.y;
}

function startFall(c: CarState): void {
  c.air = 0;
  c.fall = FALL_TICKS;
  c.vx = 0;
  c.vy = 0;
  c.boost = 0;
}

/**
 * Advance a race car one tick. Server and client both step cars only through this, so the
 * client predicts freezes, jumps, falls and the respawn/recovery jumps exactly.
 * Precedence: wreck > fall > air > drive. A boost (c.boost ticks) counts down on every driving
 * and flying tick; a fall, a wreck and the respawn or recovery that follows end it.
 * - Wrecked: sits still and counts down, then respawns on the centerline at its current
 *   track distance (or at the recovery point when that spot is over a gap or a hole).
 * - Falling: sits still for FALL_TICKS, then is placed at the last recovery point at or
 *   before its s, facing along the track, speed 0 ("recover").
 * - Grounded: lost (> 2 * wall from its own section) -> falls; in a take-off zone moving
 *   forward at MIN_TAKEOFF_SPEED or more -> takes off ("takeoff") and flies this tick;
 *   otherwise over a gap or a hole -> falls ("fall"); otherwise drives (stepCar).
 * - Airborne: committed flight, velocity and heading frozen, no input, no walls. Lost ->
 *   falls. On the last air tick it lands if it is inside the walls of its own section and
 *   not over a gap or a hole, otherwise it falls.
 */
export function stepRaceCar(c: CarState, input: Input, stats: CarStats, env: RaceEnv): RaceStepEvent | null {
  const track = env.track;
  if (c.wreck > 0) {
    c.vx = 0;
    c.vy = 0;
    c.wreck--;
    if (c.wreck === 0) respawn(c, track);
    return null;
  }
  if ((c.fall ?? 0) > 0) {
    c.vx = 0;
    c.vy = 0;
    c.fall = c.fall! - 1;
    if (c.fall === 0) {
      recover(c, track);
      return "recover";
    }
    return null;
  }
  let ev: RaceStepEvent | null = null;
  if (!((c.air ?? 0) > 0)) {
    // Level-triggered checks on the pose the last tick left. c.seg is not touched here,
    // so a plain drive step is exactly stepCar.
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    if (isLost(track, q)) {
      startFall(c);
      return "fall";
    }
    if (lipAt(track, q.s) && forwardSpeed(c, track, q) >= MIN_TAKEOFF_SPEED) {
      c.air = airTicksFor(speedOf(c));
      ev = "takeoff";
    } else if (overHazard(track, c.x, c.y, q.s)) {
      startFall(c);
      return "fall";
    } else {
      stepCar(c, input, stats, track, env.draft);
      if (c.boost > 0) c.boost--;
      return null;
    }
  }
  // Flight (a boost runs on, but a committed flight is not sped up).
  if (c.boost > 0) c.boost--;
  c.x += c.vx * DT;
  c.y += c.vy * DT;
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  c.seg = q.seg;
  c.air = c.air! - 1;
  if (isLost(track, q) || (c.air === 0 && (q.dist > track.wall || overHazard(track, c.x, c.y, q.s)))) {
    startFall(c);
    return "fall";
  }
  return ev;
}

/**
 * Place a fallen car at the last recovery point at or before its s (it has not moved), on the
 * nearest clear lane there (M4-SURF: never in a tyre mound; validation keeps solids SOLID_CLEAR
 * from recovery points, so that is the centerline).
 */
export function recover(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const r = recoveryAt(track, q.s);
  place(c, track, r, clearLaneAt(track, r));
}

/** Put a car `lat` units right of the centerline at s (0 = on it), facing along the track, standing still. */
function place(c: CarState, track: Track, s: number, lat = 0): void {
  const p = pointAt(track, s);
  c.x = lat === 0 ? p.x : p.x - Math.sin(p.h) * lat;
  c.y = lat === 0 ? p.y : p.y + Math.cos(p.h) * lat;
  c.h = p.h;
  c.vx = 0;
  c.vy = 0;
  c.seg = p.seg;
  c.air = 0;
  c.fall = 0;
  c.boost = 0;
}

/**
 * A wreck's respawn: on the centerline at the car's s, or on the nearest clear lane there when a
 * tyre mound is in the way (M4-SURF); a respawn onto a hazard (a gap, a hole) goes to the recovery
 * point instead (and its clear lane).
 */
export function respawn(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const p = pointAt(track, q.s);
  const s = overHazard(track, p.x, p.y, q.s) ? recoveryAt(track, q.s) : q.s;
  place(c, track, s, clearLaneAt(track, s));
}

export function wreckCar(c: CarState): void {
  c.wreck = WRECK_TICKS;
  c.vx = 0;
  c.vy = 0;
  c.air = 0;
  c.fall = 0;
  c.boost = 0;
}

/** Spin away from the mine: deterministic for a given state. */
export function spinOut(c: CarState, mx: number, my: number): void {
  const side = Math.cos(c.h) * (my - c.y) - Math.sin(c.h) * (mx - c.x);
  c.h += side > 0 ? -SPIN_KICK : SPIN_KICK;
  c.vx *= SPIN_SPEED;
  c.vy *= SPIN_SPEED;
}

/** A new rivet leaving the nose of the car (call after the car's step). */
export function spawnShot(c: CarState, id: number, owner: string): Shot {
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  const nose = CAR_LENGTH / 2 + 4;
  return {
    id,
    owner,
    x: c.x + cos * nose,
    y: c.y + sin * nose,
    vx: c.vx + cos * RIVET_SPEED,
    vy: c.vy + sin * RIVET_SPEED,
    seg: c.seg,
    travelled: 0,
  };
}

/** Move a shot one tick. Returns false when it is spent (out of range, into a wall or into a tyre mound). */
export function moveShot(s: Shot, track: Track): boolean {
  const x0 = s.x, y0 = s.y;
  s.x += s.vx * DT;
  s.y += s.vy * DT;
  s.travelled += Math.hypot(s.vx, s.vy) * DT;
  const q = queryTrackNear(track, s.x, s.y, s.seg);
  s.seg = q.seg;
  return s.travelled <= RIVET_RANGE && q.dist <= track.wall && !shotIntoTyres(track.tyresAt[q.seg], x0, y0, s.x, s.y);
}

/** Did a rivet moving from (x0, y0) to (x1, y1) this tick touch a tyre mound (M4-SURF: rivets die on solids)? */
function shotIntoTyres(tyres: readonly PlacedTyres[] | undefined, x0: number, y0: number, x1: number, y1: number): boolean {
  if (tyres === undefined || tyres.length === 0) return false;
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (const m of tyres) {
    let t = len2 > 0 ? ((m.x - x0) * dx + (m.y - y0) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x0 + dx * t - m.x, ey = y0 + dy * t - m.y;
    const r = m.r + RIVET_RADIUS;
    if (ex * ex + ey * ey <= r * r) return true;
  }
  return false;
}

/** A new mine just behind the car. */
export function spawnMine(c: CarState, id: number, owner: string): Mine {
  const back = CAR_LENGTH / 2 + 12;
  return { id, owner, x: c.x - Math.cos(c.h) * back, y: c.y - Math.sin(c.h) * back, age: 0 };
}

/**
 * Did a shot moving from (s0) to (s1) touch a car moving from (c0) to (c1) during the tick?
 * Swept in the car's frame, so head-on passes (~29 units/tick closing) are not missed.
 */
export function shotHits(
  s0x: number, s0y: number, s1x: number, s1y: number,
  c0x: number, c0y: number, c1x: number, c1y: number,
): boolean {
  const ax = s0x - c0x, ay = s0y - c0y;
  const bx = s1x - c1x, by = s1y - c1y;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t, py = ay + dy * t;
  const r = CAR_RADIUS + RIVET_RADIUS;
  return px * px + py * py <= r * r;
}

export function mineHits(m: Mine, c: CarState): boolean {
  const r = CAR_RADIUS + MINE_RADIUS;
  return (c.x - m.x) ** 2 + (c.y - m.y) ** 2 <= r * r;
}

// ---- run-up validation ----------------------------------------------------------------

/** Ticks a run-up may take to get past its hazard (30 s). */
const RUN_UP_MAX_TICKS = 30 * 60;

/** How far either side of a hole the run-up driver keeps to its dodge lane. */
const DODGE_REACH = 160;

/**
 * The lane (lateral offset, + = right of travel) nearest the centerline that keeps a car's
 * centre clear of every hole near s, and of every tyre mound there (M4-SURF: the run-up driver
 * steers round the solids as round the holes). The run-up driver aims along it.
 */
function clearLane(track: Track, s: number): number {
  const L = track.length;
  const reach = (o: { s: number; r: number }) => {
    const ds = Math.abs(s - o.s) % L;
    return Math.min(ds, L - ds) < o.r + DODGE_REACH;
  };
  const near: { lat: number; r: number }[] = track.holes.filter(reach);
  for (const m of track.tyres) if (reach(m)) near.push(m);
  if (!near.length) return 0;
  const max = track.def.halfWidth - CAR_WIDTH / 2;
  for (let k = 0; k <= max; k += 4) {
    for (const lat of k === 0 ? [0] : [k, -k]) {
      if (near.every((h) => Math.abs(lat - h.lat) > h.r + CAR_WIDTH)) return lat;
    }
  }
  return 0;
}

/** How far before a pool the run-up driver forced through it (validateRunUps) is on its lane already. */
const WATER_LEAD = 150;

/**
 * Full throttle, steering at a point ahead on the hole-free lane; with `through` (a pool's traction
 * rectangle, M4-SURF), on the lane down the pool's middle from WATER_LEAD before it to its end.
 */
function runUpInput(track: Track, c: CarState, through?: { s0: number; s1: number; lat0: number; lat1: number }): Input {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const s = q.s + 40 + speedOf(c) * 0.25;
  const t = pointAt(track, s);
  let lat = clearLane(track, s);
  if (through && q.s >= through.s0 - WATER_LEAD && q.s <= through.s1) {
    const max = track.def.halfWidth - CAR_WIDTH / 2;
    lat = clamp((through.lat0 + through.lat1) / 2, -max, max);
  }
  const tx = t.x - Math.sin(t.h) * lat, ty = t.y + Math.cos(t.h) * lat;
  return { throttle: 1, steer: clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1) };
}

/**
 * The hazards a car starting at recovery point r must get past before the next recovery
 * point (wrapping): where the first starts and where the last ends, as distances ahead of r.
 */
function hazardsAhead(track: Track, r: number): { start: number; end: number } | null {
  const L = track.length;
  const ahead = (v: number) => (((v - r) % L) + L) % L;
  const later = track.recovery.map(ahead).filter((d) => d > 0);
  const until = later.length ? Math.min(...later) : L; // the next recovery point
  let start = Infinity, end = -Infinity;
  const add = (s0: number, s1: number) => {
    const a = ahead(s0);
    if (a >= until) return;
    start = Math.min(start, a);
    end = Math.max(end, a + (s1 - s0));
  };
  for (const ramp of track.ramps) add(ramp.s, ramp.s + ramp.len + LIP_ZONE);
  for (const g of track.gaps) add(g.s0, g.s1);
  for (const h of track.holes) add(h.s - h.r, h.s + h.r);
  return start === Infinity ? null : { start, end };
}

/**
 * The run-up check: from every recovery point, a car with `stats` (default: no upgrades)
 * starting at rest at full throttle, steering along the centerline (around holes and tyre
 * mounds), must get past every hazard before the next recovery point without falling, and every
 * jump it makes must land on the asphalt. Catches impossible jumps and fall loops (a fall goes
 * back to the recovery point the run started from). Water in a run-up (M4-SURF, PLAN-M4 2.2): the
 * run is driven again for every pool between the recovery point and the last hazard, on a lane
 * through the pool's middle (it costs the car speed: a pool before a jump can leave it short).
 * Empty = every run-up works.
 */
export function validateRunUps(track: Track, stats: CarStats = BASE_STATS): string[] {
  const errors: string[] = [];
  const L = track.length;
  for (const r of track.recovery) {
    const hz = hazardsAhead(track, r);
    if (!hz) continue;
    const what = `run-up from recovery point s=${r.toFixed(1)} (hazard at s=${((r + hz.start) % L).toFixed(1)})`;
    const problem = runUp(track, r, hz.end, stats);
    if (problem) errors.push(`${what}: ${problem}`);
    for (const w of track.water) {
      const a = (((w.s0 - r) % L) + L) % L;
      if (a >= hz.end) continue; // not in this run-up
      const pool = tractionRect(w);
      if (!(pool.s1 > pool.s0 && pool.lat1 > pool.lat0)) continue; // no area a car feels
      const wet = runUp(track, r, hz.end, stats, pool);
      if (wet) errors.push(`${what}, driven through the water ${w.s0.toFixed(1)}..${w.s1.toFixed(1)} at lat ${((pool.lat0 + pool.lat1) / 2).toFixed(1)}: ${wet}`);
    }
  }
  return errors;
}

/** One run-up from recovery point r past `end` (ahead of r): "" = gets past, else what goes wrong. */
function runUp(track: Track, r: number, end: number, stats: CarStats, through?: { s0: number; s1: number; lat0: number; lat1: number }): string {
  const L = track.length;
  const p = pointAt(track, r);
  const c: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const env = raceEnv(track);
  let sPrev = r;
  let ahead = 0; // distance driven forward from r
  let tookOff = -1; // speed at the last take-off, -1 = none yet
  let problem = "";
  for (let i = 0; i < RUN_UP_MAX_TICKS && !problem; i++) {
    const wasAir = (c.air ?? 0) > 0;
    const v0 = speedOf(c);
    env.rt = i + 1; // as if the run started at GO
    const ev = stepRaceCar(c, runUpInput(track, c, through), stats, env);
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    let d = q.s - sPrev;
    if (d > L / 2) d -= L;
    else if (d < -L / 2) d += L;
    ahead += d;
    sPrev = q.s;
    if (ev === "takeoff") tookOff = v0;
    const jump = tookOff >= 0 ? ` (took off at ${tookOff.toFixed(0)} u/s)` : "";
    if (ev === "fall") {
      const why = !gapAt(track, q.s)
        ? wasAir ? "lands outside the walls" : "falls into a hole"
        : wasAir ? "lands short in a gap" : `rolls into a gap at ${v0.toFixed(0)} u/s (take-off needs ${MIN_TAKEOFF_SPEED})`;
      problem = `${why} at s=${q.s.toFixed(1)}${wasAir ? jump : ""}`;
    } else if (wasAir && (c.air ?? 0) === 0 && q.dist > track.def.halfWidth) {
      problem = `lands off the asphalt at s=${q.s.toFixed(1)} (${q.dist.toFixed(1)} from the centerline)${jump}`;
    } else if (ahead > end + CAR_LENGTH && (c.air ?? 0) === 0) {
      return "";
    }
  }
  return problem || "never gets past it";
}

// ---- jumps at overspeed (M4-DRAFT/M4-CELLS, PLAN-M4 advisor change 7) -------------------

/** Lanes (lateral offsets) the overspeed sweep takes off from: the centre and both sides. */
const SWEEP_LANES = [-32, 0, 32];
/** Arrival speeds are swept in steps of this (u/s), and the maximum itself. */
const SWEEP_STEP = 4;

/**
 * The overspeed sweep: a car arriving at a ramp's lip faster than validateRunUps' run from rest
 * ever gets (the slipstream's ~473 u/s, a boost's ~537) must still land. For every lip, on the
 * centre and on lanes either side, heading along the track, arrival speeds from MIN_TAKEOFF_SPEED
 * up to maxSpeed are flown: the slowest ones may fall short into the gap (validateRunUps proves a
 * run-up gets fast enough), but from the slowest speed that lands up to maxSpeed every one must
 * land without falling. A landing on the dirt verge (inside the walls) counts as landed: running
 * wide is what overspeed costs; with `onAsphalt` it does not (the strict form, as validateRunUps).
 * A flight is frozen (velocity and heading), so the car type does not change it: `stats` drives
 * only the roll after the landing. Empty = every jump lands.
 */
export function validateJumpSweep(track: Track, maxSpeed: number, stats: CarStats = BASE_STATS, onAsphalt = false): string[] {
  const errors: string[] = [];
  const speeds: number[] = [];
  for (let v = MIN_TAKEOFF_SPEED; v < maxSpeed; v += SWEEP_STEP) speeds.push(v);
  speeds.push(maxSpeed);
  for (const ramp of track.ramps) {
    const lip = ramp.s + ramp.len;
    for (const lane of SWEEP_LANES) {
      let landed = -1; // the slowest speed that lands
      const bad: { v: number; why: string }[] = [];
      for (const v of speeds) {
        const why = flyOff(track, lip, lane, v, stats, onAsphalt);
        if (!why && landed < 0) landed = v;
        else if (why && landed >= 0) bad.push({ v, why });
      }
      const at = `jump at the lip s=${lip.toFixed(1)}, lane ${lane}`;
      if (landed < 0) errors.push(`${at}: no take-off up to ${maxSpeed.toFixed(0)} u/s lands`);
      else if (bad.length) errors.push(`${at}: lands from ${landed} u/s, but not at ${bad.map((b) => b.v.toFixed(0)).join(", ")} u/s (${bad[0].why})`);
    }
  }
  return errors;
}

/** Fly off the lip at s=lip, `lane` units right of the centerline, at speed v: "" = lands on the asphalt. */
function flyOff(track: Track, lip: number, lane: number, v: number, stats: CarStats, onAsphalt: boolean): string {
  const p = pointAt(track, lip + 0.5);
  const c: CarState = {
    x: p.x - Math.sin(p.h) * lane, y: p.y + Math.cos(p.h) * lane, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v,
    seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0,
  };
  const env = raceEnv(track);
  for (let i = 0; i < MAX_AIR_TICKS + 2; i++) {
    const wasAir = c.air > 0;
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, stats, env);
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    if (ev === "fall") return `falls at s=${q.s.toFixed(1)}, ${q.dist.toFixed(1)} from the centerline`;
    if (i === 0 && ev !== "takeoff") return "does not take off";
    if (wasAir && c.air === 0) return onAsphalt && q.dist > track.def.halfWidth ? `lands off the asphalt at s=${q.s.toFixed(1)} (${q.dist.toFixed(1)} from the centerline)` : "";
  }
  return "still in the air";
}

// ---- lightning cells (M4-CELLS, PLAN-M4.md 2.5) ------------------------------------------

/**
 * Does car c take `cell` this tick, having moved from (x0, y0) (its pose at the start of the
 * tick)? The fraction of the tick at which it touches it (the earliest wins), or -1. A ground
 * cell: a car on the ground; an air cell: a car in the air at CELL_AIR_HEIGHT or higher in its
 * jump. Never a car that was wrecked or falling at the start of the tick (a respawn or a recovery
 * is a jump, not a drive) or is now. Ghosted and finished cars take nothing: the caller knows
 * those (server: the player; client: its predicted ghost and the snapshot).
 */
export function cellReach(cell: PlacedCell, x0: number, y0: number, wasDown: boolean, c: CarState): number {
  if (wasDown || c.wreck > 0 || c.fall > 0) return -1;
  if (cell.air ? !(c.air > 0 && airHeight(c) >= CELL_AIR_HEIGHT) : c.air > 0) return -1;
  return cellTouch(x0, y0, c.x, c.y, cell.x, cell.y);
}

/** The slowest take-off an air cell asks for (PLAN-M4 2.5: on the arc of take-offs from 300 u/s). */
export const CELL_MIN_TAKEOFF = 300;

/**
 * The take-off speeds (from CELL_MIN_TAKEOFF up to maxSpeed) at which some straight jump off a lip
 * before the air cell passes through it high enough to take it, flown with stepRaceCar from every
 * lane across the lip; null if none.
 */
export function airCellReach(track: Track, cell: PlacedCell, maxSpeed: number): { min: number; max: number; lanes: number } | null {
  const L = track.length;
  const lim = wallLimit(track);
  let min = Infinity, max = -Infinity;
  const lanes = new Set<number>();
  for (const ramp of track.ramps) {
    const lip = ramp.s + ramp.len;
    const ahead = (((cell.s - lip) % L) + L) % L;
    if (ahead <= 0 || ahead > maxSpeed * (MAX_AIR_TICKS / 60) + 20) continue;
    for (let lane = -Math.floor(lim); lane <= lim; lane += 4) {
      for (let v = CELL_MIN_TAKEOFF; v <= maxSpeed; v += SWEEP_STEP) {
        const p = pointAt(track, lip + 0.5);
        const c: CarState = {
          x: p.x - Math.sin(p.h) * lane, y: p.y + Math.cos(p.h) * lane, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v,
          seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0,
        };
        const env = raceEnv(track);
        for (let i = 0; i < MAX_AIR_TICKS + 2; i++) {
          const x0 = c.x, y0 = c.y;
          const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, BASE_STATS, env);
          if (cellReach(cell, x0, y0, false, c) >= 0) {
            min = Math.min(min, v);
            max = Math.max(max, v);
            lanes.add(lane);
            break;
          }
          if (ev === "fall" || (i > 0 && c.air === 0)) break;
        }
      }
    }
  }
  return min === Infinity ? null : { min, max, lanes: lanes.size };
}

/**
 * The cells' simulation checks (validateTrack does the static ones): every air cell lies on the
 * arc of some take-off between CELL_MIN_TAKEOFF and maxSpeed (a boost's ~537 u/s), high enough
 * to be taken. Empty = fine. (That a boosted car still lands every jump is validateJumpSweep.)
 */
export function validateCells(track: Track, maxSpeed: number): string[] {
  const errors: string[] = [];
  for (const c of track.cells) {
    if (!c.air) continue;
    if (!airCellReach(track, c, maxSpeed)) {
      errors.push(`air cell at s=${c.s.toFixed(1)}, lat ${c.lat}: not on the arc of any take-off between ${CELL_MIN_TAKEOFF} and ${maxSpeed.toFixed(0)} u/s (high enough to take it)`);
    }
  }
  return errors;
}
