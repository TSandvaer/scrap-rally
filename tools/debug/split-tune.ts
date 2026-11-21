// split-tune (M4-SURF part 2, ClickUp 123jpnbffz4): the numbers behind split lanes, no browser.
//   --race    server bots on the Split Yard (shared/testtracks.ts), 3 laps, per level (Easy, Normal,
//             Hard; Sport, Racer, Truck by add order; and a 5-bot race, every seat): finish times,
//             falls, wall-hit and island-contact ticks (sides and noses), the lane each bot took
//             round each island; run twice (identical = deterministic).
//   --mounds  the M4-SURF-1 review's F1: mound-contact ticks of the Surf Yard races (surf-tune.ts
//             surfRace) for a sweep of botdrive's MOUNDS.hold, next to the numbers before the fix.
//   --walls   the per-sample walls: how far a straight line between the samples (linear
//             interpolation of Track.wallL / wallR) is from the wall function the physics and the
//             drawing use (halfAt / wallAt), the largest gap per widen of the test tracks.
//
//   npx tsx tools/debug/split-tune.ts --race | --mounds | --walls

import type { BotLevel } from "../../shared/botdrive";
import { MOUNDS } from "../../shared/botdrive";
import { CAPSULE_HALF, CAPSULE_R, clamp, NOSE_MID, type CarState } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { SPLIT_YARD, TEST_TRACKS, testTrack } from "../../shared/testtracks";
import { ISLAND_NOSE, ISLAND_NOSE_ROUND, queryTrackNear, wallAt, type PlacedIsland, type Track } from "../../shared/track";
import { CAR_HP } from "../../shared/weapons";
import { wallHitSpeed } from "../../client/game";
import { Room, type Conn, type Player, type Session } from "../../server/room";
import { surfRace } from "./surf-tune";

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results") this.msgs.push(m);
  }
  close(): void {}
}

export interface SplitRace {
  phase: string;
  ticks: number;
  finish: string[]; // name:seconds, in finish order
  cars: string[]; // each bot's car type, by add order
  falls: number[];
  walls: number[]; // wall-hit ticks (>= 50 u/s into a wall or an island's side) per bot
  sides: number[]; // ticks against an island's side per bot
  noses: number[]; // ticks in contact with an island's nose per bot
  lanes: string[][]; // per bot, per island lap by lap: "L" or "R" (the side it was on at the island's middle)
  digest: string; // every tick's car states, for the rerun check
}

/** Is the car against an island's side (its centre at the side's limit, between the noses' axes) or touching a nose? */
export function islandContact(t: Track, c: CarState): "side" | "nose" | null {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  for (const isle of t.islandsAt[q.seg] ?? []) {
    if (q.s >= isle.s0 + NOSE_MID && q.s <= isle.s1 - NOSE_MID) {
      if (q.lat > isle.lat0 - 8.01 && q.lat < isle.lat1 + 8.01) return "side";
      continue;
    }
    if (noseGap(isle, c) <= 0.01) return "nose";
  }
  return null;
}

/**
 * The gap between the car's capsule and the nearer of the island's two noses (< 0 = overlapping):
 * sampled along the car's axis against the cores' edges (a probe, independent of collideNose's math).
 */
export function noseGap(isle: PlacedIsland, c: CarState): number {
  let best = Infinity;
  const ux = Math.cos(c.h), uy = Math.sin(c.h);
  for (const core of [isle.head, isle.tail]) {
    for (let i = 0; i <= 30; i++) {
      const s = -CAPSULE_HALF + (2 * CAPSULE_HALF * i) / 30;
      const px = c.x + ux * s, py = c.y + uy * s;
      for (let k = 0; k < 4; k++) {
        const a = core[k], b = core[(k + 1) % 4];
        const ex = b.x - a.x, ey = b.y - a.y;
        const t = clamp(((px - a.x) * ex + (py - a.y) * ey) / (ex * ex + ey * ey || 1), 0, 1);
        best = Math.min(best, Math.hypot(px - a.x - ex * t, py - a.y - ey * t) - ISLAND_NOSE_ROUND - CAPSULE_R);
      }
    }
  }
  return best;
}

