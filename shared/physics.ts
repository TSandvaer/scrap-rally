// Arcade car physics. Pure and shared: the server runs it authoritatively and the
// client runs the same code to predict its own car. Bit-exact agreement is not needed;
// reconciliation absorbs tiny floating-point differences between JS engines.

import { BOOST_ACCEL, BOOST_TOP, DRAFT_DRAG_CUT } from "./catchup";
import {
  BARREL_R,
  barrelLat,
  halfOf,
  ISLAND_NOSE,
  ISLAND_NOSE_ROUND,
  LIP_ZONE,
  PRESS_DEPTH,
  pressDown,
  queryTrackNear,
  segDir,
  SURF_BELT,
  SURF_DIRT,
  SURF_WATER,
  surfaceAt,
  TRUCK_HALF,
  TRUCK_MIN_SPEED,
  wallOf,
  type PlacedBarrels,
  type PlacedIsland,
  type PlacedPress,
  type PlacedTruck,
  type PlacedTyres,
  type Track,
  type TrackQuery,
  type Vec,
} from "./track";

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const CAR_LENGTH = 30;
export const CAR_WIDTH = 16;
export const CAR_RADIUS = 13; // round hit shape for rivets and mines (not car-car)
// Car-car collision shape: a capsule along the heading that matches the drawn 30x16 car,
// a segment of length 2 * CAPSULE_HALF centred on the car, swept by CAPSULE_R. Contact
// distance between centres: 16 side by side, 31 nose to tail.
export const CAPSULE_HALF = 7.5;
export const CAPSULE_R = 8;
// Bounce of a car-car bump (coefficient of restitution along the contact normal, 0 = no
// bounce, 1 = elastic). The old circle model used 0.8; this starts at 0.6 of that.
export const CAR_RESTITUTION = 0.48;

export interface CarState {
  x: number;
  y: number;
  h: number; // heading, radians (0 = +x, increasing = clockwise on screen)
  vx: number;
  vy: number;
  seg: number; // last track segment, the search hint for track queries
  wreck: number; // ticks left wrecked (frozen), 0 = driving; see shared/weapons.ts
  // Jumps and falls (shared/weapons.ts stepRaceCar).
  air: number; // ticks left in the air (committed flight: velocity and heading frozen), 0 = grounded
  fall: number; // ticks left falling (frozen, blinking), then the car is placed at a recovery point
  // Ticks of speed boost left (M4-CELLS, PLAN-M4 2.5: a lightning cell gives it, shared/catchup.ts):
  // while > 0 stepCar drives with BOOST_ACCEL x the acceleration and BOOST_TOP x the top speed;
  // stepRaceCar counts it down; a wreck, a fall and a recovery end it.
  boost: number;
}

/**
 * Per-car tuning: the car type's base (shared/cars.ts) with the driver's upgrades
 * (shared/shop.ts statsFor).
 */
export interface CarStats {
  accel: number;
  topSpeed: number;
  grip: number; // how fast sideways sliding dies out (higher = grippier)
  turn: number; // rad/s at full steering lock
  // Off the asphalt (the dirt verge, M4-CARS): drag times dirtDrag (so the top speed there is
  // topSpeed / dirtDrag) and grip times dirtGrip.
  dirtDrag: number;
  dirtGrip: number;
}

/** The Sport's stats with no upgrades (shared/cars.ts): the car every driver had before M4-CARS. */
export const BASE_STATS: CarStats = { accel: 520, topSpeed: 430, grip: 7.5, turn: 3.3, dirtDrag: 2.9, dirtGrip: 0.37 };

export interface Input {
  throttle: number; // -1 (brake/reverse) .. 1 (accelerate)
  steer: number; // -1 (left) .. 1 (right)
}

export const NO_INPUT: Input = { throttle: 0, steer: 0 };

const BRAKE = 900;
const REVERSE_FACTOR = 0.5;
const ROLL = 60; // coasting deceleration
const FULL_TURN_SPEED = 140; // below this speed steering is scaled down
const WALL_BOUNCE = 0.35;
const WALL_SCRAPE = 0.97;

// Surfaces (M4-SURF, PLAN-M4.md 2.2, 2.4 and advisor change 4). A car is on one when its centre is
// strictly inside the surface's rectangle (shared/track.ts Surface: a pool's or a dirt patch's
// traction rectangle, a belt's declared one).
// - Water (aquaplaning, one consistent model): every force along the car (throttle, brake, the
//   coasting roll and the drag) times WATER_FORCE, so the car keeps the speed it came in with (the
//   top speed is unchanged: a pool on a straight costs little); the sideways grip times the type's
//   dirtGrip x WATER_GRIP_OF_DIRT (Sport 0.123, Racer 0.100, Truck 0.200: the car slides on along
//   the way it came in) and the steering times WATER_TURN (a pool in a bend throws you wide).
// - Dirt patch: the dirt verge's drag and grip, by car type (CarStats.dirtDrag, dirtGrip).
// - Belt: grounded cars are moved its drift (vx, + = right of travel) each tick, beside the road
//   direction at the car; velocity is not changed (the ground moves, not the car).
export const WATER_FORCE = 0.35;
export const WATER_GRIP_OF_DIRT = 1 / 3;
export const WATER_TURN = 0.5;

// Tyre mounds (M4-SURF, PLAN-M4.md 2.3): a static circle the car capsule bounces off. Full push-out;
// the speed into it comes back out times TYRES_RESTITUTION and at least TYRES_MIN_OUT; the speed
// along it times TYRES_TANGENT. Airborne cars pass over (only a driving step collides), no damage.
export const TYRES_RESTITUTION = 0.8;
export const TYRES_MIN_OUT = 90;
export const TYRES_TANGENT = 0.9;

