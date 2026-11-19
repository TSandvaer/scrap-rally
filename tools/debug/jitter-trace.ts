// Jitter trace: does a car step back and forth by a pixel while it drives steadily?
//
//   npx tsx tools/debug/jitter-trace.ts                        this working tree
//   npx tsx tools/debug/jitter-trace.ts --ref main             a git ref beside it (its client/ and shared/ are
//                                                              unpacked into a temp folder); any number of refs
//   npx tsx tools/debug/jitter-trace.ts --only-refs --ref X    the refs alone
//   npx tsx tools/debug/jitter-trace.ts --frames 900 --detail  more frames; a line per run and signal
//   npx tsx tools/debug/jitter-trace.ts --show "own car on screen"
//                                                              the frames round the first reversals of that signal
//
// No browser: the Renderer draws on a canvas that records where things land. A race is played
// as client/main.ts plays it. The own car drives at a constant speed along the track (a lane
// left of the centre, smoothed: see lane()). The camera follows it with main.ts's look-ahead
// (0.28 s of its velocity) through Renderer.follow, which is also told the car's id, as
// main.ts tells it (a Renderer from before that takes no notice). A frame every 1/60 s, or
// at uneven frame times (the "uneven" runs). Beside the own car: a car pacing it (the same
// speed, a lane to its right and a little ahead), a slower one it overtakes, a parked one it
// passes, and one pacing it that hops.
//
// What is read off the canvas each frame, in view pixels:
// - where each car is drawn (the middle of its sprite; of its body in the old vector renderer),
// - where its shadow is drawn,
// - the view's scroll (the world's top-left pixel), from World.draw.
// From those: the car on screen, the car against the road (screen + scroll), the shadow
// against its car, and a car against the own car. A car is counted only while it is in view.
//
// A REVERSAL is a step of a drawn coordinate opposite to its step before, while the true
// (unrounded) value it stands for moved one way all the while between the two steps. It is
// what shows as a car shaking: forth and back by a pixel though nothing reversed. Counted per
// axis and summed. The pixels in brackets are what the reversals took back in all: whole
// pixels for sprites, fractions for the old renderer's anti-aliased shapes.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const refs: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--ref") refs.push(args[++i]);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const FRAMES = option("--frames", 600);
const DETAIL = args.includes("--detail");
// --show "<signal>": print the frames round the first reversals of that signal (drawn and true values), to see what happened.
const SHOW = args.includes("--show") ? args[args.indexOf("--show") + 1] : "";
let shown = 0;
let notes: string[] = []; // --show: what the Renderer had worked out, frame by frame (its private state, if it has any)
const HERE = resolve(new URL("../..", import.meta.url).pathname);

const VIEW_W = 640, VIEW_H = 360, ZOOM = 0.8;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const TRACKS = ["rust-bowl", "crusher-run"];
const SPEEDS = [120, 250, 430];
// Frame times: steady 60 Hz, and an uneven run (timer noise and a dropped frame now and then).
const UNEVEN = [16, 17, 17, 16, 17, 17, 16, 17, 17, 16.7, 33.3, 16.7];
const IN_VIEW = 24; // a car this far outside the view (its middle, view pixels) is not counted

// ---- a canvas that records -------------------------------------------------------------

interface Hit { kind: "car" | "shadow"; key: unknown; x: number; y: number }
let hits: Hit[] = [];
let shadeSheet: unknown = null; // the new renderer's silhouette sheet
let made = 0;

function fakeCanvas(): unknown {
  return { width: 0, height: 0, tag: ++made, getContext: () => fakeCtx() };
}

