// The static world under the cars: packed dirt, junk heaps outside the walls, the track
// (steel barriers, gravel verges, rust-and-bone kerbs, tarmac, the start line) and its
// features (ramps, gaps with their voids and scrap piles, holes).
//
// The world is baked, not drawn: 256x256 view-pixel tiles of palette indices ("Scrapyard 32",
// gfx/palette.ts), kept in a pool of TILE_POOL canvases and blitted 1:1 (the camera is
// snapped to whole view pixels). PLAN-GFX.md, items A1-A6.
//
// How a tile is baked (bakeStep):
// - Every layer is a hard 1-bit mask, composited bottom to top into an index buffer. The
//   track's bands (barrier, verge, kerb, tarmac) are thresholds on the distance to the
//   centreline, everything else a polygon or a disc sampled at the pixel centre. A pixel on
//   an edge therefore has the colour of one of the two layers that meet there: no blend, and
//   no snapping to a nearest third colour.
// - One sun, top-left: a 1 px LIT edge up-left, a 1 px SHADE edge down-right, hard cast
//   shadows (whatever lies under them, one SHADE step down) a few pixels down-right.
// - No gradients. Depth is ramp steps; an ordered dither only inside a pit and on a ramp's
//   seams. Wear on the wide surfaces is speck density (never a pattern, which would moire at
//   a phone's non-integer scale) and stays within one step either side of the surface.
// - A tile is a pure function of the track and its position: neighbours join without seams,
//   and the same tile is the same pixels on every machine (no canvas rasterisation involved).
//
// When tiles are baked (World.draw):
// - A bake is cut into steps of about a quarter of a millisecond. A frame runs steps until
//   its share is used: a small one for tiles baked ahead (where the camera's aim is moving
//   to, and where the own car will be put back after a fall or a wreck), a larger one while
//   a tile round the camera's aim is missing (after a recovery, or a new leader to follow).
//   A tile that is on screen before it is ready shows as a plain dirt-coloured square: that
//   happens while the camera sweeps across the track to a far aim, not in a race.
// - A camera cut (the first frame, follow(snap), frames that were skipped) bakes what is on
//   screen at once, so a single frame is always a complete picture.
// - The pool is module-level and keyed by track: it survives a new Renderer, and two
//   Renderers on one canvas share it.
//
// What a race leaves on it (track marks, further down): a mine's scorch and the tyre marks of
// a sliding car are put into the tiles' pixels where they lie, once, and cost nothing after.
//
// What lies on a road besides (M4-WORLD; PLAN-M4.md 2.2-2.4, 2.6 B; "the road's furniture",
// further down) is baked as well, in a step of its own that a track without any never runs: the
// widened road of a split and its island, water, dirt, a conveyor belt's bed, tyre mounds, the
// parked ramp truck, and the still parts of what moves (a crusher press's bed, the lane a row of
// barrels rolls in). What moves itself is drawn a frame at a time by gfx/obstacles.ts.
//
// Themes (PLAN-THEMES.md; gfx/theme.ts): a track's surroundings are a theme's, and a theme
// changes what is painted, never where. Two things make a theme here:
// - its palette tables (the same 32 role names in colours of its own, `water`, and extras for
//   pixels that take no marks). They belong to a track's art, and a tile keeps its art's: the
//   pool holds tiles of several tracks, so a tile is finished, marked and wiped with its own;
// - its dressing (`Dress`, further down): the tones and patterns the bake puts down where the
//   scrapyard's would be wrong for it (the ground, the barrier, the props outside the walls, a
//   gap's void, a dirt patch, a pool's rim, a mound, the truck).
// The scrapyard is the theme every shipped track has: its tiles are what they were, bit for bit.

import { MAX_PLAYERS } from "../../shared/protocol";
import { BARREL_R, gapAt, gridSlot, halfOn, holeAt, pointAt, PRESS_DEPTH, PUDDLE_TRACTION_INSET, queryMain, queryRoads, queryTrack, TRUCK_BAND, TRUCK_CAB, TRUCK_HALF, wallAt, widenAt, type Gap, type Track, type Vec } from "../../shared/track";
import type { CarView } from "../render";
import { BAYER4, PALETTE, type PaletteName } from "./palette";
import { KEEP_OFF, sceneryFor, sceneryOf, type Scenery } from "./theme";

export const VIEW_W = 640;
export const VIEW_H = 360;
export const ZOOM = 0.8;

/** Tile edge in view pixels, and how many tiles the pool holds (24 x 256 x 256 x 4 = 6.3 MB). */
export const TILE = 256;
export const TILE_POOL = 24;

const PAD = 8; // a tile is baked with this margin, so shadows and bevels see across its edges
const S = TILE + 2 * PAD;
const UNIT = 1 / ZOOM; // world units per view pixel
const BIG = 1e9;
const BLOCK = 16; // the track's pieces are sorted out per block of this many pixels
const BLOCK_R = 11.5; // ... whose centre is this far from its corners

// Track bands, in world units from the centreline (the same sizes the strokes had).
const BARRIER = 7; // the barrier stands this far outside the wall line
const RAIL_IN = 1.8; // the bright rail inside the barrier band
const RAIL_OUT = 4.6;
const KERB = 5;
const FRINGE_NEAR = 5; // gravel thrown over the wall: dense this far out ...
const FRINGE_FAR = 12; // ... thinning out to here
const REACH = BARRIER + FRINGE_FAR; // beyond the wall line: as far as the track changes a pixel

// A frame's share of the baking, in cost units (a step's cost is worked out from what it
// did: about a microsecond a unit on the machine the benchmark baseline was measured on) and
// in milliseconds, whichever is used up first. The units make a frame's work the same on
// every run, so the same frames give the same pixels; the clock protects a slower machine.
// (The benchmark and a held preview pin performance.now() while a frame draws: there only
// the units count, which is also the cap that binds on a machine as fast as the baseline's.)
const AHEAD_UNITS = 220; // tiles baked ahead
const AHEAD_MS = 1.5;
const URGENT_UNITS = 1500; // while a tile round the aim is missing
const URGENT_MS = 6;
const LEAD_MS = 750; // tiles are baked this far ahead of the camera's aim
const LEAD_MAX = 288; // ... but no further than this (view pixels)
const MARGIN = 40; // view pixels around the aim that count as on screen (camera lag, shake)
const NEAR = 400; // a camera this close to a far aim (view pixels) has its own view baked too

// ---- palette ------------------------------------------------------------------------

// The 32 role names and `water` have the same palette index in every theme: DIRT2 is the
// ground's plain tone, packed earth here and sand there. A theme's extras come after them
// (Dress holds the ones the bake uses).
const IDX = Object.fromEntries(PALETTE.map((e, i) => [e.name, i])) as Record<PaletteName, number>;
const YARD = sceneryOf("scrapyard");
// A colour in a cast shadow and on a sunlit edge, 64 entries each (a shadow falls on a theme's
// extras as on the 32): the tables of the tile being baked, set as its bake starts (bakeStart).
let SHADE_I = YARD.shadeI;
let LIT_I = YARD.litI;
const {
  soot0: SOOT0, soot1: SOOT1, soot2: SOOT2, soot3: SOOT3,
  dirt0: DIRT0, dirt1: DIRT1, dirt2: DIRT2, dirt3: DIRT3,
  gravel0: GRAVEL0, gravel1: GRAVEL1, gravel2: GRAVEL2,
  tar0: TAR0, tar1: TAR1, tar2: TAR2, tar3: TAR3,
  steel0: STEEL0, steel1: STEEL1, steel2: STEEL2, steel3: STEEL3,
  rust0: RUST0, rust1: RUST1, rust2: RUST2, rust3: RUST3,
  bone0: BONE0, bone1: BONE1, bone2: BONE2,
  haz0: HAZ0, haz1: HAZ1, haz2: HAZ2,
  blast: BLAST,
  water: WATER, // not one of the 32 (index SCRAPYARD): the body of a pool, and a pixel of it takes no marks
} = IDX;

// What a pixel is, for the passes that look at their neighbours (shadows, bevels, clips).
const C_NONE = 0;
const C_BARRIER = 1;
const C_RAIL = 2;
const C_VERGE = 3;
const C_KERB = 4;
const C_TARMAC = 5;
const C_PLATE = 6; // a ramp's plate
const C_VOID = 7;
// The road's furniture (M4-WORLD). From C_WATER on a pixel takes no track marks.
const C_DIRT = 8; // a dirt patch on the road
const C_BED = 9; // a crusher press's bed
const C_WATER = 10;
const C_BELT = 11;
const C_ISLE = 12; // the yard inside an island
const C_SOLID = 13; // a tyre, the ramp truck
const C_PROP = 14; // a theme's prop outside the walls, in colours of its own (the yard's junk is plain ground to the marks)

// ---- a theme's dressing ---------------------------------------------------------------
//
// What the bake puts down differently from theme to theme: tones (palette indices of the
// theme's table: a role's, or one of its extras) and a few patterns. A step reads what it needs
// once, outside its pixel loops. Geometry is never a theme's: the bands of the road, where the
// posts stand, the outlines of the features.

const G_YARD = 0, G_DUNES = 1; // the ground: packed earth, specked; sand with dune crests and wind ripples
const PROPS_JUNK = 0, PROPS_DESERT = 1; // outside the walls: heaps of junk; rocks, dry scrub, succulents, half-buried car shells
const MOUND_TYRES = 0, MOUND_BAGS = 1; // a mound and an island's nose: tyres; sandbags
const TRUCK_RAMP = 0, TRUCK_SAND = 1; // the ramp truck: a scrap hauler; a sand hauler

interface Dress {
  ground: number; // G_*
  props: number; // PROPS_*
  // The barrier: its band, the bright middle of the band, that middle's sunlit edge. Laid in
  // blocks `block` units long with a joint between them (0 = one long rail). A post's three tones.
  wall: number;
  rail: number;
  railLit: number;
  block: number;
  joint: number;
  postLit: number;
  postMid: number;
  postDark: number;
  // The verge's specks, by the pixel's noise (0..255): light under `vergeLight`, dark over
  // `vergeDark`, a bone fleck between `vergeFleck` and that.
  vergeLight: number;
  vergeDark: number;
  vergeFleck: number;
  // The kerb: its two paints in turn, `kerbOn` units of the first in every `kerbPeriod`.
  kerbPeriod: number;
  kerbOn: number;
  // A gap's void: steps of soot (false); or layered rock near its rim (true: `rock`, four tones,
  // dark to light). Soot fills it either way.
  canyon: boolean;
  rock: readonly number[];
  pitWall: number; // a pit's far wall, in the sun
  rubble: readonly number[]; // under the scrap that fills a gap: four tones, by the pixel's noise
  // A dirt patch on the road: its plain tone, light and dark specks, a pebble.
  patch: number;
  patchLight: number;
  patchDark: number;
  patchPebble: number;
  // A pool's rim: 0 = the ground is wet round it; else a ring of dried mud in this tone, cracked.
  mud: number;
  mound: number; // MOUND_*
  moundInner: number; // the paint of the rings inside the outer one, and of the top
  moundTop: number;
  underlay: number; // the ground under an island's nose (with soot3)
  truck: number; // TRUCK_*
  // PROPS_DESERT: a rock's two kinds of stone, a shell's paints, a succulent's three greens (dark to light), dry twigs.
  stones: readonly number[];
  shells: readonly number[];
  greens: readonly number[];
  twigs: readonly number[];
}

const dresses: (Dress | undefined)[] = [];

/** The dressing of a theme (by its scenery), made once. */
function dressOf(sc: Scenery): Dress {
  let d = dresses[sc.id];
  if (d) return d;
  const x = sc.index;
  if (sc.theme === "desert") {
    d = {
      ground: G_DUNES, props: PROPS_DESERT,
      // Sandstone blocks, a terracotta finial where the scrapyard has a post.
      wall: x.stone0, rail: x.stone2, railLit: x.stone3, block: 15, joint: x.stone1, postLit: RUST3, postMid: RUST2, postDark: RUST0,
      vergeLight: 28, vergeDark: 224, vergeFleck: 219, // grit: coarser than gravel
      kerbPeriod: 32, kerbOn: 16,
      canyon: true, rock: [x.canyon0, x.canyon1, x.canyon2, x.canyon3], pitWall: x.canyon1, rubble: [x.canyon0, SOOT1, x.canyon1, SOOT3],
      patch: RUST1, patchLight: RUST2, patchDark: RUST0, patchPebble: GRAVEL1, // red clay hardpan, never the sand's colour
      mud: GRAVEL2,
      mound: MOUND_BAGS, moundInner: x.bag1, moundTop: x.bag2, underlay: GRAVEL0,
      truck: TRUCK_SAND,
      stones: [x.canyon2, x.stone1], shells: [STEEL2, RUST1, x.bag1, STEEL1], greens: [x.cactus0, x.cactus1, x.cactus2], twigs: [x.bag0, HAZ0],
    };
  } else {
    // The scrapyard: every tone and number is what the bake has always put down.
    d = {
      ground: G_YARD, props: PROPS_JUNK,
      wall: STEEL0, rail: STEEL2, railLit: STEEL3, block: 0, joint: STEEL0, postLit: STEEL3, postMid: STEEL1, postDark: STEEL0,
      vergeLight: 19, vergeDark: 239, vergeFleck: 236,
      kerbPeriod: 44, kerbOn: 22,
      canyon: false, rock: [SOOT0, SOOT1, SOOT2, SOOT3], pitWall: DIRT0, rubble: [DIRT0, SOOT1, TAR3, SOOT3],
      patch: DIRT2, patchLight: DIRT3, patchDark: DIRT1, patchPebble: GRAVEL0,
      mud: 0,
      mound: MOUND_TYRES, moundInner: SOOT2, moundTop: BONE1, underlay: DIRT0,
      truck: TRUCK_RAMP,
      stones: [], shells: [], greens: [], twigs: [],
    };
  }
  return (dresses[sc.id] = d);
}

// ---- noise --------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What corners() and stainNoise() work out. They leave it here and hand nothing back: a
// fraction handed back from a call is boxed (see "The bake allocates nothing" below).
const CORNERS = new Float64Array(4);
const NOISE_OUT = new Float64Array(2);

/**
 * A hash 0..1 of each corner of lattice cell (x, y), whole numbers, into CORNERS:
 * (x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1).
 */
