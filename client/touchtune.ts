// Debug only (?debug=1, TOUCH-2, TOUCH-5): the touch stick's tuning panel, loaded by main.ts only
// then. A TUNE button (top left, while the touch controls show) opens a panel over the left side with
// the Mode switch (point / rate, TOUCH-5: an A/B on the phone) and a big slider per StickParams value
// of that mode; each change goes to the TouchPad at once, so a thumb on the stick feels it while
// driving. The values are kept in localStorage and read back only here (so only under ?debug=1); the
// panel shows them as text to copy back into STICK_DEFAULTS.

import { STICK_DEFAULTS, type StickMode, type StickParams, type TouchPad } from "./input";

const STORE_KEY = "scrap-rally:stick";
const MODES: readonly StickMode[] = ["point", "rate"];

/** The numeric values (all but mode, which the Mode switch sets). */
type NumKey = Exclude<keyof StickParams, "mode">;

interface Slider {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The modes it is shown in (it keeps its value in the other). */
  modes: readonly StickMode[];
  /** The value as the panel shows it. */
  show: (v: number, p: StickParams) => string;
}

const share = (v: number, p: StickParams) => `${v.toFixed(2)}R ${Math.round(v * p.radius)}px`;
const BOTH = MODES;
const RATE: readonly StickMode[] = ["rate"];
const POINT: readonly StickMode[] = ["point"];

// Short labels: the panel is about 180 px wide on a phone held upright. aimFull starts at 10°: under
// ~4° the steer would swing from lock to lock between steps.
const SLIDERS: Slider[] = [
  { key: "radius", label: "Size R", min: 30, max: 120, step: 1, modes: BOTH, show: (v) => `${v}px` },
  { key: "pointDead", label: "Aim dead", min: 0.1, max: 0.6, step: 0.01, modes: POINT, show: share },
  { key: "aimFull", label: "Full lock at", min: 10, max: 90, step: 1, modes: POINT, show: (v) => `${v}° off` },
  { key: "brakeAngle", label: "Brake past", min: 90, max: 180, step: 1, modes: POINT, show: (v) => (v >= 180 ? "never" : `${v}° off`) },
  { key: "steerDead", label: "Steer dead", min: 0, max: 0.5, step: 0.01, modes: RATE, show: share },
  { key: "steerLock", label: "Full lock", min: 0.2, max: 1, step: 0.01, modes: RATE, show: share },
  { key: "steerCurve", label: "Curve", min: 1, max: 3, step: 0.05, modes: RATE, show: (v) => (v === 1 ? "1 linear" : v.toFixed(2)) },
  { key: "throttleDead", label: "Gas dead", min: 0.05, max: 0.8, step: 0.01, modes: RATE, show: share },
  { key: "split", label: "Zone from", min: 0.3, max: 0.7, step: 0.01, modes: BOTH, show: (v) => `${Math.round(v * 100)}% width` },
];

const isMode = (v: unknown): v is StickMode => v === "point" || v === "rate";

/** The stored values, each kept only if it is a number in its slider's range (mode: one of the modes); missing ones stay the defaults. */
function load(): Partial<StickParams> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const stored = data as Record<string, unknown>;
  const out: Partial<StickParams> = {};
  if (isMode(stored.mode)) out.mode = stored.mode;
  for (const s of SLIDERS) {
    const v = stored[s.key];
    if (typeof v === "number" && Number.isFinite(v) && v >= s.min && v <= s.max) out[s.key] = v;
  }
  return out;
}

