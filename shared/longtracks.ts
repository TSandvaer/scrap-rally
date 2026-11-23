// The two long tracks (M4-TRACKS, ClickUp 123jpnbffz6; PLAN-M4.md 2.7): Slag Harbour and Breaker's
// Mile. Original layouts and names. A lap is about twice a shipped track's (server bot laps of 50-60 s
// at Normal), and the M4 features come in spaced groups with plain racing road between them, never
// two obstacle kinds back to back (user feedback for M4-TRACKS: "I like the obstacles but the surf
// yard have way to many to closely packed"); no dirt stretch is longer than ~350 units (user,
// 2026-11-22). tools/debug/track-density.ts measures both: the plain-road share, the gaps between
// the obstacle groups, the dirt stretches, the straights and the bots' laps.
// Each has one shortcut road (BR-TRACKS, ClickUp 123jpnbfghe; PLAN-BRANCH.md user decisions 1, 2 and 6):
// shorter than the main road, risky, a clean run on it about 1.5-2.5 s a lap quicker, a fall on it dearer
// than that; tools/debug/br-tracks.ts measures both per level and car type.

import type { TrackDef } from "./track";

// A dockside yard, run anticlockwise on the map (mostly left-handers). From the start on the bottom
// left: fast esses onto the long quay straight, where two rows of barrels roll off the quay toward
// the water (three at 110 u/s, then two at 80, 500 apart); the bottom-right corner is a split round
// an island, its inside lane (the left, 247 units shorter) flooded at the apex with a lightning cell
// in the pool, its outside lane dry; plain esses up the right side and round the top-right corner;
// on the top straight a parked ramp truck right of centre with an air cell over its flight (a jump in
// the band at 272 u/s or more takes it); the pier, a finger of road with a right-hand hairpin, plain
// but for a kerb cell on the hairpin's apex; a tyre-mound chicane on the top-left straight; a
// conveyor belt on the left side drifting cars to the left; the bottom-left corner onto the grid.
// The shortcut (BR-TRACKS): a narrow cut across the pier (80 wide, half-width 40, the main road's 64),
// off the right of its down leg at s 10300 and onto the right of its up leg at s 13335: down between the
// legs, a hairpin of its own above the pier's tip, flat at the bottom, with a pit on its inside halfway
// round (u 1068, lat 18, r 20: swing wide or drop in), and back up. 2137 long against the main road's
// 3035; its pit 346 from the main centreline. A recovery point on it before the pit (u 700), and the main
// road's at s 9900, 400 before the fork (a fall on the cut before u 700 goes back there: user decision 6).
// Six control points, no more: buildTrack samples each control segment 16 times, and a hairpin drawn with
// more overfills the bake's list of pieces near a block (client/gfx/world.ts `near`, 64; the main road's
// widen makes every block reach 203 units here): tools/debug/branch-sheet.ts --track slag-harbour.
export const SLAG_HARBOUR: TrackDef = {
  id: "slag-harbour",
  name: "Slag Harbour",
  control: [
    [1800, 3700], [2400, 3650], [2900, 3450], [3400, 3420], [3900, 3580], [4500, 3700], [5200, 3700],
    [5900, 3700], [6400, 3550], [6600, 3100], [6500, 2600], [6250, 2150], [6300, 1650], [6500, 1200], [6300, 700], [5800, 500],
    [5200, 500], [4600, 520], [4150, 700], [4000, 1100], [4000, 1600], [3900, 2050], [3600, 2250], [3300, 2050], [3200, 1600],
    [3200, 1100], [3050, 700], [2600, 520], [2000, 500], [1500, 560], [1100, 900], [900, 1500], [1050, 2100], [900, 2700],
    [900, 3200], [1000, 3550], [1250, 3700],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    // The quay straight: barrels rolling off the quay (toward the right of travel).
    { k: "barrels", s: 2700, n: 3, period: 240, speed: 110 },
    { k: "barrels", s: 3200, n: 2, period: 260, speed: 80 },
    // The bottom-right corner (a left-hander): the flooded short lane and the dry long one.
    { k: "widen", s0: 4250, s1: 5700, left: 60, right: 60 },
    { k: "island", s0: 4420, s1: 5530, lat0: -28, lat1: 28 },
    { k: "water", s0: 4560, s1: 4960, lat0: -124, lat1: -28 },
    { k: "cell", s: 4760, lat: -84 },
    // The top straight: the ramp truck, its band on lat 16..44, and the air cell over its flight.
    { k: "truck", s: 8600, lat: 30, len: 110 },
    { k: "cell", s: 8840, lat: 34, air: true },
    // The pier's hairpin (a right-hander): a cell on the inside kerb at its apex.
    { k: "cell", s: 11830, lat: 58 },
    // The pier's shortcut (BR-TRACKS): the narrow cut with the pit at its hairpin's apex.
    {
      k: "branch", s0: 10300, s1: 13335, side: 1, halfWidth: 40,
      control: [[3820, 1200], [3750, 1620], [3680, 1810], [3520, 1810], [3450, 1620], [3380, 1200]],
      features: [{ k: "hole", s: 1068, lat: 18, r: 20 }],
      recovery: [700],
    },
    // The top-left straight: a tyre-mound chicane, 200 apart.
    { k: "tyres", s: 14250, lat: -30, r: 24 },
    { k: "tyres", s: 14450, lat: 30, r: 24 },
    { k: "tyres", s: 14650, lat: -26, r: 22 },
    // The left side: a conveyor belt across the asphalt.
    { k: "belt", s0: 17230, s1: 17480, lat0: -64, lat1: 64, vx: -70 },
  ],
  recovery: [0, 4000, 8000, 9900, 12600, 16000],
};

