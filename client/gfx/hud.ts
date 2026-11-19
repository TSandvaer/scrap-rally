// The HUD, in view pixels (identity transform): name tags over the other cars, the minimap
// (its box at VIEW_W - 112 is fixed: client/audio.ts and client/chat.ts lay out around it)
// and the text panels (lap / position, time, notice, countdown, banner strip, corner, debug).
//
// Everything is baked: a text is printed once with the bitmap font (client/gfx/font.ts) into
// a small canvas of its own, a label, with its panel, and a frame copies the label. A label
// is filled again only when its text changes (the race time ten times a second). A text the
// font does not cover (a name in another script) is written into its label with the system
// font, that label only. The minimap's box, frame, track line and start tick are baked once
// per track. All of it in palette colours, hard pixels, no alpha.
//
// A frame allocates nothing here: labels, tags and the countdown's texts are fixed pools.

import { pointAt, type Track, type Vec } from "../../shared/track";
import type { CarView, HudView } from "../render";
import { artCanvas, BOLD, covers, print, SMALL, TALL, widthOf, type Strike } from "./font";
import { P, rgbOf } from "./palette";
import { groundRuns, VIEW_H, VIEW_W, ZOOM } from "./world";

// A panel: today's HUD background colour, now solid, lit from the top left like the world.
const FACE = P.soot1;
const LIT = P.dirt0;
const DARK = P.soot0;
const TEXT = P.bone2;
const ACCENT = P.rust3;
const SYS = "ui-monospace, Menlo, monospace"; // a text the font does not cover

/**
 * The size table. `cut` x `scale` is the bitmap text; `sys` is what the element was drawn
 * with before, and still is when the font does not cover a text. Capital height in view
 * pixels, before (measured in Chrome on macOS: 0.73 of the font size) and now:
 *
 *   name tag                  bold 9 px    6.6   BOLD        7
 *   corner, debug             9 px         6.6   SMALL       7
 *   notice                    bold 10 px   7.3   TALL        9
 *   lap lines, banner         bold 11 px   8.0   TALL        9
 *   line under the countdown  bold 12 px   8.8   TALL        9
 *   race time                 bold 13 px   9.5   SMALL x 2  14
 *   countdown                 bold 52 px  37.9   TALL x 5   45
 */
interface Style {
  cut: Strike;
  scale: number;
  color: string;
  sys: string;
  /** Height of the label; a panel is this high. */
  h: number;
  /** Air left and right of the text inside its panel. */
  pad: number;
  boxed: boolean;
}

const TAG: Style = { cut: BOLD, scale: 1, color: TEXT, sys: `bold 9px ${SYS}`, h: 12, pad: 3, boxed: false };
const LINE: Style = { cut: TALL, scale: 1, color: TEXT, sys: `bold 11px ${SYS}`, h: TALL.ch, pad: 0, boxed: false };
const LINE_TOP: Style = { ...LINE, color: ACCENT };
const TIME: Style = { cut: SMALL, scale: 2, color: TEXT, sys: `bold 13px ${SYS}`, h: 20, pad: 7, boxed: true };
const NOTICE: Style = { cut: TALL, scale: 1, color: ACCENT, sys: `bold 10px ${SYS}`, h: 15, pad: 6, boxed: true };
const SUB: Style = { cut: TALL, scale: 1, color: TEXT, sys: `bold 12px ${SYS}`, h: 20, pad: 8, boxed: true };
const BANNER: Style = { cut: TALL, scale: 1, color: TEXT, sys: `bold 11px ${SYS}`, h: 20, pad: 0, boxed: false };
const CORNER: Style = { cut: SMALL, scale: 1, color: P.bone0, sys: `9px ${SYS}`, h: SMALL.ch + 2, pad: 1, boxed: false };
const DEBUG: Style = { cut: SMALL, scale: 1, color: P.green, sys: `9px ${SYS}`, h: SMALL.ch, pad: 0, boxed: false };
const BIG = 5; // the countdown: the tall cut five times
const BIG_SYS = `bold 52px ${SYS}`;
const BIG_IN = 2; // air left of and above the countdown's text in its label (its outline) ...
const BIG_OUT = 5; // ... and right of and below it (outline and cast shadow)
const BIG_H = TALL.ch * BIG + BIG_IN + BIG_OUT;

