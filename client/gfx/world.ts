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

import { MAX_PLAYERS } from "../../shared/protocol";
import { gapAt, gridSlot, holeAt, pointAt, queryTrack, type Track, type Vec } from "../../shared/track";
import type { CarView } from "../render";
import { BAYER4, LIT, P, PALETTE, palette32, SHADE, type PaletteName } from "./palette";

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

const IDX = Object.fromEntries(PALETTE.map((e, i) => [e.name, i])) as Record<PaletteName, number>;
const SHADE_I = Uint8Array.from(PALETTE, (e) => IDX[SHADE[e.name]]);
const LIT_I = Uint8Array.from(PALETTE, (e) => IDX[LIT[e.name]]);
const {
  soot0: SOOT0, soot1: SOOT1, soot2: SOOT2, soot3: SOOT3,
  dirt0: DIRT0, dirt1: DIRT1, dirt2: DIRT2, dirt3: DIRT3,
  gravel0: GRAVEL0, gravel1: GRAVEL1, gravel2: GRAVEL2,
  tar0: TAR0, tar1: TAR1, tar2: TAR2, tar3: TAR3,
  steel0: STEEL0, steel1: STEEL1, steel2: STEEL2, steel3: STEEL3,
  rust0: RUST0, rust1: RUST1, rust2: RUST2,
  bone0: BONE0, bone1: BONE1, bone2: BONE2,
  haz0: HAZ0, haz1: HAZ1,
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

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise 0..1: the ragged edge of a stain. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
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
  gap: Int16Array; // -1 = ground, else the index of its gap
  capA: Uint8Array; // the piece ends flat here (a gap begins or ends), no round join
  capB: Uint8Array;
  junk: Junk[]; // heaps outside the walls, far ones first
  piles: Junk[][]; // per gap: the scrap that fills it (empty unless gap.scrap)
  stains: Blob[]; // on the dirt
  ruts: Float32Array[]; // wheel ruts in the dirt: x, y pairs in view pixels
  oil: Blob[]; // on the tarmac
  patches: { s0: number; s1: number; l0: number; l1: number }[]; // repairs, by distance and lateral offset
  posts: Int32Array; // barrier posts: x, y of each one's top-left pixel
  holes: { x: number; y: number; r: number; rim: Float64Array; cracks: Float64Array[] }[];
  ramps: { s0: number; s1: number; frame: Frame; reach: number; chevrons: Float64Array[][] }[]; // chevrons: [outline, inside] per arrow
  ends: { gap: number; s: number; dir: number; frame: Frame }[]; // a gap's two ends on the road
  start: Frame;
  marks: Float64Array[]; // grid slot marks: quads (x, y pairs)
  recX: Float64Array; // the recovery points, world units
  recY: Float64Array;
}

const arts = new WeakMap<Track, Art>();

