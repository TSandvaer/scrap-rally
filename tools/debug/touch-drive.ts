// The touch controls in a real browser (TOUCH-1, PLAN-TOUCH): headless Chrome from the
// agent-browser CLI, with touch emulated over the browser's own DevTools socket (agent-browser
// `get cdp-url`; the repo's `ws` speaks the protocol). agent-browser's `set device` changes the
// user agent and the viewport only (no touch, `(pointer: coarse)` stays false); the protocol's
// Emulation.setTouchEmulationEnabled makes `(pointer: coarse)` true and Input.dispatchTouchEvent
// puts several fingers down at once (one pointer id each), so this tool drives with two thumbs.
//
// Passes (all by default, or --only a,b):
//   drive-portrait   390x844, ?debug=1: a whole race (3 laps) driven by touch only; input
//                    assertions (every step's Controls, wrapped around Game.step), gas + FIRE with
//                    two fingers, MINE taps, the menu and the chat hide and clear the pad, a driving
//                    key hides it, a finished car and the results hide it.
//   drive-landscape  844x390, ?debug=1: one lap the same way, then Retire to garage hides it.
//   look-portrait / look-landscape / look-small (360x740): no debug (production layout): the
//                    lobby (pad hidden), the race with two thumbs down (screenshots), the clusters'
//                    boxes against the HUD panels, minimap, banner/ping, speaker, ☰ and the moved
//                    Chat button; no scroll or zoom from a pinch or a double tap on the view or the
//                    pad; portrait also the pause banner's touch wording.
//   desktop          1280x720 with no touch: the pad never shows in a race.
// Each pass runs in a browser of its own (see main()). Needs the dev server: PORT=3006 npm run dev.
// Exit code 1 if a check fails.
//   npx tsx tools/debug/touch-drive.ts --url http://127.0.0.1:3006 --out tmp/touch-drive
//   (--only drive-portrait,look-small  --laps n: drive-portrait's laps  --no-mid: skip its mid-race
//   menu/chat/key checks  --session name: the agent-browser session, "touch-drive")

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { angleDiff } from "../../shared/physics";
import { pointAt, queryTrackNear, type Track } from "../../shared/track";
import { findTrack } from "../../shared/tracks";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const URL = arg("url", "http://127.0.0.1:3006");
const SESSION = arg("session", "touch-drive");
const OUT = path.resolve(arg("out", "tmp/touch-drive"));
const ONLY = arg("only", "drive-portrait,drive-landscape,look-portrait,look-landscape,look-small,desktop").split(",");
const LAPS = Number(arg("laps", "3")); // drive-portrait: laps by touch (3 = the whole race, then the finish and the results)
const MID = !process.argv.includes("--no-mid"); // drive-portrait: the menu, chat and key checks mid-race
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 120_000 });
  return stdout.trim();
}

// ---- the DevTools socket ------------------------------------------------------------

class Cdp {
  private id = 0;
  private readonly wait = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  private session = "";
  /** Uncaught errors and console errors of the page, as they come (a check at the end of each pass). */
  readonly pageErrors: string[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.wait.has(m.id)) {
        this.wait.get(m.id)!(m);
        this.wait.delete(m.id);
      } else if (m.method === "Runtime.exceptionThrown") {
        const e = m.params.exceptionDetails;
        this.pageErrors.push(`${e.exception?.description ?? e.text}`.split("\n").slice(0, 3).join(" / "));
      } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.pageErrors.push(`console.error: ${m.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" ")}`);
      }
    });
  }

  static async open(browserUrl: string): Promise<Cdp> {
    const ws = new WebSocket(browserUrl);
    await new Promise((ok, fail) => (ws.once("open", ok), ws.once("error", fail)));
    const c = new Cdp(ws);
    const t = (await c.raw("Target.getTargets", {}, "")) as { targetInfos: { type: string; targetId: string }[] };
    const page = t.targetInfos.find((x) => x.type === "page")!;
    c.session = ((await c.raw("Target.attachToTarget", { targetId: page.targetId, flatten: true }, "")) as { sessionId: string }).sessionId;
    // The real window holds every emulated screen: synthesized gestures (a pinch, a swipe) are
    // checked against it, not against the emulated screen (agent-browser's window: 1280x720).
    const { windowId, bounds } = (await c.raw("Browser.getWindowForTarget", { targetId: page.targetId }, "")) as { windowId: number; bounds: { width: number; height: number } };
    await c.raw("Browser.setWindowBounds", { windowId, bounds: { width: 1300, height: 1000 } }, "");
    const after = ((await c.raw("Browser.getWindowBounds", { windowId }, "")) as { bounds: { width: number; height: number } }).bounds;
    console.log(`  browser window ${bounds.width}x${bounds.height} -> ${after.width}x${after.height}`);
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    return c;
  }

  private raw(method: string, params: object, sessionId: string): Promise<unknown> {
    const i = ++this.id;
    return new Promise((ok, fail) => {
      this.wait.set(i, (m) => (m.error ? fail(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result)));
      this.ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  send(method: string, params: object = {}): Promise<unknown> {
    return this.raw(method, params, this.session);
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Fingers on the emulated touch screen: each its own pointer, down, moved and lifted alone. Every
 * time a finger goes down it gets a new touch id, as on a real screen: Chrome's emulation kept an
 * id reused from an earlier page as still down and sent no pointer events for it.
 */
class Fingers {
  private readonly down = new Map<number, { x: number; y: number; id: number }>();
  private nextId = 1;
  constructor(private readonly cdp: Cdp) {}
  private pts = () => [...this.down.values()].map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 }));
  /** Put finger `finger` down at (x, y), or slide it there if it is down. */
  async at(finger: number, x: number, y: number): Promise<void> {
    const was = this.down.get(finger);
    const start = !was;
    this.down.set(finger, { x: Math.round(x), y: Math.round(y), id: was ? was.id : this.nextId++ });
    await this.cdp.send("Input.dispatchTouchEvent", { type: start ? "touchStart" : "touchMove", touchPoints: this.pts() });
  }
  async lift(id: number): Promise<void> {
    const p = this.down.get(id);
    if (!p) return;
    this.down.delete(id);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: p.x, y: p.y, id: p.id }] });
  }
  /** Lift every finger that is down, one by one (Chrome refuses an end with no touch down). */
  async liftAll(): Promise<void> {
    for (const finger of [...this.down.keys()]) await this.lift(finger);
  }
  has(id: number): boolean {
    return this.down.has(id);
  }
}

