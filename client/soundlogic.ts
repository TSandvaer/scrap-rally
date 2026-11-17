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

// ---- race effects (SND-2): levels, caps and trigger decisions -------------------------
//
// client/sfx.ts plays what these decide; client/game.ts queues the own car's cues
// (takeOwnSounds) and exposes the snapshot other cars are drawn from (interpSnapshot).

import type { GameEvent } from "../shared/protocol";
import type { OwnSound } from "./game";

export type SfxKind =
  | "beep" // countdown 3-2-1
  | "go"
  | "rivet"
  | "drop" // mine dropped
  | "blast" // mine went off
  | "hit" // rivet hit
  | "wreck"
  | "bump"
  | "takeoff"
  | "land"
  | "fall"
  | "recover"
  | "lap"
  | "finish";

export const SFX_KINDS: readonly SfxKind[] = ["beep", "go", "rivet", "drop", "blast", "hit", "wreck", "bump", "takeoff", "land", "fall", "recover", "lap", "finish"];

// Other cars: full volume within NEAR_UNITS of the own car (the camera when spectating),
// silent beyond FAR_UNITS, a squared fall-off between; a little quieter than the own car.
export const NEAR_UNITS = 150;
export const FAR_UNITS = 900;
export const OTHER_GAIN = 0.75;
export const PAN_UNITS = 400; // half the view's width in world units (640 px / zoom 0.8 / 2)
export const PAN_MAX = 0.5; // light: never hard left or right

export function distanceGain(d: number): number {
  if (!(d > NEAR_UNITS)) return 1;
  if (d >= FAR_UNITS) return 0;
  const f = 1 - (d - NEAR_UNITS) / (FAR_UNITS - NEAR_UNITS);
  return f * f;
}

/** Stereo pan from the horizontal offset to the camera's centre (screen x). */
export function panFor(dx: number): number {
  return Math.max(-1, Math.min(1, dx / PAN_UNITS)) * PAN_MAX;
}

/**
 * Per-kind caps instead of voice stealing: another car's sound plays only if fewer than
 * `cap` of its kind are sounding and at least `gapMs` passed since the last one started
 * (many cars firing do not stack up). The own car's sounds always play (the game already
 * paces them: rivet cooldown, refractory, bump cooldown) but count for the others.
 */
export const SFX_CAPS: Readonly<Record<SfxKind, { cap: number; gapMs: number }>> = {
  beep: { cap: 2, gapMs: 0 },
  go: { cap: 1, gapMs: 0 },
  rivet: { cap: 6, gapMs: 40 },
  drop: { cap: 3, gapMs: 60 },
  blast: { cap: 3, gapMs: 60 },
  hit: { cap: 4, gapMs: 30 },
  wreck: { cap: 2, gapMs: 100 },
  bump: { cap: 2, gapMs: 90 },
  takeoff: { cap: 3, gapMs: 60 },
  land: { cap: 3, gapMs: 60 },
  fall: { cap: 2, gapMs: 100 },
  recover: { cap: 2, gapMs: 100 },
  lap: { cap: 2, gapMs: 150 },
  finish: { cap: 2, gapMs: 200 },
};

export class SfxCaps {
  private readonly ends = new Map<SfxKind, number[]>(); // end times of the sounding voices
  private readonly last = new Map<SfxKind, number>();

  /** May a `kind` sound lasting durMs start at nowMs? Records it if so. */
  tryStart(kind: SfxKind, nowMs: number, durMs: number, own: boolean): boolean {
    const ends = (this.ends.get(kind) ?? []).filter((e) => e > nowMs);
    const { cap, gapMs } = SFX_CAPS[kind];
    if (!own && (ends.length >= cap || nowMs - (this.last.get(kind) ?? -Infinity) < gapMs)) {
      this.ends.set(kind, ends);
      return false;
    }
    ends.push(nowMs + durMs);
    this.ends.set(kind, ends);
    this.last.set(kind, nowMs);
    return true;
  }
}

