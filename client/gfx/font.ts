// The HUD's bitmap font: our own design, drawn here pixel by pixel on a 5x7 grid (capital
// height 7, two rows above for marks, two below the baseline). One master, three cuts:
//
//   SMALL  the master as it is: 5x7 capitals, 1 px strokes, 6 px a letter.
//   BOLD   every pixel also lights the one to its right: 6x7 capitals, 2 px stems, 7 px a
//          letter. A few letters that would clog are drawn for it by hand (BOLD_OWN).
//   TALL   the bold cut with two of its seven rows doubled: 6x9 capitals.
//
// Bigger text is a whole multiple of a cut (the race time, the countdown). A cut becomes a
// sheet of hard pixels per colour, built once and kept (the glyph atlas); print() copies
// letters out of it. It is called only to fill a cached label (client/gfx/hud.ts), never
// per frame.
//
// Covered: ASCII, Latin-1 (æøå and the other western European letters), Ÿ, the dotless i,
// and – — … ‘ ’ “ ”. covers() says whether a text can be printed; one that cannot (a name in
// another script) is drawn by the caller with the system font, that label only.

import { rgbOf } from "./palette";

/**
 * The master: a letter's rows, top to bottom, 5 wide. Seven rows reach from the capital
 * height to the baseline; nine go two rows below it. Lowercase letters are five rows high
 * (rows 2-6). Round shapes are flat-sided with one cut corner pixel; A has a flat top, 4 an
 * open one; Q carries its tail below the baseline: all of these stay clear when made bold.
 * The zero has a dot in it, so it is no O; V tapers over its lower three rows, so it is no U.
 */
