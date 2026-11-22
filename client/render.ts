// Canvas 2D renderer at a fixed 640x360 internal resolution, scaled up pixelated by CSS.
// Scrapyard look: packed dirt, gravel verges, steel barriers, rust-and-bone kerbs, and
// piles of junk outside the walls. The drawing itself lives in client/gfx: world.ts (the
// static world), actors.ts (cars and effects), hud.ts (name tags, minimap, HUD panels).

import type { Track } from "../shared/track";
import { Actors } from "./gfx/actors";
import { Hud } from "./gfx/hud";
import { sceneryFor } from "./gfx/theme";
import { VIEW_H, VIEW_W, World, ZOOM } from "./gfx/world";

export { VIEW_H, VIEW_W };
const SHAKE_MS = 180;

// ---- Whole pixels: the view and the car it follows (Renderer.ahead) -----------------------
//
// Three whole-pixel values hang together on each axis while the camera follows a car: the
// car's pixel on the road, the view's scroll, and the car's pixel on screen, which is the
// first less the second. They cannot each be the rounding of its own true value: they would
// step at different moments, and the car would go a pixel forth and a pixel back on screen
// while it drives steadily. Instead each keeps its value from frame to frame and steps by
// these rules:
// - only toward its true value, and not past the middle beyond it: so it never has cause to
//   step back while its true value moves one way;
// - it may wait (be up to LAG behind) when the others cannot step with it this frame;
// - it does not step yet while its true value is within SLACK of the middle between two
//   pixels, unless the others need it to (timer noise in the camera's easing cannot then
//   flip the car between two pixels).
// Of the steps that fit together, the ones that leave the least to be wished for are taken.
// (tools/debug/jitter-trace.ts counts the steps back.)

/** A value steps once its true value is this far past the middle between two pixels ... */
const SLACK = 0.3;
/** ... and it may be left this far behind its true value. */
const LAG = 1.5;
/** What a step costs that is taken before that (in squared pixels of error, the measure of the rest). */
const UNDUE = 1;

// How far the true values are ahead of the whole-pixel ones (view pixels): [0] the car on the
// road, [1] the view, [2] the car on screen; [3] the bill. Kept in an array: numbers that are
// not whole are boxed when handed over in a call.
const AHEAD = new Float64Array(4);

/** May value i step by d whole pixels, by the rules above? */
function maySteps(i: number, d: number): boolean {
  const e = AHEAD[i];
  if (d === 0) return e <= LAG && e >= -LAG;
  const r = Math.round(e);
  return (d > 0 ? e > 0 && d <= r : e < 0 && d >= r) && e - d <= LAG && e - d >= -LAG;
}

/** Add to the bill (AHEAD[3]) what a step of d leaves to be wished for in value i. */
function bill(i: number, d: number): void {
  const e = AHEAD[i], left = e - d;
  AHEAD[3] += left * left + (d !== 0 && e <= 0.5 + SLACK && e >= -0.5 - SLACK ? UNDUE : 0);
}

export interface CarView {
  id: string;
  x: number;
  y: number;
  h: number;
  color: string;
  name: string;
  me: boolean;
  wreck: boolean;
  ghost: boolean;
  /** 0..1 height of an airborne car (shared/weapons.ts airHeight); absent or 0 = on the ground. */
  height?: number;
  /** 0..1 of the fall elapsed (FALL_TICKS); absent = not falling. */
  falling?: number;
  /** 0..1 of the car's full health; under 0.4 it is drawn battered. Absent = not known: drawn whole. */
  hp?: number;
  /** The car's look (gfx/sprites.ts LOOKS). Absent = the sport. */
  car?: "sport" | "racer" | "truck";
  /**
   * 0..1: how strong a slipstream the car is in (the follower's strength w, PLAN-M4 2.8).
   * Streaks of air run past it, more and longer the stronger. Absent or 0 = none.
   */
  draft?: number;
  /** Ticks of boost left (CarState.boost): flames at its tail, sputtering over the last few. Absent or 0 = none. */
  boost?: number;
}

/**
 * A lightning cell (PLAN-M4 2.5), as the frame's WorldFx hands it over.
 * - `air`: it floats (bobbing, its shadow away on the ground) and is taken in flight; else it
 *   lies on the ground.
 * - `state`: 0 = there to be taken. Above 0 = taken, and drawn as an outline: the share of its
 *   wait that is left, 1 (just taken) down toward 0 (back any moment; under CELL_RETURNING,
 *   gfx/actors.ts, the outline blinks). A caller that only knows "taken" passes 1.
 */
