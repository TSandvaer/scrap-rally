// The road's furniture on paper (M4-WORLD: water, dirt, tyre mounds, split lanes, the conveyor
// belt, rolling barrels, the crusher press, the ramp truck).
//
//   npx tsx tools/debug/world-sheet.ts                 the contact sheet -> tmp/m4-world/contact-sheet.png
//   npx tsx tools/debug/world-sheet.ts --out file.png  ... somewhere else
//   npx tsx tools/debug/world-sheet.ts --puddles       the pools and the dirt patches alone, each with its declared and its
//                                                      traction rectangle drawn over a copy -> tmp/m4-world/puddles-sheet.png
//   npx tsx tools/debug/world-sheet.ts --sprites       the obstacle sheet alone, large -> tmp/m4-world/sprites.png
//   npx tsx tools/debug/world-sheet.ts --check         no picture: the checks below, exit code 1 if one fails
//
// The contact sheet is made of frames the game's own Renderer drew, in headless Chrome (its page
// is world-sheet/): every feature on asphalt, on dirt and across a kerb, each tile enlarged in
// whole pixels and beside that at the game's own scale; the press through its cycle; one turn of
// a barrel; and three whole frames of Preview Yard. The features lie on a track of the sheet's
// own (world-sheet/yard.ts: Preview Yard's loop, every feature on each kind of ground) and on
// Preview Yard (shared/testtracks.ts).
//
// --sprites is made in Node from client/gfx/obstacles.ts (no browser): the sheet that holds what
// moves on a track, with Preview Yard's sprites and with the sheet's own yard's.
//
// --check (Node):
// - every pixel of the obstacle sheet is a palette colour or the cast shadow's black, for
//   Preview Yard and for the sheet's yard;
// - no barrel reaches the border of its picture;
// - the eight frames of a barrel's turn are eight different pictures, each with the label or
//   the seam in sight;
// - what moves on every shipped track and every test track has room on the sheet (obstacleFit).
// (That nothing of this lies on a shipped track, and what the puddles promise: puddle-probe.ts.)

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { FONT_LETTERS, SMALL } from "../../client/gfx/font";
import { P, PALETTE, rgbOf } from "../../client/gfx/palette";
import { FX_SHADOW, OBST_H, OBST_W } from "../../client/gfx/sprites";
import { TEST_TRACKS, testTrack } from "../../shared/testtracks";
import type { Track } from "../../shared/track";
import { trackById, trackList } from "../../shared/tracks";
import { sheetYard } from "./world-sheet/yard";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// ---- a picture ---------------------------------------------------------------------------

class Picture {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, fill: string) {
    this.data = new Uint8Array(w * h * 4);
    this.rect(0, 0, w, h, fill);
  }

  rect(x: number, y: number, w: number, h: number, hex: string): void {
    const [r, g, b] = rgbOf(hex);
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 4;
        this.data[o] = r;
        this.data[o + 1] = g;
        this.data[o + 2] = b;
        this.data[o + 3] = 255;
      }
    }
  }

  text(s: string, x: number, y: number, hex: string, scale = 2): void {
    const { cw, ch, bits } = SMALL;
    for (let n = 0; n < s.length; n++) {
      const k = FONT_LETTERS.indexOf(s[n]);
      if (k < 0) continue;
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (bits[(k * ch + j) * cw + i]) this.rect(x + (n * cw + i) * scale, y + j * scale, scale, scale, hex);
    }
  }

  png(): Buffer {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) Buffer.from(this.data.buffer, y * this.w * 4, this.w * 4).copy(raw, y * (this.w * 4 + 1) + 1);
    const chunk = (type: string, body: Buffer) => {
      const out = Buffer.alloc(body.length + 12);
      out.writeUInt32BE(body.length, 0);
      out.write(type, 4, "latin1");
      body.copy(out, 8);
      out.writeUInt32BE(crc32(out.subarray(4, body.length + 8)), body.length + 8);
      return out;
    };
    const head = Buffer.alloc(13);
    head.writeUInt32BE(this.w, 0);
    head.writeUInt32BE(this.h, 4);
    head.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  }
}

function save(file: string, png: Buffer): string {
  const out = path.resolve(file);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, png);
  return out;
}

// ---- the obstacle sheet (Node) -----------------------------------------------------------------

/** client/gfx/obstacles.ts with a canvas that draws nothing in its way (Node has none): the sheet as indices. */
async function indexSheet(track: Track): Promise<Uint8Array | null> {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData(): void {}, getContextAttributes: () => ({}) }) }) };
  const { obstacleIndexSheet } = await import("../../client/gfx/obstacles");
  const sheet = obstacleIndexSheet(track);
  return sheet ? sheet.slice() : null;
}

async function sprites(): Promise<Picture> {
  const S = 4;
  const tracks = [testTrack("preview-yard")!, sheetYard()];
  const pic = new Picture(40 + OBST_W * S, 50 + tracks.length * (OBST_H * S + 40), P.soot1);
  pic.text("M4-WORLD SPRITES: THE OBSTACLE SHEET (client/gfx/obstacles.ts), 4X, ON TARMAC", 20, 14, P.bone2, 2);
  let y = 50;
  for (const track of tracks) {
    const sheet = (await indexSheet(track))!;
    pic.text(`${track.def.name.toUpperCase()}: THE BELT'S ARROW AT 64 HEADINGS; PER ROW OF BARRELS ITS 8 FRAMES; PER PRESS ITS SLAB AND SHADOW`, 20, y, P.bone0, 1);
    y += 14;
    for (let j = 0; j < OBST_H; j++) {
      for (let i = 0; i < OBST_W; i++) {
        const v = sheet[j * OBST_W + i];
        pic.rect(20 + i * S, y + j * S, S, S, v === 0 ? (((i >> 3) + (j >> 3)) & 1 ? P.tar1 : P.tar2) : v === FX_SHADOW ? P.tar0 : PALETTE[v - 1].hex);
      }
    }
    y += OBST_H * S + 26;
  }
  return pic;
}