// A breaker's yard round a mile of straights, run clockwise on the map (mostly right-handers). The
// start is on the top straight (about 2400 units of plain road to draft on, from the top-left corner
// to the first split); the 90-degree right-hander after it is a split round an island, its inside
// lane (the right, 222 units shorter) a dirt shortcut of 330 units (the truck's lane: the bots' Truck
// takes it, the Sport and the Racer the asphalt); down the right side and left onto a short straight
// with a crusher press over the left two thirds of the road (the right third, 34 of asphalt and the
// verge, stays open); the east lobe, a long right-hand hairpin, plain; the bottom straight (about 2800
// units of plain road to draft on) ends at a chasm jump (220 units, a take-off at ~340 u/s or more)
// with an air cell over it right of centre; the bottom-left corner into the finger, a pit pair on its
// first leg (left, then right), a kerb cell on the inside of its hairpin's apex; up the left side to
// the grid.
// The shortcut (BR-TRACKS): a jump cut across the east lobe (112 wide, half-width 56), off the right of
// the top straight at s 5300, round a right-hander and down the lobe's middle, then a long straight run
// down to the bottom straight with a ramp (u 1510) and a chasm of 140 (u 1590-1730; the bots take off
// at 292 u/s or more there, shared/botdrive.ts takeoffSpeedFor), onto the bottom straight at s 8803.
// 2706 long against the main road's 3503; the chasm 247 from the main centreline. A recovery point 300
// before the ramp (u 1210), and the main road's at s 4900, 400 before the fork (user decision 6). Eight
// control points (see Slag Harbour's: the bake's `near` list).
export const BREAKERS_MILE: TrackDef = {
  id: "breakers-mile",
  name: "Breaker's Mile",
  // THEME-SCHEMA (PLAN-THEMES 2.6): its straights a desert highway, the chasm a canyon; looks only (its sand comes with THEME-TRACKS).
  theme: "desert",
  control: [
    [2100, 800], [2700, 800], [3300, 800], [3900, 800], [4400, 860], [4720, 1120], [4850, 1550], [4850, 2050],
    [5050, 2550], [5500, 2780], [6100, 2850], [6600, 2800], [6950, 3200], [6850, 3800], [6300, 4200], [5600, 4250], [5000, 4250],
    [4400, 4250], [3800, 4250], [3200, 4250], [2500, 4200], [1800, 4000], [1300, 3600], [1150, 3100], [1500, 2900], [2100, 2900],
    [2700, 2900], [3200, 2800], [3400, 2550], [3200, 2320], [2700, 2250], [2100, 2250], [1500, 2250], [1150, 2000], [1050, 1500],
    [1100, 1050], [1500, 800],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    // The first corner (a right-hander): the dirt shortcut in the inside lane.
    { k: "widen", s0: 2000, s1: 3450, left: 60, right: 60 },
    { k: "island", s0: 2160, s1: 3290, lat0: -28, lat1: 28 },
    { k: "dirt", s0: 2560, s1: 2890, lat0: 28, lat1: 124 },
    // The crusher press gate: down 1 s in every 3, the right third open.
    { k: "press", s: 4800, lat0: -108, lat1: 30, period: 180, down: 60 },
    // The east lobe's shortcut (BR-TRACKS): the jump cut.
    {
      k: "branch", s0: 5300, s1: 8803, side: 1, halfWidth: 56,
      control: [[6220, 2920], [6363, 2983], [6506, 3048], [6671, 3326], [6648, 3634], [6370, 3795], [5916, 3964], [5499, 4133]],
      features: [{ k: "ramp", s: 1510, len: 80 }, { k: "gap", s0: 1590, s1: 1730 }],
      recovery: [1210],
    },
    // The chasm at the end of the bottom straight, an air cell over it.
    { k: "ramp", s: 10900, len: 80 },
    { k: "gap", s0: 10980, s1: 11200 },
    { k: "cell", s: 11120, lat: 34, air: true },
    // The finger: the pit pair, then a cell on its hairpin's inside kerb.
    { k: "hole", s: 14450, lat: -30, r: 28 },
    { k: "hole", s: 14750, lat: 30, r: 28 },
    { k: "cell", s: 15905, lat: -58 },
  ],
  recovery: [0, 4900, 5600, 10200, 13950, 17000],
};
