// Canvas 2D renderer at a fixed 640x360 internal resolution, scaled up pixelated by CSS.
// Scrapyard look: packed dirt, gravel verges, steel barriers, rust-and-bone kerbs, and
// piles of junk outside the walls.

import { CAR_LENGTH, CAR_WIDTH } from "../shared/physics";
import { pointAt, queryTrack, type Track } from "../shared/track";

export const VIEW_W = 640;
export const VIEW_H = 360;
const ZOOM = 0.8;

export interface CarView {
  id: string;
  x: number;
  y: number;
  h: number;
  color: string;
  name: string;
  me: boolean;
}

export interface HudView {
  topLeft: string[]; // lap / position lines
  time: string;
  center: string; // big countdown / status text
  centerSub: string;
  banner: string; // persistent strip at the bottom (spectating, reconnecting, ...)
  corner: string; // bottom-left small text (RTT)
  debug: string[];
}

interface Decor {
  kind: "cube" | "drum" | "tires";
  x: number;
  y: number;
  r: number;
  a: number;
  color: string;
}

const PAL = {
  dirt: "#5d4a35",
  wallDark: "#24282c",
  wallLight: "#7c858d",
  gravel: "#7b6a50",
  asphalt: "#3b3835",
  kerbA: "#c4532a",
  kerbB: "#ddd3bd",
  dash: "#8a8378",
  shadow: "rgba(0,0,0,0.38)",
  hudBg: "rgba(18,14,11,0.72)",
  hudText: "#efe6d2",
  accent: "#e8752d",
};

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noisePattern(
  ctx: CanvasRenderingContext2D,
  size: number,
  base: string,
  specks: [string, number][],
  seed: number,
): CanvasPattern {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const rnd = mulberry32(seed);
  for (const [color, count] of specks) {
    g.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const s = rnd() < 0.8 ? 1 : 2;
      g.fillRect(Math.floor(rnd() * size), Math.floor(rnd() * size), s, s);
    }
  }
  return ctx.createPattern(c, "repeat")!;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly path: Path2D;
  private readonly dirt: CanvasPattern;
  private readonly gravel: CanvasPattern;
  private readonly tarmac: CanvasPattern;
  private readonly decor: Decor[];
  private readonly mini: { scale: number; ox: number; oy: number; path: Path2D };
  readonly cam = { x: 0, y: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly track: Track,
  ) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;

    this.path = new Path2D();
    track.pts.forEach((p, i) => (i ? this.path.lineTo(p.x, p.y) : this.path.moveTo(p.x, p.y)));
    this.path.closePath();

    this.dirt = noisePattern(this.ctx, 96, PAL.dirt, [["#6a5640", 260], ["#4e3e2c", 220], ["#77634a", 60]], 1);
    this.gravel = noisePattern(this.ctx, 64, PAL.gravel, [["#8d7c61", 300], ["#655640", 260], ["#a29276", 40]], 2);
    this.tarmac = noisePattern(this.ctx, 64, PAL.asphalt, [["#45413d", 220], ["#33302d", 220]], 3);
    this.decor = this.makeDecor();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of track.pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const box = 96;
    const scale = box / Math.max(maxX - minX, maxY - minY);
    const ox = VIEW_W - 10 - box + (box - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = 10 + (box - (maxY - minY) * scale) / 2 - minY * scale;
    const mp = new Path2D();
    track.pts.forEach((p, i) => {
      const x = ox + p.x * scale, y = oy + p.y * scale;
      if (i) mp.lineTo(x, y);
      else mp.moveTo(x, y);
    });
    mp.closePath();
    this.mini = { scale, ox, oy, path: mp };
  }

  /** Junk piles scattered outside the barriers; seeded so every client sees the same yard. */
  private makeDecor(): Decor[] {
    const rnd = mulberry32(7);
    const out: Decor[] = [];
    const t = this.track;
    const colors = ["#7b3b2a", "#4f5b52", "#6d6a5c", "#8a5a2b", "#3f4a5c", "#6b2f2f"];
    for (let tries = 0; out.length < 170 && tries < 4000; tries++) {
      const s = rnd() * t.length;
      const p = pointAt(t, s);
      const side = rnd() < 0.5 ? -1 : 1;
      const off = t.wall + 22 + rnd() * 160;
      const x = p.x - Math.sin(p.h) * off * side;
      const y = p.y + Math.cos(p.h) * off * side;
      if (queryTrack(t, x, y).dist < t.wall + 18) continue;
      if (out.some((d) => Math.hypot(d.x - x, d.y - y) < 26)) continue;
      const k = rnd();
      out.push({
        kind: k < 0.45 ? "cube" : k < 0.75 ? "drum" : "tires",
        x,
        y,
        r: 8 + rnd() * 8,
        a: rnd() * Math.PI,
        color: colors[Math.floor(rnd() * colors.length)],
      });
    }
    return out;
  }

  /** Ease the camera toward a target (world coords). snap = jump straight there. */
  follow(x: number, y: number, dtMs: number, snap = false): void {
    if (snap) {
      this.cam.x = x;
      this.cam.y = y;
      return;
    }
    const k = 1 - Math.exp(-dtMs / 90);
    this.cam.x += (x - this.cam.x) * k;
    this.cam.y += (y - this.cam.y) * k;
  }

  frame(cars: CarView[], hud: HudView | null): void {
    const ctx = this.ctx;
    const cx = Math.round(this.cam.x * ZOOM) / ZOOM;
    const cy = Math.round(this.cam.y * ZOOM) / ZOOM;
    ctx.setTransform(ZOOM, 0, 0, ZOOM, VIEW_W / 2 - cx * ZOOM, VIEW_H / 2 - cy * ZOOM);

    // Ground
    ctx.fillStyle = this.dirt;
    ctx.fillRect(cx - VIEW_W / ZOOM, cy - VIEW_H / ZOOM, (2 * VIEW_W) / ZOOM, (2 * VIEW_H) / ZOOM);
    this.drawDecor(cx, cy);
    this.drawTrack();

    // Cars: shadows first so no car's shadow lands on another car.
    for (const c of cars) this.carShadow(c);
    for (const c of cars) this.car(c);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of cars) if (!c.me) this.nameTag(c, cx, cy);
    this.minimap(cars);
    if (hud) this.hud(hud);
  }

  private drawTrack(): void {
    const ctx = this.ctx;
    const t = this.track;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const stroke = (style: string | CanvasPattern, half: number, dash: number[] = []) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = half * 2;
      ctx.setLineDash(dash);
      ctx.lineCap = dash.length ? "butt" : "round"; // round caps would merge the dashes
      ctx.stroke(this.path);
    };
    stroke(PAL.wallDark, t.wall + 7);
    stroke(PAL.wallLight, t.wall + 4);
    stroke(PAL.wallDark, t.wall + 2);
    stroke(this.gravel, t.wall);
    stroke(PAL.kerbB, t.def.halfWidth + 5);
    stroke(PAL.kerbA, t.def.halfWidth + 5, [22, 22]);
    stroke(this.tarmac, t.def.halfWidth);
    ctx.lineCap = "butt";
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = PAL.dash;
    ctx.lineWidth = 2;
    ctx.setLineDash([18, 26]);
    ctx.stroke(this.path);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Start/finish: a checkered strip across the road at s = 0.
    const p = pointAt(t, 0);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.h);
    const sq = 8;
    const hw = t.def.halfWidth;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i * sq < hw * 2; i++) {
        ctx.fillStyle = (i + row) % 2 ? "#1c1c1c" : "#f1ece0";
        ctx.fillRect(-sq + row * sq, -hw + i * sq, sq, Math.min(sq, hw * 2 - i * sq));
      }
    }
    ctx.restore();
  }

  private drawDecor(cx: number, cy: number): void {
    const ctx = this.ctx;
    const rx = VIEW_W / ZOOM / 2 + 40;
    const ry = VIEW_H / ZOOM / 2 + 40;
    for (const d of this.decor) {
      if (Math.abs(d.x - cx) > rx || Math.abs(d.y - cy) > ry) continue;
      ctx.fillStyle = PAL.shadow;
      if (d.kind === "cube") {
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(d.a);
        ctx.fillRect(-d.r + 3, -d.r * 0.7 + 3, d.r * 2, d.r * 1.4);
        ctx.fillStyle = d.color;
        ctx.fillRect(-d.r, -d.r * 0.7, d.r * 2, d.r * 1.4);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(-d.r, -d.r * 0.7 + d.r * 0.45, d.r * 2, 2);
        ctx.fillRect(-d.r, d.r * 0.2, d.r * 2, 2);
        ctx.fillStyle = "rgba(255,240,210,0.12)";
        ctx.fillRect(-d.r, -d.r * 0.7, d.r * 2, 2);
        ctx.restore();
      } else if (d.kind === "drum") {
        const r = d.r * 0.6;
        circle(ctx, d.x + 2, d.y + 3, r);
        ctx.fillStyle = d.color;
        circle(ctx, d.x, d.y, r);
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r * 0.55, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        for (let i = 0; i < 3; i++) {
          const ox = Math.cos(d.a + i * 2.1) * d.r * 0.5;
          const oy = Math.sin(d.a + i * 2.1) * d.r * 0.5;
          ctx.fillStyle = PAL.shadow;
          circle(ctx, d.x + ox + 2, d.y + oy + 3, 7);
          ctx.fillStyle = "#1b1b1c";
          circle(ctx, d.x + ox, d.y + oy, 7);
          ctx.fillStyle = "#4a4a4c";
          circle(ctx, d.x + ox, d.y + oy, 3.5);
        }
      }
    }
  }

  private carShadow(c: CarView): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(c.x + 3, c.y + 4);
    ctx.rotate(c.h);
    ctx.fillStyle = PAL.shadow;
    ctx.fillRect(-CAR_LENGTH / 2, -CAR_WIDTH / 2 - 1, CAR_LENGTH, CAR_WIDTH + 2);
    ctx.restore();
  }

  private car(c: CarView): void {
    const ctx = this.ctx;
    const L = CAR_LENGTH, W = CAR_WIDTH;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.h);
    // Wheels
    ctx.fillStyle = "#111";
    for (const wx of [-L / 2 + 3, L / 2 - 10]) {
      ctx.fillRect(wx, -W / 2 - 2, 7, 3);
      ctx.fillRect(wx, W / 2 - 1, 7, 3);
    }
    // Body with a darker outline, roll cage roof and a bonnet stripe.
    ctx.fillStyle = "#151210";
    ctx.fillRect(-L / 2 - 1, -W / 2 - 1, L + 2, W + 2);
    ctx.fillStyle = c.color;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(-L / 2, W / 2 - 3, L, 3);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(-L / 2, -W / 2, L, 2);
    ctx.fillStyle = "#1e2a31";
    ctx.fillRect(1, -W / 2 + 3, 6, W - 6); // windscreen
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(-9, -W / 2 + 3, 9, W - 6); // roof
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(8, -1, L / 2 - 9, 2); // stripe
    ctx.fillStyle = "#ffe9a8";
    ctx.fillRect(L / 2 - 2, -W / 2 + 1, 2, 3); // lamps
    ctx.fillRect(L / 2 - 2, W / 2 - 4, 2, 3);
    ctx.restore();
  }

  private nameTag(c: CarView, cx: number, cy: number): void {
    const ctx = this.ctx;
    const x = Math.round(VIEW_W / 2 + (c.x - cx) * ZOOM);
    const y = Math.round(VIEW_H / 2 + (c.y - cy) * ZOOM) - 20;
    if (x < -40 || x > VIEW_W + 40 || y < -20 || y > VIEW_H + 20) return;
    ctx.font = "bold 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(c.name).width + 6;
    ctx.fillStyle = PAL.hudBg;
    ctx.fillRect(Math.round(x - w / 2), y - 6, Math.round(w), 12);
    ctx.fillStyle = c.color;
    ctx.fillRect(Math.round(x - w / 2), y + 5, Math.round(w), 1);
    ctx.fillStyle = PAL.hudText;
    ctx.fillText(c.name, x, y);
  }

  private minimap(cars: CarView[]): void {
    const ctx = this.ctx;
    const m = this.mini;
    ctx.fillStyle = "rgba(18,14,11,0.55)";
    ctx.fillRect(VIEW_W - 112, 4, 108, 108);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1c1916";
    ctx.lineWidth = 5;
    ctx.stroke(m.path);
    ctx.strokeStyle = "#a99c86";
    ctx.lineWidth = 2;
    ctx.stroke(m.path);
    const sorted = [...cars].sort((a, b) => Number(a.me) - Number(b.me));
    for (const c of sorted) {
      const x = m.ox + c.x * m.scale, y = m.oy + c.y * m.scale;
      ctx.fillStyle = "#000";
      ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, c.me ? 6 : 5, c.me ? 6 : 5);
      ctx.fillStyle = c.color;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, c.me ? 4 : 3, c.me ? 4 : 3);
    }
  }

  private hud(h: HudView): void {
    const ctx = this.ctx;
    ctx.textBaseline = "middle";
    if (h.topLeft.length) {
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(6, 6, 92, 10 + h.topLeft.length * 14);
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      h.topLeft.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? PAL.accent : PAL.hudText;
        ctx.fillText(line, 12, 18 + i * 14);
      });
    }
    if (h.time) {
      ctx.font = "bold 13px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      const w = ctx.measureText(h.time).width + 14;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), 6, Math.round(w), 20);
      ctx.fillStyle = PAL.hudText;
      ctx.fillText(h.time, VIEW_W / 2, 16);
    }
    if (h.center) {
      ctx.textAlign = "center";
      ctx.font = "bold 52px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(h.center, VIEW_W / 2 + 3, VIEW_H / 2 - 20 + 3);
      ctx.fillStyle = PAL.accent;
      ctx.fillText(h.center, VIEW_W / 2, VIEW_H / 2 - 20);
      if (h.centerSub) {
        ctx.font = "bold 12px ui-monospace, Menlo, monospace";
        const w = ctx.measureText(h.centerSub).width + 16;
        ctx.fillStyle = PAL.hudBg;
        ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), VIEW_H / 2 + 14, Math.round(w), 20);
        ctx.fillStyle = PAL.hudText;
        ctx.fillText(h.centerSub, VIEW_W / 2, VIEW_H / 2 + 24);
      }
    }
    if (h.banner) {
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(0, VIEW_H - 26, VIEW_W, 20);
      ctx.fillStyle = PAL.hudText;
      ctx.fillText(h.banner, VIEW_W / 2, VIEW_H - 16);
    }
    if (h.corner) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(239,230,210,0.7)";
      ctx.fillText(h.corner, VIEW_W - 8, VIEW_H - 8);
    }
    if (h.debug.length) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(6, VIEW_H - 40 - h.debug.length * 11, 220, 6 + h.debug.length * 11);
      ctx.fillStyle = "#9fe08a";
      h.debug.forEach((line, i) => ctx.fillText(line, 10, VIEW_H - 34 - (h.debug.length - 1 - i) * 11 - 11));
    }
  }
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