// ---- the checks (Node) -------------------------------------------------------------------------

async function check(): Promise<boolean> {
  let ok = true;
  const say = (good: boolean, what: string) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  };
  const { obstacleFit, BARREL, ROLL } = await import("../../client/gfx/obstacles");
  for (const track of [testTrack("preview-yard")!, sheetYard()]) {
    const sheet = (await indexSheet(track))!;
    let off = 0, used = 0, shadow = 0;
    const tones = new Set<number>();
    for (const v of sheet) {
      if (!v) continue;
      used++;
      if (v === FX_SHADOW) shadow++;
      else if (v >= 1 && v <= PALETTE.length) tones.add(v);
      else off++;
    }
    say(off === 0, `${track.def.name}: every pixel of the obstacle sheet is a palette colour or the cast shadow: ${used} pixels drawn, ${tones.size} of the 32 colours, ${shadow} shadow pixels, ${off} others`);
    // The barrels: the first row's frames lie at the top of the track's own part of the sheet (24 px under the arrows).
    if (track.barrels.length) {
      const top = 24;
      let edge = 0;
      const frames: string[] = [];
      let marked = 0;
      for (let f = 0; f < ROLL; f++) {
        let key = "";
        let mark = false;
        for (let y = 0; y < BARREL; y++) {
          for (let x = 0; x < BARREL; x++) {
            const v = sheet[(top + y) * OBST_W + f * BARREL + x];
            key += String.fromCharCode(48 + v);
            if (v && (x === 0 || y === 0 || x === BARREL - 1 || y === BARREL - 1)) edge++;
            const name = v >= 1 && v <= PALETTE.length ? PALETTE[v - 1].name : "";
            if (name === "bone1" || name === "bone2" || name === "bone0" || name === "rust0") mark = true;
          }
        }
        frames.push(key);
        if (mark) marked++;
      }
      say(edge === 0, `${track.def.name}: no barrel picture reaches its border (${edge} pixels on one)`);
      say(new Set(frames).size === ROLL, `${track.def.name}: the ${ROLL} frames of a barrel's turn are ${new Set(frames).size} different pictures`);
      say(marked === ROLL, `${track.def.name}: the label or the seam is in sight in ${marked} of the ${ROLL} frames`);
    }
  }
  // Room on the sheet, for every track there is.
  const all: Track[] = [...trackList().map((e) => trackById(e.id)), ...TEST_TRACKS.map((d) => testTrack(d.id)!), sheetYard()];
  for (const track of all) {
    const fit = obstacleFit(track);
    say(fit.fits, `${track.def.name}: what moves on it has room on the obstacle sheet (${fit.used} of ${fit.room} pixels; ${track.barrels.length} rows of barrels, ${track.presses.length} presses, ${track.belts.length} belts)`);
  }
  return ok;
}

// ---- the contact sheet (headless Chrome) -----------------------------------------------------

const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const PAGE = path.join("tools", "debug", "world-sheet");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const SESSION = `world-sheet-${process.pid}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const cleanups: (() => unknown)[] = [];
let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => {});
}
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

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
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 120_000, maxBuffer: 256 << 20 });
  return stdout.trim();
}

async function contact(out: string, query = ""): Promise<void> {
  const dist = mkdtempSync(path.join(tmpdir(), "world-sheet-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error("building the sheet's page ...");
  await run(VITE, ["build", path.join(ROOT, PAGE), "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const url = await serve(dist);
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  await ab(["open", `${url}/${query}`]);
  const deadline = Date.now() + 120_000;
  while ((await ab(["eval", "window.worldSheet && window.worldSheet.done ? 1 : 0"])) !== "1") {
    if (Date.now() > deadline) throw new Error("the sheet's page did not finish");
    await sleep(200);
  }
  const png = JSON.parse(await ab(["eval", "document.getElementById('sheet').toDataURL('image/png')"])) as string;
  console.log(save(out, Buffer.from(png.slice(png.indexOf(",") + 1), "base64")));
  console.log(await ab(["eval", "JSON.stringify(window.worldSheet)"]));
}

// ---- main ----------------------------------------------------------------------------------------

if (args.includes("--check")) {
  if (!(await check())) process.exit(1);
} else if (args.includes("--sprites")) {
  console.log(save(arg("--out") ?? path.join(ROOT, "tmp", "m4-world", "sprites.png"), (await sprites()).png()));
} else {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  try {
    if (args.includes("--puddles")) await contact(arg("--out") ?? path.join(ROOT, "tmp", "m4-world", "puddles-sheet.png"), "?only=puddles");
    else await contact(arg("--out") ?? path.join(ROOT, "tmp", "m4-world", "contact-sheet.png"));
  } finally {
    await cleanup();
  }
}
