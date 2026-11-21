// What moves on a road (M4-WORLD; PLAN-M4.md 2.3, 2.4): the barrels of a row rolling from wall
// to wall, a crusher press's slab with the shadow that warns of it, and the arrows running on a
// conveyor belt. Their still parts (the barrels' lane, the press's bed, the belt itself) are
// baked into the world's tiles (gfx/world.ts, "the road's furniture"); this file draws the rest,
// a frame at a time, from the race tick the frame is handed (render.ts WorldFx.rt).
//
// Where each thing is comes from the shared functions of the race tick (shared/track.ts
// barrelLat, pressState), the same ones the server's step and the client's prediction use: the
// picture is the state. Nothing is kept from frame to frame.
//
// Everything is a sprite, drawn in view space at whole pixels (identity transform), and all of
// them live on one sheet (sprites.ts obstacleSheet: OBST_W x OBST_H, one canvas whatever the
// track):
// - the belt's arrow at ARROW_HEADINGS headings, the same on every track;
// - per row of barrels, the ROLL frames of a barrel's turn, drawn at the row's own heading;
// - per press, its slab and the slab's silhouette (its shadow), at the press's heading and width.
// The sheet holds the sprites of one track at a time, laid out when the track is first drawn
// (a track's layout is fixed: obstacleFit says whether all of it has room) and painted again
// when a Renderer of another track draws. A frame allocates nothing.
//
// How they read (see also the baked parts):
// - A barrel: a rust-red drum on its side, its axis along the road, steel hoops, a dark outline
//   and a cast shadow as a car has. A white label and, half a turn on, a seam go round it as it
//   rolls: ROLL frames a turn, picked by how far it has rolled.
// - A press. Up: nothing but its bed (baked) with a dark lamp on each corner post. Warning
//   (PRESS_WARN_TICKS before it slams): the slab's shadow, away down-right and faint at first as
//   that of a car high in the air, closing in and darkening as the slab comes down; the lamps
//   blink red. Down: the slab, hazard-striped all over, over the cars on the ground and under
//   those in the air; the lamps burn. For LIFT ticks after it goes up its shadow leaves
//   the way it came (the gate is open by then: PRESS_UP).
// - A belt: bone-white arrows running across the road with the belt, at its speed.

import { barrelLat, BARREL_R, pointAt, PRESS_DEPTH, PRESS_DOWN, PRESS_WARN_TICKS, PRESS_WARNING, pressState, type PlacedBarrels, type PlacedPress, type Track } from "../../shared/track";
import { P, PALETTE, type PaletteName } from "./palette";
import { fxPalette, FX_SHADOW, OBST_H, OBST_W, obstacleSheet } from "./sprites";
import { VIEW_H, VIEW_W, ZOOM } from "./world";

// The sheet's layout.
const ARROW = 12; // a belt arrow's picture
export const ARROW_HEADINGS = 64;
const ARROW_COLS = 32;
const TOP = (ARROW_HEADINGS / ARROW_COLS) * ARROW; // a track's own sprites lie below the arrows
export const BARREL = 24; // a barrel's picture
export const ROLL = 8; // frames of a barrel's turn
const SLAB_PAD = 6; // air round a slab in its picture: its outline's and its shadow's room

// A barrel, world units: its half-length along its axis (the road's direction); BARREL_R across.
const BARREL_HALF = 7.5;
/** Frames a world unit rolled: ROLL frames a turn of 2 * pi * BARREL_R. */
const ROLL_K = ROLL / (2 * Math.PI * BARREL_R);
// A belt's arrows: a row of them every ARROW_ROWS units along the road, ARROW_PITCH apart
// across it, every second row half a pitch on; they keep ARROW_EDGE off the rollers.
const ARROW_ROWS = 36;
const ARROW_PITCH = 28;
const ARROW_EDGE = 9;
/** For this many ticks after a press has gone up its shadow is still seen leaving. */
const LIFT = 10;
// A press's shadow lies as far from its bed as a car's from the car, by the slab's height
// (gfx/actors.ts AIR_SHADOW_X, _Y: 14 and 20 world units at the top).
const FAR_X = 11, FAR_Y = 16; // view pixels, at the top
const OFF = 20; // a sprite further outside the view than its own size and this is not drawn

