// Render benchmark runner: drives client/bench.ts (?debug=1&bench=1) in headless Chrome
// through the agent-browser CLI, one cell (metric x scene x track) per page load, several
// runs, and prints the tables and the gate's verdict (PLAN-GFX.md, "Baseline"). No npm
// dependencies. It builds what it measures itself: the working tree, and a git ref for the
// baseline, each in a temp directory, so a stale dist/ cannot be measured by mistake.
//
//   npm run bench -- --vs-ref gfx-baseline   the gate: this tree against the fixed reference
//   npm run bench                            this tree alone: numbers, no verdict
//   npm run bench -- --pixels --vs-ref main  same pixels in the preview scenes?
//   npm run bench -- http://localhost:3006 --vs http://localhost:3007   targets given by hand
//
// Exit code 1 when a gated value is OVER (or the run failed), else 0. A built directory is
// served by this script on 127.0.0.1 with cross-origin isolation, which gives the page a 5 us
// timer; a URL target has whatever its server allows (usually 100 us).

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BenchOut, Cell, CellA, CellB, CellC } from "../client/bench";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const SCENES = ["S1", "S2", "S3", "S4", "S5"];
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"];
const METRICS = ["A", "G", "B", "C"];
// Silent, and never throttled when the window is not in front; precise heap sizes for metric C.
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding,--enable-precise-memory-info";

// The gate (PLAN-GFX.md, "Baseline"; user decision 2026-11-18). Both builds are loaded one
// after the other in every run; a value's ratio is the median of the per-run ratios
// this build / baseline. Metric A's median and p95 are OVER above GATE_RATIO.
const GATE_RATIO = 1.05;
const GATE_RUNS = 5; // fewer runs: numbers only, no verdict
const CTOR_ALLOWANCE_MS = 50; // PLAN-GFX section 4: construction at or below baseline + 50 ms
// The fixed reference every ticket is gated against: `--vs-ref gfx-baseline` reads the commit
// from this file (one hash on a line; lines starting with # are comments).
const BASELINE_NAME = "gfx-baseline";
const BASELINE_FILE = path.join(ROOT, "scripts", "gfx-baseline.ref");

const HELP = `npm run bench -- [target] [options]

  target             what to measure. Default: the working tree, built by the runner in a
                     temp directory. Or a built client directory or a URL, used as given.
  --vs-ref <ref>     the baseline: that git ref's client, built in a temp directory. The name
                     ${BASELINE_NAME} is the fixed reference of the gate (the commit in
                     scripts/gfx-baseline.ref); any other ref is a look, not the gate.
  --vs <target>      a baseline given as a built directory or a URL
  --runs <n>         runs per cell (default ${GATE_RUNS}; fewer gives numbers but no verdict)
  --viewports <l>    default 1280x720,390x844@3
  --metrics <l>      default A,G,B,C  (A = CPU raster, G = the same on a GPU canvas,
                     B = rAF-paced intervals, C = heap growth; see PLAN-GFX.md "Baseline")
  --only <l>         cells to run: S4 or S4:crusher-run, comma separated
  --b-scene <S#>     the scene metric B plays (default S4)
  --panel <id>       metric B with that DOM panel shown over the canvas (e.g. lobby)
  --quick            1 run, 1280x720, metric A only
  --pixels           no timing: pixel-diff the preview scenes (?debug=1&preview=1&freeze=1,
                     with and without the caption) between the two builds, or between two
                     loads of one build; --scenes <l> picks them (default: all sixteen)
  --out <file>       raw results as JSON (default tmp/bench/<time>.json)
  --session <name>   agent-browser session prefix. Default bench-<pid>, so two runs at once
                     never share a browser (they still disturb each other's timing). The
                     sessions <name>-base and <name>-this are closed on every way out.

With a baseline the runs alternate between the two builds and the gate is judged: metric A's
median and p95 are OVER when the median of the per-run ratios this/baseline is above ${GATE_RATIO};
metric B's frames over 20 ms and the Renderer's construction are checked against the baseline
too. Exit code 1 when anything is OVER.`;

