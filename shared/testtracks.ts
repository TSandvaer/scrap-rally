// Preview test tracks (M4-SCHEMA, PLAN-M4.md 2.2-2.6): track definitions that hold every M4 feature
// type (water, dirt, belts, tyre mounds, rolling barrels, a ramp truck, a crusher press, widened road
// and islands), for the preview and debug path (client/preview.ts, tools/debug) so M4-WORLD can draw
// against them before any track uses them. They are NOT in the lobby's track list (shared/tracks.ts
// SHIPPED) and no client message can select them: isTrackId does not know their ids, so a room's
// setTrack refuses them, unless the server runs with the dev-only env SCRAP_DEV_TRACK set to one of
// their ids (server/room.ts devTrackId, M4-SURF: off by default and on Render). They build and pass
// validateTrack.

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

// The M4-SURF part 1 test track (water, dirt patches, conveyor belts and tyre mounds act; ClickUp
// 123jpnbffyz): the Preview Yard's loop with only the features that do something today, so it can
// be driven (the dev flag SCRAP_DEV_TRACK, server/room.ts) and raced by bots without the barrels,
// truck, press and split lanes that are still drawings. In order round the lap: on the top straight
// a tyre-mound chicane, a dirt patch on the right half and a pool across the whole road (on a
// straight: it costs little); round the right-hand side a belt drifting right, a pool on the
// outside half of the tightest bend (it throws you wide; the inside stays dry), a mound on the
// outside, a dirt patch on the inside of the next bend into the verge (a short cut for the truck),
// a pit and a mound to weave between; on the bottom straight a pool on the left half of the run-up
// to a chasm jump, and a dirt patch past the landing; round the left-hand side a mound on the inside
// of the tightest bend, a pool on its inside half and a belt drifting left.
export const SURF_YARD: TrackDef = {
  id: "surf-yard",
  name: "Surf Yard",
  control: PREVIEW_YARD.control,
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "tyres", s: 700, lat: -30, r: 24 },
    { k: "tyres", s: 880, lat: 32, r: 26 },
    { k: "tyres", s: 1060, lat: -20, r: 20 },
    { k: "dirt", s0: 1240, s1: 1400, lat0: 16, lat1: 64 },
    { k: "water", s0: 1450, s1: 1620, lat0: -64, lat1: 64 },
    { k: "belt", s0: 2300, s1: 2520, lat0: -64, lat1: 64, vx: 70 },
    { k: "water", s0: 2880, s1: 3160, lat0: -64, lat1: 0 },
    { k: "tyres", s: 3560, lat: -38, r: 22 },
    { k: "dirt", s0: 4480, s1: 4760, lat0: 20, lat1: 108 },
    { k: "hole", s: 5000, lat: 26, r: 24 },
    { k: "tyres", s: 5220, lat: -24, r: 22 },
    { k: "water", s0: 5900, s1: 6100, lat0: -64, lat1: 0 },
    { k: "ramp", s: 6300, len: 80 },
    { k: "gap", s0: 6380, s1: 6560 },
    { k: "dirt", s0: 6720, s1: 6900, lat0: -8, lat1: 64 },
    { k: "tyres", s: 8000, lat: 38, r: 22 },
    { k: "water", s0: 8380, s1: 8640, lat0: 0, lat1: 64 },
    { k: "belt", s0: 9000, s1: 9300, lat0: -64, lat1: 64, vx: -80 },
  ],
  recovery: [0, 3300, 5650],
};

// The M4-SURF part 2 test track (split lanes; ClickUp 123jpnbffz4): the Preview Yard's loop with
// three splits and nothing else, plain road between them (the user found the Surf Yard "way too
// packed"). The road widens round an island into two lanes, and narrows again past it:
// - on the top straight a plain split: two equal lanes (the bots take the lane their seat's line is on);
// - on the bottom straight a split with the left lane flooded and the right lane dirt (the truck
//   takes the dirt, the Sport and the Racer the water: it keeps their speed on a straight);
// - in the bend from the bottom straight into the left-hand side a split whose inside (right) lane
//   is the shorter one (all the bots take it).
// Picked with the dev flag SCRAP_DEV_TRACK=split-yard (server/room.ts).
export const SPLIT_YARD: TrackDef = {
  id: "split-yard",
  name: "Split Yard",
  control: PREVIEW_YARD.control,
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "widen", s0: 650, s1: 1750, left: 48, right: 48 },
    { k: "island", s0: 820, s1: 1580, lat0: -22, lat1: 22 },
    { k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 },
    { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 },
    { k: "water", s0: 6050, s1: 6550, lat0: -124, lat1: -28 },
    { k: "dirt", s0: 6050, s1: 6750, lat0: 28, lat1: 124 },
    { k: "widen", s0: 7800, s1: 8700, left: 40, right: 40 },
    { k: "island", s0: 7950, s1: 8550, lat0: -24, lat1: 24 },
  ],
  recovery: [0],
};

