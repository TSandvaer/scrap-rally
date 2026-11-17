// Debug sound board (?debug=1&sounds=1), loaded on demand by main.ts: music play / stop /
// follow-the-game, the volume settings, an offline render check and a 30 s WAV of the music,
// for the taste gate. Nothing here runs, or is even downloaded, without the flag.
//
// SND-2 adds a button per effect with board.addButton("Effects", "Rivet", () => ...).
// Browser checks: window.scrapSound.check(bars, volume) renders offline and returns levels.

import { buildBuses, makeNoise, type AudioEngine } from "./audio";
import { SONG, SongVoices, type MusicPlayer, type SongPart } from "./music";

export interface SoundBoard {
  addButton(group: string, label: string, play: () => void): HTMLButtonElement;
}

export interface RenderStats {
  seconds: number;
  peak: number; // after the compressor (the output), 1 = full scale
  peakDb: number;
  rmsDb: number;
  clipped: number; // samples at or past full scale
  prePeak: number; // the music bus before the compressor, at the same volume
  voices: number;
}

/** The song from the top for `seconds`, rendered offline at `volume`, through the live chain or raw. */
async function renderMusic(
  seconds: number,
  volume: number,
  raw = false,
  only?: readonly SongPart[],
  sampleRate = 44100,
): Promise<{ buf: AudioBuffer; voices: number }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  let out: AudioNode;
  if (raw) {
    const g = ctx.createGain();
    g.gain.value = volume;
    g.connect(ctx.destination);
    out = g;
  } else {
    out = buildBuses(ctx, { music: volume, effects: 0, muted: false }).music;
  }
  const voices = new SongVoices(ctx, out, makeNoise(ctx));
  const lead = 0.05;
  for (let k = 0; lead + k * voices.stepSec < seconds; k++) voices.step(k, lead + k * voices.stepSec, only);
  return { buf: await ctx.startRendering(), voices: voices.voicesStarted };
}

function levels(buf: AudioBuffer): { peak: number; rms: number; clipped: number } {
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 1) clipped++;
      sum += d[i] * d[i];
    }
  }
  return { peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)), clipped };
}

const db = (x: number) => Math.round(20 * Math.log10(Math.max(x, 1e-9)) * 10) / 10;

/** Levels of `bars` bars from the top (optionally some parts only) through the live output chain. */
export async function checkMusic(bars = 4, volume = 1, only?: readonly SongPart[]): Promise<RenderStats> {
  const seconds = (bars * SONG.stepsPerBar * 60) / SONG.bpm / 4 + 0.6;
  const [post, pre] = await Promise.all([renderMusic(seconds, volume, false, only), renderMusic(seconds, volume, true, only)]);
  const l = levels(post.buf);
  return {
    seconds: Math.round(seconds * 100) / 100,
    peak: Math.round(l.peak * 1000) / 1000,
    peakDb: db(l.peak),
    rmsDb: db(l.rms),
    clipped: l.clipped,
    prePeak: Math.round(levels(pre.buf).peak * 1000) / 1000,
    voices: post.voices,
  };
}

/** 16-bit PCM WAV. */
export function wav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + n * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true);
  data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

const CSS = `
.sboard{position:fixed;left:8px;top:8px;z-index:20;width:250px;max-height:calc(100vh - 16px);overflow:auto;
  padding:10px;background:rgba(18,14,11,.94);border:2px solid #4a3a2b;font:12px ui-monospace,Menlo,monospace;color:#efe6d2}
.sboard h3{margin:0 0 6px;font-size:13px;color:#e8752d}
.sboard h4{margin:10px 0 4px;font-size:11px;color:#a89981;text-transform:uppercase;letter-spacing:1px}
.sboard .row{display:flex;flex-wrap:wrap;gap:4px}
.sboard button,.sboard a{font:inherit;color:#efe6d2;background:#2a2119;border:1px solid #4a3a2b;padding:3px 7px;cursor:pointer;text-decoration:none}
.sboard button.on{border-color:#e8752d;color:#e8752d}
.sboard .vol{display:flex;align-items:center;gap:6px;margin:2px 0}
.sboard .vol span{width:56px}
.sboard input{flex:1}
.sboard .st{white-space:pre;color:#9fe08a;font-size:11px}
`;

