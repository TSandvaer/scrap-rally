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
//   npm run bench -- --judge tmp/bench/x.json  judge a raw results file again: nothing is measured
//
// Exit code: 0 the gate passes (or there was none to judge), 1 it fails (or the run itself
// failed), 2 no verdict (INVALID): the machine was too noisy to decide, or metric A was not
// measured at the gate's window size. Only one benchmark runs on the machine at a time: a
// second one waits for the first one's lock. A built directory
// is served by this script on 127.0.0.1 with cross-origin isolation, which gives the page a
// 5 us timer; a URL target has whatever its server allows (usually 100 us).

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

// The gate (PLAN-GFX.md, "Baseline"; user decisions 2026-11-18). Both builds are loaded one
// after the other in every run; a value's ratio is the median of the per-run ratios
// this build / baseline. Metric A's median and p95 are OVER above GATE_RATIO, at one window
// size (the canvas is 640x360 whatever the window; other sizes are information).
const GATE_RATIO = 1.05;
const GATE_RUNS = 5; // any other number of runs: numbers only, no verdict (the noise limit is for five)
const GATE_VIEWPORT = "1280x720";
const CTOR_ALLOWANCE_MS = 50; // PLAN-GFX section 4: construction at or below baseline + 50 ms
// Safeguard 1, a quiet machine. One benchmark at a time (the lock), and a set knows how noisy
// it was: the noise is the median over its cells of how far apart a cell's per-run ratios of
// the median lie (max - min). Quiet runs measured 0.044 to 0.045, runs beside other load 0.104
// to 0.235. At or below NOISE_LIMIT a set is quiet and a value is ok up to GATE_RATIO, OVER
// above it. A noisier set gives each value a margin, the larger of the set's noise and the
// value's own spread (max - min of its per-run ratios): ok at or below GATE_RATIO - margin,
// OVER above GATE_RATIO + margin, open in between. A verdict that the noise cannot change
// stands; anything open ends in INVALID.
const NOISE_LIMIT = 0.1;
const LOCK_FILE = path.join(os.tmpdir(), "scrap-rally-bench.lock");
// Safeguard 2, confirm-on-OVER: the cells holding metric A values OVER in the gate run (set 1)
// are measured once more (set 2: fresh runs in new browser sessions), with control cells so
// that set 2's noise rests on at least SET2_CELLS cells. The controls are never judged.
// FAIL: a value OVER in both sets. PASS: nothing open, and every value ok in set 1, or OVER
// there and ok in set 2. Anything else: INVALID. The sets are never pooled; there is no third.
const SET2_CELLS = 5;
//
// Test only: BENCH_TEST_SCALE_SET1="S1:rust-bowl:median:1.2" multiplies that value of this
// build by the factor (1 or more) in set 1 (median or p95), to see the confirmation run
// without a slow build: it can only add an OVER that the unscaled set 2 has to confirm. The
// output says so in capitals; a run with it is not a gate result.
const TEST_SCALE = process.env.BENCH_TEST_SCALE_SET1 ?? "";
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
  --runs <n>         runs per cell (default ${GATE_RUNS}; any other number gives numbers, no verdict)
  --viewports <l>    default 1280x720,390x844@3 (metric A is judged at ${GATE_VIEWPORT} only)
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
  --judge <file>     judge such a raw results file again with this runner's rules and print
                     it as a run would be: nothing is built, opened or measured
  --session <name>   agent-browser session prefix (default bench-<pid>). The sessions
                     <name>-base and <name>-this are closed on every way out.

One benchmark at a time: the runner takes a machine-wide lock (${path.basename(LOCK_FILE)} in the temp
directory) and waits, saying so, while another one holds it.

With a baseline the runs alternate between the two builds and the gate is judged:
- Metric A's median and p95, at ${GATE_VIEWPORT}, by the median of the per-run ratios
  this/baseline: ok up to ${GATE_RATIO}, OVER above. Other window sizes, p99, the frames over
  4 ms, G and C are information.
- Noise: how far apart a cell's per-run ratios lie, in the middle cell. In a set above
  ${NOISE_LIMIT} each value gets a margin (the larger of that noise and its own spread): ok at or
  below ${GATE_RATIO} - margin, OVER above ${GATE_RATIO} + margin, open in between.
- Confirmation: the cells holding OVER values are measured once more (${GATE_RUNS} fresh runs in new
  browser sessions, with control cells for the noise figure, at least ${SET2_CELLS} cells in all).
- FAIL: a value OVER both times. PASS: nothing open, every value ok, or OVER and then ok.
  INVALID, no verdict: anything else, or metric A not measured at ${GATE_VIEWPORT}; run it again
  when nothing else is running. A run cut down with --only or --metrics says "partial".
- Metric B's frames over 20 ms and the Renderer's construction are checked against the
  baseline too (once; under noise an OVER there gives INVALID).
