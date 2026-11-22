// The flag marshals at the start/finish line on paper (MARSHALS-1; client/gfx/marshals.ts).
//
//   npx tsx tools/debug/marshal-sheet.ts                 the contact sheet -> tmp/marshals/contact-sheet.png
//   npx tsx tools/debug/marshal-sheet.ts --out file.png  ... somewhere else
//   npx tsx tools/debug/marshal-sheet.ts --check         no picture: the checks below, exit code 1 if one fails
//   npx tsx tools/debug/marshal-sheet.ts --alloc         rule 1: bytes a frame allocates with the marshals in view,
//                                                        through every phase (--warm 30000, --frames 6000, --interval 128)
//   npx tsx tools/debug/marshal-sheet.ts --shots         screenshots of every phase, in headless Chrome -> tmp/marshals/shots/
//                                                        (--out <dir>, --port <n>: default 3016), and the pixel proof below
//
// The contact sheet (Node, no browser): the sprite sheet as the game paints it for a track's
// line, enlarged; every phase of a scripted race (at ease, the countdown, GO, the last lap, the
// finish, the race over) at the line of two tracks, the figures enlarged and the whole line
// beside them; and the line of every track there is in both landed themes. The ground is the
// game's own bake (gfx/world.ts bakeTileIndices), and the marshals are put on it from what the
// game's own Marshals.draw() asks a canvas to draw.
//
// --check (Node), for every shipped track and every test track, in every theme whose art has
// landed:
// - both marshals stand: each side's spot is clear of every road (marshalSpot);
// - every picture fits its cell at the track's heading, and at 360 headings a degree apart;
// - every pixel of the sheet is a palette colour or the cast shadow;
// - no pixel of a figure (its body and outline; not its shadow, not its flag) lies on anything
//   but open ground: none on the road, a kerb, the verge, a barrier or its rail, a post, a
//   theme's prop (the bake's own kinds, bakeTileKinds), and none on a colour the theme's open
//   ground does not have (the scrapyard's junk is plain ground to the kinds: its colours tell);
// - a waved flag reaches no further toward the track than the wall line: it stays off the road;
// - culling: with the view moved past the marshals a pixel at a time, a sprite is drawn whenever
//   its cell has a pixel in the view, and nothing is drawn far off;
// - the wave's four pictures of each flag are four different pictures, and the three flags
//   differ from each other in every one of them;
// - no tone of the uniform or the flags is one of the six car colours, and how far each is from
//   the nearest of them (redmean distance, the palette's own measure);
// - readability: the WCAG contrast of the figure's parts against every tone of each theme's open
//   ground; its best part (the outline, the cap or the vest) reaches MIN_CONTRAST on each.
//
// --alloc (Node): Renderer.frame() on a canvas that draws nothing, the camera at the line, six
// cars on the grid, a scripted race running through every phase again and again. V8's sampling
// heap profiler with the objects collected since counted; bytes a frame charged to functions of
// client/, the rest to "outside" (the probe's loop, Node). A control beside it (an object a
// frame that escapes) shows the profiler sees what there is.
//
// --shots (headless Chrome): the sheet's own page (marshal-sheet/: the game's Renderer on the
// game's canvas, laid out as the game lays it out, a scripted race held at a moment), built
// into a temp directory and served on 127.0.0.1 (--port). One browser session (msh-<pid>,
// muted, closed at the end). Every phase on two tracks (Rust Bowl in the scrapyard, Breaker's
// Mile in the desert through the same theme switch as the preview's), at 1280x720 and at
// 390x844@3. Then the pixel proof: every scene is drawn again with the marshals switched off
// (marshals.ts marshalSwitch), and every pixel that differs must lie inside a cell the
// marshals drew in that frame; the count per scene is printed, exit code 1 on a pixel outside.

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FONT_LETTERS, SMALL } from "../../client/gfx/font";
import { CAR_COLORS, P, PALETTE, rgbOf } from "../../client/gfx/palette";
import type { RaceView } from "../../client/render";
import { TEST_TRACKS, testTrack } from "../../shared/testtracks";
import { pointAt, queryTrack, type Track } from "../../shared/track";
import { trackById, trackList } from "../../shared/tracks";
import { carsAt, CAMERA, END, makeCars, raceAt, SHOTS } from "./marshal-sheet/scene";
import { blank, decodePng, paste, savePng, type Picture } from "./png";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Node has no canvas: one that draws nothing and allocates nothing when drawn on stands in (the
// sheets are worked out as indices). It counts the sprites taken from a cell of the marshals' size.
const marshalDraws = new Int32Array(1);
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const nothing = (): void => {};
  const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const attributes = { willReadFrequently: true };
  const size = { width: 30 };
  const ctx: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineJoin: "", lineCap: "", font: "", textAlign: "", textBaseline: "", imageSmoothingEnabled: false,
    createImageData: pixels,
    getImageData: (_x: number, _y: number, w: number, h: number) => pixels(w, h),
    measureText: () => size,
    getContextAttributes: () => attributes,
    drawImage: (_img: unknown, _sx: number, _sy: number, sw: number): void => {
      if (sw === 22) marshalDraws[0]++;
    },
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "putImageData", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const made = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = made;
  return made;
}
const g = globalThis as Record<string, unknown>;
g.document = { createElement: () => fakeCanvas() };
g.Path2D = class {
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
};

