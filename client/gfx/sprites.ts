// Pre-rendered sprites of the cars and the effects (PLAN-GFX.md, items B1-B7).
//
// Cars: one sheet of HEADINGS (128) cells of CELL x CELL (32 x 32) view pixels per car colour.
// A sheet is made from one master, the car facing right at MASTER times the view's resolution,
// a bitmap of materials (body, roof, glass, lamp ...). Every cell samples that master
// nearest-neighbour at its own heading, pixel centre by pixel centre, into indexed colour: no
// blend, no anti-aliasing. The light is then put on in the cell, not in the master, because the
// sun stands still (top-left, as in the baked world) while the car turns: a lit edge up-left,
// a shaded one down-right, a dark outline round the body, a glint in the windscreen.
// The geometry is worked out once for all colours (three index sheets: the car, the damage
// laid over a battered car, the burnt wreck); a colour's sheet is those indices through its
// own three tones (gfx/palette.ts carTones: the body tone is the server's colour, untouched)
// and the shared neutrals.
//
// Shared by every colour, one sheet each: the damage (dents, scratches, a primer panel: drawn
// on top of the colour sheet), the burnt wreck (drawn on top too; its roof and bonnet stripe
// are left open, so the wreck still shows whose it was) and the silhouette (the cast shadow,
// and the dark a falling car sinks into). The effects are one small sheet: the mine blast, the
// hit sparks, the mines and the smoke puffs, all in the palette's 32 colours.
//
// The sheets are module-level: built on first use, they outlive a Renderer. Canvas memory is
// capped: MAX_CAR_SHEETS colour sheets (one per player; the least recently drawn colour gives
// way to a new one), three shared car sheets and the effect sheet (spriteBytes()).

import { MAX_PLAYERS } from "../../shared/protocol";
import { BAYER4, carTones, P, PALETTE, rgbOf, type PaletteName } from "./palette";

export const CELL = 32;
export const HEADINGS = 128;
export const HEADING_STEP = (Math.PI * 2) / HEADINGS;
const COLS = 16;
export const SHEET_W = COLS * CELL;
export const SHEET_H = (HEADINGS / COLS) * CELL;
/** Colour sheets kept at once: every car on screen has one, and a room has MAX_PLAYERS cars. */
export const MAX_CAR_SHEETS = MAX_PLAYERS;

const HALF = CELL / 2;
const MASTER = 8; // master pixels per view pixel
const MSIZE = CELL * MASTER;

// ---- the master ---------------------------------------------------------------------

// Materials of the master.
const M_NONE = 0;
const M_TYRE = 1;
const M_BODY = 2; // everything from here on is the hull
const M_ROOF = 3;
const M_STRIPE = 4;
const M_WING = 5;
const M_GLASS = 6;
const M_SCREEN = 7; // the windscreen: glass that takes the glint
const M_LAMP = 8;
const M_TAIL = 9;

/** The hull's outline, |v| against u (view pixels, u forward): 24 x 12.8 as the car's physics, the corners cut, the nose drawn in. */
function inHull(u: number, a: number): boolean {
  if (u < -12 || u > 12 || a > 6.4) return false;
  if (u < -10.4 && a > 4.6 + (u + 12) * 1.125) return false;
  if (u > 5 && u <= 10.6 && a > 6.4 - (u - 5) * (0.8 / 5.6)) return false;
  if (u > 10.6 && a > 5.6 - (u - 10.6) * (1.8 / 1.4)) return false;
  return true;
}

