// The catch-up visuals (M4-FX), rule 1 and the memory cap: does Renderer.frame allocate when it
// draws lightning cells, boost flames, slipstream streaks and the HUD's DRAFT and BOOST cues,
// and how much canvas memory do they add? V8's sampling heap profiler, no browser.
//
//   npx tsx tools/debug/fx-alloc.ts                 this working tree: the fields filled, then absent
//   npx tsx tools/debug/fx-alloc.ts --ref main      a git ref beside it (its client/ and shared/ unpacked into
//                                                   a temp folder; a build without the fields ignores them)
//   --warm 30000     frames driven before the measurement (the optimising compiler has to be done)
//   --frames 20000   frames measured
//   --cars 6         cars in the room (up to 6: a room's colours)
//   --cells 12       lightning cells on the track (half of them floating)
//   --off            the fields absent only (CarView.draft, .boost, WorldFx.cells, HudView.draft, .boost)
//   --on             the fields filled only
//   --interval 128   the profiler's mean sampling interval, bytes
//   --track <id>     one track only (rust-bowl, crusher-run, overpass-knot)
//   --top 10         lines per table
//
// What is driven: Renderer.frame as a race calls it, with the race HUD. A pack doing the lap at
// 430 u/s, the looks taking turns down the pack. With the fields filled: every car but the
// first is in a slipstream whose strength goes up and down (so the number and the length of
// its streaks change all the time), the first car's goes on and off; three cars burn a boost
// down from 90 ticks again and again (through the short flame at its end), one of them
// hopping (its flames grow with it); the cells lie along the road ahead of the pack, on the
// ground and floating in turn, and each is taken, waits, blinks and is back; the HUD shows the
// first car's draft and boost. The cells live in one array that is kept, as main.ts keeps it.
// ImageData is stood in for (Node has none); the canvas itself draws nothing.
//
// What is read:
// - every allocation sampled while the measured frames ran, as bytes per frame, charged to the
//   innermost function of a file under client/ on its stack ("outside" is the probe's own loop
//   and Node). Numbers under about 1 byte per frame are the sampling's noise. A hopping car
//   has an alpha worked out for its shadow (actors.ts draw): a fraction stored on the stand-in
//   canvas, which Node boxes; that is there with the fields absent too, and in the ref;
// - what the canvas was asked to draw a frame (drawImage and fillRect calls), filled against
//   absent: what the catch-up visuals cost in calls;
// - the canvases made while the measured frames ran (none: all are made before);
// - every canvas the process made and its bytes; the sprite canvases' bytes (sprites.ts
//   spriteBytes()) against their cap (SPRITE_BYTES_MAX), and the cap with the world's tile
//   pool and the most the HUD's canvases hold against the all-in cap of 16 MB (canvas-cap.ts:
//   user decision 2026-11-21; tools/debug/canvas-census.ts counts every canvas; exit code 1 if over).
//
// Each build and each mode runs in a process of its own (the script starts itself again).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANVAS_CAP, HUD_BYTES_MAX } from "./canvas-cap";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const WARM = option("--warm", 30000);
const FRAMES = option("--frames", 20000);
const CARS = Math.min(6, option("--cars", 6));
const CELLS = option("--cells", 12);
const INTERVAL = option("--interval", 128);
const TOP = option("--top", 10);
const ONLY = args.includes("--track") ? args[args.indexOf("--track") + 1] : "";
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"].filter((t) => !ONLY || t === ONLY);
const SPEED = 430;
const DT = 1000 / 60;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const LOOKS = ["sport", "racer", "truck"];
const TILE_POOL = 24 * 256 * 256 * 4; // world.ts: 24 tiles of 256 x 256
const CAP = CANVAS_CAP; // all in: the sprites, the tile pool, the HUD's canvases (canvas-cap.ts)

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

const made = { canvases: 0, images: 0, rects: 0 };
const all: { width: number; height: number }[] = []; // every canvas made

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
  all.push(canvas);
  return canvas;
}

