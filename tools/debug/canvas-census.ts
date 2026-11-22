// The canvas census: every canvas the game makes, counted against the cap (tools/debug/canvas-cap.ts:
// 16 MB, everything, user decision 2026-11-21). No browser.
//
//   npx tsx tools/debug/canvas-census.ts            the census; exit code 1 if over the cap or a pool is not full
//   npx tsx tools/debug/canvas-census.ts --list     every canvas, one a line
//
// The game's own client code is run in Node on a stand-in for the canvas (it draws nothing; every
// `document.createElement("canvas")` is noted with its size and with who asked for it, read off
// the call stack), through a session made to fill every pool there is:
// - every track in turn (the shipped ones and the Preview Yard test track), a Renderer each and a
//   lap at 430 u/s: the tile pool fills up, each track gets its minimap (M4-TRACKS: one test track,
//   not every one: a session holds at most one at a time, canvas-cap.ts MINIMAPS);
// - six cars of the three looks that keep changing state (whole, battered, wreck), one hopping,
//   one falling: every car sheet, every silhouette, the effect sheet;
// - lightning cells and boosts (the catch-up sheet), the race tick (the obstacle sheet);
// - the whole HUD: seven lines top left with the hp bar, the time, the notice, a centre text that
//   changes through more texts than its pool holds, its subtitle, the banner, the corner, three
//   debug lines (what ?debug=1 shows), the catch-up cues, and more names over the cars than the
//   name tags' pool holds, one of them in letters the font does not have.
// What comes out, by kind: how many canvases, their bytes (width x height x 4), and what bounds
// the kind (a fixed pool, one a track, one a colour ...). The sum is held against the cap and the
// headroom printed. The view canvas itself (640 x 360, the page's own element, which the
// Renderer sizes) is not one the game makes; it is listed apart, and the sum with it too.
// The pools must be full for the sum to be the most the game can hold: the census says which
// are, and fails if one is not.

import { CANVAS_CAP, HUD_BYTES_MAX, MINIMAP_BYTES, MINIMAPS } from "./canvas-cap";

const LIST = process.argv.includes("--list");
const SPEED = 430;
const DT = 1000 / 60;
const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const LOOKS = ["sport", "racer", "truck"];

interface Made {
  width: number;
  height: number;
  kind: string;
}
const made: Made[] = [];

/** Who asked for the canvas being made: the kind, read off the call stack. */
function kindOf(stack: string): string {
  const has = (name: string) => new RegExp(`\\bat (?:new )?(?:[\\w.]+\\.)?${name} `).test(stack);
  if (has("claim")) return "world tiles";
  if (has("newCarSheet")) return "car sheets";
  if (has("newShade")) return "car silhouettes";
  if (has("catchSheet")) return "catch-up sheet";
  if (has("obstacleSheet")) return "obstacle sheet";
  if (has("sharedSheets")) return "effect sheet";
  if (has("sheetOf")) return "font sheets";
  if (has("miniOf")) return "minimaps";
  if (has("bakeBars")) return "hp bars";
  if (has("bakeCues")) return "catch-up cue art";
  if (has("Label")) return has("take") ? (stack.includes("nameTag") ? "name tags" : "centre texts") : "HUD labels";
  return "other";
}

