// The catch-up visuals on paper (M4-FX: lightning cells, boost flames, slipstream streaks, the
// HUD's DRAFT and BOOST cues).
//
//   npx tsx tools/debug/fx-sheet.ts                 the contact sheet -> tmp/m4-fx/contact-sheet.png
//   npx tsx tools/debug/fx-sheet.ts --out file.png  ... somewhere else
//   npx tsx tools/debug/fx-sheet.ts --sprites       the sprite sheet alone, large -> tmp/m4-fx/sprites.png
//   npx tsx tools/debug/fx-sheet.ts --check         no picture: the checks below, exit code 1 if one fails
//   npx tsx tools/debug/fx-sheet.ts --time          no picture: what the visuals cost a frame, in headless Chrome
//
// The contact sheet is made of frames the game's own Renderer drew, in headless Chrome (its
// page is fx-sheet/): the cells on the ground, floating, taken and about to be back; the
// flame on the three looks, sputtering and in the air; the streaks at three strengths; the
// HUD's panel in its states; and one whole frame with all of it. Each tile is a piece of a
// 640 x 360 frame, enlarged in whole pixels.
//
// --sprites is made in Node from client/gfx/sprites.ts (no browser): the catch-up sheet's
// cell pictures on tarmac, dirt, gravel and the two kerb colours, and the flame's frames at
// 16 of its 64 headings behind each look.
//
// --time (headless Chrome, the page served cross-origin isolated: a 5 us timer): a pack of six
// through a bend with the race HUD, the catch-up fields filled (three cars in a slipstream,
// three boosting, six cells, the HUD's two cues) and absent in turn, 600 frames a round,
// `--reps 7` rounds each after a warm-up round; Renderer.frame() with a 1x1 read-back, ms; on
// a "soft" canvas (in main memory: CPU raster, as the benchmark's metric A) and a "gpu" one
// (`--canvas soft,gpu`).
//
// --check (Node):
// - every pixel of the catch-up sheet is a palette colour, or the cast shadow's black;
// - no flame pixel lies on its picture's border (the picture is big enough at every heading);
// - no cell pixel lies on its picture's border;
// - the sheet's bytes, and the sprites' cap with the world's tile pool against PLAN-GFX's 12 MB.

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
import { CAR_COLORS, P, PALETTE, rgbOf } from "../../client/gfx/palette";
import { carPixels, CATCH_H, CATCH_W, catchPixels, CELL, CX_AIR, CX_AIR_GONE, CX_GONE, CX_GROUND, CX_SHADE, FLAME, FLAME_AT, FLAME_COLS, FLAME_FRAMES, FLAME_HEADINGS, LOOKS, SHEET_W, SPRITE_BYTES_MAX } from "../../client/gfx/sprites";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TILE_POOL = 24 * 256 * 256 * 4; // world.ts: 24 tiles of 256 x 256
const CAP = 12_000_000; // PLAN-GFX: total canvas memory added

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

  /** A stretch of ground: the colour with specks a step darker and a step lighter, as the baked world's. */
  ground(x: number, y: number, w: number, h: number, scale: number, tones: readonly [string, string, string]): void {
    for (let j = 0; j < h; j += scale) {
      for (let i = 0; i < w; i += scale) {
        let k = Math.imul((x + i) / scale, 374761393) ^ Math.imul((y + j) / scale, 668265263);
        k = Math.imul(k ^ (k >>> 13), 1274126177);
        const r = ((k ^ (k >>> 16)) >>> 0) % 100;
        this.rect(x + i, y + j, Math.min(scale, w - i), Math.min(scale, h - j), r < 7 ? tones[0] : r > 91 ? tones[2] : tones[1]);
      }
    }
  }

  /**
   * A w x h piece of a sheet of 0xAABBGGRR words (`sw` wide) from (sx, sy), its top-left at
   * (x, y), every pixel `scale` big, blended by its own alpha.
   */
  blit(sheet: Uint32Array, sw: number, sx: number, sy: number, w: number, h: number, x: number, y: number, scale: number): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = sheet[(sy + j) * sw + sx + i];
        const alpha = (v >>> 24) / 255;
        if (!alpha) continue;
        for (let q = 0; q < scale; q++) {
          for (let p = 0; p < scale; p++) {
            const px = x + i * scale + p, py = y + j * scale + q;
            if (px < 0 || py < 0 || px >= this.w || py >= this.h) continue;
            const o = (py * this.w + px) * 4;
            this.data[o] = Math.round(this.data[o] * (1 - alpha) + (v & 255) * alpha);
            this.data[o + 1] = Math.round(this.data[o + 1] * (1 - alpha) + ((v >>> 8) & 255) * alpha);
            this.data[o + 2] = Math.round(this.data[o + 2] * (1 - alpha) + ((v >>> 16) & 255) * alpha);
          }
        }
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

