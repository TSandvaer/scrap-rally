// Pre-rendered sprites of the cars and the effects (PLAN-GFX.md, items B1-B7; the cars' three
// looks: PLAN-M4.md 2.1).
//
// Cars: a sheet is HEADINGS (128) cells of CELL x CELL (32 x 32) view pixels. It is made from
// one master, the car facing right at MASTER times the view's resolution, a bitmap of
// materials (body, roof, glass, lamp ...). Every cell samples that master nearest-neighbour at
// its own heading, pixel centre by pixel centre, into indexed colour: no blend, no
// anti-aliasing. The light is then put on in the cell, not in the master, because the sun
// stands still (top-left, as in the baked world) while the car turns: a lit edge up-left, a
// shaded one down-right, a dark outline round the body, a glint in the windscreen.
//
// A car has one of three looks (LOOKS), each a master of its own drawn inside the one shape
// every car is hit by (30 x 16 world units: 24 x 12.8 view pixels, the tyres a little
// further out, as the sport's always were): the sport, a closed two-seater; the racer, an
// open-wheel single-seater, its wheels free of the body and a wing at either end; the truck,
// a four-wheel-drive pickup, square, with a load bed and a spare wheel in it.
// The geometry of a look is worked out once for all colours (three index sheets: the car, the
// damage of a battered car, the burnt wreck). The colours are the car colour's own three tones
// (gfx/palette.ts carTones: the body tone is the server's colour, untouched) and the shared
// neutrals.
//
// A car sheet is one car as it is now: its look, its colour and its state (whole, battered,
// burnt), the damage and the wreck painted into it. The burnt wreck leaves a part of the car
// open (the sport's roof and bonnet stripe), so it still shows whose it was. No more than
// MAX_CAR_SHEETS of them exist, one a car of a full room: a car whose state changes has its
// own sheet painted again, and with room to spare a state it was in before is still there
// when it comes back to it. Beside them one silhouette sheet a look (the cast shadow, and the
// dark a falling car sinks into) and one small sheet of effects: the mine blast, the hit
// sparks, the mines and the smoke puffs, all in the palette's 32 colours.
//
// The sheets are module-level: built on first use, they outlive a Renderer. Canvas memory is
// capped at what it was with one look (spriteBytes(), SPRITE_BYTES_MAX): MAX_CAR_SHEETS car
// sheets, a silhouette for each of the three looks, the effect sheet.

import { MAX_PLAYERS } from "../../shared/protocol";
import { BAYER4, carTones, P, PALETTE, rgbOf, type PaletteName } from "./palette";

export const CELL = 32;
export const HEADINGS = 128;
export const HEADING_STEP = (Math.PI * 2) / HEADINGS;
const COLS = 16;
export const SHEET_W = COLS * CELL;
export const SHEET_H = (HEADINGS / COLS) * CELL;
/** Car sheets kept at once: every car on screen has one, and a room has MAX_PLAYERS cars. */
export const MAX_CAR_SHEETS = MAX_PLAYERS;

/** The looks, by number: what render.ts CarView.car names. */
export const LOOKS = ["sport", "racer", "truck"] as const;
export const SPORT = 0, RACER = 1, TRUCK = 2;
/** A look's number; a car that names none, or one not known here, is the sport. */
export function lookOf(car: string | undefined): number {
  return car === "racer" ? RACER : car === "truck" ? TRUCK : SPORT;
}
/** A car's states: each is a sheet of its own. */
export const WHOLE = 0, DENTED = 1, BURNT = 2;

const HALF = CELL / 2;
const MASTER = 8; // master pixels per view pixel
const MSIZE = CELL * MASTER;

// ---- the masters ----------------------------------------------------------------------

