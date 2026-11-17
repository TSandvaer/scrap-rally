// Bot driver used by the end-to-end test (scripts/bots.ts), the headless bot laps
// (scripts/sim-test.ts) and `npm run botplay`. It plays through the real client Game, so it
// sees exactly what a player's browser sees.
//
// Track features (M3): full throttle and straight onto a ramp, fast enough to clear the gap
// behind it (backing up for a longer run-up when it is too slow to make it), and a lane
// around the holes ahead.

import { NO_CONTROLS, type Controls, type Game } from "../client/game";
import { angleDiff, CAR_WIDTH, clamp, DT, speedOf, type CarStats } from "../shared/physics";
import { LIP_ZONE, pointAt, queryTrackNear, type Ramp, type Track } from "../shared/track";
import { airTicksFor, MIN_TAKEOFF_SPEED } from "../shared/weapons";

/** From this far before a ramp's lip: full throttle, no braking for bends. */
const RAMP_APPROACH = 650;
/** Inside this distance to the lip: aim at a point past the landing, so the car leaves straight. */
const RAMP_STRAIGHTEN = 320;
/** Extra take-off speed asked for over the bare minimum to clear a gap (u/s). */
const TAKEOFF_MARGIN = 12;
/** Clearance kept between the car's centre path and a hole's edge. */
const HOLE_CLEARANCE = CAR_WIDTH / 2 + 8;
/** Speed through a field of holes, so the car can weave. */
const HOLE_SPEED = 300;
/** Give up a back-up after this many steps (blocked by another car, say). */
const BACKUP_MAX_STEPS = 360;

/** Distance from `from` forward to `to` along the track, in [0, length). */
function ahead(track: Track, from: number, to: number): number {
  const L = track.length;
  return (((to - from) % L) + L) % L;
}

/** Forward speed after `dist` units of full throttle from `v` on asphalt (stepCar's update). */
export function speedAfter(v: number, dist: number, stats: CarStats): number {
  const drag = stats.accel / stats.topSpeed;
  let d = 0;
  for (let i = 0; i < 1200 && d < dist; i++) {
    v += stats.accel * DT;
    v -= v * drag * DT;
    d += v * DT;
  }
  return v;
}

/** Run-up from rest at full throttle needed to reach speed `v` (Infinity if it never does). */
export function runUpFor(v: number, stats: CarStats): number {
  const drag = stats.accel / stats.topSpeed;
  let s = 0, d = 0;
  for (let i = 0; i < 1200; i++) {
    s += stats.accel * DT;
    s -= s * drag * DT;
    d += s * DT;
    if (s >= v) return d;
  }
  return Infinity;
}

/**
 * Take-off speed a ramp asks for: enough for the jump (MIN_TAKEOFF_SPEED) and, when a gap
 * starts at its lip, for a flight that lands past the gap's end. 0 for a ramp with no gap
 * behind it (rolling off its end is harmless).
 */
export function takeoffSpeedFor(track: Track, ramp: Ramp): number {
  const lip = ramp.s + ramp.len;
  const gap = track.gaps.find((g) => g.s0 >= ramp.s && g.s0 <= lip + LIP_ZONE);
  if (!gap) return 0;
  const span = gap.s1 - lip + CAR_WIDTH; // from the lip until the centre is safely past the gap
  for (let v = MIN_TAKEOFF_SPEED; v <= 1000; v += 2) {
    if ((v * airTicksFor(v)) / 60 >= span) return v + TAKEOFF_MARGIN;
  }
  return Infinity;
}

/**
 * The lane (lateral offset, + = right of travel) nearest `pref` that keeps the car's centre
 * clear of the holes ahead of s. The nearest hole comes first: when no lane clears them all,
 * the lane clears as many of the nearest ones as it can (the rest come next).
 */
