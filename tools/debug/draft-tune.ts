// draft-tune (M4-DRAFT, PLAN-M4.md 2.8): how long a pass by slipstream takes, for a sweep of the
// slipstream constants (shared/catchup.ts), with no browser and no server: two cars on a long
// straight test track stepped through the shared stepRaceCar with the drafts draftsFor works out
// (the server's rule), both at full throttle. The follower starts `--gap` units behind at 430 u/s
// and either holds a lane `--lat` units off the leader's line all the way, or (the default) sits
// in the leader's wake until it is `--pull` (35) units behind and then pulls out to lane 24.
// Time-to-pass = until the follower's centre is ahead of the leader's along the track (it has
// drawn level and got its nose in front); also printed: the best lead it gets within the time
// limit and the time until it is a whole car length ahead (rarely: once level, its extra speed
// dies out over ~0.8 s and the car it passed is beside it, not in its wake).
//
//   npx tsx tools/debug/draft-tune.ts                 # the sweep, shipped constants marked *
//   npx tsx tools/debug/draft-tune.ts --gap 50 --lat 18
//   npx tsx tools/debug/draft-tune.ts --car truck     # sport | racer | truck

import { DRAFT_DRAG_CUT, DRAFT_SHAPE, draftsFor, type DraftEntry, type DraftShape } from "../../shared/catchup";
import { CARS, isCarType, type CarType } from "../../shared/cars";
import { angleDiff, CAR_LENGTH, clamp, speedOf, type CarState, type CarStats } from "../../shared/physics";
import { buildTrack, pointAt, queryTrackNear, type Track, type TrackDef } from "../../shared/track";
import { raceEnv, stepRaceCar } from "../../shared/weapons";

