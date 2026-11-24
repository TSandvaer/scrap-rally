// A theme on paper (TH-LOOK-1; PLAN-THEMES.md): its contact sheet, and the rules every theme is
// held to. No browser: the sheet is made of tiles the game's own bake made (client/gfx/world.ts
// bakeTileIndices), turned into pixels with the theme's own table.
//
//   npx tsx tools/debug/theme-sheet.ts                    the desert's contact sheet -> tmp/th-look/desert-sheet.png
//   npx tsx tools/debug/theme-sheet.ts --theme scrapyard  ... another theme's (the same places, for comparison)
//   npx tsx tools/debug/theme-sheet.ts --out file.png
//   npx tsx tools/debug/theme-sheet.ts --check            no picture: the checks below, exit code 1 if one fails
//   npx tsx tools/debug/theme-sheet.ts --contrast         the readability table alone (part of --check)
//   npx tsx tools/debug/theme-sheet.ts --hash [--root d]  the scrapyard's identity: a sha256 per track over what the
//                                                         bake and the obstacle sheet come to (see below)
//   npx tsx tools/debug/theme-sheet.ts --surfaces         the theme surfaces' sheet: sand, oil and the ford -> tmp/th-look/surfaces-sheet.png
//   npx tsx tools/debug/theme-sheet.ts --ford             the ford's own sheet (TH-LOOK-3): both ways its stream can run -> tmp/th-look/ford-sheet.png
//   npx tsx tools/debug/theme-sheet.ts --shots            the override's screenshots and the theme's own yard's, in headless
//                                                         Chrome -> tmp/th-look/shots/ (--theme, --out <dir>, --port <n>:
//                                                         default 3017, --session <name>, --only <start of a shot's name>)
//   npx tsx tools/debug/theme-sheet.ts --alloc            rule 1 per theme: bytes a frame allocates, no browser
//                                                         (--warm 30000, --frames 6000, --interval 128)
//
// The sheet: the theme's palette (every colour with its cast-shadow and its sunlit tone, the
// burn's three depths on each of the 32); the road's bands on a straight and in a bend; the
// ground; the props outside the walls; a gap's void, a gap filled with scrap, a pit; every
// piece of the road's furniture (a pool, a dirt patch, a belt, the barrels' lane, a press's
// bed, a mound, an island and its nose, the ramp truck); track marks on every ground; the
// barrels and a press's slab as the obstacle sheet holds them for the theme. The places are
// on Crusher Run, Overpass Knot and Preview Yard with the theme switched (gfx/theme.ts
// themedTrack) and on the furniture sheet's own yard (world-sheet/yard.ts).
//
// --check, for every theme whose art has landed:
// - the tables: the 32 role names and `water` first, in the order of the palette; the FIXED
//   names in exactly the scrapyard's colours (water with them); no colour twice under two
//   names; every name a SHADE, LIT or burn tone refers to exists; a role's SHADE and LIT are
//   roles (a pixel that takes marks holds five bits of colour);
// - luminance: SHADE <= colour <= LIT for every colour of the table;
// - the burn: charred <= singed <= soot <= colour for each of the 32, and strictly charred <
//   singed and soot < colour for every colour light enough to show a mark at all (lighter than
//   the theme's darkest burn tone), with singed never lighter than soot;
// - the tiles: on the sheet's places and a lap of the theme's tracks, every pixel holds a
//   colour of the theme's table; a pixel that takes marks holds one of the 32; water is `water`
//   and nothing else is; a marked pixel shows a colour of the table, never lighter than before;
// - readability: tarmac no lighter than the scrapyard's; a void mostly soot; the obstacle
//   tones are global palette names, none of them a car's colour; the eight frames of a barrel's
//   turn are eight pictures; and the contrast table below, held against the scrapyard's.
// - the scrapyard's tables are what gfx/world.ts had as constants before themes (recomputed
//   here from palette.ts as that code did it).
// - the harbour's own rules (TH-LOOK-H; PLAN-THEMES.md Amendment 1; harbourRules, on Quay Yard and
//   Slag Harbour as the game draws them): the kerb's yellow is none of the fixed hazard colours
//   and far from each, and a kerb pixel holds a hazard colour only where every theme has one;
//   nothing is painted on the quay or the apron; every prop pixel lies in a block of the
//   container yard or within its piece's reach at a junk site; the ground art (the yard's blocks,
//   the crane rails) keeps clear of roads, props and marshals, and no rail lies along a road; a
//   gap is soot and a ladder's steel; the four greys (tarmac, ground, verge, kerb slab) are a
//   stated step apart, and water from the ground and the verge; every colour on its props, the
//   accents too, is far from the six car colours, a container's paints as far as a parked car's.
//
// --contrast: how well what a player must see stands out from what it lies on. WCAG contrast
// ratios (1 = none, 21 = black on white) of the six car bodies and the cars' outline, a
// rivet's head and trail, a lightning cell's rim and bolt, and a mine's body and lamp against
// each theme's ground, verge, kerb paints, tarmac, dirt patch and water: against each
// surface's plain tone and, in brackets, the worst of the tones that make up at least 2% of
// its pixels (counted on baked tiles). The game's canvas is scaled without smoothing
// (image-rendering: pixelated), so at 390x844@3 (1.83 device pixels a view pixel) every
// device pixel has exactly one of these colours: the ratios are those of that screen too.
// Held, for every theme but the scrapyard (which is the measure): against the plain tone of
// every surface a car can be on, each sprite's best part (a car: its body or its outline)
// reaches MIN_CONTRAST, or the scrapyard's figure for that sprite on that surface where that
// is less; over a surface's pixels the mean is not under MIN_CONTRAST and under four fifths of
// the scrapyard's; a mine and a rivet stand out from the tarmac as in the scrapyard.
//
// --shots: the working tree is built into a temp directory and served on 127.0.0.1 (--port), one
// browser session (theme-shots-<pid>, or --session's; muted, closed at the end). The preview's scenes with
// `&theme=` (client/preview.ts: the looks of a theme on the same roads, never in the game) held
// at their key moment, at 1280x720 and at 390x844@3: Rust Bowl (its preview scenes and the tour),
// Crusher Run (the tour: grid, a bend, the scrap-filled gap, the chasm), the figure-eight's
// crossing and holes, and the Preview Yard scenes. Each as the whole window in the theme, and
// for the shipped tracks also as a pair, the track's own look beside it: `pair-<name>-<size>.png`.
// And the theme's own yard as the game draws it (no switch: its own theme, its theme surface
// drawn), the tour held at ten places round the lap: `<theme>-<yard>-<place>-<size>.png`; for
// the harbour also Slag Harbour, the shipped track that has the theme, at ten places round its
// lap and down its shortcut (its start, the split's island, a pool, the pier cut's fork, pit and
// merge among them): `harbour-slag-harbour-<place>-<size>.png`.
// For every themed shot at 390x844@3 it also holds the screen against the game canvas: every
// device pixel inside the canvas's box must have one of the colours the 640 x 360 canvas itself
// holds (the canvas is scaled without smoothing, so no colour is mixed on the way and the
// table's contrast figures are that screen's; exit code 1 otherwise), and it says how many of
// the canvas's colours are the theme's table's (the others are the sprites', the effects' and the HUD's).
//
// --alloc: does a theme's own code allocate in a frame (PLAN-GFX.md rule 1)? The other probes
// (bake-alloc.ts, world-alloc.ts) drive the tracks as they are, which is the scrapyard; this one
// drives the same two things with the theme switched, each theme in a process of its own: the
// World alone on a lap of Crusher Run at 430 u/s (the bake path: every tile baked on the way,
// every lap), and Renderer.frame on a lap of Preview Yard, six cars with the race tick running
// (the furniture, what moves, the dust). V8's sampling heap profiler with the objects collected
// since counted; bytes a frame charged to functions of client/, the rest to "outside" (the
// probe's loop, Node). A control beside it (an object a frame that escapes, 56 B or so) shows
// the profiler sees what there is. Numbers under about 1 byte a frame are the sampling's noise.
//
// --hash: per shipped and test track, sha256 over the palette indices of every tile near the
// road, over what each pixel is (bakeTileKinds), over the tiles with a fixed set of scorches and
// tyre marks (bakeTileMarked), over the pixels a World puts on its tile canvases on a lap,
// plain and marked, over the obstacle sheet (indices and pixels), and the placeholder's fill
// style. It reads nothing of the themes' own code, so it runs on any checkout: `--root <dir>`
// names one (a `git worktree` of main, say), and equal lines mean the same world, bit for bit.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { blank, decodePng, paste, savePng, type Picture } from "./png";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The bake and the obstacle sheet ask for a canvas now and then (Node has none): one that keeps its pixels.
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
interface FakeCanvas { width: number; height: number; px?: Uint32Array; getContext?: () => unknown }
const canvases: FakeCanvas[] = [];
const blits: { src: FakeCanvas; x: number; y: number }[] = [];
const fills: string[] = [];
const makeCtx = (canvas: FakeCanvas) => ({
  set fillStyle(v: string) {
    fills.push(v);
  },
  globalAlpha: 1,
  drawImage(src: FakeCanvas, x: number, y: number) {
    blits.push({ src, x, y });
  },
  fillRect() {},
  putImageData(img: FakeImageData, dx: number, dy: number, sx = 0, sy = 0, sw = img.width, sh = img.height) {
    canvas.px ??= new Uint32Array(canvas.width * canvas.height);
    const src = new Uint32Array(img.data.buffer);
    for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) canvas.px[(dy + y) * canvas.width + dx + x] = src[y * img.width + x];
  },
  getContextAttributes: () => ({ willReadFrequently: true }),
});
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => {
    const c: FakeCanvas = { width: 0, height: 0 };
    const ctx = makeCtx(c);
    c.getContext = () => ctx;
    canvases.push(c);
    return c;
  },
};

// ---- --hash: the scrapyard's identity (nothing of the themes' code is read here) -----------------

async function hash(root: string): Promise<void> {
  const load = (file: string) => import(pathToFileURL(path.resolve(root, file)).href);
  const { World, MARK, scorch, skid, clearMarks, bakeTileIndices, bakeTileMarked, bakeTileKinds, ZOOM, VIEW_W, VIEW_H, TILE } = await load("client/gfx/world.ts");
  const { obstacleIndexSheet } = await load("client/gfx/obstacles.ts");
  const { trackById, trackList } = await load("shared/tracks.ts");
  const { TEST_TRACKS, testTrack } = await load("shared/testtracks.ts");
  const { pointAt } = await load("shared/track.ts");
  type T = { def: { id: string }; length: number; wall: number };
  const tracks: T[] = [...trackList().map((e: { id: string }) => trackById(e.id)), ...TEST_TRACKS.map((d: { id: string }) => testTrack(d.id))];
  const sha = () => createHash("sha256");
  const short = (h: ReturnType<typeof sha>) => h.digest("hex").slice(0, 16);
  const tilesOf = (t: T): [number, number][] => {
    const seen = new Set<string>();
    const out: [number, number][] = [];
    for (let s = 0; s < t.length; s += 20) {
      const p = pointAt(t, s);
      for (let lat = -t.wall - 120; lat <= t.wall + 120; lat += 20) {
        const x = (p.x - Math.sin(p.h) * lat) * ZOOM, y = (p.y + Math.cos(p.h) * lat) * ZOOM;
        const k = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([Math.floor(x / TILE), Math.floor(y / TILE)]);
      }
    }
    return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  };
  console.log("track            tiles  indices           kinds             marked            pixels            marked-pixels     obstacles         fills");
  for (const t of tracks) {
    const tiles = tilesOf(t);
    const hI = sha(), hK = sha(), hM = sha(), hP = sha(), hQ = sha(), hO = sha();
    for (const [tx, ty] of tiles) hI.update(bakeTileIndices(t, tx, ty));
    for (const [tx, ty] of tiles) hK.update(bakeTileKinds(t, tx, ty));
    // The pixels, as a World puts them on its tiles: a lap of snapped views, every blit hashed.
    const view: FakeCanvas = { width: VIEW_W, height: VIEW_H };
    fills.length = 0;
    const world = new World(makeCtx(view), t);
    const lap = (h: ReturnType<typeof sha>) => {
      for (let s = 0; s < t.length; s += 240) {
        const p = pointAt(t, s);
        blits.length = 0;
        world.aim(p.x, p.y, 1000 / 60, true);
        world.draw(Math.round(p.x * ZOOM) - VIEW_W / 2, Math.round(p.y * ZOOM) - VIEW_H / 2, []);
        for (const b of blits) {
          h.update(`${b.x},${b.y};`);
          if (b.src.px) h.update(new Uint8Array(b.src.px.buffer, b.src.px.byteOffset, b.src.px.byteLength));
        }
      }
    };
    lap(hP);
    // Marks: a scorch every 180 units on lanes in turn, a tyre mark every 130.
    clearMarks();
    for (let s = 40, k = 0; s < t.length; s += 180, k++) {
      const p = pointAt(t, s), lat = ((k % 5) - 2) * 26;
      MARK[0] = p.x - Math.sin(p.h) * lat;
      MARK[1] = p.y + Math.cos(p.h) * lat;
      scorch(t);
    }
    for (let s = 90, k = 0; s < t.length; s += 130, k++) {
      const p = pointAt(t, s), lat = ((k % 7) - 3) * 18;
      const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
      const c = Math.cos(p.h), sn = Math.sin(p.h);
      MARK[0] = x + sn * 5; MARK[1] = y - c * 5; MARK[2] = x + sn * 5 + c * 9; MARK[3] = y - c * 5 + sn * 9;
      MARK[4] = x - sn * 5; MARK[5] = y + c * 5; MARK[6] = x - sn * 5 + c * 9; MARK[7] = y + c * 5 + sn * 9;
      skid(t);
    }
    for (const [tx, ty] of tiles) hM.update(bakeTileMarked(t, tx, ty, true));
    lap(hQ);
    lap(hQ); // once more: the owed rectangles have been sent
    clearMarks();
    const sheet = obstacleIndexSheet(t) as Uint8Array | null;
    if (sheet) {
      hO.update(sheet);
      // ... and its pixels, as they went to the sheet's canvas (512 x 256).
      for (const c of canvases) if (c.width === 512 && c.height === 256 && c.px) hO.update(new Uint8Array(c.px.buffer, c.px.byteOffset, c.px.byteLength));
    }
    console.log(`${t.def.id.padEnd(16)} ${String(tiles.length).padStart(5)}  ${short(hI)}  ${short(hK)}  ${short(hM)}  ${short(hP)}  ${short(hQ)}  ${sheet ? short(hO) : "-".padEnd(16)}  ${[...new Set(fills)].join(",")}`);
  }
}

if (args.includes("--hash")) {
  await hash(arg("--root") ?? ROOT);
  process.exit(0);
}

// ---- the themes' own code ----------------------------------------------------------------------

const { artLayout, bakeTileIndices, bakeTileKinds, bakeTileMarked, clearMarks, KIND, MARK, PLANT, PROP, scorch, skid, TILE, VIEW_H, VIEW_W, World, ZOOM } = await import("../../client/gfx/world");
const { BARREL, obstacleIndexSheet, ROLL } = await import("../../client/gfx/obstacles");
const { CAR_COLORS, FIXED, LIT, P, PALETTE, rgbOf, SCRAPYARD, SHADE } = await import("../../client/gfx/palette");
const { FX_SHADOW, OBST_W } = await import("../../client/gfx/sprites");
const { FONT_LETTERS, SMALL } = await import("../../client/gfx/font");
const { COLOURS, hasArt, isTheme, KEEP_OFF, sceneryFor, sceneryOf, themedTrack, themeOf, THEMES } = await import("../../client/gfx/theme");
const { testTrack } = await import("../../shared/testtracks");
const { BARREL_R, pointAt, queryTrack } = await import("../../shared/track");
const { trackById } = await import("../../shared/tracks");
const { sheetYard } = await import("./world-sheet/yard");
type Track = import("../../shared/track").Track;
type Theme = import("../../client/gfx/theme").Theme;
type Scenery = import("../../client/gfx/theme").Scenery;

// ---- pictures ------------------------------------------------------------------------------------

const rgb = (hex: string): [number, number, number] => rgbOf(hex);

function rect(pic: Picture, x: number, y: number, w: number, h: number, hex: string): void {
  const [r, g, b] = rgb(hex);
  for (let j = Math.max(0, y); j < Math.min(pic.h, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(pic.w, x + w); i++) {
      const o = (j * pic.w + i) * 4;
      pic.data[o] = r;
      pic.data[o + 1] = g;
      pic.data[o + 2] = b;
      pic.data[o + 3] = 255;
    }
  }
}

function text(pic: Picture, s: string, x: number, y: number, hex: string, scale = 1): void {
  const { cw, ch, bits } = SMALL;
  const up = s.toUpperCase();
  for (let n = 0; n < up.length; n++) {
    const k = FONT_LETTERS.indexOf(up[n]);
    if (k < 0) continue;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (bits[(k * ch + j) * cw + i]) rect(pic, x + (n * cw + i) * scale, y + j * scale, scale, scale, hex);
  }
}

/** Palette indices as a picture, in a scenery's colours. */
function picture(idx: Uint8Array, w: number, h: number, sc: Scenery): Picture {
  const out: Picture = { w, h, data: new Uint8Array(w * h * 4) };
  const words = new Uint32Array(out.data.buffer);
  for (let i = 0; i < idx.length; i++) words[i] = sc.pal32[idx[i]];
  return out;
}

// ---- windows of the baked world -------------------------------------------------------------

const tiles = new Map<string, Uint8Array>();

/** A window of a track's baked world: w x h view pixels with (x, y), world units, in its middle. With `marked`, the track marks made so far are on it. */
function windowOf(track: Track, x: number, y: number, w: number, h: number, marked = false, kinds = false): Uint8Array {
  const out = new Uint8Array(w * h);
  const x0 = Math.round(x * ZOOM - w / 2), y0 = Math.round(y * ZOOM - h / 2);
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
      const key = `${track.def.id}/${themeOf(track)}/${tx},${ty}/${marked ? "m" : kinds ? "k" : "p"}`;
      let t = tiles.get(key);
      if (!t) {
        t = kinds ? bakeTileKinds(track, tx, ty) : marked ? bakeTileMarked(track, tx, ty) : bakeTileIndices(track, tx, ty);
        if (!marked) tiles.set(key, t);
      }
      for (let j = 0; j < TILE; j++) {
        const Y = ty * TILE + j - y0;
        if (Y < 0 || Y >= h) continue;
        for (let i = 0; i < TILE; i++) {
          const X = tx * TILE + i - x0;
          if (X >= 0 && X < w) out[Y * w + X] = t[j * TILE + i];
        }
      }
    }
  }
  return out;
}

function at(track: Track, s: number, lat = 0): { x: number; y: number; h: number } {
  const p = pointAt(track, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h };
}

// ---- the contact sheet -----------------------------------------------------------------------------

interface Shot {
  label: string;
  track: Track;
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
  marks?: (track: Track) => void;
}

const drawn = new WeakSet<Track>();

/** A track takes marks once it has been drawn (gfx/world.ts marksOn): a tile of it baked will do. */
function drawnOnce(track: Track): void {
  if (drawn.has(track)) return;
  drawn.add(track);
  bakeTileIndices(track, 0, 0);
}

function scorchAt(track: Track, x: number, y: number): void {
  drawnOnce(track);
  MARK[0] = x;
  MARK[1] = y;
  scorch(track);
}

function skidAt(track: Track, x: number, y: number, h: number, len: number): void {
  drawnOnce(track);
  const c = Math.cos(h), s = Math.sin(h);
  for (let u = 0; u + 8 <= len; u += 8) {
    const ax = x + c * u, ay = y + s * u;
    MARK[0] = ax + s * 5; MARK[1] = ay - c * 5; MARK[2] = ax + s * 5 + c * 8; MARK[3] = ay - c * 5 + s * 8;
    MARK[4] = ax - s * 5; MARK[5] = ay + c * 5; MARK[6] = ax - s * 5 + c * 8; MARK[7] = ay + c * 5 + s * 8;
    skid(track);
  }
}

