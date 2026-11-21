// Keyboard input: arrows or WASD to drive, Space / Z / J for the rivet gun (hold),
// X / K to drop a mine (tap). Touch: TouchPad below (PLAN-TOUCH, a thumbstick). Gamepad comes later.

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

// ---- touch (PLAN-TOUCH, TOUCH-2) -----------------------------------------------------
// On-screen controls for phones: a floating thumbstick for the right thumb and FIRE (hold) /
// MINE (tap) for the left. A thumb that lands anywhere in the stick's zone (right of a split line)
// puts the stick's centre there; pushed up it is full gas, down brake/reverse, sideways steer in
// proportion, so gas and steer go together. They make the same Controls as the keyboard (steer may
// be a fraction, as the bots' already is); main.ts merges the two every step (mergeControls). The
// state machine is a pure reducer (reducePad) so Node tests drive it; TouchPad wires it to the DOM.

/** A box in client (CSS) pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The stick's feel. Distances are shares of the radius, so a bigger stick keeps its feel. The
 * tuning panel (?debug=1, client/touchtune.ts) changes them live; everywhere else these defaults.
 */
export interface StickParams {
  /** R, CSS px: how far the knob travels from the centre. */
  radius: number;
  /** Sideways, share of R: no steer up to here. */
  steerDead: number;
  /** Sideways, share of R: full lock from here (well inside R). */
  steerLock: number;
  /** Steer between the two: ((offset - dead) / (lock - dead)) ^ curve; 1 = linear, more = finer near the centre. */
  steerCurve: number;
  /** Up or down, share of R: no gas or brake up to here; past it full gas (up) or brake/reverse (down). */
  throttleDead: number;
  /** The stick's zone starts at this share of the screen's width (the weapons are left of it). */
  split: number;
}

/** The user's values, tuned on a phone with the panel (TOUCH-3: R 95, as R 60 was too sensitive; TOUCH-4: full lock 0.9 R and curve 3, as 0.7 and 1.4 still were). */
export const STICK_DEFAULTS: Readonly<StickParams> = { radius: 95, steerDead: 0.12, steerLock: 0.9, steerCurve: 3, throttleDead: 0.3, split: 0.5 };

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
 * inward just enough: sideways by the full-lock reach, up and down by the gas/brake dead zone (each
 * plus EDGE_PX). Moving it further (a whole R) would start the stick off pushed: a thumb landing near
 * the bottom would brake at once.
 */
export function stickCentre(x: number, y: number, screen: Rect, p: StickParams): [number, number] {
  const keep = (v: number, lo: number, size: number, reach: number) => (size <= 2 * reach ? lo + size / 2 : Math.min(lo + size - reach, Math.max(lo + reach, v)));
  return [keep(x, screen.left, screen.width, p.radius * p.steerLock + EDGE_PX), keep(y, screen.top, screen.height, p.radius * p.throttleDead + EDGE_PX)];
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

/** What the fingers hold, as the keyboard's Controls; the mine latch is left for readPad. */
export function padControls(s: PadState, p: StickParams = STICK_DEFAULTS): Controls {
  const [throttle, steer] = s.stick ? stickControls(s.stick.x - s.stick.cx, s.stick.y - s.stick.cy, p) : [0, 0];
  return { throttle, steer, fire: s.fire.length > 0, mine: s.mine };
}

/** One step's read: the controls, and the state with the mine latch taken (as Keyboard.read). */
export function readPad(s: PadState, p: StickParams = STICK_DEFAULTS): [Controls, PadState] {
  return [padControls(s, p), s.mine ? { ...s, mine: false } : s];
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
 * transform only; classes change only when the stick comes or goes, its throttle changes sign or a
 * weapon is pressed or let go, the ammo text only when a count changes.
 */
export class TouchPad {
  /** Touch is in use: a coarse pointer, or a finger on the screen; a driving key turns it off again. */
  touch = false;
  private state: PadState = PAD_IDLE;
  private params: StickParams = { ...STICK_DEFAULTS };
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

  /** The step's controls (main.ts, every step): the mine latch is taken. */
  read(): Controls {
    const [ctl, next] = readPad(this.state, this.params);
    this.state = next;
    return ctl;
  }

  /** What the fingers hold now, without taking the mine latch (the tuning panel's readout). */
  peek(): Controls {
    return padControls(this.state, this.params);
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
      if (st && (!was.stick || st.cx !== was.stick.cx || st.cy !== was.stick.cy)) {
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

  /** The knob under the thumb (a transform only) and its colour: gas, brake or neither. */
  private drawKnob(st: Stick): void {
    const [kx, ky] = stickKnob(st, this.params);
    this.els.knob.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0)`;
    this.setGas(stickControls(st.x - st.cx, st.y - st.cy, this.params)[0]);
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