function corners(x: number, y: number, seed: number): void {
  for (let k = 0; k < 4; k++) {
    let h = Math.imul(x + (k & 1), 374761393) ^ Math.imul(y + (k >> 1), 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    CORNERS[k] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
}

/** Smooth value noise 0..1 on a 5 px lattice at view pixel (X, Y), into NOISE_OUT[0]: the ragged edge of a stain. */
function stainNoise(X: number, Y: number): void {
  const x = X / 5, y = Y / 5;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  corners(xi, yi, 9);
  const a = CORNERS[0], b = CORNERS[1], c = CORNERS[2], d = CORNERS[3];
  NOISE_OUT[0] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Smooth value noise 0..1 on a 21 px lattice at view pixel (X, Y), into NOISE_OUT[1]: the deeps of a pool. */
function poolNoise(X: number, Y: number): void {
  const x = X / 21, y = Y / 21;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  corners(xi, yi, 23);
  const a = CORNERS[0], b = CORNERS[1], c = CORNERS[2], d = CORNERS[3];
  NOISE_OUT[1] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** White noise, 256x256 bytes, read at an offset of its own per tile and per use (so no tile repeats another). */
let NOISE: Uint8Array | null = null;

function noiseTable(): Uint8Array {
  if (!NOISE) {
    NOISE = new Uint8Array(65536);
    const rnd = mulberry32(0x5c2a9);
    for (let i = 0; i < NOISE.length; i++) NOISE[i] = Math.floor(rnd() * 256);
  }
  return NOISE;
}

// ---- per-track art ------------------------------------------------------------------

const K_CUBE = 0, K_DRUM = 1, K_TYRES = 2, K_PLATE = 3, K_PALLET = 4, K_ENGINE = 5, K_COIL = 6;
// A theme's props (PROPS_DESERT): a rock outcrop, a tuft of dry scrub, round succulents, a half-buried car shell.
const K_ROCK = 7, K_SCRUB = 8, K_CACTUS = 9, K_SHELL = 10;

/** A piece of junk: centre and size in view pixels, a turn, its paint (palette index). */
interface Junk {
  kind: number;
  x: number;
  y: number;
  r: number;
  a: number;
  c: number;
}

/** A stain: centre and radius in view pixels. */
interface Blob {
  x: number;
  y: number;
  r: number;
}

/** A frame on the track: origin in view pixels, the heading's cosine and sine. */
interface Frame {
  x: number;
  y: number;
  cos: number;
  sin: number;
}

/** Everything a track's tiles are baked from, prepared once per track. */
interface Art {
  tiles: Map<number, Tile>; // its tiles in the pool, by tileKey
  track: Track;
  scenery: Scenery; // the theme's tables: its tiles are finished, marked and wiped with these
  dress: Dress; // ... and what the bake puts down for it
  // The centreline cut into pieces that are all ground or all gap, in view pixels.
  n: number;
  ax: Float64Array;
  ay: Float64Array;
  ex: Float64Array; // b - a
  ey: Float64Array;
  inv: Float64Array; // 1 / |e|^2
  nx: Float64Array; // unit normal, to the right of the direction of travel
  ny: Float64Array;
  s0: Float64Array; // distance along the track at a, world units
  ds: Float64Array; // ... and the piece's length
  dash0: Float64Array; // distance from the start of its stretch of ground (the kerb and line dashes)
  groove0: Float64Array; // the racing line's offset from the centreline at a and at b
  groove1: Float64Array;
  // -1 = ground, else the index of its gap (in `gaps`). Ground of a shortcut road (BR-BAKE) is
  // -1 less its road number: -2 on the first branch's road, -3 on the second's. A run of
  // neighbours ends where this changes, so it ends where the road does.
  gap: Int16Array;
  capA: Uint8Array; // the piece ends flat here (a gap begins or ends), no round join
  capB: Uint8Array;
  // BR-BAKE (PLAN-BRANCH.md 2.7): the shortcut roads' pieces come after the main road's.
  road: Uint8Array; // the road a piece is on: 0 the main road, k the road of branch k - 1
  roads: Track[]; // the main road, then each branch's road
  // What a road's distances have added to them here (0 on the main road): a piece's s0, a
  // feature's s, a gap's ends. A shortcut's own distance u is then never taken for the main
  // road's s, and every test of the bake that compares the two stays as it is.
  sBase: Float64Array;
  gaps: readonly Gap[]; // every road's gaps (the track's own list without a branch), distances as the pieces'
  mouths: Mouth[]; // what is painted where a shortcut leaves and rejoins (empty without a branch)
  junk: Junk[]; // heaps outside the walls, far ones first
  piles: Junk[][]; // per gap: the scrap that fills it (empty unless gap.scrap)
  stains: Blob[]; // on the dirt
  ruts: Float32Array[]; // wheel ruts in the dirt: x, y pairs in view pixels
  oil: Blob[]; // on the tarmac
  patches: { s0: number; s1: number; l0: number; l1: number }[]; // repairs, by distance and lateral offset
  posts: Int32Array; // barrier posts: x, y of each one's top-left pixel
  holes: { x: number; y: number; r: number; rim: Float64Array; cracks: Float64Array[] }[];
  // w: how far a ramp's plate reaches either side of the centreline (its road's wall less 1).
  ramps: { s0: number; s1: number; w: number; frame: Frame; reach: number; chevrons: Float64Array[][] }[]; // chevrons: [outline, inside] per arrow
  // hw: its road's asphalt half-width there (the hazard stripes lie on the asphalt and the kerb).
  ends: { gap: number; s: number; dir: number; hw: number; frame: Frame }[]; // a gap's two ends on the road
  start: Frame;
  marks: Float64Array[]; // grid slot marks: quads (x, y pairs)
  recX: Float64Array; // the main road's recovery points, world units
  recY: Float64Array;
  // Per road (index 0 unused): a shortcut's own recovery points, and the main road's recovery
  // point a fall before the first of them goes back to (shared/track.ts recoveryFor).
  recRoadX: Float64Array[];
  recRoadY: Float64Array[];
  recBack: Int32Array;
  // M4-WORLD. A widened road (a split's): the bands of the road are measured from the widened
  // edge, so per piece the extra width at a and at b, left and right of travel (world units).
  wide: boolean; // some widen on the track
  wallMax: number; // the wall furthest from the centreline, world units (track.wall without a widen)
  wL0: Float64Array;
  wL1: Float64Array;
  wR0: Float64Array;
  wR1: Float64Array;
  furnished: boolean; // anything in `flats` or `things`: the bake's furniture step runs
  flats: Flat[]; // what is painted flat on the road, in the order it is painted
  things: Thing[]; // what stands on it, the order it is drawn in
}

/**
 * What is painted on the road where a shortcut leaves the main road or rejoins it (BR-BAKE;
 * PLAN-BRANCH.md 2.7, user decision 4: painted arrows, no text). One per gore.
 * - The wedge: worn stripes on the asphalt the two roads share, between them, from where their
 *   centrelines are 2 * MOUTH_LANE apart (its tip) to where their kerbs begin (the tip of the
 *   gravel between them): what is further than MOUTH_LANE from both centrelines. A pixel knows
 *   its own road and its distance from it (classify), so the wedge is told by those: on the main
 *   road's stretch m0..m1 on the side `sideM` of it, on the shortcut's b0..b1 (distances as its
 *   pieces') on its side `sideB`. `frame`: at the tip, pointing at the gravel's tip `len` away.
 * - The arrows (a fork only): one down each road, polygons in view pixels.
 */
interface Mouth {
  x0: number; // the box the wedge is painted in, view pixels (x1, y1 exclusive)
  y0: number;
  x1: number;
  y1: number;
  road: number; // the shortcut's road
  m0: number;
  m1: number;
  b0: number;
  b1: number;
  sideM: number;
  sideB: number;
  frame: Frame;
  len: number;
  arrows: Float64Array[];
}

const MOUTH_LANE = 40; // the wedge's edge runs this far from either road's centreline
const MOUTH_STRIPE = 7; // its stripes and the room between them, world units
const MOUTH_ARROW_AT = 40; // the arrows stand where the two centrelines are this far apart ...
const MOUTH_ARROW_LAT = 32; // ... each this far from its road's centreline, on the side away from the other road
const MOUTH_ARROW = 64; // an arrow's length

// The road's furniture (M4-WORLD): see furniture() for how each is drawn.
const F_DIRT = 0, F_WATER = 1, F_BELT = 2, F_ROW = 3, F_BED = 4, F_ISLAND = 5;

/** A rectangle in track coordinates (s along, l across, + = right of travel; world units) that is painted flat on the road. */
interface Flat {
  kind: number; // F_*
  s0: number;
  s1: number;
  l0: number;
  l1: number;
  x0: number; // the box it is painted in, view pixels (x1, y1 exclusive)
  y0: number;
  x1: number;
  y1: number;
  flip: boolean; // F_ROW: the barrels roll from right to left
  // F_WATER, F_DIRT: the puddle's outline (puddleEdge). Its seed, the radius of each of its four
  // corners (by nearer end along, then nearer side across), how much of the lobes it has (a
  // small one: less), and how long its widest lobes are along the road and across it.
  seed: number;
  round: Float64Array;
  swell: number;
  lobeS: number;
  lobeL: number;
}

const T_TYRES = 0, T_TRUCK = 1, T_JUNK = 2;

/** Something that stands on the road: a heap of tyres, the ramp truck, a piece of junk on an island. */
interface Thing {
  kind: number; // T_*
  x0: number; // the box it and its shadow lie in, view pixels (x1, y1 exclusive)
  y0: number;
  x1: number;
  y1: number;
  tyres: Float64Array; // T_TYRES: x, y, radius (view pixels) and paint (palette index) of each, the lowest first
  lie: Float64Array; // T_TYRES: per piece the way it lies, a cosine and a sine (a sandbag's long side: bags())
  junk: Junk | null; // T_JUNK
  truck: TruckArt | null; // T_TRUCK
}

/** The ramp truck: its rear end's middle in view pixels, its heading, its sizes in world units, its two arrows. */
interface TruckArt {
  x: number;
  y: number;
  cos: number;
  sin: number;
  len: number;
  ramp: number; // the ramp plate ends here, from the rear
  lip: number; // ... and the deck here: the take-off, at the cab's back
  chevrons: Float64Array[][]; // [outline, inside] per arrow
}

// Sizes of the furniture, world units.
const TYRE = 6.5; // a tyre's radius
const NOSE = 26; // an island's nose: two rows of tyre stacks
const GORE = 46; // the painted wedge on the road before a nose
// A puddle (a pool, a dirt patch) is drawn inside its declared rectangle, which is its bounds
// (puddleEdge): its corners round, each by a radius of its own (PUDDLE_ROUND_MIN to _MAX, no two
// of a puddle alike), its edge between PUDDLE_NEAR and PUDDLE_FAR inside the rectangle's sides,
// in lobes and bays of its own on every side. What a car feels is the rectangle less
// PUDDLE_TRACTION_INSET (gfx/puddle-shape.ts), and that lies inside the puddle with PUDDLE_KEEP
// to spare wherever one is drawn: along a side the edge is at most PUDDLE_FAR in; in a corner
// it is held to what the round corner leaves of the way to the traction rectangle's corner;
// and whatever the outline does, the traction rectangle and PUDDLE_KEEP round it are part of
// the puddle (puddleEdge's last lines: where a bay would cut into it, the rectangle wins).
const PUDDLE_KEEP = 2; // the clear margin between the puddle's edge and what a car feels
const PUDDLE_NEAR = 0.5; // the edge's least way in from a side of the rectangle ...
const PUDDLE_FAR = PUDDLE_TRACTION_INSET - PUDDLE_KEEP; // ... and its most
const PUDDLE_WOBBLE = 2.2; // of that, the fine wobble that rides on every lobe and bay
const PUDDLE_ROUND_MIN = 12;
const PUDDLE_ROUND_MAX = 34; // under (INSET * sqrt 2 - KEEP - NEAR) / (sqrt 2 - 1) = 34.9 the traction rectangle's corner is inside the round one
if (!(PUDDLE_FAR > PUDDLE_NEAR + PUDDLE_WOBBLE && PUDDLE_TRACTION_INSET * Math.SQRT2 - (Math.SQRT2 - 1) * PUDDLE_ROUND_MAX - PUDDLE_KEEP > PUDDLE_NEAR)) throw new Error("gfx/world.ts: a puddle's outline no longer holds its traction rectangle");
const ROW_JAMB = 2.5; // the frame of the hatch a row of barrels comes out of

// A track object has one theme, its definition's (gfx/theme.ts themeOf): the art is keyed by
// the track. The preview's `&theme=` switch hands the Renderer a copy of the track that names
// another theme (themedTrack), so there the key is track and theme; the game never does.
const arts = new WeakMap<Track, Art>();

function artOf(track: Track, scenery: Scenery = sceneryFor(track)): Art {
  let a = arts.get(track);
  if (!a || a.scenery !== scenery) {
    a = buildArt(track, scenery);
    arts.set(track, a);
  }
  return a;
}

function frameAt(track: Track, s: number): Frame {
  const p = pointAt(track, s);
  return { x: p.x * ZOOM, y: p.y * ZOOM, cos: Math.cos(p.h), sin: Math.sin(p.h) };
}

/** A point given along (u) and to the right of (v) a frame, world units, as view pixels. */
function inFrame(f: Frame, u: number, v: number, out: Float64Array, at: number): void {
  out[at] = f.x + (u * f.cos - v * f.sin) * ZOOM;
  out[at + 1] = f.y + (u * f.sin + v * f.cos) * ZOOM;
}

function buildArt(track: Track, scenery: Scenery): Art {
  const dress = dressOf(scenery);
  const desert = dress.props === PROPS_DESERT;
  // A theme's prop for a piece of junk: its kind by the same draw, its paint by the junk's.
  const propKind = (pick: number): number => (pick < 0.5 ? K_ROCK : pick < 0.7 ? K_SCRUB : pick < 0.88 ? K_CACTUS : K_SHELL);
  const propPaint = (kind: number, c: number): number => (kind === K_ROCK ? dress.stones[c === STEEL1 || c === STEEL2 ? 1 : 0] : kind === K_SHELL ? dress.shells[c % dress.shells.length] : 0);
  const { pts, cum, length: L, wall } = track;
  const hw = track.def.halfWidth;
  const R = wall + BARRIER;
  const wrap = (s: number) => ((s % L) + L) % L;
  // BR-BAKE: the roads, the main one first. A shortcut's road is open (it runs from the fork to
  // the merge and stops) and has distances of its own, u from 0 at the fork. Here they get the
  // road's base added (Art.sBase): a power of two beyond every road's length, times its number.
  const branches = track.branches;
  const roads: Track[] = [track];
  for (const b of branches) roads.push(b.road);
  const branchy = roads.length > 1;
  let span = 0;
  if (branchy) {
    span = 4096;
    for (const r of roads) while (span < r.length + 2048) span *= 2;
  }
  const sBase = Float64Array.from(roads, (_, k) => k * span);
  // A widened road (a split): how much wider it is at s on a side, and how far a point is from
  // the centreline less that (so the track's bands and the yard's clearances hold beside it).
  // Every road is asked (BR-BAKE): a shortcut's width is its own, taken as extra to the main road's.
  const wide = track.widens.length > 0;
  const away = (x: number, y: number): number => {
    const q = queryTrack(track, x, y);
    let d = wide ? q.dist - widenAt(track, q.s, q.side) : q.dist;
    for (let k = 1; k < roads.length; k++) {
      const r = roads[k], o = queryTrack(r, x, y);
      const e = o.dist - (halfOn(r, o.seg, o.s, o.side) - hw);
      if (e < d) d = e;
    }
    return d;
  };

  // The pieces: every centreline segment, cut where a gap begins or ends. (u0, u1: a piece's
  // ends in its own road's distances; seg: the segment it is cut from.)
  const cuts: { a: Vec; b: Vec; s0: number; s1: number; gap: number; capA: boolean; capB: boolean; road: number; seg: number; u0: number; u1: number }[] = [];
  const edge = (s: number) => track.gaps.some((g) => g.s0 === s || g.s1 === s);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const u0 = cum[i], u1 = cum[i + 1];
    const at = [u0, u1];
    for (const g of track.gaps) for (const c of [g.s0, g.s1]) if (c > u0 && c < u1) at.push(c);
    at.sort((p, q) => p - q);
    const pt = (s: number): Vec => {
      const t = (s - u0) / (u1 - u0 || 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    for (let k = 0; k + 1 < at.length; k++) {
      if (at[k + 1] - at[k] < 1e-6) continue;
      const g = gapAt(track, (at[k] + at[k + 1]) / 2);
      cuts.push({ a: pt(at[k]), b: pt(at[k + 1]), s0: at[k], s1: at[k + 1], gap: g ? track.gaps.indexOf(g) : -1, capA: edge(at[k]), capB: edge(at[k + 1]), road: 0, seg: i, u0: at[k], u1: at[k + 1] });
    }
  }
  const nMain = cuts.length;
  // The shortcuts' pieces after them, road by road: an open road has no piece from its last
  // sample back to its first. Their gaps follow the main road's in one list.
  const gaps: Gap[] = branchy ? [...track.gaps] : track.gaps;
  const gapBase = [0];
  for (let k = 1; k < roads.length; k++) {
    const r = roads[k], base = sBase[k], g0 = gaps.length;
    gapBase.push(g0);
    for (const g of r.gaps) gaps.push({ ...g, s0: g.s0 + base, s1: g.s1 + base });
    const ends = (u: number) => r.gaps.some((g) => g.s0 === u || g.s1 === u);
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const u0 = r.cum[i], u1 = r.cum[i + 1];
      const at = [u0, u1];
      for (const g of r.gaps) for (const c of [g.s0, g.s1]) if (c > u0 && c < u1) at.push(c);
      at.sort((p, q) => p - q);
      const pt = (u: number): Vec => {
        const t = (u - u0) / (u1 - u0 || 1);
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      };
      for (let j = 0; j + 1 < at.length; j++) {
        if (at[j + 1] - at[j] < 1e-6) continue;
        const g = gapAt(r, (at[j] + at[j + 1]) / 2);
        cuts.push({ a: pt(at[j]), b: pt(at[j + 1]), s0: at[j] + base, s1: at[j + 1] + base, gap: g ? g0 + r.gaps.indexOf(g) : -1 - k, capA: ends(at[j]), capB: ends(at[j + 1]), road: k, seg: i, u0: at[j], u1: at[j + 1] });
      }
    }
  }
  const n = cuts.length;
  const f64 = () => new Float64Array(n);
  const art: Art = {
    tiles: new Map(), track, scenery, dress, n,
    ax: f64(), ay: f64(), ex: f64(), ey: f64(), inv: f64(), nx: f64(), ny: f64(), s0: f64(), ds: f64(), dash0: f64(), groove0: f64(), groove1: f64(),
    gap: new Int16Array(n), capA: new Uint8Array(n), capB: new Uint8Array(n),
    road: new Uint8Array(n), roads, sBase, gaps, mouths: [],
    junk: [], piles: [], stains: [], ruts: [], oil: [], patches: [], posts: new Int32Array(0), holes: [], ramps: [], ends: [],
    start: frameAt(track, 0), marks: [],
    recX: Float64Array.from(track.recovery, (s) => pointAt(track, s).x),
    recY: Float64Array.from(track.recovery, (s) => pointAt(track, s).y),
    recRoadX: roads.map((r, k) => (k ? Float64Array.from(r.recovery, (s) => pointAt(r, s).x) : new Float64Array(0))),
    recRoadY: roads.map((r, k) => (k ? Float64Array.from(r.recovery, (s) => pointAt(r, s).y) : new Float64Array(0))),
    recBack: new Int32Array(roads.length),
    wide: wide || branchy, wallMax: wall, wL0: f64(), wL1: f64(), wR0: f64(), wR1: f64(),
    furnished: false, flats: [], things: [],
  };
  if (wide) {
    for (let i = 0; i < pts.length; i++) art.wallMax = Math.max(art.wallMax, track.wallL[i], track.wallR[i]);
    for (let i = 0; i < nMain; i++) {
      const c = cuts[i];
      art.wL0[i] = widenAt(track, c.s0, -1);
      art.wL1[i] = widenAt(track, c.s1, -1);
      art.wR0[i] = widenAt(track, c.s0, 1);
      art.wR1[i] = widenAt(track, c.s1, 1);
    }
  }
  // A shortcut's width is its own: the main road's in its mouths, tapering to its own between
  // them. Per piece what that is more (or less) than the main road's plain width, at its two
  // ends, read as the physics reads it (halfOn: the samples' widths, linear along the segment).
  for (let i = nMain; i < n; i++) {
    const c = cuts[i], r = roads[c.road];
    art.wL0[i] = halfOn(r, c.seg, c.u0, -1) - hw;
    art.wL1[i] = halfOn(r, c.seg, c.u1, -1) - hw;
    art.wR0[i] = halfOn(r, c.seg, c.u0, 1) - hw;
    art.wR1[i] = halfOn(r, c.seg, c.u1, 1) - hw;
  }
  for (let k = 1; k < roads.length; k++) {
    const r = roads[k];
    for (let i = 0; i < r.pts.length; i++) art.wallMax = Math.max(art.wallMax, r.wallL[i], r.wallR[i]);
    // A fall on it before its first recovery point goes back to the main road's before the fork.
    let back = track.recovery.length - 1;
    for (let j = 0; j < track.recovery.length; j++) if (track.recovery[j] <= branches[k - 1].s0) back = j;
    art.recBack[k] = back;
  }
  // A stretch of ground starts where the gap before it ends; a track without gaps at s = 0.
  const runStart = (s: number): number => {
    let best = 0, found = false;
    for (const g of track.gaps) if (g.s1 <= s && (!found || g.s1 > best)) { best = g.s1; found = true; }
    return found ? best : track.gaps.length ? track.gaps[track.gaps.length - 1].s1 : 0;
  };
  // The racing line swings a little from side to side, a whole number of times a lap.
  const swings = Math.max(1, Math.round(L / 1640));
  const groove = (s: number) => 16 * Math.sin((2 * Math.PI * swings * s) / L);
  // What is counted along a shortcut (the kerb's stripes, the centre line's dashes, a wall's
  // joints) and its racing line, so that both run on from the main road's at the fork and meet
  // them again at the merge: where the two roads lie on each other, a pixel of either is the same.
  const whole = (v: number) => (Number.isInteger(v) && v > 0 ? v : 1);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const lcm = (a: number, b: number) => (whole(a) / gcd(whole(a), whole(b))) * whole(b);
  const stripes = lcm(dress.kerbPeriod, 44); // the kerb's two paints and the centre line's dashes come round together after this ...
  const joints = lcm(stripes, dress.block); // ... and a wall's joints with them after this
  const dashOn: ((u: number) => number)[] = [(s) => wrap(s - runStart(s))];
  const grooveOn: ((u: number) => number)[] = [groove];
  branches.forEach((b) => {
    const r = b.road, len = r.length, rg = r.gaps;
    const d0 = dashOn[0](b.s0), d1 = dashOn[0](b.s1);
    if (rg.length === 0) {
      // One stretch of ground from fork to merge: its count runs a little fast or slow, so that
      // it ends on the main road's (under 3 % off for the stripes and the dashes both, else for the kerb alone).
      const p = stripes / 2 <= 0.03 * len ? stripes : dress.kerbPeriod;
      let c = (((d1 - d0 - len) % p) + p) % p;
      if (c > p / 2) c -= p;
      dashOn.push((u) => d0 + u + (c * u) / len);
    } else {
      // The first stretch counts on from the fork, the last one back from the merge, one between two gaps from its start.
      const first = rg[0].s0, last = rg[rg.length - 1].s1;
      const back = d1 - len + Math.ceil(Math.max(0, len - d1) / joints) * joints;
      dashOn.push((u) => {
        if (u <= first) return d0 + u;
        if (u >= last) return back + u;
        let from = 0;
        for (const g of rg) if (g.s1 <= u) from = g.s1;
        return u - from;
      });
    }
    // Its racing line: the main road's at either end, fading to a swing of its own over the mouth.
    const in0 = b.forkGore ? b.forkGore.u : len / 2, in1 = b.mergeGore ? len - b.mergeGore.u : len / 2;
    const g0 = groove(b.s0), g1 = groove(b.s1);
    const amp = Math.max(0, Math.min(16, r.def.halfWidth - 24)), turns = Math.max(1, Math.round(len / 1640));
    grooveOn.push((u) => {
      const w0 = Math.max(0, 1 - u / (in0 || 1)), w1 = Math.max(0, 1 - (len - u) / (in1 || 1));
      return g0 * w0 + g1 * w1 + amp * Math.max(0, 1 - w0 - w1) * Math.sin((2 * Math.PI * turns * u) / len);
    });
  });
  cuts.forEach((c, i) => {
    const ex = (c.b.x - c.a.x) * ZOOM, ey = (c.b.y - c.a.y) * ZOOM;
    const len = Math.hypot(ex, ey) || 1;
    art.ax[i] = c.a.x * ZOOM;
    art.ay[i] = c.a.y * ZOOM;
    art.ex[i] = ex;
    art.ey[i] = ey;
    art.inv[i] = 1 / (len * len);
    art.nx[i] = -ey / len;
    art.ny[i] = ex / len;
    art.s0[i] = c.s0;
    art.ds[i] = c.s1 - c.s0;
    art.dash0[i] = dashOn[c.road](c.u0);
    art.groove0[i] = grooveOn[c.road](c.u0);
    art.groove1[i] = grooveOn[c.road](c.u1);
    art.gap[i] = c.gap;
    art.capA[i] = c.capA ? 1 : 0;
    art.capB[i] = c.capB ? 1 : 0;
    art.road[i] = c.road;
  });

  // A road's mouths, as from, to pairs in its own distances: where a shortcut and the main road
  // lie on each other. Nothing is laid out there: a pixel has the wear of the nearer road, and a
  // repair would be cut off where the other road's pixels begin.
  const mouthsOf: number[][] = roads.map(() => []);
  branches.forEach((b, j) => {
    const fg = b.forkGore, mg = b.mergeGore, len = b.road.length;
    if (fg && mg) {
      mouthsOf[0].push(b.s0, fg.s, mg.s, b.s1);
      mouthsOf[j + 1].push(0, fg.u, mg.u, len);
    } else {
      mouthsOf[0].push(b.s0, b.s1);
      mouthsOf[j + 1].push(0, len);
    }
  });
  // Is the stretch [a, b] of road k clear of every feature (and mouth), with `more` to spare?
  const clear = (k: number, a: number, b: number, more: number): boolean => {
    const r = roads[k];
    for (const x of r.ramps) if (b > x.s - more && a < x.s + x.len + more) return false;
    for (const g of r.gaps) if (b > g.s0 - more && a < g.s1 + more) return false;
    for (const h of r.holes) if (b > h.s - h.r - more && a < h.s + h.r + more) return false;
    const m = mouthsOf[k];
    for (let q = 0; q < m.length; q += 2) if (b > m[q] - more && a < m[q + 1] + more) return false;
    return true;
  };
  const offsetOn = (r: Track, s: number, lat: number): Vec => {
    const p = pointAt(r, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
  };
  const offset = (s: number, lat: number): Vec => offsetOn(track, s, lat);

  // Junk outside the barriers, in small heaps; seeded, so every client sees the same yard.
  // Along every road, and off every road (`away`): a heap by the main road never stands on a shortcut.
  {
    const paints = [RUST1, RUST2, RUST0, HAZ0, STEEL1, RUST1, STEEL2];
    const heaps: Vec[] = [];
    roads.forEach((r, k) => {
      const rnd = mulberry32(7 + 7919 * k);
      const len = r.length, open = k > 0;
      const want = heaps.length + Math.round(len / 150);
      for (let tries = 0; heaps.length < want && tries < 2500; tries++) {
        const s = rnd() * len;
        const side = rnd() < 0.5 ? -1 : 1;
        const at = offsetOn(r, s, side * (r.wall + 40 + rnd() * 150));
        if (away(at.x, at.y) < R + 34) continue;
        if (heaps.some((h) => Math.hypot(h.x - at.x, h.y - at.y) < 90)) continue; // heaps stand apart
        heaps.push(at);
        for (let count = 2 + Math.floor(rnd() * 3), j = 0; j < count; j++) {
          const x = at.x + (rnd() - 0.5) * 52, y = at.y + (rnd() - 0.5) * 40;
          const pick = rnd(), rad = 9 + rnd() * 8, a = rnd() * Math.PI, c = paints[Math.floor(rnd() * paints.length)];
          if (away(x, y) < R + 16) continue;
          const kind = desert ? propKind(pick) : pick < 0.3 ? K_CUBE : pick < 0.46 ? K_DRUM : pick < 0.62 ? K_TYRES : pick < 0.72 ? K_PLATE : pick < 0.82 ? K_PALLET : pick < 0.92 ? K_ENGINE : K_COIL;
          art.junk.push({ kind, x: x * ZOOM, y: y * ZOOM, r: rad * ZOOM, a, c: desert ? propPaint(kind, c) : c });
        }
        // Half the heaps have leaked: a dark stain in the dirt beside them.
        if (rnd() < 0.5) art.stains.push({ x: (at.x + (rnd() - 0.5) * 40) * ZOOM, y: (at.y + 14 + rnd() * 14) * ZOOM, r: (10 + rnd() * 9) * ZOOM });
      }

      // Wheel ruts in the dirt, running along the road for a while outside the wall.
      for (let j = 0, count = Math.round(len / 700); j < count; j++) {
        const from = rnd() * len, run = 140 + rnd() * 220, side = rnd() < 0.5 ? -1 : 1;
        const base = r.wall + 34 + rnd() * 90, swing = 6 + rnd() * 14, wave = 50 + rnd() * 60;
        for (const half of [-6.5, 6.5]) {
          const line: number[] = [];
          for (let u = 0; u <= run; u += 6) {
            if (open && from + u > len) break; // an open road ends
            const q = offsetOn(r, from + u, side * (base + half + swing * Math.sin(u / wave)));
            // A rut stops where another part of the track comes near.
            if (away(q.x, q.y) < R + 14) break;
            line.push(q.x * ZOOM, q.y * ZOOM);
          }
          if (line.length >= 8) art.ruts.push(Float32Array.from(line));
        }
      }
    });
    art.junk.sort((p, q) => p.y - q.y);
  }

  // Scrap filling a gap (drawing only: it is not solid), laid out from the gap's start.
  roads.forEach((r) => {
    for (const g of r.gaps) {
      const i = art.piles.length;
      if (!g.scrap) {
        art.piles.push([]);
        continue;
      }
      const rnd = mulberry32(101 + i);
      const paints = [RUST1, RUST2, RUST0, HAZ0, STEEL1, STEEL2];
      const out: Junk[] = [];
      const W = r.wall - 4;
      for (let s = g.s0 + 9; s < g.s1 - 6; s += 14) {
        for (let lat = -W + 6; lat < W - 4; lat += 16) {
          const p = offsetOn(r, s + (rnd() - 0.5) * 8, lat + (rnd() - 0.5) * 9);
          const pick = rnd(), rad = 7 + rnd() * 6, a = rnd() * Math.PI, c = paints[Math.floor(rnd() * paints.length)];
          // The desert fills a gap with boulders, a car shell among them now and then.
          const kind = desert ? (pick < 0.88 ? K_ROCK : K_SHELL) : pick < 0.34 ? K_CUBE : pick < 0.5 ? K_DRUM : pick < 0.66 ? K_TYRES : pick < 0.78 ? K_PLATE : pick < 0.86 ? K_PALLET : pick < 0.94 ? K_ENGINE : K_COIL;
          out.push({ kind, x: p.x * ZOOM, y: p.y * ZOOM, r: rad * ZOOM, a, c: desert ? propPaint(kind, c) : c });
        }
      }
      // From the top of the screen down, so lower items overlap the ones behind them.
      art.piles.push(out.sort((p, q) => p.y - q.y));
    }
  });

  // Wear on the road: repairs with a joint round them, and oil stains.
  roads.forEach((r, k) => {
    const rnd = mulberry32(31 + 7919 * k);
    const len = r.length, half = r.def.halfWidth, base = sBase[k];
    for (let s = 260 + rnd() * 300; s < len - 500; s += 520 + rnd() * 640) {
      const run = 44 + rnd() * 50, width = 30 + rnd() * 26;
      const l0 = -half + 6 + rnd() * (2 * half - 12 - width);
      if (clear(k, s, s + run, 60)) art.patches.push({ s0: s + base, s1: s + run + base, l0, l1: l0 + width });
    }
    for (let s = 150 + rnd() * 300; s < len - 120; s += 380 + rnd() * 520) {
      const lat = (rnd() - 0.5) * (2 * half - 44), rad = 8 + rnd() * 8;
      if (!clear(k, s - rad, s + rad, 30)) continue;
      const p = offsetOn(r, s, lat);
      art.oil.push({ x: p.x * ZOOM, y: p.y * ZOOM, r: rad * ZOOM });
    }
  });

  // Barrier posts: one every 60 units on both sides of every stretch of ground.
  {
    const posts: number[] = [];
    // Where two roads lie on each other (a mouth), a post of one would stand on the other's
    // asphalt: a post stands only where its own road is the nearer one (BR-BAKE), which is on
    // the wall of the two roads together.
    const own = (k: number, q: Vec): boolean => !branchy || queryRoads(track, q.x, q.y).road === k;
    const runs = track.gaps.length ? track.gaps.map((g, i) => [g.s1, i + 1 < track.gaps.length ? track.gaps[i + 1].s0 : track.gaps[0].s0 + L]) : [[0, L]];
    for (const [from, to] of runs) {
      for (let s = from + 30; s < to; s += 60) {
        for (const side of [-1, 1]) {
          const q = offset(s, side * ((wide ? wallAt(track, s, side) : wall) + 3.2));
          if (!own(0, q)) continue;
          posts.push(Math.round(q.x * ZOOM) - 1, Math.round(q.y * ZOOM) - 1);
        }
      }
    }
    roads.forEach((r, k) => {
      if (k > 0) {
        // A shortcut's stretches of ground, from its fork to its merge; along the first one the
        // posts carry on the main road's count.
        const b = branches[k - 1];
        const stretches: number[][] = [];
        let from = 0;
        for (const g of r.gaps) {
          stretches.push([from, g.s0]);
          from = g.s1;
        }
        stretches.push([from, r.length]);
        stretches.forEach(([a, z], j) => {
          for (let u = j ? a + 30 : (((runStart(b.s0) + 30 - b.s0) % 60) + 60) % 60; u < z; u += 60) {
            const p = pointAt(r, u);
            for (const side of [-1, 1]) {
              const lat = side * (halfOn(r, p.seg, u, side) + r.def.verge + 3.2);
              const q = { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
              if (!own(k, q)) continue;
              posts.push(Math.round(q.x * ZOOM) - 1, Math.round(q.y * ZOOM) - 1);
            }
          }
        });
      }
      // An island's barrier has its posts too, inside its two long sides.
      for (const isle of r.islands) {
        for (let s = isle.s0 + NOSE + 20; s < isle.s1 - NOSE - 8; s += 60) {
          for (const lat of [isle.lat0 + 3.2, isle.lat1 - 3.2]) {
            const q = offsetOn(r, s, lat);
            posts.push(Math.round(q.x * ZOOM) - 1, Math.round(q.y * ZOOM) - 1);
          }
        }
      }
    });
    art.posts = Int32Array.from(posts);
  }

  // Holes: a jagged rim and four cracks each, seeded.
  roads.forEach((r, k) => {
    r.holes.forEach((hole, i) => {
      const rnd = mulberry32(211 + i + 7919 * k);
      const corners = 15;
      const rim = new Float64Array(corners * 2);
      for (let j = 0; j < corners; j++) {
        const a = (j / corners) * Math.PI * 2, rad = hole.r * (1.1 + rnd() * 0.16);
        rim[j * 2] = (hole.x + Math.cos(a) * rad) * ZOOM;
        rim[j * 2 + 1] = (hole.y + Math.sin(a) * rad) * ZOOM;
      }
      const cracks: Float64Array[] = [];
      for (let j = 0; j < 4; j++) {
        const a = rnd() * Math.PI * 2;
        let x = hole.x + Math.cos(a) * hole.r * 1.12, y = hole.y + Math.sin(a) * hole.r * 1.12;
        const line = [x * ZOOM, y * ZOOM];
        for (let q = 0; q < 3; q++) {
          const b = a + (rnd() - 0.5) * 1.1, step = hole.r * (0.18 + rnd() * 0.22);
          x += Math.cos(b) * step;
          y += Math.sin(b) * step;
          line.push(x * ZOOM, y * ZOOM);
        }
        cracks.push(Float64Array.from(line));
      }
      art.holes.push({ x: hole.x * ZOOM, y: hole.y * ZOOM, r: hole.r * ZOOM, rim, cracks });
    });
  });

  // Ramps: the frame its stripes and chevrons are laid out in, and the three chevrons.
  roads.forEach((r, k) => {
    for (const ramp of r.ramps) {
      const frame = frameAt(r, ramp.s + ramp.len / 2);
      const w = r.wall - 1, d = Math.min(9, ramp.len * 0.18);
      const chevrons = [-w * 0.58, 0, w * 0.58].map((lat) => [chevron(frame, d, lat, 3), chevron(frame, d, lat, 1.5)]);
      art.ramps.push({ s0: ramp.s + sBase[k], s1: ramp.s + ramp.len + sBase[k], w, frame, reach: ramp.len / 2 + r.wall + 4, chevrons });
    }
  });

  // Each gap end: the ground lies before s0 and after s1; hazard stripes lie on its last 7 units.
  roads.forEach((r, k) => {
    r.gaps.forEach((g, j) => {
      const i = gapBase[k] + j, half = r.def.halfWidth;
      art.ends.push({ gap: i, s: g.s0 + sBase[k], dir: 1, hw: half, frame: frameAt(r, g.s0 - 3.5) }, { gap: i, s: g.s1 + sBase[k], dir: -1, hw: half, frame: frameAt(r, g.s1 + 3.5) });
    });
  });

  // Grid slots: a worn bracket round each car's nose.
  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    const g = gridSlot(track, slot);
    const f: Frame = { x: g.x * ZOOM, y: g.y * ZOOM, cos: Math.cos(g.h), sin: Math.sin(g.h) };
    for (const [u0, u1, v0, v1] of [[20, 22.5, -14, 14], [8, 20, -14, -11.5], [8, 20, 11.5, 14]]) {
      const quad = new Float64Array(8);
      inFrame(f, u0, v0, quad, 0);
      inFrame(f, u1, v0, quad, 2);
      inFrame(f, u1, v1, quad, 4);
      inFrame(f, u0, v1, quad, 6);
      art.marks.push(quad);
    }
  }

  // What is painted in a shortcut's two mouths (Mouth): the wedge at each gore, the fork's arrows.
  branches.forEach((b, j) => {
    const k = j + 1, r = b.road, base = sBase[k];
    for (const end of [0, 1]) {
      const g = end ? b.mergeGore : b.forkGore;
      if (!g) continue;
      // Walk the shortcut from its end of the mouth to the gore: how far its centreline is from
      // the main road's (the nearest point of it, searched round the last one's segment as a
      // car's is; queryMain: the main road's own query, which in a mouth a car's is not), and
      // the point between them that is as far from the one as from the other (looked for along
      // the shortcut's normal, by halving: `lane` is that distance).
      const from = end ? r.length : 0, dir = end ? -1 : 1, reach = Math.abs(g.u - from);
      let hint = pointAt(track, end ? b.s1 : b.s0).seg;
      let arrowsAt = -1, arrowsS = 0, tip: Vec | null = null, kerbs: Vec | null = null, sideM = 1, sideB = 1;
      for (let d = 0; d <= reach && !kerbs; d += 2) {
        const p = pointAt(r, from + dir * d);
        const q = queryMain(track, p.x, p.y, hint);
        hint = q.seg;
        // The side of the shortcut the main road lies on: as a query's side, of the main road's nearest point.
        const toward = Math.cos(p.h) * -q.ny - Math.sin(p.h) * -q.nx < 0 ? -1 : 1;
        const nx = -Math.sin(p.h) * toward, ny = Math.cos(p.h) * toward;
        let lo = 0, hi = q.dist;
        for (let step = 0; step < 24; step++) {
          const v = (lo + hi) / 2;
          if (queryMain(track, p.x + nx * v, p.y + ny * v, hint).dist > v) lo = v;
          else hi = v;
        }
        const lane = (lo + hi) / 2;
        if (arrowsAt < 0 && q.dist >= MOUTH_ARROW_AT) {
          arrowsAt = from + dir * d;
          arrowsS = q.s;
        }
        if (!tip && lane >= MOUTH_LANE) {
          tip = { x: p.x + nx * lane, y: p.y + ny * lane };
          sideM = q.side;
          sideB = toward;
        }
        if (lane >= hw) kerbs = { x: p.x + nx * lane, y: p.y + ny * lane };
      }
      if (!tip || !kerbs) continue;
      const fx = kerbs.x - tip.x, fy = kerbs.y - tip.y, len = Math.hypot(fx, fy) || 1;
      const frame: Frame = { x: tip.x * ZOOM, y: tip.y * ZOOM, cos: fx / len, sin: fy / len };
      // Its box: the tip, and the gravel's tip with the wedge's width either side of it.
      const across = hw - MOUTH_LANE + 3;
      let x0 = tip.x, y0 = tip.y, x1 = tip.x, y1 = tip.y;
      for (const v of [-across, across]) {
        const x = kerbs.x - frame.sin * v, y = kerbs.y + frame.cos * v;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      const arrows: Float64Array[] = [];
      if (!end && arrowsAt >= 0) {
        // The fork's two arrows, each down its own road on the side away from the other.
        const pm = pointAt(track, arrowsS), pb = pointAt(r, arrowsAt);
        arrows.push(arrow({ x: pm.x * ZOOM, y: pm.y * ZOOM, cos: Math.cos(pm.h), sin: Math.sin(pm.h) }, -sideM * MOUTH_ARROW_LAT));
        arrows.push(arrow({ x: pb.x * ZOOM, y: pb.y * ZOOM, cos: Math.cos(pb.h), sin: Math.sin(pb.h) }, -sideB * MOUTH_ARROW_LAT));
      }
      art.mouths.push({
        x0: Math.floor(x0 * ZOOM) - 2, y0: Math.floor(y0 * ZOOM) - 2, x1: Math.ceil(x1 * ZOOM) + 3, y1: Math.ceil(y1 * ZOOM) + 3,
        road: k, m0: end ? g.s : b.s0, m1: end ? b.s1 : g.s, b0: base + (end ? g.u : 0), b1: base + (end ? r.length : g.u),
        sideM, sideB, frame, len, arrows,
      });
    }
  });
  furnish(art);
  return art;
}

/**
 * The road's furniture of a track (M4-WORLD), laid out once: the rectangles painted flat on
 * the road and the things that stand on it, each with the box of view pixels it is drawn in.
 * Every road's (BR-BAKE): a shortcut's lie along it, their distances as its pieces' (Art.sBase).
 */
function furnish(art: Art): void {
  const dress = art.dress;
  const desert = dress.props === PROPS_DESERT;
  // A thing's box, from the view-pixel box of what is drawn: room for its shadow down-right.
  const thing = (kind: number, x0: number, y0: number, x1: number, y1: number, more: Partial<Thing>): void => {
    art.things.push({ kind, x0: Math.floor(x0) - 2, y0: Math.floor(y0) - 2, x1: Math.ceil(x1) + 9, y1: Math.ceil(y1) + 10, tyres: new Float64Array(0), lie: new Float64Array(0), junk: null, truck: null, ...more });
  };
  /** A heap of tyres as a thing: `list` holds x, y (world units), paint of each, the lowest first. */
  const heap = (list: number[]): void => {
    const count = list.length / 3;
    const out = new Float64Array(count * 4), lie = new Float64Array(count * 2);
    let x0 = BIG, y0 = BIG, x1 = -BIG, y1 = -BIG, mx = 0, my = 0;
    for (let k = 0; k < count; k++) {
      const x = list[k * 3] * ZOOM, y = list[k * 3 + 1] * ZOOM, r = TYRE * ZOOM;
      out.set([x, y, r, list[k * 3 + 2]], k * 4);
      x0 = Math.min(x0, x - r);
      x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r);
      y1 = Math.max(y1, y + r);
      mx += x / count;
      my += y / count;
    }
    // The way each piece lies (a theme whose pieces are not round): across the way to the heap's middle; the one in the middle as it fell.
    for (let k = 0; k < count; k++) {
      const dx = out[k * 4] - mx, dy = out[k * 4 + 1] - my, far = Math.hypot(dx, dy);
      lie[k * 2] = far < 0.5 ? 0.8 : -dy / far;
      lie[k * 2 + 1] = far < 0.5 ? 0.6 : dx / far;
    }
    thing(T_TYRES, x0, y0, x1, y1, { tyres: out, lie });
  };
  /** A mound: rings of tyres one on the other up to a top one, the outer ring painted in the kerb's two colours, so the heap's edge shows on any ground. */
  const mound = (x: number, y: number, r: number, rnd: () => number): void => {
    const list: number[] = [];
    const turn = rnd() * Math.PI * 2;
    for (let ring = 0, rr = r - TYRE; rr >= TYRE * 0.8; ring++, rr -= TYRE * 1.45) {
      let count = Math.max(3, Math.round((2 * Math.PI * rr) / (TYRE * 1.72)));
      if (!ring && count & 1) count++; // the outer ring: its two paints in turn, all the way round
      for (let j = 0; j < count; j++) {
        const a = turn + ring * 0.6 + (j / count) * Math.PI * 2 + (ring ? (rnd() - 0.5) * 0.18 : 0);
        list.push(x + Math.cos(a) * rr, y + Math.sin(a) * rr, ring ? dress.moundInner : j & 1 ? RUST2 : BONE1);
      }
    }
    list.push(x, y, dress.moundTop); // the top of the heap
    heap(list);
  };

  art.roads.forEach((track, road) => {
    const base = art.sBase[road], seeds = 7919 * road;
    const offset = (s: number, lat: number): Vec => {
      const p = pointAt(track, s);
      return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
    };
    // The box of view pixels a rectangle of the road lies in, `pad` world units wider all round.
    const flat = (kind: number, s0: number, s1: number, l0: number, l1: number, pad: number, flip = false): void => {
      let x0 = BIG, y0 = BIG, x1 = -BIG, y1 = -BIG;
      const steps = Math.max(1, Math.ceil((s1 - s0 + 2 * pad) / 12));
      for (let k = 0; k <= steps; k++) {
        const s = s0 - pad + ((s1 - s0 + 2 * pad) * k) / steps;
        for (const lat of [l0 - pad, l1 + pad]) {
          const q = offset(s, lat);
          x0 = Math.min(x0, q.x * ZOOM);
          x1 = Math.max(x1, q.x * ZOOM);
          y0 = Math.min(y0, q.y * ZOOM);
          y1 = Math.max(y1, q.y * ZOOM);
        }
      }
      // A puddle's outline is its own, by the four numbers of its rectangle: the same on every client and in every bake.
      const seed = Math.imul(Math.round(s0 * 4), 73856093) ^ Math.imul(Math.round(s1 * 4), 19349663) ^ Math.imul(Math.round(l0 * 4), 83492791) ^ Math.imul(Math.round(l1 * 4), 265443576);
      const short = Math.min(s1 - s0, l1 - l0);
      const rnd = mulberry32(seed);
      // Its four corners: a tight one, a wide one and two between, dealt out by the seed, so no two are alike.
      const radii = [0, 1, 2, 3].map((k) => PUDDLE_ROUND_MIN + ((PUDDLE_ROUND_MAX - PUDDLE_ROUND_MIN) * (k + 0.15 + 0.7 * rnd())) / 4);
      for (let k = 3; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        [radii[k], radii[j]] = [radii[j], radii[k]];
      }
      const round = Float64Array.from(radii, (r) => Math.min(short / 2, r));
      const lobe = (side: number) => Math.max(60, Math.min(140, side / 2));
      art.flats.push({ kind, s0: s0 + base, s1: s1 + base, l0, l1, x0: Math.floor(x0) - 2, y0: Math.floor(y0) - 2, x1: Math.ceil(x1) + 3, y1: Math.ceil(y1) + 3, flip, seed, round, swell: Math.min(1, short / 48), lobeS: lobe(s1 - s0), lobeL: lobe(l1 - l0) });
    };

    // Painted flat, in this order: the surfaces first (they never overlap each other), then what
    // may lie on one (the lane of a row of barrels, a press's bed), the islands last.
    for (const d of track.dirt) flat(F_DIRT, d.s0, d.s1, d.lat0, d.lat1, 0);
    for (const w of track.water) flat(F_WATER, w.s0, w.s1, w.lat0, w.lat1, 0);
    for (const b of track.belts) flat(F_BELT, b.s0, b.s1, b.lat0, b.lat1, 0);
    for (const b of track.barrels) flat(F_ROW, b.s - BARREL_R - ROW_JAMB, b.s + BARREL_R + ROW_JAMB, b.lat0 - BARREL_R - BARRIER, b.lat1 + BARREL_R + BARRIER, 0, b.speed < 0);
    for (const p of track.presses) flat(F_BED, p.s - PRESS_DEPTH / 2, p.s + PRESS_DEPTH / 2, p.lat0, p.lat1, 0);
    for (const i of track.islands) flat(F_ISLAND, i.s0, i.s1, i.lat0, i.lat1, GORE);

    // Tyre mounds.
    track.tyres.forEach((m, k) => mound(m.x, m.y, m.r, mulberry32(601 + 13 * k + seeds)));

    // Islands: at either end a nose of tyre stacks, two rows across its whole width; between them
    // a strip of the yard behind a barrier, with a piece of junk now and then where it is wide.
    track.islands.forEach((isle, k) => {
      const rnd = mulberry32(811 + 17 * k + seeds);
      const width = isle.lat1 - isle.lat0, mid = (isle.lat0 + isle.lat1) / 2;
      const across = Math.max(2, Math.round(width / (TYRE * 1.8)));
      for (const end of [0, 1]) {
        const list: number[] = [];
        // From the body outward, so the stacks at the very end lie on top.
        for (let row = 1; row >= 0; row--) {
          const count = across - row;
          const s = end ? isle.s1 - TYRE - row * TYRE * 1.9 : isle.s0 + TYRE + row * TYRE * 1.9;
          for (let j = 0; j < count; j++) {
            const q = offset(s, mid + (j - (count - 1) / 2) * ((width - 2 * TYRE) / Math.max(1, across - 1)));
            list.push(q.x, q.y, (j + row) & 1 ? RUST2 : BONE1);
          }
        }
        heap(list);
      }
      const paints = [RUST1, RUST2, RUST0, HAZ0, STEEL1, STEEL2];
      const room = width - 2 * BARRIER - 8; // the yard inside the barrier, less some air
      if (room >= 14) {
        for (let s = isle.s0 + NOSE + 34 + rnd() * 30; s < isle.s1 - NOSE - 30; s += 46 + rnd() * 70) {
          const r = Math.min(room / 2.3, 7 + rnd() * 5);
          const q = offset(s, mid + (rnd() - 0.5) * Math.max(0, room - r * 2.2));
          const pick = rnd(), a = rnd() * Math.PI, c = paints[Math.floor(rnd() * paints.length)];
          // (The desert's island: rocks, scrub and succulents; a car shell has no room.)
          const kind = desert ? (pick < 0.5 ? K_ROCK : pick < 0.72 ? K_SCRUB : K_CACTUS) : pick < 0.3 ? K_CUBE : pick < 0.5 ? K_DRUM : pick < 0.66 ? K_TYRES : pick < 0.76 ? K_PLATE : pick < 0.86 ? K_PALLET : pick < 0.94 ? K_ENGINE : K_COIL;
          const j: Junk = { kind, x: q.x * ZOOM, y: q.y * ZOOM, r: r * ZOOM, a, c: desert ? (kind === K_ROCK ? dress.stones[c === STEEL1 || c === STEEL2 ? 1 : 0] : 0) : c };
          thing(T_JUNK, j.x - j.r * 1.5 - 4, j.y - j.r * 1.5 - 4, j.x + j.r * 1.5 + 4, j.y + j.r * 1.5 + 4, { junk: j });
        }
      }
    });

    // Ramp trucks: the frame of each (its rear end's middle, its heading) and its two arrows.
    for (const t of track.trucks) {
      const len = Math.hypot(t.x1 - t.x0, t.y1 - t.y0) || 1;
      const cos = (t.x1 - t.x0) / len, sin = (t.y1 - t.y0) / len;
      const rx = t.x0 - cos * TRUCK_HALF, ry = t.y0 - sin * TRUCK_HALF; // the rear end's middle
      const lip = t.len - TRUCK_CAB, ramp = Math.min(42, lip * 0.5);
      const at = (u: number): Frame => ({ x: (rx + cos * u) * ZOOM, y: (ry + sin * u) * ZOOM, cos, sin });
      const chevrons = [ramp * 0.52, (ramp + lip - 3) / 2].map((u) => [chevron(at(u), 5.5, 0, 3), chevron(at(u), 5.5, 0, 1.5)]);
      const reach = (t.len / 2 + TRUCK_HALF) * ZOOM;
      const mx = (rx + (cos * t.len) / 2) * ZOOM, my = (ry + (sin * t.len) / 2) * ZOOM;
      thing(T_TRUCK, mx - reach, my - reach, mx + reach, my + reach, { truck: { x: rx * ZOOM, y: ry * ZOOM, cos, sin, len: t.len, ramp, lip, chevrons } });
    }
  });

  // The nose at each gore of a shortcut (BR-BAKE; PLAN-BRANCH.md 2.3): a mound where the two
  // roads' walls part, as large as the one a car meets there (shared/track.ts PlacedGore).
  art.track.branches.forEach((b, k) => {
    for (const g of [b.forkGore, b.mergeGore]) if (g) mound(g.x, g.y, g.noseMain.r, mulberry32(1601 + 13 * art.things.length + 7919 * k));
  });
  art.furnished = art.flats.length + art.things.length > 0;
}

/** A painted arrow pointing along the frame, its middle `lat` to the right of the frame's line: a shaft and a head. */
function arrow(f: Frame, lat: number): Float64Array {
  const half = MOUTH_ARROW / 2, neck = half - 26, shaft = 5, head = 15;
  const out = new Float64Array(14);
  inFrame(f, -half, lat - shaft, out, 0);
  inFrame(f, neck, lat - shaft, out, 2);
  inFrame(f, neck, lat - head, out, 4);
  inFrame(f, half, lat, out, 6);
  inFrame(f, neck, lat + head, out, 8);
  inFrame(f, neck, lat + shaft, out, 10);
  inFrame(f, -half, lat + shaft, out, 12);
  return out;
}

/** A chevron pointing along the frame, `half` wide either side of its line, with a mitred tip. */
function chevron(f: Frame, d: number, lat: number, half: number): Float64Array {
  // The upper arm runs from (-d, lat - 1.3 d) to the tip (d, lat); the lower one mirrors it.
  const len = Math.hypot(2 * d, 1.3 * d);
  const ux = (2 * d) / len, uy = (1.3 * d) / len;
  const px = -uy * half, py = ux * half; // across the upper arm
  // Where the arm's two edges meet the mirror line v = lat: the mitre points.
  const tipOut = d - px + ((py * ux) / uy), tipIn = d + px - ((py * ux) / uy);
  const out = new Float64Array(12);
  inFrame(f, -d + px, lat - 1.3 * d + py, out, 0);
  inFrame(f, tipIn, lat, out, 2);
  inFrame(f, -d + px, lat + 1.3 * d - py, out, 4);
  inFrame(f, -d - px, lat + 1.3 * d + py, out, 6);
  inFrame(f, tipOut, lat, out, 8);
  inFrame(f, -d - px, lat - 1.3 * d - py, out, 10);
  return out;
}

// ---- the bake -----------------------------------------------------------------------

/** The buffers of the one bake in progress, allocated on first use. */
interface Buffers {
  idx: Uint8Array; // palette index per pixel
  cls: Uint8Array; // C_*
  mask: Uint8Array; // the shape being drawn
  dist: Float32Array; // distance to the nearest ground centreline, world units (BIG = far)
  seg: Int16Array; // ... the piece it is on
  tt: Float32Array; // ... how far along the piece, 0..1
  lat: Float32Array; // ... and the signed offset to its right, world units
  gap: Int8Array; // the gap the pixel lies in, or -1
  gapS: Float32Array; // ... its distance along the track there
  gapLat: Float32Array;
  patch: Uint8Array; // 1 + the index of the repair the pixel is on
  rows: Uint8Array[]; // idx again, as the tile's TILE rows (without the margin): made once, for copying a finished tile out
  out: ImageData | null; // the finished tile (browser only)
  out32: Uint32Array;
}

let buf: Buffers | null = null;

function buffers(): Buffers {
  if (!buf) {
    const n = S * S;
    const out = typeof ImageData === "undefined" ? null : new ImageData(TILE, TILE);
    const idx = new Uint8Array(n);
    buf = {
      idx, cls: new Uint8Array(n), mask: new Uint8Array(n),
      rows: Array.from({ length: TILE }, (_, y) => idx.subarray((y + PAD) * S + PAD, (y + PAD) * S + PAD + TILE)),
      dist: new Float32Array(n), seg: new Int16Array(n), tt: new Float32Array(n), lat: new Float32Array(n),
      gap: new Int8Array(n), gapS: new Float32Array(n), gapLat: new Float32Array(n), patch: new Uint8Array(n),
      out, out32: out ? new Uint32Array(out.data.buffer) : new Uint32Array(TILE * TILE),
    };
  }
  return buf;
}

// What takes no track marks (the barrier, the void of a gap, a pit's floor) is told apart as a
// tile is finished, by this bit on its pixels' colours in idx; a scenery's palOff reads a colour
// with or without it. (Bits 5 and 6 are how deeply a pixel is marked, once it is in a tile: see
// "track marks". The tables that turn a byte into a pixel are the tile's theme's: gfx/theme.ts.)
const OFF = KEEP_OFF;
const cand = new Int16Array(1024); // pieces near the tile
const fcand = new Int16Array(64); // flats near the tile (furniture)
const tcand = new Int16Array(256); // things near the tile
// What lies along the tile's pieces (wear): the repairs, the gaps' ends and the ramps whose stretch
// of their road one of the tile's pieces is on. A pixel of the road is asked about these alone:
// a track with shortcut roads has every road's repairs, ends and ramps in one list each
// (BR-BAKE), and a pixel that asked about all of them paid for every road on the track.
const pcand = new Int16Array(256);
const ecand = new Int16Array(64);
const rcand = new Int16Array(64);
const near = new Int16Array(64); // ... near the block
const nearD = new Float32Array(64); // ... and how far from its centre
// For checks: the most pieces `near` and `cand` have held at a time since the page loaded (or
// since bakePeaks(true)). A list that is full leaves pieces out: where two roads lie on each
// other (a shortcut's mouth, BR-BAKE) a block has both roads' pieces near it.
const PEAK = new Int32Array(2);
const polyX = new Float64Array(32);
const polyY = new Float64Array(32);
const crossX = new Float64Array(32);
// The mask's used rows and columns (x1, y1 exclusive).
let mx0 = S, my0 = S, mx1 = 0, my1 = 0;

/** The job: one tile at a time, a step at a time. */
const job = {
  art: null as Art | null,
  tx: 0,
  ty: 0,
  bx: 0, // the buffer's top-left pixel in the track's view-pixel space
  by: 0,
  step: 0,
  sub: 0, // progress inside a step that is cut up further
  track: false, // any piece of the track near this tile?
  voids: false, // ... and one of a gap among them? (only then can a pixel be void)
  wide: false, // ... and one whose road is wider or narrower than the plain width? (only then has a pixel's distance that to take off)
  np: 0, // the repairs, gap ends and ramps along the tile's pieces (in pcand, ecand, rcand)
  ne: 0,
  nr: 0,
  patched: false, // any repair on this tile? (its joint is drawn at the end of the road pass)
  // The box the props of a theme lie in on this tile (x1, y1 exclusive; none while px1 <= px0):
  // their pixels take no marks (finish()).
  px0: S,
  py0: S,
  px1: 0,
  py1: 0,
  nc: 0, // pieces in `cand`
  row: 0, // the furniture step: the next row of the flats, then the next thing
  nf: 0, // flats near this tile, in `fcand`
  nt: 0, // things near it, in `tcand`
  o1: 0, // this tile's offsets into the noise
  o2: 0,
  o3: 0,
};

/** Start baking a tile. */
function bakeStart(art: Art, tx: number, ty: number): void {
  job.art = art;
  job.tx = tx;
  job.ty = ty;
  job.bx = tx * TILE - PAD;
  job.by = ty * TILE - PAD;
  job.step = 0;
  job.sub = 0;
  job.row = 0;
  job.nf = job.nt = 0;
  job.patched = false;
  job.px0 = job.py0 = S;
  job.px1 = job.py1 = 0;
  // The theme's tables, for every step of this tile.
  SHADE_I = art.scenery.shadeI;
  LIT_I = art.scenery.litI;
  // A hash of the tile, 24 bits (as corners() hashes a lattice corner, with seed 17).
  let h = Math.imul(tx, 374761393) ^ Math.imul(ty, 668265263) ^ Math.imul(17, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 8;
  job.o1 = h & 0xffff;
  job.o2 = (Math.imul(h, 40503) >>> 4) & 0xffff;
  job.o3 = (Math.imul(h, 9973) >>> 7) & 0xffff;
}

// The bake allocates nothing once its buffers exist (tools/debug/bake-alloc.ts measures it).
// What that takes, in this file:
// - A number that is not whole is boxed (16 bytes) when it is handed to a function or back
//   from one, unless the compiler happens to inline the call. So such numbers stay inside one
//   function, or go through a typed array: a step's cost through COST, a noise value through
//   NOISE_OUT. The bake's helpers take whole numbers, typed arrays and objects.
// - Math.hypot is a call that boxes its arguments and its result, always: where the bake needs
//   a distance it is spelled out as the same sum (see HYPOT below), which gives the same bits.
// - No for...of (an iterator and a result object per step unless optimised away), no closures.

/** The cost in units of the step bakeStep() just ran. */
const COST = new Float64Array(1);

/**
 * Run the next step of the job: true with the step's cost in COST[0], or false when the tile
 * is finished (its pixels are in out32). The big passes do a slice of the tile per call, so
 * that no step takes much longer than a quarter of a millisecond.
 */
function bakeStep(): boolean {
  switch (job.step) {
    case 0:
      classify();
      return true;
    case 1:
      if (job.art!.dress.ground === G_DUNES) dunes();
      else ground();
      return true;
    case 2:
      yard();
      return true;
    case 3:
      road();
      return true;
    case 4:
      details();
      return true;
    case 5:
      finish();
      return true;
    case 6:
      furniture();
      return true;
    default:
      return false;
  }
}

// HYPOT: Math.hypot(a, b) is, in every V8 since 2015, with u = |a|, v = |b|, m = the larger:
//   m === 0 ? 0 : Math.sqrt((u / m) * (u / m) + (v / m) * (v / m)) * m
// (its compensated sum has no correction to make with two terms). The bake writes that out
// where it needs a distance whose bits decide a pixel; tools/debug/bake-alloc.ts --hypot
// compares the two on twenty million pairs.

/** The job moves on to its next step. */
function next(step = job.step + 1): void {
  job.step = step;
  job.sub = 0;
}

/** Per pixel: the nearest ground of the track and the gap it lies in. A few rows of blocks per call. */
function classify(): void {
  const art = job.art!, b = buffers();
  const { ax, ay, ex, ey, inv, nx, ny, s0, ds, gap, capA, capB, road: roadOf } = art;
  const { bx, by } = job;
  const wall = art.track.wall;
  const reach = (art.wallMax + REACH) * ZOOM + 1; // view pixels
  let wide = art.wide;
  const wL0 = art.wL0, wL1 = art.wL1, wR0 = art.wR0, wR1 = art.wR1;
  if (job.sub === 0) {
    // The pieces that can reach into this tile.
    let nc = 0, voids = false, widened = false;
    for (let i = 0; i < art.n && nc < cand.length; i++) {
      const x0 = ax[i], y0 = ay[i], x1 = x0 + ex[i], y1 = y0 + ey[i];
      if (Math.max(x0, x1) < bx - reach || Math.min(x0, x1) > bx + S + reach) continue;
      if (Math.max(y0, y1) < by - reach || Math.min(y0, y1) > by + S + reach) continue;
      cand[nc++] = i;
      if (gap[i] >= 0) voids = true;
      if (wide && (wL0[i] !== 0 || wL1[i] !== 0 || wR0[i] !== 0 || wR1[i] !== 0)) widened = true;
    }
    job.nc = nc;
    job.track = nc > 0;
    job.voids = voids;
    job.wide = widened;
    if (nc > PEAK[1]) PEAK[1] = nc;
    b.cls.fill(C_NONE);
    b.dist.fill(BIG);
    if (!nc) {
      next();
      COST[0] = 30;
      return;
    }
    b.gap.fill(-1);
    b.patch.fill(0);
  }
  const nc = job.nc;
  wide = job.wide; // of this tile's pieces: nothing to take off a pixel's distance where none is widened
  const reach2 = reach * reach;
  const gapR = (wall + BARRIER) * ZOOM;
  const blockReach = reach + BLOCK_R;
  let tests = 0;
  let y0 = job.sub * BLOCK;
  for (; y0 < S && tests < 330; y0 += BLOCK) {
    for (let x0 = 0; x0 < S; x0 += BLOCK) {
      // The pieces near this block: of each run of neighbours, only those that can be the
      // nearest of the run for some pixel of the block.
      const cx = bx + x0 + BLOCK / 2, cy = by + y0 + BLOCK / 2;
      let nb = 0, run = 0, runMin = BIG, last = -2;
      for (let k = 0; k <= nc; k++) {
        const i = k < nc ? cand[k] : -9;
        let d = BIG;
        if (k < nc) {
          const wx = cx - ax[i], wy = cy - ay[i];
          let t = (wx * ex[i] + wy * ey[i]) * inv[i];
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = wx - ex[i] * t, dy = wy - ey[i] * t;
          d = Math.sqrt(dx * dx + dy * dy);
          if (d > blockReach) continue;
        }
        if (i !== last + 1 || (last >= 0 && gap[i] !== gap[last])) {
          // The run is complete: keep what is within a block's width of its nearest piece.
          if (nb > PEAK[0]) PEAK[0] = nb;
          let keep = run;
          for (let q = run; q < nb; q++) {
            if (nearD[q] > runMin + 2 * BLOCK_R) continue;
            near[keep] = near[q];
            keep++;
          }
          nb = run = keep;
          runMin = BIG;
        }
        if (k === nc || nb === near.length) {
          if (nb > PEAK[0]) PEAK[0] = nb; // (full: the pieces after this one are left out)
          break;
        }
        last = i;
        near[nb] = i;
        nearD[nb++] = d;
        if (d < runMin) runMin = d;
      }
      if (!nb) continue;
      tests += nb;
      // Nearly every block sees only ground with no flat end near it: the nearest piece, plainly.
      let plain = true;
      for (let q = 0; q < nb; q++) {
        const i = near[q];
        if (gap[i] >= 0 || capA[i] || capB[i]) plain = false;
      }
      if (plain) {
        for (let y = y0; y < y0 + BLOCK; y++) {
          const py = by + y + 0.5;
          for (let x = x0; x < x0 + BLOCK; x++) {
            const px = bx + x + 0.5;
            let best = reach2, gi = -1, gt = 0;
            for (let k = 0; k < nb; k++) {
              const i = near[k];
              const wx = px - ax[i], wy = py - ay[i];
              let t = (wx * ex[i] + wy * ey[i]) * inv[i];
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const dx = wx - ex[i] * t, dy = wy - ey[i] * t;
              const d2 = dx * dx + dy * dy;
              if (d2 < best) { best = d2; gi = i; gt = t; }
            }
            if (gi < 0) continue;
            const p = y * S + x;
            b.dist[p] = Math.sqrt(best) * UNIT;
            b.seg[p] = gi;
            b.tt[p] = gt;
            const l = ((px - ax[gi]) * nx[gi] + (py - ay[gi]) * ny[gi]) * UNIT;
            b.lat[p] = l;
            // Beside a widened road: the distance from where the road's edge would be without the widening.
            if (wide) b.dist[p] -= l < 0 ? wL0[gi] + (wL1[gi] - wL0[gi]) * gt : wR0[gi] + (wR1[gi] - wR0[gi]) * gt;
          }
        }
        continue;
      }
      tests += nb; // the careful way costs about twice as much
      for (let y = y0; y < y0 + BLOCK; y++) {
        const py = by + y + 0.5;
        for (let x = x0; x < x0 + BLOCK; x++) {
          const px = bx + x + 0.5;
          let bestG = reach2, gi = -1, gt = 0, bestV = gapR * gapR, vi = -1, vt = 0;
          // The pieces come in runs of neighbours (a stretch of ground, a gap). What counts is
          // the nearest point of each run; if that is a flat end with the pixel beyond it, the
          // run does not reach the pixel (a butt cap: no round end sticking out past a gap's edge).
          let runD = BIG, runI = -1, runT = 0, runPast = false;
          last = -2;
          for (let k = 0; k <= nb; k++) {
            const i = k < nb ? near[k] : -9;
            if (i !== last + 1 || (last >= 0 && gap[i] !== gap[last])) {
              if (runI >= 0 && !runPast) {
                if (gap[runI] < 0) {
                  if (runD < bestG) { bestG = runD; gi = runI; gt = runT; }
                } else if (runD <= bestV) { bestV = runD; vi = runI; vt = runT; }
              }
              runD = BIG;
              runI = -1;
            }
            if (k === nb) break;
            last = i;
            const wx = px - ax[i], wy = py - ay[i];
            let t = (wx * ex[i] + wy * ey[i]) * inv[i];
            let past = false;
            if (t < 0) {
              past = capA[i] === 1;
              t = 0;
            } else if (t > 1) {
              past = capB[i] === 1;
              t = 1;
            }
            const dx = wx - ex[i] * t, dy = wy - ey[i] * t;
            const d2 = dx * dx + dy * dy;
            if (d2 < runD) { runD = d2; runI = i; runT = t; runPast = past; }
          }
          const p = y * S + x;
          if (gi >= 0) {
            b.dist[p] = Math.sqrt(bestG) * UNIT;
            b.seg[p] = gi;
            b.tt[p] = gt;
            const l = ((px - ax[gi]) * nx[gi] + (py - ay[gi]) * ny[gi]) * UNIT;
            b.lat[p] = l;
            if (wide) b.dist[p] -= l < 0 ? wL0[gi] + (wL1[gi] - wL0[gi]) * gt : wR0[gi] + (wR1[gi] - wR0[gi]) * gt;
          }
          if (vi >= 0) {
            const l = ((px - ax[vi]) * nx[vi] + (py - ay[vi]) * ny[vi]) * UNIT;
            if (roadOf[vi] === 0) {
              b.gap[p] = gap[vi];
              b.gapS[p] = s0[vi] + ds[vi] * vt;
              b.gapLat[p] = l;
            } else {
              // A shortcut's gap is as wide as the shortcut: the void ends at its own wall, and
              // the offset across it is kept as the distance is, less what the road is wider there.
              const w = l < 0 ? wL0[vi] + (wL1[vi] - wL0[vi]) * vt : wR0[vi] + (wR1[vi] - wR0[vi]) * vt;
              if (Math.sqrt(bestV) * UNIT - w <= wall + BARRIER) {
                b.gap[p] = gap[vi];
                b.gapS[p] = s0[vi] + ds[vi] * vt;
                b.gapLat[p] = l < 0 ? l + w : l - w;
              }
            }
          }
        }
      }
    }
  }
  if (y0 >= S) next();
  else job.sub = y0 / BLOCK;
  COST[0] = 10 + (nc + tests) * 0.6;
}

/** The dirt: specks whose density drifts in large patches, pebbles, and gravel thrown over the wall. Half the tile per call. */
function ground(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o1, o2, o3 } = job;
  const { idx, dist } = b;
  const R = art.track.wall + BARRIER;
  // The patches: value noise on a 46 px lattice, its corners hashed once per cell and row.
  const CELL = 46;
  const rows = S / 2, from = job.sub * rows;
  for (let y = from; y < from + rows; y++) {
    const Y = by + y;
    const ly = Math.floor(Y / CELL), fy = Y / CELL - ly, sy = fy * fy * (3 - 2 * fy);
    // The row's share of its cells' hashes (seed 11): this row of the lattice and the next.
    const hy0 = Math.imul(ly, 668265263) ^ Math.imul(11, 1442695041), hy1 = Math.imul(ly + 1, 668265263) ^ Math.imul(11, 1442695041);
    let lx = -1e9, a = 0, c = 0, bb = 0, d = 0;
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      if (dist[p] <= R) continue; // the road covers it
      const X = bx + x;
      const cell = Math.floor(X / CELL);
      if (cell !== lx) {
        // The hashes of the cell's four corners, as corners() works them out, written out
        // here: this is the dirt's inner loop, and a call per cell showed in the bake's time.
        lx = cell;
        const hx0 = Math.imul(cell, 374761393), hx1 = Math.imul(cell + 1, 374761393);
        let h = Math.imul(hx0 ^ hy0 ^ ((hx0 ^ hy0) >>> 13), 1274126177);
        a = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
        h = Math.imul(hx1 ^ hy0 ^ ((hx1 ^ hy0) >>> 13), 1274126177);
        bb = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
        h = Math.imul(hx0 ^ hy1 ^ ((hx0 ^ hy1) >>> 13), 1274126177);
        c = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
        h = Math.imul(hx1 ^ hy1 ^ ((hx1 ^ hy1) >>> 13), 1274126177);
        d = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      }
      const fx = X / CELL - cell, sx = fx * fx * (3 - 2 * fx);
      const patch = a + (bb - a) * sx + (c - a) * sy + (a - bb - c + d) * sx * sy;
      const n = N[((((Y + (o1 >> 8)) & 255) << 8) | ((X + o1) & 255))];
      let col = DIRT2;
      if (N[(((((Y >> 1) + (o3 >> 8)) & 255) << 8) | (((X >> 1) + o3) & 255))] < 2) col = GRAVEL0; // a pebble
      else if (n < 8 + 18 * patch) col = DIRT3;
      else if (n > 248 - 23 * (1 - patch)) col = DIRT1;
      const far = dist[p] - R;
      if (far <= FRINGE_FAR) {
        const m = N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2) & 255))];
        if (m < (far <= FRINGE_NEAR ? 108 : 36)) col = m & 1 ? GRAVEL0 : GRAVEL1;
      }
      idx[p] = col;
    }
  }
  if (from + rows >= S) next();
  else job.sub++;
  COST[0] = 170;
}

