// A track's surroundings (PLAN-THEMES.md): which theme a track has, and what a theme's tiles,
// dust and obstacle sprites are made with (its "scenery").
//
// - The theme is fixed per track, in its definition. Until THEME-SCHEMA adds the typed field to
//   shared/track.ts, themeOf() reads the optional `def.theme` here, in one place, and holds it
//   against isTheme: an absent or unknown one is the scrapyard. (TH-LOOK-2 swaps to shared/theme.ts.)
// - The Renderer resolves a track's scenery once, as it is built, and hands it to the World, the
//   Actors and the Obstacles. A theme whose art has not landed draws as the scrapyard.
// - A theme changes what is painted, never where: the bands of the road, the posts' spacing,
//   the outlines of the features and all that a car feels are shared code.
// - The palette tables belong to a theme, and a baked tile keeps its own theme's: the tile pool
//   holds tiles of several tracks at a time (gfx/world.ts), so no table is "the" table.
//
// The game never asks for another theme than the track's own. themedTrack() is the preview's and
// the benchmark's `&theme=` switch and the contact sheet's: the same road with another theme.

import type { Track } from "../../shared/track";
import { DESERT_PALETTE, P, PALETTE, rgbOf, SCRAPYARD, SCRAPYARD_PALETTE, type PaletteName, type ThemePalette } from "./palette";

export type Theme = "scrapyard" | "desert" | "city" | "jungle";
export const THEMES: readonly Theme[] = ["scrapyard", "desert", "city", "jungle"];

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** A track's theme: its definition's, or the scrapyard when it names none (or one nobody knows). */
export function themeOf(track: Track): Theme {
  // The one cast: TrackDef has no `theme` yet (THEME-SCHEMA adds it; this compiles before and after).
  const named = (track.def as { theme?: unknown }).theme;
  return isTheme(named) ? named : "scrapyard";
}

// ---- a theme's scenery ------------------------------------------------------------------

/** Palette indices a tile's pixel can hold: the 32, `water`, and a theme's extras (pixels that take no marks). */
export const COLOURS = 64;
/** On a tile's byte: the pixel takes no track marks; its low six bits are then all colour (gfx/world.ts). */
export const KEEP_OFF = 0x80;

/** The tones of a round thing lit from the top-left, as the obstacle sheet paints one: its far edge, its shade, its body, its lit side. Global palette names. */
export type Tones = readonly [PaletteName, PaletteName, PaletteName, PaletteName];

/** What moves on the road, in a theme's choice of the global 32 (the obstacle sheet is no baked tile: it has the effects' palette). */
export interface ObstacleTones {
  barrel: { rims: Tones; hoops: Tones; label: Tones; seam: Tones; body: Tones };
  /** A press's slab: its outline, its edge in the sun and away from it, the two stripes of its top. */
  slab: { outline: PaletteName; lit: PaletteName; dark: PaletteName; stripeA: PaletteName; stripeB: PaletteName };
}

export interface Scenery {
  /** 0 = the scrapyard; gfx/world.ts picks a theme's dressing by it. */
  id: number;
  theme: Theme;
  palette: ThemePalette;
  /** Per palette index its name and colour ("" = no colour of this theme), and the way back. */
  names: readonly string[];
  hex: readonly string[];
  index: Readonly<Record<string, number>>;
  /** Indices in use: the 32, `water`, the extras. */
  count: number;
  /** Index to pixel (0xAABBGGRR), and the same by a tile's byte with or without KEEP_OFF. */
  pal32: Uint32Array;
  palOff: Uint32Array;
  /** A colour in a cast shadow and on a sunlit edge, for every index. */
  shadeI: Uint8Array;
  litI: Uint8Array;
  /** Track marks: by level * 32 + colour (the 32), the index shown; and by a tile's whole byte, the index and the pixel shown. */
  marked: Uint8Array;
  shownI: Uint8Array;
  shown: Uint32Array;
  /** The dust a car throws up off the tarmac: young specks, old ones. */
  dust: readonly [string, string];
  /** A tile that is on screen before it is baked: the ground's plain colour. */
  plain: string;
  obstacles: ObstacleTones;
}