/**
 * The own car's take-off, landing, fall and recovery: reconcile() can undo a predicted one a
 * tick off and the next step() predicts it again, so a kind plays at most once per REFRACTORY_MS.
 */
export const REFRACTORY_MS = 400;

export class Refractory {
  private readonly last = new Map<string, number>();
  constructor(readonly ms = REFRACTORY_MS) {}
  allow(kind: string, nowMs: number): boolean {
    const t = this.last.get(kind);
    if (t !== undefined && nowMs - t < this.ms) return false;
    this.last.set(kind, nowMs);
    return true;
  }
  clear(): void {
    this.last.clear();
  }
}

/**
 * Countdown cues: beeps at 3, 2 and 1 s before the start and GO at the start, on the
 * estimated server clock (the countdown text's: phaseEnds, which is raceStart then). Latched
 * per raceStart with a monotonic index, so a clock estimate that jumps back never replays a
 * cue; nothing before the first snapshot (hasClock); a cue more than CUE_LATE_MS late (first
 * seen mid-countdown after a rejoin, a stalled frame, a hidden tab) is passed silently.
 * Returns the cue to play now: 0, 1, 2 = the beeps, 3 = GO; or null.
 */
export const CUE_LATE_MS = 250;
export const COUNTDOWN_CUES = 4;

export class CountdownCues {
  private race = 0;
  private next = 0;

  update(phase: string, raceStart: number, phaseEnds: number, serverNow: number, hasClock: boolean): number | null {
    if (!hasClock || !raceStart || (phase !== "countdown" && phase !== "racing")) return null;
    if (raceStart !== this.race) {
      this.race = raceStart;
      this.next = 0;
    }
    const end = phase === "countdown" && phaseEnds > 0 ? phaseEnds : raceStart;
    let play: number | null = null;
    while (this.next < COUNTDOWN_CUES) {
      const at = end - (COUNTDOWN_CUES - 1 - this.next) * 1000;
      if (serverNow < at) break;
      play = serverNow - at <= CUE_LATE_MS ? this.next : null;
      this.next++;
    }
    return play;
  }
}

/** What the snapshot watcher reads (client/game.ts Snapshot fits). */
export interface WatchedSnap {
  time: number;
  cars: ReadonlyMap<string, { x: number; y: number; air: number; fall: number }>;
  shots: ReadonlyMap<number, { o: string; x: number; y: number }>;
  mines: readonly { id: number; o: string; x: number; y: number }[];
}

export interface Trigger {
  kind: SfxKind;
  own: boolean; // the own car (or a global cue: the countdown): full volume, no pan
  src: "step" | "snap" | "ev" | "bump" | "countdown";
  id?: string; // the car, for its position at play time when x/y are absent
  x?: number;
  y?: number;
  vel?: number; // loudness 0..1 (a bump's closing speed), 1 if absent
}

/**
 * Other cars' shots, mines and take-off / landing / fall / recovery, from the snapshot they
 * are drawn from (the older one at the interpolation time) against the ids and states seen
 * in the snapshot before. The first snapshot, the first after reset() (a welcome) and the
 * first after a gap > SNAP_GAP_MS only seed: mines live 25 s and snapshots survive a
 * rejoin, so what is already on the track makes no sound. The own car is skipped (step()).
 */
export const SNAP_GAP_MS = 250;

export class SnapWatcher {
  private time = -Infinity;
  private shots = new Set<number>();
  private mines = new Set<number>();
  private cars = new Map<string, { air: boolean; fall: boolean }>();
  private seeded = false;

  reset(): void {
    this.seeded = false;
    this.time = -Infinity;
  }