// Materials of a master.
const M_NONE = 0;
const M_TYRE = 1;
const M_ARM = 2; // a wheel's arm (the racer's): bare steel, not part of the hull
const M_BODY = 3; // everything from here on is the hull
const M_ROOF = 4;
const M_STRIPE = 5;
const M_WING = 6;
const M_GLASS = 7;
const M_SCREEN = 8; // the windscreen: glass that takes the glint
const M_LAMP = 9;
const M_TAIL = 10;
const M_PLATE = 11; // a thin painted plate (the racer's wings): the body's tone and no other, too thin to shade
const M_PIT = 12; // a dark opening: a cockpit, an intake, a vent
const M_HELMET = 13; // the racer's driver; takes the shine
const M_BAR = 14; // a steel tube: the truck's bull bar and roll bar
const M_BED = 15; // the truck's load bed: a steel floor, sunk between its walls
const M_SPARE = 16; // the spare wheel lying in it ...
const M_HUB = 17; // ... and its rim

// Damage laid over a battered car (local coordinates, as the materials).
const D_NONE = 0;
const D_DENT = 1; // a dent's dark side
const D_PRIMER = 2; // a panel replaced and never painted
const D_SCRATCH = 3; // bare metal
const D_RUST = 4;
const D_DEAD = 5; // a lamp knocked out
const D_CRACK = 6; // in the windscreen

/**
 * A look: what the car is made of at (u, v) (u forward, v to its right, view pixels from its
 * centre), the damage of a battered one there, and where the burnt wreck is left open and the
 * car's own colour shows.
 */
interface Look {
  material(u: number, v: number): number;
  damage(u: number, v: number): number;
  open(u: number, v: number): boolean;
}

// The sport: a closed two-seater.

/** The sport's outline, |v| against u: 24 x 12.8 as the car's physics, the corners cut, the nose drawn in. */
function inHull(u: number, a: number): boolean {
  if (u < -12 || u > 12 || a > 6.4) return false;
  if (u < -10.4 && a > 4.6 + (u + 12) * 1.125) return false;
  if (u > 5 && u <= 10.6 && a > 6.4 - (u - 5) * (0.8 / 5.6)) return false;
  if (u > 10.6 && a > 5.6 - (u - 10.6) * (1.8 / 1.4)) return false;
  return true;
}

const sport: Look = {
  material(u, v) {
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
  },
  damage(u, v) {
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
  },
  // The roof and the bonnet stripe.
  open(u, v) {
    const a = Math.abs(v);
    return (u >= -4.5 && u < 1.5 && a <= 3) || (u >= 5.6 && u < 10.4 && a <= 1);
  },
};

// The racer: an open-wheel single-seater. A slim body from a pointed nose to the tail, the
// driver's helmet in its cockpit, a side pod either side of him, a wing right across at
// either end, and four wheels standing free of it all, the rear pair the bigger.

/** Half the width of the racer's body at u: the nose cone, the tub round the driver, the engine cover drawn in to the tail. */
function fuselage(u: number): number {
  if (u > 11.2) return 1.2 - (u - 11.2);
  if (u > 3) return 2.3 - (u - 3) * (1.1 / 8.2);
  if (u > -2.5) return 2.6;
  return 2.6 - (-2.5 - u) * (1 / 7.3);
}

