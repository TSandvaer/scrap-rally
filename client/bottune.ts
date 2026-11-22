// Debug only (?debug=1, HARD-2): the Hard bots' Bot tune panel, loaded by main.ts only then. It shows
// only to the host, in the lobby, of a room on a server started with the dev flag SCRAP_DEV_BOTS=1
// (the room message's botTune; without the flag the server sends none and refuses the message). A
// "Bot tune" row under the lobby's Add bot row (in the lobby's own column, so nothing floats over the
// speaker or the ☰ menu at any width) opens a panel below it with a slider per knob value (BotTune):
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

/**
 * The panel's own look (style.css is not this panel's): a row in the lobby's column under Add bot
 * (.track-pick, as the Track and Music rows) and the panel in the flow below it, so the lobby scrolls
 * it like the rest; rows, sliders and text as the touch panel's (client/style.css .tune-*).
 */
const STYLE = `
.bottune-row .bottune-btn { flex: 1; min-width: 0; color: var(--haz1); border-color: var(--haz1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bottune-panel { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; padding: 8px 10px; font-size: 11px;
  background: rgba(18, 14, 11, 0.95); border: 2px solid var(--line); box-shadow: 4px 4px 0 var(--cast); text-align: left; }
.bottune-panel .tune-head { display: flex; justify-content: space-between; align-items: center; }
.bottune-note { margin: 0; color: var(--muted-solid); }
.bottune-server { margin: 0; color: var(--haz2); }
.bottune-row.bottune-hidden, .bottune-panel.bottune-hidden { display: none; }
`;

export function mountBotTune(game: Game, root: HTMLElement): void {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  let tune = load();
  const tuneRow = el("div", "track-pick bottune-row bottune-hidden");
  tuneRow.append(el("span", "label", "Bot tune"));
  const btn = el("button", "btn small bottune-btn", "Hard bots ▾");
  btn.type = "button";
  btn.setAttribute("aria-label", "Tune the Hard bots");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "bottune-panel");
  tuneRow.append(btn);
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
  // Under the lobby's Add bot row (host only, lobby only, like this panel); without it, at the end of root.
  const after = document.getElementById("bot-add");
  if (after) after.after(tuneRow, panel);
  else root.append(tuneRow, panel);

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
  let btnShown = "";
  function renderServer(): void {
    const t = game.botTune;
    const now = t ? `Next race: ${t.rate.toFixed(1)}/lap, size ${t.size.toFixed(2)}, pace ${t.pace.toFixed(2)}, slack ${t.aim.toFixed(1)}${same(t, tune) ? "" : " (sending…)"}` : "";
    if (now !== serverShown) server.textContent = serverShown = now;
    // The row's button says what the next race's Hard bots do, open or shut.
    const label = t ? `${t.rate === 0 ? "No mistakes" : `${t.rate.toFixed(1)}/lap, size ${t.size.toFixed(2)}`}${t.pace === 1 ? "" : `, pace ${t.pace.toFixed(2)}`} ${panel.classList.contains("bottune-hidden") ? "▾" : "▴"}` : "";
    if (label !== btnShown) btn.textContent = btnShown = label;
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
    renderServer();
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
    tuneRow.classList.toggle("bottune-hidden", !on);
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
