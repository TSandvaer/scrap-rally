// Debug-only feature preview (?debug=1&preview=1), loaded on demand by main.ts: a synthetic
// figure-eight with every track feature (ramps, a chasm, a crossing whose upper pass jumps
// the lower road, holes, a scrap-filled gap) and scripted car poses, for screenshots and the
// taste gate. Nothing here runs, or is even downloaded, without the flag.
//
// Keys 1-9 pick one of the nine feature scenes, the arrows step through those and the seven
// fixture scenes after them (fx, wreck, damage, mine, spectator, pause, countdown: the states
// no feature scene shows; no test reads the renderer's output, so these frames are the
// regression net of the graphics work), then the scenes added since (blast: a mine's blast,
// a landing's puff and dust from the verge; looks: the three car looks driving a bend; the
// catch-up visuals of M4-FX: cells, boost, draft, catchup; and the road's furniture of
// M4-WORLD on the Preview Yard test track, shared/testtracks.ts: yard-chicane, yard-truck,
// yard-split, yard-bend, yard-belt).
// URL: &scene=<name> to start on one, &freeze=1 to hold
// the scene's key moment, &t=<seconds> to hold any moment, &hud=0 to hide the caption.
// &cues=0 leaves the catch-up fields out of what the renderer is handed (CarView.draft and
// .boost, WorldFx.cells, HudView.draft and .boost): the same scene as a caller that does not
// fill them gets it, which is the picture before M4-FX. &rt=0 leaves the race tick out
// (WorldFx.rt): nothing that moves on the road is drawn, as for a caller that does not fill it.
// A held moment pins performance.now() too while it draws (smoke and the mine blink read it),
// so the same URL gives the same pixels on every load.
//
// Two more pages for the graphics polish (PLAN-GFX.md), neither wired into the game:
// &scene=palette  the "scrapyard 32" sheet (client/gfx/palette.ts), at 1280x720
// &scene=mock     one piece of track baked with the palette (&mock=today: the same view as
//                 the game draws it now)

import { testTrack } from "../shared/testtracks";
import { buildTrack, gridSlot, pointAt, queryTrack, queryTrackNear, widenAt, type Track, type TrackDef } from "../shared/track";
import { trackById } from "../shared/tracks";
import { airTicksFor, FALL_TICKS, GHOST_TICKS } from "../shared/weapons";
import { BAYER4, CAR_COLORS, CAR_NEUTRALS, carTones, CSS_MIRROR, LIT, P, PALETTE, RAMPS, rgbOf, SHADE, type PaletteName } from "./gfx/palette";
import { Renderer, VIEW_H, VIEW_W, type CarView, type CellView, type HudView, type WorldFx } from "./render";

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
  yard?: boolean; // drawn on the Preview Yard test track (shared/testtracks.ts)
  cam: () => { x: number; y: number };
  cars: (t: number) => CarView[];
  key: number; // seconds: the moment &freeze=1 holds
  fx?: (t: number) => WorldFx; // fixture scenes: shots, mines, sparks
  lead?: number; // seconds drawn frame by frame before a held moment (dust comes from the frames before it)
  hud?: (t: number) => Partial<HudView>; // fixture scenes: the game's own HUD (its banner replaces the caption)
}

/** The feature scenes come first; keys 1-9 and their captions count only these. */
const CLASSIC = 9;
/** The fixture scenes after them; scenes added later are counted apart, so these keep their captions. */
const FIXTURES = 7;
const NO_HUD: HudView = { topLeft: [], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "", debug: [], hp: null };
const NO_FX: WorldFx = { shots: [], mines: [], sparks: [] };

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
    ...fixtures(track, rust),
  ];
}

/**
 * The fixture scenes: effects, wrecks, damage, mines and the HUD states (spectator, pause,
 * countdown), as the game hands them to the renderer.
 */
function fixtures(track: Track, rust: Track): Scene[] {
  const at = (t: Track, s: number) => () => pointAt(t, s);
  const spot = (t: Track, s: number, lat: number) => car(t, 0, s, lat);
  const grid = (i: number, more: Partial<CarView> = {}): CarView => {
    const g = gridSlot(rust, i);
    return { id: `p${i}`, x: g.x, y: g.y, h: g.h, color: COLORS[i], name: `Car ${i + 1}`, me: i === 0, wreck: false, ghost: false, ...more };
  };
  const raceHud: Partial<HudView> = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", corner: "23 ms", hp: 0.62 };
  // Damage: the hp each car of the grid has (the own car first). Under 40% a car is drawn
  // battered (gfx/actors.ts).
  const HP = [0.39, 1, 0.8, 0.6, 0.2, 0.05];
  const holeRun = driver(track, 3, 950, 800, 240, 2);
  return [
    {
      name: "fx",
      title: "Effects: 12 rivets in flight, 6 sparks from new to old",
      rust: true,
      cam: at(rust, 120),
      cars: () => [car(rust, 0, 20, -22), car(rust, 1, -10, 24), car(rust, 2, 250, 0)],
      fx: (t) => ({
        // Two streams of six, one from each car; a row of sparks through their whole life.
        shots: Array.from({ length: 12 }, (_, k) => {
          const p = spot(rust, (k < 6 ? 50 : 25) + (k % 6) * 30 + ((t * 900) % 30), k < 6 ? -22 : 24);
          return { x: p.x, y: p.y, vx: Math.cos(p.h) * 900, vy: Math.sin(p.h) * 900 };
        }),
        mines: [],
        sparks: Array.from({ length: 6 }, (_, k) => {
          const p = spot(rust, 120, -50 + k * 20);
          return { x: p.x, y: p.y, age: (k / 6 + t / 0.26) % 1 };
        }),
      }),
      key: 0,
    },
    {
      name: "wreck",
      title: "Wrecks: scorched and smoking, next to a healthy car",
      rust: true,
      cam: at(rust, 120),
      cars: () => {
        const turned = car(rust, 2, 185, -18, { wreck: true });
        turned.h += 0.6;
        return [car(rust, 0, 60, -26), car(rust, 1, 120, 22, { wreck: true }), turned, car(rust, 5, 95, 62, { wreck: true })];
      },
      key: 0.35,
    },
    {
      name: "damage",
      title: "Damage: hp 39% (own car), 100, 80, 60, 20, 5%",
      rust: true,
      cam: at(rust, -150),
      cars: () => HP.map((hp, i) => ({ ...grid(i, { name: `${Math.round(hp * 100)}%` }), hp })),
      hud: () => ({ ...raceHud, hp: HP[0] }),
      key: 0,
    },
    {
      name: "mine",
      title: "Mines: 4 armed (blinking), 2 not yet armed",
      cam: at(track, 1330),
      cars: (t) => [holeRun(t)],
      fx: () => ({
        shots: [],
        // On the road, beside the pits, one on the verge; [distance, lateral, armed].
        mines: ([[1250, 10, true], [1300, -44, true], [1420, 38, true], [1380, -84, true], [1215, -20, false], [1465, -34, false]] as [number, number, boolean][]).map(
          ([s, lat, armed]) => {
            const p = spot(track, s, lat);
            return { x: p.x, y: p.y, armed };
          },
        ),
        sparks: [],
      }),
      key: 1.0, // 1000 ms: the armed lamps are in the bright half of their blink
    },
    {
      name: "spectator",
      title: "Spectating: the camera on the leader, no own car",
      rust: true,
      cam: at(rust, 3000),
      cars: () => [car(rust, 1, 3000, -8), car(rust, 2, 2930, 30), car(rust, 3, 2860, -30), car(rust, 4, 3110, 12)],
      hud: () => ({ time: "0:42.3", banner: "Race in progress — you're in the next one", corner: "23 ms" }),
      key: 0,
    },
    {
      name: "pause",
      title: "Paused by another player",
      rust: true,
      cam: at(rust, 5200),
      cars: () => [car(rust, 0, 5200, -14), car(rust, 1, 5270, 22), car(rust, 2, 5120, 6)],
      hud: () => ({ ...raceHud, center: "PAUSED", centerSub: "by Car 2", banner: "Race paused by Car 2 — resumes by itself in 4:32" }),
      key: 0,
    },
    {
      name: "countdown",
      title: "Countdown on the grid",
      rust: true,
      cam: () => gridSlot(rust, 0),
      cars: () => HP.map((_, i) => grid(i)),
      hud: (t) => ({ topLeft: ["LAP 1/3", "POS 1/6", "RIV  60 MINE 3"], hp: 1, center: ["3", "2", "1", "GO!"][Math.floor(t) % 4], corner: "23 ms" }),
      key: 0,
    },
    {
      name: "blast",
      title: "Mine blast (its 8 frames), a landing's puff, dust off the verge",
      rust: true,
      cam: at(rust, 120),
      // The own car stands; one drives along the verge; one comes down from a hop at 0.5 s.
      cars: (t) => [
        car(rust, 0, 20, -22),
        car(rust, 1, 40 + ((t * 260) % 400), rust.def.halfWidth + 22),
        car(rust, 2, 30 + ((t * 200) % 400), 26, { height: t % 2 < 0.5 ? 4 * ((t % 2) / 0.5) * (1 - (t % 2) / 0.5) : 0 }),
      ],
      fx: (t) => ({
        shots: [],
        mines: [spot(rust, 250, -30), spot(rust, 265, 8)].map((p, k) => ({ x: p.x, y: p.y, armed: k === 0 })),
        // A row of blasts through their whole life, each a frame further than the one before.
        sparks: Array.from({ length: 8 }, (_, k) => {
          const p = spot(rust, 60 + k * 2, -150 + k * 34);
          const a = (k + 0.5) / 8 + (t - 0.6) / 0.1333;
          return { x: p.x, y: p.y, age: a - Math.floor(a), blast: true };
        }),
      }),
      lead: 0.6,
      key: 0.6,
    },
    {
      name: "looks",
      title: "Looks: sport, racer and truck through a bend; two battered, a wreck",
      rust: true,
      cam: at(rust, 7470),
      // Round the bend again and again: the racers on the outside, the sports in the middle, a
      // truck cutting the corner over the verge; the other truck a wreck beside the road.
      cars: (t) => {
        const lap = (i: number, v: number, lat: number, from: number, more: Partial<CarView>) => car(rust, i, 7180 + ((t * v + from) % 480), lat, more);
        const wreck = car(rust, 5, 7450, -92, { car: "truck", name: "Truck", wreck: true });
        wreck.h += 0.9;
        return [
          lap(0, 320, 2, 120, { car: "sport" }),
          lap(1, 360, -38, 0, { car: "racer", name: "Racer" }),
          lap(2, 250, rust.def.halfWidth + 20, 60, { car: "truck", name: "Truck" }),
          lap(3, 320, 2, 360, { car: "sport", name: "Sport 30%", hp: 0.3 }),
          lap(4, 360, -38, 240, { car: "racer", name: "Racer 30%", hp: 0.3 }),
          wreck,
        ];
      },
      lead: 0.6,
      key: 1,
    },
    ...catchUp(track, rust),
    ...furniture(),
  ];
}