/**
 * A 3-lap race of server bots of `levels` on `trackId` (the dev flag on), the host retired at GO;
 * weapons false: no bot shoots or drops a mine.
 */
export function splitRace(levels: BotLevel[], laps = 3, trackId = SPLIT_YARD.id, weapons = true): SplitRace {
  const old = process.env.SCRAP_DEV_TRACK;
  process.env.SCRAP_DEV_TRACK = trackId;
  try {
    const room = new Room("SPLT", laps, CAR_HP, trackId);
    let now = 1000, tick = 0;
    const conn = new HostConn();
    const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
    const bots = levels.map((l) => {
      const b = room.addBot(host, l, now);
      if (typeof b === "string") throw new Error(b);
      if (!weapons) b.bot!.mem.weapons = false;
      return b;
    });
    const e = room.start(host, now);
    if (e) throw new Error(e);
    const step = () => {
      tick++;
      now += 1000 / 60;
      room.tick(tick, now);
    };
    while (room.phase !== "racing") step();
    if (room.retire(host)) throw new Error("retire");
    const t = room.track;
    const n = bots.length;
    const out: SplitRace = {
      phase: "", ticks: 0, finish: [], cars: bots.map((b) => b.carType), falls: Array(n).fill(0), walls: Array(n).fill(0),
      sides: Array(n).fill(0), noses: Array(n).fill(0), lanes: bots.map(() => t.islands.map(() => "")), digest: "",
    };
    const prev = bots.map((b) => ({ ...b.car! }));
    const parts: number[] = [];
    while (room.phase === "racing" && out.ticks < 60 * 60 * 5) {
      step();
      out.ticks++;
      bots.forEach((b, k) => {
        const c = b.car;
        if (!c) return;
        const p = prev[k];
        if (c.fall > 0 && p.fall === 0) out.falls[k]++;
        if (c.air === 0 && c.fall === 0 && c.wreck === 0 && p.air === 0 && !b.progress?.fin) {
          if (wallHitSpeed(p, c, t) >= 50) out.walls[k]++;
          const hit = islandContact(t, c);
          if (hit === "side") out.sides[k]++;
          else if (hit === "nose") out.noses[k]++;
          // The lane at each island's middle (crossed going forward).
          const q0 = queryTrackNear(t, p.x, p.y, p.seg), q1 = queryTrackNear(t, c.x, c.y, c.seg);
          t.islands.forEach((isle, i) => {
            const m = (isle.s0 + isle.s1) / 2;
            if (q0.s < m && q1.s >= m && q1.s - q0.s < 50) out.lanes[k][i] += q1.lat < isle.mid ? "L" : "R";
          });
        }
        parts.push(c.x, c.y, c.vx, c.vy);
        prev[k] = { ...c };
      });
    }
    out.phase = room.phase;
    const res = conn.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
    out.finish = res ? res.rows.filter((r) => r.name !== "Host").map((r) => `${r.name}:${(r.timeMs / 1000).toFixed(2)}`) : [];
    let h = 0;
    for (const v of parts) h = (Math.imul(h ^ Math.floor(v * 1e6), 16777619) + 1) | 0;
    out.digest = (h >>> 0).toString(16);
    return out;
  } finally {
    if (old === undefined) delete process.env.SCRAP_DEV_TRACK;
    else process.env.SCRAP_DEV_TRACK = old;
  }
}

/** The Surf Yard races per level (surf-tune.ts surfRace) for MOUNDS = { commit, hold } (put back after). */
export function moundRaces(commit: number, hold: number): Record<BotLevel, ReturnType<typeof surfRace>> {
  const was = { ...MOUNDS };
  MOUNDS.commit = commit;
  MOUNDS.hold = hold;
  try {
    const out = {} as Record<BotLevel, ReturnType<typeof surfRace>>;
    for (const level of ["easy", "normal", "hard"] as BotLevel[]) out[level] = surfRace(level);
    return out;
  } finally {
    Object.assign(MOUNDS, was);
  }
}