export function mountSoundBoard(audio: AudioEngine, music: MusicPlayer): SoundBoard {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement("section");
  root.className = "sboard";
  root.setAttribute("aria-label", "Sound board");
  document.body.append(root);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", parent: HTMLElement = root) => {
    const e = document.createElement(tag);
    e.textContent = text;
    parent.append(e);
    return e;
  };
  const groups = new Map<string, HTMLElement>();
  const group = (name: string) => {
    let g = groups.get(name);
    if (!g) {
      el("h4", name);
      g = el("div");
      g.className = "row";
      groups.set(name, g);
    }
    return g;
  };
  const addButton = (name: string, label: string, play: () => void) => {
    const b = el("button", label, group(name));
    b.type = "button";
    b.addEventListener("click", () => {
      play();
      b.blur();
    });
    return b;
  };

  el("h3", `Sound board — ${SONG.title}`);
  const status = el("div");
  status.className = "st";

  const modes: [string, boolean | undefined][] = [
    ["Play", true],
    ["Stop", false],
    ["Follow game", undefined],
  ];
  const modeButtons = modes.map(([label, force]) => {
    const b = addButton("Music", label, () => (music.forced = force));
    b.dataset.mode = String(force);
    return b;
  });

  el("h4", "Volume");
  const slider = (label: string, key: "music" | "effects") => {
    // A div, not a <label>: a click on the text would focus the slider and hold the driving keys.
    const l = el("div");
    l.className = "vol";
    el("span", label, l);
    const r = el("input", "", l);
    r.type = "range";
    r.min = "0";
    r.max = "100";
    r.step = "5";
    r.setAttribute("aria-label", label);
    r.addEventListener("input", () => audio.set({ [key]: Number(r.value) / 100 }));
    r.addEventListener("change", () => r.blur());
    r.addEventListener("pointerup", () => r.blur());
    return r;
  };
  const vMusic = slider("Music", "music");
  const vEffects = slider("Effects", "effects");
  const mute = addButton("Mute", "Mute", () => audio.toggleMute());

  const out = el("div");
  out.className = "st";
  addButton("Check", "Render 4 bars", () => {
    out.textContent = "rendering…";
    void checkMusic(4, 1).then((s) => (out.textContent = `vol 1: peak ${s.peak} (${s.peakDb} dB) rms ${s.rmsDb} dB\nclipped ${s.clipped}  pre-comp peak ${s.prePeak}`));
  });
  const wavBtn = addButton("Check", "Make 30 s WAV", () => {
    wavBtn.textContent = "rendering…";
    void renderMusic(30, 1).then(({ buf }) => {
      const a = (document.getElementById("sboard-wav") as HTMLAnchorElement | null) ?? el("a", "", group("Check"));
      a.id = "sboard-wav";
      a.textContent = "Download WAV (music at full volume)";
      a.download = "scrap-rally-music.wav";
      if (a.href) URL.revokeObjectURL(a.href);
      a.href = URL.createObjectURL(wav(buf));
      wavBtn.textContent = "Make 30 s WAV";
    });
  });
  root.append(out);

  const render = () => {
    const s = audio.settings;
    if (document.activeElement !== vMusic) vMusic.value = String(Math.round(s.music * 100));
    if (document.activeElement !== vEffects) vEffects.value = String(Math.round(s.effects * 100));
    mute.textContent = s.muted ? "Unmute" : "Mute";
    for (const b of modeButtons) b.classList.toggle("on", b.dataset.mode === String(music.forced));
  };
  audio.onChange(render);
  render();
  const tick = () => {
    const p = music.position();
    const sec = [...SONG.sections].reverse().find((x) => p.bar >= x.bar)?.name ?? "";
    status.textContent =
      `audio ${audio.ctx?.state ?? "locked (click anywhere)"}${document.hidden ? " hidden" : ""}\n` +
      `music ${music.director.mode}${music.playing ? `  bar ${p.bar + 1}/${SONG.bars} ${sec}` : ""}\n` +
      `${SONG.bpm} BPM  voices ${music.voicesStarted}`;
    render();
    setTimeout(tick, 200);
  };
  tick();

  const board: SoundBoard = { addButton };
  (window as unknown as { scrapSound: unknown }).scrapSound = { board, check: checkMusic };
  return board;
}