Exit code 0 PASS, 1 FAIL (or the run failed), 2 INVALID.`;

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
  set: number; // 1 = the gate run, 2 = the confirmation of its OVER values
  target: string;
  run: number;
  viewport: string;
  metric: string; // A, G, B or C (G = the page's metric A on a GPU canvas)
  cell: Cell;
}

/** ok and OVER are decided; open means the set's noise leaves both possible. */
type Cls = "ok" | "OVER" | "open";

/** A value the gate judged. */
interface Gated {
  what: string; // "A median S4 crusher-run at 1280x720"
  kind: "ratio" | "dropped" | "construction";
  key: string; // the same value in another set: viewport, scene, track and statistic
  viewport: string;
  scene: string;
  track: string;
  ratio: number; // this / baseline (ratio); the plain values otherwise
  base: number;
  cand: number;
  spread: number; // max - min of the value's per-run ratios (ratio only)
  margin: number; // 0 in a quiet set; else the larger of the set's noise and the spread
  cls: Cls;
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

/** The pid and the directory in the lock file, or null when it cannot be read (gone, or being written). */
function lockHolder(file = LOCK_FILE): { pid: number; where: string } | null {
  try {
    const [pid, where] = readFileSync(file, "utf8").split("\n");
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), where: where ?? "" } : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // it exists, it is just not ours
  }
}

/**
 * Does that pid still run a benchmark? After a runner was killed its pid can come back as
 * some other process: a live pid whose command is not this script holds no lock.
 */
async function runnerAlive(pid: number): Promise<boolean> {
  if (!alive(pid)) return false;
  try {
    return /bench\.ts/.test((await run("ps", ["-o", "command=", "-p", String(pid)])).stdout);
  } catch (e) {
    // ps exits 1 for a pid that is gone meanwhile; any other trouble: leave a live process its lock.
    return (e as { code?: number }).code !== 1;
  }
}

/**
 * One benchmark on the machine at a time: two at once spoil each other's timing. The lock is
 * a file in the temp directory holding the pid. While a live runner holds it we wait and
 * say so; the lock of a process that is gone (or is something else by now) is taken over.
 */
async function acquireLock(): Promise<void> {
  let told = 0;
  for (;;) {
    try {
      writeFileSync(LOCK_FILE, `${process.pid}\n${ROOT}\n${new Date().toISOString()}\n`, { flag: "wx" });
      cleanups.push(() => {
        if (lockHolder()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
      });
      if (told) console.error("the other benchmark is done: starting");
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = lockHolder();
    const age = (() => {
      try {
        return Date.now() - statSync(LOCK_FILE).mtimeMs;
      } catch {
        return 0;
      }
    })();
    // Stale: its runner is gone, or nothing readable was ever written into it.
    if (holder ? !(await runnerAlive(holder.pid)) : age > 10_000) {
      // Moved aside in one step, so that of two waiters only one takes it; and looked at again
      // after the move, in case it was a fresh lock by then.
      const aside = `${LOCK_FILE}.${process.pid}.stale`;
      try {
        renameSync(LOCK_FILE, aside);
        const moved = lockHolder(aside);
        if (moved && (await runnerAlive(moved.pid)) && !existsSync(LOCK_FILE)) renameSync(aside, LOCK_FILE);
        else {
          rmSync(aside, { force: true });
          console.error(`took over the lock of a benchmark that is gone${holder ? ` (pid ${holder.pid})` : ""}`);
        }
      } catch {
        /* someone else was quicker: look again */
      }
      continue;
    }
    if (Date.now() - told > 60_000) {
      console.error(`another benchmark is running on this machine${holder ? ` (pid ${holder.pid}, ${holder.where})` : ""}: waiting for it to finish ...`);
      told = Date.now();
    }
    await sleep(2000);
  }
}

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

/** Start a browser for a session name. */
async function openSession(session: string): Promise<void> {
  await ab(session, ["--args", CHROME_ARGS, "open", "about:blank"]);
}

/** A build to measure: served if it is a directory, with a browser session of its own. */
async function target(label: string, spec: string, prefix: string): Promise<Target> {
  const url = /^https?:\/\//.test(spec) ? spec.replace(/\/+$/, "") : await serveDir(path.resolve(spec));
  const session = `${prefix}-${label}`;
  // Registered before it is opened: a launch that fails half-way is closed too.
  cleanups.push(() => closeSession(session));
  await openSession(session);
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

/** A value of one cell in both builds, run by run (only the runs both have). `samples` are those of one set. */
function pairs<T extends Cell>(samples: Sample[], vp: string, metric: string, scene: string, track: string, f: (x: T) => number): { base: number[]; cand: number[] } {
  const of = (t: string) =>
    new Map(samples.filter((s) => s.target === t && s.viewport === vp && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => [s.run, f(s.cell as T)]));
  const b = of("base"), c = of("this");
  const runs = [...b.keys()].filter((r) => c.has(r)).sort((x, y) => x - y);
  return { base: runs.map((r) => b.get(r)!), cand: runs.map((r) => c.get(r)!) };
}

/**
 * How noisy a set was: for each metric A cell at the gate's window size, how far apart its
 * per-run ratios of the median lie (max - min); the median of that over the cells.
 */
function noiseOf(samples: Sample[]): { noise: number; cells: number } | null {
  const spreads: number[] = [];
  for (const scene of SCENES) {
    for (const track of TRACKS) {
      const p = pairs<CellA>(samples, GATE_VIEWPORT, "A", scene, track, (x) => x.p50);
      if (p.base.length < 2) continue;
      const ratios = p.base.map((b, i) => p.cand[i] / b);
      spreads.push(Math.max(...ratios) - Math.min(...ratios));
    }
  }
  return spreads.length ? { noise: median(spreads), cells: spreads.length } : null;
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

/** ok, OVER or open for a ratio, by the noise of the set it was measured in (null: none measured, judged as quiet). */
function classify(ratio: number, spread: number, noise: number | null): { cls: Cls; margin: number } {
  const margin = noise !== null && noise > NOISE_LIMIT ? Math.max(noise, spread) : 0;
  return { cls: ratio <= GATE_RATIO - margin ? "ok" : ratio > GATE_RATIO + margin ? "OVER" : "open", margin };
}

/**
 * This build against the baseline, for the samples of one set. Each value is the median of
 * the runs; a ratio is the median of the per-run ratios this / baseline. With `judge` the
 * values the gate judges are classified by the set's `noise`, collected in `gated`, and
 * followed in the table by what `mark` says (ok, OVER, open ...). Metric A is judged at
 * GATE_VIEWPORT only. `note` adds a word to a cell's row (set 2's controls).
 */
function tablesVersus(
  samples: Sample[], vps: Viewport[], metrics: string[], judge: boolean, noise: number | null, gated: Gated[],
  mark: (g: Gated) => string, withConstruction: boolean, note: (scene: string, track: string) => string = () => "",
): string {
  const out: string[] = [];
  const noisy = noise !== null && noise > NOISE_LIMIT;
  const add = (g: Gated): string => {
    if (!judge) return "";
    gated.push(g);
    return mark(g);
  };
  const cols = (name: string) => [`${name} base`, "this", "ratio"];
  const pair = (name: string) => [`${name} base`, "this"];
  for (const vp of vps) {
    for (const metric of metrics) {
      const rows: string[][] = [];
      for (const scene of SCENES) {
        for (const track of TRACKS) {
          if (!pick<Cell>(samples, "base", vp.name, metric, scene, track).length) continue;
          const of = <T extends Cell>(f: (x: T) => number) => pairs<T>(samples, vp.name, metric, scene, track, f);
          /** base, this, ratio; `stat` names the value when it is one the gate judges. */
          const timed = <T extends Cell>(f: (x: T) => number, stat: string | null): string[] => {
            const p = of<T>(f);
            const perRun = p.base.map((b, i) => p.cand[i] / b);
            const ratio = median(perRun);
            const shown = [ms(median(p.base)), ms(median(p.cand))];
            if (!stat) return [...shown, ratio.toFixed(3)];
            const spread = Math.max(...perRun) - Math.min(...perRun);
            const g: Gated = {
              what: `${metric} ${stat} ${scene} ${track} at ${vp.name}`, kind: "ratio", key: `${vp.name}|${scene}|${track}|${stat}`, viewport: vp.name, scene, track,
              ratio, base: median(p.base), cand: median(p.cand), spread, ...classify(ratio, spread, noise),
            };
            return [...shown, `${ratio.toFixed(3)}${add(g)}`];
          };
          const plain = <T extends Cell>(f: (x: T) => number, fmt: (x: number) => string): string[] => {
            const p = of<T>(f);
            return [fmt(median(p.base)), fmt(median(p.cand))];
          };
          if (metric === "A" || metric === "G") {
            const sums = new Set(samples.filter((s) => s.viewport === vp.name && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => (s.cell as CellA).checksum));
            const gate = metric === "A" && vp.name === GATE_VIEWPORT; // G, and A at any other window size, are read, not judged
            rows.push([
              scene, `${track}${note(scene, track)}`,
              ...timed<CellA>((x) => x.p50, gate ? "median" : null), ...timed<CellA>((x) => x.p95, gate ? "p95" : null), ...timed<CellA>((x) => x.p99, null), ...plain<CellA>((x) => x.over, int),
              sums.size === 1 ? [...sums][0] : `**${sums.size} differ**`,
            ]);
          } else if (metric === "B") {
            // Dropped frames: at or below the baseline's (PLAN-GFX section 4). In headless Chrome that is 0.
            // Under noise an OVER is not believed (open), and an ok only when this build dropped none.
            const d = of<CellB>((x) => x.over20);
            const base = median(d.base), cand = median(d.cand);
            const cls: Cls = cand > base ? (noisy ? "open" : "OVER") : noisy && cand > 0 ? "open" : "ok";
            const g: Gated = { what: `B frames over 20 ms ${scene} ${track} at ${vp.name}`, kind: "dropped", key: `${vp.name}|${scene}|${track}|over20`, viewport: vp.name, scene, track, ratio: 0, base, cand, spread: 0, margin: 0, cls };
            rows.push([scene, track, ...plain<CellB>((x) => x.p50, ms), ...plain<CellB>((x) => x.p95, ms), int(g.base), `${int(g.cand)}${add(g)}`, ...plain<CellB>((x) => x.jsP50, ms)]);
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
      const info = metric === "A" && vp.name !== GATE_VIEWPORT ? `; information, the gate reads ${GATE_VIEWPORT}` : "";
      out.push(`**${TITLES[metric]} at ${vp.name}${info}**\n\n${table(head[metric === "G" ? "A" : metric], rows)}`);
    }
    if (!withConstruction) continue;
    // Construction and the first frame of a cold page, from the metric A cells. Under noise an OVER is not believed.
    const rows = TRACKS.flatMap((track) => {
      const of = (t: string) => samples.filter((s) => s.target === t && s.viewport === vp.name && s.metric === "A" && s.cell.track === track).map((s) => s.cell as CellA);
      const b = of("base"), c = of("this");
      if (!b.length || !c.length) return [];
      const ctor = { base: median(b.map((x) => x.ctorMs)), cand: median(c.map((x) => x.ctorMs)) };
      const cls: Cls = ctor.cand > ctor.base + CTOR_ALLOWANCE_MS ? (noisy ? "open" : "OVER") : "ok";
      const g: Gated = { what: `construction ${track} at ${vp.name}`, kind: "construction", key: `${vp.name}|${track}|ctor`, viewport: vp.name, scene: "", track, ratio: 0, ...ctor, spread: 0, margin: 0, cls };
      return [[track, String(b.length), ms(ctor.base), `${ms(ctor.cand)}${add(g)}`, ms(median(b.map((x) => x.firstMs))), ms(median(c.map((x) => x.firstMs)))]];
    });
    if (rows.length) out.push(`**Renderer construction and first frame on a cold page at ${vp.name} (ms, medians)**\n\n${table(["Track", "page loads each", "new Renderer() base", "this", "first frame base", "this"], rows)}`);
  }
  return out.join("\n\n");
}

type Verdict = "PASS" | "FAIL" | "INVALID";
type Noise = { noise: number; cells: number } | null;

interface Decision {
  verdict: Verdict;
  over1: Gated[]; // metric A values OVER in set 1
  confirmed: Gated[]; // ... and OVER in set 2 too
  failed: Gated[]; // what a FAIL rests on: the confirmed, and metric B or construction OVER in a quiet set 1
  undecided: string[]; // what an INVALID rests on
  undecidedInSet2: number; // how many of those are values open in set 2 (the last of the list)
  partial: string; // "" when the whole gate was judged; else what was cut
}

/**
 * The verdict. FAIL: a value OVER in set 1 and OVER in set 2 (or metric B or construction OVER
 * in a quiet set 1). PASS: nothing open, and every metric A value ok in set 1, or OVER there
 * and ok in set 2. INVALID: anything else, and any run that judged no metric A value.
 */
function decide(gated1: Gated[], gated2: Gated[] | null): Decision {
  const a1 = gated1.filter((g) => g.kind === "ratio");
  const once = gated1.filter((g) => g.kind !== "ratio"); // metric B and construction: judged in set 1 only
  const over1 = a1.filter((g) => g.cls === "OVER");
  const second = (g: Gated) => gated2?.find((x) => x.key === g.key) ?? null;
  const confirmed = over1.filter((g) => second(g)?.cls === "OVER");
  const failed = [...confirmed, ...once.filter((g) => g.cls === "OVER")];
  const undecided: string[] = [];
  if (!a1.length) undecided.push(`metric A was not judged: the gate reads it at ${GATE_VIEWPORT}, with a baseline`);
  for (const g of a1) if (g.cls === "open") undecided.push(`${g.what}: ${g.ratio.toFixed(3)} is open in set 1 (margin ${g.margin.toFixed(3)})`);
  for (const g of over1) if (!second(g)) undecided.push(`${g.what}: OVER in set 1 (${g.ratio.toFixed(3)}) and not measured in a set 2`);
  for (const g of once) if (g.cls === "open") undecided.push(`${g.what}: ${ms(g.base)} -> ${ms(g.cand)} cannot be judged in a noisy set`);
  const before = undecided.length;
  for (const g of over1) {
    const again = second(g);
    if (again?.cls === "open") undecided.push(`${g.what}: OVER in set 1 (${g.ratio.toFixed(3)}), open in set 2 (${again.ratio.toFixed(3)}, margin ${again.margin.toFixed(3)})`);
  }
  // What the whole gate judges: every metric A cell's median and p95, and metric B's lap on the three tracks.
  const cut: string[] = [];
  const all = SCENES.length * TRACKS.length * 2;
  if (a1.length < all) cut.push(`${a1.length} of the gate's ${all} metric A values`);
  if (!TRACKS.every((track) => once.some((g) => g.kind === "dropped" && g.viewport === GATE_VIEWPORT && g.scene === "S4" && g.track === track))) cut.push("without metric B's lap on all three tracks");
  const verdict: Verdict = !a1.length ? "INVALID" : failed.length ? "FAIL" : undecided.length ? "INVALID" : "PASS";
  return { verdict, over1, confirmed, failed, undecided, undecidedInSet2: undecided.length - before, partial: cut.join(", ") };
}

