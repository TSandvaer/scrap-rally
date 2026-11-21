// The bot driver (M4-BOTS, PLAN-M4.md 2.0): one pure step, botControls(view, mem). The server
// runs it for host-added bot seats (server/bots.ts) and the socket bots run it through the
// client Game (scripts/bot-ai.ts), so both drive the same way.
//
// Track features (M3): full throttle and straight onto a ramp, fast enough to clear the gap
// behind it (backing up for a longer run-up when it is too slow to make it), and a lane
// around the holes ahead.
//
// Surfaces and tyre mounds (M4-SURF, PLAN-M4 2.2-2.3): a lane-cost search (laneFor) replaces the
// plain hole lane. Holes and tyre mounds ahead are blocked (a lane must clear them, the nearest
// first, as the hole lane did, and the bot slows to HOLE_SPEED among them); water and dirt cost by
// car type (laneCost: a dirt patch the type's dirtDrag - 1 per unit, so the truck barely minds it;
// water WATER_COST scaled by the type's grip on it), so a bot leaves its racing line for the
// cheapest lane round a pool or a patch when one is free. With none of them ahead it is exactly
// the hole lane (the shipped tracks drive as before).
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
//
// Lightning cells (M4-CELLS, PLAN-M4 2.5): a Normal bot takes a cell that is there and within
// CELL_LANE of its lane: a ground cell when no ramp or hole is near, an air cell over the jump it
// is lining up for. Easy bots ignore them.
//
// Hard (M4-HARD, PLAN-M4 addendum 2026-11-21 and its binding advisor changes): the same car,
// physics, upgrades and ammo rules as everyone (no rubber band, no better stats); it only
// drives, shoots and shops better. Bend targets x HARD.corner, braking later and tighter, the
// aim lookahead scaled; an apex bias towards the inside of the bend ahead, only while the bot is
// on its own racing line (a hole lane, a ramp, the slipstream incl. a running pass and a cell all
// override it), never towards a mine; cells within HARD.cellLane; rivets only when the shot,
// fired straight along the heading with the car's velocity, would pass through the target (a
// fire gate: it never steers to aim); a mine when a solid car follows in its wake at a distance
// where it arrives just after the mine arms. The slipstream and the no-ramming rule as Normal.

import { CARS, DEFAULT_CAR, type CarType } from "./cars";
import { angleDiff, CAR_LENGTH, CAR_RADIUS, CAR_WIDTH, clamp, DT, speedOf, type CarState, type CarStats } from "./physics";
import { LIP_ZONE, pointAt, queryTrackNear, SURF_DIRT, SURF_WATER, type Ramp, type Track } from "./track";
import { airTicksFor, MIN_TAKEOFF_SPEED, MINE_ARM_TICKS, RIVET_RADIUS, RIVET_RANGE, RIVET_SPEED, WEAPONS_ARM_MS } from "./weapons";

export type BotLevel = "easy" | "normal" | "hard";
export const BOT_LEVELS: readonly BotLevel[] = ["easy", "normal", "hard"];

export function isBotLevel(v: unknown): v is BotLevel {
  return v === "easy" || v === "normal" || v === "hard";
}

/** Easy: throttle cap away from ramps, and the share of Normal's corner speeds. */
export const EASY_THROTTLE = 0.85;
export const EASY_CORNER = 0.9;

/**
 * Hard (see the top of this file). Tuned with tools/debug/hard-tune.ts (2026-11-21) to the band
 * the user picked: on every shipped track and car type, alone and weapons off, Hard's lap closes
 * 40-55 % of the gap between Normal's lap and the flat-out ceiling (the Normal driver never
 * braking for a bend: CORNER_SCALE = 3). Measured 41.5-53.6 %, with no fall, wall contact or dirt
 * (sim-test "hard pace"). An object so the tuner can sweep them; the game never changes them.
 */
