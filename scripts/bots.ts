// Headless end-to-end test: starts the real server in-process and drives bots that use
// the real client netcode (client/game.ts + client/net.ts over Node's WebSocket).
// Two races in a row with weapons, the garage and a reverse grid. Run: npm run bots

import { Game, track, type TokenStore } from "../client/game";
import { connectWs, type LagSim } from "../client/net";
import { CODE_ALPHABET, CODE_LENGTH, RESULTS_MS, type GameEvent, type Phase, type ResultRow } from "../shared/protocol";
import { PLACE_PAYOUT, WRECK_BONUS } from "../shared/shop";
import { minSelfClearance } from "../shared/track";
import { startServer } from "../server/index";
import { BotDriver } from "./bot-ai";

const STEP_MS = 1000 / 60;
const LAPS = 1;
const BOT_HP = 24; // low HP so wrecks really happen in a one-lap race (3 rivets or 1 mine)

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
  readonly errors: string[] = [];
  results: ResultRow[] | null = null;
  phases: Phase[] = [];
  welcomes = 0;
  garages = 0;

  constructor(
    readonly name: string,
    url: string,
    lateral: number,
    sim?: LagSim,
  ) {
    this.game = new Game(() => connectWs(url, sim), memoryTokens());
    this.driver = new BotDriver(this.game, lateral);
    this.game.on.welcome = () => this.welcomes++;
    this.game.on.garage = () => this.garages++;
    this.game.on.event = (ev) => this.events.push(ev);
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
    this.game.step(this.driver.controls(), STEP_MS);
  }
}

// ---- test ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = await startServer({ port: 0, vite: false, laps: LAPS, host: "127.0.0.1", hp: BOT_HP });
  const url = `ws://127.0.0.1:${server.port}/ws`;
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
    await run(url, bots);
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

async function runRace(label: string, bots: Bot[], host: Bot, racers: Bot[]): Promise<ResultRow[]> {
  const evFrom = host.events.length;
  for (const b of bots) b.results = null;
  host.game.start();
  await waitFor(`${label}: countdown`, () => host.game.phase === "countdown", 2000);
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

async function run(url: string, bots: Bot[]): Promise<void> {
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

  // Garage: starting kit, a purchase, a refusal.
  await waitFor("garage + ammo", () => [A, B, C].every((b) => b.garages > 0 && b.game.serverAmmo[0] > 0), 3000);
  check(
    "garage: starting kit (400 scrap, 40 rivets, 3 mines)",
    [A, B, C].every((b) => b.game.scrap === 400 && b.game.serverAmmo[0] === 40 && b.game.serverAmmo[1] === 3),
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

  // Spend winnings on rivets so race 2 has shooting too.
  for (const b of [A, B, C]) if (b.game.scrap >= 150) b.game.buy("rivets");
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
