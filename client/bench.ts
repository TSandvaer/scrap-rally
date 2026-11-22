// Debug-only render benchmark (?debug=1&bench=1), loaded on demand by main.ts: five scripted
// scenes on a fixed clock, on every track, timed three ways. Nothing here runs, or is even
// downloaded, without the flag. Method, baseline numbers and budget: PLAN-GFX.md, "Baseline".
// Runner (isolated page loads, five runs, the table): scripts/bench.ts, `npm run bench`.
//
// URL: &metric=A|B|C (default A)
//   A  every scripted frame once, synchronously, each followed by a 1x1 getImageData, on a
//      canvas created with willReadFrequently: main-thread JS + CPU (software) raster.
//      Before it, 300 unmeasured frames on a Renderer of their own (S4 and S5: only their
//      first second, looped, so the ground they go on to is first drawn while measured).
//   B  requestAnimationFrame-paced frames on a default canvas, no readback: the interval
//      between frames as the browser presents them (the game's own path).
//   C  JS heap growth over the frames of S3 (informational; Chrome only).
// &scene=S1..S5 &track=<id>: one cell. Without them every cell runs in this page, one after
// the other (a quick look: later cells then run on warm caches; the runner loads one cell
// per page). &scene=S6 is a cell of its own, on the Preview Yard test track whatever &track
// says (M4-WORLD: the road's furniture; it is not among the cells a page runs without &scene,
// and the gate does not judge it: tools/debug/world-bench.ts holds it against S2). &track may
// also name a test track (shared/testtracks.ts) for S4 under metric A: the lap needs no spots.
// &scene=S7 is a cell of its own too (TH-LOOK-1; PLAN-THEMES.md 2.4): S6's frames and then S4's
// lap, on the Preview Yard in another theme, `&theme=<name>` (default desert; scrapyard gives the
// same frames on the yard's own look). `&theme=` switches the look of any other cell's track as
// well (gfx/theme.ts themedTrack: the benchmark's and the preview's switch, never the game's);
// without it every cell is what it was. Under metric A a cell also notes the tiles baked and the
// cost units spent on them while it was measured (gfx/world.ts worldStats).
// &frames=<n> &warm=<n> &over=<ms> &canvas=sw|default|gpu &readback=0|1
// &panel=<element id> (metric B: show that DOM panel over the canvas). &hold=<frame> draws
// that one frame of the cell and stops (no timing): what a bench scene looks like.
// Results: window.scrapBench and the panel on screen.

import { BASE_STATS } from "../shared/physics";
import { testTrack } from "../shared/testtracks";
import { gridSlot, pointAt, recoveryAt, type Track } from "../shared/track";
import { trackById, trackList } from "../shared/tracks";
import { airTicksFor, FALL_TICKS, GHOST_TICKS, RIVET_RANGE, RIVET_SPEED } from "../shared/weapons";
import { isTheme, themedTrack, themeOf } from "./gfx/theme";
import { worldStats } from "./gfx/world";
import { Renderer, type CarView, type CellView, type HudView, type WorldFx } from "./render";

const FPS = 60;
const FRAME_MS = 1000 / FPS;
const CLOCK0 = 10_000; // the fixed clock: frame i is drawn at CLOCK0 + i * FRAME_MS
const SEED = 0x5c2a9;
const FRAMES = 600;
const WARM_A = 300; // unmeasured frames first (JIT, caches), on a Renderer of their own
const WARM_B = 60;
const LEAD_IN = 60; // S5's approach to the hazard; all of S4 and S5 that a warm-up draws (warmIndex)
const OVER_A_MS = 4; // metric A counts the frames slower than this ...
const OVER_B_MS = 20; // ... metric B the frame intervals longer than this
const CHECK_EVERY = 50; // the checksum hashes every 50th frame and the last
const TOP = BASE_STATS.topSpeed;

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"]; // server/room.ts
// The longest name the server allows (12), one with æøå and one outside Latin (font fallback).
const NAMES = ["You", "Rustbucket", "Åse Ørn", "Bolt", "SkidMarks 12", "Иван"];

export const SCENES = ["S1", "S2", "S3", "S4", "S5"] as const;
/** The scene of the Preview Yard test track: asked for by name, never part of a run of all cells. */
export const YARD_SCENE = "S6";
export const YARD_TRACK = "preview-yard";
/** The scene of a themed Preview Yard: asked for by name too. */
export const THEME_SCENE = "S7";
export type SceneId = (typeof SCENES)[number] | typeof YARD_SCENE | typeof THEME_SCENE;
const TITLES: Record<SceneId, string> = {
  S1: "grid: 6 cars, countdown",
  S2: "features: jump, fall, ghost",
  S3: "firefight: 12 shots, 6 mines, 6 sparks, 2 wrecks",
  S4: "lap at 430 u/s, 6 cars",
  S5: "recovery teleport, 3 leader cuts",
  S6: "Preview Yard: 6 cars, barrels, press, truck, pools, 3 cells",
  S7: "Preview Yard in a theme: S6's views, then a lap at 430 u/s",
};