// Finger ids: the right thumb on the pad, the left on FIRE, others for taps.
const RIGHT = 1, LEFT = 2, TAP = 3;

interface Box { left: number; top: number; width: number; height: number }
const centre = (b: Box): [number, number] => [b.left + b.width / 2, b.top + b.height / 2];
const overlap = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const boxText = (b: Box) => `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;

// ---- the page -----------------------------------------------------------------------

class PageDriver {
  readonly fingers: Fingers;
  constructor(readonly cdp: Cdp) {
    this.fingers = new Fingers(cdp);
  }

  async device(w: number, h: number, touch: boolean): Promise<void> {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: touch ? 2 : 1, mobile: touch, screenOrientation: { type: w > h ? "landscapePrimary" : "portraitPrimary", angle: w > h ? 90 : 0 } });
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  }

  async load(query: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url: `${URL}/${query}` });
    await this.until("the page loads", "document.readyState === 'complete' && !!document.getElementById('create')", 20_000);
    await sleep(300);
    // Silence: the game's own mute too (M, a synthetic key; not a driving key).
    await this.cdp.eval(`document.getElementById('sound-btn').classList.contains('muted') || window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM' }))`);
  }

  async until(what: string, expr: string, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await this.cdp.eval<boolean>(`!!(${expr})`))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(60);
    }
  }

  box(sel: string): Promise<Box | null> {
    return this.cdp.eval<Box | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; })()`);
  }

  /** A finger taps the middle of an element (the other fingers stay down). */
  async tap(sel: string): Promise<void> {
    await this.cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }), true`);
    const b = await this.box(sel);
    if (!b) throw new Error(`nothing to tap: ${sel}`);
    await this.fingers.at(TAP, ...centre(b));
    await sleep(50);
    await this.fingers.lift(TAP);
    await sleep(120);
  }

  shown(): Promise<boolean> {
    return this.cdp.eval<boolean>(`!document.getElementById('touch').classList.contains('hidden')`);
  }

  async shot(name: string): Promise<string> {
    const r = (await this.cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log(`screenshot ${file}`);
    return file;
  }

  /** In the lobby's garage: a pack of rivets and of mines (a new driver has none), by touch. */
  async buyAmmo(): Promise<void> {
    for (const n of [4, 5]) {
      await this.until("the shop", `!!document.querySelector('#shop li:nth-child(${n}) .buy:not([disabled])')`);
      await this.tap(`#shop li:nth-child(${n}) .buy`);
    }
    await this.until("the ammo bought", "document.querySelectorAll('#shop .count').length === 2 && [...document.querySelectorAll('#shop .count')].every((c) => !c.textContent.startsWith('0/'))");
  }

  /** Create a room, buy ammo, add an Easy bot, start; resolves at the countdown. */
  async race(): Promise<void> {
    await this.tap("#create");
    await this.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
    await this.buyAmmo();
    await this.tap("#bot-easy");
    await this.until("the bot", "document.querySelectorAll('#lobby-players li').length === 2");
    await this.tap("#start");
    await this.until("the countdown", "document.getElementById('lobby').classList.contains('hidden')");
  }

  /** The centre of pad zone z (row * 3 + col) on screen. */
  async zone(z: number): Promise<[number, number]> {
    const b = (await this.box("#touch-pad"))!;
    return [b.left + ((z % 3) + 0.5) * (b.width / 3), b.top + (Math.floor(z / 3) + 0.5) * (b.height / 3)];
  }
}

// ---- driving by touch ----------------------------------------------------------------

const ZONE_KEYS: [number, number][] = [[1, -1], [1, 0], [1, 1], [0, -1], [0, 0], [0, 1], [-1, -1], [-1, 0], [-1, 1]];

