// Keyboard input: arrows or WASD to drive, Space / Z / J for the rivet gun (hold),
// X / K to drop a mine (tap). Touch: TouchPad below (PLAN-TOUCH). Gamepad comes later.

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

// ---- touch (PLAN-TOUCH) -----------------------------------------------------------
// On-screen controls for phones: an 8-way pad for the right thumb (up gas, down brake/reverse,
// left/right steer, the corners both at once; one finger slides through all nine zones, the
// centre is nothing) and FIRE (hold) / MINE (tap) for the left. They make the same Controls as
// the keyboard; main.ts merges the two every step (mergeControls). The state machine is a pure
// reducer (reducePad) so Node tests drive it; TouchPad wires it to the DOM.

/** A box in client (CSS) pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the controls are on screen: cached by TouchPad, measured again after a resize. */
export interface PadGeometry {
  pad: Rect; // the 8-way pad's cluster, cut into thirds
  fire: Rect;
  mine: Rect;
}

export type PadEvent =
  | { t: "down"; id: number; cluster: "pad" | "weapons"; x: number; y: number }
  | { t: "move"; id: number; x: number; y: number }
  | { t: "up"; id: number } // pointerup, pointercancel, lostpointercapture
  | { t: "release" } // window blur, the page hidden: every finger is up (a mine tapped just before still drops)
  | { t: "clear" }; // the chat or the menu opened, the pad hid: every finger up and no mine either

export interface PadState {
  /** Fingers on the 8-way pad and the zone each is in: row * 3 + col, 0 = top left, 4 = the centre. */
  readonly pad: readonly { readonly id: number; readonly zone: number }[];
  readonly fire: readonly number[]; // fingers holding FIRE
  readonly mineHeld: readonly number[]; // fingers on MINE (lit only; a press is the latch)
  readonly mine: boolean; // MINE pressed since the last read
}

export const PAD_IDLE: PadState = { pad: [], fire: [], mineHeld: [], mine: false };

/** The pad's zone (0..8) of a point: thirds of the pad's box; a finger outside it keeps the nearest edge zone. */
export function padZone(x: number, y: number, r: Rect): number {
  const third = (v: number, size: number) => Math.max(0, Math.min(2, Math.floor((v * 3) / size)));
  return third(y - r.top, r.height) * 3 + third(x - r.left, r.width);
}

/** A zone as the arrow keys it holds: [throttle, steer]. */
export function zoneControls(zone: number): [number, number] {
  const row = Math.floor(zone / 3);
  const col = zone % 3;
  return [row === 0 ? 1 : row === 2 ? -1 : 0, col === 0 ? -1 : col === 2 ? 1 : 0];
}

/** FIRE or MINE: the button the point is on, else the nearer one (the gap between them is no dead spot). */
function weaponAt(x: number, y: number, g: PadGeometry): "fire" | "mine" {
  const dist = (r: Rect) => Math.hypot(Math.max(r.left - x, 0, x - r.left - r.width), Math.max(r.top - y, 0, y - r.top - r.height));
  return dist(g.mine) < dist(g.fire) ? "mine" : "fire";
}

const without = (ids: readonly number[], id: number) => (ids.includes(id) ? ids.filter((i) => i !== id) : ids);

/**
 * The pad's state machine, pure: each pointer event in, the new state out. Every finger is
 * tracked by its pointer id, so two thumbs (or more fingers) work at once. A finger on the pad is
 * hit-tested again as it moves (it slides from zone to zone); one on FIRE or MINE keeps that
 * button until it lifts. A move or lift of a finger the pad does not know is ignored.
 */
export function reducePad(s: PadState, ev: PadEvent, g: PadGeometry): PadState {
  switch (ev.t) {
    case "down": {
      const up = reducePad(s, { t: "up", id: ev.id }, g); // a reused id starts afresh
      if (ev.cluster === "pad") return { ...up, pad: [...up.pad, { id: ev.id, zone: padZone(ev.x, ev.y, g.pad) }] };
      if (weaponAt(ev.x, ev.y, g) === "fire") return { ...up, fire: [...up.fire, ev.id] };
      return { ...up, mineHeld: [...up.mineHeld, ev.id], mine: true };
    }
    case "move": {
      const i = s.pad.findIndex((f) => f.id === ev.id);
      if (i < 0) return s;
      const zone = padZone(ev.x, ev.y, g.pad);
      if (zone === s.pad[i].zone) return s;
      return { ...s, pad: s.pad.map((f, k) => (k === i ? { id: f.id, zone } : f)) };
    }
    case "up": {
      const pad = s.pad.some((f) => f.id === ev.id) ? s.pad.filter((f) => f.id !== ev.id) : s.pad;
      const fire = without(s.fire, ev.id);
      const mineHeld = without(s.mineHeld, ev.id);
      return pad === s.pad && fire === s.fire && mineHeld === s.mineHeld ? s : { ...s, pad, fire, mineHeld };
    }
    case "release":
      return { ...PAD_IDLE, mine: s.mine };
    case "clear":
      return PAD_IDLE;
  }
}

