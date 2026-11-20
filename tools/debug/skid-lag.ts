// Tyre marks and the connection: does the own car leave the same tyre marks on a slow link
// as on a fast one, and the same as another player's screen shows for it?
// (client/gfx/actors.ts, "Tyre marks".)
//
//   npx tsx tools/debug/skid-lag.ts                  this working tree: the drive at lag 0 and at lag 150 ± 40
//   npx tsx tools/debug/skid-lag.ts --ref f7ead2b    a git ref beside it (its client/ and shared/ are
//                                                    unpacked into a temp folder); any number of refs
//   --only-refs    the refs alone                    --seconds 60   race time driven per run
//   --runs 3       runs per build and link           --lag 150 --jitter 40   the slow link
//   --hits 1800    units driven between two spin-outs (0 = none)
//   --flicks 1100  units driven between two flicks of the wheel (0 = none)
//   --track rust-bowl
//   --detail       a line per stamp of the first run of each kind (the two slides, the correction left)
//
// No browser. Each run is a process of its own: the real server (this working tree's, in
// process, on a port of its own), the real client netcode (client/game.ts over client/net.ts
// with its lag simulation) and the real Renderer on a canvas that draws nothing. The frame
// loop is client/main.ts's: fixed steps at 60 Hz, then a draw with the own car's pose between
// the last two steps, and before it what main.ts tells the actors of the own car (ownSlide,
// in a build that has it).
//
// The drive is the same every time, and it reads the predicted car as a player reads the
// screen: flat out, steering at a point ahead on the centreline; every `flicks` units a flick
// of the wheel (full lock for a quarter of a second, to one side and the other in turn: the
// car slides, and slides again as it is caught). Every `hits` units driven the server does to
// the car what a mine does (shared/weapons.ts spinOut, no damage): the one thing in a race the
// prediction cannot know, so the snapshot that tells of it moves the predicted car, by the
// more the slower the link.
//
// A second player on a link without lag retires as the race starts and watches (a second
// copy of the client, as a second browser has): their view draws the car as any view draws
// another player's car, from the server's snapshots. The tyre marks that view makes are what
// the car's driving is worth on anybody else's screen.
//
// Counted per run:
// - stamps, own view: tyre marks made (world.ts markStats.skids) by the view of the car's own
//   player, on the link under test;
// - stamps, the onlooker's view: those the watching view made for the same car;
// - own, with no slide: own stamps made in a frame in which the predicted car's speed sideways
//   (shared/physics.ts: its velocity across its heading) was under 60 % of the threshold. A
//   mark with no slide under it. (A build that marks by that speed has none by its making.)
// - the frames in which the own car moved sideways on screen faster than the threshold, and
//   those in which the predicted car slid that fast;
// - corrections: acknowledged inputs at which the server's car was not where the prediction
//   had it (over 0.05 units), and how far; the largest correction left to work off on screen;
// - frames drawn, and display frames the loop came too late for.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const refs: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const STEP_MS = 1000 / 60;
const MAX_CATCH_UP = 5;
const SKID = 105; // actors.ts: units/s sideways
const FLICK_STEPS = 15; // a flick of the wheel: full lock for this many steps
const IDLE = { throttle: 0, steer: 0, fire: false, mine: false };
const CORRECTED = 0.05; // a snapshot this far (units) from the prediction moved the car; under it is the snapshot's rounding

interface Job { root: string; watchRoot: string; label: string; lag: number; jitter: number; seconds: number; track: string; seed: number; detail: boolean; hits: number; flicks: number }
interface Result {
  frames: number;
  late: number; // display frames missed (the loop came too late for them)
  raceSeconds: number;
  stamps: number;
  seen: number; // stamps the onlooker's view made for the same car
  noSlide: number; // stamps with the predicted car's sideways speed under 60 % of the threshold
  drawnOver: number; // frames: the drawn car moved sideways faster than the threshold
  physOver: number; // frames: the predicted car slid sideways faster than the threshold
  corrections: number;
  corrMedian: number;
  corrP95: number;
  corrMax: number;
  smoothMax: number;
  lapsDone: number;
  top: number; // top speed reached, units/s
  hits: number; // spin-outs done to the car
  lines: string[];
}

// ---- one run (a process of its own) -------------------------------------------------------

/** A canvas that draws nothing. */
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

