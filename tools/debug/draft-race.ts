// draft-race (M4-DRAFT/M4-CELLS, PLAN-M4.md 2.8): what the catch-up does to a real race, with no
// browser and no sockets: a Room on the sim clock with server bots, and optionally the host
// driven by the autopilot (the client's ?autopilot=1: the Normal driver with weapons off, a
// zero-lag "fast human"). Prints each car's finish, the lead changes per lap (the leader by race
// distance; raw, and with a a car length clear so running side by side is not dozens), the gaps
// to the autopilot, and the time each car spent drafting. --nodraft runs the same race with the
// slipstream switched off (DRAFT_SHAPE.far = 0), so the two can be compared.
//
//   npx tsx tools/debug/draft-race.ts --track rust-bowl --bots normal,normal --cars sport,sport --laps 3
//   npx tsx tools/debug/draft-race.ts --pilot --bots normal,normal,normal --laps 3 [--nodraft]

import { newBotMem, botControls, type BotLevel } from "../../shared/botdrive";
import { DRAFT_SHAPE } from "../../shared/catchup";
import { isCarType } from "../../shared/cars";
import { CAR_HP, NO_COMMAND } from "../../shared/weapons";
import { CAR_LENGTH, capsuleGap, wallLimit } from "../../shared/physics";
import { queryTrackNear } from "../../shared/track";
import type { ServerMsg } from "../../shared/protocol";
import { raceDistance } from "../../server/race";
import { solid } from "../../server/combat";
import { IMPACT_MIN_SPEED } from "../../client/contact";
import { Room, type Conn, type Player, type Session } from "../../server/room";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** The host's socket: notes the tick of each mine hit per car id (a spun car sliding into a wall is the mine's doing). */
class HostConn implements Conn {
  readonly mineHits = new Map<string, number>();
  tick = 0;
  send(m: ServerMsg): void {
    if (m.t === "ev" && m.ev.k === "hit" && m.ev.w === "mine") this.mineHits.set(m.ev.id, this.tick);
  }
  close(): void {}
}

export interface DraftRaceOut {
  names: string[];
  finish: number[]; // ticks after GO, 0 = did not finish
  changes: number[]; // lead changes per lap (hysteresis), by the leader's lap
  rawChanges: number;
  draftTicks: number[]; // ticks each car stepped with a draft > 0
  gaps: { mean: number; max: number; end: number }[]; // race distance behind the autopilot (pilot runs; + = behind; end: as it finished)
  contacts: number; // car-car contacts begun (a pair of solid cars touching)
  crashes: number; // ... of them with a closing speed >= IMPACT_MIN_SPEED (sparks and shake: a crash, not a rub)
  walls: number; // wall hits (a car reaching the wall), not counting mineWalls
  mineWalls: number; // ... within 2 s of the car being spun by a mine
  wrecks: number;
  falls: number;
  wake: { tuck: number; pass: number; passes: number; done: number; gaveUp: number }; // bots' slipstream use: ticks, passes begun, completed, given up
}

/**
 * One race. levels: the bots; cars: their car types (by bot); pilot: the host drives with the
 * autopilot (else it retires at GO). nodraft: the slipstream off. Deterministic.
 */
