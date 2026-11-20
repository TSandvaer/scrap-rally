// The bot driver (M4-BOTS, PLAN-M4.md 2.0): one pure step, botControls(view, mem). The server
// runs it for host-added bot seats (server/bots.ts) and the socket bots run it through the
// client Game (scripts/bot-ai.ts), so both drive the same way.
//
// Track features (M3): full throttle and straight onto a ramp, fast enough to clear the gap
// behind it (backing up for a longer run-up when it is too slow to make it), and a lane
// around the holes ahead.
//
// Levels: Normal is the M3 driver. Easy caps the throttle at EASY_THROTTLE except on a ramp
// approach (PLAN-M4 advisor change 3: 0.85 alone tops out near 365 u/s, below what the
// Overpass Knot crossing needs), takes bends at EASY_CORNER of Normal's speed and never shoots.
//
// The slipstream (M4-DRAFT, coordinator decision 2026-11-20): Normal bots use it. On a straight,
// a car WAKE_FROM..WAKE_TO ahead that gives a draft is followed on its own line ("tuck"); within
// WAKE_PULL behind it the bot pulls out WAKE_SIDE to the side and passes ("pass"), then goes back
// to its racing line. Bounded: a tuck or a pass that takes too long is given up and the bot rests
// on its own line for a while, so two bots never fight side by side for ever; a lane with a mine
// ahead is never taken. Easy bots keep their lane.

import { CARS, DEFAULT_CAR, type CarType } from "./cars";
import { angleDiff, CAR_WIDTH, clamp, DT, speedOf, type CarState, type CarStats } from "./physics";
import { LIP_ZONE, pointAt, queryTrackNear, type Ramp, type Track } from "./track";
import { airTicksFor, MIN_TAKEOFF_SPEED } from "./weapons";

export type BotLevel = "easy" | "normal";
export const BOT_LEVELS: readonly BotLevel[] = ["easy", "normal"];

export function isBotLevel(v: unknown): v is BotLevel {
  return v === "easy" || v === "normal";
}

/** Easy: throttle cap away from ramps, and the share of Normal's corner speeds. */
export const EASY_THROTTLE = 0.85;
export const EASY_CORNER = 0.9;

/**
 * Corner speeds by car type (M4-CARS): the Sport's bend targets times (grip / Sport grip)^(1/4),
 * from the type's base grip, not the tyre upgrades (the Sport's bot drives exactly as before
 * M4-CARS at every level). The shipped tracks never hold any type back in a bend (every type
 * laps them flat out without touching the dirt), so this is the bot's caution, not a limit: a
 * looser car is driven more carefully. The square root (PLAN-M4's starting point) put the bot's
 * Racer ~5 % behind and its Truck ~4 % ahead of the Sport on Rust Bowl; the fourth root keeps
 * every type within about 3 % on every shipped track (sim-test "cars balance").
 */
export const CORNER_SCALE: Record<CarType, number> = {
  sport: 1,
  racer: (CARS.racer.base.grip / CARS.sport.base.grip) ** 0.25,
  truck: (CARS.truck.base.grip / CARS.sport.base.grip) ** 0.25,
};

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

/** What a bot does this step: the shape of the client's Controls. */
export interface BotControls {
  throttle: number;
  steer: number;
  fire: boolean; // rivet gun held
  mine: boolean; // drop a mine this step
}

export const BOT_IDLE: BotControls = { throttle: 0, steer: 0, fire: false, mine: false };

/** Another car as the bot sees it: where it is, and whether it can be hit (solid). */
export interface BotOther {
  x: number;
  y: number;
  solid: boolean; // not ghosted, finished, wrecked, airborne or falling
  // For the slipstream (absent: never followed). id: only compared with itself (which car the
  // bot is passing), never ordered by, so a random id keeps a rerun identical.
  id?: string;
  vx?: number;
  vy?: number;
}

/** A mine on the track, as far as a bot avoids it (the wake lanes never run over one). */
export interface BotMine {
  x: number;
  y: number;
}

