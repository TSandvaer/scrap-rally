// The catch-up mapping of client/main.ts (its "catch-up cues" block: the M4-FX fields CarView.draft
// and .boost, WorldFx.cells and .nCells, HudView.draft and .boost filled from the M4-DRAFT and
// M4-CELLS state), rule 1: does it make anything a frame? V8's sampling heap profiler, no browser.
//
//   npx tsx tools/debug/catch-alloc.ts                  Rust Bowl, Crusher Run and Overpass Knot in turn
//   --track <id>     one track only
//   --bots 3         Normal server bots in the room with the own car
//   --lane 30        the own car's lane (the autopilot's ?lane=; 30 takes the Rust Bowl kerb cells at
//                    lat 58 and the Crusher Run air cell at 34)
//   --warm 6000      frames driven before the measurement (the optimising compiler has to be done),
//                    and at least until a cell has been taken plus --settle 3000 more: the first
//                    taken cell gives the block's code a fraction where it had 0, and V8 compiles it
//                    again (meanwhile it boxes those fractions, ~16 B a frame for a few thousand
//                    frames, once a page load); the measurement is of the code after that.
//                    --settle -1: no wait (--warm 0 --settle -1 --chunks 12: from the race's first frame)
//   --frames 9000    frames measured
//   --interval 128   the profiler's mean sampling interval, bytes
//   --chunks 1       the measured frames in this many stretches, a line each (how long a cold start
//                    allocates: --warm 0 --settle 0 --chunks 10)
//
// What is driven: the real server (server/room.ts Rooms, on a clock of its own) and the real
// client Game over a link without lag, a race of Normal server bots and the own car driven by the
// autopilot (scripts/bot-ai.ts, the ?autopilot=1 driver: it goes for cells and drafts as a Normal
// bot does). Every frame steps the server and the client one tick, then calls main.ts's block as
// draw() and hudView() do: syncDrafts() once, catchCar() for every car's view, catchHud(),
// catchCells(). The block is cut out of client/main.ts as it is (from "// ---- catch-up cues" to
// "// ---- end of the catch-up cues") and loaded by itself with `game` bound to the probe's Game.
// The views are kept by the probe (main.ts makes them a frame, as before; not measured here).
//
// The probe's frame function is never optimised (V8's %NeverOptimizeFunction): an optimised
// caller takes in the functions it calls, and the profiler then charges their allocations to the
// caller, out of sight (seen: an array kept a call charged 3.7 B instead of 176). So the block's
// functions run as V8 compiles them by themselves, with what they call inside them.
//
// What is read:
// - a control first, called the same way: a function of the same loaded module that makes an
//   object of four fields (56 bytes) a call; exit code 1 unless about that is seen, for then a 0
//   below would mean nothing;
// - every allocation sampled while the measured frames ran whose stack goes through a function of
//   the block (what the block calls counts too, e.g. Game.cellViews and draftsFor), in bytes per
//   frame, by the innermost function; under about 1 byte per frame is the sampling's noise;
// - what the mapping showed meanwhile, so the numbers are of a block that had work to do: frames
//   with the own car and other cars in a slipstream and boosted, cells taken, blinking back, in
//   the air;
// - the contract (render.ts CellView): air a boolean, state 0 when there and in (0, 1] when taken,
//   never rising while it waits; nCells = the track's cells. Exit code 1 if a frame breaks it.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { Rooms, type Session as RoomSession } from "../../server/room";
import { BotDriver } from "../../scripts/bot-ai";
import { Game } from "../../client/game";
import type { Transport } from "../../client/net";
import type { CarView, CellView, HudView } from "../../client/render";
import { decode, encode, type CarSnap, type ClientMsg, type ServerMsg } from "../../shared/protocol";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const WARM = option("--warm", 6000);
const FRAMES = option("--frames", 9000);
const BOTS = option("--bots", 3);
const LANE = option("--lane", 30);
const SETTLE = option("--settle", 3000);
const CHUNKS = option("--chunks", 1);
const INTERVAL = option("--interval", 128);
const ONLY = args.includes("--track") ? args[args.indexOf("--track") + 1] : "";
const TRACKS = ["rust-bowl", "crusher-run", "overpass-knot"].filter((t) => !ONLY || t === ONLY);
const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DT = 1000 / 60;
const START = "// ---- catch-up cues";
const END = "// ---- end of the catch-up cues";
const CONTROL_BYTES = 56; // the control's object: a header of 24 bytes and four fields of 8