export const HARD = {
  /** Bend targets (200/260/330 u/s by sharpness) times this. */
  corner: 1.05,
  /** Brake above target + this (Normal: 25), coast between the target and it: braking tighter. */
  brakeBand: 15,
  /** The bend lookahead (Normal: max(120, 0.9 v) past 20 ahead) times this: braking starts later. */
  bendLook: 0.84,
  /** The aim point's lookahead (Normal: 55 + 0.3 v) times this (1 measured best with the apex bias). */
  aimLook: 1,
  /** Apex bias: the racing line moves this far towards the inside of the bend ahead ... */
  apex: 20,
  /** ... once the bend ahead turns more than this (radians), fully from apexFull on. */
  apexFrom: 0.3,
  apexFull: 0.9,
  /** A mine this close (track coordinates) to the apex line, up to APEX_MINE_LOOK ahead, keeps the bot on its line. */
  apexMineClear: 26,
  /** Cells within this of its lane (Normal CELL_LANE 30); below 58, the kerb cells' distance from lane 0. */
  cellLane: 45,
  /**
   * Rivets: fire when the shot's path passes the target's centre within CAR_RADIUS + RIVET_RADIUS
   * (a hit) plus this: a little wider than a hit, so some shots miss (the user, 2026-11-21: "add a
   * little miss"; about 3 in 4 hit in bot traffic, Normal's cone about 3 in 5).
   */
  rivetSlack: 2.5,
  /** Mines: a follower at least 0.4 x its speed + mineNear behind (it arrives as the mine arms) ... */
  mineNear: 10,
  /** ... at most this far behind ... */
  mineFar: 300,
  /** ... and on the bot's line (across, track coordinates) within this. */
  mineAcross: 14,
  /** Steps between two mines at least (4 s). */
  mineGap: 240,
};

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
/** Cells (M4-CELLS): a Normal bot goes for one within CELL_LANE of its lane, CELL_LOOK ahead at most. */
const CELL_LANE = 30;
const CELL_LOOK = 320;
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
  // The lightning cells (M4-CELLS): the race tick each comes back (track.cells order, 0 = there)
  // and the race tick now. Absent: no cells.
  cells?: readonly number[];
  rt?: number;
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
  /** Hard: the race step it last dropped a mine (-Infinity: none this race). */
  lastMine: number;
}

/**
 * A bot's memory. The mine offset defaults to the one the socket bots always used (from the
 * lane); server seats pass one by seat so two bots on mirrored lanes do not drop together.
 */
export function newBotMem(lateral: number, level: BotLevel = "normal", mineOffset = Math.round(Math.abs(lateral) * 7) % 480): BotMem {
  return { level, lateral, weapons: level !== "easy", mineOffset, slow: 0, reversing: 0, backup: null, backedUpFor: -1, useWake: level !== "easy", wake: null, wakeRest: 0, lastMine: -Infinity };
}