export function holeLane(track: Track, s: number, look: number, pref: number): { lane: number; holes: number } {
  const near = track.holes
    .map((h) => ({ h, d: ahead(track, s - h.r - 30, h.s) - h.r - 30 })) // until it is behind the car
    .filter((x) => x.d < look)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.h);
  if (!near.length) return { lane: pref, holes: 0 };
  const max = track.def.halfWidth - CAR_WIDTH / 2;
  const clears = (lat: number) => {
    let n = 0;
    while (n < near.length && Math.abs(lat - near[n].lat) > near[n].r + HOLE_CLEARANCE) n++;
    return n;
  };
  let best = clamp(pref, -max, max), bestN = clears(best);
  for (let k = 2; k <= 2 * max && bestN < near.length; k += 2) {
    for (const lat of [pref - k, pref + k]) {
      if (Math.abs(lat) > max) continue;
      const n = clears(lat);
      if (n > bestN) {
        best = lat;
        bestN = n;
      }
    }
  }
  return { lane: best, holes: near.length };
}

export class BotDriver {
  weapons = true;
  private raceSteps = 0; // steps since this bot's race started (input applies)
  private slow = 0;
  private reversing = 0;
  /** Backing up for a longer run-up to the ramp with this lip (s), or null. */
  private backup: { lip: number; need: number; steps: number } | null = null;
  /** The lip of the ramp already backed up for: one back-up per approach, then go. */
  private backedUpFor = -1;

  constructor(
    private readonly game: Game,
    /** Racing line offset from the centerline (units, + = right of travel). */
    readonly lateral: number,
  ) {}

  /** The next ramp whose lip is at most `range` ahead of s (or that s is on), with its distance. */
  private rampAhead(track: Track, s: number, range: number): { ramp: Ramp; toLip: number } | null {
    let best: { ramp: Ramp; toLip: number } | null = null;
    for (const r of track.ramps) {
      const toLip = ahead(track, s, r.s + r.len);
      if (toLip <= range && (!best || toLip < best.toLip)) best = { ramp: r, toLip };
    }
    return best;
  }

  /** Does the car's straight path over the next ~0.4 s cross a hole? */
  private headingIntoHole(track: Track, x: number, y: number, vx: number, vy: number, s: number): boolean {
    const L = track.length;
    for (const h of track.holes) {
      const ds = Math.abs(s - h.s) % L;
      if (Math.min(ds, L - ds) > 200) continue;
      for (let k = 2; k <= 24; k += 2) {
        const px = x + vx * k * DT, py = y + vy * k * DT;
        if ((px - h.x) ** 2 + (py - h.y) ** 2 < (h.r + 4) ** 2) return true;
      }
    }
    return false;
  }