const IDX = Object.fromEntries(PALETTE.map((e, i) => [e.name, i + 1])) as Record<PaletteName, number>;

/** A row of barrels: the centreline point it crosses and the way across, in view pixels; its frames on the sheet. */
interface Row {
  b: PlacedBarrels;
  x: number;
  y: number;
  nx: number; // view pixels a world unit to the right of travel
  ny: number;
  reach: number; // view pixels from (x, y) a barrel can be
  ax: number; // its ROLL frames on the sheet, side by side (-1: no room)
  ay: number;
}

/** A press: its bed's middle in view pixels; its slab and silhouette on the sheet; its four lamps. */
interface Gate {
  p: PlacedPress;
  x: number;
  y: number;
  w: number; // a picture's size
  h: number;
  ax: number; // the slab on the sheet (-1: no room); its silhouette lies right of it
  ay: number;
  lamps: Int16Array; // x, y of each lamp's top-left pixel from (x, y)
}

/** A belt: per row of arrows the centreline point and the way across (view pixels), and the arrow's heading. */
interface Band {
  rows: number;
  x: Float64Array;
  y: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  head: Uint8Array;
  l0: number; // the arrows run from here across the road (world units) ...
  count: number; // ... `count` of them a row, ARROW_PITCH apart, wrapping after count * ARROW_PITCH
  vx: number;
  cx: number; // its middle and its reach, view pixels
  cy: number;
  reach: number;
}

/** What moves on a track, laid out once. */
interface Movers {
  rows: Row[];
  gates: Gate[];
  bands: Band[];
  fits: boolean; // every sprite has room on the sheet
  used: number; // sheet pixels its own sprites take
}

const movers = new WeakMap<Track, Movers | null>();

function moversOf(track: Track): Movers | null {
  let m = movers.get(track);
  if (m === undefined) {
    m = layOut(track);
    movers.set(track, m);
  }
  return m;
}

function layOut(track: Track): Movers | null {
  if (!track.barrels.length && !track.presses.length && !track.belts.length) return null;
  const set: Movers = { rows: [], gates: [], bands: [], fits: true, used: 0 };
  // Shelves, left to right, top to bottom.
  let px = 0, py = TOP, ph = 0;
  const place = (w: number, h: number): { x: number; y: number } => {
    if (px + w > OBST_W) {
      px = 0;
      py += ph;
      ph = 0;
    }
    if (w > OBST_W || py + h > OBST_H) {
      set.fits = false;
      return { x: -1, y: -1 };
    }
    const at = { x: px, y: py };
    px += w;
    ph = Math.max(ph, h);
    set.used += w * h;
    return at;
  };
  for (const b of track.barrels) {
    const at = place(ROLL * BARREL, BARREL);
    const reach = Math.max(Math.abs(b.lat0), Math.abs(b.lat1)) * ZOOM + BARREL;
    set.rows.push({ b, x: b.x * ZOOM, y: b.y * ZOOM, nx: b.nx * ZOOM, ny: b.ny * ZOOM, reach, ax: at.x, ay: at.y });
  }
  for (const p of track.presses) {
    const width = p.lat1 - p.lat0, mid = (p.lat0 + p.lat1) / 2;
    const cos = Math.abs(Math.cos(p.h)), sin = Math.abs(Math.sin(p.h));
    // The slab's box at its heading, an even number of pixels each way.
    const w = 2 * Math.ceil(((cos * PRESS_DEPTH + sin * width) * ZOOM) / 2) + 2 * SLAB_PAD;
    const h = 2 * Math.ceil(((sin * PRESS_DEPTH + cos * width) * ZOOM) / 2) + 2 * SLAB_PAD;
    const at = place(2 * w, h);
    const lamps = new Int16Array(8);
    for (let k = 0; k < 4; k++) {
      const u = (k & 1 ? 1 : -1) * (PRESS_DEPTH / 2 - 2.6), v = (k & 2 ? 1 : -1) * (width / 2 - 2.9);
      lamps[k * 2] = Math.floor((u * Math.cos(p.h) - v * Math.sin(p.h)) * ZOOM) - 1;
      lamps[k * 2 + 1] = Math.floor((u * Math.sin(p.h) + v * Math.cos(p.h)) * ZOOM) - 1;
    }
    set.gates.push({ p, x: Math.round((p.x + p.nx * mid) * ZOOM), y: Math.round((p.y + p.ny * mid) * ZOOM), w, h, ax: at.x, ay: at.y, lamps });
  }
  for (const b of track.belts) {
    const rows = Math.max(1, Math.round((b.s1 - b.s0 - 12) / ARROW_ROWS));
    const band: Band = {
      rows, x: new Float64Array(rows), y: new Float64Array(rows), nx: new Float64Array(rows), ny: new Float64Array(rows), head: new Uint8Array(rows),
      l0: b.lat0 + ARROW_EDGE, count: Math.max(1, Math.floor((b.lat1 - b.lat0 - 2 * ARROW_EDGE) / ARROW_PITCH) + 1), vx: b.vx, cx: 0, cy: 0, reach: 0,
    };
    const way = b.vx < 0 ? -1 : 1;
    for (let r = 0; r < rows; r++) {
      const q = pointAt(track, b.s0 + ((b.s1 - b.s0) * (r + 0.5)) / rows);
      band.x[r] = q.x * ZOOM;
      band.y[r] = q.y * ZOOM;
      band.nx[r] = -Math.sin(q.h) * ZOOM;
      band.ny[r] = Math.cos(q.h) * ZOOM;
      // The arrow points the way the belt runs: across the road, to the right of travel or to the left.
      const a = Math.atan2(Math.cos(q.h) * way, -Math.sin(q.h) * way);
      band.head[r] = Math.round((a / (Math.PI * 2)) * ARROW_HEADINGS + ARROW_HEADINGS) % ARROW_HEADINGS;
    }
    const mid = pointAt(track, (b.s0 + b.s1) / 2), lat = (b.lat0 + b.lat1) / 2;
    band.cx = (mid.x - Math.sin(mid.h) * lat) * ZOOM;
    band.cy = (mid.y + Math.cos(mid.h) * lat) * ZOOM;
    band.reach = (Math.hypot(b.s1 - b.s0, b.lat1 - b.lat0) / 2) * ZOOM + ARROW;
    set.bands.push(band);
  }
  return set;
}

