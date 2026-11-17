// Debug-only feature preview (?debug=1&preview=1), loaded on demand by main.ts: a synthetic
// figure-eight with every track feature (ramps, a chasm, a crossing whose upper pass jumps
// the lower road, holes, a scrap-filled gap) and scripted car poses, for screenshots and the
// taste gate. Nothing here runs, or is even downloaded, without the flag.
//
// Keys 1-9 / arrows pick a scene. URL: &scene=<name> to start on one, &freeze=1 to hold the
// scene's key moment, &t=<seconds> to hold any moment, &hud=0 to hide the caption.

import { buildTrack, pointAt, queryTrackNear, type Track, type TrackDef } from "../shared/track";
import { trackById } from "../shared/tracks";
import { airTicksFor, FALL_TICKS, GHOST_TICKS } from "../shared/weapons";
import { Renderer, type CarView, type HudView } from "./render";

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const DT = 1 / 60;

// The figure-eight: the pass at s ~ 3650 runs over the origin, the one at s ~ 10951 under it.
const N = 16, A = 2400;
const BASE: TrackDef = {
  id: "preview-eight",
  name: "Feature Preview",
  halfWidth: 64,
  verge: 44,
  control: Array.from({ length: N }, (_, k): [number, number] => {
    const t = Math.PI / 2 + (2 * Math.PI * k) / N;
    return [Math.round(A * Math.sin(t)), Math.round(A * Math.sin(t) * Math.cos(t))];
  }),
};

function previewTrack(): { track: Track; sUp: number; sLow: number } {
  const plain = buildTrack(BASE);
  const sUp = queryTrackNear(plain, 0, 0, 64).s;
  const sLow = queryTrackNear(plain, 0, 0, 192).s;
  const half = 125; // the crossing gap, as in sim-test's figure-eight
  const def: TrackDef = {
    ...BASE,
    features: [
      { k: "hole", s: 1150, lat: -34, r: 22 },
      { k: "hole", s: 1330, lat: 30, r: 26 },
      { k: "hole", s: 1520, lat: -6, r: 20 },
      { k: "ramp", s: sUp - half - 60, len: 60 },
      { k: "gap", s0: sUp - half, s1: sUp + half },
      { k: "ramp", s: 5540, len: 60 },
      { k: "gap", s0: 5600, s1: 5790 },
      { k: "ramp", s: 8440, len: 60 },
      { k: "gap", s0: 8500, s1: 8650, scrap: true },
      { k: "hole", s: 12600, lat: 8, r: 28 },
    ],
    recovery: [0, 800, sUp - half - 460, 5100, 8000, 12150],
  };
  return { track: buildTrack(def), sUp, sLow };
}

interface Scene {
  name: string;
  title: string;
  rust?: boolean; // drawn on Rust Bowl instead of the preview track
  cam: () => { x: number; y: number };
  cars: (t: number) => CarView[];
  key: number; // seconds: the moment &freeze=1 holds
}

function car(track: Track, i: number, s: number, lat: number, more: Partial<CarView> = {}): CarView {
  const p = pointAt(track, s);
  return {
    id: `p${i}`,
    x: p.x - Math.sin(p.h) * lat,
    y: p.y + Math.cos(p.h) * lat,
    h: p.h,
    color: COLORS[i % COLORS.length],
    name: `Car ${i + 1}`,
    me: i === 0,
    wreck: false,
    ghost: false,
    ...more,
  };
}

/** Height of a car driving at v over the track's ramps at distance s (0 = grounded). */
function jumpHeight(track: Track, s: number, v: number): number {
  const flight = (v * airTicksFor(v)) / 60;
  for (const r of track.ramps) {
    const u = (s - (r.s + r.len)) / flight;
    if (u > 0 && u < 1) return 4 * u * (1 - u);
  }
  return 0;
}

/** A car looping from s0 at speed v over `dist` units, jumping any ramp on the way. */
function driver(track: Track, i: number, s0: number, dist: number, v: number, lat: number) {
  return (t: number): CarView => {
    const s = s0 + ((t * v) % dist);
    return car(track, i, s, lat, { height: jumpHeight(track, s, v) });
  };
}

/** Drives at v from s0 into a pit at sFall, falls for FALL_TICKS, then is recovered at sRec (ghost). */
function faller(track: Track, i: number, s0: number, sFall: number, sRec: number, v: number, lat: number) {
  const tDrive = (sFall - s0) / v;
  const tFall = FALL_TICKS * DT;
  const tGhost = GHOST_TICKS * DT;
  const period = tDrive + tFall + tGhost + 0.5;
  return (t: number): CarView => {
    const u = t % period;
    if (u < tDrive) return car(track, i, s0 + u * v, lat);
    if (u < tDrive + tFall) return car(track, i, sFall, lat, { falling: (u - tDrive) / tFall });
    const g = u - tDrive - tFall;
    return car(track, i, sRec + Math.max(0, g - 0.4) * v * 0.6, 0, { ghost: g < tGhost });
  };
}

