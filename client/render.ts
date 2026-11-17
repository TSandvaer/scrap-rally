// Canvas 2D renderer at a fixed 640x360 internal resolution, scaled up pixelated by CSS.
// Scrapyard look: packed dirt, gravel verges, steel barriers, rust-and-bone kerbs, and
// piles of junk outside the walls.

import { CAR_LENGTH, CAR_WIDTH } from "../shared/physics";
import { pointAt, queryTrack, type Gap, type PlacedHole, type Ramp, type Track, type Vec } from "../shared/track";

export const VIEW_W = 640;
export const VIEW_H = 360;
const ZOOM = 0.8;
const SHAKE_MS = 180;

export interface CarView {
  id: string;
  x: number;
  y: number;
  h: number;
  color: string;
  name: string;
  me: boolean;
  wreck: boolean;
  ghost: boolean;
  /** 0..1 height of an airborne car (shared/weapons.ts airHeight); absent or 0 = on the ground. */
  height?: number;
  /** 0..1 of the fall elapsed (FALL_TICKS); absent = not falling. */
  falling?: number;
}

/**
 * A car pose as client/game.ts hands it out (ownPose, otherPoses), with the optional
 * airborne / fall / ghost state the renderer draws.
 */
export interface DrawPose {
  id: string;
  x: number;
  y: number;
  h: number;
  height?: number;
  falling?: number;
  ghost?: boolean;
}

export interface WorldFx {
  shots: { x: number; y: number; vx: number; vy: number }[];
  mines: { x: number; y: number; armed: boolean }[];
  sparks: { x: number; y: number; age: number }[]; // age 0..1
}

export interface HudView {
  topLeft: string[]; // lap / position lines
  time: string;
  notice: string; // small line under the race time (weapons-armed countdown)
  center: string; // big countdown / status text
  centerSub: string;
  banner: string; // persistent strip at the bottom (spectating, reconnecting, ...)
  corner: string; // bottom-left small text (RTT)
  debug: string[];
  hp: number | null; // own car health 0..1, null = no car
}

interface Decor {
  kind: "cube" | "drum" | "tires" | "plate";
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
  // Track features
  void: "#0c0a08",
  rubble: "#2a2119",
  edge: "#8a7d6a",
  hazardA: "#e0a526",
  hazardB: "#1d1a17",
  steel: "#6f777d",
  rim: "#241c15",
  pitWall: "#3b2e23",
  pitDeep: "#030202",
};

const JUNK_COLORS = ["#7b3b2a", "#4f5b52", "#6d6a5c", "#8a5a2b", "#3f4a5c", "#6b2f2f"];
/** Airborne cars: drawn up to this much bigger at the top of the arc ... */
const AIR_SCALE = 0.35;
/** ... with the shadow moved this far away (world units, down-right) at the top. */
const AIR_SHADOW_X = 14;
const AIR_SHADOW_Y = 20;
/** A falling car shrinks to this fraction of its size by the end of the fall. */
const FALL_SCALE = 0.3;
const FALL_BLINKS = 7; // on/off cycles over the whole fall

/** Track features, prepared once per track (paths in world coordinates). */
interface FeatureArt {
  gaps: { gap: Gap; mid: Vec; reach: number; area: Path2D; pile: Decor[]; heap: Path2D | null }[];
  ramps: { ramp: Ramp; foot: Vec; top: Vec; mid: Pose; plate: Path2D; lip: Path2D; shadow: Path2D }[];
  holes: { hole: PlacedHole; rim: Path2D; cracks: Path2D }[];
  /** A gap's end: the drop just inside it, the broken edge and hazard stripes on the road. */
  edges: { at: Pose; drop: Path2D; line: Path2D; hazard: Path2D }[];
}

