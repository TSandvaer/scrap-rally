// Weapons, damage states and the race-car step. Pure and shared: the server runs it
// authoritatively and the client uses the same code to predict its own car (wreck freeze
// and respawn included) and to draw its own shots without waiting for the server.

import { CAR_LENGTH, CAR_RADIUS, DT, stepCar, type CarState, type CarStats, type Input } from "./physics";
import { pointAt, queryTrackNear, type Track } from "./track";

// Nobody can fire or drop a mine until this long after the start (GO), in ms of server
// time. A mine press inside the window is discarded, not saved for later.
export const WEAPONS_ARM_MS = 8000;

// All other timers are in ticks (60 per second).
export const CAR_HP = 100;
export const WRECK_TICKS = 90;
export const GHOST_TICKS = 60;

export const RIVET_SPEED = 900;
export const RIVET_RANGE = 650;
export const RIVET_DAMAGE = 4;
export const RIVET_COOLDOWN = 9;
export const RIVET_RADIUS = 2;

export const MINE_ARM_TICKS = 24;
export const MINE_LIFE_TICKS = 25 * 60;
export const MINE_DAMAGE = 15;
export const MINE_RADIUS = 9;
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
 * Advance a race car one tick. A wrecked car sits still and counts down, then respawns on
 * the centerline at its current track distance. Server and client both step cars only
 * through this, so the client predicts the freeze and the respawn jump exactly.
 */
export function stepRaceCar(c: CarState, input: Input, stats: CarStats, track: Track): void {
  if (c.wreck > 0) {
    c.vx = 0;
    c.vy = 0;
    c.wreck--;
    if (c.wreck === 0) respawn(c, track);
    return;
  }
  stepCar(c, input, stats, track);
}

export function respawn(c: CarState, track: Track): void {
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const p = pointAt(track, q.s);
  c.x = p.x;
  c.y = p.y;
  c.h = p.h;
  c.vx = 0;
  c.vy = 0;
  c.seg = p.seg;
}

export function wreckCar(c: CarState): void {
  c.wreck = WRECK_TICKS;
  c.vx = 0;
  c.vy = 0;
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

/** Move a shot one tick. Returns false when it is spent (out of range or into a wall). */
export function moveShot(s: Shot, track: Track): boolean {
  s.x += s.vx * DT;
  s.y += s.vy * DT;
  s.travelled += Math.hypot(s.vx, s.vy) * DT;
  const q = queryTrackNear(track, s.x, s.y, s.seg);
  s.seg = q.seg;
  return s.travelled <= RIVET_RANGE && q.dist <= track.wall;
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
