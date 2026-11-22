// schema-hash (M4-SCHEMA, ClickUp 123jpnbffqj): proves a track-schema change changes no behaviour.
// For every shipped track it hashes, bit for bit (float64 bits, not rounded text):
//   built   - the arrays buildTrack makes today (pts, cum, length, wall, checkpoints, ramps, gaps,
//             holes, cells, recovery), so new per-sample fields may be added beside them;
//   queries - the track queries over a dense set of points (queryTrack, queryTrackNear's dist/nx/ny/
//             s/seg, pointAt, gapAt, holeAt, lipAt, recoveryAt, overHazard, gridSlot, wallLimit,
//             startStraightEnd, minSelfClearance) and the validators' output (validateTrack,
//             validateRunUps for every car type at L0 and L3);
//   botsDirect - three server bots (Normal, Normal, Easy; sport, racer, truck) driven by botStep and
//             stepRaceCar with the slipstream and car-car contacts, no room: every tick's control
//             stream (throttle, steer, buttons, mine press) and every car state;
//   room    - a 3-lap Room race of the same three bots on the sim clock (the host retires at GO):
//             every tick's car states, progress, shots and mines, then the results and the wallets;
//   walls   - wall contacts (M4-SURF, the M4-SCHEMA review's F4): at every 6th sample, cars driven
//             from the centerline and from near each wall into the left and the right wall at a
//             spread of angles and speeds (full throttle, steering held into the wall, and one
//             scraping along it), 45 ticks each through stepRaceCar: every tick's car state and
//             the client's wallHitSpeed (a 1e-6 change to the wall bounce shows here directly).
// Each part is run twice and must hash the same (the tool's own determinism).
// BR-SCHEMA (PLAN-BRANCH advisor change 8): test tracks with branches (Branch Yard) are hashed too, as
// `built` and `queries` (their main road, as above) and `branches`, a part emitted only for a track whose
// branches are not empty: every branch's built road (its samples, walls, features, buckets with the gores'
// noses, recovery points), its gores and mapS, the track's mouthAt and its cells (the branch cells after the
// main road's), and the branch queries over dense points round each branch: queryRoads without a hint and
// with hints >= n (on the branch) and on the main road beside it, each query's road, global segment and
// mainS; pointAt and recoveryAt / recoveryFor along each branch (clamped and past its ends). Bots and rooms
// do not drive a branch yet (BR-PHYS, BR-BOTS): no botsDirect, room or walls part for these.
// THEME-SCHEMA (PLAN-THEMES 2.5, ClickUp 123jpnbfgj1): the theme yards (Dune Yard, Block Yard, Canopy Yard)
// are hashed separately, as `built` and `queries` (as above) and `features`: the track's theme, its theme
// surfaces as declared (sand, oil, fords) and as felt (themeSurfaces, themeAt per segment), and the M4 lists
// and buckets beside them (water, dirt, belts, mounds, barrels, the truck, the press, the split), so a later
// change to a yard shows on its own line. The shipped tracks and Branch Yard are hashed exactly as before (a
// theme is a def field; the hashes are of built arrays and behaviour).
// --check prints SAME, DIFF, NEW (a part the golden file does not have yet) or GONE (one it has that is not
// made any more); DIFF and GONE fail it, NEW does not (record it with --write).
//
//   npx tsx tools/debug/schema-hash.ts            print the hashes
//   npx tsx tools/debug/schema-hash.ts --write    record them in tools/debug/schema-hash.golden.json
//   npx tsx tools/debug/schema-hash.ts --check    compare with that file (exit code 1 if any differs)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAR_TYPES } from "../../shared/cars";
import { draftsFor } from "../../shared/catchup";
import { BASE_STATS, collideCars, wallLimit, type CarState } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { statsFor } from "../../shared/shop";
import { BRANCH_YARD, THEME_YARDS } from "../../shared/testtracks";
import { themeOf } from "../../shared/theme";
import {
  buildTrack,
  gapAt,
  globalSeg,
  mainS,
  queryRoads,
  recoveryFor,
  roadOf,
  segCount,
  gridSlot,
  holeAt,
  lipAt,
  minSelfClearance,
  overHazard,
  pointAt,
  queryTrack,
  queryTrackNear,
  recoveryAt,
  startStraightEnd,
  validateTrack,
  type Track,
  type TrackQuery,
} from "../../shared/track";
import { trackList } from "../../shared/tracks";
import { CAR_HP, raceEnv, stepRaceCar, validateRunUps } from "../../shared/weapons";
import type { BotLevel } from "../../shared/botdrive";
import { botCar, botStep, newBotSeat, type BotSeat } from "../../server/bots";
import { wallHitSpeed } from "../../client/game";
import { solid, type Fighter } from "../../server/combat";
import { Room, type Conn, type Player, type Session } from "../../server/room";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "schema-hash.golden.json");
const LEVELS: BotLevel[] = ["normal", "normal", "easy"];

