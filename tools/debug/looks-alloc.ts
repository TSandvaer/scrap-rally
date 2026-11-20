// The cars' looks, rule 1 and the memory cap: does Renderer.frame allocate with six cars of
// three looks whose states keep changing, how many sheets are painted for it, and how much
// canvas memory do the sprite sheets hold? V8's sampling heap profiler, no browser.
//
//   npx tsx tools/debug/looks-alloc.ts                 this working tree
//   npx tsx tools/debug/looks-alloc.ts --ref main      a git ref beside it (its client/ and shared/ unpacked into
//                                                      a temp folder; a build without looks draws six sports)
//   --warm 30000     frames driven before the measurement (the optimising compiler has to be done)
//   --frames 20000   frames measured
//   --every 45       a car changes state every so many frames (0 = never); every third time two do at once
//   --cars 6         cars in the room (up to 6: a room's colours)
//   --plain          no car hops, falls or is a ghost: no alpha is worked out for the canvas (see below)
//   --interval 128   the profiler's mean sampling interval, bytes
//   --track <id>     one track only (rust-bowl, crusher-run, overpass-knot)
//   --top 10         lines per table
//
// What is driven: Renderer.frame as a race calls it. A pack doing the lap at 430 u/s, the
// looks taking turns down the pack (sport, racer, truck, sport ...), one car hopping, one
// falling now and then and coming back as a ghost, rivets, mines, a blast every 30 frames. A
// car's state goes whole, battered, wreck and whole again; with six cars every change has a
// sheet painted again (the pool holds six), so the measured frames hold the repaints too.
// ImageData is stood in for (Node has none), so the painting runs as in a browser; the canvas
// itself draws nothing.
//
// What is read:
// - every allocation sampled while the measured frames ran, as bytes per frame, charged to the
//   innermost function of a file under client/ on its stack ("outside" is the probe's own loop
//   and Node). Numbers under about 1 byte per frame are the sampling's noise. A hopping or a
//   falling car has an alpha worked out for it (actors.ts draw and car, the world's predict
//   for the fall): a fraction stored on the stand-in canvas, which Node boxes. --plain leaves
//   those cars out and shows what is left; --ref shows the build before beside it;
// - the sheets painted against the state changes in the measured frames (one each: a change
//   repaints the car's own sheet and no other);
// - the sprite canvases made since the start and their bytes (sprites.ts spriteBytes()) against
//   the cap (SPRITE_BYTES_MAX), and with the world's tile pool against PLAN-GFX's 12 MB.
//
// Each build runs in a process of its own (the script starts itself again).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const WARM = option("--warm", 30000);
const FRAMES = option("--frames", 20000);
const EVERY = option("--every", 45);
const CARS = Math.min(6, option("--cars", 6));
const PLAIN = args.includes("--plain");
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
const CAP = 12_000_000; // PLAN-GFX: total canvas memory added

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

const made = { canvases: 0, painted: 0 };

/** A canvas that draws nothing and allocates nothing when drawn on; it counts the sheets painted (putImageData of a sheet's size). */
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
    putImageData: (img: { width: number; height: number }): void => {
      if (img.width === 512 && img.height === 256) made.painted++; // a car sheet or a silhouette: the world's tiles are 256 x 256
    },
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "drawImage", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