function artOf(track: Track): Art {
  let a = arts.get(track);
  if (!a) {
    a = buildArt(track);
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

function buildArt(track: Track): Art {
  const { pts, cum, length: L, wall } = track;
  const hw = track.def.halfWidth;
  const R = wall + BARRIER;
  const wrap = (s: number) => ((s % L) + L) % L;

  // The pieces: every centreline segment, cut where a gap begins or ends.
  const cuts: { a: Vec; b: Vec; s0: number; s1: number; gap: number; capA: boolean; capB: boolean }[] = [];
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
      cuts.push({ a: pt(at[k]), b: pt(at[k + 1]), s0: at[k], s1: at[k + 1], gap: g ? track.gaps.indexOf(g) : -1, capA: edge(at[k]), capB: edge(at[k + 1]) });
    }
  }
  const n = cuts.length;
  const f64 = () => new Float64Array(n);
  const art: Art = {
    tiles: new Map(), track, n,
    ax: f64(), ay: f64(), ex: f64(), ey: f64(), inv: f64(), nx: f64(), ny: f64(), s0: f64(), ds: f64(), dash0: f64(), groove0: f64(), groove1: f64(),
    gap: new Int16Array(n), capA: new Uint8Array(n), capB: new Uint8Array(n),
    junk: [], piles: [], stains: [], ruts: [], oil: [], patches: [], posts: new Int32Array(0), holes: [], ramps: [], ends: [],
    start: frameAt(track, 0), marks: [],
    recX: Float64Array.from(track.recovery, (s) => pointAt(track, s).x),
    recY: Float64Array.from(track.recovery, (s) => pointAt(track, s).y),
  };
  // A stretch of ground starts where the gap before it ends; a track without gaps at s = 0.
  const runStart = (s: number): number => {
    let best = 0, found = false;
    for (const g of track.gaps) if (g.s1 <= s && (!found || g.s1 > best)) { best = g.s1; found = true; }
    return found ? best : track.gaps.length ? track.gaps[track.gaps.length - 1].s1 : 0;
  };
  // The racing line swings a little from side to side, a whole number of times a lap.
  const swings = Math.max(1, Math.round(L / 1640));
  const groove = (s: number) => 16 * Math.sin((2 * Math.PI * swings * s) / L);
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
    art.dash0[i] = wrap(c.s0 - runStart(c.s0));
    art.groove0[i] = groove(c.s0);
    art.groove1[i] = groove(c.s1);
    art.gap[i] = c.gap;
    art.capA[i] = c.capA ? 1 : 0;
    art.capB[i] = c.capB ? 1 : 0;
  });

  // Is the stretch [a, b] of the track clear of every feature, with `more` to spare?
  const clear = (a: number, b: number, more: number): boolean => {
    for (const r of track.ramps) if (b > r.s - more && a < r.s + r.len + more) return false;
    for (const g of track.gaps) if (b > g.s0 - more && a < g.s1 + more) return false;
    for (const h of track.holes) if (b > h.s - h.r - more && a < h.s + h.r + more) return false;
    return true;
  };
  const offset = (s: number, lat: number): Vec => {
    const p = pointAt(track, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
  };

  // Junk outside the barriers, in small heaps; seeded, so every client sees the same yard.
  {
    const rnd = mulberry32(7);
    const paints = [RUST1, RUST2, RUST0, HAZ0, STEEL1, RUST1, STEEL2];
    const heaps: Vec[] = [];
    const want = Math.round(L / 150);
    for (let tries = 0; heaps.length < want && tries < 2500; tries++) {
      const s = rnd() * L;
      const side = rnd() < 0.5 ? -1 : 1;
      const at = offset(s, side * (wall + 40 + rnd() * 150));
      if (queryTrack(track, at.x, at.y).dist < R + 34) continue;
      if (heaps.some((h) => Math.hypot(h.x - at.x, h.y - at.y) < 90)) continue; // heaps stand apart
      heaps.push(at);
      for (let count = 2 + Math.floor(rnd() * 3), k = 0; k < count; k++) {
        const x = at.x + (rnd() - 0.5) * 52, y = at.y + (rnd() - 0.5) * 40;
        const pick = rnd(), r = 9 + rnd() * 8, a = rnd() * Math.PI, c = paints[Math.floor(rnd() * paints.length)];
        if (queryTrack(track, x, y).dist < R + 16) continue;
        const kind = pick < 0.3 ? K_CUBE : pick < 0.46 ? K_DRUM : pick < 0.62 ? K_TYRES : pick < 0.72 ? K_PLATE : pick < 0.82 ? K_PALLET : pick < 0.92 ? K_ENGINE : K_COIL;
        art.junk.push({ kind, x: x * ZOOM, y: y * ZOOM, r: r * ZOOM, a, c });
      }
      // Half the heaps have leaked: a dark stain in the dirt beside them.
      if (rnd() < 0.5) art.stains.push({ x: (at.x + (rnd() - 0.5) * 40) * ZOOM, y: (at.y + 14 + rnd() * 14) * ZOOM, r: (10 + rnd() * 9) * ZOOM });
    }
    art.junk.sort((p, q) => p.y - q.y);

    // Wheel ruts in the dirt, running along the track for a while outside the wall.
    for (let k = 0, count = Math.round(L / 700); k < count; k++) {
      const from = rnd() * L, len = 140 + rnd() * 220, side = rnd() < 0.5 ? -1 : 1;
      const base = wall + 34 + rnd() * 90, swing = 6 + rnd() * 14, wave = 50 + rnd() * 60;
      for (const half of [-6.5, 6.5]) {
        const line: number[] = [];
        for (let u = 0; u <= len; u += 6) {
          const q = offset(from + u, side * (base + half + swing * Math.sin(u / wave)));
          // A rut stops where another part of the track comes near.
          if (queryTrack(track, q.x, q.y).dist < R + 14) break;
          line.push(q.x * ZOOM, q.y * ZOOM);
        }
        if (line.length >= 8) art.ruts.push(Float32Array.from(line));
      }
    }
  }

  // Scrap filling a gap (drawing only: it is not solid), laid out from the gap's start.
  art.piles = track.gaps.map((g, i) => {
    if (!g.scrap) return [];
    const rnd = mulberry32(101 + i);
    const paints = [RUST1, RUST2, RUST0, HAZ0, STEEL1, STEEL2];
    const out: Junk[] = [];
    const W = wall - 4;
    for (let s = g.s0 + 9; s < g.s1 - 6; s += 14) {
      for (let lat = -W + 6; lat < W - 4; lat += 16) {
        const p = offset(s + (rnd() - 0.5) * 8, lat + (rnd() - 0.5) * 9);
        const pick = rnd(), r = 7 + rnd() * 6, a = rnd() * Math.PI, c = paints[Math.floor(rnd() * paints.length)];
        const kind = pick < 0.34 ? K_CUBE : pick < 0.5 ? K_DRUM : pick < 0.66 ? K_TYRES : pick < 0.78 ? K_PLATE : pick < 0.86 ? K_PALLET : pick < 0.94 ? K_ENGINE : K_COIL;
        out.push({ kind, x: p.x * ZOOM, y: p.y * ZOOM, r: r * ZOOM, a, c });
      }
    }
    // From the top of the screen down, so lower items overlap the ones behind them.
    return out.sort((p, q) => p.y - q.y);
  });

  // Wear on the road: repairs with a joint round them, and oil stains.
  {
    const rnd = mulberry32(31);
    for (let s = 260 + rnd() * 300; s < L - 500; s += 520 + rnd() * 640) {
      const len = 44 + rnd() * 50, width = 30 + rnd() * 26;
      const l0 = -hw + 6 + rnd() * (2 * hw - 12 - width);
      if (clear(s, s + len, 60)) art.patches.push({ s0: s, s1: s + len, l0, l1: l0 + width });
    }
    for (let s = 150 + rnd() * 300; s < L - 120; s += 380 + rnd() * 520) {
      const lat = (rnd() - 0.5) * (2 * hw - 44), r = 8 + rnd() * 8;
      if (!clear(s - r, s + r, 30)) continue;
      const p = offset(s, lat);
      art.oil.push({ x: p.x * ZOOM, y: p.y * ZOOM, r: r * ZOOM });
    }
  }

  // Barrier posts: one every 60 units on both sides of every stretch of ground.
  {
    const posts: number[] = [];
    const runs = track.gaps.length ? track.gaps.map((g, i) => [g.s1, i + 1 < track.gaps.length ? track.gaps[i + 1].s0 : track.gaps[0].s0 + L]) : [[0, L]];
    for (const [from, to] of runs) {
      for (let s = from + 30; s < to; s += 60) {
        for (const side of [-1, 1]) {
          const q = offset(s, side * (wall + 3.2));
          posts.push(Math.round(q.x * ZOOM) - 1, Math.round(q.y * ZOOM) - 1);
        }
      }
    }
    art.posts = Int32Array.from(posts);
  }

  // Holes: a jagged rim and four cracks each, seeded.
  art.holes = track.holes.map((hole, i) => {
    const rnd = mulberry32(211 + i);
    const corners = 15;
    const rim = new Float64Array(corners * 2);
    for (let k = 0; k < corners; k++) {
      const a = (k / corners) * Math.PI * 2, r = hole.r * (1.1 + rnd() * 0.16);
      rim[k * 2] = (hole.x + Math.cos(a) * r) * ZOOM;
      rim[k * 2 + 1] = (hole.y + Math.sin(a) * r) * ZOOM;
    }
    const cracks: Float64Array[] = [];
    for (let k = 0; k < 4; k++) {
      const a = rnd() * Math.PI * 2;
      let x = hole.x + Math.cos(a) * hole.r * 1.12, y = hole.y + Math.sin(a) * hole.r * 1.12;
      const line = [x * ZOOM, y * ZOOM];
      for (let j = 0; j < 3; j++) {
        const b = a + (rnd() - 0.5) * 1.1, step = hole.r * (0.18 + rnd() * 0.22);
        x += Math.cos(b) * step;
        y += Math.sin(b) * step;
        line.push(x * ZOOM, y * ZOOM);
      }
      cracks.push(Float64Array.from(line));
    }
    return { x: hole.x * ZOOM, y: hole.y * ZOOM, r: hole.r * ZOOM, rim, cracks };
  });

  // Ramps: the frame its stripes and chevrons are laid out in, and the three chevrons.
  art.ramps = track.ramps.map((ramp) => {
    const frame = frameAt(track, ramp.s + ramp.len / 2);
    const w = wall - 1, d = Math.min(9, ramp.len * 0.18);
    const chevrons = [-w * 0.58, 0, w * 0.58].map((lat) => [chevron(frame, d, lat, 3), chevron(frame, d, lat, 1.5)]);
    return { s0: ramp.s, s1: ramp.s + ramp.len, frame, reach: ramp.len / 2 + wall + 4, chevrons };
  });

  // Each gap end: the ground lies before s0 and after s1; hazard stripes lie on its last 7 units.
  art.ends = track.gaps.flatMap((g, i) => [
    { gap: i, s: g.s0, dir: 1, frame: frameAt(track, g.s0 - 3.5) },
    { gap: i, s: g.s1, dir: -1, frame: frameAt(track, g.s1 + 3.5) },
  ]);

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
  return art;
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
  out: ImageData | null; // the finished tile (browser only)
  out32: Uint32Array;
}