/** A sha256 fed float64 bits, integers and strings. */
class Hasher {
  private readonly h = createHash("sha256");
  private readonly buf = Buffer.alloc(8);
  f(...vs: number[]): void {
    for (const v of vs) {
      this.buf.writeDoubleLE(v);
      this.h.update(this.buf);
    }
  }
  s(v: string): void {
    this.f(v.length);
    this.h.update(v);
  }
  hex(): string {
    return this.h.digest("hex");
  }
}

function car(h: Hasher, c: CarState | null): void {
  if (!c) return h.s("-");
  h.f(c.x, c.y, c.h, c.vx, c.vy, c.seg, c.wreck, c.air, c.fall, c.boost);
}

function query(h: Hasher, q: TrackQuery): void {
  h.f(q.dist, q.nx, q.ny, q.s, q.seg);
}

/** Today's built arrays (the fields a Track has before M4-SCHEMA), by name. */
function hashBuilt(t: Track): string {
  const h = new Hasher();
  for (const p of t.pts) h.f(p.x, p.y);
  h.f(...t.cum, t.length, t.wall, ...t.checkpoints);
  for (const r of t.ramps) h.f(r.s, r.len);
  for (const g of t.gaps) { h.f(g.s0, g.s1); h.s(String(!!g.scrap)); }
  for (const o of t.holes) h.f(o.s, o.lat, o.r, o.x, o.y);
  for (const c of t.cells) { h.f(c.s, c.lat, c.x, c.y, c.seg); h.s(String(!!c.air)); }
  h.f(...t.recovery);
  return h.hex();
}

/**
 * BR-SCHEMA: the branches (only for a track that has them): their built roads, gores, mapS, the track's
 * mouthAt and cells, and the branch queries (queryRoads without a hint and with hints >= n).
 */