/** What the gate found, in words. */
function gateSummary(o: { d: Decision; reference: string; gated1: Gated[]; gated2: Gated[] | null; noise1: Noise; noise2: Noise; controls: string[]; notes: string[] }): string {
  const { d } = o;
  const ratios = o.gated1.filter((g) => g.kind === "ratio");
  const dropped = o.gated1.filter((g) => g.kind === "dropped");
  const built = o.gated1.filter((g) => g.kind === "construction");
  const count = (gs: Gated[]) => (["ok", "OVER", "open"] as const).map((c) => `${gs.filter((g) => g.cls === c).length} ${c}`).join(", ");
  const partial = d.partial ? ` (partial: ${d.partial}; not the whole gate)` : "";
  const title =
    d.verdict === "INVALID"
      ? `INVALID, no verdict${ratios.length ? ": too noisy to decide. Run it again when nothing else is running" : `: metric A was not judged at ${GATE_VIEWPORT}`}${partial}`
      : d.verdict === "FAIL"
        ? `FAIL, ${d.failed.length} value(s) OVER${partial}`
        : `PASS${partial}`;
  const lines = [`**Gate: ${title}**`, "", ...o.notes.map((n) => `- ${n}`), `- ${o.reference}`];
  const noiseLine = (n: { noise: number; cells: number }, set: number) =>
    `Noise of set ${set}: ${n.noise.toFixed(3)} over ${n.cells} cell(s), ${
      n.noise > NOISE_LIMIT
        ? `**noisy** (above ${NOISE_LIMIT}): each value has a margin, the larger of this and its own spread; ok at or below ${GATE_RATIO} - margin, OVER above ${GATE_RATIO} + margin, open in between`
        : `quiet (at or below ${NOISE_LIMIT}): ok up to ${GATE_RATIO}, OVER above`
    }.`;
  const shown = (g: Gated) => `${g.ratio.toFixed(3)} ${g.cls}${g.margin ? ` (margin ${g.margin.toFixed(3)})` : ""}`;
  if (o.noise1) lines.push(`- ${noiseLine(o.noise1, 1)}`);
  if (ratios.length) {
    const rs = ratios.map((g) => g.ratio);
    const worst = ratios.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    lines.push(`- Metric A at ${GATE_VIEWPORT}, median and p95, set 1: ${ratios.length} ratios from ${Math.min(...rs).toFixed(3)} to ${Math.max(...rs).toFixed(3)}: ${count(ratios)}. Largest: ${worst.what}.`);
  } else lines.push(`- Metric A: not judged (the gate reads it at ${GATE_VIEWPORT}, which this run did not measure).`);
  if (o.gated2) {
    const cells = new Set(d.over1.map((g) => `${g.scene} ${g.track}`)).size;
    lines.push(`- Set 2: the ${cells} cell(s) holding the OVER values${o.controls.length ? ` and ${o.controls.length} control cell(s) for the noise figure only (${o.controls.join(", ")})` : ""}, ${GATE_RUNS} fresh runs in new browser sessions. The sets are not pooled.`);
    if (o.noise2) lines.push(`  - ${noiseLine(o.noise2, 2)}`);
    for (const g of d.over1) {
      const again = o.gated2.find((x) => x.key === g.key);
      lines.push(`  - ${g.what}: set 1 ${shown(g)}, set 2 ${again ? shown(again) : "not measured"}: ${again?.cls === "OVER" ? "**CONFIRMED**" : again?.cls === "ok" ? "not confirmed" : "undecided"}`);
    }
    for (const g of o.gated2.filter((x) => x.cls === "OVER" && !d.over1.some((y) => y.key === x.key))) lines.push(`  - ${g.what}: set 2 ${shown(g)}, OVER for the first time in set 2: does not count`);
  }
  if (dropped.length) lines.push(`- Metric B, frames over 20 ms (OVER above the baseline's): ${dropped.length} cells: ${count(dropped)}.`);
  if (built.length) lines.push(`- Construction (OVER above baseline + ${CTOR_ALLOWANCE_MS} ms): ${built.length} checked: ${count(built)}.`);
  for (const g of d.failed.filter((x) => x.kind !== "ratio")) lines.push(`- OVER: ${g.what}: ${ms(g.base)} -> ${ms(g.cand)}`);
  if (d.verdict === "INVALID" && d.undecided.length) {
    // The values open in set 2 are in the set 2 lines above already.
    const rest = d.undecided.slice(0, d.undecided.length - d.undecidedInSet2);
    lines.push(`- Undecided, which is why there is no verdict: ${d.undecided.length} value(s)${d.undecidedInSet2 ? `, ${d.undecidedInSet2} of them open in set 2 (above)` : ""}${rest.length ? ":" : "."}`);
    for (const u of rest.slice(0, 12)) lines.push(`  - ${u}`);
    if (rest.length > 12) lines.push(`  - ... and ${rest.length - 12} more`);
  }
  return lines.join("\n");
}