interface Viewport {
  name: string;
  w: number;
  h: number;
  scale: number;
}

interface Target {
  label: string;
  url: string;
  session: string;
}

interface Sample {
  target: string;
  run: number;
  viewport: string;
  metric: string; // A, G, B or C (G = the page's metric A on a GPU canvas)
  cell: Cell;
}

/** A value the gate judged. */
interface Gated {
  what: string; // "A median S4 crusher-run at 1280x720"
  kind: "ratio" | "dropped" | "construction";
  ratio: number; // this / baseline (ratio); the plain values otherwise
  base: number;
  cand: number;
  over: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

/** A failure with a message for the user: thrown, never an exit on the spot, so that every way out runs the cleanup. */
class Stop extends Error {}

function fail(msg: string): never {
  throw new Stop(msg);
}

// Everything opened on the way (browser sessions, servers, temp builds) registers its undoing
// here; it runs once, newest first, however the run ends: done, failed, or interrupted.
const cleanups: (() => unknown)[] = [];
let cleaning: Promise<void> | null = null;

/** Undo everything; every caller waits for the one pass (a signal and the failing run it causes both end up here). */
function cleanUp(): Promise<void> {
  cleaning ??= (async () => {
    for (const undo of cleanups.reverse()) {
      try {
        await undo();
      } catch {
        /* nothing more to do about a failed close */
      }
    }
  })();
  return cleaning;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Serve a built client directory, cross-origin isolated (the page gets a 5 us timer). */
function serveDir(dir: string): Promise<string> {
  if (!existsSync(path.join(dir, "index.html"))) fail(`${dir} has no index.html: it is not a built client`);
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = path.join(dir, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dir, "index.html");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    createReadStream(file).pipe(res);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

/** A temp directory that is removed again on every way out. */
function tempDir(kind: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `scrap-bench-${kind}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function viteBuild(cwd: string, more: string[], what: string): Promise<void> {
  try {
    await run(VITE, ["build", ...more], { cwd, maxBuffer: 16 << 20 });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    fail(`building ${what} failed:\n${err.stderr || err.message}`);
  }
}

/** The commit a ref names; the name gfx-baseline is read from scripts/gfx-baseline.ref. */
async function resolveRef(name: string): Promise<string> {
  let rev = name;
  if (name === BASELINE_NAME) {
    const line = existsSync(BASELINE_FILE)
      ? readFileSync(BASELINE_FILE, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"))
      : undefined;
    if (!line) fail(`${BASELINE_NAME} is not set: put the hash of the GFX-0 merge commit on a line of scripts/gfx-baseline.ref`);
    rev = line;
  }
  try {
    return (await run("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: ROOT })).stdout.trim();
  } catch {
    return fail(`${name === rev ? name : `${name} (${rev} in scripts/gfx-baseline.ref)`} is not a commit of this repository`);
  }
}

/** Build a commit's client into a temp directory (its own sources, this checkout's node_modules). */
async function buildRef(name: string, sha: string): Promise<string> {
  const dir = tempDir("base");
  console.error(`building ${name} (${sha.slice(0, 12)}) in ${dir} ...`);
  await run("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", sha, dir], { cwd: ROOT });
  if (!flag("pixels") && !existsSync(path.join(dir, "client", "bench.ts"))) fail(`${name} has no client/bench.ts: it cannot be benchmarked`);
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  await viteBuild(dir, [], name);
  return path.join(dir, "dist");
}

/** Build the working tree's client (uncommitted changes and all) into a temp directory: dist/ is neither used nor touched. */
async function buildTree(): Promise<string> {
  const dir = tempDir("this");
  console.error(`building the working tree in ${dir} ...`);
  await viteBuild(ROOT, ["--outDir", dir, "--emptyOutDir"], "the working tree");
  return dir;
}

async function ab(session: string, args: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", session, ...args], { timeout: 120_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

/** Close a browser session and wait until agent-browser no longer lists it (its daemon takes a moment to go). */
async function closeSession(session: string): Promise<void> {
  await ab(session, ["close"]).catch(() => {});
  for (let i = 0; i < 40; i++) {
    const list = await run("agent-browser", ["session", "list"], { timeout: 20_000 }).then((r) => r.stdout, () => "");
    if (!list.split("\n").some((line) => line.replace(/^\W+/, "").trim() === session)) return;
    await sleep(250);
  }
  console.error(`the browser session ${session} is still listed: close it with \`agent-browser --session ${session} close\``);
}

/** A build to measure: served if it is a directory, with a browser session of its own. */
async function target(label: string, spec: string, prefix: string): Promise<Target> {
  const url = /^https?:\/\//.test(spec) ? spec.replace(/\/+$/, "") : await serveDir(path.resolve(spec));
  const session = `${prefix}-${label}`;
  // Registered before it is opened: a launch that fails half-way is closed too.
  cleanups.push(() => closeSession(session));
  await ab(session, ["--args", CHROME_ARGS, "open", "about:blank"]);
  return { label, url, session };
}

/** One page load: a single cell of a metric. */
async function load(t: Target, query: Record<string, string>, settleMs: number): Promise<BenchOut> {
  await ab(t.session, ["open", `${t.url}/?${new URLSearchParams({ debug: "1", bench: "1", ...query })}`]);
  // A paced run is left alone until it must be over: a poll runs JS in the page.
  if (settleMs) await sleep(settleMs);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const state = await ab(t.session, ["eval", "window.scrapBench ? (window.scrapBench.done ? 2 : 1) : 0"]);
    if (state === "2") break;
    if (Date.now() > deadline) fail(`${t.label}: the bench page did not finish (state ${state}); is client/bench.ts in that build?`);
    await sleep(250);
  }
  const out = JSON.parse(JSON.parse(await ab(t.session, ["eval", "JSON.stringify(window.scrapBench)"])) as string) as BenchOut;
  if (out.error) fail(`${t.label}: bench error: ${out.error}`);
  return out;
}

// ---- pixel diff of the preview scenes -----------------------------------------------

const PREVIEW_SCENES = ["ramp", "gap", "crossing", "hole", "scrap", "jump", "fall", "ghost", "rust", "fx", "wreck", "damage", "mine", "spectator", "pause", "countdown"];
// The game canvas as base64 RGBA (640x360).
const GRAB = `(() => { const c = document.getElementById("view"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = ""; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return btoa(s); })()`;

async function grab(t: Target, query: Record<string, string>): Promise<Buffer> {
  await ab(t.session, ["open", `${t.url}/?${new URLSearchParams({ debug: "1", preview: "1", ...query })}`]);
  await sleep(300); // a held scene is redrawn every frame: any frame after the first will do
  return Buffer.from(JSON.parse(await ab(t.session, ["eval", "-b", Buffer.from(GRAB).toString("base64")])) as string, "base64");
}

function differing(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Math.max(a.length, b.length) / 4;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  return n;
}

/** The preview scenes, held, in both builds (or twice in one): how many pixels differ. */
async function pixelDiff(base: Target, cand: Target, scenes: string[]): Promise<string> {
  for (const t of new Set([base, cand])) await ab(t.session, ["set", "viewport", "1280", "720", "1"]);
  const rows: string[][] = [];
  let total = 0;
  for (const scene of scenes) {
    const row = [scene];
    for (const more of [{}, { hud: "0" }] as Record<string, string>[]) {
      const q = { scene, freeze: "1", ...more };
      const n = differing(await grab(base, q), await grab(cand, q));
      total += n;
      row.push(String(n));
    }
    rows.push(row);
    console.error(`${scene.padEnd(10)} ${row.slice(1).join("  ")}`);
  }
  // The control: the method must see a change. The same scene 20 ms later, in one build.
  const control = differing(await grab(cand, { scene: scenes[0], t: "1" }), await grab(cand, { scene: scenes[0], t: "1.02" }));
  return [
    `Pixel diff of the preview scenes (640x360 = 230400 pixels each), ${base === cand ? "two loads of one build" : "baseline against this build"}.\n`,
    table(["Scene", "differing pixels, freeze=1", "freeze=1&hud=0"], rows),
    `\nTotal differing pixels: ${total}. Control (scene ${scenes[0]} at t=1 against t=1.02, one build): ${control} pixels differ${control ? "" : " - THE CONTROL FAILED, the method sees nothing"}.`,
  ].join("\n");
}

// ---- statistics and the gate ---------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ms = (x: number) => x.toFixed(x < 100 ? 3 : 1);
const int = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const whole = (x: number) => x.toFixed(0);

function pick<T extends Cell>(samples: Sample[], t: string, vp: string, metric: string, scene: string, track: string): T[] {
  return samples.filter((s) => s.target === t && s.viewport === vp && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => s.cell as T);
}

/** A value of one cell in both builds, run by run (only the runs both have). */
function pairs<T extends Cell>(samples: Sample[], vp: string, metric: string, scene: string, track: string, f: (x: T) => number): { base: number[]; cand: number[] } {
  const of = (t: string) =>
    new Map(samples.filter((s) => s.target === t && s.viewport === vp && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => [s.run, f(s.cell as T)]));
  const b = of("base"), c = of("this");
  const runs = [...b.keys()].filter((r) => c.has(r)).sort((x, y) => x - y);
  return { base: runs.map((r) => b.get(r)!), cand: runs.map((r) => c.get(r)!) };
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map((h, i) => (i < 2 && /^[A-Za-z]/.test(h) && !/\d/.test(h) ? "---" : "---:")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

const TITLES: Record<string, string> = {
  A: "Metric A (CPU raster, ms per frame)",
  G: "Metric G (as A on a GPU canvas, ms per frame; informational)",
  B: "Metric B (rAF-paced, ms between frames)",
  C: "Metric C (heap bytes allocated per frame; informational)",
};

/** One build alone: the median of the runs and their spread (max - min). */
function tablesAlone(samples: Sample[], vps: Viewport[], metrics: string[]): string {
  const out: string[] = [];
  const cols = (name: string) => [name, "±"];
  for (const vp of vps) {
    for (const metric of metrics) {
      const rows: string[][] = [];
      for (const scene of SCENES) {
        for (const track of TRACKS) {
          const cells = pick<Cell>(samples, "base", vp.name, metric, scene, track);
          if (!cells.length) continue;
          const col = <T extends Cell>(f: (x: T) => number, fmt: (x: number) => string) => {
            const xs = (cells as T[]).map(f);
            return [fmt(median(xs)), fmt(Math.max(...xs) - Math.min(...xs))];
          };
          if (metric === "A" || metric === "G") {
            const sums = new Set(cells.map((x) => (x as CellA).checksum));
            rows.push([scene, track, ...col<CellA>((x) => x.p50, ms), ...col<CellA>((x) => x.p95, ms), ...col<CellA>((x) => x.p99, ms), ...col<CellA>((x) => x.over, int), sums.size === 1 ? [...sums][0] : `**${sums.size} differ**`]);
          } else if (metric === "B") {
            rows.push([scene, track, ...col<CellB>((x) => x.p50, ms), ...col<CellB>((x) => x.p95, ms), ...col<CellB>((x) => x.over20, int), ...col<CellB>((x) => x.jsP50, ms)]);
          } else {
            rows.push([scene, track, ...col<CellC>((x) => (x.allocBytes - x.probeBytes) / x.n, whole), ...col<CellC>((x) => x.gcDrops, int)]);
          }
        }
      }
      if (!rows.length) continue;
      const head: Record<string, string[]> = {
        A: ["Scene", "Track", ...cols("median"), ...cols("p95"), ...cols("p99"), ...cols(">4 ms"), "checksum"],
        B: ["Scene", "Track", ...cols("median"), ...cols("p95"), ...cols(">20 ms"), ...cols("frame() median")],
        C: ["Scene", "Track", ...cols("bytes/frame"), ...cols("GCs")],
      };
      out.push(`**${TITLES[metric]} at ${vp.name}**\n\n${table(head[metric === "G" ? "A" : metric], rows)}`);
    }
    // Construction and the first frame of a cold page, from the metric A cells.
    const rows = TRACKS.flatMap((track) => {
      const cells = samples.filter((s) => s.viewport === vp.name && s.metric === "A" && s.cell.track === track).map((s) => s.cell as CellA);
      if (!cells.length) return [];
      const one = (f: (x: CellA) => number) => [ms(median(cells.map(f))), ms(Math.max(...cells.map(f)))];
      return [[track, String(cells.length), ...one((x) => x.ctorMs), ...one((x) => x.firstMs)]];
    });
    if (rows.length) out.push(`**Renderer construction and first frame on a cold page at ${vp.name} (ms)**\n\n${table(["Track", "page loads", "new Renderer() median", "max", "first frame median", "max"], rows)}`);
  }
  return out.join("\n\n");
}

/**
 * This build against the baseline. Each value is the median of the runs; a ratio is the
 * median of the per-run ratios this / baseline. With `judge`, the gated values get ok or
 * OVER and are collected in `gated`.
 */
function tablesVersus(samples: Sample[], vps: Viewport[], metrics: string[], judge: boolean, gated: Gated[]): string {
  const out: string[] = [];
  const verdict = (over: boolean) => (judge ? (over ? " **OVER**" : " ok") : "");
  const cols = (name: string) => [`${name} base`, "this", "ratio"];
  const pair = (name: string) => [`${name} base`, "this"];
  for (const vp of vps) {
    for (const metric of metrics) {
      const rows: string[][] = [];
      for (const scene of SCENES) {
        for (const track of TRACKS) {
          if (!pick<Cell>(samples, "base", vp.name, metric, scene, track).length) continue;
          const of = <T extends Cell>(f: (x: T) => number) => pairs<T>(samples, vp.name, metric, scene, track, f);
          /** base, this, ratio; `gate` names the value when it is one the gate judges. */
          const timed = <T extends Cell>(f: (x: T) => number, gate: string | null): string[] => {
            const p = of<T>(f);
            const ratio = median(p.base.map((b, i) => p.cand[i] / b));
            if (!gate) return [ms(median(p.base)), ms(median(p.cand)), ratio.toFixed(3)];
            const over = ratio > GATE_RATIO;
            if (judge) gated.push({ what: `${metric} ${gate} ${scene} ${track} at ${vp.name}`, kind: "ratio", ratio, base: median(p.base), cand: median(p.cand), over });
            return [ms(median(p.base)), ms(median(p.cand)), `${ratio.toFixed(3)}${verdict(over)}`];
          };
          const plain = <T extends Cell>(f: (x: T) => number, fmt: (x: number) => string): string[] => {
            const p = of<T>(f);
            return [fmt(median(p.base)), fmt(median(p.cand))];
          };
          if (metric === "A" || metric === "G") {
            const sums = new Set(samples.filter((s) => s.viewport === vp.name && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => (s.cell as CellA).checksum));
            const gate = metric === "A"; // G is read, not gated
            rows.push([
              scene, track,
              ...timed<CellA>((x) => x.p50, gate ? "median" : null), ...timed<CellA>((x) => x.p95, gate ? "p95" : null), ...timed<CellA>((x) => x.p99, null), ...plain<CellA>((x) => x.over, int),
              sums.size === 1 ? [...sums][0] : `**${sums.size} differ**`,
            ]);
          } else if (metric === "B") {
            // Dropped frames: at or below the baseline's (PLAN-GFX section 4). In headless Chrome that is 0.
            const d = of<CellB>((x) => x.over20);
            const over = median(d.cand) > median(d.base);
            if (judge) gated.push({ what: `B frames over 20 ms ${scene} ${track} at ${vp.name}`, kind: "dropped", ratio: 0, base: median(d.base), cand: median(d.cand), over });
            rows.push([scene, track, ...plain<CellB>((x) => x.p50, ms), ...plain<CellB>((x) => x.p95, ms), int(median(d.base)), `${int(median(d.cand))}${verdict(over)}`, ...plain<CellB>((x) => x.jsP50, ms)]);
          } else {
            rows.push([scene, track, ...plain<CellC>((x) => (x.allocBytes - x.probeBytes) / x.n, whole), ...plain<CellC>((x) => x.gcDrops, int)]);
          }
        }
      }
      if (!rows.length) continue;
      const head: Record<string, string[]> = {
        A: ["Scene", "Track", ...cols("median"), ...cols("p95"), ...cols("p99"), ...pair(">4 ms"), "same picture"],
        B: ["Scene", "Track", ...pair("median"), ...pair("p95"), ...pair(">20 ms"), ...pair("frame() median")],
        C: ["Scene", "Track", ...pair("bytes/frame"), ...pair("GCs")],
      };
      out.push(`**${TITLES[metric]} at ${vp.name}**\n\n${table(head[metric === "G" ? "A" : metric], rows)}`);
    }
    // Construction and the first frame of a cold page, from the metric A cells.
    const rows = TRACKS.flatMap((track) => {
      const of = (t: string) => samples.filter((s) => s.target === t && s.viewport === vp.name && s.metric === "A" && s.cell.track === track).map((s) => s.cell as CellA);
      const b = of("base"), c = of("this");
      if (!b.length || !c.length) return [];
      const ctor = { base: median(b.map((x) => x.ctorMs)), cand: median(c.map((x) => x.ctorMs)) };
      const over = ctor.cand > ctor.base + CTOR_ALLOWANCE_MS;
      if (judge) gated.push({ what: `construction ${track} at ${vp.name}`, kind: "construction", ratio: 0, ...ctor, over });
      return [[track, String(b.length), ms(ctor.base), `${ms(ctor.cand)}${verdict(over)}`, ms(median(b.map((x) => x.firstMs))), ms(median(c.map((x) => x.firstMs)))]];
    });
    if (rows.length) out.push(`**Renderer construction and first frame on a cold page at ${vp.name} (ms, medians)**\n\n${table(["Track", "page loads each", "new Renderer() base", "this", "first frame base", "this"], rows)}`);
  }
  return out.join("\n\n");
}

/** What the gate found, in words; and whether it failed. */
function gateSummary(gated: Gated[], reference: string): string {
  const ratios = gated.filter((g) => g.kind === "ratio");
  const dropped = gated.filter((g) => g.kind === "dropped");
  const built = gated.filter((g) => g.kind === "construction");
  const over = gated.filter((g) => g.over);
  const lines = [`**Gate: ${over.length ? `FAIL, ${over.length} value(s) OVER` : "PASS"}**`, "", `- ${reference}`];
  if (ratios.length) {
    const rs = ratios.map((g) => g.ratio);
    const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    lines.push(`- Metric A, median and p95 (OVER above ${GATE_RATIO}): ${ratios.length} ratios from ${Math.min(...rs).toFixed(3)} to ${Math.max(...rs).toFixed(3)}, ${ratios.filter((g) => g.over).length} OVER. Largest: ${worst.what}.`);
  }
  if (dropped.length) lines.push(`- Metric B, frames over 20 ms (OVER above the baseline's): ${dropped.length} cells, ${dropped.filter((g) => g.over).length} OVER.`);
  if (built.length) lines.push(`- Construction (OVER above baseline + ${CTOR_ALLOWANCE_MS} ms): ${built.length} checked, ${built.filter((g) => g.over).length} OVER.`);
  for (const g of over) lines.push(`- OVER: ${g.what}: ${g.kind === "ratio" ? `ratio ${g.ratio.toFixed(3)} (${ms(g.base)} -> ${ms(g.cand)} ms)` : `${ms(g.base)} -> ${ms(g.cand)}`}`);
  return lines.join("\n");
}

// ---- main -------------------------------------------------------------------------

/** The run; the exit code. */
async function main(): Promise<number> {
  if (flag("help") || flag("h")) {
    console.log(HELP);
    return 0;
  }
  // Everything that can be wrong with the command line is found before anything is opened.
  const quick = flag("quick");
  const runs = Number(arg("runs") ?? (quick ? 1 : GATE_RUNS));
  if (!Number.isInteger(runs) || runs < 1) fail(`bad --runs ${arg("runs")}`);
  const vps: Viewport[] = (arg("viewports") ?? (quick ? "1280x720" : "1280x720,390x844@3")).split(",").map((v) => {
    const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(v.trim());
    if (!m) fail(`bad viewport ${v}`);
    return { name: v.trim(), w: Number(m[1]), h: Number(m[2]), scale: Number(m[3] ?? 1) };
  });
  const metrics = (arg("metrics") ?? (quick ? "A" : "A,G,B,C")).toUpperCase().split(",");
  for (const m of metrics) if (!METRICS.includes(m)) fail(`unknown metric ${m}: use ${METRICS.join(", ")}`);
  const only = (arg("only") ?? "").split(",").filter(Boolean).map((o) => o.split(":"));
  const wanted = (scene: string, track: string) => !only.length || only.some(([s, t]) => s.toUpperCase() === scene && (!t || t === track));
  const bScene = (arg("b-scene") ?? "S4").toUpperCase();
  const panel = arg("panel") ?? "";
  const prefix = arg("session") ?? `bench-${process.pid}`;
  const valued = new Set(["vs", "vs-ref", "runs", "viewports", "metrics", "only", "b-scene", "panel", "out", "session", "scenes"]);
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && valued.has(all[i - 1].slice(2))));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.resolve(arg("out") ?? path.join(ROOT, "tmp", "bench", `${stamp}.json`));
  if (arg("vs") && arg("vs-ref")) fail("give --vs or --vs-ref, not both");

  // Every cell of a run, as [metric, page query, time to leave a paced run alone].
  const cells: { metric: string; scene: string; track: string; query: Record<string, string>; settle: number }[] = [];
  for (const metric of metrics) {
    for (const track of TRACKS) {
      const scenes = metric === "B" ? [bScene] : metric === "C" ? ["S3"] : SCENES;
      for (const scene of scenes) {
        if (!wanted(scene, track)) continue;
        const query: Record<string, string> = { metric: metric === "G" ? "A" : metric, scene, track };
        if (metric === "G") query.canvas = "gpu";
        if (metric === "B" && panel) query.panel = panel;
        cells.push({ metric, scene, track, query, settle: metric === "B" ? 11_500 : 0 });
      }
    }
  }
  if (!flag("pixels") && !cells.length) fail("nothing to run: check --metrics, --only and --b-scene");

  // The two builds. The baseline: a git ref built here, or a target given by hand.
  const vsRef = arg("vs-ref");
  const baseSha = vsRef ? await resolveRef(vsRef) : null;
  let fixedSha: string | null = null;
  try {
    fixedSha = await resolveRef(BASELINE_NAME);
  } catch (e) {
    if (!(e instanceof Stop) || vsRef === BASELINE_NAME) throw e;
  }
  const vsSpec = vsRef ? await buildRef(vsRef, baseSha!) : arg("vs");
  const spec = positional[0] ?? (await buildTree());
  const targets: Target[] = [];
  if (vsSpec) targets.push(await target("base", vsSpec, prefix));
  targets.push(await target(vsSpec ? "this" : "base", spec, prefix));
  if (flag("pixels")) {
    console.log(await pixelDiff(targets[0], targets[targets.length - 1], arg("scenes")?.split(",") ?? PREVIEW_SCENES));
    return 0;
  }

  const samples: Sample[] = [];
  let env: BenchOut["env"] | null = null;
  const total = runs * vps.length * cells.length * targets.length;
  let done = 0;
  const started = Date.now();
  for (let r = 0; r < runs; r++) {
    for (const vp of vps) {
      for (const t of targets) {
        await ab(t.session, ["set", "viewport", String(vp.w), String(vp.h), String(vp.scale)]);
        // One short load that is thrown away: the first page after a (re)sized window is colder.
        await load(t, { metric: "A", scene: "S1", track: TRACKS[0], frames: "30", warm: "0" }, 0);
      }
      for (const [k, c] of cells.entries()) {
        if (c.metric === "C" && vp !== vps[0]) continue; // the heap does not depend on the viewport
        // The two builds one right after the other (the pair the ratio is taken from),
        // alternating which goes first so neither always runs on the warmer machine.
        const order = (r + k) % 2 ? [...targets].reverse() : targets;
        const line: string[] = [];
        for (const t of order) {
          const out = await load(t, c.query, c.settle);
          env ??= out.env;
          for (const cell of out.cells) samples.push({ target: t.label, run: r + 1, viewport: vp.name, metric: c.metric, cell });
          const cell = out.cells[0];
          line.push(`${t.label} ${cell.metric === "C" ? `${cell.allocBytes} B` : `p50 ${ms(cell.p50)} p95 ${ms(cell.p95)}`}`);
          done++;
        }
        const eta = ((Date.now() - started) / done) * (total - done);
        console.error(`run ${r + 1}/${runs}  ${vp.name.padEnd(10)} ${c.metric} ${c.scene} ${c.track.padEnd(14)} ${line.join("   ")}   (${Math.round(eta / 1000)} s left)`);
      }
    }
  }

  const compare = targets.length > 1;
  const judge = compare && runs >= GATE_RUNS;
  const gated: Gated[] = [];
  const tables = compare ? tablesVersus(samples, vps, metrics, judge, gated) : tablesAlone(samples, vps, metrics);
  // Against the fixed reference the ratios are a total: every ticket merged since GFX-0 is in them.
  const fixed = baseSha !== null && baseSha === fixedSha;
  const baseName = vsRef ? `${vsRef} (${baseSha!.slice(0, 12)})` : (arg("vs") ?? "");
  const reference = fixed
    ? `Reference: ${baseName}, the fixed reference. The ratios are the total since GFX-0, not this ticket's share, so slowdowns cannot add up from ticket to ticket.`
    : `Reference: ${baseName}. NOT the gate: this is not the fixed reference, so it shows one step only. The gate is \`npm run bench -- --vs-ref ${BASELINE_NAME}\`.`;
  const over = gated.filter((g) => g.over).length;

  mkdirSync(path.dirname(outFile), { recursive: true });
  const meta = {
    date: new Date().toISOString(), cpu: os.cpus()[0]?.model ?? "", cores: os.cpus().length, os: `${os.type()} ${os.release()}`, node: process.version,
    runs, env, targets: targets.map((t) => t.label), target: positional[0] ?? "working tree (built by the runner)", vs: vsRef ?? arg("vs"), vsSha: baseSha, fixedReference: fixed,
    gate: judge ? { ratio: GATE_RATIO, over, values: gated } : null,
  };
  writeFileSync(outFile, JSON.stringify({ meta, samples }, null, 1));

  console.log(`Render benchmark, ${meta.date.slice(0, 10)}: ${runs} run(s) per cell, ${meta.cpu}, ${env?.ua.match(/(Headless)?Chrome\/[\d.]+/)?.[0] ?? "?"}, timer ${((env?.timerMs ?? 0) * 1000).toFixed(0)} us.`);
  console.log(`Measured: ${meta.target}${compare ? `, against ${baseName}` : ""}.`);
  console.log(
    compare
      ? `Each value is the median of the runs; a ratio is the median of the per-run ratios this build / baseline (the two are loaded one right after the other in every run). OVER = a ratio above ${GATE_RATIO}, on metric A's median and p95. p99, the frames over 4 ms, G and C are information.\n`
      : "Median of the runs, ± = their spread (max - min). No verdict: the gate needs a baseline (--vs-ref gfx-baseline).\n",
  );
  if (compare && !judge) console.log(`Only ${runs} run(s): no verdict. The gate is defined on ${GATE_RUNS} runs.\n`);
  console.log(tables);
  if (judge) console.log(`\n${gateSummary(gated, reference)}`);
  console.log(`\nRaw results: ${outFile}`);
  return over ? 1 : 0;
}

// Ctrl-C and kill run the same cleanup as every other way out.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
    console.error(`${signal}: closing the browser sessions, servers and temp builds ...`);
    void cleanUp().then(() => process.exit(130));
  });
}

let code = 1;
try {
  code = await main();
} catch (e) {
  // An interrupted run fails on whatever call was in flight: that is not news.
  if (!interrupted) console.error(e instanceof Stop ? e.message : e);
} finally {
  await cleanUp();
}
process.exit(interrupted ? 130 : code);
