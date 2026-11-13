// Headless end-to-end test: starts the real server in-process and drives bots that use
// the real client netcode (client/game.ts + client/net.ts over Node's WebSocket).
// Run: npm run bots

import { Game, track, type TokenStore } from "../client/game";
import { connectWs, type LagSim } from "../client/net";
import { angleDiff, clamp, NO_INPUT, speedOf, type Input } from "../shared/physics";
import { CODE_ALPHABET, CODE_LENGTH, RESULTS_MS, type GameEvent, type Phase, type ResultRow } from "../shared/protocol";
import { minSelfClearance, pointAt, queryTrackNear } from "../shared/track";
import { startServer } from "../server/index";

const STEP_MS = 1000 / 60;
const LAPS = 1;

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
  readonly events: GameEvent[] = [];
  readonly errors: string[] = [];
  results: ResultRow[] | null = null;
  phases: Phase[] = [];
  welcomes = 0;

  constructor(
    readonly name: string,
    url: string,
    readonly lateral: number,
    sim?: LagSim,
  ) {
    this.game = new Game(() => connectWs(url, sim), memoryTokens());
    this.game.on.welcome = () => this.welcomes++;
    this.game.on.event = (ev) => this.events.push(ev);
    this.game.on.results = (rows) => (this.results = rows);
    this.game.on.error = (msg) => this.errors.push(msg);
    // The server broadcasts a room message on every phase change.
    this.game.on.room = () => {
      if (this.phases[this.phases.length - 1] !== this.game.phase) this.phases.push(this.game.phase);
    };
  }

  /** Called every fixed step. */
  step(): void {
    this.game.step(this.drive(), STEP_MS);
  }

  /** Follow the centerline (shifted sideways by `lateral`) and brake for bends. */
  private drive(): Input {
    const c = this.game.car;
    if (!c) return NO_INPUT;
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const v = speedOf(c);
    const t = pointAt(track, q.s + 55 + v * 0.3);
    const tx = t.x - Math.sin(t.h) * this.lateral;
    const ty = t.y + Math.cos(t.h) * this.lateral;
    const steer = clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
    const near = pointAt(track, q.s + 20).h;
    const far = pointAt(track, q.s + 20 + Math.max(120, v * 0.9)).h;
    const bend = Math.abs(angleDiff(near, far));
    const target = bend > 1.4 ? 200 : bend > 0.9 ? 260 : bend > 0.5 ? 330 : 1000;
    const throttle = v > target + 25 ? -1 : v > target ? 0 : 1;
    return { throttle, steer };
  }
}

// ---- test ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = await startServer({ port: 0, vite: false, laps: LAPS, host: "127.0.0.1" });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  console.log(`server on ${url}, ${LAPS} lap(s), track length ${track.length.toFixed(0)}`);

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

  // Non-host cannot start.
  B.game.start();
  await waitFor("B start refused", () => B.errors.length > 0, 2000);
  check("non-host start is refused", B.errors.length > 0 && A.game.phase === "lobby", B.errors[0] ?? "");

  // Host starts.
  A.game.start();
  await waitFor("countdown", () => A.game.phase === "countdown", 2000);
  await waitFor("racing", () => A.game.phase === "racing", 5000);
  const raceStartLocal = performance.now();
  check("all 3 have a car at race start", [A, B, C].every((b) => !!b.game.car));

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

  // C drops its connection mid-race and comes back with its token.
  await sleep(2500);
  const cId = C.game.you;
  const cBefore = A.game.latest?.cars.get(cId);
  const welcomesBefore = C.welcomes;
  C.game.simulateDrop();
  await waitFor("server marks C offline", () => A.game.player(cId)?.connected === false, 2000);
  const offlineSeen = A.game.player(cId)?.connected === false;
  await waitFor("C rejoined", () => C.welcomes > welcomesBefore && !!C.game.car, 5000);
  const cAfter = A.game.latest?.cars.get(cId);
  check("disconnect is visible to others", offlineSeen);
  check(
    "rejoin with token: same player id, car kept",
    C.game.you === cId && !!cAfter && A.game.players.length === 4,
    `id ${cId} -> ${C.game.you}, players ${A.game.players.length}`,
  );
  check(
    "rejoin: car continues from where it was (not reset to the grid)",
    !!cBefore && !!cAfter && cAfter.rd >= cBefore.rd && cBefore.rd > 500,
    `rd ${cBefore?.rd.toFixed(0)} -> ${cAfter?.rd.toFixed(0)}`,
  );

  // Everyone finishes.
  const finished = () => [A, B, C].every((b) => A.game.latest?.cars.get(b.game.you)?.fin);
  await waitFor("all bots finish", finished, 120_000);
  const lapSecs = ((performance.now() - raceStartLocal) / 1000).toFixed(1);
  check("every racing bot finishes the lap", finished(), `last finisher after ~${lapSecs}s`);

  await waitFor("results", () => A.results !== null, 5000);
  const rows = A.results ?? [];
  const finishEvents = A.events.filter((e) => e.k === "finish");
  const byEvents = [...finishEvents].sort((a, b) => (a.k === "finish" && b.k === "finish" ? a.place - b.place : 0)).map((e) => e.id);
  const timesAscending = rows.every((r, i) => i === 0 || (r.timeMs >= rows[i - 1].timeMs && r.timeMs > 0));
  check(
    "results: 3 rows, ordered by time, match finish events",
    rows.length === 3 && rows[0].timeMs > 0 && timesAscending && rows.map((r) => r.id).join() === byEvents.join(),
    rows.map((r) => `${r.name} ${(r.timeMs / 1000).toFixed(2)}s`).join(", "),
  );
  check("results: mid-race joiner not listed", !rows.some((r) => r.id === D.game.you));

  await waitFor("back to lobby", () => A.game.phase === "lobby", RESULTS_MS + 3000);
  const seq = A.phases.join(" -> ");
  check("phases: lobby -> countdown -> racing -> results -> lobby", seq === "lobby -> countdown -> racing -> results -> lobby", seq);
  // The room message flips the phase; the next snapshot (<= 33 ms later) drops the cars.
  const cleared = await waitFor("cars cleared", () => A.game.latest?.cars.size === 0, 1000);
  check("back in lobby: cars cleared", cleared);

  // Reconciliation quality.
  for (const b of [A, B, C]) {
    const s = stats(b.game.recErrors);
    console.log(
      `      ${b.name.padEnd(8)} rec err: n=${s.n} median=${s.median.toFixed(3)} p95=${s.p95.toFixed(3)} max=${s.max.toFixed(2)}  rtt=${b.game.rtt.toFixed(1)}ms`,
    );
  }
  const sb = stats(B.game.recErrors);
  check("lagged bot (80±10 ms): median reconciliation error < 0.5", sb.n > 100 && sb.median < 0.5, `median ${sb.median.toFixed(3)} over ${sb.n} samples`);
  check("lagged bot: no reconciliation error > 50 (no teleports)", sb.n > 100 && sb.max <= 50, `max ${sb.max.toFixed(2)}`);
  check("lagged bot: measured RTT reflects the simulated lag", B.game.rtt > 60, `${B.game.rtt.toFixed(1)} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