/** Normal bots' use of the slipstream (see the top of this file). */
const WAKE_FROM = 40; // follow a car this far ahead along the track ...
const WAKE_TO = 180; // ... up to this far (where its draft ends, shared/catchup.ts)
const WAKE_PULL = 40; // this close behind it: pull out and pass
const WAKE_TUCK = 6; // the tuck lane: this far off the leader's line, to the pass side (still full draft)
const WAKE_SIDE = 26; // the pass lane: this far to the side of the car passed (side by side: 16 apart)
const WAKE_DONE = 60; // the pass is done this far ahead of the car passed: back to the racing line
const WAKE_STRAIGHT = 0.3; // only while the road ahead bends less than this (radians)
const WAKE_LEAD_SPEED = 250; // a car slower than this gives no draft (DRAFT_LEAD_MIN_SPEED)
const WAKE_TUCK_MAX = 360; // a tuck that has not become a pass by then is given up (6 s)
const WAKE_PASS_MAX = 240; // a pass not done by then is given up (4 s)
const WAKE_REST = 240; // after giving up: no new tuck for this long (4 s), on the racing line
const WAKE_MINE_LOOK = 300; // a mine this far ahead ...
const WAKE_MINE_CLEAR = 28; // ... and this close to a wake lane rules the lane out (car + mine radii + margin)
// No ramming (Normal): a car this far ahead at most (centre to centre; nose to tail is 31) and
// less than this far across (side by side the capsules touch at 16) that the bot is closing on
// makes it lift. The slipstream makes a follower faster than the car it follows, so without this
// it would run into the back of it; with it, it waits until it is beside it.
const BLOCK_AHEAD = 36;
const BLOCK_ACROSS = 19;

/** Everything a bot reads to drive one step. */
export interface BotView {
  car: CarState | null; // null: not in a race
  track: Track;
  stats: CarStats;
  raceOn: boolean; // inputs apply (racing, not paused)
  raceSteps: number; // steps since the race started (counted while raceOn), for the mine timing
  others: readonly BotOther[]; // the other cars (the rivet gun, the slipstream)
  carType?: CarType; // the car type it drives (M4-CARS); absent = the Sport
  mines?: readonly BotMine[]; // the mines on the track (the slipstream lanes avoid them)
}

/** A bot's settings (by seat) and the state it keeps between steps. */
export interface BotMem {
  level: BotLevel;
  lateral: number; // racing line offset from the centerline (units, + = right of travel)
  weapons: boolean; // fires rivets and drops mines (never on Easy)
  mineOffset: number; // which step of the 480-step mine cycle drops a mine
  slow: number; // steps spent nearly stopped (stuck detector)
  reversing: number; // steps left backing out after getting stuck
  /** Backing up for a longer run-up to the ramp with this lip (s), or null. */
  backup: { lip: number; need: number; steps: number } | null;
  /** The lip of the ramp already backed up for: one back-up per approach, then go. */
  backedUpFor: number;
  /** Uses the slipstream (Normal; false = keeps its lane, as Easy and as before M4-DRAFT). */
  useWake: boolean;
  /** Following (tuck) or passing a car: which one (BotOther.id), the pass side (+1 right), steps so far. */
  wake: { id: string; pass: boolean; side: number; steps: number } | null;
  /** Steps left resting on the racing line after a tuck or a pass was given up or done. */
  wakeRest: number;
}

/**
 * A bot's memory. The mine offset defaults to the one the socket bots always used (from the
 * lane); server seats pass one by seat so two bots on mirrored lanes do not drop together.
 */
export function newBotMem(lateral: number, level: BotLevel = "normal", mineOffset = Math.round(Math.abs(lateral) * 7) % 480): BotMem {
  return { level, lateral, weapons: level === "normal", mineOffset, slow: 0, reversing: 0, backup: null, backedUpFor: -1, useWake: level === "normal", wake: null, wakeRest: 0 };
}

/** Forget the race (between races): the settings stay. */
export function resetBotMem(mem: BotMem): void {
  mem.slow = 0;
  mem.reversing = 0;
  mem.backup = null;
  mem.backedUpFor = -1;
  mem.wake = null;
  mem.wakeRest = 0;
}

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

// takeoffSpeedFor depends on the track and the ramp only: worked out once per ramp object.
const takeoffMemo = new WeakMap<Ramp, number>();

/**
 * Take-off speed a ramp asks for: enough for the jump (MIN_TAKEOFF_SPEED) and, when a gap
 * starts at its lip, for a flight that lands past the gap's end. 0 for a ramp with no gap
 * behind it (rolling off its end is harmless).
 */