// What moves and the parked trucks (M4-MOVE, PLAN-M4.md 2.3, 2.4 and advisor changes 5 and 6). Only a
// driving step collides (an airborne car passes over everything; a landing on one is resolved by
// the next driving step, below), no damage, and each from the shared pure functions of the race tick
// the step runs at (shared/track.ts barrelLat, pressState), so the server, the client's prediction
// and the renderer agree. In the order of the step: tyre mounds, barrels, presses, trucks, then the
// walls and islands (collideWalls), then the squeeze (below).
// - A rolling barrel: a kinematic circle of radius BARREL_R at barrelLat(rt) (none while it is in the
//   gutter), moving across the road at its speed. Against the car's capsule: pushed fully out (as a
//   tyre mound), and the car's speed into it relative to the barrel comes back out x
//   BARREL_RESTITUTION, so the barrel's own velocity is added to a car it rolls into. A barrel is
//   never pushed. No yaw kick (advisor change 6: a level-triggered one spins up a pinned car, and the
//   plan's 0.4 rad would need stored per-contact state in CarState): the heading is never changed.
// - Squeezed between a barrel and a wall (the barrel rolls into a car against it): after the walls,
//   a car still overlapping a barrel is pushed along the road at the row (the row's heading), out to
//   the side of the row its centre is on, by exactly the overlap (a bisection, as carContact's), and
//   its speed along the road into the row comes back out x BARREL_RESTITUTION. The barrel's lateral
//   speed is never added along the road, so the speed never grows; the car never passes through.
//   Validation keeps other solids MOVER_CLEAR along the track from a row (shared/track.ts), so the
//   wall is the only thing a car is squeezed against.
// - A crusher press while it is down (pressDown(rt)): a solid box PRESS_DEPTH along the road at its s
//   by lat0..lat1 across it, in the frame of its centreline point. Against the capsule: pushed out
//   along the line between their closest points, with the wall's bounce (WALL_BOUNCE, WALL_SCRAPE).
//   Coming down on a car (the capsule's axis inside the box, or its centre): pushed along the road to
//   the nearer of the press's two open sides (in front or behind: the one needing the shorter move,
//   behind on a tie), all the way out, with the same bounce. Never trapped inside. Up: nothing.
// - A parked truck: its body is a solid capsule (axis x0, y0 .. x1, y1, radius TRUCK_HALF), against the
//   car's capsule with the wall's bounce; a side hit is pushed out sideways (the closest points' line);
//   a car whose axis crosses the truck's is pushed across the truck's axis to the side its centre is on.
//   Its ramp band: a car whose centre at the start of the tick is in the band (truckRamp: lat in
//   band0..band1, s from TRUCK_RAMP_LEAD before the rear to the end of the take-off zone) moving
//   forward at TRUCK_MIN_SPEED or more rides up it, and the body does not touch it; stepRaceCar takes
//   it off in the take-off zone (truckLipAt). Slower, the band is as solid as the rest of the body.
export const BARREL_RESTITUTION = 0.5;
/**
 * From this far before a truck's rear (start-of-tick centre) a car in its band is on the ramp: a car
 * capsule's reach ahead of its centre (CAPSULE_HALF + CAPSULE_R = 15.5) plus a tick's travel (~9 at
 * 537 u/s), so the body never touches a car arriving in the band fast enough.
 */
export const TRUCK_RAMP_LEAD = 25;
/** A squeeze is an overlap deeper than this left after the walls (an exact touch, to rounding, is not one). */
const SQUEEZE_EPS = 1e-6;

export function cloneCar(c: CarState): CarState {
  return { x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, seg: c.seg, wreck: c.wreck, air: c.air, fall: c.fall, boost: c.boost };
}

export function speedOf(c: { vx: number; vy: number }): number {
  return Math.hypot(c.vx, c.vy);
}

/**
 * Advance one fixed step (DT). Mutates the car. draft: slipstream strength 0..1 (shared/catchup.ts
 * draftsFor): the drag is cut by DRAFT_DRAG_CUT at full strength, so the car runs up to ~10 %
 * faster behind another; 0 = alone (exactly the step without it). Boosted (c.boost > 0): the
 * acceleration times BOOST_ACCEL and the top speed times BOOST_TOP, and no slipstream on top.
 */
