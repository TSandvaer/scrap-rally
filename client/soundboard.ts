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
function wav(buf: AudioBuffer): Blob {
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
.sboard label{display:flex;align-items:center;gap:6px;margin:2px 0}
.sboard label span{width:56px}
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
    const l = el("label");
    el("span", label, l);
    const r = el("input", "", l);
    r.type = "range";
    r.min = "0";
    r.max = "100";
    r.step = "5";
    r.addEventListener("input", () => audio.set({ [key]: Number(r.value) / 100 }));
    r.addEventListener("change", () => r.blur());
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
