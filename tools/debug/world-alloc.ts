// The road's furniture (M4-WORLD), rule 1 and the memory of it: does Renderer.frame allocate
// with water, dirt, tyre mounds, split lanes, the belt, the barrels, the press and the ramp
// truck in view, the moving ones drawn at the frame's race tick? V8's sampling heap profiler,
// no browser.
//
//   npx tsx tools/debug/world-alloc.ts              this working tree: the race tick filled, then absent
//   npx tsx tools/debug/world-alloc.ts --ref main   a git ref beside it (its client/ and shared/ unpacked into a
//                                                   temp folder; a build from before M4-WORLD draws Preview Yard as
//                                                   a plain road and ignores the tick: what the rest costs there)
//   --warm 60000     frames driven before the measurement (the optimising compiler has to be done: a tile with the
//                    truck on it is baked four times a lap, and its painter is slow to be picked up)
//   --frames 20000   frames measured
//   --on             the race tick filled only (WorldFx.rt); --off: absent only
//   --lap            the lap only; --views: the standing views only
//   --interval 128   the profiler's mean sampling interval, bytes
//   --top 10         lines per table
//
// What is driven: Renderer.frame as a race calls it, with the race HUD, on the Preview Yard test
// track (shared/testtracks.ts: every feature), two ways:
// - "lap": a pack of six doing the lap at 430 u/s, the three looks taking turns, the camera
//   following the first car. Every feature comes into view and leaves again, and the tiles under
//   them are baked on the way, lap after lap (the pool of 24 tiles does not hold a lap): the
//   bake's furniture step is measured with the rest.
// - "views": the three standing views of bench scene S6 (the last mound, the barrels and a pool;
//   the truck and a pool; the split with the press), 2000 frames each in turn, six cars driving
//   through, one of them hopping, three lightning cells in each: the furniture is in view in
//   every frame, and next to nothing is baked (the tiles of a view the pool gave away, at a cut).
// With the tick filled it runs a tick a frame, so the barrels roll, the press goes through its
// cycle and the belt's arrows run. ImageData is stood in for (Node has none); the canvas itself
// draws nothing.
//
// What is read:
// - every allocation sampled while the measured frames ran, as bytes per frame, charged to the
//   innermost function of a file under client/ on its stack ("outside" is the probe's own loop
//   and Node). Numbers under about 1 byte per frame are the sampling's noise. A hopping car has
//   an alpha worked out for its shadow (actors.ts draw): a fraction stored on the stand-in
//   canvas, which Node boxes; that is there without the furniture too (tools/debug/fx-alloc.ts);
// - what the canvas was asked to draw a frame (drawImage and fillRect calls), filled against
//   absent: what the moving things cost in calls;
// - the canvases made while the measured frames ran (none: all are made before);
// - the tiles baked while they ran.
//
// Each mode runs in a process of its own (the script starts itself again).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const WARM = option("--warm", 60000);
const FRAMES = option("--frames", 20000);
const INTERVAL = option("--interval", 128);
const TOP = option("--top", 10);
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SPEED = 430;
const DT = 1000 / 60;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const LOOKS = ["sport", "racer", "truck"];
const CARS = 6;
const HOLD = 2000; // frames a standing view is held

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

const made = { canvases: 0, images: 0, rects: 0 };

/** A canvas that draws nothing and allocates nothing when drawn on; it counts what it is asked to draw. */
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const nothing = (): void => {};
  const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const attributes = { willReadFrequently: true };
  const size = { width: 30 };
  const ctx: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineJoin: "", lineCap: "", font: "", textAlign: "", textBaseline: "", imageSmoothingEnabled: false,
    createImageData: pixels,
    getImageData: (_x: number, _y: number, w: number, h: number) => pixels(w, h),
    measureText: () => size,
    getContextAttributes: () => attributes,
    putImageData: nothing,
    drawImage: (): void => {
      made.images++;
    },
    fillRect: (): void => {
      made.rects++;
    },
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "clearRect", "strokeRect", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