export function draftRace(opts: {
  track: string; levels: BotLevel[]; cars?: string[]; laps: number; pilot?: boolean; pilotLevels?: number[]; nodraft?: boolean; nowake?: boolean; weapons?: boolean; hyst?: number;
}): DraftRaceOut {
  const far = DRAFT_SHAPE.far;
  if (opts.nodraft) DRAFT_SHAPE.far = 0;
  try {
    const room = new Room("TUNE", opts.laps, CAR_HP);
    let now = 1000, tick = 0;
    const conn = new HostConn();
    const host = room.addPlayer("Pilot", { conn, room: null, player: null } as Session, now) as Player;
    if (room.trackId !== opts.track) {
      const e = room.setTrack(host, opts.track);
      if (e) throw new Error(e);
    }
    const bots = opts.levels.map((l, i) => {
      const b = room.addBot(host, l, now);
      if (typeof b === "string") throw new Error(b);
      const car = opts.cars?.[i];
      if (car && isCarType(car)) room.setCar(host, car, b.id);
      return b;
    });
    if (opts.weapons === false) for (const b of bots) b.bot!.mem.weapons = false;
    if (opts.nowake) for (const b of bots) b.bot!.mem.useWake = false;
    if (opts.pilotLevels) host.wallet.levels = { engine: opts.pilotLevels[0] ?? 0, tyres: opts.pilotLevels[1] ?? 0, welder: opts.pilotLevels[2] ?? 0 };
    const e = room.start(host, now);
    if (e) throw new Error(e);
    const mem = newBotMem(0, "normal");
    mem.weapons = false;
    mem.useWake = false; // a human on their own line (the physics drafts it all the same)
    let seq = 0, steps = 0;
    const feedHost = () => {
      if (!opts.pilot || !host.car) return;
      const racing = room.phase === "racing";
      if (racing) steps++;
      const ctl = racing ? botControls({ car: host.car, track: room.track, stats: host.stats, raceOn: true, raceSteps: steps, others: [], carType: host.carType }, mem) : NO_COMMAND;
      room.queueInputs(host, [[seq++, ctl.throttle, ctl.steer, 0]]);
    };
    const step = () => {
      feedHost();
      tick++;
      now += 1000 / 60;
      conn.tick = tick;
      room.tick(tick, now);
    };
    while (room.phase !== "racing") step();
    if (!opts.pilot && room.retire(host)) throw new Error("retire");
    const field = opts.pilot ? [host, ...bots] : bots;
    const out: DraftRaceOut = {
      names: field.map((p) => p.name), finish: field.map(() => 0), changes: Array(opts.laps).fill(0), rawChanges: 0, draftTicks: field.map(() => 0),
      gaps: bots.map(() => ({ mean: 0, max: -Infinity, end: 0 })), contacts: 0, crashes: 0, walls: 0, mineWalls: 0, wrecks: 0, falls: 0,
      wake: { tuck: 0, pass: 0, passes: 0, done: 0, gaveUp: 0 },
    };
    const wasPass = new Map<Player, boolean>();
    const touching = new Set<string>();
    const atWall = new Set<Player>();
    const prevState = new Map<Player, { wreck: number; fall: number }>();
    const before = new Map<Player, { x: number; y: number; vx: number; vy: number }>(); // pose and velocity a tick ago
    const drafts = (room as unknown as { drafts: number[] }).drafts;
    let leader = -1, rawLeader = -1, rt = 0, gapN = 0;
    const hyst = opts.hyst ?? CAR_LENGTH;
    while (room.phase === "racing" && rt < 60 * 60 * 5) {
      step();
      rt++;
      const racers = [...room.players.values()].filter((p) => p.car);
      racers.forEach((p, k) => {
        if (drafts[k] > 0) out.draftTicks[field.indexOf(p)]++;
      });
      for (let i = 0; i < racers.length; i++) {
        const a = racers[i], c = a.car!;
        const was = prevState.get(a) ?? { wreck: 0, fall: 0 };
        if (c.wreck > 0 && was.wreck === 0) out.wrecks++;
        if (c.fall > 0 && was.fall === 0) out.falls++;
        prevState.set(a, { wreck: c.wreck, fall: c.fall });
        const wall = c.air === 0 && c.fall === 0 && queryTrackNear(room.track, c.x, c.y, c.seg).dist >= wallLimit(room.track) - 0.01;
        if (wall && !atWall.has(a)) {
          if (tick - (conn.mineHits.get(a.id) ?? -Infinity) <= 120) out.mineWalls++;
          else out.walls++;
        }
        if (wall) atWall.add(a);
        else atWall.delete(a);
        for (let j = i + 1; j < racers.length; j++) {
          const b = racers[j], key = `${a.id}|${b.id}`;
          const touch = solid(a) && solid(b) && capsuleGap(c, b.car!) < 0.01;
          if (touch && !touching.has(key)) {
            out.contacts++;
            // Closing speed along the centre line, from the tick before (the bump has traded it since).
            const pa = before.get(a), pb = before.get(b);
            if (pa && pb) {
              const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.hypot(dx, dy) || 1;
              if (-((pb.vx - pa.vx) * dx + (pb.vy - pa.vy) * dy) / d >= IMPACT_MIN_SPEED) out.crashes++;
            }
          }
          if (touch) touching.add(key);
          else touching.delete(key);
        }
      }
      for (const b of bots) {
        const m = b.bot!.mem, w = m.wake, was = wasPass.get(b) ?? false;
        if (w && !w.pass) out.wake.tuck++;
        if (w?.pass) out.wake.pass++;
        if (w?.pass && !was) out.wake.passes++;
        if (was && !w?.pass) {
          if (m.wakeRest > 0) out.wake.gaveUp++;
          else out.wake.done++;
        }
        wasPass.set(b, !!w?.pass);
      }
      for (const p of racers) before.set(p, { x: p.car!.x, y: p.car!.y, vx: p.car!.vx, vy: p.car!.vy });
      const rd = field.map((p) => (p.progress ? raceDistance(room.track, p.progress) : -Infinity));
      field.forEach((p, k) => {
        if (!out.finish[k] && p.progress?.fin) out.finish[k] = rt;
      });
      const live = field.map((p, k) => (p.progress && !p.progress.fin ? k : -1)).filter((k) => k >= 0);
      if (live.length >= 2 && out.finish.every((f) => f === 0)) {
        const top = live.reduce((a, k) => (rd[k] > rd[a] ? k : a), live[0]);
        if (rawLeader >= 0 && top !== rawLeader) out.rawChanges++;
        rawLeader = top;
        if (leader < 0) leader = top;
        else if (top !== leader && rd[top] > rd[leader] + hyst) {
          const lap = Math.min(opts.laps - 1, field[top].progress!.lap);
          out.changes[lap]++;
          leader = top;
        }
      }
      if (opts.pilot && !host.progress?.fin) {
        gapN++;
        bots.forEach((_, i) => {
          const g = rd[0] - rd[i + 1];
          out.gaps[i].mean += g;
          out.gaps[i].max = Math.max(out.gaps[i].max, g);
          out.gaps[i].end = g;
        });
      }
    }
    for (const g of out.gaps) g.mean /= Math.max(1, gapN);
    return out;
  } finally {
    DRAFT_SHAPE.far = far;
  }
}

