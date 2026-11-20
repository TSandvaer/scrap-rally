// The page of tools/debug/mines-blink.ts --time: Renderer.frame() with 6 mines in the view,
// with 40, and with 40 of which 20 blink out, in turn. See the runner for what it is.
//
// ?track=rust-bowl     the track (the view stands on a straight piece of it)
// &canvas=soft|gpu     the view canvas: in main memory and read back (CPU raster, as the
//                      benchmark's metric A), or the browser's own (as its metric G)
// &reps=6              rounds of the three scenes; the first round is a warm-up and is left out
// &show=<scene>&at=<frame>   draw that frame of scene 0, 1 or 2 and stop (for a look)

import { Renderer, type HudView } from "../../../client/render";
import { pointAt } from "../../../shared/track";
import { trackById } from "../../../shared/tracks";
import { buildScene, SCENES } from "./scene";

const params = new URLSearchParams(location.search);
const trackId = params.get("track") ?? "rust-bowl";
const kind = params.get("canvas") === "gpu" ? "gpu" : "soft";
const REPS = Number(params.get("reps")) || 6;
const SHOW = params.get("show");
const FPS = 60, WARM = 300, FRAMES = 600;

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function main(): void {
  const track = trackById(trackId);
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  // The context first: the Renderer then gets this one.
  const ctx = canvas.getContext("2d", { willReadFrequently: kind === "soft" })!;
  const scenes = SCENES.map((def) => buildScene(track, pointAt, def));
  const hud: HudView = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", notice: "", center: "", centerSub: "", banner: "", corner: "23 ms", debug: [], hp: 0.62 };
  const play = (r: Renderer, k: number, i: number): void => {
    const s = scenes[k];
    s.step(i);
    r.follow(s.x, s.y, 1000 / FPS, i === 0);
    r.frame(s.cars, s.fx, hud, 10_000 + (i * 1000) / FPS);
  };
  if (SHOW !== null) {
    const k = Math.min(SCENES.length - 1, Math.max(0, Number(SHOW) || 0));
    const r = new Renderer(canvas, track);
    const last = Number(params.get("at")) || 0;
    for (let i = 0; i <= last; i++) play(r, k, i);
    (window as unknown as { minesOut: unknown }).minesOut = { done: true, scene: SCENES[k].name, frame: last };
    document.getElementById("out")!.textContent = `${SCENES[k].name}, frame ${last}`;
    return;
  }
  const runs: Record<string, unknown>[] = [];
  for (let rep = 0; rep < REPS; rep++) {
    // The three scenes in turn, the order turned round every round.
    const order = SCENES.map((_, k) => k);
    if (rep % 2) order.reverse();
    for (const k of order) {
      const r = new Renderer(canvas, track);
      // The warm-up bakes the view's tiles; it is read back like the measured frames.
      for (let i = 0; i < WARM; i++) {
        play(r, k, i);
        ctx.getImageData(0, 0, 1, 1);
      }
      const times = new Float64Array(FRAMES);
      for (let i = 0; i < FRAMES; i++) {
        const t0 = performance.now();
        play(r, k, WARM + i);
        ctx.getImageData(0, 0, 1, 1); // the frame is rastered before the clock is read
        times[i] = performance.now() - t0;
      }
      const sorted = times.slice().sort();
      let sum = 0;
      for (let i = 0; i < FRAMES; i++) sum += times[i];
      runs.push({ rep, scene: k, mean: sum / FRAMES, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted[FRAMES - 1] });
    }
  }
  const out = { done: true, track: trackId, canvas: kind, frames: FRAMES, warm: WARM, isolated: crossOriginIsolated, scenes: SCENES.map((s) => s.name), userAgent: navigator.userAgent, runs };
  (window as unknown as { minesOut: unknown }).minesOut = out;
  document.getElementById("out")!.textContent = JSON.stringify(out, null, 1);
}

main();
