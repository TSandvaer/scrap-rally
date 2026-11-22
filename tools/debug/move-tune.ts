// move-tune (M4-MOVE, ClickUp 123jpnbffz5): the numbers behind the rolling barrels, the crusher presses
// and the parked ramp truck, no browser.
//   --race    server bots on the Move Yard (shared/testtracks.ts), 3 laps, per level (Easy, Normal, Hard;
//             Sport, Racer, Truck by add order), weapons off and on, and a 5-bot race (every seat):
//             finish times, falls, wall hits, and per bot the ticks in contact with a barrel, a press and
//             a truck's body, the truck jumps taken and the press waits; run twice (identical =
//             deterministic).
//
//   --blind   the same races with the bots blind to the barrels and the presses (botdrive MOVE.see =
//             false; the trucks they still see): the baseline the contacts are measured against.
//
//   npx tsx tools/debug/move-tune.ts --race [--blind]
//
// The contact probe (moveContact) is independent of shared/physics.ts's contact math: it samples the
// car's axis against each barrel, press box and truck axis.

import { MOVE, type BotLevel } from "../../shared/botdrive";
import { CAPSULE_HALF, CAPSULE_R, type CarState } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { MOVE_YARD } from "../../shared/testtracks";
import { BARREL_R, barrelLat, LIP_ZONE, PRESS_DEPTH, pressDown, queryTrackNear, TRUCK_HALF, TRUCK_MIN_SPEED, type Track } from "../../shared/track";
import { CAR_HP } from "../../shared/weapons";
import { wallHitSpeed } from "../../client/game";
import { Room, type Conn, type Player, type Session } from "../../server/room";

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results") this.msgs.push(m);
  }
  close(): void {}
}

/** Points along the car's axis, for the probe. */
const AXIS = Array.from({ length: 31 }, (_, i) => -CAPSULE_HALF + (2 * CAPSULE_HALF * i) / 30);

/**
 * What a driving car's capsule touches at race tick rt (within `eps`): "barrel", "press" (one that is
 * down), "truck" (a truck's body: not while its centre is in the band at TRUCK_MIN_SPEED or more, as
 * on the ramp), or null. Sampled along its axis: independent of shared/physics.ts.
 */
