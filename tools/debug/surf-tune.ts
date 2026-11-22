// surf-tune (M4-SURF part 1, ClickUp 123jpnbffyz): the numbers behind water, dirt patches, belts
// and tyre mounds, no browser.
//   --race    server bots on the Surf Yard (shared/testtracks.ts), 3 laps, per level (Easy, Normal,
//             Hard; Sport, Racer, Truck by add order): finish times, falls, wall-hit and mound-contact
//             ticks, ticks on each surface; run twice (identical = deterministic).
//   --water   the water model's effect (advisor change 4): a car through the Surf Yard's straight
//             pool at full throttle against the same run with the pool dry (time and speed lost), and
//             through the pool in its tightest bend on the line a dry car holds (how far wide it ends);
//             per car type. Also a dirt patch's and a belt's effect, and a mound bounce.
//   --golden  the Hard bots' control-stream hashes on the shipped tracks (tools/debug/hard-tune.ts
//             goldenServer, 3 Hard bots, two races; and the client path on Overpass Knot), to compare
//             with the ones recorded before M4-SURF touched shared/botdrive.ts (scripts/sim-test.ts).
//
//   npx tsx tools/debug/surf-tune.ts --race | --water | --golden

import { CAR_TYPES, CARS, type CarType } from "../../shared/cars";
import { CAPSULE_R, collideTyres, speedOf, type CarState } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { SURF_YARD } from "../../shared/testtracks";
import { buildTrack, localSeg, pointAt, queryTrackNear, roadOf, roadOfSeg, surfaceAt, SURF_BELT, SURF_DIRT, SURF_WATER, type Feature, type Track } from "../../shared/track";
import { CAR_HP, raceEnv, stepRaceCar } from "../../shared/weapons";
import { angleDiff, clamp } from "../../shared/physics";
import type { BotLevel } from "../../shared/botdrive";
import { wallHitSpeed } from "../../client/game";
import { Room, type Conn, type Player, type Session } from "../../server/room";
import { goldenClient, goldenServer } from "./hard-tune";

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results") this.msgs.push(m);
  }
  close(): void {}
}

export interface SurfRace {
  phase: string;
  ticks: number;
  finish: string[]; // name:seconds, in finish order
  falls: number[];
  walls: number[]; // wall-hit ticks (>= 50 u/s into the wall) per bot
  mounds: number[]; // ticks in contact with a tyre mound per bot
  on: { water: number; dirt: number; belt: number }[]; // ticks per surface per bot
  digest: string; // every tick's car states, for the rerun check
}

/**
 * A 3-lap race of three server bots of `level` on `trackId` (with the dev flag on), the host
 * retired at GO; `cars` overrides the round-robin car types.
 */
