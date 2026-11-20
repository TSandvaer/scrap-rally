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
// - Battered (hp under BATTERED) and wrecked cars get one more sheet on top; the shadow is the
//   car's silhouette in the same cell.
// - In the air a car grows to 1.35x, in a fall it shrinks to 0.3x: the same cell, blitted
//   scaled (nearest neighbour, whole pixels). Size steps baked ahead would be a sheet per
//   step and colour (0.5 MB each); the scaled blit costs no memory and happens for a car or
//   two at a time.

import type { Track } from "../../shared/track";
import type { CarView, DrawPose, WorldFx } from "../render";
import { P } from "./palette";
import { BLAST_FRAMES, carSheet, CELL, FX_BLAST, FX_COLS, FX_MINE, FX_PUFF, FX_SPARK, HEADING_STEP, HEADINGS, SHADOW_ALPHA, sharedSheets, SPARK_FRAMES, SPARK_KINDS, spriteFrame, spritesFor, type SharedSheets } from "./sprites";
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
// How fast a car slides is read off its steps on screen, but for the own car in a race: its
// steps on screen have the corrections in them. When a snapshot puts the predicted car
// elsewhere (a mine spun it round a moment ago, as the server knows and the prediction did
// not), the car is not put there at once but drawn sliding there over a few frames
// (client/game.ts, smooth). That is no slide of the car's, and on a slow link it is a long
// one. So main.ts tells how the predicted car itself slides (ownSlide); the marks still lie
// where its wheels are drawn. (tools/debug/skid-lag.ts counts the stamps on a slow link.)
const SKID = 105;
const SKID_EVERY = 2;
const SKID_GAP = 4; // frames without a slide after which the next mark starts afresh
const AXLE = 9; // the rear wheels: this far behind the car's middle (world units) ...
const WHEEL = 6; // ... and to either side of it
const BLASTS = 32; // mine blasts remembered as having left their scorch
// The marks are cleared at a new race and a restart (world.ts clearMarks); the blasts
// remembered go with them. A blast of the race before may still burn then, or still wait to
// be shown (main.ts holds a hit on another car back by the interpolation delay, 100 ms, and a
// blast burns for 133): for QUIET ms after the clearing a blast leaves no scorch and is not
// remembered. A new race's first blast is seconds away (the countdown).
const QUIET = 300;

// Numbers that are not whole go from one function here to the next through this array, not as
// arguments or results: handed over in a call they are boxed (16 bytes each, in Node).
const F = new Float64Array(12);
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
const OWN = 11; // the own car's speed sideways as told for this frame (ownSlide), units/s; NaN = not told
F[OWN] = NaN;

/**
 * The own car's slide, for its tyre marks: main.ts hands over the predicted car (client/game.ts)
 * before each frame, and how fast that slides sideways is its velocity across its heading. A
 * frame that was told nothing (null, or no call: the preview, a benchmark) reads the own
 * car's slide off its steps on screen, like any other car's.
 */
export function ownSlide(car: { vx: number; vy: number; h: number } | null): void {
  F[OWN] = car ? car.vy * Math.cos(car.h) - car.vx * Math.sin(car.h) : NaN;
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

export class Actors {
  private sheets: SharedSheets | null = null;
  private frameNo = 0;
  private readonly last = new Float64Array(1).fill(NaN); // the time of the frame before
  // This frame's cars, by their place in the list.
  private readonly cell = new Int16Array(MAX_CARS);
  private readonly kind = new Uint8Array(MAX_CARS);
  private readonly sx = new Int32Array(MAX_CARS); // the middle of its sprite on screen
  private readonly sy = new Int32Array(MAX_CARS);
  private readonly shift = new Int32Array(MAX_CARS * 2); // ... less that on the road's pixels, by its own rounding (x, y)
  private readonly up = new Float64Array(MAX_CARS); // 0..1 height in the air
  private readonly fall = new Float64Array(MAX_CARS); // 0..1 of the fall, -1 = not falling
  private readonly order = new Uint8Array(MAX_CARS); // the airborne ones, lowest first
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

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly track: Track,
  ) {
    spritesFor(ctx);
    this.rng[0] = 0x9e3779b9;
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
    for (let i = 0; i < mines.length; i++) {
      const m = mines[i];
      const x = Math.round(m.x * ZOOM) - ox, y = Math.round(m.y * ZOOM) - oy;
      if (x < -SMALL || y < -SMALL || x > VIEW_W + SMALL || y > VIEW_H + SMALL) continue;
      const c = FX_MINE + (m.armed ? (lit ? 0 : 1) : 2);
      ctx.drawImage(fxSheet, (c % FX_COLS) * CELL + INSET, ((c / FX_COLS) | 0) * CELL + INSET, SMALL, SMALL, x - SMALL / 2, y - SMALL / 2, SMALL, SMALL);
    }
    // Falling cars sink below the road (drawn first, no shadow); airborne cars fly above
    // everything (drawn last, lowest first) and their shadows do land on other cars.
    for (let i = 0; i < n; i++) if (kind[i] === FALLING) this.car(cars[i], i);
    // Grounded cars: shadows first so no car's shadow lands on another car.
    ctx.globalAlpha = SHADOW_ALPHA;
    for (let i = 0; i < n; i++) if (kind[i] === GROUND) this.shadow(i);
    ctx.globalAlpha = 1;
    if (this.dustLive) this.dustDraw(ox, oy);
    for (let i = 0; i < n; i++) if (kind[i] === GROUND) this.car(cars[i], i);
    for (let i = 0; i < n; i++) if (cars[i].wreck) this.smoke(cars[i], ox, oy);
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
    for (let j = 0; j < flying; j++) {
      const i = order[j];
      ctx.globalAlpha = SHADOW_ALPHA * (1 - 0.4 * ups[i]);
      this.shadow(i);
    }
    ctx.globalAlpha = 1;
    for (let j = 0; j < flying; j++) this.car(cars[order[j]], order[j]);
    F[OWN] = NaN; // told for this frame only
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
    this.up[i] = up;
    this.fall[i] = fall;
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
          // This frame's step sideways: on screen, or for the own car what it was told to be (ownSlide).
          const own = F[OWN];
          const side = c.me && own === own ? own * dt : my * cos - mx * sin;
          if (side > SKID * dt || side < -SKID * dt) {
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
    this.ctx.drawImage(this.sheets!.shade, (k & 15) * CELL, (k >> 4) * CELL, CELL, CELL, x - HALF, y - HALF, CELL, CELL);
  }

  private car(c: CarView, i: number): void {
    const x = this.sx[i], y = this.sy[i];
    if (x < -OFF || y < -OFF || x > VIEW_W + OFF || y > VIEW_H + OFF) return;
    const ctx = this.ctx, sheets = this.sheets!;
    const k = this.cell[i];
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
    ctx.drawImage(carSheet(c.color), sx, sy, CELL, CELL, dx, dy, size, size);
    if (c.wreck) ctx.drawImage(sheets.burnt, sx, sy, CELL, CELL, dx, dy, size, size);
    else if (c.hp !== undefined && c.hp < BATTERED) ctx.drawImage(sheets.dents, sx, sy, CELL, CELL, dx, dy, size, size);
    if (fall >= 0) {
      ctx.globalAlpha = alpha * 0.7 * fall; // into the dark
      ctx.drawImage(sheets.shade, sx, sy, CELL, CELL, dx, dy, size, size);
      ctx.globalAlpha = 1;
    } else if (alpha !== 1) ctx.globalAlpha = 1;
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
