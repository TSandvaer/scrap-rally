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

// ---- lightning cells and the boost (M4-CELLS, PLAN-M4.md 2.5) -----------------------------

/**
 * While CarState.boost > 0 (ticks left) the car's acceleration is BOOST_ACCEL times and its top
 * speed BOOST_TOP times its own (430 -> 537 u/s; shared/physics.ts stepCar, no slipstream on top
 * of it). When it runs out the extra speed dies away with the car's own drag (~0.8 s).
 */
export const BOOST_ACCEL = 1.6;
export const BOOST_TOP = 1.25;

/** The fastest a boosted car can go: what the jumps are checked at (shared/weapons.ts). */
export function boostTopSpeed(topSpeed: number): number {
  return topSpeed * BOOST_TOP;
}

/**
 * A cell's boost by the taker's gap to the leader (race distance, from the latest snapshot's rd on
 * the client; the leader is the leading car that has not finished, advisor change 10): the leader
 * BOOST_LEADER_TICKS; up to BOOST_GAPS[0] behind BOOST_TICKS[0]; up to BOOST_GAPS[1] behind
 * BOOST_TICKS[1]; further behind BOOST_TICKS[2]. Shown on the HUD.
 */
export const BOOST_LEADER_TICKS = 36; // 0.6 s
export const BOOST_GAPS = [400, 1200] as const;
export const BOOST_TICKS = [54, 72, 90] as const; // 0.9, 1.2, 1.5 s

/** Boost ticks a cell gives a car `gap` race distance behind the leader (<= 0: it leads). */
export function boostTicksFor(gap: number): number {
  if (!(gap > 0)) return BOOST_LEADER_TICKS;
  return gap <= BOOST_GAPS[0] ? BOOST_TICKS[0] : gap <= BOOST_GAPS[1] ? BOOST_TICKS[1] : BOOST_TICKS[2];
}

/**
 * The boost a car would get now, from the race distances of a field: `rd` its own, `field` every
 * car still racing with a car (rd, finished). The leader = the leading car that has not finished.
 */
export function boostOffer(rd: number, field: Iterable<{ rd: number; fin: boolean }>): number {
  let lead = -Infinity;
  for (const f of field) if (!f.fin && f.rd > lead) lead = f.rd;
  return boostTicksFor(lead === -Infinity ? 0 : lead - rd);
}

/** A cell's radius (drawn and touched). */
export const CELL_RADIUS = 14;
/**
 * A car takes a cell when its centre comes this close to the cell's: the cell's radius plus the
 * car's round hit shape (CAR_RADIUS 13, shared/physics.ts, as for mines; checked in sim-test).
 */
export const CELL_TOUCH = CELL_RADIUS + 13;
/** A cell is back this many race ticks after it was taken (8 s). */
export const CELL_RESPAWN = 480;
/** An air cell is only taken by a car this high in its jump or higher (shared/weapons.ts airHeight). */
export const CELL_AIR_HEIGHT = 0.4;

/**
 * Is a cell available at race tick rt? back: the race tick it comes back (the snapshot's
 * cells[i]), 0 = it is there.
 */
export function cellOpen(back: number, rt: number): boolean {
  return back === 0 || rt >= back;
}

/**
 * The earliest fraction (0..1) of a tick at which a car moving in a straight line from (x0, y0) to
 * (x1, y1) touches a cell at (cx, cy) (its centre within CELL_TOUCH), or -1 if it does not.
 */
export function cellTouch(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number): number {
  const ax = x0 - cx, ay = y0 - cy;
  const dx = x1 - x0, dy = y1 - y0;
  const r2 = CELL_TOUCH * CELL_TOUCH;
  const c = ax * ax + ay * ay - r2;
  if (c <= 0) return 0; // touching from the start
  const a = dx * dx + dy * dy;
  if (a === 0) return -1;
  const b = ax * dx + ay * dy;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : -1;
}