  /** Follow the line, brake for bends, take ramps flat out, dodge holes, shoot what is ahead. */
  controls(): Controls {
    const g = this.game;
    const c = g.car;
    if (!c) {
      this.raceSteps = 0;
      this.backup = null;
      this.backedUpFor = -1;
      return NO_CONTROLS;
    }
    if (g.raceOn()) this.raceSteps++;
    // In the air the flight is committed; falling or wrecked the car sits still. Inputs do
    // nothing then, and the stuck detector must not count it as stuck.
    if (c.air > 0 || c.fall > 0 || c.wreck > 0) {
      this.slow = 0;
      this.backup = null;
      if (c.air === 0) this.backedUpFor = -1; // a fall or a wreck: the next approach starts over
      return { throttle: 1, steer: 0, fire: false, mine: false };
    }
    const track = g.track; // the room's track
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const v = speedOf(c);
    const p = pointAt(track, q.s);
    const dir = p.h;
    const vf = c.vx * Math.cos(dir) + c.vy * Math.sin(dir); // speed along the track
    const lat = (c.x - p.x) * -Math.sin(dir) + (c.y - p.y) * Math.cos(dir); // + = right of travel

    // Holes: the lane nearest the car's line that clears the next ones; slower among them.
    const pref = clamp(lat, this.lateral - 24, this.lateral + 24);
    const hole = holeLane(track, q.s, 140 + v * 0.6, pref);
    const lane = hole.lane;
    const look = hole.holes ? 40 + v * 0.25 : 55 + v * 0.3;

    // A ramp coming up: full throttle, straight at it.
    const ramp = this.rampAhead(track, q.s, RAMP_APPROACH);
    if (!ramp) this.backedUpFor = -1;
    let aim = q.s + look;
    if (ramp && ramp.toLip < RAMP_STRAIGHTEN) aim = q.s + ramp.toLip + 180;
    const t = pointAt(track, aim);
    const tx = t.x - Math.sin(t.h) * lane;
    const ty = t.y + Math.cos(t.h) * lane;
    let steer = clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
    const near = pointAt(track, q.s + 20).h;
    const far = pointAt(track, q.s + 20 + Math.max(120, v * 0.9)).h;
    const bend = Math.abs(angleDiff(near, far));
    let target = bend > 1.4 ? 200 : bend > 0.9 ? 260 : bend > 0.5 ? 330 : 1000;
    if (hole.holes) target = Math.min(target, HOLE_SPEED);
    let throttle = v > target + 25 ? -1 : v > target ? 0 : 1;
    if (ramp) throttle = 1;
    // About to roll into a hole on the current heading (spun, bumped)? Brake while turning away.
    if (hole.holes && v > 150 && this.headingIntoHole(track, c.x, c.y, c.vx, c.vy, q.s)) throttle = -1;

    // Too slow to clear the gap behind the ramp (a mine, a wall, a bump)? Back up once for a
    // longer run-up, when the car is on the asphalt, pointing along the track and has room to
    // stop before the lip. A back-up that does not get there still ends in a recovery.
    const lip = ramp ? ramp.ramp.s + ramp.ramp.len : -1;
    if (ramp && !this.backup && this.backedUpFor !== lip && g.raceOn() && q.dist <= track.def.halfWidth &&
        Math.abs(angleDiff(c.h, dir)) < 0.6) {
      const need = takeoffSpeedFor(track, ramp.ramp);
      const stop = (Math.max(0, vf) ** 2) / (2 * 900) + 20; // braking distance (stepCar's BRAKE) + margin
      if (need > 0 && ramp.toLip > stop && speedAfter(Math.max(0, vf), ramp.toLip, g.stats) < need) {
        this.backup = { lip, need, steps: 0 };
        this.backedUpFor = lip;
      }
    }
    if (this.backup) {
      const b = this.backup;
      b.steps++;
      const toLip = ahead(track, q.s, b.lip);
      if (toLip > RAMP_APPROACH + 200 || toLip >= runUpFor(b.need, g.stats) + 15 || b.steps > BACKUP_MAX_STEPS) {
        this.backup = null; // room enough (or given up): go
      } else {
        // Brake, then reverse along the track, keeping the heading on the track's (steering
        // is mirrored when reversing).
        const rolling = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
        steer = clamp(angleDiff(c.h, dir) * 2 * (rolling < 0 ? -1 : 1), -1, 1);
        return { throttle: -1, steer, fire: false, mine: false };
      }
    }

    // Spun into a wall after a mine: back out for a moment.
    if (g.raceOn() && v < 20) this.slow++;
    else this.slow = 0;
    if (this.slow > 90) {
      this.reversing = 50;
      this.slow = 0;
    }
    if (this.reversing > 0) {
      this.reversing--;
      throttle = -1;
      steer = -steer;
    }

    let fire = false;
    if (this.weapons) {
      fire = g.otherPoses().some((o) => {
        const s = g.latest?.cars.get(o.id);
        // Not at cars the server ignores: ghosted, wrecked, airborne or falling.
        if (!s || s.ghost || s.wreck || s.air || s.fall) return false;
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        return d > 1 && d < 500 && Math.abs(angleDiff(c.h, Math.atan2(o.y - c.y, o.x - c.x))) < Math.PI / 12;
      });
    }
    // No mines in the first 6 s (no start-line minefield), then one every 8 s, staggered by lane.
    const offset = Math.round(Math.abs(this.lateral) * 7) % 480;
    const mine = this.weapons && this.raceSteps > 360 && this.raceSteps % 480 === offset;
    return { throttle, steer, fire, mine };
  }
}