// ---- the sprite sheet, large (Node) ----------------------------------------------------------

const GROUNDS: { name: string; tones: readonly [string, string, string] }[] = [
  { name: "TARMAC", tones: [P.tar0, P.tar1, P.tar2] },
  { name: "DIRT", tones: [P.dirt1, P.dirt2, P.dirt3] },
  { name: "GRAVEL", tones: [P.gravel0, P.gravel1, P.gravel2] },
  { name: "KERB", tones: [P.bone1, P.bone1, P.bone1] },
  { name: "KERB", tones: [P.rust2, P.rust2, P.rust2] },
];

function sprites(): Picture {
  const S = 5; // screen pixels a view pixel
  const sheet = catchPixels();
  const T = CELL * S; // a tile
  const pic = new Picture(40 + 12 * (T + 8), 60 + GROUNDS.length * (T + 8) + 80 + LOOKS.length * (4 * (48 * 3 + 6) + 40), P.soot1);
  pic.text("M4-FX SPRITES: THE CATCH-UP SHEET (client/gfx/sprites.ts), 5X", 20, 14, P.bone2, 2);
  const names = ["GROUND 0", "GROUND 1", "GROUND 2", "GROUND 3", "AIR 0", "AIR 1", "AIR 2", "AIR 3", "TAKEN", "RETURNING", "AIR TAKEN", "AIR RETURN."];
  names.forEach((n, k) => pic.text(n, 20 + k * (T + 8), 40, P.bone0, 1));
  GROUNDS.forEach((g, row) => {
    const y = 54 + row * (T + 8);
    for (let k = 0; k < 12; k++) {
      const x = 20 + k * (T + 8);
      pic.ground(x, y, T, T, S, g.tones);
      const air = (k >= 4 && k < 8) || k >= 10;
      const cellNo = k < 4 ? CX_GROUND + k : k < 8 ? CX_AIR + (k - 4) : k < 10 ? CX_GONE + (k - 8) : CX_AIR_GONE + (k - 10);
      // A floating cell's shadow: nearer than the renderer puts it (10, 14 view pixels away), so it stays in the tile.
      if (air) {
        const sh = k >= 10 ? CX_SHADE + 2 : CX_SHADE + ((k - 4) & 1);
        const moved = new Uint32Array(CELL * CELL);
        for (let j = 0; j < CELL - 8; j++) for (let i = 0; i < CELL - 6; i++) moved[(j + 8) * CELL + i + 6] = sheet[j * CATCH_W + sh * CELL + i];
        pic.blit(moved, CELL, 0, 0, CELL, CELL, x, y, S);
      }
      pic.blit(sheet, CATCH_W, cellNo * CELL, 0, CELL, CELL, x, y, S);
    }
  });
  // The flames: behind each look, 16 headings, the four frames.
  let y = 54 + GROUNDS.length * (T + 8) + 20;
  const Z = 3, BOX = 48;
  LOOKS.forEach((look, li) => {
    const car = carPixels(CAR_COLORS[li], undefined, li);
    pic.text(`${look.toUpperCase()}: THE FLAME'S FOUR FRAMES (3 FLICKER, 1 SHORT), 16 OF ${FLAME_HEADINGS} HEADINGS, 3X`, 20, y, P.bone0, 1);
    y += 14;
    for (let j = 0; j <= FLAME_FRAMES; j++) {
      for (let h = 0; h < 16; h++) {
        const f = h * 4, k = f * 2; // the flame's heading and the car's cell
        const x = 20 + h * (BOX * Z + 6);
        pic.ground(x, y, BOX * Z, BOX * Z, Z, GROUNDS[0].tones);
        const cx = x + (BOX / 2) * Z, cy = y + (BOX / 2) * Z;
        const n = j * FLAME_HEADINGS + f;
        const a = (f * Math.PI * 2) / FLAME_HEADINGS;
        const side = li === 1 ? [0] : [-3.4, 3.4];
        for (const v of side) {
          const dx = Math.round(-Math.sin(a) * v), dy = Math.round(Math.cos(a) * v);
          pic.blit(sheet, CATCH_W, (n % FLAME_COLS) * FLAME, CELL + Math.floor(n / FLAME_COLS) * FLAME, FLAME, FLAME, cx + (FLAME_AT[f * 2] + dx - FLAME / 2) * Z, cy + (FLAME_AT[f * 2 + 1] + dy - FLAME / 2) * Z, Z);
        }
        pic.blit(car, SHEET_W, (k % 16) * CELL, Math.floor(k / 16) * CELL, CELL, CELL, cx - (CELL / 2) * Z, cy - (CELL / 2) * Z, Z);
      }
      y += BOX * Z + 6;
    }
    y += 20;
  });
  return pic;
}