setFlagsFromString("--allow-natives-syntax");
const neverOptimize = new Function("f", "%NeverOptimizeFunction(f); return f;") as <F>(f: F) => F;

interface Block {
  bind(g: Game): void;
  syncDrafts(): void;
  catchCar(v: CarView, s: CarSnap | undefined): void;
  catchHud(h: HudView): void;
  catchCells(): number;
  cellOut: CellView[];
  control(i: number): object;
}

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

/** Is a profile node's url the loaded block's file? tsx loads it as CommonJS: the profiler names it by its real path. */
function isBlock(nodeUrl: string, real: string): boolean {
  return nodeUrl === real || nodeUrl === pathToFileURL(real).href;
}

/** main.ts's block, cut out and loaded by itself (a temp module importing what main.ts imports for it). */
async function loadBlock(dir: string): Promise<{ block: Block; real: string; lines: number }> {
  const src = readFileSync(join(HERE, "client/main.ts"), "utf8");
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`client/main.ts: no "${START}" ... "${END}" block`);
  const body = src.slice(a, b);
  const at = (f: string) => JSON.stringify(join(HERE, f));
  const file = join(dir, "catch-block.ts");
  writeFileSync(
    file,
    [
      `import { CELL_RESPAWN, draftsFor, type DraftEntry } from ${at("shared/catchup.ts")};`,
      `import type { CarSnap } from ${at("shared/protocol.ts")};`,
      `import type { CarView, CellView, HudView } from ${at("client/render.ts")};`,
      `import type { Game } from ${at("client/game.ts")};`,
      "let game!: Game;",
      "export function bind(g: Game): void { game = g; }",
      body,
      "export { syncDrafts, catchCar, catchHud, catchCells, cellOut };",
      "/** The probe's control, not main.ts: an object of four fields a call, so the charging is seen to work. */",
      "export function control(i: number): object { return { a: i, b: i + 1, c: i + 2, d: i + 3 }; }",
      "",
    ].join("\n"),
  );
  const block = (await import(pathToFileURL(file).href)) as Block;
  return { block, real: realpathSync(file), lines: body.split("\n").length };
}

/** A client Game on the Rooms server over a link without lag (sim-test's laggedGame at 0 ms). */
function link(rooms: Rooms, clock: { now: number }): { game: Game; open(): void; down(): void } {
  const toClient: ServerMsg[] = [];
  const session: RoomSession = { conn: { send: (m) => void toClient.push(decode<ServerMsg>(encode(m))!), close() {} }, room: null, player: null };
  const tr: Transport = {
    send: (m) => rooms.onMessage(session, decode<ClientMsg>(encode(m)), clock.now),
    close() {},
    onOpen() {},
    onMessage() {},
    onClose() {},
  };
  const game = new Game(() => tr, { get: () => null, set() {} });
  return {
    game,
    open: () => tr.onOpen(),
    down: () => {
      while (toClient.length) tr.onMessage(toClient.shift()!);
    },
  };
}

/** Sample the allocations of `run`; the bytes whose stack goes through the block, by innermost function. */
async function sample(real: string, run: () => void): Promise<{ bytes: number; byFn: Map<string, number> }> {
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.collectGarbage");
  await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  run();
  const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };
  session.disconnect();
  const byFn = new Map<string, number>();
  let bytes = 0;
  const walk = (node: ProfileNode, under: boolean) => {
    const inBlock = under || isBlock(node.callFrame.url, real);
    if (inBlock && node.selfSize > 0) {
      const f = node.callFrame;
      const file = isBlock(f.url, real) ? "main.ts block" : f.url.replace(pathToFileURL(HERE).href + "/", "").replace(HERE + "/", "");
      const key = `${f.functionName || "(anonymous)"} (${file})`;
      byFn.set(key, (byFn.get(key) ?? 0) + node.selfSize);
      bytes += node.selfSize;
    }
    for (const c of node.children ?? []) walk(c, inBlock);
  };
  walk(profile.head, false);
  return { bytes, byFn };
}

