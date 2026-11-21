// Cars and effects on the world: shadows, cars (grounded, airborne, falling, ghost, battered,
// wreck), smoke, mines, rivets, hit sparks, mine blasts and dust. PLAN-GFX.md, items B1-B8.
// What the track keeps of them is told to the world here, where it is known (B9): a mine's
// blast leaves a scorch, a car sliding sideways its tyre marks (gfx/world.ts, track marks).
//
// Everything here is a sprite (gfx/sprites.ts) or a small rectangle, drawn in view space:
// identity transform, whole view pixels, never under the world's 0.8 zoom. A frame allocates
// nothing: the cars' states for the frame and what is remembered of them between frames live
// in typed arrays, the dust in a fixed pool.
//
// - A car is one cell of its colour's sheet, picked by its heading (128 steps). Another
//   player's car changes cell only once its heading is clearly past the step (HYSTERESIS), so
//   the noise of interpolation and reconciliation cannot flip it between two cells.
// - Where a car lands is a whole pixel, and whole pixels can make a car shake: two things
//   that move together, each rounded by itself, step at different moments and so move a
//   pixel back and forth against each other. While the view follows a car, that car is put
//   where the Renderer says (render.ts, ahead). Another car is put, on each axis,
//   on the road's pixels (it stands, or moves unlike the followed car: it then never steps
//   back against the road), or a whole number of pixels from the followed car (it moves with
//   it: it then stands still beside it while the road runs under both). A shadow is a whole
//   offset from its car. (tools/debug/jitter-trace.ts counts the steps back.)
// - A car's sheet is picked by its colour, its look (sport, racer, truck) and its state: whole,
//   battered (hp under BATTERED) or wrecked. The shadow is its look's silhouette in the same
//   cell.
// - In the air a car grows to 1.35x, in a fall it shrinks to 0.3x: the same cell, blitted
//   scaled (nearest neighbour, whole pixels). Size steps baked ahead would be a sheet per
//   step and colour (0.5 MB each); the scaled blit costs no memory and happens for a car or
//   two at a time.
// - The catch-up visuals (PLAN-M4.md 2.5, 2.8; M4-FX), each drawn only when the frame names it:
//   the lightning cells (WorldFx.cells), the flames of a boosting car (CarView.boost) and the
//   streaks of air past a car in a slipstream (CarView.draft). See "Catch-up" below.
// - What moves on a road (M4-WORLD: rolling barrels, a crusher press, a belt's arrows) is drawn
//   by gfx/obstacles.ts at the race tick the frame names (WorldFx.rt), here in the order of
//   things: on the road under the cars, and a press's slab that is down over the cars on the
//   ground and under those in the air. Without a tick none of it is drawn.

import type { Track } from "../../shared/track";
import { MINE_BLINK_FAST_TICKS } from "../../shared/weapons";
import type { CarView, DrawPose, WorldFx } from "../render";
import { Obstacles } from "./obstacles";
import { P } from "./palette";
import { BLAST_FRAMES, BURNT, carSheet, catchSheet, CELL, CELL_FRAMES, CX_AIR, CX_AIR_GONE, CX_GONE, CX_GROUND, CX_SHADE, DENTED, FLAME, FLAME_AT, FLAME_COLS, FLAME_FRAMES, FLAME_HEADINGS, FLAME_LOW, FX_BLAST, FX_COLS, FX_MINE, FX_PUFF, FX_SPARK, HEADING_STEP, HEADINGS, lookOf, RACER, SHADOW_ALPHA, shadeSheet, sharedSheets, SPARK_FRAMES, SPARK_KINDS, spriteFrame, spritesFor, WHOLE, type SharedSheets } from "./sprites";
import { MARK, marksCleared, scorch, skid, VIEW_H, VIEW_W, ZOOM } from "./world";

/** Airborne cars: drawn up to this much bigger at the top of the arc ... */
const AIR_SCALE = 0.35;
/** ... with the shadow moved this far away (world units, down-right) at the top. */
const AIR_SHADOW_X = 14;
const AIR_SHADOW_Y = 20;
/** A falling car shrinks to this fraction of its size by the end of the fall. */
const FALL_SCALE = 0.3;
const FALL_BLINKS = 7; // on/off cycles over the whole fall
/** A car under this share of its health shows its damage. */
const BATTERED = 0.4;
/** A remote car's cell changes once its heading is this far past the middle between two cells (in steps). */
const HYSTERESIS = 0.2;

const HALF = CELL / 2;
const SMALL = 20; // mines and puffs fill the middle 20 x 20 of their cell
const INSET = (CELL - SMALL) / 2;
const OFF = 48; // a car further outside the view than this is not drawn

const MAX_CARS = 16; // cars drawn in a frame (a room has six)
const SLOTS = 12; // cars remembered from frame to frame
const GROUND = 0, AIR = 1, FALLING = 2;

// Dust: a pool of 2 x 2 px specks, thrown up by a car off the tarmac and by a landing.
const DUST = 48;
const DUST_EVERY = 6; // world units driven per speck
const DUST_MIN_SPEED = 70; // units/s
const DUST_LIFE = 0.3; // seconds
const DUST_FADE = 0.12; // ... the last of them in the darker tone
const PUFF = 10; // specks of a landing
const PUFF_LIFE = 0.34;
const JUMP = 40; // a car that moved further than this in a frame was put there, not driven
const RANDOM = 65536;

// Tyre marks: a car on the ground sliding sideways faster than SKID (units/s) marks the track
// under its rear wheels, a stamp every SKID_EVERY frames at most, each a line from where the
// wheels were at the stamp before. (shared/physics.ts, full lock on tarmac: from top speed a
// car slides at up to 156 and is past 105 after a tenth of a second; from 255 units/s it
// peaks at 110; from 230 and below it never gets there.)
// How fast a car slides is read off its steps on screen, sideways to its heading. In a race
// the steps on screen are not all a car's driving, the less so the slower the link, and
// main.ts tells what it knows besides (driving), before each frame:
// - Another player's car near the own one is drawn part of the way toward where the
//   prediction has it bumped (client/contact.ts, blend), and jostles sideways there. Its
//   slide is read off its steps where the server's snapshots have it; the marks still lie
//   where its wheels are drawn.
// - The own car is the predicted one. When a snapshot puts it elsewhere (a mine spun it round
//   a moment ago, as the server knows and the prediction did not), it is not put there at once
//   but drawn sliding there over a few frames (client/game.ts, smooth). And touching another
//   car it is pushed about by a prediction of that car. So a frame marks nothing for the own
//   car while more than CORRECTING units of a correction are left to work off, nor unless the
//   predicted car itself slides at SLIDES or more (its velocity across its heading), nor within
//   TOUCHING ms of its last predicted touch. Three vetoes on its steps on screen: it is never
//   marked where it would not have been without them.
// A frame that is told nothing (the preview, a benchmark) reads every car off the screen.
// (tools/debug/skid-lag.ts counts the stamps on a slow link.)
const SKID = 105;
const SKID_EVERY = 2;
const SKID_GAP = 4; // frames without a slide after which the next mark starts afresh
const CORRECTING = 1.2; // world units of a correction left: a step works off 38 % of it, here 27 units/s
const SLIDES = 0.6 * SKID;
const TOUCHING = 100; // ms
const AXLE = 9; // the rear wheels: this far behind the car's middle (world units) ...
const WHEEL = 6; // ... and to either side of it
// A mine on its way out (shared/protocol.ts MineSnap: `out`, the ticks until it is gone) blinks:
// drawn and left out in turn, BLINK_SLOW ms each, BLINK_FAST over its last MINE_BLINK_FAST_TICKS
// (8 and 4 display frames at 60 Hz). A mine left out costs a comparison; nothing is kept per mine.
const BLINK_SLOW = (8 * 1000) / 60;
const BLINK_FAST = (4 * 1000) / 60;
/** A mine as the game hands it over: the frame's WorldFx entry, with the snapshot's `out` when it has one. */
type MineView = WorldFx["mines"][number] & { out?: number };
const BLASTS = 32; // mine blasts remembered as having left their scorch
// The marks are cleared at a new race and a restart (world.ts clearMarks); the blasts
// remembered go with them. A blast of the race before may still burn then, or still wait to
// be shown (main.ts holds a hit on another car back by the interpolation delay, 100 ms, and a
// blast burns for 133): for QUIET ms after the clearing a blast leaves no scorch and is not
// remembered. A new race's first blast is seconds away (the countdown).
const QUIET = 300;

