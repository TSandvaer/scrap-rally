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

async function child(root: string, out: string): Promise<void> {
  (globalThis as Record<string, unknown>).document = { createElement: softCanvas };
  const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
  const { trackList, trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { Hud } = await load("client/gfx/hud.ts");
  const { P } = await load("client/gfx/palette.ts");
  const { VIEW_W, VIEW_H } = await load("client/gfx/world.ts");
  const tests = existsSync(path.join(root, "shared/testtracks.ts")) ? await load("shared/testtracks.ts") : null;
  const palette = new Set<string>(Object.values(P as Record<string, string>).map((h) => h.toLowerCase()));
  const tracks: { track: any; shipped: boolean }[] = (trackList() as { id: string }[]).map((e) => ({ track: trackById(e.id), shipped: true }));
  if (tests) for (const d of tests.TEST_TRACKS as { id: string }[]) tracks.push({ track: tests.testTrack(d.id), shipped: false });
  const X0 = VIEW_W - 112, Y0 = 4;
  const result: Baked[] = [];
  for (const { track, shipped } of tracks) {
    const view = softCanvas();
    view.width = VIEW_W;
    view.height = VIEW_H;
    const hud = new Hud(view.getContext(), track);
    const cut = (): Uint8Array => {
      const o = new Uint8Array(MAP * MAP * 4);
      for (let y = 0; y < MAP; y++) o.set(view.px!.subarray(((Y0 + y) * VIEW_W + X0) * 4, ((Y0 + y) * VIEW_W + X0 + MAP) * 4), y * MAP * 4);
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
    /** The tones on the line across the road at s, from 8 px left of the centreline to 8 px right, a sample every quarter pixel. */
    const across = (s: number): string[] => {
      const p = pointAt(track, s);
      const [cx, cy] = mapAt(p.x, p.y);
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
    // The road's tone on the map: what lies on the centreline of a plain stretch. The panel's: a pixel inside the frame's corner.
    const plain = across(plainS);
    const road = plain[plain.length >> 1], face = hex(bare, (2 * MAP + 2) * 4);
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
    });
  }
  writeFileSync(out, JSON.stringify(result));
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
    });
    savePng(path.join(OUT, "bakes.png"), strip);
    console.log(`\n${path.join(OUT, "bakes.png")}${before ? `  (per track: ${refLabel} | the working tree | the pixels that differ, in red)` : ""}`);
    for (const t of now) console.log(path.join(OUT, `mini-${t.id}.png`));

    if (args.includes("--scenes")) {
      if (!ref) throw new Error("map-sheet: --scenes compares with a ref: give --ref <ref>");
      if (!(await scenes(OUT, temps[0], refLabel))) ok = false;
    }
    if (args.includes("--sheet")) await sheet(OUT, now, before, refLabel);
  } finally {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
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

/** Build the tree in `root` (the working tree as it is, or a ref unpacked) into a temp folder and serve it on 127.0.0.1: its address. */
async function site(root: string, what: string): Promise<string> {
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
  return new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

type Browser = (more: string[]) => Promise<string>;

/** A headless Chrome of its own (agent-browser session map-<pid>-<tag>), muted, closed at the end. */
async function browser(tag: string): Promise<Browser> {
  const session = `map-${process.pid}-${tag}`;
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
      const file = path.join(OUT, `window-${size.name}.png`);
      await ab(["screenshot", file]);
      const shot = decodePng(file);
      const box = JSON.parse(JSON.parse(await ab(["eval", `JSON.stringify((({x, y, width, height}) => ({x, y, width, height}))(document.getElementById("view").getBoundingClientRect()))`])) as string) as { x: number; y: number; width: number; height: number };
      const per = (box.width / VIEW_W) * size.scale; // window pixels a view pixel
      const x0 = Math.round((box.x * size.scale) + (MAP_X - AIR) * per), y0 = Math.round((box.y * size.scale) + (MAP_Y - AIR) * per), side = Math.round((MAP + 2 * AIR) * per);
      const crop = cutOut(shot, Math.max(0, x0), Math.max(0, y0), side, side);
      savePng(path.join(OUT, `minimap-${size.name}.png`), crop);
      windows.push({ size, shot, crop, per });
      if (size.scale === 1) {
        // The game canvas's own pixels: is the minimap the browser baked the one baked here, in Node?
        const there = await canvasOf(ab, MAP_X, MAP_Y, MAP, MAP);
        const n = differing(there, picture(yard.dots));
        console.log(`${n === 0 ? "ok  " : "FAIL"}  ${yard.name}: the minimap in Chrome's canvas (scene ${SCENE}, its key moment, six dots) is the one made here in Node, pixel for pixel (${n} of ${MAP * MAP} differ)`);
        if (n) process.exitCode = 1;
      }
    }

    // The sheet, written with the game's own font on a stand-in canvas.
    (globalThis as Record<string, unknown>).document = { createElement: softCanvas };
    const { print, covers, TALL, SMALL } = await import("../../client/gfx/font");
    const { P } = await import("../../client/gfx/palette");
    const also = args.flatMap((a, i) => (a === "--also" ? [args[i + 1]] : [])).map((v) => ({ label: v.slice(0, v.indexOf("=")), root: path.resolve(v.slice(v.indexOf("=") + 1)) }));
    const others = also.map((a) => ({ label: a.label, baked: bakesOf(a.root).find((t) => t.id === yard.id)! }));
    const Z = 6, GAP = 16, LINE = 22;
    const rows: { title: string; cells: { label: string; pic: Picture }[] }[] = [];
    const grown = (p: Picture, k: number) => resized(p, p.w * k, p.h * k);
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
    write("SCRAP RALLY  M4-MAP: the minimap of split lanes", GAP, 14, TALL, P.rust3, 2);
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
    const file = path.join(OUT, "sheet.png");
    savePng(file, { w: width, h: height, data: new Uint8Array(paper.px!.buffer) });
    console.log(`\nThe sheet: ${file}`);
    for (const w of windows) console.log(`${path.join(OUT, `minimap-${w.size.name}.png`)}\n${path.join(OUT, `window-${w.size.name}.png`)}`);
  }
}

if (args.includes("--child")) await child(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2]);
else await main();
