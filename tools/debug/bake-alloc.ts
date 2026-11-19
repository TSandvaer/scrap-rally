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
// its stack, with the built-in it happened in when that is not the function itself
// ("yard > hypot": the number Math.hypot hands back to yard). "outside world.ts" is the
// probe's own loop and Node. Numbers under about 1 byte per frame are the sampling's noise.
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
const NO_INLINE = args.includes("--no-inline");
const ONLY = args.includes("--track") ? args[args.indexOf("--track") + 1] : "";
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"].filter((t) => !ONLY || t === ONLY);
const SPEED = 430;
const DT = 1000 / 60;

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

/** One build, in this process: drive the laps, print the tables. */
async function measure(root: string, label: string): Promise<void> {
  const fakeCtx = () => ({ fillStyle: "", globalAlpha: 1, drawImage() {}, fillRect() {}, putImageData() {}, getContextAttributes: () => ({ willReadFrequently: true }) });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const ctx = fakeCtx();
      return { width: 0, height: 0, getContext: () => ctx };
    },
  };
  const load = (file: string) => import(pathToFileURL(join(root, file)).href);
  const world = await load("client/gfx/world.ts");
  const { trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const { World, worldStats, ZOOM, VIEW_W, VIEW_H } = world;
  const source = readFileSync(join(root, "client/gfx/world.ts"), "utf8").split("\n");
  const lineOf = (fn: string): string => {
    const at = source.findIndex((l) => new RegExp(`^(export )?function ${fn}\\(|^  (private )?${fn}\\(`).test(l));
    return at < 0 ? "" : `:${at + 1}`;
  };
  // The clock: real, or standing still while a frame draws (--pin).
  const realNow = performance.now.bind(performance);
  let pinned = -1;
  if (PIN) performance.now = () => (pinned >= 0 ? pinned : realNow());

  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");

  console.log(`\n## ${label}\n`);
  console.log(`${WARM} warm frames, then ${FRAMES} measured, per track; a lap at ${SPEED} u/s; sampling every ${INTERVAL} bytes; clock ${PIN ? "pinned while a frame draws" : "real"}${NO_INLINE ? "; INLINING OFF" : ""}.`);
  for (const id of TRACKS) {
    const track = trackById(id);
    const w = new World(fakeCtx(), track);
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
    const car = { id: "a", x: 0, y: 0, h: 0, color: "#e8552d", name: "a", me: true, wreck: false, ghost: false };
    const cars = [car];
    let frameNo = 0;
    const run = (n: number): void => {
      for (let i = 0; i < n; i++, frameNo++) {
        const k = frameNo % lap;
        car.x = xs[k];
        car.y = ys[k];
        car.h = hs[k];
        if (PIN) pinned = 10000 + frameNo * DT;
        w.aim(xs[k], ys[k], DT, false);
        w.draw(ox[k], oy[k], cars);
        pinned = -1;
      }
    };
    run(WARM);
    const baked0 = worldStats.baked, units0 = worldStats.units;
    await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const t0 = realNow();
    run(FRAMES);
    const ms = realNow() - t0;
    const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };

    // Charge every sampled allocation to the innermost world.ts function on its stack.
    const charged = new Map<string, number>();
    let inWorld = 0, outside = 0;
    const walk = (node: ProfileNode, owner: string): void => {
      const f = node.callFrame;
      const mine = f.url.endsWith("client/gfx/world.ts");
      const name = f.functionName || "(anonymous)";
      const here = mine ? `${name}${lineOf(name)}` : owner;
      if (node.selfSize > 0) {
        if (here) {
          const key = mine ? here : `${here} > ${name}`;
          charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
          inWorld += node.selfSize;
        } else outside += node.selfSize;
      }
      for (const c of node.children ?? []) walk(c, here);
    };
    walk(profile.head, "");
    const rows = [...charged].sort((a, b) => b[1] - a[1]);
    console.log(`\n**${id}**: ${worldStats.baked - baked0} tiles baked in the ${FRAMES} frames (${((worldStats.units - units0) / FRAMES).toFixed(0)} cost units a frame, ${(ms / FRAMES).toFixed(3)} ms a frame here). world.ts: **${(inWorld / FRAMES).toFixed(1)} bytes/frame**; outside world.ts (the probe's loop, Node): ${(outside / FRAMES).toFixed(1)}.\n`);
    if (rows.length) {
      console.log("| bytes/frame | charged to (world.ts function:line > built-in) |");
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