/** Wraps Game.step (debug page) to see every step's Controls as main.ts hands them over. */
const PATCH_STEP = `(() => {
  const g = window.scrapDebug.game;
  if (g.__touchStep) return true;
  g.__touchStep = true;
  const step = g.step.bind(g);
  window.__td = { last: null, steps: 0, mines: 0, fire: 0, both: 0 };
  g.step = (ctl, ms) => {
    const t = window.__td;
    t.last = ctl; t.steps++;
    if (ctl.mine) t.mines++;
    if (ctl.fire) t.fire++;
    if (ctl.fire && ctl.throttle !== 0) t.both++;
    return step(ctl, ms);
  };
  return true;
})()`;

interface Pose {
  x: number; y: number; h: number; vx: number; vy: number; seg: number; wreck: number;
  lap: number; fin: number; phase: string; track: string; ammo: [number, number];
  last: { throttle: number; steer: number; fire: boolean; mine: boolean } | null;
  steps: number; mines: number; fire: number; both: number; shown: boolean; armed: boolean;
}
const POSE = `(() => {
  const g = window.scrapDebug.game, c = g.car, s = g.ownSnap(), t = window.__td;
  return { x: c ? c.x : 0, y: c ? c.y : 0, h: c ? c.h : 0, vx: c ? c.vx : 0, vy: c ? c.vy : 0, seg: c ? c.seg : 0, wreck: c ? c.wreck : 0,
    lap: s ? s.lap : -1, fin: s ? s.fin : 0, phase: g.phase, track: g.trackId, ammo: g.predictedAmmo(),
    last: t.last, steps: t.steps, mines: t.mines, fire: t.fire, both: t.both,
    shown: !document.getElementById('touch').classList.contains('hidden'), armed: g.armsInMs() === 0 && g.raceOn() };
})()`;

/** Which zone the controller wants: aim along the track ahead, steer bang-bang, brake for a sharp bend. */
function wantZone(track: Track, p: Pose, stuck: boolean): number {
  const q = queryTrackNear(track, p.x, p.y, p.seg);
  const speed = Math.hypot(p.vx, p.vy);
  const aim = pointAt(track, q.s + 70 + speed * 0.12);
  const err = angleDiff(p.h, Math.atan2(aim.y - p.y, aim.x - p.x));
  const steer = err > 0.07 ? 1 : err < -0.07 ? -1 : 0;
  if (stuck) return 2 * 3 + (1 - steer); // reverse, wheel the other way
  const throttle = Math.abs(err) > 0.75 && speed > 160 ? -1 : 1;
  return (1 - throttle) * 3 + (steer + 1);
}

interface DriveLog { laps: number; samples: number; matched: number; mismatched: string[]; zones: Set<number>; fireBursts: number; fireWithPad: number; rivetsUsed: number; mineTaps: number; minesStepped: number; minesUsed: number; stuckTurns: number; seconds: number }

/**
 * Drive by touch until `laps` are done (or the car finished). The right thumb slides between pad
 * zones; every few seconds the left thumb holds FIRE for a while (two fingers down); once a lap a
 * third finger taps MINE. After the controls settle, each sample checks the step's Controls are the
 * zone's (and FIRE's) exactly.
 */
async function drive(d: PageDriver, laps: number, midRace?: (lap: number) => Promise<void>): Promise<DriveLog> {
  const log: DriveLog = { laps: 0, samples: 0, matched: 0, mismatched: [], zones: new Set(), fireBursts: 0, fireWithPad: 0, rivetsUsed: 0, mineTaps: 0, minesStepped: 0, minesUsed: 0, stuckTurns: 0, seconds: 0 };
  let p = await d.cdp.eval<Pose>(POSE);
  const track = findTrack(p.track);
  if (!track) throw new Error(`unknown track ${p.track}`);
  const t0 = Date.now();
  let zone = -1, settled = 0, slow = 0, stuckUntil = 0, nextFire = Date.now() + 3000, fireUntil = 0, mineLap = -1, midLap = -1;
  let fireAmmo0 = 0, mineAmmo0 = 0, mineSteps0 = 0;
  while (Date.now() - t0 < 360_000) {
    p = await d.cdp.eval<Pose>(POSE);
    if (p.fin || p.lap >= laps || (p.phase !== "racing" && p.phase !== "countdown")) break;
    const now = Date.now();
    const speed = Math.hypot(p.vx, p.vy);
    if (p.phase === "racing" && !p.wreck && speed < 25) slow++;
    else slow = 0;
    if (slow > 50 && now > stuckUntil) {
      stuckUntil = now + 900;
      log.stuckTurns++;
      slow = 0;
    }
    const z = wantZone(track, p, now < stuckUntil);
    if (z !== zone) {
      await d.fingers.at(RIGHT, ...(await d.zone(z)));
      zone = z;
      settled = 0;
      log.zones.add(z);
    } else settled++;
    // The left thumb: FIRE for 1.2 s every 4 s, once armed.
    if (p.armed && !d.fingers.has(LEFT) && now > nextFire) {
      fireAmmo0 = p.ammo[0];
      await d.fingers.at(LEFT, ...centre((await d.box("#touch-fire"))!));
      fireUntil = now + 1200;
      log.fireBursts++;
      settled = 0;
    } else if (d.fingers.has(LEFT) && now > fireUntil) {
      await d.fingers.lift(LEFT);
      log.rivetsUsed += Math.max(0, fireAmmo0 - p.ammo[0]);
      nextFire = now + 2800;
      settled = 0;
    }
    // A third finger taps MINE once a lap (armed, with mines left).
    if (p.armed && p.lap > mineLap && p.ammo[1] > 0 && !d.fingers.has(LEFT)) {
      mineLap = p.lap;
      mineAmmo0 = p.ammo[1];
      mineSteps0 = p.mines;
      await d.tap("#touch-mine");
      log.mineTaps++;
      const after = await d.cdp.eval<Pose>(POSE);
      log.minesStepped += after.mines - mineSteps0;
      log.minesUsed += Math.max(0, mineAmmo0 - after.ammo[1]);
      settled = 0;
    }
    // The step's Controls once settled (2 samples, ~3 steps after the last change).
    if (settled >= 2 && p.phase === "racing" && p.last) {
      log.samples++;
      const [t, s] = ZONE_KEYS[zone];
      const fire = d.fingers.has(LEFT);
      if (p.last.throttle === t && p.last.steer === s && p.last.fire === fire) {
        log.matched++;
        if (fire && t !== 0) log.fireWithPad++;
      } else if (log.mismatched.length < 8) log.mismatched.push(`zone ${zone} fire ${fire} -> ${JSON.stringify(p.last)}`);
    }
    if (midRace && p.lap >= 1 && midLap < 0 && p.phase === "racing" && !d.fingers.has(LEFT)) {
      midLap = p.lap;
      await midRace(p.lap);
      zone = -1;
    }
    await sleep(25);
  }
  log.laps = p.lap;
  log.seconds = Math.round((Date.now() - t0) / 1000);
  await d.fingers.liftAll();
  return log;
}

