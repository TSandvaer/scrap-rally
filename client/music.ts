// Lobby music (PLAN-SOUND.md): "Rust Bucket Shuffle", an original tracker-style song for this
// game, composed here as note tables, synthesized with Web Audio (square bass, pulse lead and
// arpeggio, noise drums with a sine kick, a scrap-metal clank) and played by a lookahead
// scheduler. The song data is built at load without any browser API (sim-test imports it).
//
// 122 BPM in E minor, 16 steps (16th notes) per bar, 32 bars (~63 s) looping:
//   A  (bars 1-8)   Em Em C D | Em Em Am B   the hook on the lead
//   B  (bars 9-16)  C D Em Em | C D B B      long lead lines over an arpeggio
//   A2 (bars 17-24) the hook again, a soft arpeggio under it, busier drums
//   B2 (bars 25-32) B with a brighter arpeggio, a run up and a snare fill back to the top

import type { AudioEngine } from "./audio";
import { MUSIC_FADE_IN_S, MUSIC_FADE_OUT_S, MusicDirector, SEQ_TIMER_MS, StepClock, stepSeconds, type MusicAction } from "./soundlogic";

// ---- the song (pure data) -------------------------------------------------------------

export type DrumKind = "kick" | "snare" | "hat" | "ohat" | "clank" | "crash";
export type SongPart = "bass" | "lead" | "arp" | DrumKind;

export interface StepEvents {
  bass?: { midi: number; len: number }; // len in steps
  lead?: { midi: number; len: number };
  arp?: { midi: number; vel: number };
  drums: { kind: DrumKind; vel: number }[];
}

