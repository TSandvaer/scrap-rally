// Render benchmark runner: drives client/bench.ts (?debug=1&bench=1) in headless Chrome
// through the agent-browser CLI, one cell (metric x scene x track) per page load, several
// runs, and prints the table PLAN-GFX.md's "Baseline" section holds. No npm dependencies.
//
//   npm run build && npm run bench                    this build alone (dist/)
//   npm run build && npm run bench -- --vs-ref main   this build against main, runs alternating
//   npm run bench -- http://localhost:3006 --vs http://localhost:3007
//   npm run build && npm run bench -- --pixels --vs-ref main   same pixels in the preview scenes?
//
// A directory target is served by this script on 127.0.0.1 with cross-origin isolation, which
// gives the page a 5 us timer; a URL target has whatever its server allows (usually 100 us).

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BenchOut, Cell, CellA, CellB, CellC } from "../client/bench";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const SCENES = ["S1", "S2", "S3", "S4", "S5"];
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"];
// Silent, and never throttled when the window is not in front; precise heap sizes for metric C.
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding,--enable-precise-memory-info";
const HELP = `npm run bench -- [target] [options]

  target             a built client directory (default: dist) or a URL
  --vs <target>      a baseline to compare with; the runs alternate between the two
  --vs-ref <ref>     build that git ref's client in a temp dir and use it as the baseline
  --runs <n>         runs per cell (default 5)
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
  --session <name>   agent-browser session prefix (default bench)`;

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
  close(): void;
}

interface Sample {
  target: string;
  run: number;
  viewport: string;
  metric: string; // A, G, B or C (G = the page's metric A on a GPU canvas)
  cell: Cell;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
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
function serveDir(dir: string): Promise<{ url: string; close(): void }> {
  if (!existsSync(path.join(dir, "index.html"))) fail(`${dir} has no index.html: run \`npm run build\` first`);
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
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() });
    });
  });
}

/** Build a git ref's client into a temp directory (its own sources, this checkout's node_modules). */
async function buildRef(ref: string): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scrap-bench-"));
  console.error(`building ${ref} in ${dir} ...`);
  await run("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", ref, dir], { cwd: ROOT });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  await run(path.join(ROOT, "node_modules", ".bin", "vite"), ["build"], { cwd: dir });
  if (!flag("pixels") && !existsSync(path.join(dir, "client", "bench.ts"))) fail(`${ref} has no client/bench.ts: it cannot be benchmarked`);
  return dir;
}

async function ab(session: string, args: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", session, ...args], { timeout: 120_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

async function target(label: string, spec: string, prefix: string, cleanup: (() => void)[]): Promise<Target> {
  let url = spec.replace(/\/+$/, "");
  let close = () => {};
  if (!/^https?:\/\//.test(spec)) {
    const served = await serveDir(path.resolve(spec));
    url = served.url;
    close = served.close;
  }
  const session = `${prefix}-${label}`;
  await ab(session, ["--args", CHROME_ARGS, "open", "about:blank"]);
  const t = { label, url, session, close };
  cleanup.push(() => t.close());
  return t;
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

// ---- statistics -------------------------------------------------------------------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * A value over the runs: the baseline is the median, the spread is max - min. A time's spread
 * counts as at least 1% of the baseline, so a cell whose runs happened to agree (or a paced
 * interval that never varies) does not get a zero allowance; a count has no such floor.
 */
interface Stat {
  base: number;
  spread: number;
  limit: number; // base + 2 x spread: the budget
}

const SPREAD_FLOOR = 0.01;
const RULE_RUNS = 5; // the budget rule is defined on five runs

function stat(xs: number[], time: boolean): Stat {
  const base = median(xs);
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), time ? base * SPREAD_FLOOR : 0);
  return { base, spread, limit: base + 2 * spread };
}

const ms = (x: number) => x.toFixed(x < 100 ? 3 : 1);
const int = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function pick<T extends Cell>(samples: Sample[], t: string, vp: string, metric: string, scene: string, track: string): T[] {
  return samples.filter((s) => s.target === t && s.viewport === vp && s.metric === metric && s.cell.scene === scene && s.cell.track === track).map((s) => s.cell as T);
}

