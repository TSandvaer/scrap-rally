// Track geometry: a closed centerline (Catmull-Rom through control points) with a road
// width, a grass verge, and walls, plus track features (ramps, gaps, holes) and recovery
// points placed by distance along the centerline (s). All queries are pure so client and
// server agree.

import { isTheme, themeOf, THEMES, type Theme } from "./theme";

export interface Vec { x: number; y: number }

/**
 * A ramp across the full width between the walls, from s to s + len. Its end (the lip) is
 * at s + len: a grounded car inside the lip zone [end, end + LIP_ZONE) moving forward at
 * MIN_TAKEOFF_SPEED or more takes off (shared/weapons.ts stepRaceCar).
 */
export interface Ramp { k: "ramp"; s: number; len: number }

/**
 * No ground from s0 to s1 across the whole width between the walls: a chasm, or the stretch
 * where this road jumps over another road. A grounded car whose own-section s is inside
 * falls. `scrap` is drawing only: scrap piles fill the gap (they are not solid; falling in
 * means recovery like any gap).
 */
export interface Gap { k: "gap"; s0: number; s1: number; scrap?: boolean }

/**
 * A round pit of radius r centred at distance s along the track, `lat` units sideways from
 * the centerline (+ = right of the direction of travel, as gridSlot). A grounded car whose
 * centre is inside it falls.
 */
export interface Hole { k: "hole"; s: number; lat: number; r: number }

/**
 * A lightning cell (M4-CELLS, PLAN-M4.md 2.5): a speed pickup at distance s, `lat` units sideways
 * (+ = right of travel). A ground cell is taken by a car on the ground; an air cell (air: true)
 * floats over a jump and is taken only by a car high in the air (shared/catchup.ts). Placed where
 * it is a little hard to reach (validateTrack, validateCells): a ground cell on the kerb or in the
 * dirt, an air cell on the arc of a fast take-off, off-centre.
 */
export interface Cell { k: "cell"; s: number; lat: number; air?: boolean }

// ---- M4 surfaces, obstacles and split lanes (M4-SCHEMA, PLAN-M4.md 2.2-2.4, 2.6 B) ----------
// buildTrack places them and validateTrack checks their layout. Water, dirt, belts and tyre mounds
// act (M4-SURF part 1: shared/physics.ts stepCar reads the per-segment buckets below, the bots
// cost their lanes by them, rivets die on mounds); widens and islands act (M4-SURF part 2: the walls
// are per sample, halfOf / wallOf; islands are solid, shared/physics.ts collideIslands; the bots
// pick a lane round each); rolling barrels, crusher presses and parked ramp trucks act (M4-MOVE: solid
// in shared/physics.ts stepCar at the race tick, the truck's ramp band in weapons.ts stepRaceCar, rivets
// die on them, the bots dodge, time and jump them).
// Track coordinates: s along the centerline, lat across it (+ = right of travel, as a hole's).

/** Water (cars aquaplane on it, shared/physics.ts): a rectangle s0..s1 by lat0..lat1; felt inside tractionRect. */
export interface Water { k: "water"; s0: number; s1: number; lat0: number; lat1: number }

/** Dirt (loose ground: the verge's drag and grip by car type): a rectangle s0..s1 by lat0..lat1; felt inside tractionRect. */
export interface Dirt { k: "dirt"; s0: number; s1: number; lat0: number; lat1: number }

/**
 * A conveyor belt (M4-SURF): a rectangle s0..s1 by lat0..lat1 that drifts a car on it across the
 * road at vx units/s (+ = toward the right of travel), a fixed drift each tick. Static.
 */
export interface Belt { k: "belt"; s0: number; s1: number; lat0: number; lat1: number; vx: number }

// ---- theme surfaces (THEME-SCHEMA, PLAN-THEMES.md 2.3, advisor changes 6, 7, 10) ----------------
// One per theme, each only on its own theme's tracks (validateTrack): sand on a desert track, oil
// on a city or a harbour one (HARBOUR-SCHEMA, PLAN-THEMES.md Amendment 1: the harbour has no surface of
// its own), a ford on a jungle one. Shaped like water and dirt: a rectangle s0..s1 by lat0..lat1
// in track coordinates, inside the asphalt; the declared rectangle is what is drawn (the bounds the
// puddle is painted in, as water's: TH-LOOK-2, TH-LOOK-3) and a car feels it inside tractionRect.
// buildTrack places them in their own lists (Track.sand, oil, fords, Track.themeSurfaces / themeAt:
// what the drawing reads) and, THEME-SURF, in Track.surfaces / surfAt with water, dirt and belts: they
// act (shared/physics.ts stepCar: themeDrag, themeGrip, OIL_TURN, a ford's drift) and the bots cost
// them (shared/botdrive.ts laneCost) and aim a ford upstream.

/** Sand (desert): "bogs you, keeps your line" (THEME-SURF). At most SAND_LEN_MAX long, and with the dirt it runs into (LOOSE_JOIN) too. */
export interface Sand { k: "sand"; s0: number; s1: number; lat0: number; lat1: number }

/** An oil slick (city, and harbour: HARBOUR-SCHEMA): "steering goes, brakes stay" (THEME-SURF). At most OIL_LEN_MAX long; a dry lane beside it, or on a straight (water's rule). */
export interface Oil { k: "oil"; s0: number; s1: number; lat0: number; lat1: number }

/**
 * A ford (jungle): a stream across the road that is to drift a car on it across the road at vx
 * units/s (+ = toward the right of travel), as a belt does, and slow it (THEME-SURF): "aim upstream".
 * FORD_LEN_MIN..FORD_LEN_MAX long, FORD_VX_MIN <= |vx| <= FORD_VX_MAX, on a straight, and no solid
 * within FORD_CLEAR past it (nor beside it).
 */
export interface Ford { k: "ford"; s0: number; s1: number; lat0: number; lat1: number; vx: number }

/** A tyre mound (M4-SURF): a static solid circle of radius r (TYRES_R_MIN..TYRES_R_MAX) at s, lat. */
export interface Tyres { k: "tyres"; s: number; lat: number; r: number }

/**
 * Rolling barrels (M4-MOVE): n barrels of radius BARREL_R roll across the road at s, from wall to
 * wall at |speed| units/s (speed > 0: from the left wall to the right one; < 0: from the right to
 * the left). Each runs a cycle of `period` ticks, the k-th one floor(k * period / n) ticks ahead of
 * the first: it crosses, drops into the gutter at the far wall and comes back in at the near wall
 * when its cycle starts again. Where a barrel is is a pure function of the race tick (barrelLat).
 */
export interface Barrels { k: "barrels"; s: number; n: number; period: number; speed: number }

/**
 * A parked ramp truck (M4-MOVE), facing along the track: its body is a solid capsule from s (the
 * rear) to s + len (the front of the cab), centred `lat` units sideways, TRUCK_HALF wide either
 * side. Its ramp band is a narrow ramp TRUCK_BAND either side of `lat`, from the rear up to the lip
 * at the cab (s + len - TRUCK_CAB): a car whose centre is in the band, moving forward at
 * TRUCK_MIN_SPEED or more, rides up and takes off in the band's take-off zone [lip, lip + LIP_ZONE)
 * (truckLipAt: the lateral lip test lipAt does not have). Slower than that, the band is as solid as
 * the rest of the body. The flight is an ordinary jump's (airTicksFor): no longer air time.
 */
export interface Truck { k: "truck"; s: number; lat: number; len: number }

/**
 * A crusher press (M4-MOVE): a gate PRESS_DEPTH long at s across lat0..lat1, on a cycle of `period`
 * ticks of which the last `down` it is down (solid); for the PRESS_WARN_TICKS before it slams its
 * shadow warns. A pure function of the race tick (pressState). No damage.
 */
export interface Press { k: "press"; s: number; lat0: number; lat1: number; period: number; down: number }

/**
 * The road widens (split lanes, PLAN-M4 2.6 B) from s0 to s1: `left` more asphalt on the left and
 * `right` more on the right (the verge and the wall move out with it). The extra width grows from 0
 * at s0 to full at s0 + WIDEN_TAPER and shrinks back to 0 between s1 - WIDEN_TAPER and s1. buildTrack
 * precomputes the per-sample half-widths and walls (Track.halfL, halfR, wallL, wallR).
 */
export interface Widen { k: "widen"; s0: number; s1: number; left: number; right: number }

/**
 * An island (split lanes): a solid band s0..s1 by lat0..lat1 inside a widened road, with a lane of
 * at least LANE_MIN either side; drawn with tyre-stack noses at both ends. s, checkpoints, rd, laps
 * and positions are unchanged: the shorter lane is simply faster.
 */
export interface Island { k: "island"; s0: number; s1: number; lat0: number; lat1: number }

/**
 * An island placed by buildTrack (M4-SURF part 2). Solid for a car on the ground (shared/physics.ts
 * collideIslands): its two long sides are a wall (the same bounce and scrape), each end a nose of
 * tyre stacks that bounces a car as a tyre mound does. A nose's shape is the outline of its drawn
 * stacks (client/gfx/world.ts: two rows of tyres of radius ISLAND_NOSE_ROUND across the island's
 * width, ISLAND_NOSE deep): the box ISLAND_NOSE deep across the island with its corners rounded by
 * ISLAND_NOSE_ROUND, i.e. every point within ISLAND_NOSE_ROUND of its core, the box that much
 * smaller all round. head and tail: the cores' corners in world coordinates (in order round them),
 * the head's at s0 + ISLAND_NOSE_ROUND and s0 + ISLAND_NOSE - ISLAND_NOSE_ROUND, the tail's the same
 * from s1. outL / outR: the narrowest asphalt half-width beside it on the left / the right over
 * s0..s1 (where its lanes end outside). lenL / lenR: the length of the path down the middle of each
 * lane (the shorter lane is faster). surfL / surfR: the surfaces (Track.surfaces) in each lane
 * beside it, for the bots' choice of lane.
 */
export interface PlacedIsland extends Island {
  mid: number;
  head: readonly Vec[];
  tail: readonly Vec[];
  outL: number;
  outR: number;
  lenL: number;
  lenR: number;
  surfL: readonly Surface[];
  surfR: readonly Surface[];
}

/** What a road carries (the main road or a branch): every feature but a branch. */
export type RoadFeature = Ramp | Gap | Hole | Cell | Water | Dirt | Belt | Sand | Oil | Ford | Tyres | Barrels | Truck | Press | Widen | Island;

/**
 * A shortcut road (BR-SCHEMA, PLAN-BRANCH.md 2.1): it leaves the main road at a fork at main s0 and
 * rejoins it at a merge at main s1, running on its own (its own walls) in between. `side` (-1 left,
 * +1 right of travel) is the side of the main road it leaves on. Its centreline is the Catmull-Rom
 * curve through main(s0 - BRANCH_GUIDE), main(s0), `control`, main(s1) and main(s1 + BRANCH_GUIDE):
 * it starts and ends on the main centreline. halfWidth (>= BRANCH_HALF_MIN) is its own asphalt
 * half-width past its mouths (in a mouth it is the main road's, PLAN-BRANCH 2.3). Its features and
 * recovery points are placed in branch distance u (0 at the fork), as a road's in s.
 */
export interface Branch {
  k: "branch";
  s0: number;
  s1: number;
  side: number;
  control: [number, number][];
  halfWidth: number;
  features?: RoadFeature[];
  recovery?: number[];
}

export type Feature = RoadFeature | Branch;

export interface TrackDef {
  /** Registry id (e.g. "rust-bowl"): the key in shared/tracks.ts and on the wire. */
  id: string;
  name: string;
  control: [number, number][];
  halfWidth: number; // asphalt half-width
  verge: number; // grass band between asphalt edge and wall
  /** Ramps, gaps and holes. None = a plain track. */
  features?: Feature[];
  /** Recovery points (s): one before every hazard, plus the start line. None = [0]. */
  recovery?: number[];
  /**
   * THEME-SCHEMA (PLAN-THEMES 2.1): the track's surroundings, fixed per track. None = the scrapyard
   * (shared/theme.ts themeOf); the three original tracks never get one. buildTrack ignores it (a
   * branch's road carries its track's); validateTrack refuses an unknown one and allows each theme
   * surface only on its own theme's tracks.
   */
  theme?: Theme;
}

/** A hole with its centre in world coordinates (computed once by buildTrack). */
export interface PlacedHole extends Hole { x: number; y: number }

/**
 * A cell with its centre in world coordinates (buildTrack). Track.cells' order is the snapshot's (cells[i]).
 * BR-SCHEMA: the main track's cells are its own, then every branch's (branch order, each by u): a branch
 * cell there has `road` (its road, >= 1), s in branch distance u and seg its global segment; a road's
 * own cells have no `road` (and seg on that road).
 */
export interface PlacedCell extends Cell { x: number; y: number; seg: number; road?: number }

/** A tyre mound with its centre in world coordinates (buildTrack). */
export interface PlacedTyres extends Tyres { x: number; y: number; seg: number }

/**
 * Rolling barrels placed by buildTrack: the centerline point at s, its heading h and the unit normal
 * (nx, ny) to the right of travel (a barrel at lateral offset v is at x + nx * v, y + ny * v); lat0..lat1
 * is the range a barrel's centre rolls (wall to wall, BARREL_R off each wall); offsets[k] is the k-th
 * barrel's head start in ticks; roll the ticks a crossing takes.
 */
export interface PlacedBarrels extends Barrels {
  x: number;
  y: number;
  h: number;
  nx: number;
  ny: number;
  seg: number;
  lat0: number;
  lat1: number;
  offsets: number[];
  roll: number;
}

/**
 * A ramp truck placed by buildTrack: its body capsule's axis from (x0, y0) (rear) to (x1, y1)
 * (front), radius TRUCK_HALF, so the body covers s..s + len; the ramp band's lateral range
 * band0..band1 and its lip (s of the take-off, at the cab).
 */
export interface PlacedTruck extends Truck {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  lip: number;
  band0: number;
  band1: number;
}

/** A crusher press placed by buildTrack: the centerline point at s, its heading and right normal. */
export interface PlacedPress extends Press { x: number; y: number; h: number; nx: number; ny: number; seg: number }

/**
 * Where a branch's corridor and the main road's part (BR-SCHEMA, PLAN-BRANCH 2.3): the point of the
 * branch's centreline (at branch distance u) that is first 2 * the mouth's wall (the main road's) from
 * the main centreline, at the fork walking from it, at the merge walking back from it. s: the main s
 * of that point (mapS there); (x, y): the gore's nose, half-way between the two centrelines there.
 * Between the fork and the gore (the mouth) the branch has the main road's width; past it, it tapers
 * to its own over WIDEN_TAPER. angle: the two centrelines' headings there (radians, >= 0). The nose
 * is a tyre stack of radius GORE_NOSE_R, in both roads' tyre buckets (one PlacedTyres per road, in its
 * own coordinates: noseMain on the main road, noseBranch on the branch; never in a road's tyres list).
 */
export interface PlacedGore {
  u: number;
  s: number;
  x: number;
  y: number;
  angle: number;
  noseMain: PlacedTyres;
  noseBranch: PlacedTyres;
}

/**
 * A branch as buildTrack places it (BR-SCHEMA, PLAN-BRANCH 2.1). road: the branch as an open road with
 * the Track shape (its own pts, cum, length, per-sample half-widths and walls, features, buckets and
 * recovery points; road.roadNo = its road number, its index in Track.branches plus 1). base: its first
 * global segment (the main road has 0..n-1; this branch base..base + segs - 1, segs = road.pts.length - 1).
 * mapS[i]: the main s for branch sample i (a projection onto the main road inside each mouth, linear
 * between the two gores; strictly increasing, validated). A gore is null when the corridors never part
 * (validateTrack says so; mapS is then linear from s0 to s1).
 */
export interface PlacedBranch {
  road: Track;
  base: number;
  s0: number;
  s1: number;
  side: number;
  forkGore: PlacedGore | null;
  mergeGore: PlacedGore | null;
  mapS: number[];
}

export interface Track {
  def: TrackDef;
  pts: Vec[]; // sampled centerline, closed (pts[n-1] connects back to pts[0])
  cum: number[]; // cumulative length at each sample, cum[n] = length
  length: number;
  wall: number; // distance from centerline to wall
  checkpoints: number[]; // distances along the track that must be crossed in order
  ramps: Ramp[]; // sorted by s
  gaps: Gap[]; // sorted by s0
  holes: PlacedHole[]; // sorted by s
  cells: PlacedCell[]; // sorted by s (then lat): the index is the snapshot's
  recovery: number[]; // sorted, never empty
  // M4-SCHEMA: per sample i (at s = cum[i]), the asphalt half-width and the wall's distance from
  // the centerline on the left (L) and the right (R), widens included. Without a widen they equal
  // def.halfWidth and wall everywhere.
  halfL: number[];
  halfR: number[];
  wallL: number[];
  wallR: number[];
  // M4-SCHEMA features, each sorted by s (s0). Water, dirt, belts, tyre mounds, widens and islands act
  // (M4-SURF); barrels, trucks and presses act (M4-MOVE).
  water: Water[];
  dirt: Dirt[];
  belts: Belt[];
  tyres: PlacedTyres[];
  barrels: PlacedBarrels[];
  trucks: PlacedTruck[];
  presses: PlacedPress[];
  widens: Widen[];
  islands: PlacedIsland[];
  // THEME-SCHEMA: the theme surfaces as declared (each its draw rectangle), sorted by s0. THEME-SURF:
  // they act, felt from surfaces / surfAt below (themeSurfaces / themeAt hold the same objects).
  sand: Sand[];
  oil: Oil[];
  fords: Ford[];
  // M4-SURF: what a car feels, in per-segment buckets built once (no scan of every feature per tick).
  /** Water, dirt, belts and (THEME-SURF) sand, oil and fords where a car feels them (Surface), sorted by s0. */
  surfaces: Surface[];
  /** Per segment i: the surfaces whose s range overlaps cum[i]..cum[i + 1] (a car whose nearest segment is i). */
  surfAt: readonly Surface[][];
  /** Per segment i: the first index in surfaces whose s1 > cum[i] (the bots look ahead from there). */
  surfFrom: number[];
  /**
   * THEME-SCHEMA: the theme surfaces where a car feels them (Surface: kind SURF_SAND, SURF_OIL or
   * SURF_FORD, the traction rectangle, a ford's vx), sorted by s0, and per segment i the ones whose s
   * range overlaps cum[i]..cum[i + 1] (as surfAt). THEME-SURF: the same objects are in surfaces / surfAt,
   * which physics and the bots read; these lists are the drawing's.
   */
  themeSurfaces: Surface[];
  themeAt: readonly Surface[][];
  /** Per segment i: the tyre mounds a car or a rivet whose nearest segment is i can touch. */
  tyresAt: readonly PlacedTyres[][];
  /** Per segment i: the first index in tyres whose far edge (s + r) is less than TYRES_BEHIND behind cum[i]. */
  tyresFrom: number[];
  // M4-SURF part 2: split lanes, per segment.
  /** Per segment i: the islands a car or a rivet whose nearest segment is i can touch (ISLAND_BUCKET_REACH). */
  islandsAt: readonly PlacedIsland[][];
  /** Per segment i: the first index in islands whose tail (s1) is less than ISLAND_BEHIND behind cum[i] (the bots look ahead from there). */
  islandsFrom: number[];
  // M4-MOVE: what moves (barrels, presses) and the parked trucks, per segment (by s: on their own
  // section, as the islands; MOVER_BUCKET_REACH round their s range).
  /** Per segment i: the rows of barrels a car or a rivet whose nearest segment is i can touch. */
  barrelsAt: readonly PlacedBarrels[][];
  /** Per segment i: the presses a car or a rivet whose nearest segment is i can touch. */
  pressesAt: readonly PlacedPress[][];
  /** Per segment i: the trucks a car or a rivet whose nearest segment is i can touch. */
  trucksAt: readonly PlacedTruck[][];
  /** Per segment i: the first index in barrels / presses / trucks whose far edge is less than MOVER_BEHIND behind cum[i] (the bots look ahead from there). */
  barrelsFrom: number[];
  pressesFrom: number[];
  trucksFrom: number[];
  // BR-SCHEMA (PLAN-BRANCH): shortcut roads.
  /**
   * 0 on a track (its main road: closed, pts[n-1] connects back to pts[0], cum[n] = length); r >= 1 on
   * the open road of its branch r - 1 (PlacedBranch.road): its centreline runs from pts[0] to pts[m-1]
   * and stops (m - 1 segments, cum[m-1] = length, per-segment lists m - 1 long); s never wraps on it.
   */
  roadNo: number;
  /** The track's branches (empty on a branch's road; Slag Harbour and Breaker's Mile have one each, BR-TRACKS). */
  branches: PlacedBranch[];
  /**
   * Per global segment (the main road's, then each branch's from its base): the global segment of
   * the other road to search too, when this segment's query window (LOCAL_WINDOW either side, clamped
   * on a branch) touches a mouth; -1 when it touches none. Empty when there are no branches.
   */
  mouthAt: number[];
}