/** What a run (or a raw results file read back) is judged with. */
interface Judging {
  vps: Viewport[];
  metrics: string[];
  runs: number;
  reference: string;
  notes: string[]; // lines for the top of the gate block (test injection, replay)
}

/** Set 1's tables, noise and gated values. */
function readSet1(samples: Sample[], j: Judging, compare: boolean, judge: boolean): { tables: string; gated1: Gated[]; noise1: Noise } {
  const set1 = samples.filter((s) => s.set === 1);
  const noise1 = judge ? noiseOf(set1) : null;
  const gated1: Gated[] = [];
  const mark = (g: Gated) => (g.cls === "ok" ? " ok" : g.cls === "OVER" ? " **OVER**" : " open");
  const tables = compare ? tablesVersus(set1, j.vps, j.metrics, judge, noise1?.noise ?? null, gated1, mark, true) : tablesAlone(set1, j.vps, j.metrics);
  return { tables, gated1, noise1 };
}

/** Set 2's tables, noise and gated values. Only the values that were OVER in set 1 are judged; the controls not at all. */
function readSet2(samples: Sample[], j: Judging, over1: Gated[]): { tables: string; gated2: Gated[]; noise2: Noise; controls: string[] } {
  const set2 = samples.filter((s) => s.set === 2);
  const noise2 = noiseOf(set2);
  const held = new Set(over1.map((g) => `${g.scene}|${g.track}`));
  const controls = [...new Set(set2.filter((s) => s.metric === "A").map((s) => `${s.cell.scene}|${s.cell.track}`))].filter((c) => !held.has(c));
  const all: Gated[] = [];
  const mark = (g: Gated) =>
    !held.has(`${g.scene}|${g.track}`) ? "" : over1.some((x) => x.key === g.key) ? (g.cls === "OVER" ? " **OVER again**" : ` ${g.cls}`) : g.cls === "OVER" ? " (first time: not counted)" : "";
  const sizes = j.vps.filter((v) => v.name === GATE_VIEWPORT);
  const tables = tablesVersus(set2, sizes, ["A"], true, noise2?.noise ?? null, all, mark, false, (scene, track) => (held.has(`${scene}|${track}`) ? "" : " (control)"));
  return { tables, gated2: all.filter((g) => held.has(`${g.scene}|${g.track}`)), noise2, controls: controls.map((c) => c.replace("|", " ")) };
}

