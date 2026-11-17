// Race sound effects (PLAN-SOUND.md, SND-2): synthesized recipes on the effects bus, the own
// car's engine, and RaceSounds, which plays what client/soundlogic.ts SoundTriggers decides
// each frame. Every recipe is a short graph of oscillators, the shared noise buffer, filters
// and envelopes, built when the sound starts and disconnected when its last source ends;
// nothing is allocated per frame (the engine only moves its parameters). Only client/main.ts
// and the debug sound board import this; client/game.ts stays audio-free.

import type { AudioEngine } from "./audio";
import type { Controls, Game } from "./game";
import {
  distanceGain,
  engineTarget,
  OTHER_GAIN,
  panFor,
  SfxCaps,
  SoundTriggers,
  type SfxKind,
  type SoundView,
  type Trigger,
} from "./soundlogic";
import type { GameEvent } from "../shared/protocol";

/** Peak level of each effect at gain 1, before the effects volume. */
const LEVEL: Record<SfxKind, number> = {
  beep: 0.32,
  go: 0.36,
  rivet: 0.3,
  drop: 0.42,
  blast: 0.75,
  hit: 0.34,
  wreck: 0.7,
  bump: 0.55,
  takeoff: 0.34,
  land: 0.5,
  fall: 0.3,
  recover: 0.26,
  lap: 0.3,
  finish: 0.32,
};

/** How long each effect sounds (s): its sources stop then; also what the per-kind caps count. */
export const SFX_DUR: Record<SfxKind, number> = {
  beep: 0.18,
  go: 0.6,
  rivet: 0.12,
  drop: 0.42,
  blast: 1.3,
  hit: 0.3,
  wreck: 1.3,
  bump: 0.25,
  takeoff: 0.55,
  land: 0.35,
  fall: 1.15,
  recover: 0.32,
  lap: 0.45,
  finish: 1.1,
};

const ENGINE_LEVEL = 0.13;
const ENGINE_MULT = [1, 1.006, 0.5]; // two saws (one detuned) and the square sub-octave

type Src = AudioScheduledSourceNode;

/** One sound being built: its nodes, its sources, and helpers that register both. */
class Voice {
  readonly nodes: AudioNode[] = [];
  readonly sources: Src[] = [];
  constructor(
    readonly c: BaseAudioContext,
    readonly out: AudioNode, // the voice's gain (-> pan -> effects bus)
    readonly t: number,
    readonly end: number,
    private readonly noiseBuf: AudioBuffer,
  ) {}

  osc(type: OscillatorType, hz: number, at = this.t, stop = this.end): OscillatorNode {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    o.start(at);
    o.stop(stop);
    this.sources.push(o);
    return o;
  }

  noise(at = this.t, stop = this.end, offset = 0): AudioBufferSourceNode {
    const n = this.c.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    n.start(at, offset % this.noiseBuf.duration);
    n.stop(stop);
    this.sources.push(n);
    return n;
  }

  filter(type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode {
    const f = this.c.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    this.nodes.push(f);
    return f;
  }

  /** A gain with a fast attack to `peak`, then an exponential decay (time constant tau). */
  env(peak: number, tau: number, at = this.t, attack = 0.002, hold = 0): GainNode {
    const g = this.c.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.setTargetAtTime(0, at + attack + hold, tau);
    this.nodes.push(g);
    return g;
  }

  /** Chain the nodes and end in the voice output. */
  chain(...ns: AudioNode[]): void {
    for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]);
    ns[ns.length - 1].connect(this.out);
  }
}