function save(p: StickParams): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* private mode: the values last until the reload */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The values as text to copy back (a StickParams literal, in STICK_DEFAULTS' order). */
function asText(p: StickParams): string {
  const keys = Object.keys(STICK_DEFAULTS) as (keyof StickParams)[];
  return `{ ${keys.map((k) => `${k}: ${typeof p[k] === "string" ? JSON.stringify(p[k]) : p[k]}`).join(", ")} }`;
}

/** Each slider's label, for an aria-label (the visible one is short). */
const LONG: Record<NumKey, string> = {
  radius: "Stick size R in pixels",
  steerDead: "Rate mode: steer dead zone, share of R",
  steerLock: "Rate mode: full lock at, share of R",
  steerCurve: "Rate mode: steer curve, 1 is linear",
  throttleDead: "Rate mode: gas and brake dead zone, share of R",
  split: "Stick zone starts at, share of the width",
  pointDead: "Point mode: dead zone, share of R",
  aimFull: "Point mode: full lock from this many degrees off",
  brakeAngle: "Point mode: brake or reverse when pointed more than this many degrees off",
};

export function mountTouchTune(pad: TouchPad, stage: HTMLElement): void {
  pad.setParams(load());

  const btn = el("button", "tune-btn", "TUNE");
  btn.type = "button";
  btn.setAttribute("aria-label", "Tune the touch stick");
  btn.setAttribute("aria-expanded", "false");
  const panel = el("section", "tune-panel hidden");
  panel.id = "tune-panel";
  panel.setAttribute("aria-label", "Touch stick tuning");
  const head = el("div", "tune-head");
  head.append(el("span", "label", "Stick tuning"));
  const close = el("button", "btn link small", "Close ✕");
  close.type = "button";
  head.append(close);
  panel.append(head);

  // The Mode switch (TOUCH-5): point or rate, live; the sliders of the other mode hide. Two radio
  // buttons with the lobby music switch's lamp (lit on the mode in use).
  const modeRow = el("div", "tune-buttons");
  modeRow.setAttribute("role", "radiogroup");
  modeRow.setAttribute("aria-label", "Steering mode");
  const modeBtns = new Map<StickMode, HTMLButtonElement>();
  for (const m of MODES) {
    const b = el("button", "btn small music-switch", m === "point" ? "Point" : "Rate");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.mode = m;
    b.addEventListener("click", () => {
      if (pad.stickParams().mode === m) return;
      pad.setParams({ mode: m });
      changed();
    });
    modeRow.append(b);
    modeBtns.set(m, b);
  }
  panel.append(modeRow);

  const outs = new Map<NumKey, HTMLElement>();
  const inputs = new Map<NumKey, HTMLInputElement>();
  const rows = new Map<NumKey, HTMLElement>();
  for (const s of SLIDERS) {
    const row = el("label", "tune-row");
    const line = el("span", "tune-line");
    line.append(el("span", "tune-name", s.label));
    const out = el("b", "tune-val");
    line.append(out);
    const input = el("input", "tune-range");
    input.type = "range";
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.dataset.key = s.key;
    input.setAttribute("aria-label", LONG[s.key]);
    input.addEventListener("input", () => {
      pad.setParams({ [s.key]: Number(input.value) });
      changed();
    });
    row.append(line, input);
    panel.append(row);
    outs.set(s.key, out);
    inputs.set(s.key, input);
    rows.set(s.key, row);
  }

  const live = el("p", "tune-live");
  const text = el("textarea", "tune-text");
  text.readOnly = true;
  text.rows = 5;
  text.setAttribute("aria-label", "The values, to copy");
  const row = el("div", "tune-buttons");
  const copy = el("button", "btn small", "Copy");
  copy.type = "button";
  const reset = el("button", "btn small", "Defaults");
  reset.type = "button";
  row.append(copy, reset);
  panel.append(live, text, row);
  stage.append(btn, panel);

  /** The sliders, their values and the text from the TouchPad's values; stored. */
  function render(): void {
    const p = pad.stickParams();
    for (const [m, b] of modeBtns) b.setAttribute("aria-checked", String(m === p.mode));
    for (const s of SLIDERS) {
      inputs.get(s.key)!.value = String(p[s.key]);
      outs.get(s.key)!.textContent = s.show(p[s.key], p);
      rows.get(s.key)!.classList.toggle("hidden", !s.modes.includes(p.mode));
    }
    text.value = asText(p);
  }
  function changed(): void {
    save(pad.stickParams());
    render();
  }
  render();

  // What the stick gives right now, while the panel is open: written only when it changes.
  let shown = "";
  let raf = 0;
  const tick = () => {
    const c = pad.peek();
    const now = `Now: ${c.throttle > 0 ? "gas" : c.throttle < 0 ? "brake/rev" : "no gas"}, steer ${c.steer.toFixed(2)}`;
    if (now !== shown) live.textContent = shown = now;
    raf = requestAnimationFrame(tick);
  };

  const setOpen = (open: boolean) => {
    panel.classList.toggle("hidden", !open);
    stage.classList.toggle("tuning", open); // the split line shows
    btn.setAttribute("aria-expanded", String(open));
    cancelAnimationFrame(raf);
    if (open) tick();
  };
  btn.addEventListener("click", () => setOpen(panel.classList.contains("hidden")));
  close.addEventListener("click", () => setOpen(false));
  reset.addEventListener("click", () => {
    pad.setParams({ ...STICK_DEFAULTS });
    changed();
  });
  copy.addEventListener("click", () => {
    text.select();
    try {
      void navigator.clipboard?.writeText(text.value).catch(() => undefined);
    } catch {
      /* no clipboard: the text stays selected to copy by hand */
    }
  });
}