/** Does everything that moves on a track have room on the sheet, and how much of it do its own sprites take (sheet pixels, of `room`)? */
export function obstacleFit(track: Track): { fits: boolean; used: number; room: number } {
  const m = moversOf(track);
  return { fits: m ? m.fits : true, used: m ? m.used : 0, room: OBST_W * (OBST_H - TOP) };
}

// ---- the sheet -------------------------------------------------------------------------

// The sheet as indices (0 = nothing, 1..32 = palette entry + 1, FX_SHADOW = cast shadow), its
// pixels on their way to the canvas, and whose sprites it holds. Made when first needed.
let sheet: Uint8Array | null = null;
let image: ImageData | null = null;
let words: Uint32Array | null = null;
let palette: Uint32Array | null = null;
let holds: Movers | null = null;
const cell = new Uint8Array(BARREL * BARREL); // a barrel frame being made: 1 = the barrel

/** The belt's arrow at every heading: a chevron pointing along it. */
function paintArrows(out: Uint8Array): void {
  for (let k = 0; k < ARROW_HEADINGS; k++) {
    const a = (k * Math.PI * 2) / ARROW_HEADINGS, cos = Math.cos(a), sin = Math.sin(a);
    const ox = (k % ARROW_COLS) * ARROW, oy = Math.floor(k / ARROW_COLS) * ARROW;
    for (let y = 0; y < ARROW; y++) {
      for (let x = 0; x < ARROW; x++) {
        const dx = x + 0.5 - ARROW / 2, dy = y + 0.5 - ARROW / 2;
        const p = dx * cos + dy * sin, q = Math.abs(dy * cos - dx * sin); // along the arrow, across it
        const at = p - (1.7 - q); // from the middle of the chevron's stroke
        if (q <= 4 && at >= -1.15 && at <= 1.15) out[(oy + y) * OBST_W + ox + x] = at > 0.3 ? IDX.bone2 : IDX.bone1;
      }
    }
  }
}