export function stepCar(c: CarState, input: Input, stats: CarStats, track: Track, draft = 0, rt = 0): void {
  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);
  const cos = Math.cos(c.h), sin = Math.sin(c.h);

  // Velocity in the car's frame.
  let vf = c.vx * cos + c.vy * sin;
  let vl = -c.vx * sin + c.vy * cos;

  const q = queryTrackNear(track, c.x, c.y, c.seg);
  c.seg = q.seg;
  // M4-MOVE: what moves and the trucks near the car (empty lists on a track without any), and the
  // truck whose ramp it rides this tick (by the start-of-tick pose, as stepRaceCar's take-off).
  const rows = track.barrelsAt[q.seg], gates = track.pressesAt[q.seg], trucks = track.trucksAt[q.seg];
  const riding = trucks !== undefined && trucks.length > 0 ? truckRamp(track, trucks, q, c.vx, c.vy) : null;
  // The surface under the car's centre (M4-SURF; null on a track without any: exactly as before).
  const surf = surfaceAt(track, q.seg, q.s, q.lat);
  const wet = surf !== null && surf.kind === SURF_WATER;
  const onRoad = q.dist <= halfOf(track, q) && !(surf !== null && surf.kind === SURF_DIRT);
  const boosted = c.boost > 0;
  const accel = boosted ? stats.accel * BOOST_ACCEL : stats.accel;
  let drag = (accel / (boosted ? stats.topSpeed * BOOST_TOP : stats.topSpeed)) * (wet ? WATER_FORCE : onRoad ? 1 : stats.dirtDrag);
  if (draft > 0 && !boosted) drag *= 1 - DRAFT_DRAG_CUT * draft;
  const grip = stats.grip * (wet ? stats.dirtGrip * WATER_GRIP_OF_DIRT : onRoad ? 1 : stats.dirtGrip);
  const force = wet ? WATER_FORCE : 1; // x 1 is exact: dry steps are the same arithmetic as before

  if (throttle > 0) {
    vf += (vf < 0 ? BRAKE : accel) * force * throttle * DT;
  } else if (throttle < 0) {
    vf -= (vf > 0 ? BRAKE : accel * REVERSE_FACTOR) * force * -throttle * DT;
  } else {
    const roll = ROLL * force * DT;
    vf = Math.abs(vf) <= roll ? 0 : vf - Math.sign(vf) * roll;
  }
  vf -= vf * drag * DT;
  vl *= Math.exp(-grip * DT);

  // Recompose in the old heading, then turn: the velocity lags the heading a little,
  // which is what makes the car slide through fast corners.
  c.vx = vf * cos - vl * sin;
  c.vy = vf * sin + vl * cos;
  const turnScale = clamp(vf / FULL_TURN_SPEED, -1, 1);
  c.h = wrapAngle(c.h + steer * (wet ? stats.turn * WATER_TURN : stats.turn) * turnScale * DT);

  c.x += c.vx * DT;
  c.y += c.vy * DT;
  if (surf !== null && surf.kind === SURF_BELT) {
    // The belt's drift, toward the right of travel at the car (a fixed move each tick).
    const d = segDir(track, q.seg);
    c.x -= d.y * surf.vx * DT;
    c.y += d.x * surf.vx * DT;
  }
  const tyres = track.tyresAt[q.seg];
  if (tyres !== undefined && tyres.length > 0) collideTyres(c, tyres);
  if (rows !== undefined && rows.length > 0) collideBarrels(c, rows, rt);
  if (gates !== undefined && gates.length > 0) collidePresses(c, gates, rt);
  if (trucks !== undefined && trucks.length > 0) collideTrucks(c, trucks, riding);

  collideWalls(c, track);
  if (rows !== undefined && rows.length > 0) squeezeBarrels(c, rows, rt);
}

/**
 * The truck among `trucks` whose ramp a car rides this tick (see above): its centre at the query
 * (start of the tick) in the band (lat band0..band1, s from TRUCK_RAMP_LEAD before the rear to the
 * end of the take-off zone, lip + LIP_ZONE) and its velocity (vx, vy) along the road at the query's
 * segment TRUCK_MIN_SPEED or more. null if none.
 */
export function truckRamp(track: Track, trucks: readonly PlacedTruck[], q: TrackQuery, vx: number, vy: number): PlacedTruck | null {
  const lat = q.lat;
  for (let i = 0; i < trucks.length; i++) {
    const t = trucks[i];
    if (lat < t.band0 || lat > t.band1 || q.s < t.s - TRUCK_RAMP_LEAD || q.s >= t.lip + LIP_ZONE) continue;
    const a = track.pts[q.seg], b = track.pts[q.seg + 1 < track.pts.length ? q.seg + 1 : 0];
    const ex = b.x - a.x, ey = b.y - a.y;
    const l = Math.hypot(ex, ey) || 1;
    if ((vx * ex + vy * ey) / l >= TRUCK_MIN_SPEED) return t;
  }
  return null;
}

/** Where barrel k of row b is at race tick rt (world), into BX, BY; false while it is in the gutter. */
let BX = 0, BY = 0;
function barrelAt(b: PlacedBarrels, k: number, rt: number): boolean {
  const lat = barrelLat(b, k, rt);
  if (lat !== lat) return false; // NaN: in the gutter
  BX = b.x + b.nx * lat;
  BY = b.y + b.ny * lat;
  return true;
}

/**
 * Bounce a driving car's capsule off the barrels it overlaps at race tick rt (see above): pushed
 * straight out (the closest point of its axis to the barrel's centre, the normal from the centre to
 * it), the speed into it relative to the barrel (rolling at b.speed along the row's right normal)
 * reflected x BARREL_RESTITUTION. Returns the fastest speed into a barrel (0 = no contact).
 */
export function collideBarrels(c: CarState, rows: readonly PlacedBarrels[], rt: number): number {
  let hit = 0;
  const reach = BARREL_R + CAPSULE_R;
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    for (let k = 0; k < b.n; k++) {
      if (!barrelAt(b, k, rt)) continue;
      const ux = Math.cos(c.h), uy = Math.sin(c.h);
      const dx = BX - c.x, dy = BY - c.y;
      if (dx * dx + dy * dy >= (reach + CAPSULE_HALF) * (reach + CAPSULE_HALF)) continue;
      const t = clamp(dx * ux + dy * uy, -CAPSULE_HALF, CAPSULE_HALF);
      let nx = c.x + ux * t - BX, ny = c.y + uy * t - BY; // from the barrel to the car's axis
      const d = Math.hypot(nx, ny);
      if (d >= reach) continue;
      if (d > 1e-6) {
        nx /= d;
        ny /= d;
      } else {
        // The barrel's centre on the car's axis (a landing): out from the centre, or sideways (left) on it.
        const dc = Math.hypot(dx, dy);
        nx = dc > 1e-6 ? -dx / dc : uy;
        ny = dc > 1e-6 ? -dy / dc : -ux;
      }
      c.x += nx * (reach - d);
      c.y += ny * (reach - d);
      const vn = (c.vx - b.nx * b.speed) * nx + (c.vy - b.ny * b.speed) * ny; // relative to the barrel
      if (vn < 0) {
        c.vx -= (1 + BARREL_RESTITUTION) * vn * nx;
        c.vy -= (1 + BARREL_RESTITUTION) * vn * ny;
        if (-vn > hit) hit = -vn;
      }
    }
  }
  return hit;
}

