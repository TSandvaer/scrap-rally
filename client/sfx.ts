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
  FordSplash,
  fordTarget,
  oilTarget,
  sandTarget,
  tyreSurface,
  type EnginePreset,
  type EngineState,
  type SfxKind,
  type SoundView,
  type SurfaceTarget,
  type Trigger,
  type TyreSurface,
} from "./soundlogic";
import type { GameEvent } from "../shared/protocol";
import { halfOf, queryTrackNear, roadFor, surfaceAt } from "../shared/track";

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

  private readonly grainBufs = new Map<GrainDef, AudioBuffer>();
  private readonly bubbleBufs = new Map<BubbleDef, AudioBuffer>();

  gravel(): GravelVoice {
    return this.crackle(GRAVEL);
  }

  /** A crackle voice of this tone (GRAVEL, SAND.*): its grains built once per context. */
  crackle(def: CrackleDef): GravelVoice {
    let buf = this.grainBufs.get(def.grains);
    if (!buf) this.grainBufs.set(def.grains, (buf = grainBuffer(this.ctx, def.grains)));
    return new GravelVoice(this.ctx, this.out, this.noiseBuf, buf, def);
  }

  /** A ford voice with this wash (WASH.*): its bubbles built once per context. */
  ford(def: WashDef): FordVoice {
    let buf = this.bubbleBufs.get(def.bubbles);
    if (!buf) this.bubbleBufs.set(def.bubbles, (buf = bubbleBuffer(this.ctx, def.bubbles)));
    return new FordVoice(this.ctx, this.out, this.noiseBuf, buf, def);
  }

  oil(): OilVoice {
    return new OilVoice(this.ctx, this.out, this.noiseBuf);
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

/** A crackle's grains (grainBuffer): `rate` a second at random times, each lenMin..+lenSpan s long, ampMin..+ampSpan strong, seeded. */
export interface GrainDef {
  rate: number;
  lenMin: number;
  lenSpan: number;
  ampMin: number;
  ampSpan: number;
  decay: number; // how fast a grain dies over its length (e^-decay at its end)
  seed: number;
}

/**
 * Grains: 2 s of short decaying noise ticks at random times (Poisson, `rate` a second, random
 * strength and length), seeded so renders repeat. Built once per context and def. GRAVEL's grains
 * are SND-2's buffer, sample for sample.
 */
function grainBuffer(ctx: BaseAudioContext, g: GrainDef): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * 2, sr);
  const d = buf.getChannelData(0);
  let x = g.seed;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
  for (let t = 0; t < d.length; ) {
    t += Math.floor((-Math.log(1 - rnd() * 0.999) / g.rate) * sr); // Poisson
    const len = Math.floor((g.lenMin + rnd() * g.lenSpan) * sr);
    const amp = g.ampMin + rnd() * g.ampSpan;
    for (let i = 0; i < len && t + i < d.length; i++) d[t + i] += amp * (rnd() * 2 - 1) * Math.exp((-g.decay * i) / len);
  }
  return buf;
}

/**
 * A crackle voice's tone (GravelVoice): its grains through a band-pass, over a band of noise (the
 * bed), under a low-pass that opens with speed (lp: base + open x speed), at `level`.
 */
export interface CrackleDef {
  label: string;
  grains: GrainDef;
  grainBand: number;
  grainQ: number;
  bedBand: number;
  bedQ: number;
  bedLevel: number;
  lp: readonly [base: number, open: number];
  level: number;
}

/** The gravel off the asphalt (SND-2, approved 2026-11-18): exactly its numbers. */
export const GRAVEL: CrackleDef = {
  label: "Gravel",
  grains: { rate: 70, lenMin: 0.002, lenSpan: 0.006, ampMin: 0.3, ampSpan: 0.7, decay: 4, seed: 0x2545f491 },
  grainBand: 2300,
  grainQ: 0.7,
  bedBand: 650,
  bedQ: 0.6,
  bedLevel: 0.18,
  lp: [1800, 4500],
  level: 0.6,
};

