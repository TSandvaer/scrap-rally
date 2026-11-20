// Catch-up (PLAN-M4.md 2.8, M4-DRAFT): the slipstream. Every constant of it lives here, and so
// do the pure rules the server (authority, server/room.ts) and the client (its own prediction,
// client/contact.ts) both run, so they agree. Always on, no host toggle (user decision
// 2026-11-20), no stored state: a car's draft is worked out afresh every tick from the
// start-of-tick poses of the cars around it.
//
// No runtime imports: shared/physics.ts reads the constants below, so this file must not import
// it back (types only).

import type { Body } from "./physics";

// ---- slipstream -------------------------------------------------------------------------

/** A car gives a draft only at this speed or more (u/s). */
export const DRAFT_LEAD_MIN_SPEED = 250;
/**
 * Distance behind the leader, along the leader's heading (centre to centre): no draft closer
 * than DRAFT_NEAR (alongside: nose to tail the centres are 31 apart, so a car right on the
 * leader's bumper still drafts fully), full strength up to DRAFT_FULL, then falling linearly
 * to 0 at DRAFT_FAR. The cut at DRAFT_NEAR is what keeps a pass from turning into a tug of
 * war: the car just passed is alongside the passer, not in its wake (tools/debug/draft-tune.ts).
 */
export const DRAFT_NEAR = 20;
export const DRAFT_FULL = 60;
export const DRAFT_FAR = 180;
/**
 * The wake's half-width at a distance d behind the leader: DRAFT_WIDTH + DRAFT_SPREAD * d.
 * Tapered, not a hard edge (PLAN-M4 advisor change 8): full strength within DRAFT_TAPER inside
 * that line, falling linearly to 0 DRAFT_TAPER outside it.
 */
export const DRAFT_WIDTH = 22;
export const DRAFT_SPREAD = 0.1;
export const DRAFT_TAPER = 8;
/**
 * The follower's drag is multiplied by (1 - DRAFT_DRAG_CUT * w) for draft strength w (0..1):
 * at full strength its terminal speed is topSpeed / 0.91, about +10 % (430 -> 473 u/s). The
 * speed carries for about a second after pulling out (the drag time constant), so a pass takes
 * about 1.5-2 s. Not while boosted (shared/physics.ts stepCar): the boost is already faster.
 */
export const DRAFT_DRAG_CUT = 0.09;

/** The fastest a car on full draft can go: what the jumps are checked at (shared/weapons.ts). */
export function draftTopSpeed(topSpeed: number): number {
  return topSpeed / (1 - DRAFT_DRAG_CUT);
}

/** The tunable shape of the slipstream (tools/debug/draft-tune.ts sweeps it). */
export interface DraftShape {
  near: number;
  full: number;
  far: number;
  width: number;
  spread: number;
  taper: number;
}

export const DRAFT_SHAPE: DraftShape = {
  near: DRAFT_NEAR,
  full: DRAFT_FULL,
  far: DRAFT_FAR,
  width: DRAFT_WIDTH,
  spread: DRAFT_SPREAD,
  taper: DRAFT_TAPER,
};

/**
 * Slipstream strength 0..1 a car at (fx, fy) gets from a leader at (lx, ly) heading lh: by the
 * distance behind it along that heading and the distance off its line. Geometry only; who may
 * give and take a draft is givesDraft / takesDraft.
 */
export function draftFrom(fx: number, fy: number, lx: number, ly: number, lh: number, shape: DraftShape = DRAFT_SHAPE): number {
  const ux = Math.cos(lh), uy = Math.sin(lh);
  const rx = lx - fx, ry = ly - fy;
  const d = rx * ux + ry * uy; // how far the follower is behind (+) the leader along its heading
  if (d <= shape.near || d >= shape.far) return 0;
  const lat = Math.abs(rx * uy - ry * ux);
  const edge = shape.width + shape.spread * d;
  const wl = (edge + shape.taper - lat) / (2 * shape.taper);
  if (wl <= 0) return 0;
  const wd = d <= shape.full ? 1 : (shape.far - d) / (shape.far - shape.full);
  return wd * (wl < 1 ? wl : 1);
}

/** The state a draft rule reads of a car (CarState and CarSnap both fit). */
export interface DraftCar extends Body {
  air: number;
  fall: number;
  wreck: number;
}

/**
 * Can this car give a draft? On the ground, not wrecked, not ghosted, not finished (ghosts and
 * finished cars are not there for the others: no collisions, so no wake either; advisor change
 * 8) and at DRAFT_LEAD_MIN_SPEED or more. air: its air ticks (the client passes 0 for a car
 * its snapshot shows in the air that has landed by the step it predicts).
 */
export function givesDraft(c: DraftCar, ghost: boolean, finished: boolean, air = c.air): boolean {
  return air === 0 && c.fall === 0 && c.wreck === 0 && !ghost && !finished && c.vx * c.vx + c.vy * c.vy >= DRAFT_LEAD_MIN_SPEED * DRAFT_LEAD_MIN_SPEED;
}

/** Can this car take a draft? On the ground (and not wrecked or falling: it does not drive then). */
export function takesDraft(c: DraftCar): boolean {
  return c.air === 0 && c.fall === 0 && c.wreck === 0;
}

/** One car of the field as the server's draft pass sees it at the start of a tick. */
export interface DraftEntry {
  car: DraftCar;
  ghost: boolean;
  finished: boolean;
}

/**
 * Every car's draft this tick (out[i] for field[i]), from the start-of-tick poses: the strongest
 * wake it is in, from any car that gives one. The server's rule (server/room.ts simulate).
 */
export function draftsFor(field: readonly DraftEntry[], out: number[], shape: DraftShape = DRAFT_SHAPE): number[] {
  out.length = field.length;
  for (let i = 0; i < field.length; i++) {
    const f = field[i].car;
    let w = 0;
    if (takesDraft(f)) {
      for (let j = 0; j < field.length && w < 1; j++) {
        if (j === i) continue;
        const l = field[j];
        if (!givesDraft(l.car, l.ghost, l.finished)) continue;
        const s = draftFrom(f.x, f.y, l.car.x, l.car.y, l.car.h, shape);
        if (s > w) w = s;
      }
    }
    out[i] = w;
  }
  return out;
}