let buf: Buffers | null = null;

function buffers(): Buffers {
  if (!buf) {
    const n = S * S;
    const out = typeof ImageData === "undefined" ? null : new ImageData(TILE, TILE);
    buf = {
      idx: new Uint8Array(n), cls: new Uint8Array(n), mask: new Uint8Array(n),
      dist: new Float32Array(n), seg: new Int16Array(n), tt: new Float32Array(n), lat: new Float32Array(n),
      gap: new Int8Array(n), gapS: new Float32Array(n), gapLat: new Float32Array(n), patch: new Uint8Array(n),
      out, out32: out ? new Uint32Array(out.data.buffer) : new Uint32Array(TILE * TILE),
    };
  }
  return buf;
}

const PAL32 = palette32();
const cand = new Int16Array(1024); // pieces near the tile
const near = new Int16Array(64); // ... near the block
const nearD = new Float32Array(64); // ... and how far from its centre
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
  patched: false, // any repair on this tile? (its joint is drawn at the end of the road pass)
  nc: 0, // pieces in `cand`
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
  job.patched = false;
  const h = Math.floor(hash(tx, ty, 17) * 0x1000000);
  job.o1 = h & 0xffff;
  job.o2 = (Math.imul(h, 40503) >>> 4) & 0xffff;
  job.o3 = (Math.imul(h, 9973) >>> 7) & 0xffff;
}

/**
 * Run the next step of the job. Returns the step's cost in units, or -1 when the tile is
 * finished (its pixels are in out32). The big passes do a slice of the tile per call, so
 * that no step takes much longer than a quarter of a millisecond.
 */
function bakeStep(): number {
  switch (job.step) {
    case 0:
      return classify();
    case 1:
      return ground();
    case 2:
      return yard();
    case 3:
      return road();
    case 4:
      return details();
    case 5:
      return finish();
    default:
      return -1;
  }
}