/** "base ± spread → limit" for one target, or "base → cand (≤ limit) ok/OVER" against a baseline. */
function column(base: number[], cand: number[] | null, fmt: (x: number) => string): string[] {
  const b = stat(base, fmt === ms);
  if (!cand) return [fmt(b.base), fmt(b.spread), fmt(b.limit)];
  const c = median(cand);
  // Under five runs there is no measured spread to judge by: the number only.
  return [fmt(b.base), fmt(b.limit), base.length < RULE_RUNS ? fmt(c) : `${fmt(c)} ${c <= b.limit ? "ok" : "**OVER**"}`];
}

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map((h, i) => (i < 2 && /^[A-Za-z]/.test(h) && !/\d/.test(h) ? "---" : "---:")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function tablesFor(samples: Sample[], base: string, cand: string | null, vps: Viewport[], metrics: string[]): string {
  const out: string[] = [];
  const cols = (name: string) => (cand ? [`${name} base`, "limit", "this build"] : [name, "±", "limit"]);
  for (const vp of vps) {
    for (const metric of metrics) {
      const rows: string[][] = [];
      for (const scene of SCENES) {
        for (const track of TRACKS) {
          const b = pick<Cell>(samples, base, vp.name, metric, scene, track);
          if (!b.length) continue;
          const c = cand ? pick<Cell>(samples, cand, vp.name, metric, scene, track) : null;
          const col = <T extends Cell>(f: (x: T) => number, fmt: (x: number) => string) =>
            column((b as T[]).map(f), c ? (c as T[]).map(f) : null, fmt);
          if (metric === "A" || metric === "G") {
            const sums = new Set([...b, ...(c ?? [])].map((x) => (x as CellA).checksum));
            rows.push([
              scene, track,
              ...col<CellA>((x) => x.p50, ms), ...col<CellA>((x) => x.p95, ms), ...col<CellA>((x) => x.p99, ms), ...col<CellA>((x) => x.over, int),
              sums.size === 1 ? [...sums][0] : `**${sums.size} differ**`,
            ]);
          } else if (metric === "B") {
            rows.push([scene, track, ...col<CellB>((x) => x.p50, ms), ...col<CellB>((x) => x.p95, ms), ...col<CellB>((x) => x.over20, int), ...col<CellB>((x) => x.jsP50, ms)]);
          } else {
            const per = (x: CellC) => (x.allocBytes - x.probeBytes) / x.n;
            rows.push([scene, track, ...col<CellC>(per, (x) => x.toFixed(0)), ...col<CellC>((x) => x.gcDrops, int)]);
          }
        }
      }
      if (!rows.length) continue;
      const title: Record<string, string> = {
        A: "Metric A (CPU raster, ms per frame)",
        G: "Metric G (as A on a GPU canvas, ms per frame; informational)",
        B: "Metric B (rAF-paced, ms between frames)",
        C: "Metric C (heap bytes allocated per frame; informational)",
      };
      const head: Record<string, string[]> = {
        A: ["Scene", "Track", ...cols("median"), ...cols("p95"), ...cols("p99"), ...cols(">4 ms"), cand ? "same picture" : "checksum"],
        B: ["Scene", "Track", ...cols("median"), ...cols("p95"), ...cols(">20 ms"), ...cols("frame() median")],
        C: ["Scene", "Track", ...cols("bytes/frame"), ...cols("GCs")],
      };
      out.push(`**${title[metric]} at ${vp.name}**\n\n${table(head[metric === "G" ? "A" : metric], rows)}`);
    }
    // Construction and the first frame of a cold page, from the metric A cells.
    const rows = TRACKS.flatMap((track) => {
      const cells = samples.filter((s) => s.target === base && s.viewport === vp.name && s.metric === "A" && s.cell.track === track).map((s) => s.cell as CellA);
      if (!cells.length) return [];
      const c = cand ? samples.filter((s) => s.target === cand && s.viewport === vp.name && s.metric === "A" && s.cell.track === track).map((s) => s.cell as CellA) : null;
      const one = (f: (x: CellA) => number) => {
        const b = cells.map(f);
        return c ? [ms(median(b)), ms(Math.max(...b)), `${ms(median(c.map(f)))} / ${ms(Math.max(...c.map(f)))}`] : [ms(median(b)), ms(Math.max(...b))];
      };
      return [[track, String(cells.length), ...one((x) => x.ctorMs), ...one((x) => x.firstMs)]];
    });
    const sub = (name: string) => (cand ? [`${name} base median`, "max", "this build median / max"] : [`${name} median`, "max"]);
    if (rows.length) out.push(`**Renderer construction and first frame on a cold page at ${vp.name} (ms)**\n\n${table(["Track", "page loads", ...sub("new Renderer()"), ...sub("first frame")], rows)}`);
  }
  return out.join("\n\n");
}

// ---- main -------------------------------------------------------------------------

async function main(): Promise<void> {
  if (flag("help") || flag("h")) {
    console.log(HELP);
    return;
  }
  const quick = flag("quick");
  const runs = Number(arg("runs") ?? (quick ? 1 : 5));
  const vps: Viewport[] = (arg("viewports") ?? (quick ? "1280x720" : "1280x720,390x844@3")).split(",").map((v) => {
    const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(v.trim());
    if (!m) fail(`bad viewport ${v}`);
    return { name: v.trim(), w: Number(m[1]), h: Number(m[2]), scale: Number(m[3] ?? 1) };
  });
  const metrics = (arg("metrics") ?? (quick ? "A" : "A,G,B,C")).toUpperCase().split(",");
  const only = (arg("only") ?? "").split(",").filter(Boolean).map((o) => o.split(":"));
  const wanted = (scene: string, track: string) => !only.length || only.some(([s, t]) => s.toUpperCase() === scene && (!t || t === track));
  const bScene = (arg("b-scene") ?? "S4").toUpperCase();
  const panel = arg("panel") ?? "";
  const prefix = arg("session") ?? "bench";
  const valued = new Set(["vs", "vs-ref", "runs", "viewports", "metrics", "only", "b-scene", "panel", "out", "session", "scenes"]);
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && valued.has(all[i - 1].slice(2))));
  const spec = positional[0] ?? "dist";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.resolve(arg("out") ?? path.join(ROOT, "tmp", "bench", `${stamp}.json`));

  const cleanup: (() => void)[] = [];
  let tmpDir: string | null = null;
  const vsSpec = arg("vs-ref") ? (tmpDir = await buildRef(arg("vs-ref")!)) && path.join(tmpDir, "dist") : arg("vs");
  const targets: Target[] = [];
  const samples: Sample[] = [];
  let env: BenchOut["env"] | null = null;
  try {
    if (vsSpec) targets.push(await target("base", vsSpec, prefix, cleanup));
    targets.push(await target(vsSpec ? "this" : "base", spec, prefix, cleanup));
    if (flag("pixels")) {
      console.log(await pixelDiff(targets[0], targets[targets.length - 1], arg("scenes")?.split(",") ?? PREVIEW_SCENES));
      return;
    }

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
    if (!cells.length) fail("nothing to run: check --metrics and --only");
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
          // Alternate which build goes first, so neither always runs on the warmer machine.
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
  } finally {
    for (const t of targets) await ab(t.session, ["close"]).catch(() => {});
    for (const f of cleanup) f();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  const meta = { date: new Date().toISOString(), cpu: os.cpus()[0]?.model ?? "", cores: os.cpus().length, os: `${os.type()} ${os.release()}`, node: process.version, runs, env, targets: targets.map((t) => t.label), spec, vs: arg("vs-ref") ?? arg("vs") };
  writeFileSync(outFile, JSON.stringify({ meta, samples }, null, 1));

  const compare = targets.length > 1;
  console.log(`Render benchmark, ${meta.date.slice(0, 10)}: ${runs} run(s) per cell, ${meta.cpu}, ${env?.ua.match(/(Headless)?Chrome\/[\d.]+/)?.[0] ?? "?"}, timer ${((env?.timerMs ?? 0) * 1000).toFixed(0)} us.`);
  console.log(
    compare
      ? "Each value is the median of the runs. limit = baseline + 2 x spread (spread = max - min of the baseline's runs, for a time at least 1% of the baseline). OVER = this build is above the limit.\n"
      : "Baseline = median of the runs, ± = spread (max - min of the runs, for a time at least 1% of the baseline), limit = baseline + 2 x spread.\n",
  );
  if (runs < RULE_RUNS) console.log(`Only ${runs} run(s): the spread is not measured, so the limits are not a budget and no verdict is given. Use the default ${RULE_RUNS} runs to judge a build.\n`);
  console.log(tablesFor(samples, "base", compare ? "this" : null, vps, metrics));
  console.log(`\nRaw results: ${outFile}`);
}

await main();