// The top-left panel: lap / position lines 14 px apart, the hp bar under them.
const TL_X = 6, TL_Y = 6, TL_W = 118, TL_PITCH = 14, TL_LINES = 7;
const BAR_W = 104, BAR_H = 5, BAR_TICK = 13; // the bar's inside; a tick every eighth

// The minimap: its box (fixed) and the 96 px square the track is fitted into.
const MAP = 108, MAP_X = VIEW_W - 112, MAP_Y = 4, MAP_FIT = 96;

class Label {
  readonly g: CanvasRenderingContext2D;
  /** What it holds; null = nothing yet. */
  text: string | null = null;
  w = 0;
  // A tag also depends on its car's colour; a pooled label remembers when it was last used.
  color = "";
  used = 0;
  constructor(
    w: number,
    h: number,
    /** In main memory, as its view canvas (font.ts artCanvas). */
    readonly soft: boolean,
  ) {
    this.g = artCanvas(w, h, soft);
  }
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  g.fillStyle = FACE;
  g.fillRect(x, y, w, h);
  g.fillStyle = LIT;
  g.fillRect(x, y, w, 1);
  g.fillRect(x, y, 1, h);
  g.fillStyle = DARK;
  g.fillRect(x, y + h - 1, w, 1);
  g.fillRect(x + w - 1, y, 1, h);
}

/** The row of a label where the capital height starts: the text is centred in the label's height. */
function capRow(st: Style): number {
  return Math.round((st.h - st.cut.cap * st.scale) / 2);
}

/**
 * Write a text into a label from column x, its capitals centred in the label's height (dy
 * rows lower): with the bitmap font, or with the system font when the font does not cover it.
 */
function ink(l: Label, text: string, st: Style, x: number, inFont: boolean, color: string, dy = 0): void {
  const g = l.g;
  const top = capRow(st) + dy;
  if (inFont) print(g, l.soft, text, x, top - st.cut.capTop * st.scale, st.cut, color, st.scale);
  else {
    g.font = st.sys;
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(text, x, top + (st.cut.cap * st.scale) / 2);
  }
}

function measure(g: CanvasRenderingContext2D, text: string, st: Style, inFont: boolean): number {
  if (inFont) return widthOf(text, st.cut, st.scale);
  g.font = st.sys;
  return Math.ceil(g.measureText(text).width);
}

/** Fill a label: the text, in its panel when the style has one. */
function write(l: Label, text: string, st: Style): void {
  const g = l.g;
  const inFont = covers(text);
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  const w = Math.min(g.canvas.width, measure(g, text, st, inFont) + 2 * st.pad);
  if (st.boxed) panel(g, 0, 0, w, st.h);
  ink(l, text, st, st.pad, inFont, st.color);
  l.text = text;
  l.w = w;
}

/** A name tag: the name on a plate, the car's colour as its bottom line. */
function writeTag(l: Label, name: string, color: string): void {
  const g = l.g;
  const inFont = covers(name);
  g.clearRect(0, 0, g.canvas.width, TAG.h);
  const w = Math.min(g.canvas.width, measure(g, name, TAG, inFont) + 2 * TAG.pad);
  g.fillStyle = FACE;
  g.fillRect(0, 0, w, TAG.h - 1);
  g.fillStyle = LIT;
  g.fillRect(0, 0, w, 1);
  g.fillRect(0, 0, 1, TAG.h - 1);
  g.fillStyle = DARK;
  g.fillRect(w - 1, 0, 1, TAG.h - 1);
  g.fillStyle = color;
  g.fillRect(0, TAG.h - 1, w, 1);
  // The 11 rows above the colour line are the font's cell: marks, capitals, descenders.
  if (inFont) print(g, l.soft, name, TAG.pad, 0, TAG.cut, TEXT);
  else ink(l, name, TAG, TAG.pad, false, TEXT);
  l.text = name;
  l.color = color;
  l.w = w;
}