/** Where the props outside the walls of a track are: the middles of clusters of prop pixels (or of anything drawn there, for the scrapyard), found on its baked tiles. */
function propSpots(track: Track, want: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const sc = sceneryFor(track);
  if (sc.theme === "city" || sc.theme === "jungle") {
    // A town's roofs are props too (the same kind of pixel), and so are a jungle's crowns: its heaps by the art's own list, a heap being the pieces within 50 pixels of its first.
    const heaps: { x: number; y: number; n: number }[] = [];
    for (const j of artLayout(track).junk) {
      const h = heaps.find((o) => Math.hypot(o.x - j.x, o.y - j.y) < 50);
      if (h) h.n++;
      else heaps.push({ x: j.x, y: j.y, n: 1 });
    }
    return heaps.filter((h) => h.n >= 3).slice(0, want).map((h) => ({ x: h.x / ZOOM, y: h.y / ZOOM }));
  }
  for (let s = 0; s < track.length && out.length < want; s += 60) {
    for (const side of [-1, 1]) {
      const p = at(track, s, side * (track.wall + 110));
      const w = 150, h = 120;
      const win = sc.id ? windowOf(track, p.x, p.y, w, h, false, true) : windowOf(track, p.x, p.y, w, h);
      let n = 0, sx = 0, sy = 0;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const v = win[j * w + i];
          // A theme's props are their own kind of pixel; the scrapyard's junk is told by its rust and steel.
          const hit = sc.id ? v === KIND.prop : v >= sc.index.steel0 && v <= sc.index.rust3;
          if (hit) {
            n++;
            sx += i;
            sy += j;
          }
        }
      }
      if (n < 60) continue;
      const x = p.x + (sx / n - w / 2) / ZOOM, y = p.y + (sy / n - h / 2) / ZOOM;
      if (out.some((o) => Math.hypot(o.x - x, o.y - y) < 150)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

interface Section {
  title: string;
  note: string;
  shots: Shot[];
}

const shot = (label: string, track: Track, s: number, lat: number, w: number, h: number, zoom = 2, marks?: Shot["marks"]): Shot => ({ label, track, ...at(track, s, lat), w, h, zoom, marks });

/** The yard a theme has of its own (shared/testtracks.ts THEME_YARDS), in its own theme. */
const YARD_OF: Partial<Record<Theme, string>> = { desert: "dune-yard", city: "block-yard", harbour: "quay-yard", jungle: "canopy-yard" };

/** The harbour's props on a track, a close-up of each kind: the largest piece of it, and of the containers a second one. */
function harbourProps(track: Track): Shot[] {
  const junk = artLayout(track).junk;
  const out: Shot[] = [];
  for (const [name, kind] of Object.entries(PROP)) {
    if (name === "empty") continue;
    // The pieces of the kind that stand most apart from the others (so that one is seen whole), the largest of those first.
    const apart = (j: (typeof junk)[number]) => Math.min(...junk.filter((o) => o !== j && o.kind !== PROP.empty).map((o) => Math.hypot(o.x - j.x, o.y - j.y) - o.reach - j.reach));
    const list = junk.filter((j) => j.kind === kind).map((j) => ({ ...j, apart: Math.min(6, apart(j)) })).sort((a, b) => b.apart - a.apart || b.reach - a.reach);
    const picks = name === "container" ? [list[0], list[1]] : [list[0]];
    for (const j of picks) if (j) out.push({ label: `${name}${name === "crane" ? "'s base, on its rails" : name === "straddle" ? " carrier" : name === "bollards" ? " with a mooring rope" : name === "hawser" ? ", coiled" : ""}, 4x`, track, x: j.x / ZOOM, y: j.y / ZOOM, w: 120, h: 86, zoom: 4 });
  }
  return out;
}

/** The harbour's ground art on a track (gfx/world.ts layStacks, layRails): its largest block of containers lying each way, its longest pair of crane rails, and a whole view. */
function harbourYard(track: Track): Shot[] {
  const art = artLayout(track), out: Shot[] = [];
  const blocks: { x: number; y: number; w: number; h: number }[] = [];
  for (let k = 0; k < art.blocks.length; k += 4) if (art.blocks[k + 2] > art.blocks[k]) blocks.push({ x: (art.blocks[k] + art.blocks[k + 2]) / 2, y: (art.blocks[k + 1] + art.blocks[k + 3]) / 2, w: art.blocks[k + 2] - art.blocks[k], h: art.blocks[k + 3] - art.blocks[k + 1] });
  const largest = (list: typeof blocks) => list.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  for (const [what, b] of [["a block, its rows along x", largest(blocks.filter((b) => b.w >= b.h))], ["a block, its rows along y", largest(blocks.filter((b) => b.w < b.h))]] as const) {
    if (b) out.push({ label: `${what} (${b.w} x ${b.h} pixels), 3x`, track, x: b.x / ZOOM, y: b.y / ZOOM, w: 170, h: 150, zoom: 3 });
  }
  let best = -1;
  for (let k = 0; k < art.rails.length; k += 6) if (best < 0 || art.rails[k + 5] - art.rails[k + 4] > art.rails[best + 5] - art.rails[best + 4]) best = k;
  if (best >= 0) {
    const r = art.rails, mid = (r[best + 4] + r[best + 5]) / 2, len = r[best + 5] - r[best + 4];
    out.push({ label: `a crane's rails, ${len} pixels of them, buffer stops at their ends, 3x`, track, x: (r[best + 2] ? r[best] : mid) / ZOOM, y: (r[best + 2] ? mid : r[best + 1]) / ZOOM, w: r[best + 2] ? 150 : 250, h: r[best + 2] ? 250 : 150, zoom: 3 });
  }
  const p = at(track, 300, -track.wall - 190);
  out.push({ label: "the quay beside the road, 1x", track, x: p.x, y: p.y, w: 640, h: 360, zoom: 1 });
  return out;
}

/** The jungle's props on a track, a close-up of each kind: the piece of it that stands most apart from the others, the largest of those. */
function jungleProps(track: Track): Shot[] {
  const junk = artLayout(track).junk;
  const out: Shot[] = [];
  for (const [name, kind] of Object.entries(PLANT)) {
    if (name === "empty") continue;
    const apart = (j: (typeof junk)[number]) => Math.min(...junk.filter((o) => o !== j && o.kind !== PLANT.empty).map((o) => Math.hypot(o.x - j.x, o.y - j.y) - o.reach - j.reach));
    const list = junk.filter((j) => j.kind === kind).map((j) => ({ ...j, apart: Math.min(6, apart(j)) })).sort((a, b) => b.apart - a.apart || b.reach - a.reach);
    const picks = name === "crown" ? [list[0], list[1]] : [list[0]];
    for (const j of picks) if (j) out.push({ label: `${name === "crown" ? "a tree's crown" : name === "ferns" ? "ferns" : name === "log" ? "a fallen log" : "a vine-hung wall fragment"}, 4x`, track, x: j.x / ZOOM, y: j.y / ZOOM, w: 120, h: 86, zoom: 4 });
  }
  return out;
}

/** The jungle's ground art on a track (gfx/world.ts layCanopy): the canopy beside the road as a race shows it, its crowns close up, its edge at the barrier, and the clearing the two flag marshals stand in. */
function jungleCanopy(track: Track): Shot[] {
  const far = at(track, 1300, -track.wall - 160), edge = at(track, 1400, -track.wall - 40), line = at(track, 0, -track.wall - 30);
  return [
    { label: "the canopy beside the road, 1x", track, x: far.x, y: far.y, w: 640, h: 360, zoom: 1 },
    { label: "crowns, 3x", track, x: far.x, y: far.y - 60, w: 250, h: 150, zoom: 3 },
    { label: "its edge at the barrier: 9 units of open loam, 3x", track, x: edge.x, y: edge.y, w: 250, h: 150, zoom: 3 },
    { label: "the start line: the marshals' clearing, 2x", track, x: line.x, y: line.y, w: 330, h: 220, zoom: 2 },
  ];
}

function sheet(theme: Theme): Picture {
  const sc = sceneryOf(theme);
  const crusher = themedTrack(trackById("crusher-run"), theme), knot = themedTrack(trackById("overpass-knot"), theme);
  const yard = themedTrack(sheetYard(), theme), preview = themedTrack(testTrack("preview-yard")!, theme), rust = themedTrack(trackById("rust-bowl"), theme);
  const gap = crusher.gaps.find((g) => !g.scrap)!, scrap = crusher.gaps.find((g) => g.scrap)!, hole = knot.holes[0];
  const port = theme === "harbour", slag = trackById("slag-harbour");
  const wild = theme === "jungle", canopy = testTrack("canopy-yard")!;
  const props = port ? [] : propSpots(rust, theme === "city" ? 9 : 6);
  // The basin's ladder is on the wall the sun is on: the flank of the chasm that holds steel.
  const ladderSide = [-1, 1].map((side) => {
    const p = at(crusher, gap.s0 + (gap.s1 - gap.s0) / 3, side * (crusher.wall - 6));
    return { side, n: port ? windowOf(crusher, p.x, p.y, 60, 60).filter((v) => v === sc.index.steel2).length : 0 };
  }).sort((a, b) => b.n - a.n)[0].side;
  const sections: Section[] = [
    {
      title: "THE ROAD'S BANDS",
      note: "ground, barrier (desert: sandstone blocks; city: concrete in lengths, an amber reflector stud where a post stands; harbour: a jersey barrier in lengths, a lashing ring where a post stands; jungle: a rail of logs laid end to end, a lashing of rope where a post stands), verge (city: a sidewalk's slabs; harbour: the quay's apron, tie-down rings in it, nothing painted or hatched on it; jungle: moss, roots creeping over it from the wall's foot), kerb (city: grey and white stones; harbour: bare grey slabs and slabs in a yellow long faded; jungle: kerb stones, every other one grown over with moss), tarmac with its centre line; a straight at 4x, the start line, a bend and a tight bend at 2x",
      shots: [shot("a straight, 4x", rust, 700, -70, 170, 110, 4), shot("start line and grid", rust, 6, 0, 300, 220), shot("a bend", rust, 2300, 0, 300, 220), shot("a tight bend", yard, 2800, 0, 300, 220)],
    },
    {
      title: "THE GROUND",
      note: "outside the walls. scrapyard: packed earth, stains and wheel ruts; desert: sand, dune crests and wind ripples; city: old paving and the roofs of the town (clay tiles, slate, zinc; gabled, hipped, flat with vents), their shadows in the alleys; harbour: a quay of concrete slabs, an expansion joint between them (no line painted on it), a lighter pour and an old stained one now and then, drains; jungle: dark loam under leaf litter, moss at the wall's foot, and the canopy that closes over it (see further down); at 2x and at 1x",
      shots: [shot("ground, 2x", rust, 1200, -420, 330, 220), shot("ground, 2x", crusher, 2000, 400, 330, 220), shot("ground, 1x", rust, 1200, -520, 640, 360, 1)],
    },
    {
      title: "PROPS OUTSIDE THE WALLS",
      note: "at the yard's junk sites. desert: rock outcrops (two stones), dry scrub, round succulents, half-buried car shells; city: planter trees, crates, traffic cones, parked cars in wine, moss, petrol and grey (no car's colour); 3x. harbour (on Slag Harbour, a close-up of each kind): containers in oxide red, green, ochre and slate, one on another; a reefer with its machinery at one end (a row of them where a heap is reefers); a crane's base (two sills on their rails, the portal's girders, the slewing column: no boom); a straddle carrier over its container; a pair of bollards with a mooring rope; a coiled hawser; pallets; a forklift. jungle (on Canopy Yard, a close-up of each kind, then heaps on Rust Bowl): a tree's crown (none reaches past the barrier: each is sized to the room its site has), a clump of ferns, a fallen log with a sawn end and moss on it, a vine-hung fragment of an old wall",
      shots: port ? harbourProps(slag) : [...(wild ? jungleProps(canopy) : []), ...props.map((p, k) => ({ label: `heap ${k + 1}`, track: rust, x: p.x, y: p.y, h: 0, w: 150, zoom: 3, ...{ h: 110 } }))],
    },
    ...(wild ? [{
      title: "THE CANOPY: GROUND ART, LAID OUT PER TRACK",
      note: "not props (those stand at the junk's sites alone) but the jungle's ground, laid out once per track as a town's roofs and a quay's container blocks are: a crown in most cells of a grid, larger than its cell, so that the crowns close over the loam; three kinds of tree (a yellow-green, a darker blue-green, a mossy olive), a grove mostly of one kind; ferns where no crown has the room. No crown and no shadow of one comes nearer a barrier than 9 units; all keep clear of the props and of the two flag marshals",
      shots: jungleCanopy(canopy),
    }] : []),
    ...(port ? [{
      title: "THE CONTAINER YARD AND THE CRANE RAILS: GROUND ART, LAID OUT PER TRACK",
      note: "not props (those stand at the junk's sites alone) but the harbour's ground, laid out once per track as a town's roofs are: blocks of container stacks on the slabs' own grid, their rows end to end; and under every crane's base its pair of rails, which run across the nearest road's way and never along a road. Both keep clear of every road (the barrier and 13 units of open quay; a rail 10), of the props, of each other and of the two flag marshals",
      shots: harbourYard(slag),
    }] : []),
    {
      title: "GAPS AND PITS",
      note: "a gap's void (soot; desert: layered rock near the rim; city: a concrete coping and a street below, all of it soot; harbour: a dock basin, its wall sheet piling in steps of soot and nothing else, no water down there and no blue; a steel ladder down the wall the sun is on; jungle: a river gorge, mossy rock and hanging vines at its rim where a wall faces the sun, a river far below in soot alone: no blue, nothing to drive on) with its ramp, hazard ends and broken edge; a gap filled with scrap (desert: boulders; city: rubble and crates; harbour: containers as they fell, and pallets; jungle: logs washed down, and boulders); a pit",
      shots: [
        shot("chasm: ramp, void, far end", crusher, (gap.s0 + gap.s1) / 2 - 40, 0, 400, 300),
        shot("the void's rim, 4x", crusher, gap.s0 + 14, crusher.wall - 30, 150, 110, 4),
        ...(port ? [shot("the basin's ladder, 4x", crusher, gap.s0 + (gap.s1 - gap.s0) / 3, ladderSide * (crusher.wall - 12), 150, 110, 4)] : []),
        shot("a gap filled with scrap", crusher, (scrap.s0 + scrap.s1) / 2, 0, 330, 300),
        shot("a pit, 4x", knot, hole.s, hole.lat, 130, 110, 4),
      ],
    },
    {
      title: "THE ROAD'S FURNITURE",
      note: "water (blue-grey in every theme, the jungle's too; desert: a rim of dried, cracked mud; city: a rain puddle over its drain grate; harbour: a rain puddle on the concrete), a dirt patch (desert: red clay; city: roadworks, taped off; harbour: ballast with old rail sleepers in it; jungle: black wet mud, a glint on it here and there), a belt, the barrels' lane with hatch and gutter, a press's bed, mounds (desert: sandbags; city: a strapped tyre bundle; harbour: stacked dock fenders; jungle: a bale of bamboo, green cane and dried cane in turn), an island with its noses, the ramp truck (desert: a sand hauler; city: a car carrier; harbour: a container chassis trailer behind a terminal tractor; jungle: a logging truck, its load of logs its deck)",
      shots: [
        shot("pool on tarmac", yard, 1225, -2, 220, 190, 3),
        shot("pool over kerb and verge", yard, 1365, 63, 220, 190, 3),
        shot("dirt patch, mound on it", yard, 705, 0, 260, 190, 3),
        shot("mounds: on tarmac, across the kerb", yard, 890, 20, 260, 190, 3),
        shot("barrels' lane", yard, 1060, 0, 150, 250, 3),
        shot("belt", yard, 1535, 0, 220, 190, 3),
        shot("ramp truck", yard, 1715, -26, 260, 150, 3),
        shot("truck on dirt", yard, 3475, 26, 220, 220, 3),
        shot("press bed", yard, 4300, 0, 150, 220, 3),
        shot("island nose and gore", yard, 5880, 0, 300, 220, 3),
        shot("split: flooded lane, island, dirt lane", yard, 6300, 0, 330, 300, 2),
        shot("Preview Yard: chicane", preview, 1350, 0, 640, 360, 1),
        shot("Preview Yard: split with a press", preview, 6640, 0, 640, 360, 1),
      ],
    },
    {
      title: "TRACK MARKS",
      note: "a mine's scorch (soot, singed, charred) and tyre marks: on tarmac, kerb and verge, on a dirt patch, at the wall's foot (the barrier takes none), by a pool",
      shots: [
        shot("tarmac, kerb, verge", rust, 1500, 60, 260, 150, 3, (t) => {
          for (const [ds, lat] of [[-60, 0], [-20, 58], [30, 88], [70, 30]]) {
            const p = at(t, 1500 + ds, lat);
            scorchAt(t, p.x, p.y);
          }
          const q = at(t, 1440, -30);
          skidAt(t, q.x, q.y, q.h + 0.25, 120);
        }),
        shot("at the wall", rust, 1900, rust.wall - 14, 220, 150, 3, (t) => {
          for (const ds of [-40, 0, 40]) {
            const p = at(t, 1900 + ds, t.wall - 6 + ds / 8);
            scorchAt(t, p.x, p.y);
          }
        }),
        shot("dirt patch and pool", yard, 3040, -10, 260, 190, 3, (t) => {
          for (const [s, lat] of [[3000, -30], [3060, 0], [2890, 10]]) {
            const p = at(t, s, lat);
            scorchAt(t, p.x, p.y);
          }
          const q = at(t, 2990, -44);
          skidAt(t, q.x, q.y, q.h - 0.2, 110);
        }),
      ],
    },
  ];
  // The theme's own yard, as a race shows it (a whole view at 1x): its theme surface twice and every obstacle on the way round.
  const own = YARD_OF[theme];
  if (own) {
    const t = testTrack(own)!;
    const view = (label: string, s: number, lat = 0): Shot => shot(label, t, s, lat, 640, 360, 1);
    sections.push({
      title: `${t.def.name.toUpperCase()}: THE THEME'S OWN YARD`,
      note: `${t.def.id} (shared/testtracks.ts), whole views at 1x round the lap: its theme surface (${t.fords.length ? "a ford" : t.oil.length ? "an oil slick" : "sand"}) ${wild ? "across the road twice, its stream running to the right of travel at slot A and to the left at slot B" : port ? "on the right half of the road and down its middle" : "across the road and on half of it"}, the truck, the mounds, the pool in the bend, the barrels' lane, the press, the split with its dirt lane`,
      shots: [view("the start", 0), view("slot A", 950), view("the truck", 1800), view("the mounds", 2790), view("the pool in the bend", 4150), view("the barrels' lane", 5000), view("the press", 6300), view("slot B", port ? 7340 : 7270), view("the split", 8300), view("the dirt lane", 8700)],
    });
  }
  // The shipped track that has the theme (the harbour's: Slag Harbour), as a race shows it.
  if (port) {
    const cut = slag.branches[0], pit = cut.road.holes[0];
    const view = (label: string, s: number, lat = 0): Shot => shot(label, slag, s, lat, 640, 360, 1);
    sections.push({
      title: "SLAG HARBOUR: THE SHIPPED TRACK IN ITS THEME",
      note: "slag-harbour (shared/longtracks.ts), whole views at 1x round the lap: the start, the quay straight's barrels, the split round its island with the flooded lane, the ramp truck, the pier's shortcut (its fork, the pit on its hairpin, its merge), the fenders' chicane, the belt",
      shots: [
        view("the start", 0), view("the quay straight: the barrels' lane", 2700), view("the split: the island's nose", 4440), view("the split: the flooded lane", 4760, -40), view("the ramp truck", 8620),
        view("the pier's shortcut: the fork", cut.s0 + 60, 40), { label: "the shortcut: the pit on its hairpin", track: slag, x: pit.x, y: pit.y, w: 640, h: 360, zoom: 1 }, view("the shortcut: the merge", cut.s1 - 60, 40),
        view("the fenders' chicane", 14450), view("the belt", 17355),
      ],
    });
  }
  const sprites = spriteStrip(preview);
  return compose(`THEME SHEET: ${theme}${hasArt(theme) ? "" : " (NO ART YET: DRAWN AS THE SCRAPYARD)"}`, sc, sections, sprites, sc);
}

/**
 * The theme surfaces on paper (TH-LOOK-2): sand as Dune Yard has it and an oil slick as Block
 * Yard has it, each whole, at its edge, with track marks made across its edge (the surface
 * takes none, the tarmac beside it does), and beside what it must not be taken for: sand
 * beside the desert's red clay dirt, oil beside a pool and beside a pit.
 */
function surfaces(): Picture {
  const dune = testTrack("dune-yard")!, block = testTrack("block-yard")!, quay = testTrack("quay-yard")!;
  const knot = themedTrack(trackById("overpass-knot"), "city");
  const marks = (s: number, lat: number) => (t: Track) => {
    for (const [ds, dl] of [[-30, -14], [40, 12]]) {
      const p = at(t, s + ds, lat + dl);
      scorchAt(t, p.x, p.y);
    }
    const q = at(t, s - 70, lat + 30);
    skidAt(t, q.x, q.y, q.h - 0.22, 150);
  };
  const part = (t: Track, what: string, a: { s0: number; s1: number; lat0: number; lat1: number }, b: { s0: number; s1: number; lat0: number; lat1: number }): Shot[] => [
    shot(`${what} across the road (${a.s1 - a.s0} x ${a.lat1 - a.lat0} units), 2x`, t, (a.s0 + a.s1) / 2, 0, Math.ceil((a.s1 - a.s0) * ZOOM) + 90, 230),
    shot(`its edge, 4x`, t, a.s0 + 26, (a.lat0 + a.lat1) / 2 - 30, 150, 110, 4),
    shot(`${what} on half the road (${b.s1 - b.s0} x ${b.lat1 - b.lat0} units), 2x`, t, (b.s0 + b.s1) / 2, 0, Math.ceil((b.s1 - b.s0) * ZOOM) + 90, 230),
    shot("scorches and a tyre mark across its edge, 3x", t, a.s0 + 10, (a.lat0 + a.lat1) / 2, 250, 150, 3, marks(a.s0 + 10, (a.lat0 + a.lat1) / 2)),
    shot("as a race shows it, 1x", t, (a.s0 + a.s1) / 2, 0, 640, 360, 1),
  ];
  const hole = knot.holes[0];
  const sections: Section[] = [
    {
      title: "SAND (DESERT; DUNE YARD)",
      note: "loose sand on the asphalt, drawn where Track.sand has a patch: a puddle's outline inside the declared rectangle (the traction rectangle is all sand), deeper than the bleached ground so that a rivet shows on it, wind ripples (a light crest over a dark trough), grains blown past its edge; it takes no track marks. Beside it for comparison: the desert's red clay dirt",
      shots: [...part(dune, "sand", dune.sand[0], dune.sand[1]), shot("for comparison: red clay dirt (the dirt lane), 2x", dune, (dune.dirt[0].s0 + dune.dirt[0].s1) / 2, (dune.dirt[0].lat0 + dune.dirt[0].lat1) / 2, 330, 190)],
    },
    {
      title: "OIL (CITY; BLOCK YARD)",
      note: "an oil slick on the asphalt, drawn where Track.oil has one: a puddle's outline with a hard edge, a violet black in slow swirls with a gloss on some, a sheen at its edge in three thin bands (teal, violet, amber); it takes no track marks. The city's tarmac has no cosmetic oil blots. Beside it for comparison: a pool (a rain puddle over its drain grate) and a pit",
      shots: [...part(block, "oil", block.oil[0], block.oil[1]), shot("for comparison: a pool, 2x", block, (block.water[0].s0 + block.water[0].s1) / 2, -32, 330, 190), shot("for comparison: a pit, 2x", knot, hole.s, hole.lat, 200, 190)],
    },
    {
      title: "OIL (HARBOUR; QUAY YARD)",
      note: "the same slick on a harbour track (PLAN-THEMES.md Amendment 1: oil lies on city and harbour tracks): the city's colours on the harbour's tarmac, on the right half of the road and down its middle. The harbour's tarmac has no cosmetic oil blots either. Beside it for comparison: a pool (a rain puddle on the concrete) and the pit of Slag Harbour's shortcut",
      shots: [...part(quay, "oil", quay.oil[0], quay.oil[1]), shot("for comparison: a pool, 2x", quay, (quay.water[0].s0 + quay.water[0].s1) / 2, -32, 330, 190), ((): Shot => {
        const slag = trackById("slag-harbour"), pit = slag.branches[0].road.holes[0];
        return { label: "for comparison: a pit (Slag Harbour's shortcut), 2x", track: slag, x: pit.x, y: pit.y, w: 200, h: 190, zoom: 2 };
      })()],
    },
  ];
  return compose("THEME SURFACES: SAND, OIL AND A FORD", null, [...sections, ...fordSections()], null, null);
}

/**
 * The ford on paper (TH-LOOK-3): each of Canopy Yard's two, the one whose stream runs to the
 * right of travel and the one whose stream runs to the left, whole, as a race shows it, its
 * chevrons and a bank close up, and track marks made across a bank (the ford takes none, the
 * tarmac beside it does); then what a ford must not be taken for: a pool, a mud patch, a gorge.
 */
function fordSections(): Section[] {
  const yard = testTrack("canopy-yard")!;
  const crusher = themedTrack(trackById("crusher-run"), "jungle"), gap = crusher.gaps.find((g) => !g.scrap)!;
  const marks = (s: number, lat: number) => (t: Track) => {
    for (const [ds, dl] of [[-30, -14], [40, 12]]) {
      const p = at(t, s + ds, lat + dl);
      scorchAt(t, p.x, p.y);
    }
    const q = at(t, s - 70, lat + 30);
    skidAt(t, q.x, q.y, q.h - 0.22, 150);
  };
  const one = (f: (typeof yard.fords)[number]): Section => {
    const way = f.vx > 0 ? "right" : "left", mid = (f.s0 + f.s1) / 2;
    return {
      title: `A FORD (JUNGLE; CANOPY YARD): ITS STREAM RUNS TO THE ${way.toUpperCase()} OF TRAVEL (VX ${f.vx > 0 ? "+" : ""}${f.vx})`,
      note: `drawn where Track.fords has one (s ${f.s0}..${f.s1}, from kerb to kerb), inside its declared rectangle; the traction rectangle is all ford. A shallow stream across the asphalt: jade, lighter and greener than a pool, no dark edge; shingle shows through at its two banks, which run in lobes and bays; its surface runs in streaks across the road, the way the water goes. The cue that says which way it pushes is baked and still: rows of foam chevrons whose tips point downstream, here to the ${way} of travel (the road runs ${Math.cos(at(yard, mid).h) > 0 ? "left to right" : "right to left"} in these pictures, so they point ${(Math.cos(at(yard, mid).h) > 0) === (f.vx > 0) ? "down" : "up"}): steer the other way, upstream. The centre line shows through; it takes no track marks`,
      shots: [
        shot(`the ford across the road (${f.s1 - f.s0} x ${f.lat1 - f.lat0} units), 2x`, yard, mid, 0, Math.ceil((f.s1 - f.s0) * ZOOM) + 110, 230),
        shot("its chevrons, 4x", yard, mid, 0, 150, 110, 4),
        shot("a bank, 4x", yard, f.s0 + 8, -30, 150, 110, 4),
        shot("as a race shows it, 1x", yard, mid, 0, 640, 360, 1),
        shot("as a phone shows it at 390x844@3 (1.83 device pixels a view pixel): 2x", yard, mid, 0, 213, 461, 2),
        shot("scorches and a tyre mark across a bank, 3x", yard, f.s0 + 10, 0, 250, 150, 3, marks(f.s0 + 10, 0)),
      ],
    };
  };
  return [
    ...yard.fords.map(one),
    {
      title: "WHAT A FORD MUST NOT BE TAKEN FOR",
      note: "a pool (drivable water of another kind: murky blue-grey with a dark edge, the same in every theme), a mud patch (black wet mud, the jungle's dirt), a gorge (a gap's void: soot, its river far below soot too; nothing to drive on), a pit",
      shots: [
        shot("a pool, 2x", yard, (yard.water[0].s0 + yard.water[0].s1) / 2, -32, 330, 190),
        shot("a mud patch, 2x", yard, (yard.dirt[0].s0 + yard.dirt[0].s1) / 2, (yard.dirt[0].lat0 + yard.dirt[0].lat1) / 2, 330, 190),
        shot("a gorge (Crusher Run in the theme), 2x", crusher, (gap.s0 + gap.s1) / 2, 0, 330, 250),
        ((): Shot => {
          const knot = themedTrack(trackById("overpass-knot"), "jungle"), hole = knot.holes[0];
          return shot("a pit (Overpass Knot in the theme), 2x", knot, hole.s, hole.lat, 200, 190);
        })(),
      ],
    },
  ];
}

/** A note cut into lines of at most `per` letters, at its spaces. */
function lines(note: string, per: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of note.split(" ")) {
    if (line && line.length + 1 + word.length > per) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

const STRIP_NOTE = "one row of barrels (the eight frames of a turn; desert: scoured drums; city: orange-white traffic drums; harbour: chemical drums, pale steel with black hoops and a yellow hazard label; jungle: log sections, pale weathered wood with a band of bark near either end and a patch of bark that goes round) and a press's slab with its silhouette (desert: an ore stamp; city: a pile driver; harbour: a container spreader, a twistlock housing on each corner; jungle: a log stamper, a ram of squared timber), on the theme's tarmac; the global 32 colours (sprites, not baked tiles); 4x";

/** A sheet: its title, a theme's table (or none), the sections' shots in rows, and the strip of what moves (or none). A shot is in its own track's colours. */
function compose(title: string, table: Scenery | null, sections: Section[], sprites: Picture | null, strip: Scenery | null): Picture {
  const W = 1560, PAD = 16, GAP = 12, LABEL = 12;
  const PER = Math.floor((W - 2 * PAD) / SMALL.cw); // letters a line of a note holds
  // Lay out: rows of shots, wrapped.
  let H = 60 + (table ? swatchesHeight(table) + 30 : 0);
  const placed: { sec: number; shot: Shot; x: number; y: number }[] = [];
  const heads: { y: number; title: string; note: string }[] = [];
  sections.forEach((sec, k) => {
    heads.push({ y: H, title: sec.title, note: sec.note });
    H += 24 + 10 * lines(sec.note, PER).length;
    let x = PAD, rowH = 0;
    for (const sh of sec.shots) {
      const w = sh.w * sh.zoom, h = sh.h * sh.zoom;
      if (x + w > W - PAD && x > PAD) {
        x = PAD;
        H += rowH + GAP + LABEL;
        rowH = 0;
      }
      placed.push({ sec: k, shot: sh, x, y: H + LABEL });
      x += w + GAP;
      rowH = Math.max(rowH, h);
    }
    H += rowH + LABEL + 26;
  });
  const spritesY = H;
  const stripNote = lines(STRIP_NOTE, PER);
  if (strip) H += 24 + 10 * stripNote.length + (sprites ? sprites.h : 0) + 30;

  const pic = blank(W, H, ...rgb(P.soot1));
  text(pic, title, PAD, 14, P.bone2, 3);
  text(pic, "TILES AS THE GAME'S BAKE MAKES THEM (client/gfx/world.ts), IN THE THEME'S OWN COLOURS. tools/debug/theme-sheet.ts", PAD, 42, P.bone0, 1);
  if (table) swatches(pic, table, PAD, 60);
  for (const h of heads) {
    text(pic, h.title, PAD, h.y, P.haz1, 2);
    // A long note runs on to a second line (and a third).
    lines(h.note, PER).forEach((line, k) => text(pic, line, PAD, h.y + 18 + 10 * k, P.bone0, 1));
  }
  for (const pl of placed) {
    const sh = pl.shot;
    clearMarks();
    sh.marks?.(sh.track);
    const idx = windowOf(sh.track, sh.x, sh.y, sh.w, sh.h, !!sh.marks);
    paste(pic, picture(idx, sh.w, sh.h, sceneryFor(sh.track)), pl.x, pl.y, 0, 0, sh.w, sh.h, sh.zoom);
    text(pic, sh.label, pl.x, pl.y - LABEL + 2, P.bone1, 1);
  }
  clearMarks();
  if (strip) {
    text(pic, "WHAT MOVES: THE OBSTACLE SHEET'S SPRITES IN THE THEME'S TONES", PAD, spritesY, P.haz1, 2);
    stripNote.forEach((line, k) => text(pic, line, PAD, spritesY + 18 + 10 * k, P.bone0, 1));
    if (sprites) paste(pic, sprites, PAD, spritesY + 24 + 10 * stripNote.length);
  }
  return pic;
}

/** The sprites of a track on the obstacle sheet, 4x, on the theme's tarmac: the rows under the belt's arrows that hold anything. */
function spriteStrip(track: Track): Picture | null {
  const sheet = obstacleIndexSheet(track);
  if (!sheet) return null;
  const sc = sceneryFor(track);
  const TOP = 24, Z = 4;
  let last = TOP;
  for (let i = TOP * OBST_W; i < sheet.length; i++) if (sheet[i]) last = Math.floor(i / OBST_W);
  let right = 0;
  for (let j = TOP; j <= last; j++) for (let i = 0; i < OBST_W; i++) if (sheet[j * OBST_W + i] && i > right) right = i;
  const w = Math.min(OBST_W, right + 4), h = last - TOP + 4;
  const out = blank(w * Z, h * Z, ...rgb(sc.hex[sc.index.tar1]));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = sheet[(TOP + j) * OBST_W + i];
      if (!v) continue;
      rect(out, i * Z, j * Z, Z, Z, v === FX_SHADOW ? sc.hex[sc.index.tar0] : PALETTE[v - 1].hex);
    }
  }
  return out;
}

const SW = 44, SH = 22;

function swatchesHeight(sc: Scenery): number {
  return 16 + (SH + 40) * Math.ceil(sc.count / 17);
}

/** The theme's table: every colour with its name, its SHADE and LIT beside it, and under each of the 32 the three depths of a burn. */
function swatches(pic: Picture, sc: Scenery, x0: number, y0: number): void {
  text(pic, "THE THEME'S TABLE: EACH COLOUR (WIDE), ITS CAST-SHADOW TONE (LEFT) AND SUNLIT TONE (RIGHT); UNDER EACH OF THE 32: SOOT, SINGED, CHARRED. * = THE SAME IN EVERY THEME", x0, y0, P.bone0, 1);
  for (let i = 0; i < sc.count; i++) {
    const x = x0 + (i % 17) * (SW + 46), y = y0 + 14 + Math.floor(i / 17) * (SH + 40);
    rect(pic, x, y, 14, SH, sc.hex[sc.shadeI[i]]);
    rect(pic, x + 14, y, SW, SH, sc.hex[i]);
    rect(pic, x + 14 + SW, y, 14, SH, sc.hex[sc.litI[i]]);
    if (i < SCRAPYARD) for (let l = 1; l <= 3; l++) rect(pic, x + 14 + (l - 1) * (SW / 3), y + SH, Math.ceil(SW / 3), 8, sc.hex[sc.marked[l * 32 + i]]);
    text(pic, `${sc.names[i]}${(FIXED as readonly string[]).includes(sc.names[i]) ? "*" : ""}`, x, y + SH + 11, P.bone1, 1);
    text(pic, sc.hex[i], x, y + SH + 21, P.bone0, 1);
  }
}

// ---- the readability table ---------------------------------------------------------------------

/** WCAG relative luminance of a colour, 0..1. */
function relLum(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours: 1 (none) to 21. */
function contrast(a: string, b: string): number {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A sprite's best part reaches this against a surface's plain tone, or what the scrapyard has there if that is less (3:1 is WCAG's floor for graphics). */
const MIN_CONTRAST = 3;
/** What of a surface's pixels a tone must make up to count among its tones for "the worst of them". */
const SHARE = 0.02;

interface Surface {
  name: string;
  plain: string; // its most common tone
  tones: { hex: string; share: number }[]; // every tone on it, with its share of the surface's pixels
  driven: boolean; // a car can be on it
}

/** A theme's surfaces, with their tones as the baked tiles have them: counted on a lap of the furniture's yard and of Crusher Run. */
function surfacesOf(theme: Theme): Surface[] {
  const sc = sceneryOf(theme);
  const kinds: { name: string; kind: number; driven: boolean }[] = [
    { name: "ground", kind: 0, driven: false },
    { name: "verge", kind: KIND.verge, driven: true },
    { name: "kerb", kind: KIND.kerb, driven: true },
    { name: "tarmac", kind: KIND.tarmac, driven: true },
    { name: "dirt patch", kind: KIND.dirt, driven: true },
    { name: "water", kind: KIND.water, driven: true },
    // The theme's surface (TH-LOOK-2, TH-LOOK-3): sand on the desert's yard, an oil slick on the city's and the harbour's, a ford on the jungle's. The scrapyard has none.
    { name: "sand", kind: KIND.sand, driven: true },
    { name: "oil", kind: KIND.oil, driven: true },
    { name: "ford", kind: KIND.ford, driven: true },
  ];
  const counts = kinds.map(() => new Float64Array(COLOURS));
  const own = YARD_OF[theme];
  for (const track of [themedTrack(sheetYard(), theme), themedTrack(trackById("crusher-run"), theme), ...(own ? [testTrack(own)!] : [])]) {
    const seen = new Set<string>();
    for (let s = 0; s < track.length; s += 200) {
      const p = at(track, s, 0);
      const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
      if (seen.has(`${tx},${ty}`)) continue;
      seen.add(`${tx},${ty}`);
      const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty);
      for (let i = 0; i < idx.length; i++) {
        const k = kinds.findIndex((e) => e.kind === cls[i]);
        if (k >= 0) counts[k][idx[i]]++;
      }
    }
  }
  return kinds.map((e, k) => {
    const total = counts[k].reduce((a, b) => a + b, 0);
    const order = Array.from(counts[k], (n, i) => ({ n, i })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n);
    return { name: e.name, plain: order.length ? sc.hex[order[0].i] : "", tones: order.map((o) => ({ hex: sc.hex[o.i], share: o.n / total })), driven: e.driven };
  });
}

/** What a player must see: each sprite's parts (global colours: the sprites are every theme's). A sprite is seen by its best part. */
const SPRITES: { name: string; parts: { name: string; hex: string }[] }[] = [
  ...CAR_COLORS.map((hex, i) => ({ name: `car ${i + 1}`, parts: [{ name: "body", hex }, { name: "outline", hex: P.soot1 }] })),
  { name: "rivet", parts: [{ name: "head", hex: P.haz2 }, { name: "trail", hex: P.haz1 }] },
  { name: "cell", parts: [{ name: "rim", hex: P.haz1 }, { name: "bolt", hex: P.haz2 }, { name: "well", hex: P.soot1 }] },
  { name: "mine", parts: [{ name: "body", hex: P.soot2 }, { name: "lamp", hex: P.red }, { name: "rim", hex: P.steel2 }] },
];

function contrastTable(say: (good: boolean, what: string) => void): void {
  const themes = THEMES.filter((t) => hasArt(t));
  // Per theme, sprite and surface: the best part's contrast against the plain tone, the mean over the surface's pixels, the worst tone.
  const best = new Map<string, { plain: number; mean: number; worst: number }>();
  const all = new Map<Theme, Surface[]>();
  for (const theme of themes) {
    const surfaces = surfacesOf(theme).filter((s) => s.plain);
    all.set(theme, surfaces);
    console.log(`\n### ${theme}: contrast of each sprite's parts against each surface's plain tone\n`);
    console.log(`| sprite, part | ${surfaces.map((s) => `${s.name} ${s.plain}`).join(" | ")} |`);
    console.log(`|---|${surfaces.map(() => "---:").join("|")}|`);
    for (const sp of SPRITES) {
      for (const part of sp.parts) console.log(`| ${sp.name}, ${part.name} ${part.hex} | ${surfaces.map((s) => contrast(part.hex, s.plain).toFixed(2)).join(" | ")} |`);
      for (const s of surfaces) {
        const of = (f: (hex: string) => number) => Math.max(...sp.parts.map((part) => f(part.hex)));
        best.set(`${theme}/${sp.name}/${s.name}`, {
          plain: of((hex) => contrast(hex, s.plain)),
          mean: of((hex) => s.tones.reduce((sum, t) => sum + t.share * contrast(hex, t.hex), 0)),
          worst: of((hex) => Math.min(...s.tones.filter((t) => t.share >= SHARE).map((t) => contrast(hex, t.hex)))),
        });
      }
    }
    console.log(`\n### ${theme}: each sprite by its best part: against the plain tone / the mean over the surface's pixels / the worst tone of ${SHARE * 100}% or more\n`);
    console.log(`| sprite | ${surfaces.map((s) => `${s.name}${s.driven ? "" : " (no car goes there)"}`).join(" | ")} |`);
    console.log(`|---|${surfaces.map(() => "---:").join("|")}|`);
    for (const sp of SPRITES) {
      console.log(`| ${sp.name} | ${surfaces.map((s) => {
        const b = best.get(`${theme}/${sp.name}/${s.name}`)!;
        return `${b.plain.toFixed(2)} / ${b.mean.toFixed(2)} / ${b.worst.toFixed(2)}`;
      }).join(" | ")} |`);
    }
  }
  console.log("");
  const yard = all.get("scrapyard")!;
  for (const theme of themes) {
    if (theme === "scrapyard") continue;
    const surfaces = all.get(theme)!.filter((s) => s.driven);
    // Against a plain tone: 3:1, or what the scrapyard has for the same sprite on the same surface.
    const low: string[] = [];
    let least = Infinity, leastOf = "";
    for (const sp of SPRITES) {
      for (const s of surfaces) {
        const here = best.get(`${theme}/${sp.name}/${s.name}`)!, there = best.get(`scrapyard/${sp.name}/${s.name}`);
        const floor = Math.min(MIN_CONTRAST, there ? there.plain : MIN_CONTRAST);
        if (here.plain < least) {
          least = here.plain;
          leastOf = `${sp.name} on ${s.name}`;
        }
        if (here.plain < floor - 0.005) low.push(`${sp.name} on ${s.name} ${here.plain.toFixed(2)} (the scrapyard ${there ? there.plain.toFixed(2) : "has none"})`);
      }
    }
    say(low.length === 0, `${theme}: every sprite's best part against the plain tone of every surface a car can be on reaches ${MIN_CONTRAST}:1, or the scrapyard's figure where that is less (${SPRITES.length} sprites x ${surfaces.length} surfaces; the lowest is ${least.toFixed(2)}, ${leastOf})${low.length ? `; below: ${low.join(", ")}` : ""}`);
    // The mean over a surface's pixels: no sprite loses more than a fifth of what it has in the scrapyard.
    const slips: string[] = [];
    for (const sp of SPRITES) {
      for (const s of surfaces) {
        const here = best.get(`${theme}/${sp.name}/${s.name}`)!, there = best.get(`scrapyard/${sp.name}/${s.name}`);
        if (there && here.mean < Math.min(MIN_CONTRAST, there.mean * 0.8)) slips.push(`${sp.name} on ${s.name} ${here.mean.toFixed(2)} against ${there.mean.toFixed(2)}`);
        // A surface the scrapyard has not (sand, oil) has no figure to fall back on: the mean reaches the floor itself.
        if (!there && here.mean < MIN_CONTRAST - 0.005) slips.push(`${sp.name} on ${s.name} ${here.mean.toFixed(2)} (the scrapyard has none)`);
      }
    }
    say(slips.length === 0, `${theme}: over a surface's pixels (its specks and shadows counted by their share) no sprite's mean contrast is under ${MIN_CONTRAST}:1 and under four fifths of the scrapyard's (on a surface the scrapyard has not, under ${MIN_CONTRAST}:1)${slips.length ? `: ${slips.join(", ")}` : ""}`);
    const mine = surfaces.filter((s) => s.name === "sand" || s.name === "oil" || s.name === "ford");
    if (mine.length) say(true, `${theme}: its theme surface is in the table above (${mine.map((s) => `${s.name}, plain tone ${s.plain}: ${SPRITES.map((sp) => `${sp.name} ${best.get(`${theme}/${sp.name}/${s.name}`)!.plain.toFixed(2)}`).join(", ")}`).join("; ")})`);
    // The tarmac against a mine and a rivet (PLAN-THEMES.md 2.2: tarmac may only be tinted).
    const tar = ["mine", "rivet"].map((n) => ({ n, here: best.get(`${theme}/${n}/tarmac`)!.plain, there: best.get(`scrapyard/${n}/tarmac`)!.plain }));
    say(tar.every((t) => t.here >= t.there * 0.95), `${theme}: a mine and a rivet stand out from the tarmac as in the scrapyard (within 5%): ${tar.map((t) => `${t.n} ${t.here.toFixed(2)} against ${t.there.toFixed(2)}`).join(", ")}`);
    const water = all.get(theme)!.find((s) => s.name === "water"), yardWater = yard.find((s) => s.name === "water");
    say(!!water && !!yardWater && water.plain === yardWater.plain && water.plain === P.water, `${theme}: water is the scrapyard's blue-grey (${water?.plain})`);
  }
}

// ---- the checks ------------------------------------------------------------------------------------

const lum601 = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

function check(): boolean {
  let ok = true;
  const say = (good: boolean, what: string) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  };
  const yardSc = sceneryOf("scrapyard");

  // The scrapyard's tables are the constants gfx/world.ts had before themes: worked out again here as that code did.
  {
    const idx = Object.fromEntries(PALETTE.map((e, i) => [e.name, i])) as Record<string, number>;
    const pal32 = Uint32Array.from(PALETTE, (e) => {
      const [r, g, b] = rgb(e.hex);
      return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    });
    const shadeI = Uint8Array.from(PALETTE, (e) => idx[SHADE[e.name]]), litI = Uint8Array.from(PALETTE, (e) => idx[LIT[e.name]]);
    const l = Float64Array.from(pal32, (v) => 0.299 * (v & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * ((v >> 16) & 255));
    const darker = (a: number, b: number): number => (l[b] < l[a] ? b : a);
    const marked = new Uint8Array(128);
    for (let c = 0; c < SCRAPYARD; c++) {
      const soot = shadeI[c];
      const singed = darker(soot, l[c] < 45 ? idx.soot2 : l[c] < 85 ? idx.soot3 : l[c] < 150 ? idx.dirt0 : idx.dirt1);
      const charred = darker(singed, l[c] < 45 ? idx.soot1 : l[c] < 85 ? idx.soot2 : l[c] < 150 ? idx.soot3 : idx.dirt0);
      marked[c] = c;
      marked[32 + c] = soot;
      marked[64 + c] = singed;
      marked[96 + c] = charred;
    }
    let bad = 0;
    for (let c = 0; c < PALETTE.length; c++) if (yardSc.pal32[c] !== pal32[c] || yardSc.shadeI[c] !== shadeI[c] || yardSc.litI[c] !== litI[c]) bad++;
    for (let v = 0; v < 128; v++) if (yardSc.marked[v] !== marked[v]) bad++;
    for (let v = 0; v < 256; v++) {
      const shownI = v & KEEP_OFF ? v & 63 : marked[v];
      if (yardSc.shownI[v] !== shownI || yardSc.shown[v] !== (pal32[shownI] ?? 0)) bad++;
      if (yardSc.palOff[v] !== ((v & 127) < PALETTE.length ? pal32[v & 127] : (v & 63) < PALETTE.length && (v & 0x40) === 0 ? pal32[v & 63] : 0) && (v & 0x40) === 0) bad++;
    }
    say(bad === 0, `scrapyard: its tables are the constants gfx/world.ts had before themes (the pixels of the 33 colours, SHADE and LIT, the 128 marked tones, what all 256 bytes show; ${bad} entries differ)`);
    say(yardSc.plain === P.dirt2 && yardSc.dust[0] === P.bone1 && yardSc.dust[1] === P.bone0, `scrapyard: the placeholder is dirt2 (${yardSc.plain}), the dust bone1 and bone0 (${yardSc.dust.join(", ")})`);
    const waiting = THEMES.filter((t) => !hasArt(t));
    say(waiting.every((t) => sceneryOf(t) === yardSc), `a theme whose art has not landed (${waiting.join(", ") || "none"}) has the scrapyard's scenery; landed: ${THEMES.filter((t) => hasArt(t)).join(", ")}`);
    const plain = trackById("rust-bowl");
    say(themeOf(plain) === "scrapyard" && sceneryFor(plain) === yardSc, "a track that names no theme is the scrapyard (Rust Bowl)");
    const odd = Object.assign({}, plain, { def: Object.assign({}, plain.def, { theme: "moon" }) });
    say(themeOf(odd) === "scrapyard" && !isTheme("moon") && isTheme("desert"), "a track that names an unknown theme is the scrapyard");
    say(themedTrack(plain, "scrapyard") === plain && themedTrack(plain, "desert") === themedTrack(plain, "desert") && themedTrack(plain, "desert") !== plain && themeOf(themedTrack(plain, "desert")) === "desert" && themedTrack(plain, "desert").pts === plain.pts, "the override: one copy per track and theme, the same road, the track itself for its own theme");
  }

  for (const theme of THEMES.filter((t) => hasArt(t))) {
    const sc = sceneryOf(theme), pal = sc.palette;
    console.log(`\n${theme}: ${sc.count} colours (the 32, water, ${pal.extras.length} extras)`);
    // The tables.
    say(PALETTE.every((e, i) => sc.names[i] === e.name), `${theme}: the 32 role names and water come first, in the palette's order`);
    const moved = FIXED.filter((n) => pal.colours[n] !== P[n]);
    say(moved.length === 0, `${theme}: the fixed colours are exact (${FIXED.length} names: soot, bone, hazard, the signals, water ${sc.hex[sc.index.water]})${moved.length ? `; changed: ${moved.join(", ")}` : ""}`);
    const seen = new Map<string, string>(), twice: string[] = [];
    for (let i = 0; i < sc.count; i++) {
      if (seen.has(sc.hex[i])) twice.push(`${seen.get(sc.hex[i])} = ${sc.names[i]}`);
      seen.set(sc.hex[i], sc.names[i]);
    }
    say(twice.length === 0, `${theme}: no colour under two names${twice.length ? `: ${twice.join(", ")}` : ""}`);
    const cars = CAR_COLORS.filter((c) => seen.has(c));
    say(cars.length === 0, `${theme}: none of its colours is one of the six car colours${cars.length ? `: ${cars.join(", ")}` : ""}`);
    let roleLinks = 0;
    for (let c = 0; c < SCRAPYARD; c++) if (sc.shadeI[c] >= SCRAPYARD || sc.litI[c] >= SCRAPYARD) roleLinks++;
    say(roleLinks === 0, `${theme}: the SHADE and the LIT of each of the 32 is one of the 32 (a pixel that takes marks holds five bits of colour); ${roleLinks} are not`);
    // SHADE and LIT for every index a pixel can hold, the extras with their own (a shadow on an extra must not come out as index 0, soot0).
    const unwired = pal.extras.filter((e, k) => sc.names[sc.shadeI[PALETTE.length + k]] !== e.shade || sc.names[sc.litI[PALETTE.length + k]] !== e.lit).map((e) => e.name);
    say(sc.shadeI.length === COLOURS && sc.litI.length === COLOURS && sc.pal32.length === COLOURS && unwired.length === 0, `${theme}: SHADE and LIT have ${sc.shadeI.length} entries, and each of the ${pal.extras.length} extras has the shade and the lit tone its palette names${unwired.length ? `; not: ${unwired.join(", ")}` : ""}`);
    // Luminance: SHADE <= colour <= LIT.
    const L = sc.hex.map((h) => (h ? lum601(h) : 0));
    const wrong: string[] = [];
    for (let i = 0; i < sc.count; i++) {
      if (L[sc.shadeI[i]] > L[i]) wrong.push(`SHADE ${sc.names[i]} -> ${sc.names[sc.shadeI[i]]} is lighter`);
      if (L[sc.litI[i]] < L[i]) wrong.push(`LIT ${sc.names[i]} -> ${sc.names[sc.litI[i]]} is darker`);
    }
    say(wrong.length === 0, `${theme}: luminance SHADE <= colour <= LIT for all ${sc.count} colours${wrong.length ? `: ${wrong.join("; ")}` : ""}`);
    // The burn.
    const burnTones = [...pal.burn.singed, ...pal.burn.charred].map((n) => sc.index[n]);
    const floor = Math.max(...pal.burn.charred.map((n) => L[sc.index[n]])); // a colour no lighter than the lightest charred tone cannot char darker
    const bad: string[] = [];
    let strict = 0;
    for (let c = 0; c < SCRAPYARD; c++) {
      const soot = sc.marked[32 + c], singed = sc.marked[64 + c], charred = sc.marked[96 + c];
      if (!(L[charred] <= L[singed] && L[singed] <= L[soot] && L[soot] <= L[c])) bad.push(`${sc.names[c]}: not charred <= singed <= soot <= colour`);
      else if (L[c] > floor) {
        strict++;
        if (!(L[charred] < L[singed] && L[soot] < L[c])) bad.push(`${sc.names[c]}: ${sc.names[charred]} < ${sc.names[singed]} <= ${sc.names[soot]} < itself does not hold`);
      }
    }
    say(bad.length === 0 && burnTones.every((i) => i !== undefined), `${theme}: the burn: charred <= singed <= soot <= colour for each of the 32, and charred < singed <= soot < colour for the ${strict} lighter than the lightest charred tone (luminance ${floor.toFixed(0)})${bad.length ? `: ${bad.join("; ")}` : ""}`);

    // The tiles: the sheet's places and a lap of a themed shipped track and of the furniture's yard.
    const used = new Uint32Array(COLOURS);
    let pixels = 0, outside = 0, wideMarkable = 0, waterWrong = 0, markedOutside = 0, markedLighter = 0, markedPx = 0, propsSeen = 0;
    const SOOTS = [sc.index.soot0, sc.index.soot1, sc.index.soot2, sc.index.soot3];
    const ownYard = YARD_OF[theme];
    for (const base of [trackById("crusher-run"), trackById("overpass-knot"), sheetYard(), testTrack("preview-yard")!, ...(ownYard ? [testTrack(ownYard)!] : [])]) {
      const track = themedTrack(base, theme);
      clearMarks();
      for (let s = 30; s < track.length; s += 170) {
        const p = at(track, s, ((s / 170) % 5 - 2) * 30);
        scorchAt(track, p.x, p.y);
      }
      const seenTiles = new Set<string>();
      for (let s = 0; s < track.length; s += 120) {
        for (const lat of [0, -track.wall - 150, track.wall + 150]) {
          const p = at(track, s, lat);
          const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
          if (seenTiles.has(`${tx},${ty}`)) continue;
          seenTiles.add(`${tx},${ty}`);
          const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty), marked = bakeTileMarked(track, tx, ty), keep = bakeTileMarked(track, tx, ty, true);
          for (let i = 0; i < idx.length; i++) {
            pixels++;
            const v = idx[i];
            used[v]++;
            if (v >= sc.count) outside++;
            const off = keep[i] === 255;
            if (!off && v >= SCRAPYARD) wideMarkable++;
            if ((cls[i] === KIND.water) !== (v === sc.index.water) && !(cls[i] === KIND.water && v !== sc.index.water)) waterWrong++;
            if (cls[i] === KIND.prop) propsSeen++;
            if (marked[i] >= sc.count) markedOutside++;
            else if (marked[i] !== v) {
              markedPx++;
              used[marked[i]]++;
              if (L[marked[i]] > L[v]) markedLighter++;
            }
          }
        }
      }
    }
    clearMarks();
    const unused = sc.names.slice(0, sc.count).filter((_, i) => !used[i]);
    say(outside === 0, `${theme}: every pixel of ${pixels} baked (laps of Crusher Run, Overpass Knot, the furniture's yard and Preview Yard${ownYard ? `, and of its own yard, ${ownYard}` : ""}) holds a colour of the theme's table (${outside} do not); ${sc.count - unused.length} of its ${sc.count} colours are used${unused.length ? ` (not on these tiles: ${unused.join(", ")})` : ""}`);
    say(wideMarkable === 0, `${theme}: a pixel that takes marks holds one of the 32 (${wideMarkable} hold water or an extra)`);
    say(waterWrong === 0, `${theme}: the colour water is on water pixels only (${waterWrong} elsewhere)`);
    say(markedPx > 0 && markedOutside === 0 && markedLighter === 0, `${theme}: with a scorch every 170 units, the ${markedPx} marked pixels show a colour of the table (${markedOutside} do not), never a lighter one (${markedLighter} are)`);
    // A void stays soot-dominant: counted on the gaps that hold no scrap (the chasm of Crusher Run, the crossing of Overpass Knot).
    let voidPx = 0, voidSoot = 0;
    for (const base of [trackById("crusher-run"), trackById("overpass-knot")]) {
      const track = themedTrack(base, theme);
      for (const g of track.gaps) {
        if (g.scrap) continue;
        const mid = at(track, (g.s0 + g.s1) / 2), w = Math.ceil((g.s1 - g.s0 + 2 * track.wall + 60) * ZOOM), h = w;
        const idx = windowOf(track, mid.x, mid.y, w, h), cls = windowOf(track, mid.x, mid.y, w, h, false, true);
        for (let i = 0; i < idx.length; i++) {
          if (cls[i] !== KIND.void) continue;
          voidPx++;
          if (SOOTS.includes(idx[i])) voidSoot++;
        }
      }
    }
    say(voidPx > 0 && voidSoot / voidPx >= 0.7, `${theme}: a gap's void is soot-dominant: ${((100 * voidSoot) / Math.max(1, voidPx)).toFixed(1)}% of the ${voidPx} void pixels of the gaps without scrap are soot0-soot3 (at least 70%)`);
    if (sc.id) say(propsSeen > 0, `${theme}: its props are on the tiles (${propsSeen} pixels of them)`);
    // Tarmac only tinted: no lighter than the scrapyard's, tone by tone, and near it.
    const tar = ["tar0", "tar1", "tar2", "tar3"].map((n) => ({ n, d: lum601(sc.hex[sc.index[n]]) - lum601(P[n as "tar0"]) }));
    say(tar.every((t) => Math.abs(t.d) <= 6), `${theme}: the tarmac is the scrapyard's, tinted: each tone within 6 of its luminance (${tar.map((t) => `${t.n} ${t.d >= 0 ? "+" : ""}${t.d.toFixed(1)}`).join(", ")})`);
    // What moves: global names, no car colour, eight frames.
    const tones = sc.obstacles;
    const names = [...Object.values(tones.barrel).flat(), ...Object.values(tones.slab)];
    const global = names.every((n) => n in P && n !== "water");
    const carTone = names.filter((n) => (CAR_COLORS as readonly string[]).includes(P[n]));
    say(global && carTone.length === 0, `${theme}: the barrels' and the slab's tones are of the global 32 (${new Set(names).size} of them), none a car's colour`);
    say(tones.slab.stripeA === "haz1" && tones.slab.stripeB === "soot2", `${theme}: the press's slab keeps its hazard stripes`);
    const moving = themedTrack(testTrack("preview-yard")!, theme);
    const sheet = obstacleIndexSheet(moving)!;
    const frames = new Set<string>();
    let offSheet = 0;
    for (const v of sheet) if (v && v !== FX_SHADOW && !(v >= 1 && v <= SCRAPYARD)) offSheet++;
    for (let f = 0; f < ROLL; f++) {
      let key = "";
      for (let y = 0; y < BARREL; y++) for (let x = 0; x < BARREL; x++) key += String.fromCharCode(48 + sheet[(24 + y) * OBST_W + f * BARREL + x]);
      frames.add(key);
    }
    say(frames.size === ROLL && offSheet === 0, `${theme}: Preview Yard's obstacle sheet: every pixel one of the global 32 or the cast shadow (${offSheet} others), the ${ROLL} frames of a barrel's turn ${frames.size} different pictures`);
  }
  sameRoad(say);
  sameSites(say);
  mixedPool(say);
  contrastTable(say);
  propColours(say);
  themeSurfaces(say);
  harbourRules(say);
  jungleRules(say);
  fordCue(say);
  return ok;
}

// ---- colours apart (TH-LOOK-2) -------------------------------------------------------------------

/** CIE L*a*b* of a colour (D65). */
function labOf(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** How far apart two colours are to the eye: CIE76 delta E (about 2 is just seen side by side, 10 is another colour at a glance). */
function deltaE(a: string, b: string): number {
  const p = labOf(a), q = labOf(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** A prop's tone that makes up this share of all prop pixels or more is one of its body tones; under it, an accent (a cone's white ring, a glint, a lit edge). */
const PROP_BODY = 0.005;
/**
 * A body tone of a prop is at least this far (delta E) from every car colour: the floor every
 * landed theme is held to, another colour at a glance (the desert's provisional art, which
 * TH-LOOK-1 held to "not exactly a car's colour", comes to 17.5; the city's to 27.1). A parked
 * car's paint (a thing in the shape of a car) is held to the second figure.
 */
const PROP_APART = 15, PARKED_APART = 40, REEFER_APART = 25;

/**
 * No prop is taken for a car (PLAN-THEMES.md 2.2 item 4; the advisor's readability rule): per
 * theme, every colour on its prop pixels (a lap of Rust Bowl, Crusher Run and the theme's own
 * yard) with its share of them and its distance from the nearest of the six car colours.
 */
function propColours(say: (good: boolean, what: string) => void): void {
  for (const theme of THEMES.filter((t) => hasArt(t) && t !== "scrapyard")) {
    const sc = sceneryOf(theme);
    const counts = new Float64Array(COLOURS);
    let total = 0;
    const own = YARD_OF[theme];
    // (The harbour is a shipped track's theme: Slag Harbour is lapped as well, as the game draws it.)
    for (const track of [themedTrack(trackById("rust-bowl"), theme), themedTrack(trackById("crusher-run"), theme), ...(own ? [testTrack(own)!] : []), ...(theme === "harbour" ? [trackById("slag-harbour")] : [])]) {
      const seen = new Set<string>();
      for (let s = 0; s < track.length; s += 120) {
        for (const lat of [-track.wall - 150, track.wall + 150]) {
          const p = at(track, s, lat);
          const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
          if (seen.has(`${tx},${ty}`)) continue;
          seen.add(`${tx},${ty}`);
          const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty);
          for (let i = 0; i < idx.length; i++) {
            if (cls[i] !== KIND.prop) continue;
            counts[idx[i]]++;
            total++;
          }
        }
      }
    }
    const rows = Array.from(counts, (n, i) => ({ i, share: n / total })).filter((r) => r.share > 0).sort((a, b) => b.share - a.share)
      .map((r) => ({ ...r, name: sc.names[r.i], hex: sc.hex[r.i], near: Math.min(...CAR_COLORS.map((c) => deltaE(sc.hex[r.i], c))), car: CAR_COLORS.reduce((best, c) => (deltaE(sc.hex[r.i], c) < deltaE(sc.hex[r.i], best) ? c : best)) }));
    console.log(`\n### ${theme}: the colours of its props (${total} prop pixels) against the six car colours\n`);
    console.log("| colour | share of the prop pixels | delta E to the nearest car colour | that car |");
    console.log("|---|---:|---:|---|");
    for (const r of rows) console.log(`| ${r.name} ${r.hex} | ${(100 * r.share).toFixed(2)} % | ${r.near.toFixed(1)} | ${r.car} |`);
    const body = rows.filter((r) => r.share >= PROP_BODY), near = body.filter((r) => r.near < PROP_APART);
    say(total > 0 && near.length === 0, `${theme}: every body tone of its props (${body.length} colours of ${(100 * PROP_BODY).toFixed(1)} % of the prop pixels or more) is at least delta E ${PROP_APART} from every car colour (the nearest: ${body.reduce((a, b) => (b.near < a.near ? b : a)).name}, ${Math.min(...body.map((r) => r.near)).toFixed(1)})${near.length ? `; nearer: ${near.map((r) => `${r.name} ${r.near.toFixed(1)}`).join(", ")}` : ""}; the accents under that share: ${rows.filter((r) => r.share < PROP_BODY).map((r) => `${r.name} ${r.near.toFixed(0)}`).join(", ") || "none"}`);
    // A parked car is a thing in the shape of a car: its paints (the extras a theme has for them; steel1 is the fourth).
    const paints = sc.palette.extras.filter((e) => /^(wine|moss|petrol)/.test(e.name));
    if (paints.length) {
      const least = paints.map((e) => ({ name: e.name, near: Math.min(...CAR_COLORS.map((c) => deltaE(e.hex, c))) }));
      say(least.every((e) => e.near >= PARKED_APART), `${theme}: a parked car's paints are at least delta E ${PARKED_APART} from every car colour (${least.map((e) => `${e.name} ${e.near.toFixed(1)}`).join(", ")})`);
    }
    if (theme === "jungle") {
      // The jungle (TH-LOOK-3, "every prop colour against the six CAR_COLORS"): no accent is let off, and its crowns' greens (most of its prop pixels) are named with their distance from the green car.
      const all = rows.filter((r) => r.near < PROP_APART), green = CAR_COLORS[3];
      const leaves = rows.filter((r) => /^(leaf|palm|gravel|bam)/.test(r.name)).map((r) => ({ name: r.name, d: deltaE(r.hex, green) }));
      say(all.length === 0 && leaves.every((e) => e.d >= PROP_APART), `${theme}: every colour on its prop pixels, the accents too (${rows.length} colours), is at least delta E ${PROP_APART} from every car colour (the nearest: ${rows.reduce((a, b) => (b.near < a.near ? b : a)).name}, ${Math.min(...rows.map((r) => r.near)).toFixed(1)})${all.length ? `; nearer: ${all.map((r) => `${r.name} ${r.near.toFixed(1)}`).join(", ")}` : ""}; its greens against the green car ${green}: ${leaves.map((e) => `${e.name} ${e.d.toFixed(1)}`).join(", ")}`);
    }
    if (theme === "harbour") {
      // The harbour (PLAN-THEMES.md Amendment 1: "every prop colour, containers too"): no accent is let off, every colour
      // on its prop pixels keeps the floor; and a container's or a port machine's paint, a box about a car's size in one
      // flat colour, is held as a parked car's is. A reefer's white is the one light paint: it is held to REEFER_APART.
      const all = rows.filter((r) => r.near < PROP_APART);
      say(all.length === 0, `${theme}: every colour on its prop pixels, the accents too (${rows.length} colours), is at least delta E ${PROP_APART} from every car colour (the nearest: ${rows.reduce((a, b) => (b.near < a.near ? b : a)).name}, ${Math.min(...rows.map((r) => r.near)).toFixed(1)})${all.length ? `; nearer: ${all.map((r) => `${r.name} ${r.near.toFixed(1)}`).join(", ")}` : ""}`);
      const of = (names: string[]) => names.map((n) => ({ name: n, hex: sc.hex[sc.index[n]], near: Math.min(...CAR_COLORS.map((c) => deltaE(sc.hex[sc.index[n]], c))) }));
      const boxes = of(["ox1", "grn1", "och1", "steel1"]), reefer = of(["reef1"]);
      say(boxes.every((e) => e.near >= PARKED_APART) && reefer.every((e) => e.near >= REEFER_APART), `${theme}: a container's and a port machine's paints (oxide, green, ochre, slate) are at least delta E ${PARKED_APART} from every car colour (${boxes.map((e) => `${e.name} ${e.hex} ${e.near.toFixed(1)}`).join(", ")}), a reefer's white at least ${REEFER_APART} (${reefer.map((e) => `${e.name} ${e.hex} ${e.near.toFixed(1)}`).join(", ")})`);
    }
  }
}

/** An oil slick's body is at least this far (delta E) from the tarmac's plain tone and from the water's; and sand from the dirt patch's. */
const OIL_FROM_TARMAC = 15, OIL_FROM_WATER = 25, SAND_FROM_DIRT = 25;
/** A ford's plain tone is at least this far (delta E) from a pool's water, from the tarmac, from a mud patch and from the soot of a gorge. */
const FORD_APART = 25;

/**
 * The theme surfaces are told from what lies beside them (TH-LOOK-2): on the theme's own yard,
 * an oil slick's colours are none of the tarmac's and none of a pool's, its body is far from
 * both and its outermost sheen stands out from the tarmac; sand's colours are none of a dirt
 * patch's and its plain tone is far from the patch's. Counted on baked tiles.
 */
function themeSurfaces(say: (good: boolean, what: string) => void): void {
  for (const theme of THEMES.filter((t) => hasArt(t) && YARD_OF[t])) {
    const sc = sceneryOf(theme), track = testTrack(YARD_OF[theme]!)!;
    const kinds = [KIND.tarmac, KIND.water, KIND.dirt, KIND.sand, KIND.oil, KIND.ford] as number[];
    const counts = kinds.map(() => new Float64Array(COLOURS));
    const seen = new Set<string>();
    for (let s = 0; s < track.length; s += 100) {
      const p = at(track, s, 0);
      const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
      if (seen.has(`${tx},${ty}`)) continue;
      seen.add(`${tx},${ty}`);
      const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty);
      for (let i = 0; i < idx.length; i++) {
        const k = kinds.indexOf(cls[i]);
        if (k >= 0) counts[k][idx[i]]++;
      }
    }
    const tones = (k: number) => Array.from(counts[k], (n, i) => ({ n, i })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n);
    const names = (k: number) => tones(k).map((o) => sc.names[o.i]);
    const plain = (k: number) => sc.hex[tones(k)[0].i];
    const [tarmac, water, dirt, sand, oil, ford] = [0, 1, 2, 3, 4, 5].map((k) => tones(k));
    if (ford.length) {
      // A ford against what it must not be taken for: a pool (drivable water of another kind), the tarmac, a mud patch, and a gorge's void.
      const shared = names(5).filter((n) => names(0).includes(n) || names(1).includes(n) || names(2).includes(n));
      const soot = ["soot0", "soot1", "soot2", "soot3"].map((n) => deltaE(plain(5), sc.hex[sc.index[n]]));
      const from = [{ n: "the water", hex: plain(1) }, { n: "the tarmac", hex: plain(0) }, { n: "the mud patch", hex: plain(2) }].map((e) => ({ ...e, d: deltaE(plain(5), e.hex), c: contrast(plain(5), e.hex) }));
      say(tarmac.length > 0 && water.length > 0 && dirt.length > 0 && shared.length === 0 && from.every((e) => e.d >= FORD_APART) && Math.min(...soot) >= FORD_APART,
        `${theme}: a ford on ${track.def.name} (${ford.reduce((a, o) => a + o.n, 0)} pixels in ${names(5).join(", ")}): none of its colours is the tarmac's, a pool's or a mud patch's (${shared.length ? shared.join(", ") : "none shared"}); its plain tone ${plain(5)} is delta E ${from.map((e) => `${e.d.toFixed(1)} from ${e.n} ${e.hex} (${e.c.toFixed(2)}:1)`).join(", ")} and ${Math.min(...soot).toFixed(1)} from the nearest soot of a gorge (at least ${FORD_APART} each)`);
    }
    if (oil.length) {
      const shared = names(4).filter((n) => names(0).includes(n) || names(1).includes(n));
      const fromTar = deltaE(plain(4), plain(0)), fromWater = deltaE(plain(4), plain(1));
      // Its edge: the brightest of its tones against the tarmac's plain tone.
      const rim = Math.max(...oil.map((o) => contrast(sc.hex[o.i], plain(0))));
      say(tarmac.length > 0 && water.length > 0 && shared.length === 0 && fromTar >= OIL_FROM_TARMAC && fromWater >= OIL_FROM_WATER && rim >= MIN_CONTRAST,
        `${theme}: an oil slick on ${track.def.name} (${oil.reduce((a, o) => a + o.n, 0)} pixels in ${names(4).join(", ")}): none of its colours is the tarmac's or a pool's (${shared.length ? shared.join(", ") : "none shared"}); its body ${plain(4)} is delta E ${fromTar.toFixed(1)} from the tarmac ${plain(0)} (at least ${OIL_FROM_TARMAC}) and ${fromWater.toFixed(1)} from the water ${plain(1)} (at least ${OIL_FROM_WATER}); contrast ${contrast(plain(4), plain(0)).toFixed(2)}:1 against the tarmac and ${contrast(plain(4), plain(1)).toFixed(2)}:1 against the water; its sheen stands out from the tarmac ${rim.toFixed(2)}:1 (at least ${MIN_CONTRAST}:1)`);
    }
    if (sand.length) {
      // (Its grains lie on the tarmac round it, so the tarmac's pixels hold its crests' tone too: sand is held against the dirt patch.)
      const shared = names(3).filter((n) => names(2).includes(n));
      const fromDirt = deltaE(plain(3), plain(2)), fromTar = contrast(plain(3), plain(0));
      say(dirt.length > 0 && shared.length === 0 && fromDirt >= SAND_FROM_DIRT && fromTar >= MIN_CONTRAST,
        `${theme}: sand on ${track.def.name} (${sand.reduce((a, o) => a + o.n, 0)} pixels in ${names(3).join(", ")}): none of its colours is a dirt patch's (${shared.length ? shared.join(", ") : "none shared"}); its plain tone ${plain(3)} is delta E ${fromDirt.toFixed(1)} from the dirt patch's ${plain(2)} (at least ${SAND_FROM_DIRT}) and stands out from the tarmac ${fromTar.toFixed(2)}:1 (at least ${MIN_CONTRAST}:1)`);
    }
  }
}

// ---- the harbour's own rules (TH-LOOK-H; PLAN-THEMES.md Amendment 1, A1.2) ------------------------

/** The four greys of a harbour track: the tarmac against the ground and against the verge reaches this contrast (WCAG) and this step of lightness (CIE L*); any two of the four are this far apart (delta E). */
const GREY_CONTRAST = 2, GREY_STEP = 20, GREY_APART = 8;
/** Water against the harbour's ground and its verge (delta E), and against the ground in contrast. */
const WATER_FROM_GROUND = 25, WATER_FROM_VERGE = 20, WATER_GROUND_CONTRAST = 2;
/** The kerb's yellow is at least this far (delta E) from each of the fixed hazard colours. */
const YELLOW_FROM_HAZARD = 20;
/** A crane's rails lie no nearer a road's heading than this where a road's centreline is within RAILS_NEAR units: 35 degrees is what gfx/world.ts lays them by (its cosine 0.82), a sample's own rounding aside. */
const RAILS_ACROSS = 34, RAILS_NEAR = 300;
/** Ground art keeps this far outside every barrier (world units; gfx/world.ts lays a block 13 off and a rail 10, on a grid of 4 pixels: 2.5 units of slack for a cell). */
const BLOCK_CLEAR = 13 - 2.5, RAIL_OFF = 10 - 1.5;

/**
 * What Amendment 1 asks of the harbour and no other check holds: on Quay Yard and Slag Harbour
 * as the game draws them.
 * - Paint: the kerb's two paints are a bare slab's grey and a yellow that is none of the fixed
 *   hazard colours and far from each; a kerb pixel holds a hazard colour only where every theme
 *   has one (a row of barrels crossing, a gap's end); nothing is painted on the quay or on the
 *   apron (no bay line, no hatching): no pixel of either holds bone, a hazard colour or the
 *   kerb's yellow.
 * - Props: every prop pixel lies in a block of the container yard or within its own piece's
 *   reach at a junk site (so nothing of a crane spans the yard), and that reach is within the
 *   junk's own (1.5 r + 6 pixels).
 * - Ground art (the yard's blocks, the crane rails): clear of every road's barrier, of the
 *   props, of each other and of the two flag marshals; and no rail lies along a road.
 * - A gap is a dock basin: soot, and a ladder's steel; no water, no hazard colour, no bone
 *   (counted on Crusher Run and Overpass Knot with the theme switched: no harbour track has a gap).
 * - The four greys: the tarmac against the ground and against the verge, and every pair of the
 *   four; water against the ground and the verge.
 */
function harbourRules(say: (good: boolean, what: string) => void): void {
  const theme: Theme = "harbour";
  if (!hasArt(theme)) return;
  const sc = sceneryOf(theme), x = sc.index;
  const HAZ = new Set([x.haz0, x.haz1, x.haz2]), BONE = new Set([x.bone0, x.bone1, x.bone2]), YELLOW = new Set([x.rust1, x.rust2, x.rust3]);
  const paint = (v: number) => HAZ.has(v) || BONE.has(v) || YELLOW.has(v);
  const kinds = { ground: 0, verge: KIND.verge as number, kerb: KIND.kerb as number, tarmac: KIND.tarmac as number, water: KIND.water as number };
  const tones: Record<string, Float64Array> = Object.fromEntries(Object.keys(kinds).map((k) => [k, new Float64Array(COLOURS)]));
  let kerbHaz = 0, kerbHazFixed = 0, groundPaint = 0, vergePaint = 0, propPx = 0, propLoose = 0, inBlocks = 0, pieces = 0, overReach = 0;
  let blocks = 0, blockNear = Infinity, blockProp = Infinity, blockMarshal = Infinity, blockRail = Infinity, rails = 0, railLen = 0, railNear = Infinity, railProp = Infinity, railMarshal = Infinity, railAngle = 90;
  const names: string[] = [];
  console.log("");
  for (const track of [testTrack("quay-yard")!, trackById("slag-harbour")]) {
    names.push(track.def.name);
    const roads = [track, ...track.branches.map((b) => b.road)];
    const art = artLayout(track);
    // How far outside the nearest road's barrier a point is (world units), and that road's heading there.
    const off = (wx: number, wy: number): { out: number; h: number; dist: number } => {
      let out = Infinity, h = 0, dist = Infinity;
      for (const r of roads) {
        const q = queryTrack(r, wx, wy);
        const wall = q.side < 0 ? r.wallL[q.seg] : r.wallR[q.seg];
        if (q.dist - wall - 7 < out) {
          out = q.dist - wall - 7;
          h = pointAt(r, q.s).h;
          dist = q.dist;
        }
      }
      return { out, h, dist };
    };
    const line = pointAt(track, 0);
    const marshals = [-1, 1].map((side) => {
      const lat = side * ((side < 0 ? track.wallL[0] : track.wallR[0]) + 7 + 11); // gfx/marshals.ts: BARRIER + STAND outside the wall
      return { x: (line.x - Math.sin(line.h) * lat) * ZOOM, y: (line.y + Math.cos(line.h) * lat) * ZOOM };
    });
    const props = art.junk.filter((j) => j.kind !== PROP.empty);
    pieces += props.length;
    for (const j of props) if (j.reach > j.r * 1.5 + 6 + 1e-9) overReach++;
    // The blocks and the rails, against the road, the props, the marshals and each other (view pixels but for the road's units).
    const B = art.blocks, Rl = art.rails;
    const railBox = (q: number) => (Rl[q + 2] ? [Rl[q] - Rl[q + 3], Rl[q + 4], Rl[q] + Rl[q + 3] + 2, Rl[q + 5]] : [Rl[q + 4], Rl[q + 1] - Rl[q + 3], Rl[q + 5], Rl[q + 1] + Rl[q + 3] + 2]);
    const gap = (a: number[], b: number[]) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
    for (let k = 0; k < B.length; k += 4) {
      if (B[k + 2] <= B[k]) continue;
      blocks++;
      const box = [B[k], B[k + 1], B[k + 2], B[k + 3]];
      for (let px = box[0]; px <= box[2]; px += 4) for (let py = box[1]; py <= box[3]; py += 4) blockNear = Math.min(blockNear, off(Math.min(px, box[2]) / ZOOM, Math.min(py, box[3]) / ZOOM).out);
      for (const j of props) blockProp = Math.min(blockProp, gap(box, [j.x, j.y, j.x, j.y]) - j.reach);
      for (const m of marshals) blockMarshal = Math.min(blockMarshal, gap(box, [m.x, m.y, m.x, m.y]) / ZOOM);
      for (let q = 0; q < Rl.length; q += 6) blockRail = Math.min(blockRail, gap(box, railBox(q)));
    }
    for (let q = 0; q < Rl.length; q += 6) {
      rails++;
      railLen += Rl[q + 5] - Rl[q + 4];
      const box = railBox(q);
      // The crane that stands on them is the one prop they pass under.
      for (const j of props) if (!(j.kind === PROP.crane && Math.floor(j.x) === Rl[q] && Math.floor(j.y) === Rl[q + 1])) railProp = Math.min(railProp, gap(box, [j.x, j.y, j.x, j.y]) - j.reach);
      for (const m of marshals) railMarshal = Math.min(railMarshal, gap(box, [m.x, m.y, m.x, m.y]) / ZOOM);
      for (let a = Rl[q + 4]; a < Rl[q + 5]; a += 2) {
        for (const side of [-Rl[q + 3], Rl[q + 3] + 1]) {
          const px = Rl[q + 2] ? Rl[q] + side : a, py = Rl[q + 2] ? a : Rl[q + 1] + side;
          const o = off((px + 0.5) / ZOOM, (py + 0.5) / ZOOM);
          railNear = Math.min(railNear, o.out);
          if (o.dist < RAILS_NEAR) railAngle = Math.min(railAngle, (Math.acos(Math.min(1, Math.abs(Rl[q + 2] ? Math.sin(o.h) : Math.cos(o.h)))) * 180) / Math.PI);
        }
      }
    }
    // The tiles: the road and either side of it, every road of the track.
    const seen = new Set<string>();
    for (const r of roads) {
      for (let s = 0; s < r.length; s += 120) {
        for (const lat of [0, -r.wall - 150, r.wall + 150]) {
          const p = at(r, s, lat);
          const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
          if (seen.has(`${tx},${ty}`)) continue;
          seen.add(`${tx},${ty}`);
          const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty);
          // What of the props and the blocks can reach into this tile.
          const x0 = tx * TILE, y0 = ty * TILE;
          const near = props.filter((j) => j.x + j.reach >= x0 && j.x - j.reach <= x0 + TILE && j.y + j.reach >= y0 && j.y - j.reach <= y0 + TILE);
          const rects: number[] = [];
          for (let k = 0; k < B.length; k += 4) if (B[k + 2] > B[k] && B[k + 2] > x0 && B[k] < x0 + TILE && B[k + 3] > y0 && B[k + 1] < y0 + TILE) rects.push(B[k], B[k + 1], B[k + 2], B[k + 3]);
          for (let i = 0; i < idx.length; i++) {
            const v = idx[i], k = cls[i];
            if (k === kinds.verge) {
              tones.verge[v]++;
              if (paint(v)) vergePaint++;
            } else if (k === kinds.tarmac) tones.tarmac[v]++;
            else if (k === kinds.water) tones.water[v]++;
            else if (k === 0) {
              tones.ground[v]++;
              if (paint(v)) groundPaint++;
            } else if (k === kinds.kerb) {
              tones.kerb[v]++;
              if (HAZ.has(v)) {
                // Where every theme has hazard stripes on a kerb: a row of barrels crossing it, a gap's end.
                const wx = (x0 + (i % TILE) + 0.5) / ZOOM, wy = (y0 + Math.floor(i / TILE) + 0.5) / ZOOM;
                const fixed = roads.some((road) => {
                  const q = queryTrack(road, wx, wy);
                  return road.barrels.some((b) => Math.abs(q.s - b.s) <= BARREL_R + 1) || road.gaps.some((g) => Math.abs(q.s - g.s0) <= 8 || Math.abs(q.s - g.s1) <= 8);
                });
                if (fixed) kerbHazFixed++;
                else kerbHaz++;
              }
            } else if (k === KIND.prop) {
              propPx++;
              const px = x0 + (i % TILE), py = y0 + Math.floor(i / TILE);
              let home = false;
              for (let q = 0; q < rects.length && !home; q += 4) if (px >= rects[q] && px < rects[q + 2] && py >= rects[q + 1] && py < rects[q + 3]) home = true;
              if (home) inBlocks++;
              else if (!near.some((j) => Math.hypot(px + 0.5 - j.x, py + 0.5 - j.y) <= j.reach)) propLoose++;
            }
          }
        }
      }
    }
  }
  const order = (k: string) => Array.from(tones[k], (n, i) => ({ n, i })).filter((o) => o.n > 0).sort((a, b) => b.n - a.n);
  const plain = (k: string) => sc.hex[order(k)[0].i];
  // The kerb's two paints: its two commonest tones.
  const [slab, yellow] = order("kerb").slice(0, 2).map((o) => o.i);
  const fromHaz = ["haz0", "haz1", "haz2"].map((n) => ({ n, d: deltaE(sc.hex[yellow], P[n as "haz0"]) }));
  say(sc.names[slab] === "steel2" && sc.names[yellow] === "rust2" && !(FIXED as readonly string[]).includes(sc.names[yellow]) && fromHaz.every((e) => e.d >= YELLOW_FROM_HAZARD),
    `${theme}: the kerb is bare grey slabs (${sc.names[slab]} ${sc.hex[slab]}) and slabs in a faded yellow (${sc.names[yellow]} ${sc.hex[yellow]}), which is none of the fixed colours and at least delta E ${YELLOW_FROM_HAZARD} from each hazard colour (${fromHaz.map((e) => `${e.n} ${e.d.toFixed(1)}`).join(", ")})`);
  say(kerbHaz === 0, `${theme}: a kerb pixel holds a hazard colour only where every theme has hazard stripes on a kerb (a row of barrels crossing it, a gap's end: ${kerbHazFixed} pixels on ${names.join(" and ")}); ${kerbHaz} elsewhere`);
  say(groundPaint === 0 && vergePaint === 0, `${theme}: nothing is painted on the quay or on the apron (no bay line, no hatching): ${groundPaint} ground pixels and ${vergePaint} verge pixels hold bone, a hazard colour or the kerb's yellow; the ground's tones are ${order("ground").map((o) => sc.names[o.i]).join(", ")}, the apron's ${order("verge").map((o) => sc.names[o.i]).join(", ")}`);
  say(propPx > 0 && propLoose === 0 && overReach === 0, `${theme}: every one of its ${propPx} prop pixels lies in a block of the container yard (${inBlocks}) or within its own piece's reach at a junk site (${propPx - inBlocks}; ${propLoose} lie elsewhere), and each of the ${pieces} pieces' reach, its shadow counted, is within the junk's own 1.5 r + 6 pixels (${overReach} are not): nothing of a crane or a carrier spans the yard`);
  say(blocks > 0 && blockNear >= BLOCK_CLEAR && blockProp >= 0 && blockMarshal >= 20 - 2.5 && blockRail > 0,
    `${theme}: the container yard's ${blocks} blocks (ground art, laid out per track) keep clear: the nearest comes ${blockNear.toFixed(1)} units to a barrier's outside (at least ${BLOCK_CLEAR}), ${blockProp.toFixed(1)} pixels to a prop's reach (at least 0), ${blockRail.toFixed(1)} pixels to a crane's rails (more than 0), ${Number.isFinite(blockMarshal) ? blockMarshal.toFixed(1) : "-"} units to a flag marshal's spot (at least 17.5)`);
  say(rails > 0 && railNear >= RAIL_OFF && railProp >= 0 && railMarshal >= 20 - 2.5 && railAngle >= RAILS_ACROSS,
    `${theme}: the ${rails} pairs of crane rails (${railLen} pixels of them) keep clear too: ${railNear.toFixed(1)} units to a barrier's outside (at least ${RAIL_OFF}), ${railProp.toFixed(1)} pixels to another prop's reach (at least 0), ${Number.isFinite(railMarshal) ? railMarshal.toFixed(1) : "-"} units to a marshal's spot (at least 17.5); and none lies along a road: within ${RAILS_NEAR} units of a road's centreline the least angle between a rail and the road's heading is ${railAngle.toFixed(1)} degrees (at least ${RAILS_ACROSS})`);
  // A gap is a dock basin.
  let voidPx = 0, voidOther = 0, ladder = 0;
  const SOOT = new Set([x.soot0, x.soot1, x.soot2, x.soot3]), STEEL = new Set([x.steel0, x.steel1, x.steel2]);
  const voidTones = new Set<string>();
  for (const base of [trackById("crusher-run"), trackById("overpass-knot")]) {
    const track = themedTrack(base, theme);
    for (const g of track.gaps) {
      if (g.scrap) continue;
      const mid = at(track, (g.s0 + g.s1) / 2), w = Math.ceil((g.s1 - g.s0 + 2 * track.wall + 60) * ZOOM);
      const idx = windowOf(track, mid.x, mid.y, w, w), cls = windowOf(track, mid.x, mid.y, w, w, false, true);
      for (let i = 0; i < idx.length; i++) {
        if (cls[i] !== KIND.void) continue;
        voidPx++;
        voidTones.add(sc.names[idx[i]]);
        if (STEEL.has(idx[i])) ladder++;
        else if (!SOOT.has(idx[i])) voidOther++;
      }
    }
  }
  say(voidPx > 0 && voidOther === 0 && ladder > 0, `${theme}: a gap is a dock basin of soot: the ${voidPx} void pixels of the gaps without scrap (Crusher Run and Overpass Knot in the theme) hold soot0-soot3 or a ladder's steel (${ladder} pixels of steel0-steel2) and nothing else (${voidOther} do): no water, no blue, no hazard colour, no bone (its tones: ${[...voidTones].join(", ")})`);
  // The four greys.
  const greys = [{ n: "tarmac", hex: plain("tarmac") }, { n: "ground", hex: plain("ground") }, { n: "verge", hex: plain("verge") }, { n: "kerb slab", hex: sc.hex[slab] }];
  const yard = surfacesOf("scrapyard"), yardOf = (n: string) => yard.find((e) => e.name === n)!.plain;
  console.log(`\n### ${theme}: its four greys, every pair: delta E (CIE76) / contrast (WCAG) / step of lightness (L*)\n`);
  console.log(`| | ${greys.map((g) => `${g.n} ${g.hex}`).join(" | ")} |`);
  console.log(`|---|${greys.map(() => "---:").join("|")}|`);
  for (const a of greys) console.log(`| ${a.n} ${a.hex} | ${greys.map((b) => (a === b ? "-" : `${deltaE(a.hex, b.hex).toFixed(1)} / ${contrast(a.hex, b.hex).toFixed(2)} / ${Math.abs(labOf(a.hex)[0] - labOf(b.hex)[0]).toFixed(1)}`)).join(" | ")} |`);
  console.log("");
  const tar = greys[0];
  const held = [greys[1], greys[2]].map((g) => ({ n: g.n, c: contrast(tar.hex, g.hex), step: Math.abs(labOf(tar.hex)[0] - labOf(g.hex)[0]), there: contrast(yardOf("tarmac"), yardOf(g.n)) }));
  let least = Infinity, leastOf = "";
  for (let a = 0; a < greys.length; a++) {
    for (let b = a + 1; b < greys.length; b++) {
      const d = deltaE(greys[a].hex, greys[b].hex);
      if (d < least) {
        least = d;
        leastOf = `${greys[a].n} and ${greys[b].n}`;
      }
    }
  }
  say(held.every((h) => h.c >= GREY_CONTRAST && h.c >= h.there && h.step >= GREY_STEP) && least >= GREY_APART,
    `${theme}: the four greys are told apart: the tarmac ${tar.hex} against ${held.map((h) => `the ${h.n} ${h.c.toFixed(2)}:1, ${h.step.toFixed(1)} of lightness (the scrapyard's tarmac against its ${h.n}: ${h.there.toFixed(2)}:1)`).join(" and against ")} (at least ${GREY_CONTRAST}:1, no less than the scrapyard's, and ${GREY_STEP} of lightness); the nearest two of the four are ${leastOf}, delta E ${least.toFixed(1)} (at least ${GREY_APART})`);
  const water = plain("water");
  const w = [{ n: "ground", hex: plain("ground"), floor: WATER_FROM_GROUND }, { n: "verge", hex: plain("verge"), floor: WATER_FROM_VERGE }, { n: "tarmac", hex: tar.hex, floor: 0 }].map((e) => ({ ...e, d: deltaE(water, e.hex), c: contrast(water, e.hex) }));
  say(water === P.water && w.every((e) => e.d >= e.floor) && w[0].c >= WATER_GROUND_CONTRAST,
    `${theme}: water ${water} against the ground ${w[0].hex}: delta E ${w[0].d.toFixed(1)} (at least ${WATER_FROM_GROUND}), ${w[0].c.toFixed(2)}:1 (at least ${WATER_GROUND_CONTRAST}:1); against the verge ${w[1].hex}: delta E ${w[1].d.toFixed(1)} (at least ${WATER_FROM_VERGE}), ${w[1].c.toFixed(2)}:1; against the tarmac ${w[2].hex}: delta E ${w[2].d.toFixed(1)}, ${w[2].c.toFixed(2)}:1 (the scrapyard's water against its tarmac: delta E ${deltaE(P.water, yardOf("tarmac")).toFixed(1)}, ${contrast(P.water, yardOf("tarmac")).toFixed(2)}:1; the city's ${deltaE(P.water, surfacesOf("city").find((e) => e.name === "tarmac")!.plain).toFixed(1)})`);
}

// ---- the jungle's own rules, and the ford's (TH-LOOK-3; PLAN-THEMES.md 2.2, 2.3, advisor changes 6 and 9) ----

/** A crown keeps this far outside every barrier, its shadow counted (world units; gfx/world.ts lays the canopy 9 off, on a grid of 4 pixels: 2.5 units of slack for a cell). */
const CANOPY_OFF = 9 - 2.5;
/** The jungle's tarmac against its verge reaches this contrast (WCAG) and this step of lightness (CIE L*); against its ground, which is as dark as the tarmac and of another hue, this delta E. Water against the ground and the verge: delta E. */
const VERGE_CONTRAST = 2, VERGE_STEP = 20, LOAM_APART = 12, WATER_FROM_LOAM = 15, WATER_FROM_MOSS = 20;
/** The ford's cue: a chevron's foam against the stream's plain tone (WCAG), and a chevron's least size on a phone at 390x844@3, device pixels either way. */
const CUE_CONTRAST = 3, CUE_DEVICE = 12;
/** A view pixel in device pixels at 390x844@3: the 640 wide canvas on 390 CSS pixels at three device pixels each. */
const PHONE = (390 * 3) / 640;

/**
 * What the ticket asks of the jungle and no other check holds: on Canopy Yard as the game draws it.
 * - Props: every prop pixel lies within a crown's reach in the canopy or within its own piece's
 *   reach at a junk site, and that reach is within the junk's own (1.5 r + 6 pixels); none lies
 *   where the yard's scrapyard look has a pixel of a road (so no crown reaches past a barrier).
 * - Ground art (the canopy): every crown and its shadow clear of every road's barrier, of the
 *   props and of the two flag marshals.
 * - Nothing on the tarmac: a tarmac pixel holds the palette index it has in the yard's scrapyard
 *   look, but under a cosmetic blot the jungle leaves out, at a pool's rim, in the mud thrown
 *   past a dirt patch's edge, in a mound's shadow and on the wet road at a ford's two banks.
 * - The kerb is stone and moss, with a hazard colour only where every theme has one.
 * - A gap is a river gorge: soot, the gorge's rock and its vines; no water colour, none of the
 *   ford's, no hazard colour, no bone (counted on Crusher Run and Overpass Knot with the theme
 *   switched: no jungle track has a gap).
 * - Tarmac against ground and against verge; water against ground and verge.
 */
function jungleRules(say: (good: boolean, what: string) => void): void {
  const theme: Theme = "jungle";
  if (!hasArt(theme)) return;
  const sc = sceneryOf(theme), x = sc.index, yardSc = sceneryOf("scrapyard");
  const track = testTrack("canopy-yard")!, bare = themedTrack(track, "scrapyard");
  const roads = [track, ...track.branches.map((b) => b.road)];
  const art = artLayout(track), blots = art.blots;
  console.log("");
  // How far outside the nearest road's barrier a point is (world units).
  const off = (wx: number, wy: number): number => {
    let out = Infinity;
    for (const r of roads) {
      const q = queryTrack(r, wx, wy);
      out = Math.min(out, q.dist - (q.side < 0 ? r.wallL[q.seg] : r.wallR[q.seg]) - 7);
    }
    return out;
  };
  const line = pointAt(track, 0);
  const marshals = [-1, 1].map((side) => {
    const lat = side * ((side < 0 ? track.wallL[0] : track.wallR[0]) + 7 + 11); // gfx/marshals.ts: BARRIER + STAND outside the wall
    return { x: (line.x - Math.sin(line.h) * lat) * ZOOM, y: (line.y + Math.cos(line.h) * lat) * ZOOM };
  });
  const props = art.junk.filter((j) => j.kind !== PLANT.empty);
  const overReach = props.filter((j) => j.reach > j.r * 1.5 + 6 + 1e-9).length;
  const kindsOf = Object.entries(PLANT).filter(([n]) => n !== "empty").map(([n, k]) => `${props.filter((j) => j.kind === k).length} ${n === "crown" ? "crowns" : n === "log" ? "logs" : n === "wall" ? "wall fragments" : "clumps of ferns"}`);
  let treeNear = Infinity, treeProp = Infinity, treeMarshal = Infinity, propNear = Infinity, propMarshal = Infinity;
  for (const t of art.trees) {
    const cx = t.x + 0.5, cy = t.y + 0.5;
    treeNear = Math.min(treeNear, off(cx / ZOOM, cy / ZOOM) - t.reach / ZOOM);
    for (const j of props) treeProp = Math.min(treeProp, Math.hypot(cx - j.x, cy - j.y) - t.reach - j.reach);
    for (const m of marshals) treeMarshal = Math.min(treeMarshal, (Math.hypot(cx - m.x, cy - m.y) - t.reach) / ZOOM);
  }
  for (const j of props) {
    propNear = Math.min(propNear, off(j.x / ZOOM, j.y / ZOOM) - j.reach / ZOOM);
    for (const m of marshals) propMarshal = Math.min(propMarshal, (Math.hypot(j.x - m.x, j.y - m.y) - j.reach) / ZOOM);
  }
  // The tiles: the road and either side of it.
  const HAZ = new Set([x.haz0, x.haz1, x.haz2]);
  const names = ["ground", "verge", "kerb", "tarmac", "water"], kinds = [0, KIND.verge as number, KIND.kerb as number, KIND.tarmac as number, KIND.water as number];
  const tones = kinds.map(() => new Float64Array(COLOURS));
  const shadeI = yardSc.shadeI, themeI = sc.shadeI;
  const steps = (t: Uint8Array, u: number, v: number): boolean => t[u] === v || t[v] === u || t[t[u]] === v || t[t[v]] === u;
  let propPx = 0, inCanopy = 0, propLoose = 0, onRoad = 0, tarmac = 0, tarOther = 0, lost = 0, rim = 0, thrown = 0, shadow = 0, banks = 0, kerbHaz = 0, kerbHazFixed = 0, tilesSeen = 0;
  const seen = new Set<string>();
  const cover = new Uint8Array(TILE * TILE);
  for (let s = 0; s < track.length; s += 120) {
    for (const lat of [0, -track.wall - 150, track.wall + 150]) {
      const p = at(track, s, lat);
      const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
      if (seen.has(`${tx},${ty}`)) continue;
      seen.add(`${tx},${ty}`);
      tilesSeen++;
      const idx = bakeTileIndices(track, tx, ty), cls = bakeTileKinds(track, tx, ty), was = bakeTileIndices(bare, tx, ty), wasK = bakeTileKinds(bare, tx, ty);
      const x0 = tx * TILE, y0 = ty * TILE;
      // What a crown or a prop can reach of this tile: 1 a crown's reach, 2 a prop's.
      cover.fill(0);
      const disc = (cx: number, cy: number, r: number, v: number): void => {
        for (let py = Math.max(0, Math.floor(cy - r - y0)); py <= Math.min(TILE - 1, Math.ceil(cy + r - y0)); py++) {
          for (let px = Math.max(0, Math.floor(cx - r - x0)); px <= Math.min(TILE - 1, Math.ceil(cx + r - x0)); px++) {
            if (Math.hypot(x0 + px + 0.5 - cx, y0 + py + 0.5 - cy) <= r) cover[py * TILE + px] |= v;
          }
        }
      };
      for (const t of art.trees) if (t.x + t.reach >= x0 && t.x - t.reach <= x0 + TILE && t.y + t.reach >= y0 && t.y - t.reach <= y0 + TILE) disc(t.x + 0.5, t.y + 0.5, t.reach, 1);
      for (const j of props) if (j.x + j.reach >= x0 && j.x - j.reach <= x0 + TILE && j.y + j.reach >= y0 && j.y - j.reach <= y0 + TILE) disc(j.x, j.y, j.reach, 2);
      for (let i = 0; i < idx.length; i++) {
        const v = idx[i], k = cls[i];
        const at2 = kinds.indexOf(k);
        if (at2 >= 0) tones[at2][v]++;
        if (k === KIND.prop) {
          propPx++;
          if (wasK[i] !== 0) onRoad++;
          if (cover[i] & 2) continue;
          if (cover[i] & 1) inCanopy++;
          else propLoose++;
        } else if (k === KIND.kerb && HAZ.has(v)) {
          const q = queryTrack(track, (x0 + (i % TILE) + 0.5) / ZOOM, (y0 + Math.floor(i / TILE) + 0.5) / ZOOM);
          if (track.barrels.some((b) => Math.abs(q.s - b.s) <= BARREL_R + 1) || track.gaps.some((g) => Math.abs(q.s - g.s0) <= 8 || Math.abs(q.s - g.s1) <= 8)) kerbHazFixed++;
          else kerbHaz++;
        } else if (k === KIND.tarmac && wasK[i] === KIND.tarmac) {
          tarmac++;
          if (v === was[i]) continue;
          const px = x0 + (i % TILE) + 0.5, py = y0 + Math.floor(i / TILE) + 0.5;
          const q = queryTrack(track, px / ZOOM, py / ZOOM);
          const by = (list: readonly { s0: number; s1: number; lat0: number; lat1: number }[], more: number): boolean => list.some((w) => q.s >= w.s0 - more && q.s <= w.s1 + more && q.lat >= w.lat0 - more && q.lat <= w.lat1 + more);
          if (was[i] === x.tar0 && v >= x.tar0 && v <= x.tar3 && blots.some((o) => Math.abs(px - o.x) <= o.r * 1.3 + 1 && Math.abs(py - o.y) <= o.r + 1)) lost++;
          else if (by(track.water, 6)) rim++;
          else if (by(track.dirt, 3)) thrown++;
          else if (by(track.fords, 3) && steps(themeI, was[i], v)) banks++;
          else if ((steps(shadeI, was[i], v) || steps(themeI, was[i], v)) && (track.tyres.some((m) => Math.hypot(px / ZOOM - m.x, py / ZOOM - m.y) <= m.r + 12) || by(track.islands, 12))) shadow++;
          else tarOther++;
        }
      }
    }
  }
  const order = (n: string) => Array.from(tones[names.indexOf(n)], (c, i) => ({ c, i })).filter((o) => o.c > 0).sort((a, b) => b.c - a.c);
  const plain = (n: string) => sc.hex[order(n)[0].i];
  say(propPx > 0 && propLoose === 0 && overReach === 0 && onRoad === 0,
    `${theme}: every one of the ${propPx} prop pixels on ${track.def.name} (${tilesSeen} tiles) lies within its own piece's reach at a junk site (${propPx - inCanopy - propLoose}) or within a crown's reach in the canopy (${inCanopy}; ${propLoose} lie elsewhere); each of the ${props.length} pieces (${kindsOf.join(", ")}; ${art.junk.length - props.length} sites left empty) reaches no further than the junk's own 1.5 r + 6 pixels, its shadow counted (${overReach} do); and no prop pixel lies where the yard's scrapyard look has a pixel of a road (${onRoad} do): no crown reaches past a barrier`);
  say(art.trees.length > 0 && treeNear >= CANOPY_OFF && treeProp >= 0 && treeMarshal >= 20 - 2.5 && propNear >= 0 && propMarshal >= 20 - 2.5,
    `${theme}: the canopy's ${art.trees.filter((t) => !t.fern).length} crowns and ${art.trees.filter((t) => t.fern).length} clumps of ferns (ground art, laid out per track) keep clear, their shadows counted: the nearest comes ${treeNear.toFixed(1)} units to a barrier's outside (at least ${CANOPY_OFF}), ${treeProp.toFixed(1)} pixels to a prop's reach (at least 0), ${treeMarshal.toFixed(1)} units to a flag marshal's spot (at least 17.5); the props at the junk's sites: ${propNear.toFixed(1)} units to a barrier's outside (at least 0), ${propMarshal.toFixed(1)} units to a marshal's spot (at least 17.5)`);
  say(tarmac > 0 && tarOther === 0,
    `${theme}: nothing is put on the tarmac of ${track.def.name}: its ${tarmac} tarmac pixels hold the palette index they have in the yard's scrapyard look (${tarOther} do not; aside: ${lost} under a cosmetic oil blot the jungle leaves out, ${rim} at the pool's rim, ${thrown} of the mud thrown past the dirt patch's edge, ${shadow} a shade step or two apart in a mound's shadow, ${banks} of the wet road at a ford's two banks, a shade step down)`);
  const [stone, moss] = order("kerb").slice(0, 2).map((o) => sc.names[o.i]);
  say(stone === "steel2" && moss === "gravel2" && kerbHaz === 0, `${theme}: the kerb is stone (${stone} ${sc.hex[x[stone]]}) and moss on stone (${moss} ${sc.hex[x[moss]]}); a kerb pixel holds a hazard colour only where every theme has hazard stripes on a kerb (the barrels' lane: ${kerbHazFixed} pixels); ${kerbHaz} elsewhere`);
  // A gap is a river gorge.
  let voidPx = 0, voidSoot = 0, voidRock = 0, voidVine = 0, voidOther = 0;
  const SOOT = new Set([x.soot0, x.soot1, x.soot2, x.soot3]), ROCK = new Set([x.rock0, x.rock1, x.rock2]), VINE = new Set([x.leaf2, x.leaf1, x.leaf0]); // (leaf1, leaf0: a vine in the shade of the road's end above it, and of the barrier's too)
  const others = new Set<string>();
  for (const base of [trackById("crusher-run"), trackById("overpass-knot")]) {
    const t = themedTrack(base, theme);
    for (const g of t.gaps) {
      if (g.scrap) continue;
      const mid = at(t, (g.s0 + g.s1) / 2), w = Math.ceil((g.s1 - g.s0 + 2 * t.wall + 60) * ZOOM);
      const idx = windowOf(t, mid.x, mid.y, w, w), cls = windowOf(t, mid.x, mid.y, w, w, false, true);
      for (let i = 0; i < idx.length; i++) {
        if (cls[i] !== KIND.void) continue;
        voidPx++;
        if (SOOT.has(idx[i])) voidSoot++;
        else if (ROCK.has(idx[i])) voidRock++;
        else if (VINE.has(idx[i])) voidVine++;
        else {
          voidOther++;
          others.add(sc.names[idx[i]]);
        }
      }
    }
  }
  say(voidPx > 0 && voidOther === 0 && voidRock > 0, `${theme}: a gap is a river gorge: the ${voidPx} void pixels of the gaps without scrap (Crusher Run and Overpass Knot in the theme) hold soot (${voidSoot}: ${((100 * voidSoot) / Math.max(1, voidPx)).toFixed(1)} %, its walls' steps and the river far below), the mossy rock of its rim (${voidRock}) or its vines (${voidVine}) and nothing else (${voidOther} do${others.size ? `: ${[...others].join(", ")}` : ""}): no water colour, none of the ford's, no hazard colour, no bone`);
  // Tarmac against ground and verge; water against them.
  const tar = plain("tarmac"), loam = plain("ground"), vergeHex = plain("verge"), water = plain("water");
  const yard = surfacesOf("scrapyard"), yardOf = (n: string) => yard.find((e) => e.name === n)!.plain;
  const lstep = (a: string, b: string) => Math.abs(labOf(a)[0] - labOf(b)[0]);
  say(contrast(tar, vergeHex) >= VERGE_CONTRAST && contrast(tar, vergeHex) >= contrast(yardOf("tarmac"), yardOf("verge")) && lstep(tar, vergeHex) >= VERGE_STEP && deltaE(tar, loam) >= LOAM_APART,
    `${theme}: the tarmac ${tar} against the verge ${vergeHex}: ${contrast(tar, vergeHex).toFixed(2)}:1, ${lstep(tar, vergeHex).toFixed(1)} of lightness, delta E ${deltaE(tar, vergeHex).toFixed(1)} (at least ${VERGE_CONTRAST}:1, no less than the scrapyard's ${contrast(yardOf("tarmac"), yardOf("verge")).toFixed(2)}:1, and ${VERGE_STEP} of lightness); against the ground ${loam}, dark loam of another hue behind the rail, the verge and the kerb: delta E ${deltaE(tar, loam).toFixed(1)} (at least ${LOAM_APART}), ${contrast(tar, loam).toFixed(2)}:1 (the scrapyard's tarmac against its ground: delta E ${deltaE(yardOf("tarmac"), yardOf("ground")).toFixed(1)}, ${contrast(yardOf("tarmac"), yardOf("ground")).toFixed(2)}:1)`);
  say(water === P.water && deltaE(water, loam) >= WATER_FROM_LOAM && deltaE(water, vergeHex) >= WATER_FROM_MOSS,
    `${theme}: water ${water} against the ground ${loam}: delta E ${deltaE(water, loam).toFixed(1)} (at least ${WATER_FROM_LOAM}), ${contrast(water, loam).toFixed(2)}:1; against the verge ${vergeHex}: delta E ${deltaE(water, vergeHex).toFixed(1)} (at least ${WATER_FROM_MOSS}), ${contrast(water, vergeHex).toFixed(2)}:1; against the tarmac ${tar}: delta E ${deltaE(water, tar).toFixed(1)}, ${contrast(water, tar).toFixed(2)}:1 (the scrapyard's: delta E ${deltaE(P.water, yardOf("tarmac")).toFixed(1)}, ${contrast(P.water, yardOf("tarmac")).toFixed(2)}:1)`);
}

/**
 * The ford's direction cue (PLAN-THEMES.md advisor change 6: a ford needs a baked cue that says
 * which way its current pushes): on every ford of Canopy Yard, the foam chevrons are found on
 * the baked tiles (each a connected run of foam pixels) and every one must point the way the
 * ford's drift goes, its tip downstream of its two arms: toward the right of travel where vx is
 * over 0, toward the left where it is under. And each must be large and bright enough to read
 * on a phone: its size at 390x844@3 in device pixels, its foam against the stream's plain tone.
 */
function fordCue(say: (good: boolean, what: string) => void): void {
  const theme: Theme = "jungle";
  if (!hasArt(theme)) return;
  const sc = sceneryOf(theme), track = testTrack("canopy-yard")!;
  const FOAM = sc.index.foam;
  const parts: string[] = [];
  let good = track.fords.length > 0;
  for (const f of track.fords) {
    const mid = at(track, (f.s0 + f.s1) / 2, (f.lat0 + f.lat1) / 2);
    const w = Math.ceil((f.s1 - f.s0 + f.lat1 - f.lat0) * ZOOM) + 40, h = w;
    const idx = windowOf(track, mid.x, mid.y, w, h), cls = windowOf(track, mid.x, mid.y, w, h, false, true);
    const x0 = Math.round(mid.x * ZOOM - w / 2), y0 = Math.round(mid.y * ZOOM - h / 2);
    const tones = new Float64Array(COLOURS);
    for (let i = 0; i < idx.length; i++) if (cls[i] === KIND.ford) tones[idx[i]]++;
    const plain = sc.hex[tones.indexOf(Math.max(...tones))];
    // The chevrons: connected runs of foam pixels on the ford (the foam in the shallows at its banks is specks, not runs).
    const done = new Uint8Array(w * h);
    let chevrons = 0, right = 0, left = 0, least = Infinity, most = 0;
    for (let start = 0; start < idx.length; start++) {
      if (done[start] || idx[start] !== FOAM || cls[start] !== KIND.ford) continue;
      const run: number[] = [start];
      done[start] = 1;
      for (let k = 0; k < run.length; k++) {
        const px = run[k] % w, py = Math.floor(run[k] / w);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx, qy = py + dy, q = qy * w + qx;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h || done[q] || idx[q] !== FOAM || cls[q] !== KIND.ford) continue;
          done[q] = 1;
          run.push(q);
        }
      }
      if (run.length < 12) continue;
      chevrons++;
      // Where each pixel lies on the track; the chevron points toward the side its tip is on: the pixels nearest its middle along the road are the furthest across it.
      const pts = run.map((q) => queryTrack(track, (x0 + (q % w) + 0.5) / ZOOM, (y0 + Math.floor(q / w) + 0.5) / ZOOM));
      const sMid = pts.reduce((a, q) => a + q.s, 0) / pts.length, lMid = pts.reduce((a, q) => a + q.lat, 0) / pts.length;
      const aMid = pts.reduce((a, q) => a + Math.abs(q.s - sMid), 0) / pts.length;
      const cov = pts.reduce((a, q) => a + (q.lat - lMid) * (Math.abs(q.s - sMid) - aMid), 0);
      if (cov < 0) right++;
      else left++;
      const xs = run.map((q) => q % w), ys = run.map((q) => Math.floor(q / w));
      const size = Math.min(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1), long = Math.max(Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1);
      least = Math.min(least, size);
      most = Math.max(most, long);
    }
    const way = f.vx > 0 ? "right" : "left", wrong = f.vx > 0 ? left : right;
    const c = contrast(sc.hex[FOAM], plain);
    if (!(chevrons >= 4 && wrong === 0 && c >= CUE_CONTRAST && least * PHONE >= CUE_DEVICE)) good = false;
    parts.push(`ford ${f.s0}..${f.s1} (vx ${f.vx > 0 ? "+" : ""}${f.vx}: it pushes to the ${way} of travel): ${chevrons} chevrons, ${f.vx > 0 ? right : left} point to the ${way} and ${wrong} the other way; each ${least} to ${most} view pixels across, ${(least * PHONE).toFixed(0)} to ${(most * PHONE).toFixed(0)} device pixels at 390x844@3 (at least ${CUE_DEVICE}); foam ${sc.hex[FOAM]} on the stream ${plain}: ${c.toFixed(2)}:1 (at least ${CUE_CONTRAST}:1)`);
  }
  say(good, `${theme}: a ford's baked direction cue on ${track.def.name}: foam chevrons that point the way its current pushes. ${parts.join("; ")}`);
}

