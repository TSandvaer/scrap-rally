// The touch controls in a real browser (TOUCH-1, TOUCH-2 stick; PLAN-TOUCH): headless Chrome from
// the agent-browser CLI, with touch emulated over the browser's own DevTools socket (agent-browser
// `get cdp-url`; the repo's `ws` speaks the protocol). agent-browser's `set device` changes the
// user agent and the viewport only (no touch, `(pointer: coarse)` stays false); the protocol's
// Emulation.setTouchEmulationEnabled makes `(pointer: coarse)` true and Input.dispatchTouchEvent
// puts several fingers down at once (one pointer id each), so this tool drives with two thumbs.
//
// Passes (all by default, or --only a,b):
//   drive-portrait   390x844, ?debug=1: in the countdown the stick by itself (the centre where the
//                    thumb lands, the knob following within R with its gas/brake/neutral colour, a
//                    sweep through gas, the diagonals, steer and brake/reverse, a second finger in the
//                    zone ignored, a landing at the edge shifted in, lifting hides it); then laps
//                    driven by the stick only (one thumb: gas and a fractional steer at once, brakes,
//                    reverses when stuck), every settled step's Controls checked against the stick's
//                    own function of the thumb's offset; gas + FIRE with two thumbs; MINE taps; the
//                    menu and the chat hide and clear the stick, a driving key hides it, the finished
//                    car and the results hide it.
//   drive-landscape  844x390, ?debug=1: the same countdown checks and a lap, then Retire to garage hides it.
//   tune-portrait / tune-landscape  390x844 / 844x390, ?debug=1: the TUNE button opens the tuning
//                    panel (it keeps the stick's zone free), a slider dragged by a second finger while
//                    the thumb holds the stick changes the step's Controls at once (screenshots of the
//                    panel open); portrait also: the values are stored and back after a reload, bad
//                    stored values are ignored, Defaults resets them; without ?debug=1 no panel and
//                    the stored values are not used.
//   look-portrait / look-landscape / look-small (360x740): no debug (production layout): the
//                    lobby (no controls), the countdown's DRIVE hint, the race with the stick held at
//                    gas+right (green), brake (red) and steer only (grey) with FIRE held (screenshots),
//                    the stick's zone (right of the split, under the speaker and ☰ to the bottom, over
//                    the view, drawing nothing), the weapons and the Chat button against the HUD,
//                    minimap, banner/ping, speaker and ☰; the Chat button tappable (no zone over it);
//                    no scroll or zoom from a pinch or a double tap on the view or the zone; portrait
//                    also the pause banner's touch wording.
//   desktop          1280x720 with no touch: the controls never show in a race.
// Each pass runs in a browser of its own (see main()). Needs the dev server: PORT=3006 npm run dev.
// Exit code 1 if a check fails.
//   npx tsx tools/debug/touch-drive.ts --url http://127.0.0.1:3006 --out tmp/touch-drive
//   (--only drive-portrait,look-small  --laps n: drive-portrait's laps  --no-mid: skip its mid-race
//   menu/chat/key checks  --session name: the agent-browser session, "stick-drive")

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { STICK_DEFAULTS, stickCentre, stickControls, type StickParams } from "../../client/input";
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
const SESSION = arg("session", "stick-drive");
const OUT = path.resolve(arg("out", "tmp/touch-drive"));
const ONLY = arg("only", "drive-portrait,drive-landscape,tune-portrait,tune-landscape,look-portrait,look-landscape,look-small,desktop").split(",");
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
 * id reused from an earlier page as still down and sent no pointer events for it. Positions are
 * whole CSS pixels (as sent), so the tool knows exactly where each finger is.
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
  /** Where a finger is (whole px), or null. */
  where(id: number): [number, number] | null {
    const p = this.down.get(id);
    return p ? [p.x, p.y] : null;
  }
}

// Finger ids: the right thumb on the stick, the left on FIRE, others for taps and a second finger.
const RIGHT = 1, LEFT = 2, TAP = 3, EXTRA = 4;

