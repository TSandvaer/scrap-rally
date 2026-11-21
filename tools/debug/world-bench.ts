// Bench scene S6 against S2 (M4-WORLD; PLAN-M4.md section 3, where S6 is called "S5"): does a
// frame of the Preview Yard test track with the road's furniture in view (six cars, the barrels,
// the press, the truck, pools, three lightning cells; client/bench.ts yardScene) cost no more
// than 1.10 times a frame of S2?
//
//   npx tsx tools/debug/world-bench.ts            five runs, metric A at 1280x720
//   npx tsx tools/debug/world-bench.ts --runs 3
//   npx tsx tools/debug/world-bench.ts --quick    one run: a look, no verdict
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
// It takes the benchmark's machine-wide lock (scrap-rally-bench.lock in the temp directory), so
// it never runs beside `npm run bench`, and waits while a live benchmark holds it.
// Exit code 0 within the budget, 1 over it, 2 without a verdict (--quick, or fewer than 5 runs).

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
const BUDGET = 1.1;
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding,--enable-precise-memory-info";
const SESSION = `world-bench-${process.pid}`;
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

async function load(url: string, scene: string, track: string): Promise<{ cell: CellA; isolated: boolean; ua: string }> {
  await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", bench: "1", metric: "A", scene, track })}`]);
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

  const cells = [
    { scene: "S2", track: "rust-bowl" },
    { scene: "S2", track: "crusher-run" },
    { scene: "S2", track: "overpass-knot" },
    { scene: "S6", track: "preview-yard" },
    { scene: "S4", track: "rust-bowl" },
    { scene: "S4", track: "crusher-run" },
    { scene: "S4", track: "overpass-knot" },
    { scene: "S4", track: "preview-yard" },
  ];
  const got: CellA[][] = cells.map(() => []);
  let isolated = true, ua = "";
  for (let r = 0; r < RUNS; r++) {
    const order = r % 2 ? [3, 2, 1, 0, 7, 6, 5, 4] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const k of order) {
      const o = await load(url, cells[k].scene, cells[k].track);
      got[k].push(o.cell);
      isolated &&= o.isolated;
      ua = o.ua;
      console.error(`run ${r + 1}/${RUNS}  ${cells[k].scene} ${cells[k].track.padEnd(14)} median ${o.cell.p50.toFixed(3)}  p95 ${o.cell.p95.toFixed(3)}  ${o.cell.checksum}`);
    }
  }
  const f = (x: number) => x.toFixed(3);
  console.log(`# S6 against S2 (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
  console.log(`Metric A at 1280x720 (CPU raster: every frame once, a 1x1 read-back after each, 300 warm-up frames), ${RUNS} run${RUNS > 1 ? "s" : ""}, one cell a page load, the order turned round from run to run. ms a frame.${isolated ? "" : " WARNING: the page was not cross-origin isolated (a 100 us timer)."}\n`);
  console.log("| cell | frames | median (of the runs' medians) | spread (max - min) | mean | p95 | p99 | frames over 4 ms | new Renderer() | first frame, cold | checksums |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  cells.forEach((c, k) => {
    if (k === 4) console.log("| *as information: the lap* | | | | | | | | | | |");
    const p50 = got[k].map((x) => x.p50);
    console.log(`| ${c.scene} ${c.track} | ${got[k][0].n} | ${f(median(p50))} | ${f(Math.max(...p50) - Math.min(...p50))} | ${f(median(got[k].map((x) => x.mean)))} | ${f(median(got[k].map((x) => x.p95)))} | ${f(median(got[k].map((x) => x.p99)))} | ${median(got[k].map((x) => x.over))} | ${f(median(got[k].map((x) => x.ctorMs)))} | ${f(median(got[k].map((x) => x.firstMs)))} | ${[...new Set(got[k].map((x) => x.checksum))].join(" ")} |`);
  });
  console.log("\nA median is a whole number of the timer's steps (5 us): a ratio of two of them moves in jumps of about 0.08 here. The mean of a cell's frames is finer and its ratio is given beside the median's, as information: S6 cuts between its three views at frames 200 and 400, and the views together need more tiles than the pool of 24 holds, so each cut bakes what the pool gave away at once (the frame over 4 ms); S2 never moves its camera.\n");
  console.log("| S6 against | ratio of the medians, run by run | median ratio | budget 1.10 | ratio of the means, run by run | median |");
  console.log("|---|---|---:|---|---|---:|");
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const ratios = got[3].map((x, r) => x.p50 / got[k][r].p50), means = got[3].map((x, r) => x.mean / got[k][r].mean);
    const m = median(ratios);
    worst = Math.max(worst, m);
    console.log(`| S2 ${cells[k].track} | ${ratios.map(f).join(" ")} | ${f(m)} | ${m <= BUDGET ? "within" : "OVER"} | ${means.map(f).join(" ")} | ${f(median(means))} |`);
  }
  console.log(`\n${ua}`);
  if (RUNS < 5) {
    console.log(`\nNo verdict: ${RUNS} run${RUNS > 1 ? "s" : ""} (five make one). Against the cheapest S2 the ratio was ${f(worst)}.`);
    return 2;
  }
  console.log(`\nS6: ${worst <= BUDGET ? "WITHIN" : "OVER"} the budget (its median at most 1.10 times S2's): ${f(worst)} against the cheapest of the three S2 cells.`);
  return worst <= BUDGET ? 0 : 1;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
let code = 1;
try {
  code = await main();
} finally {
  await cleanup();
}
process.exit(code);
