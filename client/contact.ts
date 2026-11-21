// Own-car bump prediction and near-car drawing. The server resolves every car-car contact;
// the client predicts its own car's half of each bump with the shared one-sided resolver,
// against where the other cars will be when the server applies the predicted step: the
// latest snapshot's pose moved on by its velocity and turned on at its turning speed, k
// steps after that snapshot. Cars near the own car are drawn at that same predicted pose,
// so a bump is seen where it happens. Moving smoothly matters
// as much as being exact there: the switch to and from the predicted pose eases over
// BLEND_MS, and the small jump of the prediction at each new snapshot is taken out by a
// critically damped offset, so a near car's velocity never jumps (no stutter).
// No DOM access: the headless bot test runs this code too.

import { draftFrom, givesDraft, takesDraft } from "../shared/catchup";
import { angleDiff, collideCarOneSided, DT, TICK_HZ, type CarContact, type CarState } from "../shared/physics";
import type { CarSnap } from "../shared/protocol";
import { airHeight } from "../shared/weapons";

// How far ahead of the newest snapshot other cars are predicted. It must cover how far the
// own car runs ahead (round trip + the server's input buffer + up to one snapshot
// interval: ~10 steps at 80 ms RTT, ~15 at 150 ms, ~17 at 180 ms). Past it there is no
// prediction at all: no predicted bumps (the server's arrive through the reconcile) and
// near cars go back to interpolation. Whether the own car is past it is decided once per
// snapshot cycle, from the furthest it ran ahead in that cycle, with AHEAD_HYST_STEPS of
// hysteresis, so the switch cannot flicker while the lead swings a couple of steps each
// cycle.
export const PREDICT_MAX_MS = 300;
const CAP_STEPS = Math.round((PREDICT_MAX_MS * TICK_HZ) / 1000);
const AHEAD_HYST_STEPS = 2;
const DRAW_MAX_S = 1; // drawing never stands still at the cap; this only bounds nonsense
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
  height?: number; // 0..1 (shared/weapons.ts airHeight); absent = on the ground
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
}

export class Contacts {
  private base: CarsSnap | null = null;
  private you = "";
  private readonly near = new Map<string, Near>();
  private turns = new Map<string, number>(); // heading change per second, from the last two snapshots
  private ahead = false; // the own car runs further ahead than CAP_STEPS (see PREDICT_MAX_MS)
  private impacts: Impact[] = [];
  private cooldown = 0;
  /** performance.now() of the last predicted own contact (live step or replay). */
  lastContact = -Infinity;
  /**
   * Debug: per rebase, how far the moment the own car's current step is predicted for
   * moved (ms; 0 when the server's clock and our acked steps advance together), and per
   * near car the jump of its predicted pose that the offset has to hide (units).
   */
  readonly diag = { rebases: 0, clockShiftMs: [] as number[], nearJumps: [] as number[], kOld: [] as number[], nearFrames: 0, pastCapFrames: 0, aheadCycles: 0 };
  diagOn = false; // collect diag (the debug overlay turns it on while racing)

  resetDiag(): void {
    const d = this.diag;
    d.rebases = d.nearFrames = d.pastCapFrames = d.aheadCycles = 0;
    d.clockShiftMs.length = d.nearJumps.length = d.kOld.length = 0;
  }

