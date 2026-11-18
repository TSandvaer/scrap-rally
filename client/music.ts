// Lobby music (PLAN-SOUND.md): original tracker-style songs for this game, composed here as
// note tables, synthesized with Web Audio (pulse / square / saw voices, noise drums with a
// sine kick) and played by a lookahead scheduler. The song data is built at load without any
// browser API (sim-test imports it).
//
// SONGS (SND-5): the host picks one (SND-4 wires the room's choice); Neon Tailpipe is the
// default (the user's pick, 2026-11-18). All are original compositions, each an A/B loop of
// 16 steps (16th notes) a bar:
//   neon-tailpipe  Neon Tailpipe         124 BPM  D minor  32 bars ~62 s  synthwave chase (default)
//   rust-bucket    Rust Bucket Shuffle   122 BPM  E minor  32 bars ~63 s  garage rock-chiptune (SND-1)
//   mirrorball     Mirrorball Pit Stop   120 BPM  A minor  32 bars  64 s  80s disco
//
// Rust Bucket Shuffle:
//   A  (bars 1-8)   Em Em C D | Em Em Am B   the hook on the lead
//   B  (bars 9-16)  C D Em Em | C D B B      long lead lines over an arpeggio
//   A2 (bars 17-24) the hook again, a soft arpeggio under it, busier drums
//   B2 (bars 25-32) B with a brighter arpeggio, a run up and a snare fill back to the top

import type { AudioEngine } from "./audio";
import { MUSIC_FADE_IN_S, MUSIC_FADE_OUT_S, MusicDirector, SEQ_TIMER_MS, StepClock, stepSeconds, type MusicAction } from "./soundlogic";

// ---- songs (pure data) ----------------------------------------------------------------

export type DrumKind = "kick" | "snare" | "hat" | "ohat" | "clank" | "crash" | "clap" | "tom" | "ltom";
export type SongPart = "bass" | "lead" | "arp" | "chord" | DrumKind;

export interface StepEvents {
  bass?: { midi: number; len: number }; // len in steps
  lead?: { midi: number; len: number };
  arp?: { midi: number; vel: number };
  chord?: { midi: readonly number[]; len: number; vel: number; swell?: boolean }; // stabs and pads
  drums: { kind: DrumKind; vel: number }[];
}

export type Wave = "square" | "sawtooth" | "triangle" | "pulse25" | "pulse12";

/** A filter whose cutoff glides (exponentially) from `from` to `to` at each note's start. */
export interface Sweep {
  type: BiquadFilterType;
  q: number;
  from: number;
  to: number;
  time: number;
}

/** A pitched voice: one oscillator (two with `unison`) -> optional filter -> envelope. */
export interface Tone {
  wave: Wave;
  level: number; // envelope peak at velocity 1, before the music bus
  gate: number; // the share of the note's length it sounds (the arpeggio: of one step)
  sustain: number; // share of the peak held after the decay
  decay: number; // s
  release: number; // s
  attack?: number; // s (default 0.004)
  filter?: Sweep;
  unison?: number; // cents: a second oscillator this far sharp (a thicker saw or pulse)
  vibrato?: { rate: number; depth: number; minDur: number; rise: number }; // depth in cents, on notes longer than minDur s
  echo?: boolean; // also into the song's echo
}

export interface Kit {
  kick: { level: number; from: number; to: number; drop: number; hold: number; decay: number };
  snare: { level: number; hp: number; decay: number; tone: number; toneTo: number; toneLevel: number; gate?: number }; // gate: held s, then cut (80s gated snare)
  hat: { level: number; decay: number };
  ohat: { level: number; decay: number };
  clank: number;
  crash: number;
  clap: number;
  tom: { level: number; hi: number; lo: number }; // Hz of "tom" and "ltom"
}

export interface Instruments {
  bass: Tone;
  lead: Tone;
  arp: Tone;
  chord: Tone;
  kit: Kit;
  echo?: { steps: number; feedback: number; tone: number; wet: number }; // a feedback delay, `steps` long
}

export interface Song {
  id: string;
  title: string;
  bpm: number;
  stepsPerBar: number;
  bars: number;
  sections: { name: string; bar: number; bars: number }[];
  steps: StepEvents[]; // bars * stepsPerBar
  inst: Instruments;
}

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "E4" -> 64, "F#5" -> 78 (C4 = 60). */
export function midiOf(name: string): number {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
}

// The note-table format every song is written in:
//   chords  bass root (low octave), the triad the arpeggio walks, the voicing of stabs and pads
//   bass    one char per step: R root, O octave up, F fifth, . rest (lengthens the note before
//           it, up to 2 steps)
//   lead    "step:note:length" tokens (length in steps)
//   stabs   one char per step: X / x chord stab (accented / normal), S swelling pad, - hold, . rest
//   beats   one line per drum: x hit, - soft hit, . rest; a beat named fill* swells its snare
interface ChordDef {
  root: string;
  triad: string[];
  pad?: string[];
}
type DrumBar = Partial<Record<DrumKind, string>>;
interface BarPlan {
  chord: string;
  bass: string;
  lead?: string;
  beat: string;
  arp?: { vel: number; up: number }; // up: semitones over the triad
  stab?: string;
  crash?: boolean;
}
interface SongDef {
  id: string;
  title: string;
  bpm: number;
  chords: Record<string, ChordDef>;
  bass: Record<string, string>;
  beats: Record<string, DrumBar>;
  stabs?: Record<string, string>;
  sections: { name: string; bars: BarPlan[] }[];
  inst: Instruments;
}

const SPB = 16;
const ARP_WALK = [0, 1, 2, 3, 2, 1]; // triad up and down; 3 = the root an octave up
const BASS_UP: Record<string, number> = { R: 0, O: 12, F: 7 }; // semitones over the root
const BASS_MAX = 2; // longest bass note in steps