/** What a surface does (Surface.kind). */
export const SURF_WATER = 1;
export const SURF_DIRT = 2;
export const SURF_BELT = 3;
/** THEME-SCHEMA's theme surfaces (Track.themeSurfaces, and from THEME-SURF in Track.surfaces: they act, shared/physics.ts). */
export const SURF_SAND = 4;
export const SURF_OIL = 5;
export const SURF_FORD = 6;

/**
 * A surface as a car feels it (M4-SURF): a water pool or a dirt patch by its traction rectangle
 * (tractionRect: the declared one less PUDDLE_TRACTION_INSET), a belt by its declared rectangle; a
 * car whose centre is strictly inside (s0 < s < s1, lat0 < lat < lat1) is on it. vx: a belt's drift
 * (units/s, + = toward the right of travel), 0 for water and dirt. THEME-SCHEMA: sand, oil and a
 * ford by their traction rectangles (a ford's vx its drift), in Track.themeSurfaces and (THEME-SURF) Track.surfaces.
 */
export interface Surface {
  kind: number;
  s0: number;
  s1: number;
  lat0: number;
  lat1: number;
  vx: number;
}

export interface TrackQuery {
  dist: number; // distance from centerline
  nx: number; // unit normal pointing from centerline toward the point
  ny: number;
  s: number; // distance along the track of the nearest centerline point
  seg: number; // nearest segment index
  side: number; // M4-SCHEMA: +1 right of travel (or on the centerline), -1 left
  readonly lat: number; // signed lateral offset (M4-SCHEMA): +dist right of travel, -dist left (|lat| = dist)
  /**
   * BR-SCHEMA: the road the query is on (the queried Track's roadNo: 0 = the main road, b + 1 =
   * branch b). s and seg are on that road (roadOf(track, q.road)); globalSeg turns seg into a hint.
   */
  road: number;
}

/**
 * nearest()'s result. The side is a small integer (stored unboxed) and lat a getter from it, so the
 * signed lateral adds one tagged slot per query, not a heap number (M4-SCHEMA review: 24 -> 8 bytes).
 * The road (BR-SCHEMA) is a small integer too.
 */
class Query implements TrackQuery {
  declare dist: number;
  declare nx: number;
  declare ny: number;
  declare s: number;
  declare seg: number;
  declare side: number;
  declare road: number;
  constructor(dist: number, nx: number, ny: number, s: number, seg: number, side: number, road: number) {
    this.dist = dist;
    this.nx = nx;
    this.ny = ny;
    this.s = s;
    this.seg = seg;
    this.side = side;
    this.road = road;
  }
  get lat(): number {
    return this.side < 0 ? -this.dist : this.dist;
  }
}

// Original layout: long left straight, a sweeping top section, a chicane in the
// middle, and a hairpin loop at the bottom right. No ramps, gaps or holes.
export const RUST_BOWL: TrackDef = {
  id: "rust-bowl",
  name: "Rust Bowl",
  control: [
    [400, 1700], [400, 1000], [520, 560], [950, 380], [1450, 620], [1850, 420],
    [2450, 420], [2780, 820], [2640, 1320], [2120, 1450], [1720, 1260], [1380, 1480],
    [1480, 1940], [2180, 2020], [2560, 2320], [2240, 2700], [1240, 2700], [620, 2440],
  ],
  halfWidth: 64,
  verge: 44,
  // Lightning cells (M4-CELLS) on the kerbs: the inside of the left-hander and of the right-hander
  // at their apexes (cut the corner tight), and the left kerb of the back straight.
  features: [
    { k: "cell", s: 2200, lat: -58 },
    { k: "cell", s: 7450, lat: 58 },
    { k: "cell", s: 8600, lat: -58 },
  ],
};

// Original layout: a scrapyard run. A long start straight, then past the first bend a straight
// down the right side that jumps two scrap piles blocking the road, a sweeping right-hander
// with three pits to steer between, a chasm jump on the bottom straight, and a twisty climb
// back to the start. Recovery points before each hazard.
export const CRUSHER_RUN: TrackDef = {
  id: "crusher-run",
  name: "Crusher Run",
  control: [
    [900, 500], [1400, 500], [1900, 500], [2400, 500], [2900, 500], [3350, 560], [3700, 800],
    [3850, 1150], [3850, 1500], [3850, 1850], [3850, 2200], [3850, 2550], [3700, 2900],
    [3350, 3080], [2900, 3130], [2400, 3130], [1900, 3130], [1400, 3130], [950, 3080],
    [650, 2830], [700, 2400], [450, 2050], [600, 1700], [750, 1350], [450, 1100], [300, 750],
    [500, 500],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    // Scrap piles across the right-side straight: a ramp onto each.
    { k: "ramp", s: 3420, len: 80 },
    { k: "gap", s0: 3500, s1: 3630, scrap: true },
    { k: "ramp", s: 4060, len: 80 },
    { k: "gap", s0: 4140, s1: 4280, scrap: true },
    // Three pits, 300 apart: one mid-road, then one on each side (r <= 38: the renderer's cull).
    { k: "hole", s: 5250, lat: 0, r: 30 },
    { k: "hole", s: 5550, lat: -34, r: 26 },
    { k: "hole", s: 5850, lat: 34, r: 26 },
    // The chasm: 220 units, a take-off at ~340 u/s or more.
    { k: "ramp", s: 6650, len: 80 },
    { k: "gap", s0: 6730, s1: 6950 },
    // A lightning cell (M4-CELLS) over the chasm, right of centre: a jump on that side takes it.
    { k: "cell", s: 6900, lat: 34, air: true },
  ],
  recovery: [0, 3150, 3880, 4800, 6150],
};

// Original layout: a figure-eight. Two diagonal straights cross at right angles at
// (2000, 1400); the second one (s ~ 7893 there) is the upper pass: a ramp and a gap of
// +-118 around the crossing jump it over the first one (s ~ 2818). A clockwise lobe on the
// right with a pit, a counter-clockwise lobe on the left with the start straight.
export const OVERPASS_KNOT: TrackDef = {
  id: "overpass-knot",
  name: "Overpass Knot",
  control: [
    [300, 1150], [300, 1450], [330, 1750], [520, 2060], [880, 2230],
    // the lower pass, heading up and to the right
    [1258, 2142], [1505, 1895], [1753, 1647], [2000, 1400], [2247, 1153], [2495, 905], [2742, 658],
    [3120, 520], [3500, 640], [3700, 1000], [3680, 1450], [3480, 1850], [3120, 2110],
    // the upper pass, heading up and to the left
    [2742, 2142], [2495, 1895], [2247, 1647], [2000, 1400], [1753, 1153], [1505, 905], [1258, 658],
    [880, 520], [520, 600], [330, 850],
  ],
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "hole", s: 5300, lat: 0, r: 32 },
    // Over the crossing: a take-off at ~350 u/s or more clears the 236-unit gap.
    { k: "ramp", s: 7695, len: 80 },
    { k: "gap", s0: 7775, s1: 8011 },
    // A lightning cell (M4-CELLS) over the crossing, left of centre: a jump on that side takes it.
    { k: "cell", s: 7950, lat: -34, air: true },
  ],
  recovery: [0, 4950, 7193],
};

const SAMPLES_PER_SEGMENT = 16;
export const LOCAL_WINDOW = 12; // segments searched either side of the hint

/** Length of the take-off zone past a ramp's end (a car moves at most ~7.2 units a tick). */
export const LIP_ZONE = 12;
/** No feature may lie this far behind the start line (the starting grid). */
export const GRID_ZONE = 400;
/**
 * ... or on the start straight past it, measured from the track (startStraightEnd): from the
 * line until the road's heading turns more than START_STRAIGHT_TOLERANCE away from the
 * heading at the line, and never shorter than START_ZONE (a start just out of a bend still
 * keeps its first stretch clear).
 */
export const START_ZONE = 300;
export const START_STRAIGHT_TOLERANCE = 0.05; // radians (~3 degrees)
/** Near sections must be more than 2 * LOCAL_WINDOW + this many segment indices apart. */
export const SECTION_INDEX_MARGIN = 4;

// M4-SCHEMA constants. No runtime import of physics, weapons or protocol here (they import this
// file); sim-test checks the copies against the originals.
/** Ticks per second (physics TICK_HZ): the moving obstacles' speeds are per second, rt is in ticks. */
const TICKS_PER_S = 60;
/** Half a car's length and width (physics CAR_LENGTH / 2, CAR_WIDTH / 2). */
const CAR_HALF_LEN = 15;
const CAR_HALF_WID = 8;
/** Grid slots gridSlot places (protocol MAX_PLAYERS). */
export const GRID_SLOTS = 6;
/** A tyre mound's radius range. */
export const TYRES_R_MIN = 18;
export const TYRES_R_MAX = 30;
/** A rolling barrel's radius, and the bounds on a row of them. */
export const BARREL_R = 9;
export const BARRELS_MAX = 6;
export const BARREL_SPEED_MIN = 40;
export const BARREL_SPEED_MAX = 240;
/** The ramp truck: its body's half-width, its ramp band's half-width, its cab's length. */
export const TRUCK_HALF = 20;
export const TRUCK_BAND = 14;
export const TRUCK_CAB = 30;
export const TRUCK_LEN_MIN = 80;
export const TRUCK_LEN_MAX = 160;
/** Below this forward speed the truck's ramp band is solid (weapons MIN_TAKEOFF_SPEED). */
export const TRUCK_MIN_SPEED = 220;
/** The crusher press: its depth along the track, and how long its shadow warns before it slams. */
export const PRESS_DEPTH = 24;
export const PRESS_WARN_TICKS = 30; // 0.5 s
/** pressState's values. */
export const PRESS_UP = 0;
export const PRESS_WARNING = 1;
export const PRESS_DOWN = 2;
/** A conveyor belt's largest drift (units/s). */
export const BELT_MAX = 200;
/** A widen's taper at each end (units along the track). */
export const WIDEN_TAPER = 120;
/** A split lane's narrowest width (asphalt edge to island). */
export const LANE_MIN = 72;
/**
 * An island's nose: the tyre stacks at either end, this deep along the track (client/gfx/world.ts
 * NOSE, which draws them; sim-test checks the two). An island is at least this wide and twice as long.
 */
export const ISLAND_NOSE = 26;
/** A nose's tyre stacks' radius (client/gfx/world.ts TYRE): its outline's corners are rounded by it. */
export const ISLAND_NOSE_ROUND = 6.5;
/** Solids keep at least this far from recovery points and from the grid's slots. */
export const SOLID_CLEAR = 40;
/** A pool in a bend leaves a dry lane at least this wide... */
export const DRY_LANE_MIN = 48;
/** ... unless the road turns less than this (radians) over the pool's length: it lies on a straight. */
export const POOL_STRAIGHT_TOLERANCE = 0.05;
/** A belt is at least this long (M4-WORLD re-check finding 1: a shorter one's arrows reach past its end in a bend). */
export const BELT_LEN_MIN = 48;
/**
 * M4-MOVE: a barrel row or a press keeps this far along the track (edge to edge in s) from every
 * other solid (a press: but an island beside it): two SOLID_CLEAR, room for a car (31 long) pushed
 * along the road out of it to stand clear of both, so a squeeze is only ever against a wall.
 */
export const MOVER_CLEAR = 2 * SOLID_CLEAR;
/** M4-MOVE: a press's side reaches the wall (or an island beside it) or leaves at least this much road (a car, 16 wide, and room). */
export const PRESS_SIDE_GAP = 24;
/**
 * M4-MOVE review F4: the same for a truck's body. 24 = a car's width (16) and 8: the bots' lane round a
 * truck keeps its centre TRUCK_HALF + 16 off the truck's axis, which a 24 gap leaves inside the wall's
 * limit; narrower gaps measured 2026-11-22 (review probe): 6-10 a dead end, 14 a squeeze that leaves the
 * car 3.1 into the body, 18 clean for a car but not for the bots' lane.
 */
export const TRUCK_SIDE_GAP = 24;

// BR-SCHEMA constants (PLAN-BRANCH 2.1, 2.3, 2.8, advisor changes 1 and 7).
/** A branch's curve runs through the main centreline this far before its fork and past its merge (its tangents there). */
export const BRANCH_GUIDE = 100;
/** A branch's narrowest asphalt half-width (72 wide: LANE_MIN). */
export const BRANCH_HALF_MIN = 36;
/** The largest angle between the two centrelines at a gore (degrees). */
export const GORE_ANGLE_MAX = 35;
/** The longest mouth, fork to gore (or gore to merge), along either road. */
export const MOUTH_LEN_MAX = 600;
/** Plain road kept past every gore, on both roads: no feature there (bots' look-ahead never crosses a mouth). */
export const MOUTH_CLEAR = 300;
/**
 * Outside the mouths and the gores' noses, the corridors (centreline +- wall) of two roads keep at
 * least this far apart: two cars at facing walls are then >= 56 apart, past a slipstream's reach
 * (at most 48: 22 + 0.1 x 180 + 8, shared/catchup.ts), so nobody drafts through a wall.
 */
export const BRANCH_SEP = 40;
/** The tyre-stack nose at each gore: its radius (in the tyre mounds' range). */
export const GORE_NOSE_R = 24;

// THEME-SCHEMA constants (PLAN-THEMES 2.3, advisor change 6; the user's mud rule, PLAN-M4.md "Mud length").
/** A sand patch is at most this long (the user's rule for mud: no stretch longer than ~350 units). */
export const SAND_LEN_MAX = 350;
/**
 * ... and so is a stretch of loose ground with sand in it: sand and dirt patches (any lat) whose s
 * ranges overlap or lie less than LOOSE_JOIN apart are one stretch, at most SAND_LEN_MAX from the
 * first one's s0 to the last one's s1. LOOSE_JOIN: a quarter of a second of firm road at 400 u/s, no
 * breather (the user's 700-unit lane was "too long"; two patches end to end are one long one).
 */
export const LOOSE_JOIN = 100;
/** An oil slick is at most this long. */
export const OIL_LEN_MAX = 200;
/** A ford's length range, and its drift's (|vx|, units/s). */
export const FORD_LEN_MIN = 40;
export const FORD_LEN_MAX = 160;
export const FORD_VX_MIN = 20;
export const FORD_VX_MAX = 100;
/** No solid lies within this far past a ford (along the track, edge to edge, across the whole road), nor beside it: the drift carries a car out of it sideways. */
export const FORD_CLEAR = 80;
/**
 * The themes whose tracks may carry each theme surface (validateTrack's gating, advisor change 10):
 * sand and a ford one theme each; oil a city or a harbour track (HARBOUR-SCHEMA, PLAN-THEMES.md
 * Amendment 1, amending user decision 3).
 */
export const THEME_OF_SURFACE: Readonly<Record<"sand" | "oil" | "ford", readonly Theme[]>> = { sand: ["desert"], oil: ["city", "harbour"], ford: ["jungle"] };

// ---- the traction area of a puddle (M4-WORLD; moved here from client/gfx/puddle-shape.ts by M4-SURF, unchanged) ----
// User decisions 2026-11-21: "dirt and water puddles should not be square, it should read as a
// puddle", and "the traction square" is to be made smaller so that it fits inside the puddle.
// A water pool and a dirt patch are rectangles in track coordinates (Water, Dirt: s0..s1 along the
// road, lat0..lat1 across it). Two things are made of that rectangle:
// - What is drawn: a puddle inside the rectangle, which is its bounds (client/gfx/world.ts).
// - What a car feels (where it aquaplanes, where the ground is loose): the rectangle less
//   PUDDLE_TRACTION_INSET on every side, tractionRect below. A plain rectangle test.
// The inset is chosen with the outline so that the whole traction rectangle lies inside the drawn
// puddle, on every track, at every point (tools/debug/puddle-probe.ts holds the baked tiles
// against it): a car is never slowed or sent sliding by ground that does not show it.

/** A puddle's declared rectangle: a water pool's or a dirt patch's, in track coordinates (world units). */
export type PuddleRect = Pick<Water | Dirt | Sand | Oil | Ford, "s0" | "s1" | "lat0" | "lat1">;

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

/**
 * A tyre mound goes in the bucket of every segment whose corridor piece (wall to wall) comes within
 * its radius plus this: a car capsule's reach from its centre (physics CAPSULE_HALF + CAPSULE_R =
 * 15.5) plus a tick's travel, and a rivet's swept tick (~24 units at 900 + 537 u/s) plus its radius.
 */
const TYRES_BUCKET_REACH = 30;
/** The bots keep a tyre mound in view until it is this far behind the car (as a hole: botdrive's lane search). */
const TYRES_BEHIND = 40;
/**
 * An island goes in the bucket of every segment within this of its s range: a car capsule's reach
 * from its centre (15.5) plus a tick's travel, and a rivet's swept tick (~24 units) plus its radius.
 */
const ISLAND_BUCKET_REACH = 30;
/** The bots keep an island in view until it is this far behind the car (botdrive's split lanes). */
const ISLAND_BEHIND = 40;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function buildTrack(def: TrackDef): Track {
  const c = def.control;
  const n = c.length;
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = c[(i - 1 + n) % n], p1 = c[i], p2 = c[(i + 1) % n], p3 = c[(i + 2) % n];
    for (let k = 0; k < SAMPLES_PER_SEGMENT; k++) {
      const t = k / SAMPLES_PER_SEGMENT;
      pts.push({ x: catmull(p0[0], p1[0], p2[0], p3[0], t), y: catmull(p0[1], p1[1], p2[1], p3[1], t) });
    }
  }
  const cum: number[] = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = cum[pts.length];
  const track = newRoad(def, pts, cum, length, 0);
  track.checkpoints = [0.25, 0.5, 0.75].map((f) => f * length);
  const features = def.features ?? [];
  placeFeatures(track, features, def.recovery?.length ? def.recovery : [0], []);
  const branches = features.filter((f): f is Branch => f.k === "branch");
  if (branches.length > 0) buildBranches(track, branches);
  return track;
}

