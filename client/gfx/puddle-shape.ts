// The traction area of a puddle (M4-WORLD; user decisions 2026-11-21: "dirt and water puddles
// should not be square, it should read as a puddle", and "the traction square" is to be made
// smaller so that it fits inside the puddle).
//
// A water pool and a dirt patch are rectangles in track coordinates in a track's data
// (shared/track.ts Water, Dirt: s0..s1 along the road, lat0..lat1 across it). Two things are
// made of that rectangle:
// - What is drawn: a puddle inside the rectangle, which is its bounds. Its edge wanders in a
//   few lobes between PUDDLE_NEAR and PUDDLE_FAR inside the rectangle's sides, and its corners
//   are round (client/gfx/world.ts, puddleEdge).
// - What a car feels (M4-SURF: where it aquaplanes, where the ground is loose): the rectangle
//   less PUDDLE_TRACTION_INSET on every side, tractionRect below. A plain rectangle test.
// The inset is chosen with the outline so that the whole traction rectangle lies inside the
// drawn puddle, on every track, at every point (tools/debug/puddle-probe.ts holds the baked
// tiles against it): a car is never slowed or sent sliding by ground that does not show it.
//
// M4-SURF moves the constant and the function into shared/track.ts unchanged; until then they
// live here. Pure, and nothing of the client in it: the two types are all it imports.

import type { Dirt, Water } from "../../shared/track";

/** A puddle's declared rectangle: a water pool's or a dirt patch's, in track coordinates (world units). */
export type PuddleRect = Pick<Water, "s0" | "s1" | "lat0" | "lat1"> | Pick<Dirt, "s0" | "s1" | "lat0" | "lat1">;

/** The traction area lies this far inside a puddle's declared rectangle, on every side (world units). */
export const PUDDLE_TRACTION_INSET = 12;

/**
 * The traction area of a puddle: its declared rectangle less PUDDLE_TRACTION_INSET on every
 * side. A rectangle narrower (or shorter) than two insets has no area left that way: its
 * traction area is then the line down its middle (s0 = s1, or lat0 = lat1), which no car
 * centre is inside of by a test with `<`.
 */
export function tractionRect(f: PuddleRect): { s0: number; s1: number; lat0: number; lat1: number } {
  const long = f.s1 - f.s0 >= 2 * PUDDLE_TRACTION_INSET, wide = f.lat1 - f.lat0 >= 2 * PUDDLE_TRACTION_INSET;
  const s = (f.s0 + f.s1) / 2, lat = (f.lat0 + f.lat1) / 2;
  return {
    s0: long ? f.s0 + PUDDLE_TRACTION_INSET : s,
    s1: long ? f.s1 - PUDDLE_TRACTION_INSET : s,
    lat0: wide ? f.lat0 + PUDDLE_TRACTION_INSET : lat,
    lat1: wide ? f.lat1 - PUDDLE_TRACTION_INSET : lat,
  };
}