// ---- main -------------------------------------------------------------------------

/** Print a judged run and return its exit code. */
function report(o: {
  samples: Sample[]; j: Judging; compare: boolean; judge: boolean; set1: ReturnType<typeof readSet1>; set2: ReturnType<typeof readSet2> | null;
  head: string[]; outFile: string | null; meta: Record<string, unknown>;
}): number {
  const { j, set1, set2 } = o;
  const d = o.judge ? decide(set1.gated1, set2?.gated2 ?? null) : null;
  if (o.outFile) {
    mkdirSync(path.dirname(o.outFile), { recursive: true });
    const gate = d
      ? {
          verdict: d.verdict, partial: d.partial || null, ratio: GATE_RATIO, viewport: GATE_VIEWPORT, noiseLimit: NOISE_LIMIT, noise: [set1.noise1?.noise ?? null, set2?.noise2?.noise ?? null],
          set1: set1.gated1, set2: set2?.gated2 ?? null, controls: set2?.controls ?? [], confirmed: d.confirmed.map((g) => g.key), undecided: d.undecided,
        }
      : null;
    writeFileSync(o.outFile, JSON.stringify({ meta: { ...o.meta, gate }, samples: o.samples }, null, 1));
  }
  for (const line of o.head) console.log(line);
  console.log(
    o.compare
      ? `Each value is the median of the runs; a ratio is the median of the per-run ratios this build / baseline (the two are loaded one right after the other in every run). Judged: metric A's median and p95 at ${GATE_VIEWPORT}, ok up to ${GATE_RATIO} and OVER above (with a margin in a noisy set). Other window sizes, p99, the frames over 4 ms, G and C are information.\n`
      : "Median of the runs, ± = their spread (max - min). No verdict: the gate needs a baseline (--vs-ref gfx-baseline).\n",
  );
  if (o.compare && !o.judge) console.log(`${j.runs} run(s): no verdict. The gate is defined on ${GATE_RUNS} runs.\n`);
  console.log(set1.tables);
  if (set2) console.log(`\n**Set 2: the cells with a value OVER in set 1, and the controls, measured in new browser sessions**\n\n${set2.tables}`);
  if (d) console.log(`\n${gateSummary({ d, reference: j.reference, gated1: set1.gated1, gated2: set2?.gated2 ?? null, noise1: set1.noise1, noise2: set2?.noise2 ?? null, controls: set2?.controls ?? [], notes: j.notes })}`);
  if (o.outFile) console.log(`\nRaw results: ${o.outFile}`);
  return d?.verdict === "FAIL" ? 1 : d?.verdict === "INVALID" ? 2 : 0;
}