/** One scripted frame: everything Renderer.follow / shake / frame is given. */
interface Frame {
  cx: number;
  cy: number;
  snap: boolean;
  shake: number;
  cars: CarView[];
  fx: WorldFx;
  hud: HudView | null;
}

/** Where each scene plays on a track (distances along it). */
interface Spots {
  /** S2: the camera, the lip the jumpers take off from (a real ramp's, or a made-up hop). */
  feature: { cam: number; lip: number; fall: number; ghost: number; lower: number | null };
  /** S3: the camera; lip = the ramp end the cars jump from, if a gap is in view. */
  fight: { cam: number; lip: number | null };
  /** S5: where the own car falls (it is put back at the recovery point before it). */
  fall: number;
  /** S4 under metric B: the 600 frames start here, so they cross the track's features. */
  bStart: number;
}

const SPOTS: Record<string, Spots> = {
  // No features: the jump, the fall and the ghost are drawn on the top straight.
  "rust-bowl": { feature: { cam: 3000, lip: 2950, fall: 3040, ghost: 2800, lower: null }, fight: { cam: 120, lip: null }, fall: 5200, bStart: 0 },
  // The chasm (ramp 6650, gap 6730-6950); the first scrap pile (ramp 3420, gap 3500-3630).
  "crusher-run": { feature: { cam: 6800, lip: 6730, fall: 6760, ghost: 6560, lower: null }, fight: { cam: 3560, lip: 3500 }, fall: 6745, bStart: 3000 },
  // The crossing (ramp 7695, gap 7775-8011 over the lower road at 2818); the pit at 5300.
  "overpass-knot": { feature: { cam: 7893, lip: 7775, fall: 7800, ghost: 7600, lower: 2818 }, fight: { cam: 5300, lip: null }, fall: 5290, bStart: 4500 },
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

function carAt(track: Track, i: number, s: number, lat: number, more: Partial<CarView> = {}): CarView {
  const p = pointAt(track, s);
  return {
    id: `b${i}`,
    x: p.x - Math.sin(p.h) * lat,
    y: p.y + Math.cos(p.h) * lat,
    h: p.h,
    color: COLORS[i % COLORS.length],
    name: NAMES[i % NAMES.length],
    me: i === 0,
    wreck: false,
    ghost: false,
    ...more,
  };
}

/** 0..1 height of a car at distance s that took off at `lip` with speed v (0 = grounded). */
function hop(s: number, lip: number, v: number): number {
  const u = (s - lip) / ((v * airTicksFor(v)) / FPS);
  return u > 0 && u < 1 ? 4 * u * (1 - u) : 0;
}

/** Height over the track's own ramps at lap distance s. */
function rampHop(track: Track, s: number, v: number): number {
  const lap = ((s % track.length) + track.length) % track.length;
  for (const r of track.ramps) {
    const h = hop(lap, r.s + r.len, v);
    if (h > 0) return h;
  }
  return 0;
}

function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor((ms % 1000) / 100);
  return `${m}:${String(s).padStart(2, "0")}.${t}`;
}

/** The HUD of a car in a race (main.ts hudView); the time ticks with the frame. */
function raceHud(i: number, more: Partial<HudView> = {}): HudView {
  return {
    topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"],
    time: formatTime(83_400 + i * FRAME_MS),
    notice: "",
    center: "",
    centerSub: "",
    banner: "",
    corner: "23 ms",
    debug: [],
    hp: 0.62,
    ...more,
  };
}

const NO_FX: WorldFx = { shots: [], mines: [], sparks: [] };

/** S1: the starting grid, nothing moving but the countdown. */
function gridScene(track: Track, n: number): Frame[] {
  const cars = Array.from({ length: 6 }, (_, i): CarView => {
    const g = gridSlot(track, i);
    return { id: `b${i}`, x: g.x, y: g.y, h: g.h, color: COLORS[i], name: NAMES[i], me: i === 0, wreck: false, ghost: false };
  });
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const center = ["3", "2", "1", "GO!"][Math.floor(i / FPS) % 4];
    const hud = raceHud(i, { topLeft: ["LAP 1/3", "POS 1/6", "RIV  60 MINE 3"], time: "", center, hp: 1 });
    out.push({ cx: cars[0].x, cy: cars[0].y, snap: i === 0, shake: 0, cars, fx: NO_FX, hud });
  }
  return out;
}