/** The ROLL frames of a barrel whose axis lies along heading h, side by side from (ax, ay). */
function paintBarrels(out: Uint8Array, ax: number, ay: number, h: number): void {
  const cos = Math.cos(h), sin = Math.sin(h);
  // How far the barrel's right side (across the road, to the right of travel) is turned to the sun, which stands top-left.
  const light = (sin - cos) / Math.SQRT2;
  const wrap = (a: number) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
  for (let f = 0; f < ROLL; f++) {
    const mark = (f / ROLL) * Math.PI * 2; // where the label is, round the barrel (0 = on top)
    const at = (x: number, y: number) => (ay + y) * OBST_W + ax + f * BARREL + x;
    cell.fill(0);
    for (let y = 0; y < BARREL; y++) {
      for (let x = 0; x < BARREL; x++) {
        const dx = x + 0.5 - BARREL / 2, dy = y + 0.5 - BARREL / 2;
        const u = (dx * cos + dy * sin) / ZOOM, v = (dy * cos - dx * sin) / ZOOM; // along its axis, across (world units)
        const au = Math.abs(u), av = Math.abs(v);
        if (au > BARREL_HALF || av > BARREL_R) continue;
        // Its corners are round.
        if (au > BARREL_HALF - 2 && av > BARREL_R - 2 && (au - BARREL_HALF + 2) ** 2 + (av - BARREL_R + 2) ** 2 > 4) continue;
        cell[y * BARREL + x] = 1;
        const nv = v / BARREL_R; // -1..1 across the barrel
        const sun = nv * light;
        const tone = Math.abs(nv) > 0.86 ? 0 : sun < -0.3 ? 1 : sun > 0.3 ? 3 : 2; // the far edge, shade, body, lit
        const round = Math.asin(nv); // this spot's place round the barrel
        let tones: readonly PaletteName[];
        if (au > BARREL_HALF - 1.3) tones = ["soot2", "soot3", "soot3", "dirt0"]; // the rims
        else if (au > 3.3 && au < 4.8) tones = ["steel0", "steel1", "steel2", "steel3"]; // the hoops
        else if (au < 2.9 && Math.abs(wrap(round - mark)) < 0.62) tones = ["bone0", "bone0", "bone1", "bone2"]; // the label
        else if (Math.abs(wrap(round - mark - Math.PI)) < 0.24) tones = ["soot3", "rust0", "rust0", "rust1"]; // the seam, half a turn on
        else tones = ["rust0", "rust1", "rust2", "rust3"];
        out[at(x, y)] = IDX[tones[tone]];
      }
    }
    const body = (x: number, y: number) => x >= 0 && y >= 0 && x < BARREL && y < BARREL && cell[y * BARREL + x] === 1;
    for (let y = 0; y < BARREL; y++) {
      for (let x = 0; x < BARREL; x++) {
        if (body(x, y)) continue;
        // A dark outline all round it, as a car's; its shadow down-right of that.
        if (body(x - 1, y) || body(x + 1, y) || body(x, y - 1) || body(x, y + 1)) out[at(x, y)] = IDX.soot1;
        else if (body(x - 2, y - 3) || body(x - 3, y - 3) || body(x - 2, y - 4)) out[at(x, y)] = FX_SHADOW;
        else out[at(x, y)] = 0;
      }
    }
  }
}

/** A press's slab from (ax, ay) and its silhouette right of it, w x h each, at heading h and `width` across the road. */
function paintSlab(out: Uint8Array, ax: number, ay: number, w: number, h: number, heading: number, width: number): void {
  const cos = Math.cos(heading), sin = Math.sin(heading);
  // How far inside the slab the middle of pixel (x, y) is (world units; below 0 = outside); `face` gets the face it is nearest.
  let face = 0, uu = 0, vv = 0;
  const inside = (x: number, y: number): number => {
    const dx = x + 0.5 - w / 2, dy = y + 0.5 - h / 2;
    uu = (dx * cos + dy * sin) / ZOOM;
    vv = (dy * cos - dx * sin) / ZOOM;
    const es = PRESS_DEPTH / 2 - Math.abs(uu), el = width / 2 - Math.abs(vv);
    face = es < el ? (uu < 0 ? 0 : 1) : vv < 0 ? 2 : 3;
    return es < el ? es : el;
  };
  // Does a face look up-left, to the sun? Its outward normal: -+ the road's direction, -+ across it.
  const lit = [-cos - sin < 0, cos + sin < 0, sin - cos < 0, cos - sin < 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (ay + y) * OBST_W + ax + x;
      const e = inside(x, y);
      let c = 0;
      if (e >= 0) {
        if (e < 1.3) c = IDX.soot1; // its outline
        else if (e < 3.7) c = lit[face] ? IDX.steel3 : IDX.steel0; // its edge in the sun and away from it
        else c = Math.floor((uu + vv + 4000) / 5.5) & 1 ? IDX.haz1 : IDX.soot2; // its top: hazard stripes all over, so it is not taken for its bed
      } else if (x >= 3 && y >= 4 && inside(x - 3, y - 4) >= 0) c = FX_SHADOW; // the shadow it casts when down
      out[o] = c;
      out[o + w] = inside(x, y) >= 0 ? IDX.soot0 : 0; // the silhouette
    }
  }
}

