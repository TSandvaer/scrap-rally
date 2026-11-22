// The two flag marshals at the start/finish line (MARSHALS-1): two people of the race company,
// one just outside each barrier at s = 0, facing the track. Their flags show which way the race
// goes and where it stands.
//
// Where they stand comes from the track's data alone: the centreline's point and heading at
// s = 0, and from there the per-sample wall on each side (Track.wallL[0], wallR[0]) plus the
// barrier (BARRIER, as gfx/world.ts draws it) plus STAND. A side on which that spot is not
// clear of every road there is (the track where it comes by again, a branch's road) has no
// marshal. What gfx/world.ts scatters outside the walls (its props) is not in the track's
// data: tools/debug/marshal-sheet.ts --check holds every track and theme to "no figure on a
// prop, a post, a barrier or the road".
//
// How they read, seen from above as everything is: orange shoulders round a white cap, its peak
// toward the track; one arm holds the flag out. The uniform is the same on every track and in
// every theme (the global 32 colours, as the cars' and the effects'); none of its tones is one
// of the six car colours.
// - No race (the lobby, the menu's tour; a frame without WorldFx.race): at ease, the flag
//   furled and lowered, away from the track.
// - The countdown: the company's pennant held up, still, out over the barrier toward the track.
// - GO and the race: the pennant waved across the race direction (the track's tangent at the
//   line). It is pointed, and its chevrons point the same way: the way the race goes. Fast for
//   GO_MS from GO, then steady.
// - The last lap, from when the leader starts it until the winner is in: another flag, yellow
//   with one dark bar (one lap to go), waved in double time.
// - The finish: the chequered flag, fast for BURST_MS for the winner and again for every car
//   that comes in after, steady in between; slow once the race is over.
//
// Everything is a sprite, drawn in view space at whole pixels on the world already drawn and
// under the cars. One small sheet (sprites.ts marshalSheet: MARSHAL_W x MARSHAL_H) holds the
// pictures of one track at a time, because they are painted at the heading of that track's
// line: the two figures, and the flag (with the arm that holds it) at WAVE angles for each of
// its three kinds, held up, and furled. The two marshals are each other's mirror image across
// the road, so they share the flag's pictures: one waves toward the track while the other does.
// Each picture is worked out pixel centre by pixel centre in the figure's own frame (no blend,
// no anti-aliasing), then lit as the cars are: the sun top-left, a dark outline, a cast shadow.
// The sheet is worked out with the Renderer, put on its canvas in the first frame that draws a
// marshal, and painted again when a Renderer of a track with another heading draws. A frame
// allocates nothing.

import type { RaceView } from "../render";
import { pointAt, type Track } from "../../shared/track";
import { PALETTE, type PaletteName } from "./palette";
import { fxPalette, FX_SHADOW, MARSHAL_H, MARSHAL_W, marshalSheet, spritesFor } from "./sprites";
import { VIEW_H, VIEW_W, ZOOM } from "./world";

// ---- where they stand ---------------------------------------------------------------------

/** The barrier stands this far outside the wall line (gfx/world.ts BARRIER), world units. */
const BARRIER = 7;
/** A marshal's middle is this far outside the barrier: far enough that a flag waved or held toward the track ends at the wall line, over the barrier and off the road. */
export const STAND = 11;
/** The spot is clear of a road when it is this far outside that road's barrier: the figure's reach. */
const CLEAR = 6;