/** S2: a fixed camera on a jump; three cars take it in turn, one falls, one is a ghost. */
function featureScene(track: Track, n: number, rnd: () => number): Frame[] {
  const f = SPOTS[track.def.id].feature;
  const cam = pointAt(track, f.cam);
  const v = 400;
  const from = f.lip - 380, dist = 950;
  const lanes = [0, 30, -30].map((lat) => lat + (rnd() - 0.5) * 8);
  const jumper = (k: number, i: number): CarView => {
    const s = from + ((i * (v / FPS) + (k * dist) / 3) % dist);
    return carAt(track, [0, 1, 4][k], s, lanes[k], { height: hop(s, f.lip, v) });
  };
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const cars = [
      jumper(0, i),
      jumper(1, i),
      carAt(track, 2, f.fall, 20, { falling: ((i % FALL_TICKS) + 0.5) / FALL_TICKS }),
      carAt(track, 3, f.ghost + (i % 300) * 0.5, -12, { ghost: true }),
      jumper(2, i),
      f.lower === null ? carAt(track, 5, f.cam - 300, -70) : carAt(track, 5, f.lower - 450 + ((i * 5) % 900), 14),
    ];
    out.push({ cx: cam.x, cy: cam.y, snap: i === 0, shake: 0, cars, fx: NO_FX, hud: raceHud(i) });
  }
  return out;
}

/** S3: a fixed camera on a fight: every effect at once, two wrecks smoking, the full HUD. */
function fightScene(track: Track, n: number, rnd: () => number): Frame[] {
  const f = SPOTS[track.def.id].fight;
  const cam = pointAt(track, f.cam);
  const from = f.cam - 260, dist = 520;
  const drivers = [
    { i: 0, v: 320, lat: 0, ph: 0 },
    { i: 3, v: 280, lat: 34, ph: 0.3 },
    { i: 4, v: 350, lat: -30, ph: 0.6 },
    { i: 5, v: 250, lat: 12, ph: 0.8 },
  ].map((d) => ({ ...d, lat: d.lat + (rnd() - 0.5) * 8 }));
  const wrecks = [carAt(track, 1, f.cam - 120, -40, { wreck: true }), carAt(track, 2, f.cam + 90, 45, { wreck: true })];
  const life = Math.floor((RIVET_RANGE / RIVET_SPEED) * FPS);
  const guns = Array.from({ length: 12 }, (_, k) => {
    const p = carAt(track, 0, f.cam - 200 + k * 35, ((k * 37) % 100) - 50 + (rnd() - 0.5) * 6);
    const a = p.h + (k % 2 ? Math.PI : 0) + (rnd() - 0.5) * 0.2;
    return { x: p.x, y: p.y, vx: Math.cos(a) * RIVET_SPEED, vy: Math.sin(a) * RIVET_SPEED };
  });
  const mines = [-40, 30, -10, 48, -52, 15].map((lat, k) => {
    const p = carAt(track, 0, f.cam - 180 + k * 70, lat);
    return { x: p.x, y: p.y, armed: k < 4 };
  });
  const hits = [20, -35, 0, 40, -20, 10].map((lat, k) => carAt(track, 0, f.cam - 150 + k * 60, lat));
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const cars = drivers.map((d) => {
      const s = from + ((i * (d.v / FPS) + d.ph * dist) % dist);
      return carAt(track, d.i, s, d.lat, { height: f.lip === null ? 0 : hop(s, f.lip, d.v) });
    });
    cars.splice(1, 0, ...wrecks);
    const fx: WorldFx = {
      shots: guns.map((g, k) => {
        const t = ((i + k * 5) % life) / FPS;
        return { x: g.x + g.vx * t, y: g.y + g.vy * t, vx: g.vx, vy: g.vy };
      }),
      mines,
      sparks: hits.map((h, k) => ({ x: h.x, y: h.y, age: ((i + k * 3) % 16) / 16 })),
    };
    const hud = raceHud(i, { notice: "WEAPONS ARMED IN 5", banner: "Winner is in — race closes in 12s" });
    out.push({ cx: cam.x, cy: cam.y, snap: i === 0, shake: i % FPS === 0 ? 3 : 0, cars, fx, hud });
  }
  return out;
}

/** S4: a pack of six at top speed for a lap, the camera on the own car as in a race. */
function lapScene(track: Track, n: number, rnd: () => number): Frame[] {
  const pack = [0, 40, -45, 90, -95, 150].map((ds, i) => ({ ds, lat: i ? [-30, 28, 10, -12, 35][i - 1] + (rnd() - 0.5) * 8 : 0 }));
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const s = (i * TOP) / FPS;
    const cars = pack.map((c, k) => carAt(track, k, s + c.ds, c.lat, { height: rampHop(track, s + c.ds, TOP) }));
    const own = cars[0];
    // main.ts draw(): the own car with a little look-ahead.
    out.push({ cx: own.x + Math.cos(own.h) * TOP * 0.28, cy: own.y + Math.sin(own.h) * TOP * 0.28, snap: i === 0, shake: 0, cars, fx: NO_FX, hud: raceHud(i) });
  }
  return out;
}