  update(s: WatchedSnap | null, you: string, out: Trigger[]): void {
    if (!s || s.time <= this.time) return; // the same one, or an older one (the clock estimate jumped back)
    const quiet = !this.seeded || s.time - this.time > SNAP_GAP_MS;
    this.time = s.time;
    this.seeded = true;
    const shots = new Set<number>();
    for (const [id, sh] of s.shots) {
      shots.add(id);
      if (!quiet && sh.o !== you && !this.shots.has(id)) out.push({ kind: "rivet", own: false, src: "snap", id: sh.o, x: sh.x, y: sh.y });
    }
    const mines = new Set<number>();
    for (const m of s.mines) {
      mines.add(m.id);
      if (!quiet && m.o !== you && !this.mines.has(m.id)) out.push({ kind: "drop", own: false, src: "snap", id: m.o, x: m.x, y: m.y });
    }
    const cars = new Map<string, { air: boolean; fall: boolean }>();
    for (const [id, c] of s.cars) {
      const now = { air: c.air > 0, fall: c.fall > 0 };
      cars.set(id, now);
      const was = this.cars.get(id);
      if (quiet || !was || id === you) continue;
      const kind: SfxKind | null =
        !was.fall && now.fall ? "fall" : was.fall && !now.fall ? "recover" : !was.air && now.air ? "takeoff" : was.air && !now.air && !now.fall ? "land" : null;
      if (kind) out.push({ kind, own: false, src: "snap", id, x: c.x, y: c.y });
    }
    this.shots = shots;
    this.mines = mines;
    this.cars = cars;
  }
}

/**
 * Server events (hit, wreck, lap, finish). Other cars' wait out the interpolation delay so
 * they sound with the visible hit; a fatal hit is followed by a wreck in the same tick
 * (server/combat.ts damage), so a hit waits until a snapshot of its tick or later has
 * arrived (every event of that tick is in by then: same socket, in order) and a wreck
 * of the same car and tick replaces it. A mine blast is a hit with w "mine"; a fatal one
 * keeps its blast under the wreck.
 */
export const HIT_HOLD_MAX_MS = 150; // never hold a hit longer than this past its time

interface Held {
  t: Trigger;
  tick: number;
  due: number;
  hit: boolean;
}

export class EventGate {
  private held: Held[] = [];

  constructor(readonly delayMs: number) {}

  event(ev: GameEvent, tick: number, you: string, nowMs: number): void {
    const own = ev.id === you;
    const due = own ? nowMs : nowMs + this.delayMs;
    const t = (kind: SfxKind): Trigger => ({ kind, own, src: "ev", id: ev.id });
    if (ev.k === "hit") {
      this.held.push({ t: t(ev.w === "mine" ? "blast" : "hit"), tick, due, hit: true });
    } else if (ev.k === "wreck") {
      const i = this.held.findIndex((h) => h.hit && h.tick === tick && h.t.id === ev.id);
      if (i >= 0) {
        const [h] = this.held.splice(i, 1);
        if (h.t.kind === "blast") this.held.push({ ...h, hit: false });
      }
      this.held.push({ t: t("wreck"), tick, due, hit: false });
    } else {
      this.held.push({ t: t(ev.k), tick, due, hit: false });
    }
  }

  /** The events due now; snapTick = the tick of the newest snapshot received. */
  take(nowMs: number, snapTick: number, out: Trigger[]): void {
    if (!this.held.length) return;
    const keep: Held[] = [];
    for (const h of this.held) {
      const ready = nowMs >= h.due && (!h.hit || snapTick >= h.tick || nowMs >= h.due + HIT_HOLD_MAX_MS);
      if (ready) out.push(h.t);
      else keep.push(h);
    }
    this.held = keep;
  }

  clear(): void {
    this.held = [];
  }
}

const OWN_KIND: Record<OwnSound, SfxKind> = { takeoff: "takeoff", land: "land", fall: "fall", recover: "recover", shot: "rivet", mine: "drop" };
const REFRACTORY_KINDS: ReadonlySet<OwnSound> = new Set(["takeoff", "land", "fall", "recover"]);

