// Browser entry: menu / lobby / results panels, HUD text, camera and the fixed-step loop.

import { pointAt } from "../shared/track";
import type { GameEvent, ResultRow } from "../shared/protocol";
import { AMMO, AMMO_IDS, priceOf, UPGRADE_IDS, UPGRADES, type ItemId, type Wallet } from "../shared/shop";
import { trackList, trackName } from "../shared/tracks";
import { BotDriver } from "../scripts/bot-ai";
import { Game, lostMessage, type TokenStore } from "./game";
import { Keyboard } from "./input";
import { JerkMeter } from "./jerk";
import { connectWs } from "./net";
import { Renderer, type CarView, type HudView, type WorldFx } from "./render";

const STEP_MS = 1000 / 60;
const MAX_CATCH_UP = 5;

const params = new URLSearchParams(location.search);
const debug = params.get("debug") === "1";
// Debug only: ?autopilot=1 drives the own car with the bot AI (weapons off), lane = ?lane=.
const autopilot = debug && params.get("autopilot") === "1";
const lag = Number(params.get("lag")) || 0;
const jitter = Number(params.get("jitter")) || 0;
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const tokens: TokenStore = {
  get(code) {
    try {
      return sessionStorage.getItem(`scrap-rally:token:${code}`);
    } catch {
      return null;
    }
  },
  set(code, token) {
    try {
      sessionStorage.setItem(`scrap-rally:token:${code}`, token);
    } catch {
      /* private mode: reconnect after reload just won't work */
    }
  },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  menu: $("menu"),
  name: $<HTMLInputElement>("name"),
  create: $<HTMLButtonElement>("create"),
  code: $<HTMLInputElement>("code"),
  join: $<HTMLButtonElement>("join"),
  menuErr: $("menu-err"),
  lobby: $("lobby"),
  lobbyCode: $("lobby-code"),
  copy: $<HTMLButtonElement>("copy"),
  players: $("lobby-players"),
  trackSelect: $<HTMLSelectElement>("track-select"),
  trackName: $("track-name"),
  start: $<HTMLButtonElement>("start"),
  startAnyway: $<HTMLButtonElement>("start-anyway"),
  ready: $<HTMLButtonElement>("ready"),
  wait: $("lobby-wait"),
  leave: $<HTMLButtonElement>("leave"),
  results: $("results"),
  resultRows: $("results-rows"),
  resultScrap: $("results-scrap"),
  scrap: $("scrap"),
  shop: $("shop"),
  toast: $("toast"),
};

const game = new Game(() => connectWs(wsUrl, { lag, jitter }), tokens);
const keyboard = new Keyboard(window);
// Rebuilt whenever the room's track changes (it caches the track's paths and decor).
let renderer = new Renderer($<HTMLCanvasElement>("view"), game.track);
let rendererTrack = game.track;
const jerk = new JerkMeter();
let measuredPhase = "";
const pilot = autopilot ? new BotDriver(game, Number(params.get("lane")) || 0) : null;
if (pilot) pilot.weapons = false;
if (debug) (window as unknown as { scrapDebug: unknown }).scrapDebug = { game, jerk };

let connState: "connected" | "reconnecting" | "lost" = "connected";
let restartNotice = false;
// Hit sparks wait out the interpolation delay so they line up with the visible hit.
let sparks: { id: string; start: number; x?: number; y?: number }[] = [];
const SPARK_MS = 260;
const INTERP_DELAY_MS = 100;
const BUMP_SHAKE_MAX = 3; // screen shake of a bump, 1..3 px of the 640x360 view ...
const BUMP_SHAKE_PER = 120; // ... 1 px per this much closing speed (units/s)
let flash = { text: "", until: 0 };
let toastTimer = 0;

// ---- menu -------------------------------------------------------------------------

function storedName(): string {
  try {
    return localStorage.getItem("scrap-rally:name") ?? "";
  } catch {
    return "";
  }
}

function driverName(): string {
  const name = ui.name.value.trim() || "Driver";
  try {
    localStorage.setItem("scrap-rally:name", name);
  } catch {
    /* ignore */
  }
  return name;
}

ui.name.value = storedName();
const roomParam = (params.get("room") ?? "").toUpperCase();
if (roomParam) ui.code.value = roomParam;