/** Distance from the barrel at (bx, by) to the car's axis (centre x, y, heading (ux, uy)). */
function axisDist(x: number, y: number, ux: number, uy: number, bx: number, by: number): number {
  const t = clamp((bx - x) * ux + (by - y) * uy, -CAPSULE_HALF, CAPSULE_HALF);
  return Math.hypot(x + ux * t - bx, y + uy * t - by);
}

/**
 * The squeeze (see above), after the walls: a car still overlapping a barrel (a barrel rolled it
 * into the wall, which pushed it back) is pushed along the road at the row, to the side of the row
 * its centre is on (behind on the row's line), by the smallest move that parts them, and its speed
 * along the road into the row is reflected x BARREL_RESTITUTION. Returns how far it was pushed (0 = none).
 */
export function squeezeBarrels(c: CarState, rows: readonly PlacedBarrels[], rt: number): number {
  let moved = 0;
  const reach = BARREL_R + CAPSULE_R;
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const rx = Math.cos(b.h), ry = Math.sin(b.h); // along the road at the row
    for (let k = 0; k < b.n; k++) {
      if (!barrelAt(b, k, rt)) continue;
      const ux = Math.cos(c.h), uy = Math.sin(c.h);
      if (axisDist(c.x, c.y, ux, uy, BX, BY) >= reach - SQUEEZE_EPS) continue;
      const side = (c.x - BX) * rx + (c.y - BY) * ry > 0 ? 1 : -1;
      const sx = rx * side, sy = ry * side;
      // Bisection for the smallest move along (sx, sy) that parts them; hi certainly does.
      let lo = 0, hi = reach + CAPSULE_HALF + Math.abs((BX - c.x) * sx + (BY - c.y) * sy) + 1;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2;
        if (axisDist(c.x + sx * mid, c.y + sy * mid, ux, uy, BX, BY) >= reach) hi = mid;
        else lo = mid;
      }
      c.x += sx * hi;
      c.y += sy * hi;
      moved += hi;
      const vn = c.vx * sx + c.vy * sy;
      if (vn < 0) {
        c.vx -= (1 + BARREL_RESTITUTION) * vn * sx;
        c.vy -= (1 + BARREL_RESTITUTION) * vn * sy;
      }
    }
  }
  return moved;
}

// collidePresses' box frame: the car's axis ends in it (A0, L0 .. A1, L1), and the closest points (PA, PL on the car's axis, KA, KL on the box).
let PA = 0, PL = 0, KA = 0, KL = 0;

/** The closest points of the segment (a0, l0)..(a1, l1) and the box [-ha, ha] x [l0b, l1b] (disjoint), into PA, PL / KA, KL; their distance. */
function segToBox(a0: number, l0: number, a1: number, l1: number, ha: number, lo: number, hi: number): number {
  let best = Infinity;
  // A segment end against the box ...
  for (let e = 0; e < 2; e++) {
    const a = e === 0 ? a0 : a1, l = e === 0 ? l0 : l1;
    const ka = clamp(a, -ha, ha), kl = clamp(l, lo, hi);
    const d = Math.hypot(a - ka, l - kl);
    if (d < best) {
      best = d;
      PA = a;
      PL = l;
      KA = ka;
      KL = kl;
    }
  }
  // ... and a box corner against the segment (for disjoint convex shapes one of the two is a closest pair).
  const da = a1 - a0, dl = l1 - l0, len2 = da * da + dl * dl;
  for (let k = 0; k < 4; k++) {
    const ka = k & 1 ? ha : -ha, kl = k & 2 ? hi : lo;
    const t = len2 > 0 ? clamp(((ka - a0) * da + (kl - l0) * dl) / len2, 0, 1) : 0;
    const pa = a0 + da * t, pl = l0 + dl * t;
    const d = Math.hypot(pa - ka, pl - kl);
    if (d < best) {
      best = d;
      PA = pa;
      PL = pl;
      KA = ka;
      KL = kl;
    }
  }
  return best;
}