// ---- Catch-up (PLAN-M4.md 2.5 and 2.8) -----------------------------------------------------
//
// Lightning cells (WorldFx.cells). One on the ground lies under the cars, with the mines, and
// crackles. A floating one is drawn over the cars on the ground and under the ones in the
// air, at its own place, as a car in the air is; it bobs a few pixels, and its shadow lies on
// the ground as far away as that of a car AIR_UP high. A cell that was taken is a broken
// outline, still (no bob); with less than CELL_RETURNING of its wait left the outline blinks.
// All of it is one picture a cell from the catch-up sheet (gfx/sprites.ts), picked by the
// clock and by the cell's place (so the cells of a track do not move in step).
/** A taken cell (render.ts CellView.state) with less than this share of its wait left is about to be back: its outline blinks. */
export const CELL_RETURNING = 0.12;
const CELL_BLINK = 140; // ms lit, ms not
const CELL_FRAME = 95; // ms a frame of a cell's crackle
const AIR_UP = 0.7; // a floating cell's shadow: that of a car this high (0..1)
const BOB = Int8Array.of(0, -1, -1, -2, -2, -2, -1, -1, 0, 1, 1, 2, 2, 2, 1, 1); // a floating cell's rise (-) and fall, view pixels
const BOB_STEP = 85; // ms a step: once up and down in 1.4 s
// The flames of a boosting car (CarView.boost): out of the two pipes of the sport and of the
// truck, one out of the racer's tail, under the car, at every heading (64 of them: the car's
// cell rounded to every second one). They flicker through FLAME_FRAMES frames, FLAME_STEP ms
// each; over the last FLAME_ENDS ticks of the boost they are the short frame. A car in the
// air has them grow with it; a wreck and a falling car have none.
const FLAME_STEP = 50;
const FLAME_ENDS = 9;
const PIPE = 3.4; // the two pipes: this far either side of the car's line, view pixels
/** Per flame heading: from the car's line to its right pipe, whole view pixels (x, y); the left pipe is the same the other way. */
const PIPE_AT = new Int8Array(FLAME_HEADINGS * 2);
for (let f = 0; f < FLAME_HEADINGS; f++) {
  const a = (f * Math.PI * 2) / FLAME_HEADINGS;
  PIPE_AT[f * 2] = Math.round(-Math.sin(a) * PIPE) | 0;
  PIPE_AT[f * 2 + 1] = Math.round(Math.cos(a) * PIPE) | 0;
}
// The slipstream (CarView.draft, 0..1): streaks of air running past the car, from ahead of
// it (out of the wake of the car it follows) to behind it, in lanes either side, drawn in
// toward its own wake. A streak is a one-pixel line along the car's heading. The stronger the
// draft, the more streaks (STREAKS_MIN to STREAKS) and the longer (STREAK_MIN to STREAK_MAX
// pixels), and from STREAK_BRIGHT on the lighter; every streak is dim over the first and the
// last stretch of its run. Where a streak is depends on the clock alone: nothing is kept of
// them. A line is filled as the rows (or columns) of pixels it is made of: at most
// STREAKS x STREAK_MAX rectangles a car, a third of that at most headings. A car in the air, a
// falling car and a wreck have none.
const STREAKS = 8;
const STREAKS_MIN = 3;
const STREAK_MIN = 5;
const STREAK_MAX = 14;
const STREAK_BRIGHT = 0.5;
const STREAK_MS = 300; // a streak's run past the car
const STREAK_FROM = 30; // it starts this far ahead of the car's middle, view pixels ...
const STREAK_RUN = 54; // ... and ends this much further back
const STREAK_LANE = 8; // the first lane: this far from the car's line ...
const STREAK_LANES = 2.5; // ... the next ones this much further out each
const STREAK_IN = 0.25; // a lane is this much nearer the car's line at its end
/** The cosine and the sine of a car cell's heading. */
const COS = new Float64Array(HEADINGS), SIN = new Float64Array(HEADINGS);
for (let k = 0; k < HEADINGS; k++) {
  COS[k] = Math.cos(k * HEADING_STEP);
  SIN[k] = Math.sin(k * HEADING_STEP);
}

// Numbers that are not whole go from one function here to the next through this array, not as
// arguments or results: handed over in a call they are boxed (16 bytes each, in Node).
const F = new Float64Array(14);
const DT = 0; // this frame's step, seconds
const NOW = 1; // this frame's time, ms
const QX = 2; // nearTrack: the point ...
const QY = 3;
const QDIST = 4; // ... and its distance from the centreline
const LX = 5; // the car the view follows: where it truly is, in view pixels of the track's plane ...
const LY = 6;
const LVX = 7; // ... and how far it came since the frame before
const LVY = 8;
const PG = 9; // place(): a car's step over the ground on the axis, view pixels ...
const PD = 10; // ... and its true place from the followed car's
const OWN = 11; // the predicted own car's speed sideways as told for this frame (driving), units/s; NaN = not told ...
const LEFT = 12; // ... how much of a correction is left to work off on screen, world units ...
const TOUCH = 13; // ... and when the predicted car last touched another car (ms, the frames' clock)
F[OWN] = NaN;
let snaps: readonly DrawPose[] | null = null; // the other cars where the snapshots have them, as told for this frame

/**
 * What main.ts knows of the cars' driving besides their poses on screen, told before each
 * frame of a race, for the tyre marks: the predicted own car, the correction still to be
 * worked off on screen and the contact prediction (client/game.ts: car, smooth, contact), and
 * the other cars where the server's snapshots have them (game.otherPoses()). A frame that is
 * told nothing reads every car's slide off its steps on screen.
 */
export function driving(own: { vx: number; vy: number; h: number } | null, smooth: { x: number; y: number }, contact: { lastContact: number }, others: readonly DrawPose[]): void {
  F[OWN] = own ? own.vy * Math.cos(own.h) - own.vx * Math.sin(own.h) : NaN;
  F[LEFT] = Math.sqrt(smooth.x * smooth.x + smooth.y * smooth.y);
  F[TOUCH] = contact.lastContact;
  snaps = others;
}

// ---- Whole pixels ---------------------------------------------------------------------
//
// Things drawn at whole pixels that move together cannot each be the rounding of its own
// true value: they step at different moments, and one goes a pixel forth and a pixel back
// against the other while nothing reverses. The view and the car it follows are stepped
// together by the Renderer (render.ts, ahead). For any other car, see place().