/** Frames of a full lap at top speed. */
function lapFrames(track: Track): number {
  return Math.ceil((track.length / TOP) * FPS);
}

/**
 * S5: the camera's two long moves. The own car drives into a hazard, falls, and is put back
 * at the recovery point (frames 0-299); then it is gone and the camera follows the leader,
 * which changes twice to a car far away (300-599). The camera eases as in main.ts draw().
 */
function teleportScene(track: Track, n: number, rnd: () => number): Frame[] {
  const sFall = SPOTS[track.def.id].fall;
  const sRec = recoveryAt(track, sFall);
  const L = track.length;
  const others = [1, 2, 3, 4, 5].map((k) => ({ k, s0: (k * L) / 6, lat: (rnd() - 0.5) * 60 }));
  const fallEnd = LEAD_IN + FALL_TICKS;
  const half = Math.floor(n / 2);
  const cutEvery = Math.max(1, Math.floor((n - half) / 3));
  const leaders = [1, 4, 2];
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const cars = others.map((o) => {
      const s = o.s0 + (i * 380) / FPS;
      return carAt(track, o.k, s, o.lat, { height: rampHop(track, s, 380) });
    });
    let cx: number, cy: number, hud: HudView;
    if (i < half) {
      let own: CarView, speed = 0;
      if (i < LEAD_IN) {
        own = carAt(track, 0, sFall - 300 + i * 5, 0);
        speed = 300;
      } else if (i < fallEnd) {
        own = carAt(track, 0, sFall, 0, { falling: (i - LEAD_IN + 1) / FALL_TICKS });
      } else {
        // Put back as a ghost: a moment standing, then away at full throttle.
        const t = Math.max(0, i - fallEnd - 24) / FPS;
        const tTop = TOP / BASE_STATS.accel;
        speed = Math.min(TOP, BASE_STATS.accel * t);
        const s = t < tTop ? 0.5 * BASE_STATS.accel * t * t : 0.5 * TOP * tTop + TOP * (t - tTop);
        own = carAt(track, 0, sRec + s, 0, { ghost: i < fallEnd + GHOST_TICKS });
      }
      cars.unshift(own);
      cx = own.x + Math.cos(own.h) * speed * 0.28;
      cy = own.y + Math.sin(own.h) * speed * 0.28;
      hud = raceHud(i);
    } else {
      const lead = cars[leaders[Math.min(2, Math.floor((i - half) / cutEvery))] - 1];
      cx = lead.x;
      cy = lead.y;
      hud = raceHud(i, { topLeft: [], hp: null, banner: "Race in progress — you're in the next one" });
    }
    out.push({ cx, cy, snap: i === 0, shake: 0, cars, fx: NO_FX, hud });
  }
  return out;
}

/**
 * S6 (PLAN-M4.md section 3 calls it "S5"): the road's furniture on the Preview Yard test track.
 * Three fixed views, a third of the frames each, six cars and three lightning cells in every
 * one, the race tick running a tick a frame (so the barrels roll and the press goes through its
 * cycle, three seconds long, in each view's 200 frames): the last tyre mound, the row of
 * barrels and the pool right across the road; the ramp truck (one car up its ramp and over
 * the cab) and the pool on the inside of the bend; the split with the press on its dirt lane,
 * the island and the flooded lane. The cars are scripted: nothing pushes them.
 */
function yardScene(track: Track, n: number, rnd: () => number): Frame[] {
  const each = Math.max(1, Math.floor(n / 3));
  const truck = track.trucks[0];
  const v = 380, flight = (v * airTicksFor(v)) / FPS;
  const cell = (s: number, lat: number, air: boolean): CellView => {
    const p = pointAt(track, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, air, state: 0 };
  };
  const views = [
    { cam: 1350, from: 1000, dist: 720, lanes: [-56, 14, 36, 56, -50, 24], cells: [cell(1180, -58, false), cell(1390, 58, false), cell(1530, 20, false)] },
    { cam: 3650, from: 3300, dist: 720, lanes: [truck.lat, -40, -24, -48, -30, -16], cells: [cell(truck.lip + flight / 2, truck.lat + 28, true), cell(3900, -30, false), cell(3760, 58, false)] },
    { cam: 6640, from: 6260, dist: 680, lanes: [76, -76, 84, -70, 68, -84], cells: [cell(6450, -112, false), cell(6700, 118, false), cell(6300, 118, false)] },
  ].map((w) => ({ ...w, at: pointAt(track, w.cam), lanes: w.lanes.map((lat, k) => (k ? lat + (rnd() - 0.5) * 6 : lat)), pace: [300, 280, 320, 260, 340, 290] }));
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const k = Math.min(2, Math.floor(i / each)), w = views[k];
    const cars = w.lanes.map((lat, c) => {
      const s = w.from + ((i * (w.pace[c] / FPS) + (c * w.dist) / 6) % w.dist);
      // The first car of the second view takes the truck's ramp, and flies from its lip.
      if (k === 1 && c === 0) {
        const at = w.from + ((i * (v / FPS)) % w.dist);
        const u = (at - truck.lip) / flight;
        return carAt(track, c, at, lat, { height: u > 0 && u < 1 ? 4 * u * (1 - u) : 0 });
      }
      return carAt(track, c, s, lat, { car: (["sport", "racer", "truck"] as const)[c % 3] });
    });
    out.push({ cx: w.at.x, cy: w.at.y, snap: i % each === 0 && i < 3 * each, shake: 0, cars, fx: { shots: [], mines: [], sparks: [], cells: w.cells, rt: i }, hud: raceHud(i) });
  }
  return out;
}