/** A stadium with two 4500-unit straights: room for any pass. */
export const DRAFT_STRAIGHT: TrackDef = {
  id: "draft-straight",
  name: "Draft Straight",
  control: [
    [0, 0], [1500, 0], [3000, 0], [4500, 0], [5200, 600], [4500, 1200], [3000, 1200], [1500, 1200], [0, 1200], [-700, 600],
  ],
  halfWidth: 64,
  verge: 44,
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** Steer at a point ahead on the lane `lat` units right of the centerline. */
function steerTo(t: Track, c: CarState, lat: number): number {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  const p = pointAt(t, q.s + 60 + speedOf(c) * 0.2);
  const tx = p.x - Math.sin(p.h) * lat, ty = p.y + Math.cos(p.h) * lat;
  return clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
}

export interface PassRun {
  ticks: number; // until the follower's centre is ahead of the leader's; -1 = not within the limit
  clear: number; // until it is a car length ahead; -1 = not within the limit
  best: number; // its best lead (units along the track, < 0 = never level)
  maxDraft: number;
  topSpeed: number; // the follower's
  bumps: number; // ticks the two capsules overlapped (should be 0: the lane change clears)
}

/**
 * One pass: leader on the centerline, follower `gap` behind, both at `v0`. lat: the follower's
 * lane from the start (pull < 0) or the lane it pulls out to once within `pull` units.
 * cutScale: the drag cut used, as a multiple of DRAFT_DRAG_CUT (the drafts are scaled by it).
 */
export function passRun(
  t: Track, stats: CarStats, opts: { gap: number; v0: number; lat: number; pull: number; shape?: DraftShape; cutScale?: number; limit?: number },
): PassRun {
  const s0 = 1000;
  const mk = (s: number, lat: number): CarState => {
    const p = pointAt(t, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h, vx: Math.cos(p.h) * opts.v0, vy: Math.sin(p.h) * opts.v0, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  };
  const pulling = opts.pull >= 0;
  const lead = mk(s0, 0), fol = mk(s0 - opts.gap, pulling ? 0 : opts.lat);
  const field: DraftEntry[] = [{ car: lead, ghost: false, finished: false }, { car: fol, ghost: false, finished: false }];
  const out: number[] = [];
  const env = raceEnv(t);
  const sOf = (c: CarState) => queryTrackNear(t, c.x, c.y, c.seg).s;
  let lane = pulling ? 0 : opts.lat;
  const res: PassRun = { ticks: -1, clear: -1, best: -Infinity, maxDraft: 0, topSpeed: 0, bumps: 0 };
  for (let i = 1; i <= (opts.limit ?? 600); i++) {
    draftsFor(field, out, opts.shape);
    const behind = sOf(lead) - sOf(fol);
    if (pulling && behind < opts.pull) lane = opts.lat;
    env.draft = 0;
    stepRaceCar(lead, { throttle: 1, steer: steerTo(t, lead, 0) }, stats, env);
    env.draft = out[1] * (opts.cutScale ?? 1);
    res.maxDraft = Math.max(res.maxDraft, out[1]);
    stepRaceCar(fol, { throttle: 1, steer: steerTo(t, fol, lane) }, stats, env);
    res.topSpeed = Math.max(res.topSpeed, speedOf(fol));
    const dx = fol.x - lead.x, dy = fol.y - lead.y;
    if (Math.hypot(dx, dy) < 31 && Math.abs(-Math.sin(lead.h) * dx + Math.cos(lead.h) * dy) < 16) res.bumps++;
    const lead_ = sOf(fol) - sOf(lead);
    res.best = Math.max(res.best, lead_);
    if (lead_ > 0 && res.ticks < 0) res.ticks = i;
    if (lead_ >= CAR_LENGTH && res.clear < 0) res.clear = i;
  }
  return res;
}

function main(): void {
  const t = buildTrack(DRAFT_STRAIGHT);
  const car = arg("car", "sport");
  if (!isCarType(car)) throw new Error(`--car: sport, racer or truck, not ${car}`);
  const stats = CARS[car as CarType].base;
  const gap = Number(arg("gap", "50"));
  const v0 = Number(arg("v0", "430"));
  const lat = Number(arg("lat", "24"));
  const pull = Number(arg("pull", process.argv.includes("--lat") ? "-1" : "35"));
  const sec = (r: PassRun) => (r.ticks < 0 ? "  none" : `${(r.ticks / 60).toFixed(2)} s`);
  const more = (r: PassRun) => `best lead ${r.best.toFixed(1)}, a car length ahead ${r.clear < 0 ? "never" : `at ${(r.clear / 60).toFixed(2)} s`}`;
  const how = pull >= 0 ? `in the wake, pulls out to lane ${lat} at ${pull} behind` : `on lane ${lat} all the way`;
  console.log(`${CARS[car as CarType].name}, follower ${gap} behind at ${v0} u/s, ${how}; time until its centre is ahead (4 s limit)\n`);
  const base = passRun(t, stats, { gap, v0, lat, pull, limit: 240 });
  console.log(`shipped: ${sec(base)}  ${more(base)}  max draft ${base.maxDraft.toFixed(2)}  follower top ${base.topSpeed.toFixed(0)} u/s  overlap ticks ${base.bumps}`);
  const off = passRun(t, stats, { gap, v0, lat, pull, cutScale: 0, limit: 240 });
  console.log(`no draft (cut 0): ${sec(off)}  ${more(off)}\n`);

  const row = (label: string, vals: number[], mk: (v: number) => { shape?: DraftShape; cutScale?: number }, shipped: number) => {
    const cells = vals.map((v) => {
      const r = passRun(t, stats, { gap, v0, lat, pull, limit: 240, ...mk(v) });
      return `${v === shipped ? "*" : " "}${String(v).padStart(5)}: ${sec(r)}`;
    });
    console.log(`${label.padEnd(10)} ${cells.join("  ")}`);
  };
  const cut = DRAFT_DRAG_CUT;
  row("drag cut", [0.05, 0.07, 0.09, 0.11, 0.13], (v) => ({ cutScale: v / cut }), cut);
  row("near", [0, 10, 20, 25, 30], (v) => ({ shape: { ...DRAFT_SHAPE, near: v } }), DRAFT_SHAPE.near);
  row("full to", [40, 50, 60, 80, 100], (v) => ({ shape: { ...DRAFT_SHAPE, full: v } }), DRAFT_SHAPE.full);
  row("far", [120, 150, 180, 220, 260], (v) => ({ shape: { ...DRAFT_SHAPE, far: v } }), DRAFT_SHAPE.far);
  row("width", [12, 17, 22, 28, 34], (v) => ({ shape: { ...DRAFT_SHAPE, width: v } }), DRAFT_SHAPE.width);
  row("taper", [2, 5, 8, 12, 16], (v) => ({ shape: { ...DRAFT_SHAPE, taper: v } }), DRAFT_SHAPE.taper);
  console.log("");
  for (const g of [30, 50, 100, 150, 179, 250]) {
    const r = passRun(t, stats, { gap: g, v0, lat, pull, limit: 900 });
    console.log(`start ${String(g).padStart(3)} behind: ${r.ticks < 0 ? "not level in 15 s" : `level at ${(r.ticks / 60).toFixed(2)} s`}, ${more(r)} (max draft ${r.maxDraft.toFixed(2)})`);
  }
}

if (process.argv[1]?.endsWith("draft-tune.ts")) main();
