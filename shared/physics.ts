// Arcade car physics. Pure and shared: the server runs it authoritatively and the
// client runs the same code to predict its own car. Bit-exact agreement is not needed;
// reconciliation absorbs tiny floating-point differences between JS engines.

import { queryTrackNear, type Track } from "./track";

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const CAR_LENGTH = 30;
export const CAR_WIDTH = 16;
export const CAR_RADIUS = 13; // used for car-car collisions

export interface CarState {
  x: number;
  y: number;
  h: number; // heading, radians (0 = +x, increasing = clockwise on screen)
  vx: number;
  vy: number;
  seg: number; // last track segment, the search hint for track queries
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
  return { x: c.x, y: c.y, h: c.h, vx: c.vx, vy: c.vy, seg: c.seg };
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

/** Push two overlapping cars apart and trade the velocity along the contact normal. */
export function collideCars(a: CarState, b: CarState): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const min = CAR_RADIUS * 2;
  if (d >= min || d === 0) return false;
  const nx = dx / d, ny = dy / d;
  const push = (min - d) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    const j = -rel * 0.9; // equal masses, slightly inelastic
    a.vx -= nx * j; a.vy -= ny * j;
    b.vx += nx * j; b.vy += ny * j;
  }
  return true;
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
