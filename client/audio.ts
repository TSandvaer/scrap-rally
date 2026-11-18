// Audio core (PLAN-SOUND.md): the AudioContext, unlocked by a user gesture; the output chain
// (music bus + effects bus -> light compressor -> master); suspend while the tab is hidden;
// the saved settings; and the speaker button + popover + M key. Only client/main.ts (and the
// debug sound board) import this; client/game.ts stays audio-free for Node.
//
// For sounds (SND-2): connect voices to `engine.buses.sfx`, reuse `engine.noise`, and play
// only while `engine.running()` (nothing before the unlock, nothing while hidden).

import { VIEW_W } from "./render";
import {
  clampVolume,
  effectiveSound,
  ENGINE_PRESETS,
  isMuteKey,
  musicHeard,
  musicIsOn,
  musicSlid,
  musicSwitched,
  parseStoredSound,
  ROOM_KEYS,
  storedSoundJson,
  type EnginePreset,
  type OwnSettings,
  type RoomBase,
  type RoomKey,
  type SoundSettings,
} from "./soundlogic";

const STORE_KEY = "scrap-rally:sound";
const GAIN_SMOOTH_S = 0.02; // volume and mute changes glide instead of clicking

export interface Buses {
  music: GainNode; // music volume
  sfx: GainNode; // effects volume
  master: GainNode; // mute
}

/** music + sfx -> compressor -> master -> dest. Used live and for offline renders. */
export function buildBuses(ctx: BaseAudioContext, s: Volumes, dest: AudioNode = ctx.destination): Buses {
  const music = ctx.createGain();
  const sfx = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  const master = ctx.createGain();
  music.connect(comp);
  sfx.connect(comp);
  comp.connect(master);
  master.connect(dest);
  const buses = { music, sfx, master };
  applyGains(buses, s, ctx.currentTime, true);
  return buses;
}

/** musicOn absent = on (offline renders pass a plain volume). */
type Volumes = Pick<SoundSettings, "music" | "effects" | "muted"> & { musicOn?: boolean };

function applyGains(b: Buses, s: Volumes, now: number, instant = false): void {
  const set = (p: AudioParam, v: number) => (instant ? (p.value = v) : p.setTargetAtTime(v, now, GAIN_SMOOTH_S));
  set(b.music.gain, musicHeard({ musicOn: s.musicOn !== false, music: s.music }));
  set(b.sfx.gain, s.effects);
  set(b.master.gain, s.muted ? 0 : 1);
}

/** One second of white noise (seeded, so offline renders repeat) for drums and effects. */
export function makeNoise(ctx: BaseAudioContext, seconds = 1): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let x = 0x9e3779b9;
  for (let i = 0; i < d.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    d[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
  }
  return buf;
}

// ---- settings: own and the room's (SND-4) ---------------------------------------------