// A car rides with the car the view follows, on an axis, once its step against that car is
// under RIDE_IN of its step over the ground (squared) and it moves at all (RIDE_MIN, view
// pixels a frame, squared); it stops when it moves more against that car than over the
// ground, at a moment both ways put it on the same pixel.
const RIDE_IN = 0.5;
const RIDE_MIN = 0.0025;
/** Riding, its whole-pixel place from that car changes once its true place is this far past the middle between two pixels ... */
const RIDE_SLACK = 0.25;
/** ... but a change that would step it back on the road waits for the followed car's next step there (the two cancel), up to this far off. */
const RIDE_MAX = 1.5;
/** And a step it is on its way to is taken early, from this far off, when the followed car moves a pixel on screen the other way: it then stays where it is on screen. */
const RIDE_EARLY = 0.35;

/** The centreline segment nearest to (F[QX], F[QY]) among `count` from `from`; the distance goes to F[QDIST]. */
function nearTrack(track: Track, from: number, count: number): number {
  const x = F[QX], y = F[QY];
  const pts = track.pts, n = pts.length;
  let best = Infinity, seg = 0;
  for (let k = 0; k < count; k++) {
    const i = (((from + k) % n) + n) % n;
    const a = pts[i], b = pts[i + 1 < n ? i + 1 : 0];
    const ex = b.x - a.x, ey = b.y - a.y;
    let t = ((x - a.x) * ex + (y - a.y) * ey) / (ex * ex + ey * ey || 1);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + ex * t - x, py = a.y + ey * t - y;
    const d2 = px * px + py * py;
    if (d2 < best) {
      best = d2;
      seg = i;
    }
  }
  F[QDIST] = Math.sqrt(best);
  return seg;
}

/**
 * On a widened road (a split's): F[QDIST], the distance of (F[QX], F[QY]) from the centreline
 * at segment `seg`, less how much wider the road is there on the point's side. What lies
 * halfWidth out is then the road's edge again, as on a road that is not widened.
 */