const racer: Look = {
  material(u, v) {
    const a = Math.abs(v);
    if (u < -12 || u > 12) return M_NONE;
    if (u >= -9.8 && a <= fuselage(u)) {
      // The helmet in the cockpit's opening; a ridge down the engine cover.
      if ((u + 0.1) * (u + 0.1) + v * v <= 1.69) return M_HELMET;
      if (u >= -1.7 && u < 2 && a <= 1.6) return M_PIT;
      if (u >= -9 && u < -2.7 && a <= 0.7) return M_STRIPE;
      return M_BODY;
    }
    // The wings, the rear one with a red lamp in its middle.
    if (u < -9.8) return a > 6.3 ? M_NONE : u <= -10.8 && a <= 0.8 ? M_TAIL : M_PLATE;
    if (u >= 9.7 && u <= 11.8 && a <= 6) return M_PLATE;
    // The side pods: an intake in the front of each, drawn in toward the rear wheels.
    if (u >= -5 && u < 1.6 && a <= (u < -3 ? 5 - (-3 - u) * 0.9 : 5)) return u >= 0.4 && a >= 3 && a <= 4.6 ? M_PIT : M_BODY;
    // The wheels, each on its arm.
    if ((u >= 4.8 && u <= 9 && a >= 4.2 && a <= 7.2) || (u >= -9.8 && u <= -4.8 && a >= 3.9 && a <= 7.4)) return M_TYRE;
    if ((u >= 6.3 && u <= 7.5 && a < 4.2) || (u >= -7.9 && u <= -6.7 && a < 3.9)) return M_ARM;
    return M_NONE;
  },
  damage(u, v) {
    // The front wing's right half bare, its tip scraped; the rear wing's left end in primer.
    if (u >= 9.7 && v >= 2 && Math.abs(v) > fuselage(u)) return v > 4.4 ? D_SCRATCH : D_PRIMER;
    if (u < -9.8 && v <= -3) return D_PRIMER;
    // A dent in the nose, a rusted hole in the left side pod, a scratch down the engine cover.
    if ((u - 6.2) * (u - 6.2) + (v + 0.5) * (v + 0.5) <= 1.5) return D_DENT;
    const dx = u + 1.8, dy = v + 3.9;
    if (dx * dx + dy * dy * 1.5 <= 3.6) return dx + dy > 0.6 ? D_RUST : D_DENT;
    if (u >= -8.6 && u < -3 && Math.abs(v - 1.3 + (u + 8.6) * 0.06) <= 0.5) return D_SCRATCH;
    if ((u + 3.2) * (u + 3.2) + (v - 3.6) * (v - 3.6) <= 1.3) return D_RUST;
    return D_NONE;
  },
  // The nose and the engine cover.
  open(u, v) {
    return (u >= 3.4 || (u >= -9.8 && u < -2.7)) && Math.abs(v) <= fuselage(u);
  },
};

// The truck: a four-wheel-drive pickup. Square where the sport is drawn in: a flat nose with
// a bull bar between the lamps, a short cab, a roll bar behind it, a load bed sunk between
// its walls with the spare wheel lying in it. The body is cut away at the four wheel arches,
// and the big tyres stand in them.

/** Is u at one of the truck's axles: where its body is cut away and a tyre stands? */
function arch(u: number): boolean {
  return (u >= 4.4 && u <= 9.8) || (u >= -9.8 && u <= -4.4);
}

const truck: Look = {
  material(u, v) {
    const a = Math.abs(v), e = Math.abs(u);
    if (e > 12 || a > 7.6) return M_NONE;
    if (a <= (arch(u) ? 4.8 : 6.4) && !(e > 11.2 && a > 6.4 - (e - 11.2))) {
      if (u >= 10.7) return a >= 3.4 && a <= 5.8 ? M_LAMP : a <= 2.6 ? M_BAR : M_BODY;
      if (u <= -11) return a >= 3.6 && a <= 5.8 ? M_TAIL : M_BODY;
      if (u >= 3.2 && u < 5.4 && a <= 4.6) return M_SCREEN;
      if (u >= -1.8 && u < 3.2) return a <= 4.6 ? M_ROOF : a <= 5.5 && u >= -1 && u < 2.6 ? M_GLASS : M_BODY;
      if (u >= -3.2 && u < -1.8 && a <= 5.8) return M_BAR;
      if (u >= -10.4 && u < -3.2 && a <= 3.8) {
        const d = (u + 6.8) * (u + 6.8) + v * v;
        return d <= 1.1 ? M_HUB : d <= 7.3 ? M_SPARE : M_BED;
      }
      return M_BODY;
    }
    return arch(u) && a > 4.8 ? M_TYRE : M_NONE;
  },
  damage(u, v) {
    // The left headlamp is gone, the windscreen cracked from its right corner.
    if (u >= 10.7 && v <= -3.4 && v >= -5.8) return D_DEAD;
    if (u >= 3.2 && u < 5.4 && Math.abs(v - 3 + (u - 3.2) * 1.1) <= 0.55 && v > -1) return D_CRACK;
    // The bonnet's right half crumpled, rust along its edge; a rust patch on its left.
    const dx = u - 8.2, dy = v - 3;
    if (dx * dx + dy * dy * 1.4 <= 4.6) return dx - dy < -0.7 ? D_RUST : D_DENT;
    if ((u - 9) * (u - 9) + (v + 2.8) * (v + 2.8) <= 1.6) return D_RUST;
    // The left door in primer, a scratch along the right one, a dent in the roof.
    if (u >= -1.4 && u < 3 && v <= -5.5) return D_PRIMER;
    if (u >= -3.6 && u < 3 && Math.abs(v - 5.9) <= 0.5) return D_SCRATCH;
    if ((u - 0.6) * (u - 0.6) + (v + 1.4) * (v + 1.4) <= 2.2) return u + v > -0.8 ? D_PRIMER : D_DENT;
    // The bed's right wall dented in, rust on the tailgate.
    if (u >= -9 && u < -5 && v >= 3.8) return u < -7 ? D_RUST : D_DENT;
    if ((u + 11.3) * (u + 11.3) + (v + 1.4) * (v + 1.4) <= 1.8) return D_RUST;
    return D_NONE;
  },
  // The cab's roof and the tailgate.
  open(u, v) {
    const a = Math.abs(v);
    return (u >= -1.8 && u < 3.2 && a <= 4.6) || (u < -10.4 && a <= 3.4);
  },
};

