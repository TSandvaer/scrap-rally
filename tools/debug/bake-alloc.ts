// Bake allocation probe: which functions of the world's bake path allocate, and how much per
// frame, once the code is warm? V8's sampling heap profiler, no browser.
//
//   npx tsx tools/debug/bake-alloc.ts                      this working tree
//   npx tsx tools/debug/bake-alloc.ts --ref main           a git ref beside it (its client/ and shared/ are
//                                                          unpacked into a temp folder); any number of refs
//   npx tsx tools/debug/bake-alloc.ts --only-refs --ref X  the refs alone
//   --warm 60000    frames driven before the measurement (the optimising compiler has to be done)
//   --frames 6000   frames measured
//   --interval 128  the profiler's mean sampling interval, bytes
//   --track <id>    one track only (rust-bowl, crusher-run, overpass-knot)
//   --top 12        lines per table
//   --pin           performance.now() stands still while a frame draws, as in the benchmark:
//                   a frame's share of the baking is then the same on every run
//   --marks         track marks are made on the way (builds that have them): a mine's scorch
//                   every 30 frames and a tyre mark every other frame, handed to the world as
//                   the actors hand them (world.ts MARK, scorch, skid)
//   --renderer      not the World alone but Renderer.frame as a race calls it: a pack of six
//                   doing the lap, two of them sliding sideways all the way (tyre marks every
//                   other frame), rivets, mines, a mine blast every 30 frames; no HUD panel.
//                   Charged to the innermost function of any file under client/
//   --no-inline     the optimising compilers inline nothing (V8's --no-turbo-inlining and
//                   --no-maglev-inlining): every call that hands a fraction over or back then
//                   boxes it, so this shows what the normal run owes to inlining
//   --hypot         nothing is driven: Math.hypot against the sum the bake spells out in its
//                   place (world.ts, HYPOT), on twenty million pairs, bit for bit
//
// What is driven: World.aim + World.draw, the camera on a car doing laps at 430 u/s, as a race
// does it. The pool holds 24 tiles and a lap needs about 140, so tiles are baked all the way
// round, every lap: this is the bake path, not the standing camera.
//
// What is read: every allocation the profiler sampled while the measured frames ran (objects
// that were collected again are counted: both includeObjectsCollectedBy... flags are set), as
// bytes per frame. Each one is charged to the innermost function of client/gfx/world.ts on
// its stack (with --renderer: of any file under client/), with the built-in it happened in
// when that is not the function itself ("yard > hypot": the number Math.hypot hands back to
// yard). "outside" is the probe's own loop and Node. Numbers under about 1 byte per frame are
// the sampling's noise.
//
// Each build runs in a process of its own (the script starts itself again), so no build's
// compiled code or heap is another's.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const WARM = option("--warm", 60000);
const FRAMES = option("--frames", 6000);
const INTERVAL = option("--interval", 128);
const TOP = option("--top", 12);
const PIN = args.includes("--pin");
const MARKS = args.includes("--marks");
const RENDERER = args.includes("--renderer");
const NO_INLINE = args.includes("--no-inline");
const ONLY = args.includes("--track") ? args[args.indexOf("--track") + 1] : "";
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"].filter((t) => !ONLY || t === ONLY);
const SPEED = 430;
const DT = 1000 / 60;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

/** A canvas that draws nothing and allocates nothing when drawn on (every method a Renderer calls is there, one function for all). */
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
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "drawImage", "putImageData", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