function widened(track: Track, seg: number): void {
  const pts = track.pts, n = pts.length, next = seg + 1 < n ? seg + 1 : 0;
  const a = pts[seg], b = pts[next];
  const ex = b.x - a.x, ey = b.y - a.y;
  let t = ((F[QX] - a.x) * ex + (F[QY] - a.y) * ey) / (ex * ex + ey * ey || 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const half = ex * (F[QY] - a.y) - ey * (F[QX] - a.x) < 0 ? track.halfL : track.halfR; // left of travel, or right
  F[QDIST] -= half[seg] + (half[next] - half[seg]) * t - track.def.halfWidth;
}

export class Actors {
  private sheets: SharedSheets | null = null;
  private frameNo = 0;
  private readonly last = new Float64Array(1).fill(NaN); // the time of the frame before
  // This frame's cars, by their place in the list.
  private readonly cell = new Int16Array(MAX_CARS);
  private readonly kind = new Uint8Array(MAX_CARS);
  private readonly look = new Uint8Array(MAX_CARS); // sprites.ts lookOf
  private readonly sx = new Int32Array(MAX_CARS); // the middle of its sprite on screen
  private readonly sy = new Int32Array(MAX_CARS);
  private readonly shift = new Int32Array(MAX_CARS * 2); // ... less that on the road's pixels, by its own rounding (x, y)
  private readonly up = new Float64Array(MAX_CARS); // 0..1 height in the air
  private readonly fall = new Float64Array(MAX_CARS); // 0..1 of the fall, -1 = not falling
  private readonly order = new Uint8Array(MAX_CARS); // the airborne ones, lowest first
  private boosting = 0; // how many of this frame's cars have a flame to draw ...
  private drafting = 0; // ... and how many are in a slipstream
  // What is remembered of a car from frame to frame, by slot.
  private readonly ids: string[] = new Array<string>(SLOTS).fill("");
  private readonly seen = new Int32Array(SLOTS); // the frame it was last drawn in
  private readonly lastCell = new Int16Array(SLOTS);
  private readonly lastX = new Float64Array(SLOTS);
  private readonly lastY = new Float64Array(SLOTS);
  private readonly lastUp = new Float32Array(SLOTS); // its height then
  private readonly seg = new Int32Array(SLOTS).fill(-1); // where on the track it was (the search hint)
  private readonly owed = new Float32Array(SLOTS); // distance driven off the tarmac since its last speck
  private readonly skidAt = new Int32Array(SLOTS); // the frame its rear wheels were last noted in a slide (0 = not) ...
  private readonly wheels = new Float64Array(SLOTS * 4); // ... and where they were: left x, y, right x, y
  private readonly snapX = new Float64Array(SLOTS); // where the snapshots had it (driving) ...
  private readonly snapY = new Float64Array(SLOTS);
  private readonly snapAt = new Int32Array(SLOTS); // ... in this frame (0 = never told)
  // The mine blasts that have left their scorch, by their place (a blast keeps it for life).
  private readonly blastX = new Float64Array(BLASTS).fill(NaN);
  private readonly blastY = new Float64Array(BLASTS).fill(NaN);
  private blastNext = 0;
  private cleared = -1; // world.ts marksCleared() when last looked (-1 = never)
  private readonly quiet = new Float64Array(1).fill(-Infinity); // until then (ms) a blast leaves no scorch
  // Per slot and axis (slot * 2 + axis): 1 = placed from the car the view follows, 0 = on the road's pixels ...
  private readonly rides = new Uint8Array(SLOTS * 2);
  private readonly rel = new Int32Array(SLOTS * 2); // ... and its whole-pixel place from that car
  // The car the view follows this frame: its place in the list (-1 = none); per axis its pixel
  // in the track's plane as drawn, and its steps there and on screen since the frame before
  // (`led`: it was there then).
  private lead = -1;
  private led = false;
  private readonly leadRoad = new Int32Array(2);
  private readonly leadAt = new Int32Array(2);
  private readonly leadStep = new Int32Array(2);
  private readonly leadShift = new Int32Array(2);
  // The dust.
  private readonly dustX = new Float32Array(DUST);
  private readonly dustY = new Float32Array(DUST);
  private readonly dustVx = new Float32Array(DUST);
  private readonly dustVy = new Float32Array(DUST);
  private readonly dustLife = new Float32Array(DUST); // seconds left, 0 = free
  private dustNext = 0;
  private dustLive = 0; // a count that is never too low: 0 = nothing to step or draw
  private readonly rng = new Uint32Array(1);
  private readonly moving: Obstacles; // what moves on the road (barrels, presses, a belt's arrows)
  private readonly wide: boolean; // the road is widened somewhere: its edge is not everywhere halfWidth out

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly track: Track,
  ) {
    spritesFor(ctx);
    this.rng[0] = 0x9e3779b9;
    this.moving = new Obstacles(ctx, track);
    this.wide = track.widens.length > 0;
  }

  /**
   * Draw the frame's cars and effects on the world already drawn, the view's top-left at view
   * pixel (ox, oy) of the track's plane. `now` (ms) drives the blinks, the smoke and the dust.
   * `lead`: the place in `cars` of the car the view follows (-1 = it follows none), and
   * (leadX, leadY) that car's pixel in the track's plane, as the Renderer's view has it.
   */
  draw(cars: readonly CarView[], fx: WorldFx, ox: number, oy: number, now: number, lead = -1, leadX = 0, leadY = 0): void {
    const ctx = this.ctx;
    const sheets = this.sheets ?? (this.sheets = sharedSheets());
    const kind = this.kind, order = this.order, ups = this.up;
    const n = cars.length < MAX_CARS ? cars.length : MAX_CARS;
    // A frame's step: none on the first frame, on a held clock, or after a long gap.
    const dt = (now - this.last[0]) / 1000;
    F[DT] = dt > 0 && dt < 0.1 ? dt : 0;
    F[NOW] = now;
    this.last[0] = now;
    this.frameNo++;
    spriteFrame();
    this.lead = lead >= 0 && lead < n ? lead : -1;
    if (this.lead < 0) this.led = false;
    else {
      // Before the cars are gone through: what the others are placed by.
      const c = cars[this.lead];
      const s = this.slot(c.id);
      this.led = this.seen[s] === this.frameNo - 1; // its steps are steps only if it was there the frame before
      F[LX] = c.x * ZOOM;
      F[LY] = c.y * ZOOM;
      F[LVX] = (c.x - this.lastX[s]) * ZOOM;
      F[LVY] = (c.y - this.lastY[s]) * ZOOM;
      this.leadStep[0] = leadX - this.leadRoad[0];
      this.leadStep[1] = leadY - this.leadRoad[1];
      this.leadShift[0] = leadX - ox - this.leadAt[0];
      this.leadShift[1] = leadY - oy - this.leadAt[1];
      this.leadRoad[0] = leadX;
      this.leadRoad[1] = leadY;
      this.leadAt[0] = leadX - ox;
      this.leadAt[1] = leadY - oy;
    }
    let flying = 0;
    this.boosting = this.drafting = 0;
    for (let i = 0; i < n; i++) {
      this.note(cars[i], i, ox, oy);
      if (kind[i] === AIR) {
        // Lowest first: a higher car is drawn over a lower one.
        let j = flying++;
        while (j > 0 && ups[order[j - 1]] > ups[i]) {
          order[j] = order[j - 1];
          j--;
        }
        order[j] = i;
      }
    }
    if (this.dustLive) this.dustStep();

    // Mines lie on the road, under everything.
    const fxSheet = sheets.fx;
    const mines = fx.mines;
    const lit = Math.floor(now / 250) % 2 === 0;
    const slow = Math.floor(now / BLINK_SLOW) % 2 === 0, fast = Math.floor(now / BLINK_FAST) % 2 === 0;
    for (let i = 0; i < mines.length; i++) {
      const m: MineView = mines[i];
      const out = m.out;
      if (out !== undefined && !(out > MINE_BLINK_FAST_TICKS ? slow : fast)) continue; // blinking out: not shown this frame
      const x = Math.round(m.x * ZOOM) - ox, y = Math.round(m.y * ZOOM) - oy;
      if (x < -SMALL || y < -SMALL || x > VIEW_W + SMALL || y > VIEW_H + SMALL) continue;
      const c = FX_MINE + (m.armed ? (lit ? 0 : 1) : 2);
      ctx.drawImage(fxSheet, (c % FX_COLS) * CELL + INSET, ((c / FX_COLS) | 0) * CELL + INSET, SMALL, SMALL, x - SMALL / 2, y - SMALL / 2, SMALL, SMALL);
    }
    // The lightning cells on the ground lie there too.
    const cells = fx.cells;
    if (cells) this.cells(cells, fx.nCells ?? cells.length, ox, oy, 0);
    // What moves on the road, at the frame's race tick (a whole number of ticks): a belt's
    // arrows, a press's shadow, the barrels.
    const rt = fx.rt;
    const tick = rt === undefined ? -1 : Math.floor(rt) | 0;
    if (rt !== undefined) this.moving.under(tick, ox, oy);
    // Falling cars sink below the road (drawn first, no shadow); airborne cars fly above
    // everything (drawn last, lowest first) and their shadows do land on other cars.
    for (let i = 0; i < n; i++) if (kind[i] === FALLING) this.car(cars[i], i);
    // Grounded cars: shadows first so no car's shadow lands on another car.
    ctx.globalAlpha = SHADOW_ALPHA;
    for (let i = 0; i < n; i++) if (kind[i] === GROUND) this.shadow(i);
    ctx.globalAlpha = 1;
    if (this.dustLive) this.dustDraw(ox, oy);
    // The air past a car in a slipstream and the flames of a boosting one: under every car on the ground.
    if (this.drafting) this.streaks(cars, n);
    if (this.boosting) for (let i = 0; i < n; i++) if (kind[i] === GROUND) this.flames(cars[i], i);
    for (let i = 0; i < n; i++) if (kind[i] === GROUND) this.car(cars[i], i);
    for (let i = 0; i < n; i++) if (cars[i].wreck) this.smoke(cars[i], ox, oy);
    // A press that is down: over the cars on the ground (those in the air are drawn after it).
    if (rt !== undefined) this.moving.over(tick, ox, oy);
    this.shots(fx, ox, oy);
    // The marks were cleared since the frame before: the blasts remembered are forgotten, and
    // those of the race before, still burning or about to be shown, will leave nothing (QUIET).
    const cleared = marksCleared();
    if (cleared !== this.cleared) {
      if (this.cleared >= 0) {
        this.blastX.fill(NaN);
        this.blastY.fill(NaN);
        this.quiet[0] = now + QUIET;
      }
      this.cleared = cleared;
    }
    // Hit sparks and mine blasts: a strip each, the frame picked by the age.
    const sparks = fx.sparks;
    const count = fx.nSparks ?? sparks.length;
    for (let i = 0; i < count; i++) {
      const s = sparks[i];
      if (s.blast) this.scorched(s);
      const x = Math.round(s.x * ZOOM) - ox, y = Math.round(s.y * ZOOM) - oy;
      if (x < -HALF || y < -HALF || x > VIEW_W + HALF || y > VIEW_H + HALF) continue;
      const age = s.age < 0 ? 0 : s.age;
      let c: number;
      if (s.blast) {
        const f = (age * BLAST_FRAMES) | 0;
        c = FX_BLAST + (f < BLAST_FRAMES ? f : BLAST_FRAMES - 1);
      } else {
        const f = (age * SPARK_FRAMES) | 0;
        // Which of the four turns of the rays: by where the spark is, so it keeps it for life.
        const turn = ((s.x * 0.37 + s.y * 0.11) | 0) & (SPARK_KINDS - 1);
        c = FX_SPARK + turn * SPARK_FRAMES + (f < SPARK_FRAMES ? f : SPARK_FRAMES - 1);
      }
      ctx.drawImage(fxSheet, (c % FX_COLS) * CELL, ((c / FX_COLS) | 0) * CELL, CELL, CELL, x - HALF, y - HALF, CELL, CELL);
    }
    // The floating cells: over the cars on the ground, their shadows on them; under the cars in the air.
    if (cells) this.cells(cells, fx.nCells ?? cells.length, ox, oy, 1);
    for (let j = 0; j < flying; j++) {
      const i = order[j];
      ctx.globalAlpha = SHADOW_ALPHA * (1 - 0.4 * ups[i]);
      this.shadow(i);
    }
    ctx.globalAlpha = 1;
    if (cells) this.cells(cells, fx.nCells ?? cells.length, ox, oy, 2);
    for (let j = 0; j < flying; j++) {
      if (this.boosting) this.flames(cars[order[j]], order[j]);
      this.car(cars[order[j]], order[j]);
    }
    F[OWN] = NaN; // told for this frame only
    snaps = null;
  }

  /** A mine blast, in view or not: the first time it is seen it leaves its scorch on the track. */
  private scorched(s: { x: number; y: number }): void {
    if (F[NOW] < this.quiet[0]) return; // a blast of the race before
    const bx = this.blastX, by = this.blastY;
    for (let k = 0; k < BLASTS; k++) if (bx[k] === s.x && by[k] === s.y) return;
    const k = this.blastNext;
    this.blastNext = (k + 1) % BLASTS;
    bx[k] = s.x;
    by[k] = s.y;
    MARK[0] = s.x;
    MARK[1] = s.y;
    scorch(this.track);
  }

  /**
   * How far car i of the frame just drawn sits from where its own rounding would put it, in
   * whole view pixels on axis k (0 = x, 1 = y): for what is drawn by the car's true place
   * and must stay with its sprite (the name tag).
   */
  off(i: number, k: number): number {
    return i < MAX_CARS ? this.shift[i * 2 + k] : 0;
  }

  /** The slot a car is remembered in; a car not seen before takes the one unused for longest. */
  private slot(id: string): number {
    const ids = this.ids, seen = this.seen;
    for (let s = 0; s < SLOTS; s++) if (ids[s] === id) return s;
    let s = 0;
    for (let k = 1; k < SLOTS; k++) if (seen[k] < seen[s]) s = k;
    ids[s] = id;
    seen[s] = 0;
    this.lastCell[s] = -1;
    this.seg[s] = -1;
    this.owed[s] = 0;
    this.skidAt[s] = 0;
    this.snapAt[s] = 0;
    this.rides[s * 2] = this.rides[s * 2 + 1] = 0;
    return s;
  }

  /** A car's state for this frame (its cell, its place on screen, where it is drawn in the order), and the dust it throws up. */
  private note(c: CarView, i: number, ox: number, oy: number): void {
    const dt = F[DT];
    const s = this.slot(c.id);
    const known = this.seen[s] === this.frameNo - 1; // drawn in the frame before: the way it came is known
    // Its place on screen. On the road's pixels; the followed car where the Renderer has it;
    // a car beside a followed car per axis as place() says, when both were there the frame
    // before and it was driven here, not put.
    const px = c.x * ZOOM, py = c.y * ZOOM;
    const wx = c.x - this.lastX[s], wy = c.y - this.lastY[s];
    let x = Math.round(px) - ox, y = Math.round(py) - oy;
    if (i === this.lead) {
      x = this.leadAt[0];
      y = this.leadAt[1];
      this.rides[s * 2] = this.rides[s * 2 + 1] = 0;
    } else if (this.led && known && wx * wx + wy * wy < JUMP * JUMP) {
      F[PG] = wx * ZOOM;
      F[PD] = px - F[LX];
      x = this.place(s * 2, 0, x);
      F[PG] = wy * ZOOM;
      F[PD] = py - F[LY];
      y = this.place(s * 2 + 1, 1, y);
    } else this.rides[s * 2] = this.rides[s * 2 + 1] = 0;
    this.sx[i] = x;
    this.sy[i] = y;
    this.shift[i * 2] = Math.round(px) - ox - x;
    this.shift[i * 2 + 1] = Math.round(py) - oy - y;
    // 0..1 of the fall elapsed (-1 = not falling) and 0..1 height in the air (0 = on the
    // ground), kept for the rest of the frame.
    const f = c.falling, h = c.height;
    const fall = f !== undefined && f > 0 ? (f < 1 ? f : 1) : -1;
    const up = h !== undefined && h > 0 ? (h < 1 ? h : 1) : 0;
    const kind = fall >= 0 ? FALLING : up > 0 ? AIR : GROUND;
    this.kind[i] = kind;
    this.look[i] = lookOf(c.car);
    this.up[i] = up;
    this.fall[i] = fall;
    // Absent, 0 and NaN all count as none.
    if (c.boost! > 0 && kind !== FALLING && !c.wreck) this.boosting++;
    if (c.draft! > 0 && kind === GROUND && !c.wreck) this.drafting++;
    // The cell: a falling car tumbles; the own car follows its heading; another player's
    // car keeps the cell it has until its heading is clearly in the next one.
    const turn = (kind === FALLING ? c.h + fall * 1.1 : c.h) / HEADING_STEP; // the heading in steps
    const had = this.lastCell[s];
    let cell = had;
    let d = turn - had;
    d -= Math.round(d / HEADINGS) * HEADINGS;
    if (kind === FALLING || c.me || had < 0 || d > 0.5 + HYSTERESIS || d < -0.5 - HYSTERESIS) {
      cell = Math.round(turn) % HEADINGS | 0;
      if (cell < 0) cell += HEADINGS;
    }
    this.cell[i] = cell;
    if (kind !== FALLING) this.lastCell[s] = cell;

    // Another player's car where the snapshots have it, if told (driving): its step sideways
    // there since the frame before (NaN = not told; none on the first frame it is told of).
    let driven = NaN;
    if (!c.me && snaps) {
      for (let k = 0; k < snaps.length; k++) {
        const t = snaps[k];
        if (t.id !== c.id) continue;
        driven = this.snapAt[s] === this.frameNo - 1 ? (t.y - this.snapY[s]) * Math.cos(t.h) - (t.x - this.snapX[s]) * Math.sin(t.h) : 0;
        this.snapX[s] = t.x;
        this.snapY[s] = t.y;
        this.snapAt[s] = this.frameNo;
        break;
      }
    }

    // Dust. Only for a car that was drawn in the frame before: its speed is the way it came.
    this.seen[s] = this.frameNo;
    if (known && dt > 0 && kind === GROUND && !c.wreck) {
      const mx = c.x - this.lastX[s], my = c.y - this.lastY[s];
      const moved = Math.sqrt(mx * mx + my * my);
      if (moved < JUMP) {
        if (this.lastUp[s] > 0) this.landing(c);
        // Tyre marks. It cannot slide sideways faster than it moves: most frames stop at the first test.
        if (moved > SKID * dt) {
          const cos = Math.cos(c.h), sin = Math.sin(c.h);
          // This frame's step sideways: on screen, or where the snapshots have the car.
          const side = driven === driven ? driven : my * cos - mx * sin;
          // The own car as told: not in a correction, not touching, and only if the predicted car slides.
          const own = F[OWN];
          const mine = !c.me || own !== own || (F[LEFT] <= CORRECTING && (own >= SLIDES || own <= -SLIDES) && F[NOW] - F[TOUCH] > TOUCHING);
          if (mine && (side > SKID * dt || side < -SKID * dt)) {
            const w = this.wheels, j = s * 4;
            const lx = c.x - cos * AXLE + sin * WHEEL, ly = c.y - sin * AXLE - cos * WHEEL;
            const rx = c.x - cos * AXLE - sin * WHEEL, ry = c.y - sin * AXLE + cos * WHEEL;
            const since = this.skidAt[s] > 0 ? this.frameNo - this.skidAt[s] : SKID_GAP + 1;
            if (since >= SKID_EVERY || since > SKID_GAP) {
              if (since <= SKID_GAP) {
                MARK[0] = w[j];
                MARK[1] = w[j + 1];
                MARK[2] = lx;
                MARK[3] = ly;
                MARK[4] = w[j + 2];
                MARK[5] = w[j + 3];
                MARK[6] = rx;
                MARK[7] = ry;
                skid(this.track);
              }
              // Else the slide begins here: the next stamp draws from these.
              w[j] = lx;
              w[j + 1] = ly;
              w[j + 2] = rx;
              w[j + 3] = ry;
              this.skidAt[s] = this.frameNo;
            }
          }
        }
        if (moved > DUST_MIN_SPEED * dt) {
          const track = this.track;
          F[QX] = c.x;
          F[QY] = c.y;
          let seg = this.seg[s] < 0 ? nearTrack(track, 0, track.pts.length) : nearTrack(track, this.seg[s] - 6, 13);
          // Not where it was (put back on the track elsewhere): look everywhere, once.
          if (F[QDIST] > track.wall + 30) seg = nearTrack(track, 0, track.pts.length);
          this.seg[s] = seg;
          if (this.wide) widened(track, seg); // a widened road: the distance from where its edge would be without the widening
          if (F[QDIST] > track.def.halfWidth + 2 && F[QDIST] < track.wall + 30) {
            this.owed[s] += moved;
            if (this.owed[s] >= DUST_EVERY) {
              this.owed[s] = 0;
              // From a rear wheel, the two taking turns; it drifts a little with the car, then hangs.
              const r = this.random() / RANDOM;
              const side = this.dustNext & 1 ? 6 : -6;
              const cos = Math.cos(c.h), sin = Math.sin(c.h);
              const k = this.dustNext;
              this.dustNext = (k + 1) % DUST;
              this.dustX[k] = c.x - cos * 10 - sin * side;
              this.dustY[k] = c.y - sin * 10 + cos * side;
              this.dustVx[k] = (mx / dt) * 0.12 + (r - 0.5) * 26;
              this.dustVy[k] = (my / dt) * 0.12 + (this.random() / RANDOM - 0.5) * 26 - 8;
              this.dustLife[k] = DUST_LIFE * (0.7 + 0.3 * r);
              this.dustLive = DUST;
            }
          }
        }
      }
    }
    this.lastX[s] = c.x;
    this.lastY[s] = c.y;
    this.lastUp[s] = kind === AIR ? up : 0;
  }

  /**
   * One axis (k: 0 = x, 1 = y) of the place on screen of a car that is not the one the view
   * follows: `at` on the road's pixels, or a whole number of pixels from the followed car
   * while it moves with it on this axis. j = its slot * 2 + k; its step over the ground and
   * its true place from the followed car come in F[PG] and F[PD].
   */
  private place(j: number, k: number, at: number): number {
    const g = F[PG], r = g - F[LVX + k]; // its step over the ground, and against the followed car
    const gg = g * g, rr = r * r;
    const lead = this.leadAt[k];
    if (!this.rides[j]) {
      if (!(gg > RIDE_MIN && rr < RIDE_IN * gg)) return at;
      // It starts where it is drawn now: no step at the change.
      this.rides[j] = 1;
      this.rel[j] = at - lead;
    }
    let rel = this.rel[j];
    const off = F[PD] - rel;
    const far = off > RIDE_MAX || off < -RIDE_MAX;
    // Back onto the road's pixels: at a moment the two places agree, so it does not step.
    if ((rr > gg || gg < RIDE_MIN / 4) && (lead + rel === at || far)) {
      this.rides[j] = 0;
      return at;
    }
    const step = this.leadStep[k], shift = this.leadShift[k];
    if ((shift === 1 || shift === -1) && off * shift < -RIDE_EARLY && (step - shift) * g >= 0) {
      // The followed car moved a pixel on screen, and this car was on its way to the next
      // pixel the other way: it takes that step now and so stays where it is on screen
      // (later it would go a pixel forth with the followed car and then a pixel back).
      this.rel[j] = rel -= shift;
    } else if (off > 0.5 + RIDE_SLACK || off < -0.5 - RIDE_SLACK) {
      // On the road it then steps by the followed car's step and this change together: not
      // back against its own way, unless it has fallen too far off.
      const next = Math.round(F[PD]);
      if ((step + next - rel) * g >= 0 || far) this.rel[j] = rel = next;
    }
    return lead + rel;
  }

  /** A landing: a ring of specks thrown outward. */
  private landing(c: CarView): void {
    for (let j = 0; j < PUFF; j++) {
      const a = (j / PUFF) * Math.PI * 2 + (this.random() / RANDOM) * 0.5;
      const v = 55 + (this.random() / RANDOM) * 45;
      const k = this.dustNext;
      this.dustNext = (k + 1) % DUST;
      this.dustX[k] = c.x + Math.cos(a) * 9;
      this.dustY[k] = c.y + Math.sin(a) * 7;
      this.dustVx[k] = Math.cos(a) * v;
      this.dustVy[k] = Math.sin(a) * v * 0.8;
      this.dustLife[k] = PUFF_LIFE;
    }
    this.dustLive = DUST;
  }

  /** A whole number under RANDOM, seeded per Renderer: the same frames give the same dust. */
  private random(): number {
    const rng = this.rng;
    let r = rng[0];
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    rng[0] = r;
    return rng[0] >>> 16;
  }

  private dustStep(): void {
    const dt = F[DT];
    const life = this.dustLife;
    const slow = 1 - 5 * dt;
    let live = 0;
    for (let k = 0; k < DUST; k++) {
      if (life[k] <= 0) continue;
      const left = life[k] - dt;
      life[k] = left > 0 ? left : 0;
      this.dustX[k] += this.dustVx[k] * dt;
      this.dustY[k] += this.dustVy[k] * dt;
      this.dustVx[k] *= slow;
      this.dustVy[k] *= slow;
      live++;
    }
    this.dustLive = live;
  }

  private dustDraw(ox: number, oy: number): void {
    const ctx = this.ctx, life = this.dustLife;
    // Young specks in the lighter tone, old ones a step down: two passes, two fill styles.
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass ? P.bone0 : P.bone1;
      for (let k = 0; k < DUST; k++) {
        const left = life[k];
        if (left <= 0 || (pass ? left > DUST_FADE : left <= DUST_FADE)) continue;
        ctx.fillRect(Math.round(this.dustX[k] * ZOOM) - ox - 1, Math.round(this.dustY[k] * ZOOM) - oy - 1, 2, 2);
      }
    }
  }

  /**
   * A car's shadow: its silhouette, down-right; further away the higher the car is. A whole
   * offset from the car's own place on screen, so it never slides against the car. The caller
   * sets the alpha.
   */
  private shadow(i: number): void {
    const up = this.up[i];
    const x = this.sx[i] + Math.round((3 + up * AIR_SHADOW_X) * ZOOM), y = this.sy[i] + Math.round((4 + up * AIR_SHADOW_Y) * ZOOM);
    if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) return;
    const k = this.cell[i];
    this.ctx.drawImage(shadeSheet(this.look[i]), (k & 15) * CELL, (k >> 4) * CELL, CELL, CELL, x - HALF, y - HALF, CELL, CELL);
  }

  private car(c: CarView, i: number): void {
    const x = this.sx[i], y = this.sy[i];
    if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) return;
    const ctx = this.ctx;
    const k = this.cell[i], look = this.look[i];
    const sx = (k & 15) * CELL, sy = (k >> 4) * CELL;
    const fall = this.fall[i];
    // The ghost and fall blinks: the same on/off frames and alpha as ever.
    let alpha = 1;
    if (c.ghost) alpha = Math.floor(F[NOW] / 110) % 2 ? 0.35 : 0.75;
    if (fall >= 0 && Math.floor(fall * FALL_BLINKS * 2) % 2) alpha *= 0.3;
    // The size on screen: whole pixels, the car's middle kept in place.
    let size = CELL;
    if (fall >= 0) {
      // Shrinks fast at first (dropping away), tumbling slowly (the cell turns with it).
      size = Math.round(CELL * (1 - (1 - FALL_SCALE) * (1 - (1 - fall) * (1 - fall))));
    } else {
      const up = this.up[i];
      if (up > 0) size = Math.round(CELL * (1 + up * AIR_SCALE));
    }
    const dx = x - (size >> 1), dy = y - (size >> 1);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    const state = c.wreck ? BURNT : c.hp !== undefined && c.hp < BATTERED ? DENTED : WHOLE;
    ctx.drawImage(carSheet(c.color, look, state), sx, sy, CELL, CELL, dx, dy, size, size);
    if (fall >= 0) {
      ctx.globalAlpha = alpha * 0.7 * fall; // into the dark
      ctx.drawImage(shadeSheet(look), sx, sy, CELL, CELL, dx, dy, size, size);
      ctx.globalAlpha = 1;
    } else if (alpha !== 1) ctx.globalAlpha = 1;
  }

  /**
   * The lightning cells. `layer` 0: the ones on the ground; 1: the floating ones' shadows;
   * 2: the floating ones themselves. `count`: how many of `cells` count.
   */
  private cells(cells: NonNullable<WorldFx["cells"]>, count: number, ox: number, oy: number, layer: number): void {
    const n = count < cells.length ? count : cells.length;
    if (!n) return;
    const ctx = this.ctx, sheet = catchSheet();
    const now = F[NOW];
    const frame = (now / CELL_FRAME) | 0, bob = (now / BOB_STEP) | 0;
    const lit = ((now / CELL_BLINK) | 0) & 1;
    // A floating cell's shadow: as a car's that high.
    const awayX = Math.round((3 + AIR_UP * AIR_SHADOW_X) * ZOOM), awayY = Math.round((4 + AIR_UP * AIR_SHADOW_Y) * ZOOM);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (c.air !== layer > 0) continue;
      let x = Math.round(c.x * ZOOM) - ox, y = Math.round(c.y * ZOOM) - oy;
      if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) continue;
      // Its own turn in the crackle and in the bob, by where it is.
      const turn = (c.x * 0.37 + c.y * 0.11) | 0;
      const state = c.state;
      const taken = state > 0;
      let pic: number;
      if (layer === 0) pic = taken ? CX_GONE + (state < CELL_RETURNING ? lit : 0) : CX_GROUND + ((frame + turn) & (CELL_FRAMES - 1));
      else {
        const rise = taken ? 0 : BOB[(bob + turn) & 15];
        if (layer === 1) {
          pic = taken ? CX_SHADE + 2 : CX_SHADE + (rise < 0 ? 1 : 0);
          x += awayX;
          y += awayY;
        } else {
          pic = taken ? CX_AIR_GONE + (state < CELL_RETURNING ? lit : 0) : CX_AIR + ((frame + turn) & (CELL_FRAMES - 1));
          y += rise;
        }
      }
      ctx.drawImage(sheet, pic * CELL, 0, CELL, CELL, x - HALF, y - HALF, CELL, CELL);
    }
  }

  /** The flames at the tail of a boosting car, drawn before the car itself: they come out from under it. */
  private flames(c: CarView, i: number): void {
    const boost = c.boost;
    if (boost === undefined || !(boost > 0) || c.wreck || this.kind[i] === FALLING) return;
    const x = this.sx[i], y = this.sy[i];
    if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) return;
    const ctx = this.ctx, sheet = catchSheet();
    // The flame's heading: the car's cell, to the nearer of the flame's (every second one).
    const f = ((this.cell[i] + 1) >> 1) & (FLAME_HEADINGS - 1);
    const frame = boost <= FLAME_ENDS ? FLAME_LOW : (((F[NOW] / FLAME_STEP) | 0) + i * 2) % FLAME_FRAMES;
    const pic = frame * FLAME_HEADINGS + f;
    const px = (pic % FLAME_COLS) * FLAME, py = CELL + ((pic / FLAME_COLS) | 0) * FLAME;
    let ax = FLAME_AT[f * 2], ay = FLAME_AT[f * 2 + 1];
    let sx = this.look[i] === RACER ? 0 : PIPE_AT[f * 2], sy = this.look[i] === RACER ? 0 : PIPE_AT[f * 2 + 1];
    let size = FLAME;
    const up = this.up[i];
    if (up > 0) {
      // In the air the car is drawn bigger: its flames with it.
      const grown = Math.round(CELL * (1 + up * AIR_SCALE));
      size = (FLAME * grown) >> 5; // CELL is 32
      ax = Math.round((ax * grown) / CELL) | 0;
      ay = Math.round((ay * grown) / CELL) | 0;
      sx = Math.round((sx * grown) / CELL) | 0;
      sy = Math.round((sy * grown) / CELL) | 0;
    }
    const dx = x + ax - (size >> 1), dy = y + ay - (size >> 1);
    if (sx === 0 && sy === 0) ctx.drawImage(sheet, px, py, FLAME, FLAME, dx, dy, size, size);
    else {
      ctx.drawImage(sheet, px, py, FLAME, FLAME, dx + sx, dy + sy, size, size);
      ctx.drawImage(sheet, px, py, FLAME, FLAME, dx - sx, dy - sy, size, size);
    }
  }

  /** The air running past the cars that are in a slipstream: the streaks tone by tone, the dim ones first. */
  private streaks(cars: readonly CarView[], n: number): void {
    const ctx = this.ctx;
    const t = F[NOW] / STREAK_MS;
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = pass === 0 ? P.steel2 : pass === 1 ? P.steel3 : P.bone2;
      for (let i = 0; i < n; i++) {
        const c = cars[i];
        const draft = c.draft;
        if (draft === undefined || !(draft > 0) || this.kind[i] !== GROUND || c.wreck) continue;
        const x = this.sx[i], y = this.sy[i];
        if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) continue;
        const d = draft < 1 ? draft : 1;
        const count = STREAKS_MIN + Math.round(d * (STREAKS - STREAKS_MIN));
        const len = STREAK_MIN + Math.round(d * (STREAK_MAX - STREAK_MIN));
        const tone = d >= STREAK_BRIGHT ? 2 : 1;
        const cos = COS[this.cell[i]], sin = SIN[this.cell[i]];
        // The line's pixels: a step of one along x or along y, whichever the heading is nearer to.
        const flat = (cos < 0 ? -cos : cos) >= (sin < 0 ? -sin : sin);
        const steps = Math.round(len * (flat ? (cos < 0 ? -cos : cos) : sin < 0 ? -sin : sin));
        const slope = flat ? sin / cos : cos / sin; // what the other axis moves in a step
        for (let j = 0; j < count; j++) {
          // How far along its run the streak is, 0..1: each streak and each car at its own moment.
          let p = t + j * 0.618 + i * 0.37;
          p -= Math.floor(p);
          if ((p > 0.14 && p < 0.82 ? tone : 0) !== pass) continue;
          // Its middle, from the car's middle: along the heading (u) and across it (v).
          const u = STREAK_FROM - p * STREAK_RUN;
          const v = (j & 1 ? 1 : -1) * (STREAK_LANE + (j >> 1) * STREAK_LANES) * (1 - STREAK_IN * p);
          const mx = x + u * cos - v * sin, my = y + u * sin + v * cos;
          // From its low end up the stepping axis; pixels that share a row (a column) are one rectangle.
          const a0 = Math.round((flat ? mx : my) - steps / 2) | 0;
          const b0 = (flat ? my : mx) - (((flat ? mx : my) - a0) * slope);
          let from = a0, at = Math.round(b0) | 0;
          for (let k = 1; k <= steps; k++) {
            const b = k < steps ? Math.round(b0 + k * slope) | 0 : at + 1; // the end closes the last run
            if (b === at) continue;
            if (flat) ctx.fillRect(from, at, a0 + k - from, 1);
            else ctx.fillRect(at, from, 1, a0 + k - from);
            from = a0 + k;
            at = b;
          }
        }
      }
    }
  }

  /** A wreck's smoke: four puffs rising and drifting as before, each one of three sprites by its age. */
  private smoke(c: CarView, ox: number, oy: number): void {
    const ctx = this.ctx, sheet = this.sheets!.fx;
    const t = F[NOW] / 1000;
    for (let i = 0; i < 4; i++) {
      const phase = (t * 0.9 + i / 4) % 1;
      const x = Math.round((c.x + Math.sin(i * 2.3 + t) * 4 + phase * 10) * ZOOM) - ox, y = Math.round((c.y - 4 - phase * 22) * ZOOM) - oy;
      if (x < -SMALL || y < -SMALL || x > VIEW_W + SMALL || y > VIEW_H + SMALL) continue;
      const cell = FX_PUFF + (phase < 1 / 3 ? 0 : phase < 2 / 3 ? 1 : 2);
      ctx.drawImage(sheet, (cell % FX_COLS) * CELL + INSET, ((cell / FX_COLS) | 0) * CELL + INSET, SMALL, SMALL, x - SMALL / 2, y - SMALL / 2, SMALL, SMALL);
    }
  }

  /** Rivets: a hard 3 px head and two dimmer pixels trailing it along its flight. */
  private shots(fx: WorldFx, ox: number, oy: number): void {
    const ctx = this.ctx, shots = fx.shots;
    const count = fx.nShots ?? shots.length;
    if (!count) return;
    // The trail first, so a head is never under another rivet's trail: three passes, three fill styles.
    for (let pass = 0; pass < 3; pass++) {
      ctx.fillStyle = pass === 0 ? P.rust3 : pass === 1 ? P.haz1 : P.haz2;
      for (let i = 0; i < count; i++) {
        const s = shots[i];
        const x = Math.round(s.x * ZOOM) - ox, y = Math.round(s.y * ZOOM) - oy;
        if (x < -8 || y < -8 || x > VIEW_W + 8 || y > VIEW_H + 8) continue;
        if (pass === 2) ctx.fillRect(x - 1, y - 1, 3, 3);
        else {
          const back = (pass ? 3 : 5) / (Math.sqrt(s.vx * s.vx + s.vy * s.vy) || 1);
          ctx.fillRect(Math.round(x - s.vx * back) | 0, Math.round(y - s.vy * back) | 0, 1, 1); // | 0: never a -0
        }
      }
    }
  }
}

