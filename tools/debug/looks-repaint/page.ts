// The page of tools/debug/looks-repaint.ts: what a car's change of state costs the frame it
// happens in. See the runner for what it is.
//
// ?track=rust-bowl     the track (the view stands on a piece of it)
// &canvas=soft|gpu     the view canvas: in main memory and read back (CPU raster, as the
//                      benchmark's metric A), or the browser's own (as its metric G)
// &reps=6              rounds; the first is a warm-up and is left out
// &every=30            a car changes state every so many frames
// &show=<frame>        draw the frames up to that one and stop (for a look)

import { carPixels, carSheet, LOOKS, SHEET_H, SHEET_W, spriteBytes, SPRITE_BYTES_MAX, spriteFrame } from "../../../client/gfx/sprites";
import { Renderer, type CarView, type HudView, type WorldFx } from "../../../client/render";
import { pointAt } from "../../../shared/track";
import { trackById } from "../../../shared/tracks";

const params = new URLSearchParams(location.search);
const trackId = params.get("track") ?? "rust-bowl";
const kind = params.get("canvas") === "gpu" ? "gpu" : "soft";
const REPS = Number(params.get("reps")) || 6;
const EVERY = Number(params.get("every")) || 30;
const SHOW = params.get("show");
const FPS = 60, WARM = 300, FRAMES = 1800;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const S0 = 400; // where the view stands

interface Stat { n: number; p50: number; p95: number; p99: number; max: number }

function stat(v: number[]): Stat {
  const s = Float64Array.from(v).sort();
  const q = (x: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(x * s.length))] : NaN);
  return { n: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? s[s.length - 1] : NaN };
}

function main(): void {
  const track = trackById(trackId);
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  // The context first: the Renderer then gets this one.
  const ctx = canvas.getContext("2d", { willReadFrequently: kind === "soft" })!;
  const cam = pointAt(track, S0);
  const hud: HudView = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", notice: "", center: "", centerSub: "", banner: "", corner: "23 ms", debug: [], hp: 0.62 };
  const fx: WorldFx = { shots: [], mines: [], sparks: [] };
  // Six cars of the three looks, each going through the view again and again, two lanes.
  const cars: CarView[] = COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `${LOOKS[i % 3]} ${i + 1}`, me: i === 0, wreck: false, ghost: false, hp: 1, car: LOOKS[i % 3] }));
  const state = new Uint8Array(cars.length); // 0 whole, 1 battered, 2 wreck
  let turn = 0;
  const play = (r: Renderer, i: number): boolean => {
    const changed = i % EVERY === 0;
    if (changed) {
      const c = turn++ % cars.length;
      state[c] = (state[c] + 1) % 3;
      cars[c].hp = state[c] === 0 ? 1 : 0.2;
      cars[c].wreck = state[c] === 2;
    }
    cars.forEach((c, k) => {
      const p = pointAt(track, S0 - 170 + (((i * (250 + k * 30)) / FPS + k * 57) % 340));
      const lat = k % 2 ? 26 : -26;
      c.x = p.x - Math.sin(p.h) * lat;
      c.y = p.y + Math.cos(p.h) * lat;
      c.h = p.h;
    });
    r.follow(cam.x, cam.y, 1000 / FPS, i === 0);
    r.frame(cars, fx, hud, 10_000 + (i * 1000) / FPS);
    return changed;
  };
  const say = (out: unknown) => {
    (window as unknown as { looksOut: unknown }).looksOut = out;
    document.getElementById("out")!.textContent = JSON.stringify(out, null, 1);
  };
  if (SHOW !== null) {
    const r = new Renderer(canvas, track);
    const last = Number(SHOW) || 0;
    for (let i = 0; i <= last; i++) play(r, i);
    return say({ done: true, frame: last, states: Array.from(state) });
  }

  // The frames: with a change of state, and without.
  const plain: number[] = [], change: number[] = [];
  for (let rep = 0; rep < REPS; rep++) {
    const r = new Renderer(canvas, track);
    for (let i = 0; i < WARM; i++) {
      play(r, i);
      ctx.getImageData(0, 0, 1, 1);
    }
    for (let i = WARM; i < WARM + FRAMES; i++) {
      const t0 = performance.now();
      const changed = play(r, i);
      ctx.getImageData(0, 0, 1, 1); // the frame is rastered before the clock is read
      const dt = performance.now() - t0;
      if (rep > 0) (changed ? change : plain).push(dt);
    }
  }

  // The repaint by itself: a sheet asked for in a state the pool does not hold (it holds one
  // sheet a colour by now), then the first blit from it, rastered.
  const paint: number[] = [], blit: number[] = [];
  const held = new Uint8Array(COLORS.length).fill(255);
  for (let n = 0; n < 240; n++) {
    const c = n % COLORS.length;
    spriteFrame();
    const next = held[c] === 255 ? 0 : (held[c] + 1) % 3;
    if (held[c] === 255) carSheet(COLORS[c], c % 3, 2); // so the next one asked for is not there
    held[c] = next;
    const t0 = performance.now();
    const sheet = carSheet(COLORS[c], c % 3, next);
    const t1 = performance.now();
    ctx.drawImage(sheet, 0, 0, 32, 32, 8, 8, 32, 32);
    ctx.getImageData(0, 0, 1, 1);
    const t2 = performance.now();
    if (n >= 60) {
      paint.push(t1 - t0);
      blit.push(t2 - t1);
    }
  }

  // And is a sheet painted again the sheet it should be? Every pixel of each one the pool holds.
  let compared = 0, wrong = 0;
  const want = new Uint32Array(SHEET_W * SHEET_H);
  for (let c = 0; c < COLORS.length; c++) {
    const sheet = carSheet(COLORS[c], c % 3, held[c]);
    const got = new Uint32Array(sheet.getContext("2d")!.getImageData(0, 0, SHEET_W, SHEET_H).data.buffer);
    carPixels(COLORS[c], want, c % 3, held[c]);
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) wrong++;
    compared += want.length;
  }
  say({
    done: true, track: trackId, canvas: kind, every: EVERY, isolated: crossOriginIsolated, userAgent: navigator.userAgent,
    plain: stat(plain), change: stat(change), paint: stat(paint), blit: stat(blit), compared, wrong, bytes: spriteBytes(), max: SPRITE_BYTES_MAX,
  });
}

main();