/** The scripted frames of a scene on a track (the same on every call: fixed seed). */
function script(scene: SceneId, track: Track, n: number): Frame[] {
  const rnd = mulberry32(SEED);
  switch (scene) {
    case "S1":
      return gridScene(track, n);
    case "S2":
      return featureScene(track, n, rnd);
    case "S3":
      return fightScene(track, n, rnd);
    case "S4":
      return lapScene(track, n, rnd);
    case "S5":
      return teleportScene(track, n, rnd);
    case "S6":
      return yardScene(track, n, rnd);
    case "S7": {
      // S6's frames (its three views), then S4's lap of the same track: the furniture standing
      // in view, then every tile of the yard baked on the way round.
      const views = Math.min(n, FRAMES);
      return [...yardScene(track, views, rnd), ...lapScene(track, n - views, rnd)];
    }
  }
}

/**
 * The frame a warm-up draws as its i-th. A scene with a fixed camera (S1-S3) warms up on its
 * own frames: its steady state is what it measures. S4 and S5 move, and what they measure is
 * ground drawn for the first time (the lap ahead, the recovery point, the places the leaders
 * are): their warm-up loops the first second only, the stretch the measured run starts on.
 * It never shows the own car falling or the leader changing, so a renderer that keeps baked
 * ground between Renderers, or bakes a destination ahead of a recovery or a leader change,
 * has seen none of it when the measurement starts.
 */
function warmIndex(scene: SceneId, i: number, n: number): number {
  return scene === "S4" || scene === "S5" ? i % Math.min(LEAD_IN, n) : i % n;
}

// ---- clock ------------------------------------------------------------------------

// The renderer reads performance.now() itself (smoke, the mine blink, shake), so the bench
// pins it to the fixed clock while it draws and keeps the real one for its own timing.
const realNow = performance.now.bind(performance);
let clock = CLOCK0;

function pinClock(on: boolean): void {
  if (on) performance.now = () => clock;
  else delete (performance as { now?: unknown }).now;
}

function play(r: Renderer, f: Frame, i: number): void {
  clock = CLOCK0 + i * FRAME_MS;
  if (f.shake) r.shake(f.shake);
  r.follow(f.cx, f.cy, FRAME_MS, f.snap);
  r.frame(f.cars, f.fx, f.hud, clock);
}

// ---- results ----------------------------------------------------------------------

export interface CellA {
  metric: "A";
  scene: SceneId;
  track: string;
  n: number;
  warm: number;
  ctorMs: number; // new Renderer(), first of the page
  firstMs: number; // its first frame (cold caches)
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  overMs: number;
  over: number; // frames slower than overMs
  head: number[]; // the first six frame times (a canvas switching to software shows here)
  checksum: string; // FNV-1a of every CHECK_EVERY-th frame's pixels: equal = the same picture
  theme: string; // the theme the cell's track was drawn in (gfx/theme.ts)
  baked: number; // tiles baked while the frames were measured ...
  bakeUnits: number; // ... and the cost units a frame's share of the baking spent on them (worldStats.units)
}

export interface CellB {
  metric: "B";
  scene: SceneId;
  track: string;
  n: number;
  warm: number;
  startFrame: number;
  p50: number; // frame interval, ms
  p95: number;
  p99: number;
  max: number;
  over20: number; // intervals longer than OVER_B_MS
  jsP50: number; // the frame() call itself (on a GPU canvas: recording, not raster)
  jsP95: number;
  panel: string;
}

export interface CellC {
  metric: "C";
  scene: SceneId;
  track: string;
  n: number;
  supported: boolean;
  deltaBytes: number; // used heap after - before (a GC in between makes it small or negative)
  allocBytes: number; // the sum of the per-frame increases (drops at a GC ignored)
  probeBytes: number; // the same loop without drawing: what reading the heap size costs
  gcDrops: number;
}