/**
 * In the countdown (main.ts hands every step's Controls to Game.step, which ignores them until
 * GO): one finger goes down in the centre and slides round all eight zones, corners too, and
 * back; at each stop the step's Controls must be that zone's keys.
 */
async function sweep(d: PageDriver, tag: string): Promise<void> {
  const ring = [4, 1, 2, 5, 8, 7, 6, 3, 0, 1, 4];
  const got: string[] = [];
  let ok = true;
  // What a finger lands on (for the report when it fails): the pointer events seen and the element under the zone.
  await d.cdp.eval(`window.__pd = []; for (const t of ['pointerdown', 'pointerup', 'pointercancel']) addEventListener(t, (e) => __pd.length < 12 && __pd.push(t + ':' + (e.target.id || e.target.className || e.target.tagName) + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ':' + e.pointerType + ':' + e.pointerId), true), true`);
  for (const z of ring) {
    await d.fingers.at(RIGHT, ...(await d.zone(z)));
    await sleep(90);
    const last = (await d.cdp.eval<Pose>(POSE)).last;
    const [t, st] = ZONE_KEYS[z];
    ok &&= !!last && last.throttle === t && last.steer === st;
    got.push(`${z}:${last ? `${last.throttle}/${last.steer}` : "-"}`);
  }
  const lit = await d.cdp.eval<number>(`document.querySelectorAll('#touch-pad .on').length`);
  await d.fingers.lift(RIGHT);
  await sleep(90);
  const off = (await d.cdp.eval<Pose>(POSE)).last;
  if (!ok) {
    // The emulation's state when the fingers stopped arriving, and a fresh test touch on the view.
    const state = await d.cdp.eval<string>(`JSON.stringify({ coarse: matchMedia('(pointer: coarse)').matches, mtp: navigator.maxTouchPoints, focus: document.hasFocus(), vis: document.visibilityState, size: [innerWidth, innerHeight], url: location.search })`);
    await d.cdp.eval(`window.__pd = [], true`);
    const v = (await d.box("#view"))!;
    await d.fingers.at(TAP, ...centre(v));
    await d.fingers.lift(TAP);
    await sleep(200);
    console.log(`  diagnose: ${state}; a touch on the view now: ${await d.cdp.eval<string>("JSON.stringify(__pd)")}`);
  }
  const seen = ok ? "" : await d.cdp.eval<string>(`(() => { const r = document.getElementById('touch-pad').getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 6; return JSON.stringify({ pd: __pd, at: [Math.round(x), Math.round(y)], under: document.elementsFromPoint(x, y).slice(0, 4).map((e) => e.id || e.className || e.tagName), inner: [innerWidth, innerHeight, visualViewport.scale, devicePixelRatio] }); })()`);
  check(`${tag}: one finger slides from the centre round all eight zones (corners too) and back; each stop's step Controls are that zone's keys; lifted, nothing`, ok && !!off && off.throttle === 0 && off.steer === 0, `${got.join(" ")}; lit at the end ${lit}; lifted ${off?.throttle}/${off?.steer}${seen ? `; ${seen}` : ""}`);
}

