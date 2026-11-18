// The static world under the cars: packed dirt, junk piles outside the walls, the track
// (steel barriers, gravel verges, rust-and-bone kerbs, tarmac, the start line) and its
// features (ramps, gaps with their voids and scrap piles, holes). Drawn under the renderer's
// world transform.

import { pointAt, queryTrack, type Gap, type PlacedHole, type Ramp, type Track, type Vec } from "../../shared/track";

export const VIEW_W = 640;
export const VIEW_H = 360;
export const ZOOM = 0.8;

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

export class World {
  private readonly path: Path2D;
  private readonly dirt: CanvasPattern;
  private readonly gravel: CanvasPattern;
  private readonly tarmac: CanvasPattern;
  private readonly decor: Decor[];
  /** The track stroke ends flat at a gap (butt caps); a closed path keeps round caps. */
  private readonly cap: CanvasLineCap;
  private readonly art: FeatureArt | null;
  private readonly voidFill: CanvasPattern | null;
  private readonly rubble: CanvasPattern | null;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly track: Track,
  ) {
    // No gaps: one closed path. Gaps: one open path per stretch of ground between them, so
    // the road (and a crossing's lower road under a gap) draws correctly.
    this.path = polyPath(groundRuns(track), (p) => p, !track.gaps.length);
    this.cap = track.gaps.length ? "butt" : "round";

    this.dirt = noisePattern(ctx, 96, PAL.dirt, [["#6a5640", 260], ["#4e3e2c", 220], ["#77634a", 60]], 1);
    this.gravel = noisePattern(ctx, 64, PAL.gravel, [["#8d7c61", 300], ["#655640", 260], ["#a29276", 40]], 2);
    this.tarmac = noisePattern(ctx, 64, PAL.asphalt, [["#45413d", 220], ["#33302d", 220]], 3);
    this.decor = this.makeDecor();
    const featured = track.gaps.length + track.ramps.length + track.holes.length > 0;
    this.art = featured ? this.makeArt() : null;
    this.voidFill = featured ? noisePattern(ctx, 64, PAL.void, [["#1c1611", 160], ["#2a2119", 50], ["#050403", 160]], 4) : null;
    this.rubble = featured
      ? noisePattern(ctx, 64, PAL.rubble, [["#3b2f24", 260], ["#17120d", 240], ["#6a6158", 40]], 5)
      : null;
  }

  /** Draw the world around the camera (cx, cy), in world coordinates. */
  draw(cx: number, cy: number): void {
    const ctx = this.ctx;
    // Ground
    ctx.fillStyle = this.dirt;
    ctx.fillRect(cx - VIEW_W / ZOOM, cy - VIEW_H / ZOOM, (2 * VIEW_W) / ZOOM, (2 * VIEW_H) / ZOOM);
    this.drawDecor(cx, cy);
    this.drawTrack(cx, cy);
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
}

/**
 * The centerline as polylines: the whole closed loop when there are no gaps, else one open
 * polyline per stretch of ground from a gap's end to the next gap's start (wrapping).
 */
export function groundRuns(t: Track): Vec[][] {
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

export function polyPath(runs: Vec[][], map: (p: Vec) => Vec, closed: boolean): Path2D {
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

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