function buildSong(def: SongDef): Song {
  const bars = def.sections.flatMap((s) => s.bars);
  const steps: StepEvents[] = Array.from({ length: bars.length * SPB }, () => ({ drums: [] }));
  const fail = (bar: number, what: string): never => {
    throw new Error(`${def.id} bar ${bar + 1}: bad ${what}`);
  };
  bars.forEach((b, bar) => {
    const at = bar * SPB;
    const chord = def.chords[b.chord] ?? fail(bar, `chord ${b.chord}`);
    const root = midiOf(chord.root);
    const rhythm = def.bass[b.bass];
    if (rhythm?.length !== SPB) fail(bar, `bass ${b.bass}`);
    for (let i = 0; i < SPB; i++) {
      const c = rhythm[i];
      if (c === ".") continue;
      const up = BASS_UP[c] ?? fail(bar, `bass note ${c}`);
      let len = 1;
      while (i + len < SPB && rhythm[i + len] === "." && len < BASS_MAX) len++;
      steps[at + i].bass = { midi: root + up, len };
    }
    let leadEnd = 0;
    for (const tok of (b.lead ?? "").split(" ").filter(Boolean)) {
      const [s, note, len] = tok.split(":");
      const start = Number(s);
      const n = Number(len);
      if (!(start >= leadEnd && n > 0 && start + n <= SPB)) fail(bar, `lead ${tok}`);
      steps[at + start].lead = { midi: midiOf(note), len: n };
      leadEnd = start + n;
    }
    if (b.arp) {
      const tri = chord.triad.map(midiOf);
      const notes = [...tri, tri[0] + 12];
      for (let i = 0; i < SPB; i++) {
        const n = notes[ARP_WALK[(at + i) % ARP_WALK.length]];
        steps[at + i].arp = { midi: n + b.arp.up, vel: b.arp.vel * (i % 4 === 0 ? 1 : 0.75) };
      }
    }
    if (b.stab) {
      const line = def.stabs?.[b.stab] ?? "";
      if (line.length !== SPB) fail(bar, `stab ${b.stab}`);
      const voicing = (chord.pad ?? chord.triad).map(midiOf);
      for (let i = 0; i < SPB; i++) {
        const c = line[i];
        if (c === "." || c === "-") continue;
        if (c !== "X" && c !== "x" && c !== "S") fail(bar, `stab ${c}`);
        let len = 1;
        while (i + len < SPB && line[i + len] === "-") len++;
        steps[at + i].chord = c === "S" ? { midi: voicing, len, vel: 1, swell: true } : { midi: voicing, len, vel: c === "X" ? 1 : 0.8 };
      }
    }
    const beat = def.beats[b.beat] ?? fail(bar, `beat ${b.beat}`);
    for (const kind of Object.keys(beat) as DrumKind[]) {
      const line = beat[kind]!;
      if (line.length !== SPB) fail(bar, `${kind} line in ${b.beat}`);
      for (let i = 0; i < SPB; i++) {
        if (line[i] === ".") continue;
        // A fill's snare roll swells toward the downbeat.
        const swell = b.beat.startsWith("fill") && kind === "snare" && i >= 8 ? 0.55 + (i - 8) * 0.06 : 1;
        steps[at + i].drums.push({ kind, vel: (line[i] === "-" ? 0.5 : 1) * swell });
      }
    }
    if (b.crash) steps[at].drums.push({ kind: "crash", vel: 1 });
  });
  let bar = 0;
  const sections = def.sections.map((s) => {
    const x = { name: s.name, bar, bars: s.bars.length };
    bar += s.bars.length;
    return x;
  });
  return { id: def.id, title: def.title, bpm: def.bpm, stepsPerBar: SPB, bars: bars.length, sections, steps, inst: def.inst };
}

/** Eight bars over `chords`, bar i from `bar(chord, i)`. */
const eight = (chords: string[], bar: (chord: string, i: number) => Omit<BarPlan, "chord">): BarPlan[] =>
  chords.map((chord, i) => ({ chord, ...bar(chord, i) }));
const phraseEnd = (i: number) => i === 3 || i === 7;

// The drum kit Rust Bucket Shuffle was mixed with; the other songs vary it.
const KIT: Kit = {
  kick: { level: 0.51, from: 150, to: 42, drop: 0.11, hold: 0.02, decay: 0.07 },
  snare: { level: 0.24, hp: 1100, decay: 0.045, tone: 190, toneTo: 140, toneLevel: 0.11 },
  hat: { level: 0.077, decay: 0.012 },
  ohat: { level: 0.06, decay: 0.08 },
  clank: 0.085,
  crash: 0.05,
  clap: 0.2,
  tom: { level: 0.3, hi: 200, lo: 130 },
};

// ---- Rust Bucket Shuffle (SND-1, unchanged; the default until SND-5) --------------------

const RUST_HOOK = [
  "0:B4:3 3:B4:1 4:D5:2 6:E5:4 10:D5:2 12:B4:2 14:A4:2",
  "0:G4:3 3:A4:1 4:B4:6 12:E4:2 14:G4:2",
  "0:E5:3 3:E5:1 4:G5:2 6:E5:2 8:D5:2 10:C5:2 12:B4:4",
  "0:A4:3 3:B4:1 4:A4:2 6:F#4:4 10:D4:2 12:F#4:2 14:A4:2",
  "0:B4:3 3:B4:1 4:D5:2 6:E5:4 10:D5:2 12:B4:2 14:A4:2",
  "0:G4:2 2:A4:2 4:B4:2 6:D5:2 8:E5:6 14:D5:2",
  "0:C5:3 3:B4:1 4:A4:2 6:C5:2 8:E5:4 12:D5:2 14:C5:2",
  "0:B4:2 2:D#5:2 4:F#5:4 8:D#5:2 10:B4:2 12:A4:2 14:F#4:2",
];
const RUST_LONG = [
  "0:E5:6 6:D5:2 8:C5:8",
  "0:D5:6 6:E5:2 8:F#5:8",
  "0:G5:12 12:F#5:2 14:E5:2",
  "0:B4:8 10:E5:2 12:F#5:2 14:G5:2",
  "0:E5:6 6:G5:2 8:E5:4 12:C5:4",
  "0:F#5:6 6:A5:2 8:F#5:4 12:D5:4",
  "0:D#5:8 8:F#5:8",
  "0:F#5:4 4:D#5:4 8:B4:8",
];
const RUST_LONG_END = ["0:B4:2 2:D#5:2 4:F#5:2 6:B5:2 8:A5:2 10:F#5:2 12:D#5:2 14:B4:2", "0:F#4:4"];
const RUST_A = ["Em", "Em", "C", "D", "Em", "Em", "Am", "B"];
const RUST_B = ["C", "D", "Em", "Em", "C", "D", "B", "B"];