const SCRAPYARD_OBSTACLES: ObstacleTones = {
  barrel: {
    rims: ["soot2", "soot3", "soot3", "dirt0"],
    hoops: ["steel0", "steel1", "steel2", "steel3"],
    label: ["bone0", "bone0", "bone1", "bone2"],
    seam: ["soot3", "rust0", "rust0", "rust1"],
    body: ["rust0", "rust1", "rust2", "rust3"],
  },
  slab: { outline: "soot1", lit: "steel3", dark: "steel0", stripeA: "haz1", stripeB: "soot2" },
};

// The desert's: scoured drums (bare steel the sand has blasted, rusted hoops, what is left of a
// label) and an ore stamp (a block of red oxide; its top keeps the hazard stripes).
const DESERT_OBSTACLES: ObstacleTones = {
  barrel: {
    rims: ["soot2", "soot3", "soot3", "dirt0"],
    hoops: ["rust0", "rust0", "rust1", "rust2"],
    label: ["bone0", "bone0", "bone1", "bone1"],
    seam: ["soot3", "steel0", "steel0", "steel1"],
    body: ["steel0", "steel1", "steel2", "steel3"],
  },
  slab: { outline: "soot1", lit: "rust2", dark: "rust0", stripeA: "haz1", stripeB: "soot2" },
};

/** The themes whose art has landed, in the order of their ids. */
const LANDED: readonly { theme: Theme; palette: ThemePalette; dust: readonly [PaletteName, PaletteName]; obstacles: ObstacleTones }[] = [
  { theme: "scrapyard", palette: SCRAPYARD_PALETTE, dust: ["bone1", "bone0"], obstacles: SCRAPYARD_OBSTACLES },
  { theme: "desert", palette: DESERT_PALETTE, dust: ["dirt3", "dirt1"], obstacles: DESERT_OBSTACLES },
];

