// Smoke test for a running Scrap Rally server (local prod build, container, or public URL).
//
//   npm run smoke -- http://localhost:3001
//   npm run smoke -- https://example.onrender.com --race 10
//
// Checks GET /healthz and GET /, then two WebSocket clients create and join a room, the
// guest reports ready, the host starts, and both race for --race seconds (default 10)
// while pinging. Prints RTT,
// snapshots per second and the largest gap between snapshots (arrival time and server
// clock). Exits 1 on any failure. https:// uses wss://.
//
// --expect-restart <s>: after the race, keep both clients connected for up to <s> seconds
// and require a server restart (stop the server meanwhile, e.g. `docker stop`): each
// client must get the "restarting" notice before its socket closes (code 1012).

import { decode, encode, SNAPSHOT_EVERY, type ClientMsg, type ServerMsg } from "../shared/protocol";
import { TICK_HZ } from "../shared/physics";

const args = process.argv.slice(2);
function usage(problem?: string): never {
  if (problem) console.log(`smoke: ${problem}`);
  console.log("Usage: npm run smoke -- <http(s)://host[:port]> [--race s] [--wake-timeout s] [--expect-restart s]");
  process.exit(2);
}
/** A seconds flag: absent -> fallback; given -> it must be followed by a number > 0. */
function seconds(name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const raw = args[i + 1];
  const v = Number(raw);
  if (raw === undefined || raw.startsWith("--") || raw.trim() === "" || !Number.isFinite(v) || !(v > 0)) {
    usage(`${name} needs a number of seconds > 0, got ${raw === undefined ? "nothing" : `"${raw}"`}`);
  }
  return v;
}
const base = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const RACE_S = seconds("--race", 10);
// A sleeping free instance can take about a minute to wake: the first request waits longer.
const WAKE_TIMEOUT_MS = seconds("--wake-timeout", 90) * 1000;
const STEP_TIMEOUT_MS = 15_000;
const EXPECT_RESTART_S = seconds("--expect-restart", 0); // 0 = no restart check
const EXPECTED_HZ = TICK_HZ / SNAPSHOT_EVERY;