export interface Song {
  title: string;
  bpm: number;
  stepsPerBar: number;
  bars: number;
  sections: { name: string; bar: number; bars: number }[];
  steps: StepEvents[]; // bars * stepsPerBar
}

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "E4" -> 64, "F#5" -> 78 (C4 = 60). */
export function midiOf(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

// Chords: bass root (low octave) and the triad the arpeggio walks.
const CHORDS: Record<string, { root: string; triad: string[] }> = {
  Em: { root: "E2", triad: ["E4", "G4", "B4"] },
  C: { root: "C2", triad: ["C4", "E4", "G4"] },
  D: { root: "D2", triad: ["D4", "F#4", "A4"] },
  Am: { root: "A2", triad: ["A3", "C4", "E4"] },
  B: { root: "B1", triad: ["B3", "D#4", "F#4"] },
};

// Bass rhythms, one char per step: R root, O octave up, . rest.
const BASS = {
  a: "R.R.O.R.R.RO.R.O",
  b: "R.RRR.R.R.RRO.R.",
  fill: "R.......R.R.O.O.",
};

// Lead lines per bar: "step:note:length" (length in steps).
const HOOK = [
  "0:B4:3 3:B4:1 4:D5:2 6:E5:4 10:D5:2 12:B4:2 14:A4:2",
  "0:G4:3 3:A4:1 4:B4:6 12:E4:2 14:G4:2",
  "0:E5:3 3:E5:1 4:G5:2 6:E5:2 8:D5:2 10:C5:2 12:B4:4",
  "0:A4:3 3:B4:1 4:A4:2 6:F#4:4 10:D4:2 12:F#4:2 14:A4:2",
  "0:B4:3 3:B4:1 4:D5:2 6:E5:4 10:D5:2 12:B4:2 14:A4:2",
  "0:G4:2 2:A4:2 4:B4:2 6:D5:2 8:E5:6 14:D5:2",
  "0:C5:3 3:B4:1 4:A4:2 6:C5:2 8:E5:4 12:D5:2 14:C5:2",
  "0:B4:2 2:D#5:2 4:F#5:4 8:D#5:2 10:B4:2 12:A4:2 14:F#4:2",
];
const LONG = [
  "0:E5:6 6:D5:2 8:C5:8",
  "0:D5:6 6:E5:2 8:F#5:8",
  "0:G5:12 12:F#5:2 14:E5:2",
  "0:B4:8 10:E5:2 12:F#5:2 14:G5:2",
  "0:E5:6 6:G5:2 8:E5:4 12:C5:4",
  "0:F#5:6 6:A5:2 8:F#5:4 12:D5:4",
  "0:D#5:8 8:F#5:8",
  "0:F#5:4 4:D#5:4 8:B4:8",
];
const LONG_END = ["0:B4:2 2:D#5:2 4:F#5:2 6:B5:2 8:A5:2 10:F#5:2 12:D#5:2 14:B4:2", "0:F#4:4"];

// Drum bars, one line per kind: x hit, - soft hit, . rest.
type DrumBar = Partial<Record<DrumKind, string>>;
const BEATS: Record<string, DrumBar> = {
  a: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  aEnd: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x...", clank: "..............x." },
  a2: { kick: "x.......x.x...x.", snare: "....x.......x...", hat: "x-x-x-x-x-x-x-x-" },
  b: { kick: "x.....x.x.x.....", snare: "....x.......x..-", hat: "x-x-x-x-x-x-x-x-" },
  bEnd: { kick: "x.....x.x.x.....", snare: "....x.......x...", hat: "x-x-x-x-x-x-x-..", ohat: "..............x.", clank: ".......x........" },
  fill: { kick: "x.......x.......", snare: "....x...x.x.xxxx", hat: "x.x.x.x........." },
};

interface BarPlan {
  chord: string;
  bass: keyof typeof BASS;
  lead?: string;
  beat: string;
  arp?: { vel: number; up: number }; // up: semitones over the triad
  crash?: boolean;
}

const A_CHORDS = ["Em", "Em", "C", "D", "Em", "Em", "Am", "B"];
const B_CHORDS = ["C", "D", "Em", "Em", "C", "D", "B", "B"];

function plan(): BarPlan[] {
  const bars: BarPlan[] = [];
  const end = (i: number) => i === 3 || i === 7;
  A_CHORDS.forEach((chord, i) => bars.push({ chord, bass: "a", lead: HOOK[i], beat: end(i) ? "aEnd" : "a", crash: i === 0 }));
  B_CHORDS.forEach((chord, i) =>
    bars.push({ chord, bass: "b", lead: LONG[i], beat: end(i) ? "bEnd" : "b", arp: { vel: 0.8, up: 0 }, crash: i === 0 }),
  );
  A_CHORDS.forEach((chord, i) =>
    bars.push({ chord, bass: "a", lead: HOOK[i], beat: end(i) ? "aEnd" : "a2", arp: { vel: 0.45, up: 0 }, crash: i === 0 }),
  );
  B_CHORDS.forEach((chord, i) =>
    bars.push({
      chord,
      bass: i === 7 ? "fill" : "b",
      lead: i < 6 ? LONG[i] : LONG_END[i - 6],
      beat: i === 7 ? "fill" : end(i) ? "bEnd" : "b",
      arp: i === 7 ? undefined : { vel: 0.7, up: 12 },
      crash: i === 0,
    }),
  );
  return bars;
}

const ARP_WALK = [0, 1, 2, 3, 2, 1]; // triad up and down; 3 = the root an octave up

function buildSong(): Song {
  const SPB = 16;
  const bars = plan();
  const steps: StepEvents[] = Array.from({ length: bars.length * SPB }, () => ({ drums: [] }));
  bars.forEach((b, bar) => {
    const at = bar * SPB;
    const chord = CHORDS[b.chord];
    const root = midiOf(chord.root);
    const rhythm = BASS[b.bass];
    for (let i = 0; i < SPB; i++) {
      const c = rhythm[i];
      if (c === ".") continue;
      let len = 1;
      while (i + len < SPB && rhythm[i + len] === "." && len < 2) len++;
      steps[at + i].bass = { midi: root + (c === "O" ? 12 : 0), len };
    }
    for (const tok of (b.lead ?? "").split(" ").filter(Boolean)) {
      const [s, note, len] = tok.split(":");
      steps[at + Number(s)].lead = { midi: midiOf(note), len: Number(len) };
    }
    if (b.arp) {
      const tri = chord.triad.map(midiOf);
      const notes = [...tri, tri[0] + 12];
      for (let i = 0; i < SPB; i++) {
        const n = notes[ARP_WALK[(at + i) % ARP_WALK.length]];
        steps[at + i].arp = { midi: n + b.arp.up, vel: b.arp.vel * (i % 4 === 0 ? 1 : 0.75) };
      }
    }
    const beat = BEATS[b.beat];
    for (const kind of Object.keys(beat) as DrumKind[]) {
      const line = beat[kind]!;
      for (let i = 0; i < SPB; i++) {
        if (line[i] === ".") continue;
        // The fill's snare roll swells toward the downbeat.
        const swell = b.beat === "fill" && kind === "snare" && i >= 8 ? 0.55 + (i - 8) * 0.06 : 1;
        steps[at + i].drums.push({ kind, vel: (line[i] === "-" ? 0.5 : 1) * swell });
      }
    }
    if (b.crash) steps[at].drums.push({ kind: "crash", vel: 1 });
  });
  return {
    title: "Rust Bucket Shuffle",
    bpm: 122,
    stepsPerBar: SPB,
    bars: bars.length,
    sections: [
      { name: "A", bar: 0, bars: 8 },
      { name: "B", bar: 8, bars: 8 },
      { name: "A2", bar: 16, bars: 8 },
      { name: "B2", bar: 24, bars: 8 },
    ],
    steps,
  };
}

export const SONG: Song = buildSong();

// ---- voices ---------------------------------------------------------------------------

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// Levels per voice before the music bus. Measured offline (sound board): at music volume 1
// the whole loop peaks at 0.85 before the compressor and 0.82 after it, headroom for SND-2.
const LEVEL = { bass: 0.12, lead: 0.17, arp: 0.095, kick: 0.51, snare: 0.24, tone: 0.11, hat: 0.077, ohat: 0.06, clank: 0.085, crash: 0.05 };

/** A pulse wave (duty 0.25 / 0.125: the chip lead and arpeggio), band-limited by Web Audio. */
function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const n = 48;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

/** Schedules the song's notes into any context (live or offline) on `out`. */
export class SongVoices {
  private readonly pulse25: PeriodicWave;
  private readonly pulse12: PeriodicWave;
  readonly stepSec = stepSeconds(SONG.bpm);
  voicesStarted = 0;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: AudioNode,
    readonly noise: AudioBuffer,
  ) {
    this.pulse25 = pulseWave(ctx, 0.25);
    this.pulse12 = pulseWave(ctx, 0.125);
  }

  /** Song step i (wrapped) at audio time t; `only` limits it to some parts (debug mixing). */
  step(i: number, t: number, only?: readonly SongPart[]): void {
    const ev = SONG.steps[((i % SONG.steps.length) + SONG.steps.length) % SONG.steps.length];
    const sec = this.stepSec;
    const on = (p: SongPart) => !only || only.includes(p);
    if (ev.bass && on("bass")) this.bass(ev.bass.midi, t, ev.bass.len * sec * 0.8);
    if (ev.lead && on("lead")) this.lead(ev.lead.midi, t, ev.lead.len * sec * 0.92);
    if (ev.arp && on("arp")) this.arp(ev.arp.midi, t, sec * 0.7, ev.arp.vel);
    for (const d of ev.drums) if (on(d.kind)) this.drum(d.kind, t, d.vel, i);
  }

  // Attack, decay to a sustain, release from `end`; the voice is stopped once it is silent.
  private env(g: GainNode, t: number, end: number, peak: number, sustain: number, decay: number, release: number): number {
    const p = g.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + 0.004);
    p.setTargetAtTime(peak * sustain, t + 0.004, decay / 3);
    p.setTargetAtTime(0, Math.max(end, t + 0.005), release / 4);
    return Math.max(end, t + 0.005) + release * 1.6;
  }

  private play(nodes: AudioNode[], sources: AudioScheduledSourceNode[], t: number, stop: number): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(this.out);
    for (const s of sources) {
      s.start(t);
      s.stop(stop);
    }
    sources[0].onended = () => {
      for (const n of nodes) n.disconnect();
      for (const s of sources.slice(1)) s.disconnect();
    };
    this.voicesStarted++;
  }

  private bass(midi: number, t: number, dur: number): void {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = "square";
    o.frequency.value = hz(midi);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 5;
    f.frequency.setValueAtTime(1700, t);
    f.frequency.exponentialRampToValueAtTime(380, t + 0.14);
    const g = c.createGain();
    const stop = this.env(g, t, t + dur, LEVEL.bass, 0.7, 0.12, 0.04);
    this.play([o, f, g], [o], t, stop);
  }

  private lead(midi: number, t: number, dur: number): void {
    const c = this.ctx;
    const o = c.createOscillator();
    o.setPeriodicWave(this.pulse25);
    o.frequency.value = hz(midi);
    const g = c.createGain();
    const stop = this.env(g, t, t + dur, LEVEL.lead, 0.6, 0.25, 0.06);
    const sources: AudioScheduledSourceNode[] = [o];
    if (dur > 0.5) {
      // A late vibrato on held notes.
      const lfo = c.createOscillator();
      lfo.frequency.value = 5.5;
      const depth = c.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(14, t + Math.min(0.6, dur));
      lfo.connect(depth).connect(o.detune);
      sources.push(lfo);
      this.play([o, g], sources, t, stop);
      lfo.addEventListener("ended", () => depth.disconnect());
      return;
    }
    this.play([o, g], sources, t, stop);
  }

  private arp(midi: number, t: number, dur: number, vel: number): void {
    const c = this.ctx;
    const o = c.createOscillator();
    o.setPeriodicWave(this.pulse12);
    o.frequency.value = hz(midi);
    const g = c.createGain();
    const stop = this.env(g, t, t + dur, LEVEL.arp * vel, 0.35, 0.06, 0.03);
    this.play([o, g], [o], t, stop);
  }

  private drum(kind: DrumKind, t: number, vel: number, i: number): void {
    const c = this.ctx;
    if (kind === "kick") {
      const o = c.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(LEVEL.kick * vel, t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.02, 0.07);
      this.play([o, g], [o], t, t + 0.45);
      return;
    }
    if (kind === "clank") {
      // Scrap metal: three inharmonic squares through a ringing band-pass.
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 2300;
      f.Q.value = 4;
      const g = c.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(LEVEL.clank * vel, t + 0.002);
      g.gain.setTargetAtTime(0, t + 0.004, 0.06);
      const oscs = [523, 749, 1187].map((fr) => {
        const o = c.createOscillator();
        o.type = "square";
        o.frequency.value = fr;
        o.connect(f);
        return o;
      });
      f.connect(g).connect(this.out);
      for (const o of oscs) {
        o.start(t);
        o.stop(t + 0.4);
      }
      oscs[0].onended = () => {
        for (const o of oscs) o.disconnect();
        f.disconnect();
        g.disconnect();
      };
      this.voicesStarted++;
      return;
    }
    const n = c.createBufferSource();
    n.buffer = this.noise;
    n.loop = true; // the crash outlasts the buffer
    const offset = (i * 0.137) % 0.8; // a different stretch of noise each step
    const f = c.createBiquadFilter();
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    let stop = t + 0.3;
    if (kind === "snare") {
      f.type = "highpass";
      f.frequency.value = 1100;
      g.gain.linearRampToValueAtTime(LEVEL.snare * vel, t + 0.002);
      g.gain.setTargetAtTime(0, t + 0.004, 0.045);
      // The drum's body under the noise.
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
      const og = c.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(LEVEL.tone * vel, t + 0.002);
      og.gain.setTargetAtTime(0, t + 0.004, 0.03);
      this.play([o, og], [o], t, t + 0.25);
    } else if (kind === "hat" || kind === "ohat") {
      f.type = "highpass";
      f.frequency.value = 7000;
      const open = kind === "ohat";
      g.gain.linearRampToValueAtTime((open ? LEVEL.ohat : LEVEL.hat) * vel, t + 0.001);
      g.gain.setTargetAtTime(0, t + 0.002, open ? 0.08 : 0.012);
      stop = t + (open ? 0.5 : 0.1);
    } else {
      f.type = "highpass";
      f.frequency.value = 4500;
      g.gain.linearRampToValueAtTime(LEVEL.crash * vel, t + 0.002);
      g.gain.setTargetAtTime(0, t + 0.004, 0.4);
      stop = t + 2.2;
    }
    n.connect(f).connect(g).connect(this.out);
    n.start(t, offset);
    n.stop(stop);
    n.onended = () => {
      n.disconnect();
      f.disconnect();
      g.disconnect();
    };
    this.voicesStarted++;
  }
}