const LOOK: readonly Look[] = [sport, racer, truck];

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
const T_STEEL = 11; // bare steel in the shade: a wheel's arm, the bed's floor
const T_BRIGHT = 12; // ... and in the sun: a tube's lit side, the helmet
const T_SHINE = 13; // the shine on the helmet
const TONES = 16;

// The burnt wreck's own tones (index + 1 into BURNT).
const BURNT_TONES: readonly PaletteName[] = ["soot0", "soot1", "soot2", "soot3", "dirt0", "rust0", "rust1"];
const B_PIT = 1, B_DARK = 2, B_CHAR = 3, B_EDGE = 4, B_ASH = 5, B_RUST = 6, B_EMBER = 7;
// The damage's tones (index = D_*).
const DAMAGE_TONES: readonly PaletteName[] = ["soot0", "soot3", "steel1", "steel2", "rust1", "soot2", "bone0"];

interface CarIndex {
  car: Uint8Array; // T_*
  dents: Uint8Array; // D_*, 0 = nothing there
  burnt: Uint8Array; // B_*, 0 = open (outside the car, or the colour showing through)
}

const carIndex: (CarIndex | null)[] = LOOK.map(() => null);

/** The three index sheets of a look, which every colour shares, built on first use. */
export function carIndexSheets(look = SPORT): CarIndex {
  return carIndex[look] ?? (carIndex[look] = buildIndex(LOOK[look]));
}