/** The strip along the bottom: the whole width, the text centred. */
function writeBanner(l: Label, text: string): void {
  const g = l.g;
  const inFont = covers(text);
  g.fillStyle = FACE;
  g.fillRect(0, 0, VIEW_W, BANNER.h);
  g.fillStyle = LIT;
  g.fillRect(0, 0, VIEW_W, 1);
  g.fillStyle = DARK;
  g.fillRect(0, BANNER.h - 1, VIEW_W, 1);
  ink(l, text, BANNER, Math.round((VIEW_W - measure(g, text, BANNER, inFont)) / 2), inFont, TEXT);
  l.text = text;
  l.w = VIEW_W;
}

/** The small text in the corner, over the world: outlined, so it reads on any ground. */
function writeCorner(l: Label, text: string): void {
  const g = l.g;
  const inFont = covers(text);
  g.clearRect(0, 0, g.canvas.width, CORNER.h);
  const w = Math.min(g.canvas.width, measure(g, text, CORNER, inFont) + 2);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) if (dx || dy) ink(l, text, CORNER, 1 + dx, inFont, DARK, dy);
  }
  ink(l, text, CORNER, 1, inFont, CORNER.color);
  l.text = text;
  l.w = w;
}

/** The countdown: big, with a sunlit and a shaded rim, a dark outline and a hard cast shadow. */
function writeBig(l: Label, text: string): void {
  const g = l.g;
  g.clearRect(0, 0, g.canvas.width, BIG_H);
  if (covers(text)) {
    const at = BIG_IN;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) print(g, l.soft, text, at + dx, at + dy, TALL, P.soot1, BIG);
    print(g, l.soft, text, at + 3, at + 3, TALL, P.soot1, BIG);
    print(g, l.soft, text, at + 4, at + 4, TALL, P.soot1, BIG);
    print(g, l.soft, text, at + 1, at + 1, TALL, P.rust1, BIG);
    print(g, l.soft, text, at - 1, at - 1, TALL, P.blast, BIG);
    print(g, l.soft, text, at, at, TALL, ACCENT, BIG);
    l.w = Math.min(g.canvas.width, widthOf(text, TALL, BIG) + BIG_IN + BIG_OUT);
  } else {
    g.font = BIG_SYS;
    g.textAlign = "left";
    g.textBaseline = "middle";
    const mid = BIG_IN + (TALL.capTop + TALL.cap / 2) * BIG;
    g.fillStyle = P.soot1;
    g.fillText(text, BIG_IN + 3, mid + 3);
    g.fillStyle = ACCENT;
    g.fillText(text, BIG_IN, mid);
    l.w = Math.min(g.canvas.width, Math.ceil(g.measureText(text).width) + BIG_IN + BIG_OUT);
  }
  l.text = text;
}

/** A pool of labels of one kind, the least recently used one refilled for a new text. */
class Pool {
  private readonly all: Label[] = [];
  private clock = 0;
  constructor(
    private readonly cap: number,
    private readonly w: number,
    private readonly h: number,
    private readonly soft: boolean,
  ) {}

  /** The label holding this text (and colour), or null: then take() one and fill it. */
  find(text: string, color: string): Label | null {
    const all = this.all;
    for (let i = 0; i < all.length; i++) {
      const l = all[i];
      if (l.text === text && l.color === color) {
        l.used = ++this.clock;
        return l;
      }
    }
    return null;
  }

  take(): Label {
    const all = this.all;
    let l: Label;
    if (all.length < this.cap) {
      l = new Label(this.w, this.h, this.soft);
      all.push(l);
    } else {
      l = all[0];
      for (let i = 1; i < all.length; i++) if (all[i].used < l.used) l = all[i];
    }
    l.used = ++this.clock;
    return l;
  }
}

interface Mini {
  canvas: HTMLCanvasElement;
  scale: number;
  ox: number;
  oy: number;
}

/**
 * Everything baked, for one kind of view canvas (soft: in main memory). A page has one kit;
 * the benchmark's page has two, the game's own canvas and the one it reads back. Every Hud
 * of a kind shares it, so a new Renderer (a new track) bakes nothing but its minimap.
 */