const RUST_BUCKET: SongDef = {
  id: "rust-bucket",
  title: "Rust Bucket Shuffle",
  bpm: 122,
  chords: {
    Em: { root: "E2", triad: ["E4", "G4", "B4"] },
    C: { root: "C2", triad: ["C4", "E4", "G4"] },
    D: { root: "D2", triad: ["D4", "F#4", "A4"] },
    Am: { root: "A2", triad: ["A3", "C4", "E4"] },
    B: { root: "B1", triad: ["B3", "D#4", "F#4"] },
  },
  bass: {
    a: "R.R.O.R.R.RO.R.O",
    b: "R.RRR.R.R.RRO.R.",
    fill: "R.......R.R.O.O.",
  },
  beats: {
    a: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
    aEnd: { kick: "x.......x.x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x...", clank: "..............x." },
    a2: { kick: "x.......x.x...x.", snare: "....x.......x...", hat: "x-x-x-x-x-x-x-x-" },
    b: { kick: "x.....x.x.x.....", snare: "....x.......x..-", hat: "x-x-x-x-x-x-x-x-" },
    bEnd: { kick: "x.....x.x.x.....", snare: "....x.......x...", hat: "x-x-x-x-x-x-x-..", ohat: "..............x.", clank: ".......x........" },
    fill: { kick: "x.......x.......", snare: "....x...x.x.xxxx", hat: "x.x.x.x........." },
  },
  sections: [
    { name: "A", bars: eight(RUST_A, (_, i) => ({ bass: "a", lead: RUST_HOOK[i], beat: phraseEnd(i) ? "aEnd" : "a", crash: i === 0 })) },
    { name: "B", bars: eight(RUST_B, (_, i) => ({ bass: "b", lead: RUST_LONG[i], beat: phraseEnd(i) ? "bEnd" : "b", arp: { vel: 0.8, up: 0 }, crash: i === 0 })) },
    { name: "A2", bars: eight(RUST_A, (_, i) => ({ bass: "a", lead: RUST_HOOK[i], beat: phraseEnd(i) ? "aEnd" : "a2", arp: { vel: 0.45, up: 0 }, crash: i === 0 })) },
    {
      name: "B2",
      bars: eight(RUST_B, (_, i) => ({
        bass: i === 7 ? "fill" : "b",
        lead: i < 6 ? RUST_LONG[i] : RUST_LONG_END[i - 6],
        beat: i === 7 ? "fill" : phraseEnd(i) ? "bEnd" : "b",
        arp: i === 7 ? undefined : { vel: 0.7, up: 12 },
        crash: i === 0,
      })),
    },
  ],
  // Levels measured offline (sound board): at music volume 1 the whole loop peaks at 0.85
  // before the compressor and 0.82 after it, headroom for the race effects.
  inst: {
    bass: { wave: "square", level: 0.12, gate: 0.8, sustain: 0.7, decay: 0.12, release: 0.04, filter: { type: "lowpass", q: 5, from: 1700, to: 380, time: 0.14 } },
    lead: { wave: "pulse25", level: 0.17, gate: 0.92, sustain: 0.6, decay: 0.25, release: 0.06, vibrato: { rate: 5.5, depth: 14, minDur: 0.5, rise: 0.6 } },
    arp: { wave: "pulse12", level: 0.095, gate: 0.7, sustain: 0.35, decay: 0.06, release: 0.03 },
    chord: { wave: "pulse25", level: 0.04, gate: 0.8, sustain: 0.5, decay: 0.1, release: 0.05 }, // unused
    kit: KIT,
  },
};

// ---- Mirrorball Pit Stop: 80s disco ----------------------------------------------------
// Four on the floor, open hats on the off-beats, an octave-jumping bass and string stabs.
//   A  (1-8)   Am7 Am7 Dm7 Dm7 | Fmaj7 G Am7 E7    the hook; string stabs between its phrases
//   B  (9-16)  Fmaj7 G Em7 Am7 | Dm7 G Cmaj7 E7    long lead lines over swelling strings
//   A2 (17-24) the hook with a sparkling arpeggio
//   B2 (25-32) the strings in half-bar swells, an arpeggio, a run and a fill back to the top

const DISCO_HOOK = [
  "0:A4:2 2:C5:2 4:E5:3 7:D5:1 8:C5:2 10:A4:2 12:G4:2 14:A4:2",
  "0:E5:4 4:G5:2 6:E5:2 8:D5:4 12:C5:4",
  "0:D5:2 2:F5:2 4:A5:3 7:G5:1 8:F5:2 10:D5:2 12:C5:2 14:D5:2",
  "0:F5:4 4:E5:2 6:D5:2 8:C5:4 12:A4:4",
  "0:A4:2 2:C5:2 4:F5:4 8:E5:2 10:C5:2 12:A4:4",
  "0:B4:2 2:D5:2 4:G5:4 8:F5:2 10:D5:2 12:B4:4",
  "0:C5:3 3:B4:1 4:A4:2 6:C5:2 8:E5:6 14:A5:2",
  "0:G#5:4 4:E5:2 6:B4:2 8:D5:2 10:B4:2 12:G#4:4",
];
const DISCO_LONG = [
  "0:C6:6 6:A5:2 8:G5:8",
  "0:B5:6 6:G5:2 8:D5:8",
  "0:G5:4 4:E5:4 8:B4:4 12:D5:4",
  "0:C5:12 12:E5:4",
  "0:A5:6 6:F5:2 8:D5:4 12:F5:4",
  "0:G5:6 6:D5:2 8:B4:4 12:D5:4",
  "0:E5:4 4:G5:4 8:B5:4 12:C6:4",
  "0:B5:8 8:G#5:4 12:E5:4",
];
const DISCO_RUN = "0:B4:2 2:D5:2 4:E5:2 6:G#5:2 8:B5:2 10:G#5:2 12:E5:2 14:D5:2";
const DISCO_A = ["Am7", "Am7", "Dm7", "Dm7", "Fmaj7", "G", "Am7", "E7"];
const DISCO_B = ["Fmaj7", "G", "Em7", "Am7", "Dm7", "G", "Cmaj7", "E7"];