interface Seen {
  ownDraft: number; // frames with the own car in a slipstream
  otherDraft: number; // car-frames with another car in one
  ownBoost: number; // frames with the own car boosted
  otherBoost: number; // car-frames with another car boosted
  hud: number; // frames with a HUD cue lit
  taken: number; // cells seen going from there to taken
  blinking: number; // frames with a taken cell in the last quarter of its wait
  air: number; // frames with an air cell taken
  bad: string[]; // contract breaks
}

async function runTrack(id: string, block: Block, real: string) {
  const realNow = performance.now.bind(performance);
  const clock = { now: 1_000_000 };
  performance.now = () => clock.now;
  try {
    const laps = Math.ceil((((60000 + FRAMES) / 60) * 430) / 9000) + 3; // plenty: the race outlasts the measurement
    const rooms = new Rooms(laps);
    const A = link(rooms, clock);
    const game = A.game;
    block.bind(game);
    const pilot = new BotDriver(game, LANE);
    pilot.weapons = false;
    const tick = (drive: boolean) => {
      clock.now += DT;
      rooms.step(clock.now);
      A.down();
      if (drive) game.step(pilot.controls(), DT);
    };
    game.create("Probe");
    A.open();
    for (let i = 0; i < 20; i++) tick(false);
    game.pickTrack(id);
    for (let i = 0; i < BOTS; i++) game.addBot("normal");
    for (let i = 0; i < 30; i++) tick(false);
    game.start();
    for (let i = 0; i < 60 * 30 && game.phase !== "racing"; i++) tick(true);
    if (game.phase !== "racing") throw new Error(`${id}: the race did not start (phase ${game.phase})`);

    // The views, kept by the probe (one per car, made before the measurement).
    const views = new Map<string, CarView>();
    for (const p of game.players) {
      views.set(p.id, { id: p.id, x: 0, y: 0, h: 0, me: p.id === game.you, color: "", name: "", wreck: false, ghost: false, hp: 1, draft: 0, boost: 0 });
    }
    const hud: HudView = { topLeft: [], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "", debug: [], hp: null, draft: 0, boost: 0 };
    const seen: Seen = { ownDraft: 0, otherDraft: 0, ownBoost: 0, otherBoost: 0, hud: 0, taken: 0, blinking: 0, air: 0, bad: [] };
    const was: number[] = [];
    let watch = false;
    let firstTaken = -1, frames = 0;
    // One frame: the tick, then the block as draw() and hudView() call it.
    const frame = neverOptimize(() => {
      tick(true);
      block.syncDrafts();
      const players = game.players;
      for (let i = 0; i < players.length; i++) {
        const v = views.get(players[i].id);
        if (!v) continue;
        block.catchCar(v, game.latest?.cars.get(v.id));
        if (watch) {
          if (v.draft! > 0) v.me ? seen.ownDraft++ : seen.otherDraft++;
          if (v.boost! > 0) v.me ? seen.ownBoost++ : seen.otherBoost++;
        }
      }
      if (game.car) block.catchHud(hud);
      const n = block.catchCells();
      frames++;
      if (firstTaken < 0) for (let i = 0; i < n; i++) if (block.cellOut[i].state > 0) firstTaken = frames;
      if (!watch) return;
      if (hud.draft! > 0 || hud.boost! > 0) seen.hud++;
      if (n !== game.track.cells.length && seen.bad.length < 5) seen.bad.push(`nCells ${n}, the track has ${game.track.cells.length}`);
      const out = block.cellOut;
      let blink = false, air = false;
      for (let i = 0; i < n; i++) {
        const c = out[i], prev = was[i] ?? 0;
        if ((typeof c.air !== "boolean" || !(c.state >= 0 && c.state <= 1) || (c.state > prev && prev > 0)) && seen.bad.length < 5) {
          seen.bad.push(`cell ${i}: air ${String(c.air)}, state ${c.state} after ${prev}`);
        }
        if (c.state > 0 && prev === 0) seen.taken++;
        if (c.state > 0 && c.state < 0.25) blink = true;
        if (c.state > 0 && c.air) air = true;
        was[i] = c.state;
      }
      if (blink) seen.blinking++;
      if (air) seen.air++;
    });
    const WARM_MAX = 60000;
    while (frames < WARM_MAX && (frames < WARM || (SETTLE >= 0 && game.track.cells.length > 0 && (firstTaken < 0 || frames < firstTaken + SETTLE)))) frame();
    const warm = frames;
    watch = true;
    const per = Math.ceil(FRAMES / CHUNKS);
    const r = { bytes: 0, byFn: new Map<string, number>(), chunks: [] as number[] };
    for (let done = 0; done < FRAMES; done += per) {
      const k = Math.min(per, FRAMES - done);
      const c = await sample(real, () => {
        for (let i = 0; i < k; i++) frame();
      });
      r.bytes += c.bytes;
      r.chunks.push(c.bytes / k);
      for (const [f, b] of c.byFn) r.byFn.set(f, (r.byFn.get(f) ?? 0) + b);
    }
    return { id, ...r, seen, cells: game.track.cells.length, racing: game.phase === "racing", warm, firstTaken };
  } finally {
    performance.now = realNow;
  }
}