/** What the car is made of at (u, v): u forward, v to its right, view pixels from its centre. */
function material(u: number, v: number): number {
  const a = Math.abs(v);
  if (inHull(u, a)) {
    if (u >= 10 && a >= 2.6 && a <= 5.2) return M_LAMP;
    if (u <= -11 && a >= 2.6 && a <= 4.6) return M_TAIL;
    // The cabin: a windscreen that widens to its foot, the roof, a side window either side of
    // it between the pillars, a rear window.
    if (u >= 1.5 && u < 4.7 && a <= 3.6 + (u - 1.5) * 0.3) return M_SCREEN;
    if (u >= -4.5 && u < 1.5) return a <= 3 ? M_ROOF : a <= 4.4 && u >= -3.5 && u < 0.5 ? M_GLASS : M_BODY;
    if (u >= -6.5 && u < -4.5 && a <= 3.6) return M_GLASS;
    if (u >= 5.6 && u < 10.4 && a <= 1) return M_STRIPE;
    if (u >= -11 && u < -9 && a <= 5.9) return M_WING;
    return M_BODY;
  }
  if (a >= 4.5 && a <= 7.6 && ((u >= -9.6 && u <= -4.4) || (u >= 3.4 && u <= 8.6))) return M_TYRE;
  return M_NONE;
}

// Damage laid over a battered car (local coordinates, as material()).
const D_NONE = 0;
const D_DENT = 1; // a dent's dark side
const D_PRIMER = 2; // a panel replaced and never painted
const D_SCRATCH = 3; // bare metal
const D_RUST = 4;
const D_DEAD = 5; // a lamp knocked out
const D_CRACK = 6; // in the windscreen

function damage(u: number, v: number): number {
  // The right headlamp is gone, the windscreen cracked from its left corner.
  if (u >= 10 && v >= 2.6 && v <= 5.2) return D_DEAD;
  if (u >= 1.5 && u < 4.5 && Math.abs(v + 2.6 - (u - 1.5) * 0.9) <= 0.55 && v < 1) return D_CRACK;
  // A crumpled left front wing: the dent, and rust along its lower edge.
  const dx = u - 7.2, dy = v + 4.2;
  if (dx * dx + dy * dy * 1.6 <= 5.2) return dx + dy > 1.1 ? D_RUST : D_DENT;
  // The boot's right half in primer, a scratch from the right door back to it.
  if (u >= -8.8 && u < -6.6 && v >= 0.4 && v <= 5.4) return D_PRIMER;
  if (u >= -5.5 && u < 0.5 && Math.abs(v - 5.3 + (u + 5.5) * 0.12) <= 0.5) return D_SCRATCH;
  // A dent in the roof and a rust patch on the bonnet's right.
  if ((u + 2.6) * (u + 2.6) + (v + 0.6) * (v + 0.6) <= 2.0) return u + v > -2.6 ? D_PRIMER : D_DENT;
  if ((u - 8.4) * (u - 8.4) + (v - 3.6) * (v - 3.6) <= 1.7) return D_RUST;
  return D_NONE;
}

/** Where the burnt wreck is left open and the car's own colour shows: the roof and the bonnet stripe. */
function open(u: number, v: number): boolean {
  const a = Math.abs(v);
  return (u >= -4.5 && u < 1.5 && a <= 3) || (u >= 5.6 && u < 10.4 && a <= 1);
}

/** Rust on the wreck where the paint burnt off: patches, seeded. */
function scorched(u: number, v: number): boolean {
  const x = Math.floor(u * 0.5 + 40), y = Math.floor(v * 0.5 + 40);
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) % 100 < 22;
}

// ---- the index sheets -----------------------------------------------------------------

// Tones of a car sheet: the index a pixel stores; carPalette() gives them colours.
const T_NONE = 0;
const T_OUTLINE = 1;
const T_TYRE = 2;
const T_TREAD = 3;
const T_SHADE = 4;
const T_BODY = 5;
const T_LIT = 6;
const T_GLASS = 7;
const T_GLINT = 8;
const T_LAMP = 9;
const T_TAIL = 10;
const TONES = 16;

// The burnt wreck's own tones (index + 1 into BURNT).
const BURNT: readonly PaletteName[] = ["soot0", "soot1", "soot2", "soot3", "dirt0", "rust0", "rust1"];
const B_PIT = 1, B_DARK = 2, B_CHAR = 3, B_EDGE = 4, B_ASH = 5, B_RUST = 6, B_EMBER = 7;
// The damage's tones (index = D_*).
const DAMAGE: readonly PaletteName[] = ["soot0", "soot3", "steel1", "steel2", "rust1", "soot2", "bone0"];