/** A road with its centreline and nothing on it yet (buildTrack, buildBranch). */
function newRoad(def: TrackDef, pts: Vec[], cum: number[], length: number, roadNo: number): Track {
  return {
    def,
    pts,
    cum,
    length,
    wall: def.halfWidth + def.verge,
    checkpoints: [],
    ramps: [],
    gaps: [],
    holes: [],
    cells: [],
    recovery: [],
    halfL: [],
    halfR: [],
    wallL: [],
    wallR: [],
    water: [],
    dirt: [],
    belts: [],
    tyres: [],
    barrels: [],
    trucks: [],
    presses: [],
    widens: [],
    islands: [],
    sand: [],
    oil: [],
    fords: [],
    surfaces: [],
    surfAt: [],
    surfFrom: [],
    themeSurfaces: [],
    themeAt: [],
    tyresAt: [],
    tyresFrom: [],
    islandsAt: [],
    islandsFrom: [],
    barrelsAt: [],
    pressesAt: [],
    trucksAt: [],
    barrelsFrom: [],
    pressesFrom: [],
    trucksFrom: [],
    roadNo,
    branches: [],
    mouthAt: [],
  };
}

/**
 * A road's features, per-sample walls, recovery points and buckets (buildTrack's, unchanged for the
 * main road; BR-SCHEMA: also a branch's road, whose mouths come in as `mouths`, widens of their own).
 */
function placeFeatures(track: Track, features: readonly Feature[], rec: readonly number[], mouths: readonly Widen[]): void {
  const { def, pts, cum } = track;
  // The widens first: the per-sample walls, and the barrels' wall-to-wall run, depend on them.
  for (const f of features) if (f.k === "widen") track.widens.push({ ...f });
  for (const w of mouths) track.widens.push(w);
  track.widens.sort((a, b) => a.s0 - b.s0);
  for (let i = 0; i < pts.length; i++) {
    const hl = halfAt(track, cum[i], -1), hr = halfAt(track, cum[i], 1);
    track.halfL.push(hl);
    track.halfR.push(hr);
    track.wallL.push(hl + def.verge);
    track.wallR.push(hr + def.verge);
  }
  for (const f of features) {
    switch (f.k) {
      case "ramp":
        track.ramps.push({ ...f });
        break;
      case "gap":
        track.gaps.push({ ...f });
        break;
      case "hole":
      case "cell": {
        const p = pointAt(track, f.s);
        const at = { x: p.x - Math.sin(p.h) * f.lat, y: p.y + Math.cos(p.h) * f.lat };
        if (f.k === "hole") track.holes.push({ ...f, ...at });
        else track.cells.push({ ...f, ...at, seg: p.seg });
        break;
      }
      case "water":
        track.water.push({ ...f });
        break;
      case "dirt":
        track.dirt.push({ ...f });
        break;
      case "belt":
        track.belts.push({ ...f });
        break;
      case "sand":
        track.sand.push({ ...f });
        break;
      case "oil":
        track.oil.push({ ...f });
        break;
      case "ford":
        track.fords.push({ ...f });
        break;
      case "tyres": {
        const p = trackPoint(track, f.s, f.lat);
        track.tyres.push({ ...f, x: p.x, y: p.y, seg: p.seg });
        break;
      }
      case "barrels": {
        const p = pointAt(track, f.s);
        const lat0 = -wallAt(track, f.s, -1) + BARREL_R, lat1 = wallAt(track, f.s, 1) - BARREL_R;
        const offsets: number[] = [];
        for (let k = 0; k < f.n; k++) offsets.push(Math.floor((k * f.period) / f.n));
        const roll = Math.abs(f.speed) > 0 ? ((lat1 - lat0) / Math.abs(f.speed)) * TICKS_PER_S : Infinity;
        track.barrels.push({ ...f, x: p.x, y: p.y, h: p.h, nx: -Math.sin(p.h), ny: Math.cos(p.h), seg: p.seg, lat0, lat1, offsets, roll });
        break;
      }
      case "truck": {
        // The body's axis: TRUCK_HALF in from either end, so the capsule covers s..s + len.
        const a = trackPoint(track, f.s + TRUCK_HALF, f.lat), b = trackPoint(track, f.s + f.len - TRUCK_HALF, f.lat);
        track.trucks.push({ ...f, x0: a.x, y0: a.y, x1: b.x, y1: b.y, lip: f.s + f.len - TRUCK_CAB, band0: f.lat - TRUCK_BAND, band1: f.lat + TRUCK_BAND });
        break;
      }
      case "press": {
        const p = pointAt(track, f.s);
        track.presses.push({ ...f, x: p.x, y: p.y, h: p.h, nx: -Math.sin(p.h), ny: Math.cos(p.h), seg: p.seg });
        break;
      }
      case "widen":
        break; // above
      case "island":
        track.islands.push(placeIsland(track, f));
        break;
      case "branch":
        break; // buildBranches, once the main road is built
    }
  }
  track.ramps.sort((a, b) => a.s - b.s);
  track.gaps.sort((a, b) => a.s0 - b.s0);
  track.holes.sort((a, b) => a.s - b.s);
  track.cells.sort((a, b) => a.s - b.s || a.lat - b.lat);
  track.water.sort((a, b) => a.s0 - b.s0);
  track.dirt.sort((a, b) => a.s0 - b.s0);
  track.belts.sort((a, b) => a.s0 - b.s0);
  track.sand.sort((a, b) => a.s0 - b.s0);
  track.oil.sort((a, b) => a.s0 - b.s0);
  track.fords.sort((a, b) => a.s0 - b.s0);
  track.tyres.sort((a, b) => a.s - b.s);
  track.barrels.sort((a, b) => a.s - b.s);
  track.trucks.sort((a, b) => a.s - b.s);
  track.presses.sort((a, b) => a.s - b.s);
  track.islands.sort((a, b) => a.s0 - b.s0);
  track.recovery = rec.map((r) => wrapS(track, r)).sort((a, b) => a - b);
  buildBuckets(track);
}

const NO_SURFACES: readonly Surface[] = Object.freeze([]) as readonly Surface[];
const NO_TYRES: readonly PlacedTyres[] = Object.freeze([]) as readonly PlacedTyres[];
const NO_ISLANDS: readonly PlacedIsland[] = Object.freeze([]) as readonly PlacedIsland[];
const NO_BARRELS: readonly PlacedBarrels[] = Object.freeze([]) as readonly PlacedBarrels[];
const NO_PRESSES: readonly PlacedPress[] = Object.freeze([]) as readonly PlacedPress[];
const NO_TRUCKS: readonly PlacedTruck[] = Object.freeze([]) as readonly PlacedTruck[];

/**
 * An island as buildTrack places it (the widens are in already): its noses' axes, how far out its
 * lanes end, and how long the middle of each lane is. Its lanes' surfaces come with the buckets.
 */
function placeIsland(track: Track, f: Island): PlacedIsland {
  const r = ISLAND_NOSE_ROUND;
  // A nose's core: from s (its end of the island) inward to s + dir * (ISLAND_NOSE - 2r), across lat0 + r .. lat1 - r.
  const core = (s: number, dir: number): Vec[] => {
    const a = s + dir * r, b = s + dir * (ISLAND_NOSE - r);
    return [trackPoint(track, a, f.lat0 + r), trackPoint(track, a, f.lat1 - r), trackPoint(track, b, f.lat1 - r), trackPoint(track, b, f.lat0 + r)].map((p) => ({ x: p.x, y: p.y }));
  };
  const at = samplesIn(track, f.s0, f.s1);
  // The asphalt's edge as drawn (halfOn on the segment each s is on).
  const half = (s: number, side: number) => halfOn(track, pointAt(track, s).seg, s, side);
  let outL = Infinity, outR = Infinity;
  for (const s of at) {
    outL = Math.min(outL, half(s, -1));
    outR = Math.min(outR, half(s, 1));
  }
  // The middle of each lane (between the asphalt's edge and the island) as a polyline through the samples.
  const laneLen = (side: number) => {
    let len = 0, px = 0, py = 0;
    at.forEach((s, k) => {
      const lat = side < 0 ? (f.lat0 - half(s, -1)) / 2 : (f.lat1 + half(s, 1)) / 2;
      const q = trackPoint(track, s, lat);
      if (k > 0) len += Math.hypot(q.x - px, q.y - py);
      px = q.x;
      py = q.y;
    });
    return len;
  };
  return {
    ...f, mid: (f.lat0 + f.lat1) / 2, head: core(f.s0, 1), tail: core(f.s1, -1), outL, outR, lenL: laneLen(-1), lenR: laneLen(1),
    surfL: NO_SURFACES, surfR: NO_SURFACES,
  };
}

/**
 * M4-SURF's per-segment buckets: the surfaces as a car feels them (Surface) and, per segment, the
 * surfaces and tyre mounds a car whose nearest segment it is can be on or touch, and where the bots'
 * look ahead starts. A segment with none shares one frozen empty list (no allocation per segment).
 */
function buildBuckets(track: Track): void {
  const { cum, tyres } = track;
  const n = segCount(track); // the segments (BR-SCHEMA: an open road has one fewer than its samples)
  // THEME-SCHEMA: the theme surfaces as felt (their traction rectangles, a ford's vx its drift), sorted by
  // s0, in lists of their own (themeSurfaces / themeAt below: what the drawing reads, TH-LOOK-2/3) ...
  const theme: Surface[] = [];
  for (const f of track.sand) theme.push({ kind: SURF_SAND, ...tractionRect(f), vx: 0 });
  for (const f of track.oil) theme.push({ kind: SURF_OIL, ...tractionRect(f), vx: 0 });
  for (const f of track.fords) theme.push({ kind: SURF_FORD, ...tractionRect(f), vx: f.vx });
  theme.sort((a, b) => a.s0 - b.s0 || a.lat0 - b.lat0);
  const surfaces: Surface[] = [];
  for (const w of track.water) surfaces.push({ kind: SURF_WATER, ...tractionRect(w), vx: 0 });
  for (const d of track.dirt) surfaces.push({ kind: SURF_DIRT, ...tractionRect(d), vx: 0 });
  for (const b of track.belts) surfaces.push({ kind: SURF_BELT, s0: b.s0, s1: b.s1, lat0: b.lat0, lat1: b.lat1, vx: b.vx });
  // ... and THEME-SURF: in surfaces / surfAt too (the same objects), one bucket with water, dirt and belts,
  // so physics (surfaceAt), the bots' lane costs, an island's lanes and the route rings see them. None on a
  // track without any: the same list as before.
  for (const f of theme) surfaces.push(f);
  surfaces.sort((a, b) => a.s0 - b.s0 || a.lat0 - b.lat0);
  track.surfaces = surfaces;
  const surfAt: Surface[][] = [], surfFrom: number[] = [], tyresAt: PlacedTyres[][] = [], tyresFrom: number[] = [];
  const normals = tyres.length ? track.pts.map((_, i) => vertexNormal(track, i)) : [];
  for (let i = 0; i < n; i++) {
    const a = cum[i], b = cum[i + 1];
    // A car centre on segment i has a, its s, in a..b: a surface strictly overlapping that range.
    const on = surfaces.filter((f) => f.s0 < b && f.s1 > a);
    surfAt.push(on.length ? on : (NO_SURFACES as Surface[]));
    const k = surfaces.findIndex((f) => f.s1 > a);
    surfFrom.push(k < 0 ? surfaces.length : k);
    const t = tyres.findIndex((m) => m.s + m.r + TYRES_BEHIND > a);
    tyresFrom.push(t < 0 ? tyres.length : t);
    if (!tyres.length) {
      tyresAt.push(NO_TYRES as PlacedTyres[]);
      continue;
    }
    const quad = segQuad(track, i, normals);
    const near = tyres.filter((m) => moundNear(track, quad, a, b, m));
    tyresAt.push(near.length ? near : (NO_TYRES as PlacedTyres[]));
  }
  track.surfAt = surfAt;
  track.surfFrom = surfFrom;
  track.tyresAt = tyresAt;
  track.tyresFrom = tyresFrom;
  // THEME-SCHEMA: the theme surfaces per segment in a list of their own as well (as surfAt), for the
  // drawing: a track without any shares one frozen empty list per segment.
  track.themeSurfaces = theme;
  const themeAt: Surface[][] = [];
  for (let i = 0; i < n; i++) {
    const a = cum[i], b = cum[i + 1];
    const on = theme.length ? theme.filter((f) => f.s0 < b && f.s1 > a) : [];
    themeAt.push(on.length ? on : (NO_SURFACES as Surface[]));
  }
  track.themeAt = themeAt;
  // M4-SURF part 2: the islands by segment (by s: they lie on one section, and a car's or a rivet's
  // nearest segment is on its own section), where the bots look ahead for them, and the surfaces in
  // each island's lanes.
  const islandsAt: PlacedIsland[][] = [], islandsFrom: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = cum[i], b = cum[i + 1];
    const isl = track.islands.filter((x) => x.s0 - ISLAND_BUCKET_REACH < b && x.s1 + ISLAND_BUCKET_REACH > a);
    islandsAt.push(isl.length ? isl : (NO_ISLANDS as PlacedIsland[]));
    const k = track.islands.findIndex((x) => x.s1 + ISLAND_BEHIND > a);
    islandsFrom.push(k < 0 ? track.islands.length : k);
  }
  track.islandsAt = islandsAt;
  track.islandsFrom = islandsFrom;
  for (const isle of track.islands) {
    const lane = (lat0: number, lat1: number) => surfaces.filter((f) => f.s0 < isle.s1 && f.s1 > isle.s0 && f.lat0 < lat1 && f.lat1 > lat0);
    const l = lane(-isle.outL, isle.lat0), r = lane(isle.lat1, isle.outR);
    isle.surfL = l.length ? l : NO_SURFACES;
    isle.surfR = r.length ? r : NO_SURFACES;
  }
  // M4-MOVE: the barrels, presses and trucks by segment (by s, as the islands: they lie on one
  // section), and where the bots look ahead for them.
  const barrels = moverBuckets(track, track.barrels, (b) => b.s - BARREL_R, (b) => b.s + BARREL_R, NO_BARRELS);
  const presses = moverBuckets(track, track.presses, (p) => p.s - PRESS_DEPTH / 2, (p) => p.s + PRESS_DEPTH / 2, NO_PRESSES);
  const trucks = moverBuckets(track, track.trucks, (t) => t.s, (t) => t.s + t.len, NO_TRUCKS);
  track.barrelsAt = barrels.at;
  track.barrelsFrom = barrels.from;
  track.pressesAt = presses.at;
  track.pressesFrom = presses.from;
  track.trucksAt = trucks.at;
  track.trucksFrom = trucks.from;
}

/**
 * The corridor piece of segment i (the vertex normals either end, wall to wall): where a car centre
 * whose nearest segment is i lies (buildBuckets' mounds and, BR-SCHEMA, the gores' noses).
 */
function segQuad(track: Track, i: number, normals: readonly Vec[]): Vec[] {
  const j = (i + 1) % track.pts.length, p = track.pts[i], q = track.pts[j];
  return [
    { x: p.x + normals[i].x * track.wallR[i], y: p.y + normals[i].y * track.wallR[i] },
    { x: q.x + normals[j].x * track.wallR[j], y: q.y + normals[j].y * track.wallR[j] },
    { x: q.x - normals[j].x * track.wallL[j], y: q.y - normals[j].y * track.wallL[j] },
    { x: p.x - normals[i].x * track.wallL[i], y: p.y - normals[i].y * track.wallL[i] },
  ];
}

/** Does tyre mound m go in the bucket of the segment cum a..b whose corridor piece is `quad`: on its section, within its radius + TYRES_BUCKET_REACH of it? */
function moundNear(track: Track, quad: readonly Vec[], a: number, b: number, m: PlacedTyres): boolean {
  const ds = Math.abs(m.s - (a + b) / 2);
  if (alongGap(track, ds) > 4 * (track.wall + m.r + TYRES_BUCKET_REACH)) return false; // another section
  return quadDist(quad, m.x, m.y) <= m.r + TYRES_BUCKET_REACH;
}

/**
 * A car capsule's reach from its centre (15.5) plus a tick's travel (~9 at 537 u/s), and a rivet's
 * swept tick (~24 units at 900 + 537 u/s) plus its radius: a barrel row, a press or a truck goes in
 * the bucket of every segment within this of its s range.
 */
const MOVER_BUCKET_REACH = 30;
/** The bots keep a barrel row, a press or a truck in view until it is this far behind the car (as a mound). */
const MOVER_BEHIND = 40;

/** Per segment: the features (sorted by s) whose s range lo..hi comes within MOVER_BUCKET_REACH of it, and the bots' first index. */
function moverBuckets<T>(track: Track, list: readonly T[], lo: (x: T) => number, hi: (x: T) => number, empty: readonly T[]): { at: T[][]; from: number[] } {
  const { cum } = track;
  const at: T[][] = [], from: number[] = [];
  for (let i = 0; i < segCount(track); i++) {
    const a = cum[i], b = cum[i + 1];
    const near = list.filter((x) => lo(x) - MOVER_BUCKET_REACH < b && hi(x) + MOVER_BUCKET_REACH > a);
    at.push(near.length ? near : (empty as T[]));
    const k = list.findIndex((x) => hi(x) + MOVER_BEHIND > a);
    from.push(k < 0 ? list.length : k);
  }
  return { at, from };
}

/** Distance from (x, y) to a convex quad (0 inside it). */
function quadDist(quad: readonly Vec[], x: number, y: number): number {
  let inside = true, best = Infinity;
  let sign = 0;
  for (let k = 0; k < quad.length; k++) {
    const a = quad[k], b = quad[(k + 1) % quad.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const cross = ex * (y - a.y) - ey * (x - a.x);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) inside = false;
    }
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey) / len2));
    best = Math.min(best, Math.hypot(x - a.x - ex * t, y - a.y - ey * t));
  }
  return inside ? 0 : best;
}

/**
 * The surface a car centre at (s, lat) on its nearest segment `seg` is on (strictly inside its
 * Surface rectangle), or null: a look in that segment's bucket (empty on a track without any).
 */
export function surfaceAt(track: Track, seg: number, s: number, lat: number): Surface | null {
  const list = track.surfAt[seg];
  if (list === undefined || list.length === 0) return null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (s > f.s0 && s < f.s1 && lat > f.lat0 && lat < f.lat1) return f;
  }
  return null;
}

/**
 * The lateral offset nearest the centerline (0, then +-2, +-4, ... up to the asphalt's edge less
 * half a car) at s where a car facing along the track touches no tyre mound (clear by `margin`)
 * and stands on ground (no gap or hole): where a respawn or a recovery puts a car (M4-SURF, "the
 * nearest clear lane"). 0 when no mound is near (the centerline, as before M4-SURF).
 * Split lanes (M4-SURF part 2): where an island is in the way the car (its 30 x 16 box, clear by
 * `margin`) goes in a lane beside it, out to that lane's widened asphalt, on the side of the island
 * that `prefer` (the car's own lateral offset) is on, the nearest the centerline there; on the
 * other side only if that one has no room. Without an island in the way: exactly as before.
 * M4-MOVE: the car's box also keeps `margin` clear of a barrel row's path (s +- BARREL_R, wall to
 * wall: no lane at such an s is clear), of a crusher press (up or down: it may come down) and of a
 * parked truck. 0 when no lane is clear (clearSpot then looks further back).
 */
export function clearLaneAt(track: Track, s: number, margin = 4, prefer = 0): number {
  return laneAt(track, s, margin, prefer) ?? 0;
}