/**
 * Sand (THEME-SND): the gravel voice with other parameters, a softer, lower crackle than gravel.
 * The race plays RACE_SAND, "fine" (the user's pick by ear, 2026-11-23); the other two stay on
 * the sound board for auditions only:
 * - fine: fine loose sand, many tiny soft grains blurring into a hiss over a low rush;
 * - crunch: packed sand, a lower, rounder crackle, sparser than gravel's, little hiss;
 * - dune: deep sand, mostly a low hushing whoosh with a muffled crunch in it.
 */
export type SandVariant = "fine" | "crunch" | "dune";
export const SAND_VARIANTS: readonly SandVariant[] = ["fine", "crunch", "dune"];
export const SAND: Readonly<Record<SandVariant, CrackleDef>> = {
  fine: {
    label: "Sand: fine",
    grains: { rate: 260, lenMin: 0.0015, lenSpan: 0.004, ampMin: 0.15, ampSpan: 0.45, decay: 3, seed: 0x51a7d3c1 },
    grainBand: 1500,
    grainQ: 0.6,
    bedBand: 420,
    bedQ: 0.5,
    bedLevel: 0.3,
    lp: [1100, 2600],
    level: 0.34,
  },
  crunch: {
    label: "Sand: crunch",
    grains: { rate: 95, lenMin: 0.003, lenSpan: 0.008, ampMin: 0.25, ampSpan: 0.6, decay: 5, seed: 0x7c3e9a15 },
    grainBand: 1050,
    grainQ: 0.8,
    bedBand: 300,
    bedQ: 0.6,
    bedLevel: 0.2,
    lp: [900, 2200],
    level: 0.5,
  },
  dune: {
    label: "Sand: dune",
    grains: { rate: 150, lenMin: 0.004, lenSpan: 0.01, ampMin: 0.2, ampSpan: 0.5, decay: 3.5, seed: 0x3d9b21e7 },
    grainBand: 800,
    grainQ: 0.5,
    bedBand: 260,
    bedQ: 0.7,
    bedLevel: 0.42,
    lp: [650, 1500],
    level: 0.36,
  },
};

/** A wash's bubbles (bubbleBuffer): `rate` a second, each a sine blip whose pitch rises a little as it rings, seeded. */
export interface BubbleDef {
  rate: number;
  hzMin: number;
  hzSpan: number;
  lenMin: number;
  lenSpan: number;
  rise: number; // the pitch rises by this fraction over a bubble's length
  seed: number;
}

/**
 * Bubbles: 2 s of short rising sine blips at random times (Poisson), random pitch, length and
 * strength, seeded so renders repeat; water's plinks. Built once per context and def.
 */
function bubbleBuffer(ctx: BaseAudioContext, b: BubbleDef): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr * 2, sr);
  const d = buf.getChannelData(0);
  let x = b.seed;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
  for (let t = 0; t < d.length; ) {
    t += Math.floor((-Math.log(1 - rnd() * 0.999) / b.rate) * sr);
    const len = Math.floor((b.lenMin + rnd() * b.lenSpan) * sr);
    const hz = b.hzMin + rnd() * b.hzSpan;
    const amp = 0.25 + rnd() * 0.75;
    let ph = 0;
    for (let i = 0; i < len && t + i < d.length; i++) {
      const k = i / len;
      ph += (2 * Math.PI * hz * (1 + b.rise * k)) / sr;
      d[t + i] += amp * Math.sin(ph) * Math.min(1, i / (0.0006 * sr)) * Math.exp(-4 * k);
    }
  }
  return buf;
}

/**
 * A ford's wash (FordVoice): noise through a band-pass that rises with speed, sloshing (a slow
 * amplitude swing, faster with speed), bubbles played faster with speed, a low body of water, under
 * a low-pass that opens with speed.
 */