function buildIndex(look: Look): CarIndex {
  // The masters: materials, damage and the open part, MASTER samples a view pixel. Only the
  // box the car lies in is worked out (13 x 9 view pixels either way); the rest stays empty.
  const mat = new Uint8Array(MSIZE * MSIZE), dmg = new Uint8Array(MSIZE * MSIZE), flags = new Uint8Array(MSIZE * MSIZE);
  for (let j = (HALF - 9) * MASTER; j < (HALF + 9) * MASTER; j++) {
    for (let i = (HALF - 13) * MASTER; i < (HALF + 13) * MASTER; i++) {
      const u = (i + 0.5) / MASTER - HALF, v = (j + 0.5) / MASTER - HALF;
      const m = look.material(u, v);
      mat[j * MSIZE + i] = m;
      if (m >= M_BODY) {
        dmg[j * MSIZE + i] = look.damage(u, v);
        flags[j * MSIZE + i] = (look.open(u, v) ? 1 : 0) | (scorched(u, v) ? 2 : 0);
      }
    }
  }
  const car = new Uint8Array(SHEET_W * SHEET_H), dents = new Uint8Array(SHEET_W * SHEET_H), burnt = new Uint8Array(SHEET_W * SHEET_H);
  // The cell being made: its materials with two pixels of nothing all round (so a look at a
  // neighbour needs no bounds check), and where in the master each pixel came from.
  const PADDED = CELL + 4;
  const cell = new Uint8Array(PADDED * PADDED);
  const at = new Int32Array(CELL * CELL);
  for (let k = 0; k < HEADINGS; k++) {
    const cos = Math.cos(k * HEADING_STEP), sin = Math.sin(k * HEADING_STEP);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = x + 0.5 - HALF, dy = y + 0.5 - HALF;
        const mi = Math.floor((dx * cos + dy * sin + HALF) * MASTER), mj = Math.floor((dy * cos - dx * sin + HALF) * MASTER);
        const inside = mi >= 0 && mj >= 0 && mi < MSIZE && mj < MSIZE;
        at[y * CELL + x] = inside ? mj * MSIZE + mi : -1;
        cell[(y + 2) * PADDED + x + 2] = inside ? mat[mj * MSIZE + mi] : M_NONE;
      }
    }
    const ox = (k % COLS) * CELL, oy = Math.floor(k / COLS) * CELL;
    let glint = -1, glintAt = 1e9, shine = -1, shineAt = 1e9;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const p = y * CELL + x, q = (y + 2) * PADDED + x + 2, o = (oy + y) * SHEET_W + ox + x;
        const m = cell[q];
        // Is the pixel to the left, right, above, below part of the hull?
        const left = cell[q - 1] >= M_BODY, right = cell[q + 1] >= M_BODY, above = cell[q - PADDED] >= M_BODY, below = cell[q + PADDED] >= M_BODY;
        let t = T_NONE, b = 0;
        if (m === M_NONE) {
          // The outline: one pixel round the hull, on the four sides.
          if (left || right || above || below) {
            t = T_OUTLINE;
            b = B_PIT;
          }
        } else if (m === M_TYRE) {
          t = cell[q - 1] === M_NONE || cell[q - PADDED] === M_NONE ? T_TREAD : T_TYRE;
          b = B_PIT;
        } else if (m === M_ARM) {
          t = T_STEEL;
          b = B_DARK;
        } else {
          const lit = !left || !above;
          const shade = !right || !below;
          const f = flags[at[p]];
          if (m === M_BODY) t = lit ? T_LIT : shade || cell[q + PADDED + 1] < M_BODY ? T_SHADE : T_BODY;
          else if (m === M_ROOF) t = cell[q - 1] !== M_ROOF && cell[q - PADDED] !== M_ROOF ? T_LIT : T_BODY; // the roof's sunlit corner
          else if (m === M_STRIPE) t = T_LIT;
          else if (m === M_WING) t = lit ? T_BODY : T_SHADE;
          else if (m === M_LAMP) t = T_LAMP;
          else if (m === M_TAIL) t = T_TAIL;
          else if (m === M_PLATE) t = T_BODY;
          else if (m === M_BAR) t = lit || cell[q - 1] !== M_BAR || cell[q - PADDED] !== M_BAR ? T_BRIGHT : T_GLINT;
          else if (m === M_HUB) t = T_GLINT;
          // The bed lies lower than its walls, which shade it along its top and left; the spare's tread catches the light there.
          else if (m === M_BED) t = cell[q - 1] < M_BED || cell[q - PADDED] < M_BED ? T_GLASS : T_STEEL;
          else if (m === M_SPARE) t = cell[q - 1] === M_BED || cell[q - PADDED] === M_BED ? T_TREAD : T_TYRE;
          else if (m === M_HELMET) {
            t = T_BRIGHT;
            if (x + y < shineAt) {
              shineAt = x + y;
              shine = o;
            }
          } else {
            t = T_GLASS;
            if (m === M_SCREEN && x + y < glintAt) {
              glintAt = x + y;
              glint = o;
            }
          }
          // The wreck: charred, the edges still catching the light, rust where the paint burnt off.
          if (f & 1) b = 0;
          else if (m === M_GLASS || m === M_SCREEN || m === M_PIT || m === M_SPARE) b = B_PIT;
          else if (m === M_LAMP || m === M_TAIL || m === M_HUB) b = B_DARK;
          else if (lit) b = B_ASH;
          else if (shade) b = B_DARK;
          else if (f & 2) b = (x + y) & 1 ? B_RUST : B_EMBER;
          else b = m === M_WING ? B_DARK : B_CHAR;
          if (b === B_CHAR && (cell[q - 2] < M_BODY || cell[q - 2 * PADDED] < M_BODY)) b = B_EDGE;
          dents[o] = dmg[at[p]];
        }
        car[o] = t;
        burnt[o] = b;
      }
    }
    if (glint >= 0) car[glint] = T_GLINT;
    if (shine >= 0) car[shine] = T_SHINE;
  }
  return { car, dents, burnt };
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