interface Box { left: number; top: number; width: number; height: number }
const centre = (b: Box): [number, number] => [b.left + b.width / 2, b.top + b.height / 2];
const overlap = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const boxText = (b: Box) => `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;

// ---- the page -----------------------------------------------------------------------

/** The stick as the page shows it: the gate shown, its centre (from its transform), the knob's offset and colour. */
interface StickView { on: boolean; held: boolean; cx: number; cy: number; kx: number; ky: number; colour: string; baseStyle: string; knobStyle: string }
const STICK_VIEW = `(() => {
  const z = document.getElementById('touch-stick').getBoundingClientRect();
  const base = document.getElementById('touch-base'), knob = document.getElementById('touch-knob');
  const t = (el) => { const m = /translate3d\\(([-0-9.]+)px, ([-0-9.]+)px/.exec(el.style.transform); return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]; };
  const [bx, by] = t(base), [kx, ky] = t(knob);
  return { on: base.classList.contains('on'), held: document.getElementById('touch-stick').classList.contains('held'), cx: z.left + bx, cy: z.top + by, kx, ky,
    colour: knob.classList.contains('gas') ? 'gas' : knob.classList.contains('brake') ? 'brake' : 'neutral', baseStyle: base.getAttribute('style') || '', knobStyle: knob.getAttribute('style') || '' };
})()`;

class PageDriver {
  readonly fingers: Fingers;
  /** Where the right thumb set the stick's centre (worked out as the page does: stickCentre). */
  stick: { cx: number; cy: number } | null = null;
  params: StickParams = { ...STICK_DEFAULTS };
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

  view(): Promise<StickView> {
    return this.cdp.eval<StickView>(STICK_VIEW);
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

  /** Where a thumb rests on the stick's zone: across the middle, low (portrait: under the view). */
  async rest(): Promise<[number, number]> {
    const z = (await this.box("#touch-stick"))!;
    return [Math.round(z.left + z.width / 2), Math.round(z.top + z.height * 0.7)];
  }

  /** The right thumb lands at (x, y): the stick's centre is set there (or shifted in, as the page does). */
  async thumbDown(x: number, y: number): Promise<void> {
    const stage = (await this.box("#stage"))!;
    await this.fingers.at(RIGHT, x, y);
    const [fx, fy] = this.fingers.where(RIGHT)!;
    const [cx, cy] = stickCentre(fx, fy, stage, this.params);
    this.stick = { cx, cy };
  }

  /** The right thumb slides to the stick's centre plus (dx, dy). */
  async thumbAt(dx: number, dy: number): Promise<void> {
    const s = this.stick!;
    await this.fingers.at(RIGHT, s.cx + dx, s.cy + dy);
  }

  async thumbUp(): Promise<void> {
    await this.fingers.lift(RIGHT);
    this.stick = null;
  }

  /** What the stick should give for where the right thumb is now (the page's own function). */
  expected(): [number, number] {
    const [fx, fy] = this.fingers.where(RIGHT)!;
    return stickControls(fx - this.stick!.cx, fy - this.stick!.cy, this.params);
  }
}

// ---- driving by touch ----------------------------------------------------------------

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

/** The thumb's sideways offset that gives steer `s` (the inverse of the stick's curve), in px. */
function steerOffset(s: number, p: StickParams): number {
  if (Math.abs(s) < 0.03) return 0;
  const u = Math.min(1, Math.abs(s)) ** (1 / p.steerCurve);
  return Math.sign(s) * p.radius * (p.steerDead + u * (p.steerLock - p.steerDead));
}

/** The steer levels the controller uses (so the thumb settles between changes and samples can be checked). */
const LEVELS = [-1, -0.7, -0.4, -0.2, 0, 0.2, 0.4, 0.7, 1];

/** What the controller wants: [throttle, steer level]: aim along the track ahead, steer in proportion, brake for a sharp bend. */
function want(track: Track, p: Pose, stuck: boolean): [number, number] {
  const q = queryTrackNear(track, p.x, p.y, p.seg);
  const speed = Math.hypot(p.vx, p.vy);
  const aim = pointAt(track, q.s + 70 + speed * 0.12);
  const err = angleDiff(p.h, Math.atan2(aim.y - p.y, aim.x - p.x));
  const raw = Math.max(-1, Math.min(1, err * 3));
  const level = LEVELS.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  if (stuck) return [-1, -level || 1]; // reverse, wheel the other way
  return [Math.abs(err) > 0.75 && speed > 160 ? -1 : 1, level];
}

interface DriveLog {
  laps: number; samples: number; matched: number; mismatched: string[]; gasSteer: number; fractional: number; brake: number; brakeSteer: number; levels: Set<number>;
  fireBursts: number; fireWithStick: number; rivetsUsed: number; mineTaps: number; minesStepped: number; minesUsed: number; stuckTurns: number; brakeTests: number; seconds: number;
}

/**
 * Drive by touch until `laps` are done (or the car finished). The right thumb lands once on the
 * stick and slides: up for gas (or down to brake), sideways by the steer it wants, both at once.
 * Once a lap it brakes with steer for half a second; every few seconds the left thumb holds FIRE for
 * a while (two fingers down); once a lap a third finger taps MINE. After the controls settle, each
 * sample checks the step's Controls are exactly the stick's output for the thumb's offset (and FIRE).
 */
async function drive(d: PageDriver, laps: number, midRace?: (lap: number) => Promise<void>): Promise<DriveLog> {
  const log: DriveLog = { laps: 0, samples: 0, matched: 0, mismatched: [], gasSteer: 0, fractional: 0, brake: 0, brakeSteer: 0, levels: new Set(), fireBursts: 0, fireWithStick: 0, rivetsUsed: 0, mineTaps: 0, minesStepped: 0, minesUsed: 0, stuckTurns: 0, brakeTests: 0, seconds: 0 };
  let p = await d.cdp.eval<Pose>(POSE);
  const track = findTrack(p.track);
  if (!track) throw new Error(`unknown track ${p.track}`);
  const t0 = Date.now();
  const P = d.params;
  const gasDy = -Math.round(P.radius * Math.min(0.9, P.throttleDead + 0.3)); // well past the dead zone, inside R
  let cmd = "", settled = 0, slow = 0, stuckUntil = 0, nextFire = Date.now() + 3000, fireUntil = 0, mineLap = -1, midLap = -1, brakeLap = -1, brakeUntil = 0, lapStart = Date.now(), lapSeen = p.lap;
  let fireAmmo0 = 0, mineAmmo0 = 0, mineSteps0 = 0;
  while (Date.now() - t0 < 360_000) {
    p = await d.cdp.eval<Pose>(POSE);
    if (p.fin || p.lap >= laps || (p.phase !== "racing" && p.phase !== "countdown")) break;
    const now = Date.now();
    if (p.lap !== lapSeen) {
      lapSeen = p.lap;
      lapStart = now;
    }
    const speed = Math.hypot(p.vx, p.vy);
    if (p.phase === "racing" && !p.wreck && speed < 25) slow++;
    else slow = 0;
    if (slow > 50 && now > stuckUntil) {
      stuckUntil = now + 900;
      log.stuckTurns++;
      slow = 0;
    }
    let [thr, lvl] = want(track, p, now < stuckUntil);
    // Once a lap, 5 s in: brake with the wheel turned for half a second (a diagonal down).
    if (p.phase === "racing" && p.lap > brakeLap && now - lapStart > 5000 && speed > 120 && now >= stuckUntil) {
      brakeLap = p.lap;
      brakeUntil = now + 500;
      log.brakeTests++;
    }
    if (now < brakeUntil) [thr, lvl] = [-1, lvl || 0.4];
    const key = `${thr}/${lvl}`;
    if (!d.stick) {
      await d.thumbDown(...(await d.rest()));
      cmd = "";
    }
    if (key !== cmd) {
      await d.thumbAt(Math.round(steerOffset(lvl, P)), thr > 0 ? gasDy : thr < 0 ? -gasDy : 0);
      cmd = key;
      settled = 0;
      log.levels.add(lvl);
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
      const [t, s] = d.expected();
      const fire = d.fingers.has(LEFT);
      if (p.last.throttle === t && p.last.steer === s && p.last.fire === fire) {
        log.matched++;
        if (t === 1 && s !== 0) log.gasSteer++;
        if (s !== 0 && Math.abs(s) < 1) log.fractional++;
        if (t === -1) log.brake++;
        if (t === -1 && s !== 0) log.brakeSteer++;
        if (fire && t !== 0) log.fireWithStick++;
      } else if (log.mismatched.length < 8) log.mismatched.push(`want ${t}/${s} fire ${fire} -> ${JSON.stringify(p.last)}`);
    }
    if (midRace && p.lap >= 1 && midLap < 0 && p.phase === "racing" && !d.fingers.has(LEFT)) {
      midLap = p.lap;
      await midRace(p.lap);
      cmd = "";
    }
    await sleep(25);
  }
  log.laps = p.lap;
  log.seconds = Math.round((Date.now() - t0) / 1000);
  await d.fingers.liftAll();
  d.stick = null;
  return log;
}

/**
 * In the countdown (main.ts hands every step's Controls to Game.step, which ignores them until GO,
 * so the car stays put): the stick by itself. The thumb lands: the gate shows with its centre there,
 * nothing held; it slides round gas, the diagonals, steer, brake and back, each stop's Controls the
 * stick's output, the knob within R and coloured; a second finger in the zone changes nothing;
 * lifting hides it; a landing at the zone's right edge is shifted in.
 */
async function stickChecks(d: PageDriver, tag: string): Promise<void> {
  const R = d.params.radius;
  const [rx, ry] = await d.rest();
  await d.thumbDown(rx, ry);
  await sleep(90);
  const v0 = await d.view();
  const l0 = (await d.cdp.eval<Pose>(POSE)).last;
  check(
    `${tag}: a thumb landing in the stick's zone shows the gate centred where it landed, the knob on it (neutral colour), nothing held`,
    v0.on && v0.held && Math.abs(v0.cx - rx) < 0.6 && Math.abs(v0.cy - ry) < 0.6 && v0.kx === 0 && v0.ky === 0 && v0.colour === "neutral" && !!l0 && l0.throttle === 0 && l0.steer === 0,
    `landed ${rx},${ry}; gate centre ${v0.cx.toFixed(1)},${v0.cy.toFixed(1)}, knob ${v0.kx},${v0.ky} ${v0.colour}; ${JSON.stringify(l0)}`,
  );
  // Round the gate: up (gas), up-right, right, down-right, down (brake), down-left, left, up-left,
  // far up-right (past R, still on screen: the knob stops on R), and back to the centre.
  const k = Math.round(R * 0.6);
  const stops: [string, number, number][] = [["up", 0, -k], ["up-right", Math.round(R * 0.4), -k], ["right", k, 0], ["down-right", Math.round(R * 0.4), k], ["down", 0, k], ["down-left", -Math.round(R * 0.4), k], ["left", -k, 0], ["up-left", -Math.round(R * 0.4), -k], ["far up-right", Math.round(R * 1.2), -Math.round(R * 1.5)], ["centre", 0, 0]];
  const got: string[] = [];
  let ok = true;
  let fractionalWithGas = false;
  for (const [name, dx, dy] of stops) {
    await d.thumbAt(dx, dy);
    await sleep(90);
    const last = (await d.cdp.eval<Pose>(POSE)).last;
    const v = await d.view();
    const [t, s] = d.expected();
    const knobR = Math.hypot(v.kx, v.ky);
    const colour = t > 0 ? "gas" : t < 0 ? "brake" : "neutral";
    const stopOk = !!last && last.throttle === t && last.steer === s && knobR <= R + 0.11 && v.colour === colour && Math.abs(v.cx - d.stick!.cx) < 0.6;
    ok &&= stopOk;
    if (t === 1 && s !== 0 && Math.abs(s) < 1) fractionalWithGas = true;
    got.push(`${name}:${last ? `${last.throttle}/${last.steer}` : "-"} knob ${knobR.toFixed(0)} ${v.colour}${stopOk ? "" : " (want " + t + "/" + s + " " + colour + ")"}`);
  }
  const styles = await d.view();
  check(
    `${tag}: one thumb slides round the gate: each stop's step Controls are the stick's output for the thumb's offset (gas/brake by up/down, steer in proportion; the diagonals both), the knob within R and coloured gas/brake/neutral; the gate stays put`,
    ok && fractionalWithGas,
    got.join(" | "),
  );
  check(`${tag}: the gate and the knob are moved by transform only (their inline style is the transform)`, /^transform: translate3d\([^)]*\);$/.test(styles.knobStyle) && /^transform: translate3d\([^)]*\);$/.test(styles.baseStyle), `gate "${styles.baseStyle}", knob "${styles.knobStyle}"`);
  // A second finger landing in the zone while the thumb holds gas+right: ignored.
  await d.thumbAt(Math.round(R * 0.4), -k);
  await sleep(90);
  const before = (await d.cdp.eval<Pose>(POSE)).last;
  const z = (await d.box("#touch-stick"))!;
  await d.fingers.at(EXTRA, z.left + z.width * 0.25, z.top + z.height * 0.4);
  await sleep(60);
  await d.fingers.at(EXTRA, z.left + z.width * 0.25 + 40, z.top + z.height * 0.4 + 40);
  await sleep(90);
  const during = (await d.cdp.eval<Pose>(POSE)).last;
  const vDuring = await d.view();
  await d.fingers.lift(EXTRA);
  await sleep(90);
  const afterExtra = (await d.cdp.eval<Pose>(POSE)).last;
  check(
    `${tag}: a second finger landing and moving in the zone while the thumb holds the stick changes nothing (the gate stays, the Controls stay)`,
    JSON.stringify(before) === JSON.stringify(during) && JSON.stringify(during) === JSON.stringify(afterExtra) && Math.abs(vDuring.cx - d.stick!.cx) < 0.6 && Math.abs(vDuring.cy - d.stick!.cy) < 0.6,
    `${JSON.stringify(before)} / ${JSON.stringify(during)} / ${JSON.stringify(afterExtra)}`,
  );
  // Lifting: the gate fades (not shown), nothing held.
  await d.thumbUp();
  await sleep(90);
  const vUp = await d.view();
  const lUp = (await d.cdp.eval<Pose>(POSE)).last;
  check(`${tag}: lifting the thumb hides the stick (the gate off) and lets go (no gas, no steer)`, !vUp.on && !vUp.held && !!lUp && lUp.throttle === 0 && lUp.steer === 0, `gate on ${vUp.on}; ${JSON.stringify(lUp)}`);
  // A landing 6 px from the screen's right edge: the centre shifts in so full lock stays reachable.
  const stage = (await d.box("#stage"))!;
  const ex = stage.left + stage.width - 6;
  await d.thumbDown(ex, ry);
  await sleep(90);
  const vEdge = await d.view();
  const shiftWant = stage.left + stage.width - (R * d.params.steerLock + 8);
  await d.fingers.at(RIGHT, stage.left + stage.width - 1, ry);
  await sleep(90);
  const lEdge = (await d.cdp.eval<Pose>(POSE)).last;
  check(
    `${tag}: a thumb landing at the right edge sets the centre inward (full-lock reach + 8 px from the edge), so sliding to the edge still gives full lock`,
    Math.abs(vEdge.cx - shiftWant) < 0.6 && Math.abs(vEdge.cy - ry) < 0.6 && !!lEdge && lEdge.steer === 1,
    `landed ${ex}; centre ${vEdge.cx.toFixed(1)} (want ${shiftWant.toFixed(1)}); at the edge ${JSON.stringify(lEdge)}`,
  );
  await d.thumbUp();
  await sleep(60);
}