// The M4-MOVE test track (rolling barrels, crusher presses and a parked ramp truck; ClickUp
// 123jpnbffz5): the Preview Yard's loop with three spaced groups and long plain road between them
// (the user found the Surf Yard "way too packed"); nothing else on it.
// - On the top straight two rows of rolling barrels 500 apart: three barrels rolling right at
//   110 u/s, then two rolling left at 90 (dodge them, or time them).
// - On the bottom straight a parked ramp truck right of the centre: in its ramp band at 220 u/s or
//   more a car rides up and jumps the cab (the straight past it is long enough for a boosted flight);
//   slower, or beside the band, the truck is solid. The road left of it is the way round.
// - Round the left-hand side two crusher presses 400 apart: the first over the left two thirds of
//   the road, the second over the right two thirds, on different cycles (take the open side, or time
//   them).
// Picked with the dev flag SCRAP_DEV_TRACK=move-yard (server/room.ts).
export const MOVE_YARD: TrackDef = {
  id: "move-yard",
  name: "Move Yard",
  control: PREVIEW_YARD.control,
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "barrels", s: 800, n: 3, period: 240, speed: 110 },
    { k: "barrels", s: 1300, n: 2, period: 220, speed: -90 },
    { k: "truck", s: 5950, lat: 24, len: 110 },
    { k: "press", s: 8650, lat0: -64, lat1: 16, period: 160, down: 50 },
    { k: "press", s: 9050, lat0: -16, lat1: 64, period: 200, down: 60 },
  ],
  recovery: [0],
};

// The BR-SCHEMA test track (shortcut roads, PLAN-BRANCH.md 2.10; ClickUp 123jpnbfgh9): a roomy loop
// (a rounded rectangle, the start on the top side just out of the top-left bend) with three shortcuts
// that cut three of its corners, each leaving the main road at a fork and rejoining it at a merge, and
// plain road between them; nothing else on it. In order round the lap:
// - top-right: a dirt cut, a stretch of dirt across the whole shortcut (under ~350 units: the mud rule);
// - bottom-right: a jump cut, a ramp and a chasm (a recovery point before it), out of sight of the main road;
// - bottom-left: a narrow cut (80 wide: half-width 40) with pits to steer between.
// Nothing drives or draws a branch yet (BR-PHYS, BR-BAKE): today it races as its main road.
// Picked with the dev flag SCRAP_DEV_TRACK=branch-yard (server/room.ts).
export const BRANCH_YARD: TrackDef = {
  id: "branch-yard",
  name: "Branch Yard",
  control: [
    [800, 600], [1400, 600], [2000, 600], [2600, 600], [3200, 600], [3800, 600], [4400, 600], [5000, 600], [5600, 600], [6100, 600],
    [6450, 700], [6600, 1050],
    [6600, 1600], [6600, 2200], [6600, 2800], [6600, 3400], [6600, 4000], [6600, 4600], [6600, 5200],
    [6500, 5650], [6150, 6000],
    [5600, 6000], [5000, 6000], [4400, 6000], [3800, 6000], [3200, 6000], [2600, 6000], [2000, 6000], [1400, 6000], [900, 6000],
    [450, 5900], [250, 5550],
    [200, 5000], [200, 4400], [200, 3800], [200, 3200], [200, 2600], [200, 2000],
    [250, 1100], [450, 750],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    {
      k: "branch", s0: 4000.7, s1: 7409.6, side: 1, halfWidth: 56,
      control: [[5000, 680], [5250, 820], [5600, 1030], [6170, 1600], [6380, 1950], [6520, 2200]],
      features: [{ k: "dirt", s0: 1200, s1: 1540, lat0: -56, lat1: 56 }],
    },
    {
      k: "branch", s0: 9209.6, s1: 12532.5, side: 1, halfWidth: 56,
      control: [[6520, 4400], [6380, 4650], [6170, 5000], [5600, 5570], [5250, 5780], [5000, 5920]],
      features: [{ k: "ramp", s: 1150, len: 80 }, { k: "gap", s0: 1230, s1: 1370 }],
      recovery: [850],
    },
    {
      k: "branch", s0: 15332.5, s1: 18663.6, side: 1, halfWidth: 40,
      control: [[1800, 5920], [1550, 5780], [1200, 5570], [630, 5000], [420, 4650], [280, 4400]],
      features: [{ k: "hole", s: 1100, lat: -18, r: 20 }, { k: "hole", s: 1350, lat: 18, r: 20 }, { k: "hole", s: 1600, lat: -18, r: 20 }],
      recovery: [850],
    },
  ],
  // The start line, and before each fork (a fall on a branch before its first recovery point comes back
  // to the main road's before the fork: PLAN-BRANCH user decision 6).
  recovery: [0, 3600, 8800, 14900],
};

/** Every preview test track, in the order a preview lists them. */
export const TEST_TRACKS: readonly TrackDef[] = [PREVIEW_YARD, SURF_YARD, SPLIT_YARD, MOVE_YARD, BRANCH_YARD];

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