export interface WashDef {
  label: string;
  band: readonly [slow: number, fast: number];
  q: number;
  wash: number;
  slosh: number; // depth of the swing 0..1
  sloshHz: readonly [slow: number, fast: number];
  bubbles: BubbleDef;
  bubbleLevel: number;
  rumble: number; // the low-passed body of water
  lp: readonly [base: number, open: number];
  level: number;
}

/**
 * The ford's wash (THEME-SND). The race plays RACE_WASH, "brook" (the user's pick by ear,
 * 2026-11-23); the other two stay on the sound board for auditions only:
 * - brook: a bright, bubbly wash, water churned round the wheels;
 * - surge: a heavier, lower rush with a deep slosh, few bubbles: wading through;
 * - spray: a hissing sheet of spray off the tyres over a light slosh.
 */
export type WashVariant = "brook" | "surge" | "spray";
export const WASH_VARIANTS: readonly WashVariant[] = ["brook", "surge", "spray"];
export const WASH: Readonly<Record<WashVariant, WashDef>> = {
  brook: {
    label: "Ford: brook",
    band: [650, 1300],
    q: 0.9,
    wash: 0.55,
    slosh: 0.5,
    sloshHz: [2.2, 5.5],
    bubbles: { rate: 55, hzMin: 450, hzSpan: 1100, lenMin: 0.008, lenSpan: 0.02, rise: 0.35, seed: 0x1b873593 },
    bubbleLevel: 0.5,
    rumble: 0.35,
    lp: [1600, 3200],
    level: 0.28,
  },
  surge: {
    label: "Ford: surge",
    band: [380, 760],
    q: 0.7,
    wash: 0.8,
    slosh: 0.75,
    sloshHz: [1.3, 3.2],
    bubbles: { rate: 22, hzMin: 300, hzSpan: 600, lenMin: 0.012, lenSpan: 0.025, rise: 0.25, seed: 0x6a09e667 },
    bubbleLevel: 0.3,
    rumble: 0.6,
    lp: [1000, 2200],
    level: 0.33,
  },
  spray: {
    label: "Ford: spray",
    band: [1500, 3000],
    q: 0.6,
    wash: 0.5,
    slosh: 0.3,
    sloshHz: [3, 7],
    bubbles: { rate: 40, hzMin: 700, hzSpan: 1500, lenMin: 0.005, lenSpan: 0.012, rise: 0.4, seed: 0x3c6ef372 },
    bubbleLevel: 0.3,
    rumble: 0.2,
    lp: [2600, 4500],
    level: 0.24,
  },
};

/** What the race plays on sand and in a ford (the user's picks by ear, 2026-11-23). */
export const RACE_SAND: SandVariant = "fine";
export const RACE_WASH: WashVariant = "brook";

/** Stop a persistent voice: fade its gain out, stop its sources, disconnect everything when the first has ended. */
function stopVoice(c: BaseAudioContext, g: GainNode, sources: readonly AudioScheduledSourceNode[], nodes: readonly AudioNode[], t = c.currentTime): void {
  g.gain.cancelScheduledValues(t);
  g.gain.setTargetAtTime(0, t, 0.03);
  for (const s of sources) s.stop(t + 0.25);
  sources[0].addEventListener("ended", () => {
    for (const s of sources) s.disconnect();
    for (const n of nodes) n.disconnect();
  });
}