/** The job moves on to its next step. */
function next(step = job.step + 1): void {
  job.step = step;
  job.sub = 0;
}

/** Per pixel: the nearest ground of the track and the gap it lies in. A few rows of blocks per call. */
function classify(): number {
  const art = job.art!, b = buffers();
  const { ax, ay, ex, ey, inv, nx, ny, s0, ds, gap, capA, capB } = art;
  const { bx, by } = job;
  const wall = art.track.wall;
  const reach = (wall + REACH) * ZOOM + 1; // view pixels
  if (job.sub === 0) {
    // The pieces that can reach into this tile.
    let nc = 0;
    for (let i = 0; i < art.n && nc < cand.length; i++) {
      const x0 = ax[i], y0 = ay[i], x1 = x0 + ex[i], y1 = y0 + ey[i];
      if (Math.max(x0, x1) < bx - reach || Math.min(x0, x1) > bx + S + reach) continue;
      if (Math.max(y0, y1) < by - reach || Math.min(y0, y1) > by + S + reach) continue;
      cand[nc++] = i;
    }
    job.nc = nc;
    job.track = nc > 0;
    b.cls.fill(C_NONE);
    b.dist.fill(BIG);
    if (!nc) {
      next();
      return 30;
    }
    b.gap.fill(-1);
    b.patch.fill(0);
  }
  const nc = job.nc;
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
          let keep = run;
          for (let q = run; q < nb; q++) {
            if (nearD[q] > runMin + 2 * BLOCK_R) continue;
            near[keep] = near[q];
            keep++;
          }
          nb = run = keep;
          runMin = BIG;
        }
        if (k === nc || nb === near.length) break;
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
            b.lat[p] = ((px - ax[gi]) * nx[gi] + (py - ay[gi]) * ny[gi]) * UNIT;
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
            b.lat[p] = ((px - ax[gi]) * nx[gi] + (py - ay[gi]) * ny[gi]) * UNIT;
          }
          if (vi >= 0) {
            b.gap[p] = gap[vi];
            b.gapS[p] = s0[vi] + ds[vi] * vt;
            b.gapLat[p] = ((px - ax[vi]) * nx[vi] + (py - ay[vi]) * ny[vi]) * UNIT;
          }
        }
      }
    }
  }
  if (y0 >= S) next();
  else job.sub = y0 / BLOCK;
  return 10 + (nc + tests) * 0.6;
}

/** The dirt: specks whose density drifts in large patches, pebbles, and gravel thrown over the wall. Half the tile per call. */
function ground(): number {
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
    let lx = -1e9, a = 0, c = 0, bb = 0, d = 0;
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      if (dist[p] <= R) continue; // the road covers it
      const X = bx + x;
      const cell = Math.floor(X / CELL);
      if (cell !== lx) {
        lx = cell;
        a = hash(cell, ly, 11);
        bb = hash(cell + 1, ly, 11);
        c = hash(cell, ly + 1, 11);
        d = hash(cell + 1, ly + 1, 11);
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
  return 170;
}

/** What lies on the dirt: stains, wheel ruts, and the junk heaps with their shadows. */
function yard(): number {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o2 } = job;
  const { idx, dist } = b;
  const R = art.track.wall + BARRIER;
  let cost = 8;
  for (const st of art.stains) {
    const x0 = Math.max(0, Math.floor(st.x - st.r * 1.3 - bx)), x1 = Math.min(S - 1, Math.ceil(st.x + st.r * 1.3 - bx));
    const y0 = Math.max(0, Math.floor(st.y - st.r - by)), y1 = Math.min(S - 1, Math.ceil(st.y + st.r - by));
    if (x0 > x1 || y0 > y1) continue;
    cost += (x1 - x0 + 1) * (y1 - y0 + 1) * 0.03;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * S + x;
        if (dist[p] <= R) continue;
        const X = bx + x, Y = by + y;
        const d = Math.hypot(X + 0.5 - st.x, (Y + 0.5 - st.y) * 1.4) / (st.r * (0.55 + 0.6 * vnoise(X / 5, Y / 5, 9)));
        const n = N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2 + 91) & 255))];
        if (d < 0.6 ? n < 215 : d < 1 && n < 105) idx[p] = DIRT1;
      }
    }
  }
  for (const rut of art.ruts) {
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
  for (const d of art.junk) {
    const reach = d.r * 1.5 + 6;
    if (d.x + reach < bx || d.x - reach > bx + S || d.y + reach < by || d.y - reach > by + S) continue;
    junk(d);
    cost += 4;
  }
  next(job.track ? 3 : 5);
  return cost;
}

