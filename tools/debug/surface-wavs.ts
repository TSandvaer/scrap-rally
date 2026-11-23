// Theme surface sounds as files (THEME-SND): every render of the sound board's "Theme surfaces"
// (client/soundboard.ts SURFACE_RENDERS: sand vs gravel A/B per sand, each ford wash at two speeds,
// oil with the hiss and with nothing, a race mix with the engine) offline in a muted headless
// Chrome (agent-browser), written as WAVs, and the levels table (surfaceLevels) printed. Nothing
// plays: the renders are OfflineAudioContext and Chrome runs with --mute-audio.
//
//   PORT=3010 npm run dev                     (a dev server of this tree, in another shell)
//   npx tsx tools/debug/surface-wavs.ts --url http://localhost:3010 --out <dir>   (--only sand-fine,oil-on-off; --no-levels)

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const value = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const URL_BASE = value("--url", "http://localhost:3010");
const OUT = path.resolve(value("--out", "surface-wavs"));
const ONLY = value("--only", "");
const SESSION = `thsnd-wavs-${process.pid}`;
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding";

async function ab(more: string[]): Promise<string> {
  const { stdout } = await run("agent-browser", ["--session", SESSION, ...more], { timeout: 180_000, maxBuffer: 64 << 20 });
  return stdout.trim();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await ab(["--args", CHROME_ARGS, "open", `${URL_BASE}/?debug=1&sounds=1`]);
  try {
    let renders: string[] = [];
    for (let i = 0; i < 100 && !renders.length; i++) {
      const r = await ab(["eval", "window.scrapSound && window.scrapSound.surfaces ? JSON.stringify(window.scrapSound.surfaces.renders) : ''"]);
      if (r && r !== '""') renders = JSON.parse(JSON.parse(r) as string) as string[];
      else await new Promise((done) => setTimeout(done, 200));
    }
    if (!renders.length) throw new Error("no window.scrapSound.surfaces: is the dev server this tree's, with the sound board?");
    const want = ONLY ? ONLY.split(",") : renders;
    for (const name of want) {
      const b64 = JSON.parse(await ab(["eval", `window.scrapSound.surfaces.wavBase64(${JSON.stringify(name)})`])) as string;
      const file = path.join(OUT, `${name}.wav`);
      writeFileSync(file, Buffer.from(b64, "base64"));
      console.log(file);
    }
    if (!args.includes("--no-levels")) {
      const lv = JSON.parse(JSON.parse(await ab(["eval", "window.scrapSound.surfaces.levels().then((x) => JSON.stringify(x))"])) as string) as Record<string, { peakDb: number; rmsDb: number }>;
      console.log("\nlevels (offline, effects 1, the live chain; dBFS):");
      for (const [k, v] of Object.entries(lv)) console.log(`  ${k.padEnd(26)} peak ${String(v.peakDb).padStart(6)}  rms ${String(v.rmsDb).padStart(6)}`);
    }
  } finally {
    await ab(["close"]).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