interface CarIndex {
  car: Uint8Array; // T_*
  dents: Uint8Array; // D_*, 0 = nothing there
  burnt: Uint8Array; // B_*, 0 = open (outside the car, or the colour showing through)
}

let carIndex: CarIndex | null = null;

/** The three index sheets every colour shares, built on first use. */
export function carIndexSheets(): CarIndex {
  if (carIndex) return carIndex;
  // The masters: materials, damage and the open part, MASTER samples a view pixel.
  const mat = new Uint8Array(MSIZE * MSIZE), dmg = new Uint8Array(MSIZE * MSIZE), flags = new Uint8Array(MSIZE * MSIZE);
  for (let j = 0; j < MSIZE; j++) {
    for (let i = 0; i < MSIZE; i++) {
      const u = (i + 0.5) / MASTER - HALF, v = (j + 0.5) / MASTER - HALF;
      const m = material(u, v);
      mat[j * MSIZE + i] = m;
      if (m >= M_BODY) {
        dmg[j * MSIZE + i] = damage(u, v);
        flags[j * MSIZE + i] = (open(u, v) ? 1 : 0) | (scorched(u, v) ? 2 : 0);
      }
    }
  }
  const car = new Uint8Array(SHEET_W * SHEET_H), dents = new Uint8Array(SHEET_W * SHEET_H), burnt = new Uint8Array(SHEET_W * SHEET_H);
  const cell = new Uint8Array(CELL * CELL); // materials of the cell being made
  const at = new Int32Array(CELL * CELL); // ... and where in the master each came from
  const hull = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < CELL && y < CELL && cell[y * CELL + x] >= M_BODY;
  for (let k = 0; k < HEADINGS; k++) {
    const cos = Math.cos(k * HEADING_STEP), sin = Math.sin(k * HEADING_STEP);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = x + 0.5 - HALF, dy = y + 0.5 - HALF;
        const mi = Math.floor((dx * cos + dy * sin + HALF) * MASTER), mj = Math.floor((dy * cos - dx * sin + HALF) * MASTER);
        const inside = mi >= 0 && mj >= 0 && mi < MSIZE && mj < MSIZE;
        at[y * CELL + x] = inside ? mj * MSIZE + mi : -1;
        cell[y * CELL + x] = inside ? mat[mj * MSIZE + mi] : M_NONE;
      }
    }
    const ox = (k % COLS) * CELL, oy = Math.floor(k / COLS) * CELL;
    let glint = -1, glintAt = 1e9;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const p = y * CELL + x, o = (oy + y) * SHEET_W + ox + x;
        const m = cell[p];
        let t = T_NONE, b = 0;
        if (m === M_NONE) {
          // The outline: one pixel round the hull, on the four sides.
          if (hull(x - 1, y) || hull(x + 1, y) || hull(x, y - 1) || hull(x, y + 1)) {
            t = T_OUTLINE;
            b = B_PIT;
          }
        } else if (m === M_TYRE) {
          const bare = (qx: number, qy: number) => qx < 0 || qy < 0 || qx >= CELL || qy >= CELL || cell[qy * CELL + qx] === M_NONE;
          t = bare(x - 1, y) || bare(x, y - 1) ? T_TREAD : T_TYRE;
          b = B_PIT;
        } else {
          const lit = !hull(x - 1, y) || !hull(x, y - 1);
          const shade = !hull(x + 1, y) || !hull(x, y + 1);
          const f = flags[at[p]];
          if (m === M_BODY) t = lit ? T_LIT : shade || !hull(x + 1, y + 1) ? T_SHADE : T_BODY;
          else if (m === M_ROOF) t = cell[p - 1] !== M_ROOF && cell[p - CELL] !== M_ROOF ? T_LIT : T_BODY; // the roof's sunlit corner
          else if (m === M_STRIPE) t = T_LIT;
          else if (m === M_WING) t = lit ? T_BODY : T_SHADE;
          else if (m === M_LAMP) t = T_LAMP;
          else if (m === M_TAIL) t = T_TAIL;
          else {
            t = T_GLASS;
            if (m === M_SCREEN && x + y < glintAt) {
              glintAt = x + y;
              glint = o;
            }
          }
          // The wreck: charred, the edges still catching the light, rust where the paint burnt off.
          if (f & 1) b = 0;
          else if (m === M_GLASS || m === M_SCREEN) b = B_PIT;
          else if (m === M_LAMP || m === M_TAIL) b = B_DARK;
          else if (lit) b = B_ASH;
          else if (shade) b = B_DARK;
          else if (f & 2) b = (x + y) & 1 ? B_RUST : B_EMBER;
          else b = m === M_WING ? B_DARK : B_CHAR;
          if (b === B_CHAR && (!hull(x - 2, y) || !hull(x, y - 2))) b = B_EDGE;
          dents[o] = dmg[at[p]];
        }
        car[o] = t;
        burnt[o] = b;
      }
    }
    if (glint >= 0) car[glint] = T_GLINT;
  }
  carIndex = { car, dents, burnt };
  return carIndex;
}