// ---- the checks (Node) -------------------------------------------------------------------------

function check(): boolean {
  let ok = true;
  const say = (good: boolean, what: string) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
    if (!good) ok = false;
  };
  const sheet = catchPixels();
  const palette = new Set(PALETTE.map((e) => {
    const [r, g, b] = rgbOf(e.hex);
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }));
  let off = 0, shadow = 0, used = 0;
  const tones = new Set<number>();
  for (const v of sheet) {
    if (!v) continue;
    used++;
    if (palette.has(v)) tones.add(v);
    else if ((v & 0xffffff) === 0 && v >>> 24 === Math.round(0.38 * 255)) shadow++;
    else off++;
  }
  say(off === 0, `every pixel of the catch-up sheet is a palette colour or the cast shadow: ${used} pixels drawn, ${tones.size} of the 32 colours, ${shadow} shadow pixels, ${off} others`);
  // Borders: a picture that reaches its border may be cut off.
  let cellEdge = 0, flameEdge = 0;
  for (let k = 0; k < 16; k++) {
    for (let i = 0; i < CELL; i++) {
      for (const [x, y] of [[i, 0], [i, CELL - 1], [0, i], [CELL - 1, i]]) if (sheet[y * CATCH_W + k * CELL + x]) cellEdge++;
    }
  }
  const cells = (FLAME_FRAMES + 1) * FLAME_HEADINGS;
  let flamePixels = 0, least = Infinity;
  for (let n = 0; n < cells; n++) {
    const px = (n % FLAME_COLS) * FLAME, py = CELL + Math.floor(n / FLAME_COLS) * FLAME;
    let own = 0;
    for (let y = 0; y < FLAME; y++) {
      for (let x = 0; x < FLAME; x++) {
        if (!sheet[(py + y) * CATCH_W + px + x]) continue;
        own++;
        if (x === 0 || y === 0 || x === FLAME - 1 || y === FLAME - 1) flameEdge++;
      }
    }
    flamePixels += own;
    least = Math.min(least, own);
  }
  say(cellEdge === 0, `no cell picture reaches its border (${cellEdge} pixels on one)`);
  say(flameEdge === 0, `no flame picture reaches its border (${flameEdge} pixels on one; ${cells} pictures, ${(flamePixels / cells).toFixed(1)} pixels each on average, the smallest ${least})`);
  say(least > 0, "every flame picture has a flame in it");
  const bytes = CATCH_W * CATCH_H * 4;
  say(SPRITE_BYTES_MAX + TILE_POOL <= CAP, `canvas memory: the catch-up sheet ${bytes} B; the sprites' cap ${SPRITE_BYTES_MAX} B + the tile pool ${TILE_POOL} B = ${SPRITE_BYTES_MAX + TILE_POOL} B, against ${CAP}`);
  return ok;
}