  reset(): void {
    this.base = null;
    this.near.clear();
    this.turns.clear();
    this.ahead = false;
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
   * dropping the acked ones; kOld is also the furthest the own car ran ahead of the old
   * base). The jump of each other car's drawn pose at that moment goes into its offset;
   * the offset's velocity is kept, so the drawn motion stays smooth.
   */
  rebase(snap: CarsSnap, you: string, kOld: number, kNew: number): void {
    const old = this.base;
    this.base = snap;
    this.you = you;
    if (kOld > CAP_STEPS) this.ahead = true;
    else if (kOld <= CAP_STEPS - AHEAD_HYST_STEPS) this.ahead = false;
    if (this.diagOn && this.ahead) this.diag.aheadCycles++;
    const dt = old?.time !== undefined && snap.time !== undefined ? (snap.time - old.time) / 1000 : 0;
    const turns = new Map<string, number>();
    for (const [id, b] of snap.cars) {
      const a = old?.cars.get(id);
      // Airborne and falling cars do not turn; a recovery or a respawn is a jump, not a turn.
      const steady = a && !a.wreck && !b.wreck && !a.fall && !b.fall && !b.air;
      const turn = steady && dt > 0.005 && dt < 0.2 ? angleDiff(a.h, b.h) / dt : 0;
      turns.set(id, Math.abs(turn) <= MAX_TURN ? turn : 0);
    }
    const oldTurns = this.turns;
    this.turns = turns;
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
      const pa = drawnPose(a, kOld, oldTurns.get(id) ?? 0);
      const pb = drawnPose(b, kNew, turns.get(id) ?? 0);
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (this.diagOn && n.w > 0 && this.diag.nearJumps.length < 20000) this.diag.nearJumps.push(Math.hypot(dx, dy));
      if (Math.hypot(dx, dy) > SNAP_DISTANCE || a.wreck > 0 !== b.wreck > 0 || a.fall > 0 !== b.fall > 0) {
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
   * other solid car's predicted pose (the pose near cars are drawn at): c takes exactly its
   * half of each push and impulse. Returns the hardest contact. Wrecked, ghosted (incl.
   * finished) and falling cars are skipped, and so are airborne ones still in the air at
   * step k (flight is committed: the snapshot's air ticks say when it lands). The own car
   * does not collide at all while it is wrecked, airborne, falling or ghosted, or runs
   * further ahead than PREDICT_MAX_MS. Mirrors the server's solid().
   */
  collide(c: CarState, k: number): CarContact | null {
    const base = this.base;
    if (!base || c.wreck > 0 || c.air > 0 || c.fall > 0 || base.cars.get(this.you)?.ghost || this.ahead || k > CAP_STEPS) return null;
    let hardest: CarContact | null = null;
    for (const [id, s] of base.cars) {
      if (id === this.you || s.ghost || s.wreck > 0 || s.fall > 0 || s.air > k) continue;
      const p = drawnPose(s, k, this.turns.get(id) ?? 0);
      const hit = collideCarOneSided(c, { x: p.x, y: p.y, h: p.h, vx: s.vx, vy: s.vy });
      if (hit && (!hardest || hit.impact > hardest.impact)) hardest = hit;
    }
    if (hardest) this.lastContact = performance.now();
    return hardest;
  }

  /**
   * The own car's slipstream (M4-DRAFT, shared/catchup.ts) for step k after the base snapshot:
   * the server works it out from the start-of-tick poses, so from c before the step and every
   * other car's predicted pose k - 1 steps after its snapshot (the pose near cars are drawn at),
   * with the server's rules (the leader on the ground at k - 1, not wrecked, ghosted, finished or
   * falling, at DRAFT_LEAD_MIN_SPEED by its snapshot velocity). None while the own car runs
   * further ahead than PREDICT_MAX_MS (advisor change 8): the reconcile brings it in later, as
   * with bumps.
   */
  draft(c: CarState, k: number): number {
    const base = this.base;
    if (!base || this.ahead || k > CAP_STEPS || !takesDraft(c)) return 0;
    const j = Math.max(0, k - 1);
    let w = 0;
    for (const [id, s] of base.cars) {
      if (id === this.you || s.air > j || !givesDraft(s, s.ghost, s.fin > 0, 0)) continue; // landed by then
      const p = drawnPose(s, j, this.turns.get(id) ?? 0);
      const d = draftFrom(c.x, c.y, p.x, p.y, p.h);
      if (d > w) w = d;
    }
    return w;
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
   * beyond NEAR_OFF_DIST, or while the own car runs further ahead than PREDICT_MAX_MS
   * (no prediction then). dtMs: time since the last frame. Other fields of a pose are kept;
   * a near car's height eases to its predicted height at step k with its position.
   */
  blend<P extends Pose>(interp: P[], own: CarState | null, k: number, dtMs: number): P[] {
    const base = this.base;
    if (!own || !base) {
      this.near.clear();
      return interp;
    }
    const ease = dtMs / BLEND_MS;
    const ahead = this.ahead;
    return interp.map((o) => {
      const s = base.cars.get(o.id);
      if (!s) return o;
      let n = this.near.get(o.id);
      if (!n) {
        n = { on: false, w: 0, ox: 0, oy: 0, oh: 0, vx: 0, vy: 0, vh: 0 };
        this.near.set(o.id, n);
      }
      settle(n, dtMs);
      const p = drawnPose(s, k, this.turns.get(o.id) ?? 0);
      const d = Math.hypot(p.x - own.x, p.y - own.y);
      if (d < NEAR_ON_DIST && !ahead) n.on = true;
      else if (d > NEAR_OFF_DIST || ahead) n.on = false;
      n.w = Math.max(0, Math.min(1, n.w + (n.on ? ease : -ease)));
      if (n.w === 0) return o;
      if (this.diagOn) {
        this.diag.nearFrames++;
        if (k > CAP_STEPS) this.diag.pastCapFrames++;
      }
      const f = n.w * n.w * (3 - 2 * n.w); // smoothstep
      const px = p.x + n.ox, py = p.y + n.oy, ph = p.h + n.oh;
      const h0 = o.height ?? 0;
      const height = h0 + (drawnHeight(s, k) - h0) * f;
      return { ...o, x: o.x + (px - o.x) * f, y: o.y + (py - o.y) * f, h: o.h + angleDiff(o.h, ph) * f, height };
    });
  }

  /** 0..1: how far a car is drawn at its predicted pose (debug overlay). */
  weight(id: string): number {
    return this.near.get(id)?.w ?? 0;
  }
}

/** A car k steps after its snapshot: moved on by its velocity (heading as in the snapshot). */
export function predicted(s: CarSnap, k: number): { x: number; y: number; h: number } {
  const t = predictSeconds(k);
  return { x: s.x + s.vx * t, y: s.y + s.vy * t, h: s.h };
}

function predictSeconds(k: number): number {
  return Math.min(Math.max(0, k) * DT, DRAW_MAX_S);
}

/**
 * The predicted pose of another car: its position moved on by its velocity and its heading
 * turned on at `turn` (rad/s). Near cars are drawn here and the own car bumps into it.
 */
export function drawnPose(s: CarSnap, k: number, turn: number): { x: number; y: number; h: number } {
  const p = predicted(s, k);
  return { x: p.x, y: p.y, h: s.h + turn * predictSeconds(k) };
}

/** The height (airHeight) of another car k steps after its snapshot: its flight is committed. */
export function drawnHeight(s: CarSnap, k: number): number {
  return s.air > 0 ? airHeight({ ...s, air: Math.max(0, s.air - Math.max(0, k)) }) : 0;
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