/** One build, in this process: drive the laps, print the tables. */
async function measure(root: string, label: string): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => fakeCanvas() };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  const load = (file: string) => import(pathToFileURL(join(root, file)).href);
  const world = await load("client/gfx/world.ts");
  const { trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { World, worldStats, ZOOM, VIEW_W, VIEW_H } = world;
  const { Renderer } = RENDERER ? await load("client/render.ts") : { Renderer: null };
  // Where a function of a file starts, for the tables.
  const sources = new Map<string, string[]>();
  const lineOf = (file: string, fn: string): string => {
    let lines = sources.get(file);
    if (!lines) sources.set(file, (lines = readFileSync(join(root, "client", file), "utf8").split("\n")));
    const at = lines.findIndex((l) => new RegExp(`^(export )?function ${fn}\\(|^  (private )?${fn}\\(`).test(l));
    return at < 0 ? "" : `:${at + 1}`;
  };
  // --marks: the build's own way in, if it has one.
  const marks = MARKS && typeof world.scorch === "function" ? (world as { MARK: Float64Array; scorch: (track: unknown) => void; skid: (track: unknown) => void }) : null;
  if (MARKS && !marks) console.log(`\n(${label}: this build has no track marks; --marks does nothing here)`);
  const markStats = (world.markStats ?? null) as { scorches: number; skids: number; uploads: number } | null;
  // The clock: real, or standing still while a frame draws (--pin).
  const realNow = performance.now.bind(performance);
  let pinned = -1;
  if (PIN) performance.now = () => (pinned >= 0 ? pinned : realNow());

  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");

  console.log(`\n## ${label}\n`);
  console.log(`${WARM} warm frames, then ${FRAMES} measured, per track; a lap at ${SPEED} u/s; sampling every ${INTERVAL} bytes; clock ${PIN ? "pinned while a frame draws" : "real"}${RENDERER ? "; RENDERER.FRAME (a pack of six, two sliding, rivets, mines, a blast every 30 frames)" : marks ? "; WITH TRACK MARKS (a scorch every 30 frames, a tyre mark every other frame)" : ""}${NO_INLINE ? "; INLINING OFF" : ""}.`);
  for (const id of TRACKS) {
    const track = trackById(id);
    // The lap, worked out before: the loop itself hands over numbers that exist already.
    const lap = Math.ceil((track.length / SPEED) * 60);
    const xs = new Float64Array(lap), ys = new Float64Array(lap), hs = new Float64Array(lap);
    const ox = new Int32Array(lap), oy = new Int32Array(lap);
    for (let i = 0; i < lap; i++) {
      const p = pointAt(track, (i * SPEED) / 60);
      xs[i] = p.x;
      ys[i] = p.y;
      hs[i] = p.h;
      ox[i] = Math.round(p.x * ZOOM) - VIEW_W / 2;
      oy[i] = Math.round(p.y * ZOOM) - VIEW_H / 2;
    }
    let frameNo = 0;
    let run: (n: number) => void;
    if (Renderer) {
      // A race's frame: the pack one behind the other, the last two turned against their way
      // (they slide: tyre marks), rivets flying, mines lying, a mine going off every 30 frames.
      const r = new Renderer(fakeCanvas(), track);
      // What main.ts tells the actors of the own car before each frame (a build that is told): car 0, driving straight.
      const ownSlide = ((await load("client/gfx/actors.ts")) as { ownSlide?: (car: unknown) => void }).ownSlide ?? null;
      const own = { vx: 0, vy: 0, h: 0 };
      const cars = COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, hp: i === 3 ? 0.3 : 1 }));
      const fx = {
        shots: [0, 1, 2, 3].map(() => ({ x: 0, y: 0, vx: 300, vy: 40 })),
        mines: [0, 1, 2].map((i) => ({ x: 0, y: 0, armed: i > 0 })),
        sparks: [{ x: 0, y: 0, age: 0, blast: true }, { x: 0, y: 0, age: 0, blast: false }],
        nShots: 4,
        nSparks: 2,
      };
      const times = new Float64Array(1);
      run = (n: number): void => {
        for (let i = 0; i < n; i++, frameNo++) {
          const k = frameNo % lap;
          // Each lap in a lane of its own, so that its tyre marks fall on ground not yet marked.
          const lane = (((frameNo / lap) | 0) * 13) % 80 - 40;
          for (let c = 0; c < cars.length; c++) {
            const j = (k + lap - c * 9) % lap; // 9 frames apart: about two car lengths
            cars[c].x = xs[j] - Math.sin(hs[j]) * lane;
            cars[c].y = ys[j] + Math.cos(hs[j]) * lane;
            cars[c].h = c >= 4 ? hs[j] + 0.5 : hs[j];
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
          // A blast where car 2 was when it began; its eight frames, then the next.
          const began = frameNo - (frameNo % 30);
          const b = ((began % lap) + lap - 18) % lap;
          fx.sparks[0].x = xs[b] - Math.sin(hs[b]) * lane;
          fx.sparks[0].y = ys[b] + Math.cos(hs[b]) * lane;
          fx.sparks[0].age = (frameNo % 30) / 8;
          fx.nSparks = frameNo % 30 < 8 ? 2 : 0;
          fx.sparks[1].x = xs[k];
          fx.sparks[1].y = ys[k];
          fx.sparks[1].age = (frameNo % 16) / 16;
          times[0] = 10000 + frameNo * DT;
          if (PIN) pinned = times[0];
          r.follow(xs[k], ys[k], DT, false, "c0");
          if (ownSlide) {
            own.h = hs[k];
            own.vx = Math.cos(own.h) * SPEED;
            own.vy = Math.sin(own.h) * SPEED;
            ownSlide(own);
          }
          r.frame(cars, fx, null, times[0]);
          pinned = -1;
        }
      };
    } else {
      const w = new World(fakeCanvas().getContext(), track);
      const car = { id: "a", x: 0, y: 0, h: 0, color: "#e8552d", name: "a", me: true, wreck: false, ghost: false };
      const cars = [car];
      run = (n: number): void => {
        for (let i = 0; i < n; i++, frameNo++) {
          const k = frameNo % lap;
          car.x = xs[k];
          car.y = ys[k];
          car.h = hs[k];
          if (PIN) pinned = 10000 + frameNo * DT;
          if (marks) {
            // Each lap in a lane of its own, so that its marks fall on ground not yet marked
            // (a mark on marked ground changes nothing and uploads nothing).
            const M = marks.MARK;
            const lane = (((frameNo / lap) | 0) * 13) % 80 - 40;
            const cos = Math.cos(hs[k]), sin = Math.sin(hs[k]);
            if (frameNo % 30 === 0) {
              M[0] = xs[k] - sin * lane;
              M[1] = ys[k] + cos * lane;
              marks.scorch(track);
            } else if (frameNo % 2 === 0 && k >= 2) {
              // The two rear wheels' ways since the stamp before: 6 units either side of the car's.
              const c0 = Math.cos(hs[k - 2]), s0 = Math.sin(hs[k - 2]);
              M[0] = xs[k - 2] - s0 * (lane - 6);
              M[1] = ys[k - 2] + c0 * (lane - 6);
              M[2] = xs[k] - sin * (lane - 6);
              M[3] = ys[k] + cos * (lane - 6);
              M[4] = xs[k - 2] - s0 * (lane + 6);
              M[5] = ys[k - 2] + c0 * (lane + 6);
              M[6] = xs[k] - sin * (lane + 6);
              M[7] = ys[k] + cos * (lane + 6);
              marks.skid(track);
            }
          }
          w.aim(xs[k], ys[k], DT, false);
          w.draw(ox[k], oy[k], cars);
          pinned = -1;
        }
      };
    }
    run(WARM);
    const baked0 = worldStats.baked, units0 = worldStats.units;
    const made0 = markStats ? markStats.scorches + markStats.skids : 0, sent0 = markStats ? markStats.uploads : 0;
    await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const t0 = realNow();
    run(FRAMES);
    const ms = realNow() - t0;
    const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };

    // Charge every sampled allocation to the innermost function of the watched files on its stack.
    const charged = new Map<string, number>();
    let inside = 0, outside = 0;
    const walk = (node: ProfileNode, owner: string): void => {
      const f = node.callFrame;
      // The build's own files: under its client/ folder (a ref's temp folder may be reached by another name: no prefix test).
      const at = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
      const file = at < 0 ? "" : f.url.slice(at + 8);
      const mine = RENDERER ? file !== "" : file === "gfx/world.ts";
      const name = f.functionName || "(anonymous)";
      const here = mine ? `${RENDERER ? `${file} ` : ""}${name}${lineOf(file, name)}` : owner;
      if (node.selfSize > 0) {
        if (here) {
          const key = mine ? here : `${here} > ${name}`;
          charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
          inside += node.selfSize;
        } else outside += node.selfSize;
      }
      for (const c of node.children ?? []) walk(c, here);
    };
    walk(profile.head, "");
    const rows = [...charged].sort((a, b) => b[1] - a[1]);
    const made = markStats ? `, ${markStats.scorches + markStats.skids - made0} track marks made (${markStats.uploads - sent0} rectangles uploaded)` : "";
    console.log(`\n**${id}**: ${worldStats.baked - baked0} tiles baked in the ${FRAMES} frames${made} (${((worldStats.units - units0) / FRAMES).toFixed(0)} cost units a frame, ${(ms / FRAMES).toFixed(3)} ms a frame here). ${RENDERER ? "client/" : "world.ts"}: **${(inside / FRAMES).toFixed(1)} bytes/frame**; outside (the probe's loop, Node): ${(outside / FRAMES).toFixed(1)}.\n`);
    if (rows.length) {
      console.log(`| bytes/frame | charged to (${RENDERER ? "file " : "world.ts "}function:line > built-in) |`);
      console.log("|---:|---|");
      for (const [key, bytes] of rows.slice(0, TOP)) console.log(`| ${(bytes / FRAMES).toFixed(1)} | ${key} |`);
      if (rows.length > TOP) console.log(`| ${(rows.slice(TOP).reduce((s, r) => s + r[1], 0) / FRAMES).toFixed(1)} | (${rows.length - TOP} more) |`);
    }
  }
  session.disconnect();
}