function reportDrive(tag: string, log: DriveLog, laps: number): void {
  check(`${tag}: ${laps} lap(s) driven by the stick only (one right thumb: up for gas, sideways to steer, both at once)`, log.laps >= laps, `${log.laps} laps in ${log.seconds} s, steer levels used ${[...log.levels].sort((a, b) => a - b).join(",")}, ${log.stuckTurns} unstick reverses`);
  check(
    `${tag}: every settled sample, the step's Controls are exactly the stick's output for the thumb's offset (+ FIRE while the left thumb holds it)`,
    log.samples > 100 && log.mismatched.length === 0,
    `${log.matched}/${log.samples}${log.mismatched.length ? `; ${log.mismatched.join(" | ")}` : ""}`,
  );
  check(
    `${tag}: gas and steer at once from one thumb, often with a fractional steer; brake/reverse with steer (diagonals down) too`,
    log.gasSteer > 50 && log.fractional > 50 && log.brakeSteer > 0 && log.brakeTests > 0,
    `${log.gasSteer} samples gas+steer, ${log.fractional} with a fractional steer, ${log.brake} brake/reverse (${log.brakeSteer} with steer), ${log.brakeTests} brake tests`,
  );
  check(`${tag}: two thumbs at once: FIRE held while the stick drives (samples with throttle and fire both), rivets fired`, log.fireWithStick > 10 && log.rivetsUsed > 0, `${log.fireBursts} bursts, ${log.fireWithStick} samples gas+fire, ${log.rivetsUsed} rivets`);
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
  d.params = await d.cdp.eval<StickParams>("scrapDebug.touchPad.stickParams()");
  check("drive portrait: the page's stick parameters are the defaults (nothing stored)", JSON.stringify(d.params) === JSON.stringify(STICK_DEFAULTS), JSON.stringify(d.params));
  check("drive portrait: no controls on the main menu", !(await d.shown()));
  await d.tap("#create");
  await d.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
  await sleep(300);
  check("drive portrait: no controls in the lobby (garage)", !(await d.shown()));
  await d.buyAmmo();
  await d.tap("#bot-easy");
  await d.until("the bot", "document.querySelectorAll('#lobby-players li').length === 2");
  await d.tap("#start");
  await d.until("the countdown", "window.scrapDebug.game.phase === 'countdown'");
  await d.cdp.eval(PATCH_STEP);
  await sleep(200);
  check("drive portrait: the controls show in the countdown, the stick's DRIVE hint with them", (await d.shown()) && (await d.cdp.eval<boolean>(`document.getElementById('touch-stick').classList.contains('hint')`)));
  await stickChecks(d, "drive portrait");
  await d.until("the race", "window.scrapDebug.game.phase === 'racing'", 10_000);
  await sleep(100);
  check("drive portrait: at GO the hint goes", !(await d.cdp.eval<boolean>(`document.getElementById('touch-stick').classList.contains('hint')`)));

  const mid = async () => {
    const key = (k: string) => d.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', code: '${k}' })), true`);
    const gas = async () => {
      await d.thumbDown(...(await d.rest()));
      await d.thumbAt(0, -Math.round(d.params.radius * 0.6));
    };
    // The menu opens (Esc) with the gas thumb down: the controls hide, the stick goes; closed again,
    // the thumb still down drives nothing until it is put down again (clear on open and on every hide).
    // (A tap of a second finger makes no click while another is down, so Esc stands in here.)
    await gas();
    await sleep(150);
    const before = await d.cdp.eval<Pose>(POSE);
    await key("Escape");
    await sleep(150);
    const inMenu = await d.cdp.eval<Pose>(POSE);
    const gateInMenu = await d.view();
    await key("Escape");
    await sleep(200);
    const back = await d.cdp.eval<Pose>(POSE);
    check(
      "drive portrait: the menu opening hides the controls and lets go of the held thumb (the gate off); closed, they are back and that thumb (still down) drives nothing",
      before.last?.throttle === 1 && before.shown && !inMenu.shown && inMenu.last?.throttle === 0 && !gateInMenu.on && back.shown && back.last?.throttle === 0,
      `before shown ${before.shown} throttle ${before.last?.throttle}; menu shown ${inMenu.shown} throttle ${inMenu.last?.throttle} gate ${gateInMenu.on}; back shown ${back.shown} throttle ${back.last?.throttle}`,
    );
    await d.thumbUp();
    // ☰ and Resume by touch (one finger): the menu opens and closes, the controls hide and come back.
    await d.tap("#menu-btn");
    await sleep(150);
    const menuShown = await d.shown();
    const menuOpen = await d.cdp.eval<boolean>(`!document.getElementById('game-menu').classList.contains('hidden')`);
    await d.tap('.gm [data-key="resume"]');
    await sleep(200);
    check("drive portrait: a tap on ☰ opens the menu (no controls); Resume tapped closes it (controls back)", menuOpen && !menuShown && (await d.shown()), `menu ${menuOpen}, controls in menu ${menuShown}`);
    // The chat opening (Enter) with the gas thumb down: no controls, throttle 0; Esc closes it.
    await gas();
    await sleep(150);
    await key("Enter");
    await sleep(150);
    const chatOpen = await d.cdp.eval<Pose>(POSE);
    await key("Escape");
    await sleep(200);
    const chatShut = await d.cdp.eval<Pose>(POSE);
    await d.thumbUp();
    check(
      "drive portrait: opening the chat hides the controls and lets go of the held thumb (throttle 0); closing it shows them again",
      !chatOpen.shown && chatOpen.last?.throttle === 0 && chatShut.shown && chatShut.last?.throttle === 0,
      `chat open: shown ${chatOpen.shown} throttle ${chatOpen.last?.throttle}; closed: shown ${chatShut.shown} throttle ${chatShut.last?.throttle}`,
    );
    // The moved Chat button and Close by touch.
    await d.tap("#chat .chat-open");
    await sleep(150);
    const tappedOpen = await d.cdp.eval<{ open: boolean; shown: boolean }>(`({ open: document.getElementById('chat').classList.contains('open'), shown: !document.getElementById('touch').classList.contains('hidden') })`);
    await d.tap("#chat .chat-close");
    await sleep(200);
    check("drive portrait: a tap on the (moved) Chat button opens the chat (no controls); Close tapped brings them back", tappedOpen.open && !tappedOpen.shown && (await d.shown()), JSON.stringify(tappedOpen));
    // A driving key (a tablet's keyboard): the controls hide; a finger on the screen brings them back.
    await key("ArrowUp");
    await sleep(120);
    const keyed = await d.cdp.eval<Pose>(POSE);
    await d.cdp.eval(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', code: 'ArrowUp' })), true`);
    const view = (await d.box("#view"))!;
    await d.fingers.at(TAP, view.left + view.width / 4, view.top + view.height / 2);
    await d.fingers.lift(TAP);
    await sleep(120);
    const touchedAgain = await d.shown();
    check("drive portrait: a driving keydown hides the controls (and drives: throttle 1); a touch on the view shows them again", !keyed.shown && keyed.last?.throttle === 1 && touchedAgain, `after key: shown ${keyed.shown} throttle ${keyed.last?.throttle}; after a touch: ${touchedAgain}`);
  };
  const log = await drive(d, LAPS, MID ? mid : undefined);
  reportDrive("drive portrait", log, LAPS);
  if (LAPS < 3) return;
  await d.until("our finish", "(window.scrapDebug.game.ownSnap()?.fin ?? 0) > 0", 20_000).catch(() => undefined);
  await sleep(150);
  const fin = await d.cdp.eval<Pose>(POSE);
  check("drive portrait: our car finished: the controls hide (the race goes on for the others)", fin.fin > 0 && !fin.shown && fin.phase === "racing", `fin ${fin.fin}, phase ${fin.phase}, shown ${fin.shown}`);
  await d.until("the results", "window.scrapDebug.game.phase === 'results'", 120_000);
  await sleep(200);
  check("drive portrait: no controls on the results", !(await d.shown()));
}

async function driveLandscape(d: PageDriver): Promise<void> {
  await d.device(844, 390, true);
  await d.load("?debug=1");
  check("drive landscape: matchMedia('(pointer: coarse)') under touch emulation", await d.cdp.eval<boolean>(`matchMedia('(pointer: coarse)').matches`));
  d.params = await d.cdp.eval<StickParams>("scrapDebug.touchPad.stickParams()");
  await d.race();
  await d.cdp.eval(PATCH_STEP);
  await stickChecks(d, "drive landscape");
  await d.until("the race", "window.scrapDebug.game.phase === 'racing'", 10_000);
  const log = await drive(d, 1);
  reportDrive("drive landscape", log, 1);
  // Retire to garage (the menu): the garage opens while the race runs on; no controls.
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
  check("drive landscape: retired to the garage mid-race: no controls", g.retired && g.lobby && g.phase === "racing" && !g.shown, JSON.stringify(g));
}

/** The tuning panel (?debug=1): opens from TUNE, changes the feel live; portrait also: persists, resets, not without debug. */
async function tune(d: PageDriver, w: number, h: number): Promise<void> {
  {
    const tag = `tune ${w}x${h}`;
    await d.device(w, h, true);
    await d.load("?debug=1");
    await d.cdp.eval(`localStorage.removeItem('scrap-rally:stick'), true`);
    await d.load("?debug=1");
    d.params = await d.cdp.eval<StickParams>("scrapDebug.touchPad.stickParams()");
    check(`${tag}: no TUNE button outside a race`, !(await d.box(".tune-btn")));
    await d.race();
    await d.cdp.eval(PATCH_STEP);
    await d.until("the controls", "!document.getElementById('touch').classList.contains('hidden')", 5000);
    await d.tap(".tune-btn");
    await sleep(150);
    const L = await d.cdp.eval<{ panel: Box | null; zone: Box; split: string; text: string; tuning: boolean; ranges: number }>(`(() => {
      const b = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
      return { panel: b(document.getElementById('tune-panel')), zone: b(document.getElementById('touch-stick')), split: getComputedStyle(document.getElementById('touch-stick')).boxShadow,
        text: document.querySelector('.tune-text').value, tuning: document.getElementById('stage').classList.contains('tuning'), ranges: document.querySelectorAll('.tune-range').length };
    })()`);
    const smallest = await d.cdp.eval<number>(`Math.min(...[...document.querySelectorAll('.tune-range')].map((e) => e.getBoundingClientRect().height))`);
    check(
      `${tag}: TUNE opens the panel: six big sliders (R, steer dead zone, full lock, curve, throttle dead zone, split), the values as text; it stays left of the stick's zone, whose split line shows`,
      !!L.panel && L.ranges === 6 && smallest >= 36 && L.panel.left + L.panel.width <= L.zone.left + 1 && L.tuning && L.text.includes("radius: 60") && L.text.includes("split: 0.5"),
      `panel ${L.panel ? boxText(L.panel) : "none"}, zone ${boxText(L.zone)}, sliders ${L.ranges} (smallest ${smallest} px), text ${L.text}`,
    );
    // Live while driving: the thumb holds gas + a little right; a second finger drags "Full lock at"
    // all the way left (0.2 R): the same thumb now gives full lock.
    await d.until("the race", "window.scrapDebug.game.phase === 'racing'", 10_000);
    await d.thumbDown(...(await d.rest()));
    await d.thumbAt(Math.round(d.params.radius * 0.35), -Math.round(d.params.radius * 0.6));
    await sleep(120);
    const before = (await d.cdp.eval<Pose>(POSE)).last;
    const sl = (await d.box('.tune-range[data-key="steerLock"]'))!;
    const y = Math.round(sl.top + sl.height / 2);
    const [x0] = [Math.round(sl.left + sl.width * ((d.params.steerLock - 0.2) / 0.8))];
    await d.fingers.at(EXTRA, x0, y);
    for (let x = x0; x >= sl.left - 10; x -= 12) {
      await d.fingers.at(EXTRA, x, y);
      await sleep(16);
    }
    await d.fingers.lift(EXTRA);
    await sleep(150);
    const after = (await d.cdp.eval<Pose>(POSE)).last;
    const live = await d.cdp.eval<{ lock: number; stored: string | null; shown: string; live: string }>(
      `({ lock: scrapDebug.touchPad.stickParams().steerLock, stored: localStorage.getItem('scrap-rally:stick'), shown: document.querySelector('.tune-range[data-key="steerLock"]').value, live: document.querySelector('.tune-live').textContent })`,
    );
    await d.shot(`tune-panel-${w}x${h}`);
    check(
      `${tag}: a second finger drags "Full lock at" down to 0.2 while the thumb holds the stick: the thumb's steer goes to full lock at once (live), the value is stored and shown`,
      !!before && before.throttle === 1 && before.steer > 0 && before.steer < 1 && !!after && after.throttle === 1 && after.steer === 1 && live.lock === 0.2 && !!live.stored && JSON.parse(live.stored).steerLock === 0.2 && live.shown === "0.2",
      `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}; ${JSON.stringify(live)}`,
    );
    await d.thumbUp();
    if (w > h) return;
    // Stored: back after a reload (?debug=1), and applied; the split moves the zone.
    await d.cdp.eval(`localStorage.setItem('scrap-rally:stick', JSON.stringify({ ...JSON.parse(localStorage.getItem('scrap-rally:stick')), radius: 80, split: 0.4 })), true`);
    await d.load("?debug=1");
    await sleep(300);
    const reloaded = await d.cdp.eval<StickParams>("scrapDebug.touchPad.stickParams()");
    check("tune: after a reload with ?debug=1 the stored values are applied (R 80, lock 0.2, split 0.4)", reloaded.radius === 80 && reloaded.steerLock === 0.2 && reloaded.split === 0.4, JSON.stringify(reloaded));
    // Bad stored data (out of range, not a number) is ignored value by value.
    await d.cdp.eval(`localStorage.setItem('scrap-rally:stick', JSON.stringify({ radius: 999, steerDead: 'x', steerLock: 0.5 })), true`);
    await d.load("?debug=1");
    await sleep(300);
    const bad = await d.cdp.eval<StickParams>("scrapDebug.touchPad.stickParams()");
    check("tune: stored values out of range or not numbers are ignored one by one (R and the dead zone default, the lock 0.5 kept)", bad.radius === STICK_DEFAULTS.radius && bad.steerDead === STICK_DEFAULTS.steerDead && bad.steerLock === 0.5, JSON.stringify(bad));
    // Without ?debug=1: no panel, no stored values (the gate's size is the default R) even with values stored.
    await d.cdp.eval(`localStorage.setItem('scrap-rally:stick', JSON.stringify({ radius: 100, split: 0.35 })), true`);
    await d.load("");
    await d.race();
    await d.until("the controls", "!document.getElementById('touch').classList.contains('hidden')", 5000);
    await d.thumbDown(...(await d.rest()));
    await sleep(120);
    const plain = await d.cdp.eval<{ tune: boolean; gate: number; zoneLeft: number; w: number }>(
      `({ tune: !!document.querySelector('.tune-btn'), gate: document.getElementById('touch-base').getBoundingClientRect().width, zoneLeft: document.getElementById('touch-stick').getBoundingClientRect().left, w: innerWidth })`,
    );
    await d.thumbUp();
    check(
      "tune: without ?debug=1 there is no TUNE button and the stored values are not used (gate 2 x the default R, the zone at the default split)",
      !plain.tune && Math.abs(plain.gate - 2 * STICK_DEFAULTS.radius) < 0.5 && Math.abs(plain.zoneLeft - plain.w * STICK_DEFAULTS.split) < 0.5,
      JSON.stringify(plain),
    );
    // Defaults (debug again): back to STICK_DEFAULTS, stored as such.
    await d.load("?debug=1");
    await d.race();
    await d.until("the controls", "!document.getElementById('touch').classList.contains('hidden')", 5000);
    await d.tap(".tune-btn");
    await sleep(100);
    await d.tap(".tune-buttons .btn:nth-child(2)");
    await sleep(100);
    const reset = await d.cdp.eval<{ p: StickParams; stored: string | null }>(`({ p: scrapDebug.touchPad.stickParams(), stored: localStorage.getItem('scrap-rally:stick') })`);
    check("tune: Defaults puts every value back to the shipped defaults (and stores them)", JSON.stringify(reset.p) === JSON.stringify(STICK_DEFAULTS) && !!reset.stored && JSON.stringify(JSON.parse(reset.stored)) === JSON.stringify(STICK_DEFAULTS), JSON.stringify(reset));
    await d.cdp.eval(`localStorage.removeItem('scrap-rally:stick'), true`);
  }
}

interface Layout {
  view: Box; stage: Box; zone: Box; weapons: Box; fire: Box; mine: Box; sound: Box; menu: Box; chatOpen: Box | null; chatHit: boolean; soundHit: boolean; menuHit: boolean;
  caps: Box[]; scroll: [number, number]; scale: number; touchAction: string[]; zoneLook: string; touchTop: number;
}
const LAYOUT = `(() => {
  const b = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const q = (s) => document.querySelector(s);
  const hit = (sel) => { const e = q(sel); if (!e) return false; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && e.contains(t); };
  const zs = getComputedStyle(q('#touch-stick'));
  return { view: b(q('#view')), stage: b(q('#stage')), zone: b(q('#touch-stick')), weapons: b(q('#touch-weapons')), fire: b(q('#touch-fire')), mine: b(q('#touch-mine')),
    sound: b(q('#sound-btn')), menu: b(q('#menu-btn')), chatOpen: b(q('#chat .chat-open')), chatHit: hit('#chat .chat-open'), soundHit: hit('#sound-btn'), menuHit: hit('#menu-btn'),
    caps: [...document.querySelectorAll('#touch .tcap')].map(b),
    scroll: [scrollX, scrollY], scale: visualViewport.scale,
    touchAction: ['#view', '#touch-stick', '#touch-weapons', '#stage', '.chat-log'].map((s) => q(s) ? getComputedStyle(q(s)).touchAction : '-'),
    zoneLook: zs.backgroundColor + ' / ' + zs.borderLeftWidth + ' / ' + zs.boxShadow + ' / ' + zs.backgroundImage,
    touchTop: parseFloat(getComputedStyle(q('#stage')).getPropertyValue('--touch-top')) };
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
  const size = `${w}x${h}`;
  const orient = tag.split(" ")[1];
  await d.device(w, h, true);
  await d.load("");
  if (tag === "look portrait") await d.shot("menu-portrait-390x844"); // the key help in touch words
  await d.tap("#create");
  await d.until("the lobby", "!document.getElementById('lobby').classList.contains('hidden')");
  await sleep(400);
  check(`${tag}: no controls in the lobby`, !(await d.shown()));
  if (tag === "look portrait") await d.shot("lobby-portrait-390x844");
  await d.buyAmmo();
  await d.tap("#bot-easy");
  await d.until("the bot", "document.querySelectorAll('#lobby-players li').length === 2");
  await d.tap("#start");
  await d.until("the countdown", "document.getElementById('lobby').classList.contains('hidden')");
  await d.until("the controls", "!document.getElementById('touch').classList.contains('hidden')", 5000);
  await sleep(300);
  // The countdown's DRIVE hint: where it is (a 2R box at 50% / 62% of the zone) against the HUD.
  const Lc = await d.cdp.eval<Layout>(LAYOUT);
  const R = STICK_DEFAULTS.radius;
  const hint: Box = { left: Lc.zone.left + Lc.zone.width / 2 - R, top: Lc.zone.top + Lc.zone.height * 0.62 - R, width: 2 * R, height: 2 * R };
  const hintHits = Object.entries({ ...hudBoxes(Lc.view), speaker: Lc.sound, "☰ menu": Lc.menu }).filter(([, b]) => b && overlap(hint, b)).map(([n]) => n);
  const hinted = await d.cdp.eval<string>(`getComputedStyle(document.getElementById('touch-stick'), '::before').content`);
  await d.shot(`countdown-${orient}-${size}`);
  check(`${tag}: the countdown shows the DRIVE hint in the stick's zone, clear of the HUD, minimap, banner/ping, speaker and ☰`, hinted.includes("DRIVE") && hintHits.length === 0, `${hinted}; hint ${boxText(hint)}${hintHits.length ? `; over ${hintHits.join(", ")}` : ""}`);
  await sleep(3400); // the countdown is over
  const L0 = await d.cdp.eval<Layout>(LAYOUT);
  const [rx, ry] = await d.rest();
  // Gas + right with FIRE held: the green knob.
  await d.thumbDown(rx, ry);
  await d.thumbAt(Math.round(R * 0.4), -Math.round(R * 0.6));
  await d.fingers.at(LEFT, ...centre(L0.fire));
  await sleep(500);
  const gasView = await d.view();
  const lit = await d.cdp.eval<string[]>(`[...document.querySelectorAll('#touch .on')].map((e) => e.id || e.className)`);
  await d.shot(`race-${orient}-${size}-gas`);
  // Brake with the wheel left: the red knob.
  await d.thumbAt(-Math.round(R * 0.3), Math.round(R * 0.6));
  await sleep(300);
  const brakeView = await d.view();
  await d.shot(`race-${orient}-${size}-brake`);
  // Steer only (no gas): the grey knob.
  await d.thumbAt(Math.round(R * 0.5), 0);
  await sleep(300);
  const neutralView = await d.view();
  await d.shot(`race-${orient}-${size}-neutral`);
  check(
    `${tag}: the knob's colour: gas+right green (gas), brake+left red (brake), steer only grey (neutral); FIRE lit while held`,
    gasView.on && gasView.colour === "gas" && brakeView.colour === "brake" && neutralView.colour === "neutral" && lit.includes("touch-fire") && lit.includes("touch-base"),
    `${gasView.colour}, ${brakeView.colour}, ${neutralView.colour}; lit ${lit.join(", ")}`,
  );
  const L = await d.cdp.eval<Layout>(LAYOUT);
  await d.fingers.liftAll();
  d.stick = null;
  // Sizes and places.
  const small = L.caps.filter((c) => c.width < 56 || c.height < 56);
  check(`${tag}: FIRE and MINE are at least 56 CSS px`, L.caps.length === 2 && small.length === 0, `${L.caps.length} caps, smallest ${Math.min(...L.caps.map((c) => Math.min(c.width, c.height)))} px`);
  const inside = (b: Box) => b.left >= 0 && b.top >= 0 && b.left + b.width <= w && b.top + b.height <= h;
  const split = w * STICK_DEFAULTS.split;
  check(
    `${tag}: the stick's zone is right of the split line (${STICK_DEFAULTS.split * 100}%), from under the speaker and ☰ (--touch-top) to the bottom, over the view; it draws nothing itself`,
    Math.abs(L.zone.left - split) < 0.6 && Math.abs(L.zone.left + L.zone.width - w) < 0.6 && Math.abs(L.zone.top - L.touchTop) < 0.6 && Math.abs(L.zone.top + L.zone.height - h) < 0.6 && overlap(L.zone, L.view) &&
      L.zoneLook.startsWith("rgba(0, 0, 0, 0) / 0px / none / none") && L.touchTop >= L.menu.top + L.menu.height,
    `zone ${boxText(L.zone)}, view ${boxText(L.view)}, ☰ bottom ${Math.round(L.menu.top + L.menu.height)}, --touch-top ${L.touchTop}; look ${L.zoneLook}`,
  );
  check(`${tag}: the weapons on screen, left of the stick's zone`, inside(L.weapons) && L.weapons.left + L.weapons.width < L.zone.left, `weapons ${boxText(L.weapons)}`);
  const hits: string[] = [];
  const avoid: Record<string, Box | null> = { ...hudBoxes(L.view), speaker: L.sound, "☰ menu": L.menu, "Chat button": L.chatOpen };
  for (const [name, b] of Object.entries(avoid)) {
    if (b && overlap(L.weapons, b)) hits.push(`weapons over ${name}`);
  }
  if (L.chatOpen) for (const [name, b] of Object.entries(hudBoxes(L.view))) if (overlap(L.chatOpen, b) && !name.startsWith("banner")) hits.push(`Chat button over ${name}`);
  check(`${tag}: the weapons cover no HUD panel, the minimap, the banner/ping, the speaker, ☰ or the Chat button`, hits.length === 0 && !!L.chatOpen, hits.join("; ") || `weapons ${boxText(L.weapons)}, chat ${L.chatOpen ? boxText(L.chatOpen) : "none"}, view ${boxText(L.view)}`);
  check(
    `${tag}: the Chat button, the speaker and ☰ are on top where they are (a tap reaches them; the stick's zone is not over them); the Chat button left of the zone`,
    L.chatHit && L.soundHit && L.menuHit && !!L.chatOpen && L.chatOpen.left + L.chatOpen.width < L.zone.left,
    `chat ${L.chatHit} ${L.chatOpen ? boxText(L.chatOpen) : ""}, speaker ${L.soundHit}, ☰ ${L.menuHit}`,
  );
  if (h > w) {
    check(`${tag}: portrait: the view at the top under the speaker and ☰, the weapons in the space under it`, L.view.top >= L.menu.top + L.menu.height && L.weapons.top >= L.view.top + L.view.height, `view ${boxText(L.view)}, ☰ bottom ${Math.round(L.menu.top + L.menu.height)}`);
  }
  check(`${tag}: touch-action none on the view, the stick's zone and the weapons only (the stage and the chat log keep theirs)`, L.touchAction[0] === "none" && L.touchAction[1] === "none" && L.touchAction[2] === "none" && L.touchAction[3] !== "none" && L.touchAction[4] !== "none", `#view, zone, weapons, #stage, chat log: ${L.touchAction.join(", ")}`);
  // The Chat button by touch: it opens the chat (the controls hide); Close brings them back.
  await d.tap("#chat .chat-open");
  await sleep(150);
  const opened = await d.cdp.eval<{ open: boolean; shown: boolean }>(`({ open: document.getElementById('chat').classList.contains('open'), shown: !document.getElementById('touch').classList.contains('hidden') })`);
  await d.tap("#chat .chat-close");
  await sleep(200);
  check(`${tag}: a tap on the Chat button opens the chat (the controls hide); Close tapped brings them back`, opened.open && !opened.shown && (await d.shown()), JSON.stringify(opened));
  // No zoom or scroll: a pinch on the view and on the zone, a double tap on the view, a swipe up.
  const [vx, vy] = centre(L.view);
  const [zx, zy] = [L.zone.left + L.zone.width / 2, L.zone.top + L.zone.height * 0.7];
  for (const [what, x, y, scale] of [["view", vx, vy, 2.5], ["zone", zx, zy, 2]] as const) {
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
    const menuState = await d.cdp.eval<string>(`JSON.stringify({ open: !document.getElementById('game-menu').classList.contains('hidden'), keys: [...document.querySelectorAll('#game-menu [data-key]')].map((b) => b.dataset.key), scale: visualViewport.scale })`);
    if (!(await d.box('.gm [data-key="pause"]'))) throw new Error(`no Pause in the menu: ${menuState}`);
    await d.tap('.gm [data-key="pause"]');
    await sleep(300);
    if (!(await d.cdp.eval<boolean>(`document.getElementById('game-menu').classList.contains('hidden')`))) await d.tap('.gm [data-key="resume"]');
    await sleep(400);
    await d.shot("paused-portrait-390x844");
  }
  // Last (it leaves the page zoomed): the control, the same pinch on the bare stage (touch-action auto
  // there, so the lobby and the chat scroll) does zoom. Both of the pinch's fingers must start on
  // the stage: portrait under the view left of the zone, landscape in the left letterbox bar.
  const [sx, sy] = h > w ? [L.zone.left / 2, (L.view.top + L.view.height + (L.chatOpen ? L.chatOpen.top : L.weapons.top)) / 2] : [L.view.left / 2, 120];
  const bare = await d.cdp.eval<string>(`(() => { const e = document.elementFromPoint(${sx}, ${sy}); return e.id || e.className || e.tagName; })()`);
  await d.cdp.send("Input.synthesizePinchGesture", { x: Math.round(sx), y: Math.round(sy), scaleFactor: 2.5, gestureSourceType: "touch" });
  await sleep(300);
  const zoomed = await d.cdp.eval<number>("visualViewport.scale");
  check(
    `${tag}: a pinch on the view and on the stick's zone, a double tap and a swipe on the view: no zoom, no scroll (the same pinch on the bare stage does zoom)`,
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
  check("desktop: the controls never show in the countdown and the race (4 s polled)", !seen);
  await d.shot("race-desktop-1280x720");
}

async function main(): Promise<void> {
  // Each pass in a browser of its own: after a long pass Chrome's input emulation can be left with
  // bounds that do not match the emulated screen (Input.synthesizePinchGesture answered "Position
  // out of bounds" inside it, and touches reached the page no more); a fresh browser has none of that.
  const passes: [string, (d: PageDriver) => Promise<void>][] = [
    ["drive-portrait", drivePortrait],
    ["drive-landscape", driveLandscape],
    ["tune-portrait", (d) => tune(d, 390, 844)],
    ["tune-landscape", (d) => tune(d, 844, 390)],
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