/** Forget the race (between races): the settings stay. */
export function resetBotMem(mem: BotMem): void {
  mem.slow = 0;
  mem.reversing = 0;
  mem.backup = null;
  mem.backedUpFor = -1;
  mem.wake = null;
  mem.wakeRest = 0;
  mem.lastMine = -Infinity;
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

/** A water pool's lane cost per unit of it ahead for the Sport (laneCost); a type with less grip on it pays more. */
export const WATER_COST = 1.5;
/** A lane counts as on a surface when the car's centre passes within this of its rectangle. */
const SURFACE_MARGIN = 4;
/** A tyre mound stays in the lane search until the car's centre is this far past its edge (half a car + 1). */
const MOUND_BEHIND = 16;
/** A lane round a blocker on the verge keeps this far (plus half a car) off the wall. */
const VERGE_LANE_MARGIN = 10;

/**
 * The lane cost of a surface per unit of it ahead, by car type (M4-SURF): a dirt patch costs its
 * drag over asphalt's (dirtDrag - 1: Sport 1.9, Racer 2.6, Truck 0.6), a pool WATER_COST times
 * sqrt(Sport's dirt grip / the type's) (its grip on water is a third of the dirt grip: Sport 1.5,
 * Racer 1.67, Truck 1.18). A belt costs nothing (the bot steers against its drift).
 */
export function laneCost(kind: number, stats: CarStats): number {
  if (kind === SURF_DIRT) return stats.dirtDrag - 1;
  if (kind === SURF_WATER) return WATER_COST * Math.sqrt(CARS.sport.base.dirtGrip / stats.dirtGrip);
  return 0;
}

/** A blocked spot ahead: a hole or a tyre mound (lateral offset, radius), d = how far until it is behind the car. */
interface Blocker {
  lat: number;
  r: number;
  d: number;
}

/**
 * The bot's lane through what lies ahead of s (M4-SURF, the lane-cost search that replaces
 * holeLane in botControls): holes and tyre mounds within `look` are blocked, the nearest first (the
 * lane nearest `pref` that clears as many of the nearest ones as it can, as holeLane); among the
 * lanes that clear as many, the one whose water and dirt within `look` cost least (laneCost),
 * then the nearest `pref`. With a blocker ahead the lanes reach onto the verge (each costs the dirt
 * it is over the whole look), so a car pushed to the outside of a mound goes round it there. With no
 * blocker ahead the search starts from `racing` (the racing line), stays on the asphalt and moves
 * only when the racing line costs something (`dodge`). With neither a mound nor a surface ahead it
 * is holeLane exactly. `holes`: how many blockers are ahead (0 = none).
 */
export function laneFor(track: Track, s: number, seg: number, look: number, pref: number, racing: number, stats: CarStats): { lane: number; holes: number; dodge: boolean } {
  const tyres = track.tyres, surfaces = track.surfaces;
  // The mounds and the surfaces ahead (from the segment's start indices; nothing on a plain track).
  let mounds: Blocker[] | null = null;
  for (let k = track.tyresFrom[seg] ?? tyres.length; k < tyres.length; k++) {
    const m = tyres[k];
    // Behind once the car's rear is past it (a hole stays in view r + 30: a fall costs more).
    const d = ahead(track, s - m.r - MOUND_BEHIND, m.s) - m.r - MOUND_BEHIND;
    if (d > look + 2 * m.r + 60) break; // sorted by s: the rest are further
    if (d < look) (mounds ??= []).push({ lat: m.lat, r: m.r, d });
  }
  let spans: { lat0: number; lat1: number; len: number; cost: number }[] | null = null;
  const end = s + look;
  for (let k = track.surfFrom[seg] ?? surfaces.length; k < surfaces.length && surfaces[k].s0 < end; k++) {
    const f = surfaces[k];
    const len = Math.min(f.s1, end) - Math.max(f.s0, s);
    const cost = laneCost(f.kind, stats);
    if (len > 0 && cost > 0) (spans ??= []).push({ lat0: f.lat0 - SURFACE_MARGIN, lat1: f.lat1 + SURFACE_MARGIN, len, cost });
  }
  if (!mounds && !spans) return { ...holeLane(track, s, look, pref), dodge: false };
  const near: Blocker[] = track.holes
    .map((h) => ({ lat: h.lat, r: h.r, d: ahead(track, s - h.r - 30, h.s) - h.r - 30 }))
    .filter((x) => x.d < look);
  if (mounds) near.push(...mounds);
  near.sort((a, b) => a.d - b.d);
  // On the asphalt; with a blocker ahead the verge too (costed as the dirt it is), so a car on the
  // outside of a mound goes round it there rather than back across it.
  const road = track.def.halfWidth - CAR_WIDTH / 2;
  const max = near.length ? track.wall - CAR_WIDTH / 2 - VERGE_LANE_MARGIN : road;
  const verge = laneCost(SURF_DIRT, stats) * look;
  const clears = (lat: number) => {
    let n = 0;
    while (n < near.length && Math.abs(lat - near[n].lat) > near[n].r + HOLE_CLEARANCE) n++;
    return n;
  };
  const costOf = (lat: number) => {
    let c = Math.abs(lat) > road ? verge : 0;
    if (spans) for (const p of spans) if (lat > p.lat0 && lat < p.lat1) c += p.len * p.cost;
    return c;
  };
  const from = near.length ? pref : racing;
  let best = clamp(from, -max, max), bestN = clears(best), bestC = costOf(best);
  if (!near.length && bestC === 0) return { lane: racing, holes: 0, dodge: false };
  for (let k = 2; k <= 2 * max && !(bestN === near.length && bestC === 0); k += 2) {
    for (const lat of [from - k, from + k]) {
      if (Math.abs(lat) > max) continue;
      const n = clears(lat);
      if (n < bestN) continue;
      const c = costOf(lat);
      if (n > bestN || c < bestC) {
        best = lat;
        bestN = n;
        bestC = c;
      }
    }
  }
  return { lane: best, holes: near.length, dodge: true };
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

/**
 * The lane to a cell worth taking, or null: the nearest cell ahead (CELL_LOOK at most) that is there
 * at the race tick and within CELL_LANE of `lane`. On a ramp approach (toLip >= 0) only an air cell
 * past that lip (the jump it is lining up for); otherwise only a ground cell. max: the furthest a
 * lane may lie from the centerline (the car's centre gets within reach of a kerb cell from there).
 */
function cellLane(view: BotView, s: number, lane: number, toLip: number, max: number, reach = CELL_LANE): number | null {
  const cells = view.track.cells, back = view.cells!;
  const rt = view.rt ?? 0;
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!(back[i] === 0 || rt >= (back[i] ?? 0))) continue;
    if (Math.abs(c.lat - lane) > reach) continue;
    const d = ahead(view.track, s, c.s);
    if (d > CELL_LOOK + (c.air ? 400 : 0) || d < 10) continue;
    if (toLip >= 0 ? !c.air || d < toLip : c.air) continue;
    if (d < bestD) {
      best = clamp(c.lat, -max, max);
      bestD = d;
    }
  }
  return best;
}