/**
 * A theme changes what is painted, never where, and puts nothing on the tarmac: on the shipped
 * tracks without furniture every pixel is the same kind in every theme (a prop outside the
 * walls aside: it stands where the scrapyard has plain ground, never on a band of the road), a
 * tarmac pixel holds the same palette index (so the road's wear, paint and shadows are the
 * scrapyard's, only tinted; but for a pit's far wall inside its mouth, which is the theme's),
 * and the hazard stripes at a gap's end are the same pixels. A theme may leave the scrapyard's
 * cosmetic oil blots out (the city: an oil slick is a surface there): then a tarmac pixel under
 * a blot holds a tone of the plain tarmac instead, and no other differs. And on the furniture's
 * yards (the contact sheet's and Preview Yard) the tarmac between the features is the
 * scrapyard's too, but for a pool's rim (the desert's dried mud), the earth thrown past a dirt
 * patch's edge (the patch's own tones) and the shadow of a mound (which falls as it is heaped).
 */
function sameRoad(say: (good: boolean, what: string) => void): void {
  const yardSc = sceneryOf("scrapyard");
  const HAZ1 = yardSc.index.haz1, TAR0 = yardSc.index.tar0, TAR3 = yardSc.index.tar3;
  for (const theme of THEMES.filter((t) => hasArt(t) && t !== "scrapyard")) {
    let pixels = 0, kinds = 0, onRoad = 0, tarmac = 0, tarmacOther = 0, pitWall = 0, blots = 0, stripes = 0, stripesOther = 0;
    for (const id of ["rust-bowl", "crusher-run", "overpass-knot"]) {
      const yard = trackById(id), themed = themedTrack(yard, theme);
      const spots = artLayout(yard).blots;
      const seen = new Set<string>();
      for (let s = 0; s < yard.length; s += 120) {
        const p = at(yard, s, 0);
        const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
        if (seen.has(`${tx},${ty}`)) continue;
        seen.add(`${tx},${ty}`);
        const a = bakeTileIndices(yard, tx, ty), ak = bakeTileKinds(yard, tx, ty), b = bakeTileIndices(themed, tx, ty), bk = bakeTileKinds(themed, tx, ty);
        for (let i = 0; i < a.length; i++) {
          pixels++;
          // (A theme's props are their own kind of pixel; the scrapyard's junk is plain ground.)
          if (ak[i] !== bk[i] && bk[i] !== KIND.prop) kinds++;
          if (bk[i] === KIND.prop && ak[i] !== 0) onRoad++;
          if (ak[i] === KIND.tarmac) {
            tarmac++;
            if (a[i] !== b[i]) {
              // A pit is cut into the tarmac and its far wall is the theme's (dark rock for dark earth): inside a pit's mouth it is no decoration.
              const px = tx * TILE + (i % TILE) + 0.5, py = ty * TILE + Math.floor(i / TILE) + 0.5;
              if (yard.holes.some((h) => Math.hypot(px / ZOOM - h.x, py / ZOOM - h.y) <= h.r)) pitWall++;
              // A blot the theme leaves out: the scrapyard has its dark tone there, the theme the plain tarmac's.
              else if (a[i] === TAR0 && b[i] >= TAR0 && b[i] <= TAR3 && spots.some((o) => Math.abs(px - o.x) <= o.r * 1.3 + 1 && Math.abs(py - o.y) <= o.r + 1)) blots++;
              else tarmacOther++;
            }
            if (a[i] === HAZ1) stripes++;
            if ((a[i] === HAZ1) !== (b[i] === HAZ1)) stripesOther++;
          }
        }
      }
    }
    say(kinds === 0 && onRoad === 0, `${theme}: on Rust Bowl, Crusher Run and Overpass Knot every one of ${pixels} pixels is the same kind as in the scrapyard (the bands, the features, a void: ${kinds} differ, a prop outside the walls aside; ${onRoad} prop pixels lie on a band of the road)`);
    say(tarmacOther === 0 && stripesOther === 0, `${theme}: nothing is put on the tarmac: all ${tarmac} tarmac pixels hold the scrapyard's palette index (${tarmacOther} do not; aside: the ${pitWall} of a pit's far wall, inside its mouth, which is the theme's${blots ? `, and the ${blots} under a cosmetic oil blot of the scrapyard's, which the ${theme} leaves out: plain tarmac there` : ""}), the ${stripes} hazard-stripe pixels at the gaps' ends among them (${stripesOther} differ)`);
    // The furniture's yards: the tarmac between the features.
    let between = 0, other = 0, rim = 0, thrown = 0, shadow = 0, lost = 0;
    // A shade step by the scrapyard's links or by the theme's own (the 32 have the same links by index in every theme's table but
    // for a few: the jungle's bone shades into its leaf litter's tan, not into its moss; paint in a mound's shadow shows it).
    const shadeI = yardSc.shadeI, themeI = sceneryOf(theme).shadeI;
    const steps = (t: Uint8Array, u: number, v: number): boolean => t[u] === v || t[v] === u || t[t[u]] === v || t[t[v]] === u;
    for (const yard of [sheetYard(), testTrack("preview-yard")!]) {
      const themed = themedTrack(yard, theme);
      const spots = artLayout(yard).blots;
      const seen = new Set<string>();
      for (let s = 0; s < yard.length; s += 120) {
        const p = at(yard, s, 0);
        const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
        if (seen.has(`${tx},${ty}`)) continue;
        seen.add(`${tx},${ty}`);
        const a = bakeTileIndices(yard, tx, ty), ak = bakeTileKinds(yard, tx, ty), b = bakeTileIndices(themed, tx, ty), bk = bakeTileKinds(themed, tx, ty);
        for (let i = 0; i < a.length; i++) {
          if (ak[i] !== KIND.tarmac || bk[i] !== KIND.tarmac) continue;
          between++;
          if (a[i] === b[i]) continue;
          const px = tx * TILE + (i % TILE) + 0.5, py = ty * TILE + Math.floor(i / TILE) + 0.5;
          if (a[i] === TAR0 && b[i] >= TAR0 && b[i] <= TAR3 && spots.some((o) => Math.abs(px - o.x) <= o.r * 1.3 + 1 && Math.abs(py - o.y) <= o.r + 1)) lost++;
          else {
            // Round a pool: within its declared rectangle and 6 units more.
            const q = queryTrack(yard, px / ZOOM, py / ZOOM);
            if (yard.water.some((w) => q.s >= w.s0 - 6 && q.s <= w.s1 + 6 && q.lat >= w.lat0 - 6 && q.lat <= w.lat1 + 6)) rim++;
            // The earth thrown past a dirt patch's edge is the patch's own (the desert's red clay): within its declared rectangle, and in the barrels' lane across it.
            else if (yard.dirt.some((w) => q.s >= w.s0 - 3 && q.s <= w.s1 + 3 && q.lat >= w.lat0 - 3 && q.lat <= w.lat1 + 3)) thrown++;
            // A mound's shadow falls as the mound is heaped (sandbags lie closer than tyres): the same tarmac a shade step or two apart (two where two pieces' shadows cross), beside a mound or an island's nose.
            else if ((steps(shadeI, a[i], b[i]) || steps(themeI, a[i], b[i])) && (yard.tyres.some((m) => Math.hypot(px / ZOOM - m.x, py / ZOOM - m.y) <= m.r + 12) || yard.islands.some((m) => q.s >= m.s0 - 12 && q.s <= m.s1 + 12 && q.lat >= m.lat0 - 12 && q.lat <= m.lat1 + 12))) shadow++;
            else other++;
          }
        }
      }
    }
    say(other === 0, `${theme}: on the furniture's yards (the contact sheet's and Preview Yard) the ${between} tarmac pixels between the features hold the scrapyard's palette index (${other} do not; aside: ${rim} at a pool's rim, ${thrown} of the earth thrown past a dirt patch's edge, ${shadow} a shade step or two apart in a mound's shadow${lost ? `, ${lost} under a blot the ${theme} leaves out` : ""})`);
  }
}

/**
 * A theme's props stand at the scrapyard's junk sites and nowhere else (a theme changes what is
 * painted, never where): piece for piece the same centre and the same size as the yard's junk,
 * on shipped tracks, on Preview Yard and on the theme's own yard (held against that yard in the
 * scrapyard's look). The posts stand where they stood, too. (A town's roofs are no props in
 * this sense but the city's ground, as the dunes are the desert's: gfx/world.ts layTown lays
 * them out clear of the road, of every prop and of the marshals.)
 */
function sameSites(say: (good: boolean, what: string) => void): void {
  for (const theme of THEMES.filter((t) => hasArt(t) && t !== "scrapyard")) {
    const own = YARD_OF[theme];
    let pieces = 0, moved = 0, posts = 0, postsMoved = 0;
    const names: string[] = [];
    for (const base of [trackById("rust-bowl"), trackById("crusher-run"), testTrack("preview-yard")!, ...(own ? [testTrack(own)!] : [])]) {
      const a = artLayout(themedTrack(base, "scrapyard")), b = artLayout(themedTrack(base, theme));
      names.push(base.def.name);
      pieces += a.junk.length;
      if (a.junk.length !== b.junk.length) moved += Math.abs(a.junk.length - b.junk.length);
      for (let k = 0; k < Math.min(a.junk.length, b.junk.length); k++) if (a.junk[k].x !== b.junk[k].x || a.junk[k].y !== b.junk[k].y || a.junk[k].r !== b.junk[k].r) moved++;
      posts += a.posts.length / 2;
      if (a.posts.length !== b.posts.length) postsMoved++;
      for (let k = 0; k < Math.min(a.posts.length, b.posts.length); k++) if (a.posts[k] !== b.posts[k]) postsMoved++;
    }
    say(pieces > 0 && moved === 0 && postsMoved === 0, `${theme}: its props stand at the scrapyard's junk sites, piece for piece the same centre and size (${pieces} pieces on ${names.join(", ")}: ${moved} differ), and its ${posts} posts where the scrapyard's stand (${postsMoved} differ)`);
  }
}

/**
 * The pool holds tiles of two themes at once (advisor change 1: palette tables per tile, not
 * per race): a World of Rust Bowl and one of the same road in the desert draw the same view in
 * turn on one page; marks are made on each, and each one's marks are wiped while the other
 * draws. Every tile canvas must show its own track's bake in its own theme's colours all along.
 */
function mixedPool(say: (good: boolean, what: string) => void): void {
  const yard = trackById("rust-bowl");
  for (const theme of THEMES.filter((t) => hasArt(t) && t !== "scrapyard")) {
    const sand = themedTrack(yard, theme);
    const ctx = makeCtx({ width: VIEW_W, height: VIEW_H }) as unknown as CanvasRenderingContext2D;
    const p = at(yard, 700, 0);
    const ox = Math.round(p.x * ZOOM) - VIEW_W / 2, oy = Math.round(p.y * ZOOM) - VIEW_H / 2;
    type Blit = { src: FakeCanvas; x: number; y: number };
    const frame = (w: InstanceType<typeof World>, times = 1): Blit[] => {
      for (let k = 0; k < times; k++) {
        blits.length = 0;
        w.aim(p.x, p.y, 1000 / 60, true);
        w.draw(ox, oy, []);
      }
      return blits.slice();
    };
    // How many pixels of the tiles blitted are not what the track's own bake comes to in its own theme's colours; and how many are marked.
    const wrong = (track: Track, shown: Blit[], marked: boolean): { bad: number; marks: number } => {
      const sc = sceneryFor(track);
      let bad = 0, marks = 0;
      for (const b of shown) {
        const tx = (b.x + ox) / TILE, ty = (b.y + oy) / TILE;
        const plain = bakeTileIndices(track, tx, ty), idx = marked ? bakeTileMarked(track, tx, ty) : plain;
        for (let i = 0; i < idx.length; i++) {
          if (!b.src.px || b.src.px[i] !== sc.pal32[idx[i]]) bad++;
          if (idx[i] !== plain[i]) marks++;
        }
      }
      return { bad, marks };
    };
    clearMarks();
    const A = new World(ctx, yard);
    const a1 = frame(A);
    const r1 = wrong(yard, a1, false);
    scorchAt(yard, p.x, p.y);
    const a2 = frame(A);
    const r2 = wrong(yard, a2, true);
    // The themed World: the scrapyard's marks go, and its tiles are wiped while this one draws.
    const B = new World(ctx, sand);
    const b1 = frame(B, 10);
    const r3 = wrong(sand, b1, false), r4 = wrong(yard, a2, false);
    scorchAt(sand, p.x, p.y);
    const b2 = frame(B);
    const r5 = wrong(sand, b2, true);
    // And back: a mark on the scrapyard's track, the theme's tiles wiped while the scrapyard's World draws.
    frame(A);
    scorchAt(yard, p.x, p.y);
    const a3 = frame(A, 10);
    const r6 = wrong(yard, a3, true), r7 = wrong(sand, b2, false);
    clearMarks();
    const tilesShown = a1.length + b1.length;
    const bad = [r1, r2, r3, r4, r5, r6, r7].map((r) => r.bad);
    say(bad.every((n) => n === 0) && r2.marks > 0 && r5.marks > 0 && r6.marks > 0 && a1.length > 0 && b1.length > 0 && a1.every((t) => !b1.some((u) => u.src === t.src)),
      `${theme}: the pool holding tiles of the scrapyard and of the ${theme} at once (${tilesShown} tiles of one view of Rust Bowl in both, drawn in turn): every tile canvas shows its own bake in its own theme's colours, plain, with a scorch on it (${r2.marks} and ${r5.marks} marked pixels) and after its marks were wiped while the other theme's World drew (wrong pixels at the seven looks: ${bad.join(", ")})`);
  }
}

// ---- the override's screenshots (headless Chrome) --------------------------------------------

const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];
/** The pictures: a name, the page's query, and whether the track's own look is shot beside it (a shipped track). */
const SHOTS: { name: string; query: Record<string, string>; pair: boolean }[] = [
  { name: "rust-bowl-grid", query: { scene: "tour", track: "rust-bowl", s: "0" }, pair: true },
  { name: "rust-bowl-bend", query: { scene: "tour", track: "rust-bowl", s: "2150" }, pair: true },
  { name: "rust-bowl-hairpin", query: { scene: "tour", track: "rust-bowl", s: "4300" }, pair: true },
  { name: "rust-bowl-race", query: { scene: "rust" }, pair: true },
  { name: "rust-bowl-countdown", query: { scene: "countdown" }, pair: true },
  { name: "crusher-run-grid", query: { scene: "tour", track: "crusher-run", s: "0" }, pair: true },
  { name: "crusher-run-bend", query: { scene: "tour", track: "crusher-run", s: "1500" }, pair: true },
  { name: "crusher-run-scrap-gap", query: { scene: "tour", track: "crusher-run", s: "3330" }, pair: true },
  { name: "crusher-run-chasm", query: { scene: "tour", track: "crusher-run", s: "6560" }, pair: true },
  { name: "eight-crossing", query: { scene: "jump" }, pair: true },
  { name: "eight-holes", query: { scene: "mine" }, pair: true },
  { name: "eight-fight", query: { scene: "fx" }, pair: true },
  { name: "yard-chicane", query: { scene: "yard-chicane" }, pair: false },
  { name: "yard-truck", query: { scene: "yard-truck" }, pair: false },
  { name: "yard-split", query: { scene: "yard-split" }, pair: false },
  { name: "yard-bend", query: { scene: "yard-bend" }, pair: false },
  { name: "yard-belt", query: { scene: "yard-belt" }, pair: false },
];

/** The tour of a theme's own yard, held at these places (the distance along it). */
const YARD_PLACES: [string, number][] = [["start", 0], ["slot-a", 950], ["truck", 1800], ["mounds", 2790], ["pool", 4150], ["barrels", 5000], ["press", 6300], ["slot-b", 7270], ["split", 8300], ["dirt-lane", 8700]];

/** The tour of Slag Harbour (the shipped track that has the harbour's theme), held at these places: its distance along the main road, or along its shortcut road (&road=1). */
const SLAG_PLACES: [string, Record<string, string>][] = [
  ["start", { s: "0" }], ["quay-barrels", { s: "2640" }], ["split-island", { s: "4380" }], ["pool", { s: "4700" }], ["truck", { s: "8540" }],
  ["pier-fork", { s: "10240" }], ["pier-pit", { road: "1", s: "960" }], ["pier-merge", { s: "13230" }], ["fenders", { s: "14380" }], ["belt", { s: "17290" }],
];

async function shots(theme: Theme, out: string, port: number): Promise<void> {
  const run = promisify(execFile);
  const cleanups: (() => unknown)[] = [];
  const cleanup = async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  try {
    mkdirSync(out, { recursive: true });
    const dist = mkdtempSync(path.join(tmpdir(), "theme-sheet-dist-"));
    cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
    console.error("building the working tree ...");
    await run(path.join(ROOT, "node_modules", ".bin", "vite"), ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
    const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let file = path.join(dist, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dist, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
      createReadStream(file).pipe(res);
    });
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(port, "127.0.0.1", () => done());
    });
    const url = `http://127.0.0.1:${port}`;
    const session = arg("--session") ?? `theme-shots-${process.pid}`;
    const ab = async (more: string[]): Promise<string> => (await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 })).stdout.trim();
    cleanups.push(() => ab(["close"]));
    await ab(["--args", "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding", "open", "about:blank"]);
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const scratch = mkdtempSync(path.join(tmpdir(), "theme-sheet-png-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const shot = async (query: Record<string, string>, file: string): Promise<Picture> => {
      await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", preview: "1", freeze: "1", ...query })}`]);
      await sleep(500); // a held scene is redrawn every frame: any frame after the first will do
      await ab(["screenshot", file]);
      return decodePng(file);
    };
    // The game canvas's own pixels (640 x 360), for the count of colours.
    const GRAB = `(() => { const c = document.getElementById("view"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = ""; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return btoa(s); })()`;
    const canvasColours = async (): Promise<Set<number>> => {
      const data = Buffer.from(JSON.parse(await ab(["eval", "-b", Buffer.from(GRAB).toString("base64")])) as string, "base64");
      const set = new Set<number>();
      for (let i = 0; i < data.length; i += 4) set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      return set;
    };
    const sc = sceneryOf(theme);
    const table = new Set(sc.hex.slice(0, sc.count).map((h) => parseInt(h.slice(1), 16)));
    const lines: string[] = [];
    let mixed = 0, held = 0;
    // The override's pictures, then the theme's own yard as it is (`own`: no switch in the query).
    const ownYard = YARD_OF[theme], only = arg("--only");
    const list: { name: string; query: Record<string, string>; pair: boolean; own?: boolean }[] = [
      ...SHOTS,
      ...(ownYard ? YARD_PLACES.map(([place, s]) => ({ name: `${ownYard}-${place}`, query: { scene: "tour", track: ownYard, s: String(s) }, pair: false, own: true })) : []),
      // The harbour is a shipped track's theme: Slag Harbour as the game draws it, the tour held round its lap and down its shortcut.
      ...(theme === "harbour" ? SLAG_PLACES.map(([place, q]) => ({ name: `slag-harbour-${place}`, query: { scene: "tour", track: "slag-harbour", ...q }, pair: false, own: true })) : []),
    ].filter((sh) => !only || sh.name.startsWith(only));
    for (const size of SIZES) {
      await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
      for (const sh of list) {
        const file = path.join(out, `${theme}-${sh.name}-${size.name}.png`);
        // No caption over the picture: the world is what is to be judged (a HUD scene keeps its own HUD).
        const query = { ...sh.query, hud: "0" };
        const themed = await shot(sh.own ? query : { ...query, theme }, file);
        lines.push(file);
        if (size.scale === 3) {
          // The world's colours on that screen: how many of the canvas's colours are the theme's table's.
          const seen = await canvasColours();
          let own = 0;
          for (const c of seen) if (table.has(c)) own++;
          // The screen inside the canvas's box (a device pixel in from its edges): only the canvas's own colours?
          const box = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify((({x, y, width, height}) => [x, y, width, height])(document.getElementById('view').getBoundingClientRect()))"])) as string) as number[];
          const x0 = Math.ceil(box[0] * size.scale) + 1, y0 = Math.ceil(box[1] * size.scale) + 1, x1 = Math.floor((box[0] + box[2]) * size.scale) - 1, y1 = Math.floor((box[1] + box[3]) * size.scale) - 1;
          let other = 0, inside = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const o = (y * themed.w + x) * 4;
              inside++;
              if (!seen.has((themed.data[o] << 16) | (themed.data[o + 1] << 8) | themed.data[o + 2])) other++;
            }
          }
          mixed += other;
          held += inside;
          lines.push(`  (game canvas: ${seen.size} colours, ${own} of them the theme's table's; on the screen ${inside} device pixels in its box, ${other} of a colour the canvas does not hold)`);
        }
        if (sh.pair) {
          const plain = await shot(query, path.join(scratch, "plain.png"));
          const pair = blank(plain.w + themed.w + 12, Math.max(plain.h, themed.h), 18, 14, 11);
          paste(pair, plain, 0, 0);
          paste(pair, themed, plain.w + 12, 0);
          const pairFile = path.join(out, `pair-${sh.name}-${size.name}.png`);
          savePng(pairFile, pair);
          lines.push(pairFile);
        }
        console.error(file);
      }
    }
    console.log(lines.join("\n"));
    console.log(`\n${mixed === 0 && held > 0 ? "ok  " : "FAIL"}  at 390x844@3 every device pixel inside the game canvas's box has a colour the canvas itself holds: ${held} pixels in ${list.length} shots, ${mixed} of another colour (the canvas is scaled without smoothing: a contrast figure of the palette is that screen's)`);
    if (mixed !== 0 || held === 0) process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// ---- rule 1 per theme (no browser) --------------------------------------------------------------

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