function scenes(): Scene[] {
  const { track, sUp, sLow } = previewTrack();
  const rust = trackById("rust-bowl");
  const at = (t: Track, s: number) => () => pointAt(t, s);
  const v = 380; // take-off speed of the scripted jumps (MIN_TAKEOFF_SPEED is 220)
  const flight = (v * airTicksFor(v)) / 60;
  const crossJump = driver(track, 0, sUp - 600, 1200, v, 0);
  const lower = driver(track, 1, sLow - 500, 1000, 250, 14);
  const scrapJump = driver(track, 2, 8100, 900, v, -10);
  const holeRun = driver(track, 3, 950, 800, 240, 2);
  const holeFall = faller(track, 4, 12350, 12600 - 30, 12150, 200, 8);
  const chasmFall = faller(track, 5, 5450, 5612, 5100, 150, 20);
  // Key moments: the crossing jump at the top of its arc right over the lower road.
  const apex = sUp - 125 + flight / 2;
  const tApex = (apex - (sUp - 600)) / v;
  // The lower car is at the crossing 2 s into its loop: shift it to be there at tApex.
  // (40 units on, so the jumping car does not hide it completely).
  const lowerAt = (t: number) => lower(t + 2 - tApex + 40 / 250);
  return [
    {
      name: "ramp",
      title: "Ramp: striped wedge, arrows, hazard lip",
      cam: at(track, 5585),
      cars: (t) => [car(track, 0, 5470, -36), driver(track, 1, 5200, 900, v, 30)(t)],
      key: 0.1,
    },
    {
      name: "gap",
      title: "Gap: dark void with hazard edges",
      cam: at(track, 5680),
      cars: (t) => [chasmFall(t)],
      key: (5612 - 5450) / 150 + 0.3,
    },
    {
      name: "crossing",
      title: "Crossing: the lower road shows under the gap",
      cam: () => ({ x: 0, y: 0 }),
      cars: (t) => [lower(t)],
      key: 2.0,
    },
    {
      name: "hole",
      title: "Holes: dark pits",
      cam: at(track, 1330),
      cars: (t) => [holeRun(t)],
      key: 1.6,
    },
    {
      name: "scrap",
      title: "Scrap piles drawn over a gap",
      cam: at(track, 8560),
      cars: (t) => [scrapJump(t)],
      key: (8500 + flight / 4 - 8100) / v,
    },
    {
      name: "jump",
      title: "Jump in progress: bigger car, shadow away, drawn last",
      cam: () => ({ x: 0, y: 0 }),
      cars: (t) => [lowerAt(t), crossJump(t)],
      key: tApex,
    },
    {
      name: "fall",
      title: "Falling: shrinks and blinks",
      cam: at(track, 12600),
      cars: (t) => [holeFall(t)],
      key: (12570 - 12350) / 200 + 0.5,
    },
    {
      name: "ghost",
      title: "Recovered: blinks during its ghost time",
      cam: at(track, 12230),
      cars: (t) => [holeFall(t)],
      key: (12570 - 12350) / 200 + FALL_TICKS * DT + 0.3,
    },
    {
      name: "rust",
      title: "Rust Bowl (no features): as before",
      rust: true,
      cam: at(rust, 120),
      cars: () => [car(rust, 0, 40, -20), car(rust, 1, -60, 25), car(rust, 2, 200, 0, { ghost: true })],
      key: 0,
    },
  ];
}

/** Run the preview on the game canvas (the game itself is not started). */
export function runPreview(canvas: HTMLCanvasElement, params: URLSearchParams): void {
  const list = scenes();
  const renderers = new Map<boolean, Renderer>();
  const rendererFor = (rust: boolean) => {
    let r = renderers.get(rust);
    if (!r) {
      r = new Renderer(canvas, rust ? trackById("rust-bowl") : previewTrack().track);
      renderers.set(rust, r);
    }
    return r;
  };
  let index = Math.max(0, list.findIndex((s) => s.name === params.get("scene")));
  const fixedT = params.has("t") ? Number(params.get("t")) : params.get("freeze") === "1" ? null : undefined;
  const hud = params.get("hud") !== "0";
  const start = performance.now();

  window.addEventListener("keydown", (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= list.length) index = n - 1;
    else if (e.key === "ArrowRight") index = (index + 1) % list.length;
    else if (e.key === "ArrowLeft") index = (index - 1 + list.length) % list.length;
  });

  const frame = (now: number) => {
    const scene = list[index];
    // Held moments draw at a fixed clock too, so blinks are the same on every reload.
    const held = fixedT !== undefined;
    const t = fixedT === undefined ? (now - start) / 1000 : (fixedT ?? scene.key);
    const r = rendererFor(!!scene.rust);
    const cam = scene.cam();
    r.follow(cam.x, cam.y, 16, true);
    const view: HudView | null = hud
      ? {
          topLeft: [],
          time: "",
          notice: "",
          center: "",
          centerSub: "",
          banner: `PREVIEW ${index + 1}/${list.length}  ${scene.title}  (keys 1-${list.length})`,
          corner: "",
          debug: [],
          hp: null,
        }
      : null;
    r.frame(scene.cars(t), { shots: [], mines: [], sparks: [] }, view, held ? t * 1000 : now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