/** Is (x, y) outside every barrier of a road, with CLEAR to spare? Every segment is asked: the nearest one alone could have the narrower wall. */
function clearOf(road: Track, x: number, y: number): boolean {
  const { pts, wallL, wallR } = road;
  const n = pts.length, segs = road.roadNo > 0 ? n - 1 : n;
  for (let i = 0; i < segs; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    const a = pts[i], b = pts[j];
    const ex = b.x - a.x, ey = b.y - a.y;
    let t = ((x - a.x) * ex + (y - a.y) * ey) / (ex * ex + ey * ey || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - a.x - ex * t, dy = y - a.y - ey * t;
    const wall = Math.max(wallL[i], wallL[j], wallR[i], wallR[j]) + BARRIER + CLEAR;
    if (dx * dx + dy * dy < wall * wall) return false;
  }
  return true;
}

/**
 * Where the marshal of a side (-1 = left of travel, +1 = right) stands, world units, or null
 * when that spot is not clear of every road: beside the line (s = 0), STAND outside the barrier
 * of the per-sample wall there.
 */
export function marshalSpot(track: Track, side: number): { x: number; y: number } | null {
  const p = pointAt(track, 0);
  const lat = side * ((side < 0 ? track.wallL[0] : track.wallR[0]) + BARRIER + STAND);
  const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
  if (!clearOf(track, x, y)) return null;
  for (const b of track.branches) if (!clearOf(b.road, x, y)) return null;
  return { x, y };
}

// ---- the sheet ----------------------------------------------------------------------------

/** A picture's cell on the sheet. A picture lies in it wherever it fits: MARSHAL_AT says where the cell lies from the picture's anchor. */
export const MCELL = 22;
const COLS = MARSHAL_W / MCELL;
/** The flag at this many angles across the race direction: a wave runs through them and back. */
export const WAVE = 4;
// The cells. A waved flag's WAVE pictures run from the left of travel to the right.
export const M_GO = 0; // the company's pennant
export const M_LAST = WAVE; // the last lap's flag
export const M_CHEQ = 2 * WAVE; // the chequered flag
export const M_HELD = 3 * WAVE; // the pennant held up: toward the right of travel; + 1: toward the left
export const M_EASE = M_HELD + 2; // the flag furled and lowered: toward the right of travel; + 1: toward the left
export const M_BODY = M_EASE + 2; // the marshal left of the road; + 1: right of it
export const M_CELLS = M_BODY + 2;

/** A wave's angles from the race direction, radians (+ = toward the right of travel). */
const SWING = [-0.66, -0.23, 0.23, 0.66];
/** The shoulder the flag's arm turns on, in the figure's frame (u along the race direction, w toward the track; view pixels from its middle). */
const SHOULDER_U = 2.7, SHOULDER_W = 0.3;

// What a pixel of a picture is made of.
const NONE = 0, OUTLINE = 1, VEST = 2, CAP = 3, PEAK = 4, SLEEVE = 5, HAND = 6, STICK = 7, FIELD = 8, MARK = 9, YELLOW = 10, BAR = 11, CHECK_A = 12, CHECK_B = 13, ROLL = 14, TIE = 15;
const CLOTH = FIELD; // from here on: cloth, lit along its top-left edge and shaded along the other
// A material's three tones: where the sun catches it, its own, and away from the sun.
const TONES: readonly (readonly [PaletteName, PaletteName, PaletteName])[] = [
  ["soot1", "soot1", "soot1"], // NONE (not drawn)
  ["soot1", "soot1", "soot1"], // OUTLINE
  ["haz2", "blast", "rust2"], // VEST: the company's orange
  ["bone2", "bone2", "bone0"], // CAP
  ["steel0", "steel0", "steel0"], // PEAK
  ["haz2", "blast", "rust2"], // SLEEVE
  ["bone1", "bone1", "bone0"], // HAND
  ["steel3", "steel3", "steel2"], // STICK
  ["bone2", "bone2", "bone1"], // FIELD: the pennant
  ["rust3", "rust2", "rust1"], // MARK: its chevrons
  ["haz2", "haz1", "haz0"], // YELLOW: the last lap's flag
  ["soot2", "soot2", "soot1"], // BAR
  ["bone2", "bone2", "bone1"], // CHECK_A
  ["soot2", "soot2", "soot1"], // CHECK_B
  ["bone1", "bone1", "bone0"], // ROLL: the pennant furled
  ["rust2", "rust2", "rust1"], // TIE
];
const IDX = Object.fromEntries(PALETTE.map((e, i) => [e.name, i + 1])) as Record<PaletteName, number>;
const TONE = Uint8Array.from(TONES.flat(), (name) => IDX[name]);

// The flag, in its own frame: `a` along it from the shoulder, `b` across (view pixels).
const ARM = 3.1; // the sleeve ends, the hand begins
const GRIP = 4.4; // the hand ends: the stick and the cloth lie beyond, measured from here
const HOIST = 1; // the cloth begins this far up the stick
const PENNANT = 10.6; // the pennant's length from the grip ...
const POINT = 4.4; // ... of which its point
const FLAG = 9.4; // the last lap's flag: its length, and half its width
const FLAG_HALF = 3.1;
const CHECK = 2.6; // a chequer: the chequered flag is 4 x 3 of them
const RAISED = 0.7; // a flag held up is seen from above: this much of its length
const FURLED = 7.5;

/** What the figure is made of at (u, w) of its own frame: seen from above, a cap between two shoulders. */
function figure(u: number, w: number): number {
  if (u * u + (w - 0.3) * (w - 0.3) <= 2.05 * 2.05) return CAP;
  if (w > 1.8 && w <= 3.5 && u >= -1.1 && u <= 1.1) return PEAK;
  const x = u / 4.8, y = (w + 0.1) / 2.7;
  return x * x + y * y <= 1 ? VEST : NONE;
}

/**
 * What the flag is made of at (a, b) of its frame. `kind`: M_GO, M_LAST, M_CHEQ or M_EASE (the
 * furled one); `ph`: where the cloth's ripple stands in this picture; `seen`: 1, or RAISED.
 */
function flag(kind: number, a: number, b: number, ph: number, seen: number): number {
  if (a < -0.7) return NONE;
  if (a <= ARM) return b >= -1 && b <= 1 ? SLEEVE : NONE;
  if (a <= GRIP) return b >= -1 && b <= 1 ? HAND : NONE;
  const q = (a - GRIP) / seen;
  if (kind === M_EASE) {
    if (q > FURLED || b < -1.1 || b > 1.1) return NONE;
    return (q > 2.2 && q <= 3.2) || (q > 5 && q <= 6) ? TIE : ROLL;
  }
  if (q > HOIST) {
    // The cloth snakes a little, more toward its fly end.
    const c = b - 0.55 * Math.sin(q * 0.8 + ph) * Math.min(1, q / 6);
    const side = c < 0 ? -c : c;
    if (kind === M_GO) {
      const half = 3.3 * Math.min(1, (PENNANT - q) / POINT);
      if (q <= PENNANT && side <= half) {
        const d = (q + side - 1.6) % 4.2;
        return (d < 0 ? d + 4.2 : d) < 1.9 ? MARK : FIELD;
      }
    } else if (kind === M_LAST) {
      if (side <= FLAG_HALF && q <= FLAG + 0.3 * Math.sin(c * 1.2 + ph)) return q > 3.9 && q <= 6.5 ? BAR : YELLOW;
    } else if (b >= -1.5 * CHECK && b <= 1.5 * CHECK && q <= HOIST + 4 * CHECK) {
      // The chequers keep their lines: no ripple, the cloth's edges straight.
      return (Math.floor((q - HOIST) / CHECK) + Math.floor((b + 1.5 * CHECK) / CHECK)) & 1 ? CHECK_B : CHECK_A;
    }
  }
  return q <= 1.3 && b >= -0.55 && b <= 0.55 ? STICK : NONE;
}

// A picture in the making: GRID x GRID pixels, its anchor (the figure's middle, the flag's
// shoulder) on the corner between the four pixels in the middle.
const GRID = 64, MID = GRID / 2;
const mat = new Uint8Array(GRID * GRID);
const pic = new Uint8Array(GRID * GRID);

/**
 * Light the picture in `mat`, outline it and cast its shadow (dx, dy) away: palette entry + 1,
 * or FX_SHADOW, into `pic`. `from`: the least material that casts one (a flag's arm casts none:
 * it lies over the figure's shoulder, and its shadow would fall on the cap).
 */
function finish(dx: number, dy: number, tall: boolean, from: number): void {
  pic.fill(0);
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const o = y * GRID + x, m = mat[o];
      const left = mat[o - 1] !== NONE, right = mat[o + 1] !== NONE, above = mat[o - GRID] !== NONE, below = mat[o + GRID] !== NONE;
      if (m === NONE) {
        if (left || right || above || below) pic[o] = TONE[OUTLINE * 3];
        continue;
      }
      // Cloth is lit along its whole top-left edge; the rest (small, round) only on its corner.
      const lit = m >= CLOTH ? !left || !above : !left && !above;
      // The cap stands above the shoulders: the vest down-right of it lies in its shade.
      const shade = m >= CLOTH ? !right || !below : (!right && !below) || (m === VEST && (mat[o - GRID - 1] === CAP || mat[o - 1] === CAP || mat[o - GRID] === CAP));
      pic[o] = TONE[m * 3 + (lit ? 0 : shade ? 2 : 1)];
    }
  }
  // The shadow: the outlined shape again, away down-right, where nothing of the picture is.
  // A standing figure's is longer than it is wide: twice, the second half as far.
  for (let pass = tall ? 0 : 1; pass < 2; pass++) {
    const sx = pass ? dx : dx >> 1, sy = pass ? dy : dy >> 1;
    for (let y = 1; y < GRID - 1 - sy; y++) {
      for (let x = 1; x < GRID - 1 - sx; x++) {
        const o = y * GRID + x, v = pic[o];
        if (!v || v === FX_SHADOW || pic[o + sy * GRID + sx]) continue;
        // A pixel of the outline casts with the part it runs round.
        if (mat[o] >= from || (mat[o] === NONE && (mat[o - 1] >= from || mat[o + 1] >= from || mat[o - GRID] >= from || mat[o + GRID] >= from))) pic[o + sy * GRID + sx] = FX_SHADOW;
      }
    }
  }
}