/**
 * The own car's tyres on gravel (GRAVEL) or sand (SAND, THEME-SND): crackling grains (played
 * faster with speed: denser) through a band-pass, over a band of noise, under a low-pass that opens
 * with speed. One persistent voice like the engine; set() only moves parameters.
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
    readonly def: CrackleDef = GRAVEL,
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
    const grainBand = filter("bandpass", def.grainBand, def.grainQ);
    const grainLevel = gain(1);
    const bedBand = filter("bandpass", def.bedBand, def.bedQ);
    const bedLevel = gain(def.bedLevel);
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
    const d = this.def;
    this.grains.playbackRate.setTargetAtTime(density, t, 0.08);
    this.lp.frequency.setTargetAtTime(d.lp[0] + d.lp[1] * open, t, 0.08);
    this.g.gain.setTargetAtTime(gain * d.level, t, 0.04); // fades in and out at the asphalt edge
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    stopVoice(this.c, this.g, this.sources, this.nodes, t);
  }
}

// The ford's splash (FordVoice.splash), the same for every wash: a burst of water noise through a
// band-pass falling from bright to low, a low whump of the car hitting the water, and droplets
// (the wash's bubbles, faster) raining back after it. strength 0.35..1 (soundlogic FordSplash).
const SPLASH_LEVEL = 0.22;
const SPLASH_BAND: readonly [from: number, to: number] = [3200, 600];
const SPLASH_BAND_S = 0.32;
const WHUMP_HZ: readonly [from: number, to: number] = [125, 48];

/**
 * The own car in a ford (THEME-SND): the wash while it rolls through (set(), WashDef), and a
 * splash on entry (splash()). One persistent voice like the engine: set() and splash() only move
 * parameters of the nodes built here (the splash is envelopes on its own gains), nothing is made
 * per frame or per splash.
 */
export class FordVoice {
  private readonly washBand: BiquadFilterNode;
  private readonly sloshLfo: OscillatorNode;
  private readonly sloshDepth: GainNode;
  private readonly bubbles: AudioBufferSourceNode;
  private readonly lp: BiquadFilterNode;
  private readonly g: GainNode;
  private readonly splashBand: BiquadFilterNode;
  private readonly splashEnv: GainNode;
  private readonly whump: OscillatorNode;
  private readonly whumpEnv: GainNode;
  private readonly dropEnv: GainNode;
  private readonly sources: AudioScheduledSourceNode[];
  private readonly nodes: AudioNode[];
  private stopped = false;