/**
 * Hard's apex lane: its racing line `lateral` moved towards the inside of the bend ahead (`turn`:
 * the heading change over the bend lookahead, + = right), by HARD.apex once it turns HARD.apexFull,
 * from nothing at HARD.apexFrom; kept 6 units inside the asphalt edge. Per seat: every bot moves
 * its own line by the same amount, so three bots do not converge on one inside lane.
 */
export function apexLane(lateral: number, turn: number, halfWidth: number): number {
  const bend = Math.abs(turn);
  if (bend <= HARD.apexFrom) return lateral;
  const k = Math.min(1, (bend - HARD.apexFrom) / (HARD.apexFull - HARD.apexFrom));
  const max = halfWidth - CAR_WIDTH / 2 - 6;
  return clamp(lateral + Math.sign(turn) * HARD.apex * k, -max, max);
}

/** Track coordinates of a point near the track `de` (about) ahead of s: its s and lateral offset (+ = right of travel). */
function trackCoords(track: Track, s: number, de: number, x: number, y: number): { s: number; lat: number; h: number; dist: number } {
  const q = queryTrackNear(track, x, y, pointAt(track, s + de).seg);
  const p = pointAt(track, q.s);
  return { s: q.s, lat: (x - p.x) * -Math.sin(p.h) + (y - p.y) * Math.cos(p.h), h: p.h, dist: q.dist };
}

/** Hard's apex check: no mine from 10 behind to APEX_MINE_LOOK ahead within reach of the lanes between `a` and `b`. */
const APEX_MINE_LOOK = 320;
function apexMineFree(view: BotView, c: CarState, s: number, a: number, b: number): boolean {
  const mines = view.mines;
  if (!mines || !mines.length) return true;
  const lo = Math.min(a, b) - HARD.apexMineClear, hi = Math.max(a, b) + HARD.apexMineClear;
  const far2 = (APEX_MINE_LOOK + 40) ** 2;
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  for (const m of mines) {
    const d2 = (m.x - c.x) ** 2 + (m.y - c.y) ** 2;
    if (d2 > far2) continue; // pre-filter: only the mines near the car are put in track coordinates
    // Searched from about d ahead along the track; a mine behind the car's heading also from d
    // behind, the nearer of the two kept (searched only ahead, a mine some 280+ behind could be
    // put on the road ahead; ahead in a hairpin, a mine can lie behind the heading).
    const d = Math.sqrt(d2);
    let t = trackCoords(view.track, s, d, m.x, m.y);
    if ((m.x - c.x) * cos + (m.y - c.y) * sin < 0) {
      const back = trackCoords(view.track, s, -d, m.x, m.y);
      if (back.dist < t.dist) t = back;
    }
    const along = ahead(view.track, s, t.s);
    if ((along < APEX_MINE_LOOK || along > view.track.length - 10) && t.lat > lo && t.lat < hi) return false;
  }
  return true;
}