/**
 * The desert's ground (G_DUNES), where the scrapyard has ground(): sand. Its specks thin and
 * thicken in large patches as the dirt's do; a pebble of grit now and then; sand drifted light
 * against the outside of the wall. Half the tile per call; on it, with the second half, the
 * dunes' crests and the wind's ripples (sandMarks), which are drawn where they are and cost the
 * pixels between them nothing.
 */
function dunes(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o1, o2, o3 } = job;
  const { idx, dist } = b;
  const R = art.track.wall + BARRIER;
  const CELL = 46;
  const rows = S / 2, from = job.sub * rows;
  for (let y = from; y < from + rows; y++) {
    const Y = by + y;
    const ly = Math.floor(Y / CELL), fy = Y / CELL - ly, sy = fy * fy * (3 - 2 * fy);
    // The lattice as ground() hashes it (seed 11); the row's rows of the noise.
    const hy0 = Math.imul(ly, 668265263) ^ Math.imul(11, 1442695041), hy1 = Math.imul(ly + 1, 668265263) ^ Math.imul(11, 1442695041);
    const nRow = ((Y + (o1 >> 8)) & 255) << 8, pRow = (((Y >> 1) + (o3 >> 8)) & 255) << 8, mRow = ((Y + (o2 >> 8)) & 255) << 8;
    // The row a lattice cell at a time: along it the patches' drift runs from pL by dP (times
    // the cell's smooth step), worked out once; the cell's pixels in a loop of their own.
    let x = 0;
    while (x < S) {
      const cell = Math.floor((bx + x) / CELL), X0 = cell * CELL;
      let xe = X0 + CELL - bx; // the cell's end, in the buffer's pixels
      if (xe > S) xe = S;
      const hx0 = Math.imul(cell, 374761393), hx1 = Math.imul(cell + 1, 374761393);
      let h = Math.imul(hx0 ^ hy0 ^ ((hx0 ^ hy0) >>> 13), 1274126177);
      const a = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      h = Math.imul(hx1 ^ hy0 ^ ((hx1 ^ hy0) >>> 13), 1274126177);
      const bb = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      h = Math.imul(hx0 ^ hy1 ^ ((hx0 ^ hy1) >>> 13), 1274126177);
      const c = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      h = Math.imul(hx1 ^ hy1 ^ ((hx1 ^ hy1) >>> 13), 1274126177);
      const d = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      const pL = a + (c - a) * sy, dP = bb + (d - bb) * sy - pL;
      for (; x < xe; x++) {
        const p = y * S + x;
        if (dist[p] <= R) continue; // the road covers it
        const X = bx + x;
        const fx = (X - X0) / CELL;
        const patch = pL + dP * fx * fx * (3 - 2 * fx);
        // Specks, fewer than the dirt's.
        const n = N[nRow | ((X + o1) & 255)];
        let col = DIRT2;
        if (N[pRow | (((X >> 1) + o3) & 255)] < 1) col = GRAVEL0; // a pebble
        else if (n < 5 + 9 * patch) col = DIRT3;
        else if (n > 251 - 6 * (1 - patch)) col = DIRT1;
        // Sand drifted against the wall: light, dense at its foot.
        const far = dist[p] - R;
        if (far <= FRINGE_FAR) {
          const m = N[mRow | ((X + o2) & 255)];
          if (m < (far <= FRINGE_NEAR ? 120 : 40)) col = m & 3 ? DIRT3 : GRAVEL1;
        }
        idx[p] = col;
      }
    }
  }
  // Costed as ground() is, 340 units a tile with the marks (measured, it takes about a quarter
  // less time than that: tools/debug/world-bench.ts --units).
  if (from + rows >= S) {
    sandMarks();
    next();
    COST[0] = 155 + SAND_MARKS;
  } else {
    job.sub++;
    COST[0] = 155;
  }
}

