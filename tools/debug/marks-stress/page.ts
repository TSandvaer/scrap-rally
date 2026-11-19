// The page of tools/debug/marks-stress.ts: a firefight that marks the track as hard as a race
// can, drawn with the track marks switched on and off in turn. See the runner for what it is.
//
// ?track=crusher-run   the track (the fight is where the benchmark's S3 has it)
// &canvas=soft|gpu     the view canvas: in main memory and read back (as the benchmark's
//                      metric A: CPU raster), or the browser's own (as its metric G)
// &reps=6              pairs of runs (off, on); the first pair is a warm-up and is left out
// &show=1              draw the last frame and stop (for a look; nothing is measured)

import * as world from "../../../client/gfx/world";
import { Renderer, type CarView, type HudView, type WorldFx } from "../../../client/render";
import { pointAt, type Track } from "../../../shared/track";
import { trackById } from "../../../shared/tracks";
import { RIVET_RANGE, RIVET_SPEED } from "../../../shared/weapons";

const params = new URLSearchParams(location.search);
const trackId = params.get("track") ?? "crusher-run";
const kind = params.get("canvas") === "gpu" ? "gpu" : "soft";
const REPS = Number(params.get("reps")) || 6;
const SHOW = params.get("show") === "1";
const FPS = 60, WARM = 300, FRAMES = 600, BLAST_EVERY = 30, BLAST_FRAMES = 8;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const NAMES = ["You", "Rustbucket", "Åse Ørn", "Bolt", "SkidMarks 12", "Иван"];
const CAM: Record<string, number> = { "rust-bowl": 120, "crusher-run": 3560, "overpass-knot": 5300 };

// A build from before the track marks has none of these: it is then measured as it is.
const marks = world as unknown as {
  markSwitch?: { on: boolean };
  clearMarks?: () => void;
  markStats?: { scorches: number; skids: number; uploads: number; pixels: number };
};

interface Frame { cars: CarView[]; fx: WorldFx; hud: HudView; shake: number }

function carAt(track: Track, i: number, s: number, lat: number, turn: number, more: Partial<CarView> = {}): CarView {
  const p = pointAt(track, s);
  return { id: `b${i}`, x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h + turn, color: COLORS[i], name: NAMES[i], me: i === 0, wreck: false, ghost: false, hp: i === 3 ? 0.3 : 1, ...more };
}

/**
 * The fight, frame by frame, worked out before anything is timed. Four cars cross the view
 * again and again, three of them turned against their way (sliding: tyre marks every other
 * frame), each pass in a lane of its own so that it marks fresh ground; two wrecks; twelve
 * rivets, six mines, six hit sparks; a mine going off every half second (twenty in the 600
 * measured frames), each somewhere else on the road.
 */
