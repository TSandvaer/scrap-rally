// branch-walls (BR-PHYS, PLAN-BRANCH.md 2.3, advisor changes 1 and 8): do the PHYSICS walls round every
// mouth of a track's shortcut roads match the union of the two roads' corridors, and does the physics'
// road choice match the bake's? No browser. Round each mouth (fork and merge) of every branch, from
// BRANCH_GUIDE before the fork to LOCAL_WINDOW (12) segments past the gore on BOTH roads (and the same
// from the merge back), points every --step units out to 2 walls either side of each road's centreline.
// For each point, every hint a car there could carry (the nearest segment of each road whose corridor
// it is in or near, and two either side of it, as global segments) is put through:
// - the physics: a car standing there (its heading the road's) stepped once by stepCar with no input,
//   which moves a standing car only by the walls and the gores' noses: pushed = it moved. Points within
//   a nose's reach are counted apart (the nose pushes them, not a wall);
// - the union: outside both corridors (each road's own nearest point, the whole road, its per-sample
//   wall there, less half a car: where the car's centre may go) = must be pushed; inside either = not;
// - the bake's rule: queryRoads without a hint (the nearer centreline over every road, whole), and its
//   push verdict (its distance past its road's wallLimit): the physics' must be the same. Where a car
//   with that hint can be (within REACH outside the hint road's car-centre limit: a tick's move past the
//   wall before collideWalls pushes it back), queryTrackNear with the hint must also find the same road
//   and distance as queryRoads (an exact tie: either road). Further out (lost ground between the roads,
//   reached only flying) a window can find a farther point of its own road than the other road's
//   nearest: counted apart (`far`), not a disagreement: no wall is there, both verdicts say "pushed".
// A pushed car must end inside the union (on its edge, within 0.01). Exit code 1 if anything disagrees.
// branchWalls is used by scripts/sim-test.ts; RouteDriver (a scripted driver that takes the shortcuts:
// the server bots keep the main road until BR-BOTS) by scripts/sim-test.ts and scripts/bots.ts.
//
//   npx tsx tools/debug/branch-walls.ts                    Branch Yard (shared/testtracks.ts)
//   npx tsx tools/debug/branch-walls.ts --track <id>       another test track with branches
//   npx tsx tools/debug/branch-walls.ts --step 2           a finer grid

import { angleDiff, BASE_STATS, CAPSULE_HALF, CAPSULE_R, CAR_WIDTH, clamp, NO_INPUT, speedOf, stepCar, wallLimit, type CarState } from "../../shared/physics";
import { BRANCH_GUIDE, halfOn, LOCAL_WINDOW, mainS, pointAt, queryRoads, queryTrack, queryTrackNear, roadOf, segCount, type Track } from "../../shared/track";
import { BRANCH_YARD, TEST_TRACKS, testTrack } from "../../shared/testtracks";

const f1 = (v: number) => v.toFixed(1);
/** A point this close to the car-centre limit is on it: rounding decides, both verdicts are right. */
const EDGE = 1e-6;
/** How far outside its road's car-centre limit a car with a hint on that road can be (a boosted tick ~9, and room). */
const REACH = 24;

/** Road r's own nearest point (the whole road) and how far inside the car-centre limit (its wall less half a car) a point is (> 0 inside). */
function margin(r: Track, x: number, y: number): { d: number; seg: number; inside: number } {
  const q = queryTrack(r, x, y);
  const wall = halfOn(r, q.seg, q.s, q.side) + r.def.verge;
  return { d: q.dist, seg: q.seg, inside: wall - CAR_WIDTH / 2 - q.dist };
}

export interface WallsReport {
  points: number; // probe points
  checks: number; // point x hint pairs put through the physics
  nose: number; // pairs within a nose's reach (counted apart)
  edge: number; // pairs within EDGE of the car-centre limit (either verdict is right there)
  pushWrong: number; // the physics pushed where the union says inside, or did not where it says outside
  bakeWrong: number; // the bake's push verdict (queryRoads, no hint) differs from the physics'
  roadWrong: number; // within REACH: queryTrackNear (with the hint) found another road or distance than queryRoads (no hint)
  far: number; // beyond REACH (lost ground): queryTrackNear found its own road's farther point (both verdicts "pushed")
  landWrong: number; // a pushed car that did not end on the union's edge
  pushed: number; // pairs the physics pushed (and the union agreed)
  free: number; // pairs left standing (and the union agreed)
  mouths: string[]; // per mouth: its probe range and counts
  first: string[]; // the first few disagreements
}