/**
 * The road's furniture (M4-WORLD; PLAN-M4.md 2.2-2.4, 2.6 B) on the Preview Yard test track:
 * tyre mounds, rolling barrels, pools, the ramp truck, split lanes with their islands, a dirt
 * lane, the crusher press and the conveyor belt, with the race tick running (WorldFx.rt = 60 a
 * second), so what moves is seen moving. The cars are scripted, as everywhere here: they
 * steer round what is solid and are timed to what moves, and nothing pushes them.
 */
function furniture(): Scene[] {
  const yard = testTrack("preview-yard")!;
  const at = (s: number) => () => pointAt(yard, s);
  const tick = (t: number): WorldFx => ({ ...NO_FX, rt: Math.round(t * 60) });
  const cell = (s: number, lat: number, air: boolean): CellView => {
    const p = pointAt(yard, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, air, state: 0 };
  };
  /** A car on the line lat(s) at distance s, its nose turned along the line. */
  const on = (i: number, s: number, lat: (s: number) => number, more: Partial<CarView> = {}): CarView => {
    const c = car(yard, i, s, lat(s), more);
    c.h += Math.atan((lat(s + 4) - lat(s - 4)) / 8);
    return c;
  };
  const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

  // yard-chicane: three mounds to weave through, then the barrels' lane, then a pool right
  // across the road. A lap of the loop takes 4 s, as the barrels' cycle does: each car crosses
  // their lane between two of them, every time.
  const row = yard.barrels[0];
  const weave = (s: number) => -34 + 68 * ease((s - 925) / 90) - 30 * ease((s - 1120) / 110); // left of the second mound, right of the third
  const LOOP = 800, PACE = LOOP / 4;
  const chicane = (i: number, lat: (s: number) => number, more: Partial<CarView> = {}) => (t: number): CarView => {
    // When a barrel is not in the way at this lane: a third of the way between two of them.
    const clear = (lat(row.s) - row.lat0) / Math.abs(row.speed) + (row.period / row.n / 60) * (0.55 + (i % row.n));
    const from = 800, start = clear - (row.s - from) / PACE;
    const s = from + ((((t - start) * PACE) % LOOP) + LOOP) % LOOP;
    return on(i, s, lat, more);
  };
  const weavers = [chicane(0, weave), chicane(1, (s) => weave(s) + 22 * ease((s - 1130) / 120), { car: "racer" }), chicane(2, () => -56, { car: "truck" }), chicane(3, (s) => 56 - 20 * ease((1100 - s) / 200))];

  // yard-truck: a car takes the ramp truck's ramp and flies over its cab; others pass beside
  // it and through the pool on the inside of the bend.
  const truck = yard.trucks[0];
  const v = 380, flight = (v * airTicksFor(v)) / 60;
  const jumper = (t: number): CarView => {
    const s = 3200 + ((t * v) % 900);
    const u = (s - truck.lip) / flight;
    return car(yard, 0, s, truck.lat, { height: u > 0 && u < 1 ? 4 * u * (1 - u) : 0 });
  };
  const passer = (i: number, lat: number, pace: number, from: number, more: Partial<CarView> = {}) => (t: number): CarView => car(yard, i, 3250 + ((t * pace + from) % 900), lat, more);

  // yard-split, yard-bend: both lanes of a split. The cars keep to the middle of their lane as
  // the road widens and narrows; in the first split the dirt lane's cars pass the press while
  // it is up (its cycle is 3 s, and so is their lap).
  const lane = (side: number, wide: number) => (s: number) => side * (30 + ((wide - 30) * widenAt(yard, s, side)) / 60); // the first split widens by 60 either side
  const press = yard.presses[0];
  const split = (i: number, side: number, from: number, more: Partial<CarView> = {}) => (t: number): CarView => on(i, 6150 + ((t * 300 + from) % 900), lane(side, 76), more);
  const bendLane = (side: number) => (s: number) => side * (30 + 0.85 * widenAt(yard, s, side));
  const bend = (i: number, side: number, from: number, pace: number, more: Partial<CarView> = {}) => (t: number): CarView => on(i, 7700 + ((t * pace + from) % 800), bendLane(side), more);

  // yard-belt: the belt carries the cars to the left of travel as they cross it.
  const belt = yard.belts[0];
  const carried = (i: number, lat0: number, pace: number, from: number, more: Partial<CarView> = {}) => (t: number): CarView => {
    const s = 8650 + ((t * pace + from) % 600);
    const onBelt = Math.max(0, Math.min(s, belt.s1) - belt.s0) / pace; // seconds on the belt so far
    return on(i, s, () => lat0 + belt.vx * onBelt, more);
  };

  return [
    {
      name: "yard-chicane",
      title: "Yard: tyre mounds, rolling barrels, a pool",
      yard: true,
      cam: at(1210),
      cars: (t) => weavers.map((w) => w(t)),
      fx: (t) => ({ ...tick(t), cells: [cell(1180, -58, false), cell(1390, 58, false), cell(1530, 20, false)] }),
      key: 1.1,
    },
    {
      name: "yard-truck",
      title: "Yard: up the ramp truck and over its cab",
      yard: true,
      cam: at(3650),
      cars: (t) => [jumper(t), passer(1, -34, 300, 0, { car: "racer" })(t), passer(2, -22, 260, 450, { car: "truck" })(t), passer(3, -40, 320, 700)(t)],
      fx: (t) => ({ ...tick(t), cells: [cell(truck.lip + flight / 2, truck.lat + 28, true)] }),
      key: (truck.lip + 36 - 3200) / v, // over the cab
    },
    {
      name: "yard-split",
      title: "Yard: split lanes, the press on the dirt lane",
      yard: true,
      cam: at(6640),
      // The dirt lane's cars reach the press 0.4 s and 1.1 s into its cycle (it is down for the last second of three).
      cars: (t) => [
        split(0, 1, press.s - 6150 - 0.4 * 300)(t),
        split(1, 1, press.s - 6150 - 1.1 * 300 + 900, { car: "truck" })(t),
        split(2, -1, 150, { car: "racer" })(t),
        split(3, -1, 520)(t),
        split(4, -1, 760, { car: "truck" })(t),
      ],
      fx: (t) => ({ ...tick(t), cells: [cell(6450, -112, false), cell(6700, 118, false)] }),
      key: (press.period - press.down - 8) / 60, // the press's shadow closing in
    },
    {
      name: "yard-bend",
      title: "Yard: a split in a bend",
      yard: true,
      cam: at(8100),
      cars: (t) => [bend(0, 1, 0, 300)(t), bend(1, 1, 420, 300, { car: "racer" })(t), bend(2, -1, 150, 330, { car: "truck" })(t), bend(3, -1, 560, 330)(t)],
      fx: tick,
      key: 0.9,
    },
    {
      name: "yard-belt",
      title: "Yard: the belt carries cars across the road",
      yard: true,
      cam: at(8950),
      cars: (t) => [carried(0, 40, 300, 0)(t), carried(1, 20, 260, 250, { car: "truck" })(t), carried(2, 50, 340, 430, { car: "racer" })(t)],
      fx: tick,
      key: 1.5,
    },
  ];
}

