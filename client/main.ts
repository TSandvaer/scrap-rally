// Browser entry: menu / lobby / results panels, HUD text, camera and the fixed-step loop.

import { CAR_TYPES, carName, CARS, type CarType } from "../shared/cars";
import { CELL_RESPAWN, draftsFor, type DraftEntry } from "../shared/catchup";
import { pointAt } from "../shared/track";
import { MAX_PLAYERS, PAUSE_MAX_MS, type CarSnap, type GameEvent, type ResultRow } from "../shared/protocol";
import { AMMO, AMMO_IDS, priceOf, UPGRADE_IDS, UPGRADES, type ItemId, type Wallet } from "../shared/shop";
import { DEFAULT_SONG_ID, isSongChoice, RANDOM_SONG } from "../shared/sound";
import { trackList, trackName } from "../shared/tracks";
import { isMineMode, MINE_LIFE_TICKS, MINE_MODES, type MineMode } from "../shared/weapons";
import { BotDriver } from "../scripts/bot-ai";
import { AudioEngine, SoundControls } from "./audio";
import { ChatPanel, fitViewport } from "./chat";
import { Game, lostMessage, NO_CONTROLS, type Controls, type TokenStore } from "./game";
import { driving, Effects } from "./gfx/actors";
import { clearMarks } from "./gfx/world";
import { Keyboard, mergeControls, TouchPad, type PadCar } from "./input";
import { JerkMeter } from "./jerk";
import { GameMenu } from "./menu";
import { MusicPlayer, songById } from "./music";
import { connectWs } from "./net";
import { Renderer, type CarView, type CellView, type DrawPose, type HudView } from "./render";
import { RaceSounds } from "./sfx";

const STEP_MS = 1000 / 60;
const MAX_CATCH_UP = 5;

const params = new URLSearchParams(location.search);
const debug = params.get("debug") === "1";
// Debug only: ?autopilot=1 drives the own car with the bot AI (weapons off), lane = ?lane=.
const autopilot = debug && params.get("autopilot") === "1";
// Debug only: ?sounds=1 opens the sound board (client/soundboard.ts, loaded only then).
const soundBoard = debug && params.get("sounds") === "1";
// Debug only: ?preview=1 draws a synthetic track with every feature and scripted cars
// (client/preview.ts, loaded only then) instead of the game.
const preview = debug && params.get("preview") === "1";
// Debug only: ?bench=1 runs the render benchmark (client/bench.ts, loaded only then) instead
// of the game.
const bench = debug && params.get("bench") === "1";
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
  botAdd: $("bot-add"),
  botEasy: $<HTMLButtonElement>("bot-easy"),
  botNormal: $<HTMLButtonElement>("bot-normal"),
  botHard: $<HTMLButtonElement>("bot-hard"),
  trackSelect: $<HTMLSelectElement>("track-select"),
  trackName: $("track-name"),
  songSelect: $<HTMLSelectElement>("song-select"),
  songName: $("song-name"),
  minesSelect: $<HTMLSelectElement>("mines-select"),
  minesName: $("mines-name"),
  start: $<HTMLButtonElement>("start"),
  startAnyway: $<HTMLButtonElement>("start-anyway"),
  ready: $<HTMLButtonElement>("ready"),
  wait: $("lobby-wait"),
  leave: $<HTMLButtonElement>("leave"),
  results: $("results"),
  resultRows: $("results-rows"),
  resultScrap: $("results-scrap"),
  scrap: $("scrap"),
  carPick: $("car-pick"),
  carNote: $("car-note"),
  shop: $("shop"),
  toast: $("toast"),
};

