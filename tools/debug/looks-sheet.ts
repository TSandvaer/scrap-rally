// The cars' looks on paper: contact sheets as PNG files and a check of what the sheets
// promise, made in Node from client/gfx/sprites.ts (no browser, no canvas).
//
//   npx tsx tools/debug/looks-sheet.ts                    the contact sheet -> tmp/m4-looks/contact-sheet.png
//   npx tsx tools/debug/looks-sheet.ts --out file.png     ... somewhere else
//   npx tsx tools/debug/looks-sheet.ts --zoom racer       one look large (8x): 16 headings, the three states
//   npx tsx tools/debug/looks-sheet.ts --check            no picture: the checks below, exit code 1 if one fails
//   npx tsx tools/debug/looks-sheet.ts --check --ref main ... and the sport against that ref's one car, bit for bit
//
// The contact sheet: every look in the six server colours, whole, battered and burnt, on
// tarmac and on dirt (4x); a strip of 16 headings a look (2x: the size on a 1280x720 window);
// the three looks side by side at 2x and at 1x.
//
// The checks:
// - every look lies inside the sport's box (|u| <= 12, |v| <= 7.6 view pixels: the hit shape's
//   30 x 16 world units with the tyres standing 1.2 px out, as the sport's always did);
// - the body tone of every sheet is the server's colour itself, and how common it is;
// - every pixel of a battered and a burnt sheet outside the car's own pixels is empty (the
//   silhouette, the cast shadow, is the whole car's);
// - with --ref: the sport's whole, battered and burnt sheets, its silhouette and the effect
//   sheet are the ref's, bit for bit (the ref's damage and wreck were laid over its car).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { FONT_LETTERS, SMALL } from "../../client/gfx/font";
import { CAR_COLORS, P, rgbOf } from "../../client/gfx/palette";
import { BURNT, carIndexSheets, carPalette, carPixels, CELL, DENTED, fxPixels, HEADINGS, LOOKS, shadePixels, SHEET_H, SHEET_W, WHOLE } from "../../client/gfx/sprites";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STATES = [WHOLE, DENTED, BURNT];
const STATE_NAMES = ["WHOLE", "BATTERED (HP UNDER 40%)", "BURNT (WRECK)"];
const SHADOW = 0.38; // sprites.ts SHADOW_ALPHA
const N = SHEET_W * SHEET_H;

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
  ground(x: number, y: number, w: number, h: number, scale: number, tones: [string, string, string]): void {
    for (let j = 0; j < h; j += scale) {
      for (let i = 0; i < w; i += scale) {
        let k = Math.imul((x + i) / scale, 374761393) ^ Math.imul((y + j) / scale, 668265263);
        k = Math.imul(k ^ (k >>> 13), 1274126177);
        const r = ((k ^ (k >>> 16)) >>> 0) % 100;
        this.rect(x + i, y + j, Math.min(scale, w - i), Math.min(scale, h - j), r < 7 ? tones[0] : r > 91 ? tones[2] : tones[1]);
      }
    }
  }

  /** Cell k of a sheet (0xAABBGGRR words), its middle at (cx, cy), `scale` times its size, at `alpha`; (dx, dy): moved by view pixels. */
  cell(sheet: Uint32Array, k: number, cx: number, cy: number, scale: number, alpha = 1, dx = 0, dy = 0): void {
    const ox = (k % 16) * CELL, oy = Math.floor(k / 16) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const v = sheet[(oy + y) * SHEET_W + ox + x];
        if (!(v >>> 24)) continue;
        const px = cx + (x - CELL / 2 + dx) * scale, py = cy + (y - CELL / 2 + dy) * scale;
        for (let j = 0; j < scale; j++) {
          for (let i = 0; i < scale; i++) {
            if (px + i < 0 || py + j < 0 || px + i >= this.w || py + j >= this.h) continue;
            const o = ((py + j) * this.w + px + i) * 4;
            // The canvas's own rounding of a blend.
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
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
}

const TARMAC: [string, string, string] = [P.tar0, P.tar1, P.tar2];
const DIRT: [string, string, string] = [P.dirt1, P.dirt2, P.dirt3];
const GROUNDS = [TARMAC, DIRT];

const sheets = new Map<string, Uint32Array>();
const sheet = (look: number, color: string, state: number) => {
  const key = `${look}${color}${state}`;
  let s = sheets.get(key);
  if (!s) sheets.set(key, (s = carPixels(color, new Uint32Array(N), look, state)));
  return s;
};
const shades = LOOKS.map((_, look) => shadePixels(new Uint32Array(N), look));

/** A car on the ground as the game draws it: its shadow 2 and 3 view pixels down-right (3 and 4 world units at the 0.8 zoom), then the car. */
function carAt(pic: Picture, look: number, color: string, state: number, k: number, cx: number, cy: number, scale: number): void {
  pic.cell(shades[look], k, cx, cy, scale, SHADOW, 2, 3);
  pic.cell(sheet(look, color, state), k, cx, cy, scale);
}

// ---- the contact sheet -------------------------------------------------------------------

function contactSheet(): Picture {
  const LEFT = 16, GUT = 12;
  const CW = 30 * 4, CH = 22 * 4; // a 4x cell of the states' grid: the car facing right needs 26 x 17 view pixels
  const half = CAR_COLORS.length * CW;
  const W = LEFT * 2 + half * 2 + GUT;
  const title = 30, rowLabel = 20;
  const gridH = LOOKS.length * (title + STATES.length * (CH + rowLabel)) + 8;
  const stripH = LOOKS.length * (64 + 6) * 2 + title + 8;
  const lineH = title + 2 * (64 + 8) + 2 * (32 + 8) + 20;
  const pic = new Picture(W, 44 + gridH + stripH + lineH + 16, P.soot1);
  pic.text("SCRAP RALLY - M4-LOOKS: SPORT, RACER, TRUCK", LEFT, 12, P.bone2, 3);
  let y = 52;

  // The states: a block a look, a row a state, the six colours on tarmac and again on dirt. 4x.
  LOOKS.forEach((name, look) => {
    pic.text(`${name.toUpperCase()}  (4x, facing right; left: tarmac, right: dirt)`, LEFT, y + 6, P.rust3, 2);
    y += title;
    STATES.forEach((state, row) => {
      pic.text(STATE_NAMES[row], LEFT, y + 2, P.bone0, 2);
      y += rowLabel;
      GROUNDS.forEach((ground, g) => {
        const x0 = LEFT + g * (half + GUT);
        pic.ground(x0, y, half, CH, 4, ground);
        CAR_COLORS.forEach((color, c) => carAt(pic, look, color, state, 0, x0 + c * CW + CW / 2, y + CH / 2, 4));
      });
      y += CH;
    });
  });
  y += 8;

  // The headings: 16 of the 128, at 2x, a strip on tarmac and one on dirt a look.
  pic.text("16 OF THE 128 HEADINGS  (2x: the size in a 1280x720 window)", LEFT, y + 6, P.rust3, 2);
  y += title;
  LOOKS.forEach((_, look) => {
    GROUNDS.forEach((ground, g) => {
      pic.ground(LEFT, y, 16 * 64, 64, 2, ground);
      for (let n = 0; n < 16; n++) carAt(pic, look, CAR_COLORS[(look * 2 + g + n) % CAR_COLORS.length], WHOLE, (n * HEADINGS) / 16, LEFT + n * 64 + 32, y + 32, 2);
      // Beside the strip: the look battered and burnt at two more headings.
      const x1 = LEFT + 16 * 64 + GUT;
      pic.ground(x1, y, W - LEFT - x1, 64, 2, ground);
      [DENTED, BURNT, DENTED, BURNT, DENTED, BURNT].forEach((state, n) => carAt(pic, look, CAR_COLORS[(look + n * 2 + g * 3) % CAR_COLORS.length], state, [116, 116, 20, 20, 72, 72][n], x1 + 40 + n * 68, y + 32, 2));
      y += 64 + 6;
    });
  });
  y += 8;

  // Which is which at a glance: the three side by side in every colour, at 2x and at 1x.
  pic.text("WHICH IS WHICH: SPORT, RACER, TRUCK IN EACH COLOUR  (2x, then 1x)", LEFT, y + 6, P.rust3, 2);
  y += title;
  for (const scale of [2, 1]) {
    GROUNDS.forEach((ground) => {
      const step = 34 * scale, h = 32 * scale;
      pic.ground(LEFT, y, W - LEFT * 2, h, scale, ground);
      CAR_COLORS.forEach((color, c) => {
        LOOKS.forEach((_, look) => {
          const n = c * LOOKS.length + look;
          carAt(pic, look, color, WHOLE, n % 2 ? 122 : 0, LEFT + 24 * scale + n * step + c * 10 * scale, y + h / 2, scale);
        });
      });
      y += h + 8;
    });
  }
  return pic;
}

/** One look large: 16 headings at 8x in one colour, then its three states in two more. */
function zoomSheet(look: number): Picture {
  const S = 8, C = CELL * S;
  const pic = new Picture(8 * C + 32, 3 * C + 64, P.soot1);
  pic.text(`${LOOKS[look].toUpperCase()} AT 8x`, 16, 10, P.bone2, 3);
  GROUNDS.forEach((ground, g) => {
    pic.ground(16, 48 + g * C, 8 * C, C, S, ground);
    for (let n = 0; n < 8; n++) carAt(pic, look, CAR_COLORS[g ? 1 : 0], WHOLE, ((n + g * 8) * HEADINGS) / 16 + (g ? 4 : 0), 16 + n * C + C / 2, 48 + g * C + C / 2, S);
  });
  pic.ground(16, 48 + 2 * C, 8 * C, C, S, TARMAC);
  [WHOLE, DENTED, BURNT, WHOLE, DENTED, BURNT, DENTED, BURNT].forEach((state, n) => carAt(pic, look, CAR_COLORS[2 + ((n / 3) | 0)], state, n < 6 ? 0 : 108, 16 + n * C + C / 2, 48 + 2 * C + C / 2, S));
  return pic;
}

// ---- the checks --------------------------------------------------------------------------

async function check(): Promise<number> {
  let failed = 0;
  const say = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failed++;
  };
  const SERVER = /const COLORS = \[(.*?)\]/s.exec(execFileSync("git", ["show", "HEAD:server/room.ts"], { cwd: HERE, encoding: "utf8" }))![1].match(/#[0-9a-f]{6}/g)!;
  say(SERVER.join() === CAR_COLORS.join(), `the six colours are server/room.ts COLORS: ${SERVER.join(" ")}`);

  LOOKS.forEach((name, look) => {
    const idx = carIndexSheets(look);
    // The box of the car facing right (cell 0), from the cell's middle, the outline left out (tone 1).
    let u0 = 99, u1 = -99, v1 = 0, own = 0;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const t = idx.car[y * SHEET_W + x];
        if (t < 2) continue;
        own++;
        u0 = Math.min(u0, x - CELL / 2);
        u1 = Math.max(u1, x + 1 - CELL / 2);
        v1 = Math.max(v1, Math.abs(y + 0.5 - CELL / 2) + 0.5);
      }
    }
    say(u0 >= -12 && u1 <= 12 && v1 <= 8, `${name}: facing right it covers u ${u0} to ${u1}, |v| up to ${v1} view pixels (${own} pixels; the sport's box is -12 to 12 and 8)`);
    // No cell touches its border: the car and its outline fit the 32 x 32 cell at every heading.
    let edge = 0, stray = 0;
    for (let i = 0; i < N; i++) {
      const x = i % CELL, y = Math.floor(i / SHEET_W) % CELL;
      if (idx.car[i] && (x === 0 || y === 0 || x === CELL - 1 || y === CELL - 1)) edge++;
      if (!idx.car[i] && (idx.dents[i] || idx.burnt[i])) stray++;
    }
    say(edge === 0, `${name}: no pixel on a cell's border in 128 headings (${edge})`);
    say(stray === 0, `${name}: damage and wreck only on the car's own pixels (${stray} outside)`);
    for (const color of CAR_COLORS) {
      const px = sheet(look, color, WHOLE);
      const count = new Map<number, number>();
      for (let i = 0; i < N; i++) if (px[i] >>> 24) count.set(px[i], (count.get(px[i]) ?? 0) + 1);
      const ranked = [...count].sort((a, b) => b[1] - a[1]);
      const [r, g, b] = rgbOf(color);
      const body = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      const place = ranked.findIndex(([v]) => v === body);
      const total = ranked.reduce((s, [, n]) => s + n, 0);
      say(carPalette(color)[5] === body && place === 0, `${name} ${color}: the body tone is the server colour; it is the most common pixel of the sheet (place ${place + 1} of ${ranked.length} colours, ${count.get(body) ?? 0} of ${total} pixels)`);
    }
  });

  const ref = arg("--ref");
  if (ref) {
    // The ref's sprites.ts and palette.ts side by side in a temp folder, the import of shared/ pointed back here.
    const dir = mkdtempSync(join(tmpdir(), "looks-ref-"));
    try {
      const show = (file: string) => execFileSync("git", ["show", `${ref}:${file}`], { cwd: HERE, encoding: "utf8" });
      writeFileSync(join(dir, "palette.ts"), show("client/gfx/palette.ts"));
      writeFileSync(join(dir, "sprites.ts"), show("client/gfx/sprites.ts").replace('"../../shared/protocol"', JSON.stringify(pathToFileURL(join(HERE, "shared/protocol.ts")).href)));
      const old = await import(pathToFileURL(join(dir, "sprites.ts")).href);
      const same = (a: Uint32Array, b: Uint32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
      if (old.dentPixels) {
        const dents: Uint32Array = old.dentPixels(), burnt: Uint32Array = old.burntPixels();
        for (const color of [...CAR_COLORS, "#888"]) {
          const car: Uint32Array = old.carPixels(color);
          const under = (o: Uint32Array) => car.map((v, i) => (o[i] >>> 24 ? o[i] : v));
          say(same(car, sheet(0, color, WHOLE)) && same(under(dents), sheet(0, color, DENTED)) && same(under(burnt), sheet(0, color, BURNT)), `sport ${color}: whole, battered and burnt are ${ref}'s, bit for bit`);
        }
        say(same(old.shadePixels(), shades[0]), `sport: the silhouette is ${ref}'s`);
      } else {
        for (const [l, name] of LOOKS.entries()) for (const color of CAR_COLORS) for (const s of STATES) say(same(old.carPixels(color, new Uint32Array(N), l, s), sheet(l, color, s)), `${name} ${color} state ${s}: as at ${ref}`);
        for (const [l, name] of LOOKS.entries()) say(same(old.shadePixels(new Uint32Array(N), l), shades[l]), `${name}: the silhouette is ${ref}'s`);
      }
      say(same(old.fxPixels(), fxPixels()), `the effect sheet is ${ref}'s`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  return failed ? 1 : 0;
}

// ---- main --------------------------------------------------------------------------------

if (args.includes("--check")) process.exit(await check());
const zoom = arg("--zoom");
const look = zoom ? LOOKS.indexOf(zoom as (typeof LOOKS)[number]) : -1;
if (zoom && look < 0) {
  console.error(`--zoom: one of ${LOOKS.join(", ")}`);
  process.exit(2);
}
const out = resolve(arg("--out") ?? join(HERE, "tmp/m4-looks", zoom ? `zoom-${zoom}.png` : "contact-sheet.png"));
mkdirSync(dirname(out), { recursive: true });
const pic = zoom ? zoomSheet(look) : contactSheet();
writeFileSync(out, pic.png());
console.log(`${out}  (${pic.w} x ${pic.h})`);