if (!base || !/^https?:\/\//.test(base)) usage(base ? `not an http(s) URL: "${base}"` : "missing base URL");
const httpBase = base.replace(/\/+$/, "");
const wsUrl = `${httpBase.replace(/^http/, "ws")}/ws`;

class SmokeFail extends Error {}
function fail(msg: string): never {
  throw new SmokeFail(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, timeoutMs: number): Promise<{ status: number; type: string; body: string; ms: number }> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(httpBase + path, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  } catch (e) {
    fail(`GET ${path}: ${(e as Error).message}`);
  }
  const body = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", body, ms: performance.now() - t0 };
}

// ---- one WebSocket client -------------------------------------------------------------

interface SnapStat {
  arrival: number; // performance.now() on receipt
  server: number; // server clock in the snapshot
  tick: number;
}

class Client {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMsg[] = [];
  private waiters: (() => void)[] = [];
  closed = false;
  closeInfo = "";
  closeCode = 0;
  closedAt = 0;
  restartNoticeAt = 0; // when the err "restarting" arrived (0 = not yet)
  you = "";
  code = "";
  phase = "";
  racing: SnapStat[] = [];
  rtts: number[] = [];
  private seq = 0;

  private readonly open: Promise<void>;

  constructor(readonly name: string) {
    this.ws = new WebSocket(wsUrl);
    this.open = new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new SmokeFail(`${this.name}: WebSocket ${wsUrl} failed to open`));
    });
    this.open.catch(() => {}); // observed in opened()
    this.ws.onmessage = (e) => {
      const msg = decode<ServerMsg>(e.data);
      if (!msg) return;
      const now = performance.now();
      if (msg.t === "snap") {
        this.phase = msg.phase;
        if (msg.phase === "racing") this.racing.push({ arrival: now, server: msg.time, tick: msg.tick });
      } else if (msg.t === "pong") {
        this.rtts.push(now - msg.c);
      } else if (msg.t === "room") {
        this.phase = msg.phase;
        this.inbox.push(msg);
      } else if (msg.t === "err" && msg.code === "restarting") {
        this.restartNoticeAt ||= now;
      } else {
        this.inbox.push(msg);
      }
      this.wake();
    };
    this.ws.onclose = (e) => {
      this.closed = true;
      this.closedAt = performance.now();
      this.closeCode = e.code;
      this.closeInfo = `code ${e.code}${e.reason ? ` "${e.reason}"` : ""}`;
      this.wake();
    };
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async opened(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SmokeFail(`${this.name}: WebSocket ${wsUrl} did not open in ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      await Promise.race([this.open, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  /** Wait for a queued message matching `pred`; earlier non-matching ones are kept. */
  async expect<T extends ServerMsg>(what: string, pred: (m: ServerMsg) => m is T, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as T;
      const err = this.inbox.find((m) => m.t === "err");
      if (err && err.t === "err") fail(`${this.name}: server error while waiting for ${what}: ${err.code ?? "-"} "${err.msg}"`);
      if (this.closed) fail(`${this.name}: socket closed (${this.closeInfo}) while waiting for ${what}`);
      const left = end - performance.now();
      if (left <= 0) fail(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  ping(): void {
    this.send({ t: "ping", c: performance.now() });
  }

  /** Full throttle, a little steering: enough to make the server simulate a moving car. */
  input(): void {
    const steer = Math.sin(this.seq / 90) * 0.3;
    this.send({ t: "in", i: [[this.seq++, 1, steer, 0]] });
  }

  close(): void {
    this.ws.close();
  }
}

const isWelcome = (m: ServerMsg): m is Extract<ServerMsg, { t: "welcome" }> => m.t === "welcome";
const roomWith =
  (n: number) =>
  (m: ServerMsg): m is Extract<ServerMsg, { t: "room" }> =>
    m.t === "room" && m.players.length === n;

function stats(xs: number[]): { n: number; median: number; p95: number; max: number } {
  if (!xs.length) return { n: 0, median: NaN, p95: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

const ms = (v: number) => `${v.toFixed(1)} ms`;

// ---- the run ------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`smoke: ${httpBase}  (ws ${wsUrl})`);

  const health = await get("/healthz", WAKE_TIMEOUT_MS);
  if (health.status !== 200 || health.body.trim() !== "ok") fail(`GET /healthz: ${health.status} "${health.body.slice(0, 80)}"`);
  console.log(`PASS  GET /healthz  200 "ok"  (${ms(health.ms)})`);

  const index = await get("/", STEP_TIMEOUT_MS);
  const looksHtml = index.type.includes("text/html") && /<!doctype html|<html/i.test(index.body);
  if (index.status !== 200 || !looksHtml) fail(`GET /: ${index.status} ${index.type || "(no content-type)"}`);
  console.log(`PASS  GET /  200 ${index.type}, ${Buffer.byteLength(index.body)} bytes  (${ms(index.ms)})`);

  const host = new Client("host");
  const guest = new Client("guest");
  const clients = [host, guest];
  try {
    await host.opened(STEP_TIMEOUT_MS);
    host.send({ t: "create", name: "SmokeHost" });
    const hw = await host.expect("welcome after create", isWelcome);
    host.you = hw.you;
    host.code = hw.code;
    console.log(`PASS  create: room ${hw.code}`);

    await guest.opened(STEP_TIMEOUT_MS);
    guest.send({ t: "join", code: hw.code, name: "SmokeGuest" });
    const gw = await guest.expect("welcome after join", isWelcome);
    guest.you = gw.you;
    if (gw.code !== hw.code) fail(`guest joined room ${gw.code}, expected ${hw.code}`);
    await host.expect("room with 2 players (host)", roomWith(2));
    await guest.expect("room with 2 players (guest)", roomWith(2));
    console.log("PASS  join: both clients see 2 players");

    // Lobby ready check: the host's Start waits until the guest is ready.
    guest.send({ t: "ready", ready: true });
    const guestReady = (m: ServerMsg): m is Extract<ServerMsg, { t: "room" }> =>
      m.t === "room" && m.players.some((p) => p.id === guest.you && p.ready);
    await host.expect("room with the guest ready (host)", guestReady);
    console.log("PASS  ready: the host sees the guest ready");

    host.send({ t: "start" });
    const raceStart = (m: ServerMsg): m is Extract<ServerMsg, { t: "room" }> => m.t === "room" && m.phase === "racing";
    await host.expect("racing phase (host)", raceStart);
    await guest.expect("racing phase (guest)", raceStart);
    console.log(`PASS  start: racing (race window ${RACE_S} s)`);

    // Race: inputs at 60 Hz, a ping every second, for RACE_S seconds.
    const t0 = performance.now();
    const inputs = setInterval(() => clients.forEach((c) => c.input()), 1000 / TICK_HZ);
    const pings = setInterval(() => clients.forEach((c) => c.ping()), 1000);
    clients.forEach((c) => c.ping());
    try {
      while (performance.now() - t0 < RACE_S * 1000) {
        await sleep(100);
        for (const c of clients) if (c.closed) fail(`${c.name}: socket closed mid-race (${c.closeInfo})`);
      }
    } finally {
      clearInterval(inputs);
      clearInterval(pings);
    }
    const elapsed = (performance.now() - t0) / 1000;

    // Report.
    let ok = true;
    for (const c of clients) {
      const snaps = c.racing.filter((s) => s.arrival >= t0);
      const arrivalGaps = snaps.slice(1).map((s, i) => s.arrival - snaps[i].arrival);
      const serverGaps = snaps.slice(1).map((s, i) => s.server - snaps[i].server);
      const tickJumps = snaps.slice(1).map((s, i) => s.tick - snaps[i].tick);
      const rate = snaps.length / elapsed;
      const rtt = stats(c.rtts);
      const ag = stats(arrivalGaps);
      const sg = stats(serverGaps);
      const missed = tickJumps.reduce((n, d) => n + Math.max(0, d / SNAPSHOT_EVERY - 1), 0);
      const good = snaps.length > 0 && rtt.n > 0;
      if (!good) ok = false;
      console.log(
        `${good ? "PASS" : "FAIL"}  ${c.name.padEnd(5)} racing snapshots ${snaps.length} in ${elapsed.toFixed(1)} s = ${rate.toFixed(1)}/s (expected ${EXPECTED_HZ}/s), ` +
          `missed ${missed.toFixed(0)}`,
      );
      console.log(
        `      ${"".padEnd(5)} largest gap: arrival ${ms(ag.max)} (median ${ms(ag.median)}, p95 ${ms(ag.p95)}), ` +
          `server clock ${ms(sg.max)}`,
      );
      console.log(`      ${"".padEnd(5)} RTT: n=${rtt.n} median ${ms(rtt.median)}, max ${ms(rtt.max)}`);
    }
    if (!ok) fail("a client got no racing snapshots or no pong");

    if (EXPECT_RESTART_S > 0) await expectRestart(clients);
  } finally {
    clients.forEach((c) => c.close());
  }
  console.log("\nsmoke: PASS");
}

/** Clients stay in the race; the server is stopped from outside meanwhile. */
async function expectRestart(clients: Client[]): Promise<void> {
  console.log(`WAIT  clients stay connected up to ${EXPECT_RESTART_S} s: stop or restart the server now`);
  const t0 = performance.now();
  while (!clients.every((c) => c.closed) && performance.now() - t0 < EXPECT_RESTART_S * 1000) await sleep(20);
  for (const c of clients) {
    if (!c.closed) fail(`${c.name}: no server restart within ${EXPECT_RESTART_S} s (socket still open)`);
    if (!c.restartNoticeAt) fail(`${c.name}: socket closed (${c.closeInfo}) without the "restarting" notice`);
    if (c.closeCode !== 1012) fail(`${c.name}: closed with ${c.closeInfo}, expected code 1012 (restarting)`);
    console.log(
      `PASS  ${c.name.padEnd(5)} got err "restarting", then close ${c.closeInfo} ${ms(c.closedAt - c.restartNoticeAt)} later`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log(`FAIL  ${e instanceof SmokeFail ? e.message : (e as Error).stack ?? e}`);
    console.log("\nsmoke: FAIL");
    process.exit(1);
  },
);