const game = new Game(() => connectWs(wsUrl, { lag, jitter }), tokens);
const keyboard = new Keyboard(window);
// On-screen controls for touch screens (PLAN-TOUCH): read and cleared wherever the keyboard is.
const touchPad = new TouchPad({
  stage: $("stage"),
  root: $("touch"),
  stick: $("touch-stick"),
  base: $("touch-base"),
  knob: $("touch-knob"),
  weapons: $("touch-weapons"),
  fire: $("touch-fire"),
  mine: $("touch-mine"),
  fireAmmo: $("touch-fire-ammo"),
  mineAmmo: $("touch-mine-ammo"),
});
fitViewport();
const chat = new ChatPanel({
  root: $("chat"),
  dock: $("lobby-chat"),
  stage: $("stage"),
  view: $<HTMLCanvasElement>("view"),
  me: () => game.you,
  send: (text) => game.say(text),
  onFocus: () => {
    keyboard.clear(); // a key held as the chat opens must not keep driving
    touchPad.clear();
  },
});
// Sound: unlocked by the first gesture; music in the room's lobby and results (soundFrame).
const audio = new AudioEngine();
audio.attach();
const music = new MusicPlayer(audio);
const soundControls = new SoundControls(audio, {
  root: $("sound"),
  stage: $("stage"),
  view: $<HTMLCanvasElement>("view"),
  button: $<HTMLButtonElement>("sound-btn"),
  pop: $("sound-pop"),
  music: $<HTMLInputElement>("vol-music"),
  effects: $<HTMLInputElement>("vol-effects"),
  mute: $<HTMLButtonElement>("sound-mute"),
});
let soundPhase = "";
let soundSong = ""; // the song last handed to the MusicPlayer (soundFrame)
let lastControls: Controls = NO_CONTROLS; // the engine's throttle: what the last step drove with
// Rebuilt whenever the room's track changes (it caches the track's paths and decor).
let renderer = new Renderer($<HTMLCanvasElement>("view"), game.track);
let rendererTrack = game.track;
let marksRace = game.raceId; // the race the track's marks (scorches, tyre marks) are from
const jerk = new JerkMeter();
let measuredPhase = "";
const pilot = autopilot ? new BotDriver(game, Number(params.get("lane")) || 0) : null;
if (pilot) pilot.weapons = false;

