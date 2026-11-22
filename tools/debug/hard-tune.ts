// hard-tune (M4-HARD, PLAN-M4.md addendum 2026-11-21 + its advisor changes): the Hard bot level's
// instruments, with no browser and no sockets.
//
// --golden: the byte-identity proof for Easy and Normal (advisor change 3). Server bots (a host
// that retires at GO and 3 bots of one level) race two 3-lap races in one room on every shipped
// track (the second race after the payout and the bots' shopping), and three client bots
// (BotDriver over the real client Game, weapons on) race one 3-lap race; a SHA-256 over the full
// float64 bits of every tick's throttle, steer, fire and mine and every car state field, plus the
// wallets after every race. scripts/sim-test.ts (section M4-HARD) holds the hashes taken before
// shared/botdrive.ts was touched and checks that Easy and Normal still give them.
//
//   npx tsx tools/debug/hard-tune.ts --golden
//
// --pace: per shipped track and car type, one bot alone (lanes -24, 0, 24 in turn, weapons off,
// cells within the Normal reach for every level so only the driving differs), 3 laps: the median
// lap of Normal, of the flat-out ceiling (Normal with CORNER_SCALE = 3: it never brakes for a
// bend; the trick of sim-test "cars cut") and of Hard, and the share of the Normal-to-flat-out gap
// Hard closes; falls, wall contacts and ticks on the dirt.
//
//   npx tsx tools/debug/hard-tune.ts --pace [--set corner=1.15,bendLook=0.8]
//   npx tsx tools/debug/hard-tune.ts --sweep corner=1.08,1.12,1.16 [--sweep2 apex=0,12,20]
//
// --traffic: 3-lap races of 3 bots of one level in traffic (slipstream, cells, weapons on: draft
// 473, boost 537), Hard against Normal on every track and with every car type (all Sport, all
// Racer, all Truck, and the round-robin mix): finishes, falls, wall contacts (those within 2 s
// of a mine spin apart), wrecks, rivets fired and hits, mines dropped and hits.
//
// --vs: 3 Hard against 3 Normal in one room (the host drives as the sixth bot), 3 races of 3 laps
// per track, twice (Hard on the first three seats, then Normal): places, and each bot's scrap.
//
//   npx tsx tools/debug/hard-tune.ts --traffic | --vs [--set ...]
//
// --mistakes (HARD-2): the Bot tune knob's table: 3 Hard bots in traffic (weapons off, or on with
// --weapons), 3 laps, every shipped track and the Surf, Split and Move Yards, every car set, per
// mistake rate and size (--rates 0.5,1,2,3 --sizes 0.5,1 --pace 1 --aim 2.5): lap time and its loss
// against rate 0, falls (after a hit, within 3 s of a mistake), wall and obstacle contacts, dirt,
// wrecks, the mistakes begun per lap by kind and any step of one in an excluded zone. --paces: the
// same for the pace knob (0, 0.25, 0.5, 0.75, 1) at --rate (default 0).
//
//   npx tsx tools/debug/hard-tune.ts --mistakes [--rates 1,3 --sizes 1 --weapons] | --paces [--rate 1 --size 0.5]

import { createHash, type Hash } from "node:crypto";
import { Game } from "../../client/game";
import type { Transport } from "../../client/net";
import { botTrace } from "../../server/bots";
import { Room, Rooms, type Player, type Session } from "../../server/room";
import { newBotSeat } from "../../server/bots";
import { CORNER_SCALE, HARD, MISTAKE_KINDS, type BotLevel, type BotTune, type MistakeKind } from "../../shared/botdrive";
import { CAR_TYPES, type CarType } from "../../shared/cars";
import { wallLimit, type CarState } from "../../shared/physics";
import { decode, encode, type ClientMsg, type GameEvent, type ServerMsg } from "../../shared/protocol";
import { BARREL_R, PRESS_DEPTH, queryTrackNear, type Track } from "../../shared/track";
import { islandContact } from "./split-tune";
import { moveContact } from "./move-tune";
import { touchesMound } from "./surf-tune";
import { CAR_HP } from "../../shared/weapons";
import { botShopping } from "../../shared/botshop";
import { BotDriver } from "../../scripts/bot-ai";

/** The shipped tracks. */
export const HARD_TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"];

/** Every numeric field of a car state, by name (so a new field is in the hash too); null: one 0. */
function carVals(c: CarState | null | undefined): number[] {
  if (!c) return [0];
  const out = [1];
  const r = c as unknown as Record<string, number>;
  for (const k of Object.keys(r).sort()) out.push(r[k]);
  return out;
}

/** The bytes of these numbers as float64s. */
function feed(h: Hash, vals: number[]): void {
  h.update(new Uint8Array(new Float64Array(vals).buffer));
}

const quietConn = { send(): void {}, close(): void {} };

export interface GoldenRun {
  hash: string;
  stateErrs?: number; // client runs: air/fall state mismatches between the prediction and the server
  presses?: number[][]; // client runs: per race, per bot, mine presses by its driver while racing
  dropped?: number[][]; // ... and mines the server took from its ammo
  finish: number[][]; // per race, per bot: finish time (ms after GO, 0 = did not finish)
  wallets: string[]; // per race: the bots' wallets after the payout and shopping
  mistakes?: { kind: MistakeKind; bot: number; lap: number; s: number }[]; // client runs with a tune (HARD-2): every mistake begun
}