const M = await import("../../client/gfx/marshals");
const { MARSHAL_W, MARSHAL_H, FX_SHADOW, SHADOW_ALPHA } = await import("../../client/gfx/sprites");
const { bakeTileIndices, bakeTileKinds, KIND, TILE, ZOOM } = await import("../../client/gfx/world");
const { hasArt, sceneryFor, themedTrack, THEMES } = await import("../../client/gfx/theme");
type Theme = (typeof THEMES)[number];

const LANDED = THEMES.filter((t) => hasArt(t));
const allTracks = (): Track[] => [...trackList().map((e) => trackById(e.id)), ...TEST_TRACKS.map((d) => testTrack(d.id)!)];

// ---- pictures -----------------------------------------------------------------------------

function rect(p: Picture, x: number, y: number, w: number, h: number, hex: string): void {
  const [r, gg, b] = rgbOf(hex);
  for (let j = Math.max(0, y); j < Math.min(p.h, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(p.w, x + w); i++) {
      const o = (j * p.w + i) * 4;
      p.data[o] = r;
      p.data[o + 1] = gg;
      p.data[o + 2] = b;
      p.data[o + 3] = 255;
    }
  }
}

function text(p: Picture, s: string, x: number, y: number, hex: string, scale = 1): void {
  const { cw, ch, bits } = SMALL;
  const up = s.toUpperCase();
  for (let n = 0; n < up.length; n++) {
    const k = FONT_LETTERS.indexOf(up[n]);
    if (k < 0) continue;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (bits[(k * ch + j) * cw + i]) rect(p, x + (n * cw + i) * scale, y + j * scale, scale, scale, hex);
  }
}

// ---- the game's own ground and the game's own draw calls ----------------------------------

const tiles = new Map<Track, Map<string, { idx: Uint8Array; kinds: Uint8Array }>>();

function tileOf(track: Track, tx: number, ty: number): { idx: Uint8Array; kinds: Uint8Array } {
  let of = tiles.get(track);
  if (!of) tiles.set(track, (of = new Map()));
  let t = of.get(`${tx},${ty}`);
  if (!t) of.set(`${tx},${ty}`, (t = { idx: bakeTileIndices(track, tx, ty), kinds: bakeTileKinds(track, tx, ty) }));
  return t;
}

/** The baked world's pixel at (x, y) of the track's plane (view pixels): its palette index and its kind. */
function worldAt(track: Track, x: number, y: number): { index: number; kind: number } {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  const t = tileOf(track, tx, ty), o = (y - ty * TILE) * TILE + (x - tx * TILE);
  return { index: t.idx[o], kind: t.kinds[o] };
}