/** The sheet's canvas holding the sprites of `set`: painted now if it held another track's. */
function lease(set: Movers): HTMLCanvasElement {
  const made = obstacleSheet();
  if (holds === set) return made.canvas;
  let whole = false;
  if (!sheet) {
    sheet = new Uint8Array(OBST_W * OBST_H);
    palette = fxPalette();
    if (typeof ImageData !== "undefined") {
      image = new ImageData(OBST_W, OBST_H);
      words = new Uint32Array(image.data.buffer);
    }
    paintArrows(sheet);
    whole = true;
  }
  sheet.fill(0, TOP * OBST_W);
  for (const r of set.rows) if (r.ax >= 0) paintBarrels(sheet, r.ax, r.ay, r.b.h);
  for (const g of set.gates) if (g.ax >= 0) paintSlab(sheet, g.ax, g.ay, g.w, g.h, g.p.h, g.p.lat1 - g.p.lat0);
  if (words && image && palette) {
    for (let i = whole ? 0 : TOP * OBST_W; i < sheet.length; i++) words[i] = palette[sheet[i]];
    if (whole) made.ctx.putImageData(image, 0, 0);
    else made.ctx.putImageData(image, 0, 0, 0, TOP, OBST_W, OBST_H - TOP);
  }
  holds = set;
  return made.canvas;
}

/** For checks and contact sheets: the sheet as indices (0 = nothing, 1..32 = palette entry + 1, FX_SHADOW = cast shadow) with a track's sprites on it, OBST_W x OBST_H; null when nothing moves on the track. */
export function obstacleIndexSheet(track: Track): Uint8Array | null {
  const set = moversOf(track);
  if (!set) return null;
  lease(set);
  return sheet;
}

// ---- drawing ---------------------------------------------------------------------------