/** Does the segment (a0, l0)..(a1, l1) meet the box [-ha, ha] x [lo, hi] (Liang-Barsky clip; no closure, no allocation)? */
export function segMeetsBox(a0: number, l0: number, a1: number, l1: number, ha: number, lo: number, hi: number): boolean {
  let t0 = 0, t1 = 1;
  const da = a1 - a0, dl = l1 - l0;
  for (let e = 0; e < 4; e++) {
    const p = e === 0 ? -da : e === 1 ? da : e === 2 ? -dl : dl;
    const q = e === 0 ? a0 + ha : e === 1 ? ha - a0 : e === 2 ? l0 - lo : hi - l0;
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t0 <= t1;
}

/** The wall's bounce for a car pushed out along the unit normal (nx, ny): the speed into it back x WALL_BOUNCE, the rest x WALL_SCRAPE. */
function wallBounce(c: CarState, nx: number, ny: number): number {
  const vn = c.vx * nx + c.vy * ny;
  if (vn < 0) {
    c.vx -= (1 + WALL_BOUNCE) * vn * nx;
    c.vy -= (1 + WALL_BOUNCE) * vn * ny;
  }
  c.vx *= WALL_SCRAPE;
  c.vy *= WALL_SCRAPE;
  return vn < 0 ? -vn : 0;
}

/**
 * The presses that are down at race tick rt against a driving car's capsule (see above): pushed out
 * along the closest points' line, or, the axis under it (it came down on the car, or the car landed
 * on it), along the road to the nearer open side. The wall's bounce either way. Returns the fastest
 * speed into one (0 = no contact).
 */
export function collidePresses(c: CarState, gates: readonly PlacedPress[], rt: number): number {
  let hit = 0;
  const ha = PRESS_DEPTH / 2;
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    if (!pressDown(g, rt)) continue;
    const gx = Math.cos(g.h), gy = Math.sin(g.h); // along the road at the press; (g.nx, g.ny) across it
    const ux = Math.cos(c.h), uy = Math.sin(c.h);
    const ca = (c.x - g.x) * gx + (c.y - g.y) * gy, cl = (c.x - g.x) * g.nx + (c.y - g.y) * g.ny;
    const da = (ux * gx + uy * gy) * CAPSULE_HALF, dl = (ux * g.nx + uy * g.ny) * CAPSULE_HALF;
    // Cheap reject: the centre further from the box than the capsule's reach.
    if (ca > ha + CAPSULE_HALF + CAPSULE_R || ca < -ha - CAPSULE_HALF - CAPSULE_R || cl < g.lat0 - CAPSULE_HALF - CAPSULE_R || cl > g.lat1 + CAPSULE_HALF + CAPSULE_R) continue;
    const a0 = ca - da, l0 = cl - dl, a1 = ca + da, l1 = cl + dl;
    let nx: number, ny: number, depth: number;
    // The axis meets the box, or touches it (a distance this small has no direction to push along).
    const d = segMeetsBox(a0, l0, a1, l1, ha, g.lat0, g.lat1) ? 0 : segToBox(a0, l0, a1, l1, ha, g.lat0, g.lat1);
    if (d < 1e-6) {
      // Under it: along the road to the nearer side, the whole capsule out.
      const back = Math.max(a0, a1) + CAPSULE_R + ha, ahead = ha - Math.min(a0, a1) + CAPSULE_R;
      const sgn = ahead < back ? 1 : -1;
      nx = gx * sgn;
      ny = gy * sgn;
      depth = sgn > 0 ? ahead : back;
    } else {
      if (d >= CAPSULE_R) continue;
      // Box frame -> world: (a, l) is along gx, gy and across g.nx, g.ny.
      const na = (PA - KA) / d, nl = (PL - KL) / d; // d >= 1e-6: the axis is clear of the box
      nx = gx * na + g.nx * nl;
      ny = gy * na + g.ny * nl;
      depth = CAPSULE_R - d;
    }
    c.x += nx * depth;
    c.y += ny * depth;
    hit = Math.max(hit, wallBounce(c, nx, ny));
  }
  return hit;
}

/**
 * The trucks' bodies against a driving car's capsule (see above), all but the one whose ramp it rides
 * (`riding`): pushed out along the closest points' line (up to three passes, for an axis that crosses
 * the truck's), with the wall's bounce. Returns the fastest speed into one (0 = no contact).
 */
export function collideTrucks(c: CarState, trucks: readonly PlacedTruck[], riding: PlacedTruck | null): number {
  let hit = 0;
  const reach = TRUCK_HALF + CAPSULE_R;
  for (let i = 0; i < trucks.length; i++) {
    const t = trucks[i];
    if (t === riding) continue;
    for (let pass = 0; pass < 3; pass++) { // the bounce on the first, the rest only push
      const ux = Math.cos(c.h), uy = Math.sin(c.h);
      const d = axisToSegment(c.x, c.y, ux, uy, t.x0, t.y0, t.x1, t.y1);
      if (d >= reach) break;
      let nx: number, ny: number;
      if (d > 1e-6) {
        nx = (CX - QX) / d;
        ny = (CY - QY) / d;
      } else {
        // The car's axis crosses the truck's: across the truck to the side the car's centre is on
        // (right of the truck's heading on its axis).
        const ex = t.x1 - t.x0, ey = t.y1 - t.y0, l = Math.hypot(ex, ey) || 1;
        const side = ex * (c.y - t.y0) - ey * (c.x - t.x0) < 0 ? -1 : 1;
        nx = (-ey / l) * side;
        ny = (ex / l) * side;
      }
      const depth = d > 1e-6 ? reach - d : reach;
      c.x += nx * depth;
      c.y += ny * depth;
      if (pass === 0) hit = Math.max(hit, wallBounce(c, nx, ny));
    }
  }
  return hit;
}

/**
 * Bounce a driving car's capsule off the tyre mounds it overlaps (M4-SURF): pushed straight out of
 * each (the closest point of its axis to the mound's centre, the normal from the centre to it); a
 * car moving into it, or out of it slower than TYRES_MIN_OUT, leaves along the normal at
 * TYRES_RESTITUTION x the speed it came in with, at least TYRES_MIN_OUT, and keeps TYRES_TANGENT of
 * its speed along it. Returns the fastest speed into a mound this tick (0 = no contact).
 */
export function collideTyres(c: CarState, tyres: readonly PlacedTyres[]): number {
  let hit = 0;
  for (let i = 0; i < tyres.length; i++) {
    const m = tyres[i];
    const ux = Math.cos(c.h), uy = Math.sin(c.h);
    const dx = m.x - c.x, dy = m.y - c.y;
    const reach = m.r + CAPSULE_R;
    if (dx * dx + dy * dy >= (reach + CAPSULE_HALF) * (reach + CAPSULE_HALF)) continue;
    const t = clamp(dx * ux + dy * uy, -CAPSULE_HALF, CAPSULE_HALF);
    let nx = c.x + ux * t - m.x, ny = c.y + uy * t - m.y; // from the mound to the car's axis
    const d = Math.hypot(nx, ny);
    if (d >= reach) continue;
    if (d > 1e-6) {
      nx /= d;
      ny /= d;
    } else {
      // The mound's centre on the car's axis: out from the centre, or sideways (left) on it.
      const dc = Math.hypot(dx, dy);
      nx = dc > 1e-6 ? -dx / dc : uy;
      ny = dc > 1e-6 ? -dy / dc : -ux;
    }
    c.x += nx * (reach - d);
    c.y += ny * (reach - d);
    const vn = c.vx * nx + c.vy * ny;
    if (vn < TYRES_MIN_OUT) {
      const out = Math.max(-TYRES_RESTITUTION * vn, TYRES_MIN_OUT);
      const tx = c.vx - vn * nx, ty = c.vy - vn * ny;
      c.vx = tx * TYRES_TANGENT + nx * out;
      c.vy = ty * TYRES_TANGENT + ny * out;
      if (-vn > hit) hit = -vn;
    }
  }
  return hit;
}