/** Soft clipping for grit (explosion, wreck); built once. */
function driveCurve(k = 3, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

/**
 * The recipes. Works on any BaseAudioContext, so the sound board renders them offline too.
 * play() starts one effect at audio time t with a loudness and a stereo pan.
 */
export class SfxVoices {
  voicesStarted = 0;
  private readonly curve = driveCurve();

  constructor(
    readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly noiseBuf: AudioBuffer,
  ) {}

  play(kind: SfxKind, t: number, gain = 1, pan = 0): void {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = gain * LEVEL[kind];
    const p = c.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.out);
    const v = new Voice(c, g, t, t + SFX_DUR[kind], this.noiseBuf);
    v.nodes.push(g, p);
    RECIPES[kind](v, this);
    let left = v.sources.length;
    const done = () => {
      if (--left > 0) return;
      for (const s of v.sources) s.disconnect();
      for (const n of v.nodes) n.disconnect();
    };
    for (const s of v.sources) s.addEventListener("ended", done, { once: true });
    this.voicesStarted++;
  }

  shaper(v: Voice): WaveShaperNode {
    const w = v.c.createWaveShaper();
    w.curve = this.curve;
    v.nodes.push(w);
    return w;
  }

  engine(): EngineVoice {
    return new EngineVoice(this.ctx, this.out);
  }
}

/** A short metallic clang: two inharmonic squares through a ringing band-pass. */
function clang(v: Voice, at: number, f1: number, f2: number, band: number, peak: number, tau: number): void {
  const f = v.filter("bandpass", band, 3);
  const e = v.env(peak, tau, at, 0.001);
  v.osc("square", f1, at, at + tau * 6).connect(f);
  v.osc("square", f2, at, at + tau * 6).connect(f);
  v.chain(f, e);
}

/** A short pitched blip (square or triangle) with its own envelope. */
function blip(v: Voice, type: OscillatorType, hz: number, at: number, peak: number, tau: number, hold = 0, toHz?: number): OscillatorNode {
  const o = v.osc(type, hz, at, at + hold + tau * 6);
  if (toHz) o.frequency.exponentialRampToValueAtTime(toHz, at + hold + tau * 2);
  v.chain(o, v.env(peak, tau, at, 0.003, hold));
  return o;
}