/** One mode, in this process. */
async function measure(root: string, label: string, on: boolean, views: boolean): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: () => {
      made.canvases++;
      return fakeCanvas();
    },
  };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  g.ImageData = class {
    readonly data: Uint8ClampedArray;
    constructor(readonly width: number, readonly height: number) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
  const load = (file: string) => import(pathToFileURL(join(root, file)).href);
  const { testTrack } = await load("shared/testtracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { Renderer } = await load("client/render.ts");
  const { worldStats } = await load("client/gfx/world.ts");
  const sources = new Map<string, string[]>();
  const lineOf = (file: string, fn: string): string => {
    let lines = sources.get(file);
    if (!lines) sources.set(file, (lines = readFileSync(join(root, "client", file), "utf8").split("\n")));
    const at = lines.findIndex((l) => new RegExp(`^(export )?function ${fn}\\(|^  (private )?${fn}\\(`).test(l));
    return at < 0 ? "" : `:${at + 1}`;
  };

  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  const track = testTrack("preview-yard");
  console.log(`\n## ${label}\n`);
  console.log(`${WARM} warm frames, then ${FRAMES} measured; Preview Yard, ${CARS} cars, the race HUD, three lightning cells; ${views ? `three standing views, ${HOLD} frames each in turn` : `a lap at ${SPEED} u/s, the camera on the first car`}; the race tick ${on ? "FILLED (a tick a frame)" : "ABSENT"}; sampling every ${INTERVAL} bytes.`);
  const lap = Math.ceil((track.length / SPEED) * 60);
  const xs = new Float64Array(lap), ys = new Float64Array(lap), hs = new Float64Array(lap);
  for (let i = 0; i < lap; i++) {
    const p = pointAt(track, (i * SPEED) / 60);
    xs[i] = p.x;
    ys[i] = p.y;
    hs[i] = p.h;
  }
  // The standing views: the camera's place, and where the cars drive through (frames of the lap).
  const spots = [1350, 3650, 6640].map((s) => ({ at: pointAt(track, s), from: Math.round(((s - 330) / SPEED) * 60) }));
  const through = Math.round((660 / SPEED) * 60);
  const r = new Renderer(fakeCanvas(), track);
  interface Car { id: string; x: number; y: number; h: number; color: string; name: string; me: boolean; wreck: boolean; ghost: boolean; hp: number; height: number; car: string }
  const cars: Car[] = COLORS.slice(0, CARS).map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, hp: 1, height: 0, car: LOOKS[i % LOOKS.length] }));
  const cells = [0, 1, 2].map((i) => ({ x: 0, y: 0, air: i === 2, state: 0 }));
  const fx: { shots: unknown[]; mines: unknown[]; sparks: unknown[]; nShots: number; nSparks: number; cells: typeof cells; nCells: number; rt?: number } = { shots: [], mines: [], sparks: [], nShots: 0, nSparks: 0, cells, nCells: 3 };
  if (on) fx.rt = 0; // there from the first frame on: an object's shape does not change mid-race
  const hud = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", notice: "", center: "", centerSub: "", banner: "", corner: "23 ms", debug: [], hp: 0.62 };
  const times = new Float64Array(1);
  let frameNo = 0;
  const run = (n: number): void => {
    for (let i = 0; i < n; i++, frameNo++) {
      const view = spots[Math.floor(frameNo / HOLD) % 3];
      const k = views ? view.from + (frameNo % through) : frameNo % lap;
      for (let c = 0; c < CARS; c++) {
        const j = (k + lap - c * 9) % lap; // 9 frames apart: about two car lengths
        cars[c].x = xs[j] - Math.sin(hs[j]) * (c % 2 ? 22 : -22);
        cars[c].y = ys[j] + Math.cos(hs[j]) * (c % 2 ? 22 : -22);
        cars[c].h = hs[j];
      }
      // Car 1 hops every two seconds.
      const hop = (frameNo % 120) / 40;
      cars[1].height = hop < 1 ? 4 * hop * (1 - hop) : 0;
      for (let q = 0; q < 3; q++) {
        // Three cells along the road ahead of the pack, the third floating.
        const j = (k + 20 + q * 14) % lap;
        const lat = q === 0 ? 58 : q === 1 ? -58 : 20;
        cells[q].x = xs[j] - Math.sin(hs[j]) * lat;
        cells[q].y = ys[j] + Math.cos(hs[j]) * lat;
      }
      if (on) fx.rt = frameNo;
      times[0] = 10000 + frameNo * DT;
      if (views) r.follow(view.at.x, view.at.y, DT, frameNo % HOLD === 0);
      else r.follow(xs[k], ys[k], DT, false, "c0");
      r.frame(cars, fx, hud, times[0]);
    }
  };
  run(WARM);
  const canvases0 = made.canvases, images0 = made.images, rects0 = made.rects, baked0 = worldStats.baked;
  await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const t0 = performance.now();
  run(FRAMES);
  const ms = performance.now() - t0;
  const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };

  // Charge every sampled allocation to the innermost function of a file under client/ on its stack.
  const charged = new Map<string, number>();
  let inside = 0, outside = 0;
  const walk = (node: ProfileNode, owner: string): void => {
    const f = node.callFrame;
    const at = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
    const file = at < 0 ? "" : f.url.slice(at + 8);
    const name = f.functionName || "(anonymous)";
    const here = file ? `${file} ${name}${lineOf(file, name)}` : owner;
    if (node.selfSize > 0) {
      if (here) {
        const key = file ? here : `${here} > ${name}`;
        charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
        inside += node.selfSize;
      } else outside += node.selfSize;
    }
    for (const c of node.children ?? []) walk(c, here);
  };
  walk(profile.head, "");
  const rows = [...charged].sort((a, b) => b[1] - a[1]);
  console.log(`\nclient/ **${(inside / FRAMES).toFixed(1)} bytes/frame**; outside (the probe's loop, Node): ${(outside / FRAMES).toFixed(1)}. A frame: ${((made.images - images0) / FRAMES).toFixed(1)} drawImage, ${((made.rects - rects0) / FRAMES).toFixed(1)} fillRect; ${made.canvases - canvases0} canvases made and ${worldStats.baked - baked0} tiles baked in the ${FRAMES} frames (${(ms / FRAMES).toFixed(4)} ms a frame here, the canvas drawing nothing).\n`);
  if (rows.length) {
    console.log("| bytes/frame | charged to (file function:line > built-in) |");
    console.log("|---:|---|");
    for (const [key, bytes] of rows.slice(0, TOP)) console.log(`| ${(bytes / FRAMES).toFixed(1)} | ${key} |`);
    if (rows.length > TOP) console.log(`| ${(rows.slice(TOP).reduce((s, x) => s + x[1], 0) / FRAMES).toFixed(1)} | (${rows.length - TOP} more) |`);
  }
  session.disconnect();
}