export interface CellView {
  x: number;
  y: number;
  air: boolean;
  state: number;
}

/**
 * A car pose as client/game.ts hands it out (ownPose, otherPoses), with the optional
 * airborne / fall / ghost state the renderer draws.
 */
export interface DrawPose {
  id: string;
  x: number;
  y: number;
  h: number;
  height?: number;
  falling?: number;
  ghost?: boolean;
}

export interface WorldFx {
  shots: { x: number; y: number; vx: number; vy: number }[];
  mines: { x: number; y: number; armed: boolean }[];
  sparks: { x: number; y: number; age: number; blast?: boolean }[]; // age 0..1; blast = a mine went off there, else a hit spark
  /** For a caller that keeps its arrays from frame to frame (main.ts): how many entries count. Absent = all of them. */
  nShots?: number;
  nSparks?: number;
  /**
   * The track's lightning cells, each in its state. The caller keeps the array and its entries
   * from frame to frame and changes them in place (no array a frame); `nCells` = how many
   * entries count (absent = all of them). Absent = no cells: nothing is drawn.
   */
  cells?: CellView[];
  nCells?: number;
  /**
   * The race tick the frame shows (M4-WORLD; PLAN-M4.md section 3, "Where moving things are
   * drawn"): the own car's predicted race tick, the one its step runs at (client/game.ts:
   * latest.rt + pending.length + 1, clamped at GO), so the own car's hits on what moves look
   * right; a spectator's is the latest snapshot's. What moves on the road is drawn where the
   * shared functions of the tick put it (shared/track.ts barrelLat, pressState): the barrels of
   * a row, a crusher press's warning shadow, its lamps and its slab, the arrows running on a
   * conveyor belt (gfx/obstacles.ts). A whole number of ticks; a fraction is rounded down.
   * Absent = none of them is drawn (their still parts, the barrels' lane, the press's bed and the
   * belt, are part of the baked world and always there). A track on which nothing moves (every
   * shipped one today) is the same picture with it and without.
   */
  rt?: number;
}

export interface HudView {
  topLeft: string[]; // lap / position lines
  time: string;
  notice: string; // small line under the race time (weapons-armed countdown)
  center: string; // big countdown / status text
  centerSub: string;
  banner: string; // persistent strip at the bottom (spectating, reconnecting, ...)
  corner: string; // bottom-left small text (RTT)
  debug: string[];
  hp: number | null; // own car health 0..1, null = no car
  // The catch-up cues, a small panel under the lap lines, shown while either is on (absent or
  // 0 = off; both off or absent = no panel, the HUD as it was):
  /** 0..1: the slipstream the own car is in (CarView.draft): DRAFT lit, a meter of its strength. */
  draft?: number;
  /** Ticks of boost the own car has left (CarView.boost): BOOST lit, the time left in seconds. */
  boost?: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly world: World;
  private readonly actors: Actors;
  private readonly hud: Hud;
  readonly cam = { x: 0, y: 0 };
  // Following a car (follow): its id ("" = none) and, per axis, as drawn in the frame before
  // (`led`: for which car): the view's middle and that car's pixel, both in whole view pixels
  // of the track's plane.
  private followed = "";
  private led = "";
  private readonly view = new Int32Array(2);
  private readonly carAt = new Int32Array(2);
  private shakeAmp = 0;
  private shakeStart = 0;