interface Kit {
  soft: boolean;
  tags: Pool; // name tags, by name and colour: 16
  bigs: Pool; // the countdown's texts (3, 2, 1, GO!, PAUSED): 6
  lines: Label[]; // the top-left lines, one label a line
  tlBack: Label; // the top-left panel itself, with the hp bar's well
  tlKey: number; // ... as baked: lines * 2 + (hp bar ? 1 : 0)
  bars: HTMLCanvasElement; // the hp bar full, in green, amber and red, ticks and all
  time: Label;
  notice: Label;
  sub: Label;
  banner: Label;
  corner: Label;
  debug: Label[];
  minis: WeakMap<Track, Mini>;
}

const kits: (Kit | null)[] = [null, null];

function kitOf(soft: boolean): Kit {
  return (kits[soft ? 1 : 0] ??= {
    soft,
    tags: new Pool(16, 128, TAG.h, soft),
    bigs: new Pool(6, 8 * TALL.cw * BIG + BIG_IN + BIG_OUT, BIG_H, soft),
    lines: [],
    tlBack: new Label(TL_W, 10 + TL_LINES * TL_PITCH + 12, soft),
    tlKey: -1,
    bars: bakeBars(soft),
    time: new Label(10 * SMALL.cw * TIME.scale + 2 * TIME.pad, TIME.h, soft),
    notice: new Label(320, NOTICE.h, soft),
    sub: new Label(480, SUB.h, soft),
    banner: new Label(VIEW_W, BANNER.h, soft),
    corner: new Label(96, CORNER.h, soft),
    debug: [],
    minis: new WeakMap(),
  });
}

/** The hp bar's inside, full, three times: more than half (green), more than a quarter (amber), less (red). */
function bakeBars(soft: boolean): HTMLCanvasElement {
  const g = artCanvas(BAR_W, 3 * BAR_H, soft);
  const tones = [P.green, P.haz1, P.red], shades = [P.steel1, P.haz0, P.rust1];
  for (let k = 0; k < 3; k++) {
    g.fillStyle = tones[k];
    g.fillRect(0, k * BAR_H, BAR_W, BAR_H);
    g.fillStyle = shades[k];
    g.fillRect(0, k * BAR_H + BAR_H - 1, BAR_W, 1);
    g.fillStyle = DARK;
    for (let t = BAR_TICK; t < BAR_W; t += BAR_TICK) barTick(g, t, 0, k * BAR_H);
  }
  return g.canvas;
}

/** The hp bar's tick `t` pixels along, the bar's inside at (x, y): the lower two rows, the whole height at the half. */
function barTick(g: CanvasRenderingContext2D, t: number, x: number, y: number): void {
  if (t === BAR_W / 2) g.fillRect(x + t, y, 1, BAR_H);
  else g.fillRect(x + t, y + BAR_H - 2, 1, 2);
}

/** The top-left panel for `n` lines, with the hp bar's empty well under them. */
function writeTopLeft(k: Kit, n: number, bar: boolean): void {
  const g = k.tlBack.g;
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  panel(g, 0, 0, TL_W, 10 + n * TL_PITCH + (bar ? 12 : 0));
  if (bar) {
    // The well: 106 x 7 as before, sunk (its far edges catch the light), the ticks faint in it.
    const x = 12 - TL_X, y = 12 + n * TL_PITCH - TL_Y;
    g.fillStyle = DARK;
    g.fillRect(x, y, BAR_W + 2, BAR_H + 2);
    g.fillStyle = LIT;
    g.fillRect(x, y + BAR_H + 1, BAR_W + 2, 1);
    g.fillRect(x + BAR_W + 1, y, 1, BAR_H + 2);
    g.fillStyle = P.soot3;
    for (let t = BAR_TICK; t < BAR_W; t += BAR_TICK) barTick(g, t, x + 1, y + 1);
  }
  k.tlKey = n * 2 + (bar ? 1 : 0);
}

// ---- the minimap ----------------------------------------------------------------------