function fakeCanvas(count: boolean): { width: number; height: number; getContext: () => unknown } {
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
  for (const m of ["putImageData", "drawImage", "fillRect", "setTransform", "translate", "rotate", "scale", "save", "restore", "clearRect", "strokeRect", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  if (count) made.push(Object.assign(canvas, { kind: kindOf(new Error().stack ?? "") }) as unknown as Made);
  return canvas;
}

const g = globalThis as Record<string, unknown>;
Error.stackTraceLimit = 40;
g.document = { createElement: () => fakeCanvas(true) };
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

const { trackById, trackList } = await import("../../shared/tracks");
const { testTrack } = await import("../../shared/testtracks");
const { pointAt } = await import("../../shared/track");
const { Renderer, VIEW_W, VIEW_H } = await import("../../client/render");
const { TILE, TILE_POOL, tilePoolBytes } = await import("../../client/gfx/world");
const sprites = await import("../../client/gfx/sprites");
type Track = ReturnType<typeof trackById>;

const tracks: Track[] = [...trackList().map((e) => trackById(e.id)), testTrack("preview-yard")!];
const NAMES = ["You", "Rustbucket", "Åse Ørn", "Bolt", "SkidMarks 12", "Иван", "Gasket", "Sprocket", "Dipstick", "Flange", "Camshaft", "Piston", "Grommet", "Manifold", "Tappet", "Washer", "Ratchet", "Gudgeon", "Cotter", "Spanner"];
const CENTRE = ["3", "2", "1", "GO!", "PAUSED", "FINISH", "RACE OVER", "WAIT"];
let frames = 0;
for (const track of tracks) {
  const lap = Math.ceil((track.length / SPEED) * 60);
  const r = new Renderer(fakeCanvas(false) as unknown as HTMLCanvasElement, track);
  const cars = COLORS.map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: NAMES[i], me: i === 0, wreck: false, ghost: false, hp: 1, height: 0, falling: 0, car: LOOKS[i % 3] as "sport" | "racer" | "truck", draft: 0, boost: 0 }));
  const cells = [0, 1, 2].map((i) => ({ x: 0, y: 0, air: i === 2, state: 0 }));
  const fx = { shots: [], mines: [], sparks: [], cells, nCells: 3, rt: 0 };
  const hud = { topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2", "LINE FOUR", "LINE FIVE", "LINE SIX", "LINE SEVEN"], time: "1:23.4", notice: "WEAPONS ARMED IN 5", center: "", centerSub: "by Rustbucket", banner: "Race paused by Rustbucket — resumes by itself in 4:32", corner: "23 ms", debug: ["fps 60 frame 0.3 ms", "rtt 23 ms err 0.1", "snap 30 Hz pending 2"], hp: 0.62 as number | null, draft: 0.5, boost: 30 };
  for (let i = 0; i < lap + 400; i++, frames++) {
    const k = i % lap;
    for (let c = 0; c < cars.length; c++) {
      const p = pointAt(track, ((k - c * 9 + lap) % lap) * (SPEED / 60));
      const car = cars[c];
      car.x = p.x - Math.sin(p.h) * (c % 2 ? 20 : -20);
      car.y = p.y + Math.cos(p.h) * (c % 2 ? 20 : -20);
      car.h = p.h;
      // Every 40 frames another car changes state; the names over the cars change through all of NAMES.
      const state = (Math.floor(i / 40) + c) % 3;
      car.wreck = state === 2;
      car.hp = state === 1 ? 0.3 : 1;
      if (c) car.name = NAMES[(c + Math.floor(i / 120)) % NAMES.length];
      car.car = LOOKS[(c + Math.floor(i / 300)) % 3] as "sport" | "racer" | "truck";
      car.boost = c === 1 ? 40 : 0;
      car.draft = c === 2 ? 0.7 : 0;
    }
    cars[1].height = i % 120 < 40 ? 0.6 : 0;
    cars[3].falling = i % 200 < 60 ? (i % 200) / 60 : 0;
    for (let q = 0; q < 3; q++) {
      const p = pointAt(track, ((k + 30 + q * 14) % lap) * (SPEED / 60));
      cells[q].x = p.x;
      cells[q].y = p.y;
    }
    fx.rt = i;
    hud.center = CENTRE[Math.floor(i / 30) % CENTRE.length];
    hud.time = `1:${String(Math.floor(i / 60) % 60).padStart(2, "0")}.${i % 10}`;
    hud.hp = i % 300 < 20 ? null : 0.1 + ((i % 97) / 97) * 0.9;
    r.follow(cars[0].x, cars[0].y, DT, i === 0, "c0");
    r.frame(cars, fx, hud, 10000 + frames * DT);
  }
}

// ---- the census --------------------------------------------------------------------------------

const BOUND: Record<string, string> = {
  "world tiles": `a fixed pool of ${TILE_POOL} (world.ts TILE_POOL), ${TILE} x ${TILE}, shared by every track`,
  "car sheets": `a fixed pool of ${sprites.MAX_CAR_SHEETS} (sprites.ts MAX_CAR_SHEETS), painted again as cars change`,
  "car silhouettes": `one a look: ${sprites.LOOKS.length}`,
  "effect sheet": "one",
  "catch-up sheet": "one (lightning cells, boost flames)",
  "obstacle sheet": "one, whatever the track (M4-WORLD: barrels, press, belt arrows)",
  "font sheets": "one a cut of the font and colour the HUD writes in",
  "minimaps": `one a track drawn in the session (${tracks.length} here: every shipped one and one test track; canvas-cap.ts MINIMAPS = ${MINIMAPS})`,
  "hp bars": "one",
  "catch-up cue art": "one",
  "name tags": "a fixed pool of 16",
  "centre texts": "a fixed pool of 6",
  "HUD labels": "one a line of the HUD: the panel, 7 lines, time, notice, subtitle, banner, corner, 3 debug lines",
};
const SPRITES = new Set(["car sheets", "car silhouettes", "effect sheet", "catch-up sheet", "obstacle sheet"]);
const kinds = new Map<string, { n: number; bytes: number; sizes: Map<string, number> }>();
for (const c of made) {
  const k = kinds.get(c.kind) ?? { n: 0, bytes: 0, sizes: new Map<string, number>() };
  k.n++;
  k.bytes += c.width * c.height * 4;
  const size = `${c.width} x ${c.height}`;
  k.sizes.set(size, (k.sizes.get(size) ?? 0) + 1);
  kinds.set(c.kind, k);
}
const order = ["world tiles", "car sheets", "car silhouettes", "effect sheet", "catch-up sheet", "obstacle sheet", "font sheets", "HUD labels", "name tags", "centre texts", "minimaps", "hp bars", "catch-up cue art", "other"];
const total = made.reduce((s, c) => s + c.width * c.height * 4, 0);
const mb = (b: number) => (b / 1e6).toFixed(3);
console.log(`# Canvas census (${frames} frames on ${tracks.map((t) => t.def.name).join(", ")})\n`);
console.log("| kind | canvases | sizes | bytes | what bounds it |");
console.log("|---|---:|---|---:|---|");
for (const name of order) {
  const k = kinds.get(name);
  if (!k) continue;
  console.log(`| ${name} | ${k.n} | ${[...k.sizes].map(([s, n]) => (n > 1 ? `${n} of ${s}` : s)).join(", ")} | ${k.bytes} | ${BOUND[name] ?? ""} |`);
}
const view = VIEW_W * VIEW_H * 4;
const hud = [...kinds].filter(([name]) => !SPRITES.has(name) && name !== "world tiles").reduce((s, [, k]) => s + k.bytes, 0);
const sheets = [...kinds].filter(([name]) => SPRITES.has(name)).reduce((s, [, k]) => s + k.bytes, 0);
console.log(`| **all the game makes** | **${made.length}** | | **${total}** | |`);
console.log(`\nSprites ${sheets} B (sprites.ts spriteBytes() says ${sprites.spriteBytes()}, its most SPRITE_BYTES_MAX ${sprites.SPRITE_BYTES_MAX}); world tiles ${kinds.get("world tiles")?.bytes ?? 0} B (tilePoolBytes() says ${tilePoolBytes()}); the HUD and its font ${hud} B (the other tools allow it HUD_BYTES_MAX = ${HUD_BYTES_MAX}).`);
console.log(`\n**Total ${total} B = ${mb(total)} MB of the cap's ${CANVAS_CAP} B = ${mb(CANVAS_CAP)} MB: headroom ${CANVAS_CAP - total} B = ${mb(CANVAS_CAP - total)} MB.**`);
console.log(`The view canvas itself (${VIEW_W} x ${VIEW_H}, the page's own): ${view} B more; with it ${total + view} B = ${mb(total + view)} MB.`);