const MIRRORBALL: SongDef = {
  id: "mirrorball",
  title: "Mirrorball Pit Stop",
  bpm: 120,
  chords: {
    Am7: { root: "A1", triad: ["A4", "C5", "E5"], pad: ["E4", "G4", "C5"] },
    Dm7: { root: "D2", triad: ["D4", "F4", "A4"], pad: ["F4", "A4", "C5"] },
    Fmaj7: { root: "F2", triad: ["F4", "A4", "C5"], pad: ["E4", "A4", "C5"] },
    G: { root: "G2", triad: ["G4", "B4", "D5"], pad: ["D4", "G4", "B4"] },
    Em7: { root: "E2", triad: ["E4", "G4", "B4"], pad: ["E4", "G4", "D5"] },
    Cmaj7: { root: "C2", triad: ["C4", "E4", "G4"], pad: ["E4", "G4", "B4"] },
    E7: { root: "E2", triad: ["E4", "G#4", "B4"], pad: ["D4", "G#4", "B4"] },
  },
  bass: {
    oct: "R.O.R.O.R.O.R.O.",
    roll: "R.O.R.O.R.O.ROO.",
    five: "R.O.R.O.F.O.R.O.",
    fill: "R.O.R.O.R.......",
  },
  stabs: {
    off: "......x-..x-....",
    hit: "X---......x-....",
    swell: "S---------------",
    half: "S-------S-------",
  },
  beats: {
    d: { kick: "x...x...x...x...", clap: "....x.......x...", snare: "....-.......-...", hat: "x-.-x-.-x-.-x-.-", ohat: "..x...x...x...x." },
    dEnd: { kick: "x...x...x...x...", clap: "....x.......x.x.", snare: "....-.......-...", hat: "x-.-x-.-x-.-x-..", ohat: "..x...x...x...x." },
    fill: { kick: "x...x...x...x...", snare: "....-...x.x.xxxx", clap: "....x...........", ohat: "..x...x........." },
  },
  sections: [
    { name: "A", bars: eight(DISCO_A, (_, i) => ({ bass: i === 3 || i === 7 ? "roll" : i === 5 ? "five" : "oct", lead: DISCO_HOOK[i], stab: i % 2 ? "off" : "hit", beat: phraseEnd(i) ? "dEnd" : "d", crash: i === 0 })) },
    { name: "B", bars: eight(DISCO_B, (_, i) => ({ bass: phraseEnd(i) ? "roll" : "oct", lead: DISCO_LONG[i], stab: "swell", beat: phraseEnd(i) ? "dEnd" : "d", crash: i === 0 })) },
    { name: "A2", bars: eight(DISCO_A, (_, i) => ({ bass: i === 3 || i === 7 ? "roll" : i === 5 ? "five" : "oct", lead: DISCO_HOOK[i], stab: i % 2 ? "off" : "hit", arp: { vel: 0.5, up: 0 }, beat: phraseEnd(i) ? "dEnd" : "d", crash: i === 0 })) },
    {
      name: "B2",
      bars: eight(DISCO_B, (_, i) => ({
        bass: i === 7 ? "fill" : phraseEnd(i) ? "roll" : "oct",
        lead: i === 7 ? DISCO_RUN : DISCO_LONG[i],
        stab: "half",
        arp: i === 7 ? undefined : { vel: 0.4, up: 12 },
        beat: i === 7 ? "fill" : phraseEnd(i) ? "dEnd" : "d",
        crash: i === 0,
      })),
    },
  ],
  inst: {
    bass: { wave: "sawtooth", level: 0.18, gate: 0.55, sustain: 0.55, decay: 0.1, release: 0.04, filter: { type: "lowpass", q: 4, from: 1500, to: 320, time: 0.1 } },
    lead: { wave: "pulse25", level: 0.11, gate: 0.9, sustain: 0.6, decay: 0.25, release: 0.08, unison: 7, vibrato: { rate: 5.5, depth: 12, minDur: 0.4, rise: 0.4 }, echo: true },
    arp: { wave: "pulse12", level: 0.06, gate: 0.6, sustain: 0.35, decay: 0.06, release: 0.03 },
    chord: { wave: "sawtooth", level: 0.045, gate: 0.85, sustain: 0.7, decay: 0.3, release: 0.16, attack: 0.012, unison: 9, filter: { type: "lowpass", q: 0.7, from: 3600, to: 2400, time: 0.25 } },
    kit: { ...KIT, kick: { level: 0.45, from: 140, to: 45, drop: 0.1, hold: 0.02, decay: 0.08 }, snare: { ...KIT.snare, level: 0.16 }, hat: { level: 0.05, decay: 0.01 }, ohat: { level: 0.07, decay: 0.05 }, clap: 0.18 },
    echo: { steps: 3, feedback: 0.25, tone: 3000, wet: 0.22 },
  },
};

// ---- Neon Tailpipe: synthwave chase ----------------------------------------------------
// A pulsing 16th-note saw bass, a bright detuned saw lead with an echo, gated snares, pads.
//   A  (1-8)   Dm Bb F C | Dm Bb F C       the soaring theme over pad swells
//   B  (9-16)  Gm Bb Dm A | Gm Bb Dm A     the chase: a driving riff, half-bar pads
//   A2 (17-24) the theme over an echoing arpeggio
//   B2 (25-32) the chase with the arpeggio up an octave, a tom fill back to the top