/** Pictures that did not fit their cell the last time a sheet was made (0: every one did), and the widest. For checks. */
export const marshalFit = { clipped: 0, widest: 0 };

/** Put the picture in `pic` into cell `k` of the sheet, and note where the cell lies from the picture's anchor. */
function place(sheet: Uint8Array, at: Int8Array, k: number): void {
  let x0 = GRID, y0 = GRID, x1 = -1, y1 = -1;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (!pic[y * GRID + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) x0 = y0 = x1 = y1 = MID;
  const wide = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  if (wide > marshalFit.widest) marshalFit.widest = wide;
  if (wide > MCELL) marshalFit.clipped++;
  const ox = (k % COLS) * MCELL, oy = Math.floor(k / COLS) * MCELL;
  for (let y = 0; y < MCELL; y++) {
    for (let x = 0; x < MCELL; x++) {
      const gx = x0 + x, gy = y0 + y;
      sheet[(oy + y) * MARSHAL_W + ox + x] = gx < GRID && gy < GRID ? pic[gy * GRID + gx] : 0;
    }
  }
  at[k * 2] = x0 - MID;
  at[k * 2 + 1] = y0 - MID;
}

/** One picture of the flag into cell `k`: its kind, the way it points, its ripple, how much of its length is seen, its shadow's way. */
function flagInto(sheet: Uint8Array, at: Int8Array, k: number, kind: number, angle: number, ph: number, seen: number, dx: number, dy: number): void {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const px = x + 0.5 - MID, py = y + 0.5 - MID;
      mat[y * GRID + x] = flag(kind, px * cos + py * sin, py * cos - px * sin, ph, seen);
    }
  }
  finish(dx, dy, false, STICK);
  place(sheet, at, k);
}