/** What the triggers read from the game each frame (client/sfx.ts fills it from client/game.ts). */
export interface SoundView {
  you: string;
  phase: string;
  raceStart: number;
  phaseEnds: number;
  serverNow: number;
  hasClock: boolean;
  snapTick: number;
  own: readonly OwnSound[]; // drained from Game.takeOwnSounds()
  snap: WatchedSnap | null; // Game.interpSnapshot()
}

/**
 * Every trigger decision in one place, for the frame loop: frame() once per frame, event()
 * per server event, bump() per own predicted impact. `audible` = the context runs and the
 * tab is visible; when it is not, nothing is returned or kept for later (the countdown
 * index and the seen ids still advance, so nothing stale plays on return).
 */
export class SoundTriggers {
  readonly countdown = new CountdownCues();
  readonly watch = new SnapWatcher();
  readonly gate: EventGate;
  readonly refractory = new Refractory();

  constructor(delayMs: number) {
    this.gate = new EventGate(delayMs);
  }

  /** A welcome (new room or a rejoin): seed the snapshot ids again, drop held events. */
  reset(): void {
    this.watch.reset();
    this.gate.clear();
    this.refractory.clear();
  }

  event(ev: GameEvent, tick: number, you: string, nowMs: number, audible: boolean): void {
    if (audible) this.gate.event(ev, tick, you, nowMs);
  }

  bump(speed: number, x: number, y: number, audible: boolean): Trigger | null {
    if (!audible) return null;
    return { kind: "bump", own: true, src: "bump", x, y, vel: Math.max(0.3, Math.min(1, speed / 300)) };
  }

  frame(v: SoundView, nowMs: number, audible: boolean): Trigger[] {
    const out: Trigger[] = [];
    const cue = this.countdown.update(v.phase, v.raceStart, v.phaseEnds, v.serverNow, v.hasClock);
    if (cue !== null) out.push({ kind: cue === COUNTDOWN_CUES - 1 ? "go" : "beep", own: true, src: "countdown" });
    for (const s of v.own) {
      if (REFRACTORY_KINDS.has(s) && !this.refractory.allow(s, nowMs)) continue;
      out.push({ kind: OWN_KIND[s], own: true, src: "step" });
    }
    this.watch.update(v.snap, v.you, out);
    if (!audible) {
      this.gate.clear();
      return [];
    }
    this.gate.take(nowMs, v.snapTick, out);
    return out;
  }
}

// ---- engine -------------------------------------------------------------------------

export interface EngineState {
  phase: string;
  hasCar: boolean;
  connected: boolean;
  wreck: number;
  fall: number;
  air: number;
  finished: boolean;
  speed: number;
  topSpeed: number;
  throttle: number; // -1..1, from the controls the frame loop read
}

export const ENGINE_IDLE_HZ = 42;
export const ENGINE_SPAN_HZ = 118; // + this at top speed

/**
 * The own engine: on in the countdown and the race while the car drives; pitch from the
 * speed (higher in the air: no load; a rev at a standstill), gain from the throttle.
 * Silent with no car, disconnected, wrecked, falling, finished or outside a race.
 */
export function engineTarget(e: EngineState): { on: boolean; freq: number; gain: number } {
  const on = e.hasCar && e.connected && (e.phase === "countdown" || e.phase === "racing") && e.wreck === 0 && e.fall === 0 && !e.finished;
  const thr = Math.min(1, Math.abs(e.throttle));
  const v = Math.min(1, Math.max(0, e.speed / Math.max(1, e.topSpeed)));
  const rev = v < 0.15 ? thr * 22 * (1 - v / 0.15) : 0;
  const freq = ENGINE_IDLE_HZ + ENGINE_SPAN_HZ * v + rev + (e.air > 0 ? 24 : 0);
  return { on, freq, gain: on ? 0.4 + 0.6 * (e.air > 0 ? 0.6 : thr) : 0 };
}