const RECIPES: Record<SfxKind, (v: Voice, s: SfxVoices) => void> = {
  // Countdown: a square beep at D5, then a brighter two-note GO that bends up a touch.
  beep(v) {
    const lp = v.filter("lowpass", 2600);
    const o = v.osc("square", 587.3);
    v.chain(o, lp, v.env(1, 0.03, v.t, 0.003, 0.08));
  },
  go(v) {
    const lp = v.filter("lowpass", 3800);
    const e = v.env(1, 0.12, v.t, 0.004, 0.22);
    for (const hz of [880, 1318.5]) {
      const o = v.osc("square", hz);
      o.frequency.linearRampToValueAtTime(hz * 1.03, v.t + 0.25);
      o.connect(lp);
    }
    v.chain(lp, e);
  },
  // Rivet gun: a hiss of band-passed noise, a falling square snap and a little thump.
  rivet(v) {
    const t = v.t;
    v.chain(v.noise(t, v.end, Math.random()), v.filter("bandpass", 3400, 1.3), v.env(1, 0.022, t, 0.001));
    blip(v, "square", 1500, t, 0.45, 0.018, 0, 380);
    blip(v, "triangle", 210, t, 0.5, 0.03);
  },
  // Mine dropped: a heavy clunk on the road, then two arming ticks.
  drop(v) {
    const t = v.t;
    blip(v, "triangle", 260, t, 1, 0.05, 0, 110);
    v.chain(v.noise(t, t + 0.2, Math.random()), v.filter("bandpass", 900, 2), v.env(0.6, 0.03, t, 0.001));
    blip(v, "square", 2100, t + 0.2, 0.16, 0.01);
    blip(v, "square", 2100, t + 0.32, 0.16, 0.01);
  },
  // Mine blast: a gritty low-passed noise burst closing down, a sine boom and a crackle.
  blast(v, s) {
    const t = v.t;
    const lp = v.filter("lowpass", 4200);
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.8);
    v.chain(v.noise(t, v.end, Math.random()), lp, s.shaper(v), v.env(1, 0.28, t, 0.002, 0.03));
    blip(v, "sine", 110, t, 1, 0.2, 0.02, 30);
    v.chain(v.noise(t, t + 0.4, Math.random()), v.filter("highpass", 2600), v.env(0.35, 0.05, t + 0.01, 0.001));
  },
  // Rivet hit: a metal clang and a click.
  hit(v) {
    const t = v.t;
    clang(v, t, 1180, 1735, 2600, 1, 0.05);
    v.chain(v.noise(t, t + 0.08, Math.random()), v.filter("highpass", 3200), v.env(0.6, 0.012, t, 0.001));
  },
  // Wreck: a crunch (driven noise closing down + a falling saw), then debris clanks.
  wreck(v, s) {
    const t = v.t;
    const lp = v.filter("lowpass", 2000);
    lp.frequency.setValueAtTime(2000, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.7);
    v.chain(v.noise(t, v.end, Math.random()), lp, s.shaper(v), v.env(1, 0.26, t, 0.002, 0.05));
    const saw = v.osc("sawtooth", 190);
    saw.frequency.exponentialRampToValueAtTime(42, t + 0.55);
    v.chain(saw, v.filter("lowpass", 900), v.env(0.55, 0.22, t, 0.003, 0.04));
    clang(v, t + 0.14, 830, 1290, 1900, 0.4, 0.04);
    clang(v, t + 0.29, 1460, 2110, 2900, 0.3, 0.035);
    clang(v, t + 0.47, 610, 980, 1500, 0.25, 0.05);
  },
  // Bump: a soft thud.
  bump(v) {
    const t = v.t;
    blip(v, "sine", 140, t, 1, 0.05, 0, 55);
    v.chain(v.noise(t, t + 0.12, Math.random()), v.filter("lowpass", 520), v.env(0.7, 0.03, t, 0.001));
  },
  // Take-off: a rising whoosh and a lifting tone.
  takeoff(v) {
    const t = v.t;
    const bp = v.filter("bandpass", 500, 1.4);
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(2300, t + 0.38);
    v.chain(v.noise(t, v.end, Math.random()), bp, v.env(1, 0.1, t, 0.06, 0.18));
    blip(v, "sine", 230, t, 0.35, 0.1, 0.12, 470);
  },
  // Landing: a thump, a scrape and a little spring wobble.
  land(v) {
    const t = v.t;
    blip(v, "sine", 96, t, 1, 0.07, 0, 40);
    v.chain(v.noise(t, t + 0.2, Math.random()), v.filter("lowpass", 760), v.env(0.65, 0.04, t, 0.001));
    const o = blip(v, "triangle", 520, t + 0.02, 0.18, 0.06);
    o.frequency.linearRampToValueAtTime(360, t + 0.08);
    o.frequency.linearRampToValueAtTime(450, t + 0.14);
  },
  // Fall: a long falling whistle over a little wind.
  fall(v) {
    const t = v.t;
    blip(v, "sine", 1000, t, 0.8, 0.3, 0.45, 140);
    const bp = v.filter("bandpass", 900, 0.9);
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(260, t + 0.9);
    v.chain(v.noise(t, v.end, Math.random()), bp, v.env(0.35, 0.25, t, 0.05, 0.3));
  },
  // Recovery: a ratchet of three rising blips, as the car is put back on the road.
  recover(v) {
    const t = v.t;
    [392, 523.3, 784].forEach((hz, i) => {
      blip(v, "square", hz, t + i * 0.065, 0.7, 0.025, 0.02);
      v.chain(v.noise(t + i * 0.065, t + i * 0.065 + 0.04, i * 0.21), v.filter("highpass", 3000), v.env(0.3, 0.006, t + i * 0.065, 0.001));
    });
  },
  // Lap: a two-note chime.
  lap(v) {
    const t = v.t;
    blip(v, "triangle", 1046.5, t, 1, 0.08, 0.04);
    blip(v, "triangle", 1318.5, t + 0.11, 1, 0.1, 0.05);
  },
  // Finish: a short rising fanfare ending on a held note with vibrato.
  finish(v) {
    const t = v.t;
    const notes = [784, 988, 1174.7];
    notes.forEach((hz, i) => blip(v, "square", hz, t + i * 0.09, 0.55, 0.04, 0.04));
    const top = blip(v, "square", 1568, t + 0.27, 0.6, 0.18, 0.35);
    const lfo = v.osc("sine", 6, t + 0.35, v.end);
    const depth = v.c.createGain();
    depth.gain.value = 18;
    v.nodes.push(depth);
    lfo.connect(depth).connect(top.detune);
  },
};

