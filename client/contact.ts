// Own-car bump prediction and near-car drawing. The server resolves every car-car contact;
// the client predicts its own car's half of each bump with the shared one-sided resolver,
// against where the other cars will be when the server applies the predicted step: the
// latest snapshot's pose moved on by its velocity, k steps after that snapshot. Cars near
// the own car are drawn at that same predicted pose, so a bump is seen where it happens.
// No DOM access: the headless bot test runs this code too.

import { angleDiff, collideCarOneSided, DT, type CarContact, type CarState } from "../shared/physics";
import type { CarSnap } from "../shared/protocol";

export const PREDICT_MAX_MS = 150; // other cars are never extrapolated further than this
const NEAR_ON_DIST = 90; // a car this close is drawn at its predicted pose ...
const NEAR_OFF_DIST = 130; // ... until it is this far away again
const BLEND_MS = 150; // how long the switch between interpolated and predicted pose takes
const SMOOTH_TAU_MS = 35; // jumps of near cars decay like the own car's (client/game.ts)
const SNAP_DISTANCE = 120; // bigger jumps are shown as they are
export const IMPACT_MIN_SPEED = 70; // closing speed (units/s) for sparks and shake
const FEEDBACK_COOLDOWN_STEPS = 9; // ~150 ms between two impact effects

/** The part of a snapshot the prediction needs. */
export interface CarsSnap {
  cars: Map<string, CarSnap>;
}

export interface Impact {
  x: number;
  y: number;
  speed: number; // closing speed along the contact normal
}

interface Pose {
  id: string;
  x: number;
  y: number;
  h: number;
}

interface Near {
  on: boolean; // inside the hysteresis band
  w: number; // 0 = interpolated pose, 1 = predicted pose
  sx: number; // decaying offset that hides snapshot-to-snapshot jumps
  sy: number;
  sh: number;
}

export class Contacts {
  private base: CarsSnap | null = null;
  private you = "";
  private readonly near = new Map<string, Near>();
  private impacts: Impact[] = [];
  private cooldown = 0;
  /** performance.now() of the last predicted own contact (live step or replay). */
  lastContact = -Infinity;

  reset(): void {
    this.base = null;
    this.near.clear();
    this.impacts = [];
    this.cooldown = 0;
  }

  /** The first snapshot with our car: predictions extrapolate from it. */
  setBase(snap: CarsSnap, you: string): void {
    this.base = snap;
    this.you = you;
  }

  /**
   * A new snapshot the own car was reconciled to. kOld / kNew: the step index of the own
   * car's current state after the old and the new base (pending inputs before and after
   * dropping the acked ones). The jump of each other car's predicted pose at that moment
   * goes into its decaying offset, as the own car's reconciliation jump does.
   */
  rebase(snap: CarsSnap, you: string, kOld: number, kNew: number): void {
    const old = this.base;
    this.base = snap;
    this.you = you;
    for (const [id, n] of this.near) {
      const a = old?.cars.get(id);
      const b = snap.cars.get(id);
      if (!b) {
        this.near.delete(id);
        continue;
      }
      if (!a) continue;
      const pa = predicted(a, kOld);
      const pb = predicted(b, kNew);
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (Math.hypot(dx, dy) > SNAP_DISTANCE || a.wreck > 0 !== b.wreck > 0) {
        n.sx = n.sy = n.sh = 0;
        continue;
      }
      n.sx += dx;
      n.sy += dy;
      n.sh += angleDiff(pb.h, pa.h);
    }
  }

  /**
   * Bump the own car c, just stepped to step k after the base snapshot, against every
   * other solid car's predicted pose: c takes exactly its half of each push and impulse.
   * Returns the hardest contact. Wrecked or ghosted (incl. finished) cars are skipped,
   * and the own car does not collide at all while it is wrecked or ghosted.
   */
  collide(c: CarState, k: number): CarContact | null {
    const base = this.base;
    if (!base || c.wreck > 0 || base.cars.get(this.you)?.ghost) return null;
    let hardest: CarContact | null = null;
    for (const [id, s] of base.cars) {
      if (id === this.you || s.ghost || s.wreck > 0) continue;
      const p = predicted(s, k);
      const hit = collideCarOneSided(c, { x: p.x, y: p.y, h: s.h, vx: s.vx, vy: s.vy });
      if (hit && (!hardest || hit.impact > hardest.impact)) hardest = hit;
    }
    if (hardest) this.lastContact = performance.now();
    return hardest;
  }

  /**
   * The live step (Game.step): collide, decay the near-car offsets, and queue an impact
   * effect for a hard enough contact (replays never do: they only call collide).
   */
  step(c: CarState, k: number, stepMs: number): void {
    const f = Math.exp(-stepMs / SMOOTH_TAU_MS);
    for (const n of this.near.values()) {
      n.sx *= f;
      n.sy *= f;
      n.sh *= f;
    }
    if (this.cooldown > 0) this.cooldown--;
    const hit = this.collide(c, k);
    if (hit && hit.impact >= IMPACT_MIN_SPEED && this.cooldown === 0) {
      this.impacts.push({ x: hit.px, y: hit.py, speed: hit.impact });
      this.cooldown = FEEDBACK_COOLDOWN_STEPS;
    }
  }

  /** Impact effects queued since the last call. */
  takeImpacts(): Impact[] {
    const out = this.impacts;
    this.impacts = [];
    return out;
  }

  /**
   * Where to draw the other cars. interp: their interpolated poses (100 ms in the past).
   * own: the own car, null when spectating. k: the step index the own car is drawn at
   * (fractional, between the last two steps). A car within NEAR_ON_DIST of the own car
   * eases over BLEND_MS to its predicted pose (plus its decaying offset), and back once
   * it is beyond NEAR_OFF_DIST.
   */
  blend(interp: Pose[], own: CarState | null, k: number, dtMs: number): Pose[] {
    const base = this.base;
    if (!own || !base) {
      this.near.clear();
      return interp;
    }
    const ease = dtMs / BLEND_MS;
    return interp.map((o) => {
      const s = base.cars.get(o.id);
      if (!s) return o;
      const p = predicted(s, k);
      let n = this.near.get(o.id);
      if (!n) {
        n = { on: false, w: 0, sx: 0, sy: 0, sh: 0 };
        this.near.set(o.id, n);
      }
      const d = Math.hypot(p.x - own.x, p.y - own.y);
      if (d < NEAR_ON_DIST) n.on = true;
      else if (d > NEAR_OFF_DIST) n.on = false;
      n.w = Math.max(0, Math.min(1, n.w + (n.on ? ease : -ease)));
      if (n.w === 0) return o;
      const f = n.w * n.w * (3 - 2 * n.w); // smoothstep
      const px = p.x + n.sx, py = p.y + n.sy, ph = p.h + n.sh;
      return { id: o.id, x: o.x + (px - o.x) * f, y: o.y + (py - o.y) * f, h: o.h + angleDiff(o.h, ph) * f };
    });
  }

  /** 0..1: how far a car is drawn at its predicted pose (debug overlay). */
  weight(id: string): number {
    return this.near.get(id)?.w ?? 0;
  }
}

/** A car k steps after its snapshot: moved on by its velocity, at most PREDICT_MAX_MS. */
export function predicted(s: CarSnap, k: number): { x: number; y: number; h: number } {
  const t = Math.min(Math.max(0, k) * DT, PREDICT_MAX_MS / 1000);
  return { x: s.x + s.vx * t, y: s.y + s.vy * t, h: s.h };
}