/** One theme, in this process: the two drives, the bytes a frame, the functions they are charged to. */
async function allocOne(theme: Theme): Promise<void> {
  const { Session } = await import("node:inspector/promises");
  const { World, worldStats, VIEW_W, VIEW_H } = await import("../../client/gfx/world");
  const { Renderer } = await import("../../client/render");
  const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
  const WARM = option("--warm", 30000), FRAMES = option("--frames", 6000), INTERVAL = option("--interval", 128);
  const SPEED = 430, DT = 1000 / 60;
  // A canvas that draws nothing and allocates nothing when drawn on.
  const quiet = (): { width: number; height: number; getContext: () => unknown } => {
    const nothing = (): void => {};
    const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    const attributes = { willReadFrequently: true }, size = { width: 30 };
    const ctx: Record<string, unknown> = {
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineJoin: "", lineCap: "", font: "", textAlign: "", textBaseline: "", imageSmoothingEnabled: false,
      createImageData: pixels,
      getImageData: (_x: number, _y: number, w: number, h: number) => pixels(w, h),
      measureText: () => size,
      getContextAttributes: () => attributes,
    };
    for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "drawImage", "putImageData", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
    const canvas = { width: 0, height: 0, getContext: () => ctx };
    ctx.canvas = canvas;
    return canvas;
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => quiet() };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  const sink: unknown[] = new Array(1024).fill(null);
  console.log(`\n## ${theme}\n`);
  console.log(`${WARM} warm frames, then ${FRAMES} measured; a lap at ${SPEED} u/s; sampling every ${INTERVAL} bytes, objects collected since included.\n`);
  console.log("| drive | tiles baked while measured | client/ bytes a frame | outside | the same with the control (an object a frame) | charged to |");
  console.log("|---|---:|---:|---:|---:|---|");
  // (A theme with a yard of its own is driven round that as well: its theme surface is baked on the way.)
  for (const drive of ["world", "renderer", ...(YARD_OF[theme] ? (["own"] as const) : [])] as const) {
    const track = drive === "own" ? testTrack(YARD_OF[theme]!)! : themedTrack(drive === "world" ? trackById("crusher-run") : testTrack("preview-yard")!, theme);
    const lap = Math.ceil((track.length / SPEED) * 60);
    const xs = new Float64Array(lap), ys = new Float64Array(lap), hs = new Float64Array(lap), ox = new Int32Array(lap), oy = new Int32Array(lap);
    for (let i = 0; i < lap; i++) {
      const p = pointAt(track, (i * SPEED) / 60);
      xs[i] = p.x;
      ys[i] = p.y;
      hs[i] = p.h;
      ox[i] = Math.round(p.x * ZOOM) - VIEW_W / 2;
      oy[i] = Math.round(p.y * ZOOM) - VIEW_H / 2;
    }
    let frameNo = 0, control = false;
    let run: (n: number) => void;
    if (drive === "world") {
      const w = new World(quiet().getContext() as CanvasRenderingContext2D, track);
      const car = { id: "a", x: 0, y: 0, h: 0, color: "#e8552d", name: "a", me: true, wreck: false, ghost: false };
      const cars = [car];
      run = (n) => {
        for (let i = 0; i < n; i++, frameNo++) {
          const k = frameNo % lap;
          car.x = xs[k];
          car.y = ys[k];
          car.h = hs[k];
          w.aim(xs[k], ys[k], DT, false);
          w.draw(ox[k], oy[k], cars);
          if (control) sink[frameNo & 1023] = { a: frameNo, b: k, c: 1, d: 2 };
        }
      };
    } else {
      const r = new Renderer(quiet() as unknown as HTMLCanvasElement, track);
      const cars = CAR_COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color: color as string, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, car: (["sport", "racer", "truck"] as const)[i % 3] }));
      const fx = { shots: [], mines: [], sparks: [], rt: 0 };
      const times = new Float64Array(1);
      run = (n) => {
        for (let i = 0; i < n; i++, frameNo++) {
          const k = frameNo % lap;
          for (let c = 0; c < cars.length; c++) {
            const j = (k + lap - c * 9) % lap;
            // On the verge every other lap: the dust.
            const lane = ((frameNo / lap) | 0) & 1 ? 78 : (c - 2.5) * 16;
            cars[c].x = xs[j] - Math.sin(hs[j]) * lane;
            cars[c].y = ys[j] + Math.cos(hs[j]) * lane;
            cars[c].h = hs[j];
          }
          fx.rt = frameNo;
          times[0] = 10000 + frameNo * DT;
          r.follow(xs[k], ys[k], DT, false, "c0");
          r.frame(cars, fx, null, times[0]);
          if (control) sink[frameNo & 1023] = { a: frameNo, b: k, c: 1, d: 2 };
        }
      };
    }
    const sample = async (): Promise<{ inside: number; outside: number; rows: [string, number][] }> => {
      await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      run(FRAMES);
      const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };
      const charged = new Map<string, number>();
      let inside = 0, outside = 0;
      const walk = (node: ProfileNode, owner: string): void => {
        const f = node.callFrame;
        const at = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
        const here = at < 0 ? owner : `${f.url.slice(at + 8)} ${f.functionName || "(anonymous)"}`;
        if (node.selfSize > 0) {
          if (here) {
            const key = at < 0 ? `${here} > ${f.functionName || "(anonymous)"}` : here;
            charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
            inside += node.selfSize;
          } else outside += node.selfSize;
        }
        for (const c of node.children ?? []) walk(c, here);
      };
      walk(profile.head, "");
      return { inside, outside, rows: [...charged].sort((a, b) => b[1] - a[1]) };
    };
    run(WARM);
    const baked0 = worldStats.baked;
    const plain = await sample();
    const baked = worldStats.baked - baked0;
    control = true;
    run(2000);
    const withControl = await sample();
    control = false;
    const f1 = (x: number) => (x / FRAMES).toFixed(1);
    console.log(`| ${drive === "world" ? "World, a lap of Crusher Run" : drive === "own" ? `Renderer.frame, a lap of ${track.def.name}` : "Renderer.frame, a lap of Preview Yard"} | ${baked} | **${f1(plain.inside)}** | ${f1(plain.outside)} | client/ ${f1(withControl.inside)}, outside ${f1(withControl.outside)} | ${plain.rows.length ? plain.rows.slice(0, 6).map(([k, b]) => `${k} ${f1(b)}`).join("; ") : "nothing"} |`);
  }
  session.disconnect();
}