/** One build, in this process. */
async function measure(root: string, label: string, on: boolean): Promise<void> {
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
  const { trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { Renderer } = await load("client/render.ts");
  const sprites = (await load("client/gfx/sprites.ts")) as { spriteBytes: () => number; SPRITE_BYTES_MAX: number; LOOKS?: readonly string[] };
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
  console.log(`\n## ${label}\n`);
  console.log(`${WARM} warm frames, then ${FRAMES} measured, per track; ${CARS} cars, a lap at ${SPEED} u/s, the race HUD; ${on ? `the catch-up fields FILLED (draft on ${CARS - 1} cars and on and off on the first, boost on three, ${CELLS} cells, the HUD's two cues)` : "the catch-up fields ABSENT"}; sampling every ${INTERVAL} bytes.`);
  for (const id of TRACKS) {
    const track = trackById(id);
    const lap = Math.ceil((track.length / SPEED) * 60);
    const xs = new Float64Array(lap), ys = new Float64Array(lap), hs = new Float64Array(lap);
    for (let i = 0; i < lap; i++) {
      const p = pointAt(track, (i * SPEED) / 60);
      xs[i] = p.x;
      ys[i] = p.y;
      hs[i] = p.h;
    }
    const r = new Renderer(fakeCanvas(), track);
    interface Car { id: string; x: number; y: number; h: number; color: string; name: string; me: boolean; wreck: boolean; ghost: boolean; hp: number; height: number; car: string; draft?: number; boost?: number }
    const cars: Car[] = COLORS.slice(0, CARS).map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, hp: 1, height: 0, car: LOOKS[i % LOOKS.length] }));
    const fx: { shots: unknown[]; mines: unknown[]; sparks: unknown[]; nShots: number; nSparks: number; cells?: { x: number; y: number; air: boolean; state: number }[]; nCells?: number } = { shots: [], mines: [], sparks: [], nShots: 0, nSparks: 0 };
    const hud: { topLeft: string[]; time: string; notice: string; center: string; centerSub: string; banner: string; corner: string; debug: string[]; hp: number | null; draft?: number; boost?: number } = {
      topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", notice: "", center: "", centerSub: "", banner: "", corner: "23 ms", debug: [], hp: 0.62,
    };
    if (on) {
      // The fields are there from the first frame on (an object's shape does not change mid-race), the cells in one kept array.
      for (const c of cars) {
        c.draft = 0;
        c.boost = 0;
      }
      fx.cells = Array.from({ length: CELLS }, (_, i) => ({ x: 0, y: 0, air: i % 2 === 1, state: 0 }));
      fx.nCells = CELLS;
      hud.draft = 0;
      hud.boost = 0;
    }
    const times = new Float64Array(1);
    let frameNo = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++, frameNo++) {
        const k = frameNo % lap;
        for (let c = 0; c < CARS; c++) {
          const j = (k + lap - c * 9) % lap; // 9 frames apart: about two car lengths
          cars[c].x = xs[j] - Math.sin(hs[j]) * (c % 2 ? 14 : -14);
          cars[c].y = ys[j] + Math.cos(hs[j]) * (c % 2 ? 14 : -14);
          cars[c].h = hs[j];
        }
        // Car 1 hops every two seconds.
        const hop = (frameNo % 120) / 40;
        if (CARS > 1) cars[1].height = hop < 1 ? 4 * hop * (1 - hop) : 0;
        if (on) {
          for (let c = 0; c < CARS; c++) {
            // A slipstream that swells and fades (the first car's is off half the time); a boost burnt down from 90 ticks on cars 0, 1 and 3.
            const w = ((frameNo + c * 37) % 200) / 100;
            cars[c].draft = c === 0 && frameNo % 240 < 120 ? 0 : w < 1 ? w : 2 - w;
            cars[c].boost = c === 0 || c === 1 || c === 3 ? Math.max(0, 90 - ((frameNo + c * 29) % 120)) : 0;
          }
          hud.draft = cars[0].draft;
          hud.boost = cars[0].boost;
          const cells = fx.cells!;
          for (let q = 0; q < CELLS; q++) {
            // Along the road from behind the pack to ahead of it, either side; taken every 300 frames, then waiting, then back.
            const j = (k + lap - 40 + q * 9) % lap;
            const lat = q % 3 === 0 ? 0 : q % 3 === 1 ? 58 : -58;
            cells[q].x = xs[j] - Math.sin(hs[j]) * lat;
            cells[q].y = ys[j] + Math.cos(hs[j]) * lat;
            const t = (frameNo + q * 41) % 300;
            cells[q].state = t < 120 ? 0 : 1 - (t - 120) / 180;
          }
        }
        times[0] = 10000 + frameNo * DT;
        r.follow(xs[k], ys[k], DT, false, "c0");
        r.frame(cars, fx, hud, times[0]);
      }
    };
    run(WARM);
    const canvases0 = made.canvases, images0 = made.images, rects0 = made.rects;
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
    console.log(`\n**${id}**: client/ **${(inside / FRAMES).toFixed(1)} bytes/frame**; outside (the probe's loop, Node): ${(outside / FRAMES).toFixed(1)}. A frame: ${((made.images - images0) / FRAMES).toFixed(1)} drawImage, ${((made.rects - rects0) / FRAMES).toFixed(1)} fillRect; ${made.canvases - canvases0} canvases made in the ${FRAMES} frames (${(ms / FRAMES).toFixed(4)} ms a frame here, the canvas drawing nothing).\n`);
    if (rows.length) {
      console.log("| bytes/frame | charged to (file function:line > built-in) |");
      console.log("|---:|---|");
      for (const [key, bytes] of rows.slice(0, TOP)) console.log(`| ${(bytes / FRAMES).toFixed(1)} | ${key} |`);
      if (rows.length > TOP) console.log(`| ${(rows.slice(TOP).reduce((s, x) => s + x[1], 0) / FRAMES).toFixed(1)} | (${rows.length - TOP} more) |`);
    }
  }
  session.disconnect();
  const bytes = sprites.spriteBytes(), max = sprites.SPRITE_BYTES_MAX;
  const total = all.reduce((sum, c) => sum + c.width * c.height * 4, 0);
  console.log(`\nEvery canvas this process made (view, tiles, sprites, HUD labels and art, minimaps of ${TRACKS.length} tracks): ${all.length}, ${total} B.`);
  console.log(`Sprite canvases after all of it: ${bytes} B held, the cap (SPRITE_BYTES_MAX) ${max} B: ${bytes <= max ? "ok" : "OVER"}. With the tile pool (${TILE_POOL} B) and the most the HUD's canvases hold (${HUD_BYTES_MAX} B, the catch-up cue art among them): ${max + TILE_POOL + HUD_BYTES_MAX} B at most, against the all-in cap of ${CAP}: ${max + TILE_POOL + HUD_BYTES_MAX <= CAP ? "ok" : "OVER"}.`);
  if (bytes > max || max + TILE_POOL + HUD_BYTES_MAX > CAP) process.exitCode = 1;
}

// ---- main --------------------------------------------------------------------------------

if (args.includes("--child")) {
  await measure(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2], args[args.indexOf("--child") + 3] === "on");
} else {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
  const builds: { label: string; root: string; temp: boolean }[] = [];
  for (const ref of refs) {
    const dir = mkdtempSync(join(tmpdir(), "fx-alloc-"));
    const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
    builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
  }
  builds.push({ label: "working tree", root: HERE, temp: false });
  console.log(`# Catch-up visuals allocation probe (Node ${process.version})`);
  const modes = args.includes("--off") ? ["off"] : args.includes("--on") ? ["on"] : ["on", "off"];
  try {
    for (const b of builds) {
      for (const mode of modes) execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--child", b.root, `${b.label}, fields ${mode === "on" ? "filled" : "absent"}`, mode], { cwd: HERE, stdio: "inherit" });
    }
  } finally {
    for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
  }
}