const MASTER: Record<string, string> = {
  "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
  '"': ".#.#. .#.#. ..... ..... ..... ..... .....",
  "#": ".#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.",
  $: "..#.. .#### #.#.. .###. ..#.# ####. ..#..",
  "%": "##..# ##.#. ...#. ..#.. .#... .#.## #..##",
  "&": ".##.. #..#. #.#.. .#... #.#.# #..#. .##.#",
  "'": "..#.. ..#.. ..... ..... ..... ..... .....",
  "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.",
  ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
  "*": "..... ..#.. #.#.# .###. #.#.# ..#.. .....",
  "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
  ",": "..... ..... ..... ..... ..... ..... ..#.. .#... .....",
  "-": "..... ..... ..... .###. ..... ..... .....",
  ".": "..... ..... ..... ..... ..... ..... ..#..",
  "/": "....# ...#. ...#. ..#.. .#... .#... #....",
  "0": ".###. #...# #...# #.#.# #...# #...# .###.",
  "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
  "2": ".###. #...# ....# ...#. ..#.. .#... #####",
  "3": ".###. #...# ....# ..##. ....# #...# .###.",
  "4": "#..#. #..#. #..#. ##### ...#. ...#. ...#.",
  "5": "##### #.... ####. ....# ....# #...# .###.",
  "6": ".###. #.... #.... ####. #...# #...# .###.",
  "7": "##### ....# ...#. ..#.. ..#.. ..#.. ..#..",
  "8": ".###. #...# #...# .###. #...# #...# .###.",
  "9": ".###. #...# #...# .#### ....# ....# .###.",
  ":": "..... ..#.. ..... ..... ..... ..#.. .....",
  ";": "..... ..#.. ..... ..... ..... ..... ..#.. .#... .....",
  "<": "..... ...#. ..#.. .#... ..#.. ...#. .....",
  "=": "..... ..... ##### ..... ##### ..... .....",
  ">": "..... .#... ..#.. ...#. ..#.. .#... .....",
  "?": ".###. #...# ....# ...#. ..#.. ..... ..#..",
  "@": ".###. #...# #.### #.#.# #.### #.... .####",
  A: ".###. #...# #...# ##### #...# #...# #...#",
  B: "####. #...# #...# ####. #...# #...# ####.",
  C: ".#### #.... #.... #.... #.... #.... .####",
  D: "####. #...# #...# #...# #...# #...# ####.",
  E: "##### #.... #.... ####. #.... #.... #####",
  F: "##### #.... #.... ####. #.... #.... #....",
  G: ".#### #.... #.... #..## #...# #...# .####",
  H: "#...# #...# #...# ##### #...# #...# #...#",
  I: ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  J: "..### ....# ....# ....# ....# #...# .###.",
  K: "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
  L: "#.... #.... #.... #.... #.... #.... #####",
  M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
  N: "#...# ##..# #.#.# #.#.# #..## #...# #...#",
  O: ".###. #...# #...# #...# #...# #...# .###.",
  P: "####. #...# #...# ####. #.... #.... #....",
  Q: ".###. #...# #...# #...# #...# #...# .###. ...## .....",
  R: "####. #...# #...# ####. #.#.. #..#. #...#",
  S: ".#### #.... #.... .###. ....# ....# ####.",
  T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  U: "#...# #...# #...# #...# #...# #...# .###.",
  V: "#...# #...# #...# #...# .#.#. .#.#. ..#..",
  W: "#...# #...# #...# #.#.# #.#.# ##.## #...#",
  X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
  Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
  Z: "##### ....# ...#. ..#.. .#... #.... #####",
  "[": ".##.. .#... .#... .#... .#... .#... .##..",
  "\\": "#.... .#... .#... ..#.. ...#. ...#. ....#",
  "]": "..##. ...#. ...#. ...#. ...#. ...#. ..##.",
  "^": "..#.. .#.#. #...# ..... ..... ..... .....",
  _: "..... ..... ..... ..... ..... ..... ..... ##### .....",
  "`": ".#... ..#.. ..... ..... ..... ..... .....",
  a: "..... ..... .###. ....# .#### #...# .####",
  b: "#.... #.... ####. #...# #...# #...# ####.",
  c: "..... ..... .#### #.... #.... #.... .####",
  d: "....# ....# .#### #...# #...# #...# .####",
  e: "..... ..... .###. #...# ##### #.... .####",
  f: "..##. .#... ###.. .#... .#... .#... .#...",
  g: "..... ..... .#### #...# #...# #...# .#### ....# .###.",
  h: "#.... #.... ####. #...# #...# #...# #...#",
  i: "..#.. ..... .##.. ..#.. ..#.. ..#.. .###.",
  j: "...#. ..... ..##. ...#. ...#. ...#. ...#. #..#. .##..",
  k: "#.... #.... #..#. #.#.. ##... #.#.. #..#.",
  l: ".##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  m: "..... ..... ##.#. #.#.# #.#.# #.#.# #.#.#",
  n: "..... ..... ####. #...# #...# #...# #...#",
  o: "..... ..... .###. #...# #...# #...# .###.",
  p: "..... ..... ####. #...# #...# #...# ####. #.... #....",
  q: "..... ..... .#### #...# #...# #...# .#### ....# ....#",
  r: "..... ..... #.##. ##... #.... #.... #....",
  s: "..... ..... .#### #.... .###. ....# ####.",
  t: ".#... .#... ####. .#... .#... .#... ..##.",
  u: "..... ..... #...# #...# #...# #...# .####",
  v: "..... ..... #...# #...# #...# .#.#. ..#..",
  w: "..... ..... #...# #...# #.#.# #.#.# .#.#.",
  x: "..... ..... #...# .#.#. ..#.. .#.#. #...#",
  y: "..... ..... #...# #...# #...# #...# .#### ....# .###.",
  z: "..... ..... ##### ...#. ..#.. .#... #####",
  "{": "...## ..#.. ..#.. .#... ..#.. ..#.. ...##",
  "|": "..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  "}": "##... ..#.. ..#.. ...#. ..#.. ..#.. ##...",
  "~": "..... ..... .#... #.#.# ...#. ..... .....",
  // Latin-1, the signs
  "¡": "..#.. ..... ..#.. ..#.. ..#.. ..#.. ..#..",
  "¢": "..#.. .#### #.#.. #.#.. #.#.. .#### ..#..",
  "£": "..##. .#..# .#... ###.. .#... .#... #####",
  "¤": "..... #...# .###. .#.#. .###. #...# .....",
  "¥": "#...# .#.#. ##### ..#.. ##### ..#.. ..#..",
  "¦": "..#.. ..#.. ..#.. ..... ..#.. ..#.. ..#..",
  "§": ".#### #.... .###. #...# .###. ....# ####.",
  "¨": ".#.#. ..... ..... ..... ..... ..... .....",
  "©": ".###. #...# #.### #.#.. #.### #...# .###.",
  "ª": ".##.. ...#. .###. #..#. .###. ..... ####.",
  "«": "..... ..#.# .#.#. #.#.. .#.#. ..#.# .....",
  "¬": "..... ..... ..... ##### ....# ..... .....",
  "\u00ad": "..... ..... ..... .###. ..... ..... .....",
  "®": ".###. #...# ###.# #.#.# ###.# #.#.# .###.",
  "¯": "##### ..... ..... ..... ..... ..... .....",
  "°": ".##.. #..#. #..#. .##.. ..... ..... .....",
  "±": "..#.. ..#.. ##### ..#.. ..#.. ..... #####",
  "²": "##... ..#.. .#... ###.. ..... ..... .....",
  "³": "###.. ..#.. .##.. ..#.. ###.. ..... .....",
  "´": "...#. ..#.. ..... ..... ..... ..... .....",
  µ: "..... ..... #...# #...# #...# #..## ###.# #.... #....",
  "¶": ".#### ###.# ###.# .##.# ..#.# ..#.# ..#.#",
  "·": "..... ..... ..... ..#.. ..... ..... .....",
  "¸": "..... ..... ..... ..... ..... ..... ..... ..#.. .##..",
  "¹": ".#... ##... .#... ###.. ..... ..... .....",
  º: ".##.. #..#. #..#. .##.. ..... ..... ####.",
  "»": "..... #.#.. .#.#. ..#.# .#.#. #.#.. .....",
  "¼": "#...# #..#. ..#.. .#.#. #.##. ..### ...#.",
  "½": "#...# #..#. ..#.. .#.## #...# ...#. ..###",
  "¾": "##..# .#.#. ###.. .#.#. #.##. ..### ...#.",
  "¿": "..#.. ..... ..#.. .#... #.... #...# .###.",
  "×": "..... #...# .#.#. ..#.. .#.#. #...# .....",
  "÷": "..... ..#.. ..... ##### ..... ..#.. .....",
  // Latin-1, the letters that are no letter with a mark
  Æ: ".#### #.#.. #.#.. ####. #.#.. #.#.. #.###",
  Ð: ".###. .#..# .#..# ###.# .#..# .#..# .###.",
  Ø: ".###. #..## #..## #.#.# ##..# ##..# .###.",
  Þ: "#.... ####. #...# #...# ####. #.... #....",
  ß: ".##.. #..#. #..#. #.#.. #..#. #...# #.##.",
  æ: "..... ..... ##.#. ..#.# .#### #.#.. .#.##",
  ð: ".#.#. ..#.. .#.#. ....# .#### #...# .###.",
  ø: "..... ..... .###. #..## #.#.# ##..# .###.",
  þ: "#.... #.... ####. #...# #...# #...# ####. #.... #....",
  ı: "..... ..... .##.. ..#.. ..#.. ..#.. .###.",
  // Punctuation beyond Latin-1 that the HUD's own lines use, and the curly quotes
  "–": "..... ..... ..... ##### ..... ..... .....",
  "—": "..... ..... ..... ##### ..... ..... .....",
  "…": "..... ..... ..... ..... ..... ..... #.#.#",
  "‘": "...#. ..#.. ..#.. ..... ..... ..... .....",
  "’": "..#.. ..#.. .#... ..... ..... ..... .....",
  "“": "..#.# .#.#. .#.#. ..... ..... ..... .....",
  "”": ".#.#. .#.#. #.#.. ..... ..... ..... .....",
};

