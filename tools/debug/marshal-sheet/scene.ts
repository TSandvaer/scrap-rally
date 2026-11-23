// The race the marshal sheet, its shots and its probes play (tools/debug/marshal-sheet.ts): 30 s
// in which everything the marshals show happens once. No race for 2 s (at ease), a 3 s
// countdown, GO at 5 s, the leader starts the last lap at 14 s, the winner is in at 20 s and
// three more cars at 22, 23.5 and 26 s (two never come in), the race is over at 28 s.
// The cars are put where a race would have them near the line at each of these moments: on the
// grid, pulling away, a pack coming through every 3 s, each finisher rolling out past the line.
// Both the runner (Node) and the page use this file.

import type { CarView, HudView, RaceView } from "../../../client/render";
import { pointAt, type Track } from "../../../shared/track";

export const GO = 5000, LAST_LAP = 14000, OVER = 28000, END = 30000;
/** When each car that finishes comes in (ms). */
export const IN = [20000, 22000, 23500, 26000];

/** The moments the shots are taken at: one or two a phase. */
export const SHOTS: readonly { name: string; t: number; what: string }[] = [
  { name: "1-at-ease", t: 1000, what: "no race: at ease, the flags furled" },
  { name: "2-countdown", t: 3500, what: "the countdown: the pennants held up over the barriers" },
  { name: "3-go", t: 5420, what: "GO: the pennants waved fast along the race direction" },
  { name: "4-racing", t: 9140, what: "the race: a pack comes through, the pennants waved steadily" },
  { name: "5-last-lap", t: 14280, what: "the leader starts the last lap: the yellow flag with one bar" },
  { name: "6-finish-winner", t: 20210, what: "the winner is in: the chequered flag" },
  { name: "7-finish-others", t: 23640, what: "the third car in: the chequered flag again" },
  { name: "8-over", t: 28600, what: "the race is over" },
];

/** Where the race stands at `t` ms of the script, into `out`; undefined = no race. */
export function raceAt(t: number, out: RaceView): RaceView | undefined {
  if (t < 2000) return undefined;
  out.phase = t < GO ? 1 : t < OVER ? 2 : 3;
  out.lastLap = t >= LAST_LAP && t < OVER;
  let n = 0;
  for (const at of IN) if (t >= at) n++;
  out.finished = n;
  return out;
}

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const NAMES = ["You", "Rustbucket", "Åse Ørn", "Bolt", "SkidMarks 12", "Gasket"];
const LOOKS = ["sport", "racer", "truck"] as const;
const LANES = [-34, 30, -6, 40, -40, 12];
const SPEED = 0.43; // units a ms: 430 u/s

/** The six cars, to be placed by carsAt. */
export function makeCars(): CarView[] {
  return COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: NAMES[i], me: i === 0, wreck: false, ghost: false, hp: 1, car: LOOKS[i % 3] }));
}

/** How far along the track the camera looks at the moment carsAt last placed the cars for. */
export const CAMERA = new Float64Array(1);

function put(track: Track, car: CarView, s: number, lat: number): void {
  const p = pointAt(track, s);
  car.x = p.x - Math.sin(p.h) * lat;
  car.y = p.y + Math.cos(p.h) * lat;
  car.h = p.h;
}

/** Put the cars where the script has them at `t`; returns how many are on the track (none before the countdown). */
export function carsAt(track: Track, t: number, cars: CarView[]): number {
  const half = track.def.halfWidth * 0.45;
  const clamp = (s: number) => (s < -120 ? -120 : s > 120 ? 120 : s);
  CAMERA[0] = 0;
  if (t < 2000) return 0;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    // Its grid slot (shared/track.ts gridSlot): two wide, staggered, behind the line.
    const right = i % 2 === 1;
    const slot = -50 - Math.floor(i / 2) * 70 - (right ? 35 : 0);
    if (t < GO + 3000) {
      // On the grid, then pulling away.
      const dt = t < GO ? 0 : (t - GO) / 1000;
      const s = slot + 0.5 * 300 * dt * dt;
      put(track, car, s, right ? half : -half);
      if (i === 0) CAMERA[0] = clamp(s);
    } else if (t < IN[0] - 1500) {
      // A pack comes through the line every 3 s; the leader starts the last lap exactly at LAST_LAP.
      const s = (((t - LAST_LAP + 1200) % 3000) + 3000) % 3000 * SPEED - 1200 * SPEED - i * 62;
      put(track, car, s, LANES[i]);
      if (i === 0) CAMERA[0] = clamp(s);
    } else {
      // The finish: a car comes in, rolls out and stops; two are still far out on the lap.
      const at = i < IN.length ? IN[i] : 1e9;
      const s = t < at ? Math.max(-3000, (t - at) * SPEED) : Math.min(180 + i * 46, (t - at) * SPEED * 0.8);
      put(track, car, s, LANES[i] * 0.8);
      if (t >= at || i === 0) CAMERA[0] = clamp(s);
    }
  }
  return cars.length;
}

/** The HUD a player would see at `t` (a spectator's before the countdown: none). */
export function hudAt(t: number): HudView | null {
  if (t < 2000) return null;
  const hud: HudView = { topLeft: ["LAP 1/3", "POS 1/6", "RIV  40 MINE 2"], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "23 ms", debug: [], hp: 0.84 };
  if (t < GO) hud.center = String(Math.ceil((GO - t) / 1000));
  else {
    const ms = Math.min(t, IN[0]) - GO;
    hud.time = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${Math.floor(ms / 100) % 10}`;
    if (t < GO + 900) hud.center = "GO!";
    if (t >= LAST_LAP) hud.topLeft[0] = "LAP 3/3";
    else if (t >= GO + 4500) hud.topLeft[0] = "LAP 2/3";
    if (t >= LAST_LAP && t < LAST_LAP + 1500) {
      hud.center = " ";
      hud.centerSub = "LAP 3/3";
    }
    if (t >= IN[0]) {
      hud.topLeft[0] = "FINISHED";
      if (t < OVER) hud.banner = `Winner is in — race closes in ${Math.ceil((OVER - t) / 1000)}s`;
    }
  }
  return hud;
}