export class Obstacles {
  private readonly set: Movers | null;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
  ) {
    this.set = moversOf(track);
    if (this.set) lease(this.set); // painted with the Renderer, not in its first frame
  }

  /**
   * What lies on the road at race tick `tick` (a whole number), the view's top-left at view pixel
   * (ox, oy) of the track's plane: the belts' arrows, the presses' shadows and lamps, the barrels.
   */
  under(tick: number, ox: number, oy: number): void {
    const set = this.set;
    if (!set) return;
    const ctx = this.ctx, sheet = lease(set);
    const bands = set.bands;
    for (let q = 0; q < bands.length; q++) {
      const b = bands[q];
      if (b.cx - ox < -b.reach || b.cy - oy < -b.reach || b.cx - ox > VIEW_W + b.reach || b.cy - oy > VIEW_H + b.reach) continue;
      const cycle = b.count * ARROW_PITCH;
      // How far the belt has run, within a cycle of its arrows (the belt's speed is per second, 60 ticks).
      let run = ((tick * b.vx) / 60) % cycle;
      if (run < 0) run += cycle;
      for (let r = 0; r < b.rows; r++) {
        const head = b.head[r];
        const sx = (head % ARROW_COLS) * ARROW, sy = ((head / ARROW_COLS) | 0) * ARROW;
        const from = r & 1 ? run + ARROW_PITCH / 2 : run;
        for (let j = 0; j < b.count; j++) {
          let at = from + j * ARROW_PITCH;
          if (at >= cycle) at -= cycle;
          const lat = b.l0 + at;
          const x = Math.round(b.x[r] + b.nx[r] * lat) - ox, y = Math.round(b.y[r] + b.ny[r] * lat) - oy;
          if (x < -ARROW || y < -ARROW || x > VIEW_W + ARROW || y > VIEW_H + ARROW) continue;
          ctx.drawImage(sheet, sx, sy, ARROW, ARROW, x - ARROW / 2, y - ARROW / 2, ARROW, ARROW);
        }
      }
    }
    const gates = set.gates;
    for (let q = 0; q < gates.length; q++) {
      const g = gates[q];
      const x = g.x - ox, y = g.y - oy;
      if (g.ax < 0 || x < -g.w - OFF || y < -g.h - OFF || x > VIEW_W + g.w + OFF || y > VIEW_H + g.h + OFF) continue;
      const p = g.p;
      const state = pressState(p, tick);
      // Where in its cycle (as pressState counts it): the slab's height in steps of a thirtieth
      // of the way up (0 = down, -1 = out of sight), and how dark its shadow is.
      const phase = ((tick % p.period) + p.period) % p.period;
      let high = -1, shade = 0, lamp = false;
      if (state === PRESS_DOWN) lamp = true;
      else if (state === PRESS_WARNING) {
        const t = phase - (p.period - p.down - PRESS_WARN_TICKS);
        high = PRESS_WARN_TICKS - 1 - t;
        shade = t < 7 ? 0 : t < 14 ? 1 : t < 22 ? 2 : 3;
        lamp = (t & 4) === 0;
      } else if (phase < LIFT) {
        high = (phase + 1) * 3;
        shade = phase < 3 ? 2 : phase < 6 ? 1 : 0;
      }
      if (high >= 0) {
        // A store per tone: each is a constant then (picked first and stored once, the fraction would be boxed).
        if (shade === 0) ctx.globalAlpha = 0.2;
        else if (shade === 1) ctx.globalAlpha = 0.27;
        else if (shade === 2) ctx.globalAlpha = 0.34;
        else ctx.globalAlpha = 0.42;
        ctx.drawImage(sheet, g.ax + g.w, g.ay, g.w, g.h, x - (g.w >> 1) + 2 + (((high * FAR_X + 15) / 30) | 0), y - (g.h >> 1) + 3 + (((high * FAR_Y + 15) / 30) | 0), g.w, g.h);
        ctx.globalAlpha = 1;
      }
      if (lamp) {
        ctx.fillStyle = P.red;
        const l = g.lamps;
        for (let k = 0; k < 8; k += 2) ctx.fillRect(x + l[k], y + l[k + 1], 3, 3);
      }
    }
    const rows = set.rows;
    for (let q = 0; q < rows.length; q++) {
      const r = rows[q];
      if (r.ax < 0 || r.x - ox < -r.reach || r.y - oy < -r.reach || r.x - ox > VIEW_W + r.reach || r.y - oy > VIEW_H + r.reach) continue;
      const b = r.b;
      for (let k = 0; k < b.n; k++) {
        const lat = barrelLat(b, k, tick);
        if (lat !== lat) continue; // in the gutter, on its way back
        const x = Math.round(r.x + r.nx * lat) - ox, y = Math.round(r.y + r.ny * lat) - oy;
        if (x < -BARREL || y < -BARREL || x > VIEW_W + BARREL || y > VIEW_H + BARREL) continue;
        // The frame of its turn: by how far across the road it is, so it rolls the way it goes.
        ctx.drawImage(sheet, r.ax + (Math.floor(lat * ROLL_K) & (ROLL - 1)) * BARREL, r.ay, BARREL, BARREL, x - BARREL / 2, y - BARREL / 2, BARREL, BARREL);
      }
    }
  }

  /** What stands over the cars on the ground at race tick `tick`: the slabs of the presses that are down. */
  over(tick: number, ox: number, oy: number): void {
    const set = this.set;
    if (!set || !set.gates.length) return;
    const ctx = this.ctx, sheet = lease(set);
    const gates = set.gates;
    for (let q = 0; q < gates.length; q++) {
      const g = gates[q];
      const x = g.x - ox, y = g.y - oy;
      if (g.ax < 0 || x < -g.w || y < -g.h || x > VIEW_W + g.w || y > VIEW_H + g.h) continue;
      if (pressState(g.p, tick) === PRESS_DOWN) ctx.drawImage(sheet, g.ax, g.ay, g.w, g.h, x - (g.w >> 1), y - (g.h >> 1), g.w, g.h);
    }
  }
}