/**
 * The bold cut's own drawings, 6 wide, for the letters whose strokes would run together
 * when every pixel lights its right neighbour (M, N, W, m, w, ø, æ, the busy signs), and two
 * that need another way to stay themselves: the zero is narrow with a slit (a dot would
 * close its two-pixel counter and make an 8 of it), V thins to a point (thickened, it is a U).
 */
const BOLD_OWN: Record<string, string> = {
  '"': "##.##. ##.##. ...... ...... ...... ...... ......",
  "#": "...... .#..#. ###### .#..#. ###### .#..#. ......",
  "%": "##...# ##..#. ...##. ..##.. .##... .#..## #...##",
  "&": ".###.. ##.##. ##.##. .###.. ##.### ##.##. .###.#",
  "*": "...... ..##.. #.##.# .####. #.##.# ..##.. ......",
  "@": ".####. ##..## ##.### ##.#.# ##.### ##.... .#####",
  "~": "...... ...... .##..# #..##. ...... ...... ......",
  "0": ".###.. ##.##. ##.##. ##.##. ##.##. ##.##. .###..",
  M: "##..## ###### ##..## ##..## ##..## ##..## ##..##",
  V: "##..## ##..## ##..## .#..#. .#..#. ..##.. ..##..",
  N: "##..## ###.## ###.## ###### ##.### ##.### ##..##",
  W: "##..## ##..## ##..## ##..## ##..## ###### ##..##",
  m: "...... ...... #####. ##.#.# ##.#.# ##.#.# ##.#.#",
  w: "...... ...... ##.#.# ##.#.# ##.#.# ##.#.# .##.#.",
  Æ: "..#### .#.#.. #..#.. #####. #..#.. #..#.. #..###",
  Ø: ".##### ##.### ##.### ##.### ###.## ###.## #####.",
  æ: "...... ...... ##.##. ..#..# .##### #.#... .#.###",
  ø: "...... ...... .##### ##.### ###.## ###.## #####.",
  "¤": "...... #....# .####. .#..#. .####. #....# ......",
  "©": ".####. #....# #.##.# #.#..# #.##.# #....# .####.",
  "«": "...... ..#..# .#..#. #..#.. .#..#. ..#..# ......",
  "®": ".####. #....# #.##.# #.##.# #.#.## #....# .####.",
  "»": "...... #..#.. .#..#. ..#..# .#..#. #..#.. ......",
  "…": "...... ...... ...... ...... ...... ...... #.#.#.",
  "“": "..#..# .#..#. .#..#. ...... ...... ...... ......",
  "”": ".#..#. .#..#. #..#.. ...... ...... ...... ......",
};

