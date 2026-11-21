// M4-WORLD's screenshots and pixel diffs, in headless Chrome: the shipped tracks before and
// after, the Preview Yard scenes, a close-up of the water.
//
//   npx tsx tools/debug/world-shots.ts                  against main -> tmp/m4-world/shots/
//   npx tsx tools/debug/world-shots.ts --ref <ref>      against another commit
//   npx tsx tools/debug/world-shots.ts --out <dir>
//   npx tsx tools/debug/world-shots.ts --only yard      the Preview Yard scenes alone (no ref is built)
//
// Both builds are made here (the working tree as it is, the ref from `git archive`, each in a
// temp directory with this checkout's node_modules) and served on 127.0.0.1; a browser session
// each (world-shots-<pid>-base, -this), closed at the end.
// - Before | after pairs of the whole window at 1280x720 and at 390x844@3, for pictures of the
//   shipped tracks (preview scenes on Rust Bowl and on the preview's figure-eight, and a held
//   bench frame of Crusher Run and of Overpass Knot), with the number of pixels that differ
//   between the two halves: `pair-<name>-<size>.png`. Nothing of M4-WORLD lies on a shipped
//   track, so every number is to be 0.
// - The Preview Yard scenes (new: the ref has none) at both sizes, held at their key moment:
//   `yard-<scene>-<size>.png`; and yard-chicane without a race tick (&rt=0).
// - A close-up of the pool of yard-chicane, the game's own pixels four times enlarged:
//   `water-closeup.png`.
// Exit code 1 if a pair differs.

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { blank, decodePng, differing, paste, savePng, type Picture } from "./png";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REF = arg("--ref") ?? "main";
const OUT = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "m4-world", "shots"));
const ONLY = arg("--only") ?? "";
const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };

const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];
/** The pictures of the shipped tracks: a name and the page's query. */
const PAIRS: { name: string; query: Record<string, string> }[] = [
  { name: "rust-bowl", query: { preview: "1", scene: "rust", freeze: "1" } },
  { name: "rust-bowl-countdown", query: { preview: "1", scene: "countdown", freeze: "1" } },
  { name: "rust-bowl-catchup", query: { preview: "1", scene: "catchup", freeze: "1" } },
  { name: "eight-ramp", query: { preview: "1", scene: "ramp", freeze: "1" } },
  { name: "eight-crossing", query: { preview: "1", scene: "jump", freeze: "1" } },
  { name: "eight-holes", query: { preview: "1", scene: "mine", freeze: "1" } },
  { name: "crusher-run-chasm", query: { bench: "1", scene: "S2", track: "crusher-run", hold: "140" } },
  { name: "crusher-run-scrap", query: { bench: "1", scene: "S3", track: "crusher-run", hold: "90" } },
  { name: "overpass-knot-crossing", query: { bench: "1", scene: "S2", track: "overpass-knot", hold: "140" } },
  { name: "overpass-knot-pit", query: { bench: "1", scene: "S3", track: "overpass-knot", hold: "90" } },
];
const YARD = ["yard-chicane", "yard-truck", "yard-split", "yard-bend", "yard-belt"];

const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
}