// ---- the contact sheet (headless Chrome) -----------------------------------------------------

const run = promisify(execFile);
const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const PAGE = path.join("tools", "debug", "fx-sheet");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";
const SESSION = `fx-sheet-${process.pid}`;
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
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 120_000, maxBuffer: 64 << 20 });
  return stdout.trim();
}

/** Build and serve the page, open a browser on it; `query` by `query`, wait until the page is done and hand its result to `each`. */
async function page(queries: string[], each: (query: string) => Promise<void>): Promise<void> {
  const dist = mkdtempSync(path.join(tmpdir(), "fx-sheet-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error("building the sheet's page ...");
  await run(VITE, ["build", path.join(ROOT, PAGE), "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const url = await serve(dist);
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  for (const query of queries) {
    await ab(["open", `${url}/${query}`]);
    const deadline = Date.now() + 120_000;
    while ((await ab(["eval", "window.fxSheet && window.fxSheet.done ? 1 : 0"])) !== "1") {
      if (Date.now() > deadline) throw new Error("the sheet's page did not finish");
      await sleep(200);
    }
    await each(query);
  }
}

async function contact(out: string): Promise<void> {
  await page([""], async () => {
    const png = JSON.parse(await ab(["eval", "document.getElementById('sheet').toDataURL('image/png')"])) as string;
    console.log(save(out, Buffer.from(png.slice(png.indexOf(",") + 1), "base64")));
    console.log(await ab(["eval", "JSON.stringify(window.fxSheet)"]));
  });
}

interface Stat { p50: number; p95: number; max: number }
interface Timed { kind: string; isolated: boolean; userAgent: string; frames: number; on: Stat; off: Stat; costs: number }

async function timing(): Promise<void> {
  const reps = arg("--reps") ?? "7";
  const kinds = (arg("--canvas") ?? "soft,gpu").split(",");
  console.log(`# What the catch-up visuals cost a frame (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
  console.log(`A pack of six through Rust Bowl's first bend, the race HUD; the catch-up fields filled (three cars in a slipstream, three boosting, six cells, the HUD's two cues) and absent in turn; ${reps} rounds of 600 frames each after a warm-up round. ms; a frame is Renderer.frame() with a 1x1 read-back. "soft" = a canvas in main memory (CPU raster), "gpu" = the browser's own.\n`);
  console.log("| Canvas | fields absent: median / p95 / max | fields filled: median / p95 / max | the visuals cost (median) |");
  console.log("|---|---:|---:|---:|");
  let agent = "";
  await page(kinds.map((k) => `?${new URLSearchParams({ time: k, reps })}`), async () => {
    const o = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.fxSheet)"])) as string) as Timed;
    if (!o.isolated) console.error("warning: the page is not cross-origin isolated: a 100 us timer");
    agent = o.userAgent;
    const f = (x: number) => x.toFixed(3);
    console.log(`| ${o.kind} | ${f(o.off.p50)} / ${f(o.off.p95)} / ${f(o.off.max)} | ${f(o.on.p50)} / ${f(o.on.p95)} / ${f(o.on.max)} | ${o.costs >= 0 ? "+" : ""}${f(o.costs)} |`);
  });
  console.log(`\n${agent}`);
}

// ---- main ----------------------------------------------------------------------------------------

if (args.includes("--check")) {
  if (!check()) process.exit(1);
} else if (args.includes("--sprites")) {
  console.log(save(arg("--out") ?? path.join(ROOT, "tmp", "m4-fx", "sprites.png"), sprites().png()));
} else {
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  try {
    if (args.includes("--time")) await timing();
    else await contact(arg("--out") ?? path.join(ROOT, "tmp", "m4-fx", "contact-sheet.png"));
  } finally {
    await cleanup();
  }
}
