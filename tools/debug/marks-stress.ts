// Track marks stress: what does marking the track cost a frame at its worst? A real browser
// (headless Chrome through the agent-browser CLI), the page of tools/debug/marks-stress/.
//
//   npx tsx tools/debug/marks-stress.ts                 this working tree: the marks off and on in turn
//   npx tsx tools/debug/marks-stress.ts --ref main      a git ref beside it (a build from before the
//                                                       marks has no switch: it is measured as it is)
//   --tracks crusher-run,rust-bowl    --canvas soft,gpu    --reps 6
//   --shot <file.png>                 no measurement: a screenshot of the scene's last frame, marks on
//
// The scene: the benchmark's firefight (S3) made as hard on the marks as a race can be. A fixed
// camera; four cars crossing the view again and again, three of them sliding sideways (a tyre
// mark stamp each every other frame), every pass in a lane of its own, so the marks fall on
// fresh ground; two wrecks, twelve rivets, six mines, six hit sparks, the full HUD; a mine
// going off every half second, each somewhere else: twenty blasts in the 600 measured frames
// (10 s), after 300 frames of the same that are not measured.
//
// What is measured: Renderer.frame() per frame, with a 1x1 read-back so the frame is rastered
// before the clock is read (as the benchmark's metric A on the "soft" canvas, its metric G on
// the "gpu" one). In one page load the marks are switched off and on in turn (world.ts
// markSwitch: off = scorch() and skid() do nothing; the actors still look for blasts and
// slides), six pairs, the order swapped every pair, a new Renderer and cleared marks each run;
// the first pair is a warm-up and left out. Printed: the median over the five runs of each
// run's median, p95 and p99, and of its slowest frame; the slowest frame of all with its
// place among the 600; and how many frames of the five runs took over 2 ms.
// The page is served cross-origin isolated (a 5 us timer), on a port of its own on 127.0.0.1.

import { execFile } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const PAGE = path.join("tools", "debug", "marks-stress");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const args = process.argv.slice(2);
const value = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const TRACKS = value("--tracks", "crusher-run,rust-bowl").split(",");
const CANVASES = value("--canvas", "soft,gpu").split(",");
const REPS = Number(value("--reps", "6"));
const SHOT = value("--shot", "");
const SESSION = `gfx4-stress-${process.pid}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));

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

function tempDir(kind: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `marks-stress-${kind}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build the stress page against the client of `root` (this checkout or an unpacked ref). */
async function build(root: string, what: string): Promise<string> {
  const out = tempDir("dist");
  console.error(`building the stress page against ${what} ...`);
  await run(VITE, ["build", path.join(root, PAGE), "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { cwd: root, maxBuffer: 16 << 20 });
  return out;
}

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 180_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

interface Run { rep: number; on: boolean | null; mean: number; p50: number; p95: number; p99: number; max: number; slowest: number; over: number; marks: number; uploads: number; pixels: number }
interface Out { done: boolean; track: string; canvas: string; isolated: boolean; hasMarks: boolean; userAgent: string; runs: Run[] }

const median = (v: number[]): number => {
  const s = v.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

try {
  const builds: { label: string; url: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--ref") continue;
    const ref = args[++i];
    const sha = (await run("git", ["rev-parse", "--short", ref], { cwd: ROOT })).stdout.trim();
    const dir = tempDir("ref");
    await run("sh", ["-c", `git archive "$1" client shared tsconfig.json | tar -x -C "$2"`, "sh", sha, dir], { cwd: ROOT });
    mkdirSync(path.join(dir, "tools", "debug"), { recursive: true });
    cpSync(path.join(ROOT, PAGE), path.join(dir, PAGE), { recursive: true });
    builds.push({ label: `${ref} (${sha})`, url: await serve(await build(dir, `${ref} (${sha})`)) });
  }
  builds.push({ label: "working tree", url: await serve(await build(ROOT, "the working tree")) });

  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);

  if (SHOT) {
    const track = TRACKS[0];
    await ab(["set", "viewport", "1280", "760"]);
    await ab(["open", `${builds[builds.length - 1].url}/?${new URLSearchParams({ track, canvas: "gpu", show: "1" })}`]);
    for (let i = 0; i < 200 && (await ab(["eval", "window.stressOut && window.stressOut.done ? 1 : 0"])) !== "1"; i++) await sleep(100);
    // The canvas itself, 640x360, as a PNG.
    const png = JSON.parse(await ab(["eval", "document.getElementById('view').toDataURL('image/png')"])) as string;
    writeFileSync(SHOT, Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
    console.log(`${track}: the last frame of the stress scene, marks on: ${path.resolve(SHOT)}`);
  } else {
    console.log(`# Track marks stress (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
    console.log(`A firefight with 20 mine blasts in 10 s and three cars sliding all the way; ${REPS - 1} runs of 600 frames each way after a warm-up pair; ms per Renderer.frame() with a 1x1 read-back. "soft" = a canvas in main memory (CPU raster), "gpu" = the browser's own.\n`);
    let agent = "";
    for (const track of TRACKS) {
      for (const canvas of CANVASES) {
        console.log(`**${track}, ${canvas} canvas**\n`);
        console.log("| Build | Marks | median | p95 | p99 | slowest frame (median of the runs) | slowest of all (its frame) | frames over 2 ms, all runs | marks made a run | rectangles uploaded | pixels uploaded |");
        console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (const b of builds) {
          await ab(["open", `${b.url}/?${new URLSearchParams({ track, canvas, reps: String(REPS) })}`]);
          const deadline = Date.now() + 120_000;
          while ((await ab(["eval", "window.stressOut && window.stressOut.done ? 1 : 0"])) !== "1") {
            if (Date.now() > deadline) throw new Error(`${b.label}: the stress page did not finish`);
            await sleep(250);
          }
          const out = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.stressOut)"])) as string) as Out;
          if (!out.isolated) console.error("warning: the page is not cross-origin isolated: a 100 us timer");
          agent = out.userAgent;
          const measured = out.runs.filter((r) => r.rep > 0);
          for (const on of out.hasMarks ? [false, true] : [null]) {
            const rs = measured.filter((r) => r.on === on);
            const f = (pick: (r: Run) => number) => median(rs.map(pick)).toFixed(3);
            const worst = rs.reduce((a, r) => (r.max > a.max ? r : a));
            console.log(`| ${b.label} | ${on === null ? "none in this build" : on ? "on" : "off"} | ${f((r) => r.p50)} | ${f((r) => r.p95)} | ${f((r) => r.p99)} | ${f((r) => r.max)} | ${worst.max.toFixed(3)} (${worst.slowest}) | ${rs.reduce((n, r) => n + r.over, 0)} | ${median(rs.map((r) => r.marks))} | ${median(rs.map((r) => r.uploads))} | ${median(rs.map((r) => r.pixels))} |`);
          }
        }
        console.log("");
      }
    }
    console.log(agent);
  }
} finally {
  await cleanup();
}