/** A piece of the baked world, w x h view pixels from (x0, y0). */
function ground(track: Track, x0: number, y0: number, w: number, h: number): Picture {
  const sc = sceneryFor(track), out = blank(w, h, 0, 0, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, gg, b] = rgbOf(sc.hex[worldAt(track, x0 + x, y0 + y).index]);
      out.data.set([r, gg, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}

/** What Marshals.draw() asked the canvas for in one frame: per sprite, its cell's corner on the sheet and where it goes (the track's plane). */
interface Drawn {
  sx: number;
  sy: number;
  x: number;
  y: number;
}

const calls: Drawn[] = [];
const canvas = {
  drawImage(_sheet: unknown, sx: number, sy: number, _w: number, _h: number, dx: number, dy: number): void {
    calls.push({ sx, sy, x: dx, y: dy });
  },
  putImageData(): void {},
  getContextAttributes: () => ({}),
} as unknown as CanvasRenderingContext2D;

/** Which cell of the sheet a sprite is. */
const cellNo = (d: Drawn): number => (d.sy / M.MCELL) * (MARSHAL_W / M.MCELL) + d.sx / M.MCELL;

/** One frame of a track's marshals: the sprites drawn, in the track's plane. */
function frameOf(m: InstanceType<typeof M.Marshals>, now: number, race: RaceView | undefined): Drawn[] {
  calls.length = 0;
  // The view far up-left of everything, wide enough: nothing is culled, and the plane's pixels come back by adding it again.
  const p = m.spots;
  const ox = p[0] - 320, oy = p[1] - 180;
  m.draw(ox, oy, now, race);
  return calls.map((c) => ({ ...c, x: c.x + ox, y: c.y + oy }));
}

/** Put sprites of a sheet (as indices) on a picture whose top-left is (x0, y0) of the track's plane. */
function put(to: Picture, sheet: Uint8Array, drawn: Drawn[], x0: number, y0: number): void {
  for (const d of drawn) {
    for (let j = 0; j < M.MCELL; j++) {
      for (let i = 0; i < M.MCELL; i++) {
        const v = sheet[(d.sy + j) * MARSHAL_W + d.sx + i];
        const x = d.x + i - x0, y = d.y + j - y0;
        if (!v || x < 0 || y < 0 || x >= to.w || y >= to.h) continue;
        const o = (y * to.w + x) * 4;
        if (v === FX_SHADOW) {
          const a = Math.round(SHADOW_ALPHA * 255) / 255;
          for (let c = 0; c < 3; c++) to.data[o + c] = Math.round(to.data[o + c] * (1 - a));
        } else {
          const [r, gg, b] = rgbOf(PALETTE[v - 1].hex);
          to.data.set([r, gg, b], o);
        }
      }
    }
  }
}

// ---- a scripted race ------------------------------------------------------------------------

// The race the sheet, the shots and the probes play is marshal-sheet/scene.ts.

/** A moment of the script: its name and how many ms in. */
interface Moment {
  name: string;
  t: number;
}

/** The script's moments worth a picture: each state, and of each wave its four pictures. Found by playing it. */
function moments(track: Track): Moment[] {
  const m = new M.Marshals(canvas, track);
  const race: RaceView = { phase: 0, lastLap: false, finished: 0 };
  const seen = new Set<string>(), out: Moment[] = [];
  for (let t = 0; t < END; t += 1000 / 60) {
    const r = raceAt(t, race);
    const drawn = frameOf(m, t, r);
    const flagCell = drawn.map(cellNo).find((c) => c < M.M_BODY) ?? -1;
    const state = !r ? "at ease" : r.phase === 1 ? "countdown" : r.phase === 3 ? "over" : r.finished ? "finish" : flagCell >= M.M_LAST && flagCell < M.M_CHEQ ? "last lap" : "go";
    const key = state === "over" ? state : `${state} ${flagCell}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nth = [...seen].filter((k) => k.startsWith(state)).length;
    out.push({ name: state === "at ease" || state === "countdown" || state === "over" ? state : `${state} ${nth}`, t });
  }
  return out;
}

/** A track's marshals as they are drawn at a moment of the script (played from its start, as the game would). */
function drawnAt(track: Track, t: number): Drawn[] {
  const m = new M.Marshals(canvas, track);
  const race: RaceView = { phase: 0, lastLap: false, finished: 0 };
  let drawn: Drawn[] = [];
  for (let u = 0; u <= t + 1e-6; u += 1000 / 60) drawn = frameOf(m, u, raceAt(u, race));
  return drawn;
}

// ---- the contact sheet (Node) ---------------------------------------------------------------

function themed(id: string, theme: Theme): Track {
  return themedTrack(testTrack(id) ?? trackById(id), theme);
}

function contact(): Picture {
  const W = 2000;
  const sheet = blank(W, 12000, ...rgbOf(P.soot1));
  let y = 16;
  text(sheet, "MARSHALS-1: THE FLAG MARSHALS AT THE START/FINISH LINE (client/gfx/marshals.ts)", 20, y, P.bone2, 3);
  y += 44;

  // The sprite sheet, as painted for two headings.
  const heads: [string, Track][] = [["CRUSHER RUN (THE LINE HEADS EAST)", trackById("crusher-run")], ["RUST BOWL (THE LINE HEADS NORTH, 8 DEGREES WEST)", trackById("rust-bowl")]];
  const S = 6;
  heads.forEach(([name, track], n) => {
    const x = 20 + n * (MARSHAL_W * S + 40);
    text(sheet, `THE SHEET, ${MARSHAL_W} X ${MARSHAL_H}, ${S}X: ${name}`, x, y, P.bone0, 2);
    const idx = M.marshalIndexSheet(pointAt(track, 0).h);
    for (let j = 0; j < MARSHAL_H; j++) {
      for (let i = 0; i < MARSHAL_W; i++) {
        const v = idx[j * MARSHAL_W + i];
        const cell = ((Math.floor(i / M.MCELL) + Math.floor(j / M.MCELL)) & 1) === 0;
        rect(sheet, x + i * S, y + 22 + j * S, S, S, v === 0 ? (cell ? P.dirt2 : P.dirt1) : v === FX_SHADOW ? P.dirt0 : PALETTE[v - 1].hex);
      }
    }
  });
  y += 22 + MARSHAL_H * S + 10;
  text(sheet, "ROW 1: THE PENNANT'S WAVE (4), THE LAST LAP'S FLAG (2 OF 4). ROW 2: ITS OTHER 2, THE CHEQUERED FLAG'S WAVE (4). ROW 3: HELD UP (2), FURLED (2), THE TWO FIGURES.", 20, y, P.bone0, 2);
  y += 34;

  // Every phase at the line of two tracks.
  const places: [string, Track][] = [["RUST BOWL, SCRAPYARD", themed("rust-bowl", "scrapyard")], ["BREAKER'S MILE, DESERT", themed("breakers-mile", "desert")], ["CRUSHER RUN, SCRAPYARD", themed("crusher-run", "scrapyard")]];
  for (const [name, track] of places) {
    const idx = M.marshalIndexSheet(pointAt(track, 0).h);
    const list = moments(track);
    text(sheet, `${name}: EVERY PHASE OF A SCRIPTED RACE. EACH MARSHAL 4X (LEFT OF THE ROAD ABOVE, RIGHT BELOW)`, 20, y, P.bone2, 2);
    y += 24;
    const B = 44, Z = 4, step = B * Z + 8;
    list.forEach((mo, n) => {
      const col = n % 11, row = Math.floor(n / 11);
      const x = 20 + col * step, top = y + row * (2 * step + 22);
      text(sheet, mo.name, x, top, P.bone0, 1);
      const drawn = drawnAt(track, mo.t);
      const m = new M.Marshals(canvas, track);
      for (let k = 0; k < m.count; k++) {
        const cx = m.spots[k * 5], cy = m.spots[k * 5 + 1];
        const piece = ground(track, cx - B / 2, cy - B / 2, B, B);
        put(piece, idx, drawn, cx - B / 2, cy - B / 2);
        paste(sheet, piece, x, top + 12 + k * step, 0, 0, B, B, Z);
      }
    });
    y += Math.ceil(list.length / 11) * (2 * step + 22) + 6;
    // The whole line at 2x, in four of the phases.
    const p = pointAt(track, 0);
    const cx = Math.round(p.x * ZOOM), cy = Math.round(p.y * ZOOM);
    const across = Math.abs(Math.sin(p.h)) > 0.7; // the road runs up the screen: the marshals stand left and right
    const w = across ? 300 : 230, h = across ? 130 : 290;
    let x = 20;
    for (const pick of ["at ease", "countdown", "go 2", "last lap 3", "finish 1"]) {
      const mo = list.find((e) => e.name === pick);
      if (!mo) continue;
      text(sheet, `${pick}, 2X`, x, y, P.bone0, 1);
      const piece = ground(track, cx - w / 2, cy - h / 2, w, h);
      put(piece, idx, drawnAt(track, mo.t), cx - w / 2, cy - h / 2);
      paste(sheet, piece, x, y + 12, 0, 0, w, h, 2);
      x += w * 2 + 10;
      if (x + w * 2 > W) break;
    }
    y += h * 2 + 30;
  }

  // The line of every track, in both landed themes, at ease.
  text(sheet, "THE LINE OF EVERY TRACK, IN EVERY LANDED THEME, AT EASE (1X; THE RACE GOES WHERE THE GRID'S BRACKETS POINT)", 20, y, P.bone2, 2);
  y += 24;
  let x = 20;
  const w = 300, h = 300;
  for (const base of allTracks()) {
    for (const theme of LANDED) {
      const track = themedTrack(base, theme);
      const p = pointAt(track, 0);
      const cx = Math.round(p.x * ZOOM), cy = Math.round(p.y * ZOOM);
      if (x + w > W) {
        x = 20;
        y += h + 22;
      }
      text(sheet, `${base.def.id} ${theme}`, x, y, P.bone0, 1);
      const piece = ground(track, cx - w / 2, cy - h / 2, w, h);
      put(piece, M.marshalIndexSheet(p.h), drawnAt(track, 0), cx - w / 2, cy - h / 2);
      paste(sheet, piece, x, y + 12);
      x += w + 10;
    }
  }
  y += h + 30;
  const out = blank(W, y, 0, 0, 0);
  paste(out, sheet, 0, 0, 0, 0, W, y);
  return out;
}

// ---- the checks (Node) ----------------------------------------------------------------------

const lum = (hex: string): number => {
  const [r, gg, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** The palette's own measure of how far two colours are apart (palette.ts nearest: "redmean"). */
const apart = (a: string, b: string): number => {
  const [r1, g1, b1] = rgbOf(a), [r2, g2, b2] = rgbOf(b);
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
};
/** A figure's best part must stand out from every tone of the open ground by this (WCAG; 3 is its measure for what is not text). */
const MIN_CONTRAST = 3;

function check(): boolean {
  let ok = true;
  const say = (good: boolean, what: string) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  };
  const cells = MARSHAL_W / M.MCELL;
  const cellOf = (idx: Uint8Array, k: number): Uint8Array => {
    const out = new Uint8Array(M.MCELL * M.MCELL);
    for (let j = 0; j < M.MCELL; j++) for (let i = 0; i < M.MCELL; i++) out[j * M.MCELL + i] = idx[(Math.floor(k / cells) * M.MCELL + j) * MARSHAL_W + (k % cells) * M.MCELL + i];
    return out;
  };

  // The sheet at every heading: every picture fits, every pixel is a palette colour or the shadow.
  let clipped = 0, widest = 0, off = 0;
  const used = new Set<number>();
  for (let deg = 0; deg < 360; deg++) {
    const idx = M.marshalIndexSheet((deg * Math.PI) / 180);
    clipped += M.marshalFit.clipped;
    widest = Math.max(widest, M.marshalFit.widest);
    for (const v of idx) {
      if (!v) continue;
      if (v === FX_SHADOW || (v >= 1 && v <= PALETTE.length)) used.add(v);
      else off++;
    }
  }
  say(clipped === 0, `at 360 headings a degree apart every picture fits its ${M.MCELL} x ${M.MCELL} cell: the widest is ${widest} pixels, ${clipped} do not fit`);
  const names = [...used].filter((v) => v !== FX_SHADOW).map((v) => PALETTE[v - 1].name);
  say(off === 0, `every pixel of the sheet is a palette colour or the cast shadow: ${names.length} of the 32 in use (${names.join(", ")}), ${off} others`);
  say(M.M_CELLS <= cells * (MARSHAL_H / M.MCELL), `the sheet has room for its ${M.M_CELLS} cells: ${cells} x ${MARSHAL_H / M.MCELL} of ${M.MCELL} x ${M.MCELL} = ${MARSHAL_W} x ${MARSHAL_H} = ${MARSHAL_W * MARSHAL_H * 4} bytes of canvas`);

  // The uniform and the flags against the six car colours.
  let nearest = Infinity, nearestWhat = "";
  for (const v of used) {
    if (v === FX_SHADOW) continue;
    const e = PALETTE[v - 1];
    for (const car of CAR_COLORS) {
      const d = apart(e.hex, car);
      if (d < nearest) {
        nearest = d;
        nearestWhat = `${e.name} ${e.hex} from the car colour ${car}`;
      }
    }
  }
  const same = names.filter((n) => (CAR_COLORS as readonly string[]).includes(P[n]));
  say(same.length === 0, `no tone of the sheet is one of the six car colours (${same.length} are); the nearest is ${nearestWhat}: ${nearest.toFixed(0)} apart (two car colours are at least ${Math.min(...CAR_COLORS.flatMap((a, i) => CAR_COLORS.slice(i + 1).map((b) => apart(a, b)))).toFixed(0)} apart)`);
  // The vest, the figure's largest part, against each car colour.
  const vest = P.blast;
  say(Math.min(...CAR_COLORS.map((c) => apart(vest, c))) >= 60, `the vest (${vest}) against the six car colours: ${CAR_COLORS.map((c) => `${c} ${apart(vest, c).toFixed(0)}`).join(", ")}`);

  // The wave: four pictures a flag, the flags unlike each other.
  for (const track of [trackById("crusher-run"), trackById("rust-bowl")]) {
    const idx = M.marshalIndexSheet(pointAt(track, 0).h);
    const key = (k: number) => Buffer.from(cellOf(idx, k)).toString("latin1");
    for (const [name, first] of [["pennant", M.M_GO], ["last lap's flag", M.M_LAST], ["chequered flag", M.M_CHEQ]] as const) {
      const pics = new Set(Array.from({ length: M.WAVE }, (_, i) => key(first + i)));
      say(pics.size === M.WAVE, `${track.def.name}: the ${name}'s wave is ${pics.size} different pictures of ${M.WAVE}`);
    }
    let alike = 0;
    for (let i = 0; i < M.WAVE; i++) if (new Set([key(M.M_GO + i), key(M.M_LAST + i), key(M.M_CHEQ + i)]).size < 3) alike++;
    say(alike === 0, `${track.def.name}: the three flags differ in every picture of the wave (${alike} alike)`);
  }

  // Culling: the view goes past the marshals in every direction, a pixel at a time. Whenever a
  // cell of a marshal's two sprites has a pixel in the view, both are drawn; far off, none is.
  for (const track of [trackById("crusher-run"), trackById("rust-bowl")]) {
    const m = new M.Marshals(canvas, track);
    const race: RaceView = { phase: 2, lastLap: false, finished: 0 };
    let missed = 0, frames = 0, culled = 0, far = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      for (let k = -900; k <= 900; k++) {
        const ox = m.spots[0] - 320 + dx * k, oy = m.spots[1] - 180 + dy * k;
        calls.length = 0;
        m.draw(ox, oy, 1000 + k * 37, race);
        frames++;
        const got = calls.map((c) => `${c.x},${c.y}`);
        if (!got.length) culled++;
        if (Math.abs(k) > 800 && got.length) far++;
        // What it would draw with nothing culled: the same frame from a view right on the marshals.
        calls.length = 0;
        m.draw(m.spots[0] - 320, m.spots[1] - 180, 1000 + k * 37, race);
        for (const c of calls) {
          const x = c.x + m.spots[0] - 320 - ox, y = c.y + m.spots[1] - 180 - oy;
          const inView = x + M.MCELL > 0 && y + M.MCELL > 0 && x < 640 && y < 360;
          if (inView && !got.includes(`${x},${y}`)) missed++;
        }
      }
    }
    say(missed === 0 && far === 0 && culled > 0, `${track.def.name}: culling, the view moved past the marshals a pixel at a time in four directions (${frames} frames): ${missed} sprites with a cell in the view were not drawn, ${culled} frames drew nothing, ${far} frames far off drew something`);
  }

  // Every track, every landed theme: where the figures stand.
  const open = new Map<Theme, Set<string>>(); // the tones of each theme's open ground under the figures
  for (const base of allTracks()) {
    for (const theme of LANDED) {
      const track = themedTrack(base, theme), sc = sceneryFor(track);
      const m = new M.Marshals(canvas, track);
      const idx = M.marshalIndexSheet(pointAt(track, 0).h);
      const what = `${base.def.id} (${theme})`;
      if (m.count !== 2) {
        say(false, `${what}: ${m.count} of 2 marshals stand (a spot is not clear of every road)`);
        continue;
      }
      // The figure's own pixels: the body's cell, less its shadow.
      const drawn = drawnAt(track, 0);
      const kinds = new Map<string, number>(), tones = new Map<string, number>();
      let pixels = 0;
      for (const d of drawn.filter((e) => cellNo(e) >= M.M_BODY)) {
        for (let j = 0; j < M.MCELL; j++) {
          for (let i = 0; i < M.MCELL; i++) {
            const v = idx[(d.sy + j) * MARSHAL_W + d.sx + i];
            if (!v || v === FX_SHADOW) continue;
            pixels++;
            const at = worldAt(track, d.x + i, d.y + j);
            const kind = Object.entries(KIND).find(([, n]) => n === at.kind)?.[0] ?? "open ground";
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
            tones.set(sc.names[at.index], (tones.get(sc.names[at.index]) ?? 0) + 1);
          }
        }
      }
      const onTrack = [...kinds].filter(([k]) => k !== "open ground");
      // Open ground's own tones: the theme's earth and its grit (thrown over the wall), and what a cast shadow makes of them.
      const earth = new Set<string>(["dirt0", "dirt1", "dirt2", "dirt3", "gravel0", "gravel1", "gravel2", "bone0"]);
      for (const n of [...earth]) earth.add(sc.palette.shade[n as keyof typeof sc.palette.shade]);
      const strange = [...tones].filter(([n]) => !earth.has(n));
      say(onTrack.length === 0 && strange.length === 0, `${what}: the two figures' ${pixels} pixels lie on open ground only${onTrack.length ? `; on ${onTrack.map(([k, n]) => `${k}: ${n}`).join(", ")}` : ""}${strange.length ? `; on tones the open ground does not have: ${strange.map(([k, n]) => `${k}: ${n}`).join(", ")}` : ""} (ground tones: ${[...tones].map(([k, n]) => `${k} ${n}`).join(", ")})`);
      const set = open.get(theme) ?? new Set<string>();
      for (const [n] of tones) set.add(sc.palette.colours[n as keyof typeof P] ?? sc.hex[sc.index[n]]);
      open.set(theme, set);

      // A waved flag stays off the road: every pixel of every picture of every wave, on both sides.
      let over = 0, worst = 0;
      const p = pointAt(track, 0);
      for (let k = 0; k < 2; k++) {
        const ax = m.spots[k * 5] + m.spots[k * 5 + 2], ay = m.spots[k * 5 + 1] + m.spots[k * 5 + 3];
        for (let f = 0; f < M.M_EASE + 2; f++) {
          for (let j = 0; j < M.MCELL; j++) {
            for (let i = 0; i < M.MCELL; i++) {
              const v = idx[(Math.floor(f / cells) * M.MCELL + j) * MARSHAL_W + (f % cells) * M.MCELL + i];
              if (!v || v === FX_SHADOW) continue;
              const q = queryTrack(track, (ax + M.MARSHAL_AT[f * 2] + i + 0.5) / ZOOM, (ay + M.MARSHAL_AT[f * 2 + 1] + j + 0.5) / ZOOM);
              const inside = track.wall - q.dist;
              if (inside > 0) {
                over++;
                worst = Math.max(worst, inside);
              }
            }
          }
        }
      }
      void p;
      say(over === 0, `${what}: no pixel of a flag, in any of its ${M.M_EASE + 2} pictures on either side, lies inside the wall line (${over} do${over ? `, up to ${worst.toFixed(1)} units in` : ""})`);
    }
  }

  // Readability on each theme's open ground.
  const parts: [string, string][] = [["outline", P.soot1], ["cap", P.bone2], ["vest", P.blast], ["pennant", P.bone2], ["last lap's flag", P.haz1], ["chequers", P.soot2]];
  for (const [theme, set] of open) {
    const rows: string[] = [];
    let worst = Infinity;
    for (const hex of set) {
      const each = parts.map(([, c]) => contrast(c, hex));
      const best = Math.max(each[0], each[1], each[2]);
      worst = Math.min(worst, best);
      rows.push(`${hex}: ${parts.map(([n], i) => `${n} ${each[i].toFixed(1)}`).join(", ")}`);
    }
    say(worst >= MIN_CONTRAST, `${theme}: on every tone of the open ground under the figures their best part (outline, cap or vest) reaches ${worst.toFixed(1)}:1 (at least ${MIN_CONTRAST}:1)\n      ${rows.join("\n      ")}`);
  }
  return ok;
}