/** Each theme whose art has landed, in a process of its own (no theme's compiled code or heap is another's). */
function alloc(): void {
  const self = fileURLToPath(import.meta.url);
  const pass = args.filter((a, i) => ["--warm", "--frames", "--interval"].includes(a) || ["--warm", "--frames", "--interval"].includes(args[i - 1]));
  console.log("# Rule 1 per theme: bytes a frame allocates (tools/debug/theme-sheet.ts --alloc)");
  for (const theme of THEMES.filter((t) => hasArt(t))) {
    const out = execFileSync(process.execPath, [...process.execArgv, self, "--alloc-one", theme, ...pass], { encoding: "utf8", maxBuffer: 16 << 20 });
    process.stdout.write(out);
  }
}

// ---- main ----------------------------------------------------------------------------------------

if (args.includes("--check")) {
  if (!check()) process.exit(1);
} else if (args.includes("--contrast")) {
  let ok = true;
  contrastTable((good, what) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  });
  if (!ok) process.exit(1);
} else if (args.includes("--alloc-one")) {
  const theme = arg("--alloc-one") ?? "";
  if (!isTheme(theme)) throw new Error(`unknown theme ${theme}`);
  await allocOne(theme);
  process.exit(0);
} else if (args.includes("--alloc")) {
  alloc();
} else if (args.includes("--shots")) {
  const theme = arg("--theme") ?? "desert";
  if (!isTheme(theme)) throw new Error(`unknown theme ${theme}`);
  await shots(theme, path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "th-look", "shots")), Number(arg("--port") ?? 3017));
  process.exit(process.exitCode ?? 0);
} else if (args.includes("--ford")) {
  const out = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "th-look", "ford-sheet.png"));
  mkdirSync(path.dirname(out), { recursive: true });
  savePng(out, compose("THE FORD: BOTH WAYS ITS STREAM CAN RUN", null, fordSections(), null, null));
  console.log(out);
} else if (args.includes("--surfaces")) {
  const out = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "th-look", "surfaces-sheet.png"));
  mkdirSync(path.dirname(out), { recursive: true });
  savePng(out, surfaces());
  console.log(out);
} else {
  const theme = arg("--theme") ?? "desert";
  if (!isTheme(theme)) throw new Error(`unknown theme ${theme}`);
  const out = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "th-look", `${theme}-sheet.png`));
  mkdirSync(path.dirname(out), { recursive: true });
  savePng(out, sheet(theme));
  console.log(out);
}