// ---- main --------------------------------------------------------------------------------

if (args.includes("--child")) {
  const at = args.indexOf("--child");
  await measure(args[at + 1], args[at + 2], args[at + 3] === "on", args[at + 4] === "views");
} else {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
  const builds: { label: string; root: string; temp: boolean }[] = [];
  for (const ref of refs) {
    const dir = mkdtempSync(join(tmpdir(), "world-alloc-"));
    const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
    builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
  }
  builds.push({ label: "working tree", root: HERE, temp: false });
  console.log(`# The road's furniture: allocation probe (Node ${process.version})`);
  const modes = args.includes("--off") ? ["off"] : args.includes("--on") ? ["on"] : ["on", "off"];
  const ways = args.includes("--lap") ? ["lap"] : args.includes("--views") ? ["views"] : ["views", "lap"];
  try {
    for (const b of builds) {
      for (const way of ways) {
        // A ref from before the tick knows nothing of it: one mode is all there is to it.
        for (const mode of b.temp ? ["off"] : modes) execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--child", b.root, `${b.label}: ${way === "views" ? "the three standing views" : "the lap"}, race tick ${mode === "on" ? "filled" : "absent"}`, mode, way], { cwd: HERE, stdio: "inherit" });
      }
    }
  } finally {
    for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
  }
}