/** The track itself: the void of a gap, then barrier, verge, kerb and tarmac with what is painted and worn on it. */
function road(): number {
  const art = job.art!, b = buffers(), N = noiseTable();
  const { bx, by, o1 } = job;
  const { idx, cls, dist, seg, tt, lat: latOf, gap: gapOf, gapS, gapLat, patch } = b;
  const track = art.track;
  const wall = track.wall, hw = track.def.halfWidth;
  const R = wall + BARRIER, hw5 = hw + KERB, W = wall - 1;
  const { s0, ds, dash0, groove0, groove1 } = art;
  const gaps = track.gaps, ramps = art.ramps, ends = art.ends, patches = art.patches;
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
          c = n < 16 ? DIRT0 : n < 32 ? SOOT1 : n < 35 ? TAR3 : SOOT3;
        } else if (e >= 30) {
          c = n < 18 ? SOOT0 : n < 28 ? SOOT2 : SOOT1;
        } else {
          // Which wall is this the foot of, and does it face the sun (down-right walls do)?
          const i = nearestGapPiece(art, g, s);
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
          c = e < 6 ? (away ? SOOT3 : DIRT0) : e < 13 ? (away ? SOOT2 : SOOT3) : e < 21 ? (away ? SOOT1 : SOOT2) : away ? (n < 40 ? SOOT0 : SOOT1) : n < 128 ? SOOT2 : SOOT1;
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
        if (out > RAIL_IN && out <= RAIL_OUT) { c = STEEL2; k = C_RAIL; } else { c = STEEL0; k = C_BARRIER; }
      } else {
        if (d > hw5) {
          c = n < 19 ? GRAVEL2 : n > 239 ? GRAVEL0 : n > 236 ? BONE0 : GRAVEL1;
          k = C_VERGE;
        } else if (d > hw) {
          c = (dash0[i] + ds[i] * t) % 44 < 22 ? RUST2 : BONE1;
          k = C_KERB;
        } else {
          k = C_TARMAC;
          // Worn along the racing line: more rubber and oil, fewer light specks.
          const worn = Math.abs(l - (groove0[i] + (groove1[i] - groove0[i]) * t)) < 17;
          c = n < (worn ? 77 : 13) ? TAR0 : n > (worn ? 252 : 238) ? TAR2 : TAR1;
          for (let q = 0; q < patches.length; q++) {
            const pa = patches[q];
            if (s < pa.s0 || s > pa.s1 || l < pa.l0 || l > pa.l1) continue;
            c = n < 77 ? TAR2 : n > 248 ? TAR0 : TAR1; // a repair: a lighter mix
            patch[p] = q + 1;
            job.patched = true;
          }
          if (Math.abs(l) < 1.25 && (dash0[i] + ds[i] * t) % 44 < 18) c = TAR3; // the centre line
        }
        // A gap's end on the road: hazard stripes, then the broken edge.
        for (let q = 0; q < ends.length; q++) {
          const en = ends[q];
          const back = (en.s - s) * en.dir; // how far before the edge
          if (back < 0 || back > 7) continue;
          if (Math.abs(l) <= hw5) {
            const f = en.frame;
            const rx = (X + 0.5 - f.x) * UNIT, ry = (Y + 0.5 - f.y) * UNIT;
            const u = rx * f.cos + ry * f.sin, v = -rx * f.sin + ry * f.cos;
            c = Math.floor((u - v + 2 * (hw + 14) + 5) / 5) & 1 ? HAZ1 : SOOT2;
          }
          if (back <= 2) c = GRAVEL2;
        }
        for (let q = 0; q < ramps.length; q++) {
          const rp = ramps[q];
          if (s > rp.s1) {
            // The lip's shadow on what lies beyond it.
            if (s <= rp.s1 + 9 && l >= -W + 4 && l <= W + 4) c = SHADE_I[c];
            continue;
          }
          if (s < rp.s0 || Math.abs(l) > W) continue;
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
          if (Math.abs(l) > W - 1.6 || s < rp.s0 + 1.6) c = SOOT2;
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
    return cost;
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
  return job.patched ? cost + 90 : cost;
}

/** The piece of gap `g` that distance s lies on. */
function nearestGapPiece(art: Art, g: number, s: number): number {
  for (let k = 0; k < job.nc; k++) {
    const i = cand[k];
    if (art.gap[i] === g && s >= art.s0[i] - 1e-6 && s <= art.s0[i] + art.ds[i] + 1e-6) return i;
  }
  for (let i = 0; i < art.n; i++) if (art.gap[i] === g) return i;
  return 0;
}

/**
 * What is drawn over the road, a part per call: the start line, the grid marks and oil;
 * pits and a ramp's chevrons; the scrap in a gap, sixteen pieces at a time.
 */
function details(): number {
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
    for (const quad of art.marks) {
      if (!polyFrom(quad, bx, by)) continue;
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
    for (const st of art.oil) {
      const xa = Math.max(0, Math.floor(st.x - st.r * 1.3 - bx)), xb = Math.min(S - 1, Math.ceil(st.x + st.r * 1.3 - bx));
      const ya = Math.max(0, Math.floor(st.y - st.r - by)), yb = Math.min(S - 1, Math.ceil(st.y + st.r - by));
      if (xa > xb || ya > yb) continue;
      cost += (xb - xa + 1) * (yb - ya + 1) * 0.03;
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const p = y * S + x;
          if (cls[p] !== C_TARMAC || idx[p] === TAR3) continue;
          const X = bx + x, Y = by + y;
          const d = Math.hypot(X + 0.5 - st.x, (Y + 0.5 - st.y) * 1.5) / (st.r * (0.55 + 0.6 * vnoise(X / 5, Y / 5, 9)));
          if (d < 0.6 || (d < 1 && N[((((Y + (o2 >> 8)) & 255) << 8) | ((X + o2 + 91) & 255))] < 128)) idx[p] = TAR0;
        }
      }
    }
    return cost;
  }
  if (part === 1) {
    for (const h of art.holes) {
      const reach = h.r * 1.9 + 2;
      if (h.x + reach < bx || h.x - reach > bx + S || h.y + reach < by || h.y - reach > by + S) continue;
      pit(h);
      cost += 12 + h.r * h.r * 0.12;
    }
    for (const rp of art.ramps) {
      for (const pair of rp.chevrons) {
        // The dark outline first, the bone-white arrow inside it; both on the plate only.
        for (let k = 0; k < 2; k++) {
          if (!polyFrom(pair[k], bx, by)) continue;
          cost += 5;
          const colour = k ? BONE1 : SOOT2;
          fillPoly(mask, 1);
          for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) if (mask[y * S + x] && cls[y * S + x] === C_PLATE) idx[y * S + x] = colour;
          maskClear(mask);
        }
      }
    }
    return cost;
  }
  // The scrap in a gap lies in the gap: where a piece hangs over the road's end it is cut off
  // (the hazard stripes, the edge and a ramp's lip stay whole, as they always were).
  let skip = (part - 2) * 16, done = 0;
  clipClass = C_VOID;
  for (const pile of art.piles) {
    for (const d of pile) {
      const reach = d.r * 1.5 + 6;
      if (d.x + reach < bx || d.x - reach > bx + S || d.y + reach < by || d.y - reach > by + S) continue;
      if (skip-- > 0) continue;
      if (done === 16) {
        clipClass = -1;
        return cost + done * 8;
      }
      done++;
      junk(d);
    }
  }
  clipClass = -1;
  next();
  return cost + done * 8;
}

