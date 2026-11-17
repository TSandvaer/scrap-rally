// Pure sound logic (PLAN-SOUND.md): the settings defaults and clamping, the music state
// machine and the sequencer's timing math. No AudioContext, window or localStorage here, so
// scripts/sim-test.ts tests it under Node; client/audio.ts and client/music.ts drive it.

// ---- settings -----------------------------------------------------------------------

export interface SoundSettings {
  music: number; // music volume 0..1
  effects: number; // effects volume 0..1
  muted: boolean;
}

export const DEFAULT_SOUND: Readonly<SoundSettings> = { music: 0.5, effects: 0.8, muted: false };

/** A volume in 0..1; anything that is not a finite number falls back. */
export function clampVolume(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Settings from their stored JSON; missing, broken or out-of-range values get the defaults. */
export function parseSoundSettings(raw: string | null): SoundSettings {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") o = v as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  return {
    music: clampVolume(o.music, DEFAULT_SOUND.music),
    effects: clampVolume(o.effects, DEFAULT_SOUND.effects),
    muted: typeof o.muted === "boolean" ? o.muted : DEFAULT_SOUND.muted,
  };
}

/** The M key toggles mute: e.code KeyM, no auto-repeat, no modifier (text fields are the caller's check). */
export function isMuteKey(e: { code: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return e.code === "KeyM" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

// ---- music state machine ------------------------------------------------------------

export const MUSIC_FADE_IN_S = 1;
export const MUSIC_FADE_OUT_S = 0.8;

/**
 * Music plays in a room in the lobby (the garage is part of it) and on the results screen;
 * not in the countdown or the race, and never on the main menu. Outside a room game.phase
 * reads "lobby" too (client/game.ts leave()), hence the inRoom test.
 */
export function musicWanted(inRoom: boolean, phase: string): boolean {
  return inRoom && (phase === "lobby" || phase === "results");
}

export type MusicAction =
  | "start" // the song from the top, fading in over MUSIC_FADE_IN_S
  | "resume" // wanted again while fading out: fade back in, keep the song position
  | "fadeOut" // fade to silence over MUSIC_FADE_OUT_S; a "stop" follows
  | "stop"; // silence now and stop the sequencer

/**
 * Polled every frame (snapshots change the phase without a room message). `audible` is
 * false until the AudioContext is unlocked and while the tab is hidden or the context is not
 * running: then nothing starts, and music that is no longer wanted stops at once (a fade
 * would not be heard). Unlocking later starts the music if it is wanted (a reload-rejoin
 * has no gesture). `now` is in seconds. `force` (the debug sound board) overrides the
 * room: true plays anywhere, false keeps it off, undefined follows the game.
 */
export class MusicDirector {
  mode: "off" | "on" | "fading" = "off";
  private stopAt = 0;

  update(inRoom: boolean, phase: string, audible: boolean, now: number, force?: boolean): MusicAction | null {
    const wanted = force ?? musicWanted(inRoom, phase);
    if (this.mode === "off") {
      if (!wanted || !audible) return null;
      this.mode = "on";
      return "start";
    }
    if (!wanted && (!audible || !inRoom)) {
      this.mode = "off";
      return "stop";
    }
    if (!audible) return null;
    if (this.mode === "on") {
      if (wanted) return null;
      this.mode = "fading";
      this.stopAt = now + MUSIC_FADE_OUT_S;
      return "fadeOut";
    }
    if (wanted) {
      this.mode = "on";
      return "resume";
    }
    if (now < this.stopAt) return null;
    this.mode = "off";
    return "stop";
  }
}

// ---- sequencer timing ---------------------------------------------------------------

export const SEQ_TIMER_MS = 25; // how often the scheduler wakes
export const SEQ_LOOKAHEAD_S = 0.1; // how far ahead of the audio clock it schedules
export const SEQ_START_DELAY_S = 0.05; // first step after a (re)start, so it is never late

/** Seconds per sequencer step: 4 steps per beat (16th notes). */
export function stepSeconds(bpm: number, stepsPerBeat = 4): number {
  return 60 / bpm / stepsPerBeat;
}

export interface DueStep {
  step: number; // running step count since start(); the song position is step % song length
  time: number; // audio-clock time to play it
}

/**
 * The lookahead scheduler's clock: step k plays at anchor + (k - anchorStep) * stepSec,
 * computed from the step number (no drift from summing). due() hands out every step that
 * falls before now + lookahead and never one before now: a late wake (throttled timer)
 * skips the missed steps on the grid instead of playing them in a burst. While not running
 * (tab hidden, context suspended) nothing is due; when it runs again the clock restarts from
 * now at the next step of the song.
 */
export class StepClock {
  private anchor = 0;
  private anchorStep = 0;
  private next = 0;
  private paused = false;

  constructor(
    readonly stepSec: number,
    readonly lookahead = SEQ_LOOKAHEAD_S,
    readonly startDelay = SEQ_START_DELAY_S,
  ) {}

  start(now: number, fromStep = 0): void {
    this.anchor = now + this.startDelay;
    this.anchorStep = fromStep;
    this.next = fromStep;
    this.paused = false;
  }

  timeOf(step: number): number {
    return this.anchor + (step - this.anchorStep) * this.stepSec;
  }

  /** The next step to be handed out. */
  get position(): number {
    return this.next;
  }

  due(now: number, running: boolean): DueStep[] {
    if (!running) {
      this.paused = true;
      return [];
    }
    if (this.paused) this.start(now, this.next);
    if (this.timeOf(this.next) < now) this.next += Math.ceil((now - this.timeOf(this.next)) / this.stepSec);
    while (this.timeOf(this.next) < now) this.next++; // float rounding of the ceil above
    const out: DueStep[] = [];
    while (this.timeOf(this.next) < now + this.lookahead) {
      out.push({ step: this.next, time: this.timeOf(this.next) });
      this.next++;
    }
    return out;
  }
}