// The marks of the wind on the sand, laid out on two grids of cells over the plane (a cell's
// hash says what it holds, so a tile is still a pure function of its place, and a mark that
// crosses a tile's edge is the same pixels on both sides).
const DUNE = 92; // a cell of the dunes' grid, view pixels: one crest in most of them
const DUNE_REACH = 68; // a crest reaches no further than this past its cell (1.2 times the largest radius: the arc is the circle's upper left)
const RIPPLES = 64; // a cell of the ripples' grid: a field of ripples in some of them
const SAND_MARKS = 30; // what sandMarks() costs a tile, in cost units (about: it is a few thousand pixels)

/**
 * The dunes' crests and the wind's ripples, on the sand of the whole tile.
 * - A crest is an arc that bulges toward the upper left, where the sun is: a light edge on its
 *   outside and the slip face's shade inside it, broad in the middle and thinning to nothing at
 *   its two horns (a crescent).
 * - Ripples lie in fields: a dozen or so short dashes, each a light pixel row over a dark one.
 * Only sand takes them (not the road, and not the drift at the wall's foot).
 */
function sandMarks(): void {
  const art = job.art!, b = buffers();
  const { bx, by } = job;
  const { idx, dist } = b;
  const clear = art.track.wall + BARRIER + FRINGE_NEAR; // nearer the centreline than this: the wall's foot, the road
  // Crests.
  for (let gy = Math.floor((by - DUNE_REACH) / DUNE), gy1 = Math.floor((by + S + DUNE_REACH) / DUNE); gy <= gy1; gy++) {
    for (let gx = Math.floor((bx - DUNE_REACH) / DUNE), gx1 = Math.floor((bx + S + DUNE_REACH) / DUNE); gx <= gx1; gx++) {
      let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263) ^ Math.imul(41, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      if ((h & 255) >= 184) continue; // no crest in this cell
      let h2 = Math.imul(h, 40503) ^ (h >>> 9);
      h2 = Math.imul(h2 ^ (h2 >>> 13), 1274126177);
      // The circle the arc is part of: its middle, its radius; the arc's middle (up-left of the
      // circle's, a turn of 225 degrees give or take 28) and half its length (30 to 58 degrees).
      const r = 24 + ((h >>> 24) & 31);
      const cx = gx * DUNE + ((((h >>> 8) & 255) * DUNE) >> 8) + (r >> 1), cy = gy * DUNE + ((((h >>> 16) & 255) * DUNE) >> 8) + (r >> 1);
      const mid = 3.927 + (((h2 & 255) - 128) / 128) * 0.49, half = 0.52 + (((h2 >>> 8) & 255) / 255) * 0.49;
      const broad = 3 + ((h2 >>> 16) & 3) * 0.7; // the shade at its broadest, pixels
      const steps = Math.ceil(2 * half * r);
      const turn = (2 * half) / steps, cd = Math.cos(turn), sd = Math.sin(turn);
      let ux = Math.cos(mid - half), uy = Math.sin(mid - half);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, w = broad * 4 * t * (1 - t);
        // The light edge (two pixels of it along the crest's middle), then the shade inward of it.
        for (let k = w > 2 ? -1 : w > 0.45 ? 0 : 1; k <= w; k++) {
          const x = Math.floor(cx + (r - k) * ux + 0.5) - bx, y = Math.floor(cy + (r - k) * uy + 0.5) - by;
          if (x < 0 || y < 0 || x >= S || y >= S) continue;
          const p = y * S + x;
          if (dist[p] > clear) idx[p] = k <= 0 ? DIRT3 : DIRT1;
        }
        const nx = ux * cd - uy * sd;
        uy = ux * sd + uy * cd;
        ux = nx;
      }
    }
  }
  // Ripples.
  for (let gy = Math.floor((by - 2) / RIPPLES), gy1 = Math.floor((by + S) / RIPPLES); gy <= gy1; gy++) {
    for (let gx = Math.floor((bx - 8) / RIPPLES), gx1 = Math.floor((bx + S) / RIPPLES); gx <= gx1; gx++) {
      let h = Math.imul(gx, 374761393) ^ Math.imul(gy, 668265263) ^ Math.imul(43, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h ^= h >>> 16;
      if ((h & 255) >= 104) continue; // no field in this cell
      for (let k = 0, count = 9 + ((h >>> 8) & 7); k < count; k++) {
        let q = Math.imul(h ^ Math.imul(k + 1, 0x9e3779b1), 1274126177);
        q ^= q >>> 15;
        // Where the dash begins in the cell (its upper row on an even row of the plane) and how long it is.
        const X = gx * RIPPLES + (q & 63), Y = gy * RIPPLES + ((q >>> 6) & 62), len = 3 + ((q >>> 12) & 3);
        const y = Y - by;
        if (y < -1 || y >= S) continue;
        for (let i = 0; i < len; i++) {
          const x = X + i - bx;
          if (x < 0 || x >= S) continue;
          if (y >= 0 && dist[y * S + x] > clear) idx[y * S + x] = DIRT3;
          if (y + 1 < S && dist[(y + 1) * S + x] > clear) idx[(y + 1) * S + x] = DIRT1;
        }
      }
    }
  }
}

/** What lies on the dirt: stains, wheel ruts, and the junk heaps with their shadows. */
function yard(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o2 } = job;
  const { idx, dist } = b;
  const R = art.track.wall + BARRIER;
  let cost = 8;
  const stains = art.stains, ruts = art.ruts, heaps = art.junk;
  for (let q = 0; q < stains.length; q++) {
    const st = stains[q];
    const x0 = Math.max(0, Math.floor(st.x - st.r * 1.3 - bx)), x1 = Math.min(S - 1, Math.ceil(st.x + st.r * 1.3 - bx));
    const y0 = Math.max(0, Math.floor(st.y - st.r - by)), y1 = Math.min(S - 1, Math.ceil(st.y + st.r - by));
    if (x0 > x1 || y0 > y1) continue;
    cost += (x1 - x0 + 1) * (y1 - y0 + 1) * 0.03;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * S + x;
        if (dist[p] <= R) continue;
        const X = bx + x, Y = by + y;
        // How far out in the stain, 0..1 at its ragged edge: Math.hypot(...) / (...), the distance spelled out (HYPOT).
        const u = Math.abs(X + 0.5 - st.x), v = Math.abs((Y + 0.5 - st.y) * 1.4), m = u > v ? u : v;
        stainNoise(X, Y);
        const d = (m === 0 ? 0 : Math.sqrt((u / m) * (u / m) + (v / m) * (v / m)) * m) / (st.r * (0.55 + 0.6 * NOISE_OUT[0]));
        const n = N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2 + 91) & 255))];
        if (d < 0.6 ? n < 215 : d < 1 && n < 105) idx[p] = DIRT1;
      }
    }
  }
  for (let q = 0; q < ruts.length; q++) {
    const rut = ruts[q];
    for (let k = 0; k + 3 < rut.length; k += 2) {
      const xa = rut[k] - bx, ya = rut[k + 1] - by, xb = rut[k + 2] - bx, yb = rut[k + 3] - by;
      if (Math.max(xa, xb) < 0 || Math.min(xa, xb) >= S || Math.max(ya, yb) < 0 || Math.min(ya, yb) >= S) continue;
      const steps = Math.ceil(Math.max(Math.abs(xb - xa), Math.abs(yb - ya)));
      for (let j = 0; j < steps; j++) {
        const x = Math.floor(xa + ((xb - xa) * j) / steps), y = Math.floor(ya + ((yb - ya) * j) / steps);
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const p = y * S + x;
        if (dist[p] <= R) continue;
        // A broken line: the rut shows where the ground is soft.
        if (N[(((((by + y) >> 2) + (o2 >> 8)) & 255) << 8) | ((((bx + x) >> 2) + o2 + 37) & 255)] < 170) idx[p] = DIRT1;
      }
      cost += 0.4;
    }
  }
  for (let q = 0; q < heaps.length; q++) {
    const d = heaps[q];
    const reach = d.r * 1.5 + 6;
    if (d.x + reach < bx || d.x - reach > bx + S || d.y + reach < by || d.y - reach > by + S) continue;
    junk(d);
    cost += 4;
  }
  next(job.track ? 3 : 5);
  COST[0] = cost;
}

/**
 * The repairs, the gaps' ends and the ramps along the tile's pieces, into pcand, ecand and rcand
 * (in their lists' order): those whose stretch one of the pieces touches. A pixel of the road is
 * `s` along its own piece, so no other can be under it: road() asks about these alone, and what
 * it paints is what it painted when it asked about all.
 */
function along(): void {
  const art = job.art!;
  const { s0, ds } = art;
  const nc = job.nc;
  const patches = art.patches, ends = art.ends, ramps = art.ramps;
  let np = 0, ne = 0, nr = 0;
  for (let q = 0; q < patches.length && np < pcand.length; q++) {
    const pa = patches[q];
    for (let k = 0; k < nc; k++) {
      const i = cand[k];
      if (s0[i] > pa.s1 || s0[i] + ds[i] < pa.s0) continue;
      pcand[np++] = q;
      break;
    }
  }
  // An end: the 7 units before its edge (either side of it is asked: the nearer side costs nothing).
  for (let q = 0; q < ends.length && ne < ecand.length; q++) {
    const at = ends[q].s;
    for (let k = 0; k < nc; k++) {
      const i = cand[k];
      if (s0[i] > at + 7 || s0[i] + ds[i] < at - 7) continue;
      ecand[ne++] = q;
      break;
    }
  }
  // A ramp: its plate, and its lip's shadow on the 9 units beyond.
  for (let q = 0; q < ramps.length && nr < rcand.length; q++) {
    const rp = ramps[q];
    for (let k = 0; k < nc; k++) {
      const i = cand[k];
      if (s0[i] > rp.s1 + 9 || s0[i] + ds[i] < rp.s0) continue;
      rcand[nr++] = q;
      break;
    }
  }
  job.np = np;
  job.ne = ne;
  job.nr = nr;
}

/** The track itself: the void of a gap, then barrier, verge, kerb and tarmac with what is painted and worn on it. */
function road(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o1 } = job;
  const { idx, cls, dist, seg, tt, lat: latOf, gap: gapOf, gapS, gapLat, patch } = b;
  const track = art.track;
  const wall = track.wall, hw = track.def.halfWidth;
  const R = wall + BARRIER, hw5 = hw + KERB;
  const { s0, ds, dash0, groove0, groove1 } = art;
  const gaps = art.gaps, ramps = art.ramps, ends = art.ends, patches = art.patches;
  const nc = job.nc, pieceGap = art.gap;
  if (job.sub === 0) along();
  const np = job.np, ne = job.ne, nr = job.nr;
  // The theme's dressing of the bands.
  const dress = art.dress;
  const WALL = dress.wall, RAIL = dress.rail, BLOCK = dress.block, JOINT = dress.joint;
  const vLight = dress.vergeLight, vDark = dress.vergeDark, vFleck = dress.vergeFleck;
  const kerbPeriod = dress.kerbPeriod, kerbOn = dress.kerbOn;
  const canyon = dress.canyon, rock = dress.rock, rubble = dress.rubble;
  const ROCK0 = rock[0], ROCK1 = rock[1], ROCK2 = rock[2], ROCK3 = rock[3];
  const RUB0 = rubble[0], RUB1 = rubble[1], RUB2 = rubble[2], RUB3 = rubble[3];
  const from = job.sub;
  let work = 0, y = from;
  for (; y < S && work < 11000; y++) {
    const Y = by + y;
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      const d = dist[p];
      const g = gapOf[p];
      if (d > R) {
        if (g < 0) continue; // dirt
        work++;
        // The void of a gap: dark, its earth walls in steps, the walls that face the sun lighter.
        const X = bx + x;
        const n = N[((((Y + (o1 >> 8)) & 255) << 8) | ((X + o1) & 255))];
        const gp = gaps[g];
        const s = gapS[p], l = gapLat[p];
        const side = R - Math.abs(l), head = s - gp.s0, tail = gp.s1 - s;
        const e = Math.min(side, head, tail);
        let c: number;
        if (gp.scrap && Math.abs(l) <= wall - 2 && head >= 2 && tail >= 2) {
          // Rubble under the scrap.
          c = n < 16 ? RUB0 : n < 32 ? RUB1 : n < 35 ? RUB2 : RUB3;
        } else if (e >= 30) {
          c = n < 18 ? SOOT0 : n < 28 ? SOOT2 : SOOT1;
        } else {
          // Which wall is this the foot of, and does it face the sun (down-right walls do)? By the
          // piece of the gap the pixel lies on: the first of the tile's pieces that holds its
          // distance along the track (looked up here, in place: a call per pixel showed in the bake's time).
          let i = -1;
          for (let q = 0; q < nc && i < 0; q++) {
            const o = cand[q];
            if (pieceGap[o] === g && s >= s0[o] - 1e-6 && s <= s0[o] + ds[o] + 1e-6) i = o;
          }
          if (i < 0) {
            i = 0;
            for (let o = 0; o < art.n; o++) {
              if (pieceGap[o] === g) {
                i = o;
                break;
              }
            }
          }
          let wx: number, wy: number; // the wall's normal, pointing into the void
          if (side <= head && side <= tail) {
            const k = l > 0 ? -1 : 1;
            wx = art.nx[i] * k;
            wy = art.ny[i] * k;
          } else {
            const k = head < tail ? 1 : -1;
            wx = art.ny[i] * k;
            wy = -art.nx[i] * k;
          }
          const away = wx + wy > 0;
          if (canyon) {
            // Layered rock: beds a few units thick stepping down from the rim, in the theme's
            // stone where a wall faces the sun; the walls away from it and all below are soot.
            if (away) c = e < 3 ? ROCK1 : e < 6 ? ROCK0 : e < 8 ? SOOT3 : e < 9.2 ? SOOT1 : e < 13 ? SOOT3 : e < 14.4 ? SOOT1 : e < 21 ? SOOT2 : n < 40 ? SOOT0 : SOOT1;
            else c = e < 3 ? ROCK3 : e < 6 ? ROCK2 : e < 8 ? ROCK1 : e < 9.2 ? ROCK0 : e < 13 ? ROCK1 : e < 14.4 ? SOOT3 : e < 21 ? (n < 110 ? ROCK0 : SOOT3) : n < 128 ? SOOT2 : SOOT1;
          } else c = e < 6 ? (away ? SOOT3 : DIRT0) : e < 13 ? (away ? SOOT2 : SOOT3) : e < 21 ? (away ? SOOT1 : SOOT2) : away ? (n < 40 ? SOOT0 : SOOT1) : n < 128 ? SOOT2 : SOOT1;
        }
        // The drop just inside each end, in the shade of the road above.
        if (Math.abs(l) <= wall && (head <= 10 || tail <= 10)) c = SHADE_I[c];
        idx[p] = c;
        cls[p] = C_VOID;
        continue;
      }
      work++;
      const X = bx + x;
      const n = N[((((Y + (o1 >> 8)) & 255) << 8) | ((X + o1) & 255))];
      const i = seg[p], t = tt[p], l = latOf[p];
      const s = s0[i] + ds[i] * t;
      let c: number, k: number;
      if (d > wall) {
        const out = d - wall;
        if (out > RAIL_IN && out <= RAIL_OUT) {
          // The band's bright middle: a rail; or the tops of blocks, a joint between them.
          c = BLOCK > 0 && (dash0[i] + ds[i] * t) % BLOCK < 1.4 ? JOINT : RAIL;
          k = C_RAIL;
        } else { c = WALL; k = C_BARRIER; }
      } else {
        if (d > hw5) {
          c = n < vLight ? GRAVEL2 : n > vDark ? GRAVEL0 : n > vFleck ? BONE0 : GRAVEL1;
          k = C_VERGE;
        } else if (d > hw) {
          c = (dash0[i] + ds[i] * t) % kerbPeriod < kerbOn ? RUST2 : BONE1;
          k = C_KERB;
        } else {
          k = C_TARMAC;
          // Worn along the racing line: more rubber and oil, fewer light specks.
          const worn = Math.abs(l - (groove0[i] + (groove1[i] - groove0[i]) * t)) < 17;
          c = n < (worn ? 77 : 13) ? TAR0 : n > (worn ? 252 : 238) ? TAR2 : TAR1;
          for (let q = 0; q < np; q++) {
            const pa = patches[pcand[q]];
            if (s < pa.s0 || s > pa.s1 || l < pa.l0 || l > pa.l1) continue;
            c = n < 77 ? TAR2 : n > 248 ? TAR0 : TAR1; // a repair: a lighter mix
            patch[p] = pcand[q] + 1;
            job.patched = true;
          }
          if (Math.abs(l) < 1.25 && (dash0[i] + ds[i] * t) % 44 < 18) c = TAR3; // the centre line
        }
        // A gap's end on the road: hazard stripes, then the broken edge.
        for (let q = 0; q < ne; q++) {
          const en = ends[ecand[q]];
          const back = (en.s - s) * en.dir; // how far before the edge
          if (back < 0 || back > 7) continue;
          if (Math.abs(l) <= en.hw + KERB) {
            const f = en.frame;
            const rx = (X + 0.5 - f.x) * UNIT, ry = (Y + 0.5 - f.y) * UNIT;
            const u = rx * f.cos + ry * f.sin, v = -rx * f.sin + ry * f.cos;
            c = Math.floor((u - v + 2 * (en.hw + 14) + 5) / 5) & 1 ? HAZ1 : SOOT2;
          }
          if (back <= 2) c = GRAVEL2;
        }
        for (let q = 0; q < nr; q++) {
          const rp = ramps[rcand[q]];
          // (rp.w: its road's wall less 1. A shortcut's ramp is as wide as the shortcut.)
          if (s > rp.s1) {
            // The lip's shadow on what lies beyond it.
            if (s <= rp.s1 + 9 && l >= -rp.w + 4 && l <= rp.w + 4) c = SHADE_I[c];
            continue;
          }
          if (s < rp.s0 || Math.abs(l) > rp.w) continue;
          k = C_PLATE;
          if (s >= rp.s1 - 3) {
            c = HAZ1; // the lip
            continue;
          }
          // A striped plate rising to the lip: dark at the foot, light at the top, in three steps.
          const f = rp.frame;
          const rx = (X + 0.5 - f.x) * UNIT, ry = (Y + 0.5 - f.y) * UNIT;
          const u = rx * f.cos + ry * f.sin, v = -rx * f.sin + ry * f.cos;
          const base = Math.floor((u - v + 2 * rp.reach + 6) / 6) & 1 ? STEEL2 : RUST2;
          const rise = (s - rp.s0) / (rp.s1 - rp.s0);
          const seam = (X + Y) & 1;
          c = rise < 0.34 ? (rise > 0.31 && seam ? base : SHADE_I[base]) : rise > 0.67 ? (rise < 0.7 && seam ? base : LIT_I[base]) : base;
          // Its dark outline.
          if (Math.abs(l) > rp.w - 1.6 || s < rp.s0 + 1.6) c = SOOT2;
        }
      }
      // A lower road passing under a gap sits in shade, darker still just under each end.
      if (g >= 0) {
        c = SHADE_I[c];
        const gp = gaps[g];
        if (Math.abs(gapLat[p]) <= wall && (gapS[p] - gp.s0 <= 10 || gp.s1 - gapS[p] <= 10)) c = SHADE_I[c];
      }
      idx[p] = c;
      cls[p] = k;
    }
  }
  const cost = 8 + (y - from) * 0.14 + work * 0.019;
  if (y < S) {
    job.sub = y;
    COST[0] = cost;
    return;
  }
  // The joint round a repair: dark where the patch ends down-right.
  if (job.patched) {
    for (let y = 0; y < S - 1; y++) {
      for (let x = 0; x < S - 1; x++) {
        const p = y * S + x;
        if (patch[p] && (patch[p + 1] !== patch[p] || patch[p + S] !== patch[p]) && cls[p] === C_TARMAC) idx[p] = TAR0;
      }
    }
  }
  next();
  COST[0] = job.patched ? cost + 90 : cost;
}