// ---- race effects (SND-2) ---------------------------------------------------------------
//
// A button per effect (live, on the effects bus), other cars at a distance, an engine rev,
// and an offline render of everything in a row: levels per effect and a WAV.
// Browser checks: window.scrapSound.effects.check() and .wavBase64().

import { ENGINES, EngineVoice, SFX_DUR, SfxVoices } from "./sfx";
import { DEFAULT_SOUND, distanceGain, ENGINE_PRESETS, engineTarget, OTHER_GAIN, panFor, SFX_KINDS, type EnginePreset, type SfxKind } from "./soundlogic";
import { BASE_STATS } from "../shared/physics";
import { RIVET_COOLDOWN } from "../shared/weapons";

const EFFECT_LABEL: Record<SfxKind, string> = {
  beep: "Beep",
  go: "GO",
  rivet: "Rivet",
  drop: "Mine drop",
  blast: "Mine blast",
  hit: "Hit",
  wreck: "Wreck",
  bump: "Bump",
  takeoff: "Take-off",
  land: "Landing",
  fall: "Fall",
  recover: "Recover",
  lap: "Lap",
  finish: "Finish",
};

type Sched = (kind: SfxKind, t: number, gain?: number, pan?: number) => void;

/** Other cars' rivets 100, 400 and 700 units away, to the left, centre and right. */
function distanceDemo(play: Sched, t: number): number {
  [
    [100, -300],
    [400, 0],
    [700, 300],
  ].forEach(([d, dx], i) => play("rivet", t + i * 0.35, OTHER_GAIN * distanceGain(d), panFor(dx)));
  return t + 1.1;
}

/**
 * A scripted rev, idle -> top -> idle: idle 1.5 s, flat out from a standstill (top speed
 * after 3 s) and held to 6 s, then off the throttle coasting down to idle by 8.5 s.
 */
export const ENGINE_REV_S = 9;
const REV_IDLE_END = 1.5;
const REV_TOP_AT = 4.5;
const REV_OFF_AT = 6;
const REV_IDLE_AGAIN = 8.5;

function engineRun(e: EngineVoice, t: number): number {
  const top = BASE_STATS.topSpeed;
  const seconds = ENGINE_REV_S;
  for (let k = 0; k <= seconds * 20; k++) {
    const s = k / 20;
    const throttle = s >= REV_IDLE_END && s < REV_OFF_AT ? 1 : 0;
    const speed =
      s < REV_IDLE_END ? 0 : s < REV_OFF_AT ? top * Math.min(1, (s - REV_IDLE_END) / (REV_TOP_AT - REV_IDLE_END)) : top * Math.max(0, 1 - (s - REV_OFF_AT) / (REV_IDLE_AGAIN - REV_OFF_AT));
    const g = engineTarget({ phase: "racing", hasCar: true, connected: true, wreck: 0, fall: 0, air: 0, finished: false, speed, topSpeed: top, throttle });
    e.set(g.rpm, g.load, s >= seconds - 0.05 ? 0 : g.gain, t + s);
  }
  e.stop(t + seconds);
  return t + seconds + 0.3;
}

/** Held rivet fire: a round every RIVET_COOLDOWN ticks for `seconds`. */
function rivetBurst(play: Sched, t: number, seconds = 3, gain = 1, pan = 0): number {
  const every = RIVET_COOLDOWN / 60;
  for (let k = 0; k * every < seconds; k++) play("rivet", t + k * every, gain, pan);
  return t + seconds + SFX_DUR.rivet;
}

const MID_UNITS = 450; // "mid distance" for the previews
const midGain = () => OTHER_GAIN * distanceGain(MID_UNITS);

