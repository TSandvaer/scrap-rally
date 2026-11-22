// Debug only (?debug=1, HARD-2): the Hard bots' Bot tune panel, loaded by main.ts only then. It shows
// only to the host, in the lobby, of a room on a server started with the dev flag SCRAP_DEV_BOTS=1
// (the room message's botTune; without the flag the server sends none and refuses the message). A
// BOT TUNE button (top right) opens a panel with a slider per knob value (shared/botdrive.ts BotTune):
// Hard's mistake rate per lap and their size, its pace (1 = today's Hard, 0 = Normal's bend pace) and
// its rivet aim (HARD.rivetSlack). Each change goes to the server ({t:"botTune"}); the next race's
// Hard bots drive with it (the server log prints each mistake: seat, lap, s, kind). The values are
// kept in localStorage (read back only here, so only under ?debug=1) and shown as text to copy: the
// user pastes them and they become Hard's defaults (HARD-3).

import { BOT_TUNE_RANGE, botTuneDefaults, cleanBotTune, type BotTune } from "../shared/botdrive";
import type { Game } from "./game";

const STORE_KEY = "scrap-rally:bottune";

interface Slider {
  key: keyof BotTune;
  label: string;
  long: string; // the aria-label (the visible one is short)
  step: number;
  show: (v: number) => string;
}

const SLIDERS: Slider[] = [
  { key: "rate", label: "Mistakes / lap", long: "Hard bots: mistakes per lap per bot", step: 0.1, show: (v) => (v === 0 ? "0 (none)" : v.toFixed(1)) },
  { key: "size", label: "Mistake size", long: "Hard bots: how big a mistake is, 0 to 1", step: 0.05, show: (v) => v.toFixed(2) },
  { key: "pace", label: "Pace", long: "Hard bots: bend pace, 0 is Normal's, 1 is today's Hard", step: 0.05, show: (v) => (v === 1 ? "1 (Hard)" : v === 0 ? "0 (Normal)" : v.toFixed(2)) },
  { key: "aim", label: "Rivet slack", long: "Hard bots: rivet aim slack in units, wider misses more", step: 0.5, show: (v) => v.toFixed(1) },
];

/** The stored values (each clamped into its range), or the defaults. */
function load(): BotTune {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch {
    return botTuneDefaults();
  }
  if (!raw) return botTuneDefaults();
  try {
    return cleanBotTune({ ...botTuneDefaults(), ...(JSON.parse(raw) as object) }) ?? botTuneDefaults();
  } catch {
    return botTuneDefaults();
  }
}

function save(t: BotTune): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(t));
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

/** The values as HARD's field names, to paste (HARD-3 makes them the defaults). */
function asText(t: BotTune): string {
  return `HARD-2 bot tune: { mistakeRate: ${t.rate}, mistakeSize: ${t.size}, pace: ${t.pace}, rivetSlack: ${t.aim} }`;
}

const same = (a: BotTune, b: BotTune) => a.rate === b.rate && a.size === b.size && a.pace === b.pace && a.aim === b.aim;

/** The panel's own look: placed top right over the lobby; rows, sliders and text as the touch panel's (client/style.css .tune-*). */
const STYLE = `
.bottune-btn { position: fixed; top: 10px; right: 10px; z-index: 30; min-height: 36px; padding: 0 10px; font: inherit; font-size: 12px;
  font-weight: 700; letter-spacing: 1px; color: var(--haz1); background: rgba(18, 14, 11, 0.9); border: 2px solid var(--haz1); cursor: pointer; }
.bottune-panel { position: fixed; top: 54px; right: 10px; z-index: 30; width: min(280px, calc(100vw - 32px)); max-height: calc(100dvh - 70px);
  overflow: auto; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; font-size: 11px; background: rgba(18, 14, 11, 0.95);
  border: 2px solid var(--line); box-shadow: 4px 4px 0 var(--cast); }
.bottune-panel .tune-head { display: flex; justify-content: space-between; align-items: center; }
.bottune-note { margin: 0; color: var(--muted-solid); }
.bottune-server { margin: 0; color: var(--haz2); }
.bottune-hidden { display: none; }
`;