/** Index sheet to pixels. */
function pixels(idx: Uint8Array, pal: Uint32Array, out: Uint32Array): Uint32Array {
  for (let i = 0; i < idx.length; i++) out[i] = pal[idx[i]];
  return out;
}

const palettes = new Map<string, Uint32Array>();

/** The tones of a car colour as pixel words: three of its own (the body is the colour itself) and the shared neutrals. Kept per colour. */
export function carPalette(color: string): Uint32Array {
  let pal = palettes.get(color);
  if (pal) return pal;
  const t = carTones(color);
  pal = new Uint32Array(TONES);
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
  pal[T_STEEL] = word(P.steel1);
  pal[T_BRIGHT] = word(P.steel3);
  pal[T_SHINE] = word(P.bone2);
  palettes.set(color, pal);
  return pal;
}

let dentWords: Uint32Array | null = null;
let burntWords: Uint32Array | null = null;

/**
 * A car's sheet as pixels (0xAABBGGRR), SHEET_W x SHEET_H: cell k is heading k * HEADING_STEP.
 * `state`: WHOLE, DENTED (the damage of a battered car on it) or BURNT (the wreck, open where
 * the car's colour shows through).
 */
export function carPixels(color: string, out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H), look = SPORT, state = WHOLE): Uint32Array {
  const idx = carIndexSheets(look), pal = carPalette(color);
  const car = idx.car;
  if (state === WHOLE) return pixels(car, pal, out);
  const over = state === BURNT ? idx.burnt : idx.dents;
  const tones = state === BURNT ? (burntWords ??= wordsOf(BURNT_TONES)) : (dentWords ??= wordsOf(DAMAGE_TONES.slice(1)));
  for (let i = 0; i < car.length; i++) {
    const o = over[i];
    out[i] = o ? tones[o] : pal[car[i]];
  }
  return out;
}

/** A look's silhouette in black: the cast shadow (drawn at SHADOW_ALPHA) and the dark of a fall. */
export function shadePixels(out: Uint32Array = new Uint32Array(SHEET_W * SHEET_H), look = SPORT): Uint32Array {
  const car = carIndexSheets(look).car;
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
  look: number;
  state: number;
  used: number; // the last frame it was asked for
}

let bytes = 0;
let soft = true;

/**
 * Sprite canvases live where the view canvas lives (as the world's tiles do): in main memory
 * when the view is one that is read back (the benchmark's), so a blit never crosses between
 * main memory and the GPU. The view of the Renderer that is there when the first sheet is made
 * decides: a page builds a Renderer on its own canvas before it draws on another (main.ts
 * does, before the benchmark takes over), and that one must not settle it.
 */
export function spritesFor(view: CanvasRenderingContext2D): void {
  if (!bytes) soft = view.getContextAttributes?.().willReadFrequently !== false;
}

function sheetCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  bytes += w * h * 4;
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: soft })! };
}

// The pixels of one car sheet on their way to its canvas. Kept (0.5 MB, not a canvas): a car's
// sheet is painted again whenever its state changes, in the middle of a race, and a frame
// allocates nothing.
let pixelsOut: ImageData | null = null;
let wordsOut: Uint32Array | null = null;