/** Offline previews: held rivet fire (own), a mine blast (own) and one at mid distance. */
async function renderPreview(name: "rivetBurst" | "blastOwn" | "blastMid", sampleRate = 44100): Promise<AudioBuffer> {
  const seconds = name === "rivetBurst" ? 3.5 : SFX_DUR.blast + 0.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const sv = new SfxVoices(ctx, buildBuses(ctx, { music: 0, effects: 1, muted: false }).sfx, makeNoise(ctx));
  const play: Sched = (k, at, g, p) => sv.play(k, at, g, p);
  if (name === "rivetBurst") rivetBurst(play, 0.2);
  else if (name === "blastOwn") play("blast", 0.2);
  else play("blast", 0.2, midGain(), panFor(180));
  return ctx.startRendering();
}

/** One engine preset revving idle -> top -> idle, offline through the live chain. */
async function renderEngine(preset: EnginePreset, sampleRate = 44100): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil((ENGINE_REV_S + 0.5) * sampleRate), sampleRate);
  const sv = new SfxVoices(ctx, buildBuses(ctx, { music: 0, effects: 1, muted: false }).sfx, makeNoise(ctx));
  engineRun(sv.engine(preset), 0.2);
  return ctx.startRendering();
}

/** Levels of a preset's rev: idle (0.7-1.5 s), flat out at top speed (5-6 s), coasting (6.5-7.5 s). */
async function engineLevels(preset: EnginePreset): Promise<Record<string, { peakDb: number; rmsDb: number }>> {
  const buf = await renderEngine(preset);
  const part = (a: number, b: number) => {
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = Math.floor((a + 0.2) * buf.sampleRate); i < Math.floor((b + 0.2) * buf.sampleRate); i++) {
        peak = Math.max(peak, Math.abs(d[i]));
        sum += d[i] * d[i];
        n++;
      }
    }
    return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / n)) };
  };
  return { idle: part(0.7, 1.5), top: part(5, 6), coast: part(6.5, 7.5), all: part(0, ENGINE_REV_S) };
}

/** Every effect in a row, the distance demo and an engine rev, offline through the live chain. */
async function renderEffects(preset: EnginePreset = DEFAULT_SOUND.engine, sampleRate = 44100): Promise<AudioBuffer> {
  const gap = 0.3;
  const seconds = SFX_KINDS.reduce((n, k) => n + SFX_DUR[k] + gap, 0.2) + 1.4 + ENGINE_REV_S + 0.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const sv = new SfxVoices(ctx, buildBuses(ctx, { music: 0, effects: 1, muted: false }).sfx, makeNoise(ctx));
  let t = 0.2;
  for (const k of SFX_KINDS) {
    sv.play(k, t);
    t += SFX_DUR[k] + gap;
  }
  t = distanceDemo((k, at, g, p) => sv.play(k, at, g, p), t) + 0.3;
  engineRun(sv.engine(preset), t);
  return ctx.startRendering();
}

export interface EffectStats {
  kind: SfxKind;
  peak: number;
  peakDb: number;
  rmsDb: number;
  clipped: number;
  audibleMs: number; // until the last sample above -50 dBFS
}

/**
 * Each effect alone, offline at effects volume 1 through the live chain. It starts at
 * LEAD s: the compressor is still settling at the very start of a render and reads low.
 */
async function checkEffects(): Promise<EffectStats[]> {
  const LEAD = 0.3;
  return Promise.all(
    SFX_KINDS.map(async (kind) => {
      const sr = 44100;
      const ctx = new OfflineAudioContext(2, Math.ceil((LEAD + SFX_DUR[kind] + 0.3) * sr), sr);
      new SfxVoices(ctx, buildBuses(ctx, { music: 0, effects: 1, muted: false }).sfx, makeNoise(ctx)).play(kind, LEAD);
      const buf = await ctx.startRendering();
      const l = levels(buf);
      let lastLoud = 0;
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.00316) lastLoud = i;
      return { kind, peak: Math.round(l.peak * 1000) / 1000, peakDb: db(l.peak), rmsDb: db(l.rms), clipped: l.clipped, audibleMs: Math.round((lastLoud / sr - LEAD) * 1000) };
    }),
  );
}

