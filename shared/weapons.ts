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
  segMeetsBox,
  speedOf,
  stepCar,
  wallLimit,
  type CarState,
  type CarStats,
  type Input,
} from "./physics";
import {
  BARREL_R,
  barrelLat,
  clearSpotOn,
  gapAt,
  halfOf,
  halfOn,
  isLost,
  LIP_ZONE,
  lipAt,
  overHazard,
  pointAt,
  PRESS_DEPTH,
  pressDown,
  queryMain,
  queryTrackNear,
  recoveryAt,
  globalSeg,
  recoveryFor,
  roadFor,
  roadOf,
  segDir,
  tractionRect,
  TRUCK_BAND,
  TRUCK_HALF,
  wallOf,
  wrapS,
  type PlacedCell,
  type PlacedIsland,
  type PlacedTruck,
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
 *   latest snapshot's rt (game.ts rtAt). M4-MOVE: the barrels and presses a driving step meets are
 *   where barrelLat / pressState put them at it (shared/physics.ts stepCar).
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
 *   not over a gap or a hole, otherwise it falls. Walls and the lost distance are the per-sample
 *   ones on the car's side (wallOf; M4-SURF part 2). Islands are solid only for a car on the
 *   ground: a flight passes over one, and a car that lands on one is put back in the nearer lane
 *   by its next driving step (shared/physics.ts collideIslands), as a landing on a solid.
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
    // so a plain drive step is exactly stepCar. BR-PHYS: on the road the query is on (the
    // nearer one in a mouth): its lips, trucks, gaps and holes, its walls for "lost".
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const road = roadFor(track, q);
    if (isLost(road, q)) {
      startFall(c);
      return "fall";
    }
    if ((lipAt(road, q.s) || onTruckLip(road, q)) && forwardSpeed(c, road, q) >= MIN_TAKEOFF_SPEED) {
      c.air = airTicksFor(speedOf(c));
      ev = "takeoff";
    } else if (overHazard(road, c.x, c.y, q.s)) {
      startFall(c);
      return "fall";
    } else {
      stepCar(c, input, stats, track, env.draft, env.rt);
      if (c.boost > 0) c.boost--;
      return null;
    }
  }
  // Flight (a boost runs on, but a committed flight is not sped up).
  if (c.boost > 0) c.boost--;
  c.x += c.vx * DT;
  c.y += c.vy * DT;
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const road = roadFor(track, q);
  c.seg = globalSeg(track, q);
  c.air = c.air! - 1;
  if (isLost(road, q) || (c.air === 0 && (q.dist > wallOf(road, q) || overHazard(road, c.x, c.y, q.s)))) {
    startFall(c);
    return "fall";
  }
  return ev;
}

/**
 * A ramp truck's take-off zone holds the query's car centre (shared/track.ts truckLipAt, from the
 * query segment's bucket: no scan of every truck per tick). Always false on a track without one.
 */
function onTruckLip(track: Track, q: TrackQuery): boolean {
  const list = track.trucksAt[q.seg];
  if (list === undefined || list.length === 0) return false;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (q.s >= t.lip && q.s < t.lip + LIP_ZONE && q.lat >= t.band0 && q.lat <= t.band1) return true;
  }
  return false;
}

/**
 * Place a fallen car at the last recovery point at or before its s (it has not moved), on the
 * nearest clear lane there (M4-SURF: never in a tyre mound; validation keeps solids SOLID_CLEAR
 * from recovery points, so that is the centerline). M4-MOVE: clearSpot, also clear of the barrels'
 * path, the presses and the trucks. BR-PHYS (PLAN-BRANCH 2.5, user decision 6): on the road it fell
 * on (the nearer one): on a branch its last recovery point at or before u, else the main road's
 * before the fork (recoveryFor, clearSpotOn).
 */
export function recover(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const r = recoveryFor(track, q.road, q.s);
  const at = clearSpotOn(track, r.road, r.s);
  place(c, track, at.road, at.s, at.lat);
}

/**
 * Put a car `lat` units right of the centerline at s (0 = on it) on road `road` (0 = the main road;
 * BR-PHYS: its global segment in c.seg), facing along the track, standing still.
 */
function place(c: CarState, track: Track, road: number, s: number, lat = 0): void {
  const own = road === track.roadNo; // the track's own road (the main road on a track)
  const p = pointAt(own ? track : roadOf(track, road), s);
  c.x = lat === 0 ? p.x : p.x - Math.sin(p.h) * lat;
  c.y = lat === 0 ? p.y : p.y + Math.cos(p.h) * lat;
  c.h = p.h;
  c.vx = 0;
  c.vy = 0;
  c.seg = own ? p.seg : track.branches[road - 1].base + p.seg;
  c.air = 0;
  c.fall = 0;
  c.boost = 0;
}