function tempDir(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `world-shots-${tag}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

async function ab(session: string, more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 });
  return stdout.trim();
}

interface Build {
  url: string;
  session: string;
}

async function open(tag: string, dist: string): Promise<Build> {
  const url = await serve(dist);
  const session = `world-shots-${process.pid}-${tag}`;
  cleanups.push(() => ab(session, ["close"]));
  await ab(session, ["--args", CHROME_ARGS, "open", "about:blank"]);
  return { url, session };
}

/** A page of a build, held; its window as a picture. */
async function shot(b: Build, query: Record<string, string>, file: string): Promise<Picture> {
  await ab(b.session, ["open", `${b.url}/?${new URLSearchParams({ debug: "1", ...query })}`]);
  if (query.bench) {
    const deadline = Date.now() + 60_000;
    while ((await ab(b.session, ["eval", "window.scrapBench && window.scrapBench.done ? 1 : 0"])) !== "1") {
      if (Date.now() > deadline) throw new Error(`the bench page did not finish: ${JSON.stringify(query)}`);
      await sleep(150);
    }
  }
  await sleep(400); // a held scene is redrawn every frame: any frame after the first will do
  await ab(b.session, ["screenshot", file]);
  return decodePng(file);
}

/** The game canvas of the page a session shows, 640 x 360. */
async function canvasOf(b: Build): Promise<Picture> {
  const GRAB = `(() => { const c = document.getElementById("view"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let s = ""; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return btoa(s); })()`;
  const data = Buffer.from(JSON.parse(await ab(b.session, ["eval", "-b", Buffer.from(GRAB).toString("base64")])) as string, "base64");
  return { w: 640, h: 360, data: new Uint8Array(data) };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const scratch = tempDir("png");
  console.error("building the working tree ...");
  const distThis = tempDir("this");
  await run(VITE, ["build", "--outDir", distThis, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const now = await open("this", distThis);
  const lines: string[] = [];
  let bad = 0;
  if (ONLY !== "yard") {
    const sha = (await run("git", ["rev-parse", "--verify", `${REF}^{commit}`], { cwd: ROOT })).stdout.trim();
    console.error(`building ${REF} (${sha.slice(0, 12)}) ...`);
    const src = tempDir("base");
    await run("sh", ["-c", `git archive "$1" | tar -x -C "$2"`, "sh", sha, src], { cwd: ROOT });
    symlinkSync(path.join(ROOT, "node_modules"), path.join(src, "node_modules"));
    await run(VITE, ["build", "--logLevel", "warn"], { cwd: src, maxBuffer: 16 << 20 });
    const before = await open("base", path.join(src, "dist"));
    lines.push(`Before | after: ${REF} (${sha.slice(0, 7)}) against the working tree, the whole window.\n`, "| picture | size | pixels | differing |", "|---|---|---:|---:|");
    for (const size of SIZES) {
      for (const b of [before, now]) await ab(b.session, ["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
      for (const p of PAIRS) {
        const a = await shot(before, p.query, path.join(scratch, "a.png")), c = await shot(now, p.query, path.join(scratch, "b.png"));
        const n = differing(a, c);
        if (n) bad++;
        const pair = blank(a.w + c.w + 12, Math.max(a.h, c.h), 18, 14, 11);
        paste(pair, a, 0, 0);
        paste(pair, c, a.w + 12, 0);
        const file = path.join(OUT, `pair-${p.name}-${size.name}.png`);
        savePng(file, pair);
        lines.push(`| ${p.name} | ${size.name} | ${a.w * a.h} | ${n}${n ? " DIFFERS" : ""} |`);
        console.error(`${file}  ${n} differing`);
      }
    }
  }
  lines.push("", "Preview Yard (new):", "");
  for (const size of SIZES) {
    await ab(now.session, ["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
    for (const scene of YARD) {
      const file = path.join(OUT, `${scene}-${size.name}.png`);
      await shot(now, { preview: "1", scene, freeze: "1" }, file);
      lines.push(file);
      if (scene === "yard-chicane" && size.scale === 1) {
        // The pool, the game's own pixels: the scene's frame without its caption, a piece of it four times enlarged.
        await shot(now, { preview: "1", scene, freeze: "1", hud: "0" }, path.join(scratch, "c.png"));
        const frame = await canvasOf(now);
        const close = blank(190 * 4, 150 * 4, 0, 0, 0);
        paste(close, frame, 0, 0, 420, 105, 190, 150, 4);
        savePng(path.join(OUT, "water-closeup.png"), close);
        lines.push(path.join(OUT, "water-closeup.png"));
        const still = path.join(OUT, `yard-chicane-no-tick-${size.name}.png`);
        await shot(now, { preview: "1", scene, freeze: "1", rt: "0" }, still);
        lines.push(still);
      }
    }
  }
  console.log(lines.join("\n"));
  if (bad) {
    console.log(`\n${bad} pairs differ.`);
    process.exitCode = 1;
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
try {
  await main();
} finally {
  await cleanup();
}