function word(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * The minimap of a track, baked once: the box with its frame, the track as a 2 px line in a
 * dark casing (broken where the road has a gap, for the gap's whole length), and the start
 * line as a tick across it. Hard pixels: the line is stamped along the centreline, not stroked.
 */
function miniOf(k: Kit, track: Track): Mini {
  let m = k.minis.get(track);
  if (m) return m;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of track.pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const scale = MAP_FIT / Math.max(maxX - minX, maxY - minY);
  const ox = VIEW_W - 10 - MAP_FIT + (MAP_FIT - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = 10 + (MAP_FIT - (maxY - minY) * scale) / 2 - minY * scale;

  const g = artCanvas(MAP, MAP, k.soft);
  const img = g.createImageData(MAP, MAP);
  const px = new Uint32Array(img.data.buffer);
  const lit = word(LIT), dark = word(DARK);
  px.fill(word(FACE));
  for (let i = 0; i < MAP; i++) {
    px[i] = px[i * MAP] = lit;
    px[(MAP - 1) * MAP + i] = px[i * MAP + MAP - 1] = dark;
  }
  // Map pixels from here on: the box's top-left corner is (0, 0).
  const mx = ox - MAP_X, my = oy - MAP_Y;
  // The two ends of the run being stamped (a gap's edges): a point and the unit vector along the
  // road there, pointing into the run at its head and out of it at its tail. `need` is how far
  // inside a pixel's middle must lie for the whole pixel to be inside.
  const head = { x: 0, y: 0, dx: 0, dy: 0, need: 0 }, tail = { x: 0, y: 0, dx: 0, dy: 0, need: 0 };
  /**
   * A 2 x 2 dot at a point of the map, or the 4 x 4 around it without its corners (the casing).
   * Near an end of its run (atHead, atTail) it stamps only the pixels that lie wholly inside the
   * run, so line and casing stop flat at a gap and the break is at least the gap's own length.
   */
  const dot = (x: number, y: number, casing: boolean, colour: number, atHead: boolean, atTail: boolean) => {
    const x0 = Math.round(x - 1), y0 = Math.round(y - 1);
    const a = casing ? -1 : 0, b = casing ? 2 : 1;
    for (let j = a; j <= b; j++) {
      for (let i = a; i <= b; i++) {
        if (casing && (i === a || i === b) && (j === a || j === b)) continue;
        const u = x0 + i, v = y0 + j;
        if (u <= 0 || u >= MAP - 1 || v <= 0 || v >= MAP - 1) continue;
        if (atHead && (u + 0.5 - head.x) * head.dx + (v + 0.5 - head.y) * head.dy < head.need) continue;
        if (atTail && (u + 0.5 - tail.x) * tail.dx + (v + 0.5 - tail.y) * tail.dy > -tail.need) continue;
        px[v * MAP + u] = colour;
      }
    }
  };
  /** Set an end from the run's end point p and the next point q along the road (q after p). */
  const end = (e: typeof head, p: Vec, q: Vec) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    e.dx = (q.x - p.x) / d;
    e.dy = (q.y - p.y) / d;
    e.need = (Math.abs(e.dx) + Math.abs(e.dy)) / 2;
  };
  const REACH = 4; // a casing stamp is 4 px wide: further from an end than this, nothing can cross it
  const runs = groundRuns(track);
  const closed = !track.gaps.length;
  for (const casing of [true, false]) {
    const colour = word(casing ? P.dirt0 : P.bone0);
    for (const run of runs) {
      const n = closed ? run.length : run.length - 1;
      let total = 0;
      for (let i = 0; i < n; i++) {
        const a = run[i], b = run[(i + 1) % run.length];
        total += Math.hypot(b.x - a.x, b.y - a.y) * scale;
      }
      if (!closed) {
        // The road's direction at each end, from the nearest point of the run that is not the end itself.
        const first = run[0], last = run[run.length - 1];
        let i = 1, j = run.length - 2;
        while (i < run.length - 1 && run[i].x === first.x && run[i].y === first.y) i++;
        while (j > 0 && run[j].x === last.x && run[j].y === last.y) j--;
        head.x = mx + first.x * scale;
        head.y = my + first.y * scale;
        end(head, first, run[i]);
        tail.x = mx + last.x * scale;
        tail.y = my + last.y * scale;
        end(tail, run[j], last);
      }
      let done = 0;
      for (let i = 0; i < n; i++) {
        const a = run[i], b = run[(i + 1) % run.length];
        const ax = mx + a.x * scale, ay = my + a.y * scale, bx = mx + b.x * scale, by = my + b.y * scale;
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len * 2));
        for (let k = 0; k <= steps; k++) {
          const along = done + (len * k) / steps;
          dot(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, casing, colour, !closed && along < REACH, !closed && total - along < REACH);
        }
        done += len;
      }
    }
  }
  // The start line: a bright tick across the track, 3 px either side of its middle.
  const s = pointAt(track, 0);
  const sx = mx + s.x * scale, sy = my + s.y * scale, nx = -Math.sin(s.h) * 3, ny = Math.cos(s.h) * 3;
  for (const casing of [true, false]) {
    for (let k = 0; k <= 12; k++) dot(sx + (nx * (k - 6)) / 6, sy + (ny * (k - 6)) / 6, casing, casing ? dark : word(P.bone2), false, false);
  }
  g.putImageData(img, 0, 0);
  m = { canvas: g.canvas, scale, ox, oy };
  k.minis.set(track, m);
  return m;
}

