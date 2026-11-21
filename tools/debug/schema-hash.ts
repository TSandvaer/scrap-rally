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
import {
  buildTrack,
  gapAt,
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

type Hashes = Record<string, { built: string; queries: string; botsDirect: string; room: string; walls: string }>;

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
    for (const part of ["built", "queries", "botsDirect", "room", "walls"] as const) {
      const ok = golden[id]?.[part] === hashes[id]?.[part];
      if (!ok) bad++;
      console.log(`${ok ? "SAME" : "DIFF"}  ${id} ${part}`);
    }
  }
  console.log(bad ? `FAIL: ${bad} hash(es) differ from ${GOLDEN}` : `all hashes match ${GOLDEN}`);
  process.exit(bad ? 1 : 0);
}
