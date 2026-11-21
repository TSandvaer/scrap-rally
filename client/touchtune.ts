// Debug only (?debug=1, TOUCH-2): the touch stick's tuning panel, loaded by main.ts only then.
// A TUNE button (top left, while the touch controls show) opens a panel over the left side with a
// big slider per StickParams value; each change goes to the TouchPad at once, so a thumb on the
// stick feels it while driving. The values are kept in localStorage and read back only here (so
// only under ?debug=1); the panel shows them as text to copy back into STICK_DEFAULTS.

import { STICK_DEFAULTS, type StickParams, type TouchPad } from "./input";

const STORE_KEY = "scrap-rally:stick";

interface Slider {
  key: keyof StickParams;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The value as the panel shows it. */
  show: (v: number, p: StickParams) => string;
}

const share = (v: number, p: StickParams) => `${v.toFixed(2)}R ${Math.round(v * p.radius)}px`;

// Short labels: the panel is about 180 px wide on a phone held upright.
const SLIDERS: Slider[] = [
  { key: "radius", label: "Size R", min: 30, max: 120, step: 1, show: (v) => `${v}px` },
  { key: "steerDead", label: "Steer dead", min: 0, max: 0.5, step: 0.01, show: share },
  { key: "steerLock", label: "Full lock", min: 0.2, max: 1, step: 0.01, show: share },
  { key: "steerCurve", label: "Curve", min: 1, max: 3, step: 0.05, show: (v) => (v === 1 ? "1 linear" : v.toFixed(2)) },
  { key: "throttleDead", label: "Gas dead", min: 0.05, max: 0.8, step: 0.01, show: share },
  { key: "split", label: "Zone from", min: 0.3, max: 0.7, step: 0.01, show: (v) => `${Math.round(v * 100)}% width` },
];

/** The stored values, each kept only if it is a number in its slider's range. */
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
  const out: Partial<StickParams> = {};
  for (const s of SLIDERS) {
    const v = (data as Record<string, unknown>)[s.key];
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

/** The values as text to copy back (a StickParams literal). */
function asText(p: StickParams): string {
  return `{ ${SLIDERS.map((s) => `${s.key}: ${p[s.key]}`).join(", ")} }`;
}

/** Each slider's label, for an aria-label (the visible one is short). */
const LONG: Record<keyof StickParams, string> = {
  radius: "Stick size R in pixels",
  steerDead: "Steer dead zone, share of R",
  steerLock: "Full lock at, share of R",
  steerCurve: "Steer curve, 1 is linear",
  throttleDead: "Gas and brake dead zone, share of R",
  split: "Stick zone starts at, share of the width",
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

  const outs = new Map<keyof StickParams, HTMLElement>();
  const inputs = new Map<keyof StickParams, HTMLInputElement>();
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
    for (const s of SLIDERS) {
      inputs.get(s.key)!.value = String(p[s.key]);
      outs.get(s.key)!.textContent = s.show(p[s.key], p);
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
    const now = `Now: ${c.throttle > 0 ? "gas" : c.throttle < 0 ? "brake" : "no gas"}, steer ${c.steer.toFixed(2)}`;
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
