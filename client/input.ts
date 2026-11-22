// Keyboard input: arrows or WASD to drive, Space / Z / J for the rivet gun (hold),
// X / K to drop a mine (tap). Touch: TouchPad below (PLAN-TOUCH, a thumbstick). Gamepad comes later.

import { clamp, wrapAngle } from "../shared/physics";
import type { Controls } from "./game";

const UP = new Set(["ArrowUp", "KeyW"]);
const DOWN = new Set(["ArrowDown", "KeyS"]);
const LEFT = new Set(["ArrowLeft", "KeyA"]);
const RIGHT = new Set(["ArrowRight", "KeyD"]);
const FIRE = new Set(["Space", "KeyZ", "KeyJ"]);
const MINE = new Set(["KeyX", "KeyK"]);
const ALL = [UP, DOWN, LEFT, RIGHT, FIRE, MINE];

export class Keyboard {
  private readonly down = new Set<string>();
  private minePressed = false; // latched until read, so a tap shorter than a step counts

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      const k = keyId(e);
      if (!ALL.some((set) => set.has(k))) return;
      e.preventDefault();
      if (MINE.has(k) && !e.repeat) this.minePressed = true;
      this.down.add(k);
    });
    target.addEventListener("keyup", (e) => this.down.delete(keyId(e)));
    target.addEventListener("blur", () => this.down.clear());
  }

  /**
   * Forget every held key, e.g. when the chat input takes focus: typing only blocks new
   * keydowns, so a key held at that moment would otherwise keep driving until its keyup.
   */
  clear(): void {
    this.down.clear();
    this.minePressed = false;
  }

  read(): Controls {
    const any = (keys: Set<string>) => [...keys].some((k) => this.down.has(k));
    const mine = this.minePressed;
    this.minePressed = false;
    return {
      throttle: (any(UP) ? 1 : 0) - (any(DOWN) ? 1 : 0),
      steer: (any(RIGHT) ? 1 : 0) - (any(LEFT) ? 1 : 0),
      fire: any(FIRE),
      mine,
    };
  }
}

