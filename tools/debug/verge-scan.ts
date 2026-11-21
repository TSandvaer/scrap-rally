// How many centreline segments does a frame search for a car on the verge (the dust: gfx/actors.ts
// note)? A car that moves is looked up near where it was (13 segments); only one that is "not
// where it was" is looked up along the whole track. On a widened road (a split's) the outer verge
// lies further from the centreline than a plain road's wall: is a car there taken for one that
// was put somewhere else, every frame? (M4-WORLD review.) No browser.
//
//   npx tsx tools/debug/verge-scan.ts              this working tree
//   npx tsx tools/debug/verge-scan.ts --ref <ref>  a git ref beside it (its client/ and shared/ in a temp folder)
//
// One car at 300 u/s on the Preview Yard test track, 150 frames a line, along the first split
// (s 6000 on, the road 60 units wider either side: asphalt to 124, verge to 168) at several
// offsets from the centreline, and along the plain top straight for comparison. What is counted:
// reads of the track's centreline points (track.pts, through a Proxy) in Renderer.frame, two a
// segment searched. Per line: the segments searched in a frame (median and most).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function measure(root: string, label: string): Promise<void> {
  const nothing = (): void => {};
  const canvas = (): unknown => {
    const ctx: Record<string, unknown> = { fillStyle: "", globalAlpha: 1, imageSmoothingEnabled: false, measureText: () => ({ width: 30 }), getContextAttributes: () => ({ willReadFrequently: true }), createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) };
    for (const m of ["putImageData", "drawImage", "fillRect", "setTransform", "clearRect", "fillText", "beginPath", "moveTo", "lineTo", "stroke", "fill"]) ctx[m] = nothing;
    const c = { width: 0, height: 0, getContext: () => ctx };
    ctx.canvas = c;
    return c;
  };
  (globalThis as Record<string, unknown>).document = { createElement: canvas };
  const load = (file: string) => import(pathToFileURL(join(root, file)).href);
  const { testTrack } = await load("shared/testtracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { Renderer } = await load("client/render.ts");
  const real = testTrack("preview-yard");
  let reads = 0;
  const track = { ...real, pts: new Proxy(real.pts, { get: (t, k, r) => (typeof k === "string" && k !== "length" && k.charCodeAt(0) < 58 && reads++, Reflect.get(t, k, r)) }) };
  console.log(`\n## ${label}\n`);
  console.log("| the car drives | segments searched a frame: median | most |");
  console.log("|---|---:|---:|");
  const lines: [string, number, number][] = [
    ["a plain road (s 1000), on its verge (90 from the centreline)", 1000, 90],
    ["the split (s 6000), on the widened asphalt (100)", 6000, 100],
    ["the split, on the inner verge (132)", 6000, 132],
    ["the split, on the outer verge (150)", 6000, 150],
    ["the split, at the wall (164)", 6000, 164],
    ["the split, on the outer verge of the other side (-150)", 6000, -150],
  ];
  for (const [what, s0, lat] of lines) {
    const r = new Renderer(canvas(), track);
    const car = { id: "c0", x: 0, y: 0, h: 0, color: "#e8552d", name: "", me: true, wreck: false, ghost: false };
    const fx = { shots: [], mines: [], sparks: [] };
    const per: number[] = [];
    for (let i = 0; i < 150; i++) {
      const p = pointAt(real, s0 + i * 5);
      car.x = p.x - Math.sin(p.h) * lat;
      car.y = p.y + Math.cos(p.h) * lat;
      car.h = p.h;
      r.follow(car.x, car.y, 1000 / 60, i === 0, "c0");
      reads = 0;
      r.frame([car], fx, null, 10000 + (i * 1000) / 60);
      if (i > 1) per.push(reads / 2); // the first frames: the car is new, it is looked up everywhere once
    }
    per.sort((a, b) => a - b);
    console.log(`| ${what} | ${per[per.length >> 1]} | ${per[per.length - 1]} |`);
  }
  console.log(`\nThe track has ${real.pts.length} segments.`);
}

if (args.includes("--child")) await measure(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2]);
else {
  const builds: { label: string; root: string; temp: boolean }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--ref") continue;
    const ref = args[++i];
    const dir = mkdtempSync(join(tmpdir(), "verge-scan-"));
    const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
    builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
  }
  builds.push({ label: "working tree", root: HERE, temp: false });
  console.log("# Segments searched for a car on the verge (Preview Yard)");
  try {
    for (const b of builds) execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--child", b.root, b.label], { cwd: HERE, stdio: "inherit" });
  } finally {
    for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
  }
}
