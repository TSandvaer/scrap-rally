// Bench scene S6 against S2 (M4-WORLD; PLAN-M4.md section 3, where S6 is called "S5"): does a
// frame of the Preview Yard test track with the road's furniture in view (six cars, the barrels,
// the press, the truck, pools, three lightning cells; client/bench.ts yardScene) cost no more
// than 1.10 times a frame of S2?
//
//   npx tsx tools/debug/world-bench.ts            five runs, metric A at 1280x720
//   npx tsx tools/debug/world-bench.ts --runs 3
//   npx tsx tools/debug/world-bench.ts --quick    one run: a look, no verdict
//   npx tsx tools/debug/world-bench.ts --theme <name>   S7's theme (default desert)
//   npx tsx tools/debug/world-bench.ts --yard <id>      S7 on a theme's own yard (dune-yard, block-yard, canopy-yard:
//                                                       TH-LOOK-2) instead of Preview Yard; with --theme its own theme
//   npx tsx tools/debug/world-bench.ts --session <name> the browser session's name (default world-bench-<pid>)
//   npx tsx tools/debug/world-bench.ts --units    the bake units per tile alone (no browser, no lock)
//
// The working tree is built here (as it is, into a temp directory) and served on 127.0.0.1,
// cross-origin isolated (a 5 us timer); one browser session (world-bench-<pid>), closed at the
// end. One cell a page load, as scripts/bench.ts loads them (?debug=1&bench=1&metric=A&scene=..):
// S2 on each shipped track and S6, one right after the other in every run, the order turned
// round from run to run. Metric A: every scripted frame once, each followed by a 1x1 read-back
// on a canvas in main memory (main-thread JS and CPU raster), after 300 warm-up frames.
// - Per run, the ratio of S6's median to each S2's median; a cell's ratio is the median of its
//   per-run ratios (the rule of the gate, PLAN-GFX.md "The gate").
// - The budget: S6 at or below 1.10 times S2. S2 is three cells; the verdict is given against
//   each, and the headline against the cheapest of them (the strictest reading).
// - As information (no budget is set for it): S4, the lap at 430 u/s, on Preview Yard beside
//   the three shipped tracks. A lap is where tiles are baked, so it shows what baking the
//   furniture costs a frame at its worst (the p95, the p99 and the frames over 4 ms).
//
// Bench scene S7 (TH-LOOK-1; PLAN-THEMES.md 2.4): S6's frames and then S4's lap, on Preview Yard
// in the desert (the benchmark's `&theme=` switch), and the same frames on the yard's own look
// (S7 scrapyard), one right after the other in every run.
// - The budget (coordinator's decision 2026-11-22): what S7 guards is that a theme adds no cost
//   to a frame, so the theme is held against the yard's own look on the SAME frames: S7 in the
//   theme at or below 1.05 times S7 scrapyard, on the mean of the frames and on the mean of their
//   faster half (the frames without a bake step in them), each the median of the per-run ratios.
// - Not against S2: a lap's median sits on a step of the 5 us timer in every theme (0.070 or
//   0.075 ms against S2's 0.065: 1.08 or 1.15), and so do the shipped tracks' own S4 laps on the
//   tree before themes (1.07 to 1.23 times their S2). Held against S2, S7 would measure the
//   timer, not the theme. Its ratios against S2 are printed as information, and for the record
//   S7's absolute numbers beside the S4 laps of the same run.
// - On a theme's own yard (--yard block-yard --theme city; TH-LOOK-2): S7's views are of that
//   yard's furniture (client/bench.ts themeYardScene) and the yard is drawn in its own theme,
//   its theme surface with it; the same frames on the scrapyard's look are that yard through the
//   benchmark's `&theme=scrapyard` (which has no colours for a theme surface and draws none).
// - What a theme's tiles cost to bake is worked out here in Node from the bake itself
//   (client/gfx/world.ts bakeTileIndices with its trace): the cost units of every tile the lap
//   crosses, per theme (a frame's share of the baking is counted in these units, so a dearer
//   tile takes more frames, not a longer one).
//
// Bench scene S8 (BR-BAKE; PLAN-BRANCH.md 3: a lap of the Branch Yard test track that takes every
// shortcut road) is not measured here but by tools/debug/branch-sheet.ts --bench, with S2 and the
// S4 laps beside it as here. Its rule, for the record beside S7's (coordinator's decision
// 2026-11-22): a shortcut is to add no cost to drawing a frame, so the frames without a bake
// step are held against the same frames without shortcuts (the mean of the faster half at or
// below 1.05 times), and the whole lap against the dearest shipped S4 lap of the same run (at or
// below 1.05 times, on the mean of the frames and on the mean of their faster half). Not against
// S2, for S7's reason (the timer's step). And not the mean of all the frames against the same
// frames without shortcuts, which S7 holds a theme to: a theme bakes the same road, a shortcut
// is a second one (1.19 times the bake units, 1.19 times the mean): more road to bake, not
// slower drawing.
//
// It takes the benchmark's machine-wide lock (scrap-rally-bench.lock in the temp directory), so
// it never runs beside `npm run bench`, and waits while a live benchmark holds it.
// Exit code 0 with S6 and S7 within their budgets, 1 with one over, 2 without a verdict (--quick, or fewer than 5 runs).

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const QUICK = args.includes("--quick");
const RUNS = QUICK ? 1 : option("--runs", 5);
const BUDGET = 1.1; // S6 against S2
const THEME_BUDGET = 1.05; // S7 in a theme against S7 on the yard's own look
const THEME = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : "desert";
const YARD = args.includes("--yard") ? args[args.indexOf("--yard") + 1] : "preview-yard"; // S7's track
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding,--enable-precise-memory-info";
const SESSION = args.includes("--session") ? args[args.indexOf("--session") + 1] : `world-bench-${process.pid}`;
const LOCK_FILE = path.join(os.tmpdir(), "scrap-rally-bench.lock");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };

const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
}

// ---- the benchmark's lock (as scripts/bench.ts takes it) ---------------------------------------

function lockHolder(file = LOCK_FILE): { pid: number; where: string } | null {
  try {
    const [pid, where] = readFileSync(file, "utf8").split("\n");
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), where: where ?? "" } : null;
  } catch {
    return null;
  }
}

/** Does that pid still run a benchmark (this tool's name ends in bench.ts too, so the runner sees it as one)? */
async function runnerAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return /bench\.ts/.test((await run("ps", ["-o", "command=", "-p", String(pid)])).stdout);
  } catch (e) {
    return (e as { code?: number }).code !== 1;
  }
}

async function acquireLock(): Promise<void> {
  let told = 0;
  for (;;) {
    try {
      writeFileSync(LOCK_FILE, `${process.pid}\n${ROOT}\n${new Date().toISOString()}\n`, { flag: "wx" });
      cleanups.push(() => {
        if (lockHolder()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = lockHolder();
    let age = 0;
    try {
      age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    } catch {
      /* gone meanwhile */
    }
    if (holder ? !(await runnerAlive(holder.pid)) : age > 10_000) {
      const aside = `${LOCK_FILE}.${process.pid}.stale`;
      try {
        renameSync(LOCK_FILE, aside);
        const moved = lockHolder(aside);
        if (moved && (await runnerAlive(moved.pid)) && !existsSync(LOCK_FILE)) renameSync(aside, LOCK_FILE);
        else rmSync(aside, { force: true });
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

// ---- the page ------------------------------------------------------------------------------------

function serve(dir: string): Promise<string> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = path.join(dir, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dir, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    createReadStream(file).pipe(res);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 120_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

interface CellA {
  scene: string;
  track: string;
  theme?: string;
  baked?: number;
  bakeUnits?: number;
  lowMean?: number;
  steps?: number[];
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over: number;
  ctorMs: number;
  firstMs: number;
  checksum: string;
}

async function load(url: string, scene: string, track: string, theme = ""): Promise<{ cell: CellA; isolated: boolean; ua: string }> {
  await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", bench: "1", metric: "A", scene, track, ...(theme ? { theme } : {}) })}`]);
  const deadline = Date.now() + 90_000;
  for (;;) {
    if ((await ab(["eval", "window.scrapBench && window.scrapBench.done ? 1 : 0"])) === "1") break;
    if (Date.now() > deadline) throw new Error(`the bench page did not finish (${scene} ${track})`);
    await sleep(250);
  }
  const out = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.scrapBench)"])) as string) as { error: string; cells: CellA[]; env: { isolated: boolean; ua: string } };
  if (out.error) throw new Error(`bench error: ${out.error}`);
  return { cell: out.cells[0], isolated: out.env.isolated, ua: out.env.ua };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<number> {
  await acquireLock();
  const dist = mkdtempSync(path.join(os.tmpdir(), "world-bench-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error("building the working tree ...");
  await run(VITE, ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const url = await serve(dist);
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  await ab(["set", "viewport", "1280", "720", "1"]);

  // The judged cells first (S2 on each shipped track, S6, S7 in the theme and on the yard's own
  // look), then the laps that are information.
  const cells: { scene: string; track: string; theme?: string }[] = [
    { scene: "S2", track: "rust-bowl" },
    { scene: "S2", track: "crusher-run" },
    { scene: "S2", track: "overpass-knot" },
    { scene: "S6", track: "preview-yard" },
    { scene: "S7", track: YARD, theme: THEME },
    { scene: "S7", track: YARD, theme: "scrapyard" },
    { scene: "S4", track: "rust-bowl" },
    { scene: "S4", track: "crusher-run" },
    { scene: "S4", track: "overpass-knot" },
    { scene: "S4", track: "preview-yard" },
  ];
  const JUDGED = 6, S6 = 3, S7 = 4, S7_YARD = 5;
  const name = (k: number) => `${cells[k].scene} ${cells[k].track}${cells[k].theme ? ` (${cells[k].theme})` : ""}`;
  const got: CellA[][] = cells.map(() => []);
  let isolated = true, ua = "";
  for (let r = 0; r < RUNS; r++) {
    const forward = cells.map((_, k) => k);
    const order = r % 2 ? [...forward.slice(0, JUDGED).reverse(), ...forward.slice(JUDGED).reverse()] : forward;
    for (const k of order) {
      const o = await load(url, cells[k].scene, cells[k].track, cells[k].theme);
      got[k].push(o.cell);
      isolated &&= o.isolated;
      ua = o.ua;
      console.error(`run ${r + 1}/${RUNS}  ${name(k).padEnd(28)} median ${o.cell.p50.toFixed(3)}  p95 ${o.cell.p95.toFixed(3)}  ${o.cell.checksum}`);
    }
  }
  const f = (x: number) => x.toFixed(3);
  console.log(`# S6 and S7 against S2 (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
  console.log(`Metric A at 1280x720 (CPU raster: every frame once, a 1x1 read-back after each, 300 warm-up frames), ${RUNS} run${RUNS > 1 ? "s" : ""}, one cell a page load, the order turned round from run to run. ms a frame.${isolated ? "" : " WARNING: the page was not cross-origin isolated (a 100 us timer)."}\n`);
  console.log("| cell | frames | median (of the runs' medians) | spread (max - min) | mean | p95 | p99 | frames over 4 ms | tiles baked while measured | new Renderer() | first frame, cold | checksums |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  cells.forEach((_, k) => {
    if (k === JUDGED) console.log("| *as information: the lap* | | | | | | | | | | | |");
    const p50 = got[k].map((x) => x.p50);
    console.log(`| ${name(k)} | ${got[k][0].n} | ${f(median(p50))} | ${f(Math.max(...p50) - Math.min(...p50))} | ${f(median(got[k].map((x) => x.mean)))} | ${f(median(got[k].map((x) => x.p95)))} | ${f(median(got[k].map((x) => x.p99)))} | ${median(got[k].map((x) => x.over))} | ${median(got[k].map((x) => x.baked ?? 0))} | ${f(median(got[k].map((x) => x.ctorMs)))} | ${f(median(got[k].map((x) => x.firstMs)))} | ${[...new Set(got[k].map((x) => x.checksum))].join(" ")} |`);
  });
  console.log("\nA median is a whole number of the timer's steps (5 us): a ratio of two of them moves in jumps of about 0.08 here. The mean of a cell's frames is finer and its ratio is given beside the median's, as information: S6 cuts between its three views at frames 200 and 400, and the views together need more tiles than the pool of 24 holds, so each cut bakes what the pool gave away at once (the frame over 4 ms); S2 never moves its camera.\n");
  // A scene against each S2: the ratio of the medians run by run, and the worst of the three
  // median ratios. S6 is judged by it; for S7 it is information (see the top of the file).
  const against = (scene: number, judged: boolean): number => {
    console.log(`| ${name(scene)} against | ratio of the medians, run by run | median ratio | ${judged ? "budget 1.10" : "against 1.10 (information: no budget)"} | ratio of the means, run by run | median |`);
    console.log("|---|---|---:|---|---|---:|");
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const ratios = got[scene].map((x, r) => x.p50 / got[k][r].p50), means = got[scene].map((x, r) => x.mean / got[k][r].mean);
      const m = median(ratios);
      worst = Math.max(worst, m);
      console.log(`| S2 ${cells[k].track} | ${ratios.map(f).join(" ")} | ${f(m)} | ${m <= BUDGET ? (judged ? "within" : "under") : judged ? "OVER" : "over"} | ${means.map(f).join(" ")} | ${f(median(means))} |`);
    }
    console.log("");
    return worst;
  };
  const worst6 = against(S6, true), worst7 = against(S7, false), worstYard = against(S7_YARD, false);
  // S7's budget: the theme against the yard's own look on the same frames, run by run, on the
  // mean of the frames and on the mean of their faster half; the median of the per-run ratios of each.
  const low = (k: number) => got[k].map((x) => x.lowMean ?? NaN);
  const ownMean = got[S7].map((x, r) => x.mean / got[S7_YARD][r].mean), ownLow = low(S7).map((v, r) => v / low(S7_YARD)[r]);
  const own = got[S7].map((x, r) => x.p50 / got[S7_YARD][r].p50), ownP95 = got[S7].map((x, r) => x.p95 / got[S7_YARD][r].p95);
  const themeMean = median(ownMean), themeLow = median(ownLow);
  console.log(`| S7 in the ${THEME} against S7 on the yard's own look (the same frames) | run by run | median ratio | budget ${THEME_BUDGET.toFixed(2)} |`);
  console.log("|---|---|---:|---|");
  console.log(`| the mean of the frames | ${ownMean.map(f).join(" ")} | ${f(themeMean)} | ${themeMean <= THEME_BUDGET ? "within" : "OVER"} |`);
  console.log(`| the mean of their faster half | ${ownLow.map(f).join(" ")} | ${f(themeLow)} | ${themeLow <= THEME_BUDGET ? "within" : "OVER"} |`);
  console.log(`| the median (information: whole timer steps) | ${own.map(f).join(" ")} | ${f(median(own))} | |`);
  console.log(`| the p95 (information) | ${ownP95.map(f).join(" ")} | ${f(median(ownP95))} | |`);
  console.log("");
  // For the record only: S7's absolute numbers beside the laps of the same run.
  console.log("For the record (no budget): S7 beside the S4 laps of this run, ms a frame, the median of the runs.\n");
  console.log("| cell | frames | median | the faster half's mean | mean | p95 | p99 |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const k of [S7, S7_YARD, ...cells.map((_, i) => i).slice(JUDGED)]) console.log(`| ${name(k)} | ${got[k][0].n} | ${f(median(got[k].map((x) => x.p50)))} | ${median(low(k)).toFixed(4)} | ${f(median(got[k].map((x) => x.mean)))} | ${f(median(got[k].map((x) => x.p95)))} | ${f(median(got[k].map((x) => x.p99)))} |`);
  console.log("");
  // Finer than the median, which is a whole number of timer steps: the mean of each cell's faster
  // half (frames without a bake step in them), and where the frames of the two S7 cells fall, step by step.
  console.log("| cell | the faster half of its frames, mean, run by run | median |");
  console.log("|---|---|---:|");
  for (let k = 0; k < JUDGED; k++) console.log(`| ${name(k)} | ${low(k).map((v) => v.toFixed(4)).join(" ")} | ${median(low(k)).toFixed(4)} |`);
  console.log("");
  const hist = (k: number): number[] => {
    const sum = new Array<number>(41).fill(0);
    for (const x of got[k]) (x.steps ?? []).forEach((n, i) => (sum[i] += n));
    return sum;
  };
  const hT = hist(S7), hY = hist(S7_YARD);
  console.log(`Frames by the time they took, all ${RUNS} runs together (a column a timer step of 5 us; the median falls where half the frames are reached):\n`);
  console.log(`| ms | ${[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((i) => (i * 0.005).toFixed(3)).join(" | ")} | slower than 0.100 |`);
  console.log(`|---|${new Array(12).fill("---:").join("|")}|`);
  for (const [label, h] of [[`S7 ${THEME}`, hT], ["S7 scrapyard", hY]] as const) console.log(`| ${label} | ${[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((i) => h[i]).join(" | ")} | ${h.slice(21).reduce((a, b) => a + b, 0)} |`);
  console.log("");
  await bakeUnits();
  console.log(`\n${ua}`);
  const ok6 = worst6 <= BUDGET, ok7 = themeMean <= THEME_BUDGET && themeLow <= THEME_BUDGET;
  if (RUNS < 5) {
    console.log(`\nNo verdict: ${RUNS} run${RUNS > 1 ? "s" : ""} (five make one). S6 against the cheapest S2: ${f(worst6)}. S7 in the ${THEME} against the yard's own look: the means ${f(themeMean)}, the faster halves ${f(themeLow)}.`);
    return 2;
  }
  console.log(`\nS6: ${ok6 ? "WITHIN" : "OVER"} the budget (its median at most 1.10 times S2's): ${f(worst6)} against the cheapest of the three S2 cells.`);
  console.log(`S7 (${THEME}): ${ok7 ? "WITHIN" : "OVER"} the budget (at most ${THEME_BUDGET.toFixed(2)} times the same frames on the yard's own look, on the mean of the frames and on the mean of their faster half): ${f(themeMean)} and ${f(themeLow)}. (Information: against the cheapest S2 its median is ${f(worst7)}, the yard's own look ${f(worstYard)}: a step of the timer either way.)`);
  return ok6 && ok7 ? 0 : 1;
}

/**
 * What a tile costs to bake, per theme (no browser): every tile S7's lap of Preview Yard has in
 * view, baked to the end with the bake's own trace; the cost units of its steps summed (the
 * unit a frame's share of the baking is counted in) and the time they took here in Node.
 */
async function bakeUnits(): Promise<void> {
  const { bakeTileIndices, TILE, VIEW_H, VIEW_W, ZOOM } = await import("../../client/gfx/world");
  const { themedTrack } = await import("../../client/gfx/theme");
  const { testTrack } = await import("../../shared/testtracks");
  const { pointAt } = await import("../../shared/track");
  const yard = testTrack(YARD)!;
  const keys = new Set<string>();
  for (let s = 0; s < yard.length; s += 40) {
    const p = pointAt(yard, s);
    const x = p.x * ZOOM, y = p.y * ZOOM;
    for (let ty = Math.floor((y - VIEW_H / 2) / TILE); ty <= Math.floor((y + VIEW_H / 2) / TILE); ty++) for (let tx = Math.floor((x - VIEW_W / 2) / TILE); tx <= Math.floor((x + VIEW_W / 2) / TILE); tx++) keys.add(`${tx},${ty}`);
  }
  const tiles = [...keys].map((k) => k.split(",").map(Number));
  console.log(`Bake units per tile (Node; the ${tiles.length} tiles a lap of ${yard.def.name} has in view, each baked to the end twice, the second time measured):\n`);
  console.log("| theme | units a tile: mean | median | most | by step: ground | yard and props | road | details | furniture | finish | ms a tile here: mean | most | ms per 1000 units |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const theme of ["scrapyard", THEME] as const) {
    const track = themedTrack(yard, theme as Parameters<typeof themedTrack>[1]);
    const units: number[] = [], ms: number[] = [];
    const steps = new Float64Array(8);
    for (const [tx, ty] of tiles) {
      bakeTileIndices(track, tx, ty); // once unmeasured: the compilers
      let u = 0, t = 0;
      bakeTileIndices(track, tx, ty, (step, cost, took) => {
        u += cost;
        t += took;
        steps[step] += cost;
      });
      units.push(u);
      ms.push(t);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const st = (k: number) => (steps[k] / tiles.length).toFixed(0);
    console.log(`| ${theme} | ${mean(units).toFixed(0)} | ${median(units).toFixed(0)} | ${Math.max(...units).toFixed(0)} | ${st(1)} | ${st(2)} | ${(Number(st(0)) + Number(st(3))).toFixed(0)} | ${st(4)} | ${st(6)} | ${st(5)} | ${mean(ms).toFixed(3)} | ${Math.max(...ms).toFixed(3)} | ${((1000 * mean(ms)) / mean(units)).toFixed(3)} |`);
  }
  console.log("\n(Road = the classify and the road steps. A frame bakes ahead for 220 units, or 1500 while a tile in view is missing: gfx/world.ts.)");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
let code = 1;
if (args.includes("--units")) {
  await bakeUnits();
  process.exit(0);
}
try {
  code = await main();
} finally {
  await cleanup();
}
process.exit(code);