/**
 * Hard's rivet gate: would a rivet fired now (from the nose, along the heading, with the car's
 * velocity: weapons.ts spawnShot) pass a solid car ahead within a hit plus HARD.rivetSlack, the
 * car holding its velocity, within the rivet's range and over the road (a wall stops a rivet)?
 * A gate on relative velocity only: the bot never steers to aim.
 */
function rivetWouldHit(track: Track, s: number, c: CarState): (o: BotOther) => boolean {
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  const nose = CAR_LENGTH / 2 + 4;
  const sx = c.x + cos * nose, sy = c.y + sin * nose;
  const wx = c.vx + cos * RIVET_SPEED, wy = c.vy + sin * RIVET_SPEED; // the rivet's velocity
  const tMax = RIVET_RANGE / Math.hypot(wx, wy);
  const r = CAR_RADIUS + RIVET_RADIUS + HARD.rivetSlack;
  return (o) => {
    if (!o.solid) return false;
    const rx = o.x - sx, ry = o.y - sy;
    if (rx * cos + ry * sin <= 0 || rx * rx + ry * ry > (RIVET_RANGE + 60) ** 2) return false;
    const ux = wx - (o.vx ?? 0), uy = wy - (o.vy ?? 0);
    const t = (rx * ux + ry * uy) / (ux * ux + uy * uy); // seconds to the closest approach
    if (t <= 0 || t > tMax) return false;
    const mx = rx - ux * t, my = ry - uy * t;
    if (mx * mx + my * my > r * r) return false;
    // Over the road the whole way: halfway and where it meets the car.
    for (const f of [0.5, 1]) {
      const px = sx + wx * t * f, py = sy + wy * t * f;
      const q = queryTrackNear(track, px, py, pointAt(track, s + Math.hypot(px - c.x, py - c.y)).seg);
      if (q.dist > track.wall - RIVET_RADIUS) return false;
    }
    return true;
  };
}

/** Race steps before the weapons arm (WEAPONS_ARM_MS), plus one for the tick the race starts on. */
const ARM_STEPS = Math.ceil((WEAPONS_ARM_MS * 60) / 1000) + 1;

/**
 * Hard's mine gate: a solid car follows on the bot's line (track coordinates) at a distance where
 * it reaches the mine (dropped CAR_LENGTH / 2 + 12 behind) about as it arms (MINE_ARM_TICKS), at
 * most HARD.mineFar behind; the weapons armed and HARD.mineGap steps since the last one.
 */