/** clearLaneAt's search: the lane, or null when none is clear (no mound, island or mover near: 0). */
function laneAt(track: Track, s: number, margin: number, prefer: number): number | null {
  const p = pointAt(track, s);
  const near = track.tyresAt[p.seg];
  const isles = track.islandsAt[p.seg];
  const rows = track.barrelsAt[p.seg], gates = track.pressesAt[p.seg], trucks = track.trucksAt[p.seg];
  const along = (s0: number, s1: number) => s + CAR_HALF_LEN + margin > s0 && s - CAR_HALF_LEN - margin < s1;
  const across = (lat: number, lat0: number, lat1: number) => lat + CAR_HALF_WID + margin > lat0 && lat - CAR_HALF_WID - margin < lat1;
  const boxed = (f: PlacedIsland, lat: number) => along(f.s0, f.s1) && across(lat, f.lat0, f.lat1);
  const isle = isles !== undefined && isles.length > 0 ? isles.find((f) => along(f.s0, f.s1)) : undefined;
  // The movers whose s range the car's box meets (none on a track without any).
  const row = rows !== undefined && rows.length > 0 ? rows.find((b) => along(b.s - BARREL_R, b.s + BARREL_R)) : undefined;
  if (row !== undefined) return null; // a barrel row's path: wall to wall
  const gate = gates !== undefined && gates.length > 0 ? gates.filter((g) => along(g.s - PRESS_DEPTH / 2, g.s + PRESS_DEPTH / 2)) : NO_PRESSES;
  const truck = trucks !== undefined && trucks.length > 0 ? trucks.filter((t) => along(t.s, t.s + t.len)) : NO_TRUCKS;
  const movers = gate.length > 0 || truck.length > 0;
  if (isle === undefined && !movers && (near === undefined || near.length === 0)) return 0;
  const ux = Math.cos(p.h), uy = Math.sin(p.h);
  const clear = (lat: number) => {
    const x = p.x - uy * lat, y = p.y + ux * lat;
    if (near !== undefined) {
      for (const m of near) {
        const dx = m.x - x, dy = m.y - y;
        const t = Math.max(-CAR_HALF_LEN / 2, Math.min(CAR_HALF_LEN / 2, dx * ux + dy * uy)); // CAPSULE_HALF 7.5
        if (Math.hypot(dx - ux * t, dy - uy * t) < m.r + CAR_HALF_WID + margin) return false; // CAPSULE_R 8
      }
    }
    if (isle !== undefined && isles.some((f) => boxed(f, lat))) return false;
    if (movers) {
      for (const g of gate) if (across(lat, g.lat0, g.lat1)) return false;
      for (const t of truck) if (across(lat, t.lat - TRUCK_HALF, t.lat + TRUCK_HALF)) return false;
    }
    return !overHazard(track, x, y, s);
  };
  if (isle === undefined) {
    // Without an island the asphalt as drawn here (def.halfWidth on a road that is not widened: as before).
    const max = (movers && track.widens.length > 0 ? Math.min(halfOn(track, p.seg, s, -1), halfOn(track, p.seg, s, 1)) : track.def.halfWidth) - CAR_HALF_WID;
    for (let k = 0; k <= max; k += 2) for (const lat of k === 0 ? [0] : [-k, k]) if (clear(lat)) return lat;
    return movers ? null : 0;
  }
  // An island in the way: the lanes either side, the car's own side first.
  const maxL = halfOn(track, p.seg, s, -1) - CAR_HALF_WID, maxR = halfOn(track, p.seg, s, 1) - CAR_HALF_WID;
  const side = prefer < isle.mid ? -1 : 1;
  for (const pass of [side, -side]) {
    for (let k = 0; k <= Math.max(maxL, maxR); k += 2) {
      for (const lat of k === 0 ? [0] : [-k, k]) {
        if ((lat - isle.mid) * pass <= 0 || lat < -maxL || lat > maxR) continue;
        if (clear(lat)) return lat;
      }
    }
  }
  return movers ? null : 0;
}

/**
 * Where a respawn or a recovery puts a car near s (M4-MOVE, PLAN-M4 2.3 "the nearest clear lane"):
 * at s on its nearest clear lane (clearLaneAt, `prefer` the side of an island); when no lane at s is
 * clear (a barrel row's path, wall to wall; a press or a truck leaving no room) just behind what is in
 * the way (its s range less the car's half-length and `margin`), up to twice, never onto a hole or a
 * gap; failing that, the recovery point at or before s and its lane (validation keeps solids
 * SOLID_CLEAR from it). On a track without barrels, presses and trucks: s and clearLaneAt(s), exactly.
 */
export function clearSpot(track: Track, s: number, margin = 4, prefer = 0): { s: number; lat: number } {
  const at = spotNear(track, s, margin, prefer);
  if (at !== null) return at;
  const r = recoveryAt(track, s);
  return { s: r, lat: clearLaneAt(track, r, margin, prefer) };
}

/**
 * clearSpot on road `road` of a track (BR-PHYS, PLAN-BRANCH 2.5): on the main road (0) clearSpot exactly;
 * on a branch its search on the branch's road, and where that finds no lane the recovery point recoveryFor
 * gives (the branch's last one at or before s, else the main road's before the fork: user decision 6) and
 * its lane, on that point's road.
 */
export function clearSpotOn(track: Track, road: number, s: number, margin = 4, prefer = 0): { road: number; s: number; lat: number } {
  if (road === track.roadNo) {
    const a = clearSpot(track, s, margin, prefer);
    return { road, s: a.s, lat: a.lat };
  }
  const at = spotNear(track.branches[road - 1].road, s, margin, prefer);
  if (at !== null) return { road, s: at.s, lat: at.lat };
  const rf = recoveryFor(track, road, s);
  return { road: rf.road, s: rf.s, lat: clearLaneAt(roadOf(track, rf.road), rf.s, margin, prefer) };
}

/** clearSpot's search on one road: the spot at s or just behind what is in the way, or null (the recovery point's turn). */
function spotNear(track: Track, s: number, margin: number, prefer: number): { s: number; lat: number } | null {
  let at = s;
  for (let k = 0; k < 3; k++) {
    const lat = laneAt(track, at, margin, prefer);
    if (lat !== null) return { s: at, lat };
    // What is in the way here: the furthest-back start of a barrel row, press or truck the car's box meets.
    const seg = pointAt(track, at).seg;
    let back = Infinity;
    const meets = (s0: number, s1: number) => at + CAR_HALF_LEN + margin > s0 && at - CAR_HALF_LEN - margin < s1;
    for (const b of track.barrelsAt[seg]) if (meets(b.s - BARREL_R, b.s + BARREL_R)) back = Math.min(back, b.s - BARREL_R);
    for (const g of track.pressesAt[seg]) if (meets(g.s - PRESS_DEPTH / 2, g.s + PRESS_DEPTH / 2)) back = Math.min(back, g.s - PRESS_DEPTH / 2);
    for (const t of track.trucksAt[seg]) if (meets(t.s, t.s + t.len)) back = Math.min(back, t.s);
    if (back === Infinity) break; // a mound or an island alone: not a mover's doing
    at = wrapS(track, back - CAR_HALF_LEN - margin - 1);
    // Moved back: never onto a hole or a gap (laneAt does not look for them where nothing else is
    // near: M4-MOVE review F2); on one, the recovery point below.
    const p = pointAt(track, at), q = laneAt(track, at, margin, prefer);
    if (q !== null && overHazard(track, p.x - Math.sin(p.h) * q, p.y + Math.cos(p.h) * q, at)) break;
  }
  return null;
}

/** The world point `lat` units sideways (+ = right of travel) of the centerline at s, and its segment. */
function trackPoint(track: Track, s: number, lat: number): { x: number; y: number; seg: number } {
  const p = pointAt(track, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, seg: p.seg };
}

/**
 * How much wider the asphalt is on `side` (-1 = left, +1 = right) at s than def.halfWidth: the
 * widens' extra width there, tapered over WIDEN_TAPER at each end (M4-SCHEMA). 0 without a widen.
 */
export function widenAt(track: Track, s: number, side: number): number {
  s = wrapS(track, s);
  let extra = 0;
  for (const w of track.widens) {
    if (s < w.s0 || s > w.s1) continue;
    extra += (side < 0 ? w.left : w.right) * Math.min(1, (s - w.s0) / WIDEN_TAPER, (w.s1 - s) / WIDEN_TAPER);
  }
  return extra;
}

/** The asphalt's half-width on `side` (-1 = left, +1 = right) at s: def.halfWidth plus any widen. */
export function halfAt(track: Track, s: number, side: number): number {
  return track.def.halfWidth + widenAt(track, s, side);
}

/** The wall's distance from the centerline on `side` at s: the asphalt plus the verge. */
export function wallAt(track: Track, s: number, side: number): number {
  return halfAt(track, s, side) + track.def.verge;
}

/**
 * The per-sample walls where a track query is (M4-SURF part 2): the asphalt's half-width on the
 * query's side (q.side) at its s, the per-sample half-widths (halfL / halfR) of its segment's two ends
 * taken in a straight line between them at the query's place along the segment (halfOn). That is the
 * road's edge, kerb, verge and barrier as the bake draws them (client/gfx/world.ts: each centreline
 * piece's widening at its two ends, linear in the projection between them; client/gfx/actors.ts's
 * dust the same), so a car meets the wall where it is drawn and leaves the asphalt at the drawn kerb.
 * Without a widen on the track: def.halfWidth, exactly.
 */
export function halfOf(track: Track, q: TrackQuery): number {
  // BR-PHYS: a query of a track with branches may be on a branch: its road's (roadFor); the track's own otherwise.
  const r = q.road === track.roadNo ? track : track.branches[q.road - 1].road;
  return r.widens.length === 0 ? r.def.halfWidth : halfOn(r, q.seg, q.s, q.side);
}

/**
 * The asphalt's half-width on `side` (-1 left, +1 right) at s on segment seg (cum[seg]..cum[seg + 1]):
 * the segment's two per-sample half-widths, interpolated linearly in s (the bake's projection
 * parameter). Where both ends are the same (a plain stretch, a widen's full width): that, exactly.
 */
export function halfOn(track: Track, seg: number, s: number, side: number): number {
  const arr = side < 0 ? track.halfL : track.halfR;
  const n = arr.length;
  const a = arr[seg], b = arr[seg + 1 < n ? seg + 1 : 0];
  if (a === b) return a;
  const c0 = track.cum[seg], len = track.cum[seg + 1] - c0;
  let d = wrapS(track, s) - c0;
  if (d < -track.length / 2 && track.roadNo === 0) d += track.length; // the last segment's end, wrapped to 0 (a closed road's)
  const t = !(len > 0) || d <= 0 ? 0 : d >= len ? 1 : d / len;
  const w0 = a - track.def.halfWidth, w1 = b - track.def.halfWidth; // the widening at either end, as the bake's wL0 / wL1
  return track.def.halfWidth + (w0 + (w1 - w0) * t);
}

/** The wall's distance from the centerline where a query is (its side, its s): halfOf plus the verge; track.wall without a widen, exactly. */
export function wallOf(track: Track, q: TrackQuery): number {
  const r = q.road === track.roadNo ? track : track.branches[q.road - 1].road; // BR-PHYS: the query's road (halfOf)
  return r.widens.length === 0 ? r.wall : halfOf(r, q) + r.def.verge;
}

/**
 * The island whose rectangle (s0..s1 by lat0..lat1, `pad` wider all round) holds the point (s, lat)
 * on segment seg's section, or null: a look in that segment's bucket (empty without islands).
 */
export function islandAt(track: Track, seg: number, s: number, lat: number, pad = 0): PlacedIsland | null {
  const list = track.islandsAt[seg];
  if (list === undefined || list.length === 0) return null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (s >= f.s0 - pad && s <= f.s1 + pad && lat >= f.lat0 - pad && lat <= f.lat1 + pad) return f;
  }
  return null;
}

/**
 * Where barrel k (0..n-1) of a row is across the road at race tick rt: its lateral offset (+ = right
 * of travel, from b.lat0 to b.lat1), or NaN while it is in the gutter (off the road, on its way back
 * to the near wall). A pure function of rt (integer ticks), so the server, the client's prediction
 * and the renderer agree; periodic in b.period.
 */
export function barrelLat(b: PlacedBarrels, k: number, rt: number): number {
  const p = b.period;
  const phase = (((rt + b.offsets[k]) % p) + p) % p;
  const d = (phase * Math.abs(b.speed)) / TICKS_PER_S;
  if (d > b.lat1 - b.lat0) return NaN;
  return b.speed > 0 ? b.lat0 + d : b.lat1 - d;
}

/**
 * A crusher press's state at race tick rt: PRESS_DOWN (solid) for the last `down` ticks of each
 * period, PRESS_WARNING (its shadow warns) for the PRESS_WARN_TICKS before that, PRESS_UP otherwise.
 * A pure function of rt (integer ticks), periodic in p.period.
 */
export function pressState(p: Press, rt: number): number {
  const phase = ((rt % p.period) + p.period) % p.period;
  const downAt = p.period - p.down;
  return phase >= downAt ? PRESS_DOWN : phase >= downAt - PRESS_WARN_TICKS ? PRESS_WARNING : PRESS_UP;
}

/** Is the press down (solid) at race tick rt? */
export function pressDown(p: Press, rt: number): boolean {
  return pressState(p, rt) === PRESS_DOWN;
}

/**
 * The ramp truck whose take-off zone holds a car centre at (s, lat): s in [lip, lip + LIP_ZONE) and
 * lat inside the ramp band (the lateral lip test; lipAt is the full-width ramps'). null if none.
 */
export function truckLipAt(track: Track, s: number, lat: number): PlacedTruck | null {
  s = wrapS(track, s);
  for (const t of track.trucks) if (s >= t.lip && s < t.lip + LIP_ZONE && lat >= t.band0 && lat <= t.band1) return t;
  return null;
}

function nearest(track: Track, x: number, y: number, from: number, count: number): TrackQuery {
  const { pts, cum } = track;
  const n = pts.length;
  if (track.roadNo > 0) {
    // BR-SCHEMA: an open road's window is clamped to its segments 0..n-2, never wrapped.
    const hi = Math.min(n - 2, from + count - 1);
    from = Math.max(0, Math.min(from, hi));
    count = hi - from + 1;
  }
  let best = Infinity, bestSeg = 0, bestT = 0, bx = 0, by = 0;
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % n) + n) % n;
    const a = pts[i], b = pts[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len2 = ex * ex + ey * ey || 1;
    let t = ((x - a.x) * ex + (y - a.y) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + ex * t, py = a.y + ey * t;
    const d2 = (x - px) * (x - px) + (y - py) * (y - py);
    if (d2 < best) { best = d2; bestSeg = i; bestT = t; bx = px; by = py; }
  }
  const dist = Math.sqrt(best);
  let nx = x - bx, ny = y - by;
  const a = pts[bestSeg], b = pts[(bestSeg + 1) % n];
  if (dist > 1e-6) { nx /= dist; ny /= dist; } else {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    nx = -(b.y - a.y) / l; ny = (b.x - a.x) / l;
  }
  const s = cum[bestSeg] + (cum[bestSeg + 1] - cum[bestSeg]) * bestT;
  // The side: the cross product of the segment's direction and the point (+ = right of travel).
  return new Query(dist, nx, ny, s, bestSeg, (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0 ? -1 : 1, track.roadNo);
}

/** Nearest point on the whole centerline. Use only when there is no position history. */
export function queryTrack(track: Track, x: number, y: number): TrackQuery {
  return nearest(track, x, y, 0, track.pts.length);
}

/**
 * Nearest point searched only around `hint` (the car's last segment), so a car is never
 * snapped to a different part of the track that happens to pass close by.
 * BR-PHYS (PLAN-BRANCH 2.2): on a track with branches the hint is a GLOBAL segment (CarState.seg:
 * the main road's 0..n-1, then each branch's from its base; globalSeg): the hint's road is searched
 * round it (LOCAL_WINDOW either side, clamped on a branch's open road) and, where that window touches
 * a mouth (mouthAt), the other road round its segment there too; the nearer centreline wins, on a tie
 * the hint's road (deterministic). The query's s and seg are on its road (q.road: roadOf). Without
 * branches: today's call, byte for byte.
 */
export function queryTrackNear(track: Track, x: number, y: number, hint: number): TrackQuery {
  // No global fallback: at a crossing that would snap a car onto the other road. A point
  // further than 2 * wall from its own section is lost (see isLost): a car falls, a shot dies.
  if (track.branches.length === 0) return nearest(track, x, y, hint - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
  return nearRoads(track, x, y, hint);
}

/** queryTrackNear on a track with branches (see above): the hint's road, and the other road in a mouth. */
function nearRoads(track: Track, x: number, y: number, hint: number): TrackQuery {
  const bs = track.branches;
  const r = roadOfSeg(track, hint);
  const road = r === 0 ? track : bs[r - 1].road;
  let q = nearest(road, x, y, (r === 0 ? hint : hint - bs[r - 1].base) - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
  const other = track.mouthAt[hint];
  if (other !== undefined && other >= 0) {
    const r2 = roadOfSeg(track, other);
    const q2 = nearest(r2 === 0 ? track : bs[r2 - 1].road, x, y, (r2 === 0 ? other : other - bs[r2 - 1].base) - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
    if (q2.dist < q.dist) q = q2;
  }
  return q;
}

/**
 * The main road's query round a global hint, never a branch's (BR-PHYS: the server bots keep the main
 * road until BR-BOTS gives them a route; a bot the physics put on a branch in a mouth still reads the
 * main road). A branch hint goes to the main segment at its mapS. Without branches: queryTrackNear exactly.
 */
export function queryMain(track: Track, x: number, y: number, hint: number): TrackQuery {
  if (track.branches.length > 0 && hint >= track.pts.length) {
    const r = roadOfSeg(track, hint);
    if (r > 0) {
      const b = track.branches[r - 1];
      const j = Math.max(0, Math.min(b.mapS.length - 1, hint - b.base));
      hint = pointAt(track, b.mapS[j]).seg;
    }
  }
  return nearest(track, x, y, hint - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
}

/**
 * Further than 2 * wall from its own section: a car falls (see stepRaceCar). The wall on the query's
 * side at its s (wallOf, M4-SURF part 2: a widened road is lost further out); track.wall without a widen.
 */
export function isLost(track: Track, q: TrackQuery): boolean {
  return q.dist > wallOf(track, q) * 2;
}

/** Wrap a distance along the track into [0, length) (exactly s when already inside); on an open road (BR-SCHEMA) clamp it to [0, length]. */
export function wrapS(track: Track, s: number): number {
  const L = track.length;
  if (track.roadNo > 0) return s < 0 ? 0 : s > L ? L : s;
  return s >= 0 && s < L ? s : ((s % L) + L) % L;
}

/** How far apart two places ds apart in s are along the road: the nearer way round a closed road (BR-SCHEMA: just ds on an open one). */
export function alongGap(track: Track, ds: number): number {
  return track.roadNo > 0 ? ds : Math.min(ds, track.length - ds);
}

/** The number of segments of a road: pts.length on a closed road, one fewer on an open one (a branch's, BR-SCHEMA). */
export function segCount(track: Track): number {
  return track.roadNo > 0 ? track.pts.length - 1 : track.pts.length;
}

/** Unit direction of travel of segment `seg`. */
export function segDir(track: Track, seg: number): Vec {
  const { pts } = track;
  if (track.roadNo > 0 && seg > pts.length - 2) seg = pts.length - 2; // an open road's last sample: its last segment's direction
  const a = pts[seg], b = pts[(seg + 1) % pts.length];
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

/** The gap with s inside [s0, s1), or null. */
export function gapAt(track: Track, s: number): Gap | null {
  s = wrapS(track, s);
  for (const g of track.gaps) if (s >= g.s0 && s < g.s1) return g;
  return null;
}

/** The hole whose pit contains (x, y), for a point at distance s along its own section. */
export function holeAt(track: Track, x: number, y: number, s: number): PlacedHole | null {
  for (const h of track.holes) {
    const ds = Math.abs(wrapS(track, s) - h.s);
    if (alongGap(track, ds) > h.r + track.wall) continue; // a different part of the track
    if ((x - h.x) ** 2 + (y - h.y) ** 2 < h.r * h.r) return h;
  }
  return null;
}

/** No ground under (x, y) at distance s along its own section: over a gap or a hole. */
export function overHazard(track: Track, x: number, y: number, s: number): boolean {
  return gapAt(track, s) !== null || holeAt(track, x, y, s) !== null;
}

/** The ramp whose take-off zone [end, end + LIP_ZONE) contains s, or null. */
export function lipAt(track: Track, s: number): Ramp | null {
  s = wrapS(track, s);
  for (const r of track.ramps) {
    const end = r.s + r.len;
    if (s >= end && s < end + LIP_ZONE) return r;
  }
  return null;
}

/**
 * The last recovery point at or before s, wrapping to the last one of the lap before. On an open road
 * (a branch's, BR-SCHEMA advisor change 3) nothing wraps: the last one at or before s, or -1 when none
 * is (none at all, or all of them past s): the car then goes back to the main road, recoveryFor.
 */
export function recoveryAt(track: Track, s: number): number {
  s = wrapS(track, s);
  const rec = track.recovery;
  if (track.roadNo > 0) {
    let at = -1;
    for (const r of rec) if (r <= s) at = r;
    return at;
  }
  let best = rec[rec.length - 1];
  for (const r of rec) if (r <= s) best = r;
  return best;
}

/** Point and heading on the centerline at distance s (wraps). */
export function pointAt(track: Track, s: number): { x: number; y: number; h: number; seg: number } {
  const L = track.length;
  const open = track.roadNo > 0; // BR-SCHEMA: on an open road s is clamped to 0..length and the last segment is n - 2
  s = open ? (s < 0 ? 0 : s > L ? L : s) : ((s % L) + L) % L;
  const { pts, cum } = track;
  // The last sample i (at most n - 1) with cum[i] <= s: a binary search over cum (non-decreasing,
  // cum[0] = 0), the same sample a scan from 0 finds (M4-BOTS: bots call this every tick).
  let i = 0, hi = open ? pts.length - 2 : pts.length - 1;
  while (i < hi) {
    const mid = (i + hi + 1) >> 1;
    if (cum[mid] <= s) i = mid;
    else hi = mid - 1;
  }
  const a = pts[i], b = pts[(i + 1) % pts.length];
  const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: Math.atan2(b.y - a.y, b.x - a.x), seg: i };
}

/** Staggered two-wide starting grid behind the start line (s = 0). */
export function gridSlot(track: Track, slot: number): { x: number; y: number; h: number; seg: number } {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  const p = pointAt(track, -50 - row * 70 - (side > 0 ? 35 : 0));
  const lateral = side * track.def.halfWidth * 0.45;
  return { x: p.x - Math.sin(p.h) * lateral, y: p.y + Math.cos(p.h) * lateral, h: p.h, seg: p.seg };
}

/**
 * End of the start straight, as a distance past the start line: the start of the first
 * segment whose heading differs from the heading at s = 0 by more than
 * START_STRAIGHT_TOLERANCE, but at least START_ZONE.
 */
export function startStraightEnd(track: Track): number {
  const h0 = pointAt(track, 0).h;
  for (let i = 0; i < track.pts.length; i++) {
    const d = segDir(track, i);
    const dh = Math.atan2(d.y, d.x) - h0;
    if (Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))) > START_STRAIGHT_TOLERANCE) return Math.max(START_ZONE, track.cum[i]);
  }
  return track.length;
}

/**
 * Smallest gap between two parts of the track that are far apart along the route.
 * If this is below 2 * wall the walls of the two parts overlap.
 */
export function minSelfClearance(track: Track): number {
  const { pts, cum, length } = track;
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const along = Math.min(cum[j] - cum[i], length - (cum[j] - cum[i]));
      if (along < track.wall * 4) continue;
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
  }
  return min;
}

// ---- validation ---------------------------------------------------------------------

/** Parts of the track closer than this along the route are the same section. */
const SAME_SECTION = 4; // * wall
/** Clearance kept between a recovery point and a hole's edge (about half a car). */
const RECOVERY_HOLE_MARGIN = 16;
/** A cell's extent for placement (its radius, shared/catchup.ts CELL_RADIUS: no runtime import here). */
const CELL_EDGE = 14;
/** The kerb: the asphalt's outer band this wide. A ground cell sits on it or further out (in the dirt). */
export const CELL_KERB = 8;
/**
 * An air cell sits at least this far off the centre line (|lat|), or every car that flies a jump
 * down the middle (a bot on lane 0) takes it without aiming for it. One unit past the reach of a
 * touch (CELL_TOUCH 27 in shared/catchup.ts, inclusive; no runtime import here, sim-test checks
 * the two): a car flying straight along the centre line passes it by.
 */
export const CELL_AIR_OFF = 28;

/** A piece of one centerline segment that is either all ground or all gap. */
interface Piece { seg: number; s0: number; s1: number; ground: boolean; quad: Vec[]; cx: number; cy: number; rad: number }

function vertexNormal(track: Track, i: number): Vec {
  const n = track.pts.length;
  // An open road's ends (BR-SCHEMA): the one segment there (segDir clamps the last).
  const a = segDir(track, track.roadNo > 0 ? Math.max(0, i - 1) : (i - 1 + n) % n), b = segDir(track, i);
  let dx = a.x + b.x, dy = a.y + b.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) { dx = b.x; dy = b.y; } else { dx /= l; dy /= l; }
  return { x: -dy, y: dx };
}