interface Pose {
  x: number;
  y: number;
  h: number;
}

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
  /** The track stroke ends flat at a gap (butt caps); a closed path keeps round caps. */
  private readonly cap: CanvasLineCap;
  private readonly art: FeatureArt | null;
  private readonly voidFill: CanvasPattern | null;
  private readonly rubble: CanvasPattern | null;
  readonly cam = { x: 0, y: 0 };
  private shakeAmp = 0;
  private shakeStart = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly track: Track,
  ) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;

    // No gaps: one closed path. Gaps: one open path per stretch of ground between them, so
    // the road (and a crossing's lower road under a gap) draws correctly.
    const runs = groundRuns(track);
    this.path = polyPath(runs, (p) => p, !track.gaps.length);
    this.cap = track.gaps.length ? "butt" : "round";

    this.dirt = noisePattern(this.ctx, 96, PAL.dirt, [["#6a5640", 260], ["#4e3e2c", 220], ["#77634a", 60]], 1);
    this.gravel = noisePattern(this.ctx, 64, PAL.gravel, [["#8d7c61", 300], ["#655640", 260], ["#a29276", 40]], 2);
    this.tarmac = noisePattern(this.ctx, 64, PAL.asphalt, [["#45413d", 220], ["#33302d", 220]], 3);
    this.decor = this.makeDecor();
    const featured = track.gaps.length + track.ramps.length + track.holes.length > 0;
    this.art = featured ? this.makeArt() : null;
    this.voidFill = featured ? noisePattern(this.ctx, 64, PAL.void, [["#1c1611", 160], ["#2a2119", 50], ["#050403", 160]], 4) : null;
    this.rubble = featured
      ? noisePattern(this.ctx, 64, PAL.rubble, [["#3b2f24", 260], ["#17120d", 240], ["#6a6158", 40]], 5)
      : null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of track.pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const box = 96;
    const scale = box / Math.max(maxX - minX, maxY - minY);
    const ox = VIEW_W - 10 - box + (box - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = 10 + (box - (maxY - minY) * scale) / 2 - minY * scale;
    const mp = polyPath(runs, (p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }), !track.gaps.length);
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

  /** Paths for ramps, gaps (with scrap piles) and holes; seeded so every client sees the same. */
  private makeArt(): FeatureArt {
    const t = this.track;
    const R = t.wall + 7; // outside of the barrier
    const W = t.wall - 1; // ramps span the road between the barriers
    const hw = t.def.halfWidth + 5; // asphalt and kerbs
    const gaps = t.gaps.map((gap, i) => ({
      gap,
      mid: pointAt(t, (gap.s0 + gap.s1) / 2),
      reach: (gap.s1 - gap.s0) / 2 + R,
      area: band(t, gap.s0, gap.s1, -R, R),
      pile: gap.scrap ? this.makePile(gap, 101 + i) : [],
      heap: gap.scrap ? band(t, gap.s0 + 2, gap.s1 - 2, -t.wall + 2, t.wall - 2) : null,
    }));
    const ramps = t.ramps.map((ramp) => {
      const end = ramp.s + ramp.len;
      return {
        ramp,
        foot: pointAt(t, ramp.s),
        top: pointAt(t, end),
        mid: pointAt(t, ramp.s + ramp.len / 2),
        plate: band(t, ramp.s, end, -W, W),
        lip: band(t, end - 3, end, -W, W),
        shadow: band(t, end, end + 9, -W + 4, W + 4),
      };
    });
    const holes = t.holes.map((hole, i) => {
      const rnd = mulberry32(211 + i);
      const rim = new Path2D();
      const corners = 15;
      for (let k = 0; k < corners; k++) {
        const a = (k / corners) * Math.PI * 2;
        const r = hole.r * (1.1 + rnd() * 0.16);
        if (k) rim.lineTo(hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r);
        else rim.moveTo(hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r);
      }
      rim.closePath();
      const cracks = new Path2D();
      for (let k = 0; k < 4; k++) {
        const a = rnd() * Math.PI * 2;
        let x = hole.x + Math.cos(a) * hole.r * 1.12, y = hole.y + Math.sin(a) * hole.r * 1.12;
        cracks.moveTo(x, y);
        for (let j = 0; j < 3; j++) {
          const b = a + (rnd() - 0.5) * 1.1;
          const step = hole.r * (0.18 + rnd() * 0.22);
          x += Math.cos(b) * step;
          y += Math.sin(b) * step;
          cracks.lineTo(x, y);
        }
      }
      return { hole, rim, cracks };
    });
    // Each gap end: the ground lies before s0 and after s1.
    const edges = t.gaps.flatMap((g) => [g.s0, g.s1].map((s, k) => {
      const dir = k ? -1 : 1;
      const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;
      const [hlo, hhi] = span(s, s - dir * 7);
      const [dlo, dhi] = span(s, s + dir * 10);
      const [llo, lhi] = span(s, s - dir * 2);
      return {
        at: pointAt(t, (hlo + hhi) / 2),
        drop: band(t, dlo, dhi, -t.wall, t.wall),
        line: band(t, llo, lhi, -t.wall, t.wall),
        hazard: band(t, hlo, hhi, -hw, hw),
      };
    }));
    return { gaps, ramps, holes, edges };
  }

  /** A heap of junk filling a gap (drawing only: it is not solid). */
  private makePile(g: Gap, seed: number): Decor[] {
    const t = this.track;
    const rnd = mulberry32(seed);
    const out: Decor[] = [];
    const W = t.wall - 4;
    for (let s = g.s0 + 9; s < g.s1 - 6; s += 14) {
      for (let lat = -W + 6; lat < W - 4; lat += 16) {
        const p = offsetAt(t, s + (rnd() - 0.5) * 8, lat + (rnd() - 0.5) * 9);
        const k = rnd();
        out.push({
          kind: k < 0.4 ? "cube" : k < 0.6 ? "drum" : k < 0.78 ? "tires" : "plate",
          x: p.x,
          y: p.y,
          r: 7 + rnd() * 6,
          a: rnd() * Math.PI,
          color: JUNK_COLORS[Math.floor(rnd() * JUNK_COLORS.length)],
        });
      }
    }
    // Draw from the top of the screen down so lower items overlap the ones behind them.
    return out.sort((a, b) => a.y - b.y);
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

  /** A short camera shake of up to amp view pixels (a stronger one replaces a weaker). */
  shake(amp: number): void {
    const now = performance.now();
    if (amp < this.shakeLeft(now)) return;
    this.shakeAmp = amp;
    this.shakeStart = now;
  }

  private shakeLeft(now: number): number {
    const t = (now - this.shakeStart) / SHAKE_MS;
    return t < 1 ? this.shakeAmp * (1 - t) : 0;
  }

  /** Draw one frame. `now` (ms) drives the camera shake and the car blinks. */
  frame(cars: CarView[], fx: WorldFx, hud: HudView | null, now = performance.now()): void {
    const ctx = this.ctx;
    const amp = this.shakeLeft(now) / ZOOM;
    const ph = (now - this.shakeStart) / 16;
    const cx = Math.round((this.cam.x + Math.sin(ph * 1.7) * amp) * ZOOM) / ZOOM;
    const cy = Math.round((this.cam.y + Math.cos(ph * 2.3) * amp) * ZOOM) / ZOOM;
    ctx.setTransform(ZOOM, 0, 0, ZOOM, VIEW_W / 2 - cx * ZOOM, VIEW_H / 2 - cy * ZOOM);

    // Ground
    ctx.fillStyle = this.dirt;
    ctx.fillRect(cx - VIEW_W / ZOOM, cy - VIEW_H / ZOOM, (2 * VIEW_W) / ZOOM, (2 * VIEW_H) / ZOOM);
    this.drawDecor(cx, cy);
    this.drawTrack(cx, cy);

    for (const m of fx.mines) this.mine(m.x, m.y, m.armed);
    // Falling cars sink below the road (drawn first, no shadow); airborne cars fly above
    // everything (drawn last, lowest first) and their shadows do land on other cars.
    const falling = cars.filter((c) => fallOf(c) >= 0);
    const ground = cars.filter((c) => fallOf(c) < 0 && airOf(c) === 0);
    const air = cars.filter((c) => fallOf(c) < 0 && airOf(c) > 0).sort((a, b) => airOf(a) - airOf(b));
    for (const c of falling) this.car(c, now);
    // Grounded cars: shadows first so no car's shadow lands on another car.
    for (const c of ground) this.carShadow(c);
    for (const c of ground) this.car(c, now);
    for (const c of cars) if (c.wreck) this.smoke(c);
    for (const s of fx.shots) this.shot(s.x, s.y, s.vx, s.vy);
    for (const s of fx.sparks) this.spark(s.x, s.y, s.age);
    for (const c of air) this.carShadow(c);
    for (const c of air) this.car(c, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of cars) if (!c.me) this.nameTag(c, cx, cy);
    this.minimap(cars);
    if (hud) this.hud(hud);
  }

  private drawTrack(cx: number, cy: number): void {
    const ctx = this.ctx;
    const t = this.track;
    // Gaps first: the road strokes stop at them, and a lower road crossing under a gap draws
    // over the void.
    if (this.art) this.drawVoids();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const stroke = (style: string | CanvasPattern, half: number, dash: number[] = []) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = half * 2;
      ctx.setLineDash(dash);
      ctx.lineCap = dash.length ? "butt" : this.cap; // round caps would merge the dashes
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
    if (this.art) this.drawFeatures(this.art, cx, cy);
  }

  private drawVoids(): void {
    const ctx = this.ctx;
    for (const g of this.art!.gaps) {
      ctx.fillStyle = this.voidFill!;
      ctx.fill(g.area);
      // Earth walls dropping away from every side of the hole.
      ctx.save();
      ctx.clip(g.area);
      ctx.strokeStyle = "rgba(84,64,45,0.36)";
      for (const w of [40, 24, 10]) {
        ctx.lineWidth = w;
        ctx.stroke(g.area);
      }
      ctx.restore();
    }
  }

  /** Gap shading, edges and scrap piles, holes and ramps, over the road. */
  private drawFeatures(art: FeatureArt, cx: number, cy: number): void {
    const ctx = this.ctx;
    const t = this.track;
    const rx = VIEW_W / ZOOM / 2 + 20;
    const ry = VIEW_H / ZOOM / 2 + 20;
    const seen = (p: Vec, r: number) => Math.abs(p.x - cx) < rx + r && Math.abs(p.y - cy) < ry + r;
    const R = t.wall + 7;

    for (const g of art.gaps) {
      if (!seen(g.mid, g.reach)) continue;
      // Depth: the void, and a lower road crossing under the gap, sit in shade.
      ctx.fillStyle = "rgba(0,0,0,0.34)";
      ctx.fill(g.area);
      if (g.heap) {
        ctx.fillStyle = this.rubble!;
        ctx.fill(g.heap);
        for (const d of g.pile) this.junk(d);
      }
    }
    for (const e of art.edges) {
      if (!seen(e.at, R)) continue;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fill(e.drop);
      ctx.save();
      ctx.clip(e.hazard);
      stripes(ctx, e.at.x, e.at.y, e.at.h, t.def.halfWidth + 14, 5, PAL.hazardA, PAL.hazardB);
      ctx.restore();
      ctx.fillStyle = PAL.edge;
      ctx.fill(e.line);
    }
    for (const h of art.holes) {
      const { x, y, r } = h.hole;
      if (!seen(h.hole, r * 1.8)) continue;
      ctx.strokeStyle = "rgba(22,17,13,0.75)";
      ctx.lineWidth = 1.5;
      ctx.stroke(h.cracks);
      ctx.fillStyle = PAL.rim;
      ctx.fill(h.rim);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = PAL.pitWall; // the far wall, lit from the top left
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      const g = ctx.createRadialGradient(x - r * 0.2, y - r * 0.25, 0, x - r * 0.2, y - r * 0.25, r);
      g.addColorStop(0, PAL.pitDeep);
      g.addColorStop(0.75, "#0d0a08");
      g.addColorStop(1, "#1d1611");
      ctx.fillStyle = g;
      circle(ctx, x - r * 0.2, y - r * 0.25, r);
      ctx.restore();
    }
    for (const rp of art.ramps) {
      const { len } = rp.ramp;
      const { foot: a, top: b, mid: m } = rp;
      if (!seen(m, len / 2 + R)) continue;
      ctx.fillStyle = "rgba(0,0,0,0.42)";
      ctx.fill(rp.shadow);
      ctx.save();
      ctx.clip(rp.plate);
      stripes(ctx, m.x, m.y, m.h, len / 2 + t.wall + 4, 6, PAL.steel, "#b8682e");
      // Rising toward the lip: dark at the foot, light at the top.
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, "rgba(10,8,6,0.55)");
      g.addColorStop(1, "rgba(255,244,220,0.22)");
      ctx.fillStyle = g;
      ctx.fill(rp.plate);
      this.arrows(m.x, m.y, m.h, len, t.wall - 1);
      ctx.restore();
      ctx.strokeStyle = PAL.hazardB;
      ctx.lineWidth = 1.5;
      ctx.stroke(rp.plate);
      ctx.fillStyle = PAL.hazardA;
      ctx.fill(rp.lip);
    }
  }

  /** Chevrons pointing along the direction of travel, across a ramp. */
  private arrows(x: number, y: number, h: number, len: number, w: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(h);
    ctx.lineJoin = "miter";
    const d = Math.min(9, len * 0.18);
    for (const lat of [-w * 0.58, 0, w * 0.58]) {
      for (const [color, width] of [[PAL.hazardB, 6], [PAL.kerbB, 3]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(-d, lat - d * 1.3);
        ctx.lineTo(d, lat);
        ctx.lineTo(-d, lat + d * 1.3);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawDecor(cx: number, cy: number): void {
    const rx = VIEW_W / ZOOM / 2 + 40;
    const ry = VIEW_H / ZOOM / 2 + 40;
    for (const d of this.decor) {
      if (Math.abs(d.x - cx) > rx || Math.abs(d.y - cy) > ry) continue;
      this.junk(d);
    }
  }

  /** One piece of junk with its shadow: a crushed cube, a drum, a tyre stack or a bent plate. */
  private junk(d: Decor): void {
    const ctx = this.ctx;
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
    } else if (d.kind === "plate") {
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.a);
      const w = d.r * 1.3, h = d.r * 0.8;
      const sheet = () => {
        ctx.beginPath();
        ctx.moveTo(-w, -h * 0.6);
        ctx.lineTo(w * 0.8, -h);
        ctx.lineTo(w, h * 0.5);
        ctx.lineTo(-w * 0.7, h);
        ctx.closePath();
        ctx.fill();
      };
      ctx.translate(3, 3);
      sheet();
      ctx.translate(-3, -3);
      ctx.fillStyle = d.color;
      sheet();
      ctx.strokeStyle = "rgba(255,240,210,0.22)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-w * 0.85, -h * 0.1);
      ctx.lineTo(w * 0.9, -h * 0.25); // the crease
      ctx.stroke();
      ctx.restore();
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

  private carShadow(c: CarView): void {
    const ctx = this.ctx;
    const up = airOf(c);
    ctx.save();
    ctx.translate(c.x + 3 + up * AIR_SHADOW_X, c.y + 4 + up * AIR_SHADOW_Y);
    ctx.rotate(c.h);
    ctx.fillStyle = up > 0 ? `rgba(0,0,0,${(0.38 * (1 - 0.4 * up)).toFixed(3)})` : PAL.shadow;
    ctx.fillRect(-CAR_LENGTH / 2, -CAR_WIDTH / 2 - 1, CAR_LENGTH, CAR_WIDTH + 2);
    ctx.restore();
  }

  private car(c: CarView, now: number): void {
    const ctx = this.ctx;
    const L = CAR_LENGTH, W = CAR_WIDTH;
    const up = airOf(c);
    const fall = fallOf(c);
    ctx.save();
    if (c.ghost) ctx.globalAlpha = Math.floor(now / 110) % 2 ? 0.35 : 0.75;
    if (fall >= 0 && Math.floor(fall * FALL_BLINKS * 2) % 2) ctx.globalAlpha *= 0.3;
    ctx.translate(c.x, c.y);
    if (fall >= 0) {
      // Shrinks fast at first (dropping away), tumbling slowly.
      ctx.rotate(c.h + fall * 1.1);
      const k = 1 - (1 - FALL_SCALE) * (1 - (1 - fall) * (1 - fall));
      ctx.scale(k, k);
    } else {
      ctx.rotate(c.h);
      if (up > 0) ctx.scale(1 + up * AIR_SCALE, 1 + up * AIR_SCALE);
    }
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
    if (c.wreck) {
      ctx.fillStyle = "rgba(24,18,12,0.62)"; // scorched
      ctx.fillRect(-L / 2 - 1, -W / 2 - 1, L + 2, W + 2);
    }
    if (fall >= 0) {
      ctx.fillStyle = `rgba(6,4,3,${(0.7 * fall).toFixed(3)})`; // into the dark
      ctx.fillRect(-L / 2 - 1, -W / 2 - 2, L + 2, W + 4);
    }
    ctx.restore();
  }

  private smoke(c: CarView): void {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    for (let i = 0; i < 4; i++) {
      const phase = (t * 0.9 + i / 4) % 1;
      ctx.fillStyle = `rgba(70,66,62,${0.55 * (1 - phase)})`;
      circle(ctx, c.x + Math.sin(i * 2.3 + t) * 4 + phase * 10, c.y - 4 - phase * 22, 4 + phase * 7);
    }
  }

  private mine(x: number, y: number, armed: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = PAL.shadow;
    circle(ctx, x + 1.5, y + 2, 7);
    ctx.strokeStyle = "#2a2622";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      ctx.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
    }
    ctx.stroke();
    ctx.fillStyle = "#3d3832";
    circle(ctx, x, y, 6);
    const blink = armed && Math.floor(performance.now() / 250) % 2 === 0;
    ctx.fillStyle = armed ? (blink ? "#ff3b2f" : "#7a1d16") : "#8a6d2a";
    circle(ctx, x, y, 2.2);
  }

  private shot(x: number, y: number, vx: number, vy: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,214,130,0.55)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - vx * 0.014, y - vy * 0.014);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = "#fff4cf";
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  private spark(x: number, y: number, age: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(255,${200 - age * 120},90,${1 - age})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + x * 0.01;
      const r0 = 3 + age * 8, r1 = 6 + age * 16;
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    }
    ctx.stroke();
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
    ctx.lineCap = this.cap; // breaks at gaps (shots leave round caps set)
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
      const barH = h.hp === null ? 0 : 12;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(6, 6, 118, 10 + h.topLeft.length * 14 + barH);
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      h.topLeft.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? PAL.accent : PAL.hudText;
        ctx.fillText(line, 12, 18 + i * 14);
      });
      if (h.hp !== null) {
        const y = 12 + h.topLeft.length * 14;
        ctx.fillStyle = "#120d0a";
        ctx.fillRect(12, y, 106, 7);
        ctx.fillStyle = h.hp > 0.5 ? "#7bc95a" : h.hp > 0.25 ? "#e8b83a" : "#e8452d";
        ctx.fillRect(13, y + 1, Math.round(104 * Math.max(0, Math.min(1, h.hp))), 5);
      }
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
    if (h.notice) {
      ctx.font = "bold 10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      const w = ctx.measureText(h.notice).width + 12;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), 29, Math.round(w), 15);
      ctx.fillStyle = PAL.accent;
      ctx.fillText(h.notice, VIEW_W / 2, 37);
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

/**
 * The centerline as polylines: the whole closed loop when there are no gaps, else one open
 * polyline per stretch of ground from a gap's end to the next gap's start (wrapping).
 */
function groundRuns(t: Track): Vec[][] {
  if (!t.gaps.length) return [t.pts];
  const L = t.length;
  const n = t.pts.length;
  return t.gaps.map((g, i) => {
    const from = g.s1;
    const to = i + 1 < t.gaps.length ? t.gaps[i + 1].s0 : t.gaps[0].s0 + L;
    const a = pointAt(t, from), b = pointAt(t, to);
    const run: Vec[] = [{ x: a.x, y: a.y }];
    for (let j = 0; j < 2 * n; j++) {
      const s = t.cum[j % n] + (j >= n ? L : 0);
      if (s > from && s < to) run.push(t.pts[j % n]);
    }
    run.push({ x: b.x, y: b.y });
    return run;
  });
}

function polyPath(runs: Vec[][], map: (p: Vec) => Vec, closed: boolean): Path2D {
  const path = new Path2D();
  for (const run of runs) {
    run.forEach((p, i) => {
      const q = map(p);
      if (i) path.lineTo(q.x, q.y);
      else path.moveTo(q.x, q.y);
    });
    if (closed) path.closePath();
  }
  return path;
}

/** The point `lat` units right of the centerline (as gridSlot) at distance s. */
function offsetAt(t: Track, s: number, lat: number): Vec {
  const p = pointAt(t, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
}

/** The strip between lateral offsets a and b from s0 to s1 (s0 < s1, no wrap), following the curve. */
function band(t: Track, s0: number, s1: number, a: number, b: number): Path2D {
  const ss = [s0];
  for (const c of t.cum) if (c > s0 && c < s1) ss.push(c);
  ss.push(s1);
  const path = new Path2D();
  ss.forEach((s, i) => {
    const q = offsetAt(t, s, a);
    if (i) path.lineTo(q.x, q.y);
    else path.moveTo(q.x, q.y);
  });
  for (let i = ss.length - 1; i >= 0; i--) {
    const q = offsetAt(t, ss[i], b);
    path.lineTo(q.x, q.y);
  }
  path.closePath();
  return path;
}

/** Diagonal two-colour stripes over the area of the current clip, in a local frame at (x, y, h). */
function stripes(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, reach: number, w: number, a: string, b: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(h);
  ctx.fillStyle = a;
  ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
  ctx.fillStyle = b;
  for (let u = -reach * 3 - w; u < reach; u += w * 2) {
    ctx.beginPath();
    ctx.moveTo(u, -reach);
    ctx.lineTo(u + w, -reach);
    ctx.lineTo(u + w + reach * 2, reach);
    ctx.lineTo(u + reach * 2, reach);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** 0..1 airborne height (0 = on the ground). */
function airOf(c: CarView): number {
  const h = c.height ?? 0;
  return h > 0 ? Math.min(1, h) : 0;
}

/** 0..1 of the fall elapsed, or -1 when the car is not falling. */
function fallOf(c: CarView): number {
  const f = c.falling;
  return f !== undefined && f > 0 ? Math.min(1, f) : -1;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