// ---- colours --------------------------------------------------------------------------

/** A colour as a packed 0xAABBGGRR word (little-endian ImageData). */
function word(hex: string, alpha = 255): number {
  const [r, g, b] = rgbOf(hex);
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function wordsOf(names: readonly PaletteName[]): Uint32Array {
  const out = new Uint32Array(names.length + 1);
  names.forEach((n, i) => (out[i + 1] = word(P[n])));
  return out;
}

/** The tones of a car colour as pixel words: three of its own (the body is the colour itself) and the shared neutrals. */
export function carPalette(color: string): Uint32Array {
  const t = carTones(color);
  const pal = new Uint32Array(TONES);
  pal[T_OUTLINE] = word(P.soot1);
  pal[T_TYRE] = word(P.soot2);
  pal[T_TREAD] = word(P.tar3);
  pal[T_SHADE] = word(t.shade);
  pal[T_BODY] = word(t.body);
  pal[T_LIT] = word(t.lit);
  pal[T_GLASS] = word(P.steel0);
  pal[T_GLINT] = word(P.steel2);
  pal[T_LAMP] = word(P.haz2);
  pal[T_TAIL] = word(P.red);
  return pal;
}

/** Index sheet to pixels. */
function pixels(idx: Uint8Array, pal: Uint32Array, out: Uint32Array): Uint32Array {
  for (let i = 0; i < idx.length; i++) out[i] = pal[idx[i]];
  return out;
}

/** A colour's sheet as pixels (0xAABBGGRR), SHEET_W x SHEET_H: cell k is heading k * HEADING_STEP. */
export function carPixels(color: string, out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H)): Uint32Array {
  return pixels(carIndexSheets().car, carPalette(color), out);
}

/** The damage laid over a battered car. */
export function dentPixels(out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H)): Uint32Array {
  const pal = wordsOf(DAMAGE.slice(1));
  return pixels(carIndexSheets().dents, pal, out);
}

/** The burnt wreck, open where the car's colour shows through. */
export function burntPixels(out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H)): Uint32Array {
  return pixels(carIndexSheets().burnt, wordsOf(BURNT), out);
}

/** The car's silhouette in black: the cast shadow (drawn at SHADOW_ALPHA) and the dark of a fall. */
export function shadePixels(out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H)): Uint32Array {
  const car = carIndexSheets().car;
  for (let i = 0; i < car.length; i++) out[i] = car[i] ? 0xff000000 : 0;
  return out;
}

// ---- effects --------------------------------------------------------------------------

export const FX_COLS = 8;
export const FX_W = FX_COLS * CELL;
export const FX_H = 5 * CELL;
// Cells of the effect sheet.
export const BLAST_FRAMES = 8;
export const FX_BLAST = 0; // 8 frames
export const SPARK_FRAMES = 6;
export const SPARK_KINDS = 4;
export const FX_SPARK = 8; // SPARK_KINDS x SPARK_FRAMES
export const FX_MINE = 32; // armed and lit, armed and dark, not armed
export const FX_PUFF = 35; // three puffs, young to old

// A pixel of the effect sheet: 0 = nothing, 1..32 = palette entry + 1, 33 = cast shadow.
const FX_SHADOW = PALETTE.length + 1;
/** The cast shadow's black, as the cars' (today's 38%). */
export const SHADOW_ALPHA = 0.38;