/** A context that keeps its transform and notes where car bodies, car sprites and shadows land. */
function fakeCtx(): Record<string, unknown> {
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineJoin: "", lineCap: "", font: "", textAlign: "", textBaseline: "", imageSmoothingEnabled: false,
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { m = [a, b, c, d, e, f]; },
    translate(x: number, y: number) { m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y]; },
    rotate(r: number) { const c = Math.cos(r), s = Math.sin(r); m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]]; },
    scale(x: number, y: number) { m = [m[0] * x, m[1] * x, m[2] * y, m[3] * y, m[4], m[5]]; },
    save() { stack.push(m.slice()); },
    restore() { m = stack.pop() ?? m; },
    fillRect(x: number, y: number, w: number, h: number) {
      // The old renderer: a car's body is a rectangle in its colour, its shadow one in translucent black; both centred on the origin of their transform.
      const style = String(ctx.fillStyle);
      const centred = Math.abs(x + w / 2) < 1e-9 && Math.abs(y + h / 2) < 1e-9;
      if (centred && COLORS.includes(style) && w > 20) hits.push({ kind: "car", key: style, x: m[4], y: m[5] });
      else if (centred && style.startsWith("rgba(0,0,0,0.") && w > 20) hits.push({ kind: "shadow", key: null, x: m[4], y: m[5] });
    },
    drawImage(src: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, dy: number, dw: number, dh: number) {
      // The new renderer: a car is a cell of its colour's sheet, its shadow the same cell of the silhouette sheet (drawn translucent).
      if (dw === undefined) return; // a world tile
      const x = m[4] + dx + (dw >> 1), y = m[5] + dy + (dh >> 1);
      if (src === shadeSheet) {
        if ((ctx.globalAlpha as number) < 0.39) hits.push({ kind: "shadow", key: null, x, y });
      } else if (sheetColour.has(src)) hits.push({ kind: "car", key: sheetColour.get(src), x, y });
    },
    putImageData() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {}, fillText() {}, closePath() {},
    measureText: () => ({ width: 30 }),
    getContextAttributes: () => ({ willReadFrequently: false }),
  };
  return ctx;
}
const sheetColour = new Map<unknown, string>();
(globalThis as Record<string, unknown>).document = { createElement: () => fakeCanvas() };
(globalThis as Record<string, unknown>).Path2D = class { moveTo() {} lineTo() {} closePath() {} };

// ---- reversals ---------------------------------------------------------------------------

interface Tally { reversals: number; moved: number; steps: number }

/** Reversals of a drawn series against the true value it stands for (see the top). NaN = not in view: the count starts afresh after it. */
function reversals(drawn: number[], truth: number[], into: Tally, show = ""): void {
  let sign = 0, at = 0;
  for (let t = 1; t < drawn.length; t++) {
    if (Number.isNaN(drawn[t]) || Number.isNaN(drawn[t - 1])) {
      sign = 0;
      continue;
    }
    const d = drawn[t] - drawn[t - 1];
    if (Math.abs(d) < 1e-9) continue;
    into.steps++;
    const s = d > 0 ? 1 : -1;
    if (sign && s !== sign) {
      // Did the true value move one way only from before the last step to now?
      let up = false, down = false;
      for (let k = Math.max(1, at); k <= t; k++) {
        const e = truth[k] - truth[k - 1];
        if (e > 1e-9) up = true;
        else if (e < -1e-9) down = true;
      }
      if (!(up && down)) {
        into.reversals++;
        into.moved += Math.abs(d);
        if (show && shown < 8) {
          shown++;
          console.log(`${show}: reversal at frame ${t}`);
          for (let k = Math.max(1, at - 3); k <= Math.min(drawn.length - 1, t + 2); k++) console.log(`   frame ${k}: drawn ${drawn[k]} (step ${drawn[k] - drawn[k - 1]}), true ${truth[k].toFixed(3)} (step ${(truth[k] - truth[k - 1]).toFixed(3)})  ${notes[k + 60] ?? ""}`);
        }
      }
    }
    sign = s;
    at = t;
  }
}

// ---- one build ---------------------------------------------------------------------------

const SIGNALS = [
  "own car on screen", "own car against the road", "the view's scroll",
  "pacing car on screen", "pacing car against the road", "pacing car against the own car",
  "slower car on screen", "slower car against the road",
  "parked car against the road",
  "shadow against its car (4 on the ground)", "shadow against its car (the hopping one)",
] as const;
type Signal = (typeof SIGNALS)[number];