/** Letter with a mark: the letter, its base, the mark (g grave, a acute, c circumflex, t tilde, d dots, r ring, z cedilla). */
const MARKED =
  "ÀAg ÁAa ÂAc ÃAt ÄAd ÅAr ÇCz ÈEg ÉEa ÊEc ËEd ÌIg ÍIa ÎIc ÏId ÑNt ÒOg ÓOa ÔOc ÕOt ÖOd ÙUg ÚUa ÛUc ÜUd ÝYa ŸYd " +
  "àag áaa âac ãat äad åar çcz èeg éea êec ëed ìıg íıa îıc ïıd ñnt òog óoa ôoc õot öod ùug úua ûuc üud ýya ÿyd";

/**
 * The marks, [regular, bold]. Over a capital a mark sits on the letter (two rows; the ring
 * is closed by the letter's flat top; the dots keep a row of air). Over a small letter it
 * floats one row above (the ring takes three rows).
 */
const OVER_CAPITAL: Record<string, [string, string]> = {
  g: [".#... ..#..", ".##... ..##.."],
  a: ["...#. ..#..", "...##. ..##.."],
  c: ["..#.. .#.#.", "..##.. .#..#."],
  t: [".#..# #.##.", ".##..# #..##."],
  d: [".#.#. .....", "##..## ......"],
  r: [".###. .#.#.", ".####. .#..#."],
};
const OVER_SMALL: Record<string, [string, string]> = {
  ...OVER_CAPITAL,
  d: ["..... .#.#.", "...... ##..##"],
  r: ["..#.. .#.#. ..#..", "..##.. .#..#. ..##.."],
};
const CEDILLA: [string, string] = ["..#.. .##..", "..##.. .###.."];