function mineWouldCatch(view: BotView, mem: BotMem, c: CarState, s: number, lat: number): boolean {
  if (view.raceSteps <= ARM_STEPS || view.raceSteps - mem.lastMine < HARD.mineGap) return false;
  const far = HARD.mineFar + 30;
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  for (const o of view.others) {
    if (!o.solid) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    if (dx * cos + dy * sin >= 0 || dx * dx + dy * dy > far * far) continue; // behind, near: pre-filter
    const t = trackCoords(view.track, s, -Math.hypot(dx, dy), o.x, o.y);
    const d = ahead(view.track, t.s, s); // the follower's distance behind, along the track
    const vf = (o.vx ?? 0) * Math.cos(t.h) + (o.vy ?? 0) * Math.sin(t.h);
    if (vf < 100 || Math.abs(t.lat - lat) > HARD.mineAcross) continue;
    if (d >= (vf * MINE_ARM_TICKS) / 60 + HARD.mineNear && d <= HARD.mineFar) return true;
  }
  return false;
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
  const hard = mem.level === "hard";
  const track = view.track;
  const q = queryTrackNear(track, c.x, c.y, c.seg);
  const v = speedOf(c);
  const p = pointAt(track, q.s);
  const dir = p.h;
  const vf = c.vx * Math.cos(dir) + c.vy * Math.sin(dir); // speed along the track
  const lat = (c.x - p.x) * -Math.sin(dir) + (c.y - p.y) * Math.cos(dir); // + = right of travel

  // Holes and tyre mounds: the lane nearest the car's line that clears the next ones; slower
  // among them. Water and dirt: the cheapest lane for its car type (laneFor). With none of them
  // ahead the bot holds its own racing line (mem.lateral).
  const hole = laneFor(track, q.s, q.seg, 140 + v * 0.6, clamp(lat, mem.lateral - 24, mem.lateral + 24), mem.lateral, view.stats);
  let lane = hole.holes || hole.dodge ? hole.lane : mem.lateral;
  let look = hole.holes ? 40 + v * 0.25 : 55 + v * 0.3;
  if (hard) look *= HARD.aimLook;

  // A ramp coming up: full throttle, straight at it.
  const ramp = rampAhead(track, q.s, RAMP_APPROACH);
  if (!ramp) mem.backedUpFor = -1;
  const near = pointAt(track, q.s + 20).h;
  const far = pointAt(track, q.s + 20 + Math.max(120, v * 0.9) * (hard ? HARD.bendLook : 1)).h; // x 1: Normal's exact value
  const turn = angleDiff(near, far);
  const bend = Math.abs(turn);

  // The slipstream: follow a car ahead on a straight, then pass it (Normal only).
  let coast = false;
  if (mem.wakeRest > 0) mem.wakeRest--;
  if (mem.useWake && !easy && view.raceOn && !hole.holes && !hole.dodge && !ramp && !mem.backup && mem.reversing === 0) {
    const w = wakeLane(view, mem, c, p.x, p.y, dir, bend, track.def.halfWidth - CAR_WIDTH / 2 - 2);
    if (w) {
      lane = w.lane;
      coast = w.coast;
    }
  } else mem.wake = null;
  // A cell close to its lane (Normal): steer to it; it beats the slipstream.
  let cell = false;
  if (!easy && view.raceOn && view.cells && !hole.holes) {
    const cl = cellLane(view, q.s, lane, ramp ? ramp.toLip : -1, track.def.halfWidth - CAR_WIDTH / 2 - 2, hard ? HARD.cellLane : CELL_LANE);
    if (cl !== null) {
      lane = cl;
      coast = false;
      mem.wake = null;
      cell = true;
    }
  }
  // Hard's apex bias: only on its own racing line (a hole lane, a ramp, the slipstream and a cell
  // come first), towards the inside of the bend ahead, never onto a mine. mem.lateral stays.
  if (hard && HARD.apex > 0 && !hole.holes && !hole.dodge && !ramp && !mem.wake && !cell && view.raceOn && bend > HARD.apexFrom) {
    const apex = apexLane(mem.lateral, turn, track.def.halfWidth);
    if (apexMineFree(view, c, q.s, mem.lateral, apex)) lane = apex;
  }
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
  if (hard) target *= HARD.corner;
  if (hole.holes) target = Math.min(target, HOLE_SPEED);
  let throttle = v > target + (hard ? HARD.brakeBand : 25) ? -1 : v > target ? 0 : 1;
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
  if (armed && hard) {
    // Only when the rivet would hit (see rivetWouldHit); the weapons arm first (no rivet wasted).
    fire = view.raceSteps > ARM_STEPS && view.others.some(rivetWouldHit(track, q.s, c));
    // A mine when a car follows in its wake at the distance it arrives as the mine arms.
    const mine = mineWouldCatch(view, mem, c, q.s, lat);
    if (mine) mem.lastMine = view.raceSteps;
    return { throttle, steer, fire, mine };
  }
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