/**
 * How far from the centerline a car's centre may go: its side touches the wall there. With a query:
 * the per-sample wall on its side at its s (M4-SURF part 2, wallOf: a widened road's wall is
 * further out); without one, or without a widen on the track: track.wall less half a car, exactly.
 */
export function wallLimit(track: Track, q?: TrackQuery): number {
  return (q === undefined ? track.wall : wallOf(track, q)) - CAR_WIDTH / 2;
}

/**
 * The walls of a driving car on its pose after the move: the islands in its segment's bucket first
 * (collideIslands), then the track's wall on its side (wallLimit with the query), pushed back to it
 * along the normal, the speed into it bounced back WALL_BOUNCE, and WALL_SCRAPE of the rest kept.
 */
function collideWalls(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  c.seg = q.seg;
  const isles = track.islandsAt[q.seg];
  if (isles !== undefined && isles.length > 0) collideIslands(c, q, isles);
  const limit = wallLimit(track, q);
  if (q.dist <= limit) return;
  c.x -= q.nx * (q.dist - limit);
  c.y -= q.ny * (q.dist - limit);
  const vn = c.vx * q.nx + c.vy * q.ny;
  if (vn > 0) {
    c.vx -= (1 + WALL_BOUNCE) * vn * q.nx;
    c.vy -= (1 + WALL_BOUNCE) * vn * q.ny;
  }
  c.vx *= WALL_SCRAPE;
  c.vy *= WALL_SCRAPE;
}

// Islands (M4-SURF part 2, PLAN-M4.md 2.6 B; shared/track.ts PlacedIsland): solid for a car on the
// ground (a flight passes over; a car that lands on one is put back in the nearer lane on its next
// driving step, below). In track coordinates (s, lat) of the car's centre, from its query:
// - Its long sides are a wall: a centre between the middles of its noses (s0 + NOSE_MID ..
//   s1 - NOSE_MID) closer than half a car to the island (lat0 - CAR_WIDTH / 2 < lat < lat1 +
//   CAR_WIDTH / 2), or anywhere on the island's rectangle (a landing), is pushed sideways out to the
//   nearer side, and bounces and scrapes as at the track's wall (WALL_BOUNCE, WALL_SCRAPE): the
//   same rule, the same constants.
// - Each nose is a solid as a tyre mound is (the M4-SURF part 1 contact): the outline of its tyre
//   stacks (PlacedIsland.head, tail: a core box, every point within ISLAND_NOSE_ROUND of it) against
//   the car's capsule, pushed out along the line between their closest points, with the mound's
//   bounce (TYRES_RESTITUTION, TYRES_MIN_OUT, TYRES_TANGENT). Its rounded corners turn a car that
//   clips one into the lane.
// Which applies by the centre's s: before the head's middle the head, past the tail's the tail,
// else the sides. No damage.

/** A nose's middle, from its end of the island (where the sides' wall rule takes over from it). */
export const NOSE_MID = ISLAND_NOSE / 2;

/**
 * The island side a car centre at the query's (s, lat) is against or inside (between the noses'
 * middles and within half a car of the island, or on its rectangle): -1 its left side (the car is
 * in the left lane: pushed to lat0 - CAR_WIDTH / 2), +1 its right side, 0 none.
 */
export function islandSide(isle: PlacedIsland, q: TrackQuery): number {
  const s = q.s, lat = q.lat;
  const lo = isle.lat0 - CAR_WIDTH / 2, hi = isle.lat1 + CAR_WIDTH / 2;
  const onIt = s >= isle.s0 && s <= isle.s1 && lat >= isle.lat0 && lat <= isle.lat1;
  if (!onIt && !(s >= isle.s0 + NOSE_MID && s <= isle.s1 - NOSE_MID && lat > lo && lat < hi)) return 0;
  return lat - lo < hi - lat ? -1 : 1;
}

/**
 * Bounce a driving car off the islands it touches (see above), on its pose after the move; q is
 * its query there. The sides move it along the right-of-travel normal at q (q.side x q.n), so its
 * lateral offset becomes the side's limit exactly.
 */
function collideIslands(c: CarState, q: TrackQuery, isles: readonly PlacedIsland[]): void {
  for (let i = 0; i < isles.length; i++) {
    const isle = isles[i];
    const side = islandSide(isle, q);
    if (side !== 0) {
      const push = side < 0 ? isle.lat0 - CAR_WIDTH / 2 - q.lat : isle.lat1 + CAR_WIDTH / 2 - q.lat; // + = to the right
      const rx = q.side * q.nx, ry = q.side * q.ny; // the right of travel at the car
      c.x += rx * push;
      c.y += ry * push;
      const ix = side < 0 ? rx : -rx, iy = side < 0 ? ry : -ry; // into the island
      const vn = c.vx * ix + c.vy * iy;
      if (vn > 0) {
        c.vx -= (1 + WALL_BOUNCE) * vn * ix;
        c.vy -= (1 + WALL_BOUNCE) * vn * iy;
      }
      c.vx *= WALL_SCRAPE;
      c.vy *= WALL_SCRAPE;
    } else if (q.s < isle.s0 + NOSE_MID) collideNose(c, isle.head);
    else if (q.s > isle.s1 - NOSE_MID) collideNose(c, isle.tail);
  }
}

// collideNose's closest points (no allocation per call): on the car's axis (CX, CY), on the core (QX, QY).
let CX = 0, CY = 0, QX = 0, QY = 0;