// ---- rule 1: what a frame allocates (Node) --------------------------------------------------

interface ProfileNode {
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children?: ProfileNode[];
}

async function alloc(): Promise<boolean> {
  const WARM = Number(arg("--warm") ?? 30000), FRAMES = Number(arg("--frames") ?? 6000), INTERVAL = Number(arg("--interval") ?? 128);
  const { Renderer } = await import("../../client/render");
  const DT = 1000 / 60;
  console.log(`Bytes a frame allocates, Renderer.frame() with the marshals in view through every phase of the script (${WARM} warm frames, then ${FRAMES} measured; sampling interval ${INTERVAL} B).\n`);
  console.log("| track | marshal sprites a frame | client/ B a frame | of which gfx/marshals.ts | outside B a frame | top of client/ |");
  console.log("|---|---:|---:|---:|---:|---|");
  let ok = true;
  for (const [id, control] of [["rust-bowl", false], ["breakers-mile", false], ["rust-bowl", true]] as const) {
    const track = trackById(id);
    const r = new Renderer(document.createElement("canvas"), track);
    const cars = makeCars();
    const race: RaceView = { phase: 0, lastLap: false, finished: 0 };
    const fx: { shots: never[]; mines: never[]; sparks: never[]; race?: RaceView } = { shots: [], mines: [], sparks: [] };
    const none: typeof cars = [];
    const kept: object[] = [];
    // The script, worked out beforehand a frame at a time: the measured loop itself allocates nothing.
    const N = Math.round(END / DT);
    const pos = new Float64Array(N * cars.length * 3), cam = new Float64Array(N * 2), state = new Uint8Array(N * 4);
    for (let k = 0; k < N; k++) {
      const t = k * DT;
      state[k * 4] = carsAt(track, t, cars) ? 1 : 0;
      cars.forEach((c, i) => pos.set([c.x, c.y, c.h], (k * cars.length + i) * 3));
      const p = pointAt(track, CAMERA[0]);
      cam.set([p.x, p.y], k * 2);
      const at = raceAt(t, race);
      state.set([at ? at.phase : 255, at?.lastLap ? 1 : 0, at ? at.finished : 0], k * 4 + 1);
    }
    const times = new Float64Array(1);
    let frameNo = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++, frameNo++) {
        const k = frameNo % N;
        for (let c = 0; c < cars.length; c++) {
          const o = (k * cars.length + c) * 3, car = cars[c];
          car.x = pos[o];
          car.y = pos[o + 1];
          car.h = pos[o + 2];
        }
        if (state[k * 4 + 1] === 255) fx.race = undefined;
        else {
          race.phase = state[k * 4 + 1];
          race.lastLap = state[k * 4 + 2] === 1;
          race.finished = state[k * 4 + 3];
          fx.race = race;
        }
        times[0] = 10000 + frameNo * DT;
        r.follow(cam[k * 2], cam[k * 2 + 1], DT, frameNo === 0);
        r.frame(state[k * 4] ? cars : none, fx, null, times[0]);
        if (control) kept.push({ frame: frameNo }); // the control: an object a frame that escapes
      }
    };
    run(WARM);
    kept.length = 0;
    const session = new Session();
    session.connect();
    await session.post("HeapProfiler.enable");
    await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    marshalDraws[0] = 0;
    run(FRAMES);
    const sprites = marshalDraws[0] / FRAMES;
    const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };
    session.disconnect();
    // Every sampled allocation is charged to the innermost function of client/ on its stack.
    const charged = new Map<string, number>();
    let inside = 0, outside = 0, own = 0;
    const walk = (node: ProfileNode, owner: string): void => {
      const f = node.callFrame;
      const at = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
      const here = at < 0 ? owner : `${f.url.slice(at + 8)} ${f.functionName || "(anonymous)"}`;
      if (node.selfSize > 0) {
        if (here) {
          charged.set(here, (charged.get(here) ?? 0) + node.selfSize);
          inside += node.selfSize;
          if (here.startsWith("gfx/marshals.ts")) own += node.selfSize;
        } else outside += node.selfSize;
      }
      for (const c of node.children ?? []) walk(c, here);
    };
    walk(profile.head, "");
    const top = [...charged].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, b]) => `${k}: ${(b / FRAMES).toFixed(2)}`).join("; ") || "-";
    console.log(`| ${track.def.name}${control ? " + the control (an object a frame)" : ""} | ${sprites.toFixed(2)} | **${(inside / FRAMES).toFixed(2)}** | **${(own / FRAMES).toFixed(2)}** | ${(outside / FRAMES).toFixed(1)} | ${top} |`);
    // The script has no race for its first 2 of 30 s and the cars are away for parts of it, but the line is always in view: four sprites a frame.
    if (own / FRAMES >= 1 || sprites < 3.99) ok = false;
  }
  console.log("\nNumbers under about 1 byte a frame are the sampling's noise. \"outside\" is the probe's own loop and Node: the control's row shows the profiler sees one escaping object a frame there.");
  return ok;
}