/** The corridor (centerline -wallL..+wallR, per sample) cut into ground and gap pieces, one quad each. */
function corridorPieces(track: Track): Piece[] {
  const { pts, cum, wallL, wallR } = track;
  const n = pts.length;
  const normals = pts.map((_, i) => vertexNormal(track, i));
  const out: Piece[] = [];
  for (let i = 0; i < segCount(track); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const s0 = cum[i], s1 = cum[i + 1];
    const d = segDir(track, i);
    const segN = { x: -d.y, y: d.x };
    const cuts = [s0, s1];
    for (const g of track.gaps) for (const c of [g.s0, g.s1]) if (c > s0 && c < s1) cuts.push(c);
    cuts.sort((p, q) => p - q);
    const j = (i + 1) % n;
    const at = (s: number) => {
      const t = (s - s0) / (s1 - s0 || 1);
      const nrm = s === s0 ? normals[i] : s === s1 ? normals[j] : segN;
      // The walls of the samples either end, and in between along the segment (equal walls: exactly that wall).
      const wl = s === s0 ? wallL[i] : s === s1 ? wallL[j] : wallL[i] + (wallL[j] - wallL[i]) * t;
      const wr = s === s0 ? wallR[i] : s === s1 ? wallR[j] : wallR[i] + (wallR[j] - wallR[i]) * t;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: nrm.x, ny: nrm.y, wl, wr };
    };
    for (let k = 0; k + 1 < cuts.length; k++) {
      const u = cuts[k], v = cuts[k + 1];
      if (v - u < 1e-6) continue;
      const p = at(u), q = at(v);
      // The normal points right of travel (vertexNormal): + is the right wall, - the left one.
      const quad = [
        { x: p.x + p.nx * p.wr, y: p.y + p.ny * p.wr },
        { x: q.x + q.nx * q.wr, y: q.y + q.ny * q.wr },
        { x: q.x - q.nx * q.wl, y: q.y - q.ny * q.wl },
        { x: p.x - p.nx * p.wl, y: p.y - p.ny * p.wl },
      ];
      const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
      const rad = Math.max(...quad.map((c) => Math.hypot(c.x - cx, c.y - cy)));
      out.push({ seg: i, s0: u, s1: v, ground: gapAt(track, (u + v) / 2) === null, quad, cx, cy, rad });
    }
  }
  return out;
}

/** Do two convex quads overlap (touching is not overlapping)? Separating-axis test. */
function quadsOverlap(a: Vec[], b: Vec[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ax = -(q.y - p.y), ay = q.x - p.x;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const c of a) { const d = c.x * ax + c.y * ay; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const c of b) { const d = c.x * ax + c.y * ay; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

/**
 * Everything wrong with a track's layout, features and recovery points; empty = valid.
 * - Features lie inside the track (no wrap past s = 0), off the starting grid (GRID_ZONE
 *   behind the line) and the start straight (startStraightEnd past it); holes inside the walls.
 * - Recovery points are on solid ground (not in a gap, a hole or a take-off zone).
 * - The ground corridors (centerline +-wall, outside gaps) of two sections never overlap: the
 *   track may cross itself only where one of the two sections is a gap.
 * - Sections whose corridors (gaps included) overlap, e.g. at a crossing, are more than
 *   2 * LOCAL_WINDOW + SECTION_INDEX_MARGIN segment indices apart, so queryTrackNear around a
 *   car's hint never sees the other road.
 * - Cells (M4-CELLS) lie inside the walls and outside the start zone; a ground cell on the kerb or
 *   in the dirt, not in a gap or over a hole; an air cell off-centre (|lat| >= CELL_AIR_OFF).
 *   Whether an air cell can be reached from a jump is a simulation: validateCells in
 *   shared/weapons.ts.
 * The run-up check (every jump can be made from its recovery point) is validateRunUps in
 * shared/weapons.ts.
 */
/**
 * A road's own features and recovery points (validateTrack's checks before the crossings, the main
 * road's and, BR-SCHEMA, each branch's): `zone` says where on the road a feature may lie.
 */
function validateRoad(track: Track, errors: string[], zone: (what: string, lo: number, hi: number) => void): void {
  const f1 = (v: number) => v.toFixed(1);
  for (const r of track.ramps) {
    if (!(r.len > 0)) errors.push(`ramp at s=${f1(r.s)}: length must be > 0`);
    zone(`ramp at s=${f1(r.s)}`, r.s, r.s + r.len + LIP_ZONE);
  }
  for (const g of track.gaps) {
    if (!(g.s1 > g.s0)) errors.push(`gap at s=${f1(g.s0)}: s1 must be > s0`);
    zone(`gap ${f1(g.s0)}..${f1(g.s1)}`, g.s0, g.s1);
  }
  for (const h of track.holes) {
    if (!(h.r > 0)) errors.push(`hole at s=${f1(h.s)}: radius must be > 0`);
    if (Math.abs(h.lat) + h.r > track.wall) errors.push(`hole at s=${f1(h.s)}: reaches past the wall`);
    zone(`hole at s=${f1(h.s)}`, h.s - h.r, h.s + h.r);
    if (gapAt(track, h.s)) errors.push(`hole at s=${f1(h.s)}: inside a gap`);
  }
  for (const c of track.cells) {
    if (c.road !== undefined) continue; // a branch's cell on the main track's list (BR-SCHEMA): its own road checks it
    const at = `${c.air ? "air" : "ground"} cell at s=${f1(c.s)}`;
    zone(at, c.s - CELL_EDGE, c.s + CELL_EDGE);
    if (Math.abs(c.lat) + CELL_EDGE > track.wall) errors.push(`${at}: reaches past the wall`);
    if (c.air) {
      // Off-centre: a jump has to be taken on its side.
      if (Math.abs(c.lat) < CELL_AIR_OFF) errors.push(`${at}: lat ${f1(c.lat)} is on the centre line (an air cell sits off-centre, |lat| >= ${CELL_AIR_OFF}, or a car flying down the middle takes it)`);
    } else {
      // A little hard to reach: on the kerb (the asphalt's outer CELL_KERB units) or in the dirt.
      if (Math.abs(c.lat) < track.def.halfWidth - CELL_KERB) errors.push(`${at}: lat ${f1(c.lat)} is on the open road (a ground cell sits on the kerb, |lat| >= ${track.def.halfWidth - CELL_KERB}, or in the dirt)`);
      if (gapAt(track, c.s)) errors.push(`${at}: in a gap (no ground under it)`);
      if (track.holes.some((h) => Math.hypot(h.x - c.x, h.y - c.y) < h.r + CELL_EDGE && alongGap(track, Math.abs(h.s - c.s)) < h.r + track.wall)) {
        errors.push(`${at}: over a hole`);
      }
    }
  }
  for (const r of track.recovery) {
    const p = pointAt(track, r);
    const nearHole = track.holes.some((h) => {
      const ds = Math.abs(r - h.s);
      return alongGap(track, ds) <= h.r + track.wall && Math.hypot(p.x - h.x, p.y - h.y) < h.r + RECOVERY_HOLE_MARGIN;
    });
    if (gapAt(track, r) || nearHole || lipAt(track, r)) errors.push(`recovery point s=${f1(r)}: not on solid ground (gap, hole or take-off zone)`);
  }
  validateSchema(track, errors, zone);
}

export function validateTrack(track: Track): string[] {
  const errors: string[] = [];
  const L = track.length;
  const f1 = (v: number) => v.toFixed(1);
  // THEME-SCHEMA: a theme is one of THEMES, or none (the scrapyard).
  const named: unknown = track.def.theme;
  if (named !== undefined && !isTheme(named)) errors.push(`theme ${JSON.stringify(named)}: not a theme (one of ${THEMES.join(", ")}, or none for the scrapyard)`);
  const straight = startStraightEnd(track);
  const zone = (what: string, lo: number, hi: number) => {
    if (!(lo >= 0 && hi <= L && lo <= hi)) errors.push(`${what}: outside 0..${f1(L)} (or wraps past the start line)`);
    else if (lo < straight || hi > L - GRID_ZONE) {
      errors.push(`${what}: in the start zone (grid ${f1(L - GRID_ZONE)}..${f1(L)} or start straight 0..${f1(straight)})`);
    } else if (track.branches.length > 0) mouthZone(track, errors, what, lo, hi);
  };
  validateRoad(track, errors, zone);

  sectionCrossings(track, errors, "s", "");
  if (track.branches.length > 0) validateBranches(track, errors);
  return errors;
}

/**
 * validateTrack's crossing checks on one road (the main road's; BR-SCHEMA, PLAN-BRANCH 2.8: each
 * branch's too): the ground corridors of two sections of the road (more than SAME_SECTION walls apart
 * along it) never overlap, and sections whose corridors overlap (gaps included) are more than
 * 2 * LOCAL_WINDOW + SECTION_INDEX_MARGIN segment indices apart. On a closed road "apart along it" and the
 * index difference are the shorter way round; on an open road (a branch's) they never wrap. `coord`
 * names the road's distance in the messages ("s", or "u" on a branch), `prefix` starts each one.
 */
function sectionCrossings(track: Track, errors: string[], coord: string, prefix: string): void {
  const f1 = (v: number) => v.toFixed(1);
  const open = track.roadNo > 0;
  const pieces = corridorPieces(track);
  const n = track.pts.length;
  const indexMin = 2 * LOCAL_WINDOW + SECTION_INDEX_MARGIN;
  const crossings: { a: Piece; b: Piece }[] = [];
  const closeIndex: { a: Piece; b: Piece; di: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      const along = open ? Math.max(b.s0 - a.s1, a.s0 - b.s1) : Math.min(wrapS(track, b.s0 - a.s1), wrapS(track, a.s0 - b.s1));
      if (along < SAME_SECTION * track.wall) continue;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.rad + b.rad) continue;
      if (!quadsOverlap(a.quad, b.quad)) continue;
      if (a.ground && b.ground) crossings.push({ a, b });
      const di = Math.abs(a.seg - b.seg);
      const cyc = open ? di : Math.min(di, n - di);
      if (cyc <= indexMin) closeIndex.push({ a, b, di: cyc });
    }
  }
  // One message per crossing area, not per piece pair.
  const report = <P extends { a: Piece; b: Piece }>(list: P[], msg: (p: P) => string) => {
    const shown: { a: number; b: number }[] = [];
    for (const p of list) {
      const near = (u: number, v: number) => Math.abs(u - v) < SAME_SECTION * track.wall;
      if (shown.some((q) => near(q.a, p.a.s0) && near(q.b, p.b.s0))) continue;
      shown.push({ a: p.a.s0, b: p.b.s0 });
      errors.push(msg(p));
    }
  };
  report(crossings, (p) => `${prefix}ground corridors overlap at ${coord}=${f1(p.a.s0)} and ${coord}=${f1(p.b.s0)} (cover one with a gap)`);
  report(closeIndex, (p) =>
    `${prefix}sections at ${coord}=${f1(p.a.s0)} and ${coord}=${f1(p.b.s0)} come near but are only ${p.di} segments apart (need > ${indexMin})`,
  );
}

// ---- M4-SCHEMA validation: surfaces, obstacles, split lanes ----------------------------

/** Where grid slot `slot` stands in track coordinates (gridSlot's s and lateral offset; s wrapped). */
export function gridSlotSL(track: Track, slot: number): { s: number; lat: number } {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  return { s: wrapS(track, -50 - row * 70 - (side > 0 ? 35 : 0)), lat: side * track.def.halfWidth * 0.45 };
}

/**
 * The bend at sample i: its signed curvature (radians per unit; + = turning right, - = left) from
 * the turn between the segments either side over half their lengths. 0 on a straight.
 */
export function curvatureAt(track: Track, i: number): number {
  const { cum } = track;
  const n = track.pts.length;
  if (track.roadNo > 0 && (i <= 0 || i >= n - 1)) return 0; // an open road's ends (BR-SCHEMA)
  const a = segDir(track, (i - 1 + n) % n), b = segDir(track, i);
  const turn = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  const before = i === 0 ? cum[n] - cum[n - 1] : cum[i] - cum[i - 1];
  return turn / ((before + (cum[i + 1] - cum[i])) / 2 || 1);
}

/** s0, every sample strictly between, and s1: where a check over s0..s1 looks. */
function samplesIn(track: Track, s0: number, s1: number): number[] {
  const out = [s0];
  for (const c of track.cum) if (c > s0 && c < s1) out.push(c);
  if (s1 > s0) out.push(s1);
  return out;
}

/**
 * A feature's extent in track coordinates for the overlap and clearance checks: the rectangle
 * s0..s1 by lat0..lat1 (+-Infinity = the full width), or a circle of radius r at (s, lat) (the
 * rectangle is then its bounding box). Measured in track coordinates, as the features are placed.
 */
interface Foot { what: string; s0: number; s1: number; lat0: number; lat1: number; circle?: { s: number; lat: number; r: number } }

const box = (what: string, s0: number, s1: number, lat0 = -Infinity, lat1 = Infinity): Foot => ({ what, s0, s1, lat0, lat1 });
const round = (what: string, s: number, lat: number, r: number): Foot => ({ what, s0: s - r, s1: s + r, lat0: lat - r, lat1: lat + r, circle: { s, lat, r } });
const clampTo = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Do two feet overlap (touching is not overlapping)? */
function feetOverlap(a: Foot, b: Foot): boolean {
  if (!(a.s0 < b.s1 && b.s0 < a.s1 && a.lat0 < b.lat1 && b.lat0 < a.lat1)) return false;
  const ca = a.circle, cb = b.circle;
  if (ca && cb) return Math.hypot(ca.s - cb.s, ca.lat - cb.lat) < ca.r + cb.r;
  const c = ca ?? cb;
  if (!c) return true;
  const r = ca ? b : a;
  return Math.hypot(c.s - clampTo(c.s, r.s0, r.s1), c.lat - clampTo(c.lat, r.lat0, r.lat1)) < c.r;
}

