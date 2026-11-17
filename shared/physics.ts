// Arcade car physics. Pure and shared: the server runs it authoritatively and the
// client runs the same code to predict its own car. Bit-exact agreement is not needed;
// reconciliation absorbs tiny floating-point differences between JS engines.

import { queryTrackNear, type Track } from "./track";

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
}

/** Per-car tuning. The upgrade shop will modify these. */
export interface CarStats {
  accel: number;
  topSpeed: number;
  grip: number; // how fast sideways sliding dies out (higher = grippier)
  turn: number; // rad/s at full steering lock
}

export const BASE_STATS: CarStats = { accel: 520, topSpeed: 430, grip: 7.5, turn: 3.3 };

export interface Input {
  throttle: number; // -1 (brake/reverse) .. 1 (accelerate)
  steer: number; // -1 (left) .. 1 (right)
}

export const NO_INPUT: Input = { throttle: 0, steer: 0 };

const BRAKE = 900;
const REVERSE_FACTOR = 0.5;
const ROLL = 60; // coasting deceleration
const GRASS_DRAG_MULT = 2.9;
const GRASS_GRIP_MULT = 0.37;
const FULL_TURN_SPEED = 140; // below this speed steering is scaled down
const WALL_BOUNCE = 0.35;
const WALL_SCRAPE = 0.97;

export function cloneCar(c: CarState): CarState {
  return { x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, seg: c.seg, wreck: c.wreck, air: c.air, fall: c.fall };
}

export function speedOf(c: { vx: number; vy: number }): number {
  return Math.hypot(c.vx, c.vy);
}

/** Advance one fixed step (DT). Mutates the car. */
export function stepCar(c: CarState, input: Input, stats: CarStats, track: Track): void {
  const throttle = clamp(input.throttle, -1, 1);
  const steer = clamp(input.steer, -1, 1);
  const cos = Math.cos(c.h), sin = Math.sin(c.h);

  // Velocity in the car's frame.
  let vf = c.vx * cos + c.vy * sin;
  let vl = -c.vx * sin + c.vy * cos;

  const q = queryTrackNear(track, c.x, c.y, c.seg);
  c.seg = q.seg;
  const onRoad = q.dist <= track.def.halfWidth;
  const drag = (stats.accel / stats.topSpeed) * (onRoad ? 1 : GRASS_DRAG_MULT);
  const grip = stats.grip * (onRoad ? 1 : GRASS_GRIP_MULT);

  if (throttle > 0) {
    vf += (vf < 0 ? BRAKE : stats.accel) * throttle * DT;
  } else if (throttle < 0) {
    vf -= (vf > 0 ? BRAKE : stats.accel * REVERSE_FACTOR) * -throttle * DT;
  } else {
    const roll = ROLL * DT;
    vf = Math.abs(vf) <= roll ? 0 : vf - Math.sign(vf) * roll;
  }
  vf -= vf * drag * DT;
  vl *= Math.exp(-grip * DT);

  // Recompose in the old heading, then turn: the velocity lags the heading a little,
  // which is what makes the car slide through fast corners.
  c.vx = vf * cos - vl * sin;
  c.vy = vf * sin + vl * cos;
  const turnScale = clamp(vf / FULL_TURN_SPEED, -1, 1);
  c.h = wrapAngle(c.h + steer * stats.turn * turnScale * DT);

  c.x += c.vx * DT;
  c.y += c.vy * DT;

  collideWalls(c, track);
}

function collideWalls(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  c.seg = q.seg;
  const limit = track.wall - CAR_WIDTH / 2;
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