async function runOne(job: Job): Promise<Result> {
  // The same dice every run: the link's jitter (client/net.ts) draws from Math.random.
  let seed = job.seed >>> 0;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => fakeCanvas() };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  const load = (root: string, file: string) => import(pathToFileURL(join(root, file)).href);
  const { startServer } = await load(HERE, "server/index.ts");
  const { Game } = await load(job.root, "client/game.ts");
  const { connectWs } = await load(job.root, "client/net.ts");
  const { Renderer } = await load(job.root, "client/render.ts");
  const world = await load(job.root, "client/gfx/world.ts");
  const actors = await load(job.root, "client/gfx/actors.ts");
  const { pointAt, queryTrackNear } = await load(job.root, "shared/track.ts");
  const { angleDiff } = await load(job.root, "shared/physics.ts");
  const { spinOut } = await load(HERE, "shared/weapons.ts");
  const markStats = world.markStats as { skids: number };
  // What main.ts tells the actors of the own car before each frame, in a build that is told.
  const ownSlide = (actors as { ownSlide?: (car: unknown) => void }).ownSlide ?? null;

  const server = await startServer({ port: 0, vite: false, laps: 99, host: "127.0.0.1" });
  const tokens = new Map<string, string>();
  const game = new Game(() => connectWs(`ws://127.0.0.1:${server.port}/ws`, { lag: job.lag, jitter: job.jitter }), {
    get: (c: string) => tokens.get(c) ?? null,
    set: (c: string, t: string) => void tokens.set(c, t),
  });
  const errors: string[] = [];
  game.on.error = (msg: string) => errors.push(msg);
  // The onlooker: a second player on a link without lag, who retires as the race starts and
  // watches. Their view draws the car under test as any view draws another player's car, from
  // the server's snapshots; the tyre marks it makes are what that car's driving is worth.
  // (A second copy of the same client, as a second browser would have: its own tiles, its own marks.)
  const theirs = {
    Game: (await load(job.watchRoot, "client/game.ts")).Game,
    connectWs: (await load(job.watchRoot, "client/net.ts")).connectWs,
    Renderer: (await load(job.watchRoot, "client/render.ts")).Renderer,
    world: await load(job.watchRoot, "client/gfx/world.ts"),
  };
  const watch = new theirs.Game(() => theirs.connectWs(`ws://127.0.0.1:${server.port}/ws`), { get: () => null, set: () => {} });
  watch.on.error = (msg: string) => errors.push(`onlooker: ${msg}`);

  // The driver: flat out, steering at a point ahead on the centreline; every `flicks` units
  // driven it throws the wheel over for a quarter of a second, to one side and the other in turn.
  let drove = 0, nextFlick = job.flicks, flick = 0, flickSide = 1;
  const controls = () => {
    const c = game.car;
    if (!c || c.air > 0 || c.fall > 0 || c.wreck > 0) return { throttle: 1, steer: 0, fire: false, mine: false };
    const track = game.track;
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const v = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
    if (game.raceOn()) drove += v / 60;
    if (job.flicks > 0 && drove >= nextFlick) {
      nextFlick += job.flicks;
      flick = FLICK_STEPS;
      flickSide = -flickSide;
    }
    if (flick > 0) {
      flick--;
      return { throttle: 1, steer: flickSide, fire: false, mine: false };
    }
    const t = pointAt(track, q.s + 55 + v * 0.3);
    const steer = Math.max(-1, Math.min(1, angleDiff(c.h, Math.atan2(t.y - c.y, t.x - c.x)) * 2.2));
    return { throttle: 1, steer, fire: false, mine: false };
  };

  let renderer = new Renderer(fakeCanvas(), game.track);
  let rendererTrack = game.track;
  let marksRace = game.raceId;
  let hadTarget = false;
  let watchRenderer = new theirs.Renderer(fakeCanvas(), watch.track);
  let watchTrack = watch.track;
  let watchRace = watch.raceId;
  let watchHad = false;
  const fx = { shots: [], mines: [], sparks: [], nShots: 0, nSparks: 0 };
  const res: Result = { frames: 0, late: 0, raceSeconds: 0, stamps: 0, seen: 0, noSlide: 0, drawnOver: 0, physOver: 0, corrections: 0, corrMedian: 0, corrP95: 0, corrMax: 0, smoothMax: 0, lapsDone: 0, top: 0, hits: 0, lines: [] };
  let raceSteps = 0;
  let px = NaN, py = NaN, pnow = NaN; // the own car as drawn the frame before

  /** main.ts draw(), the own car alone. */
  const draw = (alpha: number, elapsed: number, measured: boolean): void => {
    if (game.track !== rendererTrack) {
      rendererTrack = game.track;
      renderer = new Renderer(fakeCanvas(), rendererTrack);
      hadTarget = false;
    }
    if (game.raceId !== marksRace) {
      marksRace = game.raceId;
      world.clearMarks();
    }
    const own = game.ownPose(alpha);
    const car = game.car;
    const cars = own && car ? [{ id: own.id, x: own.x, y: own.y, h: own.h, me: true, color: "#e8552d", name: "Skid", wreck: car.wreck > 0, ghost: !!own.ghost, height: own.height, falling: own.falling, hp: 1 }] : [];
    if (own && car) {
      renderer.follow(own.x + car.vx * 0.28, own.y + car.vy * 0.28, elapsed, !hadTarget, own.id);
      hadTarget = true;
    } else hadTarget = false;
    const before = markStats.skids;
    const now = performance.now();
    if (ownSlide) ownSlide(car);
    renderer.frame(cars, fx, null, now);
    const made = markStats.skids - before;
    if (!own || !car) {
      px = NaN;
      return;
    }
    // The two slides, as speeds sideways (units/s): the drawn car's step since the frame
    // before across its drawn heading (what f7ead2b's actors measure), and the predicted
    // car's velocity across its heading (the physics).
    const dt = (now - pnow) / 1000;
    const drawn = dt > 0 && dt < 0.1 ? ((own.y - py) * Math.cos(own.h) - (own.x - px) * Math.sin(own.h)) / dt : 0;
    const phys = car.vy * Math.cos(car.h) - car.vx * Math.sin(car.h);
    px = own.x;
    py = own.y;
    pnow = now;
    const sm = Math.sqrt(game.smooth.x * game.smooth.x + game.smooth.y * game.smooth.y);
    if (measured) {
      res.frames++;
      res.stamps += made;
      const ground = car.air === 0 && car.fall === 0 && car.wreck === 0;
      if (ground && Math.abs(drawn) > SKID) res.drawnOver++;
      if (ground && Math.abs(phys) > SKID) res.physOver++;
      if (made && Math.abs(phys) < 0.6 * SKID) res.noSlide += made;
      if (sm > res.smoothMax) res.smoothMax = sm;
      const v = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
      if (v > res.top) res.top = v;
      if (made && job.detail && res.lines.length < 400) {
        res.lines.push(`  t ${(raceSteps / 60).toFixed(2).padStart(6)} s  sideways on screen ${drawn.toFixed(0).padStart(5)}  in the physics ${phys.toFixed(0).padStart(5)}  correction left ${sm.toFixed(2).padStart(5)}  speed ${v.toFixed(0)}`);
      }
    }
  };

  /** main.ts draw() for the onlooker: the car under test alone, the view following it. */
  const drawWatch = (alpha: number, elapsed: number, measured: boolean, now: number): void => {
    if (watch.track !== watchTrack) {
      watchTrack = watch.track;
      watchRenderer = new theirs.Renderer(fakeCanvas(), watchTrack);
      watchHad = false;
    }
    if (watch.raceId !== watchRace) {
      watchRace = watch.raceId;
      theirs.world.clearMarks();
    }
    const others = watch.otherPoses();
    const drawn = watch.contact.blend(others, watch.car, watch.pending.length - 1 + alpha, elapsed) as { id: string; x: number; y: number; h: number; height?: number; falling?: number; ghost?: boolean }[];
    const o = drawn.find((d) => d.id === game.you);
    const snap = o ? watch.latest?.cars.get(o.id) : null;
    const cars = o ? [{ id: o.id, x: o.x, y: o.y, h: o.h, me: false, color: "#e8552d", name: "Skid", wreck: !!snap?.wreck, ghost: !!(o.ghost || snap?.ghost), height: o.height, falling: o.falling, hp: 1 }] : [];
    if (o) {
      watchRenderer.follow(o.x, o.y, elapsed, !watchHad, o.id);
      watchHad = true;
    } else watchHad = false;
    const before = theirs.world.markStats.skids;
    watchRenderer.frame(cars, fx, null, now); // the frame's own time: the other view's drawing is not on this one's clock
    if (measured) res.seen += theirs.world.markStats.skids - before;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok: () => boolean, what: string, ms = 15000): Promise<void> => {
    const t0 = performance.now();
    while (!ok()) {
      if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${errors.length ? ` (${errors.join("; ")})` : ""}`);
      await sleep(5);
    }
  };

  // The frame loop, as main.ts frame(): a frame every 1/60 s by the clock (the timer brings it
  // near, the last stretch is waited out; a frame that comes too late for its turn takes the
  // next one, as on a display), fixed steps, then the draw.
  let stop = false;
  let failed = "";
  let last = performance.now();
  let acc = 0;
  const t0 = last;
  let frameNo = 0;
  const done = new Promise<void>((finish) => {
    const frame = (): void => {
      if (stop) return finish();
      const now = performance.now();
      const elapsed = now - last;
      last = now;
      acc += elapsed;
      let steps = 0;
      const measured = raceSteps > 0 && raceSteps < job.seconds * 60;
      while (acc >= STEP_MS && steps < MAX_CATCH_UP) {
        game.step(controls(), STEP_MS);
        if (game.car && game.raceOn()) raceSteps++;
        watch.step(IDLE, STEP_MS);
        acc -= STEP_MS;
        steps++;
      }
      if (acc >= STEP_MS) acc = 0;
      draw(acc / STEP_MS, elapsed, measured);
      if (watch.canRetire()) watch.retire();
      drawWatch(acc / STEP_MS, elapsed, measured, now);
      if (raceSteps >= job.seconds * 60) stop = true;
      if (now - t0 > (job.seconds + 40) * 1000) {
        failed = `the race did not get to ${job.seconds} s (phase ${game.phase}, ${raceSteps} steps raced${errors.length ? `; ${errors.join("; ")}` : ""})`;
        stop = true;
      }
      const next = Math.floor((performance.now() - t0) / STEP_MS) + 1;
      if (next > frameNo + 1) res.late += next - frameNo - 1;
      frameNo = next;
      const due = t0 + frameNo * STEP_MS;
      const wait = (): void => {
        const left = due - performance.now();
        if (left > 2.5) setTimeout(wait, left - 2);
        else if (left > 0) setImmediate(wait);
        else frame();
      };
      setImmediate(wait);
    };
    frame();
  });

  try {
    game.create("Skid");
    await until(() => !!game.you && !!game.code, "the room");
    if (job.track && game.track.def.id !== job.track) {
      game.pickTrack(job.track);
      await until(() => game.track.def.id === job.track, `the track ${job.track}`);
    }
    // What a mine does to a car (shared/weapons.ts spinOut: turned 1.6 rad, 30 % of its speed
    // kept), done to the server's car after the tick in which it has driven `hits` units more;
    // the mine to its left and to its right in turn. No damage: the car is never wrecked.
    const room = [...server.rooms.rooms.values()][0];
    const tick = room.tick.bind(room);
    let driven = 0, nextHit = job.hits, hitNo = 0;
    room.tick = (t: number, now: number): void => {
      tick(t, now);
      const c = [...room.players.values()][0]?.car;
      if (!c || job.hits <= 0) return;
      driven += Math.sqrt(c.vx * c.vx + c.vy * c.vy) / 60;
      if (driven < nextHit || c.air > 0 || c.fall > 0 || c.wreck > 0) return;
      nextHit += job.hits;
      const side = hitNo++ & 1 ? 6 : -6;
      spinOut(c, c.x - Math.sin(c.h) * side, c.y + Math.cos(c.h) * side);
      res.hits++;
    };
    watch.join(game.code, "Watch");
    await until(() => !!watch.you, "the onlooker");
    watch.setReady(true);
    await until(() => game.waitingFor() === 0, "the onlooker to be ready");
    game.start();
    await done;
    if (failed) throw new Error(failed);
  } finally {
    stop = true;
  }
  const errs = (game.recErrors as number[]).filter((e) => e > CORRECTED).sort((a, b) => a - b);
  res.corrections = errs.length;
  res.corrMedian = errs.length ? errs[errs.length >> 1] : 0;
  res.corrP95 = errs.length ? errs[Math.floor(errs.length * 0.95)] : 0;
  res.corrMax = errs.length ? errs[errs.length - 1] : 0;
  res.raceSeconds = raceSteps / 60;
  res.lapsDone = game.ownSnap()?.lap ?? 0;
  watch.leave();
  game.leave();
  await server.shutdown();
  return res;
}

// ---- all runs -----------------------------------------------------------------------------

function unpack(ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), "skid-lag-"));
  const tar = execFileSync("git", ["-C", HERE, "archive", ref, "client", "shared"], { maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return dir;
}

/** A copy of a build's client/ and shared/ (the onlooker's). */
function copy(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "skid-lag-"));
  execFileSync("cp", ["-R", join(root, "client"), join(root, "shared"), dir]);
  return dir;
}

function child(job: Job): Promise<Result> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--one", JSON.stringify(job)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (code !== 0 || !line) fail(new Error(`${job.label}, lag ${job.lag} ± ${job.jitter}: the run failed (exit ${code})\n${out}`));
      else done(JSON.parse(line.slice(7)) as Result);
    });
  });
}

async function main(): Promise<void> {
  if (args.includes("--one")) {
    const res = await runOne(JSON.parse(args[args.indexOf("--one") + 1]) as Job);
    console.log(`RESULT ${JSON.stringify(res)}`);
    process.exit(0);
  }
  const seconds = option("--seconds", 60), runs = option("--runs", 3);
  const lag = option("--lag", 150), jitter = option("--jitter", 40);
  const track = args.includes("--track") ? args[args.indexOf("--track") + 1] : "rust-bowl";
  const detail = args.includes("--detail");
  const hits = option("--hits", 1800), flicks = option("--flicks", 1100);
  const temps: string[] = [];
  const builds: { root: string; watchRoot: string; label: string }[] = [];
  for (const ref of refs) {
    const dir = unpack(ref), dir2 = unpack(ref);
    temps.push(dir, dir2);
    builds.push({ root: dir, watchRoot: dir2, label: `${ref} (${execFileSync("git", ["-C", HERE, "rev-parse", "--short", ref]).toString().trim()})` });
  }
  if (!args.includes("--only-refs")) {
    const dir2 = copy(HERE);
    temps.push(dir2);
    builds.push({ root: HERE, watchRoot: dir2, label: "working tree" });
  }
  const links = [{ lag: 0, jitter: 0 }, { lag, jitter }];
  console.log(`The drive on ${track}: flat out along the centreline, ${flicks > 0 ? `a flick of the wheel every ${flicks} units` : "no flicks"}, ${hits > 0 ? `a spin-out (as a mine's) every ${hits} units` : "no spin-outs"}. ${seconds} s of racing per run, ${runs} run(s) per build and link; every run a process of its own, those of a round side by side.`);
  try {
    const all = new Map<string, Result[]>();
    for (let r = 0; r < runs; r++) {
      const jobs: Job[] = [];
      for (const b of builds) for (const l of links) jobs.push({ root: b.root, watchRoot: b.watchRoot, label: b.label, lag: l.lag, jitter: l.jitter, seconds, track, seed: 1000 + r, detail: detail && r === 0, hits, flicks });
      const results = await Promise.all(jobs.map(child));
      jobs.forEach((j, i) => {
        const key = `${j.label}|${j.lag}|${j.jitter}`;
        if (!all.has(key)) all.set(key, []);
        all.get(key)!.push(results[i]);
      });
    }
    for (const b of builds) {
      console.log(`\n## ${b.label}\n`);
      console.log("| link | run | stamps, own view | stamps, the onlooker's view | own, with no slide | frames drawn sideways over 105 | frames sliding over 105 (physics) | corrections | how far: median / p95 / max | correction left, max | spin-outs | laps | top speed | frames (late) |");
      console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
      for (const l of links) {
        const rs = all.get(`${b.label}|${l.lag}|${l.jitter}`)!;
        rs.forEach((x, i) => {
          console.log(`| lag ${l.lag} ± ${l.jitter} | ${i + 1} | ${x.stamps} | ${x.seen} | ${x.noSlide} | ${x.drawnOver} | ${x.physOver} | ${x.corrections} | ${x.corrMedian.toFixed(2)} / ${x.corrP95.toFixed(2)} / ${x.corrMax.toFixed(2)} | ${x.smoothMax.toFixed(2)} | ${x.hits} | ${x.lapsDone} | ${x.top.toFixed(0)} | ${x.frames} (${x.late}) |`);
        });
      }
      for (const l of links) {
        const rs = all.get(`${b.label}|${l.lag}|${l.jitter}`)!;
        const mean = (f: (x: Result) => number) => rs.reduce((s, x) => s + f(x), 0) / rs.length;
        console.log(`\nlag ${l.lag} ± ${l.jitter}: own view ${mean((x) => x.stamps).toFixed(1)} stamps a run (${rs.map((x) => x.stamps).join(", ")}), ${mean((x) => x.noSlide).toFixed(1)} of them with no slide in the physics; the onlooker's view of the same car ${mean((x) => x.seen).toFixed(1)} (${rs.map((x) => x.seen).join(", ")}).`);
        if (detail && rs[0].lines.length) console.log(`the stamps of run 1:\n${rs[0].lines.join("\n")}`);
      }
    }
  } finally {
    for (const d of temps) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
}

await main();