function hashBranches(t: Track): string {
  const h = new Hasher();
  const n = t.pts.length;
  h.f(...t.mouthAt);
  for (const c of t.cells) { h.f(c.s, c.lat, c.x, c.y, c.seg, c.road ?? 0); h.s(String(!!c.air)); }
  for (const b of t.branches) {
    const r = b.road;
    h.f(b.base, b.s0, b.s1, b.side, r.roadNo, r.length, r.wall, segCount(r));
    h.s(r.def.id);
    for (const p of r.pts) h.f(p.x, p.y);
    h.f(...r.cum, ...r.halfL, ...r.halfR, ...r.wallL, ...r.wallR, ...b.mapS, ...r.recovery);
    for (const w of r.widens) h.f(w.s0, w.s1, w.left, w.right);
    for (const g of [b.forkGore, b.mergeGore]) {
      if (!g) { h.s("no gore"); continue; }
      h.f(g.u, g.s, g.x, g.y, g.angle);
      for (const m of [g.noseMain, g.noseBranch]) h.f(m.s, m.lat, m.r, m.x, m.y, m.seg);
    }
    for (const x of r.ramps) h.f(x.s, x.len);
    for (const x of r.gaps) h.f(x.s0, x.s1);
    for (const x of r.holes) h.f(x.s, x.lat, x.r, x.x, x.y);
    for (const x of [...r.water, ...r.dirt]) h.f(x.s0, x.s1, x.lat0, x.lat1);
    for (const x of r.tyres) h.f(x.s, x.lat, x.r, x.x, x.y, x.seg);
    for (const road of [t, r]) {
      for (let i = 0; i < segCount(road); i++) {
        h.f(i, road.surfAt[i].length, road.tyresAt[i].length, road.islandsAt[i].length, road.barrelsAt[i].length, road.pressesAt[i].length, road.trucksAt[i].length);
        for (const m of road.tyresAt[i]) h.f(m.x, m.y, m.r);
      }
    }
    // Queries round the branch: every sample (and a third of the way along each segment), across both
    // roads and past their walls; without a hint, with the branch's own global segment and two either
    // side (hints >= n), and with the main road's segment beside it.
    for (let i = 0; i < r.pts.length; i++) {
      for (const frac of [0, 0.37]) {
        if (i === r.pts.length - 1 && frac > 0) continue;
        const u = r.cum[i] + frac * ((r.cum[i + 1] ?? r.cum[i]) - r.cum[i]);
        const at = pointAt(r, u);
        const mainSeg = pointAt(t, b.mapS[i]).seg;
        for (let lat = -2.6 * t.wall; lat <= 2.6 * t.wall; lat += 11.5) {
          const x = at.x - Math.sin(at.h) * lat, y = at.y + Math.cos(at.h) * lat;
          for (const hint of [-1, b.base + at.seg, b.base + Math.max(0, at.seg - 2), b.base + Math.min(segCount(r) - 1, at.seg + 2), mainSeg]) {
            const q = queryRoads(t, x, y, hint);
            query(h, q);
            h.f(q.side, q.road, globalSeg(t, q), mainS(t, q), globalSeg(t, q) >= n ? 1 : 0);
          }
        }
      }
    }
    for (let u = -60; u < r.length + 60; u += 5.3) {
      const p = pointAt(r, u);
      const rf = recoveryFor(t, r.roadNo, u);
      h.f(p.x, p.y, p.h, p.seg, recoveryAt(r, u), rf.road, rf.s);
    }
    h.f(roadOf(t, r.roadNo).length);
  }
  return h.hex();
}

/**
 * THEME-SCHEMA: a theme yard's features as buildTrack places them: its theme, the theme surfaces (declared
 * and felt, per segment), and the M4 lists and per-segment buckets beside them.
 */
function hashFeatures(t: Track): string {
  const h = new Hasher();
  h.s(themeOf(t.def));
  for (const x of t.sand) h.f(x.s0, x.s1, x.lat0, x.lat1);
  h.s("oil");
  for (const x of t.oil) h.f(x.s0, x.s1, x.lat0, x.lat1);
  h.s("fords");
  for (const x of t.fords) h.f(x.s0, x.s1, x.lat0, x.lat1, x.vx);
  h.s("felt");
  for (const x of t.themeSurfaces) h.f(x.kind, x.s0, x.s1, x.lat0, x.lat1, x.vx);
  h.s("m4");
  for (const x of [...t.water, ...t.dirt]) h.f(x.s0, x.s1, x.lat0, x.lat1);
  for (const x of t.belts) h.f(x.s0, x.s1, x.lat0, x.lat1, x.vx);
  for (const x of t.surfaces) h.f(x.kind, x.s0, x.s1, x.lat0, x.lat1, x.vx);
  for (const x of t.tyres) h.f(x.s, x.lat, x.r, x.x, x.y, x.seg);
  for (const x of t.barrels) h.f(x.s, x.n, x.period, x.speed, x.x, x.y, x.h, x.seg, x.lat0, x.lat1, x.roll, ...x.offsets);
  for (const x of t.trucks) h.f(x.s, x.lat, x.len, x.x0, x.y0, x.x1, x.y1, x.lip, x.band0, x.band1);
  for (const x of t.presses) h.f(x.s, x.lat0, x.lat1, x.period, x.down, x.x, x.y, x.h, x.seg);
  for (const x of t.widens) h.f(x.s0, x.s1, x.left, x.right);
  for (const x of t.islands) h.f(x.s0, x.s1, x.lat0, x.lat1, x.outL, x.outR, x.lenL, x.lenR, x.surfL.length, x.surfR.length, ...x.head.flatMap((p) => [p.x, p.y]), ...x.tail.flatMap((p) => [p.x, p.y]));
  h.f(...t.halfL, ...t.halfR, ...t.wallL, ...t.wallR);
  for (let i = 0; i < segCount(t); i++) {
    h.f(i, t.surfAt[i].length, t.surfFrom[i], t.tyresAt[i].length, t.tyresFrom[i], t.islandsAt[i].length, t.islandsFrom[i], t.barrelsAt[i].length, t.pressesAt[i].length, t.trucksAt[i].length);
    h.f(t.themeAt[i].length);
    for (const x of t.themeAt[i]) h.f(x.kind, x.s0, x.s1, x.lat0, x.lat1, x.vx);
  }
  return h.hex();
}