const SYNTH_THEME = [
  "0:D5:6 6:F5:2 8:A5:4 12:G5:2 14:F5:2",
  "0:F5:6 6:D5:2 8:Bb4:8",
  "0:C5:4 4:F5:4 8:A5:6 14:G5:2",
  "0:G5:8 8:E5:4 12:C5:4",
  "0:D5:6 6:F5:2 8:A5:4 12:C6:4",
  "0:Bb5:6 6:A5:2 8:F5:4 12:D5:4",
  "0:F5:4 4:A5:4 8:C6:4 12:A5:4",
  "0:G5:6 6:E5:2 8:G5:4 12:E5:2 14:C5:2",
];
const SYNTH_CHASE = [
  "0:G5:2 2:G5:2 4:Bb5:2 6:A5:2 8:G5:2 10:F5:2 12:D5:4",
  "0:F5:2 2:F5:2 4:A5:2 6:G5:2 8:F5:2 10:D5:2 12:Bb4:4",
  "0:A5:4 4:F5:2 6:A5:2 8:C6:6 14:A5:2",
  "0:A5:6 6:G5:2 8:E5:4 12:C#5:4",
  "0:G5:2 2:G5:2 4:Bb5:2 6:A5:2 8:G5:2 10:F5:2 12:D5:4",
  "0:F5:2 2:F5:2 4:A5:2 6:Bb5:2 8:C6:4 12:Bb5:4",
  "0:A5:6 6:F5:2 8:D5:8",
  "0:C#5:4 4:E5:4 8:A5:8",
];
const SYNTH_A = ["Dm", "Bb", "F", "C", "Dm", "Bb", "F", "C"];
const SYNTH_B = ["Gm", "Bb", "Dm", "A", "Gm", "Bb", "Dm", "A"];

const NEON_TAILPIPE: SongDef = {
  id: "neon-tailpipe",
  title: "Neon Tailpipe",
  bpm: 124,
  chords: {
    Dm: { root: "D2", triad: ["D4", "F4", "A4"], pad: ["A3", "D4", "F4"] },
    Bb: { root: "Bb1", triad: ["Bb3", "D4", "F4"], pad: ["Bb3", "D4", "F4"] },
    F: { root: "F2", triad: ["F4", "A4", "C5"], pad: ["A3", "C4", "F4"] },
    C: { root: "C2", triad: ["C4", "E4", "G4"], pad: ["G3", "C4", "E4"] },
    Gm: { root: "G2", triad: ["G4", "Bb4", "D5"], pad: ["G3", "Bb3", "D4"] },
    A: { root: "A1", triad: ["A3", "C#4", "E4"], pad: ["A3", "C#4", "E4"] },
  },
  bass: {
    pulse: "RRORRRORRRORRROR",
    arp: "ROFOROFOROFOROFO",
    drive: "RROFRROFRROFRROF",
    fill: "RRORRROR........",
  },
  stabs: {
    swell: "S---------------",
    half: "S-------S-------",
  },
  beats: {
    k: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "x-x-x-x-x-x-x-x-" },
    kB: { kick: "x...x...x...x.x.", snare: "....x.......x...", hat: "-x-x-x-x-x-x-x..", ohat: "..............x." },
    kEnd: { kick: "x...x...x.......", snare: "....x...........", hat: "x-x-x-x-x-......", tom: "..........xx....", ltom: "............x.xx" },
    fill: { kick: "x...x...x...x...", snare: "....x...x.x.xxxx", hat: "x.x.x.x........." },
  },
  sections: [
    { name: "A", bars: eight(SYNTH_A, (_, i) => ({ bass: i % 4 === 3 ? "drive" : "pulse", lead: SYNTH_THEME[i], stab: "swell", beat: phraseEnd(i) ? "kEnd" : "k", crash: i === 0 || i === 4 })) },
    { name: "B", bars: eight(SYNTH_B, (_, i) => ({ bass: i % 2 ? "arp" : "drive", lead: SYNTH_CHASE[i], stab: "half", beat: phraseEnd(i) ? "kEnd" : "kB", crash: i === 0 })) },
    { name: "A2", bars: eight(SYNTH_A, (_, i) => ({ bass: i % 4 === 3 ? "drive" : "pulse", lead: SYNTH_THEME[i], stab: "swell", arp: { vel: 0.55, up: 0 }, beat: phraseEnd(i) ? "kEnd" : "k", crash: i === 0 || i === 4 })) },
    {
      name: "B2",
      bars: eight(SYNTH_B, (_, i) => ({
        bass: i === 7 ? "fill" : i % 2 ? "arp" : "drive",
        lead: SYNTH_CHASE[i],
        stab: "half",
        arp: i === 7 ? undefined : { vel: 0.5, up: 12 },
        beat: i === 7 ? "fill" : phraseEnd(i) ? "kEnd" : "kB",
        crash: i === 0,
      })),
    },
  ],
  inst: {
    bass: { wave: "sawtooth", level: 0.15, gate: 0.65, sustain: 0.5, decay: 0.09, release: 0.03, filter: { type: "lowpass", q: 5, from: 2200, to: 380, time: 0.09 } },
    lead: { wave: "sawtooth", level: 0.085, gate: 0.9, sustain: 0.75, decay: 0.3, release: 0.12, unison: 12, filter: { type: "lowpass", q: 1.5, from: 5500, to: 3000, time: 0.3 }, vibrato: { rate: 5.2, depth: 16, minDur: 0.4, rise: 0.45 }, echo: true },
    arp: { wave: "pulse12", level: 0.06, gate: 0.5, sustain: 0.35, decay: 0.05, release: 0.03, echo: true },
    chord: { wave: "sawtooth", level: 0.026, gate: 1, sustain: 0.85, decay: 0.6, release: 0.35, unison: 14, filter: { type: "lowpass", q: 0.8, from: 1500, to: 1100, time: 0.6 } },
    kit: {
      ...KIT,
      kick: { level: 0.42, from: 160, to: 40, drop: 0.12, hold: 0.02, decay: 0.09 },
      snare: { level: 0.19, hp: 900, decay: 0.05, tone: 180, toneTo: 120, toneLevel: 0.09, gate: 0.2 },
      hat: { level: 0.055, decay: 0.015 },
      tom: { level: 0.2, hi: 180, lo: 110 },
    },
    echo: { steps: 3, feedback: 0.38, tone: 2600, wet: 0.3 },
  },
};