/** The probe (see above) over every mouth of track t. */
export function branchWalls(t: Track, step = 4): WallsReport {
  const rep: WallsReport = { points: 0, checks: 0, nose: 0, edge: 0, pushWrong: 0, bakeWrong: 0, roadWrong: 0, far: 0, landWrong: 0, pushed: 0, free: 0, mouths: [], first: [] };
  const noses = t.branches.flatMap((b) => [b.forkGore, b.mergeGore].filter((g) => g !== null).map((g) => g!));
  const noseReach = (x: number, y: number) => noses.some((g) => Math.hypot(x - g.x, y - g.y) < g.noseMain.r + CAPSULE_R + CAPSULE_HALF + 1);
  const note = (s: string) => {
    if (rep.first.length < 8) rep.first.push(s);
  };
  t.branches.forEach((b, k) => {
    const r = b.road, n = t.pts.length;
    const mainSeg = t.length / n, branchSeg = r.length / segCount(r);
    for (const [g, end] of [[b.forkGore, "fork"], [b.mergeGore, "merge"]] as const) {
      if (!g) continue;
      // Along each road: the branch from BRANCH_GUIDE before its fork (on the main road) to 12 of its
      // segments past the gore; the main road from BRANCH_GUIDE before the fork to 12 of its segments
      // past the gore's s (mirrored at the merge).
      const fork = end === "fork";
      const lines: { road: Track; lo: number; hi: number; label: string }[] = fork
        ? [
            { road: r, lo: 0, hi: g.u + LOCAL_WINDOW * branchSeg, label: "branch" },
            { road: t, lo: b.s0 - BRANCH_GUIDE, hi: g.s + LOCAL_WINDOW * mainSeg, label: "main" },
          ]
        : [
            { road: r, lo: g.u - LOCAL_WINDOW * branchSeg, hi: r.length, label: "branch" },
            { road: t, lo: g.s - LOCAL_WINDOW * mainSeg, hi: b.s1 + BRANCH_GUIDE, label: "main" },
          ];
      const before = { ...rep };
      for (const line of lines) {
        for (let s = line.lo; s <= line.hi; s += step) {
          const p = pointAt(line.road, s);
          const nx = -Math.sin(p.h), ny = Math.cos(p.h);
          for (let lat = -2 * t.wall; lat <= 2 * t.wall; lat += step) {
            const x = p.x + nx * lat, y = p.y + ny * lat;
            rep.points++;
            const mm = margin(t, x, y), mb = margin(r, x, y);
            const outside = mm.inside < 0 && mb.inside < 0;
            const onEdge = Math.abs(Math.max(mm.inside, mb.inside)) < EDGE; // on the line itself: rounding decides
            // The hints a car here could carry: each road whose corridor it is in or near (2 walls).
            const hints: number[] = [], reach: boolean[] = [];
            for (const [m, base, segs] of [[mm, 0, n], [mb, b.base, segCount(r)]] as const) {
              if (m.d > 2 * t.wall) continue;
              for (const dk of [-2, -1, 0, 1, 2]) {
                const j = m.seg + dk;
                if (base > 0 && (j < 0 || j >= segs)) continue;
                hints.push(base + (base > 0 ? j : (j + n) % n));
                reach.push(m.inside > -REACH);
              }
            }
            const qr = queryRoads(t, x, y);
            const bakePushed = qr.dist > wallLimit(roadOf(t, qr.road), qr);
            const tie = Math.abs(queryTrack(t, x, y).dist - queryTrack(r, x, y).dist) < 1e-9;
            for (const [hk, hint] of hints.entries()) {
              rep.checks++;
              if (noseReach(x, y)) {
                rep.nose++;
                continue;
              }
              const qn = queryTrackNear(t, x, y, hint);
              if (!((qn.road === qr.road || tie) && Math.abs(qn.dist - qr.dist) < 1e-9)) {
                if (!reach[hk]) rep.far++;
                else {
                  rep.roadWrong++;
                  note(`branch ${k + 1} ${end}, ${line.label} ${f1(s)} lat ${f1(lat)}, hint ${hint}: queryTrackNear road ${qn.road} dist ${f1(qn.dist)}, queryRoads road ${qr.road} dist ${f1(qr.dist)}`);
                }
              }
              const c: CarState = { x, y, h: p.h, vx: 0, vy: 0, seg: hint, wreck: 0, air: 0, fall: 0, boost: 0 };
              stepCar(c, NO_INPUT, BASE_STATS, t);
              const moved = Math.hypot(c.x - x, c.y - y) > 1e-9;
              if (onEdge) {
                rep.edge++;
                continue;
              }
              if (moved !== bakePushed) {
                rep.bakeWrong++;
                note(`branch ${k + 1} ${end}, ${line.label} ${f1(s)} lat ${f1(lat)}, hint ${hint}: the physics ${moved ? "pushed" : "left"} it, the bake's rule (queryRoads) ${bakePushed ? "pushes" : "leaves"} it`);
              }
              if (moved !== outside) {
                rep.pushWrong++;
                note(`branch ${k + 1} ${end}, ${line.label} ${f1(s)} lat ${f1(lat)}, hint ${hint}: the physics ${moved ? "pushed" : "left"} it, the union says ${outside ? "outside" : "inside"} (main ${f1(mm.inside)}, branch ${f1(mb.inside)} inside the limit)`);
                continue;
              }
              if (moved) {
                rep.pushed++;
                const am = margin(t, c.x, c.y), ab = margin(r, c.x, c.y);
                if (Math.max(am.inside, ab.inside) < -0.01) {
                  rep.landWrong++;
                  note(`branch ${k + 1} ${end}, ${line.label} ${f1(s)} lat ${f1(lat)}, hint ${hint}: pushed to ${f1(Math.max(am.inside, ab.inside))} outside the union`);
                }
              } else rep.free++;
            }
          }
        }
      }
      rep.mouths.push(
        `branch ${k + 1} ${end} (gore u ${f1(g.u)}, s ${f1(g.s)}; branch u ${f1(lines[0].lo)}..${f1(lines[0].hi)}, main s ${f1(lines[1].lo)}..${f1(lines[1].hi)}): ` +
          `${rep.points - before.points} points, ${rep.checks - before.checks} with hints, ${rep.pushed - before.pushed} pushed, ${rep.free - before.free} free, ${rep.nose - before.nose} at the nose, ${rep.edge - before.edge} on the edge; ` +
          `${rep.pushWrong - before.pushWrong} union, ${rep.bakeWrong - before.bakeWrong} bake, ${rep.roadWrong - before.roadWrong} road, ${rep.landWrong - before.landWrong} landing disagree (${rep.far - before.far} far)`,
      );
    }
  });
  return rep;
}

