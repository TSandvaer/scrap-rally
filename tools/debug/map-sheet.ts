// The minimap on paper (M4-MAP: a split's two lanes and its island on the per-track minimap).
//
//   npx tsx tools/debug/map-sheet.ts                 every track's baked minimap: its colours, what a split shows
//   npx tsx tools/debug/map-sheet.ts --ref main      ... and the shipped tracks' against that ref's, bit for bit
//   npx tsx tools/debug/map-sheet.ts --ref main --scenes   ... and the preview scenes from before, in headless Chrome
//   npx tsx tools/debug/map-sheet.ts --ref main --sheet    ... and the contact sheet (headless Chrome)
//   --out <dir>            where the pictures go (default tmp/m4-map)
//   --also <label>=<dir>   on the sheet, another tree's minimap of the test track (a folder with client/ and shared/)
//   --label <label>        on the sheet, what the working tree's look is called beside those
// Exit code 1 if a check fails.
//
// No browser, by default. The game's own HUD (client/gfx/hud.ts) is run in Node on a stand-in
// canvas that keeps its pixels (putImageData, drawImage of whole pixels, fillRect: all the minimap
// asks of one), a Hud a track; what `Hud.minimap` draws into the view is cut out, the box of 108 x
// 108 at (VIEW_W - 112, 4). So the pixels here are the pixels a frame blits, of every track there
// is: the shipped ones (shared/tracks.ts) and the preview test tracks (shared/testtracks.ts).
// A ref is unpacked into a temp folder and its client/ and shared/ run the same way, in a
// process of its own.
// - `mini-<track>.png`: the baked minimap, the game's pixels six times enlarged; `bakes.png`:
//   all of them, the ref's beside the working tree's and the pixels that differ in red.
// - Checks: every pixel of a minimap one of the palette's colours; a shipped track's the ref's,
//   bit for bit, bare and with six cars' dots on it; across a plain stretch of every track the
//   map shows one line; on a track with a split, across every island's middle, a lane, the
//   island and a lane (two runs of the road's tone with another tone between them, at least 2 px
//   of it).
// - `--scenes`: both trees built and served, a browser each; every preview scene from before
//   M4-MAP held at its key moment in both, the game canvas's own pixels compared: how many differ
//   inside the minimap's box and outside it. A scene on a track without an island is to be the
//   same picture; one on the Preview Yard is to differ in the box alone (`pair-<scene>.png`:
//   before | after of that corner). With a control: the method sees a change of 20 ms.
// - `--sheet`: the working tree built and served, the preview scene `yard-map`
//   (?debug=1&preview=1&scene=yard-map&freeze=1) shot at 1280x720 and at 390x844@3. Is the
//   minimap in Chrome's canvas the one made here in Node, pixel for pixel? The sheet (`sheet.png`,
//   written with the game's own font) holds the minimap as those two windows show it (the
//   window's own pixels, and three times enlarged), the bake six times enlarged without and with
//   the cars' dots, the ref's bake beside it, each `--also` tree's the same way (its two window
//   sizes worked out here: a pixel of the window takes the game pixel its middle falls on), and
//   both windows. The browser sessions are map-<pid>-*, closed at the end.
//
// BR-MAP: shortcut roads (shared/track.ts PlacedBranch) on the minimap. Every run also bakes
// four shapes of its own beside the test tracks (Branch Yard turned 30 degrees: mouths on a
// slant; Branch Yard with a split on its first shortcut; Branch Yard with an island at the far
// end of a shortcut: an open road does not wrap; Branch Yard with a shortcut that leaves the
// loop: the fit), and checks every track that has a shortcut:
// - the fit: all its roads' points fill the 96 px square, centred;
// - each shortcut drawn: every sample of its centreline (outside its gaps and splits) on the
//   road's tone, the line broken over each of its gaps, one line across a plain stretch, a lane,
//   the island and a lane across each of its islands;
// - each shortcut joined at its fork and at its merge: inside the mouth's own box (from before
//   the mouth to where the shortcut is 5 px from the main road) the road's tone is one 4-connected
//   piece from the shortcut to the main road before the mouth and past it, and shuts in no pixel
//   of another tone (the two lines part once);
// - a car's dot on a shortcut lands on its line (dots a pixel apart all along it; the main road's
//   count beside it);
// - the shortcuts only add: against the same track baked without them, no pixel of the main line
//   or its start tick is lost, and no pixel differs further from a shortcut's centreline than a
//   stamp reaches (no blob).
//   `mini-<track>-cars.png`: cars on the shortcuts; `mouth-<track>-<n>-<fork|merge>.png`: a mouth,
//   16 times enlarged.
//   --branches             ... and the shortcuts' contact sheet (`branch-sheet.png`, headless Chrome):
//                          the preview's tour of Branch Yard shot at 1280x720 and at 390x844@3, the
//                          minimap in Chrome's canvas against the one made here, the bakes and mouths
//   --port <n>             the port the working tree's build is served on (default: any free one)
//   --session <name>       what the browser sessions are called: <name>-<pid>-* (default map)