/**
 * Server bots of `levels` race `races` races of `laps` laps in one room on `track` (the host
 * retires at GO each time). Hash of every tick's controls (by add order) and car states, and the
 * wallets after adding and after every race.
 */
export function goldenServer(track: string, levels: BotLevel[], races = 2, laps = 3, tune?: BotTune): GoldenRun {
  const h = createHash("sha256");
  const room = new Room("GOLD", laps, CAR_HP);
  let now = 1000, tick = 0;
  const host = room.addPlayer("Host", { conn: quietConn, room: null, player: null } as Session, now) as Player;
  if (room.trackId !== track) {
    const e = room.setTrack(host, track);
    if (e) throw new Error(e);
  }
  const bots = levels.map((l) => {
    const b = room.addBot(host, l, now);
    if (typeof b === "string") throw new Error(b);
    return b;
  });
  const order = new Map(bots.map((b, i) => [b.id, i]));
  let rows: number[] = [];
  const out: GoldenRun = { hash: "", finish: [], wallets: [] };
  const wallets = () => JSON.stringify(bots.map((b) => b.wallet));
  h.update(wallets());
  botTrace.fn = (p, ctl) => void rows.push(order.get(p.id) ?? -1, ctl.throttle, ctl.steer, ctl.fire ? 1 : 0, ctl.mine ? 1 : 0);
  try {
    const step = () => {
      tick++;
      now += 1000 / 60;
      rows = [];
      room.tick(tick, now);
      feed(h, rows);
      for (const b of bots) feed(h, carVals(b.car));
    };
    for (let r = 0; r < races; r++) {
      // HARD-2: with a tune, the host sets it through the dev message (the flag on) and the race begins with it.
      const e = tune ? withDevBots(() => room.setBotTune(host, tune) ?? room.start(host, now)) : room.start(host, now);
      if (e) throw new Error(e);
      if (tune) for (const b of bots) b.bot!.mem.onMistake = null; // no server log lines
      while (room.phase !== "racing") step();
      if (room.retire(host)) throw new Error("retire");
      for (let n = 0; room.phase === "racing" && n < 60 * 600; n++) step();
      out.finish.push(bots.map((b) => b.progress?.fin ?? 0));
      out.wallets.push(wallets());
      h.update(wallets());
      const phase = () => room.phase as string; // changed by step(): not narrowed
      for (let n = 0; phase() !== "lobby" && n < 60 * 60; n++) step();
      if (phase() !== "lobby") throw new Error(`race ${r + 1}: no lobby after the results`);
    }
  } finally {
    botTrace.fn = null;
  }
  out.hash = h.digest("hex");
  return out;
}

/** A client Game wired to a Rooms server in-process (encode/decode both ways, no sockets). */
export function wired(rooms: Rooms, clock: { now: number }): { game: Game; open(): void; flush(): void } {
  const inbox: ServerMsg[] = [];
  const session: Session = { conn: { send: (m) => inbox.push(decode<ServerMsg>(encode(m))!), close() {} }, room: null, player: null };
  const tr: Transport = {
    send: (m) => rooms.onMessage(session, decode<ClientMsg>(encode(m)), clock.now),
    close() {},
    onOpen() {},
    onMessage() {},
    onClose() {},
  };
  const tokens = new Map<string, string>();
  const game = new Game(() => tr, { get: (c) => tokens.get(c) ?? null, set: (c, t) => void tokens.set(c, t) });
  return {
    game,
    open: () => tr.onOpen(),
    flush: () => {
      for (const m of inbox.splice(0)) tr.onMessage(m);
    },
  };
}

/**
 * The socket bots' path (scripts/bot-ai.ts over the client Game, as `npm run botplay` and
 * scripts/bots.ts drive): three bots on lanes -24, 0, 24 with weapons on, `races` races of `laps`
 * laps on `track` on the sim clock. Hash of every race tick's controls, the predicted and the
 * server's car, and the wallets after each race. Between races every bot keeps stepping with its
 * driver while its car is gone (as botplay does). shop: each bot buys by the shop rule of its
 * level before every race (as botplay does; off for the golden hash, whose bots race unarmed).
 * presses / dropped: per race, per bot, the mine presses its driver made and the mines the server
 * took from its ammo.
 */