function viewportOf(v: string): Viewport {
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(v.trim());
  if (!m) fail(`bad viewport ${v}`);
  return { name: v.trim(), w: Number(m[1]), h: Number(m[2]), scale: Number(m[3] ?? 1) };
}

/** Judge a raw results file again, by this runner's rules: nothing is measured. */
function rejudge(file: string): number {
  if (!existsSync(file)) fail(`no such file: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { meta?: Record<string, unknown>; samples: Sample[] };
  const samples = raw.samples.map((s) => ({ ...s, set: s.set ?? 1 })); // files from before the sets: all set 1
  const meta = raw.meta ?? {};
  const compare = samples.some((s) => s.target === "this");
  const runs = Number(meta.runs ?? Math.max(...samples.map((s) => s.run)));
  const injection = (meta.testInjection ?? (meta.gate as { testInjection?: string } | null | undefined)?.testInjection ?? "") as string;
  const j: Judging = {
    vps: [...new Set(samples.map((s) => s.viewport))].map(viewportOf),
    metrics: METRICS.filter((m) => samples.some((s) => s.metric === m)),
    runs,
    reference: `Reference, as recorded: ${meta.vs ?? "?"}${meta.vsSha ? ` (${String(meta.vsSha).slice(0, 12)})` : ""}${meta.fixedReference ? ", the fixed reference" : ""}.`,
    notes: [`JUDGED AGAIN from ${file}: nothing was measured.${injection ? ` The file holds a test injection: ${injection}` : ""}`],
  };
  const judge = compare && runs === GATE_RUNS;
  const set1 = readSet1(samples, j, compare, judge);
  const set2 = judge && samples.some((s) => s.set === 2) ? readSet2(samples, j, set1.gated1.filter((g) => g.kind === "ratio" && g.cls === "OVER")) : null;
  return report({ samples, j, compare, judge, set1, set2, head: [`Render benchmark, judged again: ${runs} run(s) per cell.`], outFile: null, meta });
}

/** The run; the exit code. */
async function main(): Promise<number> {
  if (flag("help") || flag("h")) {
    console.log(HELP);
    return 0;
  }
  if (arg("judge") !== null) return rejudge(path.resolve(arg("judge")!));
  // Everything that can be wrong with the command line is found before anything is opened.
  const quick = flag("quick");
  const runs = Number(arg("runs") ?? (quick ? 1 : GATE_RUNS));
  if (!Number.isInteger(runs) || runs < 1) fail(`bad --runs ${arg("runs")}`);
  const vps: Viewport[] = (arg("viewports") ?? (quick ? "1280x720" : "1280x720,390x844@3")).split(",").map(viewportOf);
  const metrics = (arg("metrics") ?? (quick ? "A" : "A,G,B,C")).toUpperCase().split(",");
  for (const m of metrics) if (!METRICS.includes(m)) fail(`unknown metric ${m}: use ${METRICS.join(", ")}`);
  const only = (arg("only") ?? "").split(",").filter(Boolean).map((o) => o.split(":"));
  const wanted = (scene: string, track: string) => !only.length || only.some(([s, t]) => s.toUpperCase() === scene && (!t || t === track));
  const bScene = (arg("b-scene") ?? "S4").toUpperCase();
  const panel = arg("panel") ?? "";
  const prefix = arg("session") ?? `bench-${process.pid}`;
  const valued = new Set(["vs", "vs-ref", "runs", "viewports", "metrics", "only", "b-scene", "panel", "out", "session", "scenes", "judge"]);
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && valued.has(all[i - 1].slice(2))));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.resolve(arg("out") ?? path.join(ROOT, "tmp", "bench", `${stamp}.json`));
  if (arg("vs") && arg("vs-ref")) fail("give --vs or --vs-ref, not both");
  // The test injection: scene, track, statistic, factor. The factor is 1 or more: it can add
  // an OVER to set 1, which the unscaled set 2 then has to confirm; it can never hide one.
  const scale = TEST_SCALE ? TEST_SCALE.split(":") : null;
  if (scale && !(scale.length === 4 && SCENES.includes(scale[0]) && TRACKS.includes(scale[1]) && ["median", "p95"].includes(scale[2]) && Number(scale[3]) >= 1)) {
    fail(`bad BENCH_TEST_SCALE_SET1 "${TEST_SCALE}": use <scene>:<track>:<median|p95>:<factor of 1 or more>, e.g. S1:rust-bowl:median:1.2`);
  }

  // Every cell of a run, as [metric, page query, time to leave a paced run alone].
  interface Job { metric: string; scene: string; track: string; query: Record<string, string>; settle: number }
  const cells: Job[] = [];
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
  // From here on the machine is ours alone: builds and browsers load it too.
  await acquireLock();
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
  const seen: { env: BenchOut["env"] | null } = { env: null }; // the first page's report of its browser and timer
  /** One set: every job at every given window size, `runs` times, the two builds in pairs. */
  const measure = async (set: number, sizes: Viewport[], jobs: Job[]): Promise<void> => {
    const total = runs * sizes.length * jobs.length * targets.length;
    let done = 0;
    const started = Date.now();
    for (let r = 0; r < runs; r++) {
      for (const vp of sizes) {
        for (const t of targets) {
          await ab(t.session, ["set", "viewport", String(vp.w), String(vp.h), String(vp.scale)]);
          // One short load that is thrown away: the first page after a (re)sized window is colder.
          await load(t, { metric: "A", scene: "S1", track: TRACKS[0], frames: "30", warm: "0" }, 0);
        }
        for (const [k, c] of jobs.entries()) {
          if (c.metric === "C" && vp !== sizes[0]) continue; // the heap does not depend on the viewport
          // The two builds one right after the other (the pair the ratio is taken from),
          // alternating which goes first so neither always runs on the warmer machine.
          const order = (r + k) % 2 ? [...targets].reverse() : targets;
          const line: string[] = [];
          for (const t of order) {
            const out = await load(t, c.query, c.settle);
            seen.env ??= out.env;
            for (const cell of out.cells) samples.push({ set, target: t.label, run: r + 1, viewport: vp.name, metric: c.metric, cell });
            const cell = out.cells[0];
            line.push(`${t.label} ${cell.metric === "C" ? `${cell.allocBytes} B` : `p50 ${ms(cell.p50)} p95 ${ms(cell.p95)}`}`);
            done++;
          }
          const eta = ((Date.now() - started) / done) * (total - done);
          console.error(`${set > 1 ? `set ${set} ` : ""}run ${r + 1}/${runs}  ${vp.name.padEnd(10)} ${c.metric} ${c.scene} ${c.track.padEnd(14)} ${line.join("   ")}   (${Math.round(eta / 1000)} s left)`);
        }
      }
    }
  };

  // Set 1: the gate run.
  await measure(1, vps, cells);
  const compare = targets.length > 1;
  const judge = compare && runs === GATE_RUNS;
  const notes: string[] = [];
  if (scale && compare) {
    const [scene, track, stat, factor] = scale;
    for (const s of samples) {
      if (s.set !== 1 || s.target !== "this" || s.metric !== "A" || s.viewport !== GATE_VIEWPORT || s.cell.scene !== scene || s.cell.track !== track) continue;
      const cell = s.cell as CellA;
      if (stat === "median") cell.p50 *= Number(factor);
      else cell.p95 *= Number(factor);
    }
    notes.push(`TEST INJECTION, NOT A GATE RESULT: set 1's ${stat} of ${scene} ${track} (this build, at ${GATE_VIEWPORT}) was multiplied by ${factor} through BENCH_TEST_SCALE_SET1.`);
    console.error(notes[0]);
  }
  // Against the fixed reference the ratios are a total: every ticket merged since GFX-0 is in them.
  const fixed = baseSha !== null && baseSha === fixedSha;
  const baseName = vsRef ? `${vsRef} (${baseSha!.slice(0, 12)})` : (arg("vs") ?? "");
  const j: Judging = {
    vps, metrics, runs, notes,
    reference: fixed
      ? `Reference: ${baseName}, the fixed reference. The ratios are the total since GFX-0, not this ticket's share, so slowdowns cannot add up from ticket to ticket.`
      : `Reference: ${baseName}. NOT the gate: this is not the fixed reference, so it shows one step only. The gate is \`npm run bench -- --vs-ref ${BASELINE_NAME}\`.`,
  };
  const set1 = readSet1(samples, j, compare, judge);

  // Set 2: the cells holding values that are OVER in set 1 (quiet or noisy), once more, in new
  // browser sessions; and control cells, the first of the run's order not among those, so that
  // set 2's noise rests on at least SET2_CELLS cells. The controls are never judged.
  const over1 = set1.gated1.filter((g) => g.kind === "ratio" && g.cls === "OVER");
  let set2: ReturnType<typeof readSet2> | null = null;
  if (judge && over1.length) {
    const jobsA = cells.filter((c) => c.metric === "A");
    const again = jobsA.filter((c) => over1.some((g) => g.scene === c.scene && g.track === c.track));
    const controls = jobsA.filter((c) => !again.includes(c)).slice(0, Math.max(0, SET2_CELLS - again.length));
    console.error(`${over1.length} value(s) OVER in set 1: measuring ${again.length} cell(s) again, with ${controls.length} control cell(s), in new browser sessions (set 2) ...`);
    for (const t of targets) {
      await closeSession(t.session);
      await openSession(t.session);
    }
    // In the run's order, the controls among the others.
    await measure(2, vps.filter((v) => v.name === GATE_VIEWPORT), jobsA.filter((c) => again.includes(c) || controls.includes(c)));
    set2 = readSet2(samples, j, over1);
  }

  const meta = {
    date: new Date().toISOString(), cpu: os.cpus()[0]?.model ?? "", cores: os.cpus().length, os: `${os.type()} ${os.release()}`, node: process.version,
    runs, env: seen.env, targets: targets.map((t) => t.label), target: positional[0] ?? "working tree (built by the runner)", vs: vsRef ?? arg("vs"), vsSha: baseSha, fixedReference: fixed,
    testInjection: notes[0] ?? null,
  };
  const head = [
    `Render benchmark, ${meta.date.slice(0, 10)}: ${runs} run(s) per cell, ${meta.cpu}, ${seen.env?.ua.match(/(Headless)?Chrome\/[\d.]+/)?.[0] ?? "?"}, timer ${((seen.env?.timerMs ?? 0) * 1000).toFixed(0)} us.`,
    `Measured: ${meta.target}${compare ? `, against ${baseName}` : ""}.`,
  ];
  return report({ samples, j, compare, judge, set1, set2, head, outFile, meta });
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