// Is every pool full, and does each number say what it should?
let ok = true;
const check = (good: boolean, what: string) => {
  console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
  if (!good) ok = false;
};
console.log("");
check(total <= CANVAS_CAP, `the total is within the cap (${total} <= ${CANVAS_CAP})`);
check((kinds.get("world tiles")?.n ?? 0) === TILE_POOL, `the tile pool is full: ${kinds.get("world tiles")?.n ?? 0} of ${TILE_POOL}`);
check((kinds.get("car sheets")?.n ?? 0) === sprites.MAX_CAR_SHEETS, `the car sheets' pool is full: ${kinds.get("car sheets")?.n ?? 0} of ${sprites.MAX_CAR_SHEETS}`);
check((kinds.get("car silhouettes")?.n ?? 0) === sprites.LOOKS.length, `a silhouette for every look: ${kinds.get("car silhouettes")?.n ?? 0} of ${sprites.LOOKS.length}`);
check(sheets === sprites.SPRITE_BYTES_MAX && sheets === sprites.spriteBytes(), `the sprites are at their most: ${sheets} B counted, spriteBytes() ${sprites.spriteBytes()}, SPRITE_BYTES_MAX ${sprites.SPRITE_BYTES_MAX}`);
check((kinds.get("name tags")?.n ?? 0) === 16, `the name tags' pool is full: ${kinds.get("name tags")?.n ?? 0} of 16`);
check((kinds.get("centre texts")?.n ?? 0) === 6, `the centre texts' pool is full: ${kinds.get("centre texts")?.n ?? 0} of 6`);
check((kinds.get("minimaps")?.n ?? 0) === MINIMAPS && tracks.length === MINIMAPS && kinds.get("minimaps")?.bytes === MINIMAPS * MINIMAP_BYTES, `a minimap for every shipped track and one test track: ${kinds.get("minimaps")?.n ?? 0} of MINIMAPS ${MINIMAPS} (canvas-cap.ts: trackList().length + 1), ${kinds.get("minimaps")?.bytes ?? 0} B = MINIMAPS x ${MINIMAP_BYTES}`);
check(!kinds.has("other"), `every canvas is of a known kind (${kinds.get("other")?.n ?? 0} are not)`);
check(hud <= HUD_BYTES_MAX, `the HUD's canvases are within what the other tools allow them: ${hud} <= HUD_BYTES_MAX ${HUD_BYTES_MAX} (tools/debug/canvas-cap.ts)`);
check(sprites.SPRITE_BYTES_MAX + TILE_POOL * TILE * TILE * 4 + HUD_BYTES_MAX <= CANVAS_CAP, `the caps add up within the cap: sprites ${sprites.SPRITE_BYTES_MAX} + tiles ${TILE_POOL * TILE * TILE * 4} + HUD ${HUD_BYTES_MAX} = ${sprites.SPRITE_BYTES_MAX + TILE_POOL * TILE * TILE * 4 + HUD_BYTES_MAX} <= ${CANVAS_CAP}`);
if (LIST) {
  console.log("");
  for (const c of made) console.log(`${c.kind.padEnd(18)} ${c.width} x ${c.height}`);
}
if (!ok) process.exit(1);