export function goldenClient(track = "crusher-run", laps = 3, level: BotLevel = "normal", races = 1, shop = false, tune?: BotTune): GoldenRun {
  const h = createHash("sha256");
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const rooms = new Rooms(laps, CAR_HP);
    const lanes = [-24, 0, 24];
    const ws = lanes.map(() => wired(rooms, clock));
    ws[0].game.create("Bot0");
    ws[0].open();
    ws[0].flush();
    ws[0].game.pickTrack(track);
    ws[0].flush();
    const room = [...rooms.rooms.values()][0];
    ws.slice(1).forEach((w, i) => {
      w.game.join(room.code, `Bot${i + 1}`);
      w.open();
    });
    for (const w of ws) w.flush();
    const drivers = ws.map((w, i) => new BotDriver(w.game, lanes[i], level));
    const mistakes: NonNullable<GoldenRun["mistakes"]> = [];
    if (tune) {
      // HARD-2: the socket bots drive with the knob's values (BotDriver.tune) and every mistake is noted.
      drivers.forEach((d, k) => {
        d.tune(tune);
        d.onMistake = (kind, _size, s, lap) => void mistakes.push({ kind, bot: k, lap, s });
      });
    }
    const server = (k: number) => room.players.get(ws[k].game.you);
    const shopAll = () => {
      for (const w of ws) {
        const g = w.game;
        for (const item of botShopping({ scrap: g.scrap, levels: { ...g.levels }, ammo: { rivets: g.serverAmmo[0], mines: g.serverAmmo[1] } }, level)) g.buy(item);
        w.flush();
      }
    };
    const out: GoldenRun = { hash: "", finish: [], wallets: [], presses: [], dropped: [] };
    for (let r = 0; r < races; r++) {
      if (r > 0) {
        // Results, then the lobby: the bots step on with their cars gone (their drivers see that).
        for (let i = 0; i < 60 * 60 && room.phase !== "lobby"; i++) {
          clock.now += 1000 / 60;
          rooms.step(clock.now);
          for (const w of ws) w.flush();
          ws.forEach((w, k) => w.game.step(drivers[k].controls(), 1000 / 60));
        }
        if ((room.phase as string) !== "lobby") throw new Error(`race ${r + 1}: no lobby after the results`);
      }
      if (shop) shopAll();
      for (const w of ws.slice(1)) {
        w.game.setReady(true);
        w.flush();
      }
      ws[0].game.start();
      ws[0].flush();
      const presses = ws.map(() => 0), dropped = ws.map(() => 0);
      for (let i = 0; i < 60 * 400 && (room.phase === "countdown" || room.phase === "racing"); i++) {
        clock.now += 1000 / 60;
        const mines0 = ws.map((_, k) => server(k)?.wallet.ammo.mines ?? 0);
        rooms.step(clock.now);
        if (room.phase === "racing") ws.forEach((_, k) => (dropped[k] += Math.max(0, mines0[k] - (server(k)?.wallet.ammo.mines ?? 0))));
        for (const w of ws) w.flush();
        ws.forEach((w, k) => {
          const ctl = drivers[k].controls();
          if (ctl.mine && room.phase === "racing") presses[k]++;
          feed(h, [k, ctl.throttle, ctl.steer, ctl.fire ? 1 : 0, ctl.mine ? 1 : 0]);
          w.game.step(ctl, 1000 / 60);
          feed(h, carVals(w.game.car));
          feed(h, carVals(server(k)?.car));
        });
      }
      out.finish.push(ws.map((_, k) => server(k)?.progress?.fin ?? 0));
      out.wallets.push(JSON.stringify(ws.map((_, k) => server(k)?.wallet)));
      out.presses!.push(presses);
      out.dropped!.push(dropped);
      h.update(out.wallets[r]);
    }
    out.hash = h.digest("hex");
    out.stateErrs = ws.reduce((a, w) => a + w.game.recStateErrors, 0);
    if (tune) out.mistakes = mistakes;
    return out;
  } finally {
    performance.now = realNow;
  }
}

/** Every golden run, by name: `<track> <level>` (server bots) and `client <track>`. */
export function goldenAll(): Record<string, GoldenRun> {
  const out: Record<string, GoldenRun> = {};
  for (const track of HARD_TRACKS) {
    for (const level of ["easy", "normal"] as BotLevel[]) out[`${track} ${level}`] = goldenServer(track, [level, level, level]);
  }
  out["client crusher-run"] = goldenClient("crusher-run");
  return out;
}

// ---- races -----------------------------------------------------------------------------

/** One car's tally over the races of a run. */
export interface CarRow {
  name: string;
  level: BotLevel;
  car: CarType;
  lapTicks: number[]; // every lap of every race, in ticks
  finish: number[]; // per race: ticks after GO (0 = did not finish)
  place: number[]; // per race: 1.. (results order)
  earned: number[]; // per race: scrap earned
  falls: number;
  hitFalls: number; // ... of them within 3 s of the car being hit (rivet or mine)
  walls: number; // wall contacts begun (not within 2 s of a mine spin)
  mineWalls: number;
  dirt: number; // ticks on the dirt (grounded, off the road)
  wrecks: number;
  rivets: number; // fired
  rivetHits: number; // ... that hit
  mines: number; // dropped
  mineHits: number; // ... that hit someone
  wallet: string; // after the last race
  // HARD-2:
  mistakes: Record<MistakeKind, number>; // begun, by kind
  mistakeSteps: number; // steps with a mistake under way
  mistakeFalls: number; // falls begun while a mistake was under way or within 3 s of one
  badZone: number; // ... of them in an excluded zone (zoneBusy: a feature near, or the slipstream, a back-up, reversing, backing off an island)
  obstacles: number; // contacts begun with a tyre mound, an island, a barrel, a press or a truck
}