const SPARK_MS = 260; // a hit spark's life
const BLAST_MS = (BLAST_FRAMES * 1000) / 60; // a mine blast's: its eight frames, one a display frame
const SPARKS = 32; // sparks and blasts under way at once

/**
 * The effects of a running game, frame by frame (main.ts): one WorldFx whose arrays are kept
 * from frame to frame, and the hit sparks and mine blasts under way in a fixed pool. A frame
 * allocates nothing here.
 */
export class Effects {
  private readonly fx: WorldFx = { shots: [], mines: [], sparks: [], nShots: 0, nSparks: 0 };
  private readonly live = new Uint8Array(SPARKS);
  private readonly blast = new Uint8Array(SPARKS);
  private readonly placed = new Uint8Array(SPARKS); // its place is known
  private readonly ids: string[] = new Array<string>(SPARKS).fill("");
  private readonly start = new Float64Array(SPARKS);
  private readonly x = new Float64Array(SPARKS);
  private readonly y = new Float64Array(SPARKS);
  private next = 0;

  constructor() {
    for (let i = 0; i < SPARKS; i++) this.fx.sparks.push({ x: 0, y: 0, age: 0, blast: false });
  }

  /**
   * A hit spark, or a mine's blast, from `start` (ms) on. On the car `id`: it is placed where
   * that car is drawn once it starts (a hit on another player's car waits out the
   * interpolation delay, to line up with the hit one sees). With id "": at (x, y).
   * With the pool full the oldest gives way.
   */
  spark(id: string, start: number, blast: boolean, x = 0, y = 0): void {
    const i = this.next;
    this.next = (i + 1) % SPARKS;
    this.live[i] = 1;
    this.blast[i] = blast ? 1 : 0;
    this.placed[i] = id === "" ? 1 : 0;
    this.ids[i] = id;
    this.start[i] = start;
    this.x[i] = x;
    this.y[i] = y;
  }