function build(id: number): Scenery {
  const { theme, palette, dust, obstacles } = LANDED[id];
  const names: string[] = new Array<string>(COLOURS).fill("");
  const hex: string[] = new Array<string>(COLOURS).fill("");
  PALETTE.forEach((e, i) => {
    names[i] = e.name;
    hex[i] = palette.colours[e.name];
  });
  if (PALETTE.length + palette.extras.length > COLOURS) throw new Error(`gfx/theme.ts: ${theme} has more colours than a tile's byte holds`);
  palette.extras.forEach((e, k) => {
    names[PALETTE.length + k] = e.name;
    hex[PALETTE.length + k] = e.hex;
  });
  const count = PALETTE.length + palette.extras.length;
  const index: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    if (names[i] in index) throw new Error(`gfx/theme.ts: ${theme} names ${names[i]} twice`);
    index[names[i]] = i;
  }
  const at = (name: string): number => {
    const i = index[name];
    if (i === undefined) throw new Error(`gfx/theme.ts: ${theme} has no colour ${name}`);
    return i;
  };
  // Index to pixel: packed 0xAABBGGRR words (little-endian ImageData), as palette.ts palette32() packs them.
  const pal32 = new Uint32Array(COLOURS);
  for (let i = 0; i < count; i++) {
    const [r, g, b] = rgbOf(hex[i]);
    pal32[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  const palOff = new Uint32Array(256);
  for (let c = 0; c < COLOURS; c++) palOff[c] = palOff[c | KEEP_OFF] = pal32[c];
  // SHADE and LIT for every index a pixel can hold: a shadow falls on extras as on the 32.
  const shadeI = new Uint8Array(COLOURS), litI = new Uint8Array(COLOURS);
  PALETTE.forEach((e, i) => {
    shadeI[i] = at(palette.shade[e.name]);
    litI[i] = at(palette.lit[e.name]);
  });
  palette.extras.forEach((e, k) => {
    shadeI[PALETTE.length + k] = at(e.shade);
    litI[PALETTE.length + k] = at(e.lit);
  });
  // Track marks. A marked pixel shows, by how deeply it is marked: 1 = its colour's cast-shadow
  // tone (soot, rubber), 2 = singed, 3 = charred; the burnt tones by how light the colour is, so
  // that paint and kerb stripes still show through, and never lighter than the level before.
  const lum = Float64Array.from(pal32, (v) => 0.299 * (v & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * ((v >> 16) & 255));
  const darker = (a: number, b: number): number => (lum[b] < lum[a] ? b : a);
  const singedOf = palette.burn.singed.map(at), charredOf = palette.burn.charred.map(at);
  const marked = new Uint8Array(128);
  for (let c = 0; c < SCRAPYARD; c++) {
    const l = lum[c];
    const band = l < 45 ? 0 : l < 85 ? 1 : l < 150 ? 2 : 3;
    const soot = shadeI[c];
    const singed = darker(soot, singedOf[band]);
    const charred = darker(singed, charredOf[band]);
    marked[c] = c;
    marked[32 + c] = soot;
    marked[64 + c] = singed;
    marked[96 + c] = charred;
  }
  // What a tile's byte shows, by the whole byte. Under KEEP_OFF nothing is marked, and bits 5
  // and 6 are then not a mark's level but part of the colour: `water` and the extras.
  const shownI = Uint8Array.from({ length: 256 }, (_, v) => (v & KEEP_OFF ? v & 63 : marked[v]));
  const shown = Uint32Array.from(shownI, (c) => pal32[c]);
  return {
    id, theme, palette, names, hex, index, count, pal32, palOff, shadeI, litI, marked, shownI, shown,
    dust: [palette.colours[dust[0]], palette.colours[dust[1]]],
    plain: palette.colours.dirt2,
    obstacles,
  };
}

const built: (Scenery | undefined)[] = [];

/** The scenery of a theme: its tables, made once. A theme whose art has not landed has the scrapyard's. */
export function sceneryOf(theme: Theme): Scenery {
  let id = LANDED.findIndex((e) => e.theme === theme);
  if (id < 0) id = 0;
  return built[id] ?? (built[id] = build(id));
}

/** The scenery a track's own theme asks for. */
export function sceneryFor(track: Track): Scenery {
  return sceneryOf(themeOf(track));
}

/** Has a theme's art landed (else it draws as the scrapyard)? */
export function hasArt(theme: Theme): boolean {
  return LANDED.some((e) => e.theme === theme);
}

// ---- the override -----------------------------------------------------------------------

const copies = new WeakMap<Track, Map<Theme, Track>>();

/**
 * The same road with another theme: a copy of the track object whose definition names `theme`
 * (the arrays are the track's own; nothing is built again). For the preview's and the
 * benchmark's `&theme=` switch and for contact sheets, never for the game: a track's theme is
 * its definition's. Everything the renderer keeps per track (the world's art and tiles, the
 * obstacle sprites, the track marks) is keyed by the track object, so the copy has its own of
 * each: its art is keyed by track and theme. One copy per track and theme, whoever asks.
 */
export function themedTrack(track: Track, theme: Theme): Track {
  if (themeOf(track) === theme) return track;
  let byTheme = copies.get(track);
  if (!byTheme) copies.set(track, (byTheme = new Map()));
  let copy = byTheme.get(theme);
  if (!copy) {
    copy = Object.assign({}, track, { def: Object.assign({}, track.def, { theme }) });
    byTheme.set(theme, copy);
  }
  return copy;
}

/** The scrapyard's `water` is every theme's: exported for checks. */
export const WATER_HEX = P.water;