export interface RaceOpts {
  track: string;
  levels: BotLevel[]; // the bots, by add order (seat 0.. : lanes -24, 24, 0, -12, 12)
  cars?: CarType[]; // per bot (default: by seat)
  lanes?: number[]; // per bot: its racing line instead of its seat's
  laps?: number; // default 3
  races?: number; // races in one room, the bots shopping between (default 1)
  hostBot?: BotLevel; // the host drives as a sixth bot of this level (seat 5: lane -36); else it retires at GO
  weapons?: boolean; // default true
  tune?: BotTune; // HARD-2: the room's Bot tune knob (set by the host's dev message, the flag on for it)
}

/** Races of server bots on the sim clock (deterministic). */
export function runRaces(o: RaceOpts): CarRow[] {
  const laps = o.laps ?? 3;
  const events: GameEvent[] = [];
  let results: { id: string; earned: number }[] = [];
  const conn = {
    send: (m: ServerMsg) => {
      if (m.t === "ev") events.push(m.ev);
      if (m.t === "results") results = m.rows;
    },
    close(): void {},
  };
  const room = new Room("TUNE", laps, CAR_HP);
  let now = 1000, tick = 0;
  const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
  if (room.trackId !== o.track) {
    // A test track (surf-yard, split-yard, move-yard) needs the dev track flag to be picked.
    const e = withEnv("SCRAP_DEV_TRACK", TEST_TRACK_IDS.has(o.track) ? o.track : process.env.SCRAP_DEV_TRACK, () => room.setTrack(host, o.track));
    if (e) throw new Error(e);
  }
  const bots = o.levels.map((l, i) => {
    const b = room.addBot(host, l, now);
    if (typeof b === "string") throw new Error(b);
    const car = o.cars?.[i];
    if (car && room.setCar(host, car, b.id)) throw new Error("car");
    if (o.lanes) b.bot!.mem.lateral = o.lanes[i];
    if (o.weapons === false) b.bot!.mem.weapons = false;
    return b;
  });
  const field = o.hostBot ? [...bots, host] : bots;
  const rows: CarRow[] = field.map((p) => ({
    name: p.name, level: p.bot?.level ?? o.hostBot!, car: p.carType, lapTicks: [], finish: [], place: [], earned: [],
    falls: 0, hitFalls: 0, walls: 0, mineWalls: 0, dirt: 0, wrecks: 0, rivets: 0, rivetHits: 0, mines: 0, mineHits: 0, wallet: "",
    mistakes: { "late-brake": 0, wide: 0, wobble: 0, hesitate: 0 }, mistakeSteps: 0, mistakeFalls: 0, badZone: 0, obstacles: 0,
  }));
  const spans = featureSpans(room.track);
  const idx = new Map(field.map((p, k) => [p.id, k]));
  const wall = wallLimit(room.track);
  const step = () => {
    tick++;
    now += 1000 / 60;
    room.tick(tick, now);
  };
  for (let r = 0; r < (o.races ?? 1); r++) {
    const e = o.tune ? withDevBots(() => room.setBotTune(host, o.tune) ?? room.start(host, now)) : room.start(host, now);
    if (e) throw new Error(e);
    // HARD-2: count each bot's mistakes (in place of the dev flag's server log).
    field.forEach((p, k) => {
      if (p.bot) p.bot.mem.onMistake = (kind) => void rows[k].mistakes[kind]++;
    });
    if (o.hostBot) {
      // The host's seat drives as a bot from the grid on (a tool-only trick: a room seats 6 with its host).
      host.bot = newBotSeat(o.hostBot, 5, 99);
      if (o.weapons === false) host.bot.mem.weapons = false;
    }
    while (room.phase !== "racing") step();
    if (!o.hostBot && room.retire(host)) throw new Error("retire");
    const prev = field.map(() => ({ fall: 0, wreck: 0, lap: 0, lapAt: 0, wall: false, obstacle: false, err: -Infinity }));
    const spun = new Map<string, number>();
    const hitAt = new Map<string, number>();
    const ammo = field.map((p) => ({ ...p.wallet.ammo }));
    let rt = 0;
    events.length = 0;
    while (room.phase === "racing" && rt < 60 * 600) {
      step();
      rt++;
      for (const ev of events.splice(0)) {
        if (ev.k === "hit") {
          const by = idx.get(ev.by);
          if (by !== undefined && ev.by !== ev.id) ev.w === "rivet" ? rows[by].rivetHits++ : rows[by].mineHits++;
          if (ev.w === "mine") spun.set(ev.id, rt);
          hitAt.set(ev.id, rt);
        }
      }
      // Fired and dropped: the ammo used (a rivet at close range can hit within the tick it is fired);
      // not over the tick the race ended on (the bots shopped in it).
      if (room.phase === "racing") field.forEach((p, k) => {
        rows[k].rivets += ammo[k].rivets - p.wallet.ammo.rivets;
        rows[k].mines += ammo[k].mines - p.wallet.ammo.mines;
        ammo[k] = { ...p.wallet.ammo };
      });
      field.forEach((p, k) => {
        const c = p.car, pr = p.progress, was = prev[k];
        if (!c || !pr) return;
        if (p.bot?.mem.mistake) was.err = rt;
        if (c.fall > 0 && was.fall === 0) {
          rows[k].falls++;
          if (rt - was.err <= 180) rows[k].mistakeFalls++;
          if (rt - (hitAt.get(p.id) ?? -Infinity) <= 180) rows[k].hitFalls++;
        }
        if (c.wreck > 0 && was.wreck === 0) rows[k].wrecks++;
        was.fall = c.fall;
        was.wreck = c.wreck;
        if (c.air === 0 && c.fall === 0) {
          const d = queryTrackNear(room.track, c.x, c.y, c.seg).dist;
          if (d > room.track.def.halfWidth) rows[k].dirt++;
          const atWall = d >= wall - 0.01;
          if (atWall && !was.wall) {
            if (rt - (spun.get(p.id) ?? -Infinity) <= 120) rows[k].mineWalls++;
            else rows[k].walls++;
          }
          was.wall = atWall;
          const hit = touchesMound(room.track, c) || islandContact(room.track, c) !== null || moveContact(room.track, c, room.rt) !== null;
          if (hit && !was.obstacle) rows[k].obstacles++;
          was.obstacle = hit;
        }
        const m = p.bot?.mem;
        if (m && m.mistake !== null) {
          rows[k].mistakeSteps++;
          const s = queryTrackNear(room.track, c.x, c.y, c.seg).s;
          if (m.wake || m.backup || m.reversing > 0 || m.islandBack > 0 || zoneBusy(room.track, spans, s)) rows[k].badZone++;
        }
        if (pr.lap > was.lap) {
          rows[k].lapTicks.push(rt - was.lapAt);
          was.lap = pr.lap;
          was.lapAt = rt;
        }
      });
    }
    // The results: order and scrap earned (the host's conn has them).
    field.forEach((p, k) => {
      rows[k].finish.push(p.progress?.fin ? Math.round((p.progress.fin * 60) / 1000) : 0);
      rows[k].place.push(results.findIndex((x) => x.id === p.id) + 1);
      rows[k].earned.push(results.find((x) => x.id === p.id)?.earned ?? 0);
    });
    for (let n = 0; (room.phase as string) !== "lobby" && n < 60 * 60; n++) step();
    if (o.hostBot) host.bot = null;
  }
  field.forEach((p, k) => (rows[k].wallet = `${p.wallet.scrap} scrap, engine ${p.wallet.levels.engine} tyres ${p.wallet.levels.tyres} welder ${p.wallet.levels.welder}, ${p.wallet.ammo.rivets} rivets ${p.wallet.ammo.mines} mines`));
  return rows;
}