/** One leg of a route: road `road` (0 = the main road) from s0 on it, len long, starting at route distance `at` (within a lap). */
interface Leg { road: number; s0: number; len: number; at: number }

/** A route leg reads a pose only this far before or past its ends (a mouth, MOUTH_LEN_MAX, and room). */
const LEG_REACH = 700;

/** How far either side of a hole the route driver keeps clear of it (its lanes for two holes 250 apart never overlap). */
const HOLE_REACH = 100;

/**
 * A scripted driver along a route (BR-PHYS tests): the main road from the start line, onto each branch
 * in `take` (branch numbers, 1 = the first) at its fork and back onto the main road at its merge, lap
 * after lap. It steers at the point 40 + v / 4 ahead along the ROUTE (not along the queried road, so a
 * mouth's road choice never turns it), `lane` units right of the centreline or, near a hole, on the
 * nearest lane that keeps its centre HOLE_REACH-clear of it; full throttle up to `top` u/s, then coasting.
 * Pure: the same poses give the same controls (server-side or on a client's predicted car).
 */
export class RouteDriver {
  readonly legs: Leg[] = [];
  /** The route's length a lap. */
  readonly lap: number;
  /** Route distance of the last pose (NaN before the first). */
  d = NaN;
  constructor(readonly track: Track, take: readonly number[], readonly lane = 0, readonly top = Infinity) {
    let s = 0, at = 0;
    const bs = [...new Set(take)].sort((a, b) => track.branches[a - 1].s0 - track.branches[b - 1].s0);
    for (const k of bs) {
      const b = track.branches[k - 1];
      this.legs.push({ road: 0, s0: s, len: b.s0 - s, at });
      at += b.s0 - s;
      this.legs.push({ road: k, s0: 0, len: b.road.length, at });
      at += b.road.length;
      s = b.s1;
    }
    this.legs.push({ road: 0, s0: s, len: track.length - s, at });
    this.lap = at + track.length - s;
  }