const IDX = Object.fromEntries(PALETTE.map((e, i) => [e.name, i + 1])) as Record<PaletteName, number>;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The effect sheet as indices, FX_W x FX_H. */
export function fxIndexSheet(): Uint8Array {
  const sheet = new Uint8Array(FX_W * FX_H);
  let ox = 0, oy = 0;
  const cellAt = (n: number) => {
    ox = (n % FX_COLS) * CELL;
    oy = Math.floor(n / FX_COLS) * CELL;
  };
  const put = (x: number, y: number, name: PaletteName | null) => {
    if (x >= 0 && y >= 0 && x < CELL && y < CELL) sheet[(oy + y) * FX_W + ox + x] = name ? IDX[name] : 0;
  };
  /** More than `share` of the pixels round here are left out (ordered dither). */
  const thin = (x: number, y: number, share: number) => (BAYER4[y & 3][x & 3] + 0.5) / 16 > share;

  // The mine blast: a flash, a fireball that opens into a ring, then scraps of it. Eight
  // frames, one a display frame: after 133 ms nothing is left, and from the fifth on the ring
  // is mostly holes, so a car under it is never hidden for long.
  const BLAST: { r: number; hole: number; core: number; fill: number; tones: PaletteName[] }[] = [
    { r: 5.5, hole: 0, core: 3.5, fill: 1, tones: ["haz2", "haz2", "haz1"] },
    { r: 9.5, hole: 0, core: 5.5, fill: 1, tones: ["haz2", "blast", "rust3"] },
    { r: 12.5, hole: 0, core: 5, fill: 1, tones: ["haz2", "blast", "rust3"] },
    { r: 14.5, hole: 3.5, core: 6.5, fill: 0.94, tones: ["haz1", "blast", "rust2"] },
    { r: 15.2, hole: 7, core: 9.5, fill: 0.7, tones: ["blast", "rust3", "rust1"] },
    { r: 15.5, hole: 9.5, core: 11.5, fill: 0.5, tones: ["rust3", "rust2", "rust0"] },
    { r: 15.5, hole: 11.5, core: 13, fill: 0.3, tones: ["rust2", "rust1", "soot3"] },
    { r: 15.5, hole: 12.5, core: 14, fill: 0.14, tones: ["rust1", "rust0", "soot3"] },
  ];
  BLAST.forEach((b, f) => {
    cellAt(FX_BLAST + f);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = x + 0.5 - HALF, dy = y + 0.5 - HALF;
        const a = Math.atan2(dy, dx);
        // A ragged edge: the fireball is not a circle.
        const rag = 1 + 0.1 * Math.sin(a * 5 + f * 1.3) + 0.06 * Math.sin(a * 9 - f * 0.7);
        const d = Math.hypot(dx, dy) / rag;
        if (d > b.r) continue;
        if (d < b.hole) {
          // Inside the ring: smoke, thinning out.
          if (!thin(x, y, 0.45 - f * 0.05)) put(x, y, hash2(x, y, f) < 0.5 ? "soot3" : "tar0");
          continue;
        }
        if (thin(x, y, b.fill)) continue;
        const t = (d - b.hole) / (b.r - b.hole || 1);
        const core = (b.core - b.hole) / (b.r - b.hole || 1);
        put(x, y, d <= b.core ? b.tones[0] : t < core + (1 - core) * 0.55 ? b.tones[1] : b.tones[2]);
      }
    }
    // Scraps thrown out ahead of the fire.
    for (let k = 0; k < 9; k++) {
      const a = k * 0.7 + 0.3, r = Math.min(15, 4 + f * 2.2 + (k % 3) * 1.7);
      if (f >= 1 && f <= 6) put(Math.floor(HALF + Math.cos(a) * r), Math.floor(HALF + Math.sin(a) * r), f < 4 ? "haz2" : "haz1");
    }
  });

  // Hit sparks: seven rays flying out, as today's, in six frames; four turns of them.
  const SPARK: { tone: PaletteName; tip: PaletteName; skip: number }[] = [
    { tone: "haz2", tip: "haz2", skip: 0 },
    { tone: "haz2", tip: "haz1", skip: 0 },
    { tone: "haz1", tip: "blast", skip: 0 },
    { tone: "blast", tip: "rust3", skip: 3 },
    { tone: "rust3", tip: "rust2", skip: 2 },
    { tone: "rust2", tip: "rust1", skip: 2 },
  ];
  for (let kind = 0; kind < SPARK_KINDS; kind++) {
    SPARK.forEach((s, f) => {
      cellAt(FX_SPARK + kind * SPARK_FRAMES + f);
      const age = (f + 0.5) / SPARK_FRAMES;
      const r0 = 2.2 + 5.6 * age, r1 = Math.min(15.4, 4.4 + 11.6 * age);
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9 + kind * 0.37;
        const cos = Math.cos(a), sin = Math.sin(a);
        for (let n = 0, r = r0; r <= r1; r += 0.5, n++) {
          if (s.skip && (n >> 1) % s.skip === 0) continue;
          const x = Math.floor(HALF + cos * r), y = Math.floor(HALF + sin * r);
          const tone = r > r0 + (r1 - r0) * 0.6 ? s.tip : s.tone;
          put(x, y, tone);
          // The young rays are two pixels thick.
          if (f < 2) put(Math.floor(HALF + cos * r - sin * 0.8), Math.floor(HALF + sin * r + cos * 0.8), tone);
        }
      }
      if (f === 0) for (let y = -2; y < 2; y++) for (let x = -2; x < 2; x++) if (Math.abs(x + 0.5) + Math.abs(y + 0.5) < 3) put(HALF + x, HALF + y, "haz2");
    });
  }

  // Mines: a steel body with six stubs, a bright rim all round so it holds on worn tarmac, a
  // lamp in the middle (armed: blinking red; not armed yet: amber), a cast shadow.
  ([["red", "haz2"], ["rust0", "rust0"], ["haz0", "haz1"]] as [PaletteName, PaletteName][]).forEach(([lamp, hot], f) => {
    cellAt(FX_MINE + f);
    const disc = (x: number, y: number, r: number) => Math.hypot(x + 0.5 - HALF, y + 0.5 - HALF) <= r;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (Math.hypot(x + 0.5 - HALF - 1, y + 0.5 - HALF - 2) <= 5.4) sheet[(oy + y) * FX_W + ox + x] = FX_SHADOW;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      for (let r = 4; r <= 7.2; r += 0.4) {
        for (const w of [-0.5, 0.5]) {
          const x = Math.floor(HALF + Math.cos(a) * r - Math.sin(a) * w), y = Math.floor(HALF + Math.sin(a) * r + Math.cos(a) * w);
          put(x, y, r > 6.2 ? "steel1" : "soot2");
        }
      }
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (!disc(x, y, 5.1)) continue;
        const dx = x + 0.5 - HALF, dy = y + 0.5 - HALF;
        // The rim: bright where the sun is, a step down on the far side.
        if (!disc(x, y, 4.1)) put(x, y, dx + dy < 1 ? "steel3" : "steel2");
        else put(x, y, dx + dy > 2.2 ? "steel0" : "steel1");
      }
    }
    for (let y = -2; y < 2; y++) for (let x = -2; x < 2; x++) if (Math.abs(x + 0.5) + Math.abs(y + 0.5) < 3) put(HALF + x, HALF + y, lamp);
    put(HALF - 1, HALF - 1, hot);
  });

  // Smoke: three puffs, young to old: larger and thinner, lit from the top-left.
  ([[4.2, 1], [6.4, 0.75], [8.6, 0.45]] as [number, number][]).forEach(([r, share], f) => {
    cellAt(FX_PUFF + f);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = x + 0.5 - HALF, dy = y + 0.5 - HALF;
        // A lumpy cloud, not a disc; its rim is thinner than its middle.
        const d = Math.hypot(dx, dy) / (r * (1 + 0.1 * Math.sin(Math.atan2(dy, dx) * 3 + f * 2)));
        if (d > 1 || thin(x, y, d > 0.8 ? share * 0.5 : share)) continue;
        put(x, y, dx + dy < -r * 0.35 ? "steel2" : dx + dy > r * 0.5 ? "tar2" : "tar3");
      }
    }
  });
  return sheet;
}