// ---- HARD-2: Hard's mistakes and the Bot tune knob ------------------------------------------

/**
 * The tracks HARD-2's falls-0 gate drives: every shipped one (the first three, and M4-TRACKS' Slag Harbour
 * and Breaker's Mile: advisor change 9, the second to merge re-runs it on the new tracks) and the three
 * test tracks (advisor change 10).
 */
export const TEST_TRACK_IDS = new Set(["surf-yard", "split-yard", "move-yard"]);
export const MISTAKE_TRACKS = [...HARD_TRACKS, "slag-harbour", "breakers-mile", ...TEST_TRACK_IDS];

/** Run fn with env `name` set to `value` (undefined = unset), then put it back. */
export function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
}

/** Run fn with the dev flag SCRAP_DEV_BOTS=1 (server/room.ts devBotsOn). */
export function withDevBots<T>(fn: () => T): T {
  return withEnv("SCRAP_DEV_BOTS", "1", fn);
}

/**
 * Every feature of a track as an s span, written apart from botdrive's mistakeClear (an independent
 * check): ramps (to the lip), gaps, holes, tyre mounds, surfaces, widens, islands, trucks, barrel
 * rows and presses.
 */
export function featureSpans(t: Track): [number, number][] {
  const out: [number, number][] = [];
  for (const r of t.ramps) out.push([r.s, r.s + r.len]);
  for (const g of t.gaps) out.push([g.s0, g.s1]);
  for (const h of t.holes) out.push([h.s - h.r, h.s + h.r]);
  for (const m of t.tyres) out.push([m.s - m.r, m.s + m.r]);
  for (const f of t.surfaces) out.push([f.s0, f.s1]);
  for (const w of t.widens) out.push([w.s0, w.s1]);
  for (const i of t.islands) out.push([i.s0, i.s1]);
  for (const k of t.trucks) out.push([k.s, k.s + k.len]);
  for (const b of t.barrels) out.push([b.s - BARREL_R, b.s + BARREL_R]);
  for (const g of t.presses) out.push([g.s - PRESS_DEPTH / 2, g.s + PRESS_DEPTH / 2]);
  return out;
}

/** The excluded zone of HARD-2's test: a feature from 15 behind s to 650 ahead (RAMP_APPROACH: a ramp in view; every hole within the lane search's look). */
export function zoneBusy(t: Track, spans: readonly [number, number][], s: number): boolean {
  const L = t.length, from = s - 15, len = 15 + 650;
  const ahead = (a: number, b: number) => (((b - a) % L) + L) % L;
  return spans.some(([a, b]) => ahead(from, a) <= len || ahead(a, from) <= b - a);
}