/** The largest gap between linear interpolation of the per-sample walls and the wall function, per widen. */
export function wallGaps(): string[] {
  const out: string[] = [];
  for (const d of TEST_TRACKS) {
    const t = testTrack(d.id)!;
    for (const w of t.widens) {
      let worst = 0, at = 0;
      for (let i = 0; i < t.pts.length; i++) {
        const a = t.cum[i], b = t.cum[i + 1];
        if (b < w.s0 - 1 || a > w.s1 + 1) continue;
        const j = (i + 1) % t.pts.length;
        for (let k = 1; k < 20; k++) {
          const s = a + ((b - a) * k) / 20;
          for (const side of [-1, 1]) {
            const lin = (side < 0 ? t.wallL[i] : t.wallR[i]) + ((side < 0 ? t.wallL[j] : t.wallR[j]) - (side < 0 ? t.wallL[i] : t.wallR[i])) * (k / 20);
            const g = Math.abs(lin - wallAt(t, s, side));
            if (g > worst) {
              worst = g;
              at = s;
            }
          }
        }
      }
      out.push(`${d.id} widen ${w.s0}..${w.s1} (left ${w.left}, right ${w.right}): interpolating the samples misses the wall by up to ${worst.toFixed(2)} units (at s ${at.toFixed(0)})`);
    }
  }
  return out;
}

if (process.argv[1]?.endsWith("split-tune.ts")) {
  if (process.argv.includes("--race")) {
    const runs: [string, BotLevel[]][] = [["easy", ["easy", "easy", "easy"]], ["normal", ["normal", "normal", "normal"]], ["hard", ["hard", "hard", "hard"]], ["mixed 5", ["easy", "normal", "hard", "normal", "hard"]]];
    for (const [name, levels] of runs) {
      const a = splitRace(levels), b = splitRace(levels);
      console.log(`${name.padEnd(7)} ${a.phase} ${a.ticks} ticks; finish ${a.finish.join(", ")}; falls ${a.falls.join("/")}; wall-hit ticks ${a.walls.join("/")}; island side/nose ticks ${a.sides.map((x, k) => `${x}/${a.noses[k]}`).join(" ")}; rerun ${a.digest === b.digest ? "identical" : "DIFFERS"}`);
      a.lanes.forEach((l, k) => console.log(`        seat ${k} ${a.cars[k].padEnd(5)} lanes per island (laps): ${l.join(" | ")}`));
    }
  } else if (process.argv.includes("--mounds")) {
    console.log("mound-contact ticks per seat (Sport/Racer/Truck), falls and wall-hit ticks summed over the three races");
    console.log("before the fix (the M4-SURF-1 branch): easy 17/9/8, normal 18/9/10, hard 18/13/11; the straight fix (continue): easy 41/9/8, normal 23/14/10, hard 22/11/10");
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    for (const [commit, hold] of [[80, 32], [120, 32], [140, 32], [MOUNDS.commit, MOUNDS.hold], [200, 32], [240, 32], [160, 24], [160, 40]]) {
      const m = moundRaces(commit, hold);
      const all = [m.easy, m.normal, m.hard];
      const mark = commit === MOUNDS.commit && hold === MOUNDS.hold ? "  <- the game's" : "";
      console.log(`commit ${commit} hold ${hold}: easy ${m.easy.mounds.join("/")}, normal ${m.normal.mounds.join("/")}, hard ${m.hard.mounds.join("/")} (sum ${sum(all.flatMap((r) => r.mounds))}); falls ${sum(all.flatMap((r) => r.falls))}; wall-hit ticks ${sum(all.flatMap((r) => r.walls))}${mark}`);
    }
  } else if (process.argv.includes("--walls")) {
    for (const l of wallGaps()) console.log(l);
    console.log(`ISLAND_NOSE ${ISLAND_NOSE}`);
  } else console.log("Usage: npx tsx tools/debug/split-tune.ts --race | --mounds | --walls");
}
