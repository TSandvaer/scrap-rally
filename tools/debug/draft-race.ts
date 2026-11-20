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
import { CAR_LENGTH } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { raceDistance } from "../../server/race";
import { Room, type Conn, type Player, type Session } from "../../server/room";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

class NullConn implements Conn {
  send(_m: ServerMsg): void {}
  close(): void {}
}

export interface DraftRaceOut {
  names: string[];
  finish: number[]; // ticks after GO, 0 = did not finish
  changes: number[]; // lead changes per lap (hysteresis), by the leader's lap
  rawChanges: number;
  draftTicks: number[]; // ticks each car stepped with a draft > 0
  gaps: { mean: number; max: number }[]; // race distance behind the autopilot (pilot runs; + = behind)
}

/**
 * One race. levels: the bots; cars: their car types (by bot); pilot: the host drives with the
 * autopilot (else it retires at GO). nodraft: the slipstream off. Deterministic.
 */
export function draftRace(opts: { track: string; levels: BotLevel[]; cars?: string[]; laps: number; pilot?: boolean; nodraft?: boolean; weapons?: boolean; hyst?: number }): DraftRaceOut {
  const far = DRAFT_SHAPE.far;
  if (opts.nodraft) DRAFT_SHAPE.far = 0;
  try {
    const room = new Room("TUNE", opts.laps, CAR_HP);
    let now = 1000, tick = 0;
    const host = room.addPlayer("Pilot", { conn: new NullConn(), room: null, player: null } as Session, now) as Player;
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
    const e = room.start(host, now);
    if (e) throw new Error(e);
    const mem = newBotMem(0, "normal");
    mem.weapons = false;
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
      room.tick(tick, now);
    };
    while (room.phase !== "racing") step();
    if (!opts.pilot && room.retire(host)) throw new Error("retire");
    const field = opts.pilot ? [host, ...bots] : bots;
    const out: DraftRaceOut = { names: field.map((p) => p.name), finish: field.map(() => 0), changes: Array(opts.laps).fill(0), rawChanges: 0, draftTicks: field.map(() => 0), gaps: bots.map(() => ({ mean: 0, max: -Infinity })) };
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
  const opts = { track: arg("track", "rust-bowl"), levels, cars, laps: Number(arg("laps", "3")), pilot: process.argv.includes("--pilot"), weapons: !process.argv.includes("--noweapons") };
  for (const nodraft of process.argv.includes("--nodraft") ? [true] : [true, false]) {
    const r = draftRace({ ...opts, nodraft });
    console.log(`\n${nodraft ? "WITHOUT draft" : "WITH draft"} on ${opts.track}, ${opts.laps} laps${opts.pilot ? ", host = autopilot" : ""}${opts.weapons ? "" : ", bots without weapons"}`);
    r.names.forEach((n, k) => {
      const f = r.finish[k] ? `${(r.finish[k] / 60).toFixed(2)} s` : "DNF";
      console.log(`  ${n.padEnd(14)} finish ${f.padStart(8)}  drafting ${(r.draftTicks[k] / 60).toFixed(1)} s`);
    });
    console.log(`  lead changes per lap (a car length clear): ${r.changes.join(", ")}; raw leader switches ${r.rawChanges}`);
    if (opts.pilot) r.gaps.forEach((g, i) => console.log(`  ${r.names[i + 1].padEnd(14)} behind the autopilot: mean ${g.mean.toFixed(0)}, max ${g.max.toFixed(0)} units`));
  }
}

if (process.argv[1]?.endsWith("draft-race.ts")) main();
