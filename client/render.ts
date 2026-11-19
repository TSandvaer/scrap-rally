// Canvas 2D renderer at a fixed 640x360 internal resolution, scaled up pixelated by CSS.
// Scrapyard look: packed dirt, gravel verges, steel barriers, rust-and-bone kerbs, and
// piles of junk outside the walls. The drawing itself lives in client/gfx: world.ts (the
// static world), actors.ts (cars and effects), hud.ts (name tags, minimap, HUD panels).

import type { Track } from "../shared/track";
import { Actors } from "./gfx/actors";
import { Hud } from "./gfx/hud";
import { VIEW_H, VIEW_W, World, ZOOM } from "./gfx/world";

export { VIEW_H, VIEW_W };
const SHAKE_MS = 180;

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
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly world: World;
  private readonly actors: Actors;
  private readonly hud: Hud;
  readonly cam = { x: 0, y: 0 };
  private shakeAmp = 0;
  private shakeStart = 0;

  constructor(canvas: HTMLCanvasElement, track: Track) {
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.world = new World(this.ctx, track);
    this.actors = new Actors(this.ctx, track);
    this.hud = new Hud(this.ctx, track);
  }

  /** Ease the camera toward a target (world coords). snap = jump straight there. */
  follow(x: number, y: number, dtMs: number, snap = false): void {
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

  /** Draw one frame. `now` (ms) drives the camera shake and the car blinks. */
  frame(cars: CarView[], fx: WorldFx, hud: HudView | null, now = performance.now()): void {
    const ctx = this.ctx;
    const amp = this.shakeLeft(now) / ZOOM;
    const ph = (now - this.shakeStart) / 16;
    // The camera, snapped to whole view pixels: the baked world is blitted 1:1.
    const vx = Math.round((this.cam.x + Math.sin(ph * 1.7) * amp) * ZOOM);
    const vy = Math.round((this.cam.y + Math.cos(ph * 2.3) * amp) * ZOOM);
    const cx = vx / ZOOM, cy = vy / ZOOM;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.world.draw(vx - VIEW_W / 2, vy - VIEW_H / 2, cars);

    // Cars and effects: sprites in view space, at whole pixels.
    this.actors.draw(cars, fx, vx - VIEW_W / 2, vy - VIEW_H / 2, now);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of cars) if (!c.me) this.hud.nameTag(c, cx, cy);
    this.hud.minimap(cars);
    if (hud) this.hud.hud(hud);
  }
}