/** What the fingers hold, as the keyboard's Controls; the mine latch is left for readPad. */
export function padControls(s: PadState): Controls {
  let up = false;
  let down = false;
  let left = false;
  let right = false;
  for (const f of s.pad) {
    const [t, st] = zoneControls(f.zone);
    up ||= t > 0;
    down ||= t < 0;
    left ||= st < 0;
    right ||= st > 0;
  }
  return { throttle: (up ? 1 : 0) - (down ? 1 : 0), steer: (right ? 1 : 0) - (left ? 1 : 0), fire: s.fire.length > 0, mine: s.mine };
}

/** One step's read: the controls, and the state with the mine latch taken (as Keyboard.read). */
export function readPad(s: PadState): [Controls, PadState] {
  return [padControls(s), s.mine ? { ...s, mine: false } : s];
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
  stage: HTMLElement; // gets "touch" while touch is in use and "pad-on" while the pad shows
  root: HTMLElement; // both clusters
  pad: HTMLElement; // the 8-way pad's cluster
  weapons: HTMLElement; // FIRE and MINE's cluster
  fire: HTMLElement;
  mine: HTMLElement;
  fireAmmo: HTMLElement;
  mineAmmo: HTMLElement;
}

/**
 * The on-screen controls in the page. One listener per cluster; hit tests use boxes cached when the
 * pad shows or the window changes (nothing is measured on a move). Classes change only when a
 * finger changes zone or button, the ammo text only when a count changes.
 */
export class TouchPad {
  /** Touch is in use: a coarse pointer, or a finger on the screen; a driving key turns it off again. */
  touch = false;
  private state: PadState = PAD_IDLE;
  private geo: PadGeometry | null = null; // null: measured at the next touch
  private shown = false;
  private lit = 0; // bit per pad zone, FIRE = bit 9, MINE = bit 10
  private rivets = -1; // the counts shown
  private mines = -1;
  private readonly caps: HTMLElement[];

  constructor(private readonly els: TouchPadEls) {
    this.caps = Array.from({ length: 9 }, (_, z) => els.pad.querySelector<HTMLElement>(`[data-zone="${z}"]`)!);
    const cluster = (el: HTMLElement, name: "pad" | "weapons") => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // no focus, no text selection, no mouse events after it
        el.setPointerCapture(e.pointerId);
        this.apply({ t: "down", id: e.pointerId, cluster: name, x: e.clientX, y: e.clientY });
      });
      el.addEventListener("pointermove", (e) => {
        if (this.state.pad.some((f) => f.id === e.pointerId)) this.apply({ t: "move", id: e.pointerId, x: e.clientX, y: e.clientY });
      });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, (e) => this.apply({ t: "up", id: (e as PointerEvent).pointerId }));
      el.addEventListener("contextmenu", (e) => e.preventDefault()); // a long press opens nothing
    };
    cluster(els.pad, "pad");
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
    // touch, in any phase); a driving key hides the pad again (a laptop with a touch screen, a
    // tablet with a keyboard).
    const coarse = window.matchMedia("(pointer: coarse)");
    this.setTouch(coarse.matches);
    coarse.addEventListener("change", () => coarse.matches && this.setTouch(true));
    window.addEventListener("pointerdown", (e) => e.pointerType === "touch" && this.setTouch(true), true);
    window.addEventListener("keydown", (e) => isDriveKey(e) && this.setTouch(false), true);
  }

  /** Show or hide the pad (main.ts, every frame): only a change touches the DOM; hiding lets go of everything. */
  show(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.els.root.classList.toggle("hidden", !on);
    this.els.stage.classList.toggle("pad-on", on);
    this.geo = null;
    if (!on) this.clear();
  }

  /** Let go of every finger and the mine latch (chat focus, menu open, hidden). */
  clear(): void {
    this.apply({ t: "clear" });
  }

  /** The step's controls (main.ts, every step): the mine latch is taken. */
  read(): Controls {
    const [ctl, next] = readPad(this.state);
    this.state = next;
    return ctl;
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
    // Only a finger going down, or one on the pad moving, is hit-tested: the boxes are measured
    // then if a resize or a show made them stale (never on an ordinary move).
    const g = ev.t === "down" || ev.t === "move" ? (this.geo ??= this.measure()) : ZERO_GEO;
    const next = reducePad(this.state, ev, g);
    if (next === this.state) return;
    this.state = next;
    let lit = 0;
    for (const f of next.pad) lit |= 1 << f.zone;
    if (next.fire.length) lit |= 1 << 9;
    if (next.mineHeld.length) lit |= 1 << 10;
    if (lit === this.lit) return;
    const was = this.lit;
    this.lit = lit;
    const els = [...this.caps, this.els.fire, this.els.mine];
    for (let b = 0; b < els.length; b++) if (((was ^ lit) >> b) & 1) els[b]?.classList.toggle("on", ((lit >> b) & 1) === 1);
  }

  private measure(): PadGeometry {
    const box = (el: HTMLElement): Rect => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    return { pad: box(this.els.pad), fire: box(this.els.fire), mine: box(this.els.mine) };
  }
}

const ZERO_RECT: Rect = { left: 0, top: 0, width: 1, height: 1 };
const ZERO_GEO: PadGeometry = { pad: ZERO_RECT, fire: ZERO_RECT, mine: ZERO_RECT };