/** Physical key id; synthetic events (automation, some remappers) only carry `key`. */
function keyId(e: KeyboardEvent): string {
  if (e.code) return e.code;
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return `Key${e.key.toUpperCase()}`;
  return e.key;
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

// ---- touch (PLAN-TOUCH, TOUCH-2, TOUCH-5) -------------------------------------------
// On-screen controls for phones: a floating thumbstick for the right thumb and FIRE (hold) /
// MINE (tap) for the left. A thumb that lands anywhere in the stick's zone (right of a split line)
// puts the stick's centre there. Point mode (the default, TOUCH-5): the stick's direction is where
// the car should face; pushed past a small dead zone it drives there, the steer falling to 0 as the
// car comes round (a heading hold on the own predicted car, handed in by main.ts every step).
// Rate mode (TOUCH-2 to TOUCH-4): pushed up it is full gas, down brake/reverse, sideways steer in
// proportion. Either way gas and steer go together and they make the same Controls as the keyboard
// (steer may be a fraction, as the bots' already is); main.ts merges the two every step
// (mergeControls). The state machine is a pure reducer (reducePad) and the outputs pure functions,
// so Node tests drive them; TouchPad wires them to the DOM.

/** A box in client (CSS) pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How the stick steers (TOUCH-5). "point": the stick's direction on screen is the direction the car
 * should face (the camera never rotates, so screen axes are world axes); the car turns toward it and
 * stops turning when it faces it, and any push past the dead zone drives. "rate": the sideways
 * offset is a turn rate and up/down is gas/brake (TOUCH-2 to TOUCH-4, unchanged).
 */
export type StickMode = "point" | "rate";

/**
 * The stick's feel. Distances are shares of the radius, so a bigger stick keeps its feel. The
 * tuning panel (?debug=1, client/touchtune.ts) changes them live; everywhere else these defaults.
 */
export interface StickParams {
  mode: StickMode;
  /** R, CSS px: how far the knob travels from the centre. */
  radius: number;
  /** Rate mode, sideways, share of R: no steer up to here. */
  steerDead: number;
  /** Rate mode, sideways, share of R: full lock from here (well inside R). */
  steerLock: number;
  /** Rate mode, steer between the two: ((offset - dead) / (lock - dead)) ^ curve; 1 = linear, more = finer near the centre. */
  steerCurve: number;
  /** Rate mode, up or down, share of R: no gas or brake up to here; past it full gas (up) or brake/reverse (down). */
  throttleDead: number;
  /** The stick's zone starts at this share of the screen's width (the weapons are left of it). */
  split: number;
  /** Point mode, share of R: no direction up to here (no gas, no steer: the car coasts). */
  pointDead: number;
  /** Point mode, degrees: the heading error at which the steer is full lock; under it the steer is in proportion. */
  aimFull: number;
  /** Point mode, degrees: pointing further behind the car than this brakes when fast and reverses when slow. */
  brakeAngle: number;
}

/**
 * The shipped feel. Rate mode: the user's values, tuned on a phone with the panel (TOUCH-3: R 95, as
 * R 60 was too sensitive; TOUCH-4: full lock 0.9 R and curve 3, as 0.7 and 1.4 still were). Point
 * mode (TOUCH-5, the default for every touch player since rate mode oversteered on the phone): a dead
 * zone as big as rate mode's gas dead zone, full lock at 35° off (the plan's value), brake or reverse
 * past 110° off. Back to rate mode for everyone: mode "rate" here, nothing else. TOUCH-6: R 67, the
 * user's point-mode tuning on the phone (the push area was too big at 95; the rest unchanged).
 */
export const STICK_DEFAULTS: Readonly<StickParams> = { mode: "point", radius: 67, steerDead: 0.12, steerLock: 0.9, steerCurve: 3, throttleDead: 0.3, split: 0.5, pointDead: 0.3, aimFull: 35, brakeAngle: 110 };

/**
 * Point mode's fixed thresholds (u/s are forward speed, vf; degrees are the heading error). Not on
 * the panel: they follow from the physics (shared/physics.ts stepCar), not from taste.
 * - brakeSpeed 150: pointed past brakeAngle, faster than this brakes (BRAKE 900 u/s²) so the car
 *   slows into the turn; slower, gas turns it round forward at the full turn rate (FULL_TURN_SPEED 140).
 * - brakeHyst 30: a speed hysteresis on the brake, once a turn (the memo's brake): a turn pointed
 *   behind brakes only if it starts above brakeSpeed + 30 (180), then down to brakeSpeed (150), and
 *   not again until the car no longer points behind; so the throttle changes sign at most once a
 *   turn (brake, then gas) instead of single-step brake blips each time gas lifts vf past 150
 *   (TOUCH-5 review F2: the knob flashed red for single frames). Measured over every car type,
 *   140-430 u/s and 115-180° off, dry and wet: at most 1 change (was up to 8). The release stays at
 *   150: lower (120) brakes under FULL_TURN_SPEED and turns slower (top-speed U-turns 1-4 steps
 *   longer); the entry margin sets how fast a turn must start to brake at all.
 * - revSpeed 30: pointed past brakeAngle at or under this (or rolling backward), it reverses
 *   instead: from about a standstill a forward U-turn barely turns (the turn scales with vf / 140).
 * - flipSpeed 20: rolling backward faster than this the steer is flipped (the physics turns the
 *   other way in reverse), so the nose still swings toward the aim; more than the most one step
 *   changes vf (BRAKE / 60 = 15), so the speed the step turns with has the same sign. (The closed
 *   loops do not depend on the margin, so no test pins it: it rests on that bound.)
 * - revHyst 30: a reverse to turn round ends only under brakeAngle - 30° (80° by default), so the
 *   car does not chatter between reverse and gas (gas while rolling backward brakes).
 * - stuckSpeed 15 and stuckTicks 30: the throttle on, |vf| under 15 for 30 driving steps (0.5 s;
 *   a start from rest passes 15 in 2 steps, 6 on water) is stuck: nose in a wall and pointed more
 *   than aimFull off, it reverses out until under aimFull / 2 off; stuck reversing, it drives forward.
 */
export const POINT_RULES = { brakeSpeed: 150, brakeHyst: 30, revSpeed: 30, flipSpeed: 20, revHyst: 30, stuckSpeed: 15, stuckTicks: 30 } as const;

/** Where things are on screen: cached by TouchPad, measured again after a resize. */
export interface PadGeometry {
  screen: Rect; // the stage (the visible screen): a stick's centre keeps its full reach inside it
  fire: Rect;
  mine: Rect;
}

export type PadEvent =
  | { t: "down"; id: number; cluster: "stick" | "weapons"; x: number; y: number }
  | { t: "move"; id: number; x: number; y: number }
  | { t: "up"; id: number } // pointerup, pointercancel, lostpointercapture
  | { t: "release" } // window blur, the page hidden: every finger is up (a mine tapped just before still drops)
  | { t: "clear" }; // the chat or the menu opened, the controls hid: every finger up and no mine either

/** The thumb on the stick: its pointer id, the centre it set, and where it is now (client px). */
export interface Stick {
  readonly id: number;
  readonly cx: number;
  readonly cy: number;
  readonly x: number;
  readonly y: number;
}

export interface PadState {
  /** The finger that owns the stick (the first one down in its zone), or none. */
  readonly stick: Stick | null;
  readonly fire: readonly number[]; // fingers holding FIRE
  readonly mineHeld: readonly number[]; // fingers on MINE (lit only; a press is the latch)
  readonly mine: boolean; // MINE pressed since the last read
}

export const PAD_IDLE: PadState = { stick: null, fire: [], mineHeld: [], mine: false };

/** Room for the thumb's contact point at a screen edge (it cannot reach the last pixel). */
const EDGE_PX = 8;

/**
 * Where a thumb landing at (x, y) puts the stick's centre: right there, unless that is so close to a
 * screen edge that the full output toward the edge could not be reached. Then the centre moves
 * inward just enough: in rate mode sideways by the full-lock reach, up and down by the gas/brake dead
 * zone; in point mode every way by the dead zone, so every direction can be pointed (each plus
 * EDGE_PX). Moving it further (a whole R) would start the stick off pushed: a thumb landing near the
 * bottom would brake at once.
 */
export function stickCentre(x: number, y: number, screen: Rect, p: StickParams): [number, number] {
  const keep = (v: number, lo: number, size: number, reach: number) => (size <= 2 * reach ? lo + size / 2 : Math.min(lo + size - reach, Math.max(lo + reach, v)));
  const point = p.mode === "point";
  const side = p.radius * (point ? p.pointDead : p.steerLock) + EDGE_PX;
  const upDown = p.radius * (point ? p.pointDead : p.throttleDead) + EDGE_PX;
  return [keep(x, screen.left, screen.width, side), keep(y, screen.top, screen.height, upDown)];
}

/** Two decimals, as Game.step rounds a command before it predicts and sends it; the same both ways, never -0. */
const hundredths = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100 + 0;

/**
 * The stick's output for the thumb's offset from the centre (client px; y grows downward):
 * [throttle, steer]. Steer follows the sideways offset (capped at R): nothing inside the dead zone,
 * then up the curve to full lock (1, the keyboard's) at steerLock; in hundredths, so Game.step's
 * rounding leaves it as it is. Throttle is digital: 1 above the centre past the dead zone, -1 below.
 */
export function stickControls(dx: number, dy: number, p: StickParams): [number, number] {
  const r = Math.max(1, p.radius);
  const side = Math.min(1, Math.abs(dx) / r);
  let steer = 0;
  if (side > p.steerDead) {
    const span = p.steerLock - p.steerDead;
    const u = span > 0 ? Math.min(1, (side - p.steerDead) / span) : 1;
    steer = hundredths(Math.sign(dx) * u ** Math.max(0.1, p.steerCurve));
  }
  const up = -dy / r;
  return [up > p.throttleDead ? 1 : up < -p.throttleDead ? -1 : 0, steer];
}

// ---- point mode (TOUCH-5) ----

const DEG = Math.PI / 180;

/** The own predicted car as point mode needs it, before the step (main.ts, read fresh every step). */
export interface PadCar {
  /** Heading, radians (shared/physics.ts: 0 = +x, increasing = clockwise on screen). */
  h: number;
  /** Signed forward speed (u/s): the velocity along the heading; negative rolling backward. */
  vf: number;
  /** The step drives the car with these controls (the race on, not wrecked, in the air or falling): only then can it be stuck. */
  live: boolean;
}

/**
 * Point mode's memory between steps (TouchPad keeps it; the functions are pure). rev: 0 gas; 1
 * reversing to turn round (pointed behind from slow); 2 reversing out of a wall (stuck under gas);
 * 3 gas only (stuck reversing: no reverse to turn round until it rolls forward again). stuck: the
 * driving steps in a row with |vf| under POINT_RULES.stuckSpeed (at most stuckTicks). brake: the
 * brake for a turn pointed behind, once a turn with a speed hysteresis round brakeSpeed.
 */
export interface PointMemo {
  readonly rev: 0 | 1 | 2 | 3;
  readonly stuck: number;
  /** The brake for a turn pointed behind (not reversing): 0 no such turn, 1 braking, 2 braked or started slow (gas until it no longer points behind). */
  readonly brake: 0 | 1 | 2;
}

export const POINT_IDLE: PointMemo = { rev: 0, stuck: 0, brake: 0 };

/** Where the thumb points (radians, screen axes = world axes: 0 = right, + = clockwise), or null inside the dead zone. */
export function pointAim(dx: number, dy: number, p: StickParams): number | null {
  return Math.hypot(dx, dy) <= p.pointDead * Math.max(1, p.radius) ? null : Math.atan2(dy, dx);
}

/**
 * Point mode's steer for the heading error err = wrapAngle(aim - h) (radians): err / aimFull,
 * capped at full lock, so it falls to 0 as the car comes round; flipped while rolling backward
 * faster than flipSpeed (there the physics turns the other way). In hundredths.
 */
export function pointSteer(err: number, vf: number, p: StickParams): number {
  const s = clamp(err / (Math.max(1, p.aimFull) * DEG), -1, 1);
  return hundredths(vf < -POINT_RULES.flipSpeed ? -s : s);
}

/**
 * Point mode's throttle: one total function of the heading error (radians), the car's signed
 * forward speed and the memo, giving gas (1) or brake/reverse (-1) and the next memo.
 * - Pointed within brakeAngle: gas.
 * - Pointed past brakeAngle: a turn that starts above brakeSpeed + brakeHyst brakes down to
 *   brakeSpeed, then gas (once a turn); else gas down to revSpeed; at or under it (and at any
 *   backward speed) reverse to turn round, until under brakeAngle - revHyst.
 * - Stuck (stuckTicks driving steps with |vf| under stuckSpeed): under gas and more than aimFull
 *   off, reverse out until under aimFull / 2 off; while reversing, gas (and no reverse to turn
 *   round until it rolls forward faster than revSpeed).
 */
export function pointThrottle(err: number, car: PadCar, memo: PointMemo, p: StickParams): [number, PointMemo] {
  const R = POINT_RULES;
  const off = Math.abs(err) / DEG;
  const behind = off > p.brakeAngle;
  let rev = memo.rev;
  if (rev === 1 && off < p.brakeAngle - R.revHyst) rev = 0;
  else if (rev === 2 && off < p.aimFull / 2) rev = 0;
  else if (rev === 3 && car.vf > R.revSpeed) rev = 0;
  if (memo.stuck >= R.stuckTicks) {
    if (rev === 1 || rev === 2) rev = 3;
    else if (off > p.aimFull) rev = 2;
  }
  if (rev === 0 && behind && car.vf <= R.revSpeed) rev = 1;
  const reversing = rev === 1 || rev === 2;
  let brake: 0 | 1 | 2 = 0;
  if (!reversing && behind) {
    if (memo.brake === 1) brake = car.vf > R.brakeSpeed ? 1 : 2; // released at brakeSpeed (see brakeHyst)
    else if (memo.brake === 2) brake = 2;
    else brake = car.vf > R.brakeSpeed + R.brakeHyst ? 1 : 2;
  }
  const throttle = reversing || brake === 1 ? -1 : 1;
  const stuck = car.live && rev === memo.rev && Math.abs(car.vf) < R.stuckSpeed ? Math.min(R.stuckTicks, memo.stuck + 1) : 0;
  return [throttle, rev === memo.rev && stuck === memo.stuck && brake === memo.brake ? memo : { rev, stuck, brake }];
}

/**
 * Point mode's output for the thumb's offset (client px; y grows downward) and the car: [throttle,
 * steer, memo]. Inside the dead zone or with no car: nothing (the car coasts) and the memo afresh.
 */
export function pointControls(dx: number, dy: number, car: PadCar | null, memo: PointMemo, p: StickParams): [number, number, PointMemo] {
  const aim = pointAim(dx, dy, p);
  if (aim === null || !car) return [0, 0, POINT_IDLE];
  const err = wrapAngle(aim - car.h);
  const [throttle, next] = pointThrottle(err, car, memo, p);
  return [throttle, pointSteer(err, car.vf, p), next];
}

/** The stick's output in its mode: [throttle, steer, the point memo after it] (rate mode keeps none). */
export function stickOutput(st: Stick | null, p: StickParams, car: PadCar | null, memo: PointMemo): [number, number, PointMemo] {
  if (!st) return [0, 0, POINT_IDLE];
  const dx = st.x - st.cx;
  const dy = st.y - st.cy;
  if (p.mode !== "point") {
    const [throttle, steer] = stickControls(dx, dy, p);
    return [throttle, steer, POINT_IDLE];
  }
  return pointControls(dx, dy, car, memo, p);
}

/** Where the knob is drawn: the thumb's offset from the centre, kept within R. */
export function stickKnob(s: Stick, p: StickParams): [number, number] {
  const dx = s.x - s.cx;
  const dy = s.y - s.cy;
  const d = Math.hypot(dx, dy);
  const k = d > p.radius ? p.radius / d : 1;
  return [dx * k, dy * k];
}

/** FIRE or MINE: the button the point is on, else the nearer one (the gap between them is no dead spot). */
function weaponAt(x: number, y: number, g: PadGeometry): "fire" | "mine" {
  const dist = (r: Rect) => Math.hypot(Math.max(r.left - x, 0, x - r.left - r.width), Math.max(r.top - y, 0, y - r.top - r.height));
  return dist(g.mine) < dist(g.fire) ? "mine" : "fire";
}

const without = (ids: readonly number[], id: number) => (ids.includes(id) ? ids.filter((i) => i !== id) : ids);

/**
 * The controls' state machine, pure: each pointer event in, the new state out. Every finger is
 * tracked by its pointer id, so two thumbs (or more fingers) work at once. The first finger down in
 * the stick's zone owns the stick until it lifts (later ones there are ignored); it sets the centre
 * where it lands (stickCentre) and drives by where it is. One on FIRE or MINE keeps that button
 * until it lifts. A move or lift of a finger the controls do not know is ignored.
 */
export function reducePad(s: PadState, ev: PadEvent, g: PadGeometry, p: StickParams = STICK_DEFAULTS): PadState {
  switch (ev.t) {
    case "down": {
      const up = reducePad(s, { t: "up", id: ev.id }, g, p); // a reused id starts afresh
      if (ev.cluster === "stick") {
        if (up.stick) return up; // the stick has its thumb
        const [cx, cy] = stickCentre(ev.x, ev.y, g.screen, p);
        return { ...up, stick: { id: ev.id, cx, cy, x: ev.x, y: ev.y } };
      }
      if (weaponAt(ev.x, ev.y, g) === "fire") return { ...up, fire: [...up.fire, ev.id] };
      return { ...up, mineHeld: [...up.mineHeld, ev.id], mine: true };
    }
    case "move": {
      const st = s.stick;
      if (!st || st.id !== ev.id || (st.x === ev.x && st.y === ev.y)) return s;
      return { ...s, stick: { ...st, x: ev.x, y: ev.y } };
    }
    case "up": {
      const stick = s.stick?.id === ev.id ? null : s.stick;
      const fire = without(s.fire, ev.id);
      const mineHeld = without(s.mineHeld, ev.id);
      return stick === s.stick && fire === s.fire && mineHeld === s.mineHeld ? s : { ...s, stick, fire, mineHeld };
    }
    case "release":
      return { ...PAD_IDLE, mine: s.mine };
    case "clear":
      return PAD_IDLE;
  }
}

/** What the fingers hold, as the keyboard's Controls (point mode: for this car and memo); the mine latch is left for readPad. */
export function padControls(s: PadState, p: StickParams = STICK_DEFAULTS, car: PadCar | null = null, memo: PointMemo = POINT_IDLE): Controls {
  const [throttle, steer] = stickOutput(s.stick, p, car, memo);
  return { throttle, steer, fire: s.fire.length > 0, mine: s.mine };
}

/** One step's read: the controls, the state with the mine latch taken (as Keyboard.read) and point mode's next memo. */
export function readPad(s: PadState, p: StickParams = STICK_DEFAULTS, car: PadCar | null = null, memo: PointMemo = POINT_IDLE): [Controls, PadState, PointMemo] {
  const [throttle, steer, next] = stickOutput(s.stick, p, car, memo);
  return [{ throttle, steer, fire: s.fire.length > 0, mine: s.mine }, s.mine ? { ...s, mine: false } : s, next];
}

/** Keyboard and touch together: throttle and steer add up (clamped), fire and mine either. */
export function mergeControls(a: Controls, b: Controls): Controls {
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
  return { throttle: clamp1(a.throttle + b.throttle), steer: clamp1(a.steer + b.steer), fire: a.fire || b.fire, mine: a.mine || b.mine };
}

/** A key that drives (arrows/WASD, fire, mine) typed outside a text field: the player is on a keyboard. */
export function isDriveKey(e: KeyboardEvent): boolean {
  const k = keyId(e);
  return !isTyping(e.target) && ALL.some((set) => set.has(k));
}

export interface TouchPadEls {
  stage: HTMLElement; // gets "touch" while touch is in use and "pad-on" while the controls show; holds the stick's CSS variables
  root: HTMLElement; // all the controls
  stick: HTMLElement; // the stick's zone: right of the split line, below the top bar
  base: HTMLElement; // the stick's gate, shown where the thumb set the centre
  knob: HTMLElement; // in the gate, under the thumb
  weapons: HTMLElement; // FIRE and MINE's cluster
  fire: HTMLElement;
  mine: HTMLElement;
  fireAmmo: HTMLElement;
  mineAmmo: HTMLElement;
}

/**
 * The on-screen controls in the page. One listener per cluster; hit tests use boxes cached when the
 * controls show or the window changes (nothing is measured on a move). A move writes the knob's
 * transform only; classes change only when the stick comes or goes, its throttle changes sign (point
 * mode: checked every step, as it follows the car) or a weapon is pressed or let go, the ammo text
 * only when a count changes. Point mode's memo (PointMemo: a reverse latched, the stuck counter)
 * lives here, afresh whenever the thumb lands, lifts or the feel changes.
 */
export class TouchPad {
  /** Touch is in use: a coarse pointer, or a finger on the screen; a driving key turns it off again. */
  touch = false;
  private state: PadState = PAD_IDLE;
  private params: StickParams = { ...STICK_DEFAULTS };
  private memo: PointMemo = POINT_IDLE;
  private readonly car: PadCar = { h: 0, vf: 0, live: false }; // the last step's own car (a copy)
  private hasCar = false;
  private geo: (PadGeometry & { zone: Rect }) | null = null; // null: measured at the next touch
  private shown = false;
  private hinted = false;
  private gas = 0; // the knob's colour: the throttle's sign
  private fireLit = false;
  private mineLit = false;
  private rivets = -1; // the counts shown
  private mines = -1;

  constructor(private readonly els: TouchPadEls) {
    this.setParams({});
    const cluster = (el: HTMLElement, name: "stick" | "weapons") => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // no focus, no text selection, no mouse events after it
        el.setPointerCapture(e.pointerId);
        this.apply({ t: "down", id: e.pointerId, cluster: name, x: e.clientX, y: e.clientY });
      });
      el.addEventListener("pointermove", (e) => {
        if (this.state.stick?.id === e.pointerId) this.apply({ t: "move", id: e.pointerId, x: e.clientX, y: e.clientY });
      });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, (e) => this.apply({ t: "up", id: (e as PointerEvent).pointerId }));
      el.addEventListener("contextmenu", (e) => e.preventDefault()); // a long press opens nothing
    };
    cluster(els.stick, "stick");
    cluster(els.weapons, "weapons");
    window.addEventListener("blur", () => this.apply({ t: "release" }));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.apply({ t: "release" });
    });
    const stale = () => (this.geo = null);
    window.addEventListener("resize", stale);
    window.addEventListener("orientationchange", stale);
    window.visualViewport?.addEventListener("resize", stale);
    window.visualViewport?.addEventListener("scroll", stale);
    // Touch in use: a coarse pointer from the start, a finger on the screen (any pointerdown of a
    // touch, in any phase); a driving key hides the controls again (a laptop with a touch screen, a
    // tablet with a keyboard).
    const coarse = window.matchMedia("(pointer: coarse)");
    this.setTouch(coarse.matches);
    coarse.addEventListener("change", () => coarse.matches && this.setTouch(true));
    window.addEventListener("pointerdown", (e) => e.pointerType === "touch" && this.setTouch(true), true);
    window.addEventListener("keydown", (e) => isDriveKey(e) && this.setTouch(false), true);
  }

  /** The stick's feel now (a copy). */
  stickParams(): StickParams {
    return { ...this.params };
  }

  /**
   * Change the stick's feel (the tuning panel, live): the zone's split line and the stick's size
   * are CSS variables on the stage; a thumb on the stick drives by the new values from the next read.
   */
  setParams(change: Partial<StickParams>): void {
    this.params = { ...this.params, ...change };
    this.memo = POINT_IDLE;
    const st = this.els.stage.style;
    st.setProperty("--stick-split", `${this.params.split * 100}%`);
    st.setProperty("--stick-r", `${this.params.radius}px`);
    this.geo = null;
    if (this.state.stick) this.drawKnob(this.state.stick);
  }

  /** Show or hide the controls (main.ts, every frame): only a change touches the DOM; hiding lets go of everything. */
  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.els.root.classList.toggle("hidden", !on);
    this.els.stage.classList.toggle("pad-on", on);
    this.geo = null;
    if (!on) this.clear();
  }

  /** The countdown's hint where the stick is (main.ts while the controls show): written on change only. */
  hint(on: boolean): void {
    if (on === this.hinted) return;
    this.hinted = on;
    this.els.stick.classList.toggle("hint", on);
  }

  /** Let go of every finger and the mine latch (chat focus, menu open, hidden): the stick goes too. */
  clear(): void {
    this.apply({ t: "clear" });
  }

  /**
   * The step's controls (main.ts, every step, with the own predicted car before the step; null: no
   * car, so point mode gives nothing): the mine latch is taken, point mode's memo moves on, and the
   * knob's colour follows the throttle.
   */
  read(car: PadCar | null = null): Controls {
    this.hasCar = !!car;
    if (car) {
      this.car.h = car.h;
      this.car.vf = car.vf;
      this.car.live = car.live;
    }
    const [ctl, next, memo] = readPad(this.state, this.params, this.lastCar(), this.memo);
    this.state = next;
    this.memo = memo;
    this.setGas(ctl.throttle);
    return ctl;
  }

  /** What the fingers hold now for the last step's car, without taking the mine latch or moving the memo (the tuning panel's readout). */
  peek(): Controls {
    return padControls(this.state, this.params, this.lastCar(), this.memo);
  }

  /** Point mode's memo after the last read (touch-drive's per-step check; a copy). */
  pointMemo(): PointMemo {
    return { ...this.memo };
  }

  /** The thumb on the stick now, or none (touch-drive's per-step check: the offset each step was read with). */
  stickNow(): Stick | null {
    return this.state.stick;
  }

  /** The weapons' counts (rivets, mines); written only when one changed. */
  setAmmo(rivets: number, mines: number): void {
    if (this.rivets !== rivets) {
      this.rivets = rivets;
      this.els.fireAmmo.textContent = String(rivets);
      this.els.fire.classList.toggle("empty", rivets === 0);
    }
    if (this.mines !== mines) {
      this.mines = mines;
      this.els.mineAmmo.textContent = String(mines);
      this.els.mine.classList.toggle("empty", mines === 0);
    }
  }

  private setTouch(on: boolean): void {
    if (on === this.touch) return;
    this.touch = on;
    this.els.stage.classList.toggle("touch", on);
    // The view moves (portrait: to the top) without changing size; the chat overlay and the
    // speaker place themselves on a resize.
    window.dispatchEvent(new Event("resize"));
  }

  private apply(ev: PadEvent): void {
    // Only a finger going down is hit-tested: the boxes are measured then if a resize or a show
    // made them stale (never on a move).
    const g = ev.t === "down" ? (this.geo ??= this.measure()) : ZERO_GEO;
    const was = this.state;
    const next = reducePad(was, ev, g, this.params);
    if (next === was) return;
    this.state = next;
    const st = next.stick;
    if (st !== was.stick) {
      const landed = !!st && (!was.stick || st.id !== was.stick.id || st.cx !== was.stick.cx || st.cy !== was.stick.cy);
      if (!st || landed) this.memo = POINT_IDLE; // a new thumb or none: point mode starts afresh
      if (landed) {
        // A new thumb: the gate goes where it set the centre (the zone's box is fresh from the down).
        const z = (this.geo ?? this.measure()).zone;
        this.els.base.style.transform = `translate3d(${st.cx - z.left}px, ${st.cy - z.top}px, 0)`;
      }
      if (!!st !== !!was.stick) {
        this.els.base.classList.toggle("on", !!st);
        this.els.stick.classList.toggle("held", !!st);
      }
      if (st) this.drawKnob(st);
      else this.setGas(0);
    }
    const fire = next.fire.length > 0;
    const mine = next.mineHeld.length > 0;
    if (fire !== this.fireLit) this.els.fire.classList.toggle("on", (this.fireLit = fire));
    if (mine !== this.mineLit) this.els.mine.classList.toggle("on", (this.mineLit = mine));
  }

  /** The knob under the thumb (a transform only) and its colour: gas, brake or neither (point mode: for the last step's car). */
  private drawKnob(st: Stick): void {
    const [kx, ky] = stickKnob(st, this.params);
    this.els.knob.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0)`;
    this.setGas(stickOutput(st, this.params, this.lastCar(), this.memo)[0]);
  }

  private lastCar(): PadCar | null {
    return this.hasCar ? this.car : null;
  }

  private setGas(gas: number): void {
    if (gas === this.gas) return;
    this.gas = gas;
    this.els.knob.classList.toggle("gas", gas > 0);
    this.els.knob.classList.toggle("brake", gas < 0);
  }

  private measure(): PadGeometry & { zone: Rect } {
    const box = (el: HTMLElement): Rect => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    return { screen: box(this.els.stage), zone: box(this.els.stick), fire: box(this.els.fire), mine: box(this.els.mine) };
  }
}

const ZERO_RECT: Rect = { left: 0, top: 0, width: 1, height: 1 };
const ZERO_GEO: PadGeometry = { screen: ZERO_RECT, fire: ZERO_RECT, mine: ZERO_RECT };
