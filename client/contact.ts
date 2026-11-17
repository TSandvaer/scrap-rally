// Own-car bump prediction and near-car drawing. The server resolves every car-car contact;
// the client predicts its own car's half of each bump with the shared one-sided resolver,
// against where the other cars will be when the server applies the predicted step: the
// latest snapshot's pose moved on by its velocity, k steps after that snapshot. Cars near
// the own car are drawn at that same predicted position, so a bump is seen where it
// happens, with the heading turned on at the car's turning speed. Moving smoothly matters
// as much as being exact there: the switch to and from the predicted pose eases over
// BLEND_MS, and the small jump of the prediction at each new snapshot is taken out by a
// critically damped offset, so a near car's velocity never jumps (no stutter).
// No DOM access: the headless bot test runs this code too.

import { angleDiff, collideCarOneSided, DT, type CarContact, type CarState } from "../shared/physics";
import type { CarSnap } from "../shared/protocol";

// Other cars are never extrapolated further than this. It must cover how far the own car
// runs ahead of the newest snapshot (round trip + the server's input buffer + up to one
// snapshot interval: ~10 steps at 80 ms RTT); past it the prediction stands still.
export const PREDICT_MAX_MS = 250;
const NEAR_ON_DIST = 150; // a car this close is drawn at its predicted pose ...
const NEAR_OFF_DIST = 220; // ... until it is this far away again
// The predicted pose runs ~100 ms + k steps ahead of the interpolated one (70-120 units
// at speed), so the switch takes this long: done well before a car closing in at 200 u/s
// touches, and slow enough that the catch-up is a smooth surge, not a jump.
const BLEND_MS = 500;
const SPRING_RAD_S = 25; // offset that hides snapshot jumps: critically damped, ~150 ms
const SNAP_DISTANCE = 120; // bigger jumps are shown as they are
const MAX_TURN = 8; // rad/s: a turning-speed estimate beyond this is a respawn or a glitch
export const IMPACT_MIN_SPEED = 70; // closing speed (units/s) for sparks and shake
const FEEDBACK_COOLDOWN_STEPS = 9; // ~150 ms between two impact effects

/** The part of a snapshot the prediction needs. */
export interface CarsSnap {
  cars: Map<string, CarSnap>;
  time?: number; // server time (ms), for the debug diagnostics
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
  ox: number; // offset that hides snapshot-to-snapshot jumps, and its velocity: it springs
  oy: number; // back to 0 without a velocity jump
  oh: number;
  vx: number;
  vy: number;
  vh: number;
  turn: number; // heading change per second, from the last two snapshots
}

