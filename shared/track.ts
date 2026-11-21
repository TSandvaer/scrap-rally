// Track geometry: a closed centerline (Catmull-Rom through control points) with a road
// width, a grass verge, and walls, plus track features (ramps, gaps, holes) and recovery
// points placed by distance along the centerline (s). All queries are pure so client and
// server agree.

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

export type Feature = Ramp | Gap | Hole | Cell;

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
}

/** A hole with its centre in world coordinates (computed once by buildTrack). */
export interface PlacedHole extends Hole { x: number; y: number }

/** A cell with its centre in world coordinates (buildTrack). Track.cells' order is the snapshot's (cells[i]). */
export interface PlacedCell extends Cell { x: number; y: number; seg: number }

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
}

export interface TrackQuery {
  dist: number; // distance from centerline
  nx: number; // unit normal pointing from centerline toward the point
  ny: number;
  s: number; // distance along the track of the nearest centerline point
  seg: number; // nearest segment index
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
  const track: Track = {
    def,
    pts,
    cum,
    length,
    wall: def.halfWidth + def.verge,
    checkpoints: [0.25, 0.5, 0.75].map((f) => f * length),
    ramps: [],
    gaps: [],
    holes: [],
    cells: [],
    recovery: [],
  };
  for (const f of def.features ?? []) {
    if (f.k === "ramp") track.ramps.push({ ...f });
    else if (f.k === "gap") track.gaps.push({ ...f });
    else {
      const p = pointAt(track, f.s);
      const at = { x: p.x - Math.sin(p.h) * f.lat, y: p.y + Math.cos(p.h) * f.lat };
      if (f.k === "hole") track.holes.push({ ...f, ...at });
      else track.cells.push({ ...f, ...at, seg: p.seg });
    }
  }
  track.ramps.sort((a, b) => a.s - b.s);
  track.gaps.sort((a, b) => a.s0 - b.s0);
  track.holes.sort((a, b) => a.s - b.s);
  track.cells.sort((a, b) => a.s - b.s || a.lat - b.lat);
  const rec = def.recovery?.length ? def.recovery : [0];
  track.recovery = rec.map((r) => wrapS(track, r)).sort((a, b) => a - b);
  return track;
}