let connState: "connected" | "reconnecting" | "lost" = "connected";
let restartNotice = false;
// Hit sparks and mine blasts wait out the interpolation delay so they line up with the visible
// hit. They and the rest of a frame's effects are kept in one pooled WorldFx (gfx/actors.ts
// Effects): the effects cost no allocation per frame.
const effects = new Effects();
const BLAST_SHAKE = 4; // view pixels: a mine under the own car (bumps are 1..3)
const INTERP_DELAY_MS = 100;
// Race effects (client/sfx.ts); other cars' event sounds wait out the same delay as the sparks.
const sounds = new RaceSounds(audio, game, INTERP_DELAY_MS);
if (debug) (window as unknown as { scrapDebug: unknown }).scrapDebug = { game, jerk, audio, music, sounds, touchPad };
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
// The room's song (SND-4): the host's pick, sent as a room sound default; everyone hears it.
ui.songSelect.replaceChildren(
  ...[...music.songs, { id: RANDOM_SONG, title: "Random" }].map((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.title;
    return o;
  }),
);
ui.songSelect.addEventListener("change", () => {
  const id = ui.songSelect.value;
  if (isSongChoice(id)) game.setSoundDefaults({ song: id });
  ui.songSelect.blur();
});
// The room's mines (MINES-1): the host's pick, for the next race; everyone sees it.
const MINES_TEXT: Record<MineMode, string> = { stay: "Stay until hit", fade: `Fade after ${MINE_LIFE_TICKS / 60} s` };
ui.minesSelect.replaceChildren(
  ...MINE_MODES.map((mode) => {
    const o = document.createElement("option");
    o.value = mode;
    o.textContent = MINES_TEXT[mode];
    return o;
  }),
);
ui.minesSelect.addEventListener("change", () => {
  const mode = ui.minesSelect.value;
  if (isMineMode(mode)) game.setMines(mode);
  ui.minesSelect.blur();
});
ui.botEasy.addEventListener("click", () => game.addBot("easy"));
ui.botNormal.addEventListener("click", () => game.addBot("normal"));
ui.botHard.addEventListener("click", () => game.addBot("hard"));
ui.start.addEventListener("click", () => game.start());
ui.startAnyway.addEventListener("click", () => game.start(true));
ui.ready.addEventListener("click", () => game.setReady(!game.me()?.ready));
async function copyInvite(): Promise<void> {
  const link = `${location.origin}/?room=${game.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Invite link copied");
  } catch {
    toast(link);
  }
}
function leaveRoom(): void {
  game.leave();
  setRoomInUrl("");
  updatePanels();
}
ui.copy.addEventListener("click", () => void copyInvite());
ui.leave.addEventListener("click", leaveRoom);

// ---- in-game menu (Esc) -----------------------------------------------------------

const menu = new GameMenu({
  root: $("game-menu"),
  game,
  audio,
  onOpen: () => {
    keyboard.clear(); // a key held as the menu opens must not keep driving afterwards
    touchPad.clear();
    soundControls.close();
  },
  leave: leaveRoom,
  copyInvite: () => void copyInvite(),
});
// The menu button (everyone, in a room): under the speaker, so SoundControls places both
// clear of the minimap and the HUD. Touch screens have no Esc key.
const menuBtn = $<HTMLButtonElement>("menu-btn");
menuBtn.addEventListener("click", () => {
  menuBtn.blur();
  menu.open();
});
// Esc opens and closes the menu in a room, in any phase; on the main menu it does nothing.
// The chat input and the sound popover take their own Esc first: the chat prevents its
// default; the popover only closes itself, so whether it was open is noted on the way down
// (capture phase). An open chat overlay whose input lost the focus is closed here instead.
let escPopOpen = false;
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") escPopOpen = !$("sound-pop").classList.contains("hidden");
  },
  true,
);
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.repeat) return;
  if (escPopOpen) {
    soundControls.close();
    return;
  }
  if (chat.open) {
    chat.closeBox();
    return;
  }
  if (game.you) menu.toggle();
});

// A reload of a room page rejoins the same seat (token kept per tab in sessionStorage).
if (roomParam && tokens.get(roomParam)) game.join(roomParam, storedName() || "Driver");

// ---- game callbacks ---------------------------------------------------------------

game.on.welcome = () => {
  sounds.reset(); // a new room or a rejoin: what is on the track already makes no sound
  setRoomInUrl(game.code);
  updatePanels();
};
game.on.room = () => updatePanels();
game.on.retired = (p) => toast(`${p.name} retired from the race`);
game.on.results = () => updatePanels();
game.on.garage = () => renderGarage();
game.on.chat = (line) => chat.add(line);
game.on.chatlog = () => chat.reset(game.chat);
game.on.error = (msg) => {
  if (!game.you) ui.menuErr.textContent = msg;
  else toast(msg);
  if (game.you) {
    renderTrackPick(); // a refused pick shows the room's track again
    renderSongPick();
    renderMinesPick();
  }
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
    if ((reason === "unreachable" || reason === "busy" || reason === "locked") && code) ui.code.value = code;
    ui.menuErr.textContent = lostMessage(reason, wasInRoom);
    updatePanels();
  }
};
game.on.event = (ev: GameEvent, tick: number) => {
  sounds.event(ev, tick);
  const who = game.player(ev.id)?.name ?? "?";
  const mine = ev.id === game.you;
  if (ev.k === "lap" && mine) flashText(`LAP ${ev.lap + 1}/${game.laps}`);
  if (ev.k === "finish") {
    if (mine) {
      flashText(`FINISHED ${ordinal(ev.place)}`, 3000);
      menu.render(); // a finished car cannot retire any more
    }
    else toast(`${who} finished ${ordinal(ev.place)} — ${formatTime(ev.timeMs)}`);
  }
  if (ev.k === "hit") {
    // A mine goes off in a blast; under the own car it shakes the view too.
    const blast = ev.w === "mine";
    effects.spark(ev.id, performance.now() + (mine ? 0 : INTERP_DELAY_MS), blast);
    if (blast && mine) renderer.shake(BLAST_SHAKE);
  }
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

/**
 * The lobby panel (room, garage, docked chat): in the lobby, and for a player who retired from
 * the running race (they shop and chat while the others finish; no start or ready).
 */
function garageOpen(): boolean {
  return !!game.you && (game.phase === "lobby" || (game.phase === "racing" && game.retired()));
}

function updatePanels(): void {
  menu.render(); // the open menu follows the room (closes once we are out of it)
  const inRoom = !!game.you;
  const garage = garageOpen();
  show(menuBtn, inRoom);
  ui.menu.classList.toggle("hidden", inRoom);
  ui.lobby.classList.toggle("hidden", !garage);
  ui.results.classList.toggle("hidden", !inRoom || game.phase !== "results" || !game.results);
  chat.setMode(!inRoom ? "off" : garage ? "docked" : "overlay", debug);
  if (!inRoom) return;

  ui.lobbyCode.textContent = game.code;
  const hostLobby = game.isHost() && game.phase === "lobby";
  ui.players.replaceChildren(
    ...game.players.map((p) => {
      const li = document.createElement("li");
      if (!p.connected) li.classList.add("offline");
      // LOBBY-FIT: a bot's row drops the " (bot)" of its name (its BOT tag says it), so the name
      // fits beside the tag, car picker and Remove; chat, results and the race keep the full name.
      li.append(swatch(p.color), span("name", p.bot ? p.name.replace(/ \(bot\)$/, "") : p.name));
      if (p.bot && hostLobby) li.classList.add("bot-row");
      if (p.id === game.you) li.append(span("tag-pill", "you"));
      if (p.id === game.hostId) li.append(span("tag-pill host", "host"));
      if (!p.connected) li.append(span("tag-pill", "offline"));
      // A bot is always ready: its BOT tag (with the level when Easy or Hard) says enough.
      if (p.bot) li.append(span(`tag-pill bot${p.bot === "hard" ? " hard" : ""}`, p.bot === "normal" ? "bot" : `${p.bot} bot`));
      else if (p.ready && p.id !== game.hostId) li.append(span("tag-pill ready", "ready"));
      if (p.retired) li.append(span("tag-pill", "retired"));
      // The car they race with (M4-CARS); the host picks a bot's in the lobby, on its row.
      if (p.bot && hostLobby) li.append(botCarSelect(p.id, p.name, game.carOf(p.id)));
      else li.append(span("tag-pill car", carName(game.carOf(p.id))));
      if (p.bot && hostLobby) li.append(removeBotButton(p.id, p.name));
      return li;
    }),
  );
  renderBotAdd(hostLobby);
  renderTrackPick();
  renderSongPick();
  renderMinesPick();
  renderLobbyButtons();
  if (game.results) renderResults(game.results);
  if (garage) renderGarage(true);
}

/** A bot row's Remove (host, lobby): the bot leaves at once (kick; nothing is blocked). */
function removeBotButton(id: string, name: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn small row-x";
  b.textContent = "×";
  b.title = `Remove ${name}`;
  b.setAttribute("aria-label", `Remove ${name}`);
  b.addEventListener("click", () => game.kick(id));
  return b;
}

/** A bot row's car (host, lobby): Sport, Racer or Truck; the room message confirms it. */
function botCarSelect(id: string, name: string, car: CarType): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "row-car";
  sel.setAttribute("aria-label", `${name}'s car`);
  for (const t of CAR_TYPES) sel.append(new Option(carName(t), t, false, t === car));
  sel.addEventListener("change", () => game.pickBotCar(id, sel.value as CarType));
  return sel;
}

