// "Scrapyard 32": the fixed palette of the polished graphics (PLAN-GFX.md). Every pixel of the
// baked world, the effects and the HUD is one of these 32 colours; the DOM skin mirrors them
// in style.css :root. Cars are the exception: each car colour has three tones of its own
// (carTones), because the six server colours have no ramp here.
//
// Our own palette, not a published one: each entry is taken or derived from a colour the game
// already draws (render.ts PAL and its literals, style.css :root); the comment says which.
// Ramps run dark to light. The sun is top-left: SHADE is the tone a colour takes in a cast
// shadow, LIT the tone of a 1 px sunlit edge. No alpha, no gradients: depth is two or three
// steps of a ramp, or an ordered (BAYER4) dither between two of them in small areas.

export const P = {
  // Soot: warm blacks. Pits, voids, outlines, tyres.
  soot0: "#050403", // PAL.pitDeep #030202: the bottom of a pit
  soot1: "#120e0b", // style.css --bg; PAL.void #0c0a08; the car outline #151210
  soot2: "#1d1a17", // PAL.hazardB (hazard stripes, chevron outline); tyres #1b1b1c
  soot3: "#2a2119", // PAL.rubble; PAL.rim #241c15
  // Dirt: the packed earth of the yard.
  dirt0: "#3b2e23", // PAL.pitWall; dirt in a cast shadow (today's 38% black over PAL.dirt)
  dirt1: "#4e3e2c", // the dark dirt speck #4e3e2c
  dirt2: "#5d4a35", // PAL.dirt
  dirt3: "#6f5a42", // the light dirt specks #6a5640 and #77634a, as one
  // Gravel: the verge. Its lightest step is bone0.
  gravel0: "#655640", // the dark gravel speck
  gravel1: "#7b6a50", // PAL.gravel
  gravel2: "#8f7d61", // the light gravel speck #8d7c61; PAL.edge #8a7d6a
  // Tarmac: warm greys.
  tar0: "#2b2927", // the dark tarmac speck #33302d, one step down: tarmac in shadow
  tar1: "#3b3835", // PAL.asphalt
  tar2: "#48433f", // the light tarmac speck #45413d
  tar3: "#66615a", // the centre dashes as they land today (PAL.dash at 55% over PAL.asphalt)
  // Steel: the one cool ramp. Barriers, ramp plates, junk.
  steel0: "#24282c", // PAL.wallDark; the windscreen #1e2a31
  steel1: "#4b545b", // between the two; the slate junk #3f4a5c
  steel2: "#7c858d", // PAL.wallLight, style.css --steel; PAL.steel #6f777d
  steel3: "#b6bec3", // new: the sunlit edge of steel
  // Rust: the signature ramp. Kerbs, junk, the accent.
  rust0: "#5c2616", // the dark red junk #6b2f2f, warmer: rust in shadow
  rust1: "#9c4419", // style.css --rust-dark
  rust2: "#c4532a", // PAL.kerbA
  rust3: "#e8752d", // PAL.accent, style.css --rust
  // Bone: off-whites. Kerbs, chevrons, text.
  bone0: "#a89981", // style.css --muted-solid; the lightest gravel speck #a29276
  bone1: "#ddd3bd", // PAL.kerbB
  bone2: "#efe6d2", // PAL.hudText, style.css --text; the start line's white #f1ece0
  // Hazard: warning yellow.
  haz0: "#8a6d2a", // the unarmed mine's lamp; the ochre junk #8a5a2b
  haz1: "#e0a526", // PAL.hazardA; the hp bar's amber #e8b83a
  haz2: "#ffe9a8", // the car lamps; the rivet #fff4cf
  // Signals: one of each.
  blast: "#ff9a33", // new: the one blast orange, between rust3 and haz1 and brighter than both
  red: "#e8452d", // the hp bar's red; the armed mine's lamp #ff3b2f
  green: "#7bc95a", // the hp bar's green
} as const;

export type PaletteName = keyof typeof P;

/** The 32 entries in order (the index a baked tile stores). */
export const PALETTE: readonly { name: PaletteName; hex: string }[] = (Object.keys(P) as PaletteName[]).map((name) => ({ name, hex: P[name] }));

/** The ramps, dark to light. bone0 closes the gravel ramp and opens the bone ramp. */
export const RAMPS: Readonly<Record<string, readonly PaletteName[]>> = {
  soot: ["soot0", "soot1", "soot2", "soot3"],
  dirt: ["dirt0", "dirt1", "dirt2", "dirt3"],
  gravel: ["gravel0", "gravel1", "gravel2", "bone0"],
  tarmac: ["tar0", "tar1", "tar2", "tar3"],
  steel: ["steel0", "steel1", "steel2", "steel3"],
  rust: ["rust0", "rust1", "rust2", "rust3"],
  bone: ["bone0", "bone1", "bone2"],
  hazard: ["haz0", "haz1", "haz2"],
  signal: ["blast", "red", "green"],
};

/** A colour in a hard cast shadow (about today's 38% black, kept on the palette). */
export const SHADE: Readonly<Record<PaletteName, PaletteName>> = {
  soot0: "soot0", soot1: "soot0", soot2: "soot1", soot3: "soot1",
  dirt0: "soot3", dirt1: "soot3", dirt2: "dirt0", dirt3: "dirt1",
  gravel0: "dirt0", gravel1: "dirt1", gravel2: "dirt2",
  tar0: "soot2", tar1: "tar0", tar2: "tar0", tar3: "tar1",
  steel0: "soot2", steel1: "steel0", steel2: "steel1", steel3: "steel2",
  rust0: "soot3", rust1: "rust0", rust2: "rust1", rust3: "rust1",
  bone0: "gravel0", bone1: "bone0", bone2: "bone0",
  haz0: "dirt1", haz1: "haz0", haz2: "bone0",
  blast: "rust2", red: "rust1", green: "steel1",
};