/** The effect sheet as pixels (0xAABBGGRR), FX_W x FX_H. */
export function fxPixels(out: Uint32Array = new Uint32Array(FX_W * FX_H)): Uint32Array {
  const pal = new Uint32Array(FX_SHADOW + 1);
  PALETTE.forEach((e, i) => (pal[i + 1] = word(e.hex)));
  pal[FX_SHADOW] = word(P.soot0, Math.round(SHADOW_ALPHA * 255)) & 0xff000000; // black, the shadow's alpha
  return pixels(fxIndexSheet(), pal, out);
}

// ---- canvases -------------------------------------------------------------------------

interface CarSheet {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  color: string;
  used: number; // the last frame it was asked for
}

let bytes = 0;
let soft = true;
let softKnown = false;

/**
 * Sprite canvases live where the view canvas lives (as the world's tiles do): in main memory
 * when the view is one that is read back (the benchmark's), so a blit never crosses between
 * main memory and the GPU. The first Renderer's view decides.
 */
export function spritesFor(view: CanvasRenderingContext2D): void {
  if (softKnown) return;
  softKnown = true;
  soft = view.getContextAttributes?.().willReadFrequently !== false;
}

function sheetCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  bytes += w * h * 4;
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: soft })! };
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, fill: (out: Uint32Array) => unknown): void {
  if (typeof ImageData === "undefined") return; // no browser (a Node probe): the canvas stays empty
  const img = new ImageData(w, h);
  fill(new Uint32Array(img.data.buffer));
  ctx.putImageData(img, 0, 0);
}