// ---- the shots and the pixel proof (headless Chrome) ----------------------------------------

const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];
/** The two tracks the shots are taken on: each in its own theme (Rust Bowl: the scrapyard; Breaker's Mile: the desert). */
const SHOT_TRACKS = ["rust-bowl", "breakers-mile"];

async function shots(out: string, port: number): Promise<boolean> {
  const run = promisify(execFile);
  const cleanups: (() => unknown)[] = [];
  const cleanup = async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  let ok = true;
  try {
    mkdirSync(out, { recursive: true });
    const dist = mkdtempSync(path.join(tmpdir(), "marshal-sheet-dist-"));
    cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
    console.error("building the sheet's page ...");
    await run(path.join(ROOT, "node_modules", ".bin", "vite"), ["build", path.join(ROOT, "tools", "debug", "marshal-sheet"), "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
    const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let file = path.join(dist, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dist, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
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
    const session = `msh-${process.pid}`;
    const ab = async (more: string[]): Promise<string> => (await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 })).stdout.trim();
    cleanups.push(() => ab(["close"]));
    await ab(["--args", "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding", "open", "about:blank"]);
    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const files: string[] = [];
    const rows: string[] = [];
    for (const size of SIZES) {
      await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
      for (const id of SHOT_TRACKS) {
        for (const shot of SHOTS) {
          await ab(["open", `${url}/?${new URLSearchParams({ track: id, t: String(shot.t) })}`]);
          const deadline = Date.now() + 60_000;
          while ((await ab(["eval", "window.marshalShot && window.marshalShot.done ? 1 : 0"])) !== "1") {
            if (Date.now() > deadline) throw new Error(`the page did not finish: ${id} ${shot.name}`);
            await sleep(100);
          }
          const file = path.join(out, `${id}-${shot.name}-${size.name}.png`);
          await ab(["screenshot", file]);
          files.push(file);
          console.error(file);
          if (size !== SIZES[0]) continue;
          // Once a scene: the proof's numbers, and a close look at the line with both marshals (2x of the 1280x720 shot's own pixels).
          const res = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.marshalShot)"])) as string) as { sprites: number; covered: number; differ: number; outside: number; control: number; line: [number, number] };
          const good = res.outside === 0 && res.control === 0 && res.sprites === 4 && res.differ > 0 && res.differ <= res.covered;
          if (!good) ok = false;
          rows.push(`| ${id} | ${shot.name} | ${res.sprites} | ${res.covered} | ${res.differ} | ${res.outside} | ${res.control} | ${good ? "ok" : "FAIL"} |`);
          const whole = decodePng(file);
          const k = whole.w / 640; // screen pixels a view pixel
          const cw = 270, ch = 270;
          const x0 = Math.max(0, Math.min(640 - cw, res.line[0] - cw / 2)), y0 = Math.max(0, Math.min(360 - ch, res.line[1] - ch / 2));
          const close = blank(cw * k * 2, ch * k * 2, 0, 0, 0);
          paste(close, whole, 0, 0, Math.round(x0 * k), Math.round(y0 * k), cw * k, ch * k, 2);
          const closeFile = path.join(out, `${id}-${shot.name}-close.png`);
          savePng(closeFile, close);
          files.push(closeFile);
        }
      }
    }
    console.log(files.join("\n"));
    console.log("\nThe pixel proof (640 x 360 canvas, each scene drawn with the marshals off, off again and on):\n");
    console.log("| track | scene | marshal sprites drawn | pixels they cover | pixels that differ off/on | of those outside the sprites | control: off against off | |");
    console.log("|---|---|---:|---:|---:|---:|---:|---|");
    console.log(rows.join("\n"));
    console.log(`\n${ok ? "ok  " : "FAIL"}  in every scene the frame with the marshals differs from the frame without them only in pixels their own sprites cover`);
  } finally {
    await cleanup();
  }
  return ok;
}

// ---- main ----------------------------------------------------------------------------------------

if (args.includes("--check")) {
  if (!check()) process.exit(1);
} else if (args.includes("--alloc")) {
  if (!(await alloc())) process.exit(1);
} else if (args.includes("--shots")) {
  if (!(await shots(path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "marshals", "shots")), Number(arg("--port") ?? 3016)))) process.exit(1);
} else {
  const out = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "marshals", "contact-sheet.png"));
  mkdirSync(path.dirname(out), { recursive: true });
  savePng(out, contact());
  console.log(out);
}