/**
 * What is drawn over the road, a part per call: the start line, the grid marks and oil;
 * pits and a ramp's chevrons; the scrap in a gap, sixteen pieces at a time.
 */
function details(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o2 } = job;
  const { idx, cls, mask } = b;
  const hw = art.track.def.halfWidth;
  const part = job.sub++;
  let cost = 6;
  if (part === 0) {
    // Start/finish: a chequered strip across the road at s = 0, two rows of 8-unit squares.
    const f = art.start;
    const reach = (hw + 12) * ZOOM;
    const x0 = Math.max(0, Math.floor(f.x - reach - bx)), x1 = Math.min(S - 1, Math.ceil(f.x + reach - bx));
    const y0 = Math.max(0, Math.floor(f.y - reach - by)), y1 = Math.min(S - 1, Math.ceil(f.y + reach - by));
    if (x0 <= x1 && y0 <= y1) cost += (x1 - x0 + 1) * (y1 - y0 + 1) * 0.02;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const rx = (bx + x + 0.5 - f.x) * UNIT, ry = (by + y + 0.5 - f.y) * UNIT;
        const u = rx * f.cos + ry * f.sin, v = -rx * f.sin + ry * f.cos;
        if (u < -8 || u >= 8 || v < -hw || v >= hw) continue;
        idx[y * S + x] = (Math.floor((v + hw) / 8) + (u >= 0 ? 1 : 0)) & 1 ? SOOT2 : BONE2;
      }
    }
    // Grid marks: worn paint, on tarmac only.
    const marks = art.marks, oil = art.oil;
    for (let q = 0; q < marks.length; q++) {
      if (!polyFrom(marks[q], bx, by)) continue;
      cost += 6;
      fillPoly(mask, 1);
      for (let y = my0; y < my1; y++) {
        for (let x = mx0; x < mx1; x++) {
          const p = y * S + x;
          if (mask[p] && cls[p] === C_TARMAC && N[((((by + y + (o2 >> 8)) & 255) << 8) | ((bx + x + o2 + 53) & 255))] < 205) idx[p] = TAR3;
        }
      }
      maskClear(mask);
    }
    // Oil on the tarmac: a dark blot with a ragged edge.
    for (let q = 0; q < oil.length; q++) {
      const st = oil[q];
      const xa = Math.max(0, Math.floor(st.x - st.r * 1.3 - bx)), xb = Math.min(S - 1, Math.ceil(st.x + st.r * 1.3 - bx));
      const ya = Math.max(0, Math.floor(st.y - st.r - by)), yb = Math.min(S - 1, Math.ceil(st.y + st.r - by));
      if (xa > xb || ya > yb) continue;
      cost += (xb - xa + 1) * (yb - ya + 1) * 0.03;
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const p = y * S + x;
          if (cls[p] !== C_TARMAC || idx[p] === TAR3) continue;
          const X = bx + x, Y = by + y;
          // As a stain in the dirt: Math.hypot(...) / (...), the distance spelled out (HYPOT).
          const u = Math.abs(X + 0.5 - st.x), v = Math.abs((Y + 0.5 - st.y) * 1.5), m = u > v ? u : v;
          stainNoise(X, Y);
          const d = (m === 0 ? 0 : Math.sqrt((u / m) * (u / m) + (v / m) * (v / m)) * m) / (st.r * (0.55 + 0.6 * NOISE_OUT[0]));
          if (d < 0.6 || (d < 1 && N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2 + 91) & 255))] < 128)) idx[p] = TAR0;
        }
      }
    }
    COST[0] = cost;
    return;
  }
  if (part === 1) {
    const holes = art.holes, ramps = art.ramps;
    for (let q = 0; q < holes.length; q++) {
      const h = holes[q];
      const reach = h.r * 1.9 + 2;
      if (h.x + reach < bx || h.x - reach > bx + S || h.y + reach < by || h.y - reach > by + S) continue;
      pit(h);
      cost += 12 + h.r * h.r * 0.12;
    }
    for (let q = 0; q < ramps.length; q++) {
      const chevrons = ramps[q].chevrons;
      for (let j = 0; j < chevrons.length; j++) {
        // The dark outline first, the bone-white arrow inside it; both on the plate only.
        for (let k = 0; k < 2; k++) {
          if (!polyFrom(chevrons[j][k], bx, by)) continue;
          cost += 5;
          const colour = k ? BONE1 : SOOT2;
          fillPoly(mask, 1);
          for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] && cls[y * S + x] === C_PLATE) idx[y * S + x] = colour;
          maskClear(mask);
        }
      }
    }
    if (art.mouths.length) cost += mouths();
    COST[0] = cost;
    return;
  }
  // The scrap in a gap lies in the gap: where a piece hangs over the road's end it is cut off
  // (the hazard stripes, the edge and a ramp's lip stay whole, as they always were).
  let skip = (part - 2) * 16, done = 0;
  clipClass = C_VOID;
  const piles = art.piles;
  for (let q = 0; q < piles.length; q++) {
    const pile = piles[q];
    for (let j = 0; j < pile.length; j++) {
      const d = pile[j];
      const reach = d.r * 1.5 + 6;
      if (d.x + reach < bx || d.x - reach > bx + S || d.y + reach < by || d.y - reach > by + S) continue;
      if (skip-- > 0) continue;
      if (done === 16) {
        clipClass = -1;
        COST[0] = cost + done * 8;
        return;
      }
      done++;
      junk(d);
    }
  }
  clipClass = -1;
  next(art.furnished ? 6 : 5); // the road's furniture, where a track has any, before the tile is finished
  COST[0] = cost + done * 8;
}

/**
 * What is painted where a shortcut leaves the main road and where it rejoins it (Mouth), on
 * asphalt only and worn, as the wedge before an island's nose is: the striped wedge between the
 * two roads and the fork's two arrows. Returns its cost in units (a whole number).
 */
function mouths(): number {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o2 } = job;
  const { idx, cls, mask, dist, seg, tt, lat: latOf } = b;
  const { s0, ds, road: roadOf } = art;
  const list = art.mouths;
  let cost = 0;
  for (let q = 0; q < list.length; q++) {
    const m = list[q];
    const xa = m.x0 - bx > 0 ? m.x0 - bx : 0, xb = m.x1 - bx < S ? m.x1 - bx : S;
    const ya = m.y0 - by > 0 ? m.y0 - by : 0, yb = m.y1 - by < S ? m.y1 - by : S;
    if (xa < xb && ya < yb) {
      cost += 4 + (((xb - xa) * (yb - ya)) >> 6); // as a painted box is costed elsewhere: about 0.02 a pixel
      const f = m.frame;
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          const p = y * S + x;
          if (cls[p] !== C_TARMAC) continue;
          // Further than a lane from its own road's centreline, on the side the other road is on ...
          const e = dist[p] - MOUTH_LANE;
          if (!(e > 0)) continue;
          const i = seg[p], l = latOf[p];
          const s = s0[i] + ds[i] * tt[p];
          if (roadOf[i] === 0 ? s < m.m0 || s > m.m1 || l * m.sideM <= 0 : roadOf[i] !== m.road || s < m.b0 || s > m.b1 || l * m.sideB <= 0) continue;
          // ... and between the wedge's tip and the tip of the gravel: an outline, and stripes
          // that point back at the tip from either side.
          const rx = (bx + x + 0.5 - f.x) * UNIT, ry = (by + y + 0.5 - f.y) * UNIT;
          const along = rx * f.cos + ry * f.sin;
          if (along < 0 || along > m.len) continue;
          if (e >= 1.7 && m.len - along >= 1.7 && Math.floor((along + e) / MOUTH_STRIPE) & 1) continue;
          if (N[((((by + y + (o2 >> 8)) & 255) << 8) | ((bx + x + o2 + 53) & 255))] < 214) idx[p] = BONE1;
        }
      }
    }
    const arrows = m.arrows;
    for (let j = 0; j < arrows.length; j++) {
      if (!polyFrom(arrows[j], bx, by)) continue;
      cost += 6;
      fillPoly(mask, 1);
      for (let y = my0; y < my1; y++) {
        for (let x = mx0; x < mx1; x++) {
          const p = y * S + x;
          if (mask[p] && cls[p] === C_TARMAC && N[((((by + y + (o2 >> 8)) & 255) << 8) | ((bx + x + o2 + 53) & 255))] < 214) idx[p] = BONE1;
        }
      }
      maskClear(mask);
    }
  }
  return cost;
}

/**
 * The barrier's depth (its cast shadow, the rail's sunlit edge, the posts), and the tile's
 * pixels. Here the pixels that take no track marks get their bit (OFF): from here on a colour
 * in idx may carry it.
 */
function finish(): void {
  const art = job.art!, b = buffers();
  const { idx, cls, out32 } = b;
  const { bx, by } = job;
  const dress = art.dress, shade = SHADE_I;
  if (job.track) {
    // The barrier's shadow falls three pixels right and four down; the rail's up-left edge is lit.
    const railLit = dress.railLit;
    for (let y = 4; y < S; y++) {
      for (let x = 3; x < S; x++) {
        const p = y * S + x;
        const k = cls[p];
        if (k === C_RAIL) {
          idx[p] = (cls[p - 1] !== C_RAIL || cls[p - S] !== C_RAIL ? railLit : idx[p]) | OFF;
        } else if (k !== C_BARRIER) {
          const q = cls[p - 3 - 4 * S];
          if (q === C_BARRIER || q === C_RAIL) idx[p] = shade[idx[p]];
        } else idx[p] |= OFF;
      }
    }
    const posts = art.posts;
    const postLit = dress.postLit, postMid = dress.postMid, postDark = dress.postDark;
    for (let k = 0; k < posts.length; k += 2) {
      const x = posts[k] - bx, y = posts[k + 1] - by;
      if (x < 1 || y < 1 || x > S - 6 || y > S - 6) continue;
      // The post's shadow (two pixels down-right), then the post: a lit top-left, a dark bottom-right.
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          if (i + j === 0) continue; // under the post itself
          const p = (y + 2 + j) * S + x + 2 + i;
          const v = idx[p];
          idx[p] = shade[v & 63] | (v & OFF);
        }
      }
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) idx[(y + j) * S + x + i] = (i === 0 || j === 0 ? postLit : i === 2 || j === 2 ? postDark : postMid) | OFF;
    }
    // The void of a gap: only a tile with a gap's piece near it has any.
    if (job.voids) {
      for (let y = PAD; y < PAD + TILE; y++) {
        for (let p = y * S + PAD, end = p + TILE; p < end; p++) if (cls[p] === C_VOID) idx[p] |= OFF;
      }
    }
    // A pit's floor: its disc, as pit() cuts it.
    const holes = art.holes;
    for (let q = 0; q < holes.length; q++) {
      const h = holes[q];
      const cx = h.x - bx, cy = h.y - by, r = h.r;
      const ya = Math.max(PAD, Math.ceil(cy - r - 0.5)), yb = Math.min(PAD + TILE - 1, Math.ceil(cy + r - 0.5) - 1);
      for (let y = ya; y <= yb; y++) {
        const dy = y + 0.5 - cy;
        const half = Math.sqrt(Math.max(0, r * r - dy * dy));
        const xa = Math.max(PAD, Math.ceil(cx - half - 0.5)), xb = Math.min(PAD + TILE - 1, Math.ceil(cx + half - 0.5) - 1);
        for (let x = xa; x <= xb; x++) idx[y * S + x] |= OFF;
      }
    }
    // The road's furniture: water, a belt, an island's yard and what stands on the road.
    if (job.nf || job.nt) {
      for (let y = PAD; y < PAD + TILE; y++) {
        for (let p = y * S + PAD, end = p + TILE; p < end; p++) if (cls[p] >= C_WATER) idx[p] |= OFF;
      }
    }
  }
  // A theme's props outside the walls are in colours of its own, which only a pixel that takes
  // no marks can hold: wherever the tile lies (one far from the road has no other such pixel).
  if (job.px1 > job.px0) {
    const xa = job.px0 > PAD ? job.px0 : PAD, xb = job.px1 < PAD + TILE ? job.px1 : PAD + TILE;
    const ya = job.py0 > PAD ? job.py0 : PAD, yb = job.py1 < PAD + TILE ? job.py1 : PAD + TILE;
    for (let y = ya; y < yb; y++) {
      for (let p = y * S + xa, end = y * S + xb; p < end; p++) if (cls[p] === C_PROP) idx[p] |= OFF;
    }
  }
  // The pixels, in the theme's colours; and the tile keeps its colours (with the bit) for the marks to come.
  const base = baking ? baking.base : spareBase(), rows = b.rows, palOff = art.scenery.palOff;
  for (let y = 0; y < TILE; y++) {
    let p = (y + PAD) * S + PAD, o = y * TILE;
    for (let x = 0; x < TILE; x++) out32[o++] = palOff[idx[p++]];
    base.set(rows[y], y * TILE);
  }
  next(7); // done (step 6, the furniture, comes before this one)
  COST[0] = job.track ? 110 : 60;
}

// ---- the road's furniture (M4-WORLD) ----------------------------------------------------
//
// What lies and stands on a road besides its ramps, gaps and pits (PLAN-M4.md 2.2-2.4, 2.6 B),
// as shared/track.ts places it. Flat things are painted pixel by pixel from where the pixel is
// on the track (its distance along, its offset across: classify() knows both); what stands is
// drawn as the junk is, a shape in the sun with its cast shadow. What can be driven on is flat
// and casts nothing; what is solid has the lit and the dark edge, a shadow, and either the
// barrier's steel or tyres in the kerb's two paints.
// - Water: a puddle (see puddleEdge: round, its edge in a few lobes, inside the pool's
//   rectangle). A murky blue-grey that nothing else in the world has (palette.ts `water`), flat,
//   with no speckle; a dark edge, the ground wet round it, short ripples of light and of dark.
//   A kerb and the road's paint show through, so the road can still be read under it.
// - Dirt: a puddle of the yard's earth on the road, a little of it thrown past its edge, wheel
//   ruts along it.
// - A conveyor belt: slats of rusted steel between two rollers (it runs across the road), a
//   steel skirt along its two sides. The arrows that run on it are drawn a frame at a time.
// - A row of rolling barrels leaves its lane: worn ground from wall to wall, the kerbs striped
//   in hazard colours there, a hatch in the barrier they come out of and a grated gutter in the
//   one they drop into. The barrels themselves are drawn a frame at a time.
// - A crusher press: its bed, a steel tread plate with a hazard strip where a car drives on
//   and off it. The slab and its shadow are drawn a frame at a time.
// - An island: the barrier round a strip of the yard, and at either end a nose of tyre stacks;
//   on the road before each nose a painted wedge that sends the traffic either side.
// - A tyre mound: tyres heaped in rings, the outer ring painted.
// - The ramp truck: a ramp plate and a deck striped and lit as every ramp is, with the same
//   hazard lip where a car takes off; side boards, and beyond the lip the cab it flies over.

// The point puddleEdge() is asked about, and its answer: [0] = s, [1] = l (track coordinates,
// world units), [2] = how far inside the puddle's outline the point is (0 or less: outside it).
// Through an array: fractions handed over in a call are boxed (see "The bake allocates nothing").
const EDGE = new Float64Array(3);

/**
 * The outline of a puddle (a pool, a dirt patch) at the point in EDGE: the feature's rectangle
 * with its four corners rounded, each by its own radius, less a way in that is the edge's own
 * on every side: along a flank it changes with the distance along the road, along an end with
 * the offset across it, each side by a seed of its own, so no two sides run alike and a long
 * puddle is now wide, now narrow. The way in is a slow swell (smooth noise as long as half the
 * side, at most half of the room on a long side) and on it a row of lobes and bays: a wave that
 * goes out and in and is never level, its length the side's own and stretched and squeezed
 * along the side by smooth noise, so that no two bays are as far apart or as deep as the next
 * two; a fine wobble rides on all of it. Between PUDDLE_NEAR and PUDDLE_FAR in all. Round a corner the two
 * sides' ways run into each other, and the edge is held to what the traction rectangle's
 * corner leaves it. It is the same wherever it is worked out: whole-number hashes, + - * / and
 * a square root, nothing an engine may round its own way. And the traction rectangle (the
 * declared one less PUDDLE_TRACTION_INSET) with PUDDLE_KEEP round it is inside the outline,
 * come what may.
 */
function puddleEdge(f: Flat): void {
  const s = EDGE[0], l = EDGE[1];
  const a = s - f.s0, b = f.s1 - s, c = l - f.l0, d = f.l1 - l;
  const ds = a < b ? a : b, dl = c < d ? c : d;
  const r = f.round[(a < b ? 0 : 1) | (c < d ? 0 : 2)]; // the nearest corner's radius
  const corner = ds < r && dl < r;
  // The way in the nearer flank asks for here (it changes with s) and the nearer end (with l).
  let flank = 0, end = 0;
  for (let k = 0; k < 2; k++) {
    if (!corner && (k ? ds >= dl : dl > ds)) continue; // not that side's stretch of the edge
    const x = k ? l : s;
    const seed = f.seed ^ Math.imul(k ? (a < b ? 3 : 4) : c < d ? 1 : 2, 0x9e3779b1);
    // Three smooth noises along the side: slow (the swell), middling (the wave's stretch and depth), fine (the wobble).
    let slow = 0, warp = 0, fine = 0;
    for (let w = 0; w < 3; w++) {
      const t = x / (w === 0 ? (k ? f.lobeL : f.lobeS) : w === 1 ? 53 : 10);
      const i = Math.floor(t), g = t - i;
      const sd = seed ^ Math.imul(w + 1, 0x632be5ab);
      let h = Math.imul(i, 374761393) ^ sd;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      const p0 = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      h = Math.imul(i + 1, 374761393) ^ sd;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      const p1 = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
      const n = p0 + (p1 - p0) * g * g * (3 - 2 * g);
      if (w === 0) slow = n;
      else if (w === 1) warp = n;
      else fine = n;
    }
    // The wave: this side's own length (42 to 66 units) and start, stretched and squeezed by the middling noise.
    let h = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d);
    h ^= h >>> 12;
    const phase = x / (42 + ((h & 255) * 24) / 255) + ((h >>> 8) & 255) / 255 + 1.1 * warp;
    const p = phase - Math.floor(phase);
    const bump = 16 * p * p * (1 - p) * (1 - p); // 0 on a lobe's crest, 1 in the depth of a bay, never level between
    // Of the room there is, a long side gives up to half to its slow swell (the puddle is now
    // wide, now narrow along it) and the rest to its lobes and bays; a short side nearly all to those.
    const room = PUDDLE_FAR - PUDDLE_NEAR - PUDDLE_WOBBLE;
    let share = ((k ? f.l1 - f.l0 : f.s1 - f.s0) - 120) / 400;
    share = share < 0.15 ? 0.15 : share > 0.5 ? 0.5 : share;
    let swellIn = (slow - 0.2) / 0.6;
    swellIn = swellIn < 0 ? 0 : swellIn > 1 ? 1 : swellIn;
    const way = PUDDLE_NEAR + f.swell * (room * share * swellIn * swellIn * (3 - 2 * swellIn) + room * (1 - share) * (0.6 + 0.4 * warp) * bump + PUDDLE_WOBBLE * fine);
    if (k) end = way;
    else flank = way;
  }
  let edge: number;
  if (corner) {
    // Round the corner: from the one side's way to the other's, and no further in than the
    // traction rectangle's corner allows (least on the corner's diagonal, where that is nearest).
    const u = r - ds, v = r - dl;
    let way = u + v > 0 ? (u * end + v * flank) / (u + v) : flank;
    const most = PUDDLE_TRACTION_INSET * Math.SQRT2 - (Math.SQRT2 - 1) * r - PUDDLE_KEEP - 0.2;
    if (most < PUDDLE_FAR) {
      const cap = PUDDLE_FAR + (most - PUDDLE_FAR) * (1 - (u > v ? u - v : v - u) / (u + v || 1));
      if (way > cap) way = cap;
    }
    edge = r - Math.sqrt(u * u + v * v) - way;
  } else edge = dl <= ds ? dl - flank : ds - end;
  // The traction rectangle and PUDDLE_KEEP round it, whatever the outline did: where a bay would cut into it, it wins.
  if (f.s1 - f.s0 >= 2 * PUDDLE_TRACTION_INSET && f.l1 - f.l0 >= 2 * PUDDLE_TRACTION_INSET) {
    const ts = ds - PUDDLE_TRACTION_INSET, tl = dl - PUDDLE_TRACTION_INSET;
    const keep = ts < 0 && tl < 0 ? PUDDLE_KEEP - Math.sqrt(ts * ts + tl * tl) : PUDDLE_KEEP + (ts < tl ? ts : tl);
    if (keep > edge) edge = keep;
  }
  EDGE[2] = edge;
}

/** The furniture step: what is near the tile, then the flats a slice of rows at a time, then the things a few at a time. */
function furniture(): void {
  const art = job.art!;
  if (job.sub === 0) {
    const { bx, by } = job;
    const flats = art.flats, list = art.things;
    let nf = 0, nt = 0;
    for (let q = 0; q < flats.length && nf < fcand.length; q++) {
      const f = flats[q];
      if (f.x1 > bx && f.x0 < bx + S && f.y1 > by && f.y0 < by + S) fcand[nf++] = q;
    }
    for (let q = 0; q < list.length && nt < tcand.length; q++) {
      const t = list[q];
      if (t.x1 > bx && t.x0 < bx + S && t.y1 > by && t.y0 < by + S) tcand[nt++] = q;
    }
    job.nf = nf;
    job.nt = nt;
    job.row = 0;
    job.sub = nf ? 1 : 2;
    if (!nf && !nt) {
      next(5);
      COST[0] = 3;
      return;
    }
  }
  if (job.sub === 1) flats();
  else things();
}