function hashQueries(t: Track): string {
  const h = new Hasher();
  const n = t.pts.length;
  // Points around every sample, out to past the wall and to the "lost" distance, on both sides.
  for (let i = 0; i < n; i++) {
    const p = t.pts[i];
    const s = t.cum[i] + 3.7;
    const at = pointAt(t, s);
    for (let lat = -2.2 * t.wall; lat <= 2.2 * t.wall; lat += 9.5) {
      const x = at.x - Math.sin(at.h) * lat, y = at.y + Math.cos(at.h) * lat;
      query(h, queryTrackNear(t, x, y, i));
      query(h, queryTrackNear(t, x, y, (i + 7) % n));
      h.s(String(overHazard(t, x, y, s)) + String(holeAt(t, x, y, s)?.s ?? "n"));
    }
    if (i % 4 === 0) query(h, queryTrack(t, p.x + 11.3, p.y - 7.9));
  }
  for (let s = -t.length; s < 2 * t.length; s += 7.3) {
    const p = pointAt(t, s);
    h.f(p.x, p.y, p.h, p.seg, recoveryAt(t, s));
    h.s(`${gapAt(t, s)?.s0 ?? "n"}|${lipAt(t, s)?.s ?? "n"}`);
  }
  for (let k = 0; k < 6; k++) {
    const g = gridSlot(t, k);
    h.f(g.x, g.y, g.h, g.seg);
  }
  h.f(wallLimit(t), startStraightEnd(t), minSelfClearance(t));
  for (const e of validateTrack(t)) h.s(e);
  for (const type of CAR_TYPES) {
    for (const lv of [0, 3]) for (const e of validateRunUps(t, statsFor(type, { engine: lv, tyres: lv, welder: lv }))) h.s(`${type}${lv}:${e}`);
  }
  return h.hex();
}

type BotFighter = Fighter & { stats: ReturnType<typeof statsFor>; bot: BotSeat; carType: (typeof CAR_TYPES)[number] };

/** Three bots, no room: botStep's controls and stepRaceCar's states, every tick. */
function hashBotsDirect(t: Track): { hash: string; ticks: number } {
  const h = new Hasher();
  const bots: BotFighter[] = LEVELS.map((level, k) => {
    const g = gridSlot(t, k);
    const carType = botCar(k);
    return {
      id: `bot${k}`, car: { x: g.x, y: g.y, h: g.h, vx: 0, vy: 0, seg: g.seg, wreck: 0, air: 0, fall: 0, boost: 0 },
      finished: false, hp: CAR_HP, maxHp: CAR_HP, ghost: 0, cooldown: 0, ammo: { rivets: 40, mines: 3 },
      levels: { engine: 0, tyres: 0, welder: 0 }, stats: statsFor(carType, { engine: 0, tyres: 0, welder: 0 }), bot: newBotSeat(level, k, k), carType,
    };
  });
  const cells = t.cells.map(() => 0);
  const drafts: number[] = [];
  const env = raceEnv(t);
  const TICKS = 60 * 100;
  for (let rt = 1; rt <= TICKS; rt++) {
    const cmds = bots.map((b) => botStep(b, bots, t, true, [], cells, rt));
    draftsFor(bots.map((b) => ({ car: b.car!, ghost: false, finished: false })), drafts);
    bots.forEach((b, k) => {
      const { cmd, minePress } = cmds[k];
      h.f(cmd.throttle, cmd.steer, cmd.buttons, minePress ? 1 : 0, drafts[k]);
      env.rt = rt;
      env.draft = drafts[k];
      h.s(stepRaceCar(b.car!, cmd, b.stats, env) ?? "-");
    });
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) if (solid(bots[i]) && solid(bots[j])) collideCars(bots[i].car!, bots[j].car!);
    }
    for (const b of bots) car(h, b.car);
  }
  return { hash: h.hex(), ticks: TICKS };
}

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results" || m.t === "ev") this.msgs.push(m);
  }
  close(): void {}
}