const carSheets = new Map<string, CarSheet>();
let clock = 0;

/** A new frame: sheets asked for from now on are in use and are not given to another colour. */
export function spriteFrame(): void {
  clock++;
}

/** The sheet of a car colour: built on first use; with MAX_CAR_SHEETS in use, the one unused for longest is repainted. */
export function carSheet(color: string): HTMLCanvasElement {
  let s = carSheets.get(color);
  if (!s) {
    if (carSheets.size < MAX_CAR_SHEETS) s = { ...sheetCanvas(SHEET_W, SHEET_H), color, used: 0 };
    else {
      for (const o of carSheets.values()) if (!s || o.used < s.used) s = o;
      s = s!;
      carSheets.delete(s.color);
      s.ctx.clearRect(0, 0, SHEET_W, SHEET_H);
      s.color = color;
    }
    carSheets.set(color, s);
    paint(s.ctx, SHEET_W, SHEET_H, (out) => carPixels(color, out));
  }
  s.used = clock;
  return s.canvas;
}

export interface SharedSheets {
  dents: HTMLCanvasElement;
  burnt: HTMLCanvasElement;
  shade: HTMLCanvasElement;
  fx: HTMLCanvasElement;
}

let shared: SharedSheets | null = null;

/** The sheets every car shares and the effect sheet, built on first use. */
export function sharedSheets(): SharedSheets {
  if (!shared) {
    const make = (w: number, h: number, fill: (out: Uint32Array) => unknown) => {
      const s = sheetCanvas(w, h);
      paint(s.ctx, w, h, fill);
      return s.canvas;
    };
    shared = {
      dents: make(SHEET_W, SHEET_H, dentPixels),
      burnt: make(SHEET_W, SHEET_H, burntPixels),
      shade: make(SHEET_W, SHEET_H, shadePixels),
      fx: make(FX_W, FX_H, fxPixels),
    };
  }
  return shared;
}

/** Canvas memory the sprite sheets hold right now, in bytes. */
export function spriteBytes(): number {
  return bytes;
}

/** The most the sprite sheets can ever hold: every colour sheet, the three shared ones, the effects. */
export const SPRITE_BYTES_MAX = (MAX_CAR_SHEETS + 3) * SHEET_W * SHEET_H * 4 + FX_W * FX_H * 4;
