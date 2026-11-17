// Headless end-to-end test: starts the real server in-process and drives bots that use
// the real client netcode (client/game.ts + client/net.ts over Node's WebSocket).
// Two races in a row with weapons, the garage and a reverse grid. Run: npm run bots

import net from "node:net";
import { Game, lostMessage, type ConnReason, type Controls, type TokenStore } from "../client/game";
import { connectWs, type LagSim } from "../client/net";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  decode,
  RESULTS_MS,
  type GameEvent,
  type Phase,
  type ResultRow,
  type ServerMsg,
} from "../shared/protocol";
import { AMMO, PLACE_PAYOUT, WRECK_BONUS } from "../shared/shop";
import { minSelfClearance, queryTrackNear, type TrackDef } from "../shared/track";
import { DEFAULT_TRACK_ID, registerTestTrack, trackById } from "../shared/tracks";
import { angleDiff, capsuleGap, clamp } from "../shared/physics";
import { BTN_RIVET, WEAPONS_ARM_MS } from "../shared/weapons";
import { startServer, type RunningServer } from "../server/index";
import { BotDriver } from "./bot-ai";

const STEP_MS = 1000 / 60;
const LAPS = 1;
const BOT_HP = 12; // low HP so wrecks really happen in a one-lap race (3 rivets or 1 mine)
const AMMO_PRICE = AMMO.rivets.price + AMMO.mines.price; // one pack of each
// Measured 2026-11-16 over 7 runs: 0.12-0.27 with bump prediction (0.23-0.35 without).
const CONTACT_P95_MAX = 0.5;
const track = trackById(DEFAULT_TRACK_ID);

// A second track for the track-switch race, registered in this process only (the in-process
// server and the bots share the registry). A plain loop half as long as Rust Bowl and far
// away from it, so a car on it cannot be on Rust Bowl too.
const TEST_TRACK_ID = "test-loop";
const TEST_LOOP: TrackDef = {
  id: TEST_TRACK_ID,
  name: "Test Loop",
  control: [[5000, 400], [5600, 400], [6050, 650], [6050, 1250], [5600, 1500], [4600, 1500], [4150, 1250], [4150, 650], [4500, 400]],
  halfWidth: 64,
  verge: 44,
};
registerTestTrack(TEST_LOOP);

// ---- tiny assertion log -------------------------------------------------------------

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  console.log(`      timed out after ${timeoutMs} ms waiting for: ${what}`);
  return false;
}

function memoryTokens(): TokenStore {
  const m = new Map<string, string>();
  return { get: (c) => m.get(c) ?? null, set: (c, t) => void m.set(c, t) };
}

/** Open a bare WebSocket and report what the server says before it closes it. */
function rawConnect(url: string, timeoutMs: number): Promise<{ err: string; closeCode: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let err = "-";
    const timer = setTimeout(() => {
      ws.close();
      resolve({ err, closeCode: 0 });
    }, timeoutMs);
    ws.onmessage = (e) => {
      const m = decode<ServerMsg>(e.data);
      if (m?.t === "err") err = `${m.code ?? "-"} "${m.msg}"`;
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve({ err, closeCode: e.code });
    };
  });
}

/**
 * A WebSocket client that never answers the server's close frame: a refused socket that
 * stays in its closing handshake until the server cuts it off.
 */
function stalledSocket(port: number): { refused: Promise<boolean>; open(): boolean; destroy(): void } {
  const sock = net.connect(port, "127.0.0.1");
  let open = true;
  let buf = "";
  sock.on("close", () => (open = false));
  sock.on("error", () => (open = false));
  sock.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const refused = new Promise<boolean>((resolve) => {
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.startsWith("HTTP/1.1 101") && buf.includes('"busy"')) resolve(true);
    });
    sock.on("close", () => resolve(false));
  });
  return { refused, open: () => open, destroy: () => sock.destroy() };
}