/** Distance from a foot's edge to the point (s, lat), the nearer way round the lap (0 inside). */
function footDist(track: Track, f: Foot, s: number, lat: number): number {
  let best = Infinity;
  for (const v of track.roadNo > 0 ? [s] : [s - track.length, s, s + track.length]) {
    const d = f.circle
      ? Math.hypot(v - f.circle.s, lat - f.circle.lat) - f.circle.r
      : Math.hypot(v - clampTo(v, f.s0, f.s1), lat - clampTo(lat, f.lat0, f.lat1));
    best = Math.min(best, Math.max(0, d));
  }
  return best;
}

/**
 * The widest stretch of asphalt across the road at s with no water, no oil (THEME-SCHEMA, advisor
 * change 6) and no static solid on it (islands, tyre mounds, trucks): the dry lane a pool or an oil
 * slick in a bend must leave.
 */
function widestDry(track: Track, s: number): number {
  const blocked: [number, number][] = [];
  for (const w of track.water) if (s >= w.s0 && s <= w.s1) blocked.push([w.lat0, w.lat1]);
  for (const o of track.oil) if (s >= o.s0 && s <= o.s1) blocked.push([o.lat0, o.lat1]);
  for (const i of track.islands) if (s >= i.s0 && s <= i.s1) blocked.push([i.lat0, i.lat1]);
  for (const t of track.tyres) {
    const ds = Math.abs(s - t.s);
    if (ds < t.r) {
      const half = Math.sqrt(t.r * t.r - ds * ds);
      blocked.push([t.lat - half, t.lat + half]);
    }
  }
  for (const t of track.trucks) if (s >= t.s && s <= t.s + t.len) blocked.push([t.lat - TRUCK_HALF, t.lat + TRUCK_HALF]);
  blocked.sort((p, q) => p[0] - q[0]);
  const lo = -halfAt(track, s, -1), hi = halfAt(track, s, 1);
  let at = lo, widest = 0;
  for (const [a, b] of blocked) {
    if (a > at) widest = Math.max(widest, Math.min(a, hi) - at);
    at = Math.max(at, b);
    if (at >= hi) break;
  }
  return Math.max(widest, hi - at);
}

/** How far the road's heading turns (radians, the most) between s0 and anywhere up to s1. */
function turnOver(track: Track, s0: number, s1: number): number {
  const h0 = pointAt(track, s0).h;
  let most = 0;
  for (const s of samplesIn(track, s0, s1)) {
    const d = pointAt(track, s).h - h0;
    most = Math.max(most, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
  }
  return most;
}

/**
 * A solid across lat0..lat1 over s0..s1 (a press, a truck's body): the first gap beside it, between a
 * side and the wall (or an island beside it, sharing that s), that is wider than 0 (it reaches) but
 * narrower than `min`, at any sample s0..s1; null if none.
 */
function sideGap(track: Track, s0: number, s1: number, lat0: number, lat1: number, min: number): { gap: number; s: number } | null {
  for (const s of samplesIn(track, s0, s1)) {
    const isle = track.islands.find((i) => s >= i.s0 && s <= i.s1);
    const left = isle && isle.lat1 <= lat0 ? lat0 - isle.lat1 : lat0 + wallAt(track, s, -1);
    const right = isle && isle.lat0 >= lat1 ? isle.lat0 - lat1 : wallAt(track, s, 1) - lat1;
    for (const g of [left, right]) if (g > 1e-9 && g < min) return { gap: g, s };
  }
  return null;
}

/**
 * The structural checks of the M4-SCHEMA features (validateTrack runs them; behavioural checks such
 * as run-ups through water and the bots' lane costs are M4-SURF's):
 * - Ranges: rectangles have s1 > s0 and lat1 > lat0 and stay inside the walls; tyre mounds have
 *   r in TYRES_R_MIN..TYRES_R_MAX; barrels n 1..BARRELS_MAX, whole ticks, |speed| in range, a cycle of
 *   a crossing plus at least one tick in the gutter, and rows that do not overlap; a truck's length in range and its body
 *   inside the walls; a press's cycle in whole ticks with the warning inside the up time; a belt's
 *   drift 0 < |vx| <= BELT_MAX, its length >= BELT_LEN_MIN, and no wall-to-wall belt in a bend (the
 *   road turns more than POOL_STRAIGHT_TOLERANCE over it: on its inside the arrows would reach past
 *   its end; M4-SURF); a widen at least 2 * WIDEN_TAPER long, left and right >= 0, not both 0.
 *   All off the start zone and inside 0..length (as every feature).
 * - Overlaps: surfaces (water, dirt, belts) do not overlap each other; solids (tyre mounds, barrel
 *   rows, trucks, presses, islands) do not overlap each other, a hole, a gap, a ramp or its take-off
 *   zone, or a ground cell; widens do not overlap each other, a ramp (take-off zone included) or a gap.
 * - Split lanes: an island leaves a lane of at least LANE_MIN either side, at every s it covers; it
 *   is at least ISLAND_NOSE wide and 2 * ISLAND_NOSE long (its noses fit). The run-ups through a split
 *   are driven once per lane (validateRunUps in shared/weapons.ts). Its noses lie inside its
 *   rectangle, so the solids' clearances below hold for them too.
 * - Widen in a bend (PLAN-M4 advisor change 13): where a widen widens the inside of a bend, the
 *   farthest a car centre goes there (the wall less half a car's width, as physics wallLimit) stays
 *   below the local radius, or nearest() degenerates.
 * - Solids keep SOLID_CLEAR from every recovery point and from every grid slot.
 * - No water on a take-off zone (a ramp's, or a truck's band) or on a recovery point (a car put back
 *   there would touch it).
 * - A pool leaves a dry lane of at least DRY_LANE_MIN at every s it covers, or lies on a straight
 *   (the road turns less than POOL_STRAIGHT_TOLERANCE over it).
 * - THEME-SCHEMA (PLAN-THEMES 2.3, advisor changes 6 and 10), the theme surfaces: each only on its own
 *   theme's tracks (sand desert, oil city or harbour, ford jungle; themeOf, a branch's road its track's); inside
 *   the asphalt (the declared rectangle, at every sample: the verge rule); one surface at a time with
 *   the others; water's rules (off take-off zones and recovery points); sand <= SAND_LEN_MAX, and so is
 *   a stretch of sand and dirt less than LOOSE_JOIN apart; oil <= OIL_LEN_MAX with water's dry-lane-or-
 *   straight rule (widestDry blocks water and oil alike); a ford FORD_LEN_MIN..FORD_LEN_MAX long, its
 *   drift FORD_VX_MIN..FORD_VX_MAX either way, on a straight, no solid beside it or within FORD_CLEAR
 *   past it.
 */
function validateSchema(track: Track, errors: string[], zone: (what: string, lo: number, hi: number) => void): void {
  const f1 = (v: number) => v.toFixed(1);
  const span = (s0: number, s1: number) => `${f1(s0)}..${f1(s1)}`;
  const inside = (what: string, s0: number, s1: number, lat0: number, lat1: number) => {
    for (const s of samplesIn(track, s0, s1)) {
      if (lat0 < -wallAt(track, s, -1) || lat1 > wallAt(track, s, 1)) {
        errors.push(`${what}: reaches past the wall at s=${f1(s)}`);
        return;
      }
    }
  };
  const rect = (what: string, r: { s0: number; s1: number; lat0: number; lat1: number }) => {
    if (!(r.s1 > r.s0)) errors.push(`${what}: s1 must be > s0`);
    if (!(r.lat1 > r.lat0)) errors.push(`${what}: lat1 must be > lat0`);
    zone(what, r.s0, r.s1);
    inside(what, r.s0, r.s1, r.lat0, r.lat1);
    return box(what, r.s0, r.s1, r.lat0, r.lat1);
  };

  // Surfaces.
  const surfaces: Foot[] = [];
  for (const w of track.water) surfaces.push(rect(`water ${span(w.s0, w.s1)}`, w));
  for (const d of track.dirt) surfaces.push(rect(`dirt ${span(d.s0, d.s1)}`, d));
  for (const b of track.belts) {
    const what = `belt ${span(b.s0, b.s1)}`;
    if (!(Math.abs(b.vx) > 0 && Math.abs(b.vx) <= BELT_MAX)) errors.push(`${what}: drift vx ${b.vx} outside 0 < |vx| <= ${BELT_MAX}`);
    // M4-SURF (the M4-WORLD re-check's finding 1): on the inside of a bend a belt's arrows reach
    // past its end when it is very short or runs wall to wall.
    if (!(b.s1 - b.s0 >= BELT_LEN_MIN)) errors.push(`${what}: ${f1(b.s1 - b.s0)} long, shorter than ${BELT_LEN_MIN}`);
    else {
      const wallToWall = samplesIn(track, b.s0, b.s1).some((s) => b.lat0 <= -wallAt(track, s, -1) && b.lat1 >= wallAt(track, s, 1));
      const turn = wallToWall ? turnOver(track, b.s0, b.s1) : 0;
      if (wallToWall && turn > POOL_STRAIGHT_TOLERANCE) errors.push(`${what}: runs wall to wall in a bend (the road turns ${turn.toFixed(3)} rad over it; its inside's arrows would reach past its end)`);
    }
    surfaces.push(rect(what, b));
  }
  // THEME-SCHEMA (PLAN-THEMES 2.3, advisor changes 6 and 10): the theme surfaces. Each only on its own
  // theme's tracks, oil on a city or a harbour one (THEME_OF_SURFACE; HARBOUR-SCHEMA, Amendment 1) (themeOf:
  // a branch's road carries its track's theme; the theme-less yards and the shipped tracks are the
  // scrapyard, which has none). The verge rule (advisor change 6): the declared
  // rectangle lies inside the asphalt at every sample, so a car only ever feels one on the asphalt (its
  // traction rectangle is PUDDLE_TRACTION_INSET further in) and it never stacks with the verge's dirt
  // drag. One surface at a time with water, dirt and belts (the overlap check below). Their lengths
  // here; water's rules for all three and the ford's clearance further down.
  const theme = themeOf(track.def);
  const themed = (kind: keyof typeof THEME_OF_SURFACE, what: string, f: Sand | Oil | Ford) => {
    const want = THEME_OF_SURFACE[kind];
    if (!want.includes(theme)) errors.push(`${what}: ${kind} lies only on a ${want.join(" or ")} track (this one is ${theme})`);
    for (const s of samplesIn(track, f.s0, f.s1)) {
      if (f.lat0 < -halfAt(track, s, -1) || f.lat1 > halfAt(track, s, 1)) {
        errors.push(`${what}: reaches past the asphalt at s=${f1(s)} (a theme surface lies inside the asphalt, lat ${f1(-halfAt(track, s, -1))}..${f1(halfAt(track, s, 1))} there)`);
        break;
      }
    }
    surfaces.push(rect(what, f));
  };
  for (const f of track.sand) {
    const what = `sand ${span(f.s0, f.s1)}`;
    if (!(f.s1 - f.s0 <= SAND_LEN_MAX)) errors.push(`${what}: ${f1(f.s1 - f.s0)} long, longer than ${SAND_LEN_MAX} (the mud rule)`);
    themed("sand", what, f);
  }
  // The mud rule for a stretch (adopted advisor suggestion): sand and the dirt it runs into, LOOSE_JOIN.
  const loose = [...track.sand.map((f) => ({ s0: f.s0, s1: f.s1, sand: true })), ...track.dirt.map((f) => ({ s0: f.s0, s1: f.s1, sand: false }))].sort((a, b) => a.s0 - b.s0);
  for (let i = 0; i < loose.length; ) {
    let j = i, hi = loose[i].s1, sand = loose[i].sand;
    while (j + 1 < loose.length && loose[j + 1].s0 < hi + LOOSE_JOIN) {
      j++;
      hi = Math.max(hi, loose[j].s1);
      sand ||= loose[j].sand;
    }
    const lo = loose[i].s0;
    if (sand && j > i && hi - lo > SAND_LEN_MAX) {
      errors.push(`sand and dirt ${span(lo, hi)}: ${j - i + 1} patches less than ${LOOSE_JOIN} apart, one stretch of loose ground ${f1(hi - lo)} long, longer than ${SAND_LEN_MAX} (the mud rule)`);
    }
    i = j + 1;
  }
  for (const f of track.oil) {
    const what = `oil ${span(f.s0, f.s1)}`;
    if (!(f.s1 - f.s0 <= OIL_LEN_MAX)) errors.push(`${what}: ${f1(f.s1 - f.s0)} long, longer than ${OIL_LEN_MAX}`);
    themed("oil", what, f);
  }
  for (const f of track.fords) {
    const what = `ford ${span(f.s0, f.s1)}`;
    const len = f.s1 - f.s0;
    if (!(len >= FORD_LEN_MIN && len <= FORD_LEN_MAX)) errors.push(`${what}: ${f1(len)} long, outside ${FORD_LEN_MIN}..${FORD_LEN_MAX}`);
    if (!(Math.abs(f.vx) >= FORD_VX_MIN && Math.abs(f.vx) <= FORD_VX_MAX)) errors.push(`${what}: drift vx ${f.vx} outside ${FORD_VX_MIN} <= |vx| <= ${FORD_VX_MAX}`);
    const turn = turnOver(track, f.s0, f.s1);
    if (turn > POOL_STRAIGHT_TOLERANCE) errors.push(`${what}: not on a straight (the road turns ${turn.toFixed(3)} rad over it, more than ${POOL_STRAIGHT_TOLERANCE})`);
    themed("ford", what, f);
  }

  // Solids.
  const solids: Foot[] = [];
  for (const t of track.tyres) {
    const what = `tyres at s=${f1(t.s)}`;
    if (!(t.r >= TYRES_R_MIN && t.r <= TYRES_R_MAX)) errors.push(`${what}: radius ${t.r} outside ${TYRES_R_MIN}..${TYRES_R_MAX}`);
    zone(what, t.s - t.r, t.s + t.r);
    inside(what, t.s - t.r, t.s + t.r, t.lat - t.r, t.lat + t.r);
    solids.push(round(what, t.s, t.lat, t.r));
  }
  for (const b of track.barrels) {
    const what = `barrels at s=${f1(b.s)}`;
    const speed = Math.abs(b.speed);
    if (!(Number.isInteger(b.n) && b.n >= 1 && b.n <= BARRELS_MAX)) errors.push(`${what}: n ${b.n} is not a whole number 1..${BARRELS_MAX}`);
    if (!(Number.isInteger(b.period) && b.period >= 1)) errors.push(`${what}: period ${b.period} is not a whole number of ticks`);
    if (!(speed >= BARREL_SPEED_MIN && speed <= BARREL_SPEED_MAX)) errors.push(`${what}: speed ${b.speed} outside ${BARREL_SPEED_MIN}..${BARREL_SPEED_MAX} (either way)`);
    // The cycle covers a crossing and at least one tick in the gutter: the last tick of the cycle is
    // past the far wall (barrelLat's own test), so a barrel never jumps straight from wall to wall.
    else if (Number.isInteger(b.period) && b.period >= 1 && !(((b.period - 1) * speed) / TICKS_PER_S > b.lat1 - b.lat0)) {
      errors.push(`${what}: period ${b.period} leaves no tick in the gutter (a crossing takes ${f1(b.roll)} ticks)`);
    }
    if (!((speed * Math.floor(b.period / b.n)) / TICKS_PER_S >= 2 * BARREL_R)) errors.push(`${what}: the barrels of the row overlap each other (period / n too short)`);
    zone(what, b.s - BARREL_R, b.s + BARREL_R);
    solids.push(box(what, b.s - BARREL_R, b.s + BARREL_R));
  }
  for (const t of track.trucks) {
    const what = `truck at s=${f1(t.s)}`;
    if (!(t.len >= TRUCK_LEN_MIN && t.len <= TRUCK_LEN_MAX)) errors.push(`${what}: length ${t.len} outside ${TRUCK_LEN_MIN}..${TRUCK_LEN_MAX}`);
    zone(what, t.s, t.s + t.len);
    inside(what, t.s, t.s + t.len, t.lat - TRUCK_HALF, t.lat + TRUCK_HALF);
    // M4-MOVE review F4: each side of its body reaches the wall (or an island beside it) or leaves
    // TRUCK_SIDE_GAP: a narrower gap is a dead end, or a squeeze that leaves a car overlapping the body.
    const gap = sideGap(track, t.s, t.s + t.len, t.lat - TRUCK_HALF, t.lat + TRUCK_HALF, TRUCK_SIDE_GAP);
    if (gap) errors.push(`${what}: leaves a gap of ${f1(gap.gap)} beside it at s=${f1(gap.s)} (a side reaches the wall or an island, or leaves >= ${TRUCK_SIDE_GAP})`);
    solids.push(box(what, t.s, t.s + t.len, t.lat - TRUCK_HALF, t.lat + TRUCK_HALF));
  }
  for (const p of track.presses) {
    const what = `press at s=${f1(p.s)}`;
    if (!(Number.isInteger(p.period) && Number.isInteger(p.down) && p.down >= 1 && p.period - p.down >= PRESS_WARN_TICKS)) {
      errors.push(`${what}: period ${p.period} / down ${p.down} must be whole ticks, down >= 1, and leave the ${PRESS_WARN_TICKS}-tick warning inside the up time`);
    }
    if (!(p.lat1 > p.lat0)) errors.push(`${what}: lat1 must be > lat0`);
    zone(what, p.s - PRESS_DEPTH / 2, p.s + PRESS_DEPTH / 2);
    inside(what, p.s - PRESS_DEPTH / 2, p.s + PRESS_DEPTH / 2, p.lat0, p.lat1);
    // M4-MOVE: each side of it reaches the wall (or an island beside it) or leaves a car room to pass:
    // a gap narrower than PRESS_SIDE_GAP would hold a car between the slab and the wall while it is down.
    const gap = sideGap(track, p.s - PRESS_DEPTH / 2, p.s + PRESS_DEPTH / 2, p.lat0, p.lat1, PRESS_SIDE_GAP);
    if (gap) errors.push(`${what}: leaves a gap of ${f1(gap.gap)} beside it at s=${f1(gap.s)} (a side reaches the wall or an island, or leaves >= ${PRESS_SIDE_GAP})`);
    solids.push(box(what, p.s - PRESS_DEPTH / 2, p.s + PRESS_DEPTH / 2, p.lat0, p.lat1));
  }
  for (const i of track.islands) {
    const what = `island ${span(i.s0, i.s1)}`;
    solids.push(rect(what, i));
    // Its noses (M4-SURF part 2): ISLAND_NOSE deep at either end, across its whole width.
    if (!(i.lat1 - i.lat0 >= ISLAND_NOSE)) errors.push(`${what}: ${f1(i.lat1 - i.lat0)} wide, narrower than its noses (${ISLAND_NOSE})`);
    if (!(i.s1 - i.s0 >= 2 * ISLAND_NOSE)) errors.push(`${what}: ${f1(i.s1 - i.s0)} long, shorter than its two noses (${2 * ISLAND_NOSE})`);
    // Split lanes: asphalt edge to island, either side, at every s the island covers.
    for (const [side, name] of [[-1, "left"], [1, "right"]] as const) {
      for (const s of samplesIn(track, i.s0, i.s1)) {
        const lane = side < 0 ? i.lat0 + halfAt(track, s, -1) : halfAt(track, s, 1) - i.lat1;
        if (!(lane >= LANE_MIN)) {
          errors.push(`${what}: the ${name} lane is ${f1(lane)} wide at s=${f1(s)} (a split lane is >= ${LANE_MIN})`);
          break;
        }
      }
    }
  }

  // Widens (BR-SCHEMA: a branch's mouths are widens buildTrack makes, not the def's: not checked here).
  const widens: Foot[] = [];
  for (const w of track.roadNo > 0 ? track.widens.filter((x) => !isMouth(x)) : track.widens) {
    const what = `widen ${span(w.s0, w.s1)}`;
    if (!(w.s1 - w.s0 >= 2 * WIDEN_TAPER)) errors.push(`${what}: shorter than its two tapers (${2 * WIDEN_TAPER})`);
    if (!(w.left >= 0 && w.right >= 0 && w.left + w.right > 0)) errors.push(`${what}: left ${w.left} / right ${w.right} must be >= 0 and not both 0`);
    zone(what, w.s0, w.s1);
    widens.push(box(what, w.s0, w.s1));
    // Advisor change 13: on the widened inside of a bend, every car centre stays inside the bend's
    // radius. A centre goes as far as the wall less half a car (physics wallLimit), verge included.
    for (let i = 0; i < track.pts.length; i++) {
      const s = track.cum[i];
      if (s < w.s0 || s > w.s1) continue;
      const k = curvatureAt(track, i);
      const side = k > 0 ? 1 : -1; // the inside of the bend
      if (k === 0 || widenAt(track, s, side) <= 0) continue;
      const wall = side > 0 ? track.wallR[i] : track.wallL[i];
      const reach = wall - CAR_HALF_WID;
      if (!(reach < 1 / Math.abs(k))) {
        errors.push(`${what}: a car centre reaches ${f1(reach)} (the wall ${f1(wall)} less half a car) on the inside of the bend at s=${f1(s)}, not below the local radius ${f1(1 / Math.abs(k))} (nearest() degenerates)`);
        break;
      }
    }
  }

  // Overlaps.
  const jumps: Foot[] = [
    ...track.gaps.map((g) => box(`gap ${span(g.s0, g.s1)}`, g.s0, g.s1)),
    ...track.ramps.map((r) => box(`ramp at s=${f1(r.s)}`, r.s, r.s + r.len + LIP_ZONE)),
  ];
  const hazards: Foot[] = [
    ...jumps,
    ...track.holes.map((h) => round(`hole at s=${f1(h.s)}`, h.s, h.lat, h.r)),
    ...track.cells.filter((c) => !c.air && c.road === undefined).map((c) => round(`ground cell at s=${f1(c.s)}`, c.s, c.lat, CELL_EDGE)),
  ];
  const among = (list: Foot[], why: string) => {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (feetOverlap(list[i], list[j])) errors.push(`${list[i].what} overlaps ${list[j].what}${why}`);
  };
  const across = (list: Foot[], others: Foot[], why: string) => {
    for (const a of list) for (const b of others) if (feetOverlap(a, b)) errors.push(`${a.what} overlaps ${b.what}${why}`);
  };
  among(surfaces, " (one surface at a time)");
  among(solids, "");
  // M4-MOVE: room along the track round what moves, so a car is only ever squeezed against a wall.
  // A barrel row keeps MOVER_CLEAR (s to s, edge to edge) from every other solid, islands included
  // (a car pushed along the road out of a row lands on open road); a press keeps it from every other
  // solid but an island BESIDE it, one whose s range overlaps the press's (a car under a press is pushed
  // along the road, never across); an island before or past a press keeps MOVER_CLEAR (M4-MOVE review
  // F1: 18 before an island's nose, a car pushed out of the slab was pushed back in by the nose).
  const ranges: { what: string; s0: number; s1: number; island: boolean; mover: number }[] = [
    ...track.tyres.map((m) => ({ what: `tyres at s=${f1(m.s)}`, s0: m.s - m.r, s1: m.s + m.r, island: false, mover: 0 })),
    ...track.trucks.map((t) => ({ what: `truck at s=${f1(t.s)}`, s0: t.s, s1: t.s + t.len, island: false, mover: 0 })),
    ...track.islands.map((i) => ({ what: `island ${span(i.s0, i.s1)}`, s0: i.s0, s1: i.s1, island: true, mover: 0 })),
    ...track.barrels.map((b) => ({ what: `barrels at s=${f1(b.s)}`, s0: b.s - BARREL_R, s1: b.s + BARREL_R, island: false, mover: 1 })),
    ...track.presses.map((p) => ({ what: `press at s=${f1(p.s)}`, s0: p.s - PRESS_DEPTH / 2, s1: p.s + PRESS_DEPTH / 2, island: false, mover: 2 })),
  ];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = 0; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      if (i === j || a.mover === 0 || (b.mover !== 0 && j < i)) continue; // each pair once
      if (a.mover === 2 && b.island && b.s0 < a.s1 && a.s0 < b.s1) continue; // a press beside an island (they share s): exempt; before or past one: not
      const gap = Math.max(b.s0 - a.s1, a.s0 - b.s1);
      if (gap < MOVER_CLEAR) errors.push(`${a.what}: ${f1(Math.max(0, gap))} along the track from ${b.what} (what moves keeps >= ${MOVER_CLEAR} along the track from other solids)`);
    }
  }
  across(solids, hazards, "");
  // THEME-SCHEMA: no solid beside a ford or within FORD_CLEAR past it, across the whole road.
  for (const f of track.fords) {
    const reach = box("", f.s0, f.s1 + FORD_CLEAR);
    for (const x of solids) {
      if (feetOverlap(reach, x)) errors.push(`ford ${span(f.s0, f.s1)}: ${x.what} lies beside it or within ${FORD_CLEAR} past it (no solid there: its drift carries a car out of it sideways)`);
    }
  }
  among(widens, "");
  across(widens, jumps, " (a widened road has no jumps)");

  // Clearances of solids: recovery points (on the centerline) and grid slots.
  for (const f of solids) {
    for (const r of track.recovery) {
      const d = footDist(track, f, r, 0);
      if (d < SOLID_CLEAR) errors.push(`${f.what}: ${f1(d)} from recovery point s=${f1(r)} (solids keep >= ${SOLID_CLEAR})`);
    }
    for (let k = 0; track.roadNo === 0 && k < GRID_SLOTS; k++) {
      const g = gridSlotSL(track, k);
      const d = footDist(track, f, g.s, g.lat);
      if (d < SOLID_CLEAR) errors.push(`${f.what}: ${f1(d)} from grid slot ${k} (solids keep >= ${SOLID_CLEAR})`);
    }
  }

  // Water: off take-off zones and recovery points; a dry lane, or on a straight. THEME-SCHEMA (PLAN-THEMES
  // 2.3, advisor change 6): water's rules for the theme surfaces too, after water's (so a track without
  // them reports as before): sand, oil and fords off take-off zones and recovery points; oil leaves a
  // dry lane (water and oil both count as blocked there, widestDry) or lies on a straight (a ford is on
  // one already).
  const wet: { what: string; w: Water | Sand | Oil | Ford; dry: boolean }[] = [
    ...track.water.map((w) => ({ what: `water ${span(w.s0, w.s1)}`, w, dry: true })),
    ...track.sand.map((w) => ({ what: `sand ${span(w.s0, w.s1)}`, w, dry: false })),
    ...track.oil.map((w) => ({ what: `oil ${span(w.s0, w.s1)}`, w, dry: true })),
    ...track.fords.map((w) => ({ what: `ford ${span(w.s0, w.s1)}`, w, dry: false })),
  ];
  for (const { what, w, dry: needsDry } of wet) {
    const pool = box(what, w.s0, w.s1, w.lat0, w.lat1);
    for (const r of track.ramps) {
      if (feetOverlap(pool, box("", r.s + r.len, r.s + r.len + LIP_ZONE))) errors.push(`${what}: on the take-off zone of the ramp at s=${f1(r.s)}`);
    }
    for (const t of track.trucks) {
      if (feetOverlap(pool, box("", t.lip, t.lip + LIP_ZONE, t.band0, t.band1))) errors.push(`${what}: on the take-off zone of the truck at s=${f1(t.s)}`);
    }
    for (const r of track.recovery) {
      const car = box("", w.s0 - CAR_HALF_LEN, w.s1 + CAR_HALF_LEN, w.lat0 - CAR_HALF_WID, w.lat1 + CAR_HALF_WID);
      if (footDist(track, car, r, 0) === 0) errors.push(`${what}: on recovery point s=${f1(r)} (a car put back there touches it)`);
    }
    for (const s of needsDry ? samplesIn(track, w.s0, w.s1) : []) {
      const dry = widestDry(track, s);
      if (dry >= DRY_LANE_MIN) continue;
      const turn = turnOver(track, w.s0, w.s1);
      if (turn > POOL_STRAIGHT_TOLERANCE) {
        errors.push(`${what}: no dry lane of ${DRY_LANE_MIN} at s=${f1(s)} (the widest is ${f1(dry)}) and not on a straight (the road turns ${turn.toFixed(3)} rad over it)`);
      }
      break;
    }
  }
}