/** One build, in this process. */
async function measure(root: string, label: string): Promise<void> {
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
  console.log(`${WARM} warm frames, then ${FRAMES} measured, per track; ${CARS} cars (${sprites.LOOKS ? "sport, racer, truck in turn" : "this build has one look: all sports"}), a lap at ${SPEED} u/s; ${EVERY ? `a state change every ${EVERY} frames, every third time two at once` : "no state changes"}${PLAIN ? "; PLAIN (no hop, no fall, no ghost)" : ""}; sampling every ${INTERVAL} bytes.`);
  let changes = 0;
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
    const cars = COLORS.slice(0, CARS).map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, hp: 1, height: 0, falling: -1 as number, car: LOOKS[i % LOOKS.length] }));
    const state = new Uint8Array(CARS); // 0 whole, 1 battered, 2 wreck
    const fx = {
      shots: [0, 1, 2, 3].map(() => ({ x: 0, y: 0, vx: 300, vy: 40 })),
      mines: [0, 1, 2].map((i) => ({ x: 0, y: 0, armed: i > 0 })),
      sparks: [{ x: 0, y: 0, age: 0, blast: true }, { x: 0, y: 0, age: 0, blast: false }],
      nShots: 4,
      nSparks: 2,
    };
    const times = new Float64Array(1);
    let frameNo = 0, turn = 0;
    const change = (c: number): void => {
      state[c] = (state[c] + 1) % 3;
      cars[c].hp = state[c] === 0 ? 1 : 0.2;
      cars[c].wreck = state[c] === 2;
      changes++;
    };
    const run = (n: number): void => {
      for (let i = 0; i < n; i++, frameNo++) {
        const k = frameNo % lap;
        if (EVERY && frameNo % EVERY === 0) {
          turn++;
          change(turn % CARS);
          if (turn % 3 === 0 && CARS > 1) change((turn + 1) % CARS);
        }
        for (let c = 0; c < CARS; c++) {
          const j = (k + lap - c * 9) % lap; // 9 frames apart: about two car lengths
          cars[c].x = xs[j] - Math.sin(hs[j]) * (c % 2 ? 14 : -14);
          cars[c].y = ys[j] + Math.cos(hs[j]) * (c % 2 ? 14 : -14);
          cars[c].h = hs[j];
        }
        // Car 1 hops every two seconds; the last car falls for 90 frames every ten seconds and is a ghost for 90 more.
        if (!PLAIN) {
          const hop = (frameNo % 120) / 40;
          if (CARS > 1) cars[1].height = hop < 1 ? 4 * hop * (1 - hop) : 0;
          const last = cars[CARS - 1], f = frameNo % 600;
          last.falling = f < 90 && !last.wreck ? (f + 1) / 90 : -1;
          last.ghost = f >= 90 && f < 180;
        }
        for (let q = 0; q < 4; q++) {
          fx.shots[q].x = xs[k] + 40 * q;
          fx.shots[q].y = ys[k] + 9 * q;
        }
        for (let q = 0; q < 3; q++) {
          const j = (k + lap - 20 * (q + 1)) % lap;
          fx.mines[q].x = xs[j];
          fx.mines[q].y = ys[j];
        }
        const began = frameNo - (frameNo % 30);
        const b = ((began % lap) + lap - 18) % lap;
        fx.sparks[0].x = xs[b];
        fx.sparks[0].y = ys[b];
        fx.sparks[0].age = (frameNo % 30) / 8;
        fx.nSparks = frameNo % 30 < 8 ? 2 : 0;
        fx.sparks[1].x = xs[k];
        fx.sparks[1].y = ys[k];
        fx.sparks[1].age = (frameNo % 16) / 16;
        times[0] = 10000 + frameNo * DT;
        r.follow(xs[k], ys[k], DT, false, "c0");
        r.frame(cars, fx, null, times[0]);
      }
    };
    run(WARM);
    const painted0 = made.painted, changes0 = changes, canvases0 = made.canvases;
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
    console.log(`\n**${id}**: client/ **${(inside / FRAMES).toFixed(1)} bytes/frame**; outside (the probe's loop, Node): ${(outside / FRAMES).toFixed(1)}. ${changes - changes0} state changes, ${made.painted - painted0} sheets painted, ${made.canvases - canvases0} canvases made in the ${FRAMES} frames (${(ms / FRAMES).toFixed(4)} ms a frame here).\n`);
    if (rows.length) {
      console.log("| bytes/frame | charged to (file function:line > built-in) |");
      console.log("|---:|---|");
      for (const [key, bytes] of rows.slice(0, TOP)) console.log(`| ${(bytes / FRAMES).toFixed(1)} | ${key} |`);
      if (rows.length > TOP) console.log(`| ${(rows.slice(TOP).reduce((s, x) => s + x[1], 0) / FRAMES).toFixed(1)} | (${rows.length - TOP} more) |`);
    }
  }
  session.disconnect();
  const bytes = sprites.spriteBytes(), max = sprites.SPRITE_BYTES_MAX;
  console.log(`\nSprite canvases after all of it: ${bytes} B held, the cap (SPRITE_BYTES_MAX) ${max} B: ${bytes <= max ? "ok" : "OVER"}. With the tile pool (${TILE_POOL} B): ${bytes + TILE_POOL} B held, ${max + TILE_POOL} B at most, against ${CAP}: ${max + TILE_POOL <= CAP ? "ok" : "OVER"}.`);
  if (bytes > max || max + TILE_POOL > CAP) process.exitCode = 1;
}

// ---- main --------------------------------------------------------------------------------

if (args.includes("--child")) {
  await measure(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2]);
} else {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
  const builds: { label: string; root: string; temp: boolean }[] = [];
  for (const ref of refs) {
    const dir = mkdtempSync(join(tmpdir(), "looks-alloc-"));
    const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
    builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
  }
  builds.push({ label: "working tree", root: HERE, temp: false });
  console.log(`# Looks allocation probe (Node ${process.version})`);
  try {
    for (const b of builds) execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args, "--child", b.root, b.label], { cwd: HERE, stdio: "inherit" });
  } finally {
    for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
  }
}
