// Race progress: laps and checkpoints, detected as forward crossings between the car's
// previous and current distance along the track. Server-only; the client just displays
// what the snapshots say. BR-PHYS (PLAN-BRANCH 2.4): the distance is the main road's s, on a
// branch its mapS (shared/track.ts mainS): continuous and increasing from the fork to the merge,
// so a car on a shortcut crosses every checkpoint inside it, in order. q.s itself without branches.

import type { CarState } from "../shared/physics";
import { mainS, queryTrackNear, type Track } from "../shared/track";

export interface Progress {
  s: number; // distance along the track at the last update
  cp: number; // checkpoints passed this lap (0..3); 3 means the finish line is next
  lap: number; // completed laps
  fin: number; // finish time in ms since the start, 0 = still racing
}

export function newProgress(track: Track, car: CarState): Progress {
  return { s: mainS(track, queryTrackNear(track, car.x, car.y, car.seg)), cp: 0, lap: 0, fin: 0 };
}

/** Forward distance from a to b around the loop, in [0, L). */
function ahead(a: number, b: number, L: number): number {
  return (((b - a) % L) + L) % L;
}

/**
 * Update progress after the car moved. Returns true when this move completed a lap.
 * Only forward crossings of the *next* target count, so driving back and forth over a
 * line, or reversing over the finish, never earns anything.
 */
export function advance(track: Track, p: Progress, car: CarState): boolean {
  const L = track.length;
  const s1 = mainS(track, queryTrackNear(track, car.x, car.y, car.seg));
  let d = s1 - p.s;
  if (d > L / 2) d -= L;
  else if (d < -L / 2) d += L;
  const s0 = p.s;
  p.s = s1;
  if (d <= 0) return false;
  // Targets are a quarter lap apart and a car moves a few units per tick, so at most
  // one target can be crossed per update.
  const target = p.cp < track.checkpoints.length ? track.checkpoints[p.cp] : 0;
  const gap = ahead(s0, target, L);
  if (gap === 0 || gap > d) return false;
  if (p.cp < track.checkpoints.length) {
    p.cp++;
    return false;
  }
  p.cp = 0;
  p.lap++;
  return true;
}

/**
 * Total distance raced, for ordering. Cars on the grid sit just behind the line with
 * s close to L, so before the first checkpoint a large s counts as negative.
 */
export function raceDistance(track: Track, p: Progress): number {
  const L = track.length;
  const s = p.cp === 0 && p.s > L / 2 ? p.s - L : p.s;
  return p.lap * L + s;
}

/** Finished cars first (by time), then the rest by distance raced. */
export function compareStanding(
  a: { fin: number; rd: number },
  b: { fin: number; rd: number },
): number {
  if (a.fin && b.fin) return a.fin - b.fin;
  if (a.fin) return -1;
  if (b.fin) return 1;
  return b.rd - a.rd;
}