/**
 * The own car's engine: two slightly detuned saws and a square sub-octave through a low-pass
 * that opens with the pitch. set() only moves parameters (setTargetAtTime), once a frame.
 */
export class EngineVoice {
  private readonly oscs: OscillatorNode[];
  private readonly lp: BiquadFilterNode;
  private readonly g: GainNode;
  private stopped = false;

  constructor(
    private readonly c: BaseAudioContext,
    out: AudioNode,
  ) {
    const t = c.currentTime;
    this.g = c.createGain();
    this.g.gain.value = 0;
    this.lp = c.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.Q.value = 2.5;
    this.lp.frequency.value = 400;
    this.lp.connect(this.g).connect(out);
    const mk = (type: OscillatorType, mult: number, level: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = 42 * mult;
      const lv = c.createGain();
      lv.gain.value = level;
      o.connect(lv).connect(this.lp);
      o.start(t);
      o.addEventListener("ended", () => {
        o.disconnect();
        lv.disconnect();
      });
      return o;
    };
    this.oscs = [mk("sawtooth", ENGINE_MULT[0], 0.6), mk("sawtooth", ENGINE_MULT[1], 0.5), mk("square", ENGINE_MULT[2], 0.55)];
  }

  set(freq: number, gain: number, t = this.c.currentTime): void {
    if (this.stopped) return;
    for (let i = 0; i < this.oscs.length; i++) this.oscs[i].frequency.setTargetAtTime(freq * ENGINE_MULT[i], t, 0.06);
    this.lp.frequency.setTargetAtTime(200 + freq * 7, t, 0.06);
    this.g.gain.setTargetAtTime(gain * ENGINE_LEVEL, t, gain > 0 ? 0.05 : 0.03);
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    this.g.gain.cancelScheduledValues(t);
    this.g.gain.setTargetAtTime(0, t, 0.03);
    for (const o of this.oscs) o.stop(t + 0.25);
    this.oscs[0].addEventListener("ended", () => {
      this.lp.disconnect();
      this.g.disconnect();
    });
  }
}

export interface TriggerLogEntry {
  kind: SfxKind;
  own: boolean;
  src: Trigger["src"];
  at: number; // performance.now(), ms
  gain: number;
  race: number; // the race it belongs to (raceStart), 0 outside one
}

const LOG_MAX = 2000;

/**
 * The live race sounds: frame() once per frame from the frame loop, event() per server
 * event, bump() per own predicted impact. Triggers are decided by SoundTriggers and dropped
 * entirely while audio is not running (locked, suspended, tab hidden). Every played trigger
 * goes to `log` (debug: scrapDebug.sounds.log) and every dropped one is counted.
 */
export class RaceSounds {
  readonly triggers: SoundTriggers;
  readonly log: TriggerLogEntry[] = [];
  readonly dropped = { silent: 0, far: 0, capped: 0 };
  private voices: SfxVoices | null = null;
  private engine: EngineVoice | null = null;
  private readonly caps = new SfxCaps();
  private readonly view: SoundView = { you: "", phase: "", raceStart: 0, phaseEnds: 0, serverNow: 0, hasClock: false, snapTick: 0, own: [], snap: null };

  constructor(
    private readonly audio: AudioEngine,
    private readonly game: Game,
    delayMs: number,
  ) {
    this.triggers = new SoundTriggers(delayMs);
  }