function sheetWords(): Uint32Array | null {
  if (typeof ImageData === "undefined") return null; // no browser (a Node probe): the canvas stays empty
  if (!pixelsOut) {
    pixelsOut = new ImageData(SHEET_W, SHEET_H);
    wordsOut = new Uint32Array(pixelsOut.data.buffer);
  }
  return wordsOut;
}

const carSheets: CarSheet[] = [];
let clock = 0;

/** A new frame: sheets asked for from now on are in use and are not given to another car. */
export function spriteFrame(): void {
  clock++;
}

/**
 * The sheet of a car: its colour, its look (lookOf) and its state (WHOLE, DENTED, BURNT).
 * Built on first use. With MAX_CAR_SHEETS in use another sheet is painted again as this one:
 * the car's own from before its state changed (a room gives every car a colour of its own),
 * if no car drew from it this frame, else the one unused for longest.
 */
export function carSheet(color: string, look = SPORT, state = WHOLE): HTMLCanvasElement {
  for (let i = 0; i < carSheets.length; i++) {
    const s = carSheets[i];
    if (s.state === state && s.look === look && s.color === color) {
      s.used = clock;
      return s.canvas;
    }
  }
  return newCarSheet(color, look, state);
}

function newCarSheet(color: string, look: number, state: number): HTMLCanvasElement {
  let s: CarSheet;
  if (carSheets.length < MAX_CAR_SHEETS) {
    const made = sheetCanvas(SHEET_W, SHEET_H);
    s = { canvas: made.canvas, ctx: made.ctx, color, look, state, used: clock };
    carSheets.push(s);
  } else {
    let own: CarSheet | null = null;
    s = carSheets[0];
    for (let i = 0; i < carSheets.length; i++) {
      const o = carSheets[i];
      if (o.used < s.used) s = o;
      if (o.color === color && o.used < clock && (!own || o.used < own.used)) own = o;
    }
    if (own) s = own;
    s.color = color;
    s.look = look;
    s.state = state;
    s.used = clock;
  }
  const out = sheetWords();
  if (out) {
    carPixels(color, out, look, state);
    s.ctx.putImageData(pixelsOut!, 0, 0);
  }
  return s.canvas;
}

const shades: (HTMLCanvasElement | null)[] = LOOKS.map(() => null);

/** A look's silhouette sheet, built on first use and kept: three at most. */
export function shadeSheet(look = SPORT): HTMLCanvasElement {
  return shades[look] ?? newShade(look);
}

function newShade(look: number): HTMLCanvasElement {
  const s = sheetCanvas(SHEET_W, SHEET_H);
  const out = sheetWords();
  if (out) {
    shadePixels(out, look);
    s.ctx.putImageData(pixelsOut!, 0, 0);
  }
  return (shades[look] = s.canvas);
}

export interface SharedSheets {
  /** The sport's silhouette, as shadeSheet(SPORT) hands it out. */
  shade: HTMLCanvasElement;
  fx: HTMLCanvasElement;
}

let shared: SharedSheets | null = null;

/** The effect sheet, and the silhouette of the look every room has, built on first use. */
export function sharedSheets(): SharedSheets {
  if (!shared) {
    const fx = sheetCanvas(FX_W, FX_H);
    if (typeof ImageData !== "undefined") {
      const img = new ImageData(FX_W, FX_H);
      fxPixels(new Uint32Array(img.data.buffer));
      fx.ctx.putImageData(img, 0, 0);
    }
    shared = { shade: shadeSheet(SPORT), fx: fx.canvas };
  }
  return shared;
}

/** Canvas memory the sprite sheets hold right now, in bytes. */
export function spriteBytes(): number {
  return bytes;
}

/** The most the sprite sheets can ever hold: every car sheet, a silhouette a look, the effects. As it was with one look. */
export const SPRITE_BYTES_MAX = (MAX_CAR_SHEETS + LOOKS.length) * SHEET_W * SHEET_H * 4 + FX_W * FX_H * 4;