/**
 * The closest points of the car's axis (centre (x, y), direction (ux, uy), half-length CAPSULE_HALF)
 * and the segment a..b, into CX, CY and QX, QY; returns their distance.
 */
function axisToSegment(x: number, y: number, ux: number, uy: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax, ey = by - ay;
  const len2 = ex * ex + ey * ey;
  const rx = x - ax, ry = y - ay;
  const b = ux * ex + uy * ey, cc = ux * rx + uy * ry, f = ex * rx + ey * ry;
  const denom = len2 - b * b; // |u| = 1
  // On the segment: t in 0..1 (a + e t); on the axis: s in -CAPSULE_HALF..CAPSULE_HALF (centre + u s).
  let t = denom > 1e-9 ? clamp((f - b * cc) / denom, 0, 1) : len2 > 0 ? clamp(f / len2, 0, 1) : 0;
  let s = clamp(b * t - cc, -CAPSULE_HALF, CAPSULE_HALF);
  t = len2 > 0 ? clamp((f + b * s) / len2, 0, 1) : 0;
  s = clamp(b * t - cc, -CAPSULE_HALF, CAPSULE_HALF);
  CX = x + ux * s;
  CY = y + uy * s;
  QX = ax + ex * t;
  QY = ay + ey * t;
  return Math.hypot(CX - QX, CY - QY);
}

/**
 * A nose (its core box `core`, corners in order, every point within ISLAND_NOSE_ROUND of it) against
 * the car's capsule: pushed straight out (the closest points of the car's axis and the core, the
 * normal from the core's to the car's) with the tyre mound's bounce (collideTyres). Returns the
 * speed into it (0 = no contact or moving out).
 */
export function collideNose(c: CarState, core: readonly Vec[]): number {
  const reach = ISLAND_NOSE_ROUND + CAPSULE_R;
  const ux = Math.cos(c.h), uy = Math.sin(c.h);
  // Cheap reject: the car's centre further from every corner than the core's size plus both reaches.
  const a = core[0], b = core[1], d2 = core[2], e = core[3];
  const span = Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(e.x - a.x, e.y - a.y) + reach + CAPSULE_HALF;
  if ((c.x - a.x) ** 2 + (c.y - a.y) ** 2 >= span * span) return 0;
  let best = Infinity, cx = 0, cy = 0, qx = 0, qy = 0;
  for (let k = 0; k < 4; k++) {
    const p = core[k], q = core[(k + 1) & 3];
    const d = axisToSegment(c.x, c.y, ux, uy, p.x, p.y, q.x, q.y);
    if (d < best) {
      best = d;
      cx = CX;
      cy = CY;
      qx = QX;
      qy = QY;
    }
  }
  // The car's centre inside the core (deep; a landing is the sides' rule): out the way it came.
  const inside = insideQuad(a, b, d2, e, c.x, c.y);
  if (!inside && best >= reach) return 0;
  let nx: number, ny: number, depth: number;
  if (!inside && best > 1e-6) {
    nx = (cx - qx) / best;
    ny = (cy - qy) / best;
    depth = reach - best;
  } else {
    nx = -ux;
    ny = -uy;
    depth = reach + best;
  }
  c.x += nx * depth;
  c.y += ny * depth;
  const vn = c.vx * nx + c.vy * ny;
  if (vn < TYRES_MIN_OUT) {
    const out = Math.max(-TYRES_RESTITUTION * vn, TYRES_MIN_OUT);
    const tx = c.vx - vn * nx, ty = c.vy - vn * ny;
    c.vx = tx * TYRES_TANGENT + nx * out;
    c.vy = ty * TYRES_TANGENT + ny * out;
    return Math.max(0, -vn);
  }
  return 0;
}

/** Is (x, y) inside the convex quad a, b, c, d (corners in order, either way round; an edge counts as inside)? */
function insideQuad(a: Vec, b: Vec, c: Vec, d: Vec, x: number, y: number): boolean {
  const k0 = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  const k1 = (c.x - b.x) * (y - b.y) - (c.y - b.y) * (x - b.x);
  const k2 = (d.x - c.x) * (y - c.y) - (d.y - c.y) * (x - c.x);
  const k3 = (a.x - d.x) * (y - d.y) - (a.y - d.y) * (x - d.x);
  return (k0 >= 0 && k1 >= 0 && k2 >= 0 && k3 >= 0) || (k0 <= 0 && k1 <= 0 && k2 <= 0 && k3 <= 0);
}

/** The pose and velocity a car-car contact needs (CarState and snapshots both fit). */
export interface Body {
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
}

/**
 * One car-car contact: the normal (unit, from a towards b), each car's share of the
 * push-out, each car's share of the impulse, the contact point and the closing speed.
 */
export interface CarContact {
  nx: number;
  ny: number;
  push: number; // each car moves this far along the normal (half the overlap)
  j: number; // each car's velocity change along the normal (0 when already separating)
  px: number; // contact point (midway between the two closest points)
  py: number;
  impact: number; // closing speed along the normal, > 0 when the cars move together
}

/**
 * The single contact between two car capsules, or null when they do not touch.
 *
 * Normal: on a fresh contact (the capsules did not touch at the start of this tick, going
 * back along their relative velocity) it is the closest-points direction at the moment
 * they first touched, so a fast head-on or T-bone that overlapped deeply within one tick
 * still pushes back along the way they met, never sideways through each other. On a
 * sustained contact it is the closest-points direction now, or the centre line once the
 * overlap is deeper than one radius. Push-out: the smallest move along that normal that
 * separates the capsules.
 */