/**
 * The sheet for a track whose line has the heading `h`, as indices (0 = nothing, 1.. = palette
 * entry + 1, FX_SHADOW = cast shadow: the effect sheet's, sprites.ts fxPalette), MARSHAL_W x
 * MARSHAL_H. `at`: per cell, where its top-left pixel lies from the picture's anchor (x, y).
 */
export function marshalIndexSheet(h: number, sheet: Uint8Array = new Uint8Array(MARSHAL_W * MARSHAL_H), at: Int8Array = new Int8Array(M_CELLS * 2)): Uint8Array {
  marshalFit.clipped = marshalFit.widest = 0;
  for (let i = 0; i < WAVE; i++) {
    flagInto(sheet, at, M_GO + i, M_GO, h + SWING[i], i * 1.7, 1, 2, 3);
    flagInto(sheet, at, M_LAST + i, M_LAST, h + SWING[i], i * 1.7, 1, 2, 3);
    flagInto(sheet, at, M_CHEQ + i, M_CHEQ, h + SWING[i], i * 1.7, 1, 2, 3);
  }
  for (let i = 0; i < 2; i++) {
    const across = h + (i ? -Math.PI / 2 : Math.PI / 2);
    flagInto(sheet, at, M_HELD + i, M_GO, across, 0.6, RAISED, 3, 5); // held high: its shadow lies further off
    flagInto(sheet, at, M_EASE + i, M_EASE, across, 0, 1, 1, 1); // lowered: its shadow right under it
  }
  // The figures: u along the race direction, w toward the track, which is to the right of
  // travel for the marshal on the left and to the left for the one on the right.
  const cos = Math.cos(h), sin = Math.sin(h);
  for (let k = 0; k < 2; k++) {
    const toTrack = k ? -1 : 1;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const px = x + 0.5 - MID, py = y + 0.5 - MID;
        mat[y * GRID + x] = figure(px * cos + py * sin, (py * cos - px * sin) * toTrack);
      }
    }
    finish(2, 3, true, VEST);
    place(sheet, at, M_BODY + k);
  }
  return sheet;
}