/** The two rows of the seven that the tall cut doubles; a letter with a dot doubles the dot's row, V its taper. */
const DOUBLED: Record<string, [number, number]> = { ".": [1, 6], ",": [1, 6], "!": [1, 6], "?": [1, 6], ";": [1, 6], V: [1, 3], i: [0, 5], j: [0, 5] };
const DOUBLED_ELSE: [number, number] = [1, 5];

const MARKS = 2; // rows above the capital height
const BELOW = 2; // rows below the baseline
const X_ROW = 2; // the master row where a small letter starts
const COLS = 16; // letters per row of a sheet

export interface Strike {
  /** Width of a letter's cell: the letter and the pixel of air after it. */
  readonly cw: number;
  /** Height of the cell: MARKS rows, the capital height, BELOW rows. */
  readonly ch: number;
  /** Rows of the cell above the capital height. */
  readonly capTop: number;
  /** The capital height. */
  readonly cap: number;
  /** One byte a pixel, 1 = ink: letter k's cell starts at k * cw * ch. */
  readonly bits: Uint8Array;
  /** The sheets made so far, by colour: [for a view canvas on the GPU side, for one in main memory]. */
  readonly sheets: readonly [Map<string, HTMLCanvasElement>, Map<string, HTMLCanvasElement>];
}

type Grid = Uint8Array[]; // rows of 0 / 1

function grid(rows: string, w: number, h: number, at: number): Grid {
  const g: Grid = Array.from({ length: h }, () => new Uint8Array(w));
  rows.split(" ").forEach((row, r) => {
    for (let x = 0; x < row.length && x < w; x++) if (row[x] === "#") g[at + r][x] = 1;
  });
  return g;
}

/** Every pixel also lights its right neighbour. */
function embolden(g: Grid): Grid {
  return g.map((row) => {
    const out = new Uint8Array(row.length + 1);
    for (let x = 0; x < row.length; x++) if (row[x]) out[x] = out[x + 1] = 1;
    return out;
  });
}

/** Stamp a mark's rows onto a letter, its top row at `top`. */
function stamp(g: Grid, rows: string, top: number): void {
  rows.split(" ").forEach((row, r) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") g[top + r][x] = 1;
  });
}

/** The letters in sheet order: the space first, then everything drawn. */
const LETTERS = [" ", "\u00a0", ...Object.keys(MASTER), ...MARKED.split(" ").map((m) => m[0])];

const LAST_CODE = 0x2030;
const INDEX = new Int16Array(LAST_CODE).fill(-1);
LETTERS.forEach((l, k) => (INDEX[l.charCodeAt(0)] = k));

function build(bold: boolean, tall: boolean): Strike {
  const gw = bold ? 6 : 5;
  const cap = tall ? 9 : 7;
  const cw = gw + 1, ch = MARKS + cap + BELOW;
  const which = bold ? 1 : 0;
  const marked = new Map(MARKED.split(" ").map((m) => [m[0], m]));
  const bits = new Uint8Array(LETTERS.length * cw * ch);

  /** A drawn letter in this cut, as rows 0..8 of the master (7 + BELOW), widened and stretched. */
  const letter = (l: string): Grid => {
    let g: Grid;
    if (bold && BOLD_OWN[l]) g = grid(BOLD_OWN[l], gw, 7 + BELOW, 0);
    else {
      g = grid(MASTER[l], 5, 7 + BELOW, 0);
      if (bold) g = embolden(g);
    }
    if (!tall) return g;
    const [a, b] = DOUBLED[l] ?? DOUBLED_ELSE;
    const out: Grid = [];
    g.forEach((row, r) => {
      out.push(row);
      if (r === a || r === b) out.push(row);
    });
    return out;
  };

  LETTERS.forEach((l, k) => {
    const cell: Grid = Array.from({ length: ch }, () => new Uint8Array(cw));
    const put = (g: Grid, top: number) => g.forEach((row, r) => row.forEach((v, x) => v && (cell[top + r][x] = 1)));
    const m = marked.get(l);
    if (m) {
      const base = m[1], mark = m[2];
      put(letter(base), MARKS);
      if (mark === "z") stamp(cell, CEDILLA[which], MARKS + cap);
      else if (base === base.toUpperCase() && base !== "ı") stamp(cell, OVER_CAPITAL[mark][which], 0);
      else {
        // One row of air over the small letter, the mark above it.
        const rows = OVER_SMALL[mark][which];
        const xTop = MARKS + X_ROW + (tall ? 1 : 0);
        stamp(cell, rows, xTop - 1 - rows.split(" ").length);
      }
    } else if (MASTER[l]) put(letter(l), MARKS);
    // The long dash runs through the air after it.
    if (l === "—") for (const row of cell) row[cw - 1] = row[cw - 2];
    cell.forEach((row, y) => bits.set(row, (k * ch + y) * cw));
  });
  return { cw, ch, capTop: MARKS, cap, bits, sheets: [new Map(), new Map()] };
}