function main(): void {
  const levels = arg("bots", "normal,normal").split(",") as BotLevel[];
  const cars = process.argv.includes("--cars") ? arg("cars", "").split(",") : undefined;
  const pilotLevels = process.argv.includes("--pilot-levels") ? arg("pilot-levels", "0,0,0").split(",").map(Number) : undefined;
  const base = { levels, cars, laps: Number(arg("laps", "3")), pilot: process.argv.includes("--pilot") || !!pilotLevels, pilotLevels, weapons: !process.argv.includes("--noweapons") };
  const tracks = process.argv.includes("--all") ? ["rust-bowl", "crusher-run", "overpass-knot"] : [arg("track", "rust-bowl")];
  for (const track of tracks) {
    for (const after of [false, true]) {
      const r = draftRace({ ...base, track, nodraft: !after, nowake: !after });
      const head = `${after ? "AFTER (draft + wake)" : "BEFORE (no draft, lanes held)"} on ${track}, ${base.laps} laps${base.pilot ? `, host = autopilot${pilotLevels ? ` at levels ${pilotLevels.join("/")}` : ""}` : ""}${base.weapons ? "" : ", bots without weapons"}`;
      const tally = `contacts ${r.contacts} (crashes ${r.crashes}), wall hits ${r.walls} (+${r.mineWalls} after a mine), wrecks ${r.wrecks}, falls ${r.falls}; wake: tuck ${(r.wake.tuck / 60).toFixed(1)} s, pass ${(r.wake.pass / 60).toFixed(1)} s, passes ${r.wake.passes} (done ${r.wake.done}, given up ${r.wake.gaveUp})`;
      if (process.argv.includes("--all")) {
        console.log(`${head}: lead changes ${r.changes.join(",")}; ${tally}; finish ${r.finish.map((f) => (f / 60).toFixed(1)).join("/")} s`);
        continue;
      }
      console.log(`\n${head}`);
      r.names.forEach((n, k) => {
        const f = r.finish[k] ? `${(r.finish[k] / 60).toFixed(2)} s` : "DNF";
        console.log(`  ${n.padEnd(14)} finish ${f.padStart(8)}  drafting ${(r.draftTicks[k] / 60).toFixed(1)} s`);
      });
      console.log(`  lead changes per lap (a car length clear): ${r.changes.join(", ")}; raw leader switches ${r.rawChanges}`);
      console.log(`  ${tally}`);
      if (base.pilot) r.gaps.forEach((g, i) => console.log(`  ${r.names[i + 1].padEnd(14)} behind the autopilot: mean ${g.mean.toFixed(0)}, max ${g.max.toFixed(0)}, as it finished ${g.end.toFixed(0)} units`));
    }
  }
}

if (process.argv[1]?.endsWith("draft-race.ts")) main();