function nearest(track: Track, x: number, y: number, from: number, count: number): TrackQuery {
  const { pts, cum } = track;
  const n = pts.length;
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
  if (dist > 1e-6) { nx /= dist; ny /= dist; } else {
    const a = pts[bestSeg], b = pts[(bestSeg + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    nx = -(b.y - a.y) / l; ny = (b.x - a.x) / l;
  }
  const s = cum[bestSeg] + (cum[bestSeg + 1] - cum[bestSeg]) * bestT;
  return { dist, nx, ny, s, seg: bestSeg };
}

/** Nearest point on the whole centerline. Use only when there is no position history. */
export function queryTrack(track: Track, x: number, y: number): TrackQuery {
  return nearest(track, x, y, 0, track.pts.length);
}

/**
 * Nearest point searched only around `hint` (the car's last segment), so a car is never
 * snapped to a different part of the track that happens to pass close by.
 */
export function queryTrackNear(track: Track, x: number, y: number, hint: number): TrackQuery {
  // No global fallback: at a crossing that would snap a car onto the other road. A point
  // further than 2 * wall from its own section is lost (see isLost): a car falls, a shot dies.
  return nearest(track, x, y, hint - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
}

/** Further than 2 * wall from its own section: a car falls (see stepRaceCar). */
export function isLost(track: Track, q: TrackQuery): boolean {
  return q.dist > track.wall * 2;
}

/** Wrap a distance along the track into [0, length) (exactly s when already inside). */
function wrapS(track: Track, s: number): number {
  const L = track.length;
  return s >= 0 && s < L ? s : ((s % L) + L) % L;
}

/** Unit direction of travel of segment `seg`. */
export function segDir(track: Track, seg: number): Vec {
  const { pts } = track;
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
  const L = track.length;
  for (const h of track.holes) {
    const ds = Math.abs(wrapS(track, s) - h.s);
    if (Math.min(ds, L - ds) > h.r + track.wall) continue; // a different part of the track
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

/** The last recovery point at or before s, wrapping to the last one of the lap before. */
export function recoveryAt(track: Track, s: number): number {
  s = wrapS(track, s);
  const rec = track.recovery;
  let best = rec[rec.length - 1];
  for (const r of rec) if (r <= s) best = r;
  return best;
}

/** Point and heading on the centerline at distance s (wraps). */
export function pointAt(track: Track, s: number): { x: number; y: number; h: number; seg: number } {
  const L = track.length;
  s = ((s % L) + L) % L;
  const { pts, cum } = track;
  // The last sample i (at most n - 1) with cum[i] <= s: a binary search over cum (non-decreasing,
  // cum[0] = 0), the same sample a scan from 0 finds (M4-BOTS: bots call this every tick).
  let i = 0, hi = pts.length - 1;
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
  const a = segDir(track, (i - 1 + n) % n), b = segDir(track, i);
  let dx = a.x + b.x, dy = a.y + b.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) { dx = b.x; dy = b.y; } else { dx /= l; dy /= l; }
  return { x: -dy, y: dx };
}

/** The corridor (centerline +-wall) cut into ground and gap pieces, one quad each. */
function corridorPieces(track: Track): Piece[] {
  const { pts, cum, wall } = track;
  const n = pts.length;
  const normals = pts.map((_, i) => vertexNormal(track, i));
  const out: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const s0 = cum[i], s1 = cum[i + 1];
    const d = segDir(track, i);
    const segN = { x: -d.y, y: d.x };
    const cuts = [s0, s1];
    for (const g of track.gaps) for (const c of [g.s0, g.s1]) if (c > s0 && c < s1) cuts.push(c);
    cuts.sort((p, q) => p - q);
    const at = (s: number) => {
      const t = (s - s0) / (s1 - s0 || 1);
      const nrm = s === s0 ? normals[i] : s === s1 ? normals[(i + 1) % n] : segN;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, nx: nrm.x, ny: nrm.y };
    };
    for (let k = 0; k + 1 < cuts.length; k++) {
      const u = cuts[k], v = cuts[k + 1];
      if (v - u < 1e-6) continue;
      const p = at(u), q = at(v);
      const quad = [
        { x: p.x + p.nx * wall, y: p.y + p.ny * wall },
        { x: q.x + q.nx * wall, y: q.y + q.ny * wall },
        { x: q.x - q.nx * wall, y: q.y - q.ny * wall },
        { x: p.x - p.nx * wall, y: p.y - p.ny * wall },
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
export function validateTrack(track: Track): string[] {
  const errors: string[] = [];
  const L = track.length;
  const f1 = (v: number) => v.toFixed(1);
  const straight = startStraightEnd(track);
  const zone = (what: string, lo: number, hi: number) => {
    if (!(lo >= 0 && hi <= L && lo <= hi)) errors.push(`${what}: outside 0..${f1(L)} (or wraps past the start line)`);
    else if (lo < straight || hi > L - GRID_ZONE) {
      errors.push(`${what}: in the start zone (grid ${f1(L - GRID_ZONE)}..${f1(L)} or start straight 0..${f1(straight)})`);
    }
  };
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
      if (track.holes.some((h) => Math.hypot(h.x - c.x, h.y - c.y) < h.r + CELL_EDGE && Math.min(Math.abs(h.s - c.s), L - Math.abs(h.s - c.s)) < h.r + track.wall)) {
        errors.push(`${at}: over a hole`);
      }
    }
  }
  for (const r of track.recovery) {
    const p = pointAt(track, r);
    const nearHole = track.holes.some((h) => {
      const ds = Math.abs(r - h.s);
      return Math.min(ds, L - ds) <= h.r + track.wall && Math.hypot(p.x - h.x, p.y - h.y) < h.r + RECOVERY_HOLE_MARGIN;
    });
    if (gapAt(track, r) || nearHole || lipAt(track, r)) errors.push(`recovery point s=${f1(r)}: not on solid ground (gap, hole or take-off zone)`);
  }

  const pieces = corridorPieces(track);
  const n = track.pts.length;
  const indexMin = 2 * LOCAL_WINDOW + SECTION_INDEX_MARGIN;
  const crossings: { a: Piece; b: Piece }[] = [];
  const closeIndex: { a: Piece; b: Piece; di: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const a = pieces[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const b = pieces[j];
      const along = Math.min(wrapS(track, b.s0 - a.s1), wrapS(track, a.s0 - b.s1));
      if (along < SAME_SECTION * track.wall) continue;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.rad + b.rad) continue;
      if (!quadsOverlap(a.quad, b.quad)) continue;
      if (a.ground && b.ground) crossings.push({ a, b });
      const di = Math.abs(a.seg - b.seg);
      const cyc = Math.min(di, n - di);
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
  report(crossings, (p) => `ground corridors overlap at s=${f1(p.a.s0)} and s=${f1(p.b.s0)} (cover one with a gap)`);
  report(closeIndex, (p) =>
    `sections at s=${f1(p.a.s0)} and s=${f1(p.b.s0)} come near but are only ${p.di} segments apart (need > ${indexMin})`,
  );
  return errors;
}