export function mountBotTune(game: Game, root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  let tune = load();
  const btn = el("button", "bottune-btn bottune-hidden", "BOT TUNE");
  btn.type = "button";
  btn.setAttribute("aria-label", "Tune the Hard bots");
  btn.setAttribute("aria-expanded", "false");
  const panel = el("section", "bottune-panel bottune-hidden");
  panel.id = "bottune-panel";
  panel.setAttribute("aria-label", "Hard bot tuning");
  const head = el("div", "tune-head");
  head.append(el("span", "label", "Hard bot tune"));
  const close = el("button", "btn link small", "Close ✕");
  close.type = "button";
  head.append(close);
  panel.append(head, el("p", "bottune-note", "Dev server only. Applies from the next race; the server log prints each mistake."));

  const outs = new Map<keyof BotTune, HTMLElement>();
  const inputs = new Map<keyof BotTune, HTMLInputElement>();
  for (const s of SLIDERS) {
    const row = el("label", "tune-row");
    const line = el("span", "tune-line");
    line.append(el("span", "tune-name", s.label));
    const out = el("b", "tune-val");
    line.append(out);
    const input = el("input", "tune-range");
    input.type = "range";
    input.min = String(BOT_TUNE_RANGE[s.key][0]);
    input.max = String(BOT_TUNE_RANGE[s.key][1]);
    input.step = String(s.step);
    input.dataset.key = s.key;
    input.setAttribute("aria-label", s.long);
    input.addEventListener("input", () => {
      tune = { ...tune, [s.key]: Number(input.value) };
      changed(false);
    });
    input.addEventListener("change", () => send());
    row.append(line, input);
    panel.append(row);
    outs.set(s.key, out);
    inputs.set(s.key, input);
  }

  const server = el("p", "bottune-server");
  const text = el("textarea", "tune-text");
  text.readOnly = true;
  text.rows = 3;
  text.setAttribute("aria-label", "The values, to copy");
  const row = el("div", "tune-buttons");
  const copy = el("button", "btn small", "Copy");
  copy.type = "button";
  const reset = el("button", "btn small", "Today's Hard");
  reset.type = "button";
  row.append(copy, reset);
  panel.append(server, text, row);
  root.append(btn, panel);

  /** The sliders, their values and the text from `tune`; the server's line from the room message. */
  function render(): void {
    for (const s of SLIDERS) {
      inputs.get(s.key)!.value = String(tune[s.key]);
      outs.get(s.key)!.textContent = s.show(tune[s.key]);
    }
    text.value = asText(tune);
    renderServer();
  }
  let serverShown = "";
  function renderServer(): void {
    const t = game.botTune;
    const now = t ? `Next race: ${t.rate.toFixed(1)}/lap, size ${t.size.toFixed(2)}, pace ${t.pace.toFixed(2)}, slack ${t.aim.toFixed(1)}${same(t, tune) ? "" : " (sending…)"}` : "";
    if (now !== serverShown) server.textContent = serverShown = now;
  }
  let sendTimer = 0;
  /** To the server now (a slider let go) or shortly (while one moves). */
  function send(): void {
    clearTimeout(sendTimer);
    sendTimer = 0;
    if (allowed() && game.botTune && !same(game.botTune, tune)) game.tuneBots(tune);
  }
  function changed(now: boolean): void {
    save(tune);
    render();
    if (now) send();
    else if (!sendTimer) sendTimer = window.setTimeout(send, 250);
  }
  render();

  /** The host of a room on a dev-flag server, in the lobby. */
  const allowed = () => !!game.code && game.botTune !== null && game.phase === "lobby" && game.hostId === game.you && !!game.you;

  const setOpen = (open: boolean) => {
    panel.classList.toggle("bottune-hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => setOpen(panel.classList.contains("bottune-hidden")));
  close.addEventListener("click", () => setOpen(false));
  reset.addEventListener("click", () => {
    tune = botTuneDefaults();
    changed(true);
  });
  copy.addEventListener("click", () => {
    text.select();
    try {
      void navigator.clipboard?.writeText(text.value).catch(() => undefined);
    } catch {
      /* no clipboard: the text stays selected to copy by hand */
    }
  });

  // Shown while allowed; on becoming allowed in a room (a new room starts at today's Hard), the
  // stored values go to the server once.
  let syncedFor = "";
  window.setInterval(() => {
    const on = allowed();
    btn.classList.toggle("bottune-hidden", !on);
    if (!on) {
      setOpen(false);
      return;
    }
    if (syncedFor !== game.code) {
      syncedFor = game.code;
      send();
    }
    renderServer();
  }, 250);
}