function reportDrive(tag: string, log: DriveLog, laps: number): void {
  check(`${tag}: ${laps} lap(s) driven by touch only (the right thumb sliding through the pad's zones)`, log.laps >= laps, `${log.laps} laps in ${log.seconds} s, zones used ${[...log.zones].sort().join(",")}, ${log.stuckTurns} unstick reverses`);
  check(
    `${tag}: every settled sample, the step's Controls are exactly the finger's zone (+ FIRE while the left thumb holds it)`,
    log.samples > 100 && log.mismatched.length === 0,
    `${log.matched}/${log.samples}${log.mismatched.length ? `; ${log.mismatched.join(" | ")}` : ""}`,
  );
  check(`${tag}: two thumbs at once: FIRE held while the pad drives (samples with throttle and fire both), rivets fired`, log.fireWithPad > 10 && log.rivetsUsed > 0, `${log.fireBursts} bursts, ${log.fireWithPad} samples gas+fire, ${log.rivetsUsed} rivets`);
  check(`${tag}: a MINE tap reaches exactly one step's mine and drops one mine`, log.mineTaps > 0 && log.minesStepped === log.mineTaps && log.minesUsed === log.mineTaps, `${log.mineTaps} taps, ${log.minesStepped} steps with mine, ${log.minesUsed} mines dropped`);
}

// ---- the passes ------------------------------------------------------------------------

async function drivePortrait(d: PageDriver): Promise<void> {
  await d.device(390, 844, true);
  await d.load("?debug=1");
  const env = await d.cdp.eval<{ coarse: boolean; touch: boolean; help: string }>(
    `({ coarse: matchMedia('(pointer: coarse)').matches, touch: document.getElementById('stage').classList.contains('touch'), help: getComputedStyle(document.querySelector('.keys-touch')).display + '/' + getComputedStyle(document.querySelector('.keys-keyboard')).display })`,
  );
  check("drive portrait: matchMedia('(pointer: coarse)') under touch emulation; touch in use from the start; the key help shows the touch words", env.coarse && env.touch && env.help === "block/none", JSON.stringify(env));
  check("drive portrait: no pad on the main menu", !(await d.shown()));
  await d.tap("#create");
  await d.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
  await sleep(300);
  check("drive portrait: no pad in the lobby (garage)", !(await d.shown()));
  await d.buyAmmo();
  await d.tap("#bot-easy");
  await d.until("the bot", "document.querySelectorAll('#lobby-players li').length === 2");
  await d.tap("#start");
  await d.until("the countdown", "window.scrapDebug.game.phase === 'countdown'");
  await d.cdp.eval(PATCH_STEP);
  await sleep(200);
  check("drive portrait: the pad shows in the countdown", await d.shown());
  await sweep(d, "drive portrait");
  await d.until("the race", "window.scrapDebug.game.phase === 'racing'", 10_000);

  const mid = async () => {
    const key = (k: string) => d.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', code: '${k}' })), true`);
    // The menu opens (Esc) with the gas finger down: the pad hides; closed again, the finger
    // still down drives nothing until it is put down again (clear on open and on every hide).
    // (A tap of a second finger makes no click while another is down, so Esc stands in here.)
    await d.fingers.at(RIGHT, ...(await d.zone(1)));
    await sleep(150);
    const before = await d.cdp.eval<Pose>(POSE);
    await key("Escape");
    await sleep(150);
    const inMenu = await d.cdp.eval<Pose>(POSE);
    await key("Escape");
    await sleep(200);
    const back = await d.cdp.eval<Pose>(POSE);
    check(
      "drive portrait: the menu opening hides the pad and lets go of the held finger; closed, the pad is back and that finger (still down) drives nothing",
      before.last?.throttle === 1 && before.shown && !inMenu.shown && inMenu.last?.throttle === 0 && back.shown && back.last?.throttle === 0,
      `before shown ${before.shown} throttle ${before.last?.throttle}; menu shown ${inMenu.shown} throttle ${inMenu.last?.throttle}; back shown ${back.shown} throttle ${back.last?.throttle}`,
    );
    await d.fingers.lift(RIGHT);
    // ☰ and Resume by touch (one finger): the menu opens and closes, the pad hides and comes back.
    await d.tap("#menu-btn");
    await sleep(150);
    const menuShown = await d.shown();
    const menuOpen = await d.cdp.eval<boolean>(`!document.getElementById('game-menu').classList.contains('hidden')`);
    await d.tap('.gm [data-key="resume"]');
    await sleep(200);
    check("drive portrait: a tap on ☰ opens the menu (no pad); Resume tapped closes it (pad back)", menuOpen && !menuShown && (await d.shown()), `menu ${menuOpen}, pad in menu ${menuShown}`);
    // The chat opening (Enter) with the gas finger down: no pad, throttle 0; Esc closes it.
    await d.fingers.at(RIGHT, ...(await d.zone(1)));
    await sleep(150);
    await key("Enter");
    await sleep(150);
    const chatOpen = await d.cdp.eval<Pose>(POSE);
    await key("Escape");
    await sleep(200);
    const chatShut = await d.cdp.eval<Pose>(POSE);
    await d.fingers.lift(RIGHT);
    check(
      "drive portrait: opening the chat hides the pad and lets go of the held finger (throttle 0); closing it shows the pad again",
      !chatOpen.shown && chatOpen.last?.throttle === 0 && chatShut.shown && chatShut.last?.throttle === 0,
      `chat open: shown ${chatOpen.shown} throttle ${chatOpen.last?.throttle}; closed: shown ${chatShut.shown} throttle ${chatShut.last?.throttle}`,
    );
    // The moved Chat button and Close by touch.
    await d.tap("#chat .chat-open");
    await sleep(150);
    const tappedOpen = await d.cdp.eval<{ open: boolean; shown: boolean }>(`({ open: document.getElementById('chat').classList.contains('open'), shown: !document.getElementById('touch').classList.contains('hidden') })`);
    await d.tap("#chat .chat-close");
    await sleep(200);
    check("drive portrait: a tap on the (moved) Chat button opens the chat (no pad); Close tapped brings the pad back", tappedOpen.open && !tappedOpen.shown && (await d.shown()), JSON.stringify(tappedOpen));
    // A driving key (a tablet's keyboard): the pad hides; a finger on the screen brings it back.
    await key("ArrowUp");
    await sleep(120);
    const keyed = await d.cdp.eval<Pose>(POSE);
    await d.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', code: 'ArrowUp' })), true`);
    const view = (await d.box("#view"))!;
    await d.fingers.at(TAP, view.left + view.width / 2, view.top + view.height / 2);
    await d.fingers.lift(TAP);
    await sleep(120);
    const touchedAgain = await d.shown();
    check("drive portrait: a driving keydown hides the pad (and drives: throttle 1); a touch on the view shows it again", !keyed.shown && keyed.last?.throttle === 1 && touchedAgain, `after key: shown ${keyed.shown} throttle ${keyed.last?.throttle}; after a touch: ${touchedAgain}`);
  };
  const log = await drive(d, LAPS, MID ? mid : undefined);
  reportDrive("drive portrait", log, LAPS);
  if (LAPS < 3) return;
  await d.until("our finish", "(window.scrapDebug.game.ownSnap()?.fin ?? 0) > 0", 20_000).catch(() => undefined);
  await sleep(150);
  const fin = await d.cdp.eval<Pose>(POSE);
  check("drive portrait: our car finished: the pad hides (the race goes on for the others)", fin.fin > 0 && !fin.shown && fin.phase === "racing", `fin ${fin.fin}, phase ${fin.phase}, shown ${fin.shown}`);
  await d.until("the results", "window.scrapDebug.game.phase === 'results'", 120_000);
  await sleep(200);
  check("drive portrait: no pad on the results", !(await d.shown()));
}