/** Every song, the default (Neon Tailpipe) first. */
export const SONGS: readonly Song[] = [NEON_TAILPIPE, RUST_BUCKET, MIRRORBALL].map(buildSong);
export const DEFAULT_SONG_ID = "neon-tailpipe";
/** The default song (SND-1's single SONG export, kept for its callers). */
export const SONG: Song = SONGS.find((s) => s.id === DEFAULT_SONG_ID)!;
/** For a song picker: id + title, the default first. */
export const SONG_LIST: readonly { id: string; title: string }[] = SONGS.map((s) => ({ id: s.id, title: s.title }));

/** The song with this id; an unknown id (or none) is the default. */
export function songById(id: string | null | undefined): Song {
  return SONGS.find((s) => s.id === id) ?? SONG;
}

// ---- voices ---------------------------------------------------------------------------

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A pulse wave (duty 0.25 / 0.125: the chip lead and arpeggio), band-limited by Web Audio. */
function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const n = 48;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

/** Schedules a song's notes into any context (live or offline) on `out`. */
export class SongVoices {
  private readonly pulse25: PeriodicWave;
  private readonly pulse12: PeriodicWave;
  private readonly echo: { input: GainNode; nodes: AudioNode[] } | null = null;
  readonly stepSec: number;
  voicesStarted = 0;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: AudioNode,
    readonly noise: AudioBuffer,
    readonly song: Song = SONG,
  ) {
    this.stepSec = stepSeconds(song.bpm);
    this.pulse25 = pulseWave(ctx, 0.25);
    this.pulse12 = pulseWave(ctx, 0.125);
    const fx = song.inst.echo;
    if (fx) {
      // One feedback delay per run, darkened each repeat; voices with `echo` send into it.
      const input = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = fx.steps * this.stepSec;
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = fx.tone;
      const feedback = ctx.createGain();
      feedback.gain.value = fx.feedback;
      const wet = ctx.createGain();
      wet.gain.value = fx.wet;
      input.connect(delay);
      delay.connect(tone);
      tone.connect(feedback);
      feedback.connect(delay);
      tone.connect(wet);
      wet.connect(out);
      this.echo = { input, nodes: [input, delay, tone, feedback, wet] };
    }
  }

  /** Disconnects the run's own nodes (the echo); the notes disconnect themselves when they end. */
  dispose(): void {
    for (const n of this.echo?.nodes ?? []) n.disconnect();
  }

  /** Song step i (wrapped) at audio time t; `only` limits it to some parts (debug mixing). */
  step(i: number, t: number, only?: readonly SongPart[]): void {
    const song = this.song;
    const at = ((i % song.steps.length) + song.steps.length) % song.steps.length;
    const ev = song.steps[at];
    const sec = this.stepSec;
    const inst = song.inst;
    const on = (p: SongPart) => !only || only.includes(p);
    if (ev.bass && on("bass")) this.tone(inst.bass, ev.bass.midi, t, ev.bass.len * sec * inst.bass.gate, 1);
    if (ev.lead && on("lead")) this.tone(inst.lead, ev.lead.midi, t, ev.lead.len * sec * inst.lead.gate, 1);
    if (ev.arp && on("arp")) this.tone(inst.arp, ev.arp.midi, t, sec * inst.arp.gate, ev.arp.vel);
    if (ev.chord && on("chord")) this.chord(ev.chord, t, ev.chord.len * sec * inst.chord.gate);
    for (const d of ev.drums) if (on(d.kind)) this.drum(d.kind, t, d.vel, i);
  }

  // Attack, decay to a sustain, release from `end`; the voice is stopped once it is silent.
  private env(g: GainNode, t: number, end: number, peak: number, sustain: number, decay: number, release: number, attack = 0.004): number {
    const p = g.gain;
    const top = t + attack;
    const off = Math.max(end, top + 0.001);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, top);
    p.setTargetAtTime(peak * sustain, top, decay / 3);
    p.setTargetAtTime(0, off, release / 4);
    return off + release * 1.6;
  }

  private play(nodes: AudioNode[], sources: AudioScheduledSourceNode[], t: number, stop: number, echo = false): void {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    const last = nodes[nodes.length - 1];
    last.connect(this.out);
    if (echo && this.echo) last.connect(this.echo.input);
    for (const s of sources) {
      s.start(t);
      s.stop(stop);
    }
    sources[0].onended = () => {
      for (const n of nodes) n.disconnect();
      for (const s of sources) if (s !== nodes[0]) s.disconnect();
    };
    this.voicesStarted++;
  }

  /**
   * A voice's gain node, silent until its envelope starts. (GainNode starts at 1: when a note's
   * start falls exactly on a sample frame, that frame passed the raw noise or wave at full level.)
   */
  private gain(): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    return g;
  }

  private osc(wave: Wave, midi: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave === "pulse25") o.setPeriodicWave(this.pulse25);
    else if (wave === "pulse12") o.setPeriodicWave(this.pulse12);
    else o.type = wave;
    o.frequency.value = hz(midi);
    return o;
  }

  private sweep(s: Sweep, t: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = s.type;
    f.Q.value = s.q;
    f.frequency.setValueAtTime(s.from, t);
    f.frequency.exponentialRampToValueAtTime(s.to, t + s.time);
    return f;
  }

  private tone(inst: Tone, midi: number, t: number, dur: number, vel: number): void {
    const c = this.ctx;
    const o = this.osc(inst.wave, midi);
    const nodes: AudioNode[] = [o];
    if (inst.filter) nodes.push(this.sweep(inst.filter, t));
    const g = this.gain();
    nodes.push(g);
    const stop = this.env(g, t, t + dur, inst.level * vel, inst.sustain, inst.decay, inst.release, inst.attack);
    const sources: AudioScheduledSourceNode[] = [o];
    let o2: OscillatorNode | null = null;
    if (inst.unison) {
      o2 = this.osc(inst.wave, midi);
      o2.detune.value = inst.unison;
      o2.connect(nodes[1]);
      sources.push(o2);
    }
    const vib = inst.vibrato;
    if (vib && dur > vib.minDur) {
      // A late vibrato on held notes.
      const lfo = c.createOscillator();
      lfo.frequency.value = vib.rate;
      const depth = this.gain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(vib.depth, t + Math.min(vib.rise, dur));
      lfo.connect(depth).connect(o.detune);
      if (o2) depth.connect(o2.detune);
      sources.push(lfo);
      this.play(nodes, sources, t, stop, inst.echo);
      lfo.addEventListener("ended", () => depth.disconnect());
      return;
    }
    this.play(nodes, sources, t, stop, inst.echo);
  }

  /** A stab or pad: every note of the voicing (doubled with `unison`) into one filter and envelope. */
  private chord(ch: NonNullable<StepEvents["chord"]>, t: number, dur: number): void {
    const inst = this.song.inst.chord;
    const f = inst.filter ? this.sweep(inst.filter, t) : null;
    const g = this.gain();
    const attack = ch.swell ? Math.min(0.45, dur * 0.4) : inst.attack;
    const stop = this.env(g, t, t + dur, inst.level * ch.vel, inst.sustain, inst.decay, inst.release, attack);
    const into = f ?? g;
    const sources: OscillatorNode[] = [];
    for (const m of ch.midi) {
      const o = this.osc(inst.wave, m);
      o.connect(into);
      sources.push(o);
      if (inst.unison) {
        const o2 = this.osc(inst.wave, m);
        o2.detune.value = inst.unison;
        o2.connect(into);
        sources.push(o2);
      }
    }
    this.play(f ? [f, g] : [g], sources, t, stop, inst.echo);
  }

  private drum(kind: DrumKind, t: number, vel: number, i: number): void {
    const c = this.ctx;
    const kit = this.song.inst.kit;
    if (kind === "kick") {
      const k = kit.kick;
      const o = c.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(k.from, t);
      o.frequency.exponentialRampToValueAtTime(k.to, t + k.drop);
      const g = this.gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(k.level * vel, t + 0.003);
      g.gain.setTargetAtTime(0, t + k.hold, k.decay);
      this.play([o, g], [o], t, t + 0.45);
      return;
    }
    if (kind === "tom" || kind === "ltom") {
      // A chip tom: a triangle dropping in pitch.
      const f0 = kind === "tom" ? kit.tom.hi : kit.tom.lo;
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.22);
      const g = this.gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(kit.tom.level * vel, t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.03, 0.08);
      this.play([o, g], [o], t, t + 0.55);
      return;
    }
    if (kind === "clank") {
      // Scrap metal: three inharmonic squares through a ringing band-pass.
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 2300;
      f.Q.value = 4;
      const g = this.gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(kit.clank * vel, t + 0.002);
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
    const g = this.gain();
    g.gain.setValueAtTime(0, t);
    let stop = t + 0.3;
    if (kind === "snare") {
      const s = kit.snare;
      f.type = "highpass";
      f.frequency.value = s.hp;
      const peak = s.level * vel;
      g.gain.linearRampToValueAtTime(peak, t + 0.002);
      if (s.gate) {
        // Gated: a burst held at a plateau, then cut.
        g.gain.linearRampToValueAtTime(peak * 0.5, t + 0.04);
        g.gain.linearRampToValueAtTime(peak * 0.35, t + s.gate);
        g.gain.linearRampToValueAtTime(0, t + s.gate + 0.012);
        stop = t + s.gate + 0.05;
      } else g.gain.setTargetAtTime(0, t + 0.004, s.decay);
      // The drum's body under the noise.
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(s.tone, t);
      o.frequency.exponentialRampToValueAtTime(s.toneTo, t + 0.06);
      const og = this.gain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(s.toneLevel * vel, t + 0.002);
      og.gain.setTargetAtTime(0, t + 0.004, 0.03);
      this.play([o, og], [o], t, t + 0.25);
    } else if (kind === "clap") {
      // Three quick bursts and a short tail.
      f.type = "bandpass";
      f.frequency.value = 1300;
      f.Q.value = 1.2;
      const peak = kit.clap * vel;
      for (let k = 0; k < 3; k++) {
        g.gain.linearRampToValueAtTime(peak, t + k * 0.011 + 0.001);
        g.gain.linearRampToValueAtTime(peak * 0.15, t + k * 0.011 + 0.009);
      }
      g.gain.linearRampToValueAtTime(peak, t + 0.034);
      g.gain.setTargetAtTime(0, t + 0.036, 0.045);
      stop = t + 0.4;
    } else if (kind === "hat" || kind === "ohat") {
      f.type = "highpass";
      f.frequency.value = 7000;
      const h = kind === "ohat" ? kit.ohat : kit.hat;
      g.gain.linearRampToValueAtTime(h.level * vel, t + 0.001);
      g.gain.setTargetAtTime(0, t + 0.002, h.decay);
      stop = t + (kind === "ohat" ? 0.5 : 0.1);
    } else {
      f.type = "highpass";
      f.frequency.value = 4500;
      g.gain.linearRampToValueAtTime(kit.crash * vel, t + 0.002);
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

/** Seconds a song switch takes while playing: the old song fades out as the new one fades in from the top. */
export const SONG_XFADE_S = 0.6;

interface Run {
  song: Song;
  voices: SongVoices;
  clock: StepClock;
  fade: GainNode; // one per run; dropped on stop with any notes still queued
}

/**
 * Plays the selected song on the music bus. update() is polled every frame from the frame
 * loop with the room state; the MusicDirector (client/soundlogic.ts) decides start / fade /
 * stop, and the run's StepClock hands the ~25 ms timer the steps due in the next ~100 ms of
 * the audio clock. Nothing is scheduled before the unlock or while the tab is hidden; on
 * return the clock restarts from now. setSong() picks the song the next start plays; while
 * the music is on it switches at once with a short crossfade (the new song from the top).
 */
export class MusicPlayer {
  readonly director = new MusicDirector();
  /** The debug sound board: true plays anywhere (menu included), false silences, undefined follows the game. */
  forced: boolean | undefined = undefined;
  /** Transitions, newest last (debug: client/main.ts exposes it on scrapDebug). */
  readonly log: { action: MusicAction; phase: string; inRoom: boolean; at: number }[] = [];
  /** The songs for a picker (id + title), the default first. */
  readonly songs = SONG_LIST;
  private selected: Song = SONG;
  private run: Run | null = null;
  private outgoing: (Run & { until: number }) | null = null; // the song fading out during a switch
  private timer = 0;
  private voicesBefore = 0; // voices started by runs that are gone (debug count)

  constructor(private readonly audio: AudioEngine) {}

  update(inRoom: boolean, phase: string): void {
    const ctx = this.audio.ctx;
    const act = this.director.update(inRoom, phase, this.audio.running(), ctx ? ctx.currentTime : 0, this.forced);
    if (!act) return;
    this.log.push({ action: act, phase, inRoom, at: Math.round(performance.now()) });
    if (this.log.length > 50) this.log.shift();
    if (act === "start") this.start();
    else if (act === "resume") {
      // Wanted again while fading out; a song picked meanwhile comes in now.
      if (this.run && this.run.song !== this.selected) this.switchSong();
      else this.ramp(this.run?.fade, 1, MUSIC_FADE_IN_S);
    } else if (act === "fadeOut") this.ramp(this.run?.fade, 0, MUSIC_FADE_OUT_S);
    else this.stop();
  }

  /** The selected song: the one the next start plays (and the one playing, after a switch). */
  get song(): Song {
    return this.selected;
  }

  /** Picks the song by id (an unknown id picks the default). Off: the next start plays it; on: a short crossfade to it. */
  setSong(id: string): void {
    const next = songById(id);
    if (next === this.selected) return;
    this.selected = next;
    if (this.run && this.director.mode === "on") this.switchSong();
  }

  get playing(): boolean {
    return this.run !== null;
  }

  /** The song now heard, or null. */
  get playingSong(): Song | null {
    return this.run?.song ?? null;
  }

  /** Bar (0-based) and step of the song now being handed out. */
  position(): { bar: number; step: number } {
    const song = this.run?.song ?? this.selected;
    const s = (this.run?.clock.position ?? 0) % song.steps.length;
    return { bar: Math.floor(s / song.stepsPerBar), step: s % song.stepsPerBar };
  }

  /** Voices started since the page loaded (debug). */
  get voicesStarted(): number {
    return this.voicesBefore + (this.run?.voices.voicesStarted ?? 0) + (this.outgoing?.voices.voicesStarted ?? 0);
  }

  private start(): void {
    this.stop();
    this.begin(MUSIC_FADE_IN_S);
  }

  /** A new run of the selected song from the top, fading in; any run before it is handled by the caller. */
  private begin(fadeIn: number): void {
    const { ctx, buses, noise } = this.audio;
    if (!ctx || !buses || !noise) return;
    const fade = ctx.createGain();
    fade.gain.value = 0;
    fade.connect(buses.music);
    const song = this.selected;
    const clock = new StepClock(stepSeconds(song.bpm));
    clock.start(ctx.currentTime);
    this.run = { song, voices: new SongVoices(ctx, fade, noise, song), clock, fade };
    this.ramp(fade, 1, fadeIn);
    clearTimeout(this.timer);
    this.tick();
  }

  /** The playing song fades out over SONG_XFADE_S (still scheduled) while the selected one starts from the top. */
  private switchSong(): void {
    const ctx = this.audio.ctx;
    const old = this.run;
    if (!ctx || !old) return;
    this.dropOutgoing();
    this.outgoing = { ...old, until: ctx.currentTime + SONG_XFADE_S };
    this.ramp(old.fade, 0, SONG_XFADE_S);
    this.run = null;
    this.begin(SONG_XFADE_S);
  }

  private ramp(fade: GainNode | undefined, to: number, seconds: number): void {
    const ctx = this.audio.ctx;
    if (!ctx || !fade) return;
    const p = fade.gain;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(to, now + seconds);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.dropOutgoing();
    const run = this.run;
    this.run = null;
    if (run) this.retire(run);
  }

  private dropOutgoing(): void {
    const o = this.outgoing;
    this.outgoing = null;
    if (o) this.retire(o);
  }

  /** A short ramp instead of a click; then the run's queued notes (up to the lookahead) and its echo go too. */
  private retire(run: Run): void {
    this.voicesBefore += run.voices.voicesStarted;
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const p = run.fade.gain;
    p.cancelScheduledValues(ctx.currentTime);
    p.setValueAtTime(p.value, ctx.currentTime);
    p.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
    window.setTimeout(() => {
      run.fade.disconnect();
      run.voices.dispose();
    }, 300);
  }

  private tick = (): void => {
    const ctx = this.audio.ctx;
    const run = this.run;
    if (!ctx || !run) return;
    this.timer = window.setTimeout(this.tick, SEQ_TIMER_MS);
    const running = this.audio.running();
    for (const d of run.clock.due(ctx.currentTime, running)) run.voices.step(d.step, d.time);
    const o = this.outgoing;
    if (!o) return;
    if (ctx.currentTime >= o.until) this.dropOutgoing();
    else for (const d of o.clock.due(ctx.currentTime, running)) o.voices.step(d.step, d.time);
  };
}
