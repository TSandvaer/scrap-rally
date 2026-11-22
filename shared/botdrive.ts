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
// Split lanes (M4-SURF part 2, PLAN-M4 2.6 B and advisor change 2): an island ahead or beside the bot
// (splitFor) makes it take one lane round it, the cheaper one for its car type (lane length plus the
// water or dirt filling it: the truck takes the dirt lane), the side of its seat's racing line on a tie
// (never the random id), and hold that lane, inside the asphalt, until it is past the island. Tyre
// mounds lock the side the bot is passing them on (MOUNDS, the M4-SURF-1 review's F1), and the lane
// search looks round the lap past the finish line (F2).
//
// What moves and the parked trucks (M4-MOVE, PLAN-M4 2.3-2.4): a row of rolling barrels is a blocker in
// the lane search where each barrel will be when the bot gets to the row (barrelLat at the race tick it
// arrives, padded by how long it takes to pass and how sure the arrival is: MOVE), so it takes a gap
// between them; a crusher press is a blocker across its width when it will be down while the bot
// passes under it (pressDown over the same window), so it takes the open side, and where no lane is
// open it brakes and waits short of the press until it will be up. A parked truck: from MOVE.truckLook
// before its rear the bot decides once (BotMem.truckS) whether it jumps it: when its seat's racing line
// lies in the band (advisor change 2: by seat; with the server's six lines 12 apart, one or two seats) and
// no other car is on the band ahead of it or level (bandTaken: the band takes one car at a time, the one
// behind gives the jump up while the rear is MOVE.truckYield away) and it will arrive in the
// band at TRUCK_MIN_SPEED + MOVE.truckMargin or faster (a ramp approach: full throttle up the middle of
// the band, its usual aim point: the band is narrow, a far aim would not bring it in), or else goes round
// it (a blocker); a jump given up after a bump goes round.
// The lane round any of them is the lane search's, nearest the seat's racing line (advisor change 2).
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
//
// Hard's human mistakes (HARD-2, PLAN-M4 addendum 2026-11-22 and its binding advisor changes): now
// and then a late brake into a bend (the brake trigger's lookahead shortened, then braking below the
// bend's speed: it arrives fast and scrubs), a wide line (the apex bias turned to the outside), a
// wobble after a landing (a few ticks of over-correcting steer, decaying) and a hesitation after an
// overtake or a hit (a short lift: BotView.hp, fed by both adapters). Drawn from a hash of (BotMem.seed, BotView.lap, the segment, the kind of
// moment), never Math.random or the random id, so a rerun is identical; latched for the bend (or the
// few ticks) in BotMem.mistake. Only on its own racing line, with no hole, mound, surface, ramp, gap,
// island, truck or mover within MISTAKE_LOOK (longer than RAMP_APPROACH plus a mistake's length), and
// ended at once when anything of advisor change 4 comes up, so a mistake never carries into a jump or
// a hole. BotMem.hard holds the constants for the race (HARD itself by default; a room's dev tune is
// its own object, hardParams); mistakeRate 0, the default, runs none of it.
//
// Shortcut roads (BR-BOTS, PLAN-BRANCH.md 2.6, its advisor changes 4 and 6, user decision 3): on a track
// with branches each bot drives a route, the main road with the shortcuts it takes spliced in, as one
// closed road of its own (Route.ring, routeOf). Every look-ahead above (the aim point, the bend, ramps,
// holes, mounds, surfaces, islands, trucks, what moves, cells, a mistake's clear road) runs on that ring,
// so it walks the route and never the queried road: before a fork the bot sees the shortcut's features
// ahead, on a shortcut the main road's past the merge, and in a mouth (where the physics' road can flip
// under the car) it holds the route's road. Which shortcuts (routePlan, once per race, by seat, car type
// and level, never the random id): see ROUTE. Without branches none of it runs (the ring is the track).

import { CARS, DEFAULT_CAR, type CarType } from "./cars";
import { angleDiff, CAR_LENGTH, CAR_RADIUS, CAR_WIDTH, clamp, DT, speedOf, type CarState, type CarStats } from "./physics";
import {
  BARREL_R,
  barrelLat,
  halfOf,
  halfOn,
  islandAt,
  ISLAND_NOSE,
  LIP_ZONE,
  MOUTH_CLEAR,
  pointAt,
  PRESS_DEPTH,
  pressDown,
  queryMain,
  roadOfSeg,
  segCount,
  SURF_DIRT,
  SURF_WATER,
  TRUCK_BAND,
  TRUCK_HALF,
  TRUCK_MIN_SPEED,
  wallOf,
  type Gap,
  type PlacedBarrels,
  type PlacedBranch,
  type PlacedCell,
  type PlacedHole,
  type PlacedIsland,
  type PlacedPress,
  type PlacedTruck,
  type PlacedTyres,
  type Ramp,
  type Surface,
  type Track,
  type TrackQuery,
  type Vec,
  type Widen,
} from "./track";
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
  /**
   * HARD-2: mistakes per lap per bot (the expected number, spread over the lap's bends and landings
   * where one may happen: mistakeSpots). 0: none, and none of the mistake code runs (Hard drives
   * exactly as before HARD-2). The user tunes it on a dev copy (SCRAP_DEV_BOTS, the Bot tune panel).
   */
  mistakeRate: 0,
  /** HARD-2: a mistake's size, 0..1 (each one 0.75-1.25 x this, at most 1). */
  mistakeSize: 0.5,
};

/** Hard's constants as one bot reads them (BotMem.hard): HARD itself, or a room's dev tune (hardParams). */
export type HardParams = typeof HARD;

/**
 * The dev Bot tune knob (HARD-2, SCRAP_DEV_BOTS): Hard's mistake rate (per lap) and size, its pace
 * (1 = today's Hard bend pace, 0 = Normal's: corner, brakeBand and bendLook only; the apex, cells,
 * weapons and shopping stay Hard's) and its rivet aim (HARD.rivetSlack: wider misses more).
 */
export interface BotTune {
  rate: number;
  size: number;
  pace: number;
  aim: number;
}

/** The knob's ranges (a message's values are clamped into them). */
export const BOT_TUNE_RANGE: Readonly<Record<keyof BotTune, readonly [number, number]>> = {
  rate: [0, 3],
  size: [0, 1],
  pace: [0, 1],
  aim: [0, 20],
};

/** The knob at today's Hard (HARD's own values): what a room tunes from. */
export function botTuneDefaults(): BotTune {
  return { rate: HARD.mistakeRate, size: HARD.mistakeSize, pace: 1, aim: HARD.rivetSlack };
}

/** A knob from the wire: every value a finite number (else null), clamped into BOT_TUNE_RANGE. */
export function cleanBotTune(v: unknown): BotTune | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const out = {} as BotTune;
  for (const k of Object.keys(BOT_TUNE_RANGE) as (keyof BotTune)[]) {
    const x = r[k];
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out[k] = clamp(x, BOT_TUNE_RANGE[k][0], BOT_TUNE_RANGE[k][1]);
  }
  return out;
}

/** Normal's brake band and the bend lookahead factor (botControls: 25, x 1): the pace knob's 0. */
const NORMAL_BRAKE_BAND = 25;

/**
 * Hard's constants for a race tuned with the knob: a new object (HARD is never changed). Pace 1 is
 * HARD's corner, brakeBand and bendLook themselves (no interpolation: bit for bit today's Hard);
 * pace 0 is Normal's 1, 25 and 1.
 */
export function hardParams(t: BotTune): HardParams {
  const p = t.pace;
  return {
    ...HARD,
    corner: p === 1 ? HARD.corner : 1 + (HARD.corner - 1) * p,
    brakeBand: p === 1 ? HARD.brakeBand : NORMAL_BRAKE_BAND + (HARD.brakeBand - NORMAL_BRAKE_BAND) * p,
    bendLook: p === 1 ? HARD.bendLook : 1 + (HARD.bendLook - 1) * p,
    rivetSlack: t.aim,
    mistakeRate: t.rate,
    mistakeSize: t.size,
  };
}

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
  /** Laps the car has completed (HARD-2: a mistake's draw). Absent: 0. */
  lap?: number;
  /** The car's hit points (HARD-2: a drop is a hit, a moment a hesitation may follow). Absent: no hits seen. */
  hp?: number;
}

/** HARD-2: the kinds of Hard's mistakes (see the top of this file). */
export type MistakeKind = "late-brake" | "wide" | "wobble" | "hesitate";
export const MISTAKE_KINDS: readonly MistakeKind[] = ["late-brake", "wide", "wobble", "hesitate"];

/** HARD-2: a mistake under way, latched when it begins (BotMem.mistake). */
export interface Mistake {
  kind: MistakeKind;
  size: number; // 0..1
  from: number; // the s it began at
  end: number; // the s it ends at (or earlier: after n steps, or when an exclusion comes up)
  delay: number; // a late brake: how far past `from` the bend is seen (0 for the others)
  t: number; // steps since it began
  n: number; // steps it lasts at most
  sign: number; // a wobble's first swing (+1 right)
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
  /** Split lanes: steps left backing off an island it was pressed against or nosing into (at most SPLIT.backMax) ... */
  islandBack: number;
  /** ... which way (BACK_SIDE, BACK_NOSE) and toward which lane (-1 left, +1 right) ... */
  islandKind: number;
  islandSide: number;
  /** ... and steps left with the nose's back-off off (SPLIT.cool). */
  islandCool: number;
  /** M4-MOVE: the truck (its s) it has decided about on this approach (-1: none), and whether it jumps it. */
  truckS: number;
  truckJump: boolean;
  /** HARD-2: its mistakes' seed (server: the seat slot; a socket bot: from its lane), a setting. */
  seed: number;
  /** HARD-2: Hard's constants for this race (HARD itself by default; a room's dev tune: hardParams, set at beginRace). */
  hard: HardParams;
  /** HARD-2: the mistake under way, or null. */
  mistake: Mistake | null;
  /** HARD-2: in a bend (the bend-entry latch's hysteresis) ... */
  inBend: boolean;
  /** ... and in the air last step (a landing: the c.air edge) ... */
  flew: boolean;
  /** ... and its hit points last step (BotView.hp; -1: none seen yet), for a hit's edge. */
  hp: number;
  /** HARD-2: told of each mistake as it begins (the dev flag's server log; the tests), or null. */
  onMistake: ((kind: MistakeKind, size: number, s: number, lap: number) => void) | null;
  /** BR-BOTS: its seat (server: the slot; a socket bot: seatOfLane), a setting: which shortcuts it takes (routePlan). */
  seat: number;
  /** BR-BOTS: the shortcuts it takes this race (bit b: branch b; routePlan), -1 until its first step on a track with branches ... */
  plan: number;
  /** ... on this track. */
  planTrack: Track | null;
  /** BR-BOTS: the route it drives now (bit b: branch b): the plan, but a jump given up at its fork, or the car's road past a gore. */
  route: number;
  /** BR-BOTS: the forks it has committed at on this pass (bit b), released once it is out of the fork's zone (routeStep). */
  forkDone: number;
}

/** The server's racing lines by seat (server/bots.ts; botplay's bots use them in order). */
export const BOT_LANES: readonly number[] = [-24, 24, 0, -12, 12, -36];

/** A socket bot's seat (BR-BOTS: its shortcuts, routePlan) from its lane: the seat that races on it, else the lane's twelfths round six seats. */
export function seatOfLane(lateral: number): number {
  const i = BOT_LANES.indexOf(lateral);
  return i >= 0 ? i : ((Math.round(lateral / 12) % BOT_LANES.length) + BOT_LANES.length) % BOT_LANES.length;
}

/**
 * A bot's memory. The mine offset defaults to the one the socket bots always used (from the
 * lane); server seats pass one by seat so two bots on mirrored lanes do not drop together. The
 * mistakes' seed likewise (HARD-2): from the lane, signed (mirrored lanes differ); a seat's slot.
 * The seat (BR-BOTS) likewise: a socket bot's from its lane (seatOfLane), a server seat's slot.
 */