export type Cell = CellA | CellB | CellC;

export interface BenchOut {
  version: 1;
  done: boolean;
  error: string;
  metric: "A" | "B" | "C";
  env: {
    ua: string;
    dpr: number;
    width: number;
    height: number;
    canvasCss: number; // CSS width of the canvas
    isolated: boolean; // crossOriginIsolated: the timer is 5 us instead of 100 us
    timerMs: number; // the smallest step of performance.now() seen
    canvas: string; // sw | default | gpu
    readback: boolean;
  };
  cells: Cell[];
}

function quantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function summary(times: Float64Array): { mean: number; p50: number; p95: number; p99: number; max: number } {
  const s = Float64Array.from(times).sort();
  let sum = 0;
  for (const t of s) sum += t;
  return { mean: sum / s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s[s.length - 1] };
}

function countOver(times: Float64Array, ms: number): number {
  let k = 0;
  for (const t of times) if (t > ms) k++;
  return k;
}

function timerStep(): number {
  let best = Infinity, prev = realNow();
  for (let i = 0; i < 200_000; i++) {
    const t = realNow();
    if (t !== prev) {
      best = Math.min(best, t - prev);
      prev = t;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

function fnv(h: number, px: Uint32Array): number {
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i], 16777619);
  return h >>> 0;
}

const yieldToPage = () => new Promise<void>((done) => setTimeout(done, 0));

// ---- the three metrics ------------------------------------------------------------

interface Opts {
  frames: number | null; // null = the scene's own count
  warm: number | null;
  overMs: number;
  readback: boolean;
  panel: string;
}

function framesFor(scene: SceneId, track: Track, o: Opts): Frame[] {
  return script(scene, track, o.frames ?? (scene === "S4" ? lapFrames(track) : scene === "S7" ? FRAMES + lapFrames(track) : FRAMES));
}

function runA(canvas: HTMLCanvasElement, scene: SceneId, track: Track, o: Opts): CellA {
  const frames = framesFor(scene, track, o);
  const n = frames.length;
  const warm = Math.min(n, o.warm ?? WARM_A);
  const ctx = canvas.getContext("2d")!;
  const read = () => {
    if (o.readback) ctx.getImageData(0, 0, 1, 1);
  };
  pinClock(true);
  try {
    let t0 = realNow();
    const warmer = new Renderer(canvas, track);
    const ctorMs = realNow() - t0;
    t0 = realNow();
    play(warmer, frames[0], 0);
    read();
    const firstMs = realNow() - t0;
    for (let i = 1; i < warm; i++) {
      const k = warmIndex(scene, i, n);
      play(warmer, frames[k], k);
      read();
    }

    const r = new Renderer(canvas, track);
    const times = new Float64Array(n);
    const baked0 = worldStats.baked, units0 = worldStats.units;
    for (let i = 0; i < n; i++) {
      t0 = realNow();
      play(r, frames[i], i);
      read();
      times[i] = realNow() - t0;
    }
    const baked = worldStats.baked - baked0, bakeUnits = worldStats.units - units0;

    // The same frames once more for the checksum (the camera eases, so every frame's follow
    // runs; only the hashed frames are drawn).
    const c = new Renderer(canvas, track);
    let hash = 2166136261;
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      clock = CLOCK0 + i * FRAME_MS;
      if (f.shake) c.shake(f.shake);
      c.follow(f.cx, f.cy, FRAME_MS, f.snap);
      if (i % CHECK_EVERY && i !== n - 1) continue;
      c.frame(f.cars, f.fx, f.hud, clock);
      hash = fnv(hash, new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer));
    }
    return {
      metric: "A",
      scene,
      track: track.def.id,
      n,
      warm,
      ctorMs,
      firstMs,
      ...summary(times),
      overMs: o.overMs,
      over: countOver(times, o.overMs),
      head: Array.from(times.subarray(0, 6)),
      checksum: hash.toString(16).padStart(8, "0"),
      theme: themeOf(track),
      baked,
      bakeUnits,
    };
  } finally {
    pinClock(false);
  }
}