async function trace(root: string, label: string): Promise<Record<Signal, Tally>> {
  const load = (file: string) => import(pathToFileURL(join(root, file)).href);
  const { Renderer } = await load("client/render.ts");
  const world = await load("client/gfx/world.ts");
  const { trackById } = await load("shared/tracks.ts");
  const { pointAt } = await load("shared/track.ts");
  const sprites = existsSync(join(root, "client/gfx/sprites.ts")) ? await load("client/gfx/sprites.ts") : null;
  // The view's scroll is what World.draw is handed. The world itself is not drawn: nothing here needs its tiles.
  let scrollX = 0, scrollY = 0;
  world.World.prototype.draw = function (ox: number, oy: number) { scrollX = ox; scrollY = oy; };
  if (sprites) {
    sheetColour.clear();
    for (const c of COLORS) sheetColour.set(sprites.carSheet(c), c);
    shadeSheet = sprites.sharedSheets().shade;
  } else shadeSheet = null;

  const total = Object.fromEntries(SIGNALS.map((s) => [s, { reversals: 0, moved: 0, steps: 0 }])) as Record<Signal, Tally>;
  for (const trackId of TRACKS) {
    const track = trackById(trackId);
    for (const speed of SPEEDS) {
      for (const uneven of [false, true]) {
        const run = Object.fromEntries(SIGNALS.map((s) => [s, { reversals: 0, moved: 0, steps: 0 }])) as Record<Signal, Tally>;
        const r = new Renderer(fakeCanvas(), track);
        // The cars: 0 own, 1 pacing, 2 slower, 3 parked, 4 pacing and hopping.
        // A lane of the track as a smooth path: the centreline is a polyline, and a car that
        // followed it to the letter would turn in jerks at its corners, which no car does.
        // So a place on the lane is the mean of nine places 8 units apart, and the heading
        // is the way the path runs there.
        const lane = (s: number, lat: number) => {
          let x = 0, y = 0;
          for (let k = -4; k <= 4; k++) {
            const p = pointAt(track, s + k * 8);
            x += p.x - Math.sin(p.h) * lat;
            y += p.y + Math.cos(p.h) * lat;
          }
          return { x: x / 9, y: y / 9 };
        };
        const at = (s: number, lat: number) => {
          const p = lane(s, lat), a = lane(s - 1, lat), b = lane(s + 1, lat);
          return { x: p.x, y: p.y, h: Math.atan2(b.y - a.y, b.x - a.x), vx: (b.x - a.x) / 2, vy: (b.y - a.y) / 2 }; // vx, vy: per unit driven
        };
        const S0 = 300;
        const parkedAt = at(S0 + speed * 4, 30);
        const pose = (i: number, t: number) => {
          if (i === 0) return at(S0 + speed * t, -20);
          if (i === 1) return at(S0 + 40 + speed * t, 12);
          if (i === 2) return at(S0 + 150 + speed * 0.85 * t, 40);
          if (i === 3) return parkedAt;
          return at(S0 - 45 + speed * t, -52);
        };
        const cars = COLORS.slice(0, 5).map((color, i) => ({ id: `t${i}`, x: 0, y: 0, h: 0, color, name: `T${i}`, me: i === 0, wreck: false, ghost: false, height: 0 }));
        const fx = { shots: [], mines: [], sparks: [] };
        // Per car: drawn on screen, drawn shadow, true position in world pixels; per frame: scroll, true camera.
        const drawn = cars.map(() => ({ x: [] as number[], y: [] as number[], sx: [] as number[], sy: [] as number[], tx: [] as number[], ty: [] as number[], lift: [] as number[] }));
        const scroll = { x: [] as number[], y: [] as number[], tx: [] as number[], ty: [] as number[] };
        let t = 0;
        notes = [];
        for (let f = 0; f < FRAMES; f++) {
          const elapsed = uneven ? UNEVEN[f % UNEVEN.length] : 1000 / 60;
          t += elapsed / 1000;
          cars.forEach((c, i) => {
            const p = pose(i, t);
            c.x = p.x;
            c.y = p.y;
            c.h = p.h;
            // The hopping car: up for half a second every two.
            c.height = i === 4 && t % 2 < 0.5 ? Math.sin(((t % 2) / 0.5) * Math.PI) : 0;
          });
          // main.ts draw(): the camera's target is the own car and 0.28 s of its velocity; the first frame snaps.
          const own = cars[0], way = pose(0, t) as { vx: number; vy: number };
          const tx = own.x + way.vx * speed * 0.28, ty = own.y + way.vy * speed * 0.28;
          r.follow(tx, ty, elapsed, f === 0, own.id);
          hits = [];
          r.frame(cars, fx, null, 10_000 + t * 1000);
          const bodies = hits.filter((h) => h.kind === "car"), shadows = hits.filter((h) => h.kind === "shadow");
          cars.forEach((c, i) => {
            const d = drawn[i];
            const body = bodies.find((h) => h.key === c.color);
            // Counted only while it is in view, by the same rule for every build (the sprite renderer does not draw a car outside it).
            const seen = body && body.x > -IN_VIEW && body.x < VIEW_W + IN_VIEW && body.y > -IN_VIEW && body.y < VIEW_H + IN_VIEW;
            if (i === 0 && !seen) throw new Error(`${label}: the own car was not drawn in frame ${f} (${trackId}, ${speed} u/s)`);
            // Its shadow: the one nearest to where this car's shadow belongs (3 and 4 world units down-right, further with its height).
            const ex = (3 + c.height * 14) * ZOOM, ey = (4 + c.height * 20) * ZOOM;
            let shade: Hit | null = null;
            if (body) for (const s of shadows) if (!shade || Math.hypot(s.x - body.x - ex, s.y - body.y - ey) < Math.hypot(shade.x - body.x - ex, shade.y - body.y - ey)) shade = s;
            if (seen && !shade) throw new Error(`${label}: no shadow drawn in frame ${f}`);
            d.x.push(seen ? body.x : NaN);
            d.y.push(seen ? body.y : NaN);
            d.sx.push(seen ? shade!.x - body.x : NaN);
            d.sy.push(seen ? shade!.y - body.y : NaN);
            d.tx.push(c.x * ZOOM);
            d.ty.push(c.y * ZOOM);
            d.lift.push(c.height);
          });
          if (SHOW) {
            const state = r as { worked?: Uint8Array; view?: Int32Array; lead?: Int32Array; carAt?: Int32Array };
            notes[f] = state.worked ? `worked out x/y: ${["scroll", "car", "road"][state.worked[0]]}/${["scroll", "car", "road"][state.worked[1]]}, view ${state.view![0]},${state.view![1]}, lead ${state.lead![0]},${state.lead![1]}, car ${state.carAt![0]},${state.carAt![1]} (its own pixel ${Math.round(cars[0].x * ZOOM)},${Math.round(cars[0].y * ZOOM)})` : "";
          }
          scroll.x.push(scrollX);
          scroll.y.push(scrollY);
          scroll.tx.push(r.cam.x * ZOOM - VIEW_W / 2);
          scroll.ty.push(r.cam.y * ZOOM - VIEW_H / 2);
        }
        // The first second is left out: the camera is still settling behind the car.
        const from = 60;
        const cut = (a: number[]) => a.slice(from);
        const both = (name: Signal, dx: number[], dy: number[], tx: number[], ty: number[]) => {
          const show = SHOW === name ? `${label} ${trackId} ${speed} ${uneven ? "uneven" : "steady"}` : "";
          reversals(cut(dx), cut(tx), run[name], show && `${show} x`);
          reversals(cut(dy), cut(ty), run[name], show && `${show} y`);
        };
        const sub = (a: number[], b: number[]) => a.map((v, k) => v - b[k]);
        const add = (a: number[], b: number[]) => a.map((v, k) => v + b[k]);
        const onScreen = (i: number, name: Signal) => both(name, drawn[i].x, drawn[i].y, sub(drawn[i].tx, scroll.tx), sub(drawn[i].ty, scroll.ty));
        const onRoad = (i: number, name: Signal) => both(name, add(drawn[i].x, scroll.x), add(drawn[i].y, scroll.y), drawn[i].tx, drawn[i].ty);
        onScreen(0, "own car on screen");
        onRoad(0, "own car against the road");
        both("the view's scroll", scroll.x, scroll.y, scroll.tx, scroll.ty);
        onScreen(1, "pacing car on screen");
        onRoad(1, "pacing car against the road");
        both("pacing car against the own car", sub(drawn[1].x, drawn[0].x), sub(drawn[1].y, drawn[0].y), sub(drawn[1].tx, drawn[0].tx), sub(drawn[1].ty, drawn[0].ty));
        onScreen(2, "slower car on screen");
        onRoad(2, "slower car against the road");
        onRoad(3, "parked car against the road");
        // A shadow's true place against its car: 3 and 4 world units down-right, further with the height (render: +14, +20 at the top).
        for (const i of [0, 1, 2, 3]) both("shadow against its car (4 on the ground)", drawn[i].sx, drawn[i].sy, drawn[i].lift.map(() => 3 * ZOOM), drawn[i].lift.map(() => 4 * ZOOM));
        both("shadow against its car (the hopping one)", drawn[4].sx, drawn[4].sy, drawn[4].lift.map((u) => (3 + u * 14) * ZOOM), drawn[4].lift.map((u) => (4 + u * 20) * ZOOM));
        for (const s of SIGNALS) {
          total[s].reversals += run[s].reversals;
          total[s].moved += run[s].moved;
          total[s].steps += run[s].steps;
          if (DETAIL) console.log(`${label}  ${trackId} ${String(speed).padStart(3)} u/s ${uneven ? "uneven" : "steady"}  ${s.padEnd(42)} ${String(run[s].reversals).padStart(5)} reversals, ${run[s].moved.toFixed(1)} px, in ${run[s].steps} steps`);
        }
      }
    }
  }
  return total;
}