// ---- BR-SCHEMA: shortcut roads (PLAN-BRANCH.md 2.1-2.5, 2.8; advisor changes 1, 2, 3, 7) ----------
// A branch is an open road with the Track shape (PlacedBranch.road). Global segments: the main road's
// 0..n-1, then each branch's from its base. Nothing drives on a branch yet (BR-PHYS) and nothing draws
// it (BR-BAKE): this is the data, its queries and its validation. A track without a branch never runs
// any of this (buildTrack, validateTrack and every query take today's path).

/** A branch's mouth as buildTrack widens it to the main road's width (a def's own widens have no `mouth`). */
interface MouthWiden extends Widen { mouth: true }

function isMouth(w: Widen): boolean {
  return (w as Partial<MouthWiden>).mouth === true;
}

/** buildTrack's branches, once the main road is built: their roads, the gores' noses in both roads' buckets, the cells, mouthAt. */
function buildBranches(main: Track, defs: readonly Branch[]): void {
  let base = main.pts.length;
  for (const bd of defs) {
    const b = buildBranch(main, bd, main.branches.length + 1, base);
    main.branches.push(b);
    base += segCount(b.road);
  }
  for (const b of main.branches) {
    for (const g of [b.forkGore, b.mergeGore]) {
      if (g === null) continue;
      addNose(main, g.noseMain);
      addNose(b.road, g.noseBranch);
    }
    // The branch's cells after the main road's (the snapshot's order: shipped indices never move).
    for (const c of b.road.cells) main.cells.push({ ...c, seg: b.base + c.seg, road: b.road.roadNo });
  }
  main.mouthAt = buildMouthAt(main);
}

/** Where a mouth's walk from the fork (or back from the merge) first finds the centrelines 2 * the mouth's wall apart. */
interface GoreAt { u: number; s: number; x: number; y: number; angle: number; seg: number; lat: number }

/**
 * Walk the branch's samples from `from` in direction `dir` (+1 from the fork, -1 back from the merge),
 * each one's projection onto the main road (a search round the last one's segment, as a car's), up to
 * the first sample 2 * main.wall from the main centreline: the gore lies between it and the one before
 * (the distance taken linear in between). proj[j]: the main s of sample j (NaN where not walked).
 */
function mouthWalk(main: Track, pts: readonly Vec[], cum: readonly number[], from: number, dir: number, hint: number): { proj: number[]; gore: GoreAt | null } {
  const proj: number[] = pts.map(() => NaN);
  const two = 2 * main.wall;
  let prev = -1, prevD = 0;
  for (let j = from; j >= 0 && j < pts.length; j += dir) {
    const q = queryTrackNear(main, pts[j].x, pts[j].y, hint);
    hint = q.seg;
    proj[j] = q.s;
    if (q.dist >= two && prev >= 0) {
      const t = (two - prevD) / (q.dist - prevD || 1);
      const u = cum[prev] + (cum[j] - cum[prev]) * t;
      const x = pts[prev].x + (pts[j].x - pts[prev].x) * t, y = pts[prev].y + (pts[j].y - pts[prev].y) * t;
      const g = queryTrackNear(main, x, y, hint);
      const lo = Math.min(prev, j);
      const bh = Math.atan2(pts[lo + 1].y - pts[lo].y, pts[lo + 1].x - pts[lo].x);
      const md = segDir(main, g.seg);
      const dh = bh - Math.atan2(md.y, md.x);
      // The nose: half-way from the main centreline to the branch's.
      return {
        proj,
        gore: { u, s: g.s, x: x - (g.nx * g.dist) / 2, y: y - (g.ny * g.dist) / 2, angle: Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))), seg: g.seg, lat: (g.side * g.dist) / 2 },
      };
    }
    prev = j;
    prevD = q.dist;
  }
  return { proj, gore: null };
}

/** One branch's open road, its gores and mapS (buildBranches). */
function buildBranch(main: Track, bd: Branch, roadNo: number, base: number): PlacedBranch {
  const g0 = pointAt(main, bd.s0 - BRANCH_GUIDE), f = pointAt(main, bd.s0), m = pointAt(main, bd.s1), g1 = pointAt(main, bd.s1 + BRANCH_GUIDE);
  // The open Catmull-Rom curve through main(s0 - BRANCH_GUIDE), main(s0), the control points, main(s1),
  // main(s1 + BRANCH_GUIDE), from main(s0) to main(s1) (its first and last points exactly those).
  const c: [number, number][] = [[g0.x, g0.y], [f.x, f.y], ...bd.control, [m.x, m.y], [g1.x, g1.y]];
  const pts: Vec[] = [];
  for (let i = 1; i + 2 < c.length; i++) {
    const p0 = c[i - 1], p1 = c[i], p2 = c[i + 1], p3 = c[i + 2];
    for (let k = 0; k < SAMPLES_PER_SEGMENT; k++) {
      const t = k / SAMPLES_PER_SEGMENT;
      pts.push({ x: catmull(p0[0], p1[0], p2[0], p3[0], t), y: catmull(p0[1], p1[1], p2[1], p3[1], t) });
    }
  }
  pts.push({ x: m.x, y: m.y });
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const length = cum[pts.length - 1];
  const fw = mouthWalk(main, pts, cum, 0, 1, f.seg), mw = mouthWalk(main, pts, cum, pts.length - 1, -1, m.seg);
  const fg = fw.gore, mg = mw.gore;
  // mapS: the projection inside each mouth, linear between the gores (fork and merge exactly s0 and s1).
  const u0 = fg ? fg.u : 0, sA = fg ? fg.s : bd.s0, u1 = mg ? mg.u : length, sB = mg ? mg.s : bd.s1;
  const mapS = cum.map((u, j) => {
    if (j === 0) return bd.s0;
    if (j === pts.length - 1) return bd.s1;
    if (fg && u <= fg.u) return fw.proj[j];
    if (mg && u >= mg.u) return mw.proj[j];
    return sA + ((u - u0) * (sB - sA)) / (u1 - u0 || 1);
  });
  // The mouths (PLAN-BRANCH 2.3): the main road's half-width on both sides from the fork to the gore,
  // then the branch's own over WIDEN_TAPER (and back before the merge): widens of the branch's road, so
  // halfOf / wallOf read its per-sample walls (advisor change 2: a road without widens reads the constants).
  const e = main.def.halfWidth - bd.halfWidth;
  const mouths: MouthWiden[] = fg && mg
    ? [
        { k: "widen", s0: -WIDEN_TAPER, s1: fg.u + WIDEN_TAPER, left: e, right: e, mouth: true },
        { k: "widen", s0: mg.u - WIDEN_TAPER, s1: length + WIDEN_TAPER, left: e, right: e, mouth: true },
      ]
    : [{ k: "widen", s0: -WIDEN_TAPER, s1: length + WIDEN_TAPER, left: e, right: e, mouth: true }]; // the corridors never part (validateTrack says so)
  const def: TrackDef = {
    id: `${main.def.id}/branch-${roadNo}`, name: `${main.def.name} shortcut ${roadNo}`, control: bd.control, halfWidth: bd.halfWidth, verge: main.def.verge,
    features: bd.features, recovery: bd.recovery,
    // THEME-SCHEMA: a branch's road carries its track's theme (validateTrack's gating of its theme surfaces).
    ...(main.def.theme !== undefined ? { theme: main.def.theme } : {}),
  };
  const road = newRoad(def, pts, cum, length, roadNo);
  placeFeatures(road, bd.features ?? [], bd.recovery ?? [], mouths);
  const gore = (g: GoreAt | null): PlacedGore | null => {
    if (g === null) return null;
    const qb = queryTrackNear(road, g.x, g.y, pointAt(road, g.u).seg);
    return {
      u: g.u, s: g.s, x: g.x, y: g.y, angle: g.angle,
      noseMain: { k: "tyres", s: g.s, lat: g.lat, r: GORE_NOSE_R, x: g.x, y: g.y, seg: g.seg },
      noseBranch: { k: "tyres", s: qb.s, lat: qb.lat, r: GORE_NOSE_R, x: g.x, y: g.y, seg: qb.seg },
    };
  };
  return { road, base, s0: bd.s0, s1: bd.s1, side: bd.side, forkGore: gore(fg), mergeGore: gore(mg), mapS };
}

/** A gore's nose into a road's tyre buckets: every segment it reaches by buildBuckets' rule for mounds (moundNear). */
function addNose(track: Track, nose: PlacedTyres): void {
  const at = track.tyresAt as PlacedTyres[][];
  const normals = track.pts.map((_, i) => vertexNormal(track, i));
  for (let i = 0; i < segCount(track); i++) {
    if (!moundNear(track, segQuad(track, i, normals), track.cum[i], track.cum[i + 1], nose)) continue;
    at[i] = at[i].length > 0 ? [...at[i], nose] : [nose];
  }
}

/**
 * A mouth's search windows (mouthAt): for one end of a branch, the main segments i0..i1 (not wrapped:
 * may run below 0 or past n - 1) and the branch's segments j0..j1 that overlap the mouth, each widened
 * by LOCAL_WINDOW (the branch's clamped to its own).
 */
interface MouthZone { branch: number; end: string; i0: number; i1: number; j0: number; j1: number }

function mouthZones(main: Track): MouthZone[] {
  const out: MouthZone[] = [];
  const n = main.pts.length, W = LOCAL_WINDOW;
  main.branches.forEach((b, k) => {
    const r = b.road, m = segCount(r);
    const fg = b.forkGore, mg = b.mergeGore;
    const ends: [string, number, number, number, number][] = fg && mg
      ? [["fork", b.s0, fg.s, 0, fg.u], ["merge", mg.s, b.s1, mg.u, r.length]]
      : [["fork and merge", b.s0, b.s1, 0, r.length]];
    for (const [end, lo, hi, u0, u1] of ends) {
      let i0 = -1, i1 = -1, j0 = -1, j1 = -1;
      for (let i = 0; i < n; i++) {
        if (main.cum[i] < hi && main.cum[i + 1] > lo) {
          if (i0 < 0) i0 = i;
          i1 = i;
        }
      }
      for (let j = 0; j < m; j++) {
        if (r.cum[j] < u1 && r.cum[j + 1] > u0) {
          if (j0 < 0) j0 = j;
          j1 = j;
        }
      }
      if (i0 < 0 || j0 < 0) continue;
      out.push({ branch: k, end, i0: i0 - W, i1: i1 + W, j0: Math.max(0, j0 - W), j1: Math.min(m - 1, j1 + W) });
    }
  });
  return out;
}