export function surfRace(level: BotLevel, laps = 3, trackId = SURF_YARD.id, levels?: BotLevel[]): SurfRace {
  const old = process.env.SCRAP_DEV_TRACK;
  process.env.SCRAP_DEV_TRACK = trackId;
  try {
    const room = new Room("SURF", laps, CAR_HP, trackId);
    let now = 1000, tick = 0;
    const conn = new HostConn();
    const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
    const bots = (levels ?? [level, level, level]).map((l) => {
      const b = room.addBot(host, l, now);
      if (typeof b === "string") throw new Error(b);
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
    const out: SurfRace = { phase: "", ticks: 0, finish: [], falls: Array(n).fill(0), walls: Array(n).fill(0), mounds: Array(n).fill(0), on: bots.map(() => ({ water: 0, dirt: 0, belt: 0 })), digest: "" };
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
        if (c.air === 0 && c.fall === 0 && c.wreck === 0 && p.air === 0) {
          if (wallHitSpeed(p, c, t) >= 50) out.walls[k]++;
          const q = queryTrackNear(t, p.x, p.y, p.seg);
          const f = surfaceAt(t, q.seg, q.s, q.lat);
          if (f?.kind === SURF_WATER) out.on[k].water++;
          else if (f?.kind === SURF_DIRT) out.on[k].dirt++;
          else if (f?.kind === SURF_BELT) out.on[k].belt++;
          if (touchesMound(t, c)) out.mounds[k]++;
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

/** The tyre bucket of a car's segment hint (BR-PHYS: a global segment, on its road; the track's own without branches). */
function tyresOf(t: Track, g: number) {
  return roadOf(t, roadOfSeg(t, g)).tyresAt[localSeg(t, g)];
}

/** Does the car's capsule touch a tyre mound (at most 0.01 apart: collideTyres pushes it out to touching)? */
export function touchesMound(t: Track, c: CarState): boolean {
  const ux = Math.cos(c.h), uy = Math.sin(c.h);
  return (tyresOf(t, c.seg) ?? []).some((m) => {
    const k = clamp((m.x - c.x) * ux + (m.y - c.y) * uy, -7.5, 7.5);
    return Math.hypot(c.x + ux * k - m.x, c.y + uy * k - m.y) <= m.r + CAPSULE_R + 0.01;
  });
}

/** The Surf Yard without one feature kind (or with its features replaced): a dry reference. */
export function yardWith(features: Feature[]): Track {
  return buildTrack({ ...SURF_YARD, id: "surf-ref", features });
}

/** Drive a car from s0 at speed v on lane `lat` holding that lane with a simple aim (full throttle), for `ticks`. */
export function laneRun(t: Track, type: CarType, s0: number, v: number, lat: number, ticks: number, throttle = 1): { states: CarState[] } {
  const p = pointAt(t, s0);
  const c: CarState = { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
  const stats = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
  const env = raceEnv(t);
  const states: CarState[] = [];
  for (let i = 0; i < ticks; i++) {
    const q = queryTrackNear(t, c.x, c.y, c.seg);
    const a = pointAt(t, q.s + 60 + speedOf(c) * 0.2);
    const tx = a.x - Math.sin(a.h) * lat, ty = a.y + Math.cos(a.h) * lat;
    env.rt = i + 1;
    stepRaceCar(c, { throttle, steer: clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1) }, stats, env);
    states.push({ ...c });
  }
  return { states };
}

export function sOf(t: Track, c: CarState): { s: number; lat: number } {
  const q = queryTrackNear(t, c.x, c.y, c.seg);
  return { s: q.s, lat: q.lat };
}

/** Ticks until the car's s passes `s1` (or -1), and its speed then. */
export function passes(t: Track, states: CarState[], s1: number): { tick: number; v: number } {
  for (let i = 0; i < states.length; i++) if (sOf(t, states[i]).s >= s1) return { tick: i + 1, v: speedOf(states[i]) };
  return { tick: -1, v: 0 };
}

export function waterNumbers(): string[] {
  const out: string[] = [];
  const yard = buildTrack(SURF_YARD);
  const dry = yardWith(SURF_YARD.features!.filter((f) => f.k !== "water" && f.k !== "dirt" && f.k !== "belt"));
  const f1 = (v: number) => v.toFixed(1);
  for (const type of CAR_TYPES) {
    const st = statsFor(type, { engine: 0, tyres: 0, welder: 0 });
    out.push(`${CARS[type].name}: water grip x${f1(st.dirtGrip / 3 * 100)}% of dry (${(st.grip * st.dirtGrip / 3).toFixed(2)}/s vs ${st.grip}/s), dirt drag x${st.dirtGrip ? st.dirtDrag : 0} (top ${f1(st.topSpeed / st.dirtDrag)} u/s), dirt grip x${st.dirtGrip}`);
    // The straight pool 1450..1620 (felt 1462..1608), full width: from 1300 on the centre at two speeds.
    for (const v of [430, 300]) {
      const a = laneRun(yard, type, 1300, v, 0, 120), b = laneRun(dry, type, 1300, v, 0, 120);
      const pa = passes(yard, a.states, 1700), pb = passes(dry, b.states, 1700);
      out.push(`  straight pool from ${v} u/s: 1300 -> 1700 in ${pa.tick} ticks (dry ${pb.tick}), ${pa.tick - pb.tick} ticks lost, ${f1(pa.v)} u/s out (dry ${f1(pb.v)})`);
    }
    // The pool on the outside half of the tightest right-hander (2880..3160, lat -64..0): a car on
    // lane -32 at the speed a dry car holds that lane at full throttle, then its widest lateral.
    for (const v of [330, 400]) {
      const a = laneRun(yard, type, 2780, v, -32, 110), b = laneRun(dry, type, 2780, v, -32, 110);
      const wide = (r: { states: CarState[] }, t: Track) => Math.min(...r.states.map((c) => sOf(t, c).lat));
      const endA = sOf(yard, a.states[a.states.length - 1]), endB = sOf(dry, b.states[b.states.length - 1]);
      out.push(`  bend pool (R~424, lane -32) at ${v} u/s: widest lat ${f1(wide(a, yard))} (dry ${f1(wide(b, dry))}); after ${a.states.length} ticks at s ${f1(endA.s)} lat ${f1(endA.lat)} (dry s ${f1(endB.s)} lat ${f1(endB.lat)})`);
    }
    // The dirt patch 1240..1400 x 16..64 (felt 1252..1388 x 28..52): on lane 40 from 300 u/s.
    const a = laneRun(yard, type, 1100, 380, 40, 150), b = laneRun(dry, type, 1100, 380, 40, 150);
    const pa = passes(yard, a.states, 1420), pb = passes(dry, b.states, 1420);
    out.push(`  dirt patch on lane 40 from 380 u/s: 1100 -> 1420 in ${pa.tick} ticks (dry ${pb.tick}), out at ${f1(pa.v)} u/s (dry ${f1(pb.v)})`);
  }
  // The belt 2300..2520 drifting right at 70 u/s: a car holding lane 0 with no steering at 300 u/s.
  {
    const p = pointAt(yard, 2250);
    const c: CarState = { x: p.x, y: p.y, h: p.h, vx: Math.cos(p.h) * 300, vy: Math.sin(p.h) * 300, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    const env = raceEnv(yard);
    const lat0 = sOf(yard, c).lat;
    let i = 0;
    for (; i < 200 && sOf(yard, c).s < 2560; i++) stepRaceCar(c, { throttle: 0.6, steer: 0 }, statsFor("sport", { engine: 0, tyres: 0, welder: 0 }), env);
    const ref = { ...c };
    const p2 = pointAt(dry, 2250);
    const d: CarState = { x: p2.x, y: p2.y, h: p2.h, vx: Math.cos(p2.h) * 300, vy: Math.sin(p2.h) * 300, seg: p2.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    for (let k = 0; k < i; k++) stepRaceCar(d, { throttle: 0.6, steer: 0 }, statsFor("sport", { engine: 0, tyres: 0, welder: 0 }), raceEnv(dry));
    out.push(`belt (vx 70, 220 long): a Sport at ~300 u/s, no steering, 2250 -> 2560: lat ${f1(lat0)} -> ${f1(sOf(yard, ref).lat)} (dry: ${f1(sOf(dry, d).lat)}), drift ${f1(sOf(yard, ref).lat - sOf(dry, d).lat)} units in ${i} ticks`);
  }
  // A mound bounce: straight into the chicane's first mound (s 700, lat -30, r 24) on its line.
  for (const v of [150, 300, 430]) {
    const m = yard.tyres[0];
    const p = pointAt(yard, 600);
    const c: CarState = { x: p.x - Math.sin(p.h) * m.lat, y: p.y + Math.cos(p.h) * m.lat, h: p.h, vx: Math.cos(p.h) * v, vy: Math.sin(p.h) * v, seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0 };
    let hit = 0, i = 0;
    for (; i < 120 && !hit; i++) {
      const before = { ...c };
      stepRaceCar(c, { throttle: 0, steer: 0 }, statsFor("sport", { engine: 0, tyres: 0, welder: 0 }), raceEnv(yard));
      const probe = { ...before };
      if (collideTyres(probe, tyresOf(yard, c.seg)) > 0 || Math.hypot(c.vx - before.vx, c.vy - before.vy) > 50) hit = speedOf(before);
    }
    out.push(`mound (r 24) head-on, coasting at ${v} u/s: hit at ${f1(hit)} u/s, bounced back at ${f1(speedOf(c))} u/s (vx along the road ${f1(c.vx * Math.cos(p.h) + c.vy * Math.sin(p.h))})`);
  }
  return out;
}

/** The Hard bots' control-stream hashes on the shipped tracks (and the client path on Overpass Knot). */
export function hardHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of ["rust-bowl", "crusher-run", "overpass-knot"]) out[`${t} hard`] = goldenServer(t, ["hard", "hard", "hard"]).hash;
  out["client overpass-knot hard"] = goldenClient("overpass-knot", 2, "hard").hash;
  return out;
}

if (process.argv[1]?.endsWith("surf-tune.ts")) {
  if (process.argv.includes("--race")) {
    for (const level of ["easy", "normal", "hard"] as BotLevel[]) {
      const a = surfRace(level), b = surfRace(level);
      console.log(`${level.padEnd(6)} ${a.phase} ${a.ticks} ticks; finish ${a.finish.join(", ")}; falls ${a.falls.join("/")}; wall-hit ticks ${a.walls.join("/")}; mound-contact ticks ${a.mounds.join("/")}; on water/dirt/belt ${a.on.map((o) => `${o.water}/${o.dirt}/${o.belt}`).join("  ")}; rerun ${a.digest === b.digest ? "identical" : "DIFFERS"}`);
    }
  } else if (process.argv.includes("--water")) {
    for (const l of waterNumbers()) console.log(l);
  } else if (process.argv.includes("--golden")) {
    for (const [k, v] of Object.entries(hardHashes())) console.log(k, v);
  } else console.log("Usage: npx tsx tools/debug/surf-tune.ts --race | --water | --golden");
}