/**
 * A wreck's respawn: on the centerline at the car's s, or on the nearest clear lane there when a
 * tyre mound is in the way (M4-SURF); a respawn onto a hazard (a gap, a hole) goes to the recovery
 * point instead (and its clear lane). In a split (M4-SURF part 2) the clear lane is in the lane the
 * car wrecked in (clearLaneAt's side of the island: the car's own lateral offset). M4-MOVE
 * (clearSpot): never in a barrel row's path, under a press or in a truck: on a lane clear of them,
 * or just behind one that leaves no lane.
 */
export function respawn(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  // BR-PHYS: on its own road (the nearer one); a hazard there sends it to recoveryFor's point.
  const road = roadFor(track, q);
  const p = pointAt(road, q.s);
  const back = overHazard(road, p.x, p.y, q.s) ? recoveryFor(track, q.road, q.s) : null;
  const at = clearSpotOn(track, back === null ? q.road : back.road, back === null ? q.s : back.s, 4, q.lat);
  place(c, track, at.road, at.s, at.lat);
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

/**
 * Move a shot one tick, at race tick rt. Returns false when it is spent (out of range, into a wall,
 * into a tyre mound, or into an island or its noses: M4-SURF part 2, the wall on its side is the
 * per-sample one; M4-MOVE: into a barrel where barrelLat puts it at rt, a press that is down at rt,
 * or a truck's body). Server: server/combat.ts, at the tick the cars stepped; the client's cosmetic
 * rivets (client/game.ts) at the tick the server moves them.
 */
export function moveShot(s: Shot, track: Track, rt: number): boolean {
  const x0 = s.x, y0 = s.y;
  s.x += s.vx * DT;
  s.y += s.vy * DT;
  const step = Math.hypot(s.vx, s.vy) * DT;
  s.travelled += step;
  const q = queryTrackNear(track, s.x, s.y, s.seg);
  // BR-PHYS: the road the rivet is over (the nearer one in a mouth), its global segment kept.
  const road = roadFor(track, q);
  s.seg = globalSeg(track, q);
  return s.travelled <= RIVET_RANGE && q.dist <= wallOf(road, q) && !shotIntoTyres(road.tyresAt[q.seg], x0, y0, s.x, s.y) && !shotIntoIslands(road, q, x0, y0, s.x, s.y) &&
    !shotIntoMovers(road, q.seg, x0, y0, s.x, s.y, rt, s.travelled - step);
}

/**
 * Did a rivet moving from (x0, y0) to (x1, y1) this tick (seg: its segment at the end) touch a barrel
 * at race tick rt, a press that is down at rt, or a truck's body (M4-MOVE: rivets die on solids)?
 * From the segment's buckets (empty on a track without any). back: how far it flew before this tick
 * (its flight is straight: it was fired from (x0, y0) less that much along its way).
 */
function shotIntoMovers(track: Track, seg: number, x0: number, y0: number, x1: number, y1: number, rt: number, back: number): boolean {
  const rows = track.barrelsAt[seg], gates = track.pressesAt[seg], trucks = track.trucksAt[seg];
  if (rows !== undefined && rows.length > 0) {
    const r = BARREL_R + RIVET_RADIUS;
    for (const b of rows) {
      for (let k = 0; k < b.n; k++) {
        const lat = barrelLat(b, k, rt);
        if (lat !== lat) continue; // in the gutter
        if (pointSegDist2(b.x + b.nx * lat, b.y + b.ny * lat, x0, y0, x1, y1) <= r * r) return true;
      }
    }
  }
  if (gates !== undefined && gates.length > 0) {
    for (const g of gates) {
      if (!pressDown(g, rt)) continue;
      const gx = Math.cos(g.h), gy = Math.sin(g.h);
      const a0 = (x0 - g.x) * gx + (y0 - g.y) * gy, l0 = (x0 - g.x) * g.nx + (y0 - g.y) * g.ny;
      const a1 = (x1 - g.x) * gx + (y1 - g.y) * gy, l1 = (x1 - g.x) * g.nx + (y1 - g.y) * g.ny;
      if (segMeetsBox(a0, l0, a1, l1, PRESS_DEPTH / 2 + RIVET_RADIUS, g.lat0 - RIVET_RADIUS, g.lat1 + RIVET_RADIUS)) return true;
    }
  }
  if (trucks !== undefined && trucks.length > 0) {
    // A rivet FIRED in a truck's ramp band (from a car riding it) passes that truck, as the car does
    // (M4-MOVE review F3, the coordinator's call); every other one dies on its body. Decided by where it
    // was fired, not where this tick starts (review 2: one from behind could come round the body's round
    // rear corner into the band untouched and then pass).
    for (const t of trucks) {
      if (segSegDist(x0, y0, x1, y1, t) > TRUCK_HALF + RIVET_RADIUS) continue;
      const dx = x1 - x0, dy = y1 - y0, dl = Math.sqrt(dx * dx + dy * dy) || 1;
      if (!rivetInBand(t, x0 - (dx / dl) * back, y0 - (dy / dl) * back, dx, dy)) return true;
    }
  }
  return false;
}

/**
 * Was a rivet fired at (fx, fy), flying along (dx, dy), fired in truck t's ramp band moving forward along
 * it (from a car riding the band)? In the truck's own frame (its axis from x0, y0 to x1, y1, TRUCK_HALF in
 * from either end): within TRUCK_BAND of the axis, along it from the rear to the front plus the rivet's
 * radius and a unit (a car at the end of the take-off zone fires from just past the cab).
 */
function rivetInBand(t: PlacedTruck, fx: number, fy: number, dx: number, dy: number): boolean {
  const ex = t.x1 - t.x0, ey = t.y1 - t.y0;
  const l = Math.sqrt(ex * ex + ey * ey) || 1;
  const ux = ex / l, uy = ey / l;
  if (dx * ux + dy * uy <= 0) return false; // not flying forward along the truck
  const along = (fx - t.x0) * ux + (fy - t.y0) * uy + TRUCK_HALF; // from the rear
  const across = -(fx - t.x0) * uy + (fy - t.y0) * ux;
  return along >= 0 && along <= t.len + RIVET_RADIUS + 1 && across >= -TRUCK_BAND && across <= TRUCK_BAND;
}

/** Squared distance from (px, py) to the segment (x0, y0)..(x1, y1). */
function pointSegDist2(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x0 + dx * t - px, ey = y0 + dy * t - py;
  return ex * ex + ey * ey;
}

/** Distance from the segment (x0, y0)..(x1, y1) to a truck's body axis (0 when they cross). */
function segSegDist(x0: number, y0: number, x1: number, y1: number, t: PlacedTruck): number {
  const ex = x1 - x0, ey = y1 - y0, fx = t.x1 - t.x0, fy = t.y1 - t.y0;
  const den = ex * fy - ey * fx;
  if (den !== 0) {
    const gx = t.x0 - x0, gy = t.y0 - y0;
    const u = (gx * fy - gy * fx) / den, v = (gx * ey - gy * ex) / den;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return 0;
  }
  let m = pointSegDist2(x0, y0, t.x0, t.y0, t.x1, t.y1);
  const m1 = pointSegDist2(x1, y1, t.x0, t.y0, t.x1, t.y1), m2 = pointSegDist2(t.x0, t.y0, x0, y0, x1, y1), m3 = pointSegDist2(t.x1, t.y1, x0, y0, x1, y1);
  if (m1 < m) m = m1;
  if (m2 < m) m = m2;
  if (m3 < m) m = m3;
  return Math.sqrt(m);
}

/**
 * Did a rivet moving from (x0, y0) to (x1, y1) this tick (q: its query at the end) touch an island,
 * its noses included (its rectangle RIVET_RADIUS wider)? The tick's path in track coordinates,
 * taken in the frame of the end point's segment (a straight line there: a rivet moves ~24 units).
 */
function shotIntoIslands(track: Track, q: TrackQuery, x0: number, y0: number, x1: number, y1: number): boolean {
  const list = track.islandsAt[q.seg];
  if (list === undefined || list.length === 0) return false;
  const a = track.pts[q.seg], b = track.pts[(q.seg + 1) % track.pts.length];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
  // The start relative to the end, along the track and to the right of travel.
  const ds = (x0 - x1) * dx + (y0 - y1) * dy, dl = -(x0 - x1) * dy + (y0 - y1) * dx;
  for (const f of list) if (segmentHitsRect(q.s + ds, q.lat + dl, q.s, q.lat, f, RIVET_RADIUS)) return true;
  return false;
}

/** Does the segment (s0, l0)..(s1, l1) meet the island's rectangle `pad` wider (Liang-Barsky clip)? */
function segmentHitsRect(s0: number, l0: number, s1: number, l1: number, f: PlacedIsland, pad: number): boolean {
  const ds = s1 - s0, dl = l1 - l0;
  let lo = 0, hi = 1;
  // Along s.
  if (Math.abs(ds) < 1e-12) {
    if (s0 < f.s0 - pad || s0 > f.s1 + pad) return false;
  } else {
    const a = (f.s0 - pad - s0) / ds, b = (f.s1 + pad - s0) / ds;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
    if (lo > hi) return false;
  }
  // Across.
  if (Math.abs(dl) < 1e-12) return l0 >= f.lat0 - pad && l0 <= f.lat1 + pad;
  const a = (f.lat0 - pad - l0) / dl, b = (f.lat1 + pad - l0) / dl;
  return Math.max(lo, Math.min(a, b)) <= Math.min(hi, Math.max(a, b));
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
 * Split lanes (M4-SURF part 2): from DODGE_REACH before an island to just past it, the lane on
 * `side` of it (-1 the left, +1 the right) instead: the one nearest that lane's middle that clears
 * the holes and mounds there, inside the asphalt at s.
 */
function clearLane(track: Track, s: number, side = -1): number {
  const L = track.length;
  // BR-PHYS (advisor change 4): on a branch's open road nothing wraps (u is clamped, distances are plain).
  const open = track.roadNo > 0;
  const reach = (o: { s: number; r: number }) => {
    if (open) return Math.abs(s - o.s) < o.r + DODGE_REACH;
    const ds = Math.abs(s - o.s) % L;
    return Math.min(ds, L - ds) < o.r + DODGE_REACH;
  };
  const near: { lat: number; r: number }[] = track.holes.filter(reach);
  for (const m of track.tyres) if (reach(m)) near.push(m);
  const ws = open ? wrapS(track, s) : (((s % L) + L) % L);
  const isle = track.islands.find((f) => ws >= f.s0 - DODGE_REACH && ws <= f.s1 + CAR_LENGTH);
  if (isle) {
    // The lane beside the island on `side`, kept inside the asphalt here (a taper is narrower).
    const edge = halfOn(track, pointAt(track, ws).seg, ws, side) - CAR_WIDTH / 2 - 4;
    const lo = side < 0 ? -edge : isle.lat1 + CAR_WIDTH;
    const hi = side < 0 ? isle.lat0 - CAR_WIDTH : edge;
    const middle = side < 0 ? (isle.lat0 - isle.outL) / 2 : (isle.lat1 + isle.outR) / 2;
    const at = clamp(middle, Math.min(lo, hi), Math.max(lo, hi));
    for (let k = 0; k <= hi - lo; k += 4) {
      for (const lat of k === 0 ? [at] : [at + k, at - k]) {
        if (lat < lo || lat > hi) continue;
        if (near.every((h) => Math.abs(lat - h.lat) > h.r + CAR_WIDTH)) return lat;
      }
    }
    return at;
  }
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
 * Full throttle, steering at a point ahead on the hole-free lane (in a split, the lane on `side` of
 * the island); with `through` (a pool's traction rectangle, M4-SURF), on the lane down the pool's
 * middle from WATER_LEAD before it to its end (inside the asphalt there, widened or not).
 */
function runUpInput(track: Track, c: CarState, through?: { s0: number; s1: number; lat0: number; lat1: number }, side = -1): Input {
  // The main road's query (BR-PHYS: queryMain; a mouth's branch never takes this run off its road).
  const q = queryMain(track, c.x, c.y, c.seg);
  const s = q.s + 40 + speedOf(c) * 0.25;
  const t = pointAt(track, s);
  let lat = clearLane(track, s, side);
  if (through && q.s >= through.s0 - WATER_LEAD && q.s <= through.s1) {
    lat = clamp((through.lat0 + through.lat1) / 2, -(halfOn(track, t.seg, s, -1) - CAR_WIDTH / 2), halfOn(track, t.seg, s, 1) - CAR_WIDTH / 2);
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
 * THEME-SURF (PLAN-THEMES 2.3): and so for every sand patch, oil slick and ford (throughRuns).
 * Split lanes (M4-SURF part 2, PLAN-M4 2.6 B): with an island in the run-up it is driven once per
 * lane, all the islands' left lanes and then all their right ones (a run through a pool only in the
 * lane the pool is in, when the pool lies beside an island). Empty = every run-up works.
 */
export function validateRunUps(track: Track, stats: CarStats = BASE_STATS): string[] {
  const errors: string[] = [];
  const L = track.length;
  const name = (side: number) => (side < 0 ? "the left lane" : "the right lane");
  for (const r of track.recovery) {
    const hz = hazardsAhead(track, r);
    if (!hz) continue;
    const what = `run-up from recovery point s=${r.toFixed(1)} (hazard at s=${((r + hz.start) % L).toFixed(1)})`;
    const ahead = (v: number) => (((v - r) % L) + L) % L;
    const isles = track.islands.filter((f) => ahead(f.s0) < hz.end);
    const sides = isles.length ? [-1, 1] : [-1];
    for (const side of sides) {
      const problem = runUp(track, r, hz.end, stats, undefined, side);
      if (problem) errors.push(`${what}${isles.length ? ` through ${name(side)} of the split` : ""}: ${problem}`);
    }
    for (const { w, kind } of throughRuns(track)) {
      const a = ahead(w.s0);
      if (a >= hz.end) continue; // not in this run-up
      const pool = tractionRect(w);
      if (!(pool.s1 > pool.s0 && pool.lat1 > pool.lat0)) continue; // no area a car feels
      // Beside an island: only in the lane the pool is in.
      const by = isles.find((f) => w.s0 < f.s1 && w.s1 > f.s0);
      const mid = (pool.lat0 + pool.lat1) / 2;
      for (const side of by ? [mid < by.mid ? -1 : 1] : sides) {
        const wet = runUp(track, r, hz.end, stats, pool, side);
        if (wet) errors.push(`${what}, driven through ${kind} ${w.s0.toFixed(1)}..${w.s1.toFixed(1)} at lat ${mid.toFixed(1)}${isles.length ? ` (${name(side)} of the split)` : ""}: ${wet}`);
      }
    }
  }
  if (track.branches.length > 0) branchRunUps(track, stats, errors);
  return errors;
}

/**
 * The surfaces validateRunUps drives a run through the middle of (as it does a pool): the water, then
 * (THEME-SURF, PLAN-THEMES 2.3) the sand, the oil and the fords, each as named in its message. Only the
 * water on a track without theme surfaces (as before).
 */
function throughRuns(r: Track): { w: { s0: number; s1: number; lat0: number; lat1: number }; kind: string }[] {
  const out: { w: { s0: number; s1: number; lat0: number; lat1: number }; kind: string }[] = r.water.map((w) => ({ w, kind: "the water" }));
  for (const w of r.sand) out.push({ w, kind: "the sand" });
  for (const w of r.oil) out.push({ w, kind: "the oil" });
  for (const w of r.fords) out.push({ w, kind: "the ford" });
  return out;
}

// ---- run-ups through the branches (BR-PHYS, PLAN-BRANCH 2.8, advisor change 3, user decision 6) ----
// A shipped track has no branch and never runs any of this. Per branch: one run from the main road's
// recovery point at or before its fork, through the whole branch and past its merge (where a fall before
// the branch's first recovery point goes back to); and from each of the branch's recovery points a run
// past its hazards before the next one (as the main road's). Each on the lanes round any island in it
// and through every pool in it, as validateRunUps drives the main road. The run follows its course (the
// legs below), not the queried road, so a mouth's road choice never sends it the wrong way.

/** A run's way: legs end to end, each on one road (0 = the main road) from s0 on it; `at` its start in course distance, len its length (the last runs on). */
interface Leg { road: number; s0: number; len: number; at: number }

/** A pool on a course: its traction rectangle on its road and where it lies in course distance. */
interface CoursePool { road: number; d0: number; d1: number; lat0: number; lat1: number }

/** The leg holding course distance d (before the first: the first; from the last one's start on: the last). */
function legAt(legs: readonly Leg[], d: number): Leg {
  let k = 0;
  while (k + 1 < legs.length && d >= legs[k + 1].at) k++;
  return legs[k];
}

/** The road and its s at course distance d. */
function courseAt(track: Track, legs: readonly Leg[], d: number): { roadNo: number; road: Track; s: number } {
  const g = legAt(legs, d);
  return { roadNo: g.road, road: roadOf(track, g.road), s: g.s0 + (d - g.at) };
}

/** Where s on road `road` lies on the course (of the legs on that road that hold it, the first), NaN if on none. */
function onCourse(track: Track, legs: readonly Leg[], road: number, s: number): number {
  const L = track.length;
  for (const g of legs) {
    if (g.road !== road) continue;
    const a = road === 0 ? (((s - g.s0) % L) + L) % L : s - g.s0;
    if (a >= 0 && a <= g.len) return g.at + a;
  }
  return NaN;
}

/** A course leg reads a query only this far before or past its ends (a mouth, MOUTH_LEN_MAX 600, and room). */
const LEG_REACH = 700;

/**
 * A query's course distance (on its road): each leg on that road reads it along the leg (on the main road
 * both ways round the lap), counted only within LEG_REACH of the leg (a mouth's main road beside a fork or
 * a merge) unless none is; of those, the reading nearest `prev`. NaN off the course's roads.
 */
function courseOf(track: Track, legs: readonly Leg[], q: TrackQuery, prev: number): number {
  const L = track.length;
  let best = NaN, bestOff = Infinity, any = NaN, anyOff = Infinity;
  for (const g of legs) {
    if (g.road !== q.road) continue;
    const a0 = g.road === 0 ? (((q.s - g.s0) % L) + L) % L : q.s - g.s0;
    for (let w = 0; w < (g.road === 0 ? 2 : 1); w++) {
      const a = w === 0 ? a0 : a0 - L;
      const d = g.at + a, off = Math.abs(d - prev);
      if (off < anyOff) {
        any = d;
        anyOff = off;
      }
      if (a >= -LEG_REACH && a <= g.len + LEG_REACH && off < bestOff) {
        best = d;
        bestOff = off;
      }
    }
  }
  return best === best ? best : any;
}

/** runUpInput on a course: at the point 40 + speed / 4 ahead along it, on its road's hole-free lane (or the pool's middle). */
function courseInput(track: Track, legs: readonly Leg[], c: CarState, d: number, through: CoursePool | undefined, side: number): Input {
  const at = courseAt(track, legs, d + 40 + speedOf(c) * 0.25);
  const t = pointAt(at.road, at.s);
  let lat = clearLane(at.road, at.s, side);
  if (through && d >= through.d0 - WATER_LEAD && d <= through.d1) {
    lat = clamp((through.lat0 + through.lat1) / 2, -(halfOn(at.road, t.seg, at.s, -1) - CAR_WIDTH / 2), halfOn(at.road, t.seg, at.s, 1) - CAR_WIDTH / 2);
  }
  const tx = t.x - Math.sin(t.h) * lat, ty = t.y + Math.cos(t.h) * lat;
  return { throttle: 1, steer: clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1) };
}

/** runUp on a course: from rest at course distance d0, past `end` beyond it: "" = gets past, else what goes wrong. */
function courseRun(track: Track, legs: readonly Leg[], d0: number, end: number, stats: CarStats, through: CoursePool | undefined, side: number): string {
  const st = courseAt(track, legs, d0);
  const p = pointAt(st.road, st.s);
  const seg = st.roadNo === 0 ? p.seg : track.branches[st.roadNo - 1].base + p.seg;
  const c: CarState = { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const env = raceEnv(track);
  let d = d0;
  let tookOff = -1;
  let problem = "";
  for (let i = 0; i < RUN_UP_MAX_TICKS && !problem; i++) {
    const wasAir = c.air > 0;
    const v0 = speedOf(c);
    env.rt = i + 1;
    const ev = stepRaceCar(c, courseInput(track, legs, c, d, through, side), stats, env);
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const nd = courseOf(track, legs, q, d);
    if (nd === nd) d = nd; // NaN: off the course's roads (never: there are two), keep the last
    const road = roadFor(track, q);
    const where = q.road === 0 ? `s=${q.s.toFixed(1)}` : `u=${q.s.toFixed(1)} on branch ${q.road}`;
    if (ev === "takeoff") tookOff = v0;
    const jump = tookOff >= 0 ? ` (took off at ${tookOff.toFixed(0)} u/s)` : "";
    if (ev === "fall") {
      const why = !gapAt(road, q.s)
        ? wasAir ? "lands outside the walls" : "falls into a hole"
        : wasAir ? "lands short in a gap" : `rolls into a gap at ${v0.toFixed(0)} u/s (take-off needs ${MIN_TAKEOFF_SPEED})`;
      problem = `${why} at ${where}${wasAir ? jump : ""}`;
    } else if (wasAir && c.air === 0 && q.dist > halfOf(road, q)) {
      problem = `lands off the asphalt at ${where} (${q.dist.toFixed(1)} from the centerline)${jump}`;
    } else if (d - d0 > end + CAR_LENGTH && c.air === 0) {
      return "";
    }
  }
  return problem || "never gets past it";
}

/** The runs of one course from d0 past `end` beyond it: each island lane, then through each pool in it (as validateRunUps). */
function courseRuns(track: Track, legs: readonly Leg[], d0: number, end: number, stats: CarStats, what: string, errors: string[]): void {
  const name = (side: number) => (side < 0 ? "the left lane" : "the right lane");
  const roads = [...new Set(legs.map((g) => g.road))];
  const inRun = (d: number) => d === d && d >= d0 && d < d0 + end;
  const isles: { road: number; d0: number; d1: number; mid: number }[] = [];
  const pools: (CoursePool & { what: string })[] = [];
  for (const k of roads) {
    const r = roadOf(track, k);
    for (const f of r.islands) {
      const a = onCourse(track, legs, k, f.s0);
      if (inRun(a)) isles.push({ road: k, d0: a, d1: a + (f.s1 - f.s0), mid: f.mid });
    }
    for (const { w, kind } of throughRuns(r)) {
      const a = onCourse(track, legs, k, w.s0);
      if (!inRun(a)) continue;
      const pool = tractionRect(w);
      if (!(pool.s1 > pool.s0 && pool.lat1 > pool.lat0)) continue; // no area a car feels
      const at = k === 0 ? `s` : `u`;
      pools.push({ road: k, d0: a + (pool.s0 - w.s0), d1: a + (pool.s1 - w.s0), lat0: pool.lat0, lat1: pool.lat1, what: `${kind} ${at} ${w.s0.toFixed(1)}..${w.s1.toFixed(1)}${k === 0 ? "" : ` on branch ${k}`}` });
    }
  }
  const sides = isles.length ? [-1, 1] : [-1];
  for (const side of sides) {
    const problem = courseRun(track, legs, d0, end, stats, undefined, side);
    if (problem) errors.push(`${what}${isles.length ? ` through ${name(side)} of the split` : ""}: ${problem}`);
  }
  for (const pool of pools) {
    const by = isles.find((f) => f.road === pool.road && pool.d0 < f.d1 && pool.d1 > f.d0);
    const mid = (pool.lat0 + pool.lat1) / 2;
    for (const side of by ? [mid < by.mid ? -1 : 1] : sides) {
      const wet = courseRun(track, legs, d0, end, stats, pool, side);
      if (wet) errors.push(`${what}, driven through ${pool.what} at lat ${mid.toFixed(1)}${isles.length ? ` (${name(side)} of the split)` : ""}: ${wet}`);
    }
  }
}

/** validateRunUps' runs through every branch (see above). */
function branchRunUps(track: Track, stats: CarStats, errors: string[]): void {
  const L = track.length;
  track.branches.forEach((b, k) => {
    const road = k + 1, r = b.road, len = r.length;
    // From the main road's recovery point at or before the fork, through the branch, past the merge.
    const r0 = recoveryAt(track, b.s0);
    const A = (((b.s0 - r0) % L) + L) % L;
    // The last leg: the main road past the merge (the run ends a car's length past it; a leg's reach is finite).
    const through: Leg[] = [{ road: 0, s0: r0, len: A, at: 0 }, { road, s0: 0, len, at: A }, { road: 0, s0: b.s1, len: 2 * LEG_REACH, at: A + len }];
    courseRuns(track, through, 0, A + len, stats, `run-up from main recovery point s=${r0.toFixed(1)} through branch ${road} (fork s=${b.s0.toFixed(1)}, merge s=${b.s1.toFixed(1)})`, errors);
    // From each of the branch's recovery points, past its hazards before the next one.
    const legs: Leg[] = [{ road, s0: 0, len, at: 0 }, { road: 0, s0: b.s1, len: 2 * LEG_REACH, at: len }];
    r.recovery.forEach((u, i) => {
      const until = i + 1 < r.recovery.length ? r.recovery[i + 1] : len;
      let start = Infinity, end = -Infinity;
      const add = (s0: number, s1: number) => {
        if (s0 < u || s0 >= until) return;
        start = Math.min(start, s0);
        end = Math.max(end, s1);
      };
      for (const x of r.ramps) add(x.s, x.s + x.len + LIP_ZONE);
      for (const g of r.gaps) add(g.s0, g.s1);
      for (const h of r.holes) add(h.s - h.r, h.s + h.r);
      if (start === Infinity) return;
      courseRuns(track, legs, u, end - u, stats, `run-up from branch ${road} recovery point u=${u.toFixed(1)} (hazard at u=${start.toFixed(1)})`, errors);
    });
  });
}

/**
 * One run-up from recovery point r past `end` (ahead of r): "" = gets past, else what goes wrong.
 * side: the lane it takes round an island (-1 left, +1 right).
 */
function runUp(track: Track, r: number, end: number, stats: CarStats, through?: { s0: number; s1: number; lat0: number; lat1: number }, side = -1): string {
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
    const ev = stepRaceCar(c, runUpInput(track, c, through, side), stats, env);
    const q = queryMain(track, c.x, c.y, c.seg);
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
    } else if (wasAir && (c.air ?? 0) === 0 && q.dist > halfOf(track, q)) {
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
  // M4-MOVE (advisor change 7): a ramp truck's lip too, from the middle of its band and TRUCK_SWEEP
  // either side of it; it has no gap behind it, so every speed from MIN_TAKEOFF_SPEED up must land.
  // A truck's flight starts TRUCK_SWEEP_IN into its take-off zone (a ramp's 0.5): its band lies off the
  // centre line, where in a bend the start's own s can be a little short of the one on the centre line.
  const lips: { lip: number; lanes: readonly number[]; what: string; into: number; road: number }[] = [
    ...track.ramps.map((r) => ({ lip: r.s + r.len, lanes: SWEEP_LANES, what: "jump", into: 0.5, road: 0 })),
    ...track.trucks.map((t) => ({ lip: t.lip, lanes: [t.lat - TRUCK_SWEEP, t.lat, t.lat + TRUCK_SWEEP], what: `truck jump (truck at s=${t.s.toFixed(1)})`, into: TRUCK_SWEEP_IN, road: 0 })),
  ];
  // BR-PHYS (PLAN-BRANCH 2.8): every branch's lips too, flown on the whole track from its road.
  track.branches.forEach((b, k) => {
    const r = b.road, on = ` on branch ${k + 1}`;
    for (const x of r.ramps) lips.push({ lip: x.s + x.len, lanes: SWEEP_LANES, what: `jump${on}`, into: 0.5, road: k + 1 });
    for (const t of r.trucks) lips.push({ lip: t.lip, lanes: [t.lat - TRUCK_SWEEP, t.lat, t.lat + TRUCK_SWEEP], what: `truck jump${on} (truck at u=${t.s.toFixed(1)})`, into: TRUCK_SWEEP_IN, road: k + 1 });
  });
  for (const { lip, lanes, what, into, road } of lips) {
    for (const lane of lanes) {
      let landed = -1; // the slowest speed that lands
      const bad: { v: number; why: string }[] = [];
      for (const v of speeds) {
        const why = flyOff(track, lip, lane, v, stats, onAsphalt, into, road);
        if (!why && landed < 0) landed = v;
        else if (why && landed >= 0) bad.push({ v, why });
      }
      const at = `${what} at the lip ${road === 0 ? "s" : "u"}=${lip.toFixed(1)}, lane ${lane}`;
      if (landed < 0) errors.push(`${at}: no take-off up to ${maxSpeed.toFixed(0)} u/s lands`);
      else if (bad.length) errors.push(`${at}: lands from ${landed} u/s, but not at ${bad.map((b) => b.v.toFixed(0)).join(", ")} u/s (${bad[0].why})`);
    }
  }
  return errors;
}

/** The overspeed sweep flies a truck's jump from its band's middle and this far either side (the band is TRUCK_BAND = 14 either side). */
const TRUCK_SWEEP = 10;
/** ... from this far into its take-off zone (LIP_ZONE 12). */
const TRUCK_SWEEP_IN = 2;

/**
 * Fly off the lip at s=lip, `lane` units right of the centerline, at speed v: "" = lands on the asphalt.
 * road: the lip's road (BR-PHYS: a branch's, its u; 0 = the main road); the flight is on the whole track.
 */
function flyOff(track: Track, lip: number, lane: number, v: number, stats: CarStats, onAsphalt: boolean, into = 0.5, road = 0): string {
  const p = pointAt(road === 0 ? track : roadOf(track, road), lip + into);
  const c: CarState = {
    x: p.x - Math.sin(p.h) * lane, y: p.y + Math.cos(p.h) * lane, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v,
    seg: road === 0 ? p.seg : track.branches[road - 1].base + p.seg, wreck: 0, air: 0, fall: 0, boost: 0,
  };
  const env = raceEnv(track);
  for (let i = 0; i < MAX_AIR_TICKS + 2; i++) {
    const wasAir = c.air > 0;
    const ev = stepRaceCar(c, { throttle: 1, steer: 0 }, stats, env);
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const at = q.road === 0 ? `s=${q.s.toFixed(1)}` : `u=${q.s.toFixed(1)} on branch ${q.road}`;
    if (ev === "fall") return `falls at ${at}, ${q.dist.toFixed(1)} from the centerline`;
    if (i === 0 && ev !== "takeoff") return "does not take off";
    if (wasAir && c.air === 0) return onAsphalt && q.dist > halfOf(roadFor(track, q), q) ? `lands off the asphalt at ${at} (${q.dist.toFixed(1)} from the centerline)` : "";
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
 * lane across the lip; null if none. M4-TRACKS: a ramp truck's lip too (an air cell over its
 * flight), flown from every lane across its band (band0..band1), TRUCK_SWEEP_IN into its take-off
 * zone, as validateJumpSweep flies it.
 */
export function airCellReach(track: Track, cell: PlacedCell, maxSpeed: number): { min: number; max: number; lanes: number } | null {
  // BR-PHYS: a branch's cell (cell.road, its s in u) off its own road's lips, flown on the whole track.
  const road = cell.road ?? 0;
  const own = road === 0 ? track : roadOf(track, road);
  const base = road === 0 ? 0 : track.branches[road - 1].base;
  const L = own.length;
  const lim = wallLimit(own);
  let min = Infinity, max = -Infinity;
  const lanes = new Set<number>();
  const lips: { lip: number; lane0: number; lane1: number; into: number }[] = [
    ...own.ramps.map((ramp) => ({ lip: ramp.s + ramp.len, lane0: -Math.floor(lim), lane1: lim, into: 0.5 })),
    ...own.trucks.map((t) => ({ lip: t.lip, lane0: t.band0, lane1: t.band1, into: TRUCK_SWEEP_IN })),
  ];
  for (const { lip, lane0, lane1, into } of lips) {
    const ahead = road === 0 ? (((cell.s - lip) % L) + L) % L : cell.s - lip; // an open road's u never wraps
    if (ahead <= 0 || ahead > maxSpeed * (MAX_AIR_TICKS / 60) + 20) continue;
    for (let lane = lane0; lane <= lane1; lane += 4) {
      for (let v = CELL_MIN_TAKEOFF; v <= maxSpeed; v += SWEEP_STEP) {
        const p = pointAt(own, lip + into);
        const c: CarState = {
          x: p.x - Math.sin(p.h) * lane, y: p.y + Math.cos(p.h) * lane, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v,
          seg: base + p.seg, wreck: 0, air: 0, fall: 0, boost: 0,
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
 * to be taken, off a ramp's lip or a ramp truck's (airCellReach). Empty = fine. (That a boosted car
 * still lands every jump is validateJumpSweep.)
 */
export function validateCells(track: Track, maxSpeed: number): string[] {
  const errors: string[] = [];
  for (const c of track.cells) {
    if (!c.air) continue;
    if (!airCellReach(track, c, maxSpeed)) {
      errors.push(`air cell at ${c.road === undefined ? "s" : "u"}=${c.s.toFixed(1)}${c.road === undefined ? "" : ` on branch ${c.road}`}, lat ${c.lat}: not on the arc of any take-off between ${CELL_MIN_TAKEOFF} and ${maxSpeed.toFixed(0)} u/s (high enough to take it)`);
    }
  }
  return errors;
}