function stats(xs: number[]): { n: number; median: number; p95: number; max: number } {
  if (!xs.length) return { n: 0, median: NaN, p95: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

// ---- bot ----------------------------------------------------------------------------

class Bot {
  readonly game: Game;
  readonly driver: BotDriver;
  readonly events: GameEvent[] = [];
  readonly hitsAfterGo: number[] = []; // estimated server ms since GO when each hit arrived
  readonly errors: string[] = [];
  results: ResultRow[] | null = null;
  phases: Phase[] = [];
  welcomes = 0;
  garages = 0;
  ram: string | null = null; // player id to steer into (contact test) ...
  apart = false; // ... or, while set, to steer away from
  readonly contactErrs: number[] = []; // reconciliation errors while touching another car
  readonly freeErrs: number[] = []; // ... and all the others
  private errsSeen = 0;
  script: (() => Controls) | null = null; // scripted controls instead of the AI driver
  afterStep: (() => void) | null = null;

  constructor(
    readonly name: string,
    url: string,
    lateral: number,
    sim?: LagSim,
    readonly tokens: TokenStore = memoryTokens(), // shared store = same "tab"
  ) {
    this.game = new Game(() => connectWs(url, sim), tokens);
    this.driver = new BotDriver(this.game, lateral);
    this.game.on.welcome = () => this.welcomes++;
    this.game.on.garage = () => this.garages++;
    this.game.on.event = (ev) => {
      this.events.push(ev);
      if (ev.k === "hit") this.hitsAfterGo.push(this.game.serverNow() - this.game.raceStart);
    };
    this.game.on.results = (rows) => (this.results = rows);
    this.game.on.error = (msg) => this.errors.push(msg);
    // The server broadcasts a room message on every phase change.
    this.game.on.room = () => {
      if (this.phases[this.phases.length - 1] !== this.game.phase) this.phases.push(this.game.phase);
    };
  }

  set weapons(on: boolean) {
    this.driver.weapons = on;
  }

  /** Called every fixed step. */
  step(): void {
    const ctl = { ...(this.script?.() ?? this.driver.controls()) };
    if (this.ram) this.ramInto(this.ram, ctl);
    this.game.step(ctl, STEP_MS);
    this.afterStep?.();
    this.sortErrors();
  }

  /**
   * Contact test: steer at a point just ahead of the target car; with the target behind,
   * keep the line but coast so it catches up and runs into us. While `apart`, steer
   * away from it instead (so the next ram is a fresh impact, not just rubbing).
   */
  private ramInto(id: string, ctl: Controls): void {
    const c = this.game.car;
    const o = this.game.otherPoses().find((p) => p.id === id);
    if (!c || !o || c.wreck) return;
    const side = angleDiff(c.h, Math.atan2(o.y - c.y, o.x - c.x));
    if (this.apart) {
      if (Math.hypot(o.x - c.x, o.y - c.y) < 60) ctl.steer = side > 0 ? -0.6 : 0.6;
      return;
    }
    const tx = o.x + Math.cos(o.h) * 20, ty = o.y + Math.sin(o.h) * 20;
    const off = angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x));
    if (Math.abs(side) > Math.PI / 2) ctl.throttle = Math.min(ctl.throttle, 0);
    else ctl.steer = clamp(off * 2.5, -1, 1);
  }

  /**
   * File new reconciliation errors as "in contact" when the own car predicted a bump in
   * the last 300 ms or the server shows it within 3 units of another solid car.
   */
  private sortErrors(): void {
    const g = this.game;
    const errs = g.recErrors;
    if (errs.length === this.errsSeen) return;
    const me = g.latest?.cars.get(g.you);
    const touching =
      performance.now() - g.contact.lastContact < 300 ||
      (!!me && [...(g.latest?.cars.values() ?? [])].some((o) => o.id !== me.id && !o.ghost && !o.wreck && capsuleGap(me, o) < 3));
    for (let i = this.errsSeen; i < errs.length; i++) (touching ? this.contactErrs : this.freeErrs).push(errs[i]);
    this.errsSeen = errs.length;
  }
}

// ---- test ---------------------------------------------------------------------------

interface Ctx {
  url: string;
  server: RunningServer;
  /** Graceful shutdown, then a fresh server on the same port (rooms are gone). */
  restart(): Promise<void>;
}