/** The flats near the tile, a slice of rows per call. */
function flats(): void {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o1, o2, o3, nf } = job;
  const { idx, cls, dist, seg, tt, lat: latOf } = b;
  const ps0 = art.s0, pds = art.ds, list = art.flats;
  const wall = art.track.wall, hw = art.track.def.halfWidth;
  // The theme's dressing of the surfaces and of an island.
  const dress = art.dress, shade = SHADE_I;
  const PATCH = dress.patch, PATCH_LIGHT = dress.patchLight, PATCH_DARK = dress.patchDark, PATCH_PEBBLE = dress.patchPebble;
  const MUD = dress.mud, rim = MUD ? -4.4 : -2.2; // how far outside its edge a pool changes the ground
  const WALL = dress.wall, RAIL = dress.rail, BLOCK = dress.block, JOINT = dress.joint, UNDERLAY = dress.underlay;
  let work = 0, y = job.row;
  for (; y < S && work < 7000; y++) {
    const Y = by + y;
    for (let q = 0; q < nf; q++) {
      const f = list[fcand[q]];
      if (Y < f.y0 || Y >= f.y1) continue;
      const kind = f.kind;
      const xa = f.x0 - bx > 0 ? f.x0 - bx : 0, xb = f.x1 - bx < S ? f.x1 - bx : S;
      work += 8;
      for (let x = xa; x < xb; x++) {
        const p = y * S + x;
        const d = dist[p];
        if (d > wall + BARRIER) continue; // off the track
        work++;
        const i = seg[p];
        const s = ps0[i] + pds[i] * tt[p], l = latOf[p];
        const X = bx + x;
        const k = cls[p];
        const n = N[((((Y + (o1 >> 8)) & 255) << 8) | ((X + o1) & 255))];
        // How far inside the rectangle, along and across.
        const es = s - f.s0 < f.s1 - s ? s - f.s0 : f.s1 - s, el = l - f.l0 < f.l1 - l ? l - f.l0 : f.l1 - l;
        if (kind === F_DIRT) {
          if (d > hw + KERB || (k !== C_TARMAC && k !== C_KERB) || es <= 0 || el <= 0) continue;
          EDGE[0] = s;
          EDGE[1] = l;
          puddleEdge(f);
          const e = EDGE[2];
          if (e <= -1.5) continue;
          if (e <= 0) {
            // A little loose earth thrown past the patch's edge.
            if (n < 64 && k === C_TARMAC) idx[p] = n & 1 ? PATCH : PATCH_DARK;
            continue;
          }
          let c = PATCH;
          if (N[(((((Y >> 1) + (o3 >> 8)) & 255) << 8) | (((X >> 1) + o3) & 255))] < 2) c = PATCH_PEBBLE; // a pebble
          else if (n < 24) c = PATCH_LIGHT;
          else if (n > 234) c = PATCH_DARK;
          // Wheel ruts along it, wandering a little: one pair down a narrow patch, two down a wide one.
          const width = f.l1 - f.l0;
          poolNoise(X, Y);
          let a = l - (f.l0 + f.l1) / 2 + 7 * (NOISE_OUT[1] - 0.5);
          if (width >= 64) a = (a < 0 ? -a : a) - width / 4;
          const r = Math.abs((a < 0 ? -a : a) - 6.5);
          if (r < 1.2) {
            if (N[(((((Y >> 2) + (o2 >> 8)) & 255) << 8) | (((X >> 2) + o2 + 37) & 255))] < 150) c = PATCH_DARK;
          } else if (r < 2.3 && n < 60) c = PATCH_LIGHT;
          idx[p] = c;
          cls[p] = C_DIRT;
        } else if (kind === F_WATER) {
          if (d > wall || (k !== C_TARMAC && k !== C_KERB && k !== C_VERGE) || es <= 0 || el <= 0) continue;
          EDGE[0] = s;
          EDGE[1] = l;
          puddleEdge(f);
          const depth = EDGE[2];
          if (depth <= rim) continue;
          const was = idx[p];
          if (depth <= 0) {
            if (MUD && depth <= -1.2 && k !== C_KERB) {
              // A flash flood's pool: round the wet ground a ring of dried mud, cracked into
              // plates (the cracks and its ragged outer edge show the ground).
              const cx = (X + ((Math.imul(Y >> 2, 668265263) >>> 13) & 3)) % 5, cy = (Y + ((Math.imul(X >> 2, 374761393) >>> 13) & 3)) % 5;
              if (cx !== 0 && cy !== 0 && (depth > -3.2 || n < 150)) idx[p] = MUD;
              continue;
            }
            idx[p] = shade[was]; // the ground is wet round the pool
            continue;
          }
          let c = WATER;
          if (depth < 1.4) c = STEEL0; // the water's edge
          else if (k === C_KERB) c = shade[was]; // a kerb shows through ...
          else if (was === TAR3) c = STEEL2; // ... and so does the paint on the road
          // Ripples: short dashes lying across the pool, light ones (a glint at the head of some) and dark ones.
          if (depth >= 1.4) {
            let h = Math.imul(X >> 3, 374761393) ^ Math.imul(Y, 668265263);
            h = Math.imul(h ^ (h >>> 13), 1274126177);
            h ^= h >>> 16;
            const at = (X & 7) - ((h >> 8) & 3);
            if (at >= 0 && at < 3 + ((h >> 10) & 3)) {
              if ((h & 255) < 22) c = at === 0 && ((h >> 12) & 3) === 0 ? STEEL3 : STEEL2;
              else if ((h & 255) > 238 && depth > 3) c = STEEL0;
            }
          }
          idx[p] = c;
          cls[p] = C_WATER;
        } else if (kind === F_BELT) {
          if (d > wall || (k !== C_TARMAC && k !== C_KERB && k !== C_VERGE) || es < 0 || el < 0) continue;
          let c: number;
          // A roller at either end (the belt runs across the road), a skirt along either side, slats between.
          if (el < 5.6) c = el < 1.2 ? SOOT1 : el < 2.3 ? STEEL2 : el < 3.3 ? STEEL3 : el < 4.5 ? STEEL2 : SOOT2;
          else if (es < 4.6) c = es < 1.2 ? SOOT1 : es < 3.5 ? ((l - f.l0) % 9 < 1.5 ? STEEL3 : STEEL1) : SOOT2;
          else c = (s - f.s0) % 10 < 2 ? SOOT3 : n < 20 ? RUST1 : RUST0;
          idx[p] = c;
          cls[p] = C_BELT;
        } else if (kind === F_ROW) {
          const a = Math.abs(s - (f.s0 + f.s1) / 2);
          if (a > BARREL_R + ROW_JAMB) continue;
          if (d > wall) {
            // In the barrier: the hatch the barrels come out of, the grated gutter they drop into.
            if (k !== C_BARRIER && k !== C_RAIL) continue;
            const gutter = l > 0 !== f.flip;
            idx[p] = a > BARREL_R ? STEEL3 : gutter && Math.floor((s + 4000) / 2.6) & 1 ? STEEL1 : d - wall < 1.6 ? SOOT2 : SOOT0;
            cls[p] = C_BARRIER;
            continue;
          }
          if (a > BARREL_R) continue;
          // Their lane: worn ground, and the kerbs in hazard stripes where they cross.
          if (k === C_KERB) idx[p] = Math.floor((s + l + 4000) / 4) & 1 ? HAZ1 : SOOT2;
          else if (k === C_TARMAC) {
            if (idx[p] !== TAR3 && n < 104) idx[p] = TAR0;
          } else if (k === C_VERGE) {
            if (n < 96) idx[p] = GRAVEL0;
          } else if (k === C_DIRT && n < 84) idx[p] = PATCH_DARK;
        } else if (kind === F_BED) {
          if (d > wall || k === C_VOID || k === C_PLATE || es < 0 || el < 0) continue;
          // A steel plate, a hazard strip where a car drives on and off it, and on each corner
          // a post with a lamp (dark here: gfx/obstacles.ts lights it).
          if (es < 5.2 && el < 5.8) idx[p] = es < 1.1 || el < 1.1 || es > 4.1 || el > 4.7 ? SOOT2 : Math.abs(es - 2.6) < 1 && Math.abs(el - 2.9) < 1 ? RUST0 : STEEL2;
          else idx[p] = es < 3.4 ? (Math.floor((s + l + 4000) / 4.5) & 1 ? HAZ1 : SOOT2) : es < 4.7 || el < 1.5 ? SOOT2 : n < 26 ? STEEL2 : n > 226 ? STEEL0 : STEEL1;
          cls[p] = C_BED;
        } else {
          // An island.
          const mid = (f.l0 + f.l1) / 2, half = (f.l1 - f.l0) / 2;
          if (s < f.s0 || s > f.s1) {
            // The wedge painted on the road before a nose: worn stripes, on tarmac only.
            const g = s < f.s0 ? f.s0 - s : s - f.s1;
            if (g > GORE || k !== C_TARMAC) continue;
            const a = Math.abs(l - mid), w = half * (1 - g / GORE);
            if (a <= w && (a > w - 1.7 || (Math.floor((g + a) / 5) & 1) === 0) && n < 214) idx[p] = BONE1;
            continue;
          }
          if (el < 0) continue;
          const head = s - f.s0 - NOSE, tail = f.s1 - s - NOSE;
          if (head < 0 || tail < 0) {
            // Under a nose's tyre stacks.
            idx[p] = n < 56 ? UNDERLAY : SOOT3;
            cls[p] = C_SOLID;
            continue;
          }
          const ends = head < tail ? head : tail, e = el < ends ? el : ends;
          if (e <= BARRIER) {
            // The barrier round it, as the track's own (its rail nearer the road).
            if (e > RAIL_IN && e <= RAIL_OUT) {
              idx[p] = BLOCK > 0 && (s - f.s0) % BLOCK < 1.4 ? JOINT : RAIL;
              cls[p] = C_RAIL;
            } else {
              idx[p] = WALL;
              cls[p] = C_BARRIER;
            }
            continue;
          }
          // The yard inside it, gravel thrown over the barrier as outside the track's.
          const far = e - BARRIER;
          let c = n < 22 ? DIRT3 : n > 234 ? DIRT1 : DIRT2;
          if (far <= FRINGE_FAR) {
            const m = N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2) & 255))];
            if (m < (far <= FRINGE_NEAR ? 108 : 36)) c = m & 1 ? GRAVEL0 : GRAVEL1;
          }
          idx[p] = c;
          cls[p] = C_ISLE;
        }
      }
    }
  }
  if (y >= S) {
    job.sub = 2;
    job.row = 0;
    if (!job.nt) next(5);
  } else job.row = y;
  COST[0] = 6 + work * 0.03;
}

/** The things near the tile, a few per call. */
function things(): void {
  const list = job.art!.things;
  let cost = 4;
  for (let done = 0; job.row < job.nt && done < 3; done++) {
    const t = list[tcand[job.row++]];
    if (t.kind === T_TYRES) {
      if (job.art!.dress.mound === MOUND_BAGS) bags(t.tyres, t.lie);
      else tyres(t.tyres);
      cost += 4 + t.tyres.length * 1.5;
    } else if (t.kind === T_TRUCK) {
      truck(t.truck!);
      cost += 90;
    } else {
      // A piece of junk in an island's yard: it stays inside the barrier.
      clipClass = C_ISLE;
      junk(t.junk!);
      clipClass = -1;
      cost += 8;
    }
  }
  if (job.row >= job.nt) next(5);
  COST[0] = cost;
}

/** The pixels of the shape in the mask stand on the road: solid, and they take no marks. */
function stands(): void {
  const { cls, mask } = buffers();
  for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] === 1) cls[y * S + x] = C_SOLID;
}

/**
 * The pixels of the shape in the mask are a theme's prop: they take no marks (finish()), so
 * they may hold the theme's own colours. Not where junk is clipped to a class: a gap's void and
 * an island's yard take no marks as it is, and a piece there keeps lying on the one before it.
 */
function prop(): void {
  if (clipClass >= 0) return;
  const { cls, mask } = buffers();
  for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] === 1) cls[y * S + x] = C_PROP;
  propBox();
}

/** The mask's box is added to the box of the tile's props. */
function propBox(): void {
  if (mx0 < job.px0) job.px0 = mx0;
  if (my0 < job.py0) job.py0 = my0;
  if (mx1 > job.px1) job.px1 = mx1;
  if (my1 > job.py1) job.py1 = my1;
}

/**
 * A heap of sandbags (MOUND_BAGS), where the scrapyard has a heap of tyres: the same places and
 * paints (x, y, radius, paint each; view pixels), the lowest first. Each is a sack lying round
 * the heap's middle (`lie`: a cosine and a sine each), its corners cut, a seam along it, in the
 * sun with its shadow on what lies under it.
 */
function bags(a: Float64Array, lie: Float64Array): void {
  const { mask } = buffers();
  const { bx, by } = job;
  for (let k = 0; k < a.length; k += 4) {
    const x = a[k] - bx, y = a[k + 1] - by, r = a[k + 2], c = a[k + 3] | 0;
    if (x + r + 8 < 0 || y + r + 8 < 0 || x - r - 2 > S || y - r - 2 > S) continue;
    // Its long side lies as the heap was laid out (`lie`: worked out with the art, not here).
    AT[0] = x;
    AT[1] = y;
    AT[2] = lie[k >> 1];
    AT[3] = lie[(k >> 1) + 1];
    const L = r * 1.12, W = r * 0.78, cut = r * 0.36;
    polyN = 8;
    Q[0] = -L + cut, Q[1] = -W;
    corner(0);
    Q[0] = L - cut, Q[1] = -W;
    corner(1);
    Q[0] = L, Q[1] = -W + cut;
    corner(2);
    Q[0] = L, Q[1] = W - cut;
    corner(3);
    Q[0] = L - cut, Q[1] = W;
    corner(4);
    Q[0] = -L + cut, Q[1] = W;
    corner(5);
    Q[0] = -L, Q[1] = W - cut;
    corner(6);
    Q[0] = -L, Q[1] = -W + cut;
    corner(7);
    fillPoly(mask, 1);
    solid(c, 2);
    stands();
    // The seam along it.
    Q[0] = 0, Q[1] = 0, Q[2] = 2 * (L - cut), Q[3] = 1.15;
    rect();
    inlay(SHADE_I[c]);
    maskClear(mask);
  }
}

/** A heap of tyres (x, y, radius, paint each; view pixels), the lowest first: each a ring in the sun with its shadow on what lies under it. */
function tyres(a: Float64Array): void {
  const { mask } = buffers();
  const { bx, by } = job;
  for (let k = 0; k < a.length; k += 4) {
    const x = a[k] - bx, y = a[k + 1] - by, r = a[k + 2], c = a[k + 3] | 0;
    if (x + r + 6 < 0 || y + r + 6 < 0 || x - r > S || y - r > S) continue;
    Q[0] = x, Q[1] = y, Q[2] = r;
    fillDisc(mask, 1);
    solid(c, 2);
    stands();
    if (c === SOOT2) {
      // A black tyre: its inner wall, lighter, round the hole.
      Q[2] = r * 0.56;
      inlayDisc(TAR2);
      Q[2] = r * 0.26;
      inlayDisc(SOOT0);
    } else {
      Q[2] = r * 0.42;
      inlayDisc(SOOT1);
    }
    maskClear(mask);
  }
}

/** The parked ramp truck: its body with the ramp plate, the deck and the side boards, then its cab, which stands higher. */
function truck(t: TruckArt): void {
  const { idx, cls, mask } = buffers();
  const { bx, by } = job;
  const cos = t.cos, sin = t.sin, len = t.len, lip = t.lip, ramp = t.ramp;
  const CUT = 8 * ZOOM, TOE = 12 * ZOOM, HALF = TRUCK_HALF * ZOOM, LEN = len * ZOOM;
  // A sand hauler: its side bins are full of sand, its cab is terracotta (the scrapyard's: rusted boards, a yellow cab).
  const sand = job.art!.dress.truck === TRUCK_SAND, N = noiseTable();
  const CAB = sand ? RUST2 : HAZ1, CAB_DARK = sand ? RUST1 : HAZ0;
  AT[0] = t.x - bx;
  AT[1] = t.y - by;
  AT[2] = cos;
  AT[3] = sin;
  // The body: a long box with its corners cut, as the shape it is hit by is round at both ends.
  polyN = 8;
  Q[0] = 0, Q[1] = -TOE;
  corner(0);
  Q[0] = CUT, Q[1] = -HALF;
  corner(1);
  Q[0] = LEN - CUT, Q[1] = -HALF;
  corner(2);
  Q[0] = LEN, Q[1] = -TOE;
  corner(3);
  Q[0] = LEN, Q[1] = TOE;
  corner(4);
  Q[0] = LEN - CUT, Q[1] = HALF;
  corner(5);
  Q[0] = CUT, Q[1] = HALF;
  corner(6);
  Q[0] = 0, Q[1] = TOE;
  corner(7);
  fillPoly(mask, 1);
  solid(STEEL1, 3);
  stands();
  for (let y = my0; y < my1; y++) {
    for (let x = mx0; x < mx1; x++) {
      const p = y * S + x;
      if (mask[p] !== 1) continue;
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1 || mask[p - 1] === 0 || mask[p - S] === 0 || mask[p + 1] === 0 || mask[p + S] === 0) continue; // the lit and the dark edge stay
      const rx = (x + 0.5 - AT[0]) * UNIT, ry = (y + 0.5 - AT[1]) * UNIT;
      const u = rx * cos + ry * sin, v = ry * cos - rx * sin, a = v < 0 ? -v : v;
      if (u >= lip) continue; // under the cab
      let c: number;
      if (a <= TRUCK_BAND) {
        if (u < ramp) {
          // The ramp plate: striped and rising in three steps, as every ramp.
          const base = Math.floor((u - v + 400) / 6) & 1 ? STEEL2 : RUST2;
          const rise = u / ramp, seam = (bx + x + by + y) & 1;
          c = rise < 0.34 ? (rise > 0.3 && seam ? base : SHADE_I[base]) : rise > 0.67 ? (rise < 0.71 && seam ? base : LIT_I[base]) : base;
        } else c = u > lip - 3.2 ? HAZ1 : (u - ramp) % 11 < 1.3 ? STEEL2 : STEEL3; // the deck, the lip at its end
        if (a > TRUCK_BAND - 1.5 && u <= lip - 3.2) c = SOOT2; // the band's edge
      } else if (a <= TRUCK_BAND + 1.3) c = SOOT2;
      else if (u < ramp) c = STEEL1; // the ramp's cheeks
      else if (a > 17.4 && u > ramp + 6 && u < ramp + 23) c = SOOT2; // a wheel under the board
      else if (sand) {
        // The bins: a rib every 14 units, a wall along the outside, the load heaped between.
        const n = N[(((by + y) & 255) << 8) | ((bx + x) & 255)];
        c = (u - ramp) % 14 < 1.5 || a > 18.2 ? RUST0 : n < 40 ? DIRT3 : n > 226 ? DIRT1 : DIRT2;
      } else c = (u - ramp) % 14 < 1.5 ? RUST0 : RUST1; // the side boards
      idx[p] = c;
    }
  }
  maskClear(mask);
  // The arrows up the ramp and the deck: a dark outline, bone white inside, on the truck only.
  for (let j = 0; j < t.chevrons.length; j++) {
    for (let k = 0; k < 2; k++) {
      if (!polyFrom(t.chevrons[j][k], bx, by)) continue;
      fillPoly(mask, 1);
      for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] && cls[y * S + x] === C_SOLID) idx[y * S + x] = k ? BONE1 : SOOT2;
      maskClear(mask);
    }
  }
  // The cab: higher, so its shadow is longer (and lies on the deck where the sun is behind it).
  polyN = 6;
  Q[0] = (lip + 1.5) * ZOOM, Q[1] = -HALF;
  corner(0);
  Q[0] = LEN - CUT, Q[1] = -HALF;
  corner(1);
  Q[0] = LEN, Q[1] = -TOE;
  corner(2);
  Q[0] = LEN, Q[1] = TOE;
  corner(3);
  Q[0] = LEN - CUT, Q[1] = HALF;
  corner(4);
  Q[0] = (lip + 1.5) * ZOOM, Q[1] = HALF;
  corner(5);
  fillPoly(mask, 1);
  solid(CAB, 5);
  stands();
  for (let y = my0; y < my1; y++) {
    for (let x = mx0; x < mx1; x++) {
      const p = y * S + x;
      if (mask[p] !== 1) continue;
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1 || mask[p - 1] === 0 || mask[p - S] === 0 || mask[p + 1] === 0 || mask[p + S] === 0) continue;
      const rx = (x + 0.5 - AT[0]) * UNIT, ry = (y + 0.5 - AT[1]) * UNIT;
      const u = rx * cos + ry * sin, v = ry * cos - rx * sin, a = v < 0 ? -v : v;
      const w = u - lip; // from the cab's back wall
      let c = CAB;
      if (w < 4.2) c = CAB_DARK; // its back wall, in its own shade
      else if (w < 15.5) {
        // The roof, a lamp on it.
        if (a > 16.4) c = CAB_DARK;
        else if ((w - 9.6) * (w - 9.6) + v * v < 5.2) c = (w - 9.6) * (w - 9.6) + v * v < 1.6 ? HAZ2 : BLAST;
      } else if (w < 21.2) c = a > 16 ? CAB_DARK : w < 17.4 && v < -6.5 && v > -13 ? STEEL2 : STEEL0; // the windscreen, a glint in it
      else if (u < len - 2.8) c = a < 1.3 ? CAB_DARK : CAB; // the bonnet
      else c = a >= 8.5 && a <= 14.5 ? HAZ2 : STEEL2; // the bumper, a lamp either side
      idx[p] = c;
    }
  }
  maskClear(mask);
}

// ---- shapes -------------------------------------------------------------------------

/** Load a polygon given in view pixels (x, y pairs) into polyX/polyY, in buffer pixels; false when it misses the buffer. */
function polyFrom(pts: Float64Array, bx: number, by: number): boolean {
  let lox = BIG, loy = BIG, hix = -BIG, hiy = -BIG;
  polyN = pts.length >> 1;
  for (let i = 0; i < polyN; i++) {
    const x = pts[i * 2] - bx, y = pts[i * 2 + 1] - by;
    polyX[i] = x;
    polyY[i] = y;
    if (x < lox) lox = x;
    if (x > hix) hix = x;
    if (y < loy) loy = y;
    if (y > hiy) hiy = y;
  }
  return hix >= 0 && hiy >= 0 && lox < S && loy < S;
}

let polyN = 0;

// The numbers of the shape being drawn go to the functions below through these two, not as
// arguments (they are not whole). AT: the frame of a piece of junk, its middle in buffer
// pixels and the cosine and sine of its turn. Q: the shape, as each function says.
const AT = new Float64Array(4);
const Q = new Float64Array(4);


/** A rectangle Q[2] x Q[3] centred (Q[0], Q[1]) in the frame AT, as the polygon. */
function rect(): void {
  const cx = AT[0], cy = AT[1], cos = AT[2], sin = AT[3];
  const ox = Q[0], oy = Q[1], w = Q[2], h = Q[3];
  polyN = 4;
  for (let k = 0; k < 4; k++) {
    const u = ox + (k === 0 || k === 3 ? -w / 2 : w / 2), v = oy + (k < 2 ? -h / 2 : h / 2);
    polyX[k] = cx + u * cos - v * sin;
    polyY[k] = cy + u * sin + v * cos;
  }
}

/** Fill the polygon into mask m (pixel centres, even-odd), growing the used box. */
function fillPoly(m: Uint8Array, v: number): void {
  let lo = BIG, hi = -BIG;
  for (let i = 0; i < polyN; i++) {
    if (polyY[i] < lo) lo = polyY[i];
    if (polyY[i] > hi) hi = polyY[i];
  }
  const ya = Math.max(0, Math.ceil(lo - 0.5)), yb = Math.min(S - 1, Math.ceil(hi - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    let k = 0;
    for (let i = 0; i < polyN; i++) {
      const j = i + 1 === polyN ? 0 : i + 1;
      const y0 = polyY[i], y1 = polyY[j];
      if (y0 <= yc === y1 <= yc) continue;
      const xc = polyX[i] + ((yc - y0) * (polyX[j] - polyX[i])) / (y1 - y0);
      // Insertion sort: a handful of crossings at most.
      let q = k++;
      while (q > 0 && crossX[q - 1] > xc) {
        crossX[q] = crossX[q - 1];
        q--;
      }
      crossX[q] = xc;
    }
    for (let q = 0; q + 1 < k; q += 2) {
      const xa = Math.max(0, Math.ceil(crossX[q] - 0.5)), xb = Math.min(S - 1, Math.ceil(crossX[q + 1] - 0.5) - 1);
      if (xa > xb) continue;
      m.fill(v, y * S + xa, y * S + xb + 1);
      if (xa < mx0) mx0 = xa;
      if (xb + 1 > mx1) mx1 = xb + 1;
      if (y < my0) my0 = y;
      if (y + 1 > my1) my1 = y + 1;
    }
  }
}

/** Fill the disc round (Q[0], Q[1]) of radius Q[2], buffer pixels, into mask m (pixel centres). */
function fillDisc(m: Uint8Array, v: number): void {
  const cx = Q[0], cy = Q[1], r = Q[2];
  const ya = Math.max(0, Math.ceil(cy - r - 0.5)), yb = Math.min(S - 1, Math.ceil(cy + r - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const xa = Math.max(0, Math.ceil(cx - half - 0.5)), xb = Math.min(S - 1, Math.ceil(cx + half - 0.5) - 1);
    if (xa > xb) continue;
    m.fill(v, y * S + xa, y * S + xb + 1);
    if (xa < mx0) mx0 = xa;
    if (xb + 1 > mx1) mx1 = xb + 1;
    if (y < my0) my0 = y;
    if (y + 1 > my1) my1 = y + 1;
  }
}

function maskClear(m: Uint8Array): void {
  for (let y = my0; y < my1; y++) m.fill(0, y * S + mx0, y * S + mx1);
  mx0 = my0 = S;
  mx1 = my1 = 0;
}

/** Junk is painted on pixels of this class only (C_VOID: the scrap in a gap stays off the road's ends); -1 = anywhere. */
let clipClass = -1;

/**
 * The shape in the mask (value 1) as a solid thing in the sun: its cast shadow on whatever
 * lies down-right of it, its colour, a lit edge up-left and a dark edge down-right. With a
 * clipClass, the parts of the shape on other pixels are marked 2: they still count as the
 * shape (no edge where it is cut off), but neither they nor a shadow on them is painted.
 */
function solid(c: number, drop: number): void {
  const { idx, cls, mask } = buffers();
  if (mx0 >= mx1) return;
  const clip = clipClass;
  if (clip >= 0) {
    for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] === 1 && cls[y * S + x] !== clip) mask[y * S + x] = 2;
  }
  if (drop) {
    const dy = drop + 1;
    const xb = Math.min(S, mx1 + drop), yb = Math.min(S, my1 + dy);
    for (let y = my0 + dy; y < yb; y++) {
      for (let x = mx0 + drop; x < xb; x++) {
        const p = y * S + x;
        if (mask[p - drop - dy * S] !== 0 && mask[p] === 0 && (clip < 0 || cls[p] === clip)) idx[p] = SHADE_I[idx[p]];
      }
    }
  }
  const lit = LIT_I[c], dark = SHADE_I[c];
  for (let y = my0; y < my1; y++) {
    for (let x = mx0; x < mx1; x++) {
      const p = y * S + x;
      if (mask[p] !== 1) continue;
      if (x === 0 || y === 0 || mask[p - 1] === 0 || mask[p - S] === 0) idx[p] = lit;
      else if (x === S - 1 || y === S - 1 || mask[p + 1] === 0 || mask[p + S] === 0) idx[p] = dark;
      else idx[p] = c;
    }
  }
}

