// Cars and effects on the world: shadows, cars (grounded, airborne, falling, ghost, wreck),
// smoke, mines, rivets and hit sparks. Drawn under the renderer's world transform.

import { CAR_LENGTH, CAR_WIDTH } from "../../shared/physics";
import type { CarView } from "../render";

const SHADOW = "rgba(0,0,0,0.38)";
/** Airborne cars: drawn up to this much bigger at the top of the arc ... */
const AIR_SCALE = 0.35;
/** ... with the shadow moved this far away (world units, down-right) at the top. */
const AIR_SHADOW_X = 14;
const AIR_SHADOW_Y = 20;
/** A falling car shrinks to this fraction of its size by the end of the fall. */
const FALL_SCALE = 0.3;
const FALL_BLINKS = 7; // on/off cycles over the whole fall

export class Actors {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  carShadow(c: CarView): void {
    const ctx = this.ctx;
    const up = airOf(c);
    ctx.save();
    ctx.translate(c.x + 3 + up * AIR_SHADOW_X, c.y + 4 + up * AIR_SHADOW_Y);
    ctx.rotate(c.h);
    ctx.fillStyle = up > 0 ? `rgba(0,0,0,${(0.38 * (1 - 0.4 * up)).toFixed(3)})` : SHADOW;
    ctx.fillRect(-CAR_LENGTH / 2, -CAR_WIDTH / 2 - 1, CAR_LENGTH, CAR_WIDTH + 2);
    ctx.restore();
  }

  car(c: CarView, now: number): void {
    const ctx = this.ctx;
    const L = CAR_LENGTH, W = CAR_WIDTH;
    const up = airOf(c);
    const fall = fallOf(c);
    ctx.save();
    if (c.ghost) ctx.globalAlpha = Math.floor(now / 110) % 2 ? 0.35 : 0.75;
    if (fall >= 0 && Math.floor(fall * FALL_BLINKS * 2) % 2) ctx.globalAlpha *= 0.3;
    ctx.translate(c.x, c.y);
    if (fall >= 0) {
      // Shrinks fast at first (dropping away), tumbling slowly.
      ctx.rotate(c.h + fall * 1.1);
      const k = 1 - (1 - FALL_SCALE) * (1 - (1 - fall) * (1 - fall));
      ctx.scale(k, k);
    } else {
      ctx.rotate(c.h);
      if (up > 0) ctx.scale(1 + up * AIR_SCALE, 1 + up * AIR_SCALE);
    }
    // Wheels
    ctx.fillStyle = "#111";
    for (const wx of [-L / 2 + 3, L / 2 - 10]) {
      ctx.fillRect(wx, -W / 2 - 2, 7, 3);
      ctx.fillRect(wx, W / 2 - 1, 7, 3);
    }
    // Body with a darker outline, roll cage roof and a bonnet stripe.
    ctx.fillStyle = "#151210";
    ctx.fillRect(-L / 2 - 1, -W / 2 - 1, L + 2, W + 2);
    ctx.fillStyle = c.color;
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(-L / 2, W / 2 - 3, L, 3);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(-L / 2, -W / 2, L, 2);
    ctx.fillStyle = "#1e2a31";
    ctx.fillRect(1, -W / 2 + 3, 6, W - 6); // windscreen
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(-9, -W / 2 + 3, 9, W - 6); // roof
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(8, -1, L / 2 - 9, 2); // stripe
    ctx.fillStyle = "#ffe9a8";
    ctx.fillRect(L / 2 - 2, -W / 2 + 1, 2, 3); // lamps
    ctx.fillRect(L / 2 - 2, W / 2 - 4, 2, 3);
    if (c.wreck) {
      ctx.fillStyle = "rgba(24,18,12,0.62)"; // scorched
      ctx.fillRect(-L / 2 - 1, -W / 2 - 1, L + 2, W + 2);
    }
    if (fall >= 0) {
      ctx.fillStyle = `rgba(6,4,3,${(0.7 * fall).toFixed(3)})`; // into the dark
      ctx.fillRect(-L / 2 - 1, -W / 2 - 2, L + 2, W + 4);
    }
    ctx.restore();
  }

  smoke(c: CarView): void {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    for (let i = 0; i < 4; i++) {
      const phase = (t * 0.9 + i / 4) % 1;
      ctx.fillStyle = `rgba(70,66,62,${0.55 * (1 - phase)})`;
      circle(ctx, c.x + Math.sin(i * 2.3 + t) * 4 + phase * 10, c.y - 4 - phase * 22, 4 + phase * 7);
    }
  }

  mine(x: number, y: number, armed: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = SHADOW;
    circle(ctx, x + 1.5, y + 2, 7);
    ctx.strokeStyle = "#2a2622";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      ctx.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9);
    }
    ctx.stroke();
    ctx.fillStyle = "#3d3832";
    circle(ctx, x, y, 6);
    const blink = armed && Math.floor(performance.now() / 250) % 2 === 0;
    ctx.fillStyle = armed ? (blink ? "#ff3b2f" : "#7a1d16") : "#8a6d2a";
    circle(ctx, x, y, 2.2);
  }

  shot(x: number, y: number, vx: number, vy: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,214,130,0.55)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - vx * 0.014, y - vy * 0.014);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = "#fff4cf";
    ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  spark(x: number, y: number, age: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(255,${200 - age * 120},90,${1 - age})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + x * 0.01;
      const r0 = 3 + age * 8, r1 = 6 + age * 16;
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    }
    ctx.stroke();
  }
}

/** 0..1 airborne height (0 = on the ground). */
export function airOf(c: CarView): number {
  const h = c.height ?? 0;
  return h > 0 ? Math.min(1, h) : 0;
}

/** 0..1 of the fall elapsed, or -1 when the car is not falling. */
export function fallOf(c: CarView): number {
  const f = c.falling;
  return f !== undefined && f > 0 ? Math.min(1, f) : -1;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