async function base64(buf: AudioBuffer): Promise<string> {
  const bytes = new Uint8Array(await wav(buf).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const wavBase64 = async (preset?: EnginePreset) => base64(await renderEffects(preset));
const engineWavBase64 = async (preset: EnginePreset) => base64(await renderEngine(preset));
const previewWavBase64 = async (name: "rivetBurst" | "blastOwn" | "blastMid") => base64(await renderPreview(name));
async function previewLevels(): Promise<Record<string, { peakDb: number; rmsDb: number; clipped: number }>> {
  const out: Record<string, { peakDb: number; rmsDb: number; clipped: number }> = {};
  for (const n of ["rivetBurst", "blastOwn", "blastMid"] as const) {
    const l = levels(await renderPreview(n));
    out[n] = { peakDb: db(l.peak), rmsDb: db(l.rms), clipped: l.clipped };
  }
  return out;
}

export function mountEffects(board: SoundBoard, audio: AudioEngine): void {
  let voices: SfxVoices | null = null;
  const live = (): SfxVoices | null => {
    const { ctx, buses, noise } = audio;
    if (!ctx || !buses || !noise) return null;
    if (!voices || voices.ctx !== ctx) voices = new SfxVoices(ctx, buses.sfx, noise);
    return voices;
  };
  const now = (v: SfxVoices) => v.ctx.currentTime + 0.02;
  for (const kind of SFX_KINDS) {
    board.addButton("Effects", EFFECT_LABEL[kind], () => {
      const v = live();
      if (v) v.play(kind, now(v));
    });
  }
  board.addButton("Other cars", "Rivets 100 / 400 / 700 away", () => {
    const v = live();
    if (v) distanceDemo((k, t, g, p) => v.play(k, t, g, p), now(v));
  });
  board.addButton("Other cars", `Mine blast ${MID_UNITS} away`, () => {
    const v = live();
    if (v) v.play("blast", now(v), midGain(), panFor(180));
  });
  board.addButton("Effects", "Rivet burst (3 s)", () => {
    const v = live();
    if (v) rivetBurst((k, t, g, p) => v.play(k, t, g, p), now(v));
  });
  // Engines: rev each preset (idle -> top -> idle), and pick the one the race uses.
  for (const p of ENGINE_PRESETS) {
    board.addButton("Engine: rev", `Rev ${ENGINES[p].label}`, () => {
      const v = live();
      if (v) engineRun(v.engine(p), now(v));
    });
  }
  const pick = ENGINE_PRESETS.map((p) => {
    const b = board.addButton("Engine: use in game", ENGINES[p].label, () => audio.set({ engine: p }));
    b.dataset.engine = p;
    return b;
  });
  const showPick = () => {
    for (const b of pick) {
      const on = b.dataset.engine === audio.settings.engine;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  audio.onChange(showPick);
  showPick();

  const link = (after: HTMLElement, id: string, text: string, file: string, buf: AudioBuffer) => {
    let a = document.getElementById(id) as HTMLAnchorElement | null;
    if (!a) {
      a = document.createElement("a");
      a.id = id;
      after.after(a);
    }
    a.textContent = text;
    a.download = file;
    if (a.href) URL.revokeObjectURL(a.href);
    a.href = URL.createObjectURL(wav(buf));
  };
  const btn = board.addButton("Check", "Effects WAV", () => {
    btn.textContent = "rendering…";
    void renderEffects(audio.settings.engine).then((buf) => {
      link(btn, "sboard-sfx-wav", `Download effects WAV (${buf.duration.toFixed(1)} s)`, "scrap-rally-effects.wav", buf);
      btn.textContent = "Effects WAV";
    });
  });
  const ebtn = board.addButton("Check", "Engine WAVs", () => {
    ebtn.textContent = "rendering…";
    void Promise.all(ENGINE_PRESETS.map((p) => renderEngine(p))).then((bufs) => {
      [...bufs].reverse().forEach((buf, i) => {
        const p = ENGINE_PRESETS[bufs.length - 1 - i];
        link(ebtn, `sboard-engine-${p}`, `${ENGINES[p].label} rev WAV`, `scrap-rally-engine-${p}.wav`, buf);
      });
      ebtn.textContent = "Engine WAVs";
    });
  });
  const w = window as unknown as { scrapSound?: Record<string, unknown> };
  w.scrapSound = { ...w.scrapSound, effects: { check: checkEffects, render: renderEffects, wavBase64, engineWavBase64, engineLevels, previewWavBase64, previewLevels } };
}