/** A 3-lap Room race of the three bots on the sim clock. */
function hashRoom(id: string): { hash: string; ticks: number; finish: string } {
  const h = new Hasher();
  const room = new Room("HASH", 3, CAR_HP);
  let now = 1000, tick = 0;
  const conn = new HostConn();
  const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
  if (room.trackId !== id) {
    const e = room.setTrack(host, id);
    if (e) throw new Error(e);
  }
  const bots = LEVELS.map((l) => {
    const b = room.addBot(host, l, now);
    if (typeof b === "string") throw new Error(b);
    return b;
  });
  const ids = new Map<string, number>([[host.id, -1], ...bots.map((b, k): [string, number] => [b.id, k])]);
  const seat = (id: string) => ids.get(id) ?? -2;
  const e = room.start(host, now);
  if (e) throw new Error(e);
  const step = () => {
    tick++;
    now += 1000 / 60;
    room.tick(tick, now);
  };
  while (room.phase !== "racing") step();
  if (room.retire(host)) throw new Error("retire");
  let rt = 0;
  while (room.phase === "racing" && rt < 60 * 60 * 4) {
    step();
    rt++;
    for (const b of bots) {
      car(h, b.car);
      const p = b.progress;
      if (p) h.f(p.s, p.cp, p.lap, p.fin);
      h.f(b.hp, b.ghost, b.cooldown, b.ammo.rivets, b.ammo.mines);
    }
    for (const s of room.combat.shots) h.f(seat(s.owner), s.id, s.x, s.y, s.vx, s.vy);
    for (const m of room.combat.mines) h.f(seat(m.owner), m.id, m.x, m.y);
  }
  // Player ids are random: each one written as its seat.
  for (const m of conn.msgs) h.s(JSON.stringify(m).replace(/"[A-Za-z0-9_-]{6,}"/g, (q) => (ids.has(q.slice(1, -1)) ? `"#${ids.get(q.slice(1, -1))}"` : q)));
  for (const b of bots) h.s(`${b.name}|${b.wallet.scrap}|${JSON.stringify(b.wallet.levels)}|${b.wallet.ammo.rivets},${b.wallet.ammo.mines}`);
  const res = conn.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
  return { hash: h.hex(), ticks: rt, finish: res ? res.rows.map((r) => `${r.name}:${r.earned}`).join(", ") : `phase ${room.phase}` };
}

/** Wall contacts: cars driven into both walls from the centre and from near the wall, every tick. */
function hashWalls(t: Track): { hash: string; contacts: number } {
  const h = new Hasher();
  const env = raceEnv(t);
  const lim = wallLimit(t);
  let contacts = 0;
  for (let i = 0; i < t.pts.length; i += 6) {
    const s = t.cum[i] + 2.9;
    const p = pointAt(t, s);
    for (const side of [-1, 1]) {
      for (const [lat, angle, speed, steer] of [
        [0, 0.35, 430, 0], [0, 0.8, 300, 0], [0, 1.3, 180, 0], [side * (lim - 20), 0.5, 380, side], [side * (lim - 2), 0.12, 420, side * 0.6],
      ] as const) {
        const hh = p.h + side * angle;
        const c: CarState = {
          x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: hh, vx: Math.cos(hh) * speed, vy: Math.sin(hh) * speed,
          seg: p.seg, wreck: 0, air: 0, fall: 0, boost: 0,
        };
        for (let k = 0; k < 45; k++) {
          const before = { vx: c.vx, vy: c.vy };
          env.rt = k + 1;
          h.s(stepRaceCar(c, { throttle: 1, steer }, BASE_STATS, env) ?? "-");
          car(h, c);
          const into = c.air === 0 && c.fall === 0 ? wallHitSpeed(before, c, t) : 0;
          if (into > 0) contacts++;
          h.f(into);
        }
      }
    }
  }
  return { hash: h.hex(), contacts };
}

type Hashes = Record<string, Record<string, string>>;

