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
//   npx tsx tools/debug/theme-sheet.ts --surfaces         the theme surfaces' sheet: sand and oil -> tmp/th-look/surfaces-sheet.png
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
// drawn), the tour held at ten places round the lap: `<theme>-<yard>-<place>-<size>.png`.
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

const { artLayout, bakeTileIndices, bakeTileKinds, bakeTileMarked, clearMarks, KIND, MARK, scorch, skid, TILE, VIEW_H, VIEW_W, World, ZOOM } = await import("../../client/gfx/world");
const { BARREL, obstacleIndexSheet, ROLL } = await import("../../client/gfx/obstacles");
const { CAR_COLORS, FIXED, LIT, P, PALETTE, rgbOf, SCRAPYARD, SHADE } = await import("../../client/gfx/palette");
const { FX_SHADOW, OBST_W } = await import("../../client/gfx/sprites");
const { FONT_LETTERS, SMALL } = await import("../../client/gfx/font");
const { COLOURS, hasArt, isTheme, KEEP_OFF, sceneryFor, sceneryOf, themedTrack, themeOf, THEMES } = await import("../../client/gfx/theme");
const { testTrack } = await import("../../shared/testtracks");
const { pointAt, queryTrack } = await import("../../shared/track");
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
  if (sc.theme === "city") {
    // A town's roofs are props too (the same kind of pixel): its heaps by the art's own list, a heap being the pieces within 50 pixels of its first.
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
const YARD_OF: Partial<Record<Theme, string>> = { desert: "dune-yard", city: "block-yard" };

function sheet(theme: Theme): Picture {
  const sc = sceneryOf(theme);
  const crusher = themedTrack(trackById("crusher-run"), theme), knot = themedTrack(trackById("overpass-knot"), theme);
  const yard = themedTrack(sheetYard(), theme), preview = themedTrack(testTrack("preview-yard")!, theme), rust = themedTrack(trackById("rust-bowl"), theme);
  const gap = crusher.gaps.find((g) => !g.scrap)!, scrap = crusher.gaps.find((g) => g.scrap)!, hole = knot.holes[0];
  const props = propSpots(rust, theme === "city" ? 9 : 6);
  const sections: Section[] = [
    {
      title: "THE ROAD'S BANDS",
      note: "ground, barrier (desert: sandstone blocks; city: concrete in lengths, an amber reflector stud where a post stands), verge (city: a sidewalk's slabs), kerb (city: grey and white stones), tarmac with its centre line; a straight at 4x, the start line, a bend and a tight bend at 2x",
      shots: [shot("a straight, 4x", rust, 700, -70, 170, 110, 4), shot("start line and grid", rust, 6, 0, 300, 220), shot("a bend", rust, 2300, 0, 300, 220), shot("a tight bend", yard, 2800, 0, 300, 220)],
    },
    {
      title: "THE GROUND",
      note: "outside the walls. scrapyard: packed earth, stains and wheel ruts; desert: sand, dune crests and wind ripples; city: old paving and the roofs of the town (clay tiles, slate, zinc; gabled, hipped, flat with vents), their shadows in the alleys; at 2x and at 1x",
      shots: [shot("ground, 2x", rust, 1200, -420, 330, 220), shot("ground, 2x", crusher, 2000, 400, 330, 220), shot("ground, 1x", rust, 1200, -520, 640, 360, 1)],
    },
    {
      title: "PROPS OUTSIDE THE WALLS",
      note: "at the yard's junk sites. desert: rock outcrops (two stones), dry scrub, round succulents, half-buried car shells; city: planter trees, crates, traffic cones, parked cars in wine, moss, petrol and grey (no car's colour); 3x",
      shots: props.map((p, k) => ({ label: `heap ${k + 1}`, track: rust, x: p.x, y: p.y, h: 0, w: 150, zoom: 3, ...{ h: 110 } })),
    },
    {
      title: "GAPS AND PITS",
      note: "a gap's void (soot; desert: layered rock near the rim; city: a concrete coping and a street below, all of it soot) with its ramp, hazard ends and broken edge; a gap filled with scrap (desert: boulders; city: rubble and crates); a pit",
      shots: [
        shot("chasm: ramp, void, far end", crusher, (gap.s0 + gap.s1) / 2 - 40, 0, 400, 300),
        shot("the void's rim, 4x", crusher, gap.s0 + 14, crusher.wall - 30, 150, 110, 4),
        shot("a gap filled with scrap", crusher, (scrap.s0 + scrap.s1) / 2, 0, 330, 300),
        shot("a pit, 4x", knot, hole.s, hole.lat, 130, 110, 4),
      ],
    },
    {
      title: "THE ROAD'S FURNITURE",
      note: "water (blue-grey in every theme; desert: a rim of dried, cracked mud; city: a rain puddle over its drain grate), a dirt patch (desert: red clay; city: roadworks, taped off), a belt, the barrels' lane with hatch and gutter, a press's bed, mounds (desert: sandbags; city: a strapped tyre bundle), an island with its noses, the ramp truck (desert: a sand hauler; city: a car carrier)",
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
      note: `${t.def.id} (shared/testtracks.ts), whole views at 1x round the lap: its theme surface (${theme === "city" ? "an oil slick" : "sand"}) across the road and on half of it, the truck, the mounds, the pool in the bend, the barrels' lane, the press, the split with its dirt lane`,
      shots: [view("the start", 0), view("slot A", 950), view("the truck", 1800), view("the mounds", 2790), view("the pool in the bend", 4150), view("the barrels' lane", 5000), view("the press", 6300), view("slot B", 7270), view("the split", 8300), view("the dirt lane", 8700)],
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
  const dune = testTrack("dune-yard")!, block = testTrack("block-yard")!;
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
    shot(`its edge, 4x`, t, a.s0 + 26, -30, 150, 110, 4),
    shot(`${what} on half the road (${b.s1 - b.s0} x ${b.lat1 - b.lat0} units), 2x`, t, (b.s0 + b.s1) / 2, 0, Math.ceil((b.s1 - b.s0) * ZOOM) + 90, 230),
    shot("scorches and a tyre mark across its edge, 3x", t, a.s0 + 10, 0, 250, 150, 3, marks(a.s0 + 10, 0)),
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
  ];
  return compose("THEME SURFACES: SAND AND OIL", null, sections, null, null);
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

const STRIP_NOTE = "one row of barrels (the eight frames of a turn; desert: scoured drums; city: orange-white traffic drums) and a press's slab with its silhouette (desert: an ore stamp; city: a pile driver), on the theme's tarmac; the global 32 colours (sprites, not baked tiles); 4x";

/** A sheet: its title, a theme's table (or none), the sections' shots in rows, and the strip of what moves (or none). A shot is in its own track's colours. */
function compose(title: string, table: Scenery | null, sections: Section[], sprites: Picture | null, strip: Scenery | null): Picture {
  const W = 1560, PAD = 16, GAP = 12, LABEL = 12;
  const PER = Math.floor((W - 2 * PAD) / 6); // letters a line of a note holds
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
    // The theme's surface (TH-LOOK-2): sand on the desert's yard, an oil slick on the city's. The scrapyard has neither.
    { name: "sand", kind: KIND.sand, driven: true },
    { name: "oil", kind: KIND.oil, driven: true },
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
    const mine = surfaces.filter((s) => s.name === "sand" || s.name === "oil");
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
  mixedPool(say);
  contrastTable(say);
  propColours(say);
  themeSurfaces(say);
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
const PROP_APART = 15, PARKED_APART = 40;

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
    for (const track of [themedTrack(trackById("rust-bowl"), theme), themedTrack(trackById("crusher-run"), theme), ...(own ? [testTrack(own)!] : [])]) {
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
  }
}

/** An oil slick's body is at least this far (delta E) from the tarmac's plain tone and from the water's; and sand from the dirt patch's. */
const OIL_FROM_TARMAC = 15, OIL_FROM_WATER = 25, SAND_FROM_DIRT = 25;

/**
 * The theme surfaces are told from what lies beside them (TH-LOOK-2): on the theme's own yard,
 * an oil slick's colours are none of the tarmac's and none of a pool's, its body is far from
 * both and its outermost sheen stands out from the tarmac; sand's colours are none of a dirt
 * patch's and its plain tone is far from the patch's. Counted on baked tiles.
 */
function themeSurfaces(say: (good: boolean, what: string) => void): void {
  for (const theme of THEMES.filter((t) => hasArt(t) && YARD_OF[t])) {
    const sc = sceneryOf(theme), track = testTrack(YARD_OF[theme]!)!;
    const kinds = [KIND.tarmac, KIND.water, KIND.dirt, KIND.sand, KIND.oil] as number[];
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
    const [tarmac, water, dirt, sand, oil] = [0, 1, 2, 3, 4].map((k) => tones(k));
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
    const shadeI = yardSc.shadeI; // (the 32 have the same links by index in every theme's table but for a few, and these are the scrapyard's tarmac tones)
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
            else if ((shadeI[a[i]] === b[i] || shadeI[b[i]] === a[i] || shadeI[shadeI[a[i]]] === b[i] || shadeI[shadeI[b[i]]] === a[i]) && (yard.tyres.some((m) => Math.hypot(px / ZOOM - m.x, py / ZOOM - m.y) <= m.r + 12) || yard.islands.some((m) => q.s >= m.s0 - 12 && q.s <= m.s1 + 12 && q.lat >= m.lat0 - 12 && q.lat <= m.lat1 + 12))) shadow++;
            else other++;
          }
        }
      }
    }
    say(other === 0, `${theme}: on the furniture's yards (the contact sheet's and Preview Yard) the ${between} tarmac pixels between the features hold the scrapyard's palette index (${other} do not; aside: ${rim} at a pool's rim, ${thrown} of the earth thrown past a dirt patch's edge, ${shadow} a shade step or two apart in a mound's shadow${lost ? `, ${lost} under a blot the ${theme} leaves out` : ""})`);
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