import { execFile, execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { blank, decodePng, differing, paste, savePng, type Picture } from "./png";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const HERE = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAP = 108; // the minimap's box (client/gfx/hud.ts)

/** A track's minimap out of a tree: the bake as a frame blits it, and the same with cars on it. */
interface Baked {
  id: string;
  name: string;
  shipped: boolean;
  bare: string; // 108 x 108 RGBA, base64
  dots: string; // ... with the cars' dots
  notPalette: number; // pixels of the bake that are no palette colour
  /** Per island: the tones met on a line across the road through its middle, as runs ("road" / "other"), and how long each is (px). */
  islands: { s: number; runs: string }[];
  /** The same across a plain stretch of the track (no widen): one run of the road's tone. */
  plain: string;
  road: string; // the road's tone on the map, #rrggbb
  /** A shape of this tool's own (BR-MAP), not a track of the game. */
  tool?: string;
  /** BR-MAP: what the map makes of the track's shortcuts (a track that has some, a tree whose HUD keeps its map's scale). */
  br?: BranchReport;
}

/** A mouth of a shortcut on the map: is its line one piece with the main road's there? box: the mouth on the map (x, y, w, h). pockets: pixels of another tone the line shuts in there (not joined through a side to the box's edge). */
interface MouthCheck { end: "fork" | "merge"; joined: boolean; note: string; box: [number, number, number, number]; pockets: number }

interface BranchCheck {
  no: number;
  long: number; // its length on the map, px
  samples: number; // samples of its centreline, outside its gaps and splits ...
  off: number; // ... and those not on the road's tone
  gaps: { u0: number; u1: number; px: number; samples: number; on: number }[];
  mouths: MouthCheck[];
  probes: number; // cars' dots along it ...
  onLine: number; // ... whose middle pixel is the line's
  touching: number; // ... whose 3 x 3 covers a pixel of the line
  plain: string; // the tones across a plain stretch of it, at u = plainU ("" = it has none)
  plainU: number;
  islands: { s: number; runs: string }[];
}

interface BranchReport {
  /** The fit: all roads' points on the map (px: w x h, and where the box of them starts), and how far the shortcuts reach outside the main road's own box (px). */
  fit: { w: number; h: number; left: number; top: number; beyond: number };
  branches: BranchCheck[];
  /** The main road's dots, the same way: probes, and those whose middle pixel is the line's. */
  mainProbes: number;
  mainOn: number;
  /** Against the same track without its shortcuts, when both are fitted alike: pixels that differ; the main line's (or tick's) lost; road-tone pixels further than a line's stamp from a shortcut; any further than a casing's. */
  twin: { changed: number; lost: number; strayLine: number; stray: number; line: number; casing: number } | null;
  /** The shape WRAP_SHAPE only: in the box of the first shortcut's fork on Branch Yard's own map, the pixels that differ from Branch Yard's (null: the two are not fitted alike). */
  wrap?: number | null;
  cars: string; // 108 x 108 RGBA, base64: the bake with cars on the shortcuts
  tour: string; // ... and with the pack of the preview's tour at TOUR_S (--branches: what Chrome is to show)
  errors: number; // validateTrack's
}

// ---- the child: a tree's minimaps -----------------------------------------------------------

interface Soft {
  width: number;
  height: number;
  px: Uint8ClampedArray | null;
  getContext: () => unknown;
}

/** A canvas that keeps its pixels: what the HUD's bakes and the minimap ask of one, and no more. */
function softCanvas(): Soft {
  const c: Soft = { width: 0, height: 0, px: null, getContext: () => ctx };
  const px = (): Uint8ClampedArray => (c.px && c.px.length === c.width * c.height * 4 ? c.px : (c.px = new Uint8ClampedArray(c.width * c.height * 4)));
  const nothing = (): void => {};
  const ctx: Record<string, unknown> = {
    canvas: c,
    fillStyle: "#000000",
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getContextAttributes: () => ({ willReadFrequently: true }),
    measureText: () => ({ width: 30 }),
    putImageData(img: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): void {
      const to = px();
      for (let j = 0; j < img.height; j++) {
        for (let i = 0; i < img.width; i++) {
          const X = x + i, Y = y + j;
          if (X < 0 || Y < 0 || X >= c.width || Y >= c.height) continue;
          to.set(img.data.subarray((j * img.width + i) * 4, (j * img.width + i) * 4 + 4), (Y * c.width + X) * 4);
        }
      }
    },
    drawImage(from: Soft, ...a: number[]): void {
      // (from, dx, dy) or (from, sx, sy, sw, sh, dx, dy, dw, dh); enlarged by whole pixels (the font's print).
      const [sx, sy, sw, sh, dx, dy, dw, dh] = a.length === 2 ? [0, 0, from.width, from.height, a[0], a[1], from.width, from.height] : a;
      const src = from.px, to = px();
      if (!src) return;
      for (let j = 0; j < dh; j++) {
        for (let i = 0; i < dw; i++) {
          const X = dx + i, Y = dy + j, u = sx + Math.floor((i * sw) / dw), v = sy + Math.floor((j * sh) / dh), o = (v * from.width + u) * 4;
          if (X < 0 || Y < 0 || X >= c.width || Y >= c.height || u >= from.width || v >= from.height || !src[o + 3]) continue;
          to.set(src.subarray(o, o + 4), (Y * c.width + X) * 4);
        }
      }
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      const s = String(ctx.fillStyle), to = px();
      if (!/^#[0-9a-f]{6}$/i.test(s)) throw new Error(`map-sheet: a fill in ${s}`);
      const r = parseInt(s.slice(1, 3), 16), g = parseInt(s.slice(3, 5), 16), b = parseInt(s.slice(5, 7), 16);
      for (let Y = Math.max(0, y); Y < Math.min(c.height, y + h); Y++) for (let X = Math.max(0, x); X < Math.min(c.width, x + w); X++) to.set([r, g, b, 255], (Y * c.width + X) * 4);
    },
    clearRect(x: number, y: number, w: number, h: number): void {
      const to = px();
      for (let Y = Math.max(0, y); Y < Math.min(c.height, y + h); Y++) to.fill(0, (Y * c.width + Math.max(0, x)) * 4, (Y * c.width + Math.min(c.width, x + w)) * 4);
    },
  };
  for (const m of ["fillText", "strokeText", "setTransform", "save", "restore", "beginPath", "closePath", "moveTo", "lineTo", "fill", "stroke"]) ctx[m] = nothing;
  return c;
}

const hex = (d: Uint8Array | Uint8ClampedArray, o: number) => "#" + [d[o], d[o + 1], d[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");

/** The cars of the dots, as (s, lat) on the Preview Yard: where the preview scene yard-map has them at its key moment (a car in each lane of both splits, two on plain road). The first is the own car. */
const DOTS: [number, number][] = [[6350, 76], [6500, -76], [8050, 64], [8150, -64], [2000, 20], [4700, -30]];
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
// BR-MAP: the preview's tour (client/preview.ts tour(): a pack of six, each so far along from &s and so far across), and where --branches holds it on Branch Yard: the top straight, clear of every mouth.
const TOUR_PACK = [0, 46, -52, 104, -110, 170], TOUR_LANES = [0, -30, 28, 12, -14, 34], TOUR_S = 1500;
const WRAP_SHAPE = "map-branch-wrap"; // the shape with an island at the far end of a shortcut (branchShapes)

async function child(root: string, out: string): Promise<void> {
  (globalThis as Record<string, unknown>).document = { createElement: softCanvas };
  const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
  const { trackList, trackById } = await load("shared/tracks.ts");
  const T = await load("shared/track.ts");
  const { pointAt } = T;
  const { Hud } = await load("client/gfx/hud.ts");
  const { P } = await load("client/gfx/palette.ts");
  const { VIEW_W, VIEW_H } = await load("client/gfx/world.ts");
  const tests = existsSync(path.join(root, "shared/testtracks.ts")) ? await load("shared/testtracks.ts") : null;
  const palette = new Set<string>(Object.values(P as Record<string, string>).map((h) => h.toLowerCase()));
  const tracks: { track: any; shipped: boolean; tool?: string }[] = (trackList() as { id: string }[]).map((e) => ({ track: trackById(e.id), shipped: true }));
  if (tests) for (const d of tests.TEST_TRACKS as { id: string }[]) tracks.push({ track: tests.testTrack(d.id), shipped: false });
  if (tests?.BRANCH_YARD && tests.testTrack("branch-yard")?.branches?.length) for (const s of branchShapes(tests.BRANCH_YARD, tests.testTrack("branch-yard"))) tracks.push({ track: T.buildTrack(s.def), shipped: false, tool: s.what });
  const X0 = VIEW_W - 112, Y0 = 4;
  const result: Baked[] = [];
  let yardMap: { bare: Uint8Array; scale: number; ox: number; oy: number; fork: [number, number, number, number] } | null = null; // Branch Yard's, for WRAP_SHAPE
  for (const { track, shipped, tool } of tracks) {
    const view = softCanvas();
    view.width = VIEW_W;
    view.height = VIEW_H;
    const hud = new Hud(view.getContext(), track);
    const cut = (from: Soft = view): Uint8Array => {
      const o = new Uint8Array(MAP * MAP * 4);
      for (let y = 0; y < MAP; y++) o.set(from.px!.subarray(((Y0 + y) * VIEW_W + X0) * 4, ((Y0 + y) * VIEW_W + X0 + MAP) * 4), y * MAP * 4);
      return o;
    };
    hud.minimap([]);
    const bare = cut();
    const cars = DOTS.map(([s, lat], i) => {
      const p = pointAt(track, s % track.length);
      return { id: `c${i}`, x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h, color: COLORS[i], name: "", me: i === 0, wreck: false, ghost: false };
    });
    hud.minimap(cars);
    const dots = cut();
    let notPalette = 0;
    for (let o = 0; o < bare.length; o += 4) if (bare[o + 3] !== 255 || !palette.has(hex(bare, o))) notPalette++;

    // Where the map puts a point of the world: the own car's dot is drawn at it. Found from two dots.
    const where = (x: number, y: number): [number, number] => {
      view.px!.fill(0);
      hud.minimap([{ id: "p", x, y, h: 0, color: "#ff00ff", name: "", me: false, wreck: false, ghost: false }]);
      const d = cut();
      let sx = 0, sy = 0, n = 0;
      for (let o = 0; o < d.length; o += 4) {
        if (d[o] === 255 && d[o + 1] === 0 && d[o + 2] === 255) {
          sx += (o / 4) % MAP;
          sy += Math.floor(o / 4 / MAP);
          n++;
        }
      }
      return n ? [sx / n, sy / n] : [NaN, NaN];
    };
    const start = pointAt(track, 0), far = pointAt(track, track.length / 2);
    const [ax, ay] = where(start.x, start.y), [bx, by] = where(far.x, far.y);
    const k = Math.hypot(bx - ax, by - ay) / Math.hypot(far.x - start.x, far.y - start.y); // map pixels a world unit
    const mapAt = (x: number, y: number): [number, number] => [ax + (x - start.x) * k, ay + (y - start.y) * k];
    /** The tones on the line across a road (the main road, or a shortcut's) at s, from 8 px left of the centreline to 8 px right, a sample every quarter pixel. */
    const across = (s: number, on = track, to = mapAt): string[] => {
      const p = pointAt(on, s);
      const [cx, cy] = to(p.x, p.y);
      const tones: string[] = [];
      for (let t = -8; t <= 8; t += 0.25) {
        const u = Math.round(cx - Math.sin(p.h) * t), v = Math.round(cy + Math.cos(p.h) * t);
        tones.push(u < 0 || v < 0 || u >= MAP || v >= MAP ? "" : hex(bare, (v * MAP + u) * 4));
      }
      return tones;
    };
    const plainS = (() => {
      for (let s = 100; s < track.length; s += 50) {
        const clear = (track.widens ?? []).every((w: { s0: number; s1: number }) => s < w.s0 - 200 || s > w.s1 + 200) && (track.gaps ?? []).every((g: { s0: number; s1: number }) => s < g.s0 - 200 || s > g.s1 + 200) && s > 300;
        if (clear) return s;
      }
      return track.length / 2;
    })();
    // The road's tone on the map: what lies in the middle of the line across a plain stretch (the run of
    // non-panel tones round the centreline, its middle sample). THEME-SCHEMA: not the centreline's own
    // pixel, which at a smaller map scale (the theme yards' wider loop) can be the line's 1-px edge step.
    // The panel's: a pixel inside the frame's corner.
    const plain = across(plainS);
    const face = hex(bare, (2 * MAP + 2) * 4);
    const road = (() => {
      let a = plain.length >> 1, b = a;
      while (a > 0 && plain[a - 1] !== face && plain[a - 1] !== "") a--;
      while (b < plain.length - 1 && plain[b + 1] !== face && plain[b + 1] !== "") b++;
      return plain[(a + b) >> 1];
    })();
    /** The run of tones round the line's middle, as far as the panel shows through either side: "road 2 | other 2 | road 2", in px. */
    const runsOf = (tones: string[]): string => {
      let a = tones.length >> 1, b = a;
      while (a > 0 && tones[a - 1] !== face && tones[a - 1] !== "") a--;
      while (b < tones.length - 1 && tones[b + 1] !== face && tones[b + 1] !== "") b++;
      const runs: string[] = [];
      let last = "", n = 0;
      const push = () => last && runs.push(`${last} ${(n / 4).toFixed(n % 4 ? 2 : 0)}`);
      for (let i = a; i <= b; i++) {
        const what = tones[i] === road ? "road" : "other";
        if (what === last) n++;
        else {
          push();
          last = what;
          n = 1;
        }
      }
      push();
      return runs.join(" | ");
    };

    // ---- BR-MAP: the track's shortcuts on the map ----
    // The map's own scale and offset (the HUD's baked minimap: view pixels = o + world * scale), so
    // a point of a centreline is found to the fraction of a pixel.
    const mini = (hud as { mini?: { scale: number; ox: number; oy: number } }).mini;
    const brs: any[] = track.branches ?? [];
    let br: BranchReport | undefined;
    if (brs.length && mini && Number.isFinite(mini.scale)) {
      const sc = mini.scale;
      const at = (x: number, y: number): [number, number] => [mini.ox - X0 + x * sc, mini.oy - Y0 + y * sc];
      const tone = (pic: Uint8Array, u: number, v: number): string => (u < 0 || v < 0 || u >= MAP || v >= MAP ? "" : hex(pic, (v * MAP + u) * 4));
      const onRoad = (X: number, Y: number): boolean => tone(bare, Math.floor(X), Math.floor(Y)) === road;
      const forkU = Math.max(T.WIDEN_TAPER, 4 / sc); // the lanes run together over this much road round an island (hud.ts MAP_FORK, MAP_FORK_MIN)
      /** On a road: inside a gap or round a split (where the line is broken, or two lanes), with `air` px to spare. */
      const special = (r: any, s: number, air: number): boolean =>
        r.gaps.some((g: any) => s > g.s0 - air / sc && s < g.s1 + air / sc) || r.islands.some((i: any) => s > i.s0 - forkU - air / sc && s < i.s1 + forkU + air / sc);
      /** A car's dot at a point of the world: its middle pixel on the map, or null when it is not whole. */
      const dotAt = (x: number, y: number): [number, number] | null => {
        view.px!.fill(0);
        hud.minimap([{ id: "p", x, y, h: 0, color: "#ff00ff", name: "", me: false, wreck: false, ghost: false }]);
        const d = cut();
        let sx = 0, sy = 0, n = 0;
        for (let o = 0; o < d.length; o += 4) {
          if (d[o] === 255 && d[o + 1] === 0 && d[o + 2] === 255) {
            sx += (o / 4) % MAP;
            sy += Math.floor(o / 4 / MAP);
            n++;
          }
        }
        return n === 9 ? [sx / 9, sy / 9] : null;
      };
      /** Dots a pixel apart along a road, outside its gaps and splits: how many, those whose middle pixel is the line's, those that cover a pixel of it. */
      const dotsAlong = (r: any): [number, number, number] => {
        let probes = 0, onLine = 0, touching = 0;
        for (let s = 0; s <= r.length; s += 1 / sc) {
          if (special(r, s, 1.5)) continue;
          const p = pointAt(r, s), c = dotAt(p.x, p.y);
          if (!c) continue;
          probes++;
          if (tone(bare, c[0], c[1]) === road) onLine++;
          let touch = false;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (tone(bare, c[0] + i, c[1] + j) === road) touch = true;
          if (touch) touching++;
        }
        return [probes, onLine, touching];
      };

      // The fit: every road's points.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, m0 = Infinity, n0 = Infinity, m1 = -Infinity, n1 = -Infinity;
      for (const p of track.pts) {
        m0 = Math.min(m0, p.x); m1 = Math.max(m1, p.x);
        n0 = Math.min(n0, p.y); n1 = Math.max(n1, p.y);
      }
      for (const r of [track, ...brs.map((b) => b.road)]) {
        for (const p of r.pts) {
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
          y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
      }
      const corner = at(x0, y0);
      const fit = { w: (x1 - x0) * sc, h: (y1 - y0) * sc, left: corner[0], top: corner[1], beyond: Math.max(m0 - x0, x1 - m1, n0 - y0, y1 - n1) * sc };

      // Every shortcut's centreline on the map, a sample every tenth of a pixel: [x, y, round a split].
      const lines: [number, number, boolean][] = [];
      const branches: BranchCheck[] = brs.map((b, bi) => {
        const r = b.road, L: number = r.length;
        let samples = 0, off = 0;
        for (let u = 0; u <= L; u += 0.1 / sc) {
          const p = pointAt(r, u), [X, Y] = at(p.x, p.y);
          lines.push([X, Y, r.islands.some((i: any) => u > i.s0 - forkU - 2 / sc && u < i.s1 + forkU + 2 / sc)]);
          if (special(r, u, 1.5)) continue;
          samples++;
          if (!onRoad(X, Y)) off++;
        }
        const gaps = r.gaps.map((g: any) => {
          let n = 0, on = 0;
          for (let u = g.s0 + 0.05 / sc; u < g.s1; u += 0.1 / sc) {
            const p = pointAt(r, u), [X, Y] = at(p.x, p.y);
            n++;
            if (onRoad(X, Y)) on++;
          }
          return { u0: g.s0, u1: g.s1, px: (g.s1 - g.s0) * sc, samples: n, on };
        });
        // A mouth: three arms meet in it, the main road before it (the trunk), the main road past
        // the gore and the shortcut past the gore. Inside the mouth's own box, the road's tone
        // from the shortcut's arm is to reach both others through pixels that share a side.
        const reach = Math.min(3 / sc, T.MOUTH_CLEAR - 50); // how far past the mouth each arm is taken, units
        const mouth = (end: "fork" | "merge"): MouthCheck => {
          const g = end === "fork" ? b.forkGore : b.mergeGore;
          if (!g) return { end, joined: false, note: "it has no gore there: the corridors never part", box: [0, 0, 0, 0], pockets: 0 };
          const dir = end === "fork" ? 1 : -1, sEnd: number = end === "fork" ? b.s0 : b.s1, uEnd = end === "fork" ? 0 : L;
          const pix = (p: { x: number; y: number }): [number, number] => {
            const [X, Y] = at(p.x, p.y);
            return [Math.floor(X), Math.floor(Y)];
          };
          // Where the two lines have parted for good: from the gore on, the first place on the shortcut 5 px
          // from the main centreline (the nearest point of it), at most a third of the shortcut along.
          let uFar: number = g.u, sFar: number = g.s, hint = pointAt(track, g.s).seg;
          for (; dir > 0 ? uFar < L / 3 : uFar > (2 * L) / 3; uFar += (dir * 0.25) / sc) {
            const p = pointAt(r, uFar), q = T.queryTrackNear(track, p.x, p.y, hint);
            hint = q.seg;
            sFar = q.s;
            if (q.dist * sc >= 5) break;
          }
          const arms: [string, [number, number]][] = [
            ["the shortcut where it has left the main road", pix(pointAt(r, uFar))],
            [end === "fork" ? "the main road before the fork" : "the main road after the merge", pix(pointAt(track, sEnd - dir * reach))],
            [end === "fork" ? "the main road past the mouth" : "the main road before the mouth", pix(pointAt(track, sFar + dir * reach))],
          ];
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          const grow = (p: { x: number; y: number }) => {
            const [X, Y] = pix(p);
            bx0 = Math.min(bx0, X - 3); bx1 = Math.max(bx1, X + 3);
            by0 = Math.min(by0, Y - 3); by1 = Math.max(by1, Y + 3);
          };
          for (let s = Math.min(sEnd - dir * reach, sFar + dir * reach); s <= Math.max(sEnd - dir * reach, sFar + dir * reach); s += 0.25 / sc) grow(pointAt(track, s));
          for (let u = Math.min(uEnd, uFar); u <= Math.max(uEnd, uFar); u += 0.25 / sc) grow(pointAt(r, u));
          const box: [number, number, number, number] = [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1];
          // Pockets: what is not the road's tone and cannot be reached from the box's edge through sides
          // (a split's own, the island between its lanes and its forks' tips, aside: within 3 px of its centreline).
          const open = new Set<number>(), walk: [number, number][] = [];
          const enter = (u: number, v: number) => {
            if (u < bx0 || u > bx1 || v < by0 || v > by1 || open.has(v * MAP + u) || tone(bare, u, v) === road) return;
            open.add(v * MAP + u);
            walk.push([u, v]);
          };
          for (let u = bx0; u <= bx1; u++) enter(u, by0), enter(u, by1);
          for (let v = by0; v <= by1; v++) enter(bx0, v), enter(bx1, v);
          while (walk.length) {
            const [u, v] = walk.pop()!;
            enter(u + 1, v), enter(u - 1, v), enter(u, v + 1), enter(u, v - 1);
          }
          let pockets = 0;
          for (let v = by0; v <= by1; v++) {
            for (let u = bx0; u <= bx1; u++) {
              if (tone(bare, u, v) === road || open.has(v * MAP + u)) continue;
              if (!lines.some(([X, Y, isle]) => isle && Math.hypot(u + 0.5 - X, v + 0.5 - Y) < 3)) pockets++;
            }
          }
          const dark = arms.filter(([, [u, v]]) => tone(bare, u, v) !== road);
          if (dark.length) return { end, joined: false, note: `no line under ${dark.map((a) => a[0]).join(" and ")}`, box, pockets };
          // Flood the road's tone from the shortcut's arm, inside the box, through sides.
          const seen = new Set<number>(), todo = [arms[0][1]];
          seen.add(arms[0][1][1] * MAP + arms[0][1][0]);
          while (todo.length) {
            const [u, v] = todo.pop()!;
            for (const [i, j] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const U = u + i, V = v + j;
              if (U < bx0 || U > bx1 || V < by0 || V > by1 || seen.has(V * MAP + U) || tone(bare, U, V) !== road) continue;
              seen.add(V * MAP + U);
              todo.push([U, V]);
            }
          }
          const apart = arms.slice(1).filter(([, [u, v]]) => !seen.has(v * MAP + u));
          return { end, joined: apart.length === 0, note: apart.length ? `the line does not reach ${apart.map((a) => a[0]).join(" or ")}` : `${seen.size} pixels of the road's tone in one piece`, box, pockets };
        };
        // A plain stretch: between the gores, clear of its mouths' widens, its gaps and its splits; the middle one.
        const fg = b.forkGore, mg = b.mergeGore, plains: number[] = [];
        for (let u = (fg ? fg.u : 0) + 200; u < (mg ? mg.u : L) - 200; u += 50) {
          if (r.widens.every((w: any) => u < w.s0 - 200 || u > w.s1 + 200) && !special(r, u, 200 * sc)) plains.push(u);
        }
        const plainU = plains.length ? plains[plains.length >> 1] : NaN;
        const [probes, onLine, touching] = dotsAlong(r);
        return {
          no: bi + 1, long: L * sc, samples, off, gaps, mouths: [mouth("fork"), mouth("merge")], probes, onLine, touching,
          plain: plains.length ? runsOf(across(plainU, r, at)) : "", plainU,
          islands: r.islands.map((i: any) => ({ s: (i.s0 + i.s1) / 2, runs: runsOf(across((i.s0 + i.s1) / 2, r, at)) })),
        };
      });
      const [mainProbes, mainOn] = dotsAlong(track);

      // The same track without its shortcuts, baked beside it: what do they change?
      const twinView = softCanvas();
      twinView.width = VIEW_W;
      twinView.height = VIEW_H;
      const twinHud = new Hud(twinView.getContext(), T.buildTrack({ ...track.def, id: `${track.def.id}/main-only`, features: (track.def.features ?? []).filter((f: any) => f.k !== "branch") }));
      twinHud.minimap([]);
      const alone = cut(twinView), tm = (twinHud as { mini?: { scale: number; ox: number; oy: number } }).mini!;
      let twin: BranchReport["twin"] = null;
      if (tm.scale === sc && tm.ox === mini.ox && tm.oy === mini.oy) {
        twin = { changed: 0, lost: 0, strayLine: 0, stray: 0, line: 0, casing: 0 };
        const tick = String(P.bone2).toLowerCase();
        // The casing's tone: the main line's own, beside it across the plain stretch.
        const casingTone = plain.find((t) => t !== "" && t !== face && t !== road) ?? "";
        for (let v = 0; v < MAP; v++) {
          for (let u = 0; u < MAP; u++) {
            const a = tone(alone, u, v), c = tone(bare, u, v);
            if (a === c) continue;
            twin.changed++;
            if (c === road) twin.line++;
            else if (c === casingTone) twin.casing++;
            if (a === road || a === tick) twin.lost++;
            let d = Infinity, split = false;
            for (const [X, Y, isle] of lines) {
              const e = Math.hypot(u + 0.5 - X, v + 0.5 - Y);
              if (e < d) {
                d = e;
                split = isle;
              }
            }
            // A line's stamp reaches a pixel's middle at most 1 px either way of its own (1.42 px),
            // a casing's 2 one way and 1 the other (2.24 px); round a split the lanes lie off the centreline.
            if (c === road && d > (split ? 8 : 1.5)) twin.strayLine++;
            if (d > (split ? 8 : 2.3)) twin.stray++;
          }
        }
      }

      // Cars on the shortcuts, two each (a third of the way along, and in the merge's mouth); the first is the own car.
      const riders = brs.flatMap((b, bi) => [0.33, 0.93].map((f, k) => {
        const p = pointAt(b.road, b.road.length * f), i = bi * 2 + k;
        return { id: `b${i}`, x: p.x, y: p.y, h: p.h, color: COLORS[i % COLORS.length], name: "", me: i === 0, wreck: false, ghost: false };
      }));
      view.px!.fill(0);
      hud.minimap(riders);
      const cars = Buffer.from(cut()).toString("base64");
      // The pack of the preview's tour (client/preview.ts tour(), held at its start: t = 0).
      view.px!.fill(0);
      hud.minimap(TOUR_PACK.map((ds, i) => {
        const p = pointAt(track, TOUR_S + ds);
        return { id: `p${i}`, x: p.x - Math.sin(p.h) * TOUR_LANES[i], y: p.y + Math.cos(p.h) * TOUR_LANES[i], h: p.h, color: COLORS[i], name: "", me: i === 0, wreck: false, ghost: false };
      }));
      br = { fit, branches, mainProbes, mainOn, twin, cars, tour: Buffer.from(cut()).toString("base64"), errors: T.validateTrack(track).length };
      if (track.def.id === "branch-yard") yardMap = { bare, scale: sc, ox: mini.ox, oy: mini.oy, fork: branches[0].mouths[0].box };
      if (track.def.id === WRAP_SHAPE) {
        br.wrap = null;
        if (yardMap && yardMap.scale === sc && yardMap.ox === mini.ox && yardMap.oy === mini.oy) {
          const [fx, fy, fw, fh] = yardMap.fork;
          br.wrap = 0;
          for (let v = fy; v < fy + fh; v++) for (let u = fx; u < fx + fw; u++) if (tone(bare, u, v) !== tone(yardMap.bare, u, v)) br.wrap++;
        }
      }
    }

    result.push({
      id: track.def.id,
      name: track.def.name,
      shipped,
      bare: Buffer.from(bare).toString("base64"),
      dots: Buffer.from(dots).toString("base64"),
      notPalette,
      islands: (track.islands ?? []).map((i: { s0: number; s1: number }) => ({ s: (i.s0 + i.s1) / 2, runs: runsOf(across((i.s0 + i.s1) / 2)) })),
      plain: runsOf(plain),
      road,
      ...(tool ? { tool } : {}),
      ...(br ? { br } : {}),
    });
  }
  writeFileSync(out, JSON.stringify(result));
}

/**
 * BR-MAP: four shapes of this tool's own, made of Branch Yard (its def, and the yard as built):
 * what the game's test track does not show the map.
 * - turned 30 degrees about its middle: the same roads, every mouth on a slant;
 * - a split on its first shortcut (a widen and an island in its middle, in place of the dirt);
 * - an island at the far end of its first shortcut (in the merge's mouth: not a valid track): the
 *   lanes of an island fork over a stretch of road before and after it, which on the main road runs
 *   on round the lap's end; a shortcut's road is open, so its other end, the fork, is to stay as it is;
 * - its first shortcut swung outside the loop, round the top-right bend: longer than the main road
 *   there, so no shortcut and not a valid track, but a road beyond the main road's own box (the fit).
 */
function branchShapes(yard: any, built: any): { def: any; what: string }[] {
  const turn = (a: number) => ([x, y]: [number, number]): [number, number] => {
    const dx = x - 3400, dy = y - 3300, c = Math.cos(a), s = Math.sin(a);
    return [3400 + dx * c - dy * s, 3300 + dx * s + dy * c];
  };
  const shapes: { def: any; what: string }[] = [];
  const t30 = turn(Math.PI / 6);
  shapes.push({
    what: "Branch Yard turned 30 degrees: every mouth on a slant",
    def: { ...yard, id: "map-branch-slant", name: "Branch Yard turned", control: yard.control.map(t30), features: yard.features.map((f: any) => (f.k === "branch" ? { ...f, control: f.control.map(t30) } : f)) },
  });
  const b0 = built.branches[0], fg = b0.forkGore, mg = b0.mergeGore;
  if (fg && mg) {
    const mid = (fg.u + mg.u) / 2;
    const split = [{ k: "widen", s0: mid - 500, s1: mid + 500, left: 40, right: 40 }, { k: "island", s0: mid - 350, s1: mid + 350, lat0: -22, lat1: 22 }];
    let first = true;
    shapes.push({
      what: "Branch Yard with a split on its first shortcut",
      def: { ...yard, id: "map-branch-split", name: "Branch Yard split", features: yard.features.map((f: any) => (f.k === "branch" && first ? ((first = false), { ...f, features: split }) : f)) },
    });
  }
  {
    // An island that ends 60 short of the first shortcut's end, in its merge's mouth. On a closed road
    // the lanes of an island that near the lap's end would fork across s = 0; a shortcut's road is open.
    const L: number = b0.road.length;
    let first = true;
    shapes.push({
      what: "Branch Yard with an island at the far end of its first shortcut (not a valid track: an open road does not wrap)",
      def: { ...yard, id: WRAP_SHAPE, name: "Branch Yard far island", features: yard.features.map((f: any) => (f.k === "branch" && first ? ((first = false), { ...f, features: [{ k: "island", s0: L - 500, s1: L - 60, lat0: -22, lat1: 22 }] }) : f)) },
    });
  }
  let first = true;
  shapes.push({
    what: "Branch Yard with its first shortcut swung outside the loop (not a valid track: for the fit)",
    def: {
      ...yard, id: "map-branch-out", name: "Branch Yard outside",
      features: yard.features.map((f: any) => (f.k === "branch" && first ? ((first = false), { ...f, side: -1, features: [], control: [[5400, 430], [6000, 260], [6700, 240], [6960, 500], [6980, 1100], [6800, 1800]] }) : f)),
    },
  });
  return shapes;
}

// ---- the parent ---------------------------------------------------------------------------

const picture = (b64: string): Picture => ({ w: MAP, h: MAP, data: new Uint8Array(Buffer.from(b64, "base64")) });

function bakesOf(root: string): Baked[] {
  const dir = mkdtempSync(path.join(tmpdir(), "map-sheet-json-"));
  try {
    const file = path.join(dir, "out.json");
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--child", root, file], { cwd: HERE, stdio: ["ignore", "inherit", "inherit"] });
    return JSON.parse(readFileSync(file, "utf8")) as Baked[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where two pictures differ: the second one, greyed, the differing pixels red. */
function mask(a: Picture, b: Picture): Picture {
  const out = blank(b.w, b.h, 0, 0, 0);
  for (let o = 0; o < b.data.length; o += 4) {
    const same = a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2] && a.data[o + 3] === b.data[o + 3];
    const grey = (b.data[o] + b.data[o + 1] + b.data[o + 2]) / 6;
    out.data.set(same ? [grey, grey, grey, 255] : [255, 40, 40, 255], o);
  }
  return out;
}

async function main(): Promise<void> {
  const OUT = path.resolve(arg("--out") ?? path.join(HERE, "tmp", "m4-map"));
  mkdirSync(OUT, { recursive: true });
  const temps: string[] = [];
  let ok = true;
  const check = (good: boolean, what: string) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  };
  try {
    const ref = arg("--ref");
    let before: Baked[] | null = null, refLabel = "";
    if (ref) {
      const sha = execFileSync("git", ["rev-parse", "--short", `${ref}^{commit}`], { cwd: HERE, encoding: "utf8" }).trim();
      const dir = mkdtempSync(path.join(tmpdir(), "map-sheet-ref-"));
      temps.push(dir);
      execFileSync("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", sha, dir], { cwd: HERE });
      refLabel = `${ref} (${sha})`;
      before = bakesOf(dir);
    }
    const now = bakesOf(HERE);
    console.log(`# The minimaps (${now.length} tracks)${ref ? `, the working tree against ${refLabel}` : ""}\n`);

    const Z = 4, PADDING = 8;
    const strip = blank(PADDING + (before ? 3 : 1) * (MAP * Z + PADDING), PADDING + now.length * (MAP * Z + PADDING), 18, 14, 11);
    now.forEach((t, row) => {
      const mine = picture(t.bare);
      const big = blank(MAP * 6, MAP * 6, 0, 0, 0);
      paste(big, mine, 0, 0, 0, 0, MAP, MAP, 6);
      savePng(path.join(OUT, `mini-${t.id}.png`), big);
      const y = PADDING + row * (MAP * Z + PADDING);
      const old = before?.find((b) => b.id === t.id);
      if (before) {
        if (old) {
          paste(strip, picture(old.bare), PADDING, y, 0, 0, MAP, MAP, Z);
          paste(strip, mask(picture(old.bare), mine), PADDING + 2 * (MAP * Z + PADDING), y, 0, 0, MAP, MAP, Z);
        }
        paste(strip, mine, PADDING + MAP * Z + PADDING, y, 0, 0, MAP, MAP, Z);
      } else paste(strip, mine, PADDING, y, 0, 0, MAP, MAP, Z);

      check(t.notPalette === 0, `${t.name}: every pixel of its minimap is a palette colour (${t.notPalette} are not)`);
      if (before) {
        if (!old) console.log(`      ${t.name}: ${refLabel} has no such track`);
        else {
          const n = differing(picture(old.bare), mine), m = differing(picture(old.dots), picture(t.dots));
          if (t.shipped) check(n === 0 && m === 0, `${t.name} (shipped): its baked minimap is ${refLabel}'s, bit for bit: ${n} of ${MAP * MAP} pixels differ (with six cars' dots on it: ${m})`);
          else console.log(`      ${t.name} (test track): ${n} of ${MAP * MAP} pixels differ from ${refLabel}'s (with the dots: ${m})`);
        }
      }
      check(/^other [\d.]+ \| road [\d.]+ \| other [\d.]+$/.test(t.plain), `${t.name}: across a plain stretch the map shows one line (${t.plain})`);
      for (const i of t.islands) {
        const m = /^other [\d.]+ \| road ([\d.]+) \| other ([\d.]+) \| road ([\d.]+) \| other [\d.]+$/.exec(i.runs);
        check(!!m && Number(m[2]) >= 2 && Number(m[1]) >= 1.5 && Number(m[3]) >= 1.5, `${t.name}: across the island at s ${i.s} the map shows a lane, the island and a lane, the island at least 2 px (${i.runs})`);
      }
      if (t.br) branchChecks(OUT, t, check);
    });
    savePng(path.join(OUT, "bakes.png"), strip);
    console.log(`\n${path.join(OUT, "bakes.png")}${before ? `  (per track: ${refLabel} | the working tree | the pixels that differ, in red)` : ""}`);
    for (const t of now) console.log(path.join(OUT, `mini-${t.id}.png`));
    for (const t of now) {
      if (!t.br) continue;
      console.log(path.join(OUT, `mini-${t.id}-cars.png`));
      for (const b of t.br.branches) for (const m of b.mouths) if (m.box[2]) console.log(path.join(OUT, `mouth-${t.id}-${b.no}-${m.end}.png`));
    }

    if (args.includes("--scenes")) {
      if (!ref) throw new Error("map-sheet: --scenes compares with a ref: give --ref <ref>");
      if (!(await scenes(OUT, temps[0], refLabel))) ok = false;
    }
    if (args.includes("--sheet")) await sheet(OUT, now, before, refLabel);
    if (args.includes("--branches") && !(await branchSheet(OUT, now, before, refLabel))) ok = false;
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
}

// ---- BR-MAP: a track's shortcuts ----------------------------------------------------------------

const MAP_FIT = 96, MAP_AIR = 6; // the square a track is fitted into, and the box's edge round it (client/gfx/hud.ts)
const MOUTH_Z = 16; // a mouth's picture: this many times enlarged

/** A mouth of a shortcut cut out of a bake, its box with two pixels of air, MOUTH_Z times enlarged. */
function mouthPicture(bake: Picture, m: MouthCheck): Picture {
  const x = Math.max(0, m.box[0] - 2), y = Math.max(0, m.box[1] - 2), w = Math.min(MAP - x, m.box[2] + 4), h = Math.min(MAP - y, m.box[3] + 4);
  const out = blank(w * MOUTH_Z, h * MOUTH_Z, 0, 0, 0);
  paste(out, bake, 0, 0, x, y, w, h, MOUTH_Z);
  return out;
}

/** The checks of a track with shortcuts (its BranchReport), and its pictures: the bake with cars on the shortcuts, every mouth enlarged. */
function branchChecks(OUT: string, t: Baked, check: (good: boolean, what: string) => void): void {
  const r = t.br!, px = (v: number) => v.toFixed(1), near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const big = blank(MAP * 6, MAP * 6, 0, 0, 0);
  paste(big, picture(r.cars), 0, 0, 0, 0, MAP, MAP, 6);
  savePng(path.join(OUT, `mini-${t.id}-cars.png`), big);
  console.log(`      ${t.name}${t.tool ? ` (this tool's own shape: ${t.tool})` : ""}: ${r.branches.length} shortcut${r.branches.length > 1 ? "s" : ""}; validateTrack: ${r.errors ? `${r.errors} error${r.errors > 1 ? "s" : ""}` : "valid"}`);
  check(
    near(Math.max(r.fit.w, r.fit.h), MAP_FIT) && near(r.fit.left, MAP_AIR + (MAP_FIT - r.fit.w) / 2) && near(r.fit.top, MAP_AIR + (MAP_FIT - r.fit.h) / 2),
    `${t.name}: fitted with its shortcuts: all its roads' points fill the ${MAP_FIT} px square, centred (${px(r.fit.w)} x ${px(r.fit.h)} px from (${px(r.fit.left)}, ${px(r.fit.top)}); the shortcuts reach ${px(Math.max(0, r.fit.beyond))} px outside the main road's own box)`,
  );
  for (const b of r.branches) {
    const who = `${t.name}, shortcut ${b.no}`;
    check(b.samples > 0 && b.off === 0, `${who} (${px(b.long)} px long): drawn from its fork to its merge: ${b.samples - b.off} of ${b.samples} samples of its centreline (outside its gaps and splits) lie on the road's tone`);
    for (const g of b.gaps) check(g.samples > 0 && g.on === 0, `${who}: broken over its gap at u ${g.u0}..${g.u1} (${px(g.px)} px on the map): ${g.on} of ${g.samples} samples of the centreline in it lie on the road's tone`);
    for (const m of b.mouths) {
      check(m.joined && m.pockets === 0, `${who}: joined to the main road at its ${m.end}: in the mouth's box (${m.box[2]} x ${m.box[3]} px at ${m.box[0]}, ${m.box[1]}) ${m.note}${m.joined ? ", from the shortcut where it has left the main road (5 px from it) to the main road either side of the mouth" : ""}; ${m.pockets} pixels of another tone are shut in by the line there`);
      if (m.box[2]) savePng(path.join(OUT, `mouth-${t.id}-${b.no}-${m.end}.png`), mouthPicture(picture(t.bare), m));
    }
    // One run of the road's tone, 2 px of it (to 3 on a slant); on a slant the line across can step
    // from the line to the panel between two stamps of the casing, which has no corners.
    const one = /^(?:other [\d.]+ \| )?road ([\d.]+)(?: \| other [\d.]+)?$/.exec(b.plain);
    if (b.plain) check(!!one && Number(one[1]) >= 1.5 && Number(one[1]) <= 3.25, `${who}: across a plain stretch (u ${Math.round(b.plainU)}) the map shows one line of the main road's width (${b.plain}; the main road: ${t.plain})`);
    else console.log(`      ${who}: no plain stretch between its gores to look across`);
    for (const i of b.islands) {
      if (r.wrap !== undefined) continue; // that shape's island lies in a mouth, over the main road's line: nothing to read across it
      const m = /^other [\d.]+ \| road ([\d.]+) \| other ([\d.]+) \| road ([\d.]+) \| other [\d.]+$/.exec(i.runs);
      check(!!m && Number(m[2]) >= 2 && Number(m[1]) >= 1.5 && Number(m[3]) >= 1.5, `${who}: across its island at u ${Math.round(i.s)} the map shows a lane, the island and a lane, the island at least 2 px (${i.runs})`);
    }
    check(b.probes > 0 && b.touching === b.probes && b.onLine / b.probes >= r.mainOn / r.mainProbes - 0.05, `${who}: a car's dot on it lands on its line: of ${b.probes} dots a pixel apart along it, ${b.onLine} have their middle pixel on the line and ${b.touching} cover it (the main road: ${r.mainOn} of ${r.mainProbes} on the line)`);
  }
  if (r.wrap !== undefined) check(r.wrap === 0, `${t.name}: an island at the far end of a shortcut does not reach round to its start (an open road does not wrap): in the box of that shortcut's fork the map is Branch Yard's, pixel for pixel (${r.wrap === null ? "not compared: the two are not fitted alike" : `${r.wrap} pixels differ`})`);
  if (r.twin) {
    check(r.twin.line + r.twin.casing === r.twin.changed && r.twin.line > 0, `${t.name}: its shortcuts are in the main road's line style (the same track baked without them): the ${r.twin.changed} pixels they change are of the main line's two tones, ${r.twin.line} its line's and ${r.twin.casing} its casing's (an island between two lanes is in the casing's)`);
    check(r.twin.lost === 0 && r.twin.strayLine === 0 && r.twin.stray === 0, `${t.name}: its shortcuts only add to the map, and no blob: ${r.twin.lost} pixels of the main line or the start tick are lost; ${r.twin.strayLine} of the road's tone lie further than a line's stamp (1.5 px) from a shortcut's centreline, ${r.twin.stray} of any tone further than a casing's (2.3 px)`);
  }
  else console.log(`      ${t.name}: not compared with the same track without its shortcuts (they change the fit)`);
}

// ---- the contact sheet ----------------------------------------------------------------------

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];
const VIEW_W = 640, VIEW_H = 360, MAP_X = VIEW_W - 112, MAP_Y = 4; // the view and the minimap's box in it (client/gfx/hud.ts)
const AIR = 6; // view pixels of the frame shown round the minimap in a cut-out
const SCENE = "yard-map";

/** A piece of a picture. */
function cutOut(p: Picture, x: number, y: number, w: number, h: number): Picture {
  const out = blank(w, h, 0, 0, 0);
  paste(out, p, 0, 0, x, y, w, h);
  return out;
}

/** A picture enlarged or reduced by any factor, each pixel the one its middle falls on (as `image-rendering: pixelated` does). */
function resized(p: Picture, w: number, h: number): Picture {
  const out = blank(w, h, 0, 0, 0);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (Math.min(p.h - 1, Math.floor(((j + 0.5) * p.h) / h)) * p.w + Math.min(p.w - 1, Math.floor(((i + 0.5) * p.w) / w))) * 4;
      out.data.set(p.data.subarray(o, o + 4), (j * w + i) * 4);
    }
  }
  return out;
}

const cleanups: (() => unknown)[] = [];

const sites = new Map<string, Promise<string>>();

/** Build the tree in `root` (the working tree as it is, or a ref unpacked) into a temp folder and serve it on 127.0.0.1 (the working tree's on --port, when given): its address. Once a tree. */
function site(root: string, what: string): Promise<string> {
  let s = sites.get(root);
  if (!s) sites.set(root, (s = serve(root, what, root === HERE ? Number(arg("--port") ?? 0) : 0)));
  return s;
}

async function serve(root: string, what: string, port: number): Promise<string> {
  const dist = mkdtempSync(path.join(tmpdir(), "map-sheet-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error(`building ${what} ...`);
  if (root !== HERE && !existsSync(path.join(root, "node_modules"))) symlinkSync(path.join(HERE, "node_modules"), path.join(root, "node_modules"));
  await run(path.join(HERE, "node_modules", ".bin", "vite"), ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: root, maxBuffer: 16 << 20 });
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
  return new Promise<string>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

type Browser = (more: string[]) => Promise<string>;

/** A headless Chrome of its own (agent-browser session map-<pid>-<tag>, or --session's name for map), muted, closed at the end. */
async function browser(tag: string): Promise<Browser> {
  const session = `${arg("--session") ?? "map"}-${process.pid}-${tag}`;
  const ab: Browser = async (more) => (await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 })).stdout.trim();
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  return ab;
}

/** A piece of the game canvas of the page a browser shows, its own pixels. */
async function canvasOf(ab: Browser, x = 0, y = 0, w = VIEW_W, h = VIEW_H): Promise<Picture> {
  const GRAB = `(() => { const c = document.getElementById("view"); const d = c.getContext("2d").getImageData(${x}, ${y}, ${w}, ${h}).data; let s = ""; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return btoa(s); })()`;
  return { w, h, data: new Uint8Array(Buffer.from(JSON.parse(await ab(["eval", "-b", Buffer.from(GRAB).toString("base64")])) as string, "base64")) };
}

/** A preview scene held at its key moment (or at &t=), in a browser. */
async function hold(ab: Browser, url: string, scene: string, more: Record<string, string> = {}): Promise<void> {
  await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", preview: "1", scene, freeze: "1", ...more })}`]);
  await sleep(500); // a held scene is redrawn every frame: any frame after the first will do
}

// The preview's scenes from before M4-MAP (client/preview.ts), in its order: on the figure-eight
// and on Rust Bowl, then M4-WORLD's on the Preview Yard.
const SCENES_BEFORE = ["ramp", "gap", "crossing", "hole", "scrap", "jump", "fall", "ghost", "rust", "fx", "wreck", "damage", "mine", "spectator", "pause", "countdown", "blast", "looks", "cells", "boost", "draft", "catchup", "yard-chicane", "yard-truck", "yard-split", "yard-bend", "yard-belt"];

/**
 * The existing preview scenes, the ref's build against the working tree's, the game canvas's own
 * pixels (640 x 360): how many differ inside the minimap's box and outside it. A scene on a
 * track without an island: none anywhere. A scene on the Preview Yard: none outside the box.
 */
async function scenes(OUT: string, refRoot: string, refLabel: string): Promise<boolean> {
  const urlThen = await site(refRoot, refLabel), urlNow = await site(HERE, "the working tree");
  const then = await browser("base"), now = await browser("this");
  for (const ab of [then, now]) await ab(["set", "viewport", "1280", "720", "1"]);
  let ok = true;
  console.log(`\n## The preview scenes from before, ${refLabel} against the working tree (the game canvas, ${VIEW_W} x ${VIEW_H} = ${VIEW_W * VIEW_H} pixels; held at the key moment)\n`);
  console.log("| scene | differing in the minimap's box (108 x 108) | differing outside it | |");
  console.log("|---|---:|---:|---|");
  const inBox = (o: number) => {
    const x = (o / 4) % VIEW_W, y = Math.floor(o / 4 / VIEW_W);
    return x >= MAP_X && x < MAP_X + MAP && y >= MAP_Y && y < MAP_Y + MAP;
  };
  for (const scene of SCENES_BEFORE) {
    await hold(then, urlThen, scene);
    await hold(now, urlNow, scene);
    const a = await canvasOf(then), b = await canvasOf(now);
    let inside = 0, outside = 0;
    for (let o = 0; o < a.data.length; o += 4) if (a.data[o] !== b.data[o] || a.data[o + 1] !== b.data[o + 1] || a.data[o + 2] !== b.data[o + 2] || a.data[o + 3] !== b.data[o + 3]) inBox(o) ? inside++ : outside++;
    const split = scene.startsWith("yard-"); // drawn on the Preview Yard, which has islands: its minimap is the one that changes
    const good = outside === 0 && (split ? inside > 0 : inside === 0);
    if (!good) ok = false;
    console.log(`| ${scene} | ${inside} | ${outside} | ${good ? (split ? "ok: the minimap alone (a track with splits)" : "ok: the same picture") : "FAIL"} |`);
    if (split) {
      // Before | after: the corner of the view with the minimap, four times enlarged.
      const W = 160, H = 120, pair = blank(2 * W * 4 + 12, H * 4, 18, 14, 11);
      paste(pair, a, 0, 0, VIEW_W - W, 0, W, H, 4);
      paste(pair, b, W * 4 + 12, 0, VIEW_W - W, 0, W, H, 4);
      savePng(path.join(OUT, `pair-${scene}.png`), pair);
    }
  }
  // The control: the method must see a change. One scene 20 ms later, in one build.
  await hold(now, urlNow, SCENES_BEFORE[0], { t: "1" });
  const c0 = await canvasOf(now);
  await hold(now, urlNow, SCENES_BEFORE[0], { t: "1.02" });
  const control = differing(c0, await canvasOf(now));
  console.log(`\n${control ? "ok  " : "FAIL"}  the control: scene ${SCENES_BEFORE[0]} at t=1 against t=1.02 in one build differs in ${control} pixels (the method sees a change)`);
  console.log(`${ok ? "ok  " : "FAIL"}  ${SCENES_BEFORE.length} scenes: those on a track without an island are the same picture, those on the Preview Yard differ in the minimap's box alone`);
  console.log(`Before | after of the Preview Yard scenes' minimap corner: ${path.join(OUT, "pair-yard-*.png")}`);
  return ok && control > 0;
}

/** A row of a contact sheet: its title and its pictures, each with a label under it. */
interface Row { title: string; cells: { label: string; pic: Picture }[] }

const grown = (p: Picture, k: number) => resized(p, p.w * k, p.h * k);

/** A contact sheet: its heading and its rows, written with the game's own font on a stand-in canvas. */
async function paperOf(heading: string, rows: Row[]): Promise<Picture> {
  (globalThis as Record<string, unknown>).document = { createElement: softCanvas };
  const { print, covers, TALL, SMALL } = await import("../../client/gfx/font");
  const { P } = await import("../../client/gfx/palette");
  const GAP = 16, LINE = 22;
  const width = Math.max(...rows.map((r) => GAP + r.cells.reduce((s, c) => s + c.pic.w + GAP, 0)), 900);
  const height = 60 + rows.reduce((s, r) => s + LINE + 14 + Math.max(...r.cells.map((c) => c.pic.h)) + LINE + GAP, 0);
  const paper = softCanvas();
  paper.width = width;
  paper.height = height;
  const g = paper.getContext() as { fillStyle: string; fillRect: (x: number, y: number, w: number, h: number) => void; putImageData: (img: { width: number; height: number; data: Uint8Array }, x: number, y: number) => void };
  g.fillStyle = P.soot1;
  g.fillRect(0, 0, width, height);
  const write = (text: string, x: number, y: number, cut: typeof TALL, color: string, scale = 1) => {
    if (!covers(text)) throw new Error(`map-sheet: the font does not cover "${text}"`);
    print(g as unknown as CanvasRenderingContext2D, true, text, x, y, cut, color, scale);
  };
  write(heading, GAP, 14, TALL, P.rust3, 2);
  let y = 60;
  for (const r of rows) {
    write(r.title, GAP, y, TALL, P.bone2);
    y += LINE;
    let x = GAP;
    const h = Math.max(...r.cells.map((c) => c.pic.h));
    for (const c of r.cells) {
      g.putImageData({ width: c.pic.w, height: c.pic.h, data: c.pic.data }, x, y);
      write(c.label, x, y + h + 6, SMALL, P.bone0);
      x += c.pic.w + GAP;
    }
    y += h + LINE + 14 + GAP;
  }
  return { w: width, h: height, data: new Uint8Array(paper.px!.buffer) };
}

/** A window's shot of a held scene and the minimap cut out of it (with AIR round it), saved as <stem>window-<size>.png and <stem>minimap-<size>.png. */
// (The M4-MAP sheet shows a window from its top; the shortcuts' sheet from where the game's view is: on a phone held upright it lies in the middle.)
async function shoot(ab: Browser, OUT: string, stem: string, size: (typeof SIZES)[number]): Promise<{ size: (typeof SIZES)[number]; shot: Picture; crop: Picture; per: number; top: number }> {
  const file = path.join(OUT, `${stem}window-${size.name}.png`);
  await ab(["screenshot", file]);
  const shot = decodePng(file);
  const box = JSON.parse(JSON.parse(await ab(["eval", `JSON.stringify((({x, y, width, height}) => ({x, y, width, height}))(document.getElementById("view").getBoundingClientRect()))`])) as string) as { x: number; y: number; width: number; height: number };
  const per = (box.width / VIEW_W) * size.scale; // window pixels a view pixel
  const x0 = Math.round((box.x * size.scale) + (MAP_X - AIR) * per), y0 = Math.round((box.y * size.scale) + (MAP_Y - AIR) * per), side = Math.round((MAP + 2 * AIR) * per);
  const crop = cutOut(shot, Math.max(0, x0), Math.max(0, y0), side, side);
  savePng(path.join(OUT, `${stem}minimap-${size.name}.png`), crop);
  return { size, shot, crop, per, top: Math.round(box.y * size.scale) }; // top: where the game's view starts in the window, window pixels
}

/**
 * BR-MAP: the shortcuts' contact sheet. The working tree built and served; the preview's tour of
 * Branch Yard (?debug=1&preview=1&scene=tour&track=branch-yard&s=TOUR_S&freeze=1: the pack on the
 * top straight) shot at both sizes; the minimap in Chrome's canvas against the one made here in
 * Node, pixel for pixel. The sheet: the minimap as the two windows show it, the bakes (the ref's,
 * now, with cars on the shortcuts), every mouth enlarged, this tool's own shapes, both windows.
 */
async function branchSheet(OUT: string, now: Baked[], before: Baked[] | null, refLabel: string): Promise<boolean> {
  const yard = now.find((t) => t.id === "branch-yard" && t.br);
  if (!yard?.br) {
    console.log("FAIL  --branches: this tree has no Branch Yard with shortcuts on its map");
    return false;
  }
  let ok = true;
  const url = await site(HERE, "the working tree");
  const ab = await browser("branches");
  const windows: Awaited<ReturnType<typeof shoot>>[] = [];
  for (const size of SIZES) {
    await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
    await hold(ab, url, "tour", { track: yard.id, s: String(TOUR_S) });
    await sleep(700); // a larger track than the Preview Yard: its first tiles
    windows.push(await shoot(ab, OUT, "branch-", size));
    if (size.scale === 1) {
      const there = await canvasOf(ab, MAP_X, MAP_Y, MAP, MAP);
      const n = differing(there, picture(yard.br.tour));
      console.log(`${n === 0 ? "ok  " : "FAIL"}  ${yard.name}: the minimap in Chrome's canvas (the preview's tour held at s ${TOUR_S}, its pack of six) is the one made here in Node, pixel for pixel (${n} of ${MAP * MAP} differ)`);
      if (n) ok = false;
    }
  }
  const Z = 6, rows: Row[] = [];
  rows.push({
    title: `As the game shows it: the preview's tour of ${yard.name} in headless Chrome, the minimap cut out of the window, the window's own pixels and those three times enlarged`,
    cells: windows.flatMap((w) => [
      { label: `${w.size.name}  (${w.per.toFixed(2)} window px a game px)`, pic: w.crop },
      { label: `${w.size.name}  x 3`, pic: grown(w.crop, 3) },
    ]),
  });
  const old = before?.find((b) => b.id === yard.id);
  rows.push({
    title: `The baked minimap of ${yard.name}, the game's pixels ${Z} times enlarged`,
    cells: [
      ...(old ? [{ label: `before: ${refLabel}`, pic: grown(picture(old.bare), Z) }] : []),
      { label: "now: its three shortcuts, in the main road's line", pic: grown(picture(yard.bare), Z) },
      { label: "now, with two cars on each shortcut (the own one ringed)", pic: grown(picture(yard.br.cars), Z) },
    ],
  });
  const mouths = (t: Baked): Row["cells"] => t.br!.branches.flatMap((b) => b.mouths.filter((m) => m.box[2]).map((m) => ({ label: `shortcut ${b.no}: its ${m.end}`, pic: mouthPicture(picture(t.bare), m) })));
  rows.push({ title: `${yard.name}: every mouth, ${MOUTH_Z} times enlarged (where a shortcut leaves the main road, and where it comes back)`, cells: mouths(yard) });
  for (const t of now) {
    if (!t.tool || !t.br) continue;
    rows.push({
      title: `Not a track of the game, a shape of this tool's: ${t.tool}. ${Z} times enlarged`,
      cells: [
        { label: "its bake", pic: grown(picture(t.bare), Z) },
        { label: "with two cars on each shortcut", pic: grown(picture(t.br.cars), Z) },
      ],
    });
    if (t.id === "map-branch-slant") rows.push({ title: `${t.name}: every mouth, ${MOUTH_Z} times enlarged`, cells: mouths(t) });
  }
  for (const w of windows) {
    // The window, or the part of it the game's view takes (a phone held upright is mostly page above and below it).
    const y = Math.max(0, w.top - Math.round(20 * w.per)), high = Math.min(w.shot.h - y, Math.round((VIEW_H + 40) * w.per));
    rows.push({ title: `The window at ${w.size.name}${high < w.shot.h ? ", the game's view in it" : ""}`, cells: [{ label: `branch-window-${w.size.name}.png`, pic: cutOut(w.shot, 0, y, w.shot.w, high) }] });
  }
  const file = path.join(OUT, "branch-sheet.png");
  savePng(file, await paperOf("SCRAP RALLY  BR-MAP: shortcut roads on the minimap", rows));
  console.log(`\nThe shortcuts' sheet: ${file}`);
  for (const w of windows) console.log(`${path.join(OUT, `branch-minimap-${w.size.name}.png`)}\n${path.join(OUT, `branch-window-${w.size.name}.png`)}`);
  return ok;
}

async function sheet(OUT: string, now: Baked[], before: Baked[] | null, refLabel: string): Promise<void> {
  {
    // The working tree, built and served; the scene at both sizes.
    const url = await site(HERE, "the working tree");
    const ab = await browser("sheet");
    const yard = now.find((t) => !t.shipped && t.islands.length) ?? now[now.length - 1];
    const windows: { size: (typeof SIZES)[number]; shot: Picture; crop: Picture; per: number }[] = [];
    for (const size of SIZES) {
      await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
      await hold(ab, url, SCENE);
      windows.push(await shoot(ab, OUT, "", size));
      if (size.scale === 1) {
        // The game canvas's own pixels: is the minimap the browser baked the one baked here, in Node?
        const there = await canvasOf(ab, MAP_X, MAP_Y, MAP, MAP);
        const n = differing(there, picture(yard.dots));
        console.log(`${n === 0 ? "ok  " : "FAIL"}  ${yard.name}: the minimap in Chrome's canvas (scene ${SCENE}, its key moment, six dots) is the one made here in Node, pixel for pixel (${n} of ${MAP * MAP} differ)`);
        if (n) process.exitCode = 1;
      }
    }

    const also = args.flatMap((a, i) => (a === "--also" ? [args[i + 1]] : [])).map((v) => ({ label: v.slice(0, v.indexOf("=")), root: path.resolve(v.slice(v.indexOf("=") + 1)) }));
    const others = also.map((a) => ({ label: a.label, baked: bakesOf(a.root).find((t) => t.id === yard.id)! }));
    const Z = 6;
    const rows: Row[] = [];
    const label = arg("--label"); // what to call the working tree's look, when others stand beside it
    rows.push({
      title: `${label ? `${label}. ` : ""}As the game shows it: the preview scene ${SCENE} in headless Chrome, the minimap cut out of the window, the window's own pixels and those three times enlarged`,
      cells: windows.flatMap((w) => [
        { label: `${w.size.name}  (${w.per.toFixed(2)} window px a game px)`, pic: w.crop },
        { label: `${w.size.name}  x 3`, pic: grown(w.crop, 3) },
      ]),
    });
    const old = before?.find((b) => b.id === yard.id);
    rows.push({
      title: `${label ? `${label}. ` : ""}The baked minimap of ${yard.name}, the game's pixels ${Z} times enlarged`,
      cells: [
        ...(old ? [{ label: `before: ${refLabel}`, pic: grown(picture(old.bare), Z) }] : []),
        { label: "now", pic: grown(picture(yard.bare), Z) },
        { label: "now, with six cars' dots (the own one ringed)", pic: grown(picture(yard.dots), Z) },
      ],
    });
    for (const o of others) {
      // Another tree's look, as the two windows would show it: the window's scaling done here.
      rows.push({
        title: `${o.label}. Another look, not built: as the two windows would show it, and ${Z} times enlarged`,
        cells: [
          ...windows.map((w) => ({ label: `as at ${w.size.name}`, pic: resized(picture(o.baked.dots), Math.round(MAP * w.per), Math.round(MAP * w.per)) })),
          { label: `x ${Z}`, pic: grown(picture(o.baked.bare), Z) },
          { label: `x ${Z}, with the dots`, pic: grown(picture(o.baked.dots), Z) },
        ],
      });
    }
    for (const w of windows) {
      // The window, or as much of it as the game's view takes (a phone's window is mostly page below it).
      const high = Math.min(w.shot.h, Math.round((VIEW_H + 40) * w.per));
      rows.push({ title: `The window at ${w.size.name}${high < w.shot.h ? ", its top" : ""}`, cells: [{ label: `window-${w.size.name}.png`, pic: cutOut(w.shot, 0, 0, w.shot.w, high) }] });
    }
    const file = path.join(OUT, "sheet.png");
    savePng(file, await paperOf("SCRAP RALLY  M4-MAP: the minimap of split lanes", rows));
    console.log(`\nThe sheet: ${file}`);
    for (const w of windows) console.log(`${path.join(OUT, `minimap-${w.size.name}.png`)}\n${path.join(OUT, `window-${w.size.name}.png`)}`);
  }
}

if (args.includes("--child")) await child(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2]);
else await main();