/** The barrier's depth (its cast shadow, the rail's sunlit edge, the posts), and the tile's pixels. */
function finish(): number {
  const art = job.art!, b = buffers();
  const { idx, cls, out32 } = b;
  const { bx, by } = job;
  if (job.track) {
    // The barrier's shadow falls three pixels right and four down; the rail's up-left edge is lit.
    for (let y = 4; y < S; y++) {
      for (let x = 3; x < S; x++) {
        const p = y * S + x;
        const k = cls[p];
        if (k === C_RAIL) {
          if (cls[p - 1] !== C_RAIL || cls[p - S] !== C_RAIL) idx[p] = STEEL3;
        } else if (k !== C_BARRIER) {
          const q = cls[p - 3 - 4 * S];
          if (q === C_BARRIER || q === C_RAIL) idx[p] = SHADE_I[idx[p]];
        }
      }
    }
    const posts = art.posts;
    for (let k = 0; k < posts.length; k += 2) {
      const x = posts[k] - bx, y = posts[k + 1] - by;
      if (x < 1 || y < 1 || x > S - 6 || y > S - 6) continue;
      // The post's shadow (two pixels down-right), then the post: a lit top-left, a dark bottom-right.
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          if (i + j === 0) continue; // under the post itself
          const p = (y + 2 + j) * S + x + 2 + i;
          idx[p] = SHADE_I[idx[p]];
        }
      }
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) idx[(y + j) * S + x + i] = i === 0 || j === 0 ? STEEL3 : i === 2 || j === 2 ? STEEL0 : STEEL1;
    }
  }
  for (let y = 0; y < TILE; y++) {
    let p = (y + PAD) * S + PAD, o = y * TILE;
    for (let x = 0; x < TILE; x++) out32[o++] = PAL32[idx[p++]];
  }
  next();
  return job.track ? 110 : 60;
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