/** A tally of mistakes by kind over rows. */
export function mistakeCounts(rows: readonly CarRow[]): Record<MistakeKind, number> {
  const out = { "late-brake": 0, wide: 0, wobble: 0, hesitate: 0 } as Record<MistakeKind, number>;
  for (const r of rows) for (const k of MISTAKE_KINDS) out[k] += r.mistakes[k];
  return out;
}

/** A knob: today's Hard with these values set. */
export function tuneOf(t: Partial<BotTune>): BotTune {
  return { rate: HARD.mistakeRate, size: HARD.mistakeSize, pace: 1, aim: HARD.rivetSlack, ...t };
}

/** One configuration's traffic numbers (3 Hard bots, 3 laps, every car set, per track list). */
export interface TuneRow {
  label: string;
  lap: number; // mean lap over every bot, lap and race (ticks)
  falls: number;
  walls: number;
  dirt: number;
  obstacles: number;
  mistakes: Record<MistakeKind, number>;
  perLap: number; // mistakes begun per bot per lap
  badZone: number;
  mistakeFalls: number;
  hitFalls: number; // falls within 3 s of the car being hit (a rivet or a mine)
  laps: number;
  wrecks: number;
}

/** 3 Hard bots in traffic (weapons on) with `tune` on `tracks`, every car set (mix, all Sport, all Racer, all Truck): summed. */
export function tuneTraffic(
  label: string, tune: BotTune | undefined, tracks: readonly string[] = HARD_TRACKS, levels: BotLevel[] = ["hard", "hard", "hard"], weapons = true,
): { row: TuneRow; runs: { key: string; rows: CarRow[] }[] } {
  const runs: { key: string; rows: CarRow[] }[] = [];
  for (const track of tracks) {
    for (const cars of [undefined, ...CAR_TYPES.map((t) => [t, t, t, t, t])]) {
      runs.push({ key: `${track} ${cars ? cars[0] : "mix"}`, rows: runRaces({ track, levels, cars: cars?.slice(0, levels.length), tune, weapons }) });
    }
  }
  const all = runs.flatMap((r) => r.rows.filter((x) => x.level === "hard"));
  const laps = all.reduce((a, r) => a + r.lapTicks.length, 0);
  const mistakes = mistakeCounts(all);
  return {
    runs,
    row: {
      label, laps, lap: all.reduce((a, r) => a + r.lapTicks.reduce((x, y) => x + y, 0), 0) / Math.max(1, laps),
      falls: sum(all, (r) => r.falls), walls: sum(all, (r) => r.walls), dirt: sum(all, (r) => r.dirt), obstacles: sum(all, (r) => r.obstacles),
      mistakes, perLap: MISTAKE_KINDS.reduce((a, k) => a + mistakes[k], 0) / Math.max(1, laps), badZone: sum(all, (r) => r.badZone), wrecks: sum(all, (r) => r.wrecks),
      mistakeFalls: sum(all, (r) => r.mistakeFalls), hitFalls: sum(all, (r) => r.hitFalls),
    },
  };
}

/** A table line: lap time and its loss against `base`, falls, contacts, mistakes by kind. */
export function tuneLine(r: TuneRow, base: TuneRow): string {
  const loss = ((r.lap / base.lap - 1) * 100).toFixed(2);
  return `${r.label.padEnd(26)} lap ${(r.lap / 60).toFixed(2)} s (${Number(loss) >= 0 ? "+" : ""}${loss}%)  falls ${r.falls} (${r.hitFalls} after a hit, ${r.mistakeFalls} within 3 s of a mistake)  walls ${r.walls}  obstacles ${r.obstacles}  dirt ${r.dirt}  wrecks ${r.wrecks}  ` +
    `mistakes ${r.perLap.toFixed(2)}/lap (late ${r.mistakes["late-brake"]}, wide ${r.mistakes.wide}, wobble ${r.mistakes.wobble}, hesitate ${r.mistakes.hesitate}; in an excluded zone: ${r.badZone} steps)`;
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN;
};

/** Run fn with HARD's constants set from "k=v,k=v" (restored after). */
export function withHard<T>(set: Record<string, number>, fn: () => T): T {
  const saved = { ...HARD };
  Object.assign(HARD, set);
  try {
    return fn();
  } finally {
    Object.assign(HARD, saved);
  }
}

/** Run fn with every car type's corner scale at 3: a bot that never brakes for a bend (sim-test "cars cut"). */
export function flatOut<T>(fn: () => T): T {
  const saved = { ...CORNER_SCALE };
  for (const t of CAR_TYPES) CORNER_SCALE[t] = 3;
  try {
    return fn();
  } finally {
    Object.assign(CORNER_SCALE, saved);
  }
}

const PACE_LANES = [-24, 0, 24];

export interface PaceRow {
  track: string;
  car: CarType;
  normal: number; // median lap, ticks (mean over the lanes)
  flat: number;
  hard: number;
  share: number; // of the Normal-to-flat-out gap Hard closes
  falls: [number, number, number]; // normal, flat, hard
  walls: [number, number, number];
  dirt: [number, number, number];
}