// ---- main --------------------------------------------------------------------------------

const builds: { label: string; root: string; temp: boolean }[] = [];
for (const ref of refs) {
  const dir = mkdtempSync(join(tmpdir(), "jitter-trace-"));
  const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: HERE, encoding: "utf8" }).trim();
  execFileSync("sh", ["-c", `git archive ${sha} client shared | tar -x -C "${dir}"`], { cwd: HERE });
  builds.push({ label: `${ref} (${sha})`, root: dir, temp: true });
}
if (!args.includes("--only-refs")) builds.push({ label: "working tree", root: HERE, temp: false });

const results: { label: string; total: Record<Signal, Tally> }[] = [];
try {
  for (const b of builds) results.push({ label: b.label, total: await trace(b.root, b.label) });
} finally {
  for (const b of builds) if (b.temp) rmSync(b.root, { recursive: true, force: true });
}
const runs = TRACKS.length * SPEEDS.length * 2;
console.log(`\nJitter trace: ${runs} runs (${TRACKS.join(", ")}; ${SPEEDS.join(", ")} u/s; steady and uneven frame times), ${FRAMES} frames each, the first 60 left out.`);
console.log("Reversals: steps opposite to the step before while the true value moved one way; both axes; (px) = pixels taken back in all.\n");
console.log(`| Signal | ${results.map((r) => r.label).join(" | ")} |`);
console.log(`|---|${results.map(() => "---:").join("|")}|`);
for (const s of SIGNALS) console.log(`| ${s} | ${results.map((r) => `${r.total[s].reversals} (${r.total[s].moved.toFixed(r.total[s].moved % 1 ? 1 : 0)} px)`).join(" | ")} |`);
