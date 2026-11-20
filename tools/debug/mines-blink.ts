// Mines blink probe: does drawing mines that blink out allocate, and what do 40 mines in the
// view cost a frame against 6? (MINES-1: with "stay" up to 40 mines lie on the track.)
//
//   npx tsx tools/debug/mines-blink.ts                 allocation, no browser (this working tree)
//   npx tsx tools/debug/mines-blink.ts --time          frame time, in headless Chrome
//   --ref main          a git ref beside it (its client/ and shared/; the scenes are this tree's);
//                       a build from before the blink draws a blinking mine like any other
//   --track <id>        rust-bowl (default), crusher-run, overpass-knot
//   allocation:  --warm 30000   --frames 6000   --interval 128   --top 8
//   frame time:  --canvas soft,gpu   --reps 6   --shot <file.png> [--scene 2] [--at 14]
//
// The scenes (tools/debug/mines-blink/scene.ts): a standing view of the road, a pack of six
// driving through it, and in the view 6 mines, 40 mines, or 40 mines of which 20 blink out
// (their `out` counting down a tick a frame through both blink speeds, again and again).
//
// Allocation: Renderer.frame() as a race calls it, on a canvas that draws nothing. V8's
// sampling heap profiler over the measured frames, after the warm-up; every sampled
// allocation is charged to the innermost function of a file under client/ on its stack, as
// bytes per frame (objects collected again are counted). "outside" is the probe's own loop
// and Node. Also counted: the mines drawn a frame (a blinking mine is left out about every
// other frame, so 40 mines with 20 blinking come to about 30). Each scene runs in a process
// of its own. Numbers under about 1 byte per frame are the sampling's noise.
//
// Frame time: Renderer.frame() per frame with a 1x1 read-back, so the frame is rastered
// before the clock is read ("soft" = a canvas in main memory, CPU raster; "gpu" = the
// browser's own). In one page load the three scenes take turns, six rounds of 600 frames
// after 300 warm ones, the order turned round every round; the first round is left out.
// Printed: the median over the five rounds of each round's median, p95 and p99, and of its
// slowest frame. The page is served cross-origin isolated (a 5 us timer) on 127.0.0.1.

import { execFile, execFileSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { Session } from "node:inspector/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildScene, SCENES } from "./mines-blink/scene";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRACK = value("--track", "rust-bowl");
const DT = 1000 / 60;

// ---- allocation (Node) --------------------------------------------------------------------

interface ProfileNode {
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children?: ProfileNode[];
}

const drawn = new Int32Array(1); // sprites of 20 x 20 source pixels drawn: the mines (the scenes have no smoke)

/** A canvas that draws nothing and allocates nothing when drawn on; it counts the mines drawn. */
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
      if (sw === 20) drawn[0]++;
    },
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "putImageData", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

/** One scene of one build, in this process: prints one table row (and the top allocators, if any). */
async function measure(root: string, label: string, sceneNo: number): Promise<void> {
  const WARM = Number(value("--warm", "30000")), FRAMES = Number(value("--frames", "6000")), INTERVAL = Number(value("--interval", "128")), TOP = Number(value("--top", "8"));
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => fakeCanvas() };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
  const { Renderer } = await load("client/render.ts");
  const { trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const track = trackById(TRACK);
  const scene = buildScene(track, pointAt, SCENES[sceneNo]);
  const r = new Renderer(fakeCanvas(), track);
  const times = new Float64Array(1);
  let frameNo = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n; i++, frameNo++) {
      scene.step(frameNo);
      times[0] = 10000 + frameNo * DT;
      r.follow(scene.x, scene.y, DT, frameNo === 0);
      r.frame(scene.cars, scene.fx, null, times[0]);
    }
  };
  run(WARM);
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  drawn[0] = 0;
  const t0 = performance.now();
  run(FRAMES);
  const ms = performance.now() - t0;
  const mines = drawn[0] / FRAMES;
  const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };
  session.disconnect();
  // Charge every sampled allocation to the innermost function of client/ on its stack.
  const charged = new Map<string, number>();
  let inside = 0, outside = 0;
  const walk = (node: ProfileNode, owner: string): void => {
    const f = node.callFrame;
    const at = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
    const name = f.functionName || "(anonymous)";
    const here = at < 0 ? owner : `${f.url.slice(at + 8)} ${name}`;
    if (node.selfSize > 0) {
      if (here) {
        const key = at < 0 ? `${here} > ${name}` : here;
        charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
        inside += node.selfSize;
      } else outside += node.selfSize;
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  walk(profile.head, "");
  const rows = [...charged].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  const top = rows.length ? rows.map(([key, bytes]) => `${key}: ${(bytes / FRAMES).toFixed(1)}`).join("; ") : "-";
  console.log(`| ${label} | ${SCENES[sceneNo].name} | ${mines.toFixed(1)} | **${(inside / FRAMES).toFixed(1)}** | ${(outside / FRAMES).toFixed(1)} | ${(ms / FRAMES).toFixed(4)} | ${top} |`);
}

// ---- frame time (headless Chrome) -----------------------------------------------------------

const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const PAGE = path.join("tools", "debug", "mines-blink");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const SESSION = `mines-blink-${process.pid}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
}

function tempDir(kind: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `mines-blink-${kind}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git ref's client/ and shared/ in a temp folder, with this tree's probe page beside them. */
function unpack(ref: string): { label: string; root: string } {
  const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: ROOT, encoding: "utf8" }).trim();
  const dir = tempDir("ref");
  execFileSync("sh", ["-c", `git archive "$1" client shared tsconfig.json | tar -x -C "$2"`, "sh", sha, dir], { cwd: ROOT });
  mkdirSync(path.join(dir, "tools", "debug"), { recursive: true });
  cpSync(path.join(ROOT, PAGE), path.join(dir, PAGE), { recursive: true });
  return { label: `${ref} (${sha})`, root: dir };
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** Serve a built page, cross-origin isolated. */
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