const dir = mkdtempSync(join(tmpdir(), "catch-alloc-"));
let failed = false;
try {
  const { block, real, lines } = await loadBlock(dir);
  console.log(`client/main.ts catch-up block: ${lines} lines; ${WARM} frames warm, ${FRAMES} measured; ${BOTS} Normal bots + the autopilot (lane ${LANE}); sampling every ${INTERVAL} B`);
  // The control, called as the block is (warm first, from a function never optimised).
  const keep: object[] = [];
  const calls = 50000;
  const call = neverOptimize((i: number) => {
    keep[i & 7] = block.control(i);
  });
  for (let i = 0; i < calls; i++) call(i);
  const ctl = await sample(real, () => {
    for (let i = 0; i < calls; i++) call(i);
  });
  const per = ctl.bytes / calls;
  const ok = per > CONTROL_BYTES * 0.7 && per < CONTROL_BYTES * 1.3;
  if (!ok) failed = true;
  console.log(`control: ${per.toFixed(1)} B/call charged to the block's module for a call that makes a ${CONTROL_BYTES}-byte object${ok ? " (the charging works)" : "  THE CHARGING DOES NOT WORK"}`);
  for (const id of TRACKS) {
    const r = await runTrack(id, block, real);
    const s = r.seen;
    console.log(
      `\n${r.id}: ${(r.bytes / FRAMES).toFixed(3)} B/frame under the block (${r.bytes} B sampled in ${FRAMES} frames, after ${r.warm} warm; first cell taken in frame ${r.firstTaken})${r.racing ? "" : "  [the race ended inside the measurement]"}`,
    );
    for (const [k, v] of [...r.byFn].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${(v / FRAMES).toFixed(3)} B/frame  ${k}`);
    if (CHUNKS > 1) console.log(`  by stretch of ${Math.ceil(FRAMES / CHUNKS)} frames (B/frame): ${r.chunks.map((c) => c.toFixed(1)).join(", ")}`);
    console.log(
      `  showed: own car drafting ${s.ownDraft} frames, boosted ${s.ownBoost}; other cars drafting ${s.otherDraft} car-frames, boosted ${s.otherBoost}; HUD cue lit ${s.hud} frames; ` +
        `${r.cells} cell(s): ${s.taken} taken, ${s.blinking} frames with one blinking back, ${s.air} with an air cell taken`,
    );
    if (s.bad.length) {
      failed = true;
      console.log(`  CONTRACT BROKEN: ${s.bad.join("; ")}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