export function moveContact(t: Track, c: CarState, rt: number, eps = 0.01): "barrel" | "press" | "truck" | null {
  const ux = Math.cos(c.h), uy = Math.sin(c.h);
  let barrel = Infinity, press = Infinity, truck = Infinity;
  for (const a of AXIS) {
    const px = c.x + ux * a, py = c.y + uy * a;
    for (const b of t.barrels) {
      for (let k = 0; k < b.n; k++) {
        const lat = barrelLat(b, k, rt);
        if (lat !== lat) continue;
        barrel = Math.min(barrel, Math.hypot(px - b.x - b.nx * lat, py - b.y - b.ny * lat) - BARREL_R - CAPSULE_R);
      }
    }
    for (const g of t.presses) {
      if (!pressDown(g, rt)) continue;
      const ga = (px - g.x) * Math.cos(g.h) + (py - g.y) * Math.sin(g.h), gl = (px - g.x) * g.nx + (py - g.y) * g.ny;
      const da = Math.max(0, Math.abs(ga) - PRESS_DEPTH / 2), dl = Math.max(0, g.lat0 - gl, gl - g.lat1);
      press = Math.min(press, Math.hypot(da, dl) - CAPSULE_R);
    }
    for (const tr of t.trucks) {
      const ex = tr.x1 - tr.x0, ey = tr.y1 - tr.y0;
      const k = Math.max(0, Math.min(1, ((px - tr.x0) * ex + (py - tr.y0) * ey) / (ex * ex + ey * ey)));
      truck = Math.min(truck, Math.hypot(px - tr.x0 - ex * k, py - tr.y0 - ey * k) - TRUCK_HALF - CAPSULE_R);
    }
  }
  if (barrel <= eps) return "barrel";
  if (press <= eps) return "press";
  if (truck <= eps) {
    // On the ramp: the centre in the band at TRUCK_MIN_SPEED or more is not a contact.
    const q = queryTrackNear(t, c.x, c.y, c.seg);
    const a = t.pts[q.seg], b = t.pts[(q.seg + 1) % t.pts.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const fwd = (c.vx * (b.x - a.x) + c.vy * (b.y - a.y)) / l;
    const riding = t.trucks.some((tr) => q.lat >= tr.band0 && q.lat <= tr.band1 && q.s >= tr.s - 25 && q.s < tr.lip + LIP_ZONE && fwd >= TRUCK_MIN_SPEED);
    if (!riding) return "truck";
  }
  return null;
}

export interface MoveRace {
  phase: string;
  ticks: number;
  finish: string[]; // name:seconds, in finish order
  cars: string[]; // each bot's car type, by add order
  falls: number[];
  walls: number[]; // wall-hit ticks (>= 50 u/s into a wall) per bot
  barrels: number[]; // ticks in contact with a barrel per bot
  presses: number[]; // ... with a press that is down
  trucks: number[]; // ... with a truck's body
  jumps: number[]; // truck jumps taken (take-offs within a truck's length of one)
  waits: number[]; // ticks standing (< 20 u/s) within 120 before a press
  wrecks: number[];
  digest: string; // every tick's car states, for the rerun check
}

/** A race of server bots of `levels` on the Move Yard (the dev flag on), the host retired at GO; weapons false: no bot shoots or drops a mine. */
export function moveRace(levels: BotLevel[], laps = 3, weapons = false, trackId = MOVE_YARD.id): MoveRace {
  const old = process.env.SCRAP_DEV_TRACK;
  process.env.SCRAP_DEV_TRACK = trackId;
  try {
    const room = new Room("MOVE", laps, CAR_HP, trackId);
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
    const zero = () => Array(n).fill(0) as number[];
    const out: MoveRace = {
      phase: "", ticks: 0, finish: [], cars: bots.map((b) => b.carType), falls: zero(), walls: zero(), barrels: zero(), presses: zero(), trucks: zero(),
      jumps: zero(), waits: zero(), wrecks: zero(), digest: "",
    };
    const prev = bots.map((b) => ({ ...b.car! }));
    const parts: number[] = [];
    while (room.phase === "racing" && out.ticks < 60 * 60 * 5) {
      step();
      out.ticks++;
      const rt = room.rt;
      bots.forEach((b, k) => {
        const c = b.car;
        if (!c) return;
        const p = prev[k];
        if (c.fall > 0 && p.fall === 0) out.falls[k]++;
        if (c.wreck > 0 && p.wreck === 0) out.wrecks[k]++;
        const q = queryTrackNear(t, c.x, c.y, c.seg);
        if (c.air > 0 && p.air === 0 && t.trucks.some((tr) => q.s >= tr.s && q.s <= tr.s + tr.len + 20)) out.jumps[k]++;
        if (c.air === 0 && c.fall === 0 && c.wreck === 0 && p.air === 0 && !b.progress?.fin) {
          if (wallHitSpeed(p, c, t) >= 50) out.walls[k]++;
          const hit = moveContact(t, c, rt);
          if (hit === "barrel") out.barrels[k]++;
          else if (hit === "press") out.presses[k]++;
          else if (hit === "truck") out.trucks[k]++;
          if (Math.hypot(c.vx, c.vy) < 20 && t.presses.some((g) => g.s - q.s > 0 && g.s - q.s < 120)) out.waits[k]++;
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

/** One race's row for the report. */
export function raceRow(name: string, r: MoveRace): string {
  return `${name.padEnd(16)} ${r.phase} ${(r.ticks / 60).toFixed(1)} s | finish ${r.finish.join(" ")} | cars ${r.cars.join("/")} | falls ${r.falls.join("/")} walls ${r.walls.join("/")} | barrel ${r.barrels.join("/")} press ${r.presses.join("/")} truck ${r.trucks.join("/")} | jumps ${r.jumps.join("/")} waits ${r.waits.join("/")} wrecks ${r.wrecks.join("/")} | ${r.digest}`;
}

if (process.argv[1]?.endsWith("move-tune.ts") && process.argv.includes("--race")) {
  if (process.argv.includes("--blind")) MOVE.see = false;
  const levels: BotLevel[] = ["easy", "normal", "hard"];
  for (const weapons of [false, true]) {
    for (const level of levels) {
      const a = moveRace([level, level, level], 3, weapons), b = moveRace([level, level, level], 3, weapons);
      console.log(raceRow(`${level}${weapons ? " +weapons" : ""}`, a), a.digest === b.digest ? "rerun SAME" : `rerun DIFFERS ${b.digest}`);
    }
  }
  const five = moveRace(["hard", "normal", "easy", "hard", "normal"], 3, true);
  console.log(raceRow("5 bots +weapons", five), five.digest === moveRace(["hard", "normal", "easy", "hard", "normal"], 3, true).digest ? "rerun SAME" : "rerun DIFFERS");
}