export const SMALL: Strike = build(false, false);
export const TALL: Strike = build(true, true);
export const BOLD: Strike = build(true, false);

/** The sheet's letters, in order: with a cut's bits, all a specimen sheet needs. */
export const FONT_LETTERS: readonly string[] = LETTERS;

/** Whether every character of the text is in the font. */
export function covers(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= LAST_CODE || INDEX[c] < 0) return false;
  }
  return true;
}

/** Width in pixels of a text in a cut at a whole-number scale (without the air after the last letter). */
export function widthOf(text: string, s: Strike, scale = 1): number {
  return text.length ? (text.length * s.cw - 1) * scale : 0;
}

/**
 * A canvas for baked HUD art, with its context. `soft`: kept in main memory, as a view canvas
 * that is read back is (the benchmark's). Baked art is always of its view canvas's kind: a
 * view canvas in main memory that draws from art on the GPU side pays about a quarter of a
 * millisecond a frame for it (measured in Chrome 152).
 */
export function artCanvas(w: number, h: number, soft: boolean): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: soft })!;
  g.imageSmoothingEnabled = false;
  return g;
}

/** The glyph atlas of a cut in a colour (#rrggbb): hard pixels, built on first use and kept. */
function sheetOf(s: Strike, color: string, soft: boolean): HTMLCanvasElement {
  const sheets = s.sheets[soft ? 1 : 0];
  let sheet = sheets.get(color);
  if (!sheet) {
    const rows = Math.ceil(LETTERS.length / COLS);
    const g = artCanvas(COLS * s.cw, rows * s.ch, soft);
    const img = g.createImageData(COLS * s.cw, rows * s.ch);
    const px = new Uint32Array(img.data.buffer);
    const [r, gr, b] = rgbOf(color);
    const ink = (0xff000000 | (b << 16) | (gr << 8) | r) >>> 0;
    for (let k = 0; k < LETTERS.length; k++) {
      const x0 = (k % COLS) * s.cw, y0 = Math.floor(k / COLS) * s.ch;
      for (let y = 0; y < s.ch; y++) {
        for (let x = 0; x < s.cw; x++) if (s.bits[(k * s.ch + y) * s.cw + x]) px[(y0 + y) * img.width + x0 + x] = ink;
      }
    }
    g.putImageData(img, 0, 0);
    sheet = g.canvas;
    sheets.set(color, sheet);
  }
  return sheet;
}

/**
 * Print a text the font covers onto baked art (`soft`: as it was made): the first cell's
 * top-left at (x, y), each pixel `scale` pixels big. The capital height starts
 * s.capTop * scale below y.
 */
export function print(g: CanvasRenderingContext2D, soft: boolean, text: string, x: number, y: number, s: Strike, color: string, scale = 1): void {
  const sheet = sheetOf(s, color, soft);
  const cw = s.cw, ch = s.ch;
  for (let i = 0; i < text.length; i++) {
    const k = INDEX[text.charCodeAt(i)];
    if (k > 0) g.drawImage(sheet, (k % COLS) * cw, ((k / COLS) | 0) * ch, cw, ch, x + i * cw * scale, y, cw * scale, ch * scale);
  }
}