/** A lone bot's 3-lap race per lane: the mean of the median laps, falls, walls, dirt (weapons off, cells at the Normal reach). */
function solo(track: string, level: BotLevel, car: CarType): { lap: number; falls: number; walls: number; dirt: number } {
  let lap = 0, falls = 0, walls = 0, dirt = 0;
  for (const lane of PACE_LANES) {
    const [r] = withHard({ cellLane: 30 }, () => runRaces({ track, levels: [level], cars: [car], lanes: [lane], weapons: false }));
    lap += median(r.lapTicks) / PACE_LANES.length;
    falls += r.falls;
    walls += r.walls;
    dirt += r.dirt;
  }
  return { lap, falls, walls, dirt };
}

export function pace(tracks = HARD_TRACKS, cars: readonly CarType[] = CAR_TYPES): PaceRow[] {
  const out: PaceRow[] = [];
  for (const track of tracks) {
    for (const car of cars) {
      const n = solo(track, "normal", car), f = flatOut(() => solo(track, "normal", car)), h = solo(track, "hard", car);
      out.push({
        track, car, normal: n.lap, flat: f.lap, hard: h.lap, share: (n.lap - h.lap) / (n.lap - f.lap),
        falls: [n.falls, f.falls, h.falls], walls: [n.walls, f.walls, h.walls], dirt: [n.dirt, f.dirt, h.dirt],
      });
    }
  }
  return out;
}

function paceLine(r: PaceRow): string {
  const s = (t: number) => (t / 60).toFixed(2);
  return `${r.track.padEnd(14)} ${r.car.padEnd(6)} Normal ${s(r.normal)} s  flat-out ${s(r.flat)} s  Hard ${s(r.hard)} s (${(((r.hard / r.normal) - 1) * 100).toFixed(1)}% vs Normal)  closes ${(r.share * 100).toFixed(0)}% of the gap; falls ${r.falls.join("/")}, walls ${r.walls.join("/")}, dirt ${r.dirt.join("/")} ticks (N/flat/H)`;
}

/** Parse "k=v,k=v" into numbers. */
function parseSet(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of (v ?? "").split(",").filter(Boolean)) {
    const [k, x] = kv.split("=");
    if (!(k in HARD)) throw new Error(`unknown HARD constant ${k}`);
    out[k] = Number(x);
  }
  return out;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** 3 bots of `level` in traffic per track and car set: summed tallies. */
export function traffic(level: BotLevel, tracks = HARD_TRACKS): { key: string; rows: CarRow[] }[] {
  const out: { key: string; rows: CarRow[] }[] = [];
  for (const track of tracks) {
    for (const cars of [undefined, ...CAR_TYPES.map((t) => [t, t, t])]) {
      out.push({ key: `${track} ${cars ? cars[0] : "mix"}`, rows: runRaces({ track, levels: [level, level, level], cars }) });
    }
  }
  return out;
}

const sum = (rows: CarRow[], f: (r: CarRow) => number) => rows.reduce((a, r) => a + f(r), 0);