function script(track: Track, n: number): Frame[] {
  const cam = CAM[track.def.id] ?? 500;
  const from = cam - 260, dist = 520;
  const drivers = [
    { i: 0, v: 320, lat: -6, ph: 0, turn: 0 },
    { i: 3, v: 280, lat: 30, ph: 0.3, turn: 0.5 },
    { i: 4, v: 350, lat: -34, ph: 0.6, turn: -0.45 },
    { i: 5, v: 250, lat: 12, ph: 0.8, turn: 0.55 },
  ];
  const wrecks = [carAt(track, 1, cam - 120, -40, 0, { wreck: true }), carAt(track, 2, cam + 90, 45, 0, { wreck: true })];
  const life = Math.floor((RIVET_RANGE / RIVET_SPEED) * FPS);
  const guns = Array.from({ length: 12 }, (_, k) => {
    const p = carAt(track, 0, cam - 200 + k * 35, ((k * 37) % 100) - 50, 0);
    const a = p.h + (k % 2 ? Math.PI : 0);
    return { x: p.x, y: p.y, vx: Math.cos(a) * RIVET_SPEED, vy: Math.sin(a) * RIVET_SPEED };
  });
  const mines = [-40, 30, -10, 48, -52, 15].map((lat, k) => {
    const p = carAt(track, 0, cam - 180 + k * 70, lat, 0);
    return { x: p.x, y: p.y, armed: k < 4 };
  });
  const hits = [20, -35, 0, 40, -20, 10].map((lat, k) => carAt(track, 0, cam - 150 + k * 60, lat, 0));
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const cars = drivers.map((d) => {
      const way = i * (d.v / FPS) + d.ph * dist;
      const pass = Math.floor(way / dist);
      return carAt(track, d.i, from + (way % dist), d.lat + ((pass * 5) % 30) - 15, d.turn);
    });
    cars.splice(1, 0, ...wrecks);
    const sparks: WorldFx["sparks"] = hits.map((h, k) => ({ x: h.x, y: h.y, age: ((i + k * 3) % 16) / 16 }));
    if (i % BLAST_EVERY < BLAST_FRAMES) {
      const k = Math.floor(i / BLAST_EVERY);
      const p = carAt(track, 0, cam - 210 + ((k * 97) % 420), ((k * 41) % 104) - 52, 0);
      sparks.push({ x: p.x, y: p.y, age: (i % BLAST_EVERY) / BLAST_FRAMES, blast: true });
    }
    const fx: WorldFx = {
      shots: guns.map((g, k) => {
        const t = ((i + k * 5) % life) / FPS;
        return { x: g.x + g.vx * t, y: g.y + g.vy * t, vx: g.vx, vy: g.vy };
      }),
      mines,
      sparks,
    };
    const ms = 83_400 + (i * 1000) / FPS;
    const hud: HudView = {
      topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"],
      time: `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`,
      notice: "WEAPONS ARMED IN 5", center: "", centerSub: "", banner: "Winner is in — race closes in 12s", corner: "23 ms", debug: [], hp: 0.62,
    };
    out.push({ cars, fx, hud, shake: i % FPS === 0 ? 3 : 0 });
  }
  return out;
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function main(): void {
  const track = trackById(trackId);
  const camAt = pointAt(track, CAM[trackId] ?? 500);
  const frames = script(track, WARM + FRAMES);
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  // The context first: the Renderer then gets this one.
  const ctx = canvas.getContext("2d", { willReadFrequently: kind === "soft" })!;
  const play = (r: Renderer, i: number): void => {
    const f = frames[i];
    r.follow(camAt.x, camAt.y, 1000 / FPS, i === 0);
    if (f.shake) r.shake(f.shake);
    r.frame(f.cars, f.fx, f.hud, 10_000 + (i * 1000) / FPS);
  };
  const runs: Record<string, unknown>[] = [];
  const stats = marks.markStats;
  for (let rep = 0; rep < (SHOW ? 1 : REPS); rep++) {
    // Off and on in turn, the order swapped every pair. A build without the switch runs as it is, twice.
    for (const on of rep % 2 ? [true, false] : [false, true]) {
      if (SHOW && !on) continue;
      marks.clearMarks?.();
      if (marks.markSwitch) marks.markSwitch.on = on;
      const r = new Renderer(canvas, track);
      // The warm-up also wipes what the run before left on the tiles (one tile a frame). It is
      // read back like the measured frames: else the first of those would raster all of it.
      for (let i = 0; i < WARM; i++) {
        play(r, i);
        if (!SHOW) ctx.getImageData(0, 0, 1, 1);
      }
      const made0 = stats ? stats.scorches + stats.skids : 0, sent0 = stats ? stats.uploads : 0, px0 = stats ? stats.pixels : 0;
      const times = new Float64Array(FRAMES);
      for (let i = 0; i < FRAMES; i++) {
        const t0 = performance.now();
        play(r, WARM + i);
        if (!SHOW) ctx.getImageData(0, 0, 1, 1); // the frame is rastered before the clock is read
        times[i] = performance.now() - t0;
      }
      const sorted = times.slice().sort();
      let sum = 0, slowest = 0, over = 0;
      for (let i = 0; i < FRAMES; i++) {
        sum += times[i];
        if (times[i] > times[slowest]) slowest = i;
        if (times[i] > 2) over++;
      }
      runs.push({
        rep, on: marks.markSwitch ? on : null,
        mean: sum / FRAMES, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted[FRAMES - 1], slowest, over,
        marks: stats ? stats.scorches + stats.skids - made0 : 0, uploads: stats ? stats.uploads - sent0 : 0, pixels: stats ? stats.pixels - px0 : 0,
      });
    }
  }
  if (marks.markSwitch) marks.markSwitch.on = true;
  const out = { done: true, track: trackId, canvas: kind, frames: FRAMES, warm: WARM, isolated: crossOriginIsolated, hasMarks: !!marks.markSwitch, userAgent: navigator.userAgent, runs };
  (window as unknown as { stressOut: unknown }).stressOut = out;
  document.getElementById("out")!.textContent = JSON.stringify(out, null, 1);
}

main();