/** The branch segment whose mapS range holds main s (the last sample at or before it), clamped to the branch's segments. */
function branchSegAt(b: PlacedBranch, s: number): number {
  const ms = b.mapS;
  let lo = 0, hi = ms.length - 2;
  if (!(s >= ms[0])) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Track.mouthAt (PLAN-BRANCH 2.2): per global segment the other road's segment to search too, or -1. */
function buildMouthAt(main: Track): number[] {
  const n = main.pts.length;
  let total = n;
  for (const b of main.branches) total += segCount(b.road);
  const out: number[] = new Array<number>(total).fill(-1);
  for (const z of mouthZones(main)) {
    const b = main.branches[z.branch];
    for (let i = z.i0; i <= z.i1; i++) {
      const k = ((i % n) + n) % n;
      out[k] = b.base + branchSegAt(b, (main.cum[k] + main.cum[k + 1]) / 2);
    }
    for (let j = z.j0; j <= z.j1; j++) out[b.base + j] = pointAt(main, b.mapS[j]).seg;
  }
  return out;
}

/** The road numbered `road` (0 = the main road, b + 1 = branch b's road). */
export function roadOf(track: Track, road: number): Track {
  return road === 0 ? track : track.branches[road - 1].road;
}

/** The road a global segment g is on (0 for the main road's 0..n-1). */
export function roadOfSeg(track: Track, g: number): number {
  if (g < track.pts.length) return 0;
  const bs = track.branches;
  for (let k = bs.length - 1; k >= 0; k--) if (g >= bs[k].base) return k + 1;
  return 0;
}

/** A global segment's index on its own road. */
export function localSeg(track: Track, g: number): number {
  const r = roadOfSeg(track, g);
  return r === 0 ? g : g - track.branches[r - 1].base;
}

/**
 * A query's segment as a global one (the seg hint CarState stores). BR-PHYS: relative to the track queried:
 * a query of a road on its own (a branch's road stepped as its own track) keeps its segment.
 */
export function globalSeg(track: Track, q: TrackQuery): number {
  return q.road === track.roadNo ? q.seg : track.branches[q.road - 1].base + q.seg;
}

/**
 * The road a query of `track` is on (BR-PHYS): the track itself for its own road (always on a track without
 * branches), else the branch's road (PlacedBranch.road). Every per-segment lookup of a query reads this.
 */
export function roadFor(track: Track, q: TrackQuery): Track {
  return q.road === track.roadNo ? track : track.branches[q.road - 1].road;
}

/**
 * The main s of a query (PLAN-BRANCH 2.4): q.s on the main road; on a branch its mapS, interpolated
 * along the query's segment. Race progress takes this (BR-PHYS wires it).
 */
export function mainS(track: Track, q: TrackQuery): number {
  if (q.road === 0) return q.s;
  const b = track.branches[q.road - 1], r = b.road, i = q.seg;
  const c0 = r.cum[i], len = r.cum[i + 1] - c0;
  const t = !(len > 0) ? 0 : q.s <= c0 ? 0 : q.s >= c0 + len ? 1 : (q.s - c0) / len;
  return b.mapS[i] + (b.mapS[i + 1] - b.mapS[i]) * t;
}

/**
 * Where a fall at s on road `road` recovers (advisor change 3, user decision 6): on the main road its
 * recovery point at or before s (recoveryAt); on a branch the branch's last recovery point at or before
 * u, and when there is none, the main road's recovery point at or before the fork (s0).
 */
export function recoveryFor(track: Track, road: number, s: number): { road: number; s: number } {
  if (road === track.roadNo) return { road, s: recoveryAt(track, s) }; // BR-PHYS: the track's own road (0 on a track)
  const b = track.branches[road - 1];
  const r = recoveryAt(b.road, s);
  return r >= 0 ? { road, s: r } : { road: 0, s: recoveryAt(track, b.s0) };
}

/**
 * The nearest road and its query at (x, y) (PLAN-BRANCH 2.2, 2.7), the rule physics and the bake share:
 * the nearer centreline, on a tie the lower road. Without a hint: every road, whole (the bake's nearest
 * piece; queryTrack on a track without branches). With a global segment hint: the hint's road round it
 * (LOCAL_WINDOW either side, clamped on a branch) and, where that window touches a mouth (mouthAt), the
 * other road round its segment too; on a tie the hint's road. Without branches that is
 * queryTrackNear(track, x, y, hint) exactly.
 */
export function queryRoads(track: Track, x: number, y: number, hint = -1): TrackQuery {
  const bs = track.branches;
  if (hint < 0) {
    let best = queryTrack(track, x, y);
    for (const b of bs) {
      const q = queryTrack(b.road, x, y);
      if (q.dist < best.dist) best = q;
    }
    return best;
  }
  // BR-PHYS: the hinted rule is queryTrackNear's own (physics), so the two can never part.
  return queryTrackNear(track, x, y, hint);
}

/** Advisor change 7: a main-road feature lo..hi in a mouth or within MOUTH_CLEAR past its gore (validateTrack's zone). */
function mouthZone(main: Track, errors: string[], what: string, lo: number, hi: number): void {
  const f1 = (v: number) => v.toFixed(1);
  main.branches.forEach((b, k) => {
    const fg = b.forkGore, mg = b.mergeGore;
    const ranges: [number, number][] = fg && mg ? [[b.s0, fg.s + MOUTH_CLEAR], [mg.s - MOUTH_CLEAR, b.s1]] : [[b.s0, b.s1]];
    for (const [r0, r1] of ranges) {
      if (lo < r1 && hi > r0) {
        errors.push(`${what}: in a mouth of branch ${k + 1} or within ${MOUTH_CLEAR} of its gore (main s ${f1(r0)}..${f1(r1)}: no main-road feature there)`);
        return;
      }
    }
  });
}

/**
 * The branches' checks (PLAN-BRANCH 2.8, advisor changes 1 and 7; validateTrack runs them when there are
 * branches). Per branch: its side is -1 or +1, s0 < s1 and both off the start zone; halfWidth >=
 * BRANCH_HALF_MIN; it is shorter than the main road from s0 to s1 (strictly); its corridor parts from
 * the main road's at both ends (a gore each); the centrelines meet at <= GORE_ANGLE_MAX at each gore,
 * and each mouth is <= MOUTH_LEN_MAX along either road; mapS strictly increasing; its own sections pass
 * the crossing checks (sectionCrossings, not wrapped) and no bend of it is tighter than its inside's reach
 * (its corridor never folds over itself); its features keep
 * MOUTH_CLEAR past its gores and pass the road checks (validateRoad); its recovery points lie between
 * its gores, one before its first hazard (a ramp, a gap, a hole or a truck); the gores' noses keep
 * SOLID_CLEAR from every recovery point; mouths never share a search window (mouthAt has one answer);
 * and the corridors of different roads (branchSeparation) overlap only in mouths or where one is a gap,
 * keep >= the walls' difference apart past every gore and >= BRANCH_SEP apart outside the gores' noses.
 */
function validateBranches(main: Track, errors: string[]): void {
  const f1 = (v: number) => v.toFixed(1);
  const L = main.length;
  const straight = startStraightEnd(main);
  main.branches.forEach((b, k) => {
    const at = `branch ${k + 1} (main ${f1(b.s0)}..${f1(b.s1)})`;
    const r = b.road;
    if (!(b.side === -1 || b.side === 1)) errors.push(`${at}: side ${b.side} is not -1 (left) or +1 (right)`);
    if (!(b.s1 > b.s0)) errors.push(`${at}: s1 must be > s0`);
    if (!(b.s0 >= straight && b.s1 <= L - GRID_ZONE)) errors.push(`${at}: its fork or merge is in the start zone or off the lap (they lie in ${f1(straight)}..${f1(L - GRID_ZONE)})`);
    if (!(r.def.halfWidth >= BRANCH_HALF_MIN)) errors.push(`${at}: half-width ${r.def.halfWidth} is narrower than ${BRANCH_HALF_MIN} (a branch is >= ${2 * BRANCH_HALF_MIN} wide)`);
    if (!(r.length < b.s1 - b.s0)) errors.push(`${at}: ${f1(r.length)} long, not shorter than the main road's ${f1(b.s1 - b.s0)} from its fork to its merge (a shortcut is shorter)`);
    const fg = b.forkGore, mg = b.mergeGore;
    if (fg === null || mg === null) {
      errors.push(`${at}: its corridor never parts from the main road's ${fg === null ? "past its fork" : "before its merge"} (no point of its centreline is ${f1(2 * main.wall)} from the main centreline there)`);
      return;
    }
    if (!(fg.u < mg.u && fg.s < mg.s)) errors.push(`${at}: its gores are out of order (fork gore u=${f1(fg.u)} s=${f1(fg.s)}, merge gore u=${f1(mg.u)} s=${f1(mg.s)})`);
    for (const [g, name] of [[fg, "fork"], [mg, "merge"]] as const) {
      if (Math.sign(g.noseMain.lat) !== b.side) errors.push(`${at}: it leaves the main road on its ${g.noseMain.lat < 0 ? "left" : "right"} at its ${name}, not on side ${b.side}`);
      const deg = (g.angle * 180) / Math.PI;
      if (!(deg <= GORE_ANGLE_MAX)) errors.push(`${at}: the centrelines meet at ${deg.toFixed(1)} degrees at its ${name} gore (u=${f1(g.u)}), more than ${GORE_ANGLE_MAX}`);
    }
    const forkLen = Math.max(fg.u, fg.s - b.s0), mergeLen = Math.max(r.length - mg.u, b.s1 - mg.s);
    if (!(forkLen <= MOUTH_LEN_MAX)) errors.push(`${at}: its fork mouth is ${f1(forkLen)} long (fork to gore, the longer road), more than ${MOUTH_LEN_MAX}`);
    if (!(mergeLen <= MOUTH_LEN_MAX)) errors.push(`${at}: its merge mouth is ${f1(mergeLen)} long (gore to merge, the longer road), more than ${MOUTH_LEN_MAX}`);
    for (let i = 1; i < b.mapS.length; i++) {
      if (!(b.mapS[i] > b.mapS[i - 1])) {
        errors.push(`${at}: mapS is not strictly increasing at branch sample ${i} (u=${f1(r.cum[i])}: ${f1(b.mapS[i - 1])} then ${f1(b.mapS[i])})`);
        break;
      }
    }
    // Its features in u, MOUTH_CLEAR past its gores, and the road's own checks.
    const lo = fg.u + MOUTH_CLEAR, hi = mg.u - MOUTH_CLEAR;
    if (!(hi > lo)) errors.push(`${at}: ${f1(mg.u - fg.u)} between its gores, not longer than ${2 * MOUTH_CLEAR} (MOUTH_CLEAR of plain road past each)`);
    // Its own sections (review 1): the crossing checks of every road, without wrapping (sectionCrossings),
    // and, since those leave alone what lies within SAME_SECTION walls along it, no bend tighter than its
    // inside's reach (advisor change 13's rule for a widened bend, at every sample of a branch): a tighter
    // bend folds its corridor over itself, and nearest() degenerates there.
    sectionCrossings(r, errors, "u", `${at}: `);
    for (let i = 0; i < r.pts.length; i++) {
      const k = curvatureAt(r, i);
      if (k === 0) continue;
      const reach = (k > 0 ? r.wallR[i] : r.wallL[i]) - CAR_HALF_WID;
      if (!(reach < 1 / Math.abs(k))) {
        errors.push(`${at}: a car centre reaches ${f1(reach)} (the wall less half a car) on the inside of the bend at u=${f1(r.cum[i])}, not below the local radius ${f1(1 / Math.abs(k))} (its corridor folds over itself)`);
        break;
      }
    }
    const own: string[] = [];
    validateRoad(r, own, (what, a, z) => {
      if (!(a >= lo && z <= hi && a <= z)) own.push(`${what}: outside u ${f1(lo)}..${f1(hi)} (a branch's features keep ${MOUTH_CLEAR} past its gores at u ${f1(fg.u)} and ${f1(mg.u)})`);
    });
    for (const e of own) errors.push(`${at}: ${e}`);
    for (const rp of r.recovery) {
      if (!(rp >= fg.u && rp <= mg.u)) errors.push(`${at}: recovery point u=${f1(rp)} is in a mouth (a branch's recovery points lie between its gores, u ${f1(fg.u)}..${f1(mg.u)})`);
    }
    const first = Math.min(Infinity, ...r.ramps.map((x) => x.s), ...r.gaps.map((x) => x.s0), ...r.holes.map((x) => x.s - x.r), ...r.trucks.map((x) => x.s));
    if (first < Infinity && !r.recovery.some((rp) => rp < first)) {
      errors.push(`${at}: no recovery point before its first hazard at u=${f1(first)} (validation keeps one there; a fall before it goes back to the main road before the fork)`);
    }
    for (const [g, name] of [[fg, "fork"], [mg, "merge"]] as const) {
      for (const [road, label] of [[main, "main s"], [r, "branch u"]] as const) {
        for (const rp of road.recovery) {
          const p = pointAt(road, rp);
          const d = Math.hypot(p.x - g.x, p.y - g.y) - GORE_NOSE_R;
          if (d < SOLID_CLEAR) errors.push(`${at}: the nose of its ${name} gore is ${f1(Math.max(0, d))} from the recovery point at ${label}=${f1(rp)} (solids keep >= ${SOLID_CLEAR})`);
        }
      }
    }
  });
  // Mouths never share a search window: mouthAt has one answer per segment.
  const zones = mouthZones(main), n = main.pts.length;
  const name = (z: MouthZone) => `the ${z.end} of branch ${z.branch + 1}`;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zones[i], c = zones[j];
      const mainMeet = [-n, 0, n].some((w) => a.i0 <= c.i1 + w && c.i0 + w <= a.i1);
      const branchMeet = a.branch === c.branch && a.j0 <= c.j1 && c.j0 <= a.j1;
      if (mainMeet || branchMeet) errors.push(`${name(a)} and ${name(c)} are within ${LOCAL_WINDOW} segments of each other on the ${mainMeet ? "main road" : "branch"} (two mouths never share a search window)`);
    }
  }
  branchSeparation(main, errors);
}

/**
 * The corridors of different roads (PLAN-BRANCH 2.8, advisor change 1). At every sample of each road,
 * against the nearest point of every other road's centreline (the closest approach of two polylines is
 * at a vertex of one of them): the gap between the corridors there, the distance less the two facing
 * walls, is
 * - free inside a mouth (a branch sample before its gore with the main road's fork section, and the main
 *   road's samples whose nearest branch point is there: the corridors overlap, with equal walls);
 * - at least the walls' difference |wA - wB| past every gore (else the nearer road's wall, which physics
 *   and the bake use, cuts into the other's corridor: advisor change 1), and never an overlap;
 * - and at least BRANCH_SEP outside the gores' noses (from a gore to the first sample past it whose gap
 *   is BRANCH_SEP, which lies within MOUTH_CLEAR of the gore).
 * Where either point is over a gap (one road jumps the other) nothing is required.
 */
function branchSeparation(main: Track, errors: string[]): void {
  const f1 = (v: number) => v.toFixed(1);
  const roads = [main, ...main.branches.map((b) => b.road)];
  const label = (k: number) => (k === 0 ? "the main road" : `branch ${k}`);
  const coord = (k: number) => (k === 0 ? "s" : "u");
  const same = SAME_SECTION * main.wall;
  /** The gap between the corridors of road a at its sample i and road b at its nearest point. */
  const gapAt_ = (ra: Track, i: number, rb: Track) => {
    const p = ra.pts[i];
    const q = queryTrack(rb, p.x, p.y);
    const qx = p.x - q.nx * q.dist, qy = p.y - q.ny * q.dist;
    const d = segDir(ra, i);
    const wA = d.x * (qy - p.y) - d.y * (qx - p.x) < 0 ? ra.wallL[i] : ra.wallR[i];
    const wB = halfOn(rb, q.seg, q.s, q.side) + rb.def.verge;
    return { q, gap: q.dist - wA - wB, dw: Math.abs(wA - wB) };
  };
  // The gores' noses: from each gore to the first branch sample past it BRANCH_SEP clear of the main
  // road, which lies within MOUTH_CLEAR of the gore (else the nose ends there, and it is reported).
  const L = main.length;
  const open = main.branches.map((b, k) => {
    const r = b.road, fg = b.forkGore, mg = b.mergeGore;
    let fork = -Infinity, merge = Infinity;
    if (fg && mg) {
      fork = fg.u + MOUTH_CLEAR;
      merge = mg.u - MOUTH_CLEAR;
      let i = 0;
      while (i < r.pts.length && !(r.cum[i] > fg.u && gapAt_(r, i, main).gap >= BRANCH_SEP)) i++;
      if (i < r.pts.length && r.cum[i] <= fork) fork = r.cum[i];
      else errors.push(`branch ${k + 1} (main ${f1(b.s0)}..${f1(b.s1)}): its corridor is not ${BRANCH_SEP} clear of the main road's within ${MOUTH_CLEAR} past its fork gore (u ${f1(fg.u)})`);
      i = r.pts.length - 1;
      while (i >= 0 && !(r.cum[i] < mg.u && gapAt_(r, i, main).gap >= BRANCH_SEP)) i--;
      if (i >= 0 && r.cum[i] >= merge) merge = r.cum[i];
      else errors.push(`branch ${k + 1} (main ${f1(b.s0)}..${f1(b.s1)}): its corridor is not ${BRANCH_SEP} clear of the main road's within ${MOUTH_CLEAR} before its merge gore (u ${f1(mg.u)})`);
    }
    return { fork, merge };
  });
  /** s in lo..hi, the nearer way round the lap. */
  const within = (s: number, lo: number, hi: number) => (s >= lo && s <= hi) || (s - L >= lo && s - L <= hi) || (s + L >= lo && s + L <= hi);
  /** 1: inside a mouth (free); 2: in a gore's nose (the walls' difference only); 0: elsewhere. */
  const zoneOf = (k: number, u: number, s: number): number => {
    const b = main.branches[k - 1], fg = b.forkGore, mg = b.mergeGore, o = open[k - 1];
    if (fg === null || mg === null) return 1; // reported already: its corridor never parts
    if (within(s, b.s0 - same, fg.s + same)) {
      if (u <= fg.u) return 1;
      if (u <= o.fork) return 2;
    }
    if (within(s, mg.s - same, b.s1 + same)) {
      if (u >= mg.u) return 1;
      if (u >= o.merge) return 2;
    }
    return 0;
  };
  const shown = new Set<string>();
  for (let a = 0; a < roads.length; a++) {
    for (let c = 0; c < roads.length; c++) {
      if (a === c) continue;
      const ra = roads[a], rc = roads[c];
      for (let i = 0; i < ra.pts.length; i++) {
        const sa = ra.cum[i];
        const { q, gap, dw } = gapAt_(ra, i, rc);
        if (gap >= BRANCH_SEP && gap >= dw) continue;
        if (gapAt(ra, sa) || gapAt(rc, q.s)) continue; // one road jumps the other
        const zone = a === 0 ? zoneOf(c, q.s, sa) : c === 0 ? zoneOf(a, sa, q.s) : 0;
        if (zone === 1) continue;
        const kind = gap < 0 ? "overlap" : gap < dw ? "walls" : zone === 2 ? "" : "near";
        if (kind === "") continue;
        const key = `${Math.min(a, c)}|${Math.max(a, c)}|${kind}`;
        if (shown.has(key)) continue;
        shown.add(key);
        const where = `${label(a)} at ${coord(a)}=${f1(sa)} and ${label(c)} at ${coord(c)}=${f1(q.s)}`;
        if (kind === "overlap") errors.push(`${where}: their corridors overlap (by ${f1(-gap)}) outside a mouth (roads overlap only in a mouth, or where one is a gap)`);
        else if (kind === "walls") errors.push(`${where}: past a gore their corridors are ${f1(gap)} apart, less than the walls' difference ${f1(dw)} (the nearer road's wall would cut into the other's corridor)`);
        else errors.push(`${where}: their corridors are ${f1(gap)} apart, less than ${BRANCH_SEP} (outside the mouths and the gores' noses)`);
      }
    }
  }
}