function loadStored(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function saveStored(json: string): void {
  try {
    localStorage.setItem(STORE_KEY, json);
  } catch {
    /* private mode: the settings last until the reload */
  }
}

const UNLOCK_EVENTS = ["pointerup", "click", "keydown"] as const;

export class AudioEngine {
  ctx: AudioContext | null = null; // created on the first gesture
  buses: Buses | null = null;
  noise: AudioBuffer | null = null;
  /**
   * The effective settings, what is heard (client/soundlogic.ts effectiveSound): each room key
   * the player's own if they moved it, else the room's (the host's), outside a room the
   * built-in default; mute and the engine always the player's own. Read-only for callers.
   */
  settings: SoundSettings;
  /** The room keys this player moved (kept in every room and across reloads). */
  own: OwnSettings;
  /** The room's sound defaults (game.soundDefaults in a room), or null outside a room. */
  room: RoomBase | null = null;
  /** This player is the room's host (their controls say "room" where the others say "host's"). */
  roomHost = false;
  private muted: boolean;
  private enginePreset: EnginePreset;
  private slideStart: { music: number | undefined } | null = null; // a Music slider gesture under way
  private armed = false;
  private readonly listeners = new Set<() => void>();
  private readonly unlock = () => this.tryUnlock();

  constructor() {
    const st = parseStoredSound(loadStored());
    this.own = st.own;
    this.muted = st.muted;
    this.enginePreset = st.engine;
    this.settings = this.effective();
  }

  /** Listen for a gesture that may start audio and for the tab being hidden. */
  attach(): void {
    this.arm();
    document.addEventListener("visibilitychange", () => {
      const ctx = this.ctx;
      if (!ctx) return;
      if (document.hidden) void ctx.suspend().catch(() => {});
      else {
        // The suspend's statechange came while hidden, so nothing re-armed the unlock then. If
        // this resume() does not bring the context back, the next gesture must (stateChanged()
        // disarms once it runs).
        if (ctx.state !== "running") this.arm();
        void ctx.resume().then(() => this.stateChanged(), () => {});
      }
      this.changed();
    });
  }

  /** Sounds may be scheduled: unlocked, running and the tab visible. */
  running(): boolean {
    return this.ctx?.state === "running" && !document.hidden;
  }

  /**
   * The player changed settings: each room key given (musicOn, music, effects) becomes their
   * own; muted and engine are always theirs. Only the keys given are touched and saved.
   */
  set(patch: Partial<SoundSettings>): void {
    this.slideStart = null;
    for (const k of ROOM_KEYS) {
      const v = patch[k];
      if (k === "musicOn" ? typeof v === "boolean" : typeof v === "number" && Number.isFinite(v)) {
        (this.own as Record<RoomKey, unknown>)[k] = k === "musicOn" ? v : clampVolume(v, 0);
      }
    }
    if (typeof patch.muted === "boolean") this.muted = patch.muted;
    if (patch.engine && ENGINE_PRESETS.includes(patch.engine)) this.enginePreset = patch.engine;
    this.update(true);
  }

  /** The master mute (M): the player's own, never a room key. */
  toggleMute(): void {
    this.set({ muted: !this.muted });
  }

  /** The race engine sound (the sound board): the player's own, never a room key. */
  setEngine(p: EnginePreset): void {
    this.set({ engine: p });
  }

  /** Music on/off (musicSwitched): only the music; effects and the master mute stay as they are. */
  toggleMusic(): void {
    this.set(musicSwitched(this.settings));
  }

  /**
   * A Music slider moved (input events, v 0..1): above 0 the volume is the player's (and the
   * music on); 0 is the switch's off, with the volume as it was before this drag. slideEnd()
   * (the slider's change) ends the gesture.
   */
  slideMusic(v: number): void {
    if (!Number.isFinite(v)) return;
    const start = (this.slideStart ??= { music: this.own.music });
    const r = musicSlid(clampVolume(v, 0), this.settings, start.music);
    if (r.musicOn !== undefined) this.own.musicOn = r.musicOn;
    if (r.music === undefined) delete this.own.music;
    else this.own.music = r.music;
    this.update(true);
  }

  slideEnd(): void {
    this.slideStart = null;
  }

  /** "Use host's sound": the room keys follow the room again; mute and the engine stay. */
  useRoomSound(): void {
    this.slideStart = null;
    this.own = {};
    this.update(true);
  }

  /** The player moved any room key. */
  hasOwn(): boolean {
    return ROOM_KEYS.some((k) => this.own[k] !== undefined);
  }

  /** This room key follows the room (the player has not moved it). */
  follows(k: RoomKey): boolean {
    return this.own[k] === undefined;
  }

  /**
   * The room's sound defaults (null outside a room) and whether this player is its host;
   * polled every frame (soundFrame), so it only acts on a change.
   */
  setRoom(room: RoomBase | null, host = false): void {
    const r = this.room;
    const same = room === null ? r === null : r !== null && r.musicOn === room.musicOn && r.music === room.music && r.effects === room.effects;
    if (same && host === this.roomHost) return;
    this.room = room && { musicOn: room.musicOn, music: room.music, effects: room.effects };
    this.roomHost = host;
    this.update(false);
  }

  private effective(): SoundSettings {
    return { ...effectiveSound(this.own, this.room), muted: this.muted, engine: this.enginePreset };
  }

  private update(save: boolean): void {
    this.settings = this.effective();
    if (save) saveStored(storedSoundJson({ own: this.own, muted: this.muted, engine: this.enginePreset }));
    if (this.buses && this.ctx) applyGains(this.buses, this.settings, this.ctx.currentTime);
    this.changed();
  }

  /** Called on settings and context-state changes; returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  // The gesture listeners stay until the context runs; they come back when it stops running
  // while the tab is visible (iOS "interrupted", or the browser suspended it).
  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    for (const ev of UNLOCK_EVENTS) window.addEventListener(ev, this.unlock, { capture: true, passive: true });
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    for (const ev of UNLOCK_EVENTS) window.removeEventListener(ev, this.unlock, { capture: true });
  }

  private tryUnlock(): void {
    if (document.hidden) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: "interactive" });
      } catch {
        this.disarm(); // no Web Audio: the game stays silent
        return;
      }
      this.buses = buildBuses(this.ctx, this.settings);
      this.noise = makeNoise(this.ctx);
      this.ctx.addEventListener("statechange", () => this.stateChanged());
    }
    if (this.ctx.state === "running") this.disarm();
    else void this.ctx.resume().then(() => this.stateChanged(), () => {});
  }

  private stateChanged(): void {
    const state: string = this.ctx?.state ?? "";
    if (state === "running") this.disarm();
    else if (state !== "closed" && !document.hidden) this.arm();
    this.changed();
  }
}

// ---- the controls' room marks (SND-4) -----------------------------------------------------

/**
 * The mark on a setting the room decides for this player ("host's"; on the host's own
 * controls "room"), or "" when they moved it or outside a room. Music: the heard music, so it
 * is the room's while musicOn follows it and, with the music on, the volume does too.
 */
export function roomTag(e: AudioEngine, which: "music" | "effects"): string {
  if (!e.room) return "";
  const follows = which === "effects" ? e.follows("effects") : e.follows("musicOn") && (!e.settings.musicOn || e.follows("music"));
  return follows ? (e.roomHost ? "room" : "host's") : "";
}

/** The reset button's text (AudioEngine.useRoomSound), or "" when there is nothing to reset. */
export function resetLabel(e: AudioEngine): string {
  if (!e.hasOwn()) return "";
  return !e.room ? "Default sound" : e.roomHost ? "Use room sound" : "Use host's sound";
}

/** The title of a room mark (hover): what following means. */
export const ROOM_TAG_TITLE = "Set by the host for the room until you change it";

// ---- speaker button, popover, M key ---------------------------------------------------

const BUTTON_PX = 34; // .sound-btn (client/style.css)
const EDGE_PX = 10; // from the screen edge when the button sits in a letterbox bar
const MAP_LEFT = VIEW_W - 112; // the minimap's box in view pixels (client/render.ts minimap())
const MAP_TOP = 4;
const MAP_GAP_PX = 6; // between the button and the minimap

export interface SoundControlEls {
  root: HTMLElement; // holds the button and the popover, placed by layout()
  stage: HTMLElement; // root's positioned parent
  view: HTMLCanvasElement; // the game view (the minimap is in its top right corner)
  button: HTMLButtonElement;
  pop: HTMLElement;
  music: HTMLInputElement; // range 0..100
  effects: HTMLInputElement; // range 0..100
  mute: HTMLButtonElement;
  // SND-4, found by id when not given: the "host's" marks by the sliders and "Use host's sound".
  musicTag?: HTMLElement | null;
  effectsTag?: HTMLElement | null;
  reset?: HTMLButtonElement | null;
  lobby?: LobbyMusicEls | null; // the lobby panel's Music row; found by id when not given
}

/** The lobby panel's Music row (index.html), for every player: switch, volume, mute note. */
export interface LobbyMusicEls {
  toggle: HTMLButtonElement; // role="switch", aria-checked
  music: HTMLInputElement; // range 0..100
  muted: HTMLElement | null; // shown while everything is muted (M)
  tag: HTMLElement | null; // "host's" while the music follows the room
  reset: HTMLButtonElement | null; // "Use host's sound"
}

function lobbyMusicEls(): LobbyMusicEls | null {
  const toggle = document.getElementById("lobby-music-on");
  const music = document.getElementById("lobby-music-vol");
  if (!(toggle instanceof HTMLButtonElement) || !(music instanceof HTMLInputElement)) return null;
  const reset = document.getElementById("lobby-sound-reset");
  return {
    toggle,
    music,
    muted: document.getElementById("lobby-music-muted"),
    tag: document.getElementById("lobby-music-tag"),
    reset: reset instanceof HTMLButtonElement ? reset : null,
  };
}

function byId<T extends HTMLElement>(id: string, type: { new (): T }): T | null {
  const e = document.getElementById(id);
  return e instanceof type ? e : null;
}

/**
 * The speaker button opens a popover with the music and effects sliders and a mute toggle;
 * M toggles mute anywhere but in a text field. Range inputs swallow the driving keys
 * (client/input.ts) and arrows move them, so every control gives its focus back after use,
 * and close() (at the countdown) drops it too. The slider captions are not <label>s: a click
 * on one would focus its slider with no pointerup or change to blur it. The lobby panel's
 * Music row (switch + volume) follows the same rules and shows the same settings.
 */
export class SoundControls {
  private readonly lobby: LobbyMusicEls | null;
  private readonly musicTag: HTMLElement | null;
  private readonly effectsTag: HTMLElement | null;
  private readonly reset: HTMLButtonElement | null;

  constructor(
    private readonly engine: AudioEngine,
    private readonly els: SoundControlEls,
  ) {
    const { root, button, pop, music, effects, mute } = els;
    this.lobby = els.lobby === undefined ? lobbyMusicEls() : els.lobby;
    this.musicTag = els.musicTag === undefined ? document.getElementById("vol-music-tag") : els.musicTag;
    this.effectsTag = els.effectsTag === undefined ? document.getElementById("vol-effects-tag") : els.effectsTag;
    this.reset = els.reset === undefined ? byId("sound-reset", HTMLButtonElement) : els.reset;
    button.addEventListener("click", () => {
      this.setOpen(pop.classList.contains("hidden"));
      button.blur();
    });
    const slider = (el: HTMLInputElement, key: "music" | "effects") => {
      el.addEventListener("input", () => {
        const v = Number(el.value) / 100;
        if (key === "music") engine.slideMusic(v);
        else engine.set({ effects: v });
      });
      el.addEventListener("change", () => {
        engine.slideEnd();
        el.blur();
      });
      el.addEventListener("pointerup", () => el.blur());
    };
    slider(music, "music");
    slider(effects, "effects");
    const resetButton = (b: HTMLButtonElement | null) =>
      b?.addEventListener("click", () => {
        engine.useRoomSound();
        b.blur();
      });
    resetButton(this.reset);
    if (this.lobby) {
      const { toggle, music: lobbyMusic } = this.lobby;
      slider(lobbyMusic, "music");
      toggle.addEventListener("click", () => {
        engine.toggleMusic();
        toggle.blur();
      });
      resetButton(this.lobby.reset);
    }
    mute.addEventListener("click", () => {
      engine.toggleMute();
      mute.blur();
    });
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!root.contains(e.target as Node)) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (!isMuteKey(e) || isTextField(e.target)) return;
      e.preventDefault();
      engine.toggleMute();
    });
    engine.onChange(() => this.render());
    this.render();
    const relayout = () => this.layout();
    const ro = new ResizeObserver(relayout);
    ro.observe(els.view);
    ro.observe(els.stage); // the letterbox bars change without the view changing size
    window.addEventListener("resize", relayout);
    this.layout();
  }

  /**
   * The button never covers the minimap or the HUD: in a letterbox bar beside or above the
   * view when one has room for it (wide desktop windows, phones), else over the view just left
   * of the minimap and level with its top, where the HUD draws nothing (the lap box is top
   * left, the race time and notices top centre).
   */
  private layout(): void {
    const { root, stage, view } = this.els;
    const s = stage.getBoundingClientRect();
    const v = view.getBoundingClientRect();
    let top = EDGE_PX;
    let right = EDGE_PX;
    const room = BUTTON_PX + 2 * EDGE_PX;
    if (s.right - v.right < room && v.top - s.top < room) {
      const scale = v.width / VIEW_W;
      right = s.right - (v.left + MAP_LEFT * scale) + MAP_GAP_PX;
      top = v.top - s.top + MAP_TOP * scale;
    }
    root.style.top = `${Math.round(top)}px`;
    root.style.right = `${Math.round(right)}px`;
  }

  close(): void {
    this.setOpen(false);
    // The lobby panel hides at the countdown: its Music slider, if still focused (keyboard),
    // would keep swallowing the driving keys.
    const a = document.activeElement;
    if (this.lobby && (a === this.lobby.toggle || a === this.lobby.music)) (a as HTMLElement).blur();
  }

  private setOpen(open: boolean): void {
    const { root, button, pop } = this.els;
    pop.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (!open && root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private render(): void {
    const e = this.engine;
    const s = e.settings;
    const { button, music, effects, mute } = this.els;
    button.classList.toggle("muted", s.muted);
    button.title = s.muted ? "Sound is muted (M)" : "Sound (M mutes)";
    const heard = String(Math.round(musicHeard(s) * 100));
    if (document.activeElement !== music) music.value = heard;
    if (document.activeElement !== effects) effects.value = String(Math.round(s.effects * 100));
    mute.textContent = s.muted ? "Unmute (M)" : "Mute (M)";
    mute.setAttribute("aria-pressed", String(s.muted));
    const musicTag = roomTag(e, "music");
    showTag(this.musicTag, musicTag);
    showTag(this.effectsTag, roomTag(e, "effects"));
    const reset = resetLabel(e);
    showTag(this.reset, reset);
    if (this.lobby) {
      const { toggle, music: lobbyMusic, muted, tag, reset: lobbyReset } = this.lobby;
      const on = musicIsOn(s);
      if (document.activeElement !== lobbyMusic) lobbyMusic.value = heard;
      toggle.setAttribute("aria-checked", String(on));
      toggle.textContent = on ? "On" : "Off";
      toggle.title = on ? "Music off (effects stay on)" : "Music on";
      muted?.classList.toggle("hidden", !s.muted);
      showTag(tag, musicTag);
      showTag(lobbyReset, reset);
    }
  }
}

/** Text on an element, hidden when there is none (a room mark, the reset button). */
export function showTag(el: HTMLElement | null, text: string): void {
  if (!el) return;
  if (text && el.textContent !== text) el.textContent = text;
  if (el.title === "" && el.classList.contains("room-tag")) el.title = ROOM_TAG_TITLE;
  el.classList.toggle("hidden", !text);
}

/** Fields that take typed text (where M is a letter); range sliders and buttons are not. */
function isTextField(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return true;
  return t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(t.type);
}