  reset(): void {
    this.triggers.reset();
  }

  event(ev: GameEvent, tick: number): void {
    const audible = this.audio.running();
    if (!audible) this.dropped.silent++;
    this.triggers.event(ev, tick, this.game.you, performance.now(), audible);
  }

  bump(speed: number, x: number, y: number, cam: { x: number; y: number }): void {
    const t = this.triggers.bump(speed, x, y, this.audio.running());
    if (t) this.play(t, cam);
    else this.dropped.silent++;
  }

  /** ctl: the controls the frame loop last stepped with; cam: the camera centre (pan, spectating). */
  frame(ctl: Controls, cam: { x: number; y: number }): void {
    const g = this.game;
    const v = this.view;
    v.you = g.you;
    v.phase = g.phase;
    v.raceStart = g.raceStart;
    v.phaseEnds = g.phaseEnds;
    v.serverNow = g.serverNow();
    v.hasClock = g.hasClock();
    v.snapTick = g.snapTick;
    v.own = g.takeOwnSounds();
    v.snap = g.you ? g.interpSnapshot() : null;
    const audible = this.audio.running();
    const out = this.triggers.frame(v, performance.now(), audible);
    if (!audible && v.own.length) this.dropped.silent += v.own.length;
    for (const t of out) this.play(t, cam);
    this.updateEngine(ctl, audible);
  }

  private voicesNow(): SfxVoices | null {
    const { ctx, buses, noise } = this.audio;
    if (!ctx || !buses || !noise) return null;
    if (!this.voices || this.voices.ctx !== ctx) this.voices = new SfxVoices(ctx, buses.sfx, noise);
    return this.voices;
  }

  private play(t: Trigger, cam: { x: number; y: number }): void {
    const sv = this.voicesNow();
    if (!sv) return;
    let gain = t.vel ?? 1;
    let pan = 0;
    if (!t.own) {
      const at = this.where(t);
      if (!at) {
        this.dropped.far++;
        return;
      }
      const ear = this.game.car ?? cam;
      gain *= OTHER_GAIN * distanceGain(Math.hypot(at.x - ear.x, at.y - ear.y));
      pan = panFor(at.x - cam.x);
    }
    if (gain < 0.01) {
      this.dropped.far++;
      return;
    }
    const now = sv.ctx.currentTime;
    if (!this.caps.tryStart(t.kind, now * 1000, SFX_DUR[t.kind] * 1000, t.own)) {
      this.dropped.capped++;
      return;
    }
    sv.play(t.kind, now, gain, pan);
    this.log.push({ kind: t.kind, own: t.own, src: t.src, at: Math.round(performance.now()), gain: Math.round(gain * 100) / 100, race: this.game.raceStart });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  /** Where another car's sound is: its own x/y, else the car as drawn now (events). */
  private where(t: Trigger): { x: number; y: number } | null {
    if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
    if (!t.id) return null;
    return this.game.otherPoses().find((p) => p.id === t.id) ?? this.game.latest?.cars.get(t.id) ?? null;
  }

  private updateEngine(ctl: Controls, audible: boolean): void {
    const g = this.game;
    const car = g.car;
    const inRace = !!car && (g.phase === "countdown" || g.phase === "racing");
    if (!inRace) {
      this.engine?.stop();
      this.engine = null;
      return;
    }
    if (!audible) return; // the context is suspended: nothing moves
    const target = engineTarget({
      phase: g.phase,
      hasCar: true,
      connected: g.connected,
      wreck: car.wreck,
      fall: car.fall,
      air: car.air,
      finished: !!g.ownSnap()?.fin,
      speed: Math.hypot(car.vx, car.vy),
      topSpeed: g.stats.topSpeed,
      throttle: ctl.throttle,
    });
    if (!this.engine) {
      if (!target.on) return;
      const sv = this.voicesNow();
      if (!sv) return;
      this.engine = sv.engine();
    }
    this.engine.set(target.freq, target.gain);
  }
}