/**
 * The catch-up scenes (M4-FX; PLAN-M4.md 2.5, 2.8): the lightning cells, the flames of a
 * boost, the streaks of a slipstream and the HUD's two cues, as the game will hand them to
 * the renderer (the optional fields of CarView, WorldFx and HudView).
 */
function catchUp(track: Track, rust: Track): Scene[] {
  const at = (t: Track, s: number) => () => pointAt(t, s);
  const cell = (t: Track, s: number, lat: number, air: boolean, state: number): CellView => {
    const p = pointAt(t, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, air, state };
  };
  const raceHud: Partial<HudView> = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", corner: "23 ms", hp: 0.62 };
  const kerb = rust.def.halfWidth - 6; // PLAN-M4 2.5: ground cells lie on the kerb

  // cells: the chasm of the preview track. A car jumps it again and again and takes the
  // floating cell on its line at the top of its arc; that cell is then an outline until the
  // car comes round again (its wait runs out as the lap does).
  const v = 380;
  const flight = (v * airTicksFor(v)) / 60;
  const from = 5200, lap = 900, line = -22;
  const jumper = driver(track, 0, from, lap, v, line);
  const top = 5600 + flight / 2; // the top of the arc
  const tTake = (top - from) / v, period = lap / v;
  const takenBy = (t: number): number => {
    const u = t % period;
    return u < tTake ? 0 : Math.max(0.01, 1 - (u - tTake) / (period - tTake));
  };

  // boost: five cars down Rust Bowl's first straight, each with a boost that runs out and
  // comes again; the fifth hops while it burns.
  const burn = (i: number, t: number): number => Math.max(0, 90 - ((t * 60 + i * 23) % 120)); // ticks left: 90 down to 0, then 30 ticks without
  const boosted = (t: number): CarView[] => {
    const run = (i: number, lat: number, more: Partial<CarView>) => car(rust, i, -40 + ((t * 300 + i * 83) % 330), lat, { boost: burn(i, t), ...more });
    const hop = (t * 0.9) % 1;
    return [
      run(0, -40, { car: "sport" }),
      run(1, -8, { car: "racer", name: "Racer" }),
      run(2, 26, { car: "truck", name: "Truck" }),
      run(3, 58, { car: "sport", name: "Ending", boost: 1 + ((t * 60) % 9) }),
      run(4, -72, { car: "truck", name: "In the air", height: hop < 0.6 ? 4 * (hop / 0.6) * (1 - hop / 0.6) : 0, boost: 60 }),
    ];
  };

  // draft: three pairs down the same straight, the follower 50, 110 and 160 units behind its
  // leader: a slipstream of 1, 0.58 and 0.17 (PLAN-M4 2.8: 1 up to 60 units, 0 at 180).
  const GAPS = [110, 50, 160];
  const strength = (gap: number) => Math.max(0, Math.min(1, (180 - gap) / 120));
  const drafted = (t: number): CarView[] => {
    const out: CarView[] = [];
    const s0 = 60 + ((t * 430) % 260);
    GAPS.forEach((gap, k) => {
      // The own car is the follower of the middle pair; the pairs either side are further back, so no name tag covers a car.
      const s = s0 - [110, 0, 60][k], lat = (k - 1) * 42;
      const w = strength(gap);
      out.push(car(rust, k === 1 ? 0 : k + 2, s, lat, { draft: w, name: `Draft ${Math.round(w * 100)}%`, car: k === 2 ? "truck" : "sport" }));
      out.push(car(rust, k === 1 ? 1 : k + 3, s + gap, lat, { name: "Lead", car: k === 0 ? "racer" : "sport" }));
    });
    return out;
  };

  // catchup: a pack through Rust Bowl's first bend with all of it at once. (The cars drive up
  // the screen and to the right there: no name tag lies over a flame.)
  const pack = (t: number): CarView[] => {
    const lapOf = (i: number, lat: number, start: number, more: Partial<CarView>) => car(rust, i, 1010 + ((t * 380 + start) % 520), lat, more);
    return [
      lapOf(0, -6, 60, { car: "sport", draft: 0.75, boost: Math.max(0, 54 - ((t * 60) % 90)) }),
      lapOf(1, -4, 122, { car: "racer", name: "Racer", boost: 40 }),
      lapOf(2, 30, 300, { car: "truck", name: "Truck" }),
      lapOf(3, 34, 235, { car: "sport", name: "Sport", draft: 0.4 }),
      lapOf(4, -40, 400, { car: "racer", name: "Racer 2", draft: 1 }),
      lapOf(5, -42, 452, { car: "truck", name: "Truck 2", boost: 5 }),
    ];
  };
  const bendCells = (t: number): CellView[] => [
    cell(rust, 1080, -kerb, false, 0),
    cell(rust, 1230, kerb, false, 0),
    cell(rust, 1310, -kerb, false, 1), // taken
    cell(rust, 1370, kerb, false, 0.05), // about to be back
    cell(rust, 1450, -kerb, false, 0),
    cell(rust, 1400, 10, true, t % 3 < 2 ? 0 : 1 - ((t % 3) - 2)), // floats over the road
  ];

  return [
    {
      name: "cells",
      title: "Lightning cells: on the kerbs, floating over the chasm; taken; about to be back",
      cam: at(track, 5660),
      cars: (t) => [jumper(t), car(track, 1, 5415, 36), car(track, 2, 5950, -30, { car: "truck" })],
      fx: (t) => ({
        ...NO_FX,
        cells: [
          cell(track, 5400, -58, false, 0),
          cell(track, 5455, 58, false, 0),
          cell(track, 5500, -58, false, 1), // taken
          cell(track, 5360, 58, false, 0.05), // about to be back
          cell(track, 5330, -92, false, 0), // off the road, on the verge
          cell(track, top, line, true, takenBy(t)), // on the jumper's line
          cell(track, top - 10, 34, true, 0),
          cell(track, top + 55, 6, true, 1), // taken
          cell(track, top - 60, -62, true, 0.05), // about to be back
          cell(track, 5900, 58, false, 0),
          cell(track, 5950, -58, false, 0),
        ],
      }),
      key: tTake - 0.1,
    },
    {
      name: "boost",
      title: "Boost: flames on sport, racer and truck; one ending, one in the air",
      rust: true,
      cam: at(rust, 120),
      cars: boosted,
      hud: (t) => ({ ...raceHud, boost: burn(0, t) }),
      key: 0.3,
    },
    {
      name: "draft",
      title: "Slipstream: streaks past the follower at strength 0.58, 1 and 0.17",
      rust: true,
      cam: at(rust, 120),
      cars: drafted,
      hud: () => ({ ...raceHud, draft: strength(GAPS[1]) }),
      key: 0.1,
    },
    {
      name: "catchup",
      title: "Catch-up: drafting and boosting through a bend, cells on its kerbs",
      rust: true,
      cam: at(rust, 1270),
      cars: pack,
      fx: (t) => ({ ...NO_FX, cells: bendCells(t) }),
      hud: (t) => ({ ...raceHud, draft: 0.75, boost: Math.max(0, 54 - ((t * 60) % 90)) }),
      lead: 0.6,
      key: 0.5,
    },
  ];
}

