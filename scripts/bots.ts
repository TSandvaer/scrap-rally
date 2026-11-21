// Headless end-to-end test: starts the real server in-process and drives bots that use
// the real client netcode (client/game.ts + client/net.ts over Node's WebSocket).
// Two races in a row with weapons, the garage and a reverse grid. Run: npm run bots

import net from "node:net";
import { Game, lostMessage, NO_CONTROLS, type ConnReason, type Controls, type TokenStore } from "../client/game";
import { connectWs, type LagSim } from "../client/net";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  decode,
  RESULTS_MS,
  type ChatLine,
  type GameEvent,
  type Phase,
  type ResultRow,
  type ServerMsg,
} from "../shared/protocol";
import { AMMO, PLACE_PAYOUT, statsFor, WRECK_BONUS } from "../shared/shop";
import { BUILTIN_SOUND, DEFAULT_SONG_ID, RANDOM_SONG, SONG_IDS } from "../shared/sound";
import { gridSlot, pointAt, queryTrackNear, validateTrack, type Track, type TrackDef } from "../shared/track";
import { DEFAULT_TRACK_ID, registerTestTrack, trackById, trackList } from "../shared/tracks";
import { angleDiff, BASE_STATS, capsuleGap, clamp, speedOf, type CarState } from "../shared/physics";
import { BTN_RIVET, MINE_FADE_TICKS, MINE_LIFE_TICKS, validateRunUps, WEAPONS_ARM_MS } from "../shared/weapons";
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

// Jumps and falls (M3-T1b): the layout of scripts/sim-test.ts's T1B_DEF. One straight
// (s = x there): ramp 1100..1200 into a gap 1200..1400, ramp 2000..2100 into a gap
// 2100..2250, a hole at s = 5000; recovery points 0, 700, 1700 and 4500.
const JUMPS_TRACK_ID = "t1b-jumps";
const JUMPS: TrackDef = {
  id: JUMPS_TRACK_ID,
  name: "T1b Jumps",
  control: [...Array.from({ length: 13 }, (_, i): [number, number] => [i * 1000, 0]), [12000, 3000], [-1000, 3000], [-1000, 0]],
  halfWidth: 64,
  verge: 44,
  features: [
    { k: "ramp", s: 1100, len: 100 },
    { k: "gap", s0: 1200, s1: 1400 },
    { k: "ramp", s: 2000, len: 100 },
    { k: "gap", s0: 2100, s1: 2250 },
    { k: "hole", s: 5000, lat: 0, r: 30 },
  ],
  recovery: [0, 700, 1700, 4500],
};
registerTestTrack(JUMPS);
// The prediction error bound through a jump and a fall (advisor change 9): below one tick of
// top-speed travel (~7.2 units).
const JUMP_FALL_ERR_MAX = 7;

/**
 * The jump-then-roll-off driver (as in scripts/sim-test.ts), on the predicted car: full
 * throttle along the centerline over the first jump; once landed, hold ~150 u/s (below the
 * take-off speed) and roll off the second ramp into its gap; after the recovery, sit still.
 */