/** The host's Add bot row (lobby only): off while the room is full. Room messages only. */
function renderBotAdd(on: boolean): void {
  show(ui.botAdd, on);
  const full = game.players.length >= MAX_PLAYERS;
  for (const [b, what] of [[ui.botEasy, "an Easy"], [ui.botNormal, "a Normal"], [ui.botHard, "a Hard"]] as const) {
    b.disabled = full;
    b.title = full ? "The room is full" : `Add ${what} bot`;
  }
}

/**
 * The host picks the track next to Start; everyone else sees its name. Runs on room
 * messages only (not every frame), so the host's pick is not reset before the server's
 * confirmation arrives.
 */
function renderTrackPick(): void {
  const host = game.isHost() && game.phase === "lobby"; // a retired host's garage: no pick

  show(ui.trackSelect, host);
  show(ui.trackName, !host);
  if (ui.trackSelect.value !== game.trackId) ui.trackSelect.value = game.trackId;
  setText(ui.trackName, trackName(game.trackId));
}

/**
 * The room's song, under the track: the host picks it (a song or Random) in the lobby, everyone
 * else sees the name of the song playing; with Random the host sees it beside the pick. Room
 * messages only, as the track pick.
 */
function renderSongPick(): void {
  const host = game.isHost() && game.phase === "lobby";
  const choice = game.soundDefaults.song;
  const random = choice === RANDOM_SONG;
  const title = songById(game.song).title;
  show(ui.songSelect, host);
  if (ui.songSelect.value !== choice) ui.songSelect.value = choice;
  show(ui.songName, !host || random);
  ui.songName.classList.toggle("song-now", host);
  setText(ui.songName, host ? `now ${title}` : random ? `${title} (random)` : title);
}

/**
 * The room's mines, under the song: the host picks in the lobby whether they stay or fade,
 * everyone else sees the pick. Room messages only, as the track pick.
 */
function renderMinesPick(): void {
  const host = game.isHost() && game.phase === "lobby";
  show(ui.minesSelect, host);
  show(ui.minesName, !host);
  if (ui.minesSelect.value !== game.mines) ui.minesSelect.value = game.mines;
  setText(ui.minesName, MINES_TEXT[game.mines]);
}