/** Paint the polygon in colour c, but only inside the shape that is in the mask (it is marked 2 there on the way and put back). */
function inlay(c: number): void {
  const { idx, mask } = buffers();
  const x0 = mx0, y0 = my0, x1 = mx1, y1 = my1;
  // Rows of the polygon, clipped to the shape: mark with 2 where the mask is 1.
  let lo = BIG, hi = -BIG;
  for (let i = 0; i < polyN; i++) {
    if (polyY[i] < lo) lo = polyY[i];
    if (polyY[i] > hi) hi = polyY[i];
  }
  const ya = Math.max(y0, Math.ceil(lo - 0.5)), yb = Math.min(y1 - 1, Math.ceil(hi - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const yc = y + 0.5;
    let k = 0;
    for (let i = 0; i < polyN; i++) {
      const j = i + 1 === polyN ? 0 : i + 1;
      const ya0 = polyY[i], ya1 = polyY[j];
      if (ya0 <= yc === ya1 <= yc) continue;
      const xc = polyX[i] + ((yc - ya0) * (polyX[j] - polyX[i])) / (ya1 - ya0);
      let q = k++;
      while (q > 0 && crossX[q - 1] > xc) {
        crossX[q] = crossX[q - 1];
        q--;
      }
      crossX[q] = xc;
    }
    for (let q = 0; q + 1 < k; q += 2) {
      const xa = Math.max(x0, Math.ceil(crossX[q] - 0.5)), xb = Math.min(x1 - 1, Math.ceil(crossX[q + 1] - 0.5) - 1);
      for (let x = xa; x <= xb; x++) if (mask[y * S + x] === 1) idx[y * S + x] = c;
    }
  }
}

/** Paint the disc round (Q[0], Q[1]) of radius Q[2] in colour c inside the shape that is in the mask. */
function inlayDisc(c: number): void {
  const { idx, mask } = buffers();
  const cx = Q[0], cy = Q[1], r = Q[2];
  const ya = Math.max(my0, Math.ceil(cy - r - 0.5)), yb = Math.min(my1 - 1, Math.ceil(cy + r - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const xa = Math.max(mx0, Math.ceil(cx - half - 0.5)), xb = Math.min(mx1 - 1, Math.ceil(cx + half - 0.5) - 1);
    for (let x = xa; x <= xb; x++) if (mask[y * S + x] === 1) idx[y * S + x] = c;
  }
}

const SLATS = [-0.3, 0, 0.3]; // a pallet's gaps and an engine's bores, as shares of the width
// A rock's seven corners: the directions, and two outlines (each corner's share of the radius).
const ROCK_COS = Float64Array.from({ length: 7 }, (_, k) => Math.cos((k * 2 * Math.PI) / 7));
const ROCK_SIN = Float64Array.from({ length: 7 }, (_, k) => Math.sin((k * 2 * Math.PI) / 7));
const ROCK_A = [1, 0.74, 0.96, 0.7, 0.92, 0.8, 0.62];
const ROCK_B = [0.86, 1, 0.66, 0.9, 0.72, 1, 0.78];
const STRAPS = [-0.17, 0.2]; // the straps round a crushed cube

/** Corner k of the polygon: (Q[0], Q[1]) in the frame AT. */
function corner(k: number): void {
  const px = Q[0], py = Q[1];
  polyX[k] = AT[0] + px * AT[2] - py * AT[3];
  polyY[k] = AT[1] + px * AT[3] + py * AT[2];
}

/** One piece of junk: two tones, a lit edge, a hard shadow. */
function junk(d: Junk): void {
  const { idx, mask } = buffers();
  const x = d.x - job.bx, y = d.y - job.by, r = d.r;
  const cos = Math.cos(d.a), sin = Math.sin(d.a);
  const u = ZOOM; // one world unit, in pixels
  AT[0] = x;
  AT[1] = y;
  AT[2] = cos;
  AT[3] = sin;
  switch (d.kind) {
    case K_CUBE:
    case K_PALLET: {
      // A crushed cube with two straps; a pallet is wood with three gaps between its slats.
      const pallet = d.kind === K_PALLET;
      const w = pallet ? r * 1.6 : r * 2, h = pallet ? r * 1.6 : r * 1.4;
      const c = pallet ? GRAVEL1 : d.c;
      Q[0] = 0, Q[1] = 0, Q[2] = w, Q[3] = h;
      rect();
      fillPoly(mask, 1);
      solid(c, 3);
      const bands = pallet ? SLATS : STRAPS;
      for (let k = 0; k < bands.length; k++) {
        Q[0] = 0, Q[1] = bands[k] * h, Q[2] = w - 3 * u, Q[3] = 2.5 * u;
        rect();
        inlay(SHADE_I[c]);
      }
      break;
    }
    case K_DRUM: {
      // A drum on its end: the rim is the bevel, inside it a darker ring.
      const rr = r * 0.66;
      Q[0] = x, Q[1] = y, Q[2] = rr;
      fillDisc(mask, 1);
      solid(d.c, 3);
      const ring = r * 0.36, dark = SHADE_I[d.c];
      for (let j = my0; j < my1; j++) {
        for (let i = mx0; i < mx1; i++) {
          if (mask[j * S + i] !== 1) continue;
          // The distance from the middle: Math.hypot, spelled out (HYPOT).
          const ha = Math.abs(i + 0.5 - x), hb = Math.abs(j + 0.5 - y), hm = ha > hb ? ha : hb;
          const q = hm === 0 ? 0 : Math.sqrt((ha / hm) * (ha / hm) + (hb / hm) * (hb / hm)) * hm;
          if (Math.abs(q - ring) <= 1 * u) idx[j * S + i] = dark;
        }
      }
      break;
    }
    case K_COIL: {
      // A coil of cable: rings of the colour and its shade round a dark eye.
      const rr = r * 0.72;
      Q[0] = x, Q[1] = y, Q[2] = rr;
      fillDisc(mask, 1);
      solid(d.c, 3);
      const dark = SHADE_I[d.c];
      for (let j = my0 + 1; j < my1 - 1; j++) {
        for (let i = mx0 + 1; i < mx1 - 1; i++) {
          const p = j * S + i;
          if (mask[p] !== 1 || mask[p - 1] === 0 || mask[p - S] === 0 || mask[p + 1] === 0 || mask[p + S] === 0) continue; // the bevel stays
          // The distance from the middle: Math.hypot, spelled out (HYPOT).
          const ha = Math.abs(i + 0.5 - x), hb = Math.abs(j + 0.5 - y), hm = ha > hb ? ha : hb;
          const q = hm === 0 ? 0 : Math.sqrt((ha / hm) * (ha / hm) + (hb / hm) * (hb / hm)) * hm;
          idx[p] = q < rr * 0.24 ? SOOT2 : Math.floor(q / 1.6) & 1 ? dark : d.c;
        }
      }
      break;
    }
    case K_TYRES: {
      for (let k = 0; k < 3; k++) {
        const tx = x + Math.cos(d.a + k * 2.1) * r * 0.5, ty = y + Math.sin(d.a + k * 2.1) * r * 0.5;
        Q[0] = tx, Q[1] = ty, Q[2] = 7 * u;
        fillDisc(mask, 1);
        solid(SOOT2, 3);
        Q[0] = tx, Q[1] = ty, Q[2] = 3.4 * u;
        inlayDisc(TAR2);
        maskClear(mask);
      }
      return;
    }
    case K_PLATE: {
      // A bent plate with its crease catching the sun.
      const w = r * 1.3, h = r * 0.8;
      polyN = 4;
      Q[0] = -w, Q[1] = -h * 0.6;
      corner(0);
      Q[0] = w * 0.8, Q[1] = -h;
      corner(1);
      Q[0] = w, Q[1] = h * 0.5;
      corner(2);
      Q[0] = -w * 0.7, Q[1] = h;
      corner(3);
      fillPoly(mask, 1);
      solid(d.c, 3);
      // The crease: a thin strip, turned a little against the plate.
      const a = d.a - 0.08;
      AT[2] = Math.cos(a);
      AT[3] = Math.sin(a);
      Q[0] = 0, Q[1] = -h * 0.1, Q[2] = w * 1.6, Q[3] = 1.8 * u;
      rect();
      inlay(LIT_I[d.c]);
      break;
    }
    case K_ROCK: {
      // An outcrop: a block of stone, seven-cornered, a sunlit facet on it and a crack down its dark side.
      const shape = Math.floor(d.a * 977) & 1 ? ROCK_A : ROCK_B;
      polyN = 7;
      for (let k = 0; k < 7; k++) {
        Q[0] = ROCK_COS[k] * r * shape[k], Q[1] = ROCK_SIN[k] * r * shape[k] * 0.82;
        corner(k);
      }
      fillPoly(mask, 1);
      solid(d.c, 4);
      prop();
      // The facet: the block again at half its size, moved toward the sun.
      for (let k = 0; k < 7; k++) {
        polyX[k] = x - r * 0.2 + (polyX[k] - x) * 0.5;
        polyY[k] = y - r * 0.22 + (polyY[k] - y) * 0.5;
      }
      inlay(LIT_I[d.c]);
      Q[0] = r * 0.3, Q[1] = r * 0.26, Q[2] = r * 0.8, Q[3] = 1.2;
      rect();
      inlay(SHADE_I[d.c]);
      break;
    }
    case K_CACTUS: {
      // Round succulents, three in a clump: each a rosette, eight light ribs out from a dark crown.
      const greens = job.art!.dress.greens;
      for (let k = 0; k < 3; k++) {
        const rr = r * (k === 0 ? 0.44 : k === 1 ? 0.31 : 0.25), out = k ? r * 0.58 : 0;
        const tx = x + Math.cos(d.a + k * 2.3) * out, ty = y + Math.sin(d.a + k * 2.3) * out;
        Q[0] = tx, Q[1] = ty, Q[2] = rr;
        fillDisc(mask, 1);
        solid(greens[1], 2);
        prop();
        for (let j = my0 + 1; j < my1 - 1; j++) {
          for (let i = mx0 + 1; i < mx1 - 1; i++) {
            const p = j * S + i;
            if (mask[p] !== 1 || mask[p - 1] === 0 || mask[p - S] === 0 || mask[p + 1] === 0 || mask[p + S] === 0) continue; // the bevel stays
            const dx = i + 0.5 - tx, dy = j + 0.5 - ty, ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
            if (ax < 1.1 && ay < 1.1) idx[p] = greens[0];
            else if (ax < 0.6 || ay < 0.6 || (ax > ay ? ax - ay : ay - ax) < 0.75) idx[p] = greens[2];
          }
        }
        maskClear(mask);
      }
      return;
    }
    case K_SCRUB: {
      // Dry scrub: a ragged tuft of twigs, thinning toward its edge; the ground shows between them.
      const { cls } = buffers();
      const twigs = job.art!.dress.twigs, N = noiseTable(), clip = clipClass;
      const rr = r * 0.66;
      Q[0] = x, Q[1] = y, Q[2] = rr;
      fillDisc(mask, 1);
      for (let j = my0; j < my1; j++) {
        for (let i = mx0; i < mx1; i++) {
          const p = j * S + i;
          if (mask[p] !== 1 || (clip >= 0 && cls[p] !== clip)) continue;
          const dx = i + 0.5 - x, dy = j + 0.5 - y;
          const n = N[(((job.by + j) & 255) << 8) | ((job.bx + i + 71) & 255)];
          if (n >= 190 - (150 * (dx * dx + dy * dy)) / (rr * rr)) continue;
          idx[p] = twigs[n & 1];
          if (clip < 0) cls[p] = C_PROP;
        }
      }
      if (clip < 0) propBox();
      break;
    }
    case K_SHELL: {
      // A car's shell: its body, a roof, two dark screens. Outside the walls the sand has drifted over one end of it.
      const w = r * 2.1 < 26 ? r * 2.1 : 26, h = w * 0.5;
      Q[0] = 0, Q[1] = 0, Q[2] = w, Q[3] = h;
      rect();
      fillPoly(mask, 1);
      solid(d.c, 2);
      prop();
      Q[0] = -w * 0.06, Q[1] = 0, Q[2] = w * 0.44, Q[3] = h * 0.74;
      rect();
      inlay(SHADE_I[d.c]);
      Q[0] = w * 0.21, Q[1] = 0, Q[2] = 2.2, Q[3] = h * 0.62;
      rect();
      inlay(SOOT2);
      Q[0] = -w * 0.31, Q[1] = 0, Q[2] = 1.8, Q[3] = h * 0.56;
      rect();
      inlay(SOOT2);
      if (clipClass < 0) {
        const { cls } = buffers();
        const N = noiseTable();
        for (let j = my0; j < my1; j++) {
          for (let i = mx0; i < mx1; i++) {
            const p = j * S + i;
            if (mask[p] !== 1) continue;
            const n = N[(((job.by + j) & 255) << 8) | ((job.bx + i + 113) & 255)];
            // Along the car from its middle, in pixels: past a ragged line the drift has it.
            if ((i + 0.5 - x) * cos + (j + 0.5 - y) * sin < w * 0.1 + (n & 3) - 1.5) continue;
            idx[p] = n < 36 ? DIRT3 : n > 236 ? DIRT1 : DIRT2;
            cls[p] = C_NONE;
          }
        }
      }
      break;
    }
    default: {
      // An engine block: steel, a lighter head, three bores.
      const w = r * 1.7, h = r * 1.1;
      Q[0] = 0, Q[1] = 0, Q[2] = w, Q[3] = h;
      rect();
      fillPoly(mask, 1);
      solid(STEEL1, 3);
      Q[0] = 0, Q[1] = -h / 2 + 1.5 * u + h * 0.18, Q[2] = w - 3 * u, Q[3] = h * 0.36;
      rect();
      inlay(STEEL2);
      for (let j = 0; j < SLATS.length; j++) {
        const k = SLATS[j];
        Q[0] = x + k * w * cos - h * 0.18 * sin, Q[1] = y + k * w * sin + h * 0.18 * cos, Q[2] = 2.2 * u;
        inlayDisc(SOOT2);
      }
    }
  }
  maskClear(mask);
}

/** Is a pixel of this class ground between the walls (a pit is cut into nothing else)? */
function walled(k: number): boolean {
  return k === C_TARMAC || k === C_KERB || k === C_VERGE;
}

/** A pit: cracks, a jagged rim that catches the light, and the dark dithering down to its floor. */
function pit(h: Art["holes"][number]): void {
  const { idx, cls, mask } = buffers();
  const { bx, by } = job;
  const pitWall = job.art!.dress.pitWall;
  // Cracks: thin dark lines running out from the rim.
  for (let c = 0; c < h.cracks.length; c++) {
    const line = h.cracks[c];
    for (let k = 0; k + 3 < line.length; k += 2) {
      const xa = line[k] - bx, ya = line[k + 1] - by, xb = line[k + 2] - bx, yb = line[k + 3] - by;
      // The piece's length: Math.hypot, spelled out (HYPOT).
      const ha = Math.abs(xb - xa), hb = Math.abs(yb - ya), hm = ha > hb ? ha : hb;
      const len = (hm === 0 ? 0 : Math.sqrt((ha / hm) * (ha / hm) + (hb / hm) * (hb / hm)) * hm) || 1;
      const px = (-(yb - ya) / len) * 0.8, py = ((xb - xa) / len) * 0.8;
      polyN = 4;
      polyX[0] = xa + px; polyY[0] = ya + py;
      polyX[1] = xb + px; polyY[1] = yb + py;
      polyX[2] = xb - px; polyY[2] = yb - py;
      polyX[3] = xa - px; polyY[3] = ya - py;
      fillPoly(mask, 1);
    }
  }
  for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] && walled(cls[y * S + x])) idx[y * S + x] = SOOT2;
  maskClear(mask);
  // The rim, its up-left edge lit.
  if (polyFrom(h.rim, bx, by)) {
    fillPoly(mask, 1);
    for (let y = my0; y < my1; y++) {
      for (let x = mx0; x < mx1; x++) {
        const p = y * S + x;
        if (!mask[p] || !walled(cls[p])) continue;
        idx[p] = x === 0 || y === 0 || !mask[p - 1] || !mask[p - S] ? TAR3 : SOOT3;
      }
    }
    maskClear(mask);
  }
  // The pit: its floor sits up-left of its mouth, so what shows down-right is the lit far wall.
  const cx = h.x - bx, cy = h.y - by, r = h.r;
  const fx = cx - r * 0.2, fy = cy - r * 0.25;
  const ya = Math.max(0, Math.ceil(cy - r - 0.5)), yb = Math.min(S - 1, Math.ceil(cy + r - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const xa = Math.max(0, Math.ceil(cx - half - 0.5)), xb = Math.min(S - 1, Math.ceil(cx + half - 0.5) - 1);
    for (let x = xa; x <= xb; x++) {
      const p = y * S + x;
      if (!walled(cls[p])) continue;
      // How far from the floor's middle, in radii: Math.hypot(...) / r, spelled out (HYPOT).
      const ha = Math.abs(x + 0.5 - fx), hb = Math.abs(y + 0.5 - fy), hm = ha > hb ? ha : hb;
      const d = (hm === 0 ? 0 : Math.sqrt((ha / hm) * (ha / hm) + (hb / hm) * (hb / hm)) * hm) / r;
      const t = (BAYER4[(by + y) & 3][(bx + x) & 3] + 0.5) / 16;
      idx[p] = d > 1 ? pitWall : d > 0.8 ? ((d - 0.8) / 0.2 > t ? SOOT3 : SOOT2) : d > 0.45 ? ((d - 0.45) / 0.35 > t ? SOOT2 : SOOT1) : d / 0.45 > t ? SOOT1 : SOOT0;
    }
  }
}

// ---- the tile pool --------------------------------------------------------------------

interface Tile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  home: Map<number, Tile> | null; // its track's tiles, or null when it holds nothing
  key: number; // its tileKey there, or -1
  scenery: Scenery; // its track's theme: the tables its bytes are turned into pixels with (begin())
  ready: boolean;
  used: number; // the last frame it was drawn or wanted in
  // Track marks (see "track marks" below). What was baked, a byte a pixel: the colour in bits
  // 0-4, how deeply it is marked in bits 5-6 (0 = not), bit 7 set on what marks keep off.
  base: Uint8Array;
  marked: boolean; // some pixel of it is marked
  epoch: number; // ... by marks of this epoch (marksEpoch): older ones are gone and it is due a wipe
  // The part whose pixels are to be put on its canvas again (x1, y1 exclusive; none while x1 <= x0).
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const pool: Tile[] = [];
let frameNo = 0;
let baking: Tile | null = null; // the tile the job bakes into

// A tile's key among its track's tiles: ty and tx in 15 bits each, so a key is under 2^30, a
// small integer to the engine, and looking it up allocates nothing. (One key for all tracks
// was a number above 2^32, boxed for every lookup: about half a kilobyte a frame in Node.)
const KEY_BITS = 15;
const KEY_HALF = 1 << (KEY_BITS - 1); // tiles -16384 .. 16383: 4.2 million view pixels either way

/** The key of tile (tx, ty), or -1 when it lies further out than a key holds: such a tile is never baked. */
function tileKey(tx: number, ty: number): number {
  const x = tx + KEY_HALF, y = ty + KEY_HALF;
  return x >= 0 && x < 2 * KEY_HALF && y >= 0 && y < 2 * KEY_HALF ? (y << KEY_BITS) | x : -1;
}

/**
 * The pool's tile for (tx, ty) of a track, or null. A track's map keeps its entries: taking
 * one out for every tile given away made the map rebuild itself every few tiles (an
 * allocation each time). An entry whose tile has since gone to another place is known by
 * that tile's key and home, which no longer match. The map grows to the number of the
 * track's tiles ever baked and no further.
 */
function tileAt(art: Art, tx: number, ty: number): Tile | null {
  const key = tileKey(tx, ty);
  const t = art.tiles.get(key);
  return t !== undefined && t.key === key && t.home === art.tiles ? t : null;
}

/** A tile to bake into: a new one while the pool is not full, else the one unused for longest (never one used this frame). */
function claim(): Tile | null {
  if (pool.length < TILE_POOL) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = TILE;
    // Opaque. In main memory when the view canvas is (one that is read back, as the benchmark's):
    // a blit then never crosses between main memory and the GPU.
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: softTiles })!;
    const t: Tile = { canvas, ctx, home: null, key: -1, scenery: YARD, ready: false, used: -1, base: new Uint8Array(TILE * TILE), marked: false, epoch: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
    pool.push(t);
    return t;
  }
  let best: Tile | null = null;
  for (let i = 0; i < pool.length; i++) {
    const t = pool[i];
    if (t === baking || t.used >= frameNo) continue;
    if (!best || t.used < best.used) best = t;
  }
  if (best) {
    best.home = null;
    best.key = -1;
    best.ready = false;
    best.marked = false;
    best.x1 = best.x0 = 0;
  }
  return best;
}

/** Counters since the page loaded, for checks and reports: tiles baked, jobs given up, squares drawn plain because their tile was not ready, and the cost units spent baking. */
export const worldStats = { baked: 0, dropped: 0, placeholders: 0, units: 0 };

/** Whether tile canvases are kept in main memory: as the view canvas of the World that finds the pool empty. */
let softTiles = true;

/** Canvas memory the pool holds right now, in bytes. */
export function tilePoolBytes(): number {
  return pool.length * TILE * TILE * 4;
}

// ---- track marks ----------------------------------------------------------------------
//
// The track remembers the race: a mine's blast leaves a scorch, a sliding car its tyre marks
// (PLAN-GFX.md, B9). A mark is not drawn each frame. It is put into the tiles it lies on,
// once, and then costs nothing:
// - A mark changes nothing but how deeply a pixel is marked (0..3, kept with the tile's
//   baked colours): 1 = soot or rubber (the colour's cast-shadow tone), 2 = singed, 3 =
//   charred (warm soot tones, never as dark as a pit's floor, and no rim: a scorch is not a
//   hole). A pixel shows the deepest mark that reached it, so marks may overlap in any order
//   and a mark put on twice changes nothing. Only palette colours come of it.
// - Putting a mark on a tile touches that tile's pixels under the mark, no others, and
//   uploads that rectangle (one upload per tile and frame, however many marks). No tile is
//   ever baked again for a mark. The void of a gap, a pit's floor and the barrier take none.
// - The last SCORCHES scorches and SKIDS skids are kept (typed arrays). A tile that was given
//   away and is baked again gets those that lie on it put back as it is finished. Older
//   marks last as long as their tile stays in the pool.
// - All marks go at a new race, a restart (clearMarks) and when another track is drawn:
//   the tiles still showing some are wiped one a frame (their pixels, not a bake).
// Nothing here allocates once the first mark has been made.

/** Scorches and skids kept for tiles that are baked again. */
export const SCORCHES = 128;
export const SKIDS = 2048;

/**
 * The mark handed to scorch() or skid(), in world units (not as arguments: fractions).
 * scorch: [0], [1] = where the mine went off. skid: [0..3] = the way one rear wheel came,
 * from (x, y) to (x, y); [4..7] = the other's.
 */
export const MARK = new Float64Array(8);

const LEVEL = 0x60; // how deeply a pixel is marked (OFF, further up: one that takes no marks)
// What a tile's byte shows is its theme's to say (gfx/theme.ts: a scenery's `marked`, by level
// * 32 + colour; and by the whole byte `shownI`, a palette index, and `shown`, a pixel). The
// burnt tones are the theme's own: sand has no dark tone to burn to. Under OFF nothing is
// marked, and bits 5 and 6 are then not a mark's level but part of the colour: `water` and a
// theme's extras. A tile is put on its canvas, marked and wiped with its own theme's tables
// (Tile.scenery): the pool holds tiles of several tracks.

// A scorch: one of SCORCH_KINDS shapes, SCORCH x SCORCH view pixels, a level per pixel.
const SCORCH = 32;
const SCORCH_KINDS = 8;
const SKID_REACH = 40; // every pixel of a skid lies this near its first point (view pixels): skid() sees to it

let SCORCH_MASK: Uint8Array | null = null;

function scorchMasks(): Uint8Array {
  if (!SCORCH_MASK) {
    const m = (SCORCH_MASK = new Uint8Array(SCORCH_KINDS * SCORCH * SCORCH));
    const LOBES = 11, R = 10.5;
    const edge = new Float64Array(LOBES + 1);
    for (let k = 0; k < SCORCH_KINDS; k++) {
      const rnd = mulberry32(4201 + 7 * k);
      // The outline of the burst: a radius every 11th of a turn, a few of them thrown further.
      for (let q = 0; q < LOBES; q++) edge[q] = R * (rnd() < 0.3 ? 0.95 + 0.25 * rnd() : 0.62 + 0.3 * rnd());
      edge[LOBES] = edge[0];
      const turn = rnd() * LOBES;
      for (let j = 0; j < SCORCH; j++) {
        for (let i = 0; i < SCORCH; i++) {
          const dx = i + 0.5 - SCORCH / 2, dy = j + 0.5 - SCORCH / 2;
          const f = (((Math.atan2(dy, dx) / (2 * Math.PI)) * LOBES + turn) % LOBES + LOBES) % LOBES;
          const q = Math.floor(f), t = f - q, st = t * t * (3 - 2 * t);
          const u = Math.sqrt(dx * dx + dy * dy) / (edge[q] + (edge[q + 1] - edge[q]) * st);
          const n = rnd();
          let level = 0;
          if (u < 0.45) level = n < 0.72 ? 3 : 2; // the charred middle
          else if (u < 0.8) level = n < 0.1 ? 3 : 2; // singed, a charred speck here and there
          else if (u < 1) level = n < 0.25 + 0.6 * ((1 - u) / 0.2) ? 2 : 1; // breaking up
          else if (u < 1.4) level = n < 0.6 * ((1.4 - u) / 0.4) ? 1 : 0; // soot thrown further out
          // Streaks of soot between the lobes, thrown out past the edge.
          if (level < 2 && u < 1.55 && t > 0.42 && t < 0.58 && (q * 5 + k) % 3 === 0 && n < 0.8) level = u < 1.2 ? 2 : 1;
          m[(k * SCORCH + j) * SCORCH + i] = level;
        }
      }
    }
  }
  return SCORCH_MASK;
}

// The rings: the last marks, oldest overwritten. A scorch: its middle in view pixels (whole)
// and its shape. A skid: eight numbers, two ways of a wheel, in view pixels.
const scorchX = new Int32Array(SCORCHES);
const scorchY = new Int32Array(SCORCHES);
const scorchKind = new Uint8Array(SCORCHES);
const skidPts = new Float32Array(SKIDS * 8);
let scorchCount = 0; // marks made since the last clearing (the ring holds the last SCORCHES of them)
let skidCount = 0;
let markArt: Art | null = null; // the track the marks are on
let marksEpoch = 1; // goes up when the marks are cleared: a tile marked in an older epoch is due a wipe
let clearings = 0; // clearMarks() calls so far (marksCleared)
let wiping = false; // some tile may still show marks of an older epoch
let unsent = false; // some tile has pixels to put on its canvas

/** Counters since the page loaded, for checks and reports: marks made, rectangles uploaded and their pixels, tiles wiped of old marks, marks put back on tiles baked again. */
export const markStats = { scorches: 0, skids: 0, uploads: 0, pixels: 0, wiped: 0, putBack: 0 };

/** For checks (tools/debug/marks-stress.ts measures a frame with and without): off = scorch() and skid() do nothing. */
export const markSwitch = { on: true };

// The rectangle of a tile the stamp just made changed (x1, y1 exclusive).
let sx0 = TILE, sy0 = TILE, sx1 = 0, sy1 = 0;

let markOut: ImageData | null = null; // a tile's worth of pixels on their way to a canvas (browser only)
let markOut32: Uint32Array | null = null;
let spare: Uint8Array | null = null;

/** Somewhere for a bake without a tile (bakeTileIndices) to leave its base bytes. */
function spareBase(): Uint8Array {
  return spare ?? (spare = new Uint8Array(TILE * TILE));
}

/** Put scorch i of the ring into a tile's base bytes; the tile's top-left is view pixel (ox, oy). */
function stampScorch(base: Uint8Array, ox: number, oy: number, i: number): void {
  const mask = scorchMasks();
  const left = scorchX[i] - SCORCH / 2 - ox, top = scorchY[i] - SCORCH / 2 - oy;
  const at = scorchKind[i] * SCORCH * SCORCH;
  const ja = top < 0 ? -top : 0, jb = top + SCORCH > TILE ? TILE - top : SCORCH;
  const ia = left < 0 ? -left : 0, ib = left + SCORCH > TILE ? TILE - left : SCORCH;
  for (let j = ja; j < jb; j++) {
    const row = (top + j) * TILE + left;
    for (let k = ia; k < ib; k++) {
      const level = mask[at + j * SCORCH + k] << 5;
      if (!level) continue;
      const v = base[row + k];
      if (v & OFF || (v & LEVEL) >= level) continue;
      base[row + k] = (v & 31) | level;
      const x = left + k, y = top + j;
      if (x < sx0) sx0 = x;
      if (x >= sx1) sx1 = x + 1;
      if (y < sy0) sy0 = y;
      if (y >= sy1) sy1 = y + 1;
    }
  }
}

/** Put skid i of the ring into a tile's base bytes: two lines two pixels wide, soot deep. */
function stampSkid(base: Uint8Array, ox: number, oy: number, i: number): void {
  for (let w = 0; w < 2; w++) {
    const at = i * 8 + w * 4;
    const xa = skidPts[at], ya = skidPts[at + 1];
    const ex = skidPts[at + 2] - xa, ey = skidPts[at + 3] - ya;
    const ax = ex < 0 ? -ex : ex, ay = ey < 0 ? -ey : ey;
    const steps = Math.ceil(ax > ay ? ax : ay) || 1;
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(xa + (ex * k) / steps) - 1 - ox, y = Math.round(ya + (ey * k) / steps) - 1 - oy;
      if (x < -1 || y < -1 || x >= TILE || y >= TILE) continue;
      for (let q = 0; q < 4; q++) {
        const px = x + (q & 1), py = y + (q >> 1);
        if (px < 0 || py < 0 || px >= TILE || py >= TILE) continue;
        const v = base[py * TILE + px];
        if (v & (OFF | LEVEL)) continue;
        base[py * TILE + px] = v | 32;
        if (px < sx0) sx0 = px;
        if (px >= sx1) sx1 = px + 1;
        if (py < sy0) sy0 = py;
        if (py >= sy1) sy1 = py + 1;
      }
    }
  }
}