// The sheet as indices and where its cells lie: those of one heading (`baked`). Its canvas holds
// the pictures of `painted`.
let baked = NaN;
let painted = NaN;
const index = new Uint8Array(MARSHAL_W * MARSHAL_H);
export const MARSHAL_AT = new Int8Array(M_CELLS * 2);
let image: ImageData | null = null;
let words: Uint32Array | null = null;
let colours: Uint32Array | null = null;

/** Work out the sheet of heading `h`, unless it is the one worked out last. */
function bake(h: number): void {
  if (h === baked) return;
  baked = h;
  painted = NaN;
  marshalIndexSheet(h, index, MARSHAL_AT);
}

/**
 * The sheet's canvas with the pictures of heading `h`: put on it now if it held another's. The
 * canvas is not made before a frame draws from it, as every sprite sheet's: the view that is
 * drawn on when the first sheet is made decides where they all live (sprites.ts spritesFor), and
 * a page builds a Renderer on a canvas it may never draw on (main.ts does, before the benchmark
 * takes over).
 */
function lease(h: number): HTMLCanvasElement {
  const made = marshalSheet();
  bake(h);
  if (h !== painted) {
    painted = h;
    if (typeof ImageData !== "undefined") {
      if (!image || !words) {
        image = new ImageData(MARSHAL_W, MARSHAL_H);
        words = new Uint32Array(image.data.buffer);
      }
      const pal = colours ?? (colours = fxPalette());
      for (let i = 0; i < index.length; i++) words[i] = pal[index[i]];
      made.ctx.putImageData(image, 0, 0);
    }
  }
  return made.canvas;
}

// ---- the frame ----------------------------------------------------------------------------

// RaceView.phase.
const COUNTDOWN = 1, RACING = 2, OVER = 3;
/** From GO the pennant is waved fast for this long (ms); the last lap's flag does not show before. */
const GO_MS = 3000;
/** A car that finishes gets the chequered flag fast for this long (ms). */
const BURST_MS = 2500;
/** A wave's pace: ms a picture. */
const FAST = 70, STEADY = 120, SLOW = 170;
/** A wave runs through the flag's WAVE pictures and back. */
const SWEEP = Uint8Array.of(0, 1, 2, 3, 2, 1);
const NEVER = -1e12;

/** Draws nothing when off: tools/debug/marshal-sheet.ts compares a frame with and without. */
export const marshalSwitch = { on: true };