export function takeoffSpeedFor(track: Track, ramp: Ramp): number {
  const known = track.ramps.includes(ramp) ? takeoffMemo.get(ramp) : undefined;
  if (known !== undefined) return known;
  const lip = ramp.s + ramp.len;
  const gap = track.gaps.find((g) => g.s0 >= ramp.s && g.s0 <= lip + LIP_ZONE);
  let need = Infinity;
  if (!gap) need = 0;
  else {
    const span = gap.s1 - lip + CAR_WIDTH; // from the lip until the centre is safely past the gap
    for (let v = MIN_TAKEOFF_SPEED; v <= 1000; v += 2) {
      if ((v * airTicksFor(v)) / 60 >= span) {
        need = v + TAKEOFF_MARGIN;
        break;
      }
    }
  }
  if (track.ramps.includes(ramp)) takeoffMemo.set(ramp, need);
  return need;
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

/** The next ramp whose lip is at most `range` ahead of s (or that s is on), with its distance. */
function rampAhead(track: Track, s: number, range: number): { ramp: Ramp; toLip: number } | null {
  let best: { ramp: Ramp; toLip: number } | null = null;
  for (const r of track.ramps) {
    const toLip = ahead(track, s, r.s + r.len);
    if (toLip <= range && (!best || toLip < best.toLip)) best = { ramp: r, toLip };
  }
  return best;
}

/** Does the car's straight path over the next ~0.4 s cross a hole? */
function headingIntoHole(track: Track, x: number, y: number, vx: number, vy: number, s: number): boolean {
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

/**
 * The slipstream lane for this step, or null for the racing line (see the top of this file).
 * (px, py, dir): the centerline point at the bot's s and its heading; the other cars and mines
 * are placed along and across the track in that frame (the bot only uses the wake on straights).
 * max: the furthest a lane may lie from the centerline.
 */
function wakeLane(
  view: BotView, mem: BotMem, c: CarState, px: number, py: number, dir: number, bend: number, max: number,
): { lane: number; coast: boolean } | null {
  const ux = Math.cos(dir), uy = Math.sin(dir);
  const along = (x: number, y: number) => (x - c.x) * ux + (y - c.y) * uy; // + = ahead of the bot
  const across = (x: number, y: number) => -(x - px) * uy + (y - py) * ux; // + = right of the centerline
  const mineFree = (lane: number) =>
    Math.abs(lane) <= max &&
    !(view.mines ?? []).some((m) => {
      const a = along(m.x, m.y);
      return a > -10 && a < WAKE_MINE_LOOK && Math.abs(across(m.x, m.y) - lane) < WAKE_MINE_CLEAR;
    });
  const leads = (o: BotOther) => o.solid && o.id !== undefined && (o.vx ?? 0) ** 2 + (o.vy ?? 0) ** 2 >= WAKE_LEAD_SPEED * WAKE_LEAD_SPEED;
  const giveUp = () => {
    mem.wake = null;
    mem.wakeRest = WAKE_REST;
    return null;
  };
  const w = mem.wake;
  if (w) {
    w.steps++;
    const o = view.others.find((x) => x.id === w.id);
    if (!o || !o.solid) {
      mem.wake = null;
      return null;
    }
    const a = along(o.x, o.y), olat = across(o.x, o.y);
    if (w.pass) {
      if (a < -WAKE_DONE) {
        mem.wake = null; // passed: back to the racing line (on the pass side, away from it)
        return null;
      }
      const lane = olat + w.side * WAKE_SIDE;
      if (w.steps > WAKE_PASS_MAX || a > WAKE_TO || !mineFree(lane)) return giveUp();
      return { lane, coast: false };
    }
    if (bend > WAKE_STRAIGHT || a < 0 || a > WAKE_TO + 20 || !leads(o)) {
      mem.wake = null; // a bend, or the car is gone from ahead: back to the racing line
      return null;
    }
    if (w.steps > WAKE_TUCK_MAX) return giveUp();
    if (a < WAKE_PULL) {
      // Pass: on the planned side, else the other; neither free -> stay behind and coast.
      for (const side of [w.side, -w.side]) {
        if (mineFree(olat + side * WAKE_SIDE)) {
          w.pass = true;
          w.side = side;
          w.steps = 0;
          return { lane: olat + side * WAKE_SIDE, coast: false };
        }
      }
      return { lane: olat + w.side * WAKE_TUCK, coast: true };
    }
    const lane = olat + w.side * WAKE_TUCK;
    return mineFree(lane) ? { lane, coast: false } : giveUp();
  }
  if (mem.wakeRest > 0 || bend > WAKE_STRAIGHT) return null;
  // A new tuck: the nearest car ahead in range that gives a draft.
  let best: BotOther | null = null, bestA = Infinity;
  for (const o of view.others) {
    if (!leads(o)) continue;
    const a = along(o.x, o.y);
    if (a >= WAKE_FROM && a <= WAKE_TO && a < bestA) {
      best = o;
      bestA = a;
    }
  }
  if (!best) return null;
  const olat = across(best.x, best.y);
  // Pass towards its own racing line (so going back to it never crosses the car passed); on the
  // same line, by seat (the side of the line it races on, right for the centre).
  const side = mem.lateral > olat + 1 ? 1 : mem.lateral < olat - 1 ? -1 : mem.lateral >= 0 ? 1 : -1;
  const lane = olat + side * WAKE_TUCK;
  if (!mineFree(lane)) return null;
  mem.wake = { id: best.id!, pass: false, side, steps: 0 };
  return { lane, coast: false };
}

/** Is a solid car right ahead of the bot on its line (BLOCK_AHEAD, BLOCK_ACROSS) and the bot closing on it? */
function closingOnCar(view: BotView, c: CarState, dir: number): boolean {
  const ux = Math.cos(dir), uy = Math.sin(dir);
  const mine = c.vx * ux + c.vy * uy;
  return view.others.some((o) => {
    if (!o.solid || o.vx === undefined) return false;
    const dx = o.x - c.x, dy = o.y - c.y;
    const a = dx * ux + dy * uy;
    return a > 0 && a < BLOCK_AHEAD && Math.abs(-dx * uy + dy * ux) < BLOCK_ACROSS && mine > o.vx * ux + (o.vy ?? 0) * uy;
  });
}

/** Follow the line, brake for bends, take ramps flat out, dodge holes, shoot what is ahead. */
export function botControls(view: BotView, mem: BotMem): BotControls {
  const c = view.car;
  if (!c) {
    mem.backup = null;
    mem.backedUpFor = -1;
    return BOT_IDLE;
  }
  // In the air the flight is committed; falling or wrecked the car sits still. Inputs do
  // nothing then, and the stuck detector must not count it as stuck.
  if (c.air > 0 || c.fall > 0 || c.wreck > 0) {
    mem.slow = 0;
    mem.backup = null;
    mem.wake = null;
    if (c.air === 0) mem.backedUpFor = -1; // a fall or a wreck: the next approach starts over
    return { throttle: 1, steer: 0, fire: false, mine: false };
  }
  const easy = mem.level === "easy";
  const track = view.track;
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const v = speedOf(c);
  const p = pointAt(track, q.s);
  const dir = p.h;
  const vf = c.vx * Math.cos(dir) + c.vy * Math.sin(dir); // speed along the track
  const lat = (c.x - p.x) * -Math.sin(dir) + (c.y - p.y) * Math.cos(dir); // + = right of travel

  // Holes: the lane nearest the car's line that clears the next ones; slower among them.
  // With no holes ahead the bot holds its own racing line (mem.lateral).
  const hole = holeLane(track, q.s, 140 + v * 0.6, clamp(lat, mem.lateral - 24, mem.lateral + 24));
  let lane = hole.holes ? hole.lane : mem.lateral;
  const look = hole.holes ? 40 + v * 0.25 : 55 + v * 0.3;

  // A ramp coming up: full throttle, straight at it.
  const ramp = rampAhead(track, q.s, RAMP_APPROACH);
  if (!ramp) mem.backedUpFor = -1;
  const near = pointAt(track, q.s + 20).h;
  const far = pointAt(track, q.s + 20 + Math.max(120, v * 0.9)).h;
  const bend = Math.abs(angleDiff(near, far));

  // The slipstream: follow a car ahead on a straight, then pass it (Normal only).
  let coast = false;
  if (mem.wakeRest > 0) mem.wakeRest--;
  if (mem.useWake && !easy && view.raceOn && !hole.holes && !ramp && !mem.backup && mem.reversing === 0) {
    const w = wakeLane(view, mem, c, p.x, p.y, dir, bend, track.def.halfWidth - CAR_WIDTH / 2 - 2);
    if (w) {
      lane = w.lane;
      coast = w.coast;
    }
  } else mem.wake = null;
  let aim = q.s + look;
  if (ramp && ramp.toLip < RAMP_STRAIGHTEN) aim = q.s + ramp.toLip + 180;
  const t = pointAt(track, aim);
  const tx = t.x - Math.sin(t.h) * lane;
  const ty = t.y + Math.cos(t.h) * lane;
  let steer = clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
  let target = bend > 1.4 ? 200 : bend > 0.9 ? 260 : bend > 0.5 ? 330 : 1000;
  const scale = CORNER_SCALE[view.carType ?? DEFAULT_CAR];
  if (scale !== 1) target *= scale;
  if (easy) target *= EASY_CORNER;
  if (hole.holes) target = Math.min(target, HOLE_SPEED);
  let throttle = v > target + 25 ? -1 : v > target ? 0 : 1;
  // No ramming; never on a ramp approach (the jump needs the speed: a bump costs less than a fall).
  if (!ramp && (coast || (mem.useWake && !easy && closingOnCar(view, c, dir))) && throttle > 0) throttle = 0;
  if (ramp) throttle = 1; // Easy too: the cap would leave it short of some jumps
  else if (easy && throttle > EASY_THROTTLE) throttle = EASY_THROTTLE;
  // About to roll into a hole on the current heading (spun, bumped)? Brake while turning away.
  if (hole.holes && v > 150 && headingIntoHole(track, c.x, c.y, c.vx, c.vy, q.s)) throttle = -1;

  // Too slow to clear the gap behind the ramp (a mine, a wall, a bump)? Back up once for a
  // longer run-up, when the car is on the asphalt, pointing along the track and has room to
  // stop before the lip. A back-up that does not get there still ends in a recovery.
  const lip = ramp ? ramp.ramp.s + ramp.ramp.len : -1;
  if (ramp && !mem.backup && mem.backedUpFor !== lip && view.raceOn && q.dist <= track.def.halfWidth &&
      Math.abs(angleDiff(c.h, dir)) < 0.6) {
    const need = takeoffSpeedFor(track, ramp.ramp);
    const stop = (Math.max(0, vf) ** 2) / (2 * 900) + 20; // braking distance (stepCar's BRAKE) + margin
    if (need > 0 && ramp.toLip > stop && speedAfter(Math.max(0, vf), ramp.toLip, view.stats) < need) {
      mem.backup = { lip, need, steps: 0 };
      mem.backedUpFor = lip;
    }
  }
  if (mem.backup) {
    const b = mem.backup;
    b.steps++;
    const toLip = ahead(track, q.s, b.lip);
    if (toLip > RAMP_APPROACH + 200 || toLip >= runUpFor(b.need, view.stats) + 15 || b.steps > BACKUP_MAX_STEPS) {
      mem.backup = null; // room enough (or given up): go
    } else {
      // Brake, then reverse along the track, keeping the heading on the track's (steering
      // is mirrored when reversing).
      const rolling = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
      steer = clamp(angleDiff(c.h, dir) * 2 * (rolling < 0 ? -1 : 1), -1, 1);
      return { throttle: -1, steer, fire: false, mine: false };
    }
  }

  // Spun into a wall after a mine: back out for a moment.
  if (view.raceOn && v < 20) mem.slow++;
  else mem.slow = 0;
  if (mem.slow > 90) {
    mem.reversing = 50;
    mem.slow = 0;
  }
  if (mem.reversing > 0) {
    mem.reversing--;
    throttle = -1;
    steer = -steer;
  }

  const armed = mem.weapons && !easy;
  let fire = false;
  if (armed) {
    // Not at cars the server ignores: ghosted, wrecked, airborne or falling.
    fire = view.others.some((o) => {
      if (!o.solid) return false;
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      return d > 1 && d < 500 && Math.abs(angleDiff(c.h, Math.atan2(o.y - c.y, o.x - c.x))) < Math.PI / 12;
    });
  }
  // No mines in the first 6 s (no start-line minefield), then one every 8 s, staggered by seat.
  const mine = armed && view.raceSteps > 360 && view.raceSteps % 480 === mem.mineOffset;
  return { throttle, steer, fire, mine };
}