/** Put every mark of the rings that lies on tile (tx, ty) into its base bytes. Returns how many did. */
function stampAll(base: Uint8Array, tx: number, ty: number): number {
  const ox = tx * TILE, oy = ty * TILE;
  let hit = 0;
  const half = SCORCH / 2;
  for (let i = scorchCount < SCORCHES ? scorchCount : SCORCHES; i-- > 0; ) {
    const x = scorchX[i], y = scorchY[i];
    if (x + half <= ox || x - half >= ox + TILE || y + half <= oy || y - half >= oy + TILE) continue;
    stampScorch(base, ox, oy, i);
    hit++;
  }
  for (let i = skidCount < SKIDS ? skidCount : SKIDS; i-- > 0; ) {
    const x = skidPts[i * 8], y = skidPts[i * 8 + 1];
    if (x + SKID_REACH < ox || x - SKID_REACH > ox + TILE || y + SKID_REACH < oy || y - SKID_REACH > oy + TILE) continue;
    stampSkid(base, ox, oy, i);
    hit++;
  }
  return hit;
}

/** The stamp's rectangle is added to what tile t has to put on its canvas. */
function owe(t: Tile): void {
  if (sx1 <= sx0) return;
  if (t.x1 <= t.x0) {
    t.x0 = sx0;
    t.y0 = sy0;
    t.x1 = sx1;
    t.y1 = sy1;
  } else {
    if (sx0 < t.x0) t.x0 = sx0;
    if (sy0 < t.y0) t.y0 = sy0;
    if (sx1 > t.x1) t.x1 = sx1;
    if (sy1 > t.y1) t.y1 = sy1;
  }
  t.marked = true;
  unsent = true;
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
}

/** A tile showing marks of an older epoch: they are wiped, today's marks put on, the whole tile owed. */
function wipe(t: Tile, tx: number, ty: number): void {
  const base = t.base;
  // What keeps marks off has none to lose (and its bit 5 is colour, not a mark's level: SHOWN_I).
  for (let o = 0; o < base.length; o++) if (!(base[o] & OFF)) base[o] &= ~LEVEL;
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
  const live = t.home === (markArt ? markArt.tiles : null) && stampAll(base, tx, ty) > 0;
  sx0 = sy0 = 0;
  sx1 = sy1 = TILE;
  owe(t);
  t.marked = live;
  t.epoch = marksEpoch;
  markStats.wiped++;
}

/** The tile (tx, ty) of the marks' track, if it is in the pool and finished, ready to take a mark of today's. */
function markable(tx: number, ty: number): Tile | null {
  const t = tileAt(markArt!, tx, ty);
  if (!t || !t.ready) return null; // not there: the mark is put on when it is baked
  if (t.marked && t.epoch !== marksEpoch) {
    wipe(t, tx, ty); // which puts today's marks on, this one with them
    return null;
  }
  t.epoch = marksEpoch;
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
  return t;
}

/** The marks are on `track` from now on: marks on another track go. False when that track has never been drawn. */
function marksOn(track: Track): boolean {
  const art = arts.get(track);
  if (!art) return false;
  if (markArt !== art) {
    dropMarks(); // not a clearing to count (marksCleared): this track's marks begin here, none of them go
    markArt = art;
  }
  return true;
}

/** A mine went off at (MARK[0], MARK[1]) of `track`: its scorch, on the tiles that are there now and on those baked later. */
export function scorch(track: Track): void {
  if (!markSwitch.on || !marksOn(track)) return;
  const x = Math.round(MARK[0] * ZOOM), y = Math.round(MARK[1] * ZOOM);
  const i = scorchCount % SCORCHES;
  scorchCount = scorchCount + 1 < 2 * SCORCHES ? scorchCount + 1 : SCORCHES; // counts on, but never far
  scorchX[i] = x;
  scorchY[i] = y;
  scorchKind[i] = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 29;
  markStats.scorches++;
  const half = SCORCH / 2;
  const tx1 = Math.floor((x + half - 1) / TILE), ty1 = Math.floor((y + half - 1) / TILE);
  for (let ty = Math.floor((y - half) / TILE); ty <= ty1; ty++) {
    for (let tx = Math.floor((x - half) / TILE); tx <= tx1; tx++) {
      const t = markable(tx, ty);
      if (!t) continue;
      stampScorch(t.base, tx * TILE, ty * TILE, i);
      owe(t);
    }
  }
}

/**
 * A car slid: its two rear wheels came the ways in MARK (see there). Two short dark lines,
 * on the tiles that are there now and on those baked later. A way longer than a car is long
 * is no slide (the car was put there): nothing is marked.
 */
export function skid(track: Track): void {
  if (!markSwitch.on) return;
  const LONGEST = 28; // view pixels
  for (let w = 0; w < 8; w += 4) {
    const ex = (MARK[w + 2] - MARK[w]) * ZOOM, ey = (MARK[w + 3] - MARK[w + 1]) * ZOOM;
    if (!(ex * ex + ey * ey <= LONGEST * LONGEST)) return;
  }
  const ax = (MARK[4] - MARK[0]) * ZOOM, ay = (MARK[5] - MARK[1]) * ZOOM;
  if (!(ax * ax + ay * ay <= 10 * 10)) return; // the two wheels of one car are that near each other
  if (!marksOn(track)) return;
  const i = skidCount % SKIDS;
  skidCount = skidCount + 1 < 2 * SKIDS ? skidCount + 1 : SKIDS;
  let lox = 1e9, loy = 1e9, hix = -1e9, hiy = -1e9;
  for (let k = 0; k < 8; k += 2) {
    const x = (skidPts[i * 8 + k] = MARK[k] * ZOOM), y = (skidPts[i * 8 + k + 1] = MARK[k + 1] * ZOOM);
    if (x < lox) lox = x;
    if (x > hix) hix = x;
    if (y < loy) loy = y;
    if (y > hiy) hiy = y;
  }
  markStats.skids++;
  const tx1 = Math.floor((hix + 2) / TILE), ty1 = Math.floor((hiy + 2) / TILE);
  for (let ty = Math.floor((loy - 2) / TILE); ty <= ty1; ty++) {
    for (let tx = Math.floor((lox - 2) / TILE); tx <= tx1; tx++) {
      const t = markable(tx, ty);
      if (!t) continue;
      stampSkid(t.base, tx * TILE, ty * TILE, i);
      owe(t);
    }
  }
}

/** The marks made are no more. The tiles showing some are wiped over the next frames, one a frame. */
function dropMarks(): void {
  if (!scorchCount && !skidCount) return;
  scorchCount = skidCount = 0;
  marksEpoch++;
  wiping = true;
}

/** All marks go (a new race, a restart). The tiles showing some are wiped over the next frames, one a frame. */
export function clearMarks(): void {
  clearings++;
  dropMarks();
}

/**
 * How often the marks have been cleared (clearMarks). Whoever remembers something about the
 * marks made (gfx/actors.ts: the blasts that have left their scorch) sees by it that they
 * are gone. A track's first mark is no clearing (marksOn): the blast that made it, and the
 * next ones, are that track's own.
 */
export function marksCleared(): number {
  return clearings;
}

/** A frame's upkeep of the marks: one tile of an older epoch wiped, and the owed pixels put on their canvases. */
function sendMarks(): void {
  if (wiping) {
    let found = false;
    for (let i = 0; i < pool.length && !found; i++) {
      const t = pool[i];
      if (!t.marked || t.epoch === marksEpoch) continue;
      found = true;
      if (!t.ready || !t.home) t.marked = false; // it holds nothing, or is being baked: no pixels to wipe
      else wipe(t, (t.key & (2 * KEY_HALF - 1)) - KEY_HALF, (t.key >> KEY_BITS) - KEY_HALF);
    }
    if (!found) wiping = false;
  }
  if (!unsent) return;
  unsent = false;
  if (!markOut32) {
    markOut = typeof ImageData === "undefined" ? null : new ImageData(TILE, TILE);
    markOut32 = markOut ? new Uint32Array(markOut.data.buffer) : new Uint32Array(TILE * TILE);
  }
  const out = markOut32;
  for (let i = 0; i < pool.length; i++) {
    const t = pool[i];
    if (t.x1 <= t.x0) continue;
    const base = t.base;
    if (t.ready) {
      const shown = t.scenery.shown; // the tile's own theme's
      for (let y = t.y0; y < t.y1; y++) {
        for (let o = y * TILE + t.x0, end = y * TILE + t.x1; o < end; o++) out[o] = shown[base[o]];
      }
      if (markOut) t.ctx.putImageData(markOut, 0, 0, t.x0, t.y0, t.x1 - t.x0, t.y1 - t.y0);
      markStats.uploads++;
      markStats.pixels += (t.x1 - t.x0) * (t.y1 - t.y0);
    }
    t.x1 = t.x0 = 0;
  }
}

/** A tile is finished: the marks that lie on it are put into its pixels (out32) before they go to its canvas. */
function marksBack(t: Tile, tx: number, ty: number, out32: Uint32Array): void {
  t.marked = false;
  t.epoch = marksEpoch;
  t.x1 = t.x0 = 0;
  if (!markArt || t.home !== markArt.tiles || !(scorchCount || skidCount)) return;
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
  const hit = stampAll(t.base, tx, ty);
  if (sx1 > sx0) {
    const base = t.base, shown = t.scenery.shown;
    for (let y = sy0; y < sy1; y++) {
      for (let o = y * TILE + sx0, end = y * TILE + sx1; o < end; o++) out32[o] = shown[base[o]];
    }
    t.marked = true;
    markStats.putBack += hit;
  }
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
}

// ---- the world ------------------------------------------------------------------------

const want = new Int32Array(96); // this frame's tiles to have, as tx, ty pairs, most wanted first
let wanted = 0; // ... and how many numbers of it are in use
// The view centre wantRound() works round, in view pixels. It is handed over here and not in
// the call: a number that is not whole was boxed on the way in (16 bytes each, in Node).
const centre = new Float64Array(2);
const clock = (): number => performance.now();

export class World {
  private readonly art: Art;
  private readonly plain: string; // a tile that is not baked yet: the theme's plain ground
  private first = true;
  private cut = false; // the camera jumped since the last frame
  private aims = 0; // follow() calls since the last frame
  private aimX = 0; // where the camera is heading, view pixels
  private aimY = 0;
  private velX = 0; // ... and how fast the aim moves, view pixels per ms
  private velY = 0;
  private restX = NaN; // the car position the predicted destination was worked out for
  private restY = NaN;
  private destX = 0; // where the own car will be put back, view pixels
  private destY = 0;
  private dest = false;

  /** `scenery`: the track's theme as the Renderer resolved it (a caller without one gets the track's own). */
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
    scenery: Scenery = sceneryFor(track),
  ) {
    this.art = artOf(track, scenery);
    this.plain = scenery.plain;
    if (!pool.length) softTiles = ctx.getContextAttributes?.().willReadFrequently !== false;
    if (markArt && markArt !== this.art) clearMarks(); // another track: its marks go
  }

  /** Where the camera is heading (world coordinates), once per frame; snap = it jumps there. */
  aim(x: number, y: number, dtMs: number, snap: boolean): void {
    const ax = x * ZOOM, ay = y * ZOOM;
    if (snap || this.first) {
      this.cut = true;
      this.velX = this.velY = 0;
    } else if (dtMs > 0) {
      const vx = (ax - this.aimX) / dtMs, vy = (ay - this.aimY) / dtMs;
      // A jump of the aim (a recovery, a new leader) is no speed.
      if (Math.abs(vx) > 1.5 || Math.abs(vy) > 1.5) this.velX = this.velY = 0;
      else {
        this.velX += (vx - this.velX) * 0.3;
        this.velY += (vy - this.velY) * 0.3;
      }
    }
    this.aimX = ax;
    this.aimY = ay;
    this.aims++;
  }

  /**
   * Draw the world with the view's top-left at view pixel (ox, oy) of the track's plane
   * (identity transform), and bake what will be needed next. `cars`: the own car's fall or
   * wreck tells where it will be put back.
   */
  draw(ox: number, oy: number, cars: readonly CarView[]): void {
    const ctx = this.ctx, art = this.art;
    frameNo++;
    const sync = this.first || this.cut || this.aims > 1;
    if (!this.aims) {
      // Drawn without an aim: the view is all there is to go by.
      this.aimX = ox + VIEW_W / 2;
      this.aimY = oy + VIEW_H / 2;
    }
    this.first = this.cut = false;
    this.aims = 0;
    this.predict(cars);
    if (unsent || wiping) sendMarks();

    const x0 = Math.floor(ox / TILE), x1 = Math.floor((ox + VIEW_W - 1) / TILE);
    const y0 = Math.floor(oy / TILE), y1 = Math.floor((oy + VIEW_H - 1) / TILE);
    // The tiles on screen are in use, whatever happens to them below.
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = tileAt(art, tx, ty);
        if (t) t.used = frameNo;
      }
    }
    if (sync) {
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.bakeNow(tx, ty);
    }
    this.bakeAhead(ox, oy);

    ctx.fillStyle = this.plain;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = tileAt(art, tx, ty);
        if (t && t.ready) ctx.drawImage(t.canvas, tx * TILE - ox, ty * TILE - oy);
        else {
          ctx.fillRect(tx * TILE - ox, ty * TILE - oy, TILE, TILE);
          worldStats.placeholders++;
        }
      }
    }
  }

  /** Bake a tile to the end, now. */
  private bakeNow(tx: number, ty: number): void {
    const have = tileAt(this.art, tx, ty);
    if (have && have.ready) return;
    if (!(baking && baking === have)) {
      if (!this.begin(tx, ty)) return;
    }
    while (bakeStep()) { /* to the end */ }
    this.done();
  }

  /** Point the job at a tile; false when the pool has no tile to spare (or the tile is beyond what a key holds). */
  private begin(tx: number, ty: number): boolean {
    const key = tileKey(tx, ty);
    if (key < 0) return false;
    drop(); // a job for another tile: its turn comes again if it is still wanted
    const t = claim();
    if (!t) return false;
    t.home = this.art.tiles;
    t.key = key;
    t.scenery = this.art.scenery;
    t.ready = false;
    t.used = frameNo;
    t.home.set(key, t);
    baking = t;
    bakeStart(this.art, tx, ty);
    return true;
  }

  private done(): void {
    const t = baking!;
    const b = buffers();
    marksBack(t, job.tx, job.ty, b.out32);
    if (b.out) t.ctx.putImageData(b.out, 0, 0);
    t.ready = true;
    baking = null;
    worldStats.baked++;
  }

  /**
   * This frame's share of the baking: the tiles round the aim first (they are, or are about
   * to be, on screen), then those ahead of it, then those round a predicted destination.
   * (ox, oy): the view's top-left, as in draw().
   */
  private bakeAhead(ox: number, oy: number): void {
    const art = this.art;
    wanted = 0;
    centre[0] = this.aimX;
    centre[1] = this.aimY;
    wantRound(MARGIN);
    // A camera easing in to a far aim (a recovery, a new leader): once it is near, what it
    // shows on the way counts too. Further out the view changes every frame and is left plain.
    const off = Math.abs(ox + VIEW_W / 2 - this.aimX) + Math.abs(oy + VIEW_H / 2 - this.aimY);
    if (off > MARGIN && off < NEAR) {
      centre[0] = ox + VIEW_W / 2;
      centre[1] = oy + VIEW_H / 2;
      wantRound(0);
    }
    const nAim = wanted;
    const lx = Math.max(-LEAD_MAX, Math.min(LEAD_MAX, this.velX * LEAD_MS)), ly = Math.max(-LEAD_MAX, Math.min(LEAD_MAX, this.velY * LEAD_MS));
    if (Math.abs(lx) + Math.abs(ly) > 8) {
      centre[0] = this.aimX + lx;
      centre[1] = this.aimY + ly;
      wantRound(MARGIN);
    }
    if (this.dest) {
      centre[0] = this.destX;
      centre[1] = this.destY;
      wantRound(0);
    }
    const n = wanted;

    // Wanted tiles are not given away this frame. Is one round the aim missing?
    let missing = false, urgent = false;
    for (let k = 0; k < n; k += 2) {
      const t = tileAt(art, want[k], want[k + 1]);
      if (t) t.used = frameNo;
      if (!t || !t.ready) {
        missing = true;
        if (k < nAim) urgent = true;
      }
    }
    // A job left over from another track is dropped. One for a tile of this track that has
    // just left the list is finished first: it is near, and most of its work may be done.
    if (baking && job.art !== art) drop();
    if (!missing && !baking) return;

    // Steps until the budget is used: the larger one while a tile round the aim is missing.
    const units = urgent ? URGENT_UNITS : AHEAD_UNITS, ms = urgent ? URGENT_MS : AHEAD_MS;
    const t0 = clock();
    let used = 0, k = 0;
    for (;;) {
      if (!baking) {
        while (k < n && tileAt(art, want[k], want[k + 1])?.ready) k += 2;
        if (k >= n || !this.begin(want[k], want[k + 1])) break; // all there, or no tile to spare
      }
      if (used >= units || (used > 0 && clock() - t0 >= ms)) break;
      if (bakeStep()) used += COST[0];
      else this.done();
    }
    worldStats.units += used;
  }

  /**
   * Where will the own car be put back? While it falls: at its recovery point. While it is a
   * wreck: on the centreline, or at the recovery point when that spot is over a hazard
   * (shared/weapons.ts recover, respawn). Worked out once per fall or wreck.
   */
  private predict(cars: readonly CarView[]): void {
    let own: CarView | null = null;
    for (let i = 0; i < cars.length; i++) if (cars[i].me) own = cars[i];
    const falling = own !== null && own.falling !== undefined && own.falling > 0;
    if (!own || !(falling || own.wreck)) {
      this.dest = false;
      this.restX = NaN;
      return;
    }
    if (own.x === this.restX && own.y === this.restY) return; // it has not moved
    this.restX = own.x;
    this.restY = own.y;
    this.dest = false;
    const art = this.art, track = art.track, L = track.length;
    // The renderer is not told which part of the track the car is on. At a crossing two parts
    // pass under it: the nearest piece, and the nearest one that is far from it along the
    // track (or on another road: a shortcut's, BR-BAKE). The part that is a hazard there is the
    // one the car fell from.
    const px = own.x * ZOOM, py = own.y * ZOOM;
    let firstS = -1, firstRoad = 0, pick = -1, pickRoad = 0;
    for (let pass = 0; pass < 2 && pick < 0; pass++) {
      let best = pass ? (2 * track.wall * ZOOM) ** 2 : BIG, bi = -1, bt = 0;
      for (let i = 0; i < art.n; i++) {
        if (pass && art.road[i] === firstRoad) {
          // (firstS and a piece's s0 are of one road here: both have its base in them. An open road's ends are not neighbours.)
          const along = Math.abs(art.s0[i] - firstS);
          if ((firstRoad ? along : Math.min(along, L - along)) < track.wall * 4) continue;
        }
        const wx = px - art.ax[i], wy = py - art.ay[i];
        let t = (wx * art.ex[i] + wy * art.ey[i]) * art.inv[i];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = wx - art.ex[i] * t, dy = wy - art.ey[i] * t;
        if (dx * dx + dy * dy < best) {
          best = dx * dx + dy * dy;
          bi = i;
          bt = t;
        }
      }
      if (bi < 0) break;
      // On its own road (a shortcut's distances are its own, from its base).
      const k = art.road[bi], on = art.roads[k];
      const at = art.s0[bi] + art.ds[bi] * bt, s = k ? at - art.sBase[k] : at;
      // A falling car stands over the hazard; a wreck goes to the centreline there.
      const x = falling ? own.x : (art.ax[bi] + art.ex[bi] * bt) * UNIT, y = falling ? own.y : (art.ay[bi] + art.ey[bi] * bt) * UNIT;
      if (gapAt(on, s) !== null || holeAt(on, x, y, s) !== null) {
        pick = s;
        pickRoad = k;
      } else if (!pass) {
        firstS = at;
        firstRoad = k;
      }
    }
    // A fall with no hazard found under the car (it left the track): from the nearest part.
    if (pick < 0 && falling) {
      pick = firstRoad ? firstS - art.sBase[firstRoad] : firstS;
      pickRoad = firstRoad;
    }
    if (pick < 0) return; // a wreck on solid ground stays where it is
    if (pickRoad) {
      // On a shortcut: its last recovery point at or before the place, or (none yet) the main
      // road's before the fork (shared/track.ts recoveryFor).
      const rec = art.roads[pickRoad].recovery;
      let r = -1;
      for (let k = 0; k < rec.length; k++) if (rec[k] <= pick) r = k;
      this.destX = (r < 0 ? art.recX[art.recBack[pickRoad]] : art.recRoadX[pickRoad][r]) * ZOOM;
      this.destY = (r < 0 ? art.recY[art.recBack[pickRoad]] : art.recRoadY[pickRoad][r]) * ZOOM;
      this.dest = true;
      return;
    }
    let r = track.recovery.length - 1;
    for (let k = 0; k < track.recovery.length; k++) if (track.recovery[k] <= pick) r = k;
    this.destX = art.recX[r] * ZOOM;
    this.destY = art.recY[r] * ZOOM;
    this.dest = true;
  }
}

/** Add the tiles under a view centred on `centre`, `margin` wider all round, to this frame's list: nearest to the centre first. */
function wantRound(margin: number): void {
  const cx = centre[0], cy = centre[1];
  const x0 = Math.floor((cx - VIEW_W / 2 - margin) / TILE), x1 = Math.floor((cx + VIEW_W / 2 - 1 + margin) / TILE);
  const y0 = Math.floor((cy - VIEW_H / 2 - margin) / TILE), y1 = Math.floor((cy + VIEW_H / 2 - 1 + margin) / TILE);
  const from = wanted;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      let seen = false;
      for (let k = 0; k < wanted; k += 2) {
        if (want[k] === tx && want[k + 1] === ty) {
          seen = true;
          break;
        }
      }
      if (seen || wanted + 2 > want.length) continue;
      // An insertion sort over the few tiles of this group.
      const d = Math.abs((tx + 0.5) * TILE - cx) + Math.abs((ty + 0.5) * TILE - cy);
      let q = wanted;
      while (q > from) {
        const e = Math.abs((want[q - 2] + 0.5) * TILE - cx) + Math.abs((want[q - 1] + 0.5) * TILE - cy);
        if (e <= d) break;
        want[q] = want[q - 2];
        want[q + 1] = want[q - 1];
        q -= 2;
      }
      want[q] = tx;
      want[q + 1] = ty;
      wanted += 2;
    }
  }
}

/** Give up the job in progress: its tile holds nothing again. */
function drop(): void {
  if (!baking) return;
  worldStats.dropped++;
  baking.home = null;
  baking.key = -1;
  baking.ready = false;
  baking = null;
}

/**
 * For tests and checks: bake one tile of a track to the end and return its palette indices
 * (TILE x TILE). `trace` is told each step's number, its cost in units and the time it took.
 */
export function bakeTileIndices(track: Track, tx: number, ty: number, trace?: (step: number, units: number, ms: number) => void): Uint8Array {
  drop(); // a job under way for the pool would be baked over
  bakeStart(artOf(track), tx, ty);
  for (;;) {
    const step = job.step, t0 = clock();
    if (!bakeStep()) break;
    trace?.(step, COST[0], clock() - t0);
  }
  const { idx } = buffers();
  const out = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) out[y * TILE + x] = idx[(y + PAD) * S + PAD + x] & 63;
  return out;
}

/**
 * For checks: the most pieces the bake's two lists have held at a time (`near`: the pieces near
 * a block, of `nearRoom`; `cand`: the pieces near a tile, of `candRoom`) since the page loaded
 * or the last call with `reset`. A list that was full has left pieces out.
 */
export function bakePeaks(reset = false): { near: number; nearRoom: number; cand: number; candRoom: number } {
  const out = { near: PEAK[0], nearRoom: near.length, cand: PEAK[1], candRoom: cand.length };
  if (reset) PEAK.fill(0);
  return out;
}

/**
 * For checks: what a track's art lays out beside and on its roads. Barrier posts (x, y of each
 * one's top-left view pixel: a post is 3 x 3), the junk or props outside the walls (centre and
 * size, view pixels), the ruts' points (x, y pairs, view pixels), and how many mouths have paint.
 */
export function artLayout(track: Track): { posts: Int32Array; junk: readonly { x: number; y: number; r: number }[]; ruts: readonly Float32Array[]; mouths: number } {
  const a = artOf(track);
  return { posts: a.posts, junk: a.junk, ruts: a.ruts, mouths: a.mouths.length };
}

/** What a pixel of a baked tile is, as bakeTileKinds() tells it. */
export const KIND = { tarmac: C_TARMAC, kerb: C_KERB, verge: C_VERGE, barrier: C_BARRIER, rail: C_RAIL, dirt: C_DIRT, bed: C_BED, water: C_WATER, belt: C_BELT, isle: C_ISLE, solid: C_SOLID, plate: C_PLATE, void: C_VOID, prop: C_PROP } as const;

/**
 * For tests and checks: bake one tile of a track to the end and return what each of its pixels
 * is (KIND; 0 = none of the track's: the yard), TILE x TILE.
 */
export function bakeTileKinds(track: Track, tx: number, ty: number): Uint8Array {
  bakeTileIndices(track, tx, ty);
  const { cls } = buffers();
  const out = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) out.set(cls.subarray((y + PAD) * S + PAD, (y + PAD) * S + PAD + TILE), y * TILE);
  return out;
}

/**
 * For tests and checks: as bakeTileIndices, with the track marks that lie on the tile put on
 * (the colours as drawn). With `keepOff`, the pixels that take no marks come back as 255.
 */
export function bakeTileMarked(track: Track, tx: number, ty: number, keepOff = false): Uint8Array {
  bakeTileIndices(track, tx, ty);
  const base = spareBase();
  if (markArt === artOf(track)) stampAll(base, tx, ty);
  sx0 = sy0 = TILE;
  sx1 = sy1 = 0;
  const out = new Uint8Array(TILE * TILE), shownI = artOf(track).scenery.shownI;
  for (let o = 0; o < out.length; o++) out[o] = keepOff && base[o] & OFF ? 255 : shownI[base[o]];
  return out;
}

/** For tests and checks: the palette indices pool tile (tx, ty) of a track shows right now (its marks on), or null when it is not there. */
export function poolTileIndices(track: Track, tx: number, ty: number): Uint8Array | null {
  const t = tileAt(artOf(track), tx, ty);
  if (!t || !t.ready) return null;
  const shownI = t.scenery.shownI;
  return Uint8Array.from(t.base, (v) => shownI[v]);
}

/**
 * The centerline as polylines: the whole closed loop when there are no gaps, else one open
 * polyline per stretch of ground from a gap's end to the next gap's start (wrapping).
 */
export function groundRuns(t: Track): Vec[][] {
  if (!t.gaps.length) return [t.pts];
  const L = t.length;
  const n = t.pts.length;
  return t.gaps.map((g, i) => {
    const from = g.s1;
    const to = i + 1 < t.gaps.length ? t.gaps[i + 1].s0 : t.gaps[0].s0 + L;
    const a = pointAt(t, from), b = pointAt(t, to);
    const run: Vec[] = [{ x: a.x, y: a.y }];
    for (let j = 0; j < 2 * n; j++) {
      const s = t.cum[j % n] + (j >= n ? L : 0);
      if (s > from && s < to) run.push(t.pts[j % n]);
    }
    run.push({ x: b.x, y: b.y });
    return run;
  });
}

export function polyPath(runs: Vec[][], map: (p: Vec) => Vec, closed: boolean): Path2D {
  const path = new Path2D();
  for (const run of runs) {
    run.forEach((p, i) => {
      const q = map(p);
      if (i) path.lineTo(q.x, q.y);
      else path.moveTo(q.x, q.y);
    });
    if (closed) path.closePath();
  }
  return path;
}