export function carContact(a: Body, b: Body): CarContact | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  // Cheap reject: centres further apart than nose-to-tail contact.
  const reach = 2 * (CAPSULE_HALF + CAPSULE_R);
  if (dx * dx + dy * dy >= reach * reach) return null;
  const ux = Math.cos(a.h), uy = Math.sin(a.h);
  const vx = Math.cos(b.h), vy = Math.sin(b.h);
  const touch = 2 * CAPSULE_R;
  const dist = (ox: number, oy: number) => segGap(ox, oy, ux, uy, vx, vy);
  const now = dist(dx, dy);
  if (now.d >= touch) return null;

  // Where b was relative to a at the start of the tick (current headings).
  const rx = (b.vx - a.vx) * DT, ry = (b.vy - a.vy) * DT;
  let at = now; // the closest points the normal is taken from
  let exact = true; // normal = closest points now, so the overlap is touch - d
  if (dist(dx - rx, dy - ry).d >= touch) {
    // Fresh contact: bisect for the moment of first touch along the relative path.
    let lo = 0, hi = 1; // fraction of the tick: lo apart, hi touching
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (dist(dx - rx * (1 - mid), dy - ry * (1 - mid)).d >= touch) lo = mid;
      else hi = mid;
    }
    at = dist(dx - rx * (1 - lo), dy - ry * (1 - lo));
    exact = false;
  }
  let nx: number, ny: number;
  if (exact ? now.d >= CAPSULE_R : at.d > 1e-6) {
    nx = at.nx;
    ny = at.ny;
  } else {
    // A deep sustained overlap (the client's one-sided push leaves half of it) or one
    // with no motion to go by: the closest points could point sideways through the other
    // car, so use the centre line, or sideways from a when the centres coincide.
    const dc = Math.hypot(dx, dy);
    nx = dc > 1e-6 ? dx / dc : -uy;
    ny = dc > 1e-6 ? dy / dc : ux;
    exact = false;
  }

  let overlap: number;
  if (exact) {
    overlap = touch - now.d;
  } else {
    // Smallest p with the capsules apart after moving b by p along n. Separation along n
    // by the capsules' full extents (an upper bound) certainly parts them; the touching
    // set along a line is an interval, so bisection finds its end.
    let hi = touch + CAPSULE_HALF * (Math.abs(ux * nx + uy * ny) + Math.abs(vx * nx + vy * ny)) - (dx * nx + dy * ny);
    let lo = 0;
    if (hi <= 0) return null;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (dist(dx + nx * mid, dy + ny * mid).d >= touch) hi = mid;
      else lo = mid;
    }
    overlap = hi;
  }
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  return {
    nx,
    ny,
    push: overlap / 2,
    j: rel < 0 ? (-rel * (1 + CAR_RESTITUTION)) / 2 : 0, // equal masses
    px: a.x + (ux * at.s + dx + vx * at.t) / 2,
    py: a.y + (uy * at.s + dy + vy * at.t) / 2,
    impact: Math.max(0, -rel),
  };
}

/** Gap between two car capsules: 0 = touching, < 0 = overlapping by that much. */
export function capsuleGap(a: { x: number; y: number; h: number }, b: { x: number; y: number; h: number }): number {
  const g = segGap(b.x - a.x, b.y - a.y, Math.cos(a.h), Math.sin(a.h), Math.cos(b.h), Math.sin(b.h));
  return g.d - 2 * CAPSULE_R;
}

/**
 * Closest points of the two car segments, a's centred at the origin with direction u and
 * b's centred at (dx, dy) with direction v, both of half-length CAPSULE_HALF: their
 * parameters s and t, the distance d and the unit direction from a's point to b's.
 */
function segGap(
  dx: number, dy: number, ux: number, uy: number, vx: number, vy: number,
): { d: number; nx: number; ny: number; s: number; t: number } {
  const half = CAPSULE_HALF;
  const b = ux * vx + uy * vy; // u·v; |u| = |v| = 1
  const c = ux * dx + uy * dy; // u·d
  const f = vx * dx + vy * dy; // v·d
  const denom = 1 - b * b;
  let s: number;
  if (denom > 1e-9) {
    s = clamp((c - b * f) / denom, -half, half);
  } else {
    // Parallel: the middle of where the two segments overlap along u, or the nearer end.
    const lo = Math.max(-half, c - half), hi = Math.min(half, c + half);
    s = lo <= hi ? (lo + hi) / 2 : clamp(c, -half, half);
  }
  let t = clamp(b * s - f, -half, half);
  s = clamp(b * t + c, -half, half);
  t = clamp(b * s - f, -half, half);
  const ex = dx + vx * t - ux * s, ey = dy + vy * t - uy * s;
  const d = Math.hypot(ex, ey);
  return d > 0 ? { d, nx: ex / d, ny: ey / d, s, t } : { d: 0, nx: 0, ny: 0, s, t };
}

/** Push two overlapping cars apart and trade the velocity along the contact normal. */
export function collideCars(a: CarState, b: CarState): boolean {
  const k = carContact(a, b);
  if (!k) return false;
  a.x -= k.nx * k.push; a.y -= k.ny * k.push;
  b.x += k.nx * k.push; b.y += k.ny * k.push;
  a.vx -= k.nx * k.j; a.vy -= k.ny * k.j;
  b.vx += k.nx * k.j; b.vy += k.ny * k.j;
  return true;
}

/**
 * collideCars for car a alone: b is kinematic (not changed). a moves by exactly its half
 * of the push and gets exactly its half of the impulse, so a ends up where collideCars(a, b)
 * would put it. The client predicts its own car's bumps with this.
 */
export function collideCarOneSided(a: CarState, b: Body): CarContact | null {
  const k = carContact(a, b);
  if (!k) return null;
  a.x -= k.nx * k.push; a.y -= k.ny * k.push;
  a.vx -= k.nx * k.j; a.vy -= k.ny * k.j;
  return k;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Shortest signed difference b - a between two angles. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}