/** The 1 px sunlit (top-left) edge of a shape in that colour. */
export const LIT: Readonly<Record<PaletteName, PaletteName>> = {
  soot0: "soot1", soot1: "soot2", soot2: "soot3", soot3: "dirt0",
  dirt0: "dirt1", dirt1: "dirt2", dirt2: "dirt3", dirt3: "gravel1",
  gravel0: "gravel1", gravel1: "gravel2", gravel2: "bone0",
  tar0: "tar1", tar1: "tar2", tar2: "tar3", tar3: "bone0",
  steel0: "steel1", steel1: "steel2", steel2: "steel3", steel3: "bone2",
  rust0: "rust1", rust1: "rust2", rust2: "rust3", rust3: "blast",
  bone0: "bone1", bone1: "bone2", bone2: "bone2",
  haz0: "haz1", haz1: "haz2", haz2: "haz2", // haz2 is the lightest of the 32: its lit tone is itself
  blast: "haz2", red: "blast", green: "haz2",
};

/**
 * style.css :root mirrored: the palette entry each CSS variable takes. Six equal today's CSS
 * value exactly; --line (#4a3a2b), --panel (rgba(22,17,13,0.92)) and --err (#ff8b6b) move
 * onto the palette when GFX-3 applies the mirror (red on soot1 is 4.8:1; GFX-3 judges it).
 */
export const CSS_MIRROR: Readonly<Record<string, PaletteName>> = {
  "--bg": "soot1",
  "--panel": "soot2",
  "--line": "dirt1",
  "--text": "bone2",
  "--muted-solid": "bone0",
  "--rust": "rust3",
  "--rust-dark": "rust1",
  "--steel": "steel2",
  "--err": "red",
};

/** Ordered dither thresholds, 0..15: pixel (x, y) takes the second colour when its share > BAYER4[y & 3][x & 3] / 16. */
export const BAYER4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export type Rgb = [number, number, number];

export function rgbOf(hex: string): Rgb {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.replace(/./g, (c) => c + c) : v;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexOf([r, g, b]: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const RGB: readonly Rgb[] = PALETTE.map((p) => rgbOf(p.hex));

/** Index (into PALETTE) of a name. */
export function indexOf(name: PaletteName): number {
  return PALETTE.findIndex((p) => p.name === name);
}

/** The palette as packed 0xAABBGGRR words (little-endian ImageData), for index-to-pixel blits. */
export function palette32(): Uint32Array {
  return Uint32Array.from(RGB, ([r, g, b]) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
}

let lut: Uint8Array | null = null;

/**
 * Nearest palette index for a colour, through a 15-bit RGB table built on first use. For
 * fills and dither only (bake time): an edge is never snapped with it (PLAN-GFX advisor 3),
 * edges come from per-layer alpha masks.
 */
export function nearest(r: number, g: number, b: number): number {
  if (!lut) {
    lut = new Uint8Array(1 << 15);
    for (let i = 0; i < lut.length; i++) {
      // The cell's centre, back in 8 bits.
      const cr = (((i >> 10) & 31) << 3) | 4, cg = (((i >> 5) & 31) << 3) | 4, cb = ((i & 31) << 3) | 4;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < RGB.length; k++) {
        const dr = cr - RGB[k][0], dg = cg - RGB[k][1], db = cb - RGB[k][2];
        // "Redmean" weights: closer to the eye than plain RGB distance, and cheap.
        const rm = (cr + RGB[k][0]) / 2;
        const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      lut[i] = best;
    }
  }
  return lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
}

// ---- cars -------------------------------------------------------------------------

/** The six car colours, in the server's order (server/room.ts COLORS): the body tone is exactly this. */
export const CAR_COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"] as const;

export interface CarTones {
  shade: string; // the side away from the sun, and the lower body panel
  body: string; // the server colour, untouched (minimap dots and name-tag lines use it too)
  lit: string; // the 1 px sunlit edge and the bonnet highlight
}

/** Neutrals every car shares, all from the palette. */
export const CAR_NEUTRALS = { outline: P.soot1, tyre: P.soot2, glass: P.steel0, glint: P.steel2, lamp: P.haz2 } as const;

/** The shadow side of a sunlit yard leans to violet; the sunlit side to a warm white. */
const SHADOW_TINT: Rgb = [42, 26, 46];
const SUN_TINT: Rgb = [255, 246, 220];

function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * share)) as Rgb;
}

const tones = new Map<string, CarTones>();

/**
 * The three tones of a car colour: the body is the colour itself; the shade is the colour
 * mixed 42% toward a dark violet, the lit tone 45% toward a warm white. Any colour works
 * (the "#888" of a player not known yet); results are cached.
 */
export function carTones(color: string): CarTones {
  let t = tones.get(color);
  if (!t) {
    const body = rgbOf(color);
    t = { shade: hexOf(mix(body, SHADOW_TINT, 0.42)), body: color, lit: hexOf(mix(body, SUN_TINT, 0.45)) };
    tones.set(color, t);
  }
  return t;
}