class JumpFallScript {
  stage: "jump" | "slow" | "fall" | "done" = "jump";
  private flown = false;
  constructor(private readonly track: Track) {}
  done(): boolean {
    return this.stage === "done";
  }
  controls(c: CarState | null): Controls {
    if (!c) return NO_CONTROLS;
    if (c.air > 0) this.flown = true;
    if (this.stage === "jump" && this.flown && c.air === 0 && c.fall === 0) this.stage = "slow";
    if (this.stage === "slow" && c.fall > 0) this.stage = "fall";
    if (this.stage === "fall" && c.fall === 0) this.stage = "done";
    if (this.stage === "fall" || this.stage === "done") return NO_CONTROLS;
    const q = queryTrackNear(this.track, c.x, c.y, c.seg);
    const v = speedOf(c);
    const t = pointAt(this.track, q.s + 40 + v * 0.25);
    const steer = clamp(angleDiff(c.h, Math.atan2(t.y - c.y, t.x - c.x)) * 2.2, -1, 1);
    const throttle = this.stage === "jump" ? 1 : v < 140 ? 1 : v > 160 ? -1 : 0;
    return { throttle, steer, fire: false, mine: false };
  }
}

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
    level: BotLevel = "normal", // the driver's bot level (M4-HARD: botplay --level)
  ) {
    this.game = new Game(() => connectWs(url, sim), tokens);
    this.driver = new BotDriver(this.game, lateral, level);
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
      (!!me &&
        [...(g.latest?.cars.values() ?? [])].some((o) => o.id !== me.id && !o.ghost && !o.wreck && !o.air && !o.fall && capsuleGap(me, o) < 3));
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
  await runJumpFall(ctx, bots);
  await runOverpass(ctx, bots);
  await runChat(ctx, bots);
  await runMenu(ctx, bots);
  await runRetire(ctx, bots);
  await runPause(ctx, bots);
  await runSound(ctx, bots);
  await runMines(ctx, bots);
  await runCars(ctx, bots);
  await runRaceTick(ctx, bots);
  await runDraft(ctx, bots);
  await runCells(ctx, bots);
  await runHard(ctx, bots);
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
  // Track sanity: every shipped track passes the layout check and the run-up check, with no
  // upgrades and with max upgrades (faster take-offs, longer jumps). minSelfClearance no
  // longer applies: Overpass Knot crosses itself by design.
  const maxUp = statsFor("sport", { engine: 3, tyres: 3, welder: 3 });
  const shipped = trackList().filter((e) => e.id !== TEST_TRACK_ID && e.id !== JUMPS_TRACK_ID);
  const trackErrs = shipped.flatMap((e) => {
    const t = trackById(e.id);
    return [...validateTrack(t), ...validateRunUps(t, BASE_STATS), ...validateRunUps(t, maxUp)].map((m) => `${e.id}: ${m}`);
  });
  check(
    "tracks: every shipped track passes validateTrack and validateRunUps (no upgrades, max upgrades)",
    shipped.length >= 3 && trackErrs.length === 0,
    trackErrs.join("; ") || shipped.map((e) => e.id).join(", "),
  );

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
  // Mine cap 3 (2026-11-17): one pack fills it, so a second pack is refused over the socket.
  const em = A.errors.length;
  A.game.buy("mines");
  await waitFor("A second mine pack refused", () => A.errors.length > em, 3000);
  check(
    "garage: a second mine pack is refused at the cap of 3 (Already maxed out)",
    AMMO.mines.cap === AMMO.mines.pack && A.errors[em] === "Already maxed out" && A.game.scrap === 400 - AMMO_PRICE && A.game.serverAmmo[1] === 3,
    `${A.errors[em] ?? "no error"}, scrap ${A.game.scrap}, mines ${A.game.serverAmmo[1]}`,
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
  // Chat: the race's result line reaches everyone; the rejoined C and the mid-race joiner D
  // hold exactly the host's log (chatlog on every bind, then live lines).
  const resultText = resultLineFor(rows1);
  await waitFor("result line everywhere", () => [A, B, C, D].every((b) => b.game.chat.some((l) => l.kind === "result")), 3000);
  check(
    "chat: one result line per race reaches everyone; a rejoiner and a mid-race joiner hold the host's log",
    [A, B, C, D].every((b) => b.game.chat.filter((l) => l.kind === "result").map((l) => l.text).join() === resultText) &&
      [B, C, D].every((b) => chatKeys(b) === chatKeys(A)) &&
      A.game.chat.filter((l) => l.kind === "join").length === 4,
    `${resultText}; lines ${[A, B, C, D].map((b) => `${b.name} ${b.game.chat.length}`).join(", ")}`,
  );
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
  const comings = () => A.game.chat.filter((l) => l.kind === "join" || l.kind === "leave").length;
  const comingsBefore = comings();
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
  check(
    "chat: a takeover writes no join or leave line; the new tab gets the room's log",
    comings() === comingsBefore && chatKeys(E) === chatKeys(A),
    `${comings() - comingsBefore} new join/leave lines, Echo ${E.game.chat.length} lines, Alpha ${A.game.chat.length}`,
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

/**
 * Jumps and falls over a lagged link (M3-T1b): a solo bot at 80±10 ms runs the scripted jump
 * and roll-off fall on the jumps test track. Its prediction must match the server through
 * the take-off, the flight, the landing, the fall and the recovery: no predicted air/fall
 * state that the server did not have, and a max reconciliation error below
 * JUMP_FALL_ERR_MAX through each. A car-less observer (joined mid-race) sees the jumper's
 * height, fall and ghost in its poses, with no slide to the recovery point.
 */
async function runJumpFall(ctx: Ctx, bots: Bot[]): Promise<void> {
  const jumps = trackById(JUMPS_TRACK_ID);
  // A test straight: its features sit on the start straight on purpose (s = x), so that one
  // rule (startStraightEnd) is not asked of it; everything else is.
  const tErr = [...validateTrack(jumps).filter((m) => !m.includes("start straight")), ...validateRunUps(jumps)];
  check("jumps track: validates (track and run-ups; its features are on the start straight by design)", tErr.length === 0, tErr.join("; "));
  const J = new Bot("Juliett", ctx.url, 0, { lag: 80, jitter: 10 });
  const P = new Bot("Papa", ctx.url, 0);
  bots.push(J, P);
  for (const b of [J, P]) b.weapons = false;
  J.game.create(J.name);
  await waitFor("J welcome", () => !!J.game.you, 3000);
  J.game.pickTrack(JUMPS_TRACK_ID);
  await waitFor("J on the jumps track", () => J.game.trackId === JUMPS_TRACK_ID, 2000);
  const script = new JumpFallScript(J.game.track);
  J.script = () => script.controls(J.game.car);
  const errs = { jump: [] as number[], fall: [] as number[] };
  const seen = { serverAir: false, serverFall: false, serverGhost: false, ownHeight: false, ownFalling: false, ownGhost: false, obsHeight: false, obsFalling: false, obsGhost: false };
  let slide = 0;
  let errsSeen = 0;
  J.afterStep = () => {
    const g = J.game;
    for (; errsSeen < g.recErrors.length; errsSeen++) (script.stage === "jump" ? errs.jump : errs.fall).push(g.recErrors[errsSeen]);
    const s = g.ownSnap();
    if (s) {
      seen.serverAir ||= s.air > 0;
      seen.serverFall ||= s.fall > 0;
      seen.serverGhost ||= s.ghost && seen.serverFall;
    }
    const own = g.ownPose(1);
    seen.ownHeight ||= (own?.height ?? 0) > 0;
    seen.ownFalling ||= own?.falling !== undefined;
    seen.ownGhost ||= !!own?.ghost && seen.ownFalling;
    const obs = P.game.otherPoses().find((o) => o.id === g.you);
    if (obs) {
      seen.obsHeight ||= (obs.height ?? 0) > 0;
      seen.obsFalling ||= obs.falling !== undefined;
      seen.obsGhost ||= !!obs.ghost && seen.obsFalling;
      // Falling at the second ramp's end (~2100) or recovered at 1700, never in between.
      if ((script.stage === "fall" || script.stage === "done") && obs.x > 1750 && obs.x < 2050) slide++;
    }
  };
  try {
    J.game.start();
    await waitFor("jumps: racing", () => J.game.phase === "racing" && !!J.game.car, 6000);
    P.game.join(J.game.code, P.name);
    await waitFor("observer in", () => !!P.game.you && !!P.game.latest, 3000);
    await waitFor("jump, roll-off fall and recovery", () => script.done(), 40_000);
    await sleep(1500); // the server's recovery, ghost and the last acks arrive
    const all = J.game.recErrors;
    const sj = stats(errs.jump), sf = stats(errs.fall), sa = stats(all);
    const rec = pointAt(jumps, 1700);
    const car = J.game.ownSnap();
    console.log(
      `      Juliett  rec err: jump n=${sj.n} median=${sj.median.toFixed(3)} max=${sj.max.toFixed(3)}; ` +
        `roll-off fall n=${sf.n} median=${sf.median.toFixed(3)} max=${sf.max.toFixed(3)}; state mismatches ${J.game.recStateErrors}; rtt=${J.game.rtt.toFixed(1)}ms`,
    );
    check(
      "jumps: the lagged bot jumps, rolls off into the second gap and recovers at its recovery point",
      script.done() && seen.serverAir && seen.serverFall && seen.serverGhost && !!car && Math.hypot(car.x - rec.x, car.y - rec.y) < 1,
      `stage ${script.stage}, server car at x=${car?.x.toFixed(1)}`,
    );
    check(
      "jumps: strict prediction parity at 80±10 ms (no air/fall state mismatch at any acked step)",
      sa.n > 200 && J.game.recStateErrors === 0,
      `${J.game.recStateErrors} of ${sa.n} acked steps`,
    );
    check(
      `jumps: lagged bot max reconciliation error < ${JUMP_FALL_ERR_MAX} through the jump`,
      sj.n > 50 && sj.max < JUMP_FALL_ERR_MAX,
      `max ${sj.max.toFixed(3)} over ${sj.n} samples`,
    );
    check(
      `jumps: lagged bot max reconciliation error < ${JUMP_FALL_ERR_MAX} through the roll-off fall and recovery`,
      sf.n > 50 && sf.max < JUMP_FALL_ERR_MAX,
      `max ${sf.max.toFixed(3)} over ${sf.n} samples`,
    );
    check("jumps: own Pose has height in the air, falling while falling, ghost after the recovery", seen.ownHeight && seen.ownFalling && seen.ownGhost, JSON.stringify(seen));
    check(
      "jumps: an observer's Pose of the jumper has height, falling and ghost; no slide to the recovery point",
      seen.obsHeight && seen.obsFalling && seen.obsGhost && slide === 0,
      `${slide} drawn poses between the fall spot and the recovery point`,
    );
  } finally {
    J.script = null;
    J.afterStep = null;
    for (const b of [J, P]) b.game.leave();
  }
}

// Overpass Knot over sockets (M3-T4): measured 2026-11-17 (see the log line); bounds with room.
/** Reconciliation errors above this are "large" (about one tick of top-speed travel). */
const KNOT_LARGE_ERR = 7;
const KNOT_LARGE_MAX = 3; // large errors allowed for the lagged bot over the race
const KNOT_FALLS_MAX = 2; // falls allowed over the whole field

/**
 * A four-bot race on Overpass Knot over real sockets, one bot lagged (80±10 ms), no weapons:
 * every bot finishes, takes off over the crossing, stays on its own road (never snapped onto
 * the other pass), and few fall. In a multi-car race bumps are predicted only approximately,
 * so the lagged bot's large reconciliation errors are bounded by count, not by the max.
 */
async function runOverpass(ctx: Ctx, bots: Bot[]): Promise<void> {
  const KNOT_ID = "overpass-knot";
  const knot = trackById(KNOT_ID);
  const Q = new Bot("Quebec", ctx.url, -24);
  const R = new Bot("Romeo", ctx.url, 24, { lag: 80, jitter: 10 });
  const S = new Bot("Sierra", ctx.url, 0);
  const T = new Bot("Tango", ctx.url, 12);
  const field = [Q, R, S, T];
  bots.push(...field);
  for (const b of field) b.weapons = false;
  Q.game.create(Q.name);
  await waitFor("Q welcome", () => !!Q.game.you, 3000);
  for (const b of [R, S, T]) b.game.join(Q.game.code, b.name);
  await waitFor("4 in Q's room", () => field.every((b) => b.game.players.length === 4), 3000);
  Q.game.pickTrack(KNOT_ID);
  await waitFor("all on Overpass Knot", () => field.every((b) => b.game.trackId === KNOT_ID), 2000);
  check("knot: the host picks Overpass Knot; everyone's Game.track is it", field.every((b) => b.game.track === knot), field.map((b) => b.game.trackId).join(","));

  const name = (id: string) => Q.game.player(id)?.name ?? id;
  const flew = new Set<string>();
  const falls = new Map<string, number>();
  const wasFalling = new Map<string, boolean>();
  let samples = 0, offTrack = 0;
  Q.afterStep = () => {
    if (Q.game.phase !== "racing") return;
    for (const c of Q.game.latest?.cars.values() ?? []) {
      samples++;
      if (c.air > 0) flew.add(c.id);
      if (c.fall > 0 && !wasFalling.get(c.id)) falls.set(c.id, (falls.get(c.id) ?? 0) + 1);
      wasFalling.set(c.id, c.fall > 0);
      // Own section only (queryTrackNear around the car's segment): a car snapped onto the
      // other pass at the crossing would show up as far off its road.
      if (!c.fall && queryTrackNear(knot, c.x, c.y, c.seg).dist > knot.wall) offTrack++;
    }
  };
  const e0 = R.game.recErrors.length, st0 = R.game.recStateErrors;
  try {
    const rows = await runRace("knot", bots, Q, field);
    const nFalls = [...falls.values()].reduce((a, b) => a + b, 0);
    const s = stats(R.game.recErrors.slice(e0));
    const large = R.game.recErrors.slice(e0).filter((x) => x > KNOT_LARGE_ERR).length;
    console.log(
      `      knot: ${rows.map((r) => `${r.name} ${(r.timeMs / 1000).toFixed(2)}s`).join(", ")}; falls ${nFalls}; ` +
        `Romeo rec err n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)} large(>${KNOT_LARGE_ERR})=${large} ` +
        `state mismatches ${R.game.recStateErrors - st0}; rtt=${R.game.rtt.toFixed(1)}ms`,
    );
    check(
      "knot: every bot takes off over the crossing (server snapshots show it airborne)",
      field.every((b) => flew.has(b.game.you)),
      `airborne: ${[...flew].map(name).join(", ") || "-"}`,
    );
    check(`knot: at most ${KNOT_FALLS_MAX} falls over the field`, nFalls <= KNOT_FALLS_MAX, [...falls].map(([id, n]) => `${name(id)} ${n}`).join(", ") || "none");
    check("knot: every car stays on its own road (no snap onto the other pass)", samples > 500 && offTrack === 0, `${offTrack} of ${samples} samples off`);
    check(
      `knot: lagged bot median reconciliation error < 0.5 and at most ${KNOT_LARGE_MAX} errors > ${KNOT_LARGE_ERR} (count, not max)`,
      s.n > 500 && s.median < 0.5 && large <= KNOT_LARGE_MAX,
      `median ${s.median.toFixed(3)}, ${large} large of ${s.n}, max ${s.max.toFixed(2)}`,
    );
  } finally {
    Q.afterStep = null;
    for (const b of field) b.game.leave();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---- room chat (CHAT-1) ---------------------------------------------------------------

function chatKeys(b: Bot): string {
  return b.game.chat.map((l: ChatLine) => `${l.n}:${l.kind}:${l.name}:${l.text}`).join("|");
}

/** The result line the server writes for these rows (finishers only). */
function resultLineFor(rows: ResultRow[]): string {
  const fin = rows.filter((r) => r.timeMs > 0);
  const places = ["2nd", "3rd", "4th", "5th", "6th"];
  const tail = fin.slice(1).map((r, i) => `${places[i]} ${r.name}`).join(", ");
  return `Race won by ${fin[0]?.name}${tail ? ` — ${tail}` : ""}`;
}

/**
 * Room chat over real sockets: two bots (one lagged) chat both ways in the lobby and during a
 * race while they keep driving, a late joiner gets the whole log, and Leave removes a player
 * at once with one leave line. Bots never act on chat.
 */
async function runChat(ctx: Ctx, bots: Bot[]): Promise<void> {
  const P = new Bot("Papa", ctx.url, -20);
  const Q = new Bot("Quebec", ctx.url, 20, { lag: 60, jitter: 10 });
  const R = new Bot("Romeo", ctx.url, 0);
  bots.push(P, Q, R);
  try {
    for (const b of [P, Q]) b.weapons = false;
    P.game.create(P.name);
    await waitFor("P welcome", () => !!P.game.you, 3000);
    Q.game.join(P.game.code, Q.name);
    await waitFor("Q in P's room", () => P.game.players.length === 2 && !!Q.game.you, 3000);
    P.game.say("lobby hello from Papa");
    await waitFor("Q sees P's lobby line", () => Q.game.chat.some((l) => l.text === "lobby hello from Papa"), 3000);
    await readyUp("chat", P, [P, Q]);
    P.game.start();
    await waitFor("chat: racing", () => P.game.phase === "racing" && !!P.game.car && !!Q.game.car, 6000);
    await sleep(1500);
    const rd0 = [P, Q].map((b) => b.game.ownSnap()?.rd ?? 0);
    P.game.say("Papa: go go go");
    Q.game.say("Quebec: catch me if you can");
    const both = (b: Bot) => ["Papa: go go go", "Quebec: catch me if you can"].every((t) => b.game.chat.some((l) => l.kind === "say" && l.text === t));
    await waitFor("both race lines on both", () => both(P) && both(Q), 3000);
    await sleep(1000);
    const rd1 = [P, Q].map((b) => b.game.ownSnap()?.rd ?? 0);
    check(
      "chat over sockets: two clients chat both ways during a race (one lagged), and keep driving",
      P.game.phase === "racing" && both(P) && both(Q) && chatKeys(P) === chatKeys(Q) && rd1.every((d, i) => d > rd0[i] + 100) && P.errors.length + Q.errors.length === 0,
      `rd ${rd0.map((d) => d.toFixed(0)).join("/")} -> ${rd1.map((d) => d.toFixed(0)).join("/")}, errors ${[...P.errors, ...Q.errors].join("; ") || "-"}`,
    );

    // A late joiner (mid-race) receives the whole conversation, its own join line once.
    R.game.join(P.game.code, R.name);
    await waitFor("R welcome + log", () => !!R.game.you && R.game.chat.length > 0, 3000);
    await waitFor("P sees R join", () => P.game.chat.some((l) => l.kind === "join" && l.name === R.name), 2000);
    await sleep(200);
    check(
      "chat over sockets: a late joiner receives the full log, with its own join line once",
      chatKeys(R) === chatKeys(P) && R.game.chat.filter((l) => l.kind === "join" && l.name === R.name).length === 1 && R.game.chat.length >= 6,
      `${R.game.chat.length} lines: ${R.game.chat.map((l) => `${l.kind}:${l.text}`).join(" | ")}`,
    );

    // Leave: removed at once (not after the 20 s reconnect grace), one leave line for everyone.
    const rId = R.game.you;
    const t0 = performance.now();
    R.game.leave();
    await waitFor("R gone for P", () => !P.game.player(rId) && P.game.chat.some((l) => l.kind === "leave" && l.name === R.name), 2000);
    const took = performance.now() - t0;
    await sleep(300);
    check(
      "chat over sockets: Leave removes the player at once with one leave line; the leaver's list is cleared",
      !P.game.player(rId) && took < 1500 && P.game.chat.filter((l) => l.kind === "leave").length === 1 && R.game.chat.length === 0,
      `gone after ${took.toFixed(0)} ms, players ${P.game.players.length}`,
    );
  } finally {
    for (const b of [P, Q, R]) b.game.leave();
  }
}

// ---- in-game menu: host room controls (MENU-1, PLAN-MENU.md) ---------------------------

/**
 * Host room controls over real sockets. A kicked bot is told "kicked" and stops: no reconnect
 * attempts (an uncoded err plus the close would have resent its token 15 times), and typing the
 * code again with its kept token meets the block. A restart mid-race sends every car back to
 * the grid without a reconciliation jump for the lagged bot (the new raceStart drops the
 * predicted car), and a stop takes everyone back to the lobby.
 */
async function runMenu(ctx: Ctx, bots: Bot[]): Promise<void> {
  const S = new Bot("Sierra", ctx.url, -20);
  const T = new Bot("Tango", ctx.url, 20, { lag: 80, jitter: 10 });
  const U = new Bot("Uniform", ctx.url, 0);
  bots.push(S, T, U);
  for (const b of [S, T, U]) {
    b.weapons = false;
    watch(b);
  }
  try {
    S.game.create(S.name);
    await waitFor("S welcome", () => !!S.game.you, 3000);
    const code = S.game.code;
    T.game.join(code, T.name);
    U.game.join(code, U.name);
    await waitFor("T and U in S's room", () => S.game.players.length === 3 && !!T.game.you && !!U.game.you, 3000);

    // Kick: the kicked bot stops for good.
    const uId = U.game.you;
    const uToken = U.tokens.get(code);
    S.game.kick(uId);
    await waitFor("U told", () => lost.get(U.name)!.length > 0, 3000);
    await waitFor("S sees U removed", () => !S.game.player(uId) && S.game.chat.some((l) => l.kind === "removed" && l.name === U.name), 2000);
    await sleep(2500); // well past the 1 s reconnect delay: a rejoin loop would show
    const uLines = S.game.chat.filter((l) => l.name === U.name && (l.kind === "removed" || l.kind === "leave")).map((l) => l.kind);
    check(
      "menu over sockets: a kicked bot is told 'kicked' and stops (no reconnect attempts, token kept); one 'removed' line, no 'left'",
      lost.get(U.name)!.join() === "kicked" &&
        reconnecting.get(U.name)!.length === 0 &&
        !U.game.connected &&
        !!uToken && U.tokens.get(code) === uToken &&
        uLines.join() === "removed" &&
        S.game.players.length === 2 && T.game.players.length === 2,
      `lost ${lost.get(U.name)!.join() || "-"}, reconnecting ${reconnecting.get(U.name)!.length}, lines ${uLines.join() || "-"}, players ${S.game.players.length}`,
    );
    U.game.leave();
    U.game.join(code, U.name); // the kept token goes with it
    await waitFor("U refused again", () => lost.get(U.name)!.length > 1, 3000);
    await sleep(1500);
    check(
      "menu over sockets: the kicked bot typing the code again is refused ('kicked'), still no reconnect",
      lost.get(U.name)!.join() === "kicked,kicked" && reconnecting.get(U.name)!.length === 0 && S.game.players.length === 2,
      `lost ${lost.get(U.name)!.join()}`,
    );

    // Restart mid-race: back to the grid, no reconciliation jump for the lagged bot.
    await readyUp("menu", S, [S, T]);
    S.game.start();
    await waitFor("menu: racing", () => S.game.phase === "racing" && !!S.game.car && !!T.game.car, 6000);
    await sleep(3000);
    const far = T.game.ownSnap()?.rd ?? 0;
    const e0 = T.game.recErrors.length;
    const start0 = S.game.raceStart;
    S.game.restartRace();
    await waitFor("restart: countdown", () => [S, T].every((b) => b.game.phase === "countdown" && b.game.raceStart !== start0), 3000);
    const slots = [0, 1].map((i) => gridSlot(track, i));
    const onGrid = (b: Bot) => !!b.game.car && slots.some((g) => Math.hypot(b.game.car!.x - g.x, b.game.car!.y - g.y) < 1);
    await waitFor("restart: both on the grid", () => onGrid(S) && onGrid(T), 2000);
    const gridOk = onGrid(S) && onGrid(T);
    await waitFor("restart: racing again", () => [S, T].every((b) => b.game.phase === "racing"), 6000);
    await sleep(3000);
    const st = stats(T.game.recErrors.slice(e0));
    check(
      "menu over sockets: a restart mid-race puts both cars back on the grid; the lagged bot's reconciliation stays within the 50-unit bound (median < 0.5)",
      far > 300 && gridOk && st.n > 100 && st.max <= 50 && st.median < 0.5 && S.errors.length + T.errors.length === 0,
      `raced to rd ${far.toFixed(0)} first; after the restart n=${st.n} median ${st.median.toFixed(3)} max ${st.max.toFixed(2)}; errors ${[...S.errors, ...T.errors].join("; ") || "-"}`,
    );

    // Stop: everyone back in the lobby, no results.
    S.game.stopRace();
    await waitFor("stop: lobby", () => [S, T].every((b) => b.game.phase === "lobby"), 3000);
    await sleep(300);
    check(
      "menu over sockets: Stop takes everyone back to the lobby with no results and no cars",
      [S, T].every((b) => b.game.phase === "lobby" && b.results === null && !b.game.car) && S.errors.length + T.errors.length === 0,
      [S, T].map((b) => `${b.name} ${b.game.phase}`).join(", "),
    );
  } finally {
    for (const b of [S, T, U]) b.game.leave();
  }
}

// ---- in-game menu: retire to garage (MENU-2, PLAN-MENU.md) -----------------------------

/**
 * Retire over real sockets: a bot retires mid-race. Its car leaves everyone's snapshots and
 * never comes back to its own prediction, it buys in the garage during the race, the race ends
 * as soon as the two bots still racing have finished (no 30 s grace waiting on it), the
 * results show it as DNF, and it is on the grid again in the next race.
 */
async function runRetire(ctx: Ctx, bots: Bot[]): Promise<void> {
  const W = new Bot("Whiskey", ctx.url, -20);
  const X = new Bot("Xray", ctx.url, 20, { lag: 80, jitter: 10 });
  const Y = new Bot("Yankee", ctx.url, 0);
  bots.push(W, X, Y);
  for (const b of [W, X, Y]) b.weapons = false;
  try {
    W.game.create(W.name);
    await waitFor("W welcome", () => !!W.game.you, 3000);
    const code = W.game.code;
    X.game.join(code, X.name);
    Y.game.join(code, Y.name);
    await waitFor("X and Y in W's room", () => W.game.players.length === 3 && !!X.game.you && !!Y.game.you, 3000);
    await readyUp("retire", W, [W, X, Y]);
    W.game.start();
    await waitFor("retire: racing", () => [W, X, Y].every((b) => b.game.phase === "racing" && !!b.game.car), 6000);
    await sleep(2500);
    const yId = Y.game.you;
    const rd = Y.game.ownSnap()?.rd ?? 0;
    // From the room message that says we retired: no predicted car, and no own car in any
    // snapshot newer than that message (the one already in hand may still show it).
    let carBack = false;
    let snapBack = false;
    let retiredTick = -1;
    Y.afterStep = () => {
      if (retiredTick < 0 && Y.game.retired()) retiredTick = Y.game.snapTick;
      if (retiredTick < 0) return;
      if (Y.game.car) carBack = true;
      if (Y.game.snapTick > retiredTick && Y.game.ownSnap()) snapBack = true;
    };
    Y.game.retire();
    await waitFor("retire: everyone sees Y retired", () => [W, X, Y].every((b) => b.game.player(yId)?.retired === true), 3000);
    await sleep(600);
    const gone = [W, X].every((b) => !b.game.latest?.cars.has(yId));
    check(
      "retire over sockets: the bot's car leaves every snapshot at once and never returns to its own prediction; the others race on",
      rd > 100 && retiredTick >= 0 && Y.game.snapTick > retiredTick && !carBack && !snapBack && !Y.game.car && gone &&
        W.game.phase === "racing" && !!W.game.car && !!X.game.car && Y.errors.length === 0,
      `rd ${rd.toFixed(0)} at the retire; predicted car back ${carBack}, own car in a later snapshot ${snapBack}; errors ${Y.errors.join("; ") || "-"}`,
    );
    const scrap0 = Y.game.scrap;
    Y.game.buy("rivets");
    await waitFor("retire: garage", () => Y.game.scrap === scrap0 - AMMO.rivets.price, 3000);
    await sleep(200);
    check(
      "retire over sockets: the retired bot buys in the garage during the race",
      Y.game.scrap === scrap0 - AMMO.rivets.price && Y.game.serverAmmo[0] === AMMO.rivets.pack && Y.game.phase === "racing" && Y.errors.length === 0,
      `scrap ${scrap0} -> ${Y.game.scrap}, rivets ${Y.game.serverAmmo[0]}, errors ${Y.errors.join("; ") || "-"}`,
    );
    const finished = () => [W, X].every((b) => W.game.latest?.cars.get(b.game.you)?.fin);
    await waitFor("retire: W and X finish", finished, 150_000);
    const finishedAt = performance.now();
    await waitFor("retire: results", () => W.results !== null && Y.results !== null, 5000);
    const after = performance.now() - finishedAt;
    const rows = Y.results ?? [];
    check(
      "retire over sockets: the race ends when the bots still racing have finished (no grace wait on the retired bot); its results show it DNF",
      finished() && after < 3000 && rows.length === 3 && rows[2].id === yId && rows[2].timeMs === 0 && rows.slice(0, 2).every((r) => r.timeMs > 0),
      `results ${after.toFixed(0)} ms after the last finish: ${rows.map((r) => `${r.name} ${r.timeMs ? (r.timeMs / 1000).toFixed(2) : "DNF"}`).join(", ")}`,
    );
    await waitFor("retire: lobby", () => [W, X, Y].every((b) => b.game.phase === "lobby"), RESULTS_MS + 3000);
    const cleared = [W, X, Y].every((b) => b.game.player(yId)?.retired === false);
    Y.afterStep = null;
    await readyUp("retire 2", W, [W, X, Y]);
    W.game.start();
    await waitFor("retire 2: Y on the grid", () => W.game.phase === "countdown" && !!Y.game.car, 3000);
    check(
      "retire over sockets: back in the lobby the flag is clear, and the bot is on the grid for the next race",
      cleared && W.game.phase === "countdown" && !!Y.game.car && W.game.latest?.cars.has(yId) === true,
      `cleared ${cleared}, ${W.game.phase}, car ${!!Y.game.car}`,
    );
    W.game.stopRace();
    await waitFor("retire 2: stopped", () => [W, X, Y].every((b) => b.game.phase === "lobby"), 3000);
  } finally {
    for (const b of [W, X, Y]) b.game.leave();
  }
}

// ---- in-game menu: pause for everyone (MENU-3, PLAN-MENU.md) ----------------------------

/**
 * Pause over real sockets, with a lagged bot: the host pauses mid-race; every car stands still
 * in the lagged bot's snapshots (which keep coming), it predicts and sends nothing, and its race
 * clock stands. The resume's 3-2-1 plays out, raceStart moves on by the time paused, both cars
 * drive on, and the lagged bot's reconciliation after the resume stays within the usual 50-unit
 * bound (median < 0.5): each car waits on the server for its driver's first inputs.
 */
async function runPause(ctx: Ctx, bots: Bot[]): Promise<void> {
  const P = new Bot("Papa", ctx.url, -20);
  const Q = new Bot("Quebec", ctx.url, 20, { lag: 80, jitter: 10 });
  bots.push(P, Q);
  for (const b of [P, Q]) b.weapons = false;
  try {
    P.game.create(P.name);
    await waitFor("P welcome", () => !!P.game.you, 3000);
    Q.game.join(P.game.code, Q.name);
    await waitFor("Q in P's room", () => P.game.players.length === 2 && !!Q.game.you, 3000);
    await readyUp("pause", P, [P, Q]);
    P.game.start();
    await waitFor("pause: racing", () => [P, Q].every((b) => b.game.phase === "racing" && !!b.game.car), 6000);
    await sleep(3000);
    const start0 = P.game.raceStart;
    const rd0 = Q.game.ownSnap()?.rd ?? 0;
    const pausedAt = performance.now();
    P.game.pause();
    await waitFor("pause: both paused", () => [P, Q].every((b) => b.game.paused), 2000);
    await sleep(600); // the inputs in flight are consumed and acked
    const poses = () => JSON.stringify([...(Q.game.latest?.cars.values() ?? [])].map((c) => [c.id, c.x, c.y, c.h]));
    const at0 = { poses: poses(), tick: Q.game.snapTick, seq: Q.game.seq, clock: Q.game.raceNow() - Q.game.raceStart };
    await sleep(1500);
    const at1 = { poses: poses(), tick: Q.game.snapTick, seq: Q.game.seq, clock: Q.game.raceNow() - Q.game.raceStart };
    check(
      "pause over sockets: every car stands still in the lagged bot's snapshots (which keep coming); it sends nothing, has nothing pending and its race clock stands",
      at0.poses === at1.poses && at1.tick - at0.tick >= 60 && at1.seq === at0.seq && Q.game.pending.length === 0 && at0.clock === at1.clock &&
        !Q.game.raceOn() && Q.game.pausedBy === P.name && P.errors.length + Q.errors.length === 0,
      `${at1.tick - at0.tick} ticks of snapshots, seq ${at0.seq} -> ${at1.seq}, clock ${at0.clock.toFixed(0)} -> ${at1.clock.toFixed(0)}`,
    );
    let e0 = -1;
    Q.afterStep = () => {
      if (e0 < 0 && !Q.game.paused) e0 = Q.game.recErrors.length;
    };
    P.game.resume();
    await waitFor("resume: 3-2-1", () => Q.game.resumeAt > 0, 2000);
    const resumeIn = Q.game.resumeAt - Q.game.serverNow();
    await waitFor("resume: racing again", () => [P, Q].every((b) => !b.game.paused) && e0 >= 0, 6000);
    const pausedFor = performance.now() - pausedAt;
    const shift = P.game.raceStart - start0;
    await sleep(3000);
    Q.afterStep = null;
    const st = stats(Q.game.recErrors.slice(e0));
    const rd1 = Q.game.ownSnap()?.rd ?? 0;
    check(
      "pause over sockets: after the 3-2-1 raceStart has moved on by the time paused and the race goes on; the lagged bot's reconciliation after the resume stays within the 50-unit bound (median < 0.5)",
      resumeIn > 2500 && resumeIn <= 3100 && shift > 4000 && shift <= pausedFor + 50 && rd1 > rd0 + 300 && P.game.phase === "racing" &&
        st.n > 60 && st.max <= 50 && st.median < 0.5 && P.errors.length + Q.errors.length === 0,
      `3-2-1 of ${resumeIn.toFixed(0)} ms; shift ${shift.toFixed(0)} ms of ${pausedFor.toFixed(0)} paused; rd ${rd0.toFixed(0)} -> ${rd1.toFixed(0)}; after the resume n=${st.n} median ${st.median.toFixed(3)} max ${st.max.toFixed(2)}; errors ${[...P.errors, ...Q.errors].join("; ") || "-"}`,
    );
    P.game.stopRace();
    await waitFor("pause: stopped", () => [P, Q].every((b) => b.game.phase === "lobby"), 3000);
  } finally {
    for (const b of [P, Q]) b.game.leave();
  }
}

/**
 * Room sound over sockets (SND-4): the host's sound defaults and song reach the other clients
 * (one lagged) in the room message; a "random" song is picked by the server and every client
 * plays the same one; a guest's change is refused.
 */
async function runSound(ctx: Ctx, bots: Bot[]): Promise<void> {
  const H = new Bot("Hotel", ctx.url, -20);
  const G = new Bot("Golf", ctx.url, 20, { lag: 80, jitter: 10 });
  bots.push(H, G);
  for (const b of [H, G]) b.weapons = false;
  try {
    H.game.create(H.name);
    await waitFor("H welcome", () => !!H.game.you, 3000);
    G.game.join(H.game.code, G.name);
    await waitFor("G in H's room", () => H.game.players.length === 2 && !!G.game.you, 3000);
    const fresh = JSON.stringify(G.game.soundDefaults) === JSON.stringify(BUILTIN_SOUND) && G.game.song === DEFAULT_SONG_ID;
    H.game.setSoundDefaults({ musicOn: false, music: 0.33, effects: 0.6, song: "mirrorball" });
    const got = await waitFor("sound: G sees the host's defaults", () => G.game.soundDefaults.song === "mirrorball", 3000);
    check(
      "room sound over sockets: the host's defaults reach the lagged guest (music off, 0.33 snapped to 0.35, effects 0.6) with the song to play",
      fresh && got && !G.game.soundDefaults.musicOn && G.game.soundDefaults.music === 0.35 && G.game.soundDefaults.effects === 0.6 && G.game.song === "mirrorball" && H.errors.length + G.errors.length === 0,
      `${JSON.stringify(G.game.soundDefaults)} ${G.game.song}; errors ${[...H.errors, ...G.errors].join("; ") || "-"}`,
    );
    H.game.setSoundDefaults({ song: RANDOM_SONG });
    const picked = await waitFor("sound: random picked", () => G.game.soundDefaults.song === RANDOM_SONG && H.game.soundDefaults.song === RANDOM_SONG, 3000);
    check(
      "room sound over sockets: Random is picked by the server (not the song before) and both clients play the same song",
      picked && G.game.song === H.game.song && G.game.song !== "mirrorball" && (SONG_IDS as readonly string[]).includes(G.game.song),
      `H ${H.game.song}, G ${G.game.song}`,
    );
    const e0 = G.errors.length;
    G.game.setSoundDefaults({ music: 1 });
    await waitFor("sound: guest refused", () => G.errors.length > e0, 3000);
    check("room sound over sockets: a guest's change is refused with an err; the defaults stay", G.errors.slice(e0).join() === "Only the host can set the room sound" && H.game.soundDefaults.music === 0.35, G.errors.slice(e0).join());
    G.errors.length = e0;
  } finally {
    for (const b of [H, G]) b.game.leave();
  }
}

/**
 * The mines setting over sockets (MINES-1): the host's pick reaches the other client (lagged)
 * in the room message, a guest's is refused; a race keeps the mode it began with while the
 * host picks another; and a fading mine's `out` comes through the snapshots to both clients.
 */
async function runMines(ctx: Ctx, bots: Bot[]): Promise<void> {
  const H = new Bot("Hotel", ctx.url, -20);
  const G = new Bot("Golf", ctx.url, 20, { lag: 80, jitter: 10 });
  bots.push(H, G);
  for (const b of [H, G]) {
    b.weapons = false;
    b.script = () => NO_CONTROLS; // the cars wait on the grid
  }
  try {
    H.game.create(H.name);
    await waitFor("H welcome", () => !!H.game.you, 3000);
    G.game.join(H.game.code, G.name);
    await waitFor("G in H's room", () => H.game.players.length === 2 && !!G.game.you, 3000);
    const room = ctx.server.rooms.rooms.get(H.game.code)!;
    const mode = (b: Bot): string => b.game.mines; // read afresh each time
    const fresh = mode(H) === "stay" && mode(G) === "stay" && room.mines === "stay";
    H.game.setMines("fade");
    const got = await waitFor("mines: G sees Fade", () => mode(G) === "fade" && mode(H) === "fade", 3000);
    check(
      "mines over sockets: a new room has Stay; the host picks Fade and both clients (one lagged) see it",
      fresh && got && (room.mines as string) === "fade" && H.errors.length + G.errors.length === 0,
      `fresh ${fresh}; H ${mode(H)}, G ${mode(G)}, room ${room.mines}; errors ${[...H.errors, ...G.errors].join("; ") || "-"}`,
    );
    const e0 = G.errors.length;
    G.game.setMines("stay");
    await waitFor("mines: guest refused", () => G.errors.length > e0, 3000);
    check("mines over sockets: a guest's pick is refused with an err; the setting stays", G.errors.slice(e0).join() === "Only the host can set the mines" && (room.mines as string) === "fade" && mode(H) === "fade", G.errors.slice(e0).join());
    G.errors.length = e0;

    // A race begun in Fade; the host picks Stay while it runs: the clients see Stay, the race stays Fade.
    await readyUp("mines", H, [H, G]);
    H.game.start();
    await waitFor("mines: racing", () => H.game.phase === "racing" && G.game.phase === "racing" && !!G.game.latest?.cars.size, 6000);
    H.game.setMines("stay");
    const back = await waitFor("mines: G sees Stay", () => mode(G) === "stay" && mode(H) === "stay", 3000);
    check("mines over sockets: Stay picked mid-race reaches the clients; the race under way keeps Fade", back && (room.mines as string) === "stay" && room.combat.mode === "fade" && room.phase === "racing", `clients ${mode(H)},${mode(G)}; room ${room.mines}; race ${room.combat.mode}`);
    // A mine 1.5 s from the end of its life, far ahead of the grid: its out comes through.
    const at = pointAt(room.track, 900);
    const left = 90;
    room.combat.mines.push({ id: 9001, owner: H.game.you, x: at.x, y: at.y, age: MINE_LIFE_TICKS - left });
    const outs = new Map<Bot, number[]>([[H, []], [G, []]]);
    const seen = new Map<Bot, boolean>([[H, false], [G, false]]);
    for (const b of [H, G]) {
      b.afterStep = () => {
        const m = b.game.latest?.mines.find((x) => x.id === 9001);
        if (!m) return;
        seen.set(b, true);
        const list = outs.get(b)!;
        if (m.out !== undefined && list[list.length - 1] !== m.out) list.push(m.out);
      };
    }
    const gone = await waitFor("mines: the fading mine is gone", () => [H, G].every((b) => seen.get(b) && !b.game.latest?.mines.some((x) => x.id === 9001)), 5000);
    for (const b of [H, G]) b.afterStep = null;
    const ok = (list: number[]) => list.length >= 20 && list[0] <= left && list[0] <= MINE_FADE_TICKS && list[list.length - 1] <= 4 && list.every((o, i) => o >= 1 && (i === 0 || o < list[i - 1]));
    check(
      "mines over sockets: a fading mine's out (ticks left) comes through the snapshots to both clients, counting down, then the mine is gone",
      gone && ok(outs.get(H)!) && ok(outs.get(G)!) && room.combat.mines.length === 0,
      [H, G].map((b) => `${b.name}: ${outs.get(b)!.length} values ${outs.get(b)![0]}..${outs.get(b)![outs.get(b)!.length - 1]}`).join("; "),
    );
    H.game.stopRace();
    await waitFor("mines: back in the lobby", () => H.game.phase === "lobby" && G.game.phase === "lobby", 3000);
    check("mines over sockets: no errors on the way", H.errors.length + G.errors.length === 0, [...H.errors, ...G.errors].join("; ") || "-");
  } finally {
    for (const b of [H, G]) b.game.leave();
  }
}

// ---- car types (M4-CARS, PLAN-M4.md 2.1, ClickUp 123jpnbffdz, 2026-11-20) ----------------

// This section's imports (hoisted like the ones at the top).
import { CAR_TYPES, carName, type CarType } from "../shared/cars";

/**
 * A socket bot of each car type (Sport host, Racer, Truck), every one lagged (80±10 ms), weapons
 * off, one lap of Rust Bowl: each picks its car in the lobby, the others see it, the client's
 * prediction stats are exactly the server's (garage.car), and each keeps a median
 * reconciliation error below 0.5 (no teleports: max <= 50).
 */
async function runCars(ctx: Ctx, bots: Bot[]): Promise<void> {
  const field = CAR_TYPES.map((t, i) => new Bot(["Zulu", "Victor", "Whiskey"][i], ctx.url, [-24, 0, 24][i], { lag: 80, jitter: 10 }));
  const typeOf = new Map<Bot, CarType>(field.map((b, i) => [b, CAR_TYPES[i]]));
  bots.push(...field);
  for (const b of field) b.weapons = false;
  const [H] = field;
  try {
    H.game.create(H.name);
    await waitFor("cars: H welcome", () => !!H.game.you, 3000);
    for (const b of field.slice(1)) b.game.join(H.game.code, b.name);
    await waitFor("cars: 3 in H's room", () => field.every((b) => b.game.players.length === 3), 3000);
    for (const b of field) b.game.pickCar(typeOf.get(b)!);
    const picked = await waitFor(
      "cars: every pick confirmed",
      () => field.every((b) => b.game.carType === typeOf.get(b) && field.every((o) => o.game.carOf(b.game.you) === typeOf.get(b))),
      3000,
    );
    check(
      "cars over sockets: each driver picks a car in the lobby (one per type); their garage and everyone's room message carry it",
      picked && field.every((b) => b.errors.length === 0),
      field.map((b) => `${b.name} ${b.game.carType} (seen by host as ${H.game.carOf(b.game.you)})`).join(", "),
    );
    const room = ctx.server.rooms.rooms.get(H.game.code)!;
    const e0 = new Map(field.map((b) => [b, b.game.recErrors.length]));
    const st0 = new Map(field.map((b) => [b, b.game.recStateErrors]));
    let statsSame: boolean | null = null;
    H.afterStep = () => {
      if (statsSame !== null || H.game.phase !== "racing") return;
      statsSame = field.every((b) => {
        const p = room.players.get(b.game.you)!;
        return p.carType === typeOf.get(b) && JSON.stringify(p.stats) === JSON.stringify(b.game.stats) && JSON.stringify(b.game.stats) === JSON.stringify(statsFor(typeOf.get(b)!, b.game.levels));
      });
    };
    const rows = await runRace("cars", bots, H, field);
    H.afterStep = null;
    check("cars over sockets: in the race the server's stats are the client's, statsFor(car, levels), for every type", statsSame === true, String(statsSame));
    console.log(`      cars: ${rows.map((r) => `${r.name} (${carName(H.game.carOf(r.id))}) ${(r.timeMs / 1000).toFixed(2)}s`).join(", ")}`);
    for (const b of field) {
      const s = stats(b.game.recErrors.slice(e0.get(b)!));
      console.log(
        `      ${b.name.padEnd(8)} ${typeOf.get(b)!.padEnd(5)} rec err n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)}; ` +
          `state mismatches ${b.game.recStateErrors - st0.get(b)!}; rtt=${b.game.rtt.toFixed(1)}ms`,
      );
      check(
        `cars over sockets: lagged ${carName(typeOf.get(b)!)} bot: median reconciliation error < 0.5, no error > 50`,
        s.n > 500 && s.median < 0.5 && s.max <= 50,
        `median ${s.median.toFixed(3)}, max ${s.max.toFixed(2)} over ${s.n}`,
      );
    }
  } finally {
    H.afterStep = null;
    for (const b of field) b.game.leave();
  }
}

// ---- race tick (M4-ENV, PLAN-M4.md 3 and advisor change 9, ClickUp 123jpnbffe0, 2026-11-20) ----

/** Sorted |values|: median, p95 and max of the absolute values. */
function absStats(xs: number[]): { n: number; median: number; p95: number; max: number; exact: number } {
  const a = xs.map(Math.abs).sort((x, y) => x - y);
  if (!a.length) return { n: 0, median: NaN, p95: NaN, max: NaN, exact: NaN };
  return { n: a.length, median: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1], exact: a.filter((x) => x === 0).length / a.length };
}

/**
 * The client's race-tick skew over a lagged link (80±10 ms): the server notes the race tick it
 * applied each of the lagged bot's inputs at (from its own tick; inputs thrown away while paused
 * are left out), the client logs the race tick it predicted each one at (live, and after its last
 * replay). Through the countdown and GO (the clamp), a forced underrun (the bot sends nothing for
 * 30 steps: the server repeats, coasts and rebuffers to QUEUE_START) and a pause with its resume
 * (the resume hold), the skew stays bounded and the prediction is exact most of the time.
 * The rule (PLAN-M4 3): step i after a snapshot runs at rt + i + 1. Right after a gap in the
 * inputs (the underrun, the resume) nothing is pending, so the live prediction runs about one
 * round trip of ticks early (~5-8 at 80 ms) until the next snapshot's replay corrects it.
 */
async function runRaceTick(ctx: Ctx, bots: Bot[]): Promise<void> {
  const H = new Bot("Hotel", ctx.url, -20);
  const L = new Bot("Lima", ctx.url, 20, { lag: 80, jitter: 10 });
  bots.push(H, L);
  for (const b of [H, L]) b.weapons = false;
  let stall = 0;
  const step = L.step.bind(L);
  L.step = () => {
    if (stall > 0) stall--; // no game.step: nothing predicted, nothing sent
    else step();
  };
  const truth = new Map<number, number>();
  let room: ReturnType<typeof ctx.server.rooms.rooms.get> | undefined;
  let tick: ((t: number, now: number) => void) | null = null;
  try {
    H.game.create(H.name);
    await waitFor("rt: H welcome", () => !!H.game.you, 3000);
    L.game.join(H.game.code, L.name);
    await waitFor("rt: L in H's room", () => H.game.players.length === 2 && !!L.game.you, 3000);
    room = ctx.server.rooms.rooms.get(H.game.code)!;
    const r = room;
    tick = r.tick.bind(r);
    let last = -1;
    r.tick = (t: number, now: number) => {
      tick!(t, now);
      const p = r.players.get(L.game.you);
      if (p && p.car && p.ack !== last) {
        last = p.ack;
        if (!r.paused) truth.set(p.ack, r.rt);
      }
    };
    await readyUp("rt", H, [H, L]);
    const log0 = L.game.rtLog.length;
    H.game.start();
    await waitFor("rt: racing", () => [H, L].every((b) => b.game.phase === "racing" && !!b.game.car), 6000);
    await sleep(2500);
    stall = 30;
    await sleep(2500);
    H.game.pause();
    await waitFor("rt: paused", () => L.game.paused, 2000);
    await sleep(800);
    H.game.resume();
    await waitFor("rt: racing again", () => [H, L].every((b) => !b.game.paused), 6000);
    await sleep(2500);
    const log = L.game.rtLog.slice(log0).filter(([seq]) => truth.has(seq));
    const live = absStats(log.map(([seq, rt0]) => rt0 - truth.get(seq)!));
    const fin = absStats(log.map(([seq, , rt]) => rt - truth.get(seq)!));
    const countdown = log.filter(([seq]) => truth.get(seq) === 0).length;
    console.log(
      `      Lima rt skew (predicted - server, ticks) over ${log.length} applied inputs (${countdown} in the countdown, rt up to ${Math.max(...log.map(([seq]) => truth.get(seq)!))}): ` +
        `live median ${live.median} p95 ${live.p95} max ${live.max} (exact ${(100 * live.exact).toFixed(1)}%); ` +
        `after replays median ${fin.median} p95 ${fin.p95} max ${fin.max} (exact ${(100 * fin.exact).toFixed(1)}%); rtt=${L.game.rtt.toFixed(1)}ms`,
    );
    check(
      "race tick over sockets: the lagged bot (80±10 ms) predicts the race tick of its inputs through the countdown, GO, an underrun and a pause/resume: after replays exact for >= 95% (max 3); live exact for >= 90% (max 10, a round trip after a gap)",
      log.length > 400 && countdown > 20 && fin.exact >= 0.95 && fin.max <= 3 && live.exact >= 0.9 && live.max <= 10 && H.errors.length + L.errors.length === 0,
      `live median ${live.median} p95 ${live.p95} max ${live.max}; after replays exact ${(100 * fin.exact).toFixed(1)}%, max ${fin.max}`,
    );
    H.game.stopRace();
    await waitFor("rt: stopped", () => [H, L].every((b) => b.game.phase === "lobby"), 3000);
  } finally {
    if (room && tick) room.tick = tick;
    for (const b of [H, L]) b.game.leave();
  }
}

// ---- slipstream (M4-DRAFT, PLAN-M4.md 2.8 and section 3, ClickUp 123jpnbfffj, 2026-11-20) ----

/**
 * The own car's slipstream over a lagged socket (80±10 ms): a lagged socket bot (the Normal
 * driver: it tucks in behind the car ahead and passes) hosts a room with one Easy server bot,
 * waits 4 s on the line so the bot gets ahead, then catches it. The server notes the draft it
 * stepped each of the lagged bot's inputs with; the client logs the draft it predicted (live and
 * after its last replay, from the other car's predicted pose at k-1). PLAN-M4 section 3: the
 * error is small and continuous.
 */
async function runDraft(ctx: Ctx, bots: Bot[]): Promise<void> {
  const D = new Bot("Delta", ctx.url, 0, { lag: 80, jitter: 10 });
  bots.push(D);
  D.weapons = false;
  let racing = 0;
  D.script = () => {
    const c = D.driver.controls();
    if (D.game.phase === "racing") racing++;
    return racing < 240 ? { ...c, throttle: 0 } : c;
  };
  const truth = new Map<number, number>();
  let room: ReturnType<typeof ctx.server.rooms.rooms.get> | undefined;
  let tick: ((t: number, now: number) => void) | null = null;
  try {
    D.game.create(D.name);
    await waitFor("draft: D welcome", () => !!D.game.you, 3000);
    D.game.addBot("easy");
    await waitFor("draft: the bot is in", () => D.game.players.length === 2, 3000);
    room = ctx.server.rooms.rooms.get(D.game.code)!;
    const r = room;
    tick = r.tick.bind(r);
    let last = -1;
    const drafts = (r as unknown as { drafts: number[] }).drafts;
    r.tick = (t: number, now: number) => {
      tick!(t, now);
      const p = r.players.get(D.game.you);
      if (p && p.car && p.ack !== last && r.phase === "racing" && !r.paused) {
        last = p.ack;
        truth.set(p.ack, drafts[[...r.players.values()].filter((q) => q.car).indexOf(p)]);
      }
    };
    const e0 = D.game.recErrors.length, st0 = D.game.recStateErrors, log0 = D.game.draftLog.length;
    D.game.start();
    await waitFor("draft: racing", () => D.game.phase === "racing" && !!D.game.car, 6000);
    await waitFor("draft: the race is over", () => D.game.phase === "results" || D.game.phase === "lobby", 75000);
    const log = D.game.draftLog.slice(log0).filter(([seq]) => truth.has(seq));
    const drafted = log.filter(([seq]) => truth.get(seq)! > 0).length;
    const rep = log.map(([seq, , rp]) => Math.abs(rp - truth.get(seq)!));
    const live = log.map(([seq, lv]) => Math.abs(lv - truth.get(seq)!));
    const close = rep.filter((x) => x <= 0.05).length / Math.max(1, rep.length);
    const s = stats(D.game.recErrors.slice(e0));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    console.log(
      `      Delta (80±10 ms): ${log.length} inputs, ${drafted} with a draft (server); |predicted - server| after replay mean ${mean(rep).toFixed(4)} max ${Math.max(0, ...rep).toFixed(3)}, ` +
        `live mean ${mean(live).toFixed(4)} max ${Math.max(0, ...live).toFixed(3)}; rec err median ${s.median.toFixed(3)} p95 ${s.p95.toFixed(3)} max ${s.max.toFixed(2)}; state mismatches ${D.game.recStateErrors - st0}; rtt=${D.game.rtt.toFixed(1)}ms`,
    );
    check(
      "draft over sockets: a lagged bot (80±10 ms) drafting an Easy server bot predicts its own draft (after its replay within 0.05 of the server's for >= 90% of its inputs) and keeps a median reconciliation error below 0.5, no error > 50",
      drafted > 50 && close >= 0.9 && s.n > 500 && s.median < 0.5 && s.max <= 50 && D.errors.length === 0,
      `${drafted} drafted inputs; within 0.05: ${(100 * close).toFixed(1)}%; median ${s.median.toFixed(3)}, p95 ${s.p95.toFixed(3)}, max ${s.max.toFixed(2)}`,
    );
  } finally {
    if (room && tick) room.tick = tick;
    D.script = null;
    D.game.leave();
  }
}

// ---- lightning cells (M4-CELLS, PLAN-M4.md 2.5, ClickUp 123jpnbfffk, 2026-11-20) -----------------

/**
 * Cells over a lagged socket (80±10 ms): a lagged socket bot on lane -36 (within 30 of Rust Bowl's
 * -58 kerb cells: the Normal driver goes for them) races one lap against an unlagged one on lane
 * 24. The server notes every boost it gives the lagged bot (a cell taken); the client predicts its
 * own pickups. The lagged-bot bounds still hold: median reconciliation error < 0.5, no error > 50,
 * and at most a few boost state mismatches (a pickup predicted a tick off).
 */
async function runCells(ctx: Ctx, bots: Bot[]): Promise<void> {
  const H = new Bot("Hotel2", ctx.url, 24);
  const K = new Bot("Kilo", ctx.url, -36, { lag: 80, jitter: 10 });
  bots.push(H, K);
  for (const b of [H, K]) b.weapons = false;
  let room: ReturnType<typeof ctx.server.rooms.rooms.get> | undefined;
  let tick: ((t: number, now: number) => void) | null = null;
  try {
    H.game.create(H.name);
    await waitFor("cells: H welcome", () => !!H.game.you, 3000);
    K.game.join(H.game.code, K.name);
    await waitFor("cells: K in H's room", () => H.game.players.length === 2 && !!K.game.you, 3000);
    room = ctx.server.rooms.rooms.get(H.game.code)!;
    const r = room;
    tick = r.tick.bind(r);
    let taken = 0, last = 0, predicted = 0, lastPred = 0;
    r.tick = (t: number, now: number) => {
      tick!(t, now);
      const b = r.players.get(K.game.you)?.car?.boost ?? 0;
      if (b > last) taken++;
      last = b;
    };
    K.afterStep = () => {
      const b = K.game.car?.boost ?? 0;
      if (b > lastPred) predicted++;
      lastPred = b;
    };
    const e0 = K.game.recErrors.length, st0 = K.game.recStateErrors;
    const rows = await runRace("cells", bots, H, [H, K]);
    const s = stats(K.game.recErrors.slice(e0));
    const st = K.game.recStateErrors - st0;
    console.log(
      `      Kilo (80±10 ms, lane -36): cells taken (server) ${taken}, pickups predicted ${predicted}; rec err n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)}; ` +
        `state mismatches ${st}; finish ${rows.map((x) => `${x.name} ${(x.timeMs / 1000).toFixed(2)}s`).join(", ")}`,
    );
    check(
      "cells over sockets: a lagged bot (80±10 ms) takes the kerb cells on its lane, predicts its own pickups, and keeps a median reconciliation error below 0.5, no error > 50, at most 4 state mismatches",
      taken >= 1 && predicted >= taken && s.n > 500 && s.median < 0.5 && s.max <= 50 && st <= 4 && H.errors.length + K.errors.length === 0,
      `taken ${taken}, predicted ${predicted}; median ${s.median.toFixed(3)}, max ${s.max.toFixed(2)}; state mismatches ${st}`,
    );
  } finally {
    if (room && tick) room.tick = tick;
    K.afterStep = null;
    for (const b of [H, K]) b.game.leave();
  }
}

// ---- Hard bot level (M4-HARD, PLAN-M4.md addendum 2026-11-21, ClickUp 123jpnbffqh) ----------------

// This section's imports (hoisted like the ones at the top).
import type { BotLevel, BotMem } from "../shared/botdrive";
import { botShopping } from "../shared/botshop";

/**
 * A lagged (80±10 ms) Hard socket bot (BotDriver level "hard", shopping by the Hard rule as
 * `npm run botplay -- CODE 3 --level hard` does) hosts a room with two Normal server bots: two
 * races of one lap of Crusher Run (ramps, gaps, holes) with weapons, shopping before each. Each
 * race: all finish, its prediction holds (median reconciliation error below 0.5, no error > 50, at
 * most 4 air/fall state mismatches). Race 2 (review 2026-11-21: the driver kept race 1's last-mine
 * step, so its mine gap held every mine back after race 1): its mine gate is clear as the race
 * starts. Race 1 always ends with a last-mine step (a real one, else one set at its last step, as a
 * mine there would), so the check never passes by default. Whether it drops a mine depends on a
 * car following it on its line in that real-time race: printed with the steps that had one (the
 * deterministic proof that Hard mines race after race is sim-test "hard client"). It races on
 * Lugnut's lane (24), where a Normal bot can follow it on its line.
 */
async function runHard(ctx: Ctx, bots: Bot[]): Promise<void> {
  const H = new Bot("Hotel", ctx.url, 24, { lag: 80, jitter: 10 }, undefined, "hard");
  bots.push(H);
  let race = 0;
  const presses = [0, 0], dropped = [0, 0];
  const mem = (H.driver as unknown as { mem: BotMem }).mem; // the driver's own memory (private)
  const gateAtGo = [NaN, NaN], lastAtEnd = [NaN, NaN], steps = [0, 0], followed = [0, 0], inWindow = [0, 0];
  let wasRacing = false, ends = 0;
  H.script = () => {
    const g = H.game, racing = g.phase === "racing";
    if (racing && Number.isNaN(gateAtGo[race])) gateAtGo[race] = mem.lastMine;
    if (racing) {
      steps[race]++;
      // Diagnostic, as its view shows them: a car on its line (within 14 across its heading) 300 or
      // less behind it, and one of those in the mine gate's window (0.4 x its speed + 10 behind or more).
      const c = g.car;
      let on = false, win = false;
      if (c) {
        const ux = Math.cos(c.h), uy = Math.sin(c.h);
        for (const o of g.otherPoses()) {
          const dx = o.x - c.x, dy = o.y - c.y, a = dx * ux + dy * uy;
          if (!(a < 0 && a > -300 && Math.abs(-dx * uy + dy * ux) <= 14)) continue;
          on = true;
          const sn = g.latest?.cars.get(o.id), vf = sn ? sn.vx * ux + sn.vy * uy : 0;
          if (vf >= 100 && -a >= 0.4 * vf + 10) win = true;
        }
      }
      if (on) followed[race]++;
      if (win) inWindow[race]++;
    }
    // Race 1 just over (results, the car still there): no mine dropped -> as if one was, at its last step.
    if (wasRacing && !racing && ++ends === 1) {
      if (mem.lastMine === -Infinity) mem.lastMine = steps[0];
      lastAtEnd[0] = mem.lastMine;
    }
    wasRacing = racing;
    const c = H.driver.controls();
    if (c.mine && racing) presses[race]++;
    return c;
  };
  let room: ReturnType<typeof ctx.server.rooms.rooms.get> | undefined;
  let tick: ((t: number, now: number) => void) | null = null;
  try {
    H.game.create(H.name);
    await waitFor("hard: H welcome", () => !!H.game.you && H.game.scrap > 0, 3000);
    H.game.pickTrack("crusher-run");
    H.game.addBot("normal");
    H.game.addBot("normal");
    await waitFor("hard: two Normal bots in", () => H.game.players.filter((p) => p.bot === "normal").length === 2 && H.game.trackId === "crusher-run", 3000);
    room = ctx.server.rooms.rooms.get(H.game.code)!;
    const r = room;
    tick = r.tick.bind(r);
    let mines = -1;
    r.tick = (t: number, now: number) => {
      tick!(t, now);
      const m = r.players.get(H.game.you)?.wallet.ammo.mines ?? 0;
      if (r.phase === "racing" && mines > m) dropped[race] += mines - m;
      mines = m;
    };
    for (race = 0; race < 2; race++) {
      if (race > 0) await waitFor("hard: back in the lobby", () => H.game.phase === "lobby", 15000);
      const wallet = { scrap: H.game.scrap, levels: { ...H.game.levels }, ammo: { rivets: H.game.serverAmmo[0], mines: H.game.serverAmmo[1] } };
      const buys = botShopping(wallet, "hard");
      const scrap0 = H.game.scrap;
      for (const item of buys) H.game.buy(item);
      await waitFor("hard: H shopped", () => !buys.length || H.game.scrap < scrap0, 3000);
      const hits = H.events.length;
      const e0 = H.game.recErrors.length, st0 = H.game.recStateErrors;
      H.results = null;
      H.game.start();
      await waitFor("hard: racing", () => H.game.phase === "racing" && !!H.game.car, 6000);
      await waitFor("hard: the race is over", () => H.results !== null, 90000);
      const evs = H.events.slice(hits);
      const mine = (e: GameEvent, w: string) => e.k === "hit" && e.w === w && e.by === H.game.you;
      const rivetHits = evs.filter((e) => mine(e, "rivet")).length, mineHits = evs.filter((e) => mine(e, "mine")).length;
      const rows: ResultRow[] = (H.results as ResultRow[] | null) ?? []; // set by the results message (not narrowed)
      const s = stats(H.game.recErrors.slice(e0));
      const st = H.game.recStateErrors - st0;
      console.log(
        `      Hotel race ${race + 1} (Hard, 80±10 ms, bought ${buys.join("+") || "nothing"}): finish ${rows.map((x) => `${x.name} ${(x.timeMs / 1000).toFixed(2)}s`).join(", ")}; ` +
          `its mine presses ${presses[race]}, mines dropped ${dropped[race]} (of its ${steps[race]} steps: a car on its line within 300 behind on ${followed[race]}, in the mine window on ${inWindow[race]}); its rivet hits ${rivetHits}, mine hits ${mineHits}; ` +
          `rec err n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)}; state mismatches ${st}; rtt=${H.game.rtt.toFixed(1)}ms`,
      );
      check(
        `hard over sockets, race ${race + 1}: a lagged Hard socket bot (botplay's driver at --level hard) races two Normal server bots on Crusher Run: all three finish, it keeps a median reconciliation error below 0.5, no error > 50, at most 4 state mismatches`,
        rows.length === 3 && rows.every((x) => x.timeMs > 0) && s.n > 500 && s.median < 0.5 && s.max <= 50 && st <= 4 && H.errors.length === 0,
        `median ${s.median.toFixed(3)}, max ${s.max.toFixed(2)}, state mismatches ${st}; errors ${H.errors.join("; ") || "none"}`,
      );
      if (race === 0) check("hard over sockets: the Hard socket bot uses its weapons (its rivets hit someone)", rivetHits > 0, `${rivetHits} rivet hits, ${mineHits} mine hits`);
    }
    check(
      "hard over sockets: the Hard socket bot's mine gate is clear as race 2 starts: race 1 ended with a last-mine step, and its driver starts it over between races (as its race steps)",
      Number.isFinite(lastAtEnd[0]) && gateAtGo[0] === -Infinity && gateAtGo[1] === -Infinity,
      `last-mine step at the end of race 1 ${lastAtEnd[0]}, at GO of race 1 ${gateAtGo[0]}, of race 2 ${gateAtGo[1]}; mines dropped race 1 ${dropped[0]}, race 2 ${dropped[1]} (presses ${presses.join("/")})`,
    );
  } finally {
    if (room && tick) room.tick = tick;
    H.script = null;
    H.game.leave();
  }
}