/** A rectangle w x h centred (ox, oy) from (cx, cy) in a frame turned by a, as the polygon. */
function rect(cx: number, cy: number, cos: number, sin: number, ox: number, oy: number, w: number, h: number): void {
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

/** Fill a disc into mask m (pixel centres). */
function fillDisc(m: Uint8Array, cx: number, cy: number, r: number, v: number): void {
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

/** Paint a disc in colour c inside the shape that is in the mask. */
function inlayDisc(cx: number, cy: number, r: number, c: number): void {
  const { idx, mask } = buffers();
  const ya = Math.max(my0, Math.ceil(cy - r - 0.5)), yb = Math.min(my1 - 1, Math.ceil(cy + r - 0.5) - 1);
  for (let y = ya; y <= yb; y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    const xa = Math.max(mx0, Math.ceil(cx - half - 0.5)), xb = Math.min(mx1 - 1, Math.ceil(cx + half - 0.5) - 1);
    for (let x = xa; x <= xb; x++) if (mask[y * S + x] === 1) idx[y * S + x] = c;
  }
}

const SLATS = [-0.3, 0, 0.3]; // a pallet's gaps and an engine's bores, as shares of the width
const STRAPS = [-0.17, 0.2]; // the straps round a crushed cube

/** Corner k of the polygon: (px, py) in the frame at (x, y) turned by the angle whose cosine and sine are given. */
function corner(k: number, x: number, y: number, cos: number, sin: number, px: number, py: number): void {
  polyX[k] = x + px * cos - py * sin;
  polyY[k] = y + px * sin + py * cos;
}

/** One piece of junk: two tones, a lit edge, a hard shadow. */
function junk(d: Junk): void {
  const { idx, mask } = buffers();
  const x = d.x - job.bx, y = d.y - job.by, r = d.r;
  const cos = Math.cos(d.a), sin = Math.sin(d.a);
  const u = ZOOM; // one world unit, in pixels
  switch (d.kind) {
    case K_CUBE:
    case K_PALLET: {
      // A crushed cube with two straps; a pallet is wood with three gaps between its slats.
      const pallet = d.kind === K_PALLET;
      const w = pallet ? r * 1.6 : r * 2, h = pallet ? r * 1.6 : r * 1.4;
      const c = pallet ? GRAVEL1 : d.c;
      rect(x, y, cos, sin, 0, 0, w, h);
      fillPoly(mask, 1);
      solid(c, 3);
      for (const k of pallet ? SLATS : STRAPS) {
        rect(x, y, cos, sin, 0, k * h, w - 3 * u, 2.5 * u);
        inlay(SHADE_I[c]);
      }
      break;
    }
    case K_DRUM: {
      // A drum on its end: the rim is the bevel, inside it a darker ring.
      const rr = r * 0.66;
      fillDisc(mask, x, y, rr, 1);
      solid(d.c, 3);
      const ring = r * 0.36, dark = SHADE_I[d.c];
      for (let j = my0; j < my1; j++) {
        for (let i = mx0; i < mx1; i++) {
          if (mask[j * S + i] === 1 && Math.abs(Math.hypot(i + 0.5 - x, j + 0.5 - y) - ring) <= 1 * u) idx[j * S + i] = dark;
        }
      }
      break;
    }
    case K_COIL: {
      // A coil of cable: rings of the colour and its shade round a dark eye.
      const rr = r * 0.72;
      fillDisc(mask, x, y, rr, 1);
      solid(d.c, 3);
      const dark = SHADE_I[d.c];
      for (let j = my0 + 1; j < my1 - 1; j++) {
        for (let i = mx0 + 1; i < mx1 - 1; i++) {
          const p = j * S + i;
          if (mask[p] !== 1 || mask[p - 1] === 0 || mask[p - S] === 0 || mask[p + 1] === 0 || mask[p + S] === 0) continue; // the bevel stays
          const q = Math.hypot(i + 0.5 - x, j + 0.5 - y);
          idx[p] = q < rr * 0.24 ? SOOT2 : Math.floor(q / 1.6) & 1 ? dark : d.c;
        }
      }
      break;
    }
    case K_TYRES: {
      for (let k = 0; k < 3; k++) {
        const tx = x + Math.cos(d.a + k * 2.1) * r * 0.5, ty = y + Math.sin(d.a + k * 2.1) * r * 0.5;
        fillDisc(mask, tx, ty, 7 * u, 1);
        solid(SOOT2, 3);
        inlayDisc(tx, ty, 3.4 * u, TAR2);
        maskClear(mask);
      }
      return;
    }
    case K_PLATE: {
      // A bent plate with its crease catching the sun.
      const w = r * 1.3, h = r * 0.8;
      polyN = 4;
      corner(0, x, y, cos, sin, -w, -h * 0.6);
      corner(1, x, y, cos, sin, w * 0.8, -h);
      corner(2, x, y, cos, sin, w, h * 0.5);
      corner(3, x, y, cos, sin, -w * 0.7, h);
      fillPoly(mask, 1);
      solid(d.c, 3);
      const a = d.a - 0.08;
      rect(x, y, Math.cos(a), Math.sin(a), 0, -h * 0.1, w * 1.6, 1.8 * u);
      inlay(LIT_I[d.c]);
      break;
    }
    default: {
      // An engine block: steel, a lighter head, three bores.
      const w = r * 1.7, h = r * 1.1;
      rect(x, y, cos, sin, 0, 0, w, h);
      fillPoly(mask, 1);
      solid(STEEL1, 3);
      rect(x, y, cos, sin, 0, -h / 2 + 1.5 * u + h * 0.18, w - 3 * u, h * 0.36);
      inlay(STEEL2);
      for (const k of SLATS) inlayDisc(x + k * w * cos - h * 0.18 * sin, y + k * w * sin + h * 0.18 * cos, 2.2 * u, SOOT2);
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
  // Cracks: thin dark lines running out from the rim.
  for (const line of h.cracks) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const xa = line[k] - bx, ya = line[k + 1] - by, xb = line[k + 2] - bx, yb = line[k + 3] - by;
      const len = Math.hypot(xb - xa, yb - ya) || 1;
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
      const d = Math.hypot(x + 0.5 - fx, y + 0.5 - fy) / r;
      const t = (BAYER4[(by + y) & 3][(bx + x) & 3] + 0.5) / 16;
      idx[p] = d > 1 ? DIRT0 : d > 0.8 ? ((d - 0.8) / 0.2 > t ? SOOT3 : SOOT2) : d > 0.45 ? ((d - 0.45) / 0.35 > t ? SOOT2 : SOOT1) : d / 0.45 > t ? SOOT1 : SOOT0;
    }
  }
}

// ---- the tile pool --------------------------------------------------------------------

interface Tile {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  home: Map<number, Tile> | null; // the map it is in (its track's tiles), or null when it holds nothing
  key: number; // its tileKey there, or -1
  ready: boolean;
  used: number; // the last frame it was drawn or wanted in
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

/** A tile to bake into: a new one while the pool is not full, else the one unused for longest (never one used this frame). */
function claim(): Tile | null {
  if (pool.length < TILE_POOL) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = TILE;
    // Opaque. In main memory when the view canvas is (one that is read back, as the benchmark's):
    // a blit then never crosses between main memory and the GPU.
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: softTiles })!;
    const t: Tile = { canvas, ctx, home: null, key: -1, ready: false, used: -1 };
    pool.push(t);
    return t;
  }
  let best: Tile | null = null;
  for (const t of pool) {
    if (t === baking || t.used >= frameNo) continue;
    if (!best || t.used < best.used) best = t;
  }
  if (best) {
    if (best.home) best.home.delete(best.key);
    best.home = null;
    best.key = -1;
    best.ready = false;
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

// ---- the world ------------------------------------------------------------------------

const want = new Int32Array(96); // this frame's tiles to have, as tx, ty pairs, most wanted first
let wanted = 0; // ... and how many numbers of it are in use
const clock = (): number => performance.now();

export class World {
  private readonly art: Art;
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

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
  ) {
    this.art = artOf(track);
    if (!pool.length) softTiles = ctx.getContextAttributes?.().willReadFrequently !== false;
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

    const x0 = Math.floor(ox / TILE), x1 = Math.floor((ox + VIEW_W - 1) / TILE);
    const y0 = Math.floor(oy / TILE), y1 = Math.floor((oy + VIEW_H - 1) / TILE);
    // The tiles on screen are in use, whatever happens to them below.
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = art.tiles.get(tileKey(tx, ty));
        if (t) t.used = frameNo;
      }
    }
    if (sync) {
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.bakeNow(tx, ty);
    }
    this.bakeAhead(ox, oy);

    ctx.fillStyle = P.dirt2;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = art.tiles.get(tileKey(tx, ty));
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
    const have = this.art.tiles.get(tileKey(tx, ty));
    if (have && have.ready) return;
    if (!(baking && baking === have)) {
      if (!this.begin(tx, ty)) return;
    }
    while (bakeStep() >= 0) { /* to the end */ }
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
    wantRound(this.aimX, this.aimY, MARGIN);
    // A camera easing in to a far aim (a recovery, a new leader): once it is near, what it
    // shows on the way counts too. Further out the view changes every frame and is left plain.
    const off = Math.abs(ox + VIEW_W / 2 - this.aimX) + Math.abs(oy + VIEW_H / 2 - this.aimY);
    if (off > MARGIN && off < NEAR) wantRound(ox + VIEW_W / 2, oy + VIEW_H / 2, 0);
    const nAim = wanted;
    const lx = Math.max(-LEAD_MAX, Math.min(LEAD_MAX, this.velX * LEAD_MS)), ly = Math.max(-LEAD_MAX, Math.min(LEAD_MAX, this.velY * LEAD_MS));
    if (Math.abs(lx) + Math.abs(ly) > 8) wantRound(this.aimX + lx, this.aimY + ly, MARGIN);
    if (this.dest) wantRound(this.destX, this.destY, 0);
    const n = wanted;

    // Wanted tiles are not given away this frame. Is one round the aim missing?
    let missing = false, urgent = false;
    for (let k = 0; k < n; k += 2) {
      const t = art.tiles.get(tileKey(want[k], want[k + 1]));
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
        while (k < n && art.tiles.get(tileKey(want[k], want[k + 1]))?.ready) k += 2;
        if (k >= n || !this.begin(want[k], want[k + 1])) break; // all there, or no tile to spare
      }
      if (used >= units || (used > 0 && clock() - t0 >= ms)) break;
      const cost = bakeStep();
      if (cost < 0) this.done();
      else used += cost;
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
    // track. The part that is a hazard there is the one the car fell from.
    const px = own.x * ZOOM, py = own.y * ZOOM;
    let firstS = -1, pick = -1;
    for (let pass = 0; pass < 2 && pick < 0; pass++) {
      let best = pass ? (2 * track.wall * ZOOM) ** 2 : BIG, bi = -1, bt = 0;
      for (let i = 0; i < art.n; i++) {
        if (pass) {
          const along = Math.abs(art.s0[i] - firstS);
          if (Math.min(along, L - along) < track.wall * 4) continue;
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
      const s = art.s0[bi] + art.ds[bi] * bt;
      // A falling car stands over the hazard; a wreck goes to the centreline there.
      const x = falling ? own.x : (art.ax[bi] + art.ex[bi] * bt) * UNIT, y = falling ? own.y : (art.ay[bi] + art.ey[bi] * bt) * UNIT;
      if (gapAt(track, s) !== null || holeAt(track, x, y, s) !== null) pick = s;
      else if (!pass) firstS = s;
    }
    // A fall with no hazard found under the car (it left the track): from the nearest part.
    if (pick < 0 && falling) pick = firstS;
    if (pick < 0) return; // a wreck on solid ground stays where it is
    let r = track.recovery.length - 1;
    for (let k = 0; k < track.recovery.length; k++) if (track.recovery[k] <= pick) r = k;
    this.destX = art.recX[r] * ZOOM;
    this.destY = art.recY[r] * ZOOM;
    this.dest = true;
  }
}

/** Add the tiles under a view centred on (cx, cy), `margin` wider all round, to this frame's list: nearest to the centre first. */
function wantRound(cx: number, cy: number, margin: number): void {
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
  if (baking.home) baking.home.delete(baking.key);
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
  bakeStart(artOf(track), tx, ty);
  for (;;) {
    const step = job.step, t0 = clock();
    const units = bakeStep();
    if (units < 0) break;
    trace?.(step, units, clock() - t0);
  }
  const { idx } = buffers();
  const out = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) out.set(idx.subarray((y + PAD) * S + PAD, (y + PAD) * S + PAD + TILE), y * TILE);
  return out;
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