function runB(canvas: HTMLCanvasElement, scene: SceneId, track: Track, o: Opts): Promise<CellB> {
  const lap = scene === "S4";
  const n = o.frames ?? FRAMES;
  const warm = o.warm ?? WARM_B;
  const all = script(scene, track, lap ? lapFrames(track) : n);
  // The 600 frames of the lap start where the track's features are, and its warm-up is the
  // stretch that leads up to them; any other scene warms up as under metric A (warmIndex).
  const startFrame = lap ? Math.round((SPOTS[track.def.id].bStart / TOP) * FPS) : 0;
  const frameAt = (k: number) => {
    const i = k < 0 && !lap ? warmIndex(scene, k + warm, all.length) : (((startFrame + k) % all.length) + all.length) % all.length;
    return { f: all[i], i };
  };
  const r = new Renderer(canvas, track);
  const stamps = new Float64Array(n + 1);
  const js = new Float64Array(n);
  return new Promise((done) => {
    let k = -warm;
    pinClock(true);
    const tick = (ts: number) => {
      if (k >= 0 && k <= n) stamps[k] = ts;
      if (k === n) {
        pinClock(false);
        const gaps = new Float64Array(n);
        for (let j = 0; j < n; j++) gaps[j] = stamps[j + 1] - stamps[j];
        const g = summary(gaps), j = summary(js);
        done({
          metric: "B", scene, track: track.def.id, n, warm, startFrame,
          p50: g.p50, p95: g.p95, p99: g.p99, max: g.max, over20: countOver(gaps, OVER_B_MS),
          jsP50: j.p50, jsP95: j.p95, panel: o.panel,
        });
        return;
      }
      const { f, i } = frameAt(k);
      const t0 = realNow();
      // The camera snaps on the first frame drawn, then eases as scripted.
      play(r, k === -warm ? { ...f, snap: true } : f, i);
      if (k >= 0) js[k] = realNow() - t0;
      k++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function runC(canvas: HTMLCanvasElement, scene: SceneId, track: Track, o: Opts): CellC {
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  const frames = framesFor(scene, track, o);
  const n = frames.length;
  const none: CellC = { metric: "C", scene, track: track.def.id, n, supported: false, deltaBytes: 0, allocBytes: 0, probeBytes: 0, gcDrops: 0 };
  if (!mem) return none;
  const used = () => (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
  pinClock(true);
  try {
    const warmer = new Renderer(canvas, track);
    for (let i = 0; i < Math.min(n, o.warm ?? WARM_A); i++) {
      const k = warmIndex(scene, i, n);
      play(warmer, frames[k], k);
    }
    const r = new Renderer(canvas, track);
    let probeBytes = 0, last = used();
    for (let i = 0; i < n; i++) {
      const u = used();
      if (u > last) probeBytes += u - last;
      last = u;
    }
    const before = (last = used());
    let allocBytes = 0, gcDrops = 0;
    for (let i = 0; i < n; i++) {
      play(r, frames[i], i);
      const u = used();
      if (u > last) allocBytes += u - last;
      else if (u < last) gcDrops++;
      last = u;
    }
    return { ...none, supported: true, deltaBytes: last - before, allocBytes, probeBytes, gcDrops };
  } finally {
    pinClock(false);
  }
}

// ---- page -------------------------------------------------------------------------

function f2(x: number): string {
  return x.toFixed(x < 10 ? 3 : 2).padStart(7);
}

function report(out: BenchOut): string {
  const e = out.env;
  const lines = [
    `SCRAP RALLY BENCH  metric ${out.metric}  ${e.width}x${e.height} @${e.dpr}x  canvas ${e.canvas}${out.metric === "A" ? (e.readback ? " + readback" : ", no readback") : ""}`,
    `timer ${(e.timerMs * 1000).toFixed(0)} us${e.isolated ? "" : " (not cross-origin isolated: coarse)"}  ${out.done ? "done" : "running..."}${out.error ? `  ERROR ${out.error}` : ""}`,
    "",
  ];
  if (out.metric === "A") lines.push(`scene track           n   median     p95     p99     max  >${OVER_A_MS}ms   first    ctor  checksum`);
  if (out.metric === "B") lines.push("scene track           n   median     p95     p99     max  >20ms  js p50  js p95");
  if (out.metric === "C") lines.push("scene track           n  bytes/frame  alloc kB  delta kB  GCs");
  for (const c of out.cells) {
    const id = `${c.scene}    ${c.track.padEnd(14)}${String(c.n).padStart(5)}`;
    if (c.metric === "A") lines.push(`${id}  ${f2(c.p50)} ${f2(c.p95)} ${f2(c.p99)} ${f2(c.max)} ${String(c.over).padStart(6)} ${f2(c.firstMs)} ${f2(c.ctorMs)}  ${c.checksum}`);
    else if (c.metric === "B") lines.push(`${id}  ${f2(c.p50)} ${f2(c.p95)} ${f2(c.p99)} ${f2(c.max)} ${String(c.over20).padStart(6)} ${f2(c.jsP50)} ${f2(c.jsP95)}`);
    else if (!c.supported) lines.push(`${id}  performance.memory is not available in this browser`);
    else lines.push(`${id}  ${String(Math.round((c.allocBytes - c.probeBytes) / c.n)).padStart(11)}  ${(c.allocBytes / 1024).toFixed(0).padStart(8)}  ${(c.deltaBytes / 1024).toFixed(0).padStart(8)}  ${String(c.gcDrops).padStart(3)}`);
  }
  lines.push("", ...[...SCENES, YARD_SCENE, THEME_SCENE].map((s) => `${s}  ${TITLES[s as SceneId]}`));
  return lines.join("\n");
}

/** Run the benchmark on the game canvas (the game itself is not started). */
export async function runBench(view: HTMLCanvasElement, params: URLSearchParams): Promise<void> {
  const metric = ((params.get("metric") ?? "A").toUpperCase() as BenchOut["metric"]);
  const mode = params.get("canvas") ?? (metric === "B" ? "default" : "sw");
  const num = (key: string) => (params.has(key) ? Number(params.get(key)) : null);
  const opts: Opts = {
    frames: num("frames"),
    warm: num("warm"),
    overMs: num("over") ?? OVER_A_MS,
    readback: params.get("readback") !== "0",
    panel: params.get("panel") ?? "",
  };

  // A canvas of our own in the game canvas's place (same id, same CSS): main.ts has already
  // made a context on the original, and the context's attributes are fixed by its first use.
  const canvas = view.cloneNode(false) as HTMLCanvasElement;
  view.replaceWith(canvas);
  if (mode === "sw") canvas.getContext("2d", { willReadFrequently: true });
  else if (mode === "gpu") canvas.getContext("2d", { willReadFrequently: false });

  const panel = document.createElement("pre");
  panel.id = "bench-out";
  panel.style.cssText =
    "position:fixed;left:8px;top:8px;margin:0;padding:8px 10px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;" +
    "background:rgba(10,8,6,0.9);color:#9fe08a;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;z-index:99;white-space:pre";
  const out: BenchOut = {
    version: 1,
    done: false,
    error: "",
    metric,
    env: {
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
      canvasCss: canvas.getBoundingClientRect().width,
      isolated: self.crossOriginIsolated === true,
      timerMs: timerStep(),
      canvas: mode,
      readback: metric === "A" && opts.readback,
    },
    cells: [],
  };
  (window as unknown as { scrapBench: BenchOut }).scrapBench = out;
  const show = () => {
    panel.textContent = report(out);
  };
  // Metric B measures what the browser presents: nothing of ours over the canvas meanwhile.
  if (metric !== "B") document.body.append(panel);
  if (opts.panel) document.getElementById(opts.panel)?.classList.remove("hidden");

  try {
    if (!["A", "B", "C"].includes(metric)) throw new Error(`unknown metric ${metric}`);
    const one = params.get("scene")?.toUpperCase() as SceneId | undefined;
    const yard = one === YARD_SCENE || one === THEME_SCENE;
    if (one && !yard && !(SCENES as readonly string[]).includes(one)) throw new Error(`unknown scene ${one}`);
    const scenes: SceneId[] = one ? [one] : metric === "A" ? [...SCENES] : [metric === "B" ? "S4" : "S3"];
    const named = params.get("track");
    // The look of another theme on the cell's track: asked for with &theme=, and S7's by default.
    const asked = params.get("theme") ?? (one === THEME_SCENE ? "desert" : null);
    if (asked !== null && !isTheme(asked)) throw new Error(`unknown theme ${asked}`);
    const themed = (t: Track): Track => (isTheme(asked) ? themedTrack(t, asked) : t);
    const tracks = (yard ? [testTrack(YARD_TRACK)!] : named ? [testTrack(named) ?? trackById(named)] : trackList().map((e) => trackById(e.id))).map(themed);
    const hold = num("hold");
    if (hold !== null) {
      const frames = framesFor(scenes[0], tracks[0], opts);
      const last = Math.max(0, Math.min(frames.length - 1, Math.floor(hold)));
      const r = new Renderer(canvas, tracks[0]);
      pinClock(true);
      for (let i = 0; i < last; i++) {
        clock = CLOCK0 + i * FRAME_MS;
        if (frames[i].shake) r.shake(frames[i].shake);
        r.follow(frames[i].cx, frames[i].cy, FRAME_MS, frames[i].snap);
      }
      play(r, frames[last], last);
      pinClock(false);
      panel.remove();
      out.done = true;
      return;
    }
    for (const track of tracks) {
      if (!yard && !SPOTS[track.def.id] && !(one === "S4" && metric === "A")) throw new Error(`no bench spots for track ${track.def.id}`);
      for (const scene of scenes) {
        show();
        await yieldToPage();
        if (metric === "A") out.cells.push(runA(canvas, scene, track, opts));
        else if (metric === "B") out.cells.push(await runB(canvas, scene, track, opts));
        else out.cells.push(runC(canvas, scene, track, opts));
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.done = true;
  if (metric === "B") document.body.append(panel);
  show();
}