async function main(): Promise<void> {
  const opts = { port: 0, vite: false, laps: LAPS, host: "127.0.0.1", hp: BOT_HP };
  let server = await startServer(opts);
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const ctx: Ctx = {
    url,
    get server() {
      return server;
    },
    async restart() {
      const port = server.port;
      await server.shutdown();
      server = await startServer({ ...opts, port });
    },
  };
  console.log(`server on ${url}, ${LAPS} lap(s), ${BOT_HP} HP, track length ${track.length.toFixed(0)}`);

  const bots: Bot[] = [];
  let last = performance.now();
  let acc = 0;
  const loop = setInterval(() => {
    const now = performance.now();
    acc += now - last;
    last = now;
    let n = 0;
    while (acc >= STEP_MS && n < 5) {
      for (const b of bots) b.step();
      acc -= STEP_MS;
      n++;
    }
    if (acc >= STEP_MS) acc = 0;
  }, 2);

  try {
    await run(ctx, bots);
  } finally {
    clearInterval(loop);
    for (const b of bots) b.game.leave();
    await server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** Expected scrap per racer from finish places and counted wreck events (not from `earned`). */
function expectedEarnings(events: GameEvent[], racers: string[]): Map<string, number> {
  const out = new Map<string, number>(racers.map((id) => [id, 0]));
  for (const e of events) {
    if (e.k === "finish") out.set(e.id, (out.get(e.id) ?? 0) + (PLACE_PAYOUT[e.place - 1] ?? 0));
    if (e.k === "wreck" && e.by !== e.id && out.has(e.by)) out.set(e.by, out.get(e.by)! + WRECK_BONUS);
  }
  return out;
}

/** Every racer except the host reports ready; resolves once the host's room state shows it. */
async function readyUp(label: string, host: Bot, racers: Bot[]): Promise<boolean> {
  const others = racers.filter((b) => b !== host);
  for (const b of others) b.game.setReady(true);
  return waitFor(`${label}: racers ready`, () => others.every((b) => host.game.player(b.game.you)?.ready), 3000);
}

async function runRace(label: string, bots: Bot[], host: Bot, racers: Bot[]): Promise<ResultRow[]> {
  const evFrom = host.events.length;
  for (const b of bots) b.results = null;
  await readyUp(label, host, racers);
  const e0 = host.errors.length;
  const waiting = host.game.waitingFor();
  host.game.start();
  await waitFor(`${label}: countdown`, () => host.game.phase === "countdown", 2000);
  check(
    `${label}: host start accepted once every racer is ready`,
    host.game.phase === "countdown" && host.errors.length === e0,
    host.errors.slice(e0).join("; ") || `host counted ${waiting} not ready at Start`,
  );
  await waitFor(`${label}: racing`, () => host.game.phase === "racing", 5000);
  const t0 = performance.now();
  const finished = () => racers.every((b) => host.game.latest?.cars.get(b.game.you)?.fin);
  await waitFor(`${label}: all finish`, finished, 150_000);
  check(`${label}: every racer finishes`, finished(), `last finisher after ~${((performance.now() - t0) / 1000).toFixed(1)}s`);
  await waitFor(`${label}: results`, () => host.results !== null, 5000);
  const rows = host.results ?? [];
  const finishOrder = host.events
    .slice(evFrom)
    .filter((e): e is Extract<GameEvent, { k: "finish" }> => e.k === "finish")
    .sort((a, b) => a.place - b.place)
    .map((e) => e.id);
  const ascending = rows.every((r, i) => r.timeMs > 0 && (i === 0 || r.timeMs >= rows[i - 1].timeMs));
  check(
    `${label}: results ordered by time and match finish events`,
    rows.length === racers.length && ascending && rows.map((r) => r.id).join() === finishOrder.join(),
    rows.map((r) => `${r.name} ${(r.timeMs / 1000).toFixed(2)}s +${r.earned}`).join(", "),
  );
  return rows;
}

async function run(ctx: Ctx, bots: Bot[]): Promise<void> {
  await runGame(ctx, bots);
  await runServerFull(bots);
  await runArmDelayLagged(bots);
  await runContact(ctx, bots);
  await runTrackSwitch(ctx, bots);
}

const lost = new Map<string, (ConnReason | undefined)[]>();
const reconnecting = new Map<string, (ConnReason | undefined)[]>();
function watch(b: Bot): void {
  lost.set(b.name, []);
  reconnecting.set(b.name, []);
  b.game.on.connection = (state, reason) => {
    if (state === "lost") lost.get(b.name)!.push(reason);
    if (state === "reconnecting") reconnecting.get(b.name)!.push(reason);
  };
}

async function runGame(ctx: Ctx, bots: Bot[]): Promise<void> {
  const url = ctx.url;
  // Track sanity.
  const clearance = minSelfClearance(track);
  check("track: minSelfClearance > 2 * wall", clearance > 2 * track.wall, `${clearance.toFixed(1)} > ${2 * track.wall}`);

  // Unknown code is refused.
  const stray = new Bot("Stray", url, 0);
  stray.game.join("ZZZZ", "Stray");
  await waitFor("error for unknown room", () => stray.errors.length > 0, 3000);
  check("join with an unknown code is refused", stray.errors.length > 0 && !stray.game.you, stray.errors[0] ?? "no error");
  stray.game.leave();

  // A creates, B (lagged) and C join by code.
  const A = new Bot("Alpha", url, -24);
  const B = new Bot("Bravo", url, 24, { lag: 80, jitter: 10 });
  const C = new Bot("Charlie", url, 0);
  bots.push(A, B, C);
  A.game.create(A.name);
  await waitFor("A welcome", () => !!A.game.you, 3000);
  const code = A.game.code;
  const codeRe = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
  check("create: room code format", codeRe.test(code), code);
  B.game.join(code, B.name);
  C.game.join(code, C.name);
  await waitFor("3 players in room", () => [A, B, C].every((b) => b.game.players.length === 3), 3000);
  check("join by code: 3 players see each other", [A, B, C].every((b) => b.game.players.length === 3));
  check("host is the creator", A.game.isHost() && B.game.hostId === A.game.you);

  // Garage: starting kit, purchases, a refusal.
  await waitFor("garage + snapshot", () => [A, B, C].every((b) => b.garages > 0 && !!b.game.latest), 3000);
  check(
    "garage: starting kit (400 scrap, no rivets, no mines)",
    [A, B, C].every((b) => b.game.scrap === 400 && b.game.serverAmmo.join() === "0,0"),
    [A, B, C].map((b) => `${b.name} ${b.game.scrap} ${b.game.serverAmmo.join("/")}`).join(", "),
  );
  // A and C arm themselves for race 1; B spends everything on the engine and races unarmed.
  for (const b of [A, C]) {
    b.game.buy("rivets");
    b.game.buy("mines");
  }
  const kit = `${AMMO.rivets.pack},${AMMO.mines.pack}`;
  await waitFor("A and C ammo in snapshots", () => [A, C].every((b) => b.game.serverAmmo.join() === kit), 3000);
  check(
    "garage: Alpha and Charlie buy rivets and mines (350)",
    [A, C].every((b) => b.game.scrap === 400 - AMMO_PRICE && b.game.serverAmmo.join() === kit),
    [A, C].map((b) => `${b.name} ${b.game.scrap} ${b.game.serverAmmo.join("/")}`).join(", "),
  );
  const g0 = B.garages;
  B.game.buy("engine");
  await waitFor("B engine bought", () => B.garages > g0, 3000);
  check("garage: lagged bot buys Engine L1", B.game.scrap === 0 && B.game.levels.engine === 1, `scrap ${B.game.scrap}`);
  const e0 = B.errors.length;
  B.game.buy("tyres");
  await waitFor("B tyres refused", () => B.errors.length > e0, 3000);
  check("garage: purchase refused without enough scrap", B.errors[e0] === "Not enough scrap", B.errors[e0] ?? "no error");

  // Non-host cannot start.
  const e1 = B.errors.length;
  B.game.start();
  await waitFor("B start refused", () => B.errors.length > e1, 2000);
  check("non-host start is refused", B.errors.length > e1 && A.game.phase === "lobby", B.errors[e1] ?? "");

  // Ready check: the host's Start waits for B and C; with B ready it still waits for C.
  const e2 = A.errors.length;
  A.game.start();
  await waitFor("A start refused (nobody ready)", () => A.errors.length > e2, 2000);
  const waitingBefore = A.game.waitingFor();
  B.game.setReady(true);
  await waitFor("A sees B ready", () => !!A.game.player(B.game.you)?.ready, 2000);
  const e3 = A.errors.length;
  A.game.start();
  await waitFor("A start refused (C not ready)", () => A.errors.length > e3, 2000);
  check(
    "ready check: start refused while a bot is not ready (2, then 1 waiting)",
    A.errors[e2] === "Waiting for 2 players to get ready" &&
      A.errors[e3] === "Waiting for 1 player to get ready" &&
      waitingBefore === 2 &&
      A.game.waitingFor() === 1 &&
      A.game.phase === "lobby",
    `${A.errors[e2] ?? "-"}; ${A.errors[e3] ?? "-"}; client counted ${waitingBefore} then ${A.game.waitingFor()}`,
  );

  // ---- race 1 ----------------------------------------------------------------------
  const scrapBefore1 = new Map([A, B, C].map((b) => [b.game.you, b.game.scrap]));
  const ev1From = A.events.length;
  const race1 = runRace("race 1", bots, A, [A, B, C]);
  await waitFor("racing", () => A.game.phase === "racing", 6000);
  check("race 1: all 3 have a car", [A, B, C].every((b) => !!b.game.car));

  // D joins mid-race: seated for the next race, no car.
  await sleep(2000);
  const D = new Bot("Delta", url, 0);
  bots.push(D);
  D.game.join(code, D.name);
  await waitFor("D welcome + snapshot", () => !!D.game.you && !!D.game.latest, 3000);
  await sleep(200);
  const dInfo = A.game.player(D.game.you);
  check(
    "mid-race joiner: inRace false and no car",
    !!dInfo && dInfo.inRace === false && !D.game.car && !D.game.latest?.cars.has(D.game.you),
    `inRace=${dInfo?.inRace} car=${!!D.game.car}`,
  );

  // C holds fire, drops its connection mid-race and comes back with its token.
  await sleep(1500);
  C.weapons = false;
  await sleep(800);
  const cId = C.game.you;
  const cBefore = A.game.latest?.cars.get(cId);
  const cAmmo = [...C.game.serverAmmo];
  const cScrap = C.game.scrap;
  const welcomesBefore = C.welcomes;
  C.game.simulateDrop();
  await waitFor("server marks C offline", () => A.game.player(cId)?.connected === false, 2000);
  const offlineSeen = A.game.player(cId)?.connected === false;
  await waitFor("C rejoined", () => C.welcomes > welcomesBefore && !!C.game.car, 5000);
  await sleep(150);
  const cAfter = A.game.latest?.cars.get(cId);
  check("disconnect is visible to others", offlineSeen);
  check(
    "rejoin with token: same player id, car kept",
    C.game.you === cId && !!cAfter && A.game.players.length === 4,
    `id ${cId} -> ${C.game.you}, players ${A.game.players.length}`,
  );
  check(
    "rejoin: car continues from where it was (not reset to the grid)",
    !!cBefore && !!cAfter && cAfter.rd >= cBefore.rd - 30 && cBefore.rd > 300,
    `rd ${cBefore?.rd.toFixed(0)} -> ${cAfter?.rd.toFixed(0)}`,
  );
  check(
    "rejoin: scrap and ammo kept",
    C.game.scrap === cScrap && C.game.serverAmmo.join() === cAmmo.join(),
    `scrap ${cScrap}->${C.game.scrap}, ammo ${cAmmo.join("/")}->${C.game.serverAmmo.join("/")}`,
  );
  C.weapons = true;

  const rows1 = await race1;
  check("results: mid-race joiner not listed", !rows1.some((r) => r.id === D.game.you));
  const expect1 = expectedEarnings(A.events.slice(ev1From), [A, B, C].map((b) => b.game.you));
  await waitFor("garage after payouts", () => [A, B, C].every((b) => b.game.scrap !== scrapBefore1.get(b.game.you) || expect1.get(b.game.you) === 0), 3000);
  const scrapOk = [A, B, C].every((b) => b.game.scrap === scrapBefore1.get(b.game.you)! + expect1.get(b.game.you)!);
  check(
    "race 1: scrap = before + place money + 60 per wreck caused (from events)",
    scrapOk && rows1.every((r) => r.earned === expect1.get(r.id)),
    [A, B, C].map((b) => `${b.name} ${scrapBefore1.get(b.game.you)}+${expect1.get(b.game.you)}=${b.game.scrap}`).join(", "),
  );

  await waitFor("back to lobby", () => A.game.phase === "lobby", RESULTS_MS + 3000);
  const cleared = await waitFor("cars cleared", () => A.game.latest?.cars.size === 0, 1000);
  check("back in lobby: cars cleared", cleared);

  // Spend winnings on rivets so race 2 has shooting too; Delta buys its first ammo.
  for (const b of [A, B, C]) if (b.game.scrap >= 150) b.game.buy("rivets");
  D.game.buy("rivets");
  D.game.buy("mines");
  await waitFor("D ammo in snapshots", () => D.game.serverAmmo.join() === kit, 3000);
  check(
    "garage: Delta buys rivets and mines before race 2",
    D.game.scrap === 400 - AMMO_PRICE && D.game.serverAmmo.join() === kit,
    `${D.game.scrap} ${D.game.serverAmmo.join("/")}`,
  );
  await sleep(300);

  // ---- race 2: reverse grid, D joins in -------------------------------------------
  const order1 = rows1.map((r) => r.id);
  const race2 = runRace("race 2", bots, A, [A, B, C, D]);
  await waitFor("race 2 countdown snapshot", () => A.game.phase === "countdown" && (A.game.latest?.cars.size ?? 0) === 4, 4000);
  const grid = [...(A.game.latest?.cars.values() ?? [])].sort((a, b) => b.rd - a.rd).map((c) => c.id);
  const expectGrid = [D.game.you, ...[...order1].reverse()];
  const nameOf = (id: string) => A.game.player(id)?.name ?? id;
  check("race 2: reverse grid (newcomer first, last winner at the back)", grid.join() === expectGrid.join(), grid.map(nameOf).join(" > "));
  await race2;
  await waitFor("back to lobby", () => A.game.phase === "lobby", RESULTS_MS + 3000);

  const seq = A.phases.join(" -> ");
  const expectSeq = "lobby -> countdown -> racing -> results -> lobby -> countdown -> racing -> results -> lobby";
  check("phases over two races", seq === expectSeq, seq);

  // ---- combat and reconciliation ----------------------------------------------------
  const hits = A.events.filter((e) => e.k === "hit");
  const wrecks = A.events.filter((e): e is Extract<GameEvent, { k: "wreck" }> => e.k === "wreck");
  check("combat happened: hits and wrecks", hits.length > 0 && wrecks.length > 0, `${hits.length} hits, ${wrecks.length} wrecks`);
  const firstHit = Math.min(...A.hitsAfterGo);
  check(
    "weapons armed delay: no hit arrives in the first 8 s of a race",
    A.hitsAfterGo.length > 0 && firstHit >= WEAPONS_ARM_MS - 100,
    `earliest hit ${(firstHit / 1000).toFixed(2)} s after GO`,
  );
  const wreckedIds = new Set(wrecks.map((w) => w.id));
  for (const b of [A, B, C, D]) {
    const s = stats(b.game.recErrors);
    const w = wrecks.filter((x) => x.id === b.game.you).length;
    console.log(
      `      ${b.name.padEnd(8)} rec err: n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)}  rtt=${b.game.rtt.toFixed(1)}ms  wrecked ${w}x`,
    );
  }
  const wreckedBots = [A, B, C, D].filter((b) => wreckedIds.has(b.game.you));
  check(
    "every wrecked bot: no reconciliation error > 50 (freeze and respawn predicted)",
    wreckedBots.length > 0 && wreckedBots.every((b) => stats(b.game.recErrors).max <= 50),
    wreckedBots.map((b) => `${b.name} ${stats(b.game.recErrors).max.toFixed(1)}`).join(", "),
  );
  const sb = stats(B.game.recErrors);
  check("lagged bot (80±10 ms, Engine L1): median reconciliation error < 0.5", sb.n > 100 && sb.median < 0.5, `median ${sb.median.toFixed(3)} over ${sb.n} samples`);
  check("lagged bot: no reconciliation error > 50 (no teleports)", sb.n > 100 && sb.max <= 50, `max ${sb.max.toFixed(2)}`);
  check("lagged bot: measured RTT reflects the simulated lag", B.game.rtt > 60, `${B.game.rtt.toFixed(1)} ms`);

  // ---- seat taken over (a duplicated tab shares the token) ---------------------------
  [A, B, C, D].forEach(watch);
  const dId = D.game.you;
  const E = new Bot("Echo", url, 0, undefined, D.tokens);
  bots.push(E);
  watch(E);
  E.game.join(code, E.name);
  await waitFor("E takes D's seat", () => E.game.you === dId && lost.get("Delta")!.length > 0, 3000);
  await sleep(2500); // D must not come back and take the seat again
  check(
    "seat taken over in another tab: old client stops, no ping-pong",
    lost.get("Delta")!.join() === "taken" && !D.game.connected && E.game.connected && E.game.you === dId && A.game.players.length === 4,
    `Delta lost: ${lost.get("Delta")!.join() || "-"}, Echo connected: ${E.game.connected}, players ${A.game.players.length}`,
  );

  // ---- server restart: rooms are gone ------------------------------------------------
  const left = [A, B, C, E];
  await ctx.restart();
  await waitFor("everyone told the room is gone", () => left.every((b) => lost.get(b.name)!.length > 0), 10_000);
  await sleep(300);
  const restartText = lostMessage(lost.get("Alpha")![0], true);
  check(
    "server restart: restart notice, then 'room is gone, the server restarted', reconnecting stops",
    left.every((b) => reconnecting.get(b.name)![0] === "restarting" && lost.get(b.name)!.join() === "restarted") &&
      /the server restarted/.test(restartText),
    left.map((b) => `${b.name}: ${reconnecting.get(b.name)![0] ?? "-"} -> ${lost.get(b.name)!.join() || "-"}`).join(", ") +
      `; menu: "${restartText}"`,
  );
  check("after the restart no client keeps a socket open", ctx.server.sockets() === 0, `${ctx.server.sockets()} open`);

  // ---- room closed while away, no restart notice -------------------------------------
  const F = new Bot("Foxtrot", url, 0);
  bots.push(F);
  watch(F);
  F.game.create(F.name);
  await waitFor("F welcome", () => !!F.game.you, 3000);
  F.game.simulateDrop();
  // Stands in for the reconnect grace running out with nobody in the room: the server
  // deletes the room while F is away (F rejoins after 1 s).
  ctx.server.rooms.rooms.delete(F.game.code);
  await waitFor("F told the room closed", () => lost.get("Foxtrot")!.length > 0, 5000);
  const awayText = lostMessage(lost.get("Foxtrot")![0], true);
  check(
    "room closed while away (no restart notice): menu says so and does not blame a restart",
    lost.get("Foxtrot")!.join() === "gone" &&
      !reconnecting.get("Foxtrot")!.includes("restarting") &&
      /closed while you were away/.test(awayText) &&
      !/restart/i.test(awayText),
    `Foxtrot: ${reconnecting.get("Foxtrot")!.map((r) => r ?? "drop").join(",")} -> ${lost.get("Foxtrot")!.join() || "-"}; menu: "${awayText}"`,
  );
}

/** A server with a socket cap of 2: the next socket is told "busy" over the socket. */
async function runServerFull(bots: Bot[]): Promise<void> {
  const FULL_TEXT = "The server is full right now, try again later";
  const small = await startServer({ port: 0, vite: false, laps: LAPS, host: "127.0.0.1", maxSockets: 2 });
  const url = `ws://127.0.0.1:${small.port}/ws`;
  const G = new Bot("Golf", url, 0);
  const H = new Bot("Hotel", url, 0);
  const I = new Bot("India", url, 0);
  bots.push(G, H, I);
  [G, H, I].forEach(watch);
  try {
    G.game.create(G.name);
    await waitFor("G welcome", () => !!G.game.you, 3000);
    H.game.join(G.game.code, H.name);
    await waitFor("H welcome", () => !!H.game.you, 3000);

    const raw = await rawConnect(url, 3000);
    check(
      "server full (socket cap 2): a third socket gets err busy, then close 1013",
      raw.err === `busy "${FULL_TEXT}"` && raw.closeCode === 1013,
      `err ${raw.err}, close ${raw.closeCode}`,
    );

    I.game.join(G.game.code, I.name);
    await waitFor("I refused", () => lost.get("India")!.length > 0, 3000);
    const iText = lostMessage(lost.get("India")![0], false);
    check(
      "server full: a new client's menu says the server is full (not 'could not reach')",
      lost.get("India")!.join() === "busy" && iText === FULL_TEXT && !I.game.you && I.errors.length === 0,
      `India lost: ${lost.get("India")!.join() || "-"}; menu: "${iText}"`,
    );
    await waitFor("refused sockets closed", () => small.sockets() === 2, 2000);
    check("server full: refused sockets do not stay open", small.sockets() === 2, `${small.sockets()} open`);

    // A player who drops while the server is full keeps retrying and gets back in.
    const hId = H.game.you;
    const hWelcomes = H.welcomes;
    H.game.simulateDrop();
    await waitFor("H socket gone", () => small.sockets() === 1, 2000);
    const filler = new WebSocket(url); // takes the free slot
    await waitFor("filler counted", () => small.sockets() === 2, 2000);
    await waitFor("H refused at least once", () => reconnecting.get("Hotel")!.length >= 2, 5000);
    const refusedTries = reconnecting.get("Hotel")!.length;
    filler.close();
    await waitFor("H back in", () => H.welcomes > hWelcomes && H.game.connected, 5000);
    check(
      "server full: a dropped player retries while refused and gets back in when a slot frees",
      refusedTries >= 2 && H.game.you === hId && H.game.connected && lost.get("Hotel")!.length === 0,
      `${refusedTries} reconnect attempts before the slot freed, id ${hId} -> ${H.game.you}`,
    );

    H.game.leave();
    await waitFor("H socket gone", () => small.sockets() === 1, 2000);
    I.game.join(G.game.code, I.name);
    await waitFor("I welcome", () => !!I.game.you, 3000);
    check("server full: once a socket frees up, a new client joins", I.game.code === G.game.code && !!I.game.you);

    // A refusal still in its closing handshake must not hold a slot: G and I fill the cap,
    // a stalled client is refused, I leaves, and H joins before the refusal has closed.
    const stalled = stalledSocket(small.port);
    const wasRefused = await stalled.refused;
    const countedWhileClosing = small.sockets();
    I.game.leave();
    await waitFor("I socket gone", () => small.sockets() === 2, 500);
    H.game.join(G.game.code, H.name);
    await waitFor("H joins", () => !!H.game.you || lost.get("Hotel")!.length > 0, 500);
    const stillClosing = stalled.open();
    check(
      "server full: a freed slot is usable while a refused socket is still closing",
      wasRefused && countedWhileClosing === 3 && stillClosing && !!H.game.you && lost.get("Hotel")!.length === 0,
      `refused ${wasRefused}, sockets while closing ${countedWhileClosing}, refusal still open at join ${stillClosing}, ` +
        `Hotel ${H.game.you ? "joined" : `lost: ${lost.get("Hotel")!.join() || "-"}`}`,
    );
    await waitFor("stalled refusal cut off", () => !stalled.open(), 3000);
    check("server full: a refused socket that never closes is cut off", !stalled.open());
    stalled.destroy();
  } finally {
    for (const b of [G, H, I]) b.game.leave();
    await small.close();
  }
}

/**
 * Solid car contact: a lagged bot (80±10 ms) and an unlagged one steer into each other for
 * a stretch of a race, weapons off. The lagged bot predicts its half of every bump; its
 * reconciliation error while touching shows how well that prediction holds.
 */
async function runContact(ctx: Ctx, bots: Bot[]): Promise<void> {
  const L = new Bot("Lima", ctx.url, 0, { lag: 80, jitter: 10 });
  const M = new Bot("Mike", ctx.url, 0);
  bots.push(L, M);
  for (const b of [L, M]) b.weapons = false;
  L.game.create(L.name);
  await waitFor("L welcome", () => !!L.game.you, 3000);
  M.game.join(L.game.code, M.name);
  await waitFor("M in L's room", () => L.game.players.length === 2, 3000);
  await readyUp("contact", L, [L, M]);
  L.game.start();
  await waitFor("contact: racing", () => L.game.phase === "racing" && !!L.game.car && !!M.game.car, 6000);
  L.ram = M.game.you;
  M.ram = L.game.you;
  for (let i = 0; i < 7; i++) {
    for (const b of [L, M]) b.apart = false;
    await sleep(1400);
    for (const b of [L, M]) b.apart = true;
    await sleep(600);
  }
  const impacts = L.game.contact.takeImpacts().length + M.game.contact.takeImpacts().length;
  for (const b of [L, M]) b.game.leave();

  const all = stats(L.game.recErrors);
  const hit = stats(L.contactErrs);
  const free = stats(L.freeErrs);
  console.log(
    `      Lima     rec err: all n=${all.n} median=${all.median.toFixed(3)} p95=${all.p95.toFixed(3)} max=${all.max.toFixed(2)}; ` +
      `in contact n=${hit.n} median=${hit.median.toFixed(3)} p95=${hit.p95.toFixed(3)} max=${hit.max.toFixed(2)}; ` +
      `free p95=${free.p95.toFixed(3)}; impact effects ${impacts}`,
  );
  check("contact: the bots really bumped (>= 60 reconciliation samples in contact)", hit.n >= 60, `${hit.n} samples`);
  check(
    `contact: lagged bot p95 reconciliation error in contact < ${CONTACT_P95_MAX}`,
    hit.n >= 60 && hit.p95 < CONTACT_P95_MAX,
    `p95 ${hit.p95.toFixed(3)}`,
  );
  check("contact: lagged bot median < 0.5 and max <= 50 throughout", all.n > 100 && all.median < 0.5 && all.max <= 50, `median ${all.median.toFixed(3)}, max ${all.max.toFixed(2)}`);
}

/**
 * A 100 ms RTT player holding the rivet gun from GO to past the 8 s mark. Its serverNow runs
 * behind the server and the server reads each input later still, so a fire bit sent before
 * the client's own armed() would make the server fire rivets the client never predicted.
 */
async function runArmDelayLagged(bots: Bot[]): Promise<void> {
  const srv = await startServer({ port: 0, vite: false, laps: LAPS, host: "127.0.0.1" });
  const K = new Bot("Kilo", `ws://127.0.0.1:${srv.port}/ws`, 0, { lag: 100, jitter: 0 });
  bots.push(K);
  try {
    K.game.create(K.name);
    await waitFor("K welcome + snapshot", () => !!K.game.you && !!K.game.latest, 3000);
    K.game.buy("rivets");
    await waitFor("K rivets", () => K.game.serverAmmo[0] === AMMO.rivets.pack, 3000);
    let hold = true;
    let lastSeq = -1;
    let predicted = 0;
    let earlyFireBits = 0;
    K.script = () => ({ throttle: 0, steer: 0, fire: hold, mine: false });
    K.afterStep = () => {
      const p = K.game.pending[K.game.pending.length - 1];
      if (!p || p.seq <= lastSeq) return; // no input sent this step
      lastSeq = p.seq;
      if (p.fired) predicted++;
      if (p.cmd.buttons & BTN_RIVET && !K.game.armed()) earlyFireBits++;
    };
    K.game.start();
    await waitFor("K racing", () => K.game.phase === "racing", 5000);
    await waitFor("K armed", () => K.game.armed(), WEAPONS_ARM_MS + 2000);
    await sleep(1000); // keep holding past the mark
    hold = false;
    await sleep(800); // the server consumes the rest and snapshots the ammo
    const serverFired = AMMO.rivets.pack - K.game.serverAmmo[0];
    check(
      "armed delay at 100 ms RTT: no fire bit sent before armed(); the server fires exactly the predicted rivets",
      earlyFireBits === 0 && predicted >= 5 && serverFired === predicted,
      `${earlyFireBits} early fire inputs, predicted ${predicted}, server fired ${serverFired}`,
    );
  } finally {
    K.script = null;
    K.afterStep = null;
    K.game.leave();
    await srv.close();
  }
}

/**
 * Per-room track: the host switches the lobby to the test loop (refusals for a non-host and an
 * unknown id, ready reset), a reloaded tab rejoins onto it, and the room races a lap there.
 * The server's race distance at the finish is the test loop's length, every car stays inside
 * its walls, and the lagged bot predicts on it (small reconciliation errors).
 */
async function runTrackSwitch(ctx: Ctx, bots: Bot[]): Promise<void> {
  const loop = trackById(TEST_TRACK_ID);
  const N = new Bot("November", ctx.url, -24);
  const O = new Bot("Oscar", ctx.url, 24, { lag: 80, jitter: 10 });
  bots.push(N, O);
  for (const b of [N, O]) b.weapons = false;
  N.game.create(N.name);
  await waitFor("N welcome", () => !!N.game.you, 3000);
  O.game.join(N.game.code, O.name);
  await waitFor("O in N's room", () => N.game.players.length === 2 && O.game.players.length === 2, 3000);
  check(
    "track: a new room races on the default track",
    [N, O].every((b) => b.game.trackId === DEFAULT_TRACK_ID && b.game.track === track),
    [N, O].map((b) => `${b.name} ${b.game.trackId}`).join(", "),
  );

  O.game.setReady(true);
  await waitFor("N sees O ready", () => !!N.game.player(O.game.you)?.ready, 2000);
  const eO = O.errors.length;
  O.game.pickTrack(TEST_TRACK_ID);
  await waitFor("O's pick refused", () => O.errors.length > eO, 2000);
  const eN = N.errors.length;
  N.game.pickTrack("no-such-track");
  await waitFor("unknown id refused", () => N.errors.length > eN, 2000);
  check(
    "track: refused from a non-host and for an unknown id",
    O.errors[eO] === "Only the host can pick the track" && N.errors[eN] === "Unknown track" && N.game.trackId === DEFAULT_TRACK_ID,
    `${O.errors[eO] ?? "-"}; ${N.errors[eN] ?? "-"}`,
  );

  N.game.pickTrack(TEST_TRACK_ID);
  await waitFor("both on the test loop", () => [N, O].every((b) => b.game.trackId === TEST_TRACK_ID), 2000);
  check(
    "track: the host's pick reaches everyone; Game.track is the picked track",
    [N, O].every((b) => b.game.trackId === TEST_TRACK_ID && b.game.track === loop),
    [N, O].map((b) => `${b.name} ${b.game.trackId}`).join(", "),
  );
  check("track: the switch resets the ready flag", !N.game.player(O.game.you)?.ready && O.game.me()?.ready === false);

  // A reload: a fresh Game (default track) with the same token takes the seat back.
  const oId = O.game.you;
  O.game.leave();
  await waitFor("O offline", () => N.game.player(oId)?.connected === false, 2000);
  const O2 = new Bot("Oscar", ctx.url, 24, { lag: 80, jitter: 10 }, O.tokens);
  bots.push(O2);
  O2.weapons = false;
  const before = O2.game.trackId;
  O2.game.join(N.game.code, O2.name);
  await waitFor("O2 rejoined", () => O2.game.you === oId && O2.game.trackId === TEST_TRACK_ID, 3000);
  check(
    "track: a rejoin gets the room's track",
    before === DEFAULT_TRACK_ID && O2.game.you === oId && O2.game.trackId === TEST_TRACK_ID && O2.game.track === loop,
    `${before} -> ${O2.game.trackId}`,
  );

  // Race a lap on it. Sample the server's view of every car while it runs.
  let samples = 0;
  let offTrack = 0;
  const rdAtFinish = new Map<string, number>();
  N.afterStep = () => {
    for (const c of N.game.latest?.cars.values() ?? []) {
      // The last finisher's first snapshot already says "results" (the race ends that tick).
      if (c.fin && !rdAtFinish.has(c.id)) rdAtFinish.set(c.id, c.rd);
      if (N.game.phase !== "racing") continue;
      samples++;
      if (queryTrackNear(loop, c.x, c.y, c.seg).dist > loop.wall) offTrack++;
    }
  };
  const e0 = O2.game.recErrors.length;
  try {
    const rows = await runRace("track switch", bots, N, [N, O2]);
    // runRace returns on its own poll; the sampler runs on the next game step.
    await waitFor("both finish distances sampled", () => rdAtFinish.size === 2, 1000);
    const seen = [...rdAtFinish].map(([id, rd]) => `${N.game.player(id)?.name ?? id} ${rd.toFixed(0)}`).join(", ");
    const latest = [...(N.game.latest?.cars.values() ?? [])].map((c) => `${N.game.player(c.id)?.name ?? c.id} fin=${c.fin} rd=${c.rd.toFixed(0)}`).join(", ");
    check(
      "track: the race ran on the test loop (server race distance at the finish = its length)",
      rows.length === 2 && rdAtFinish.size === 2 && [...rdAtFinish.values()].every((rd) => Math.abs(rd - loop.length) < 200),
      `loop ${loop.length.toFixed(0)}, Rust Bowl ${track.length.toFixed(0)}; at the finish ${seen}` + (rdAtFinish.size === 2 ? "" : `; latest: ${latest}`),
    );
    check("track: every car stayed inside the test loop's walls", samples > 500 && offTrack === 0, `${offTrack} of ${samples} samples outside`);
    const s = stats(O2.game.recErrors.slice(e0));
    check(
      "track: the lagged bot predicts on the new track (median < 0.5, max <= 50)",
      s.n > 100 && s.median < 0.5 && s.max <= 50,
      `n=${s.n} median ${s.median.toFixed(3)} max ${s.max.toFixed(2)}`,
    );
  } finally {
    N.afterStep = null;
    for (const b of [N, O2]) b.game.leave();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