function main(): void {
  const set = parseSet(arg("set"));
  if (process.argv.includes("--pace")) {
    withHard(set, () => {
      const rows = pace();
      for (const r of rows) console.log(paceLine(r));
      const shares = rows.map((r) => r.share);
      console.log(`share of the gap closed: min ${(Math.min(...shares) * 100).toFixed(0)}%, median ${(median(shares) * 100).toFixed(0)}%, max ${(Math.max(...shares) * 100).toFixed(0)}%`);
    });
    return;
  }
  if (arg("sweep")) {
    const [k, vs] = arg("sweep")!.split("=");
    const [k2, vs2] = (arg("sweep2") ?? "=").split("=");
    for (const v of vs.split(",").map(Number)) {
      for (const v2 of k2 ? vs2.split(",").map(Number) : [NaN]) {
        const s2 = k2 ? { [k2]: v2 } : {};
        const rows = withHard({ ...set, [k]: v, ...s2 }, () => pace());
        const shares = rows.map((r) => r.share);
        const tot = (i: number, f: (r: PaceRow) => number[]) => rows.reduce((a, r) => a + f(r)[i], 0);
        console.log(`${k}=${v}${k2 ? ` ${k2}=${v2}` : ""}: closes min ${(Math.min(...shares) * 100).toFixed(0)}% median ${(median(shares) * 100).toFixed(0)}% max ${(Math.max(...shares) * 100).toFixed(0)}%; ` +
          `falls H ${tot(2, (r) => r.falls)} (N ${tot(0, (r) => r.falls)}), walls H ${tot(2, (r) => r.walls)} (N ${tot(0, (r) => r.walls)}), dirt H ${tot(2, (r) => r.dirt)} (N ${tot(0, (r) => r.dirt)}); ` +
          rows.map((r) => `${r.track.slice(0, 5)}/${r.car.slice(0, 2)} ${(r.share * 100).toFixed(0)}%`).join(" "));
      }
    }
    return;
  }
  if (process.argv.includes("--traffic")) {
    withHard(set, () => {
      const n = traffic("normal"), h = traffic("hard");
      n.forEach((x, i) => {
        const y = h[i].rows, xr = x.rows;
        const line = (rows: CarRow[]) =>
          `fin ${rows.map((r) => (r.finish[0] / 60).toFixed(1)).join("/")} falls ${sum(rows, (r) => r.falls)} walls ${sum(rows, (r) => r.walls)}(+${sum(rows, (r) => r.mineWalls)} mine) wrecks ${sum(rows, (r) => r.wrecks)} dirt ${sum(rows, (r) => r.dirt)} rivets ${sum(rows, (r) => r.rivetHits)}/${sum(rows, (r) => r.rivets)} mines ${sum(rows, (r) => r.mineHits)}/${sum(rows, (r) => r.mines)}`;
        console.log(`${x.key.padEnd(20)} N: ${line(xr)}\n${"".padEnd(20)} H: ${line(y)}`);
      });
      const all = (xs: { rows: CarRow[] }[], f: (r: CarRow) => number) => xs.reduce((a, x) => a + sum(x.rows, f), 0);
      console.log(`TOTAL falls N ${all(n, (r) => r.falls)} (${all(n, (r) => r.hitFalls)} after a hit) H ${all(h, (r) => r.falls)} (${all(h, (r) => r.hitFalls)} after a hit); walls N ${all(n, (r) => r.walls)} H ${all(h, (r) => r.walls)}; mine walls N ${all(n, (r) => r.mineWalls)} H ${all(h, (r) => r.mineWalls)}; wrecks N ${all(n, (r) => r.wrecks)} H ${all(h, (r) => r.wrecks)}`);
    });
    return;
  }
  if (process.argv.includes("--vs")) {
    withHard(set, () => {
      for (const track of HARD_TRACKS) {
        for (const hardFirst of [true, false]) {
          const levels: BotLevel[] = hardFirst ? ["hard", "hard", "hard", "normal", "normal"] : ["normal", "normal", "normal", "hard", "hard"];
          const rows = runRaces({ track, levels, hostBot: hardFirst ? "normal" : "hard", races: 3 });
          const wins = rows.map((r) => r.place.filter((p) => p === 1).length);
          const byLevel = (l: BotLevel) => rows.filter((r) => r.level === l);
          const pts = (l: BotLevel) => byLevel(l).reduce((a, r) => a + r.place.reduce((x, y) => x + y, 0), 0);
          console.log(`\n${track}, Hard on ${hardFirst ? "the first three seats" : "the last three seats"}: races won Hard ${sum(byLevel("hard"), (r) => r.place.filter((p) => p === 1).length)}, Normal ${sum(byLevel("normal"), (r) => r.place.filter((p) => p === 1).length)}; sum of places Hard ${pts("hard")}, Normal ${pts("normal")} (lower is better)`);
          rows.forEach((r, k) => console.log(`  ${r.name.padEnd(14)} ${r.level.padEnd(6)} ${r.car.padEnd(5)} places ${r.place.join(",")} won ${wins[k]} earned ${r.earned.join("+") || "?"}; wrecks ${r.wrecks} falls ${r.falls} (${r.hitFalls} after a hit) rivets ${r.rivetHits}/${r.rivets} mines ${r.mineHits}/${r.mines}; ${r.wallet}`));
        }
      }
    });
    return;
  }
  if (process.argv.includes("--golden")) {
    const t0 = performance.now();
    const all = goldenAll();
    for (const [k, r] of Object.entries(all)) {
      console.log(`${k.padEnd(22)} ${r.hash}  finish ${r.finish.map((f) => f.map((x) => (x / 1000).toFixed(2)).join("/")).join(" | ")} s`);
    }
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    return;
  }
  if (process.argv.includes("--mistakes") || process.argv.includes("--paces")) {
    const nums = (name: string, def: number[]) => (arg(name) ?? def.join()).split(",").map(Number);
    const weapons = process.argv.includes("--weapons");
    const pace = Number(arg("pace") ?? 1), aim = Number(arg("aim") ?? HARD.rivetSlack);
    const t0 = performance.now();
    const base = tuneTraffic("rate 0 (today's Hard)", undefined, MISTAKE_TRACKS, ["hard", "hard", "hard"], weapons).row;
    console.log(`3 Hard bots, weapons ${weapons ? "on" : "off"}, ${MISTAKE_TRACKS.join(", ")} x mix/sport/racer/truck, 3 laps:`);
    console.log(tuneLine(base, base));
    if (process.argv.includes("--mistakes")) {
      for (const size of nums("sizes", [0.5, 1])) {
        for (const rate of nums("rates", [0.5, 1, 2, 3])) {
          console.log(tuneLine(tuneTraffic(`rate ${rate} size ${size}`, tuneOf({ rate, size, pace, aim }), MISTAKE_TRACKS, ["hard", "hard", "hard"], weapons).row, base));
        }
      }
    } else {
      const rate = Number(arg("rate") ?? 0), size = Number(arg("size") ?? HARD.mistakeSize);
      for (const p of [0, 0.25, 0.5, 0.75, 1]) console.log(tuneLine(tuneTraffic(`pace ${p} rate ${rate}`, tuneOf({ rate, size, pace: p, aim }), MISTAKE_TRACKS, ["hard", "hard", "hard"], weapons).row, base));
    }
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    return;
  }
  console.log("Usage: npx tsx tools/debug/hard-tune.ts --golden | --pace | --sweep k=a,b,c [--sweep2 k=a,b] | --traffic | --vs  [--set k=v,...] | --mistakes | --paces");
}

if (process.argv[1]?.endsWith("hard-tune.ts")) main();