async function build(root: string, what: string): Promise<string> {
  const out = tempDir("dist");
  console.error(`building the probe page against ${what} ...`);
  await run(VITE, ["build", path.join(root, PAGE), "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { cwd: root, maxBuffer: 16 << 20 });
  return out;
}

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 180_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

interface Run { rep: number; scene: number; mean: number; p50: number; p95: number; p99: number; max: number }
interface Out { done: boolean; isolated: boolean; userAgent: string; runs: Run[] }

const median = (v: number[]): number => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function time(builds: { label: string; root: string }[]): Promise<void> {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  const CANVASES = value("--canvas", "soft,gpu").split(",");
  const REPS = Number(value("--reps", "6"));
  const SHOT = value("--shot", "");
  try {
    const served: { label: string; url: string }[] = [];
    for (const b of builds) served.push({ label: b.label, url: await serve(await build(b.root, b.label)) });
    cleanups.push(() => ab(["close"]));
    await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
    const wait = async (what: string): Promise<void> => {
      const deadline = Date.now() + 180_000;
      while ((await ab(["eval", "window.minesOut && window.minesOut.done ? 1 : 0"])) !== "1") {
        if (Date.now() > deadline) throw new Error(`${what}: the probe page did not finish`);
        await sleep(250);
      }
    };
    if (SHOT) {
      const scene = value("--scene", "2"), at = value("--at", "0");
      await ab(["set", "viewport", "1280", "760"]);
      await ab(["open", `${served[served.length - 1].url}/?${new URLSearchParams({ track: TRACK, canvas: "gpu", show: scene, at })}`]);
      await wait("shot");
      // The canvas itself, 640 x 360, as a PNG.
      const png = JSON.parse(await ab(["eval", "document.getElementById('view').toDataURL('image/png')"])) as string;
      writeFileSync(SHOT, Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
      console.log(`${TRACK}: frame ${at} of "${SCENES[Number(scene)]?.name}": ${path.resolve(SHOT)}`);
      return;
    }
    console.log(`# Mines in the view: frame time (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
    console.log(`${TRACK}; ${REPS - 1} rounds of 600 frames a scene after a warm-up round; ms per Renderer.frame() with a 1x1 read-back; the median over the rounds. "soft" = a canvas in main memory (CPU raster), "gpu" = the browser's own.\n`);
    let agent = "";
    for (const canvas of CANVASES) {
      console.log(`**${canvas} canvas**\n`);
      console.log("| Build | Scene | median | p95 | p99 | slowest frame | median against 6 mines |");
      console.log("|---|---|---:|---:|---:|---:|---:|");
      for (const b of served) {
        await ab(["open", `${b.url}/?${new URLSearchParams({ track: TRACK, canvas, reps: String(REPS) })}`]);
        await wait(b.label);
        const out = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.minesOut)"])) as string) as Out;
        if (!out.isolated) console.error("warning: the page is not cross-origin isolated: a 100 us timer");
        agent = out.userAgent;
        const measured = out.runs.filter((x) => x.rep > 0);
        const of = (k: number, pick: (x: Run) => number) => median(measured.filter((x) => x.scene === k).map(pick));
        const base = of(0, (x) => x.p50);
        SCENES.forEach((s, k) => {
          const f = (pick: (x: Run) => number) => of(k, pick).toFixed(3);
          const d = of(k, (x) => x.p50) - base;
          console.log(`| ${b.label} | ${s.name} | ${f((x) => x.p50)} | ${f((x) => x.p95)} | ${f((x) => x.p99)} | ${f((x) => x.max)} | ${k ? `${d >= 0 ? "+" : ""}${d.toFixed(3)}` : "-"} |`);
        });
      }
      console.log("");
    }
    console.log(agent);
  } finally {
    await cleanup();
  }
}

// ---- main ---------------------------------------------------------------------------------

if (args.includes("--child")) {
  const at = args.indexOf("--child");
  await measure(args[at + 1], args[at + 2], Number(args[at + 3]));
} else {
  const builds: { label: string; root: string }[] = [];
  try {
    for (let i = 0; i < args.length; i++) if (args[i] === "--ref") builds.push(unpack(args[++i]));
    builds.push({ label: "working tree", root: ROOT });
    if (args.includes("--time")) await time(builds);
    else {
      console.log(`# Mines blink: allocation of Renderer.frame() (Node ${process.version})\n`);
      console.log(`${TRACK}; ${value("--warm", "30000")} warm frames, then ${value("--frames", "6000")} measured; sampling every ${value("--interval", "128")} bytes.\n`);
      console.log("| Build | Scene | mines drawn a frame | client/ bytes a frame | outside (the probe, Node) | ms a frame here | charged to |");
      console.log("|---|---|---:|---:|---:|---:|---|");
      for (const b of builds) {
        for (let k = 0; k < SCENES.length; k++) {
          // The same script again, in a process of its own, under the same loader.
          execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--child", b.root, b.label, String(k)], { cwd: ROOT, stdio: "inherit" });
        }
      }
    }
  } finally {
    await cleanup();
  }
}