export function newBotMem(
  lateral: number, level: BotLevel = "normal", mineOffset = Math.round(Math.abs(lateral) * 7) % 480, seed = Math.round(lateral * 7), seat = seatOfLane(lateral),
): BotMem {
  return {
    level, lateral, weapons: level !== "easy", mineOffset, slow: 0, reversing: 0, backup: null, backedUpFor: -1, useWake: level !== "easy", wake: null, wakeRest: 0, lastMine: -Infinity,
    islandBack: 0, islandKind: 0, islandSide: 0, islandCool: 0, truckS: -1, truckJump: false,
    seed, hard: HARD, mistake: null, inBend: false, flew: false, hp: -1, onMistake: null,
    seat, plan: -1, planTrack: null, route: 0, forkDone: 0,
  };
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
  mem.islandBack = 0;
  mem.islandKind = 0;
  mem.islandSide = 0;
  mem.islandCool = 0;
  mem.truckS = -1;
  mem.truckJump = false;
  mem.mistake = null;
  mem.inBend = false;
  mem.flew = false;
  mem.hp = -1;
  // BR-BOTS: the route is chosen again (once per race: the stats may have changed in the garage).
  mem.plan = -1;
  mem.planTrack = null;
  mem.route = 0;
  mem.forkDone = 0;
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
 * the lane clears as many of the nearest ones as it can (the rest come next). `half`: the road's
 * asphalt half-width (BR-BOTS: a route's leg's; the track's by default).
 */
export function holeLane(track: Track, s: number, look: number, pref: number, half = track.def.halfWidth): { lane: number; holes: number } {
  const near = track.holes
    .map((h) => ({ h, d: ahead(track, s - h.r - 30, h.s) - h.r - 30 })) // until it is behind the car
    .filter((x) => x.d < look)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.h);
  if (!near.length) return { lane: pref, holes: 0 };
  const max = half - CAR_WIDTH / 2;
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
/** A tyre mound is a blocker in the lane search until the car's centre is this far past its edge (half a car + 1). */
const MOUND_BEHIND = 16;
/**
 * Side locks (M4-SURF part 2, the M4-SURF-1 review's F1). The search used to drop every later mound
 * for a while after passing one, which by chance kept a bot on its side; seeing them at once, it
 * crossed in front of the next mound for a cheaper lane (one on the asphalt rather than the verge)
 * with too little road left, or turned its rear into the one just passed. Now a mound from
 * MOUNDS.commit ahead of the car's centre until that centre is MOUNDS.hold past its edge holds the
 * lane on the side of it the car is on: the bot keeps its side until it is clear, and the mounds
 * after it are in the search all the while. Tuned on the Surf Yard (tools/debug/split-tune.ts
 * --mounds). An object so the tuner can sweep it; the game never changes it.
 */
export const MOUNDS = { commit: 160, hold: 32 };
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

/** A blocked spot ahead: a hole or a tyre mound (lateral offset, radius), d = how far until it is behind the car (M4-MOVE: a barrel, a press, a truck: moverBlockers). */
export interface Blocker {
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
 * is holeLane exactly. `holes`: how many blockers are ahead (0 = none). `half`, `wall`: the road's asphalt
 * half-width and wall (BR-BOTS: a route's leg's; the track's by default).
 */
export function laneFor(
  track: Track, s: number, seg: number, look: number, pref: number, racing: number, stats: CarStats, span: SplitSpan | null = null, lat = pref,
  extra: readonly Blocker[] | null = null, nExtra = extra ? extra.length : 0, half = track.def.halfWidth, wall = track.wall,
): { lane: number; holes: number; dodge: boolean } {
  const tyres = track.tyres, surfaces = track.surfaces;
  const L = track.length;
  // The mounds and the surfaces ahead (from the segment's start indices, on round the lap past the
  // finish line: M4-SURF part 2, the review's F2; nothing on a plain track).
  let mounds: Blocker[] | null = null;
  // The side locks (MOUNDS), nearest first: each keeps the lane on the car's side of its mound
  // unless that leaves no lane with the nearer ones.
  let holdLo = -Infinity, holdHi = Infinity;
  const nT = tyres.length;
  if (nT > 0) {
    const k0 = track.tyresFrom[seg] ?? nT;
    for (let j = 0; j < nT; j++) {
      const m = tyres[(k0 + j) % nT];
      let d = m.s - s; // how far ahead of the car (the nearer way round the lap)
      if (d < -L / 2) d += L;
      else if (d >= L / 2) d -= L;
      // Behind once the car's rear is past it (a hole stays in view r + 30: a fall costs more); held a while longer.
      const locked = d < -(m.r + MOUND_BEHIND) ? d >= -(m.r + MOUNDS.hold) : d < MOUNDS.commit;
      if (locked) {
        const lo = lat < m.lat ? holdLo : Math.max(holdLo, m.lat + m.r + HOLE_CLEARANCE);
        const hi = lat < m.lat ? Math.min(holdHi, m.lat - m.r - HOLE_CLEARANCE) : holdHi;
        if (lo <= hi) {
          holdLo = lo;
          holdHi = hi;
        }
      }
      if (d < -(m.r + MOUND_BEHIND)) continue;
      if (d > look + 2 * m.r + 60) break; // in order round the lap: the rest are further
      if (d < look) (mounds ??= []).push({ lat: m.lat, r: m.r, d });
    }
  }
  const held = holdLo > -Infinity || holdHi < Infinity;
  let spans: { lat0: number; lat1: number; len: number; cost: number }[] | null = null;
  const end = s + look;
  const nS = surfaces.length;
  if (nS > 0) {
    const k0 = track.surfFrom[seg] ?? nS;
    for (let j = 0; j < nS; j++) {
      const k = k0 + j;
      const f = surfaces[k % nS];
      const lap = k >= nS ? L : 0; // the ones past the finish line, a lap on
      if (f.s0 + lap >= end) break; // sorted by s0 round the lap from surfFrom
      const len = Math.min(f.s1 + lap, end) - Math.max(f.s0 + lap, s);
      const cost = laneCost(f.kind, stats);
      if (len > 0 && cost > 0) (spans ??= []).push({ lat0: f.lat0 - SURFACE_MARGIN, lat1: f.lat1 + SURFACE_MARGIN, len, cost });
    }
  }
  if (!mounds && !spans && !span && !held && nExtra === 0) return { ...holeLane(track, s, look, pref, half), dodge: false };
  const near: Blocker[] = track.holes
    .map((h) => ({ lat: h.lat, r: h.r, d: ahead(track, s - h.r - 30, h.s) - h.r - 30 }))
    .filter((x) => x.d < look);
  if (mounds) near.push(...mounds);
  for (let i = 0; i < nExtra; i++) near.push(extra![i]); // M4-MOVE: barrels, presses and a truck to go round (moverBlockers)
  near.sort((a, b) => a.d - b.d);
  // On the asphalt; with a blocker ahead the verge too (costed as the dirt it is), so a car on the
  // outside of a mound goes round it there rather than back across it. In a split (span): inside
  // the lane it takes round the island (all asphalt).
  const road = span ? Infinity : half - CAR_WIDTH / 2;
  const max = near.length ? wall - CAR_WIDTH / 2 - VERGE_LANE_MARGIN : half - CAR_WIDTH / 2;
  let lo = span ? span.lo : -max, hi = span ? span.hi : max;
  if (held && Math.max(lo, holdLo) <= Math.min(hi, holdHi)) {
    lo = Math.max(lo, holdLo);
    hi = Math.min(hi, holdHi);
  }
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
  const from = span ? clamp(near.length ? pref : span.racing, lo, hi) : near.length ? pref : racing;
  let best = clamp(from, lo, hi), bestN = clears(best), bestC = costOf(best);
  if (!near.length && bestC === 0) return span || held ? { lane: best, holes: 0, dodge: true } : { lane: racing, holes: 0, dodge: false };
  for (let k = 2; k <= hi - lo && !(bestN === near.length && bestC === 0); k += 2) {
    for (const lat of [from - k, from + k]) {
      if (lat < lo || lat > hi) continue;
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

// ---- split lanes (M4-SURF part 2, PLAN-M4.md 2.6 B and advisor change 2) -------------------
// An island ahead (within the lane search's look) or beside the bot: it takes one lane round it,
// chosen per seat and car type and never by the random id (splitSide), and keeps inside that lane
// until it is past the island (SplitSpan: laneFor searches only there, and botControls holds the
// final lane inside it and inside the asphalt at the aim point, so the bot follows the road's edge
// out into the lane and back in). From SPLIT.commit before the island's head on it keeps the
// side it is on (a bumped bot never cuts across a nose).

/** The lane a bot takes round an island: its lateral range (lo..hi, + = right of travel), its racing line there, the side. */
export interface SplitSpan {
  lo: number;
  hi: number;
  racing: number;
  side: number; // -1 the left lane, +1 the right one
  isle: PlacedIsland;
}

/** Split lanes (see above). An object so the tuner can sweep it; the game never changes it. */
export const SPLIT = {
  /** The car's centre keeps this far off the island's side (half a car + 8, as a hole's HOLE_CLEARANCE) ... */
  clear: CAR_WIDTH / 2 + 8,
  /** ... and this far inside the asphalt's edge. */
  edge: CAR_WIDTH / 2 + 6,
  /** Lanes whose costs (units) differ by less than this are a tie: the seat decides. */
  tie: 40,
  /** From this far before the island's head the bot keeps the side it is on. */
  commit: 60,
  /** The island stays in view until the car's centre is this far past its tail (its rear clear of the nose). */
  past: 24,
  /**
   * An island comes into view this far ahead plus lookPerSpeed x the speed (~620 at 400 u/s; the lane
   * search's own look is 140 + 0.6 v): the bot heads for its lane early, so two bots swapping sides
   * have room to get past each other before the nose.
   */
  look: 140,
  lookPerSpeed: 1.2,
  /**
   * Backing off (after a spin or a bump; BotMem.islandBack). At low speed a car turns slowly: driving
   * on it would scrape along an island's side, or bounce off its nose again and again.
   * - Pressed against a side with its heading turned into it more than `into` (radians): brake and
   *   reverse with full lock toward its lane (rolling backwards the nose swings away from the
   *   island) for at least `backMin` steps and until it is turned in less than `into` / 2 or 12 off
   *   the side.
   * - In front of a nose (`nose` plus its braking distance) inside the island's width (plus half a
   *   car), on a heading that does not take it into its lane before its front reaches the nose: brake
   *   and reverse straight back along the
   *   track (as a ramp's back-up) until the head is `noseClear` ahead, then drive on; the nose's back-
   *   off is off for `cool` steps after (it turns out, or clips the nose's rounded corner once).
   * At most `backMax` steps either way.
   */
  into: 0.35,
  nose: 34,
  noseClear: 70,
  backMin: 15,
  backMax: 60,
  cool: 90,
};

/** How far ahead of s island `isle`'s head is (the nearer way round the lap; < 0 = past it). */
function headAhead(track: Track, isle: PlacedIsland, s: number): number {
  let d0 = isle.s0 - s;
  const L = track.length;
  if (d0 < -L / 2) d0 += L;
  else if (d0 >= L / 2) d0 -= L;
  return d0;
}

/** Backing-off kinds (BotMem.islandKind). */
const BACK_SIDE = 1, BACK_NOSE = 2;

/**
 * Should a bot back off island `isle`, taking the lane on `side` (-1 left, +1 right) of it, at
 * (s, lat) with heading dh off the track's (+ = turned right) and speed vf along it? BACK_NOSE in
 * front of its nose (SPLIT.nose plus its braking distance) on a heading that does not take it into the
 * lane first (unless `noNose`), BACK_SIDE pressed against its side turned into it, 0 neither.
 */
function islandPinned(track: Track, isle: PlacedIsland, side: number, s: number, lat: number, dh: number, noNose: boolean, vf: number): number {
  const d0 = headAhead(track, isle, s);
  const lo = isle.lat0 - CAR_WIDTH / 2, hi = isle.lat1 + CAR_WIDTH / 2;
  // Within SPLIT.nose of the head, plus the braking distance at its speed along the track (stepCar's BRAKE 900).
  const reach = SPLIT.nose + (Math.max(0, vf) ** 2) / (2 * 900);
  if (d0 > -ISLAND_NOSE / 2 && d0 < reach && lat > lo - 2 && lat < hi + 2) {
    if (noNose) return 0;
    // Does its heading take the car's centre past the side's limit before its front reaches the nose?
    const need = side < 0 ? lat - lo + 2 : hi - lat + 2;
    const room = d0 - CAR_LENGTH / 2;
    return room > 0 && room * Math.tan(clamp(side * dh, 0, 1.2)) >= need ? 0 : BACK_NOSE;
  }
  const along = -d0; // past the head
  if (along < ISLAND_NOSE / 2 || along > isle.s1 - isle.s0 - ISLAND_NOSE / 2) return 0;
  return (Math.abs(lat - lo) < 1 && dh > SPLIT.into) || (Math.abs(lat - hi) < 1 && dh < -SPLIT.into) ? BACK_SIDE : 0;
}

/**
 * Which lane round `isle` (-1 the left, +1 the right) a bot of car type `stats` with racing line
 * `lateral` (its seat's) takes: the cheaper one, a lane costing the length of its middle
 * (PlacedIsland.lenL, lenR: the shorter lane is faster) plus the surfaces in it as laneFor costs
 * them (length x laneCost) when they leave it no dry line for the car's centre; within SPLIT.tie of
 * each other the seat's side (its racing line's; right for the centre line, as the slipstream's
 * pass side). So on a split with water in one lane and dirt in the other the truck takes the dirt.
 */
export function splitSide(isle: PlacedIsland, stats: CarStats, lateral: number): number {
  const cost = (side: number, surfs: readonly Surface[]) => {
    let c = side < 0 ? isle.lenL : isle.lenR;
    const lo = side < 0 ? -isle.outL + SPLIT.edge : isle.lat1 + SPLIT.clear, hi = side < 0 ? isle.lat0 - SPLIT.clear : isle.outR - SPLIT.edge;
    for (const f of surfs) {
      if (f.lat0 - SURFACE_MARGIN > lo || f.lat1 + SURFACE_MARGIN < hi) continue; // a dry line beside it
      c += Math.max(0, Math.min(f.s1, isle.s1) - Math.max(f.s0, isle.s0)) * laneCost(f.kind, stats);
    }
    return c;
  };
  const l = cost(-1, isle.surfL), r = cost(1, isle.surfR);
  if (Math.abs(l - r) < SPLIT.tie) return lateral >= 0 ? 1 : -1;
  return l < r ? -1 : 1;
}

/**
 * The split lane a bot at (s, lat) on segment seg is in or heading for: the first island round the
 * lap from the segment's start index whose head is at most `look` ahead and that the car is not yet
 * SPLIT.past beyond; null if none (a plain track: no island, nothing to do). `half`: the road's
 * asphalt half-width (BR-BOTS: a route's leg's; the track's by default).
 */
export function splitFor(
  track: Track, s: number, seg: number, lat: number, look: number, lateral: number, stats: CarStats, half = track.def.halfWidth,
): SplitSpan | null {
  const isles = track.islands, n = isles.length;
  if (n === 0) return null;
  const L = track.length;
  const k0 = track.islandsFrom[seg] ?? n;
  for (let j = 0; j < n; j++) {
    const isle = isles[(k0 + j) % n];
    let d0 = isle.s0 - s; // how far ahead its head is (the nearer way round the lap)
    if (d0 < -L / 2) d0 += L;
    else if (d0 >= L / 2) d0 -= L;
    if (d0 + (isle.s1 - isle.s0) < -SPLIT.past) continue; // past it
    if (d0 > look) break; // in order round the lap: the rest are further
    // The planned lane until SPLIT.commit before the head; then the lane the car is in, beside the
    // island's width (or alongside it); in front of the nose, inside its width, still the planned one
    // (so a bot knocked there does not swing from side to side).
    const inFront = d0 > 0 && lat > isle.lat0 && lat < isle.lat1;
    const side = d0 > SPLIT.commit || inFront ? splitSide(isle, stats, lateral) : lat < isle.mid ? -1 : 1;
    const lo = side < 0 ? -isle.outL + SPLIT.edge : isle.lat1 + SPLIT.clear;
    const hi = side < 0 ? isle.lat0 - SPLIT.clear : isle.outR - SPLIT.edge;
    // The seat's racing line, scaled from the road into the lane.
    const racing = clamp((lo + hi) / 2 + (lateral * (hi - lo)) / 2 / (half - CAR_WIDTH / 2), lo, hi);
    return { lo, hi, racing, side, isle };
  }
  return null;
}

// ---- what moves and the parked trucks (M4-MOVE, see the top of this file) -------------------

/** M4-MOVE's bot settings. An object so a tuner can sweep it; the game never changes it. */
export const MOVE = {
  /** From this far before a truck's rear the bot decides whether it jumps it ... */
  truckLook: 520,
  /** ... when it will reach the lip at TRUCK_MIN_SPEED + this or faster (full throttle from its speed now); it gives the jump up below half this margin. */
  truckMargin: 50,
  /** Going round a truck, from this far before its rear on it keeps the side it is on. */
  truckSide: 40,
  /** A jump is given up for the lane round the truck when its band is taken (bandTaken) and the rear is still this far ahead. */
  truckYield: 80,
  /** A barrel's or a press's crossing window is padded by this many ticks either side ... */
  padTicks: 3,
  /** ... plus this share of the ticks until the bot gets there (its arrival is less sure further out). */
  padShare: 0.1,
  /** Waiting for a press that leaves no open lane: stop with the car's nose this far short of it. */
  pressStop: 14,
  /** false: the bots do not see the barrels and the presses (the tuner's baseline, tools/debug/move-tune.ts --blind). */
  see: true,
};

/** The slowest along-track speed the bots time a barrel or a press by (a car standing still gets going). */
const MOVE_V_MIN = 100;

/** truckAhead's answer (one object, refilled: no allocation a step). */
const TRUCK_AHEAD: { t: PlacedTruck; toRear: number } = { t: null as unknown as PlacedTruck, toRear: 0 };

/** The next truck at most `look` ahead of s that the car is not yet past (from trucksFrom), with how far ahead its rear is (< 0 alongside); valid until the next call. */
function truckAhead(track: Track, s: number, seg: number, look: number): { t: PlacedTruck; toRear: number } | null {
  const list = track.trucks, n = list.length;
  if (n === 0) return null;
  const L = track.length;
  const k0 = track.trucksFrom[seg] ?? n;
  for (let j = 0; j < n; j++) {
    const t = list[(k0 + j) % n];
    let d = t.s - s;
    if (d < -L / 2) d += L;
    else if (d >= L / 2) d -= L;
    if (d + t.len + CAR_LENGTH / 2 < 0) continue; // past it
    if (d > look) break; // in order round the lap: the rest are further
    TRUCK_AHEAD.t = t;
    TRUCK_AHEAD.toRear = d;
    return TRUCK_AHEAD;
  }
  return null;
}

/**
 * Is truck t's ramp band taken for a bot at c: another solid car within the band's width (plus half a
 * car) in the truck's own frame, along it from level with the bot to the end of the take-off zone, and
 * no further ahead of the bot than the band is long (it will still be on it when the bot gets there)?
 * The one behind yields (level: both). Others without an id are not cars (BotOther: every car has one).
 */
function bandTaken(t: PlacedTruck, c: CarState, others: readonly BotOther[]): boolean {
  const ex = t.x1 - t.x0, ey = t.y1 - t.y0;
  const l = Math.sqrt(ex * ex + ey * ey) || 1;
  const ux = ex / l, uy = ey / l;
  const rx = t.x0 - ux * TRUCK_HALF, ry = t.y0 - uy * TRUCK_HALF; // the rear's middle
  const self = (c.x - rx) * ux + (c.y - ry) * uy;
  for (let i = 0; i < others.length; i++) {
    const o = others[i];
    if (!o.solid) continue;
    const along = (o.x - rx) * ux + (o.y - ry) * uy, across = -(o.x - rx) * uy + (o.y - ry) * ux;
    if (across < -TRUCK_BAND - CAR_WIDTH / 2 || across > TRUCK_BAND + CAR_WIDTH / 2) continue;
    if (along >= self && along <= t.len + LIP_ZONE && along - self <= t.len + TRUCK_YIELD_REACH) return true;
  }
  return false;
}

/** bandTaken: how much further than the band is long a car ahead still counts (the lead before the rear, a tick's travel). */
const TRUCK_YIELD_REACH = 40;

/** The ticks from now (lo .. hi) in which a car `d` ahead of something at along-track speed vf is within `reach` of it, padded (MOVE); into WIN (one object, refilled). */
const WIN = { lo: 0, hi: 0 };
function crossWindow(d: number, vf: number, reach: number): void {
  const v = Math.max(vf, MOVE_V_MIN);
  const eta = (d / v) * 60;
  const half = (reach / v) * 60 + MOVE.padTicks + MOVE.padShare * Math.max(0, eta);
  WIN.lo = Math.floor(eta - half);
  WIN.hi = Math.ceil(eta + half);
}

/** The nearest press ahead that will be down while the bot passes it (moverBlockers): how far ahead its centre is (-1 none), its width. */
const HOLD = { d: -1, lat0: 0, lat1: 0 };
/** moverBlockers' blockers, kept from step to step (count: MOVER_N). */
export const MOVERS: Blocker[] = [];
let MOVER_N = 0;
function mover(lat: number, r: number, d: number): void {
  const b = MOVERS[MOVER_N] ?? (MOVERS[MOVER_N] = { lat: 0, r: 0, d: 0 });
  b.lat = lat;
  b.r = r;
  b.d = d;
  MOVER_N++;
}

/**
 * The blockers what moves puts in the bot's lane search (see the top of this file), into MOVERS (kept
 * from step to step, its first MOVER_N count; no allocation a step), at race tick rt
 * for a car at s on segment seg moving vf along the track, within `look`: per barrel each run of ticks
 * it is on the road in the window the bot passes its row, as the lateral range it rolls over then (plus
 * BARREL_R); per press that will be down at any tick of the window the bot passes under it, its width
 * (and the nearest such press in HOLD); `round`: a truck the bot goes round (its body's width). Returns
 * how many (0 = none: laneFor as before).
 */
export function moverBlockers(track: Track, s: number, seg: number, vf: number, look: number, rt: number, round: { t: PlacedTruck; toRear: number } | null): number {
  MOVER_N = 0;
  HOLD.d = -1;
  const L = track.length;
  const rows = track.barrels, nB = MOVE.see ? rows.length : 0;
  if (nB > 0) {
    const k0 = track.barrelsFrom[seg] ?? nB;
    for (let j = 0; j < nB; j++) {
      const b = rows[(k0 + j) % nB];
      let d = b.s - s;
      if (d < -L / 2) d += L;
      else if (d >= L / 2) d -= L;
      if (d < -(BARREL_R + CAR_LENGTH / 2 + 2)) continue; // behind the car
      if (d > look) break;
      crossWindow(d, vf, BARREL_R + CAR_LENGTH / 2 + 4);
      for (let k = 0; k < b.n; k++) {
        let first = NaN, last = NaN;
        for (let w = WIN.lo; w <= WIN.hi + 1; w++) {
          const lat = w <= WIN.hi ? barrelLat(b, k, rt + w) : NaN;
          if (lat === lat) {
            if (first !== first) first = lat;
            last = lat;
          } else if (first === first) {
            mover((first + last) / 2, Math.abs(last - first) / 2 + BARREL_R, d); // a run on the road
            first = NaN;
          }
        }
      }
    }
  }
  const gates = track.presses, nP = MOVE.see ? gates.length : 0;
  if (nP > 0) {
    const k0 = track.pressesFrom[seg] ?? nP;
    for (let j = 0; j < nP; j++) {
      const g = gates[(k0 + j) % nP];
      let d = g.s - s;
      if (d < -L / 2) d += L;
      else if (d >= L / 2) d -= L;
      if (d < -(PRESS_DEPTH / 2 + CAR_LENGTH / 2 + 2)) continue;
      if (d > look) break;
      crossWindow(d, vf, PRESS_DEPTH / 2 + CAR_LENGTH / 2 + 4);
      let down = false;
      for (let w = WIN.lo; w <= WIN.hi && !down; w++) down = pressDown(g, rt + w);
      if (!down) continue;
      mover((g.lat0 + g.lat1) / 2, (g.lat1 - g.lat0) / 2, d);
      if (HOLD.d < 0 || d < HOLD.d) {
        HOLD.d = d;
        HOLD.lat0 = g.lat0;
        HOLD.lat1 = g.lat1;
      }
    }
  }
  if (round) mover(round.t.lat, TRUCK_HALF, round.toRear);
  return MOVER_N;
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

/** HARD-2: set by wakeLane when a pass is done or given up this step (botControls clears it before the call, for Hard with mistakes on). */
const PASS = { done: false };

/**
 * The slipstream lane for this step, or null for the racing line (see the top of this file).
 * (px, py, dir): the centerline point at the bot's s and its heading; the other cars and mines
 * are placed along and across the track in that frame (the bot only uses the wake on straights).
 * max: the furthest a lane may lie from the centerline. lateral: its racing line (BR-BOTS: scaled to a
 * shortcut's width; mem.lateral elsewhere).
 */
function wakeLane(
  view: BotView, mem: BotMem, c: CarState, px: number, py: number, dir: number, bend: number, max: number, lateral = mem.lateral,
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
        PASS.done = true; // HARD-2: a hesitation may follow
        return null;
      }
      const lane = olat + w.side * WAKE_SIDE;
      if (w.steps > WAKE_PASS_MAX || a > WAKE_TO || !mineFree(lane)) {
        PASS.done = true; // HARD-2: an overtake given up, a moment a hesitation may follow too
        return giveUp();
      }
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
  const side = lateral > olat + 1 ? 1 : lateral < olat - 1 ? -1 : lateral >= 0 ? 1 : -1;
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
 * BR-BOTS: `ring` is the road it drives (the track, or its route's ring: the cells on its route, at
 * their route distance; idx: each one's index in track.cells, the race's cell timers).
 */
function cellLane(view: BotView, ring: Track, idx: readonly number[] | null, s: number, lane: number, toLip: number, max: number, reach = CELL_LANE): number | null {
  const cells = ring.cells, back = view.cells!;
  const rt = view.rt ?? 0;
  let best: number | null = null, bestD = Infinity;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.road !== undefined) continue; // a branch's cell on a track's own list (its s is u on its road): a route's ring has its own
    const k = idx === null ? i : idx[i];
    if (!(back[k] === 0 || rt >= (back[k] ?? 0))) continue;
    if (Math.abs(c.lat - lane) > reach) continue;
    const d = ahead(ring, s, c.s);
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
export function apexLane(lateral: number, turn: number, halfWidth: number, h: HardParams = HARD): number {
  const bend = Math.abs(turn);
  if (bend <= h.apexFrom) return lateral;
  const k = Math.min(1, (bend - h.apexFrom) / (h.apexFull - h.apexFrom));
  const max = halfWidth - CAR_WIDTH / 2 - 6;
  return clamp(lateral + Math.sign(turn) * h.apex * k, -max, max);
}

/**
 * HARD-2: a wide line, the apex bias turned to the outside of the bend: the racing line moved away
 * from the inside by (0.25 + 1.75 x size) x HARD.apex at full strength (as apexLane's ramp-up: size 0
 * misses the apex, size 1 runs two apex biases wide), kept 6 units inside the asphalt edge.
 */
export function wideLane(lateral: number, turn: number, halfWidth: number, h: HardParams, size: number): number {
  const bend = Math.abs(turn);
  if (bend <= h.apexFrom) return lateral;
  const k = Math.min(1, (bend - h.apexFrom) / (h.apexFull - h.apexFrom));
  const max = halfWidth - CAR_WIDTH / 2 - 6;
  return clamp(lateral - Math.sign(turn) * h.apex * (0.25 + 1.75 * size) * k, -max, max);
}

/** Track coordinates of a point near the track `de` (about) ahead of s: its s and lateral offset (+ = right of travel). */
function trackCoords(track: Track, s: number, de: number, x: number, y: number): { s: number; lat: number; h: number; dist: number } {
  const q = queryMain(track, x, y, pointAt(track, s + de).seg); // the road the bot drives (BR-BOTS: its route's ring on a track with branches)
  const p = pointAt(track, q.s);
  return { s: q.s, lat: (x - p.x) * -Math.sin(p.h) + (y - p.y) * Math.cos(p.h), h: p.h, dist: q.dist };
}

/** Hard's apex check: no mine from 10 behind to APEX_MINE_LOOK ahead within reach of the lanes between `a` and `b`. */
const APEX_MINE_LOOK = 320;
function apexMineFree(view: BotView, ring: Track, c: CarState, s: number, a: number, b: number, clear: number): boolean {
  const mines = view.mines;
  if (!mines || !mines.length) return true;
  const lo = Math.min(a, b) - clear, hi = Math.max(a, b) + clear;
  const far2 = (APEX_MINE_LOOK + 40) ** 2;
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  for (const m of mines) {
    const d2 = (m.x - c.x) ** 2 + (m.y - c.y) ** 2;
    if (d2 > far2) continue; // pre-filter: only the mines near the car are put in track coordinates
    // Searched from about d ahead along the track; a mine behind the car's heading also from d
    // behind, the nearer of the two kept (searched only ahead, a mine some 280+ behind could be
    // put on the road ahead; ahead in a hairpin, a mine can lie behind the heading).
    const d = Math.sqrt(d2);
    let t = trackCoords(ring, s, d, m.x, m.y);
    if ((m.x - c.x) * cos + (m.y - c.y) * sin < 0) {
      const back = trackCoords(ring, s, -d, m.x, m.y);
      if (back.dist < t.dist) t = back;
    }
    const along = ahead(ring, s, t.s);
    if ((along < APEX_MINE_LOOK || along > ring.length - 10) && t.lat > lo && t.lat < hi) return false;
  }
  return true;
}

/**
 * Hard's rivet gate: would a rivet fired now (from the nose, along the heading, with the car's
 * velocity: weapons.ts spawnShot) pass a solid car ahead within a hit plus HARD.rivetSlack, the
 * car holding its velocity, within the rivet's range and over the road (a wall stops a rivet)?
 * A gate on relative velocity only: the bot never steers to aim.
 */
function rivetWouldHit(track: Track, s: number, c: CarState, slack: number): (o: BotOther) => boolean {
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  const nose = CAR_LENGTH / 2 + 4;
  const sx = c.x + cos * nose, sy = c.y + sin * nose;
  const wx = c.vx + cos * RIVET_SPEED, wy = c.vy + sin * RIVET_SPEED; // the rivet's velocity
  const tMax = RIVET_RANGE / Math.hypot(wx, wy);
  const r = CAR_RADIUS + RIVET_RADIUS + slack;
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
      const q = queryMain(track, px, py, pointAt(track, s + Math.hypot(px - c.x, py - c.y)).seg); // the road it drives (BR-BOTS: its route's ring)
      if (q.dist > wallOf(track, q) - RIVET_RADIUS) return false;
      if (islandAt(track, q.seg, q.s, q.lat, RIVET_RADIUS)) return false; // an island in the way (M4-SURF part 2)
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
function mineWouldCatch(view: BotView, ring: Track, mem: BotMem, c: CarState, s: number, lat: number): boolean {
  const h = mem.hard;
  if (view.raceSteps <= ARM_STEPS || view.raceSteps - mem.lastMine < h.mineGap) return false;
  const far = h.mineFar + 30;
  const cos = Math.cos(c.h), sin = Math.sin(c.h);
  for (const o of view.others) {
    if (!o.solid) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    if (dx * cos + dy * sin >= 0 || dx * dx + dy * dy > far * far) continue; // behind, near: pre-filter
    const t = trackCoords(ring, s, -Math.hypot(dx, dy), o.x, o.y);
    const d = ahead(ring, t.s, s); // the follower's distance behind, along the track
    const vf = (o.vx ?? 0) * Math.cos(t.h) + (o.vy ?? 0) * Math.sin(t.h);
    if (vf < 100 || Math.abs(t.lat - lat) > h.mineAcross) continue;
    if (d >= (vf * MINE_ARM_TICKS) / 60 + h.mineNear && d <= h.mineFar) return true;
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

// ---- Hard's human mistakes (HARD-2, see the top of this file) ---------------------------------

/** No mistake begins in the first 3 s after GO. */
const MISTAKE_FROM = 180;
/** A mistake lasts this far at most (units along the track) ... */
const MISTAKE_MAX = 500;
/**
 * ... and begins only with nothing that matters (a hole, a mound, a surface, a ramp, a gap, a widen,
 * an island, a truck, a barrel row or a press) from MISTAKE_BEHIND behind the car to this far ahead:
 * longer than RAMP_APPROACH plus MISTAKE_MAX, so when it ends the next ramp is still out of view and
 * every hole beyond the lane search's look (140 + 0.6 v).
 */
export const MISTAKE_LOOK = RAMP_APPROACH + MISTAKE_MAX;
/** What the car is still beside (half a car and a little); a gap behind does not count (it has landed past it). */
const MISTAKE_BEHIND = CAR_LENGTH / 2 + 4;
/** The bend-entry latch: a bend begins when the bend lookahead turns more than BEND_ON, ends below BEND_OFF. */
const BEND_ON = 0.5;
const BEND_OFF = 0.3;
/**
 * Late brake: the brake trigger late by this x size of the bend lookahead (the bend is seen that far
 * past its entry, still before the bend: the lookahead shortened for its trigger), then on the brakes
 * too hard: down to the bend's speed less LATE_SCRUB x size, held through the bend. (Seen late alone it
 * would gain time: the shipped bends take more speed than Hard asks for.)
 */
const LATE_LOOK = 0.6;
const LATE_SCRUB = 0.4;
/** Wobble: an added steer of WOBBLE_AMP0 + WOBBLE_AMP x size, swinging with this period (steps), decaying over 30 + 40 x size steps. */
const WOBBLE_AMP0 = 0.3;
const WOBBLE_AMP = 0.5;
const WOBBLE_PERIOD = 24;
/** ... and the throttle held to 1 - WOBBLE_LIFT x size for its first half. */
const WOBBLE_LIFT = 0.5;
/** The speed the lap's bends are counted at (mistakeSpots). */
const SPOT_V = 400;

/** A 32-bit mix (murmur3's finaliser). */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/** A deterministic draw in [0, 1) from (seed, lap, segment, what): never Math.random, never the random id. */
export function mistakeDraw(seed: number, lap: number, seg: number, what: number): number {
  let h = mix32((seed | 0) ^ 0x2545f491);
  h = mix32(h ^ (lap | 0));
  h = mix32(h ^ Math.imul(seg | 0, 0x9e3779b1));
  h = mix32(h ^ (what | 0));
  return (h >>> 0) / 4294967296;
}

/** Does the span a..b (track s, b >= a) touch the window from `from`, `len` long (round the lap)? */
function spanIn(track: Track, from: number, len: number, a: number, b: number): boolean {
  return ahead(track, from, a) <= len || ahead(track, a, from) <= b - a;
}

/**
 * Is the road from MISTAKE_BEHIND behind s to MISTAKE_LOOK ahead free of everything a mistake must
 * stay clear of (see MISTAKE_LOOK)? A gap only ahead of s.
 */
export function mistakeClear(track: Track, s: number): boolean {
  const from = s - MISTAKE_BEHIND, len = MISTAKE_BEHIND + MISTAKE_LOOK;
  for (const h of track.holes) if (spanIn(track, from, len, h.s - h.r, h.s + h.r)) return false;
  for (const r of track.ramps) if (spanIn(track, from, len, r.s, r.s + r.len + LIP_ZONE)) return false;
  for (const g of track.gaps) if (spanIn(track, s, MISTAKE_LOOK, g.s0, g.s1)) return false;
  for (const m of track.tyres) if (spanIn(track, from, len, m.s - m.r, m.s + m.r)) return false;
  for (const f of track.surfaces) if (spanIn(track, from, len, f.s0, f.s1)) return false;
  for (const w of track.widens) if (spanIn(track, from, len, w.s0, w.s1)) return false;
  for (const i of track.islands) if (spanIn(track, from, len, i.s0 - ISLAND_NOSE, i.s1 + ISLAND_NOSE)) return false;
  for (const t of track.trucks) if (spanIn(track, from, len, t.s, t.s + t.len + LIP_ZONE)) return false;
  for (const b of track.barrels) if (spanIn(track, from, len, b.s - BARREL_R, b.s + BARREL_R)) return false;
  for (const g of track.presses) if (spanIn(track, from, len, g.s - PRESS_DEPTH / 2, g.s + PRESS_DEPTH / 2)) return false;
  return true;
}

/** Where a car lands after the ramp with lip `lip` (just past its gap, if it has one; else a little past the lip). */
function landingAfter(track: Track, lip: number): number {
  const gap = track.gaps.find((g) => ahead(track, lip - LIP_ZONE, g.s0) <= 2 * LIP_ZONE);
  return gap ? gap.s1 + CAR_WIDTH : lip + 120;
}

/** mistakeSpots by track and bend lookahead factor. */
const spotsMemo = new WeakMap<Track, Map<number, number>>();

/**
 * The places a lap offers a mistake (counted once per track and bendLook): the bend entries (the
 * bend-entry latch at SPOT_V) and the landings (ramps and trucks) where mistakeClear holds. A
 * mistake's chance at each is mistakeRate over this, so a bot makes mistakeRate a lap on average
 * (fewer when the slipstream, a cell or traffic keep it off its own line; a hesitation after a
 * pass comes on top).
 */
export function mistakeSpots(track: Track, bendLook: number): number {
  let by = spotsMemo.get(track);
  if (!by) spotsMemo.set(track, (by = new Map()));
  const known = by.get(bendLook);
  if (known !== undefined) return known;
  const d = 20 + Math.max(120, SPOT_V * 0.9) * bendLook;
  const bendAt = (s: number) => Math.abs(angleDiff(pointAt(track, s + 20).h, pointAt(track, s + d).h));
  let n = 0, inBend = false;
  for (let s = -500; s < track.length; s += 10) {
    const b = bendAt(s);
    const entered = b > BEND_ON && !inBend;
    if (b > BEND_ON) inBend = true;
    else if (b < BEND_OFF) inBend = false;
    if (s >= 0 && entered && mistakeClear(track, s)) n++; // from -500: the latch as it is at the line
  }
  for (const r of track.ramps) if (mistakeClear(track, landingAfter(track, r.s + r.len))) n++;
  for (const t of track.trucks) if (mistakeClear(track, t.lip + 120)) n++;
  by.set(bendLook, n);
  return n;
}

/**
 * One step of Hard's mistakes (mistakeRate > 0 only): the one under way goes on (ended when `free`
 * is false, after its steps or past its end), the bend-entry latch moves, and at a bend entry, a
 * landing, a pass done or given up, or a hit, with `free` and none under way, a new one may begin (mistakeDraw against
 * the rate's chance, then mistakeClear): {kind, size, end} latched in mem.mistake (t 0 on the step it begins).
 */
function mistakeStep(
  view: BotView, track: Track, mem: BotMem, s: number, seg: number, v: number, bend: number, free: boolean, landed: boolean, passed: boolean, hit: boolean,
): Mistake | null {
  const hp = mem.hard; // track: the road it drives (BR-BOTS: its route's ring, whose widens hold the mouths)
  let m = mem.mistake;
  if (m !== null) {
    m.t++;
    if (!free || m.t > m.n || ahead(track, m.end, s) < track.length / 2) m = mem.mistake = null;
  }
  const entered = bend > BEND_ON && !mem.inBend;
  if (bend > BEND_ON) mem.inBend = true;
  else if (bend < BEND_OFF) mem.inBend = false;
  if (m !== null || !free) return m;
  const what = entered ? 1 : landed ? 2 : passed ? 3 : hit ? 4 : 0;
  if (what === 0) return null;
  const lap = view.lap ?? 0;
  const spots = mistakeSpots(track, hp.bendLook);
  const chance = spots > 0 ? Math.min(1, hp.mistakeRate / spots) : 0;
  if (mistakeDraw(mem.seed, lap, seg, 4 * what) >= chance || !mistakeClear(track, s)) return null;
  const kind: MistakeKind = what === 1 ? (mistakeDraw(mem.seed, lap, seg, 4 * what + 1) < 0.5 ? "late-brake" : "wide") : what === 2 ? "wobble" : "hesitate"; // 3, 4: a pass, a hit
  const size = Math.min(1, hp.mistakeSize * (0.75 + 0.5 * mistakeDraw(mem.seed, lap, seg, 4 * what + 2)));
  // A bend's: on through the bend seen at its entry (its lookahead) and a little past; a wobble or a
  // hesitation: a few steps.
  const len = what === 1 ? Math.min(MISTAKE_MAX, 20 + Math.max(120, v * 0.9) * hp.bendLook + 150) : MISTAKE_MAX;
  const n = what === 1 ? 360 : what === 2 ? Math.round(30 + 40 * size) : Math.round(12 + 36 * size);
  const delay = kind === "late-brake" ? LATE_LOOK * size * (20 + Math.max(120, v * 0.9) * hp.bendLook) : 0;
  m = mem.mistake = { kind, size, from: s, end: s + len, delay, t: 0, n, sign: mistakeDraw(mem.seed, lap, seg, 4 * what + 3) < 0.5 ? -1 : 1 };
  return m; // botControls reports it (onMistake) once it is driven: a wide line may find no free lane
}

// ---- shortcut roads (BR-BOTS, PLAN-BRANCH.md 2.6, its advisor changes 4 and 6, user decision 3) ---------

/**
 * Which shortcuts a bot takes and how it commits to one (routePlan, routeStep). An object so the tuner
 * (tools/debug/branch-tune.ts) can sweep it; the game never changes it.
 * - A shortcut costs its length, plus laneCost x the length of every surface on it the car cannot drive
 *   round (no dry lane beside it), plus the level's margin for a jump (a ramp or a gap) and for holes;
 *   the main road from the fork to the merge its length plus its surfaces the same way. A bot takes it
 *   when it costs less (once per race, by seat, car type, stats and level: never the random id).
 * - Easy never takes a jump or a holes shortcut, and one with dirt only in the truck (user decision 3:
 *   "Easy never takes a risky shortcut"); Normal only on its even seats (alternate seats: "Normal on
 *   half the seats"); Hard whenever it pays (its margins are small).
 * - From `decide` before a fork (main s) it commits for this pass: a jump shortcut is given up there when
 *   full throttle from its speed would not reach the take-off speed (takeoffSpeedFor) at the lip.
 */
export const ROUTE = {
  /** The margins (route units) a level adds to a shortcut's cost for a jump and for holes. */
  margin: {
    easy: { jump: Infinity, holes: Infinity },
    normal: { jump: 150, holes: 250 },
    hard: { jump: 50, holes: 150 },
  } as Record<BotLevel, { jump: number; holes: number }>,
  /** From this far before a fork the bot commits to the shortcut or the main road for this pass. */
  decide: 400,
};

/** One shortcut's verdict for one bot (routePlan): what it is, the two costs, taken or not and why. */
export interface RouteChoice {
  branch: number; // 1 = the track's first
  kind: string; // "jump", "holes", "dirt", "water", "plain" (joined with "+")
  main: number; // the main road's cost from fork to merge
  cost: number; // the shortcut's (Infinity: never, `why`)
  take: boolean;
  why: string;
}

/** The surfaces of road r over a..b (its s) a car cannot drive round, as laneFor costs them (length x laneCost). */
function surfCost(r: Track, a: number, b: number, stats: CarStats): number {
  const free = CAR_WIDTH + 2 * SURFACE_MARGIN, half = r.def.halfWidth;
  let c = 0;
  for (const f of r.surfaces) {
    const len = Math.min(f.s1, b) - Math.max(f.s0, a);
    if (len <= 0 || f.lat0 + half >= free || half - f.lat1 >= free) continue; // a dry lane beside it
    c += len * laneCost(f.kind, stats);
  }
  return c;
}

/** What a shortcut holds (RouteChoice.kind). */
function branchKind(r: Track): { jump: boolean; holes: boolean; dirt: boolean; kind: string } {
  const jump = r.ramps.length > 0 || r.gaps.length > 0, holes = r.holes.length > 0;
  const dirt = r.surfaces.some((f) => f.kind === SURF_DIRT), water = r.surfaces.some((f) => f.kind === SURF_WATER);
  const kind = [jump && "jump", holes && "holes", dirt && "dirt", water && "water"].filter(Boolean).join("+") || "plain";
  return { jump, holes, dirt, kind };
}

/** The shortcuts a bot on `seat` of `level` in a `carType` with `stats` takes on `track` (see ROUTE): bit b of mask = branch b. */
export function routePlan(track: Track, level: BotLevel, seat: number, carType: CarType, stats: CarStats): { mask: number; rows: RouteChoice[] } {
  const rows: RouteChoice[] = [];
  let mask = 0;
  track.branches.forEach((b, k) => {
    const r = b.road, f = branchKind(r);
    const main = b.s1 - b.s0 + surfCost(track, b.s0, b.s1, stats);
    let cost = r.length + surfCost(r, 0, r.length, stats), why = "";
    if (level === "easy" && (f.jump || f.holes)) why = "Easy never takes a jump or holes";
    else if (level === "easy" && f.dirt && carType !== "truck") why = "Easy takes dirt only in the truck";
    else if (level === "normal" && seat % 2 !== 0) why = "Normal on an odd seat keeps the main road";
    if (why) cost = Infinity;
    else {
      const m = ROUTE.margin[level];
      if (f.jump) cost += m.jump;
      if (f.holes) cost += m.holes;
      why = cost < main ? "costs less" : "costs more";
    }
    const take = cost < main;
    if (take) mask |= 1 << k;
    rows.push({ branch: k + 1, kind: f.kind, main, cost, take, why });
  });
  return { mask, rows };
}

/** A stretch of one road on a route: road (0 the main road, b + 1 branch b) from its s0, len long, starting at route distance `at`. */
export interface RouteLeg {
  road: number;
  s0: number;
  len: number;
  at: number;
}

/**
 * A route round a track with shortcut roads (routeOf): the main road with the branches of `mask` spliced in
 * at their forks and merges, as one closed road, `ring`, with the Track shape. Its centreline is the main
 * road's samples up to each fork, the branch's from its fork (on the main centreline) to its merge, then
 * the main road's; its route distance starts at the main road's s = 0. On it, at their route distance:
 * every ramp, gap, hole, tyre mound, surface, island, truck, barrel row, press and cell of those
 * stretches, and as widens (for mistakeClear only: the ring's per-sample walls are the roads' own) every
 * mouth from its fork or merge to MOUTH_CLEAR past its gore, taken or not (HARD-2: a mistake never
 * begins near one). The per-segment start indices the driver looks ahead from (surfFrom, tyresFrom,
 * islandsFrom, trucksFrom, barrelsFrom, pressesFrom; islandsAt) by track.ts' rules.
 */
export interface Route {
  /** The branches it takes (bit b: branch b), as built: one that forks before the last one taken merges is left out. */
  mask: number;
  ring: Track;
  legs: RouteLeg[];
  /** Per global segment of the track (CarState.seg): the ring segment a query of the ring searches round. */
  hint: Int32Array;
  /** Per ring segment: the road it lies on. */
  segRoad: Uint8Array;
  /**
   * Per ring sample: the asphalt half-width the driver's lanes keep inside (its def.halfWidth on the main road,
   * as today's driver; on a branch its own, but in a mouth and its taper the narrower side's, the main road's
   * width there: a lane round a main-road hole just past a merge is open from the mouth).
   */
  half: Float64Array;
  /** Per ring cell: its index in track.cells (the race's cell timers, BotView.cells). */
  cellIdx: number[];
}

/** Main samples this close to a fork or a merge are left out of a ring (the branch's end samples lie there). */
const ROUTE_JOIN = 0.5;
/** track.ts' look-ahead start rules (buildBuckets): a mound, an island, a barrel row, a press or a truck stays in a segment's look until this far behind it ... */
const ROUTE_BEHIND = 40;
/** ... and an island in a segment's bucket within this of its s range (ISLAND_BUCKET_REACH). */
const ROUTE_ISLAND_REACH = 30;

const routeMemo = new WeakMap<Track, Map<number, Route>>();

/** The route of `mask` round `track` (built once per track and mask). */
export function routeOf(track: Track, mask: number): Route {
  let by = routeMemo.get(track);
  if (!by) routeMemo.set(track, (by = new Map()));
  let r = by.get(mask);
  if (!r) by.set(mask, (r = buildRoute(track, mask)));
  return r;
}

/** The first index of a list whose `far` edge plus ROUTE_BEHIND is past each ring sample (track.ts' xxxFrom). */
function fromIndex<T>(cum: readonly number[], segs: number, list: readonly T[], far: (x: T) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < segs; i++) {
    const k = list.findIndex((x) => far(x) + ROUTE_BEHIND > cum[i]);
    out.push(k < 0 ? list.length : k);
  }
  return out;
}

/** The last index j of a strictly increasing list with xs[j] <= v (0 below it). */
function lastAtOrBelow(xs: readonly number[], v: number): number {
  let lo = 0, hi = xs.length - 1;
  if (!(v >= xs[0])) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function buildRoute(track: Track, mask: number): Route {
  const bs = track.branches, L = track.length, n = track.pts.length;
  const roads: Track[] = [track, ...bs.map((b) => b.road)];
  // The branches taken, in fork order (one forking before the last one's merge is left out).
  const take: number[] = [];
  let last = -Infinity;
  for (const k of bs.map((_, i) => i).sort((a, b) => bs[a].s0 - bs[b].s0)) {
    if ((mask & (1 << k)) !== 0 && bs[k].s0 > last) {
      take.push(k);
      last = bs[k].s1;
    }
  }
  const legs: RouteLeg[] = [];
  let s = 0;
  for (const k of take) {
    legs.push({ road: 0, s0: s, len: bs[k].s0 - s, at: 0 });
    legs.push({ road: k + 1, s0: 0, len: bs[k].road.length, at: 0 });
    s = bs[k].s1;
  }
  legs.push({ road: 0, s0: s, len: L - s, at: 0 });
  // The centreline, sample by sample: each with its road's per-sample half-widths and walls.
  const pts: Vec[] = [], halfL: number[] = [], halfR: number[] = [], wallL: number[] = [], wallR: number[] = [], segRoad: number[] = [], laneHalf: number[] = [];
  const mainAt = new Int32Array(n).fill(-1);
  const branchAt: (Int32Array | null)[] = bs.map(() => null);
  const firstOf: number[] = []; // per leg: its first ring sample
  const push = (r: Track, i: number, road: number) => {
    pts.push({ x: r.pts[i].x, y: r.pts[i].y });
    halfL.push(r.halfL[i]);
    halfR.push(r.halfR[i]);
    wallL.push(r.wallL[i]);
    wallR.push(r.wallR[i]);
    segRoad.push(road);
    // The lanes' half-width (Route.half): a branch's sample in one of its mouths' widens (the taper included) the narrower side's.
    const u = r.cum[i];
    const mouth = r !== track && r.widens.some((w) => (w as { mouth?: boolean }).mouth === true && u >= w.s0 && u <= w.s1);
    laneHalf.push(mouth ? Math.min(r.halfL[i], r.halfR[i]) : r.def.halfWidth);
  };
  legs.forEach((g, li) => {
    firstOf.push(pts.length);
    if (g.road === 0) {
      const lo = g.s0 === 0 ? 0 : g.s0 + ROUTE_JOIN, hi = li === legs.length - 1 ? Infinity : g.s0 + g.len - ROUTE_JOIN;
      for (let i = 0; i < n; i++) {
        if (track.cum[i] >= lo && track.cum[i] < hi) {
          mainAt[i] = pts.length;
          push(track, i, 0);
        }
      }
    } else {
      const r = roads[g.road], m = r.pts.length, at = new Int32Array(m);
      for (let j = 0; j < m; j++) {
        at[j] = pts.length;
        push(r, j, j < m - 1 ? g.road : 0); // its last sample is the merge, on the main road: the segment from it is the main road's
      }
      branchAt[g.road - 1] = at;
    }
  });
  const N = pts.length;
  const cum = [0];
  for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(pts[i % N].x - pts[i - 1].x, pts[i % N].y - pts[i - 1].y));
  const length = cum[N];
  // Each leg's route distance at its s0, from its first sample (a main leg's may lie a little past it).
  legs.forEach((g, li) => {
    const k = firstOf[li];
    if (g.road > 0) g.at = cum[k];
    else {
      const i = mainAt.indexOf(k);
      g.at = li === 0 ? 0 : i < 0 ? cum[k] : cum[k] - (track.cum[i] - g.s0);
    }
  });
  // The features of each leg at their route distance.
  const ramps: Ramp[] = [], gaps: Gap[] = [], holes: PlacedHole[] = [], tyres: PlacedTyres[] = [], surfaces: Surface[] = [], islands: PlacedIsland[] = [];
  const trucks: PlacedTruck[] = [], barrels: PlacedBarrels[] = [], presses: PlacedPress[] = [], cells: PlacedCell[] = [], cellIdx: number[] = [];
  const widens: Widen[] = [];
  const zone = (a: number, b: number) => widens.push({ k: "widen", s0: a, s1: b, left: 0, right: 0 });
  for (const g of legs) {
    const r = roads[g.road];
    const on = (x: number) => g.road > 0 || (x >= g.s0 && x < g.s0 + g.len);
    const to = (x: number) => g.at + (x - g.s0);
    const surf = (f: Surface): Surface => ({ ...f, s0: to(f.s0), s1: to(f.s1) });
    for (const f of r.ramps) if (on(f.s)) ramps.push({ ...f, s: to(f.s) });
    for (const f of r.gaps) if (on(f.s0)) gaps.push({ ...f, s0: to(f.s0), s1: to(f.s1) });
    for (const f of r.holes) if (on(f.s)) holes.push({ ...f, s: to(f.s) });
    for (const f of r.tyres) if (on(f.s)) tyres.push({ ...f, s: to(f.s) });
    for (const f of r.surfaces) if (on(f.s0)) surfaces.push(surf(f));
    for (const f of r.islands) if (on(f.s0)) islands.push({ ...f, s0: to(f.s0), s1: to(f.s1), surfL: f.surfL.map(surf), surfR: f.surfR.map(surf) });
    for (const f of r.trucks) if (on(f.s)) trucks.push({ ...f, s: to(f.s), lip: to(f.lip) });
    for (const f of r.barrels) if (on(f.s)) barrels.push({ ...f, s: to(f.s) });
    for (const f of r.presses) if (on(f.s)) presses.push({ ...f, s: to(f.s) });
    for (const f of r.widens) if (!(f as { mouth?: boolean }).mouth && on(f.s0)) widens.push({ ...f, s0: to(f.s0), s1: to(f.s1) });
    track.cells.forEach((c, i) => {
      if ((c.road ?? 0) !== g.road || !on(c.s)) return;
      const rc: PlacedCell = { ...c, s: to(c.s) };
      delete rc.road; // on the ring it is on the bot's road
      cells.push(rc);
      cellIdx.push(i);
    });
    // The mouths (HARD-2's exclusions): a taken branch's on its own leg, every other branch's on the main road.
    if (g.road > 0) {
      const b = bs[g.road - 1], fg = b.forkGore, mg = b.mergeGore;
      if (fg && mg) {
        zone(g.at, g.at + fg.u + MOUTH_CLEAR);
        zone(g.at + mg.u - MOUTH_CLEAR, g.at + g.len);
      } else zone(g.at, g.at + g.len);
    } else {
      for (const b of bs) {
        if (!on(b.s0)) continue;
        const fg = b.forkGore, mg = b.mergeGore;
        if (fg && mg) {
          zone(to(b.s0), to(fg.s) + MOUTH_CLEAR);
          zone(to(mg.s) - MOUTH_CLEAR, to(b.s1));
        } else zone(to(b.s0), to(b.s1));
      }
    }
  }
  widens.sort((a, b) => a.s0 - b.s0);
  const islandsAt: PlacedIsland[][] = [];
  for (let i = 0; i < N; i++) islandsAt.push(islands.filter((x) => x.s0 - ROUTE_ISLAND_REACH < cum[i + 1] && x.s1 + ROUTE_ISLAND_REACH > cum[i]));
  const ring: Track = {
    def: { ...track.def, id: `${track.def.id}/route-${mask}`, name: `${track.def.name} route ${mask}`, features: [], recovery: [0] },
    pts, cum, length, wall: track.wall, checkpoints: [], ramps, gaps, holes, cells, recovery: [0],
    halfL, halfR, wallL, wallR, water: [], dirt: [], belts: [], tyres, barrels, trucks, presses, widens, islands, sand: [], oil: [], fords: [],
    surfaces, surfAt: [], surfFrom: [],
    themeSurfaces: [], themeAt: [], tyresAt: [], tyresFrom: fromIndex(cum, N, tyres, (m) => m.s + m.r),
    islandsAt, islandsFrom: fromIndex(cum, N, islands, (x) => x.s1),
    barrelsAt: [], pressesAt: [], trucksAt: [],
    barrelsFrom: fromIndex(cum, N, barrels, (b) => b.s + BARREL_R),
    pressesFrom: fromIndex(cum, N, presses, (p) => p.s + PRESS_DEPTH / 2),
    trucksFrom: fromIndex(cum, N, trucks, (t) => t.s + t.len),
    roadNo: 0, branches: [], mouthAt: [],
  };
  for (let i = 0; i < N; i++) {
    const k = surfaces.findIndex((f) => f.s1 > cum[i]);
    ring.surfFrom.push(k < 0 ? surfaces.length : k);
  }
  // The hints: a segment on the ring is its own; a main segment a taken branch replaces, the branch's
  // beside it (its mapS); a branch's not taken, the main road's beside it.
  const mainHint = (i: number): number => {
    if (mainAt[i] >= 0) return mainAt[i];
    // Left out: a taken branch's stretch from its fork to its merge (or within ROUTE_JOIN of either end).
    const c = track.cum[i];
    for (const k of take) {
      const b = bs[k];
      if (c >= b.s0 - 2 * ROUTE_JOIN && c <= b.s1 + 2 * ROUTE_JOIN) return branchAt[k]![Math.min(lastAtOrBelow(b.mapS, c), segCount(b.road) - 1)];
    }
    // (Not reached: every main sample is on the ring or beside a taken branch.) The nearest ring sample.
    let best = 0, bd = Infinity;
    const p = track.pts[i];
    for (let j = 0; j < pts.length; j++) {
      const d = (pts[j].x - p.x) ** 2 + (pts[j].y - p.y) ** 2;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    return best;
  };
  const hint = new Int32Array(track.mouthAt.length);
  for (let i = 0; i < n; i++) hint[i] = mainHint(i);
  bs.forEach((b, k) => {
    for (let j = 0; j < segCount(b.road); j++) hint[b.base + j] = branchAt[k] ? branchAt[k]![j] : mainHint(pointAt(track, b.mapS[j]).seg);
  });
  let built = 0;
  for (const k of take) built |= 1 << k;
  return { mask: built, ring, legs, hint, segRoad: Uint8Array.from(segRoad), half: Float64Array.from(laneHalf), cellIdx };
}

/** The lanes' half-width (Route.half) at route distance s on ring segment seg: its two samples', linear between them. */
function routeHalf(route: Route, seg: number, s: number): number {
  const h = route.half, ring = route.ring, n = h.length;
  const a = h[seg], b = h[seg + 1 < n ? seg + 1 : 0];
  if (a === b) return a;
  const c0 = ring.cum[seg], len = ring.cum[seg + 1] - c0;
  return a + (b - a) * (len > 0 ? clamp((s - c0) / len, 0, 1) : 0);
}

/** routeStep's position on its route (one object, refilled): the leg, the road, its s on that road and the main s beside it. */
const AT = { leg: 0, road: 0, s: 0, ms: 0 };

/** Where route distance d of `route` is (into AT): its leg and road, the s on that road and (on a branch through its mapS) the main s. */
function routeAt(track: Track, route: Route, d: number): typeof AT {
  const legs = route.legs;
  let li = 0;
  while (li + 1 < legs.length && legs[li + 1].at <= d) li++;
  const g = legs[li];
  AT.leg = li;
  AT.road = g.road;
  AT.s = g.s0 + (d - g.at);
  if (g.road === 0) AT.ms = AT.s >= track.length ? AT.s - track.length : AT.s < 0 ? AT.s + track.length : AT.s;
  else {
    const b = track.branches[g.road - 1], r = b.road, u = clamp(AT.s, 0, r.length);
    const j = pointAt(r, u).seg, c0 = r.cum[j], len = r.cum[j + 1] - c0;
    AT.ms = b.mapS[j] + (b.mapS[j + 1] - b.mapS[j]) * (len > 0 ? clamp((u - c0) / len, 0, 1) : 0);
  }
  return AT;
}

/** Is a car on the branch b's road at u, or on the main road at s (road 0), between its two gores (the corridors apart: walls between the roads)? */
function pastGores(b: PlacedBranch, road: number, s: number): boolean {
  const fg = b.forkGore, mg = b.mergeGore;
  if (!fg || !mg) return false;
  return road === 0 ? s > fg.s && s < mg.s : s > fg.u && s < mg.u;
}

/** Would full throttle from speed v carry the car to every take-off lip of branch b (toFork ahead of its fork) at its take-off speed? */
function jumpReach(b: PlacedBranch, toFork: number, v: number, stats: CarStats): boolean {
  const r = b.road;
  for (const ramp of r.ramps) {
    const need = takeoffSpeedFor(r, ramp);
    if (need > 0 && speedAfter(Math.max(0, v), toFork + ramp.s + ramp.len, stats) < need) return false;
  }
  return true;
}

/** routeStep builds every route of a track with at most this many branches at its first plan (2^n rings). */
const ROUTE_PREBUILD = 4;

/** routeStep's answer (one object, refilled): the route this step and the bot's query on its ring. */
const ROUTE_STEP: { route: Route; q: TrackQuery } = { route: null as unknown as Route, q: null as unknown as TrackQuery };

/**
 * One step of a bot's route on a track with branches (botControls): the plan once per race (routePlan),
 * the car queried on its route's ring (round the ring segment beside its global segment: Route.hint),
 * then per fork: out of its zone (more than ROUTE.decide before the fork, or past the merge) the plan
 * again; entering it, the commitment for this pass (a jump given up when it cannot reach its take-off
 * speed); past a gore on the other road than the route's, the car's road. A changed route: the query
 * again on its ring, and what the driver keeps in route distance (a back-up's lip, a truck decided, a
 * mistake) forgotten.
 */
function routeStep(view: BotView, mem: BotMem, c: CarState): typeof ROUTE_STEP {
  const track = view.track, bs = track.branches;
  if (mem.plan < 0 || mem.planTrack !== track) {
    mem.plan = routePlan(track, mem.level, mem.seat, view.carType ?? DEFAULT_CAR, view.stats).mask;
    mem.planTrack = track;
    mem.route = mem.plan;
    mem.forkDone = 0;
    // Every route it may switch to (a jump given up, a bump past a gore), built now (the countdown, first
    // bot only: routeOf keeps them per track) rather than in a race tick; up to ROUTE_PREBUILD branches.
    if (bs.length <= ROUTE_PREBUILD) for (let m = 0; m < 1 << bs.length; m++) routeOf(track, m);
  }
  let route = routeOf(track, mem.route);
  let q = queryMain(route.ring, c.x, c.y, route.hint[c.seg]);
  const at = routeAt(track, route, q.s);
  const road = at.road, ms = at.ms;
  let mask = mem.route;
  for (let k = 0; k < bs.length; k++) {
    const b = bs[k], bit = 1 << k;
    if (ms < b.s0 - ROUTE.decide || ms > b.s1) {
      mem.forkDone &= ~bit;
      mask = (mem.plan & bit) !== 0 ? mask | bit : mask & ~bit;
    } else if ((mem.forkDone & bit) === 0) {
      mem.forkDone |= bit;
      let go = (mem.plan & bit) !== 0;
      if (go && road === 0 && ms < b.s0) {
        const p = pointAt(route.ring, q.s);
        go = jumpReach(b, b.s0 - ms, c.vx * Math.cos(p.h) + c.vy * Math.sin(p.h), view.stats);
      }
      mask = go ? mask | bit : mask & ~bit;
    }
  }
  // Past a gore the car's own road (CarState.seg: the physics'), when it is not the route's there.
  const pr = roadOfSeg(track, c.seg);
  if (pr !== road) {
    if (pr > 0) {
      const b = bs[pr - 1];
      if (pastGores(b, pr, b.road.cum[c.seg - b.base])) {
        mask |= 1 << (pr - 1);
        mem.forkDone |= 1 << (pr - 1);
      }
    } else if (pastGores(bs[road - 1], 0, track.cum[c.seg])) {
      mask &= ~(1 << (road - 1));
      mem.forkDone |= 1 << (road - 1);
    }
  }
  if (mask !== mem.route) {
    mem.route = mask;
    route = routeOf(track, mask);
    q = queryMain(route.ring, c.x, c.y, route.hint[c.seg]);
    mem.backup = null;
    mem.backedUpFor = -1;
    mem.truckS = -1;
    mem.mistake = null;
  }
  ROUTE_STEP.route = route;
  ROUTE_STEP.q = q;
  return ROUTE_STEP;
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
    mem.mistake = null; // HARD-2: a mistake ends here
    if (c.air === 0) mem.backedUpFor = -1; // a fall or a wreck: the next approach starts over
    if (c.fall > 0) mem.forkDone = 0; // BR-BOTS: recovered before a fork, it commits there again
    if (mem.level === "hard" && mem.hard.mistakeRate > 0) mem.flew = c.fall === 0 && c.wreck === 0; // in a jump's flight: it lands next
    return { throttle: 1, steer: 0, fire: false, mine: false };
  }
  const easy = mem.level === "easy";
  const hard = mem.level === "hard";
  const hp = mem.hard; // Hard's constants for this race (HARD itself unless a room's dev tune)
  // HARD-2: Hard's mistakes (mistakeRate 0, the default: none of the mistake code runs).
  const errs = hard && hp.mistakeRate > 0;
  let landed = false, hit = false;
  if (errs) {
    landed = mem.flew;
    mem.flew = false;
    const hpNow = view.hp ?? -1;
    hit = hpNow >= 0 && mem.hp >= 0 && hpNow < mem.hp;
    mem.hp = hpNow;
  }
  const track = view.track;
  // BR-BOTS: on a track with branches the bot drives its route's ring (routeStep): every look-ahead below
  // walks the route. Without branches the ring is the track and the query today's (queryMain is
  // queryTrackNear exactly there).
  let ring = track, route: Route | null = null, q: TrackQuery;
  if (track.branches.length === 0) q = queryMain(track, c.x, c.y, c.seg);
  else {
    const rs = routeStep(view, mem, c);
    route = rs.route;
    ring = route.ring;
    q = rs.q;
  }
  // The road it is on (a route's leg's): its lanes' asphalt half-width and wall (Route.half), and its seat's
  // racing line scaled to that width (on the main road: the track's, today's).
  const half = route === null ? track.def.halfWidth : routeHalf(route, q.seg, q.s);
  const wall = route === null ? track.wall : half + track.def.verge;
  const lateral = half === track.def.halfWidth ? mem.lateral : (mem.lateral * (half - CAR_WIDTH / 2)) / (track.def.halfWidth - CAR_WIDTH / 2);
  const v = speedOf(c);
  const p = pointAt(ring, q.s);
  const dir = p.h;
  const vf = c.vx * Math.cos(dir) + c.vy * Math.sin(dir); // speed along the track
  const lat = (c.x - p.x) * -Math.sin(dir) + (c.y - p.y) * Math.cos(dir); // + = right of travel

  // Holes and tyre mounds: the lane nearest the car's line that clears the next ones; slower
  // among them. Water and dirt: the cheapest lane for its car type (laneFor). With none of them
  // ahead the bot holds its own racing line (mem.lateral).
  // Split lanes (M4-SURF part 2): an island ahead or beside it: the lane it takes round it (null on a plain track).
  const split = splitFor(ring, q.s, q.seg, lat, SPLIT.look + v * SPLIT.lookPerSpeed, lateral, view.stats, half);
  const pref = split ? clamp(lat, split.racing - 24, split.racing + 24) : clamp(lat, lateral - 24, lateral + 24);
  // M4-MOVE: the next truck: jump it (decided once per approach) or go round it; the barrels and the
  // presses ahead as blockers at the race tick the bot gets to them (none on a track without them).
  const tk = truckAhead(ring, q.s, q.seg, MOVE.truckLook);
  let jump: PlacedTruck | null = null;
  if (tk) {
    const toLip = tk.toRear + (tk.t.lip - tk.t.s);
    const arrive = toLip > 0 ? speedAfter(Math.max(0, vf), toLip, view.stats) : vf;
    if (mem.truckS !== tk.t.s) {
      // Its seat's line in the band (advisor change 2: by seat; two seats can qualify, bandTaken below keeps them apart), fast enough.
      mem.truckS = tk.t.s;
      mem.truckJump = Math.abs(lateral - tk.t.lat) <= TRUCK_BAND && arrive >= TRUCK_MIN_SPEED + MOVE.truckMargin;
    } else if (mem.truckJump && tk.toRear > CAR_LENGTH && arrive < TRUCK_MIN_SPEED + MOVE.truckMargin / 2) mem.truckJump = false; // slowed: round it
    // The band takes one car: another car on it (or lined up for it) ahead or level gives the jump up while there is room to go round.
    if (mem.truckJump && tk.toRear > MOVE.truckYield && bandTaken(tk.t, c, view.others)) mem.truckJump = false;
    if (mem.truckJump) jump = tk.t;
  } else mem.truckS = -1;
  const laneLook = 140 + v * 0.6;
  const movers = (MOVE.see ? ring.barrels.length + ring.presses.length : 0) + ring.trucks.length > 0 ? moverBlockers(ring, q.s, q.seg, vf, laneLook, view.rt ?? 0, tk && !jump ? tk : null) : 0;
  const hole = laneFor(ring, q.s, q.seg, laneLook, pref, lateral, view.stats, split, lat, movers > 0 ? MOVERS : null, movers, half, wall);
  let lane = hole.holes || hole.dodge ? hole.lane : lateral;
  if (jump) lane = jump.lat; // up the middle of its band
  else if (tk && tk.toRear < MOVE.truckSide) {
    // Going round it, at it or beside it: keep the side the car is on (as the mounds' side locks), never across it.
    const clear = TRUCK_HALF + HOLE_CLEARANCE;
    lane = lat >= tk.t.lat ? Math.max(lane, tk.t.lat + clear) : Math.min(lane, tk.t.lat - clear);
  }
  let look = hole.holes ? 40 + v * 0.25 : 55 + v * 0.3;
  if (hard) look *= hp.aimLook;

  // A ramp coming up: full throttle, straight at it (a truck jumped: as a ramp, below).
  const ramp = rampAhead(ring, q.s, RAMP_APPROACH);
  if (!ramp) mem.backedUpFor = -1;
  const near = pointAt(ring, q.s + 20).h;
  const far = pointAt(ring, q.s + 20 + Math.max(120, v * 0.9) * (hard ? hp.bendLook : 1)).h; // x 1: Normal's exact value
  const turn = angleDiff(near, far);
  const bend = Math.abs(turn);

  // The slipstream: follow a car ahead on a straight, then pass it (Normal only).
  let coast = false;
  if (mem.wakeRest > 0) mem.wakeRest--;
  if (errs) PASS.done = false;
  if (mem.useWake && !easy && view.raceOn && !hole.holes && !hole.dodge && !ramp && !jump && !mem.backup && mem.reversing === 0) {
    const w = wakeLane(view, mem, c, p.x, p.y, dir, bend, half - CAR_WIDTH / 2 - 2, lateral);
    if (w) {
      lane = w.lane;
      coast = w.coast;
    }
  } else mem.wake = null;
  // A cell close to its lane (Normal): steer to it; it beats the slipstream.
  let cell = false;
  if (!easy && view.raceOn && view.cells && !hole.holes && !jump) {
    const cl = cellLane(view, ring, route === null ? null : route.cellIdx, q.s, lane, ramp ? ramp.toLip : -1, half - CAR_WIDTH / 2 - 2, hard ? hp.cellLane : CELL_LANE);
    if (cl !== null) {
      lane = cl;
      coast = false;
      mem.wake = null;
      cell = true;
    }
  }
  // Hard's apex bias: only on its own racing line (a hole lane, a ramp, the slipstream and a cell
  // come first), towards the inside of the bend ahead, never onto a mine. mem.lateral stays.
  if (hard && hp.apex > 0 && !hole.holes && !hole.dodge && !ramp && !jump && !mem.wake && !cell && view.raceOn && bend > hp.apexFrom) {
    const apex = apexLane(lateral, turn, half, hp);
    if (apexMineFree(view, ring, c, q.s, lateral, apex, hp.apexMineClear)) lane = apex;
  }
  // HARD-2: the mistake under way or one beginning: only on its own racing line, with nothing of
  // advisor change 4 about (holes, a lane round anything, a ramp, a truck, a split, what moves, the
  // slipstream, a cell, a back-up, reversing, backing off an island; waiting for a press needs a
  // mover), and from MISTAKE_FROM after GO.
  let err: Mistake | null = null;
  if (errs) {
    const free = view.raceOn && view.raceSteps > MISTAKE_FROM && !hole.holes && !hole.dodge && !ramp && !jump && !tk && !split && movers === 0 &&
      !mem.wake && !cell && !mem.backup && mem.reversing === 0 && mem.islandBack === 0;
    err = mistakeStep(view, ring, mem, q.s, q.seg, v, bend, free, landed, PASS.done, hit);
    if (err !== null && err.kind === "wide") {
      // Running wide: the lane must cost nothing (laneFor from it, as its racing line) and pass no mine.
      const wide = wideLane(lateral, turn, half, hp, err.size);
      const wl = laneFor(ring, q.s, q.seg, laneLook, wide, wide, view.stats, null, lat, null, 0, half, wall);
      if (!wl.holes && !wl.dodge && wl.lane === wide && apexMineFree(view, ring, c, q.s, lateral, wide, hp.apexMineClear)) lane = wide;
      else mem.mistake = err = null; // nowhere to run wide: no mistake
    }
    // A mistake that begins this step, once it is sure to be driven (a wide line has its lane).
    if (err !== null && err.t === 0) mem.onMistake?.(err.kind, err.size, q.s, view.lap ?? 0);
  }
  let aim = q.s + look;
  if (ramp && ramp.toLip < RAMP_STRAIGHTEN) aim = q.s + ramp.toLip + 180;
  const t = pointAt(ring, aim);
  if (split) {
    // In its lane round the island, and inside the asphalt at the aim point (a taper is narrower):
    // a cell or anything else never takes it across the island.
    const lo = Math.max(split.lo, -halfOn(ring, t.seg, aim, -1) + SPLIT.edge), hi = Math.min(split.hi, halfOn(ring, t.seg, aim, 1) - SPLIT.edge);
    lane = clamp(lane, lo, Math.max(lo, hi));
  }
  if (route !== null) {
    // BR-BOTS: an aim point where the road is narrower (a shortcut past its mouth's taper): inside its asphalt there.
    const ah = routeHalf(route, t.seg, aim);
    if (ah < half) {
      const m = ah - CAR_WIDTH / 2 - 2;
      lane = clamp(lane, -m, m);
    }
  }
  const tx = t.x - Math.sin(t.h) * lane;
  const ty = t.y + Math.cos(t.h) * lane;
  let steer = clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
  // HARD-2 wobble: over-correcting steer after a landing, decaying over the mistake's steps.
  if (err !== null && err.kind === "wobble") {
    const amp = (WOBBLE_AMP0 + WOBBLE_AMP * err.size) * (1 - err.t / err.n);
    steer = clamp(steer + err.sign * amp * Math.sin((2 * Math.PI * err.t) / WOBBLE_PERIOD), -1, 1);
  }
  // HARD-2 late brake: only the brake trigger is late (the bend is seen err.delay after its entry);
  // `bend` (the slipstream, the apex, the bend latch) is unchanged.
  let tb = bend;
  if (err !== null && err.kind === "late-brake" && ahead(ring, err.from, q.s) < err.delay) tb = 0;
  let target = tb > 1.4 ? 200 : tb > 0.9 ? 260 : tb > 0.5 ? 330 : 1000;
  const scale = CORNER_SCALE[view.carType ?? DEFAULT_CAR];
  if (scale !== 1) target *= scale;
  if (easy) target *= EASY_CORNER;
  if (hard) target *= hp.corner;
  if (err !== null && err.kind === "late-brake" && tb > 0.5) target *= 1 - LATE_SCRUB * err.size;
  // Among holes and mounds: slow enough to weave. What moves and the trucks only steer the lane (M4-MOVE).
  if (hole.holes > movers) target = Math.min(target, HOLE_SPEED);
  let throttle = v > target + (hard ? hp.brakeBand : 25) ? -1 : v > target ? 0 : 1;
  // No ramming; never on a ramp approach (the jump needs the speed: a bump costs less than a fall).
  if (!ramp && !jump && (coast || (mem.useWake && !easy && closingOnCar(view, c, dir))) && throttle > 0) throttle = 0;
  if (err !== null && err.kind === "hesitate" && throttle > 0) throttle = 0; // HARD-2: a short lift (a ramp below still wins)
  else if (err !== null && err.kind === "wobble" && err.t < err.n / 2 && throttle > 1 - WOBBLE_LIFT * err.size) throttle = 1 - WOBBLE_LIFT * err.size; // and off the gas a little while it swings
  if (ramp || jump) throttle = 1; // Easy too: the cap would leave it short of some jumps (a truck's: the band would be solid)
  else if (easy && throttle > EASY_THROTTLE) throttle = EASY_THROTTLE;
  // A press that will be down as the bot gets there, across its lane (no open one in reach): brake and
  // wait short of it until it will be up (M4-MOVE).
  let waiting = false;
  if (movers > 0 && HOLD.d >= 0 && lane > HOLD.lat0 - HOLE_CLEARANCE && lane < HOLD.lat1 + HOLE_CLEARANCE) {
    const toFace = HOLD.d - PRESS_DEPTH / 2 - CAR_LENGTH / 2 - MOVE.pressStop;
    const stop = (Math.max(0, vf) ** 2) / (2 * 900); // stepCar's BRAKE
    if (toFace < stop + 6) {
      throttle = vf > 0 ? -1 : 0;
      waiting = true;
    } else if (toFace < stop + 90 && throttle > 0) throttle = 0;
  }
  // About to roll into a hole on the current heading (spun, bumped)? Brake while turning away.
  if (hole.holes && v > 150 && headingIntoHole(ring, c.x, c.y, c.vx, c.vy, q.s)) throttle = -1;

  // Too slow to clear the gap behind the ramp (a mine, a wall, a bump)? Back up once for a
  // longer run-up, when the car is on the asphalt, pointing along the track and has room to
  // stop before the lip. A back-up that does not get there still ends in a recovery.
  const lip = ramp ? ramp.ramp.s + ramp.ramp.len : -1;
  if (ramp && !mem.backup && mem.backedUpFor !== lip && view.raceOn && q.dist <= halfOf(ring, q) &&
      Math.abs(angleDiff(c.h, dir)) < 0.6) {
    const need = takeoffSpeedFor(ring, ramp.ramp);
    const stop = (Math.max(0, vf) ** 2) / (2 * 900) + 20; // braking distance (stepCar's BRAKE) + margin
    if (need > 0 && ramp.toLip > stop && speedAfter(Math.max(0, vf), ramp.toLip, view.stats) < need) {
      mem.backup = { lip, need, steps: 0 };
      mem.backedUpFor = lip;
    }
  }
  if (mem.backup) {
    const b = mem.backup;
    b.steps++;
    const toLip = ahead(ring, q.s, b.lip);
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

  // Split lanes: pressed against an island or nosing into one (a spin, a bump): back off, then go.
  if (split && view.raceOn) {
    const dh = angleDiff(dir, c.h);
    if (mem.islandCool > 0) mem.islandCool--;
    if (mem.islandBack === 0) {
      mem.islandKind = islandPinned(ring, split.isle, split.side, q.s, lat, dh, mem.islandCool > 0, vf);
      if (mem.islandKind) {
        mem.islandBack = SPLIT.backMax;
        mem.islandSide = split.side;
      }
    } else if (mem.islandKind === BACK_NOSE) {
      if (headAhead(ring, split.isle, q.s) >= SPLIT.noseClear) mem.islandBack = 0; // room to turn out
    } else if (mem.islandBack <= SPLIT.backMax - SPLIT.backMin) {
      // A side: released once 12 off it or turned in less than into / 2 (+ = into it).
      const face = mem.islandSide < 0 ? split.isle.lat0 - CAR_WIDTH / 2 : split.isle.lat1 + CAR_WIDTH / 2;
      if (Math.abs(lat - face) >= 12 || -mem.islandSide * dh <= SPLIT.into / 2) mem.islandBack = 0;
    }
    if (mem.islandBack > 0) {
      mem.islandBack--;
      if (mem.islandBack === 0 && mem.islandKind === BACK_NOSE) mem.islandCool = SPLIT.cool;
      const rolling = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
      throttle = -1;
      // A side: full lock toward the lane (mirrored rolling backwards: the nose swings away from the
      // island). A nose: straight back along the track (the heading kept on the track's, mirrored).
      steer = mem.islandKind === BACK_SIDE ? (rolling < 0 ? -mem.islandSide : mem.islandSide) : clamp(angleDiff(c.h, dir) * 2 * (rolling < 0 ? -1 : 1), -1, 1);
    } else if (mem.islandKind === BACK_NOSE) {
      mem.islandKind = 0;
      mem.islandCool = SPLIT.cool;
    }
  } else {
    mem.islandBack = 0;
    mem.islandKind = 0;
    mem.islandCool = 0;
  }

  // Spun into a wall after a mine: back out for a moment (not while waiting for a press).
  if (view.raceOn && v < 20 && !waiting) mem.slow++;
  else mem.slow = 0;
  if (mem.slow > 90) {
    mem.reversing = 50;
    mem.slow = 0;
  }
  if (mem.reversing > 0) {
    mem.reversing--;
    throttle = -1;
    steer = -steer;
    if (errs) mem.mistake = null; // HARD-2: backing out ends a mistake
  }

  const armed = mem.weapons && !easy;
  let fire = false;
  if (armed && hard) {
    // Only when the rivet would hit (see rivetWouldHit); the weapons arm first (no rivet wasted).
    fire = view.raceSteps > ARM_STEPS && view.others.some(rivetWouldHit(ring, q.s, c, hp.rivetSlack));
    // A mine when a car follows in its wake at the distance it arrives as the mine arms.
    const mine = mineWouldCatch(view, ring, mem, c, q.s, lat);
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
