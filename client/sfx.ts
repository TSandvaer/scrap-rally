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
  gravelTarget,
  onGravel,
  type EnginePreset,
  type EngineState,
  type SfxKind,
  type SoundView,
  type Trigger,
} from "./soundlogic";
import type { GameEvent } from "../shared/protocol";
import { halfOf, queryTrackNear, roadOf } from "../shared/track";

/** Peak level of each effect at gain 1, before the effects volume. */
const LEVEL: Record<SfxKind, number> = {
  beep: 0.25,
  go: 0.16,
  rivet: 0.27,
  drop: 0.25,
  blast: 0.8,
  hit: 0.18,
  wreck: 0.43,
  bump: 0.22,
  crash: 0.5,
  wall: 0.45,
  takeoff: 0.39,
  land: 0.22,
  fall: 0.3,
  recover: 0.245,
  lap: 0.25,
  finish: 0.4,
};

/** How long each effect sounds (s): its sources stop then; also what the per-kind caps count. */
export const SFX_DUR: Record<SfxKind, number> = {
  beep: 0.26,
  go: 0.85,
  rivet: 0.16,
  drop: 0.42,
  blast: 1.9,
  hit: 0.3,
  wreck: 1.3,
  bump: 0.25,
  crash: 0.9,
  wall: 0.9,
  takeoff: 0.75,
  land: 0.35,
  fall: 1.3,
  recover: 0.32,
  lap: 0.75,
  finish: 1.4,
};


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
    readonly force = 1, // 0..1: how hard (crashes)
  ) {}

  osc(type: OscillatorType, hz: number, at = this.t, stop = this.end): OscillatorNode {
    const o = this.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, at);
    o.start(at);
    o.stop(Math.min(stop, this.end)); // every source ends with the voice
    this.sources.push(o);
    return o;
  }

  noise(at = this.t, stop = this.end, offset = 0): AudioBufferSourceNode {
    const n = this.c.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    n.start(at, offset % this.noiseBuf.duration);
    n.stop(Math.min(stop, this.end));
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

  play(kind: SfxKind, t: number, gain = 1, pan = 0, force = 1): void {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = gain * LEVEL[kind];
    const p = c.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.out);
    const v = new Voice(c, g, t, t + SFX_DUR[kind], this.noiseBuf, force);
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

  engine(preset: EnginePreset): EngineVoice {
    return new EngineVoice(this.ctx, this.out, this.noiseBuf, preset, this.curve);
  }

  private grainBuf: AudioBuffer | null = null;

  gravel(): GravelVoice {
    this.grainBuf ??= grainBuffer(this.ctx);
    return new GravelVoice(this.ctx, this.out, this.noiseBuf, this.grainBuf);
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

/** Bent metal: crunch noise, bending inharmonic partials, a groan when hard (crash / wall). */
function metalCrash(v: Voice, s: SfxVoices, force: number, level: number): void {
  const t = v.t;
  const vary = () => 1 + (Math.random() * 2 - 1) * 0.07;
  const sat = s.shaper(v);
  const crunch = v.filter("bandpass", 1300 * vary(), 0.9);
  v.chain(v.noise(t, v.end, Math.random()), crunch, v.env(level, 0.035 + 0.15 * force, t, 0.001, 0.01 + 0.04 * force), sat);
  const band = v.filter("bandpass", 1900 * vary(), 2.2);
  const env = v.env(0.55 * level, 0.05 + 0.2 * force, t, 0.001, 0.01);
  [347, 589, 911, 1433].forEach((hz, i) => {
    const at = t + i * (0.006 + 0.008 * force);
    const f0 = hz * vary();
    const o = v.osc(i % 2 ? "triangle" : "square", f0, at, v.end);
    o.frequency.exponentialRampToValueAtTime(f0 * (0.9 - 0.08 * force), at + 0.08 + 0.1 * force); // bending
    o.connect(band);
  });
  v.chain(band, env, sat);
  blip(v, "sine", 130, t, 0.7 * level, 0.04 + 0.04 * force, 0, 50);
  if (force > 0.45) {
    const groan = v.osc("sawtooth", 430 * vary(), t + 0.02, v.end);
    groan.frequency.exponentialRampToValueAtTime(205, t + 0.4);
    v.chain(groan, v.filter("bandpass", 720, 6), v.env(0.4 * level * force, 0.14, t + 0.02, 0.01, 0.05));
  }
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
  // Rivet gun, a machine-gun round: a sharp broadband crack of noise on a low punchy thump
  // through a little saturation. Pitch and filters vary by a few percent per shot, so held
  // fire rattles instead of repeating one sample.
  rivet(v, s) {
    const t = v.t;
    const vary = () => 1 + (Math.random() * 2 - 1) * 0.08;
    const sat = s.shaper(v);
    const crack = v.filter("highpass", 1400 * vary(), 0.8);
    const bite = v.filter("peaking", 3600 * vary(), 1.2);
    bite.gain.value = 6;
    v.chain(v.noise(t, t + 0.09, Math.random()), crack, bite, v.env(1, 0.014, t, 0.0005, 0.004), sat);
    v.chain(v.noise(t, t + 0.08, Math.random()), v.filter("bandpass", 900 * vary(), 1.1), v.env(0.55, 0.02, t, 0.001));
    const hz = 140 * vary();
    const thump = v.osc("sine", hz, t, t + 0.12);
    thump.frequency.exponentialRampToValueAtTime(hz * 0.48, t + 0.05);
    v.chain(thump, v.env(0.9, 0.018, t, 0.001, 0.006), sat);
  },
  // Mine dropped: a heavy clunk on the road, then two arming ticks.
  drop(v) {
    const t = v.t;
    blip(v, "triangle", 260, t, 1, 0.05, 0, 110);
    v.chain(v.noise(t, t + 0.2, Math.random()), v.filter("bandpass", 900, 2), v.env(0.6, 0.03, t, 0.001));
    blip(v, "square", 2100, t + 0.2, 0.16, 0.01);
    blip(v, "square", 2100, t + 0.32, 0.16, 0.01);
  },
  // Mine blast, an explosion: a short bright crack, a deep boom sweeping ~120 -> 35 Hz, and a
  // noise burst through a low-pass that closes over about a second (the rumble tail), all
  // lightly saturated.
  blast(v, s) {
    const t = v.t;
    const sat = s.shaper(v);
    v.chain(v.noise(t, t + 0.12, Math.random()), v.filter("highpass", 2400), v.env(0.7, 0.016, t, 0.0005, 0.003), sat);
    const boom = v.osc("sine", 120, t, v.end);
    boom.frequency.exponentialRampToValueAtTime(35, t + 0.55);
    v.chain(boom, v.env(1, 0.32, t, 0.003, 0.05), sat);
    const body = v.osc("triangle", 240, t, t + 0.8);
    body.frequency.exponentialRampToValueAtTime(70, t + 0.4);
    v.chain(body, v.env(0.3, 0.12, t, 0.003), sat);
    const lp = v.filter("lowpass", 5000, 0.9);
    lp.frequency.setValueAtTime(5000, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 1.1);
    v.chain(v.noise(t, v.end, Math.random()), lp, v.env(1, 0.38, t, 0.002, 0.06), sat);
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
  // Crash into another car: bending metal. A crunch of saturated band-passed noise, four
  // inharmonic metal partials starting a few ms apart that bend down in pitch, and from
  // force ~0.5 a groaning resonant saw; force (0..1) sets length and weight.
  crash(v, s) {
    metalCrash(v, s, v.force, 1);
  },
  // The own car into a wall: the same bent metal on a heavier, lower concrete thump.
  wall(v, s) {
    const t = v.t;
    const f = v.force;
    const boom = v.osc("sine", 95, t, t + 0.5);
    boom.frequency.exponentialRampToValueAtTime(38, t + 0.12 + 0.1 * f);
    v.chain(boom, v.env(0.9, 0.06 + 0.06 * f, t, 0.002));
    v.chain(v.noise(t, t + 0.25, Math.random()), v.filter("lowpass", 700), v.env(0.6, 0.04 + 0.04 * f, t, 0.001));
    metalCrash(v, s, f, 0.8);
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
    blip(v, "sine", 1000, t, 0.8, 0.2, 0.4, 140);
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
 * A petrol engine preset. The firing rate (pulses per second) runs from idleHz at idle to
 * topHz at top speed; one oscillator plays a whole engine cycle (`pulses` firings at their
 * positions and strengths, so worn or uneven engines lope), each firing a decaying pulse
 * `width` of a firing interval long (shorter = brighter, buzzier).
 */
interface EngineDef {
  label: string;
  idleHz: number;
  topHz: number;
  pulses: readonly (readonly [at: number, amp: number])[];
  width: number;
  sub: number; // a sine at half the firing rate: body, rumble
  noise: number; // band-passed noise chuffing (or rattling) with every firing
  noiseBand: number; // its centre, in firing-rate multiples
  noiseQ: number;
  wobble: number; // idle unsteadiness, cents (fades out with the revs)
  drive: readonly [coast: number, full: number]; // into the soft clipper: grit on throttle
  cutoff: readonly [coast: number, full: number]; // low-pass, in firing-rate multiples
  q: number;
  level: number;
}

export const ENGINES: Readonly<Record<EnginePreset, EngineDef>> = {
  // A small four-cylinder buzz: even, narrow firings, high revs.
  four: {
    label: "4-cyl",
    idleHz: 32,
    topHz: 205,
    pulses: [[0, 1], [0.25, 0.93], [0.5, 0.97], [0.75, 0.9]],
    width: 0.16,
    sub: 0.12,
    noise: 0.07,
    noiseBand: 9,
    noiseQ: 1.2,
    wobble: 10,
    drive: [1.2, 2.6],
    cutoff: [7, 20],
    q: 1.2,
    level: 0.06,
  },
  // A deep V8 rumble: eight wide firings a cycle, one bank louder than the other (the
  // cross-plane lope), a strong sub, low revs.
  v8: {
    label: "V8",
    idleHz: 27,
    topHz: 150,
    pulses: [[0, 1], [0.125, 0.68], [0.25, 1], [0.375, 0.95], [0.5, 0.7], [0.625, 1], [0.75, 0.66], [0.875, 0.72]],
    width: 0.34,
    sub: 0.5,
    noise: 0.05,
    noiseBand: 6,
    noiseQ: 1,
    wobble: 16,
    drive: [1.6, 3.6],
    cutoff: [5, 13],
    q: 1.6,
    level: 0.046,
  },
  // An old rattly buggy: four worn cylinders firing a little off time and unevenly, loose
  // metal rattling with every firing, a lumpy idle.
  buggy: {
    label: "Buggy",
    idleHz: 25,
    topHz: 170,
    pulses: [[0, 1], [0.27, 0.6], [0.5, 0.88], [0.78, 0.5]],
    width: 0.24,
    sub: 0.25,
    noise: 0.2,
    noiseBand: 11,
    noiseQ: 1.8,
    wobble: 34,
    drive: [2, 4.2],
    cutoff: [6, 16],
    q: 1.4,
    level: 0.047,
  },
};

const ENGINE_HARMONICS = 96; // of the cycle oscillator: ~12-24 firing harmonics
const waveCache = new Map<EnginePreset, { real: Float32Array<ArrayBuffer>; imag: Float32Array<ArrayBuffer> }>();

/**
 * One engine cycle as a Fourier series: each firing a one-sided exponential pulse
 * (time constant `width` of a firing interval) at its position, summed.
 */
function cycleWave(preset: EnginePreset): { real: Float32Array<ArrayBuffer>; imag: Float32Array<ArrayBuffer> } {
  const hit = waveCache.get(preset);
  if (hit) return hit;
  const def = ENGINES[preset];
  const n = ENGINE_HARMONICS + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  const w = def.width / def.pulses.length; // in cycles
  for (let k = 1; k < n; k++) {
    // One pulse e^{-t/w}: c = w / (1 + i 2 pi k w); shifted to `at`: times e^{-i 2 pi k at}.
    const x = 2 * Math.PI * k * w;
    const pr = w / (1 + x * x);
    const pi = (-w * x) / (1 + x * x);
    let re = 0;
    let im = 0;
    for (const [at, amp] of def.pulses) {
      const ph = -2 * Math.PI * k * at;
      re += amp * (pr * Math.cos(ph) - pi * Math.sin(ph));
      im += amp * (pr * Math.sin(ph) + pi * Math.cos(ph));
    }
    real[k] = 2 * re; // x(t) = sum real[k] cos + imag[k] sin = sum 2 Re(c e^{i 2 pi k t})
    imag[k] = -2 * im;
  }
  const out = { real, imag };
  waveCache.set(preset, out);
  return out;
}

/**
 * The own car's engine, a petrol engine (ENGINES): the firing pulses of the cycle oscillator
 * and a sub sine, chuffing noise gated by the firing rate, through a soft clipper (more drive
 * on throttle) and a low-pass that opens with the revs and the throttle; two slow LFOs make
 * the idle unsteady. One persistent voice; set() only moves parameters (setTargetAtTime).
 */
export class EngineVoice {
  private readonly def: EngineDef;
  private readonly cycle: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly am: OscillatorNode; // the firing rate, gating the noise
  private readonly noiseSrc: AudioBufferSourceNode;
  private readonly band: BiquadFilterNode;
  private readonly drive: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly g: GainNode;
  private readonly wobbleDepth: GainNode;
  private readonly sources: AudioScheduledSourceNode[];
  private readonly nodes: AudioNode[];
  private stopped = false;

  constructor(
    private readonly c: BaseAudioContext,
    out: AudioNode,
    noise: AudioBuffer,
    readonly preset: EnginePreset,
    shaperCurve: Float32Array<ArrayBuffer>,
  ) {
    const def = (this.def = ENGINES[preset]);
    const t = c.currentTime;
    const idle = def.idleHz;
    const gain = (v: number) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const osc = (type: OscillatorType, hz: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      return o;
    };
    const { real, imag } = cycleWave(preset);
    this.cycle = c.createOscillator();
    this.cycle.setPeriodicWave(c.createPeriodicWave(real, imag));
    this.cycle.frequency.value = idle / def.pulses.length;
    this.sub = osc("sine", idle / 2);
    this.am = osc("sine", idle);
    this.noiseSrc = c.createBufferSource();
    this.noiseSrc.buffer = noise;
    this.noiseSrc.loop = true;
    this.band = c.createBiquadFilter();
    this.band.type = "bandpass";
    this.band.frequency.value = idle * def.noiseBand;
    this.band.Q.value = def.noiseQ;
    // The noise gain swings 0..2x its level with the firing rate: a chuff per firing.
    const noiseGate = gain(def.noise);
    const amDepth = gain(def.noise);
    this.drive = gain(def.drive[0]);
    const shaper = c.createWaveShaper();
    shaper.curve = shaperCurve;
    this.lp = c.createBiquadFilter();
    this.lp.type = "lowpass";
    this.lp.frequency.value = idle * def.cutoff[0];
    this.lp.Q.value = def.q;
    this.g = gain(0);
    const cycleLevel = gain(0.55);
    const subLevel = gain(def.sub);
    // Idle unsteadiness: two slow LFOs (detune, cents) on every rate-bound oscillator.
    this.wobbleDepth = gain(def.wobble);
    const lfo1 = osc("sine", 2.1);
    const lfo2 = osc("sine", 0.53);
    const lfo2Level = gain(0.7);

    this.cycle.connect(cycleLevel).connect(this.drive);
    this.sub.connect(subLevel).connect(this.drive);
    this.noiseSrc.connect(this.band).connect(noiseGate).connect(this.drive);
    this.am.connect(amDepth).connect(noiseGate.gain);
    this.drive.connect(shaper).connect(this.lp).connect(this.g).connect(out);
    lfo1.connect(this.wobbleDepth);
    lfo2.connect(lfo2Level).connect(this.wobbleDepth);
    for (const o of [this.cycle, this.sub, this.am]) this.wobbleDepth.connect(o.detune);

    this.sources = [this.cycle, this.sub, this.am, this.noiseSrc, lfo1, lfo2];
    this.nodes = [this.band, noiseGate, amDepth, this.drive, shaper, this.lp, this.g, cycleLevel, subLevel, this.wobbleDepth, lfo2Level];
    for (const s of this.sources) s.start(t);
  }

  /** rpm 0..1 (idle .. top), load 0..1 (throttle), gain 0..1 (0 = silent). */
  set(rpm: number, load: number, gain: number, t = this.c.currentTime): void {
    if (this.stopped) return;
    const d = this.def;
    const hz = d.idleHz + (d.topHz - d.idleHz) * rpm;
    const tau = 0.07;
    this.cycle.frequency.setTargetAtTime(hz / d.pulses.length, t, tau);
    this.sub.frequency.setTargetAtTime(hz / 2, t, tau);
    this.am.frequency.setTargetAtTime(hz, t, tau);
    this.band.frequency.setTargetAtTime(hz * d.noiseBand, t, tau);
    this.lp.frequency.setTargetAtTime(150 + hz * (d.cutoff[0] + (d.cutoff[1] - d.cutoff[0]) * load), t, 0.05);
    this.drive.gain.setTargetAtTime(d.drive[0] + (d.drive[1] - d.drive[0]) * load, t, 0.05);
    this.wobbleDepth.gain.setTargetAtTime(d.wobble * (1 - rpm) * (1 - rpm), t, 0.2);
    this.g.gain.setTargetAtTime(gain * d.level, t, gain > 0 ? 0.05 : 0.03);
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    this.g.gain.cancelScheduledValues(t);
    this.g.gain.setTargetAtTime(0, t, 0.03);
    for (const s of this.sources) s.stop(t + 0.25);
    this.cycle.addEventListener("ended", () => {
      for (const s of this.sources) s.disconnect();
      for (const n of this.nodes) n.disconnect();
    });
  }
}

/**
 * Gravel grains: 2 s of short decaying noise ticks at random times (~70 a second, random
 * strength and length), seeded so renders repeat. Built once per context.
 */
function grainBuffer(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * 2, sr);
  const d = buf.getChannelData(0);
  let x = 0x2545f491;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
  for (let t = 0; t < d.length; ) {
    t += Math.floor((-Math.log(1 - rnd() * 0.999) / 70) * sr); // Poisson, ~70 a second
    const len = Math.floor((0.002 + rnd() * 0.006) * sr);
    const amp = 0.3 + rnd() * 0.7;
    for (let i = 0; i < len && t + i < d.length; i++) d[t + i] += amp * (rnd() * 2 - 1) * Math.exp((-4 * i) / len);
  }
  return buf;
}

/**
 * The own car's tyres on gravel: crackling grains (played faster with speed: denser) through a
 * band-pass, over a gritty band of noise, under a low-pass that opens with speed. One persistent
 * voice like the engine; set() only moves parameters.
 */
export class GravelVoice {
  private readonly grains: AudioBufferSourceNode;
  private readonly lp: BiquadFilterNode;
  private readonly g: GainNode;
  private readonly sources: AudioScheduledSourceNode[];
  private readonly nodes: AudioNode[];
  private stopped = false;

  constructor(
    private readonly c: BaseAudioContext,
    out: AudioNode,
    noise: AudioBuffer,
    grainBuf: AudioBuffer,
  ) {
    const t = c.currentTime;
    const filter = (type: BiquadFilterType, hz: number, q: number) => {
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const gain = (v: number) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    this.grains = c.createBufferSource();
    this.grains.buffer = grainBuf;
    this.grains.loop = true;
    const bed = c.createBufferSource();
    bed.buffer = noise;
    bed.loop = true;
    const grainBand = filter("bandpass", 2300, 0.7);
    const grainLevel = gain(1);
    const bedBand = filter("bandpass", 650, 0.6);
    const bedLevel = gain(0.18);
    this.lp = filter("lowpass", 2500, 0.7);
    this.g = gain(0);
    this.grains.connect(grainBand).connect(grainLevel).connect(this.lp);
    bed.connect(bedBand).connect(bedLevel).connect(this.lp);
    this.lp.connect(this.g).connect(out);
    this.sources = [this.grains, bed];
    this.nodes = [grainBand, grainLevel, bedBand, bedLevel, this.lp, this.g];
    for (const s of this.sources) s.start(t);
  }

  /** gain 0..1 (0 = silent), density = grain rate (playback rate), open 0..1 (speed: brighter). */
  set(gain: number, density: number, open: number, t = this.c.currentTime): void {
    if (this.stopped) return;
    this.grains.playbackRate.setTargetAtTime(density, t, 0.08);
    this.lp.frequency.setTargetAtTime(1800 + 4500 * open, t, 0.08);
    this.g.gain.setTargetAtTime(gain * GRAVEL_LEVEL, t, 0.04); // fades in and out at the asphalt edge
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    this.g.gain.cancelScheduledValues(t);
    this.g.gain.setTargetAtTime(0, t, 0.03);
    for (const s of this.sources) s.stop(t + 0.25);
    this.grains.addEventListener("ended", () => {
      for (const s of this.sources) s.disconnect();
      for (const n of this.nodes) n.disconnect();
    });
  }
}

const GRAVEL_LEVEL = 0.6;

export interface TriggerLogEntry {
  kind: SfxKind;
  own: boolean;
  src: Trigger["src"];
  out: "played" | "far" | "capped"; // far: beyond FAR_UNITS (or nowhere); capped: per-kind cap
  ent?: number; // the shot or mine id (snapshot triggers)
  at: number; // performance.now(), ms
  gain: number;
  race: number; // the race it belongs to (raceStart), 0 outside one
}

const LOG_MAX = 2000;

/**
 * The live race sounds: frame() once per frame from the frame loop, event() per server
 * event, bump() per own predicted impact. Triggers are decided by SoundTriggers and dropped
 * entirely while audio is not running (locked, suspended, tab hidden; counted in
 * dropped.silent). Every trigger goes to `log` with what became of it (debug:
 * scrapDebug.sounds.log).
 */
export class RaceSounds {
  readonly triggers: SoundTriggers;
  readonly log: TriggerLogEntry[] = [];
  readonly dropped = { silent: 0 };
  private voices: SfxVoices | null = null;
  private engine: EngineVoice | null = null;
  private gravel: GravelVoice | null = null;
  private readonly carState: EngineState = { phase: "", hasCar: true, connected: true, wreck: 0, fall: 0, air: 0, finished: false, speed: 0, topSpeed: 1, throttle: 0 };
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
    v.paused = g.paused;
    v.resumeGo = g.resumeGo;
    v.raceKey = g.raceId;
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
      const ear = this.game.car ?? cam;
      gain = at ? gain * OTHER_GAIN * distanceGain(Math.hypot(at.x - ear.x, at.y - ear.y)) : 0;
      if (at) pan = panFor(at.x - cam.x);
    }
    const now = sv.ctx.currentTime;
    const out = gain < 0.01 ? "far" : this.caps.tryStart(t.kind, now * 1000, SFX_DUR[t.kind] * 1000, t.own) ? "played" : "capped";
    if (out === "played") sv.play(t.kind, now, gain, pan, t.force ?? 1);
    this.log.push({ kind: t.kind, own: t.own, src: t.src, out, ent: t.ent, at: Math.round(performance.now()), gain: Math.round(gain * 100) / 100, race: this.game.raceStart });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  /** Tyres on gravel: the own predicted pose off the asphalt (same query as the physics). */
  private updateGravel(st: EngineState): void {
    const g = this.game;
    const car = g.car!;
    const q = queryTrackNear(g.track, car.x, car.y, car.seg);
    const off = onGravel(q.dist, halfOf(roadOf(g.track, q.road), q)); // the per-sample asphalt (M4-SURF part 2: a split's widened road; BR-PHYS: on the car's road)
    const target = gravelTarget(st, off);
    if (!this.gravel) {
      if (!target.on) return;
      const sv = this.voicesNow();
      if (!sv) return;
      this.gravel = sv.gravel();
    }
    this.gravel.set(target.gain, target.density, Math.min(1, st.speed / Math.max(1, st.topSpeed)));
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
      this.gravel?.stop();
      this.gravel = null;
      return;
    }
    if (!audible) return; // the context is suspended: nothing moves
    const st = this.carState;
    st.phase = g.phase;
    st.connected = g.connected;
    st.wreck = car.wreck;
    st.fall = car.fall;
    st.air = car.air;
    st.finished = !!g.ownSnap()?.fin;
    st.speed = Math.hypot(car.vx, car.vy);
    st.topSpeed = g.stats.topSpeed;
    st.throttle = ctl.throttle;
    st.paused = g.paused; // the race stands still: no engine, no gravel
    this.updateGravel(st);
    const target = engineTarget(st);
    const preset = this.audio.settings.engine;
    if (this.engine && this.engine.preset !== preset) {
      this.engine.stop(); // another engine was picked on the sound board
      this.engine = null;
    }
    if (!this.engine) {
      if (!target.on) return;
      const sv = this.voicesNow();
      if (!sv) return;
      this.engine = sv.engine(preset);
    }
    this.engine.set(target.rpm, target.load, target.gain);
  }
}
