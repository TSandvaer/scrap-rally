// Preview test tracks (M4-SCHEMA, PLAN-M4.md 2.2-2.6): track definitions that hold every M4 feature
// type (water, dirt, belts, tyre mounds, rolling barrels, a ramp truck, a crusher press, widened road
// and islands), for the preview and debug path (client/preview.ts, tools/debug) so M4-WORLD can draw
// against them before any track uses them. They are NOT in the lobby's track list (shared/tracks.ts
// SHIPPED) and no client message can select them: isTrackId does not know their ids, so a room's
// setTrack refuses them. They build and pass validateTrack.

import { buildTrack, type Track, type TrackDef } from "./track";

// A long loop: a straight top side (s ~600-1800, heading +x), a gentle right-hand side, a straight
// bottom side (s ~5800-7000, heading -x) and a left-hand side bending right.
// Top straight: a tyre-mound chicane, a row of rolling barrels, then a full-width pool (it lies on a
// straight, so it needs no dry lane). Right side: a parked ramp truck, then a pool in the bend that
// leaves a dry lane. Bottom straight: a split around an island, the left lane flooded and the right
// lane dirt, with a crusher press across the right lane. Left side: a split in the bend (the inside
// lane is the shorter one), then a conveyor belt.
export const PREVIEW_YARD: TrackDef = {
  id: "preview-yard",
  name: "Preview Yard",
  control: [
    [800, 600], [1400, 600], [2000, 600], [2600, 600], [3200, 600], [3700, 800], [3900, 1300], [3900, 1900],
    [3700, 2400], [3200, 2600], [2600, 2600], [2000, 2600], [1400, 2600], [800, 2600], [400, 2400], [200, 1900],
    [200, 1300], [400, 800],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "tyres", s: 700, lat: -30, r: 24 },
    { k: "tyres", s: 880, lat: 32, r: 26 },
    { k: "tyres", s: 1060, lat: -20, r: 20 },
    { k: "barrels", s: 1260, n: 3, period: 240, speed: 110 },
    { k: "water", s0: 1450, s1: 1620, lat0: -64, lat1: 64 },
    { k: "truck", s: 3450, lat: 30, len: 110 },
    { k: "water", s0: 3800, s1: 4100, lat0: -64, lat1: 0 },
    { k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 },
    { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 },
    { k: "water", s0: 6000, s1: 6500, lat0: -124, lat1: -28 },
    { k: "dirt", s0: 6000, s1: 6750, lat0: 28, lat1: 124 },
    { k: "press", s: 6820, lat0: 28, lat1: 124, period: 180, down: 60 },
    { k: "widen", s0: 7700, s1: 8500, left: 40, right: 40 },
    { k: "island", s0: 7850, s1: 8350, lat0: -24, lat1: 24 },
    { k: "belt", s0: 8800, s1: 9100, lat0: -64, lat1: 64, vx: -60 },
  ],
  recovery: [0, 3200, 5500],
};

/** Every preview test track, in the order a preview lists them. */
export const TEST_TRACKS: readonly TrackDef[] = [PREVIEW_YARD];

const built = new Map<string, Track>(); // built once per id; a Track is never mutated

/** The built preview test track for an id, or null when it is not one. */
export function testTrack(id: string): Track | null {
  const def = TEST_TRACKS.find((d) => d.id === id);
  if (!def) return null;
  let t = built.get(id);
  if (!t) {
    t = buildTrack(def);
    built.set(id, t);
  }
  return t;
}
