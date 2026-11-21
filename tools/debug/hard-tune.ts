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

import { createHash, type Hash } from "node:crypto";
import { Game } from "../../client/game";
import type { Transport } from "../../client/net";
import { botTrace } from "../../server/bots";
import { Room, Rooms, type Player, type Session } from "../../server/room";
import type { BotLevel } from "../../shared/botdrive";
import type { CarState } from "../../shared/physics";
import { decode, encode, type ClientMsg, type ServerMsg } from "../../shared/protocol";
import { CAR_HP } from "../../shared/weapons";
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
  finish: number[][]; // per race, per bot: finish time (ms after GO, 0 = did not finish)
  wallets: string[]; // per race: the bots' wallets after the payout and shopping
}

/**
 * Server bots of `levels` race `races` races of `laps` laps in one room on `track` (the host
 * retires at GO each time). Hash of every tick's controls (by add order) and car states, and the
 * wallets after adding and after every race.
 */
export function goldenServer(track: string, levels: BotLevel[], races = 2, laps = 3): GoldenRun {
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
      const e = room.start(host, now);
      if (e) throw new Error(e);
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
function wired(rooms: Rooms, clock: { now: number }): { game: Game; open(): void; flush(): void } {
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
 * scripts/bots.ts drive): three bots on lanes -24, 0, 24 with weapons on, one race of `laps` laps
 * on `track` on the sim clock. Hash of every tick's controls, the predicted and the server's car.
 */
export function goldenClient(track = "crusher-run", laps = 3): GoldenRun {
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
    for (const w of ws.slice(1)) {
      w.game.setReady(true);
      w.flush();
    }
    ws[0].game.start();
    ws[0].flush();
    const drivers = ws.map((w, i) => new BotDriver(w.game, lanes[i]));
    const out: GoldenRun = { hash: "", finish: [[]], wallets: [] };
    for (let i = 0; i < 60 * 400 && (room.phase === "countdown" || room.phase === "racing"); i++) {
      clock.now += 1000 / 60;
      rooms.step(clock.now);
      for (const w of ws) w.flush();
      ws.forEach((w, k) => {
        const ctl = drivers[k].controls();
        feed(h, [k, ctl.throttle, ctl.steer, ctl.fire ? 1 : 0, ctl.mine ? 1 : 0]);
        w.game.step(ctl, 1000 / 60);
        feed(h, carVals(w.game.car));
        feed(h, carVals(room.players.get(w.game.you)?.car));
      });
    }
    out.finish[0] = ws.map((w) => room.players.get(w.game.you)?.progress?.fin ?? 0);
    out.wallets.push(JSON.stringify(ws.map((w) => room.players.get(w.game.you)?.wallet)));
    h.update(out.wallets[0]);
    out.hash = h.digest("hex");
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

function main(): void {
  if (process.argv.includes("--golden")) {
    const t0 = performance.now();
    const all = goldenAll();
    for (const [k, r] of Object.entries(all)) {
      console.log(`${k.padEnd(22)} ${r.hash}  finish ${r.finish.map((f) => f.map((x) => (x / 1000).toFixed(2)).join("/")).join(" | ")} s`);
    }
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    return;
  }
  console.log("Usage: npx tsx tools/debug/hard-tune.ts --golden");
}

if (process.argv[1]?.endsWith("hard-tune.ts")) main();