  /**
   * This frame's effects: other players' rivets, then our own; the mines; the sparks and
   * blasts that have started. `own` and `others` are the poses the cars are drawn at
   * (`you` = the own car's id).
   */
  frame(
    now: number,
    theirs: WorldFx["shots"],
    ours: WorldFx["shots"],
    mines: WorldFx["mines"],
    you: string,
    own: DrawPose | null,
    others: readonly DrawPose[],
  ): WorldFx {
    const fx = this.fx, shots = fx.shots;
    // The list only ever grows: its entries past nShots are left over from an earlier frame.
    let n = 0;
    for (let i = 0; i < theirs.length; i++, n++) {
      if (n < shots.length) shots[n] = theirs[i];
      else shots.push(theirs[i]);
    }
    for (let i = 0; i < ours.length; i++, n++) {
      if (n < shots.length) shots[n] = ours[i];
      else shots.push(ours[i]);
    }
    fx.nShots = n;
    fx.mines = mines;
    let shown = 0;
    for (let i = 0; i < SPARKS; i++) {
      if (!this.live[i]) continue;
      const life = this.blast[i] ? BLAST_MS : SPARK_MS;
      const age = (now - this.start[i]) / life;
      if (age >= 1) {
        this.live[i] = 0;
        this.ids[i] = "";
        continue;
      }
      if (age < 0) continue;
      if (!this.placed[i]) {
        // Hit sparks stay at the interpolation time (also on near cars drawn predicted).
        const id = this.ids[i];
        let pose: DrawPose | null = null;
        if (id === you) pose = own;
        else for (let k = 0; k < others.length && !pose; k++) if (others[k].id === id) pose = others[k];
        if (!pose) continue;
        this.x[i] = pose.x;
        this.y[i] = pose.y;
        this.placed[i] = 1;
      }
      const out = fx.sparks[shown++];
      out.x = this.x[i];
      out.y = this.y[i];
      out.age = age;
      out.blast = this.blast[i] === 1;
    }
    fx.nSparks = shown;
    return fx;
  }
}