// ---- live player ----------------------------------------------------------------------

/**
 * Plays SONG on the music bus. update() is polled every frame from the frame loop with the
 * room state; the MusicDirector (client/soundlogic.ts) decides start / fade / stop, and the
 * StepClock hands the ~25 ms timer the steps due in the next ~100 ms of the audio clock.
 * Nothing is scheduled before the unlock or while the tab is hidden; on return the clock
 * restarts from now.
 */
export class MusicPlayer {
  readonly director = new MusicDirector();
  /** The debug sound board: true plays anywhere (menu included), false silences, undefined follows the game. */
  forced: boolean | undefined = undefined;
  /** Transitions, newest last (debug: client/main.ts exposes it on scrapDebug). */
  readonly log: { action: MusicAction; phase: string; inRoom: boolean; at: number }[] = [];
  private readonly clock = new StepClock(stepSeconds(SONG.bpm));
  private voices: SongVoices | null = null;
  private fade: GainNode | null = null; // one per run; dropped on stop with any notes still queued
  private timer = 0;

  constructor(private readonly audio: AudioEngine) {}

  update(inRoom: boolean, phase: string): void {
    const ctx = this.audio.ctx;
    const act = this.director.update(inRoom, phase, this.audio.running(), ctx ? ctx.currentTime : 0, this.forced);
    if (!act) return;
    this.log.push({ action: act, phase, inRoom, at: Math.round(performance.now()) });
    if (this.log.length > 50) this.log.shift();
    if (act === "start") this.start();
    else if (act === "resume") this.ramp(1, MUSIC_FADE_IN_S);
    else if (act === "fadeOut") this.ramp(0, MUSIC_FADE_OUT_S);
    else this.stop();
  }