  constructor(
    private readonly c: BaseAudioContext,
    out: AudioNode,
    noise: AudioBuffer,
    bubbleBuf: AudioBuffer,
    readonly def: WashDef,
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
    const loop = (buf: AudioBuffer) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      return s;
    };
    const water = loop(noise);
    this.bubbles = loop(bubbleBuf);
    const drops = loop(bubbleBuf);
    // The wash: noise -> band -> slosh (a gain swinging 1 - depth .. 1 with the LFO) -> lp; bubbles and a low body beside it.
    this.washBand = filter("bandpass", def.band[0], def.q);
    const washLevel = gain(def.wash);
    const slosh = gain(1 - def.slosh / 2);
    this.sloshDepth = gain(def.slosh / 2);
    this.sloshLfo = c.createOscillator();
    this.sloshLfo.type = "sine";
    this.sloshLfo.frequency.value = def.sloshHz[0];
    const bubbleLevel = gain(def.bubbleLevel);
    const body = filter("lowpass", 220, 0.7);
    const bodyLevel = gain(def.rumble);
    this.lp = filter("lowpass", def.lp[0], 0.7);
    this.g = gain(0);
    water.connect(this.washBand).connect(washLevel).connect(slosh).connect(this.lp);
    this.sloshLfo.connect(this.sloshDepth).connect(slosh.gain);
    this.bubbles.connect(bubbleLevel).connect(this.lp);
    water.connect(body).connect(bodyLevel).connect(this.lp);
    this.lp.connect(this.g).connect(out);
    // The splash: envelopes at 0 until splash() opens them.
    const splashOut = gain(SPLASH_LEVEL);
    this.splashBand = filter("bandpass", SPLASH_BAND[0], 0.8);
    this.splashEnv = gain(0);
    this.whump = c.createOscillator();
    this.whump.type = "sine";
    this.whump.frequency.value = WHUMP_HZ[0];
    this.whumpEnv = gain(0);
    this.dropEnv = gain(0);
    drops.playbackRate.value = 1.6;
    water.connect(this.splashBand).connect(this.splashEnv).connect(splashOut);
    this.whump.connect(this.whumpEnv).connect(splashOut);
    drops.connect(this.dropEnv).connect(splashOut);
    splashOut.connect(out);
    this.sources = [water, this.bubbles, drops, this.sloshLfo, this.whump];
    this.nodes = [this.washBand, washLevel, slosh, this.sloshDepth, bubbleLevel, body, bodyLevel, this.lp, this.g, splashOut, this.splashBand, this.splashEnv, this.whumpEnv, this.dropEnv];
    water.start(t);
    this.bubbles.start(t);
    drops.start(t, 0.9); // another stretch of the bubbles than the wash's
    this.sloshLfo.start(t);
    this.whump.start(t);
  }

  /** The wash: gain 0..1 (0 = silent), density = the slosh and bubble rate, open 0..1 (speed: brighter, higher). */
  set(gain: number, density: number, open: number, t = this.c.currentTime): void {
    if (this.stopped) return;
    const d = this.def;
    this.washBand.frequency.setTargetAtTime(d.band[0] + (d.band[1] - d.band[0]) * open, t, 0.1);
    this.sloshLfo.frequency.setTargetAtTime(d.sloshHz[0] + (d.sloshHz[1] - d.sloshHz[0]) * open, t, 0.2);
    this.bubbles.playbackRate.setTargetAtTime(density, t, 0.1);
    this.lp.frequency.setTargetAtTime(d.lp[0] + d.lp[1] * open, t, 0.1);
    this.g.gain.setTargetAtTime(gain * d.level, t, gain > 0 ? 0.06 : 0.12); // water closes over more slowly than it opens
  }

  /** The entry splash at audio time t, strength 0.35..1 (soundlogic FordSplash). */
  splash(strength: number, t = this.c.currentTime): void {
    if (this.stopped || !(strength > 0)) return;
    const s = Math.min(1, strength);
    const band = this.splashBand.frequency;
    band.cancelScheduledValues(t);
    band.setValueAtTime(SPLASH_BAND[0] * (0.8 + 0.2 * s), t);
    band.exponentialRampToValueAtTime(SPLASH_BAND[1], t + SPLASH_BAND_S * (0.7 + 0.5 * s));
    const env = (p: AudioParam, peak: number, attack: number, hold: number, tau: number) => {
      p.cancelScheduledValues(t);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(peak, t + attack);
      p.setTargetAtTime(0, t + attack + hold, tau);
    };
    env(this.splashEnv.gain, s, 0.006, 0.02 + 0.04 * s, 0.07 + 0.12 * s);
    env(this.whumpEnv.gain, 0.55 * s, 0.004, 0.01, 0.05 + 0.04 * s);
    env(this.dropEnv.gain, 0.9 * s, 0.05, 0.05 + 0.1 * s, 0.18 + 0.15 * s);
    const hz = this.whump.frequency;
    hz.cancelScheduledValues(t);
    hz.setValueAtTime(WHUMP_HZ[0], t);
    hz.exponentialRampToValueAtTime(WHUMP_HZ[1], t + 0.16);
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of [this.splashEnv.gain, this.whumpEnv.gain, this.dropEnv.gain]) {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(0, t, 0.03);
    }
    stopVoice(this.c, this.g, this.sources, this.nodes, t);
  }
}

const OIL_LEVEL = 0.065;

/**
 * The own car on an oil slick (THEME-SND): the gravel crackle drops out on the slick (there is no
 * asphalt tyre sound in the game to drop: on the tarmac only the engine is heard) and this thin hiss
 * of tyres sliding on the film plays instead (the user's pick by ear over nothing, 2026-11-23): noise
 * through a high-pass and a band-pass that rises with the slide. One persistent voice; set() only
 * moves parameters.
 */
export class OilVoice {
  private readonly band: BiquadFilterNode;
  private readonly g: GainNode;
  private readonly sources: AudioScheduledSourceNode[];
  private readonly nodes: AudioNode[];
  private stopped = false;

