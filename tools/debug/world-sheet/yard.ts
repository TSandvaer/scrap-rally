// The contact sheet's own track (tools/debug/world-sheet.ts): Preview Yard's loop with every
// M4 feature laid on each kind of ground, so the sheet can show each on asphalt, on dirt and
// across a kerb. A drawing fixture only: it is not a track of the game and not a test track
// (shared/testtracks.ts), nothing can race on it, and it is not held to validateTrack (a mound
// may lie on a kerb here, a dirt patch under a row of barrels).

import { buildTrack, type Track, type TrackDef } from "../../../shared/track";
import { PREVIEW_YARD } from "../../../shared/testtracks";

export const SHEET_YARD: TrackDef = {
  id: "sheet-yard",
  name: "Sheet Yard",
  control: PREVIEW_YARD.control,
  halfWidth: PREVIEW_YARD.halfWidth,
  verge: PREVIEW_YARD.verge,
  features: [
    // The top straight (heading right). Tyre mounds: on dirt, on asphalt, across the kerb; the three sizes.
    { k: "dirt", s0: 640, s1: 770, lat0: -64, lat1: 64 },
    { k: "tyres", s: 705, lat: 0, r: 24 },
    { k: "tyres", s: 850, lat: -22, r: 30 },
    { k: "tyres", s: 930, lat: 72, r: 18 },
    // A row of barrels: over the verge, the kerbs, the asphalt and a dirt patch.
    { k: "dirt", s0: 1010, s1: 1110, lat0: -64, lat1: -6 },
    { k: "barrels", s: 1060, n: 3, period: 240, speed: 110 },
    // Water: on the asphalt, and over the kerb onto the verge.
    { k: "water", s0: 1170, s1: 1280, lat0: -44, lat1: 40 },
    { k: "water", s0: 1310, s1: 1420, lat0: 24, lat1: 102 },
    // A belt on the asphalt; the truck on the asphalt.
    { k: "belt", s0: 1470, s1: 1600, lat0: -64, lat1: 64, vx: 60 },
    { k: "truck", s: 1660, lat: -26, len: 110 },
    // The top right corner (a tight bend): a pool on its inside and a dirt patch on its outside.
    { k: "water", s0: 2760, s1: 2900, lat0: -10, lat1: 64 },
    { k: "dirt", s0: 2960, s1: 3120, lat0: -64, lat1: 24 },
    // The right-hand side (a bend, heading down): the truck on dirt and across the kerb, a belt
    // over the kerb, a press right across the road.
    { k: "dirt", s0: 3380, s1: 3570, lat0: -16, lat1: 64 },
    { k: "truck", s: 3420, lat: 26, len: 110 },
    { k: "truck", s: 3720, lat: 52, len: 90 },
    { k: "belt", s0: 3950, s1: 4080, lat0: -10, lat1: 104, vx: -60 },
    { k: "press", s: 4300, lat0: -64, lat1: 64, period: 180, down: 60 },
    // The bottom right corner (a tight bend): a pool and a dirt patch right across the road.
    { k: "water", s0: 4540, s1: 4700, lat0: -64, lat1: 64 },
    { k: "dirt", s0: 4780, s1: 4960, lat0: -64, lat1: 64 },
    // The bottom straight (heading left): a split round an island, a flooded lane and a dirt
    // lane; a press on the dirt, and one that reaches over the kerb.
    { k: "widen", s0: 5750, s1: 7050, left: 60, right: 60 },
    { k: "island", s0: 5900, s1: 6900, lat0: -28, lat1: 28 },
    { k: "water", s0: 6000, s1: 6500, lat0: -124, lat1: -28 },
    { k: "dirt", s0: 6000, s1: 6700, lat0: 28, lat1: 124 },
    { k: "press", s: 6560, lat0: 28, lat1: 124, period: 180, down: 60 },
    { k: "press", s: 6800, lat0: 28, lat1: 150, period: 180, down: 60 },
    // The left-hand side: a split in the bend, a row of barrels rolling the other way, a belt.
    { k: "widen", s0: 7700, s1: 8500, left: 40, right: 40 },
    { k: "island", s0: 7850, s1: 8350, lat0: -24, lat1: 24 },
    { k: "barrels", s: 8660, n: 4, period: 200, speed: -150 },
    { k: "belt", s0: 8800, s1: 9100, lat0: -64, lat1: 64, vx: -60 },
  ],
  recovery: [0],
};

let built: Track | null = null;

export function sheetYard(): Track {
  return built ?? (built = buildTrack(SHEET_YARD));
}