/** Math.hypot against the sum world.ts spells out in its place: the same bits? */
function hypotCheck(): void {
  const f = new Float64Array(1), u = new BigUint64Array(f.buffer);
  const bits = (x: number): bigint => {
    f[0] = x;
    return u[0];
  };
  const spelled = (a: number, b: number): number => {
    const x = Math.abs(a), y = Math.abs(b), m = x > y ? x : y;
    return m === 0 ? 0 : Math.sqrt((x / m) * (x / m) + (y / m) * (y / m)) * m;
  };
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let n = 0, bad = 0;
  const check = (a: number, b: number): void => {
    n++;
    if (bits(Math.hypot(a, b)) !== bits(spelled(a, b)) && bad++ < 5) console.log(`  differ: hypot(${a}, ${b}) = ${Math.hypot(a, b)}, spelled out ${spelled(a, b)}`);
  };
  for (let i = 0; i < 20_000_000; i++) {
    const k = i % 5;
    // Pixel offsets as the stains, the oil, the junk and the pits have them; a wide range; whole numbers and zeros.
    if (k === 0) check((rnd() - 0.5) * 600, (rnd() - 0.5) * 600 * 1.4);
    else if (k === 1) check(Math.floor(rnd() * 600) + 0.5 - rnd() * 600, (Math.floor(rnd() * 600) + 0.5 - rnd() * 600) * 1.5);
    else if (k === 2) check(Math.floor(rnd() * 272) + 0.5 - rnd() * 272, Math.floor(rnd() * 272) + 0.5 - rnd() * 272);
    else if (k === 3) check((rnd() - 0.5) * 10 ** Math.floor(rnd() * 40 - 20), (rnd() - 0.5) * 10 ** Math.floor(rnd() * 40 - 20));
    else check(Math.floor(rnd() * 40) - 20, Math.floor(rnd() * 40) - 20);
  }
  for (const [a, b] of [[0, 0], [-0, 0], [0, -0], [1, 0], [0, -3], [3, 4], [-3, 4], [5e-324, 5e-324], [1e308, 1e308], [1e-200, 1e200]]) check(a, b);
  console.log(`Math.hypot against the spelled-out sum: ${n} pairs, ${bad} differ (Node ${process.version}, V8 ${process.versions.v8}).`);
  if (bad) process.exitCode = 1;
}

// ---- main --------------------------------------------------------------------------------

if (args.includes("--hypot")) {
  hypotCheck();
} else if (args.includes("--child")) {
  await measure(args[args.indexOf("--child") + 1], args[args.indexOf("--child") + 2]);
} else {
  const refs: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
  const builds: { label: string; root: string; temp: boolean }[] = [];
  for (const ref of refs) {
    const dir = mkdtempSync(join(tmpdir(), "bake-alloc-"));
    const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
    builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
  }
  if (!args.includes("--only-refs")) builds.push({ label: "working tree", root: HERE, temp: false });
  console.log(`# Bake allocation probe (Node ${process.version})`);
  try {
    for (const b of builds) {
      // The same script again, in a process of its own, under the same loader.
      const flags = NO_INLINE ? ["--no-turbo-inlining", "--no-maglev-inlining"] : [];
      execFileSync(process.execPath, [...flags, ...process.execArgv, fileURLToPath(import.meta.url), ...args, "--child", b.root, b.label], { cwd: HERE, stdio: "inherit" });
    }
  } finally {
    for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
  }
}