// ---- the HUD --------------------------------------------------------------------------

export class Hud {
  private readonly mini: Mini;
  private readonly kit: Kit;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
  ) {
    this.kit = kitOf(ctx.getContextAttributes?.().willReadFrequently !== false);
    this.mini = miniOf(this.kit, track);
  }

  /** A car's name over it; (vx, vy) is the camera in view pixels (whole numbers). */
  nameTag(c: CarView, vx: number, vy: number): void {
    const x = Math.round(VIEW_W / 2 + c.x * ZOOM - vx);
    const y = Math.round(VIEW_H / 2 + c.y * ZOOM - vy) - 20;
    if (x < -40 || x > VIEW_W + 40 || y < -20 || y > VIEW_H + 20) return;
    const tags = this.kit.tags;
    let l = tags.find(c.name, c.color);
    if (!l) {
      l = tags.take();
      writeTag(l, c.name, c.color);
    }
    this.ctx.drawImage(l.g.canvas, 0, 0, l.w, TAG.h, x - (l.w >> 1), y - 6, l.w, TAG.h);
  }

  minimap(cars: CarView[]): void {
    const ctx = this.ctx;
    const m = this.mini;
    ctx.drawImage(m.canvas, MAP_X, MAP_Y);
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c.me) continue;
      const x = Math.round(m.ox + c.x * m.scale), y = Math.round(m.oy + c.y * m.scale);
      ctx.fillStyle = DARK;
      ctx.fillRect(x - 2, y - 2, 5, 5);
      ctx.fillStyle = c.color;
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
    // The own dot last, on top: bigger, ringed in white, the white ringed dark.
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.me) continue;
      const x = Math.round(m.ox + c.x * m.scale), y = Math.round(m.oy + c.y * m.scale);
      ctx.fillStyle = DARK;
      ctx.fillRect(x - 3, y - 3, 8, 8);
      ctx.fillStyle = TEXT;
      ctx.fillRect(x - 2, y - 2, 6, 6);
      ctx.fillStyle = c.color;
      ctx.fillRect(x - 1, y - 1, 4, 4);
    }
  }

  hud(h: HudView): void {
    const ctx = this.ctx;
    const k = this.kit;
    const lines = Math.min(h.topLeft.length, TL_LINES);
    if (lines) {
      const hp = h.hp;
      const bar = hp !== null;
      if (k.tlKey !== lines * 2 + (bar ? 1 : 0)) writeTopLeft(k, lines, bar);
      const hgt = 10 + lines * TL_PITCH + (bar ? 12 : 0);
      ctx.drawImage(k.tlBack.g.canvas, 0, 0, TL_W, hgt, TL_X, TL_Y, TL_W, hgt);
      for (let i = 0; i < lines; i++) {
        if (i === k.lines.length) k.lines.push(new Label(TL_W - 12, LINE.h, k.soft));
        const l = k.lines[i], text = h.topLeft[i];
        if (l.text !== text) write(l, text, i === 0 ? LINE_TOP : LINE);
        // Capitals centred on the line's old middle (18 + 14 i).
        if (l.w) ctx.drawImage(l.g.canvas, 0, 0, l.w, LINE.h, 12, 18 + i * TL_PITCH - 4 - TALL.capTop, l.w, LINE.h);
      }
      if (hp !== null) {
        const w = Math.round(BAR_W * Math.max(0, Math.min(1, hp)));
        const zone = hp > 0.5 ? 0 : hp > 0.25 ? 1 : 2;
        if (w > 0) ctx.drawImage(k.bars, 0, zone * BAR_H, w, BAR_H, 13, 13 + lines * TL_PITCH, w, BAR_H);
      }
    }
    if (h.time) {
      const l = k.time;
      if (l.text !== h.time) write(l, h.time, TIME);
      ctx.drawImage(l.g.canvas, 0, 0, l.w, TIME.h, Math.round(VIEW_W / 2 - l.w / 2), 6, l.w, TIME.h);
    }
    if (h.notice) {
      const l = k.notice;
      if (l.text !== h.notice) write(l, h.notice, NOTICE);
      ctx.drawImage(l.g.canvas, 0, 0, l.w, NOTICE.h, Math.round(VIEW_W / 2 - l.w / 2), 29, l.w, NOTICE.h);
    }
    if (h.center) {
      let l = k.bigs.find(h.center, "");
      if (!l) {
        l = k.bigs.take();
        writeBig(l, h.center);
      }
      // Capitals centred on (VIEW_W / 2, VIEW_H / 2 - 20), as before.
      const tw = l.w - BIG_IN - BIG_OUT;
      const top = VIEW_H / 2 - 20 - ((TALL.cap * BIG) >> 1) - TALL.capTop * BIG - BIG_IN;
      ctx.drawImage(l.g.canvas, 0, 0, l.w, BIG_H, Math.round(VIEW_W / 2 - tw / 2) - BIG_IN, top, l.w, BIG_H);
      if (h.centerSub) {
        const s = k.sub;
        if (s.text !== h.centerSub) write(s, h.centerSub, SUB);
        ctx.drawImage(s.g.canvas, 0, 0, s.w, SUB.h, Math.round(VIEW_W / 2 - s.w / 2), VIEW_H / 2 + 14, s.w, SUB.h);
      }
    }
    if (h.banner) {
      const l = k.banner;
      if (l.text !== h.banner) writeBanner(l, h.banner);
      ctx.drawImage(l.g.canvas, 0, VIEW_H - 26);
    }
    if (h.corner) {
      const l = k.corner;
      if (l.text !== h.corner) writeCorner(l, h.corner);
      // Right edge at VIEW_W - 8, capitals centred on VIEW_H - 8, as before.
      ctx.drawImage(l.g.canvas, 0, 0, l.w, CORNER.h, VIEW_W - 8 - l.w + 1, VIEW_H - 8 - 3 - capRow(CORNER), l.w, CORNER.h);
    }
    const n = h.debug.length;
    if (n) {
      ctx.fillStyle = DARK;
      ctx.fillRect(6, VIEW_H - 40 - n * 11, 220, 6 + n * 11);
      for (let i = 0; i < n; i++) {
        if (i === k.debug.length) k.debug.push(new Label(VIEW_W - 10, DEBUG.h, k.soft)); // a long line runs to the view's edge
        const l = k.debug[i], text = h.debug[i];
        if (l.text !== text) write(l, text, DEBUG);
        if (l.w) ctx.drawImage(l.g.canvas, 0, 0, l.w, DEBUG.h, 10, VIEW_H - 34 - (n - 1 - i) * 11 - 11 - 3 - SMALL.capTop, l.w, DEBUG.h);
      }
    }
  }
}
