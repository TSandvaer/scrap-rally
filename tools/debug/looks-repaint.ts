// What does a car's change of state cost the frame it happens in? A car sheet holds the car as
// it is (its look, its colour, whole, battered or burnt: client/gfx/sprites.ts), so a car that
// becomes battered or a wreck in the middle of a race has its sheet of 128 headings painted
// again, there and then. Measured in headless Chrome.
//
//   npx tsx tools/debug/looks-repaint.ts                    this working tree, rust-bowl
//   --tracks rust-bowl,crusher-run,overpass-knot            more tracks
//   --canvas soft,gpu    "soft" = a view canvas in main memory (CPU raster, as the benchmark's
//                        metric A), "gpu" = the browser's own (as a player's)
//   --reps 6             rounds of 1800 frames after 300 warm ones; the first round is left out
//   --every 30           a car changes state every so many frames (a race: a few times a minute)
//   --shot file.png [--at 900]   no timing: the canvas after that many frames, as a PNG
//
// The scene (tools/debug/looks-repaint/page.ts): a standing view, six cars of the three looks
// driving through it, and every 30 frames one of them changes state: whole, battered, wreck,
// whole again. With six cars the pool of six sheets has no room to spare, so every change is a
// repaint.
//
// What is read, in ms:
// - Renderer.frame() with a 1x1 read-back (so the frame is rastered before the clock is read),
//   for the frames with a change of state and for the frames without: the difference is what
//   a change costs its frame;
// - the repaint by itself: carSheet() asked for a sheet the pool does not hold (the pixels
//   worked out, putImageData), and the first blit from that sheet, rastered;
// - whether the sheets painted again hold the pixels they should, every pixel of the six;
// - the sprite canvases' bytes against the cap.
// The page is served cross-origin isolated (a 5 us timer) on 127.0.0.1.

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const PAGE = path.join("tools", "debug", "looks-repaint");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const SESSION = `looks-repaint-${process.pid}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
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

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 300_000, maxBuffer: 16 << 20 });
  return stdout.trim();
}

interface Stat { n: number; p50: number; p95: number; p99: number; max: number }
interface Out { done: boolean; isolated: boolean; userAgent: string; plain: Stat; change: Stat; paint: Stat; blit: Stat; compared: number; wrong: number; bytes: number; max: number }

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
let failed = false;
try {
  const dist = mkdtempSync(path.join(tmpdir(), "looks-repaint-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error("building the probe page ...");
  await run(VITE, ["build", path.join(ROOT, PAGE), "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const url = await serve(dist);
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  const wait = async (what: string): Promise<void> => {
    const deadline = Date.now() + 300_000;
    while ((await ab(["eval", "window.looksOut && window.looksOut.done ? 1 : 0"])) !== "1") {
      if (Date.now() > deadline) throw new Error(`${what}: the probe page did not finish`);
      await sleep(250);
    }
  };
  const TRACKS = value("--tracks", "rust-bowl").split(",");
  const EVERY = value("--every", "30");
  const SHOT = value("--shot", "");
  if (SHOT) {
    const at = value("--at", "900");
    await ab(["set", "viewport", "1280", "760"]);
    await ab(["open", `${url}/?${new URLSearchParams({ track: TRACKS[0], canvas: "gpu", show: at, every: EVERY })}`]);
    await wait("shot");
    const png = JSON.parse(await ab(["eval", "document.getElementById('view').toDataURL('image/png')"])) as string;
    writeFileSync(SHOT, Buffer.from(png.slice(png.indexOf(",") + 1), "base64"));
    console.log(`${TRACKS[0]}, frame ${at}: ${path.resolve(SHOT)}  (${await ab(["eval", "JSON.stringify(window.looksOut.states)"])})`);
  } else {
    const REPS = value("--reps", "6");
    console.log(`# A car's change of state: what it costs its frame (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
    console.log(`Six cars of three looks in a standing view; one changes state every ${EVERY} frames (every change repaints a sheet of 128 headings); ${Number(REPS) - 1} rounds of 1800 frames after a warm-up round. ms; a frame is Renderer.frame() with a 1x1 read-back. "soft" = a canvas in main memory (CPU raster), "gpu" = the browser's own.\n`);
    console.log("| Canvas | Track | frames without a change: median / p95 / p99 / max | frames with a change: median / p95 / p99 / max | a change costs (median) | the repaint alone: median / p95 / max | the first blit from it: median / max | sheets as they should be | sprite bytes / cap |");
    console.log("|---|---|---:|---:|---:|---:|---:|---|---:|");
    let agent = "";
    for (const canvas of value("--canvas", "soft,gpu").split(",")) {
      for (const track of TRACKS) {
        await ab(["open", `${url}/?${new URLSearchParams({ track, canvas, reps: REPS, every: EVERY })}`]);
        await wait(`${canvas} ${track}`);
        const o = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.looksOut)"])) as string) as Out;
        if (!o.isolated) console.error("warning: the page is not cross-origin isolated: a 100 us timer");
        agent = o.userAgent;
        const f = (x: number) => x.toFixed(3);
        const four = (s: Stat) => `${f(s.p50)} / ${f(s.p95)} / ${f(s.p99)} / ${f(s.max)} (${s.n})`;
        if (o.wrong || o.bytes > o.max) failed = true;
        console.log(`| ${canvas} | ${track} | ${four(o.plain)} | ${four(o.change)} | +${f(o.change.p50 - o.plain.p50)} | ${f(o.paint.p50)} / ${f(o.paint.p95)} / ${f(o.paint.max)} (${o.paint.n}) | ${f(o.blit.p50)} / ${f(o.blit.max)} | ${o.wrong ? `**${o.wrong} pixels WRONG**` : `yes (${o.compared} pixels)`} | ${o.bytes} / ${o.max}${o.bytes > o.max ? " **OVER**" : ""} |`);
      }
    }
    console.log(`\n${agent}`);
  }
} finally {
  await cleanup();
}
if (failed) process.exit(1);