  constructor(
    private readonly c: BaseAudioContext,
    out: AudioNode,
    noise: AudioBuffer,
  ) {
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    hp.Q.value = 0.7;
    this.band = c.createBiquadFilter();
    this.band.type = "bandpass";
    this.band.frequency.value = 3600;
    this.band.Q.value = 0.9;
    this.g = c.createGain();
    this.g.gain.value = 0;
    src.connect(hp).connect(this.band).connect(this.g).connect(out);
    this.sources = [src];
    this.nodes = [hp, this.band, this.g];
    src.start(t, 0.37); // another stretch of the noise than the engine's and the gravel's
  }

  /** gain 0..1 (0 = silent), open 0..1 (the slide: higher and brighter). */
  set(gain: number, open: number, t = this.c.currentTime): void {
    if (this.stopped) return;
    this.band.frequency.setTargetAtTime(3600 + 3600 * open, t, 0.08);
    this.g.gain.setTargetAtTime(gain * OIL_LEVEL, t, 0.05);
  }

  stop(t = this.c.currentTime): void {
    if (this.stopped) return;
    this.stopped = true;
    stopVoice(this.c, this.g, this.sources, this.nodes, t);
  }
}

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
  // THEME-SND: one voice per theme surface kind at most, and the frame loop's reused targets.
  private sand: GravelVoice | null = null;
  private ford: FordVoice | null = null;
  private oil: OilVoice | null = null;
  private readonly fordSplash = new FordSplash();
  private readonly sandTarget: SurfaceTarget = { on: false, gain: 0, density: 0, open: 0 };
  private readonly washTarget: SurfaceTarget = { on: false, gain: 0, density: 0, open: 0 };
  private readonly oilTarget: SurfaceTarget = { on: false, gain: 0, density: 0, open: 0 };
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
    const off = onGravel(q.dist, halfOf(g.track, q)); // the per-sample asphalt (M4-SURF part 2: a split's widened road)
    // THEME-SND: the surface under the car's centre, the physics' own lookup (stepCar); a theme surface replaces the gravel.
    const surf = surfaceAt(roadFor(g.track, q), q.seg, q.s, q.lat);
    const under = tyreSurface(surf === null ? 0 : surf.kind, off);
    const target = gravelTarget(st, under === "gravel");
    if (!this.gravel && target.on) this.gravel = this.voicesNow()?.gravel() ?? null;
    this.gravel?.set(target.gain, target.density, Math.min(1, st.speed / Math.max(1, st.topSpeed)));
    this.updateThemeSurfaces(st, under, Math.abs(car.vy * Math.cos(car.h) - car.vx * Math.sin(car.h)));
  }

  /**
   * THEME-SND, the theme surfaces' own voices (one per kind, made the first time it sounds, kept to
   * the race's end): sand's crackle, the ford's splash and wash, oil's hiss; slip = the car's sideways speed.
   */
  private updateThemeSurfaces(st: EngineState, under: TyreSurface, slip: number): void {
    const sand = sandTarget(st, under === "sand", this.sandTarget);
    if (!this.sand && sand.on) this.sand = this.voicesNow()?.crackle(SAND[RACE_SAND]) ?? null;
    this.sand?.set(sand.gain, sand.density, sand.open);

    const inFord = under === "ford";
    const splash = this.fordSplash.update(st, inFord, performance.now());
    const wash = fordTarget(st, inFord, this.washTarget);
    if (!this.ford && (wash.on || splash > 0)) this.ford = this.voicesNow()?.ford(WASH[RACE_WASH]) ?? null;
    if (this.ford) {
      this.ford.set(wash.gain, wash.density, wash.open);
      if (splash > 0) this.ford.splash(splash);
    }

    const oil = oilTarget(st, under === "oil", slip, this.oilTarget);
    if (!this.oil && oil.on) this.oil = this.voicesNow()?.oil() ?? null;
    this.oil?.set(oil.gain, oil.open);
  }

  private stopSurfaces(): void {
    this.gravel?.stop();
    this.gravel = null;
    this.sand?.stop();
    this.sand = null;
    this.ford?.stop();
    this.ford = null;
    this.oil?.stop();
    this.oil = null;
    this.fordSplash.reset();
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
      this.stopSurfaces();
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
