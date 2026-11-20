// The scenes of tools/debug/mines-blink.ts, for its Node probe and its browser page alike: a
// standing view of the road with a pack of six driving through it again and again, and `count`
// mines lying in the view, `blinking` of them on their way out (shared/protocol.ts MineSnap:
// `out`, the ticks until the mine is gone, counting down a tick a frame as a race's snapshots
// do; the others have no `out` at all, as in a race). Everything is built before anything is
// measured; stepping a scene allocates nothing.

import type { CarView, WorldFx } from "../../../client/render";
import type { Track } from "../../../shared/track";

export const SCENES = [
  { name: "6 mines", count: 6, blinking: 0 },
  { name: "40 mines", count: 40, blinking: 0 },
  { name: "40 mines, 20 blinking out", count: 40, blinking: 20 },
] as const;
export type SceneDef = (typeof SCENES)[number];

/** Where the view stands, by track (distance along it): a straight piece of road. */
export const CAM: Record<string, number> = { "rust-bowl": 120, "crusher-run": 3560, "overpass-knot": 5300 };
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const FPS = 60;
const OUT_MAX = 120; // shared/weapons.ts MINE_FADE_TICKS: a fading mine's blink, from its start to its end
/** A mine as a race's snapshot has it: `out` only while it blinks out. */
type Mine = WorldFx["mines"][number] & { out?: number };
type PointAt = (track: Track, s: number) => { x: number; y: number; h: number };

export interface Scene {
  cars: CarView[];
  fx: WorldFx;
  /** The camera's place. */
  x: number;
  y: number;
  /** Set the scene for frame i. */
  step(i: number): void;
}

export function buildScene(track: Track, pointAt: PointAt, def: SceneDef): Scene {
  const cam = CAM[track.def.id] ?? 500;
  const at = pointAt(track, cam);
  const cars: CarView[] = COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, hp: 1 }));
  // The mines: a grid of 8 x 5 in the view (640 x 360 view pixels are 800 x 450 world units),
  // 90 by 80 units apart. With fewer than 40, every (40 / count)th place of it.
  const mines: Mine[] = [];
  const every = Math.floor(40 / def.count);
  for (let k = 0; k < def.count; k++) {
    const g = k * every;
    const m: Mine = { x: at.x + ((g % 8) - 3.5) * 90, y: at.y + (Math.floor(g / 8) - 2) * 80, armed: k % 7 !== 3 };
    // Every other mine blinks out, as far as `blinking` goes; each starts somewhere else in its blink.
    if (k % 2 === 1 && (k >> 1) < def.blinking) m.out = 1 + ((k * 37) % OUT_MAX);
    mines.push(m);
  }
  const fx: WorldFx = { shots: [], mines, sparks: [], nShots: 0, nSparks: 0 };
  // The pack's way through the view, worked out before: 840 units at 300 units/s, then again.
  const LAP = 168, GAP = 28; // frames: a pass, and from one car to the next
  const xs = new Float64Array(LAP), ys = new Float64Array(LAP), hs = new Float64Array(LAP);
  for (let j = 0; j < LAP; j++) {
    const p = pointAt(track, cam - 420 + j * (300 / FPS));
    xs[j] = p.x;
    ys[j] = p.y;
    hs[j] = p.h;
  }
  return {
    cars,
    fx,
    x: at.x,
    y: at.y,
    step(i: number): void {
      for (let c = 0; c < cars.length; c++) {
        const j = (i + c * GAP) % LAP;
        const lat = (c % 3) * 26 - 26;
        cars[c].x = xs[j] - Math.sin(hs[j]) * lat;
        cars[c].y = ys[j] + Math.cos(hs[j]) * lat;
        cars[c].h = hs[j];
      }
      for (let k = 0; k < mines.length; k++) {
        const m = mines[k];
        if (m.out !== undefined) m.out = m.out > 1 ? m.out - 1 : OUT_MAX;
      }
    },
  };
}