function run(): { hashes: Hashes; notes: string[]; stable: boolean } {
  const hashes: Hashes = {};
  const notes: string[] = [];
  let stable = true;
  for (const e of trackList()) {
    const t1 = buildTrack(e.def), t2 = buildTrack(e.def);
    const built = [hashBuilt(t1), hashBuilt(t2)];
    const queries = [hashQueries(t1), hashQueries(t2)];
    const direct = [hashBotsDirect(t1), hashBotsDirect(t2)];
    const room = [hashRoom(e.id), hashRoom(e.id)];
    const walls = [hashWalls(t1), hashWalls(t2)];
    const diff = [built[0] !== built[1] && "built", queries[0] !== queries[1] && "queries", direct[0].hash !== direct[1].hash && "botsDirect", room[0].hash !== room[1].hash && "room", walls[0].hash !== walls[1].hash && "walls"].filter(Boolean);
    const same = diff.length === 0;
    stable &&= same;
    hashes[e.id] = { built: built[0], queries: queries[0], botsDirect: direct[0].hash, room: room[0].hash, walls: walls[0].hash };
    notes.push(`${e.id}: botsDirect ${direct[0].ticks} ticks; room race ${room[0].ticks} ticks (${room[0].finish}); walls ${walls[0].contacts} wall-hit ticks; rerun ${same ? "identical" : `DIFFERS (${diff.join(", ")})`}`);
  }
  // BR-SCHEMA: the test tracks with branches (their main road's built arrays and queries, and the branches).
  for (const def of [BRANCH_YARD]) {
    const t1 = buildTrack(def), t2 = buildTrack(def);
    const parts: Record<string, string[]> = { built: [hashBuilt(t1), hashBuilt(t2)], queries: [hashQueries(t1), hashQueries(t2)] };
    if (t1.branches.length > 0) parts.branches = [hashBranches(t1), hashBranches(t2)];
    const diff = Object.keys(parts).filter((k) => parts[k][0] !== parts[k][1]);
    stable &&= diff.length === 0;
    hashes[def.id] = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v[0]]));
    notes.push(`${def.id}: ${t1.branches.length} branch(es); rerun ${diff.length === 0 ? "identical" : `DIFFERS (${diff.join(", ")})`}`);
  }
  // THEME-SCHEMA: the theme yards, each on its own lines.
  for (const def of THEME_YARDS) {
    const t1 = buildTrack(def), t2 = buildTrack(def);
    const parts: Record<string, string[]> = { built: [hashBuilt(t1), hashBuilt(t2)], queries: [hashQueries(t1), hashQueries(t2)], features: [hashFeatures(t1), hashFeatures(t2)] };
    const diff = Object.keys(parts).filter((k) => parts[k][0] !== parts[k][1]);
    stable &&= diff.length === 0;
    hashes[def.id] = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v[0]]));
    notes.push(`${def.id}: theme ${themeOf(t1.def)}, ${t1.sand.length} sand, ${t1.oil.length} oil, ${t1.fords.length} ford(s); rerun ${diff.length === 0 ? "identical" : `DIFFERS (${diff.join(", ")})`}`);
  }
  return { hashes, notes, stable };
}

const { hashes, notes, stable } = run();
for (const n of notes) console.log(n);
console.log(JSON.stringify(hashes, null, 2));
if (!stable) {
  console.log("FAIL: a part hashed differently on a rerun (not deterministic)");
  process.exit(1);
}
if (process.argv.includes("--write")) {
  writeFileSync(GOLDEN, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`written ${GOLDEN}`);
} else if (process.argv.includes("--check")) {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Hashes;
  let bad = 0;
  for (const id of new Set([...Object.keys(golden), ...Object.keys(hashes)])) {
    for (const part of new Set([...Object.keys(golden[id] ?? {}), ...Object.keys(hashes[id] ?? {})])) {
      const was = golden[id]?.[part], now = hashes[id]?.[part];
      const verdict = was === undefined ? "NEW " : now === undefined ? "GONE" : was === now ? "SAME" : "DIFF";
      if (verdict === "DIFF" || verdict === "GONE") bad++;
      console.log(`${verdict}  ${id} ${part}`);
    }
  }
  console.log(bad ? `FAIL: ${bad} hash(es) differ from ${GOLDEN}` : `all hashes match ${GOLDEN}`);
  process.exit(bad ? 1 : 0);
}