export class Marshals {
  /** How many stand at the line: 2, fewer where a spot is not clear. */
  readonly count: number;
  /** Per marshal: the pixel of its middle in the track's plane (x, y), the corner the flag's shoulder is on from there (x, y), and its side (0 = left of the road, 1 = right). */
  readonly spots = new Int32Array(10);
  private readonly heading: number;
  // What the race was at in the frame before, and when it changed (ms): GO, the last car in.
  private phase = -1;
  private finished = -1;
  private readonly since = new Float64Array(2).fill(NEVER);

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
  ) {
    spritesFor(ctx);
    const p = pointAt(track, 0);
    const cos = Math.cos(p.h), sin = Math.sin(p.h);
    this.heading = p.h;
    let n = 0;
    for (let k = 0; k < 2; k++) {
      const at = marshalSpot(track, k ? 1 : -1);
      if (!at) continue;
      // The shoulder: SHOULDER_U along the race direction, SHOULDER_W toward the track.
      const w = k ? -SHOULDER_W : SHOULDER_W;
      this.spots[n * 5] = Math.round(at.x * ZOOM);
      this.spots[n * 5 + 1] = Math.round(at.y * ZOOM);
      this.spots[n * 5 + 2] = Math.round(SHOULDER_U * cos - w * sin);
      this.spots[n * 5 + 3] = Math.round(SHOULDER_U * sin + w * cos);
      this.spots[n * 5 + 4] = k;
      n++;
    }
    this.count = n;
    if (n) bake(this.heading); // worked out with the Renderer; its first frame only puts it on the canvas
  }

  /**
   * Draw the marshals on the world already drawn, the view's top-left at view pixel (ox, oy) of
   * the track's plane. `now` (ms) drives the waves; `race`: where the race stands (absent = no
   * race: at ease).
   */
  draw(ox: number, oy: number, now: number, race: RaceView | undefined): void {
    const phase = race ? race.phase : 0, finished = race ? race.finished : 0;
    // What changed since the frame before. A first frame in the middle of a race is no GO, and
    // the cars that were in before it are no news.
    if (phase !== this.phase) {
      if (phase === RACING && this.phase === COUNTDOWN) this.since[0] = now;
      this.phase = phase;
    }
    if (finished !== this.finished) {
      if (finished > this.finished && this.finished >= 0) this.since[1] = now;
      this.finished = finished;
    }
    const n = this.count;
    if (!n || !marshalSwitch.on) return;
    // Which flag, and how fast: 0 = held up, -1 = at ease, else ms a picture of the wave.
    let kind = M_GO, pace = -1;
    if (phase === COUNTDOWN) pace = 0;
    else if (phase === RACING || phase === OVER) {
      const go = now - this.since[0];
      if (finished > 0) {
        kind = M_CHEQ;
        pace = now - this.since[1] < BURST_MS ? FAST : phase === OVER ? SLOW : STEADY;
      } else if (phase === RACING) {
        if (race!.lastLap && go >= GO_MS) {
          kind = M_LAST;
          pace = FAST;
        } else pace = go < GO_MS ? FAST : STEADY;
      }
    }
    const step = pace > 0 ? SWEEP[Math.floor(now / pace) % SWEEP.length] : 0;
    const ctx = this.ctx, spots = this.spots, at = MARSHAL_AT;
    const sheet = lease(this.heading);
    for (let i = 0; i < n; i++) {
      const x = spots[i * 5] - ox, y = spots[i * 5 + 1] - oy, right = spots[i * 5 + 4];
      // Off screen with everything it holds (a flag reaches MCELL from its shoulder at most)?
      if (x < -2 * MCELL || y < -2 * MCELL || x > VIEW_W + 2 * MCELL || y > VIEW_H + 2 * MCELL) continue;
      const body = M_BODY + right;
      ctx.drawImage(sheet, (body % COLS) * MCELL, ((body / COLS) | 0) * MCELL, MCELL, MCELL, x + at[body * 2], y + at[body * 2 + 1], MCELL, MCELL);
      // The flag, its arm over the shoulder. Toward the track is toward the right of travel for
      // the marshal on the left: the two wave as each other's mirror image.
      const f = pace > 0 ? kind + (right ? WAVE - 1 - step : step) : pace === 0 ? M_HELD + right : M_EASE + 1 - right;
      ctx.drawImage(sheet, (f % COLS) * MCELL, ((f / COLS) | 0) * MCELL, MCELL, MCELL, x + spots[i * 5 + 2] + at[f * 2], y + spots[i * 5 + 3] + at[f * 2 + 1], MCELL, MCELL);
    }
  }
}