  constructor(canvas: HTMLCanvasElement, track: Track) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    // The track's theme (PLAN-THEMES.md), resolved here, once: its definition's, the scrapyard
    // when it names none or one whose art has not landed. The world's tiles, the dust and what
    // moves on the road are made with it; the cars, the effects and the HUD are every theme's.
    const scenery = sceneryFor(track);
    this.world = new World(this.ctx, track, scenery);
    this.actors = new Actors(this.ctx, track, scenery);
    this.hud = new Hud(this.ctx, track);
  }

  /**
   * Ease the camera toward a target (world coords). snap = jump straight there.
   * `car`: the id of the car the camera follows (the own car, or the leader a spectator
   * watches), "" when it follows none (a fixed view, the tour). View and car are then stepped
   * together in whole pixels (ahead), so the car does not move a pixel back and forth on
   * screen while it drives.
   */
  follow(x: number, y: number, dtMs: number, snap = false, car = ""): void {
    this.followed = car;
    this.world.aim(x, y, dtMs, snap);
    if (snap) {
      this.cam.x = x;
      this.cam.y = y;
      return;
    }
    const k = 1 - Math.exp(-dtMs / 90);
    this.cam.x += (x - this.cam.x) * k;
    this.cam.y += (y - this.cam.y) * k;
  }

  /** A short camera shake of up to amp view pixels (a stronger one replaces a weaker). */
  shake(amp: number): void {
    const now = performance.now();
    if (amp < this.shakeLeft(now)) return;
    this.shakeAmp = amp;
    this.shakeStart = now;
  }

  private shakeLeft(now: number): number {
    const t = (now - this.shakeStart) / SHAKE_MS;
    return t < 1 ? this.shakeAmp * (1 - t) : 0;
  }

  /**
   * One axis (k: 0 = x, 1 = y) of the view's middle while the camera follows `car`, in whole
   * view pixels; the car's pixel goes to carAt[k]. The two are stepped together by the rules
   * of "Whole pixels" at the top. `fresh`: followed from this frame on, nothing to step from.
   */
  private ahead(k: number, car: CarView, fresh: boolean): number {
    const at = k ? car.y : car.x, cam = k ? this.cam.y : this.cam.x; // world units
    if (fresh) {
      this.carAt[k] = Math.round(at * ZOOM);
      return (this.view[k] = Math.round(cam * ZOOM));
    }
    // How far the true values are ahead of the drawn ones: the car on the road, the view, the car on screen.
    AHEAD[0] = at * ZOOM - this.carAt[k];
    AHEAD[1] = cam * ZOOM - this.view[k];
    AHEAD[2] = AHEAD[0] - AHEAD[1];
    const r0 = Math.round(AHEAD[0]), v0 = Math.round(AHEAD[1]);
    let dCar = r0, dView = v0, least = Infinity;
    // Tried: the step each of the two asks for, or one less (it waits for the other).
    for (let i = 0; i < 4; i++) {
      const dc = i & 1 ? r0 - (r0 > 0 ? 1 : r0 < 0 ? -1 : 0) : r0, dv = i & 2 ? v0 - (v0 > 0 ? 1 : v0 < 0 ? -1 : 0) : v0;
      if (!maySteps(0, dc) || !maySteps(1, dv) || !maySteps(2, dc - dv)) continue;
      AHEAD[3] = 0;
      bill(0, dc);
      bill(1, dv);
      bill(2, dc - dv);
      if (AHEAD[3] < least) {
        least = AHEAD[3];
        dCar = dc;
        dView = dv;
      }
    }
    this.carAt[k] += dCar;
    return (this.view[k] += dView);
  }

  /** Draw one frame. `now` (ms) drives the camera shake and the car blinks. */
  frame(cars: CarView[], fx: WorldFx, hud: HudView | null, now = performance.now()): void {
    const ctx = this.ctx;
    const amp = this.shakeLeft(now) / ZOOM;
    const ph = (now - this.shakeStart) / 16;
    // The view's middle, in whole view pixels: the baked world is blitted 1:1.
    let lead = -1; // the car the camera follows, by its place in the list
    if (this.followed) for (let i = 0; i < cars.length && lead < 0; i++) if (cars[i].id === this.followed) lead = i;
    let vx: number, vy: number;
    if (lead < 0) {
      // The camera itself, rounded.
      this.led = "";
      vx = Math.round((this.cam.x + Math.sin(ph * 1.7) * amp) * ZOOM);
      vy = Math.round((this.cam.y + Math.cos(ph * 2.3) * amp) * ZOOM);
    } else {
      // The view and the car it follows, stepped together; the shake on top, in whole pixels.
      const car = cars[lead];
      const fresh = this.led !== this.followed;
      this.led = this.followed;
      vx = this.ahead(0, car, fresh) + Math.round(Math.sin(ph * 1.7) * amp * ZOOM);
      vy = this.ahead(1, car, fresh) + Math.round(Math.cos(ph * 2.3) * amp * ZOOM);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.world.draw(vx - VIEW_W / 2, vy - VIEW_H / 2, cars);

    // Cars and effects: sprites in view space, at whole pixels.
    this.actors.draw(cars, fx, vx - VIEW_W / 2, vy - VIEW_H / 2, now, lead, this.carAt[0], this.carAt[1]);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A name tag is placed by its car's true place: the view it is given is moved by as much
    // as the car's sprite is off that (a pixel at most), so the tag stays put over the sprite.
    for (let i = 0; i < cars.length; i++) if (!cars[i].me) this.hud.nameTag(cars[i], vx + this.actors.off(i, 0), vy + this.actors.off(i, 1));
    this.hud.minimap(cars);
    if (hud) this.hud.hud(hud);
  }
}
