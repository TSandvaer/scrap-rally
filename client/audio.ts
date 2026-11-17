// Audio core (PLAN-SOUND.md): the AudioContext, unlocked by a user gesture; the output chain
// (music bus + effects bus -> light compressor -> master); suspend while the tab is hidden;
// the saved settings; and the speaker button + popover + M key. Only client/main.ts (and the
// debug sound board) import this; client/game.ts stays audio-free for Node.
//
// For sounds (SND-2): connect voices to `engine.buses.sfx`, reuse `engine.noise`, and play
// only while `engine.running()` (nothing before the unlock, nothing while hidden).

import { VIEW_W } from "./render";
import { DEFAULT_SOUND, isMuteKey, parseSoundSettings, type SoundSettings } from "./soundlogic";

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

type Volumes = Pick<SoundSettings, "music" | "effects" | "muted">;

function applyGains(b: Buses, s: Volumes, now: number, instant = false): void {
  const set = (p: AudioParam, v: number) => (instant ? (p.value = v) : p.setTargetAtTime(v, now, GAIN_SMOOTH_S));
  set(b.music.gain, s.music);
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

function loadSettings(): SoundSettings {
  try {
    return parseSoundSettings(localStorage.getItem(STORE_KEY));
  } catch {
    return { ...DEFAULT_SOUND };
  }
}

function saveSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: the settings last until the reload */
  }
}

const UNLOCK_EVENTS = ["pointerup", "click", "keydown"] as const;

export class AudioEngine {
  ctx: AudioContext | null = null; // created on the first gesture
  buses: Buses | null = null;
  noise: AudioBuffer | null = null;
  settings: SoundSettings = loadSettings();
  private armed = false;
  private readonly listeners = new Set<() => void>();
  private readonly unlock = () => this.tryUnlock();

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

  set(patch: Partial<SoundSettings>): void {
    this.settings = parseSoundSettings(JSON.stringify({ ...this.settings, ...patch }));
    saveSettings(this.settings);
    if (this.buses && this.ctx) applyGains(this.buses, this.settings, this.ctx.currentTime);
    this.changed();
  }

  toggleMute(): void {
    this.set({ muted: !this.settings.muted });
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
}

/**
 * The speaker button opens a popover with the music and effects sliders and a mute toggle;
 * M toggles mute anywhere but in a text field. Range inputs swallow the driving keys
 * (client/input.ts) and arrows move them, so every control gives its focus back after use,
 * and close() (at the countdown) drops it too. The slider captions are not <label>s: a click
 * on one would focus its slider with no pointerup or change to blur it.
 */
export class SoundControls {
  constructor(
    private readonly engine: AudioEngine,
    private readonly els: SoundControlEls,
  ) {
    const { root, button, pop, music, effects, mute } = els;
    button.addEventListener("click", () => {
      this.setOpen(pop.classList.contains("hidden"));
      button.blur();
    });
    const slider = (el: HTMLInputElement, key: "music" | "effects") => {
      el.addEventListener("input", () => engine.set({ [key]: Number(el.value) / 100 }));
      el.addEventListener("change", () => el.blur());
      el.addEventListener("pointerup", () => el.blur());
    };
    slider(music, "music");
    slider(effects, "effects");
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
  }

  private setOpen(open: boolean): void {
    const { root, button, pop } = this.els;
    pop.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (!open && root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  private render(): void {
    const s = this.engine.settings;
    const { button, music, effects, mute } = this.els;
    button.classList.toggle("muted", s.muted);
    button.title = s.muted ? "Sound is muted (M)" : "Sound (M mutes)";
    if (document.activeElement !== music) music.value = String(Math.round(s.music * 100));
    if (document.activeElement !== effects) effects.value = String(Math.round(s.effects * 100));
    mute.textContent = s.muted ? "Unmute (M)" : "Mute (M)";
    mute.setAttribute("aria-pressed", String(s.muted));
  }
}

/** Fields that take typed text (where M is a letter); range sliders and buttons are not. */
function isTextField(t: EventTarget | null): boolean {
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return true;
  return t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(t.type);
}