  /** The road and s at route distance d (any lap). */
  at(d: number): { road: number; s: number } {
    const k = Math.floor(d / this.lap), w = d - k * this.lap;
    let g = this.legs[0];
    for (const x of this.legs) if (w >= x.at) g = x;
    return { road: g.road, s: g.s0 + (w - g.at) };
  }

  /**
   * The route distance of a pose: of the readings of its query (on its road) on that road's legs, the one
   * nearest the last. On a branch the route does not take (a mouth's query can land there): its mainS on
   * the main road's legs.
   */
  progress(c: CarState): number {
    const t = this.track, L = t.length;
    const q0 = queryTrackNear(t, c.x, c.y, c.seg);
    const q = this.legs.some((g) => g.road === q0.road) ? { road: q0.road, s: q0.s } : { road: 0, s: mainS(t, q0) };
    const lap = Number.isNaN(this.d) ? 0 : Math.floor(this.d / this.lap);
    const ref = Number.isNaN(this.d) ? 0 : this.d;
    // Each leg on the query's road reads it as a along the leg (on the main road both ways round the lap);
    // a reading counts only within MOUTH_LEN_MAX + 100 of the leg (a mouth's main road beside a branch's
    // fork or merge), unless none does. Of those, the one nearest the last.
    let best = NaN, off = Infinity, bestAny = NaN, offAny = Infinity;
    for (let k = lap - 1; k <= lap + 1; k++) {
      for (const g of this.legs) {
        if (g.road !== q.road) continue;
        const a0 = g.road === 0 ? (((q.s - g.s0) % L) + L) % L : q.s - g.s0;
        for (const a of g.road === 0 ? [a0, a0 - L] : [a0]) {
          const d = k * this.lap + g.at + a, o = Math.abs(d - ref);
          if (o < offAny) {
            offAny = o;
            bestAny = d;
          }
          if (a >= -LEG_REACH && a <= g.len + LEG_REACH && o < off) {
            off = o;
            best = d;
          }
        }
      }
    }
    const d = Number.isNaN(best) ? bestAny : best;
    if (!Number.isNaN(d)) this.d = d;
    return this.d;
  }

  /** The lane at (road, s): `lane`, or near a hole the nearest one clear of it, inside the asphalt less 10. */
  laneAt(road: number, s: number): number {
    const r = roadOf(this.track, road);
    const near = r.holes.filter((h) => Math.abs(h.s - s) < h.r + HOLE_REACH);
    if (near.length === 0) return this.lane;
    const max = r.def.halfWidth - 10;
    for (let k = 0; k <= 2 * max; k += 2) {
      for (const lat of k === 0 ? [this.lane] : [this.lane + k, this.lane - k]) {
        if (Math.abs(lat) > max) continue;
        if (near.every((h) => Math.abs(lat - h.lat) > h.r + 12)) return lat;
      }
    }
    return this.lane;
  }

  controls(c: CarState): { throttle: number; steer: number } {
    const d = this.progress(c);
    const v = speedOf(c);
    const aim = this.at(d + 40 + v * 0.25);
    const r = roadOf(this.track, aim.road);
    const p = pointAt(r, aim.s);
    const lat = this.laneAt(aim.road, aim.s);
    const tx = p.x - Math.sin(p.h) * lat, ty = p.y + Math.cos(p.h) * lat;
    return { throttle: v < this.top ? 1 : 0, steer: clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1) };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const id = arg("--track") ?? BRANCH_YARD.id;
  if (!TEST_TRACKS.some((d) => d.id === id)) throw new Error(`no test track ${id}`);
  const t = testTrack(id)!;
  if (t.branches.length === 0) throw new Error(`${id} has no branches`);
  const rep = branchWalls(t, Number(arg("--step") ?? 4));
  console.log(`${id}: ${t.branches.length} branch(es), wall ${t.wall}`);
  for (const m of rep.mouths) console.log(`  ${m}`);
  console.log(`all: ${rep.points} points, ${rep.checks} point-hint pairs (${rep.nose} at a nose, ${rep.edge} on the edge), ${rep.pushed} pushed and ${rep.free} free as the union says; ${rep.pushWrong} union, ${rep.bakeWrong} bake, ${rep.roadWrong} road, ${rep.landWrong} landing disagreements; ${rep.far} far (lost ground, not a disagreement)`);
  for (const f of rep.first) console.log(`  ${f}`);
  process.exit(rep.pushWrong + rep.bakeWrong + rep.roadWrong + rep.landWrong > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith("branch-walls.ts")) main();
