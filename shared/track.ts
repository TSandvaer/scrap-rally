// Track geometry: a closed centerline (Catmull-Rom through control points) with a road
// width, a grass verge, and walls. All queries are pure so client and server agree.

export interface Vec { x: number; y: number }

export interface TrackDef {
  name: string;
  control: [number, number][];
  halfWidth: number; // asphalt half-width
  verge: number; // grass band between asphalt edge and wall
}

export interface Track {
  def: TrackDef;
  pts: Vec[]; // sampled centerline, closed (pts[n-1] connects back to pts[0])
  cum: number[]; // cumulative length at each sample, cum[n] = length
  length: number;
  wall: number; // distance from centerline to wall
  checkpoints: number[]; // distances along the track that must be crossed in order
}

export interface TrackQuery {
  dist: number; // distance from centerline
  nx: number; // unit normal pointing from centerline toward the point
  ny: number;
  s: number; // distance along the track of the nearest centerline point
  seg: number; // nearest segment index
}

// Original layout: long left straight, a sweeping top section, a chicane in the
// middle, and a hairpin loop at the bottom right.
export const RUST_BOWL: TrackDef = {
  name: "Rust Bowl",
  control: [
    [400, 1700], [400, 1000], [520, 560], [950, 380], [1450, 620], [1850, 420],
    [2450, 420], [2780, 820], [2640, 1320], [2120, 1450], [1720, 1260], [1380, 1480],
    [1480, 1940], [2180, 2020], [2560, 2320], [2240, 2700], [1240, 2700], [620, 2440],
  ],
  halfWidth: 64,
  verge: 44,
};

const SAMPLES_PER_SEGMENT = 16;
const LOCAL_WINDOW = 12; // segments searched either side of the hint

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
  return {
    def,
    pts,
    cum,
    length,
    wall: def.halfWidth + def.verge,
    checkpoints: [0.25, 0.5, 0.75].map((f) => f * length),
  };
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
  const q = nearest(track, x, y, hint - LOCAL_WINDOW, LOCAL_WINDOW * 2 + 1);
  // Lost (teleported or a bad hint): fall back to a full search.
  return q.dist > track.wall * 2 ? queryTrack(track, x, y) : q;
}

/** Point and heading on the centerline at distance s (wraps). */
export function pointAt(track: Track, s: number): { x: number; y: number; h: number; seg: number } {
  const L = track.length;
  s = ((s % L) + L) % L;
  const { pts, cum } = track;
  let i = 0;
  while (i < pts.length - 1 && cum[i + 1] <= s) i++;
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