ui.create.addEventListener("click", () => {
  ui.menuErr.textContent = "";
  game.create(driverName());
});
const doJoin = () => {
  const code = ui.code.value.trim().toUpperCase();
  if (code.length !== 4) {
    ui.menuErr.textContent = "Room codes have 4 characters";
    return;
  }
  ui.menuErr.textContent = "";
  game.join(code, driverName());
};
ui.join.addEventListener("click", doJoin);
ui.code.addEventListener("keydown", (e) => e.key === "Enter" && doJoin());
ui.name.addEventListener("keydown", (e) => e.key === "Enter" && (ui.code.value ? doJoin() : ui.create.click()));
ui.trackSelect.replaceChildren(
  ...trackList().map((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name;
    return o;
  }),
);
ui.trackSelect.addEventListener("change", () => game.pickTrack(ui.trackSelect.value));
ui.start.addEventListener("click", () => game.start());
ui.startAnyway.addEventListener("click", () => game.start(true));
ui.ready.addEventListener("click", () => game.setReady(!game.me()?.ready));
ui.copy.addEventListener("click", async () => {
  const link = `${location.origin}/?room=${game.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied");
  } catch {
    toast(link);
  }
});
ui.leave.addEventListener("click", () => {
  game.leave();
  setRoomInUrl("");
  updatePanels();
});

// A reload of a room page rejoins the same seat (token kept per tab in sessionStorage).
if (roomParam && tokens.get(roomParam)) game.join(roomParam, storedName() || "Driver");

// ---- game callbacks ---------------------------------------------------------------

game.on.welcome = () => {
  setRoomInUrl(game.code);
  updatePanels();
};
game.on.room = () => updatePanels();
game.on.results = () => updatePanels();
game.on.garage = () => renderGarage();
game.on.error = (msg) => {
  if (!game.you) ui.menuErr.textContent = msg;
  else toast(msg);
  if (game.you) renderTrackPick(); // a refused pick shows the room's track again
};
game.on.connection = (state, reason) => {
  connState = state;
  restartNotice = state === "reconnecting" && reason === "restarting";
  if (state === "lost") {
    const wasInRoom = !!game.you;
    const code = game.code;
    game.leave();
    setRoomInUrl("");
    // The room may still be there: keep its code for another try.
    if ((reason === "unreachable" || reason === "busy") && code) ui.code.value = code;
    ui.menuErr.textContent = lostMessage(reason, wasInRoom);
    updatePanels();
  }
};
game.on.event = (ev: GameEvent) => {
  const who = game.player(ev.id)?.name ?? "?";
  const mine = ev.id === game.you;
  if (ev.k === "lap" && mine) flashText(`LAP ${ev.lap + 1}/${game.laps}`);
  if (ev.k === "finish") {
    if (mine) flashText(`FINISHED ${ordinal(ev.place)}`, 3000);
    else toast(`${who} finished ${ordinal(ev.place)} — ${formatTime(ev.timeMs)}`);
  }
  if (ev.k === "hit") sparks.push({ id: ev.id, start: performance.now() + (mine ? 0 : INTERP_DELAY_MS) });
  if (ev.k === "wreck") {
    const by = game.player(ev.by)?.name ?? "?";
    if (mine) flashText(ev.by === ev.id ? "WRECKED YOURSELF" : `WRECKED BY ${by.toUpperCase()}`, 1500);
    else if (ev.by === game.you) flashText(`YOU WRECKED ${who.toUpperCase()}`, 1500);
    else toast(ev.by === ev.id ? `${who} wrecked themselves` : `${by} wrecked ${who}`);
  }
};

function setRoomInUrl(code: string): void {
  const p = new URLSearchParams(location.search);
  if (code) p.set("room", code);
  else p.delete("room");
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

// ---- panels -----------------------------------------------------------------------

function updatePanels(): void {
  const inRoom = !!game.you;
  ui.menu.classList.toggle("hidden", inRoom);
  ui.lobby.classList.toggle("hidden", !inRoom || game.phase !== "lobby");
  ui.results.classList.toggle("hidden", !inRoom || game.phase !== "results" || !game.results);
  if (!inRoom) return;

  ui.lobbyCode.textContent = game.code;
  ui.players.replaceChildren(
    ...game.players.map((p) => {
      const li = document.createElement("li");
      if (!p.connected) li.classList.add("offline");
      li.append(swatch(p.color), span("name", p.name));
      if (p.id === game.you) li.append(span("tag-pill", "you"));
      if (p.id === game.hostId) li.append(span("tag-pill host", "host"));
      if (!p.connected) li.append(span("tag-pill", "offline"));
      if (p.ready && p.id !== game.hostId) li.append(span("tag-pill ready", "ready"));
      return li;
    }),
  );
  renderTrackPick();
  renderLobbyButtons();
  if (game.results) renderResults(game.results);
  if (game.phase === "lobby") renderGarage(true);
}

/**
 * The host picks the track next to Start; everyone else sees its name. Runs on room
 * messages only (not every frame), so the host's pick is not reset before the server's
 * confirmation arrives.
 */
function renderTrackPick(): void {
  const host = game.isHost();
  show(ui.trackSelect, host);
  show(ui.trackName, !host);
  if (ui.trackSelect.value !== game.trackId) ui.trackSelect.value = game.trackId;
  setText(ui.trackName, trackName(game.trackId));
}

/**
 * Host: Start (disabled until everyone is ready) and, from forceStartAt, Start anyway.
 * Others: the Ready toggle. Runs every lobby frame, since Start anyway appears on the
 * clock rather than on a room message; it only touches the DOM when something changed.
 */
function renderLobbyButtons(): void {
  const host = game.isHost();
  const waiting = game.waitingFor();
  const ready = !!game.me()?.ready;
  show(ui.start, host);
  ui.start.disabled = waiting > 0;
  setText(ui.start, waiting > 0 ? `Waiting for ${waiting} to get ready` : "Start race");
  show(ui.startAnyway, host && waiting > 0 && game.canForceStart());
  show(ui.ready, !host);
  ui.ready.classList.toggle("primary", !ready);
  setText(ui.ready, ready ? "Cancel ready" : "I'm ready");
  show(ui.wait, !host);
  setText(ui.wait, ready ? "Ready — waiting for the host to start…" : "Shop first, then tell the host you're ready");
}

function show(el: HTMLElement, on: boolean): void {
  el.classList.toggle("hidden", !on);
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function renderResults(rows: ResultRow[]): void {
  ui.resultRows.replaceChildren(
    ...rows.map((r, i) => {
      const li = document.createElement("li");
      if (r.id === game.you) li.classList.add("me");
      li.append(span("place", String(i + 1)), swatch(r.color), span("name", r.name));
      li.append(span("time", r.timeMs ? formatTime(r.timeMs) : "DNF"), span("earned", `+${r.earned}`));
      return li;
    }),
  );
  ui.resultScrap.textContent = `You have ${game.scrap} scrap for the garage`;
}

// ---- garage -----------------------------------------------------------------------

let garageKey = "";

function wallet(): Wallet {
  const [rivets, mines] = game.serverAmmo;
  return { scrap: game.scrap, levels: { ...game.levels }, ammo: { rivets, mines } };
}

/** Rebuild the shop list only when something it shows has changed. */
function renderGarage(force = false): void {
  const w = wallet();
  const key = JSON.stringify(w);
  if (!force && key === garageKey) return;
  garageKey = key;
  ui.scrap.textContent = String(w.scrap);
  const row = (item: ItemId, name: string, blurb: string, extra: HTMLElement) => {
    const li = document.createElement("li");
    const title = span("item", name);
    title.append(extra);
    const price = priceOf(item, w);
    const btn = document.createElement("button");
    btn.className = "btn buy";
    btn.textContent = price === null ? "Maxed" : `${price}`;
    btn.disabled = price === null || price > w.scrap;
    btn.title = price === null ? "Maxed out" : `Buy for ${price} scrap`;
    btn.addEventListener("click", () => game.buy(item));
    li.append(title, btn, span("blurb", blurb));
    return li;
  };
  ui.shop.replaceChildren(
    ...UPGRADE_IDS.map((id) => {
      const u = UPGRADES[id];
      const pips = span("pips", "");
      for (let i = 0; i < u.prices.length; i++) {
        const pip = document.createElement("i");
        if (i < w.levels[id]) pip.className = "on";
        pips.append(pip);
      }
      pips.setAttribute("aria-label", `level ${w.levels[id]} of ${u.prices.length}`);
      return row(id, u.name, `${u.blurb} per level`, pips);
    }),
    ...AMMO_IDS.map((id) => {
      const a = AMMO[id];
      const use = id === "rivets" ? "Hold Space / Z / J to fire" : "Tap X / K to drop behind you";
      return row(id, `${a.name} ×${a.pack}`, use, span("count", `${w.ammo[id]}/${a.cap}`));
    }),
  );
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function swatch(color: string): HTMLSpanElement {
  const s = span("swatch", "");
  s.style.background = color;
  return s;
}

function toast(text: string): void {
  ui.toast.textContent = text;
  ui.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.add("hidden"), 2600);
}

function flashText(text: string, ms = 1500): void {
  flash = { text, until: performance.now() + ms };
}

// ---- HUD --------------------------------------------------------------------------

function formatTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor((ms % 1000) / 100);
  return `${m}:${String(s).padStart(2, "0")}.${t}`;
}

function ordinal(n: number): string {
  const s = ["TH", "ST", "ND", "RD"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function hudView(): HudView | null {
  if (!game.you) return null;
  const hud: HudView = { topLeft: [], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "", debug: [], hp: null };
  const now = game.serverNow();
  const standings = game.standings();
  const mine = game.latest?.cars.get(game.you);
  const racePhase = game.phase === "countdown" || game.phase === "racing" || game.phase === "results";

  if (mine && racePhase) {
    hud.topLeft.push(mine.fin ? "FINISHED" : `LAP ${Math.min(mine.lap + 1, game.laps)}/${game.laps}`);
    hud.topLeft.push(`POS ${standings.findIndex((c) => c.id === game.you) + 1}/${standings.length}`);
    const [rivets, mines] = game.predictedAmmo();
    hud.topLeft.push(`RIV ${String(rivets).padStart(3)} MINE ${mines}`);
    hud.hp = mine.maxHp ? mine.hp / mine.maxHp : null;
  }
  if ((game.phase === "racing" || game.phase === "results") && game.raceStart) {
    hud.time = formatTime(mine?.fin || Math.max(0, now - game.raceStart));
  }
  const armsIn = game.armsInMs();
  if (mine && !mine.fin && game.raceOn() && armsIn > 0) {
    hud.notice = `WEAPONS ARMED IN ${Math.ceil(armsIn / 1000)}`;
  }
  if (game.phase === "countdown") {
    const left = game.phaseEnds - now;
    hud.center = left > 0 ? String(Math.ceil(left / 1000)) : "GO!";
    hud.centerSub = mine ? "" : "Spectating";
  } else if (game.phase === "racing" && now - game.raceStart < 900 && mine) {
    hud.center = "GO!";
  }
  if (flash.text && performance.now() < flash.until) {
    hud.centerSub = flash.text;
    if (!hud.center) hud.center = " ";
  }

  if (connState === "reconnecting") {
    hud.banner = restartNotice ? "Server restarting — reconnecting…" : "Connection lost — reconnecting…";
  } else if (game.car && game.car.wreck > 0) hud.banner = `WRECKED — back on track in ${(game.car.wreck / 60).toFixed(1)}s`;
  else if (!mine && (game.phase === "countdown" || game.phase === "racing")) {
    hud.banner = "Race in progress — you're in the next one";
  } else if (game.phase === "racing" && game.phaseEnds) {
    hud.banner = `Winner is in — race closes in ${Math.max(0, Math.ceil((game.phaseEnds - now) / 1000))}s`;
  }
  if (game.rtt) hud.corner = `${Math.round(game.rtt)} ms`;

  if (debug) {
    const errs = game.recErrors.slice(-120);
    hud.debug = [
      `rtt ${game.rtt.toFixed(1)} ms  lag sim ${lag}±${jitter}`,
      `pending ${game.pending.length}  ack ${game.lastAck}  seq ${game.seq}`,
      `rec err last ${(errs[errs.length - 1] ?? 0).toFixed(2)}  med ${median(errs).toFixed(2)}  max ${Math.max(0, ...errs).toFixed(2)}`,
      `smooth ${Math.hypot(game.smooth.x, game.smooth.y).toFixed(2)}  snaps ${game.snaps.length}`,
      `jerk near ${jerk.near.text()}`,
      `jerk ramp ${jerk.ramp.text()}`,
      `jerk far  ${jerk.far.text()}`,
      `near ${game.players.filter((p) => game.contact.weight(p.id) > 0).map((p) => `${p.name} ${game.contact.weight(p.id).toFixed(2)}`).join(", ") || "-"}`,
    ];
  }
  return hud;
}

// ---- loop -------------------------------------------------------------------------

let last = performance.now();
let acc = 0;
let attract = 0;
let hadTarget = false;

function frame(now: number): void {
  const elapsed = now - last;
  last = now;
  acc += elapsed;
  let steps = 0;
  while (acc >= STEP_MS && steps < MAX_CATCH_UP) {
    game.step(pilot ? pilot.controls() : keyboard.read(), STEP_MS);
    acc -= STEP_MS;
    steps++;
  }
  if (acc >= STEP_MS) acc = 0;
  draw(acc / STEP_MS, elapsed);
  if (game.you && game.phase === "lobby") {
    renderGarage();
    renderLobbyButtons();
  }
  requestAnimationFrame(frame);
}

/** A new room track gets a new Renderer; the camera tour restarts at its start line. */
function syncRenderer(): void {
  if (game.track === rendererTrack) return;
  rendererTrack = game.track;
  renderer = new Renderer($<HTMLCanvasElement>("view"), rendererTrack);
  attract = 0;
  hadTarget = false;
}

function draw(alpha: number, elapsed: number): void {
  syncRenderer();
  const cars: CarView[] = [];
  const view = (id: string, x: number, y: number, h: number, me: boolean): CarView => {
    const p = game.player(id);
    const s = game.latest?.cars.get(id);
    const wreck = me ? (game.car?.wreck ?? 0) > 0 : !!s?.wreck;
    return { id, x, y, h, me, color: p?.color ?? "#888", name: p?.name ?? "?", wreck, ghost: !!s?.ghost };
  };
  // Other cars at the interpolation time; near ones are drawn at their predicted pose,
  // where the own car bumps into them (client/contact.ts).
  const others = game.otherPoses();
  const drawn = game.contact.blend(others, game.car, game.pending.length - 1 + alpha, elapsed);
  for (const o of drawn) cars.push(view(o.id, o.x, o.y, o.h, false));
  game.contact.diagOn = debug && game.phase === "racing";
  if (debug && game.phase === "racing" && measuredPhase !== "racing") {
    jerk.reset(); // one race per measurement
    game.contact.resetDiag();
  }
  measuredPhase = game.phase;
  if (debug && game.car && game.phase === "racing") {
    jerk.frame(
      drawn,
      (id) => game.contact.weight(id),
      (id) => {
        const s = game.latest?.cars.get(id);
        return !s || s.wreck > 0 || s.ghost;
      },
      elapsed,
    );
  }
  const own = game.ownPose(alpha);
  if (own) cars.push(view(own.id, own.x, own.y, own.h, true));

  // Camera: own car with a little look-ahead; else the leader; else a slow tour.
  let target: { x: number; y: number } | null = null;
  if (own && game.car) {
    target = { x: own.x + game.car.vx * 0.28, y: own.y + game.car.vy * 0.28 };
  } else {
    const leader = game.standings()[0];
    const pose = leader && drawn.find((o) => o.id === leader.id);
    if (pose) target = pose;
  }
  if (target) {
    renderer.follow(target.x, target.y, elapsed, !hadTarget);
    hadTarget = true;
  } else {
    attract += elapsed / 1000;
    const p = pointAt(game.track, attract * 90);
    renderer.follow(p.x, p.y, elapsed, !hadTarget && attract < 0.05);
    hadTarget = false;
  }
  const now = performance.now();
  // Own predicted bumps: sparks at the contact point and a small shake, right away.
  for (const im of game.contact.takeImpacts()) {
    sparks.push({ id: "", start: now, x: im.x, y: im.y });
    renderer.shake(Math.max(1, Math.min(BUMP_SHAKE_MAX, im.speed / BUMP_SHAKE_PER)));
  }
  sparks = sparks.filter((s) => now < s.start + SPARK_MS);
  const fx: WorldFx = {
    shots: [...game.otherShots(), ...game.localShots],
    mines: game.visibleMines(),
    sparks: [],
  };
  for (const s of sparks) {
    if (now < s.start) continue;
    if (s.x === undefined) {
      // Hit sparks stay at the interpolation time (also on near cars drawn predicted).
      const pose = s.id === game.you ? own : others.find((c) => c.id === s.id);
      if (!pose) continue;
      s.x = pose.x;
      s.y = pose.y;
    }
    fx.sparks.push({ x: s.x, y: s.y!, age: (now - s.start) / SPARK_MS });
  }
  renderer.frame(cars, fx, hudView());
}

updatePanels();
requestAnimationFrame(frame);