async function driveLandscape(d: PageDriver): Promise<void> {
  await d.device(844, 390, true);
  await d.load("?debug=1");
  check("drive landscape: matchMedia('(pointer: coarse)') under touch emulation", await d.cdp.eval<boolean>(`matchMedia('(pointer: coarse)').matches`));
  await d.race();
  await d.cdp.eval(PATCH_STEP);
  await sweep(d, "drive landscape");
  await d.until("the race", "window.scrapDebug.game.phase === 'racing'", 10_000);
  const log = await drive(d, 1);
  reportDrive("drive landscape", log, 1);
  // Retire to garage (the menu): the garage opens while the race runs on; no pad.
  await d.tap("#menu-btn");
  await sleep(150);
  await d.tap('.gm [data-key="retire"]');
  await sleep(150);
  await d.tap('.gm [data-key="confirm"]');
  await d.until("the garage", "!document.getElementById('lobby').classList.contains('hidden')", 5000).catch(() => undefined);
  await sleep(200);
  const g = await d.cdp.eval<{ phase: string; retired: boolean; lobby: boolean; shown: boolean }>(
    `({ phase: scrapDebug.game.phase, retired: scrapDebug.game.retired(), lobby: !document.getElementById('lobby').classList.contains('hidden'), shown: !document.getElementById('touch').classList.contains('hidden') })`,
  );
  check("drive landscape: retired to the garage mid-race: no pad", g.retired && g.lobby && g.phase === "racing" && !g.shown, JSON.stringify(g));
}

interface Layout {
  view: Box; stage: Box; pad: Box; weapons: Box; fire: Box; mine: Box; sound: Box; menu: Box; chatOpen: Box | null;
  caps: Box[]; scroll: [number, number]; scale: number; touchAction: string[];
}
const LAYOUT = `(() => {
  const b = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const q = (s) => document.querySelector(s);
  return { view: b(q('#view')), stage: b(q('#stage')), pad: b(q('#touch-pad')), weapons: b(q('#touch-weapons')), fire: b(q('#touch-fire')), mine: b(q('#touch-mine')),
    sound: b(q('#sound-btn')), menu: b(q('#menu-btn')), chatOpen: b(q('#chat .chat-open')),
    caps: [...document.querySelectorAll('#touch .tcap')].map(b),
    scroll: [scrollX, scrollY], scale: visualViewport.scale,
    touchAction: ['#view', '#touch-pad', '#touch-weapons', '#stage', '.chat-log'].map((s) => q(s) ? getComputedStyle(q(s)).touchAction : '-') };
})()`;

/** The HUD's boxes on screen, from the view's box (gfx/hud.ts, in 640x360 view pixels). */
function hudBoxes(view: Box): Record<string, Box> {
  const k = view.width / 640;
  const vb = (x: number, y: number, w: number, h: number): Box => ({ left: view.left + x * k, top: view.top + y * k, width: w * k, height: h * k });
  return {
    "top-left panel (lap, position, ammo, HP, cues)": vb(0, 0, 130, 110),
    "race time and notices": vb(220, 0, 200, 45),
    minimap: vb(528, 4, 108, 108),
    "banner strip and ping label": vb(0, 334, 640, 26),
  };
}