export class Contacts {
  private base: CarsSnap | null = null;
  private you = "";
  private readonly near = new Map<string, Near>();
  private impacts: Impact[] = [];
  private cooldown = 0;
  /** performance.now() of the last predicted own contact (live step or replay). */
  lastContact = -Infinity;
  /**
   * Debug: per rebase, how far the moment the own car's current step is predicted for
   * moved (ms; 0 when the server's clock and our acked steps advance together), and per
   * near car the jump of its predicted pose that the offset has to hide (units).
   */
  readonly diag = { rebases: 0, clockShiftMs: [] as number[], nearJumps: [] as number[], kOld: [] as number[], nearFrames: 0, clampedFrames: 0 };
  diagOn = false; // collect diag (the debug overlay turns it on while racing)

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
   * dropping the acked ones). The jump of each other car's drawn pose at that moment goes
   * into its offset; the offset's velocity is kept, so the drawn motion stays smooth.
   */
  rebase(snap: CarsSnap, you: string, kOld: number, kNew: number): void {
    const old = this.base;
    this.base = snap;
    this.you = you;
    if (this.diagOn && old?.time !== undefined && snap.time !== undefined && this.diag.clockShiftMs.length < 20000) {
      this.diag.rebases++;
      this.diag.clockShiftMs.push(snap.time + kNew * DT * 1000 - (old.time + kOld * DT * 1000));
      this.diag.kOld.push(kOld);
    }
    for (const [id, n] of this.near) {
      const a = old?.cars.get(id);
      const b = snap.cars.get(id);
      if (!b) {
        this.near.delete(id);
        continue;
      }
      if (!a) continue;
      const pa = drawnPose(a, kOld, n.turn);
      const dt = old?.time !== undefined && snap.time !== undefined ? (snap.time - old.time) / 1000 : 0;
      const turn = dt > 0.005 && dt < 0.2 && !a.wreck && !b.wreck ? angleDiff(a.h, b.h) / dt : 0;
      n.turn = Math.abs(turn) <= MAX_TURN ? turn : 0;
      const pb = drawnPose(b, kNew, n.turn);
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (this.diagOn && n.w > 0 && this.diag.nearJumps.length < 20000) this.diag.nearJumps.push(Math.hypot(dx, dy));
      if (Math.hypot(dx, dy) > SNAP_DISTANCE || a.wreck > 0 !== b.wreck > 0) {
        n.ox = n.oy = n.oh = n.vx = n.vy = n.vh = 0;
        continue;
      }
      n.ox += dx;
      n.oy += dy;
      n.oh += angleDiff(pb.h, pa.h);
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
   * The live step (Game.step): collide, and queue an impact effect for a hard enough
   * contact (replays never do: they only call collide).
   */
  step(c: CarState, k: number): void {
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
   * eases over BLEND_MS to its predicted pose (plus its offset), and back once it is
   * beyond NEAR_OFF_DIST, or when the own car runs further ahead than PREDICT_MAX_MS
   * (the prediction would stand still). dtMs: time since the last frame.
   */
  blend(interp: Pose[], own: CarState | null, k: number, dtMs: number): Pose[] {
    const base = this.base;
    if (!own || !base) {
      this.near.clear();
      return interp;
    }
    const ease = dtMs / BLEND_MS;
    const ahead = k * DT * 1000 > PREDICT_MAX_MS;
    return interp.map((o) => {
      const s = base.cars.get(o.id);
      if (!s) return o;
      let n = this.near.get(o.id);
      if (!n) {
        n = { on: false, w: 0, ox: 0, oy: 0, oh: 0, vx: 0, vy: 0, vh: 0, turn: 0 };
        this.near.set(o.id, n);
      }
      settle(n, dtMs);
      const p = drawnPose(s, k, n.turn);
      const d = Math.hypot(p.x - own.x, p.y - own.y);
      if (d < NEAR_ON_DIST && !ahead) n.on = true;
      else if (d > NEAR_OFF_DIST || ahead) n.on = false;
      n.w = Math.max(0, Math.min(1, n.w + (n.on ? ease : -ease)));
      if (n.w === 0) return o;
      if (this.diagOn) {
        this.diag.nearFrames++;
        if (k * DT * 1000 > PREDICT_MAX_MS) this.diag.clampedFrames++;
      }
      const f = n.w * n.w * (3 - 2 * n.w); // smoothstep
      const px = p.x + n.ox, py = p.y + n.oy, ph = p.h + n.oh;
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
  const t = predictSeconds(k);
  return { x: s.x + s.vx * t, y: s.y + s.vy * t, h: s.h };
}

function predictSeconds(k: number): number {
  return Math.min(Math.max(0, k) * DT, PREDICT_MAX_MS / 1000);
}

/** Where a near car is drawn: the predicted position, the heading turned on by `turn`. */
export function drawnPose(s: CarSnap, k: number, turn: number): { x: number; y: number; h: number } {
  const p = predicted(s, k);
  return { x: p.x, y: p.y, h: s.h + turn * predictSeconds(k) };
}

/** Spring a near car's offset back towards 0 (critically damped), dtMs of frame time. */
function settle(n: Near, dtMs: number): void {
  const w = SPRING_RAD_S;
  let left = Math.min(dtMs, 100) / 1000;
  while (left > 0) {
    const dt = Math.min(left, 1 / 120);
    left -= dt;
    n.vx += (-w * w * n.ox - 2 * w * n.vx) * dt;
    n.vy += (-w * w * n.oy - 2 * w * n.vy) * dt;
    n.vh += (-w * w * n.oh - 2 * w * n.vh) * dt;
    n.ox += n.vx * dt;
    n.oy += n.vy * dt;
    n.oh += n.vh * dt;
  }
}