/** Run the preview on the game canvas (the game itself is not started). */
export function runPreview(canvas: HTMLCanvasElement, params: URLSearchParams): void {
  if (params.get("scene") === "palette") return showPalette(canvas);
  if (params.get("scene") === "mock") return showMock(canvas, params.get("mock") === "today");
  const list = scenes();
  const renderers = new Map<string, Renderer>();
  const rendererFor = (scene: Scene) => {
    const on = scene.yard ? "yard" : scene.rust ? "rust" : "eight";
    let r = renderers.get(on);
    if (!r) {
      r = new Renderer(canvas, scene.yard ? testTrack("preview-yard")! : scene.rust ? trackById("rust-bowl") : previewTrack().track);
      renderers.set(on, r);
    }
    return r;
  };
  let index = Math.max(0, list.findIndex((s) => s.name === params.get("scene")));
  const fixedT = params.has("t") ? Number(params.get("t")) : params.get("freeze") === "1" ? null : undefined;
  const hud = params.get("hud") !== "0";
  const cues = params.get("cues") !== "0";
  const ticks = params.get("rt") !== "0";
  const start = performance.now();
  let led: Scene | null = null; // the held scene whose lead-up has been drawn

  window.addEventListener("keydown", (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= CLASSIC) index = n - 1;
    else if (e.key === "ArrowRight") index = (index + 1) % list.length;
    else if (e.key === "ArrowLeft") index = (index - 1 + list.length) % list.length;
  });

  const frame = (now: number) => {
    const scene = list[index];
    // Held moments draw at a fixed clock too, so blinks are the same on every reload.
    const held = fixedT !== undefined;
    const t = fixedT === undefined ? (now - start) / 1000 : (fixedT ?? scene.key);
    const r = rendererFor(scene);
    const cam = scene.cam();
    r.follow(cam.x, cam.y, 16, true);
    const caption = !hud
      ? ""
      : index < CLASSIC
        ? `PREVIEW ${index + 1}/${CLASSIC}  ${scene.title}  (keys 1-${CLASSIC})`
        : index < CLASSIC + FIXTURES
          ? `FIXTURE ${index - CLASSIC + 1}/${FIXTURES}  ${scene.title}  (arrows)`
          : `EXTRA ${index - CLASSIC - FIXTURES + 1}  ${scene.title}  (arrows)`;
    const view: HudView | null = scene.hud ? { ...NO_HUD, banner: caption, ...scene.hud(t) } : caption ? { ...NO_HUD, banner: caption } : null;
    if (!cues && view) delete view.draft, delete view.boost;
    // A held moment of a scene with a lead-up: the frames before it are drawn first, once,
    // each at its own time (after that the held frame is redrawn as it is: no time passes).
    const from = held && scene.lead && led !== scene ? t - scene.lead : t;
    led = held ? scene : null;
    for (let k = Math.round((t - from) / DT); k >= 0; k--) {
      const u = t - k * DT;
      // The renderer reads the real clock for the smoke and the mine blink: pin it while held.
      if (held) performance.now = () => u * 1000;
      try {
        const cars = scene.cars(u), fx = scene.fx ? scene.fx(u) : NO_FX;
        if (!cues) {
          for (const c of cars) delete c.draft, delete c.boost;
          delete fx.cells, delete fx.nCells;
        }
        if (!ticks) delete fx.rt;
        r.frame(cars, fx, view, held ? u * 1000 : now);
      } finally {
        if (held) delete (performance as { now?: unknown }).now;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---- pixel car (the palette sheet and the mock) -----------------------------------

const CAR_W = 26, CAR_H = 19;

/**
 * A car facing right as hard pixels in its three tones and the shared neutrals: only to
 * judge the tones in place. The real sprites (128 headings from a master) are GFX-2a's.
 */
function carPixels(color: string): (string | null)[][] {
  const t = carTones(color), n = CAR_NEUTRALS;
  const px: (string | null)[][] = Array.from({ length: CAR_H }, () => new Array<string | null>(CAR_W).fill(null));
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px[j][i] = c;
  };
  rect(3, 0, 6, CAR_H, n.tyre); // the wheels show 2 px either side of the body
  rect(17, 0, 6, CAR_H, n.tyre);
  rect(0, 2, 26, 15, n.outline);
  rect(1, 3, 24, 13, t.body);
  rect(1, 3, 24, 1, t.lit); // the sunlit edge
  rect(1, 13, 24, 3, t.shade); // the side away from the sun
  rect(6, 5, 7, 9, t.shade); // roof
  rect(6, 5, 7, 1, t.body);
  rect(13, 5, 5, 9, n.glass); // windscreen
  rect(13, 5, 2, 1, n.glint);
  rect(18, 9, 6, 2, t.lit); // bonnet stripe
  rect(23, 4, 2, 2, n.lamp);
  rect(23, 13, 2, 2, n.lamp);
  return px;
}

// ---- palette sheet ------------------------------------------------------------------

/** Relative luminance 0..1 (to pick a readable label colour). */
function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The palette sheet: a 1280x720 canvas of its own over the page, drawn 1:1. */
function showPalette(view: HTMLCanvasElement): void {
  const W = 1280, H = 720;
  const sheet = document.createElement("canvas");
  sheet.id = "palette-sheet";
  sheet.width = W;
  sheet.height = H;
  sheet.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;z-index:99;image-rendering:pixelated`;
  view.style.visibility = "hidden";
  document.body.append(sheet);
  const g = sheet.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  const mono = "ui-monospace, Menlo, Consolas, monospace";
  const text = (str: string, x: number, y: number, color: string, size = 11, bold = false) => {
    g.font = `${bold ? "bold " : ""}${size}px ${mono}`;
    g.fillStyle = color;
    g.fillText(str, x, y);
  };
  const ink = (hex: string) => (luminance(hex) > 0.2 ? P.soot1 : P.bone2);
  g.fillStyle = P.soot1;
  g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";
  text("SCRAPYARD 32", 24, 36, P.bone2, 24, true);
  text("Scrap Rally palette: 32 colours in 9 ramps, dark to light. The sun is top-left.", 232, 26, P.bone0, 12);
  text("Each swatch: its sunlit edge (top and left), the colour, the colour in a cast shadow (bottom).", 232, 42, P.bone0, 12);

  // The ramps.
  const sw = 116, sh = 54, x0 = 24, y0 = 62, rowH = 72;
  Object.entries(RAMPS).forEach(([ramp, names], row) => {
    const y = y0 + row * rowH;
    text(ramp.toUpperCase(), x0, y + 22, P.bone2, 12, true);
    text(`${names.length} steps`, x0, y + 38, P.bone0, 11);
    names.forEach((name, i) => {
      const x = x0 + 84 + i * (sw + 8);
      const hex = P[name];
      g.fillStyle = hex;
      g.fillRect(x, y, sw, sh);
      g.fillStyle = P[SHADE[name]];
      g.fillRect(x, y + sh - 13, sw, 13);
      g.fillStyle = P[LIT[name]];
      g.fillRect(x, y, sw, 3);
      g.fillRect(x, y, 3, sh - 13);
      text(name, x + 10, y + 20, ink(hex), 12, true);
      text(hex, x + 10, y + 35, ink(hex), 11);
      if (name === "bone0") text(ramp === "gravel" ? "= bone0" : "shared", x + 62, y + 35, ink(hex), 10);
    });
  });

  // The cars.
  const x1 = 624;
  text("CARS", x1, 78, P.bone2, 12, true);
  text("three tones each: shade, body (= the server colour), lit", x1 + 44, 78, P.bone0, 11);
  CAR_COLORS.forEach((color, i) => {
    const y = 88 + i * 66;
    const t = carTones(color);
    ([["shade", t.shade], ["body", t.body], ["lit", t.lit]] as const).forEach(([label, hex], k) => {
      const x = x1 + k * 92;
      g.fillStyle = hex;
      g.fillRect(x, y, 86, 60);
      text(label, x + 8, y + 24, ink(hex), 11, true);
      text(hex, x + 8, y + 40, ink(hex), 11);
    });
    // The car on tarmac and on dirt, 3x.
    [P.tar1, P.dirt2].forEach((ground, k) => {
      const bx = x1 + 286 + k * 108, scale = 3;
      g.fillStyle = ground;
      g.fillRect(bx, y, 100, 60);
      // Its hard shadow first, in the ground's SHADE tone.
      const px = carPixels(color);
      g.fillStyle = P[SHADE[k ? "dirt2" : "tar1"]];
      px.forEach((line, j) => line.forEach((c, m) => c && g.fillRect(bx + 9 + (m + 1) * scale, y - 1 + (j + 1) * scale, scale, scale)));
      px.forEach((line, j) =>
        line.forEach((c, m) => {
          if (!c) return;
          g.fillStyle = c;
          g.fillRect(bx + 9 + m * scale, y - 1 + j * scale, scale, scale);
        }),
      );
    });
  });
  const x2 = 1140;
  text("CAR NEUTRALS", x2, 78, P.bone2, 12, true);
  Object.entries(CAR_NEUTRALS).forEach(([label, hex], i) => {
    const y = 88 + i * 34;
    g.fillStyle = hex;
    g.fillRect(x2, y, 30, 26);
    g.strokeStyle = P.dirt1;
    g.strokeRect(x2 + 0.5, y + 0.5, 29, 25);
    text(label, x2 + 38, y + 12, P.bone2, 11, true);
    text(PALETTE.find((e) => e.hex === hex)?.name ?? hex, x2 + 38, y + 24, P.bone0, 10);
  });

  // Dither: the only blend there is, and only in small areas (a pit, a ramp).
  const yd = 506;
  text("DITHER", x1, yd, P.bone2, 12, true);
  text("depth without gradients: ordered 4x4 between two steps (3x here)", x1 + 58, yd, P.bone0, 11);
  ([["soot0", "soot2"], ["soot1", "dirt0"], ["steel1", "steel3"], ["rust1", "rust3"]] as [PaletteName, PaletteName][]).forEach(([a, b], i) => {
    const bx = x1 + (i % 2) * 320, by = yd + 10 + Math.floor(i / 2) * 36;
    for (let yy = 0; yy < 6; yy++) {
      for (let xx = 0; xx < 100; xx++) {
        g.fillStyle = BAYER4[yy & 3][xx & 3] < (xx / 99) * 16 ? P[b] : P[a];
        g.fillRect(bx + xx * 3, by + yy * 3, 3, 3);
      }
    }
    text(`${a}  to  ${b}`, bx, by + 29, P.bone0, 10);
  });

  // The CSS mirror, checked against the page's own :root.
  const yc = 606;
  text("CSS :root MIRROR", x1, yc, P.bone2, 12, true);
  text("the entry each style.css variable takes (GFX-3 applies it), and its value now", x1 + 130, yc, P.bone0, 11);
  const css = getComputedStyle(document.documentElement);
  Object.entries(CSS_MIRROR).forEach(([name, entry], i) => {
    const bx = x1 + (i % 2) * 300, by = yc + 9 + Math.floor(i / 2) * 21;
    const today = css.getPropertyValue(name).trim();
    g.fillStyle = P[entry];
    g.fillRect(bx, by, 20, 16);
    g.strokeStyle = P.dirt1;
    g.strokeRect(bx + 0.5, by + 0.5, 19, 15);
    text(name, bx + 28, by + 12, P.bone2, 11, true);
    text(`${entry} ${P[entry]}`, bx + 118, by + 12, P.bone0, 10);
    text(today.toLowerCase() === P[entry] ? "= now" : `now ${today.replace(/\s+/g, "")}`, bx + 206, by + 12, today.toLowerCase() === P[entry] ? P.green : P.haz1, 10);
  });
  (window as unknown as { scrapPalette: unknown }).scrapPalette = { colours: PALETTE.length, distinct: new Set(PALETTE.map((e) => e.hex)).size };
}

// ---- baked mock scene ---------------------------------------------------------------
//
// One view of a made-up piece of track (a pit, a ramp, a chasm, the start of a bend), baked
// the way PLAN-GFX.md wants the world baked, to judge the palette and the lighting before
// GFX-1 builds the real thing:
// - every layer is drawn alone on a scratch canvas, cut to a hard mask at alpha >= 128, and
//   filled with palette indices; layers are stacked bottom to top. An edge pixel therefore
//   has the colour of one of the two layers that meet there, never a blend or a snapped third;
// - one sun, top-left: a 1 px LIT edge up-left, a 1 px SHADE edge down-right, hard cast
//   shadows (the colour underneath, mapped through SHADE) 2-4 px down-right; no alpha;
// - no gradients: ramp steps, and an ordered dither only inside the pit, the chasm walls
//   and the ramp plate. Wear on the wide surfaces is speck density, not a dither pattern
//   (which could moire at a phone's non-integer scale).

const ZOOM = 0.8; // render.ts ZOOM
const MOCK_CAM = { x: 1620, y: 452 };
const MOCK_CARS: [number, number, number][] = [[0, 1462, 0], [1, 1880, 1]]; // colour, x, lane (0 = left of centre)

function mockTrack(): Track {
  return buildTrack({
    id: "preview-mock",
    name: "Bake Mock",
    halfWidth: 64,
    verge: 44,
    control: [[400, 400], [900, 400], [1400, 400], [1900, 400], [2300, 600], [2400, 1000], [2300, 1400], [1900, 1600], [1400, 1600], [900, 1600], [400, 1600], [100, 1400], [0, 1000], [100, 600]],
    features: [
      { k: "hole", s: 990, lat: -26, r: 24 },
      { k: "ramp", s: 1150, len: 60 },
      { k: "gap", s0: 1210, s1: 1360 },
    ],
    recovery: [0, 700],
  });
}

function mockCarPose(track: Track, x: number, lane: number): { x: number; y: number } {
  const q = queryTrack(track, x, 400);
  const p = pointAt(track, q.s);
  const lat = lane ? 26 : -24;
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise 0..1 (the large patches of wear). */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

type Mask = Uint8Array;
type Fill = PaletteName | ((x: number, y: number) => PaletteName);

/** The view as palette indices, with the layer operations of the bake. */
class Bake {
  readonly w = VIEW_W;
  readonly h = VIEW_H;
  readonly idx = new Uint8Array(VIEW_W * VIEW_H);
  readonly colors: string[] = PALETTE.map((e) => e.hex); // 0..31 the palette; car tones after
  private readonly at = new Map<string, number>(PALETTE.map((e, i) => [e.name, i]));
  private readonly shadeOf = PALETTE.map((e) => PALETTE.findIndex((o) => o.name === SHADE[e.name]));
  private readonly scratch: CanvasRenderingContext2D;
  private readonly ox: number;
  private readonly oy: number;

  constructor(cam: { x: number; y: number }) {
    const c = document.createElement("canvas");
    c.width = this.w;
    c.height = this.h;
    this.scratch = c.getContext("2d", { willReadFrequently: true })!;
    // The renderer's camera: snapped to whole view pixels.
    this.ox = this.w / 2 - Math.round(cam.x * ZOOM);
    this.oy = this.h / 2 - Math.round(cam.y * ZOOM);
  }

  /** World to view pixels. */
  px(x: number, y: number): [number, number] {
    return [x * ZOOM + this.ox, y * ZOOM + this.oy];
  }

  /** The hard mask of what `draw` paints in world coordinates: alpha >= 128, no in-between. */
  mask(draw: (g: CanvasRenderingContext2D) => void): Mask {
    const g = this.scratch;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.save();
    g.setTransform(ZOOM, 0, 0, ZOOM, this.ox, this.oy);
    g.fillStyle = g.strokeStyle = "#fff";
    g.lineJoin = "round";
    g.lineCap = "butt";
    draw(g);
    g.restore();
    const a = g.getImageData(0, 0, this.w, this.h).data;
    const m = new Uint8Array(this.w * this.h);
    for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3] >= 128 ? 1 : 0;
    return m;
  }

  fill(m: Mask | null, fill: Fill): void {
    const flat = typeof fill === "string" ? this.at.get(fill)! : -1;
    for (let y = 0, i = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++, i++) {
        if (m && !m[i]) continue;
        this.idx[i] = flat >= 0 ? flat : this.at.get((fill as (x: number, y: number) => PaletteName)(x, y))!;
      }
    }
  }

  /** One pixel. */
  put(i: number, color: PaletteName): void {
    this.idx[i] = this.at.get(color)!;
  }

  /** A cast shadow: whatever lies under the mask, one SHADE step down. */
  shade(m: Mask): void {
    for (let i = 0; i < m.length; i++) if (m[i] && this.idx[i] < this.shadeOf.length) this.idx[i] = this.shadeOf[this.idx[i]];
  }

  /** The mask moved by (dx, dy) view pixels. */
  shift(m: Mask, dx: number, dy: number): Mask {
    const out = new Uint8Array(m.length);
    for (let y = 0; y < this.h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= this.h) continue;
      for (let x = 0; x < this.w; x++) {
        const sx = x - dx;
        if (sx >= 0 && sx < this.w) out[y * this.w + x] = m[sy * this.w + sx];
      }
    }
    return out;
  }

  /** a and not b. */
  minus(a: Mask, b: Mask): Mask {
    return a.map((v, i) => (v && !b[i] ? 1 : 0));
  }

  /** The 1 px edges of a shape: sunlit up-left, dark down-right. */
  bevel(m: Mask, lit: PaletteName | null, dark: PaletteName | null): void {
    const w = this.w, h = this.h;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    const litI = lit ? this.at.get(lit)! : -1, darkI = dark ? this.at.get(dark)! : -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (litI >= 0 && (!on(x - 1, y) || !on(x, y - 1))) this.idx[y * w + x] = litI;
        else if (darkI >= 0 && (!on(x + 1, y) || !on(x, y + 1))) this.idx[y * w + x] = darkI;
      }
    }
  }

  /** A shape with the sun on it: its cast shadow, the colour, the two edges. */
  solid(m: Mask, color: PaletteName, drop = 2): void {
    if (drop) this.shade(this.minus(this.shift(m, drop, drop + 1), m));
    this.fill(m, color);
    this.bevel(m, LIT[color], SHADE[color]);
  }

  /** Hard pixels of any colour (a car), top-left at view pixel (x, y). */
  stamp(px: (string | null)[][], x: number, y: number): void {
    px.forEach((line, j) =>
      line.forEach((c, i) => {
        const u = x + i, v = y + j;
        if (!c || u < 0 || v < 0 || u >= this.w || v >= this.h) return;
        let k = this.colors.indexOf(c);
        if (k < 0) k = this.colors.push(c) - 1;
        this.idx[v * this.w + u] = k;
      }),
    );
  }

  /** The baked pixels. */
  image(): ImageData {
    const img = new ImageData(this.w, this.h);
    const out = new Uint32Array(img.data.buffer);
    const table = this.colors.map((hex) => {
      const [r, g, b] = rgbOf(hex);
      return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    });
    for (let i = 0; i < out.length; i++) out[i] = table[this.idx[i]];
    return img;
  }
}

/** The mock's world: the same camera and cars for the baked and the "today" view. */
function showMock(canvas: HTMLCanvasElement, today: boolean): void {
  const track = mockTrack();
  canvas.width = VIEW_W;
  canvas.height = VIEW_H;
  document.getElementById("sound")?.classList.add("hidden"); // the game's sound button: not part of the picture
  const cars = MOCK_CARS.map(([color, x, lane]) => ({ color: CAR_COLORS[color], ...mockCarPose(track, x, lane) }));
  if (today) {
    const r = new Renderer(canvas, track);
    r.follow(MOCK_CAM.x, MOCK_CAM.y, 16, true);
    const view = cars.map((c, i): CarView => ({ id: `m${i}`, x: c.x, y: c.y, h: 0, color: c.color, name: "", me: true, wreck: false, ghost: false }));
    r.frame(view, NO_FX, null, 0);
    return;
  }
  const b = bakeMock(track, cars);
  const g = canvas.getContext("2d")!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.putImageData(b.image(), 0, 0);
  // Proof for the report: read the canvas back and count the pixels that are not one of the
  // 32 (the two cars' own tones are counted apart).
  const data = new Uint32Array(g.getImageData(0, 0, VIEW_W, VIEW_H).data.buffer);
  const world = new Set(PALETTE.map((e) => rgbOf(e.hex)).map(([r, gg, bb]) => (0xff000000 | (bb << 16) | (gg << 8) | r) >>> 0));
  const carTone = new Set(b.colors.slice(PALETTE.length).map((hex) => rgbOf(hex)).map(([r, gg, bb]) => (0xff000000 | (bb << 16) | (gg << 8) | r) >>> 0));
  let offPalette = 0, carPixelCount = 0;
  const used = new Set<number>();
  for (const v of data) {
    if (world.has(v)) used.add(v);
    else if (carTone.has(v)) carPixelCount++;
    else offPalette++;
  }
  (window as unknown as { scrapMock: unknown }).scrapMock = { pixels: data.length, offPalette, paletteColoursUsed: used.size, carPixels: carPixelCount };
}

function bakeMock(track: Track, cars: { color: string; x: number; y: number }[]): Bake {
  const b = new Bake(MOCK_CAM);
  const gap = track.gaps[0], ramp = track.ramps[0], hole = track.holes[0];
  const L = track.length;
  const wall = track.wall, hw = track.def.halfWidth;
  const R = wall + 7; // outside of the barrier
  const offset = (s: number, lat: number) => {
    const p = pointAt(track, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
  };
  // The ground from the gap's end round to its start, as one open centreline (butt caps).
  const line = new Path2D();
  for (let s = gap.s1; s <= gap.s0 + L; s += 6) {
    const p = pointAt(track, Math.min(s, gap.s0 + L));
    if (s === gap.s1) line.moveTo(p.x, p.y);
    else line.lineTo(p.x, p.y);
  }
  const end = pointAt(track, gap.s0);
  line.lineTo(end.x, end.y);
  const band = (s0: number, s1: number, a: number, c: number) => {
    const path = new Path2D();
    const ss: number[] = [];
    for (let s = s0; s < s1; s += 6) ss.push(s);
    ss.push(s1);
    ss.forEach((s, i) => {
      const q = offset(s, a);
      if (i) path.lineTo(q.x, q.y);
      else path.moveTo(q.x, q.y);
    });
    for (let i = ss.length - 1; i >= 0; i--) {
      const q = offset(ss[i], c);
      path.lineTo(q.x, q.y);
    }
    path.closePath();
    return path;
  };
  const stroke = (half: number, dash: number[] = []) =>
    b.mask((g) => {
      g.lineWidth = half * 2;
      g.setLineDash(dash);
      g.stroke(line);
    });
  const area = (path: Path2D) => b.mask((g) => g.fill(path));
  /** Diagonal stripes inside `clip`, in the frame at (x, y, h): the mask of every second one. */
  const stripes = (clip: Path2D, at: { x: number; y: number; h: number }, reach: number, w: number) =>
    b.mask((g) => {
      g.clip(clip);
      g.translate(at.x, at.y);
      g.rotate(at.h);
      for (let u = -reach * 3 - w; u < reach; u += w * 2) {
        g.beginPath();
        g.moveTo(u, -reach);
        g.lineTo(u + w, -reach);
        g.lineTo(u + w + reach * 2, reach);
        g.lineTo(u + reach * 2, reach);
        g.closePath();
        g.fill();
      }
    });

  // 1. Dirt: specks as today, their density drifting in large patches so no tile repeats.
  b.fill(null, (x, y) => {
    const patch = vnoise(x / 46, y / 46, 11);
    const h = hash(x, y, 1);
    if (hash(x >> 1, y >> 1, 5) < 0.006) return "gravel0"; // a pebble
    if (h < 0.03 + 0.07 * patch) return "dirt3";
    if (h > 0.97 - 0.09 * (1 - patch)) return "dirt1";
    return "dirt2";
  });

  // 2. Junk in small heaps outside the walls: two tones, a lit edge, a hard shadow.
  const rnd = mulberry(23);
  const paints: PaletteName[] = ["rust1", "rust2", "rust0", "haz0", "steel1", "rust1", "steel2"];
  const junk: { kind: string; x: number; y: number; r: number; a: number; c: PaletteName }[] = [];
  for (let tries = 0; junk.length < 26 && tries < 400; tries++) {
    const hx = MOCK_CAM.x + (rnd() - 0.5) * 860, hy = MOCK_CAM.y + (rnd() - 0.5) * 500;
    if (queryTrack(track, hx, hy).dist < R + 40) continue;
    if (junk.some((d) => Math.hypot(d.x - hx, d.y - hy) < 90)) continue; // heaps stand apart
    for (let n = 2 + Math.floor(rnd() * 3), k = 0; k < n; k++) {
      const x = hx + (rnd() - 0.5) * 52, y = hy + (rnd() - 0.5) * 40;
      if (queryTrack(track, x, y).dist < R + 16) continue;
      const pick = rnd();
      const kind = pick < 0.36 ? "cube" : pick < 0.56 ? "drum" : pick < 0.74 ? "tyres" : pick < 0.84 ? "plate" : pick < 0.93 ? "pallet" : "engine";
      junk.push({ kind, x, y, r: 9 + rnd() * 8, a: rnd() * Math.PI, c: paints[Math.floor(rnd() * paints.length)] });
    }
  }
  junk.sort((p, q) => p.y - q.y);
  for (const d of junk) {
    const turned = (g: CanvasRenderingContext2D) => {
      g.translate(d.x, d.y);
      g.rotate(d.a);
    };
    const disc = (x: number, y: number, r: number) => b.mask((g) => g.fill(circlePath(x, y, r)));
    if (d.kind === "cube" || d.kind === "pallet") {
      // A crushed cube with two straps; a pallet is wood with three slats.
      const pallet = d.kind === "pallet";
      const w = pallet ? d.r * 1.6 : d.r * 2, h = pallet ? d.r * 1.6 : d.r * 1.4;
      const c: PaletteName = pallet ? "gravel1" : d.c;
      b.solid(b.mask((g) => { turned(g); g.fillRect(-w / 2, -h / 2, w, h); }), c, 3);
      b.fill(b.mask((g) => {
        turned(g);
        for (const k of pallet ? [-0.3, 0, 0.3] : [-0.17, 0.2]) g.fillRect(-w / 2 + 1.5, k * h - 1.25, w - 3, 2.5);
      }), SHADE[c]);
    } else if (d.kind === "drum") {
      // A drum on its end: the rim is the bevel, inside it a darker ring.
      b.solid(disc(d.x, d.y, d.r * 0.66), d.c, 3);
      b.fill(b.mask((g) => { g.lineWidth = 2; g.stroke(circlePath(d.x, d.y, d.r * 0.36)); }), SHADE[d.c]);
    } else if (d.kind === "tyres") {
      for (let i = 0; i < 3; i++) {
        const x = d.x + Math.cos(d.a + i * 2.1) * d.r * 0.5, y = d.y + Math.sin(d.a + i * 2.1) * d.r * 0.5;
        b.solid(disc(x, y, 7), "soot2", 3);
        b.fill(disc(x, y, 3.4), "tar2");
      }
    } else if (d.kind === "plate") {
      // A bent plate with its crease catching the sun.
      const w = d.r * 1.3, h = d.r * 0.8;
      b.solid(b.mask((g) => {
        turned(g);
        g.beginPath();
        g.moveTo(-w, -h * 0.6);
        g.lineTo(w * 0.8, -h);
        g.lineTo(w, h * 0.5);
        g.lineTo(-w * 0.7, h);
        g.closePath();
        g.fill();
      }), d.c, 3);
      b.fill(b.mask((g) => { turned(g); g.rotate(-0.08); g.fillRect(-w * 0.8, -h * 0.2, w * 1.6, 1.8); }), LIT[d.c]);
    } else {
      // An engine block: steel, a lighter head, three bores.
      const w = d.r * 1.7, h = d.r * 1.1;
      b.solid(b.mask((g) => { turned(g); g.fillRect(-w / 2, -h / 2, w, h); }), "steel1", 3);
      b.fill(b.mask((g) => { turned(g); g.fillRect(-w / 2 + 1.5, -h / 2 + 1.5, w - 3, h * 0.36); }), "steel2");
      b.fill(b.mask((g) => { turned(g); for (const k of [-0.3, 0, 0.3]) g.fill(circlePath(k * w, h * 0.18, 2.2)); }), "soot2");
    }
  }

  // 3. Gravel thrown over the wall: a ragged fringe, thinning out, instead of a ruled edge.
  const fringe = [b.minus(stroke(R + 5), stroke(R)), b.minus(stroke(R + 12), stroke(R + 5))];
  fringe.forEach((m, k) => {
    for (let y = 0, i = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++, i++) {
        if (m[i] && hash(x, y, 31) < (k ? 0.14 : 0.42)) b.put(i, hash(x, y, 32) < 0.5 ? "gravel0" : "gravel1");
      }
    }
  });

  // 4. The chasm: dark, its earth walls in steps; the walls that face the sun one step lighter.
  const voidPath = band(gap.s0, gap.s1, -R, R);
  const voidMask = area(voidPath);
  b.fill(voidMask, (x, y) => (hash(x, y, 4) < 0.07 ? "soot0" : hash(x, y, 6) < 0.04 ? "soot2" : "soot1"));
  const wallBand = (width: number) => b.mask((g) => { g.clip(voidPath); g.lineWidth = width * 2; g.stroke(voidPath); });
  const inVoid = (x: number, y: number) => x >= 0 && y >= 0 && x < b.w && y < b.h && voidMask[y * b.w + x] === 1;
  // From the dark inward step out to the rim: each band is drawn over the one before it.
  [30, 21, 13, 6].forEach((width, k) => {
    const reach = Math.ceil(width * ZOOM);
    b.fill(wallBand(width), (x, y) => {
      // A wall on the sun's side of the hole faces away from the sun: a step darker.
      const away = !inVoid(x - reach, y - reach);
      if (k === 0) return BAYER4[y & 3][x & 3] < 8 ? "soot1" : away ? "soot0" : "soot2";
      return (away ? (["soot1", "soot2", "soot3"] as const) : (["soot2", "soot3", "dirt0"] as const))[k - 1];
    });
  });

  // 5-7. Verge, kerbs, tarmac: one stroke each, the road worn along the racing line.
  b.fill(stroke(wall), (x, y) => {
    const h = hash(x, y, 2);
    return h < 0.075 ? "gravel2" : h > 0.935 ? "gravel0" : h > 0.925 ? "bone0" : "gravel1";
  });
  b.fill(stroke(hw + 5), "bone1");
  b.fill(stroke(hw + 5, [22, 22]), "rust2");
  const tarmac = stroke(hw);
  const groove = b.mask((g) => {
    // The racing line: where the cars run, more rubber and oil.
    g.lineWidth = 34;
    g.beginPath();
    for (let s = gap.s1; s <= gap.s0 + L; s += 8) {
      const q = offset(s, 16 * Math.sin(s / 260));
      if (s === gap.s1) g.moveTo(q.x, q.y);
      else g.lineTo(q.x, q.y);
    }
    g.stroke();
  });
  const patch = area(band(1040, 1110, 8, 52)); // a repair: a lighter mix, a dark joint round it
  b.fill(tarmac, (x, y) => {
    const i = y * b.w + x, h = hash(x, y, 3);
    if (patch[i]) return h < 0.3 ? "tar2" : h > 0.97 ? "tar0" : "tar1";
    const dark = groove[i] ? 0.3 : 0.05;
    return h < dark ? "tar0" : h > (groove[i] ? 0.985 : 0.93) ? "tar2" : "tar1";
  });
  b.bevel(patch, null, "tar0");
  b.fill(b.mask((g) => { g.lineWidth = 2.5; g.setLineDash([18, 26]); g.stroke(line); }), "tar3");
  // Two oil stains near the pit.
  for (const [s, lat, r] of [[905, 22, 15], [1085, -40, 11]]) {
    const o = offset(s, lat), [ox, oy] = b.px(o.x, o.y);
    b.fill(tarmac, (x, y) => {
      const d = Math.hypot(x - ox, (y - oy) * 1.5) / (r * ZOOM * (0.55 + 0.6 * vnoise(x / 5, y / 5, 9)));
      const now = PALETTE[b.idx[y * b.w + x]].name;
      return d < 0.6 ? "tar0" : d < 1 && hash(x, y, 8) < 0.5 ? "tar0" : now;
    });
  }

  // 8. The pit: a jagged rim, cracks, and the far wall in the sun; the dark dithers down.
  {
    const rr = mulberry(211);
    const rim = new Path2D();
    for (let k = 0; k < 15; k++) {
      const a = (k / 15) * Math.PI * 2, r = hole.r * (1.1 + rr() * 0.16);
      if (k) rim.lineTo(hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r);
      else rim.moveTo(hole.x + Math.cos(a) * r, hole.y + Math.sin(a) * r);
    }
    rim.closePath();
    b.fill(b.mask((g) => {
      g.lineWidth = 2;
      g.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = rr() * Math.PI * 2;
        let x = hole.x + Math.cos(a) * hole.r * 1.12, y = hole.y + Math.sin(a) * hole.r * 1.12;
        g.moveTo(x, y);
        for (let j = 0; j < 3; j++) {
          const c = a + (rr() - 0.5) * 1.1, step = hole.r * (0.18 + rr() * 0.22);
          x += Math.cos(c) * step;
          y += Math.sin(c) * step;
          g.lineTo(x, y);
        }
      }
      g.stroke();
    }), "soot2");
    const rimMask = area(rim);
    b.fill(rimMask, "soot3");
    b.bevel(rimMask, "tar3", null); // the broken edge catches the light
    const [hx, hy] = b.px(hole.x, hole.y), r = hole.r * ZOOM;
    b.fill(area(circlePath(hole.x, hole.y, hole.r)), (x, y) => {
      // The pit's floor sits up-left of its mouth: what shows down-right is the lit far wall.
      const d = Math.hypot(x + 0.5 - (hx - r * 0.2), y + 0.5 - (hy - r * 0.25)) / r;
      const t = BAYER4[y & 3][x & 3] / 16;
      if (d > 1) return "dirt0";
      if (d > 0.8) return (d - 0.8) / 0.2 > t ? "soot3" : "soot2";
      if (d > 0.45) return (d - 0.45) / 0.35 > t ? "soot2" : "soot1";
      return d / 0.45 > t ? "soot1" : "soot0";
    });
  }

  // 9. The chasm's ends on the road: the drop, hazard stripes, the broken edge.
  for (const [s, dir] of [[gap.s0, 1], [gap.s1, -1]]) {
    const lo = (p: number, q: number) => Math.min(p, q), hi = (p: number, q: number) => Math.max(p, q);
    b.shade(area(band(lo(s, s + dir * 10), hi(s, s + dir * 10), -wall, wall)));
    const hz = band(lo(s, s - dir * 7), hi(s, s - dir * 7), -(hw + 5), hw + 5);
    b.fill(area(hz), "haz1");
    b.fill(stripes(hz, pointAt(track, s - dir * 3.5), hw + 14, 5), "soot2");
    b.fill(area(band(lo(s, s - dir * 2), hi(s, s - dir * 2), -wall, wall)), "gravel2");
  }

  // 10. The ramp: a striped plate rising to the lip (dark at the foot, light at the top, by
  // dither), three chevrons, the hazard lip, and its shadow on what lies beyond.
  {
    const W = wall - 1, top = ramp.s + ramp.len;
    const plate = band(ramp.s, top, -W, W);
    const mid = pointAt(track, ramp.s + ramp.len / 2);
    b.shade(area(band(top, top + 9, -W + 4, W + 4)));
    const plateMask = area(plate), striped = stripes(plate, mid, ramp.len / 2 + wall + 4, 6);
    const [ax, ay] = b.px(pointAt(track, ramp.s).x, pointAt(track, ramp.s).y);
    const [bx, by] = b.px(pointAt(track, top).x, pointAt(track, top).y);
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    b.fill(plateMask, (x, y) => {
      const base: PaletteName = striped[y * b.w + x] ? "rust2" : "steel2";
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      const seam = (x + y) & 1;
      if (t < 0.34) return t > 0.31 && seam ? base : SHADE[base];
      if (t > 0.67) return t < 0.7 && seam ? base : LIT[base];
      return base;
    });
    const chevrons = (width: number) =>
      b.mask((g) => {
        g.clip(plate);
        g.translate(mid.x, mid.y);
        g.rotate(mid.h);
        g.lineJoin = "miter";
        g.lineWidth = width;
        const d = Math.min(9, ramp.len * 0.18);
        for (const lat of [-W * 0.58, 0, W * 0.58]) {
          g.beginPath();
          g.moveTo(-d, lat - d * 1.3);
          g.lineTo(d, lat);
          g.lineTo(-d, lat + d * 1.3);
          g.stroke();
        }
      });
    b.fill(chevrons(6), "soot2");
    b.fill(chevrons(3), "bone1");
    b.fill(b.mask((g) => { g.lineWidth = 2; g.stroke(plate); }), "soot2");
    b.fill(area(band(top - 3.5, top, -W, W)), "haz1");
  }

  // 11. The barrier last: its shadow on the ground both sides, the rail with a lit top
  // edge, a post every 60 units.
  const barrier = b.minus(stroke(R), stroke(wall));
  b.shade(b.minus(b.shift(barrier, 3, 4), barrier));
  b.fill(barrier, "steel0");
  const rail = b.minus(stroke(wall + 4.6), stroke(wall + 1.8));
  b.fill(rail, "steel2");
  b.bevel(rail, "steel3", null);
  for (let s = gap.s1 + 30; s < gap.s0 + L; s += 60) {
    for (const side of [-1, 1]) {
      const q = offset(s, side * (wall + 3.2));
      const [qx, qy] = b.px(q.x, q.y);
      const x = Math.round(qx) - 1, y = Math.round(qy) - 1;
      if (x < 1 || y < 1 || x > b.w - 4 || y > b.h - 4) continue;
      const post = new Uint8Array(b.w * b.h);
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) post[(y + j) * b.w + x + i] = 1;
      b.shade(b.minus(b.shift(post, 2, 2), post));
      b.fill(post, "steel1");
      b.bevel(post, "steel3", "steel0");
    }
  }

  // 12. Two cars, to judge the car tones on the baked road (hard silhouette shadows).
  for (const c of cars) {
    const [cx, cy] = b.px(c.x, c.y);
    const x = Math.round(cx) - CAR_W / 2, y = Math.round(cy) - Math.floor(CAR_H / 2);
    const px = carPixels(c.color);
    const body = new Uint8Array(b.w * b.h);
    px.forEach((row, j) => row.forEach((v, i) => {
      if (v && y + j >= 0 && y + j < b.h && x + i >= 0 && x + i < b.w) body[(y + j) * b.w + x + i] = 1;
    }));
    b.shade(b.minus(b.shift(body, 2, 3), body));
    b.stamp(px, x, y);
  }
  return b;
}

function circlePath(x: number, y: number, r: number): Path2D {
  const p = new Path2D();
  p.arc(x, y, r, 0, Math.PI * 2);
  return p;
}

function mulberry(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