async function look(d: PageDriver, tag: string, w: number, h: number): Promise<void> {
  await d.device(w, h, true);
  await d.load("");
  if (tag === "look portrait") await d.shot("menu-portrait-390x844"); // the key help in touch words
  await d.tap("#create");
  await d.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
  await sleep(400);
  check(`${tag}: no pad in the lobby`, !(await d.shown()));
  if (tag === "look portrait") await d.shot("lobby-portrait-390x844");
  await d.buyAmmo();
  await d.tap("#bot-easy");
  await d.until("the bot", "document.querySelectorAll('#lobby-players li').length === 2");
  await d.tap("#start");
  await d.until("the countdown", "document.getElementById('lobby').classList.contains('hidden')");
  await d.until("the pad", "!document.getElementById('touch').classList.contains('hidden')", 5000);
  await sleep(3600); // the countdown is over
  // Both thumbs down: the right on gas + right (a corner), the left on FIRE.
  await d.fingers.at(RIGHT, ...(await d.zone(2)));
  await d.fingers.at(LEFT, ...centre((await d.box("#touch-fire"))!));
  await sleep(700);
  const lit = await d.cdp.eval<string[]>(`[...document.querySelectorAll('#touch .on')].map((e) => e.getAttribute('aria-label'))`);
  const L = await d.cdp.eval<Layout>(LAYOUT);
  await d.shot(`race-${tag.split(" ")[1]}-${w}x${h}`);
  check(`${tag}: two fingers down light the gas+right corner and FIRE`, lit.length === 2 && lit.includes("Gas and steer right") && lit.some((l) => l.startsWith("Rivet gun")), lit.join(", "));
  // Sizes and places.
  const small = L.caps.filter((c) => c.width < 56 || c.height < 56);
  check(`${tag}: every key cap is at least 56 CSS px`, L.caps.length === 10 && small.length === 0, `${L.caps.length} caps, smallest ${Math.min(...L.caps.map((c) => Math.min(c.width, c.height)))} px`);
  const inside = (b: Box) => b.left >= 0 && b.top >= 0 && b.left + b.width <= w && b.top + b.height <= h;
  check(`${tag}: both clusters on screen`, inside(L.pad) && inside(L.weapons), `pad ${boxText(L.pad)}, weapons ${boxText(L.weapons)}`);
  const hits: string[] = [];
  const avoid: Record<string, Box | null> = { ...hudBoxes(L.view), speaker: L.sound, "☰ menu": L.menu, "Chat button": L.chatOpen };
  for (const [name, b] of Object.entries(avoid)) {
    if (!b) continue;
    if (overlap(L.pad, b)) hits.push(`pad over ${name}`);
    if (overlap(L.weapons, b)) hits.push(`weapons over ${name}`);
  }
  if (overlap(L.pad, L.weapons)) hits.push("pad over weapons");
  check(`${tag}: the clusters cover no HUD panel, the minimap, the banner/ping, the speaker, ☰ or the Chat button`, hits.length === 0 && !!L.chatOpen, hits.join("; ") || `pad ${boxText(L.pad)}, weapons ${boxText(L.weapons)}, chat ${L.chatOpen ? boxText(L.chatOpen) : "none"}, view ${boxText(L.view)}`);
  if (h > w) {
    check(`${tag}: portrait: the view at the top under the speaker and ☰, the clusters in the space under it`, L.view.top >= L.menu.top + L.menu.height && L.pad.top >= L.view.top + L.view.height && L.weapons.top >= L.view.top + L.view.height, `view ${boxText(L.view)}, ☰ bottom ${Math.round(L.menu.top + L.menu.height)}`);
  }
  check(`${tag}: touch-action none on the view and the pad only (the stage and the chat log keep theirs)`, L.touchAction[0] === "none" && L.touchAction[1] === "none" && L.touchAction[2] === "none" && L.touchAction[3] !== "none" && L.touchAction[4] !== "none", `#view, pad, weapons, #stage, chat log: ${L.touchAction.join(", ")}`);
  await d.fingers.liftAll();
  // No zoom or scroll: a pinch on the view and on the pad, a double tap on the view, a swipe up.
  const [vx, vy] = centre(L.view);
  const [px, py] = centre(L.pad);
  for (const [what, x, y, scale] of [["view", vx, vy, 2.5], ["pad", px, py, 2]] as const) {
    try {
      await d.cdp.send("Input.synthesizePinchGesture", { x: Math.round(x), y: Math.round(y), scaleFactor: scale, gestureSourceType: "touch" });
    } catch (e) {
      const m = await d.cdp.send("Page.getLayoutMetrics");
      throw new Error(`pinch on the ${what} at ${Math.round(x)},${Math.round(y)}: ${String(e)}; layout metrics ${JSON.stringify(m).slice(0, 600)}`);
    }
  }
  for (let i = 0; i < 2; i++) {
    await d.fingers.at(TAP, vx, vy);
    await d.fingers.lift(TAP);
    await sleep(60);
  }
  await d.cdp.send("Input.synthesizeScrollGesture", { x: Math.round(vx), y: Math.round(vy), yDistance: -300, gestureSourceType: "touch" });
  await sleep(400);
  const after = await d.cdp.eval<Layout>(LAYOUT);
  if (tag === "look portrait") {
    // The pause banner in touch words (the host): ☰, Pause race; the banner on the canvas says "tap Menu".
    await d.tap("#menu-btn");
    await sleep(150);
    const menuState = await d.cdp.eval<string>(`JSON.stringify({ open: !document.getElementById('game-menu').classList.contains('hidden'), keys: [...document.querySelectorAll('#game-menu [data-key]')].map((b) => b.dataset.key), scale: visualViewport.scale, btn: document.getElementById('menu-btn').getBoundingClientRect().toJSON() })`);
    if (!(await d.box('.gm [data-key="pause"]'))) throw new Error(`no Pause in the menu: ${menuState}`);
    await d.tap('.gm [data-key="pause"]');
    await sleep(300);
    if (!(await d.cdp.eval<boolean>(`document.getElementById('game-menu').classList.contains('hidden')`))) await d.tap('.gm [data-key="resume"]');
    await sleep(400);
    await d.shot("paused-portrait-390x844");
  }
  // Last (it leaves the page zoomed): the control, the same pinch on the bare stage (touch-action auto
  // there, so the lobby and the chat scroll) does zoom.
  // (Both of the pinch's fingers must start on the stage: Chrome takes the touch-action both allow.)
  const [sx, sy] = h > w ? [w / 2, (L.view.top + L.view.height + (L.chatOpen ? L.chatOpen.top : L.pad.top)) / 2] : [L.view.left / 2, 120];
  const bare = await d.cdp.eval<string>(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e.id || e.className || e.tagName; })()`);
  await d.cdp.send("Input.synthesizePinchGesture", { x: Math.round(sx), y: Math.round(sy), scaleFactor: 2.5, gestureSourceType: "touch" });
  await sleep(300);
  const zoomed = await d.cdp.eval<number>("visualViewport.scale");
  check(
    `${tag}: a pinch on the view and on the pad, a double tap and a swipe on the view: no zoom, no scroll (the same pinch on the bare stage does zoom)`,
    after.scale === 1 && after.scroll[0] === 0 && after.scroll[1] === 0 && zoomed > 1.2,
    `scale ${after.scale}, scroll ${after.scroll.join(",")}; control on ${bare} at ${Math.round(sx)},${Math.round(sy)}: scale ${zoomed.toFixed(2)}`,
  );
}

async function desktop(d: PageDriver): Promise<void> {
  await d.device(1280, 720, false);
  await d.load("");
  const env = await d.cdp.eval<{ coarse: boolean; touch: boolean; help: string }>(
    `({ coarse: matchMedia('(pointer: coarse)').matches, touch: document.getElementById('stage').classList.contains('touch'), help: getComputedStyle(document.querySelector('.keys-keyboard')).display })`,
  );
  check("desktop: no coarse pointer, touch not in use, the key help shows the keys", !env.coarse && !env.touch && env.help === "block", JSON.stringify(env));
  await d.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 }).catch(() => undefined);
  const b = (await d.box("#create"))!;
  for (const type of ["mousePressed", "mouseReleased"]) await d.cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), button: "left", clickCount: 1 });
  await d.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
  const s = (await d.box("#start"))!;
  for (const type of ["mousePressed", "mouseReleased"]) await d.cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(s.left + s.width / 2), y: Math.round(s.top + s.height / 2), button: "left", clickCount: 1 });
  await d.until("the countdown", "document.getElementById('lobby').classList.contains('hidden')");
  let seen = false;
  for (let i = 0; i < 40; i++) {
    seen ||= await d.shown();
    await sleep(100);
  }
  check("desktop: the pad never shows in the countdown and the race (4 s polled)", !seen);
  await d.shot("race-desktop-1280x720");
}

async function main(): Promise<void> {
  // Each pass in a browser of its own: after a long pass Chrome's input emulation can be left with
  // bounds that do not match the emulated screen (Input.synthesizePinchGesture answered "Position
  // out of bounds" inside it, and touches reached the page no more); a fresh browser has none of that.
  const passes: [string, (d: PageDriver) => Promise<void>][] = [
    ["drive-portrait", drivePortrait],
    ["drive-landscape", driveLandscape],
    ["look-portrait", (d) => look(d, "look portrait", 390, 844)],
    ["look-landscape", (d) => look(d, "look landscape", 844, 390)],
    ["look-small", (d) => look(d, "look small", 360, 740)],
    ["desktop", desktop],
  ];
  for (const [name, pass] of passes) {
    if (!ONLY.includes(name)) continue;
    console.log(`\n# ${name}`);
    let cdp: Cdp | null = null;
    try {
      await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
      cdp = await Cdp.open(await ab(["get", "cdp-url"]));
      await pass(new PageDriver(cdp));
    } catch (e) {
      check(`${name} threw`, false, String(e));
    } finally {
      if (cdp) check(`${name}: no page errors`, cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 5).join(" | "));
      cdp?.close();
      await ab(["close"]).catch(() => undefined);
    }
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