  get playing(): boolean {
    return this.fade !== null;
  }

  /** Bar (0-based) and step of the song now being handed out. */
  position(): { bar: number; step: number } {
    const s = this.clock.position % SONG.steps.length;
    return { bar: Math.floor(s / SONG.stepsPerBar), step: s % SONG.stepsPerBar };
  }

  /** Voices started since the page loaded (debug). */
  get voicesStarted(): number {
    return this.voices?.voicesStarted ?? 0;
  }

  private start(): void {
    const { ctx, buses, noise } = this.audio;
    if (!ctx || !buses || !noise) return;
    this.stop();
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.fade.connect(buses.music);
    const started = this.voices?.voicesStarted ?? 0;
    this.voices = new SongVoices(ctx, this.fade, noise);
    this.voices.voicesStarted = started;
    this.clock.start(ctx.currentTime);
    this.ramp(1, MUSIC_FADE_IN_S);
    this.tick();
  }

  private ramp(to: number, seconds: number): void {
    const ctx = this.audio.ctx;
    if (!ctx || !this.fade) return;
    const p = this.fade.gain;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(to, now + seconds);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    const fade = this.fade;
    const ctx = this.audio.ctx;
    this.fade = null;
    if (!fade || !ctx) return;
    // A short ramp instead of a click; then the queued notes (up to the lookahead) go too.
    fade.gain.cancelScheduledValues(ctx.currentTime);
    fade.gain.setValueAtTime(fade.gain.value, ctx.currentTime);
    fade.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
    window.setTimeout(() => fade.disconnect(), 300);
  }

  private tick = (): void => {
    const ctx = this.audio.ctx;
    if (!ctx || !this.fade || !this.voices) return;
    this.timer = window.setTimeout(this.tick, SEQ_TIMER_MS);
    for (const d of this.clock.due(ctx.currentTime, this.audio.running())) this.voices.step(d.step, d.time);
  };
}