/**
 * Host: Start (disabled until everyone is ready) and, from forceStartAt, Start anyway.
 * Others: the Ready toggle. Runs every lobby frame, since Start anyway appears on the
 * clock rather than on a room message; it only touches the DOM when something changed.
 */
function renderLobbyButtons(): void {
  if (game.phase !== "lobby") {
    // Retired from the running race: the garage only, no start or ready until the next lobby.
    for (const b of [ui.start, ui.startAnyway, ui.ready]) show(b, false);
    show(ui.wait, true);
    const paused = game.paused ? ` The race is paused by ${game.pausedBy || "the host"}.` : "";
    setText(ui.wait, `You retired — you're in the next race. Shop and chat while the others finish.${paused}`);
    return;
  }
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

/** Rebuild the car row and the shop list only when something they show has changed. */
function renderGarage(force = false): void {
  const w = wallet();
  const key = JSON.stringify([w, game.carType, game.phase]);
  if (!force && key === garageKey) return;
  garageKey = key;
  ui.scrap.textContent = String(w.scrap);
  renderCarPick();
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

/**
 * The Car row (M4-CARS): three cards, name and feel; the one the server confirmed is lit. Free
 * to switch in the lobby; a retired player's garage during a race shows it but cannot change it.
 */
function renderCarPick(): void {
  const lobby = game.phase === "lobby";
  ui.carPick.replaceChildren(
    ...CAR_TYPES.map((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "car-card";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(t === game.carType));
      b.disabled = !lobby;
      b.append(span("car-name", CARS[t].name), span("car-feel", CARS[t].feel));
      b.addEventListener("click", () => {
        if (t !== game.carType) game.pickCar(t);
      });
      return b;
    }),
  );
  setText(ui.carNote, lobby ? "Switching is free. Your upgrades go with you." : "You can change cars in the lobby.");
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
  const hud: HudView = { topLeft: [], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "", debug: [], hp: null, draft: 0, boost: 0 };
  // Race time (clock, countdown, GO!, weapons armed, race closes): stands still while paused.
  const now = game.raceNow();
  const standings = game.standings();
  const mine = game.latest?.cars.get(game.you);
  const racePhase = game.phase === "countdown" || game.phase === "racing" || game.phase === "results";

  if (mine && racePhase) {
    hud.topLeft.push(mine.fin ? "FINISHED" : `LAP ${Math.min(mine.lap + 1, game.laps)}/${game.laps}`);
    hud.topLeft.push(`POS ${standings.findIndex((c) => c.id === game.you) + 1}/${standings.length}`);
    const [rivets, mines] = game.predictedAmmo();
    hud.topLeft.push(`RIV ${String(rivets).padStart(3)} MINE ${mines}`);
    hud.hp = mine.maxHp ? mine.hp / mine.maxHp : null;
    if (game.car) catchHud(hud);
  }
  if ((game.phase === "racing" || game.phase === "results") && game.raceStart) {
    hud.time = formatTime(mine?.fin || Math.max(0, now - game.raceStart));
  }
  const armsIn = game.armsInMs();
  if (mine && !mine.fin && game.raceOnAt(now) && armsIn > 0) {
    hud.notice = `WEAPONS ARMED IN ${Math.ceil(armsIn / 1000)}`;
  }
  if (game.phase === "countdown") {
    const left = game.phaseEnds - now;
    hud.center = left > 0 ? String(Math.ceil(left / 1000)) : "GO!";
    hud.centerSub = mine ? "" : "Spectating";
  } else if (game.phase === "racing" && mine && (now - game.raceStart < 900 || (game.resumeGo > 0 && now >= game.resumeGo && now - game.resumeGo < 900))) {
    hud.center = "GO!"; // the start, and the end of a pause's 3-2-1
  }
  if (flash.text && performance.now() < flash.until) {
    hud.centerSub = flash.text;
    if (!hud.center) hud.center = " ";
  }
  const pause = pauseView();
  if (pause) {
    hud.center = pause.center;
    hud.centerSub = pause.sub;
  }

  if (connState === "reconnecting") {
    hud.banner = restartNotice ? "Server restarting — reconnecting…" : "Connection lost — reconnecting…";
  } else if (pause) hud.banner = pause.banner;
  else if (game.car && game.car.wreck > 0) hud.banner = `WRECKED — back on track in ${(game.car.wreck / 60).toFixed(1)}s`;
  else if (!mine && (game.phase === "countdown" || game.phase === "racing")) {
    // Retired: the garage panel says it (the strip would sit under the panel's bottom edge).
    hud.banner = game.retired() ? "" : "Race in progress — you're in the next one";
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

/**
 * The pause on the canvas (everyone: racers, spectators): "PAUSED" by whom, then the resume
 * 3-2-1 (GO! once it is over and the room message ending the pause is on its way). The banner
 * says how it goes on: the host resumes from the menu, else it resumes by itself.
 */
function pauseView(): { center: string; sub: string; banner: string } | null {
  if (!game.paused) return null;
  const now = game.serverNow();
  if (game.resumeAt) {
    const left = game.resumeAt - now;
    return { center: left > 0 ? String(Math.ceil(left / 1000)) : "GO!", sub: "Get ready", banner: "Race resuming" };
  }
  const by = game.pausedBy || "the host";
  const auto = Math.max(0, Math.ceil((game.pausedAt + PAUSE_MAX_MS - now) / 1000));
  const autoText = `${Math.floor(auto / 60)}:${String(auto % 60).padStart(2, "0")}`;
  return {
    center: "PAUSED",
    sub: `by ${by}`,
    // A touch screen has no Esc: the ☰ button opens the menu (the HUD font has no ☰, so its word).
    banner: game.isHost()
      ? `Race paused — ${touchPad.touch ? "tap Menu" : "Esc"}, then Resume race (resumes by itself in ${autoText})`
      : `Race paused by ${by} — resumes by itself in ${autoText}`,
  };
}

// ---- catch-up cues ----------------------------------------------------------------
// The M4-FX fields (render.ts: CarView.draft and .boost, WorldFx.cells and .nCells, HudView.draft
// and .boost) filled from the M4-DRAFT / M4-CELLS state with nothing made a frame: one array of
// cells whose entries are kept and changed in place, the other cars' drafts worked out once per
// snapshot into kept arrays, and the fields written into the views draw() and hudView() make.
// tools/debug/catch-alloc.ts loads this block by itself (from the line above to its end marker)
// and measures it, so it uses only `game`, shared/catchup.ts and the types main.ts imports.

/** A taken cell's state stays above 0 until it is back (render.ts CellView: 0 = there to be taken). */
const CELL_TAKEN_MIN = 1e-3;
/** Game.cellViews' entries (it fills them in place), and the renderer's: one each per cell of the track. */
const cellSrc: { x: number; y: number; air: boolean; open: boolean; backIn: number }[] = [];
const cellOut: CellView[] = [];

/**
 * This frame's cells into cellOut; returns how many count. None before the countdown: the
 * catch-up sprite sheet is made in the first frame that has a cell (some 20 ms, once a page
 * load: gfx/sprites.ts catchSheet), so that lands in the countdown's first frame, never at GO or
 * mid-race (only a page that joins a race already running makes it then, in its first frame).
 */
function catchCells(): number {
  if (game.phase !== "countdown" && game.phase !== "racing" && game.phase !== "results") return 0;
  const src = game.cellViews(cellSrc);
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    const v = (cellOut[i] ??= { x: 0, y: 0, air: false, state: 0 });
    v.x = s.x;
    v.y = s.y;
    v.air = s.air === true;
    // Taken: the share of its wait (CELL_RESPAWN) still to go, 1 just taken, toward 0 (back any moment).
    v.state = s.open ? 0 : Math.min(1, Math.max(CELL_TAKEN_MIN, s.backIn / CELL_RESPAWN));
  }
  return src.length;
}

// The other cars' slipstream: snapshots carry no draft, so the server's own rule (shared/catchup.ts
// draftsFor, on the start-of-tick poses: the latest snapshot's are those of the next tick) runs on
// the latest snapshot's cars, once per snapshot. The own car's is its prediction (Game.draft).
const draftField: DraftEntry[] = [];
const draftIds: string[] = [];
const draftOut: number[] = [];
let draftN = 0;
let draftSnap: object | null = null;

function draftCar(s: CarSnap): void {
  const e = (draftField[draftN] ??= { car: s, ghost: false, finished: false });
  e.car = s;
  e.ghost = s.ghost;
  e.finished = s.fin > 0;
  draftIds[draftN++] = s.id;
}

/** Work out every car's draft afresh when a new snapshot is in (draw() calls it once a frame). */
function syncDrafts(): void {
  const snap = game.latest;
  if (snap === draftSnap) return;
  draftSnap = snap;
  draftN = 0;
  if (snap) snap.cars.forEach(draftCar);
  draftField.length = draftN;
  draftsFor(draftField, draftOut);
}

/** A car's catch-up fields: the own car's predicted slipstream and boost; another's by the latest snapshot (s). */
function catchCar(v: CarView, s: CarSnap | undefined): void {
  if (v.me) {
    v.draft = game.draft;
    v.boost = game.boostLeft();
    return;
  }
  let w = 0;
  for (let i = 0; i < draftN; i++) {
    if (draftIds[i] === v.id) {
      w = draftOut[i];
      break;
    }
  }
  v.draft = w;
  v.boost = s ? s.boost : 0;
}

/** The HUD's cues: the own car's (as its CarView). */
function catchHud(h: HudView): void {
  h.draft = game.draft;
  h.boost = game.boostLeft();
}
// ---- end of the catch-up cues

// ---- loop -------------------------------------------------------------------------

let last = performance.now();
let acc = 0;
let attract = 0;
let hadTarget = false;

/**
 * The own predicted car as the touch stick's point mode needs it (TOUCH-5): read fresh at every
 * step, as a reconcile replaces game.car; null when there is none. Live: this step's controls drive
 * it (the race on, not wrecked, in the air or falling). One object, refilled (TouchPad copies it).
 */
const padCarNow: PadCar = { h: 0, vf: 0, live: false };
function padCar(): PadCar | null {
  const c = game.car;
  if (!c) return null;
  padCarNow.h = c.h;
  padCarNow.vf = c.vx * Math.cos(c.h) + c.vy * Math.sin(c.h);
  padCarNow.live = c.wreck === 0 && c.air === 0 && c.fall === 0 && game.raceOn();
  return padCarNow;
}

function frame(now: number): void {
  const elapsed = now - last;
  last = now;
  acc += elapsed;
  let steps = 0;
  while (acc >= STEP_MS && steps < MAX_CATCH_UP) {
    // Read every step (a mine tap is latched until read), but drive with nothing while the
    // menu is open: the race keeps running and the car coasts. Keys and touch drive together.
    const ctl = pilot ? pilot.controls() : mergeControls(keyboard.read(), touchPad.read(padCar()));
    lastControls = menu.isOpen ? NO_CONTROLS : ctl;
    game.step(lastControls, STEP_MS);
    acc -= STEP_MS;
    steps++;
  }
  if (acc >= STEP_MS) acc = 0;
  touchFrame();
  draw(acc / STEP_MS, elapsed);
  soundFrame();
  if (garageOpen()) {
    renderGarage();
    renderLobbyButtons();
  }
  requestAnimationFrame(frame);
}

/**
 * Music follows the room's phase, polled every frame since snapshots change it without a
 * room message: on in the lobby (garage) and results, off in the countdown and the race,
 * never on the menu. The sound popover closes as the countdown starts, so a slider cannot
 * keep the driving keys. Race effects: countdown, own-car cues, other cars from the drawn
 * snapshot, held server events, and the engine from the controls the steps used.
 */
function soundFrame(): void {
  // The room's sound defaults are the base of the player's own settings (none outside a room).
  audio.setRoom(game.you ? game.soundDefaults : null, game.isHost());
  // Everyone plays the room's song (outside a room the default). Picked before a start, so the
  // first song heard is the room's; while the music plays only after update(): in the lobby a
  // new pick crossfades, at the countdown (a "random" one picked then) it waits for the next start.
  const song = game.you ? game.song : DEFAULT_SONG_ID;
  const pickSong = () => {
    if (song === soundSong) return;
    soundSong = song;
    music.setSong(song);
  };
  if (music.director.mode === "off") pickSong();
  music.update(!!game.you, game.phase);
  pickSong();
  sounds.frame(lastControls, renderer.cam);
  if (game.phase === "countdown" && soundPhase !== "countdown") soundControls.close();
  soundPhase = game.phase;
}

/**
 * The touch controls show on a touch screen while the own car can drive: the countdown or the race,
 * our car on the field and not finished, and no garage, menu or chat over it (PLAN-TOUCH advisor
 * change 2). Polled every frame, since snapshots and events change it; TouchPad touches the DOM
 * only when it changes, and hiding lets go of every finger. The weapons show their ammo.
 */
function padWanted(): boolean {
  if (!touchPad.touch || (game.phase !== "countdown" && game.phase !== "racing")) return false;
  const s = game.ownSnap();
  return !!game.car && !!s && !s.fin && !garageOpen() && !menu.isOpen && !chat.open;
}

function touchFrame(): void {
  const on = padWanted();
  touchPad.show(on);
  if (!on) return;
  touchPad.hint(game.phase === "countdown"); // where the stick is, until GO
  const [rivets, mines] = game.predictedAmmo();
  touchPad.setAmmo(rivets, mines);
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
  // A new race or a restart: the track's marks go (a new track's went with its renderer).
  if (game.raceId !== marksRace) {
    marksRace = game.raceId;
    clearMarks();
  }
  const cars: CarView[] = [];
  syncDrafts();
  // `at` places the car; `st` carries its airborne / fall / ghost state (game.ts poses).
  const view = (at: DrawPose, st: DrawPose, me: boolean): CarView => {
    const id = at.id;
    const p = game.player(id);
    const s = game.latest?.cars.get(id);
    const wreck = me ? (game.car?.wreck ?? 0) > 0 : !!s?.wreck;
    const ghost = !!(st.ghost || s?.ghost);
    const { x, y, h } = at;
    const hp = s && s.maxHp > 0 ? s.hp / s.maxHp : 1;
    // The car's look (M4-CARS): the type the room message names; absent or unknown = the Sport.
    const car = game.carOf(id);
    const v: CarView = { id, x, y, h, me, color: p?.color ?? "#888", name: p?.name ?? "?", wreck, ghost, height: st.height, falling: st.falling, hp, car, draft: 0, boost: 0 };
    catchCar(v, s);
    return v;
  };
  // Other cars at the interpolation time; near ones are drawn at their predicted pose,
  // where the own car bumps into them (client/contact.ts). The state stays the pose's, except
  // the height: the blend eases a near car's height toward its predicted flight too.
  const others: DrawPose[] = game.otherPoses();
  const state = new Map(others.map((o) => [o.id, o]));
  const drawn = game.contact.blend(others, game.car, game.pending.length - 1 + alpha, elapsed);
  for (const o of drawn) cars.push(view(o, { ...(state.get(o.id) ?? o), height: o.height }, false));
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
  const own: DrawPose | null = game.ownPose(alpha);
  if (own) cars.push(view(own, own, true));

  // Camera: own car with a little look-ahead; else the leader; else a slow tour. The renderer
  // is told which car it follows: it steps the view in whole pixels together with that car.
  let target: { x: number; y: number } | null = null;
  let followed = "";
  if (own && game.car) {
    target = { x: own.x + game.car.vx * 0.28, y: own.y + game.car.vy * 0.28 };
    followed = own.id;
  } else {
    const leader = game.standings()[0];
    const pose = leader && drawn.find((o) => o.id === leader.id);
    if (pose) {
      target = pose;
      followed = pose.id;
    }
  }
  if (target) {
    renderer.follow(target.x, target.y, elapsed, !hadTarget, followed);
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
    effects.spark("", now, false, im.x, im.y);
    renderer.shake(Math.max(1, Math.min(BUMP_SHAKE_MAX, im.speed / BUMP_SHAKE_PER)));
    sounds.bump(im.speed, im.x, im.y, renderer.cam);
  }
  const fx = effects.frame(now, game.otherShots(), game.localShots, game.visibleMines(), game.you, own, others);
  fx.cells = cellOut;
  fx.nCells = catchCells();
  // What moves (M4-MOVE: barrels, presses, belts' arrows) at the race tick the own car's drawn step ran
  // at, a spectator's at the latest snapshot's (Game.drawTick); none before a snapshot: a still picture.
  fx.rt = game.drawTick();
  driving(game.car, game.smooth, game.contact, others); // tyre marks: by the cars' driving, not by what the prediction does to them on screen
  renderer.frame(cars, fx, hudView());
}

if (soundBoard) void import("./soundboard").then((m) => m.mountEffects(m.mountSoundBoard(audio, music), audio));
// Debug only: the touch stick's tuning panel (client/touchtune.ts, loaded only then; TOUCH-2).
if (debug && !preview && !bench) void import("./touchtune").then((m) => m.mountTouchTune(touchPad, $("stage")));
if (preview) {
  ui.menu.classList.add("hidden");
  void import("./preview").then((m) => m.runPreview($<HTMLCanvasElement>("view"), params));
} else if (bench) {
  ui.menu.classList.add("hidden");
  void import("./bench").then((m) => m.runBench($<HTMLCanvasElement>("view"), params));
} else {
  updatePanels();
  requestAnimationFrame(frame);
}
