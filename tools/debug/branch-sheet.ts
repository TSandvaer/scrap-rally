// branch-sheet (BR-BAKE; PLAN-BRANCH.md 2.3, 2.7, 3, advisor change 1): a track's shortcut roads
// as the bake draws them, on paper and in numbers. Branch Yard (shared/testtracks.ts).
//
//   npx tsx tools/debug/branch-sheet.ts              the probe and the checks, no browser (exit code 1 if one fails)
//   npx tsx tools/debug/branch-sheet.ts --tiles      + a sheet of the bake's own tiles a theme, no browser (--each: every place twice enlarged)
//   npx tsx tools/debug/branch-sheet.ts --shots      the contact sheet, in headless Chrome
//   npx tsx tools/debug/branch-sheet.ts --bench      the fly-through's frame times, in headless Chrome
//   npx tsx tools/debug/branch-sheet.ts --alloc      rule 1 on Branch Yard, no browser
//   npx tsx tools/debug/branch-sheet.ts --units      what a tile costs to bake with and without the shortcuts, no browser
//   (--out <dir>: default tmp/br-bake, --port <n>: default 3011, --runs <n>, --detail)
//
// The probe, per mouth from BRANCH_GUIDE before it to 12 segments past its gore: every pixel of
// the baked tiles there is put back in the world (its centre) and asked two ways whether it lies
// between the walls. Drawn: what the bake made of it (client/gfx/world.ts bakeTileKinds: anything
// of the road inside the barrier). Physics: shared/track.ts queryRoads, the nearer road, and
// that road's wall where the point is (halfOn + its verge), the rule a car's wall contact uses.
// A pixel on which the two disagree is counted, with how far its centre is from the physics
// wall; the bound is 1 view pixel. Pixels of a gap's void are left out and counted (a void has
// no wall: a car falls there), and what stands on the road (a nose's tyres) is counted apart.
//
// The checks:
// - barrier posts: every post's own road is the nearer one where it stands, and none stands
//   between another road's walls; beside it, how many of the posts a road would have without
//   that rule (one every 60 units on both sides) would stand between another road's walls;
// - the yard: no piece of junk and no rut nearer a road's barrier than the art's own clearances
//   (measured here on every road by itself), and in a theme with props no pixel of one between
//   the walls or on the barrier;
// - `near` and `cand` (the bake's lists of pieces near a block and near a tile): the most they
//   held while every tile of the track was baked, against their room;
// - the dust's lookup (client/gfx/actors.ts): a car driven down every shortcut on its verge
//   throws dust, one on its asphalt throws none, and how many segments a frame searches for it;
// - what moves (client/gfx/obstacles.ts): on a copy of the track with a belt, a row of barrels
//   and a press on a shortcut, each is laid out and drawn there, and its bed is baked there;
// - the gaps: a shortcut's void ends at the shortcut's own wall (no void pixel further out).
//
// --shots: the working tree is built into a temp directory and served on 127.0.0.1 (--port), one
// browser session (brb-sheet-<pid>, muted, closed at the end). The preview's scenes of Branch
// Yard (client/preview.ts: the fork, the cut and the merge of each shortcut), held, at 1280x720
// and at 390x844@3, in the yard's own look and in the desert (`&theme=`): each as the whole
// window, and one sheet a size of all of them (at 390x844@3: the game canvas cut out of each).
//
// --bench: metric A at 1280x720, one cell a page load, the order turned round from run to run,
// as tools/debug/world-bench.ts measures S6 and S7 (it takes the benchmark's lock). The cells:
// S2 on each shipped track; S8 (client/bench.ts: a lap of Branch Yard at 430 u/s that takes
// every shortcut); S4 on Branch Yard (the lap of its main road, past all six mouths) and the same
// frames on the road without its shortcuts (&plain=1); the shipped tracks' own S4 laps; and, as
// information, S8's frames over the road without shortcuts. The rule is printed with the verdict.
//
// --alloc: Renderer.frame on Branch Yard, six cars taking every shortcut (on the verge every
// other lap: the dust's lookup on a shortcut), V8's sampling heap profiler with the objects
// collected since counted, bytes a frame charged to functions of client/, a control beside it.

import { execFile, execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FONT_LETTERS, SMALL } from "../../client/gfx/font";
import { rgbOf } from "../../client/gfx/palette";
import { sceneryOf, themedTrack, themeOf, type Scenery, type Theme } from "../../client/gfx/theme";
import { artLayout, bakePeaks, bakeTileIndices, bakeTileKinds, KIND, TILE, VIEW_H, VIEW_W, ZOOM } from "../../client/gfx/world";
import { BRANCH_YARD, testTrack } from "../../shared/testtracks";
import { BRANCH_GUIDE, buildTrack, halfOn, pointAt, queryRoads, queryTrack, roadOf, validateTrack, type Feature, type PlacedBranch, type Track } from "../../shared/track";
import { blank, decodePng, paste, savePng, type Picture } from "./png";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.resolve(arg("--out") ?? path.join(ROOT, "tmp", "br-bake"));
const DETAIL = args.includes("--detail");
const THEMES: Theme[] = ["scrapyard", "desert"];
const PAST = 12; // segments past each gore the probe goes (PLAN-BRANCH advisor change 1; LOCAL_WINDOW)
const BARRIER = 7; // the barrier's band outside a wall (client/gfx/world.ts)
const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

let failed = 0;
function say(good: boolean, what: string): void {
  if (!good) failed++;
  console.log(`${good ? "ok  " : "FAIL"}  ${what}`);
}

const roadsOf = (t: Track): Track[] => [t, ...t.branches.map((b) => b.road)];

// ---- windows of the baked world ----------------------------------------------------------------

const tiles = new Map<string, Uint8Array>();

function tile(track: Track, tx: number, ty: number, kinds: boolean): Uint8Array {
  const key = `${track.def.id}/${themeOf(track)}/${tx},${ty}/${kinds ? "k" : "p"}`;
  let t = tiles.get(key);
  if (!t) tiles.set(key, (t = kinds ? bakeTileKinds(track, tx, ty) : bakeTileIndices(track, tx, ty)));
  return t;
}

/** What the pixel (X, Y) of a track's plane is (view pixels). */
function kindAt(track: Track, X: number, Y: number): number {
  const tx = Math.floor(X / TILE), ty = Math.floor(Y / TILE);
  return tile(track, tx, ty, true)[(Y - ty * TILE) * TILE + X - tx * TILE];
}

/** A window of a track's baked world: w x h view pixels with (x, y), world units, in its middle. */
function windowOf(track: Track, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const x0 = Math.round(x * ZOOM - w / 2), y0 = Math.round(y * ZOOM - h / 2);
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w - 1) / TILE); tx++) {
      const t = tile(track, tx, ty, false);
      for (let j = 0; j < TILE; j++) {
        const Y = ty * TILE + j - y0;
        if (Y < 0 || Y >= h) continue;
        for (let i = 0; i < TILE; i++) {
          const X = tx * TILE + i - x0;
          if (X >= 0 && X < w) out[Y * w + X] = t[j * TILE + i];
        }
      }
    }
  }
  return out;
}

function picture(idx: Uint8Array, w: number, h: number, sc: Scenery): Picture {
  const out: Picture = { w, h, data: new Uint8Array(w * h * 4) };
  const words = new Uint32Array(out.data.buffer);
  for (let i = 0; i < idx.length; i++) words[i] = sc.pal32[idx[i]];
  return out;
}

function rect(pic: Picture, x: number, y: number, w: number, h: number, hex: string): void {
  const [r, g, b] = rgbOf(hex);
  for (let j = Math.max(0, y); j < Math.min(pic.h, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(pic.w, x + w); i++) {
      const o = (j * pic.w + i) * 4;
      pic.data[o] = r;
      pic.data[o + 1] = g;
      pic.data[o + 2] = b;
      pic.data[o + 3] = 255;
    }
  }
}

/** A line of text in the game's own small font. */
function text(pic: Picture, s: string, x: number, y: number, hex: string, scale = 1): void {
  const { cw, ch, bits } = SMALL;
  const up = s.toUpperCase();
  for (let n = 0; n < up.length; n++) {
    const k = FONT_LETTERS.indexOf(up[n]);
    if (k < 0) continue;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) if (bits[(k * ch + j) * cw + i]) rect(pic, x + (n * cw + i) * scale, y + j * scale, scale, scale, hex);
  }
}

// ---- the places of a track with shortcuts ---------------------------------------------------------

interface Place {
  name: string; // branch-1-fork, branch-1-cut, branch-1-merge: the preview's scenes of them
  what: string;
  x: number; // the middle of its picture, world units
  y: number;
}

/** A shortcut's cut: where along it, as client/preview.ts centres its scene. */
function cutAt(r: Track): number {
  if (r.ramps.length) return r.ramps[0].s + r.ramps[0].len + 50;
  if (r.holes.length) return (r.holes[0].s + r.holes[r.holes.length - 1].s) / 2;
  if (r.dirt.length) return (r.dirt[0].s0 + r.dirt[0].s1) / 2;
  return r.length / 2;
}

/** Each shortcut's fork, cut and merge: where a picture of each is centred (a mouth: between the two roads). */
function places(t: Track): Place[] {
  const out: Place[] = [];
  t.branches.forEach((b, k) => {
    const r = b.road;
    const mid = (u: number): { x: number; y: number } => {
      const p = pointAt(r, u), q = queryTrack(t, p.x, p.y);
      return { x: p.x - (q.nx * q.dist) / 2, y: p.y - (q.ny * q.dist) / 2 };
    };
    const what = r.ramps.length ? "a jump" : r.holes.length ? "pits" : r.dirt.length ? "dirt" : "plain";
    const fork = b.forkGore ? b.forkGore.u * 0.56 : 0, merge = b.mergeGore ? r.length - (r.length - b.mergeGore.u) * 0.56 : r.length;
    out.push({ name: `branch-${k + 1}-fork`, what: `shortcut ${k + 1}: the fork`, ...mid(fork) });
    const c = pointAt(r, cutAt(r));
    out.push({ name: `branch-${k + 1}-cut`, what: `shortcut ${k + 1}: ${what}`, x: c.x, y: c.y });
    out.push({ name: `branch-${k + 1}-merge`, what: `shortcut ${k + 1}: the merge`, ...mid(merge) });
  });
  return out;
}

// ---- the probe: the drawn walls against the physics walls ------------------------------------------

const INSIDE = new Set<number>([KIND.tarmac, KIND.kerb, KIND.verge, KIND.plate, KIND.dirt, KIND.bed, KIND.water, KIND.belt, KIND.isle, KIND.solid]);

/** The physics: how far outside the wall of the nearer road is the point (world units; 0 or less: between the walls)? */
function wallOut(t: Track, x: number, y: number): number {
  const q = queryRoads(t, x, y);
  const r = roadOf(t, q.road);
  return q.dist - (halfOn(r, q.seg, q.s, q.side) + r.def.verge);
}

/** The same asked of every road by itself: how far outside the nearest wall of any of them. */
function wallOutAny(t: Track, x: number, y: number): number {
  let best = Infinity;
  for (const r of roadsOf(t)) {
    const q = queryTrack(r, x, y);
    best = Math.min(best, q.dist - (halfOn(r, q.seg, q.s, q.side) + r.def.verge));
  }
  return best;
}

interface Probe {
  name: string;
  pixels: number;
  wrong: number;
  worst: number; // view pixels: the furthest a disagreeing pixel's centre is from the physics wall
  voids: number;
  solids: number; // pixels of what stands on the road that the physics has outside the walls
}

/** One mouth: the pixels within reach of its two roads from BRANCH_GUIDE before it to PAST segments past its gore. */
function probeMouth(t: Track, b: PlacedBranch, k: number, end: number): Probe {
  const r = b.road, g = (end ? b.mergeGore : b.forkGore)!;
  const seg = r.length / (r.pts.length - 1), mainSeg = t.length / t.pts.length;
  const reach = t.wall + 40; // across: the walls and what lies beyond them
  // The stretch of the shortcut and of the main road the mouth and its PAST segments cover.
  const u0 = end ? g.u - PAST * seg : 0, u1 = end ? r.length : g.u + PAST * seg;
  const s0 = end ? g.s - PAST * mainSeg : b.s0 - BRANCH_GUIDE, s1 = end ? b.s1 + BRANCH_GUIDE : g.s + PAST * mainSeg;
  // The view pixels within `reach` of either stretch.
  const seen = new Set<number>();
  const mark = (road: Track, a: number, z: number) => {
    for (let d = a; d <= z; d += 4) {
      const p = pointAt(road, d);
      for (let lat = -reach; lat <= reach; lat += 1) {
        const X = Math.floor((p.x - Math.sin(p.h) * lat) * ZOOM), Y = Math.floor((p.y + Math.cos(p.h) * lat) * ZOOM);
        seen.add((Y + 32768) * 65536 + X + 32768);
      }
    }
  };
  mark(r, Math.max(0, u0), Math.min(r.length, u1));
  mark(t, s0, s1);
  const out: Probe = { name: `shortcut ${k + 1}, ${end ? "merge" : "fork"}`, pixels: 0, wrong: 0, worst: 0, voids: 0, solids: 0 };
  const first: string[] = [];
  for (const key of seen) {
    const X = (key % 65536) - 32768, Y = Math.floor(key / 65536) - 32768;
    const kind = kindAt(t, X, Y);
    if (kind === KIND.void) {
      out.voids++;
      continue;
    }
    const drawn = INSIDE.has(kind);
    const off = wallOut(t, (X + 0.5) / ZOOM, (Y + 0.5) / ZOOM);
    out.pixels++;
    if (drawn === off <= 0) continue;
    // What stands on the road is drawn over whatever is under it.
    if (kind === KIND.solid) {
      out.solids++;
      continue;
    }
    out.wrong++;
    out.worst = Math.max(out.worst, Math.abs(off) * ZOOM);
    if (first.length < 6) first.push(`(${X}, ${Y}) drawn ${drawn ? "inside" : "outside"}, the physics wall ${Math.abs(off).toFixed(4)} units ${off > 0 ? "nearer the road" : "further out"}`);
  }
  if (DETAIL && first.length) console.log(`      ${first.join("; ")}`);
  return out;
}

function probe(t: Track): void {
  console.log(`\nThe drawn walls against the physics walls (queryRoads), a pixel at a time, from ${BRANCH_GUIDE} units before each mouth to ${PAST} segments past its gore:`);
  let pixels = 0, wrong = 0, worst = 0, mouths = 0;
  t.branches.forEach((b, k) => {
    for (const end of [0, 1]) {
      if (!(end ? b.mergeGore : b.forkGore)) continue;
      const p = probeMouth(t, b, k, end);
      pixels += p.pixels;
      wrong += p.wrong;
      worst = Math.max(worst, p.worst);
      mouths++;
      console.log(`      ${p.name}: ${p.pixels} pixels, ${p.wrong} drawn on the other side of the wall than the physics has them${p.wrong ? ` (the furthest ${p.worst.toFixed(4)} px from it)` : ""}; ${p.solids} of what stands on the road outside the walls; ${p.voids} of a gap's void left out`);
    }
  });
  say(mouths > 0 && worst <= 1, `the drawn union of the two corridors matches queryRoads within 1 px round every mouth and to ${PAST} segments past each gore: ${mouths} mouths, ${pixels} pixels, ${wrong} on the other side of the wall, the furthest ${worst.toFixed(4)} px from it`);
  // A control: the same count with the walls of the main road alone (no shortcut known to the physics) must not be 0.
  let alone = 0;
  const b = t.branches[0], g = b.forkGore;
  if (g) {
    for (let u = 0; u <= g.u; u += 3) {
      const p = pointAt(b.road, u);
      const X = Math.floor(p.x * ZOOM), Y = Math.floor(p.y * ZOOM);
      const q = queryTrack(t, (X + 0.5) / ZOOM, (Y + 0.5) / ZOOM);
      if (INSIDE.has(kindAt(t, X, Y)) !== q.dist <= t.wall) alone++;
    }
  }
  say(alone > 0, `control: held against the main road's walls alone, ${alone} pixels of the first shortcut's centreline in its fork's mouth are on the other side (the probe sees a difference when there is one)`);
}

// ---- every tile of the track ---------------------------------------------------------------------

/** Every tile a road of the track reaches (its walls and 60 units beyond), in a fixed order. */
function tilesOf(t: Track): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const r of roadsOf(t)) {
    for (let s = 0; s <= r.length; s += 20) {
      const p = pointAt(r, s);
      for (let lat = -t.wall - 60; lat <= t.wall + 60; lat += 20) {
        const tx = Math.floor(((p.x - Math.sin(p.h) * lat) * ZOOM) / TILE), ty = Math.floor(((p.y + Math.cos(p.h) * lat) * ZOOM) / TILE);
        if (seen.has(`${tx},${ty}`)) continue;
        seen.add(`${tx},${ty}`);
        out.push([tx, ty]);
      }
    }
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** `near` and `cand` while every tile is baked; no prop pixel on a road; a shortcut's void no wider than the shortcut. */
function lists(t: Track): void {
  for (const theme of THEMES) {
    const track = themedTrack(t, theme);
    const all = tilesOf(t);
    bakePeaks(true);
    let props = 0, onRoad = 0, voids = 0, wideVoid = 0;
    for (const [tx, ty] of all) {
      const kinds = bakeTileKinds(track, tx, ty); // baked here and now: the lists' peaks are these tiles'
      tiles.set(`${track.def.id}/${themeOf(track)}/${tx},${ty}/k`, kinds);
      for (let p = 0; p < kinds.length; p++) {
        if (kinds[p] !== KIND.prop && kinds[p] !== KIND.void) continue;
        const x = (tx * TILE + (p % TILE) + 0.5) / ZOOM, y = (ty * TILE + Math.floor(p / TILE) + 0.5) / ZOOM;
        if (kinds[p] === KIND.prop) {
          props++;
          if (wallOutAny(t, x, y) <= BARRIER) onRoad++;
        } else {
          // A void pixel: no further out than the barrier of the road whose gap it is (the nearer road's).
          voids++;
          if (wallOut(t, x, y) > BARRIER + 0.01) wideVoid++;
        }
      }
    }
    const peak = bakePeaks();
    say(peak.near < peak.nearRoom && peak.cand < peak.candRoom, `${theme}: ${all.length} tiles baked; the most pieces near a block ${peak.near} of ${peak.nearRoom}, near a tile ${peak.cand} of ${peak.candRoom} (a full list leaves pieces out)`);
    if (theme === "scrapyard") say(voids > 0 && wideVoid === 0, `the gaps: ${voids} pixels of void, ${wideVoid} further out than the barrier of the road whose gap it is`);
    else say(props > 0 && onRoad === 0, `${theme}: ${props} pixels of props, ${onRoad} of them between a road's walls or on its barrier`);
  }
}

// ---- posts, junk, ruts -----------------------------------------------------------------------------

function layout(t: Track): void {
  const art = artLayout(t);
  const roads = roadsOf(t);
  // Every post: which road it is a post of (the one whose wall it stands 3.2 beyond), and what it stands on.
  let astray = 0, onRoad = 0;
  const inMouth = t.branches.map(() => [0, 0]);
  for (let k = 0; k < art.posts.length; k += 2) {
    // Its middle pixel's centre.
    const X = art.posts[k] + 1, Y = art.posts[k + 1] + 1;
    const x = (X + 0.5) / ZOOM, y = (Y + 0.5) / ZOOM;
    // Its own road: the one it stands 3.2 beyond the wall of (to the rounding of its pixel).
    let own = -1, off = Infinity;
    roads.forEach((r, j) => {
      const q = queryTrack(r, x, y);
      const o = Math.abs(q.dist - (halfOn(r, q.seg, q.s, q.side) + r.def.verge) - 3.2);
      if (o < off) {
        off = o;
        own = j;
      }
    });
    const near = queryRoads(t, x, y);
    if (near.road !== own && Math.abs(wallOut(t, x, y) - 3.2) > 1.5) astray++;
    if (wallOutAny(t, x, y) <= 0 || INSIDE.has(kindAt(t, X, Y))) onRoad++;
    t.branches.forEach((b, j) => {
      const q = queryTrack(b.road, x, y);
      if (q.dist > t.wall + 12) return;
      if (b.forkGore && q.s <= b.forkGore.u) inMouth[j][0]++;
      else if (b.mergeGore && q.s >= b.mergeGore.u) inMouth[j][1]++;
    });
  }
  // What the rule is for: the posts each road would have by itself, one every 60 units on both sides.
  let would = 0, between = 0;
  roads.forEach((r, j) => {
    for (let s = 30; s < r.length; s += 60) {
      const p = pointAt(r, s);
      for (const side of [-1, 1]) {
        const lat = side * (halfOn(r, p.seg, s, side) + r.def.verge + 3.2);
        const x = p.x - Math.sin(p.h) * lat, y = p.y + Math.cos(p.h) * lat;
        would++;
        if (roads.some((o, i) => i !== j && ((q) => q.dist <= halfOn(o, q.seg, q.s, q.side) + o.def.verge)(queryTrack(o, x, y)))) between++;
      }
    }
  });
  say(art.posts.length > 0 && onRoad === 0 && astray === 0, `barrier posts: ${art.posts.length / 2} stand; ${onRoad} between a road's walls (on its verge, kerb or asphalt), ${astray} where their own road is not the nearer one; per mouth (fork, merge): ${inMouth.map((m) => m.join(", ")).join(" | ")}`);
  say(between > 0, `control: of the ${would} posts the roads would have each by itself, ${between} would stand between another road's walls (the rule has something to drop)`);

  // Junk and ruts: outside every road's barrier by the art's own clearances (16 and 14 units beyond it).
  let junkNear = 0, rutNear = 0, rutPoints = 0, least = Infinity;
  for (const j of art.junk) {
    const d = wallOutAny(t, j.x / ZOOM, j.y / ZOOM) - BARRIER;
    least = Math.min(least, d);
    if (d < 16 - 1e-6) junkNear++;
  }
  for (const r of art.ruts) {
    for (let k = 0; k < r.length; k += 2) {
      rutPoints++;
      // (A rut's points are kept as 32-bit floats: a hair of rounding.)
      if (wallOutAny(t, r[k] / ZOOM, r[k + 1] / ZOOM) - BARRIER < 14 - 0.01) rutNear++;
    }
  }
  say(art.junk.length > 0 && junkNear === 0, `junk: ${art.junk.length} pieces, ${junkNear} nearer than 16 units to a road's barrier (the nearest ${least.toFixed(1)}), every road asked by itself`);
  say(rutPoints > 0 && rutNear === 0, `ruts: ${art.ruts.length} of ${rutPoints} points, ${rutNear} nearer than 14 units to a road's barrier`);
  // How much of it lies along the shortcuts (beyond the main road's own strip of junk: its wall + 190 + a heap's size).
  const far = art.junk.filter((j) => queryTrack(t, j.x / ZOOM, j.y / ZOOM).dist > t.wall + 230).length;
  say(far > 0, `junk along the shortcuts: ${far} pieces lie further from the main road than its own heaps reach`);
  say(art.mouths === t.branches.length * 2, `mouth paint: ${art.mouths} mouths have their wedge (a fork its arrows too), of ${t.branches.length * 2}`);
}

// ---- a Renderer in Node --------------------------------------------------------------------------

interface Recorder {
  fills: Map<string, number>; // fillRect calls by fill style
  blits: number; // drawImage calls
}

/** A canvas that draws nothing and counts what it is asked for. */
function quietCanvas(rec: Recorder | null): { width: number; height: number; getContext: () => unknown } {
  const nothing = (): void => {};
  const pixels = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const attributes = { willReadFrequently: true }, size = { width: 30 };
  const ctx: Record<string, unknown> = {
    fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineJoin: "", lineCap: "", font: "", textAlign: "", textBaseline: "", imageSmoothingEnabled: false,
    createImageData: pixels,
    getImageData: (_x: number, _y: number, w: number, h: number) => pixels(w, h),
    measureText: () => size,
    getContextAttributes: () => attributes,
  };
  for (const m of ["setTransform", "translate", "rotate", "scale", "save", "restore", "fillRect", "clearRect", "strokeRect", "drawImage", "putImageData", "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo", "arc", "rect", "fill", "stroke", "clip", "setLineDash"]) ctx[m] = nothing;
  if (rec) {
    ctx.fillRect = () => rec.fills.set(ctx.fillStyle as string, (rec.fills.get(ctx.fillStyle as string) ?? 0) + 1);
    ctx.drawImage = () => rec.blits++;
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  ctx.canvas = canvas;
  return canvas;
}

function nodeDom(): void {
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => quietCanvas(null) };
  g.Path2D = class {
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
}

/** The dust's lookup on the shortcuts: a car on a shortcut's verge throws dust, one on its asphalt none; the segments searched a frame. */
async function dust(t: Track): Promise<void> {
  nodeDom();
  const { Renderer } = await import("../../client/render");
  let reads = 0;
  const counted = (r: Track): Track => ({ ...r, pts: new Proxy(r.pts, { get: (o, k, rc) => (typeof k === "string" && k !== "length" && k.charCodeAt(0) < 58 && reads++, Reflect.get(o, k, rc)) }) });
  // The same track with every road's points counted as they are read (two a segment searched).
  const track: Track = { ...counted(t), branches: t.branches.map((b) => ({ ...b, road: counted(b.road) })) };
  const tones = new Set(sceneryOf("scrapyard").dust);
  const fx = { shots: [], mines: [], sparks: [] };
  const drive = (road: Track, from: number, to: number, lat: number): { specks: number; frames: number; median: number; most: number } => {
    const rec: Recorder = { fills: new Map(), blits: 0 };
    const r = new Renderer(quietCanvas(rec) as unknown as HTMLCanvasElement, track);
    const car = { id: "c0", x: 0, y: 0, h: 0, color: "#e8552d", name: "", me: true, wreck: false, ghost: false };
    const per: number[] = [];
    let specks = 0, frames = 0;
    for (let s = from, i = 0; s <= to; s += 5, i++) {
      const p = pointAt(road, s);
      car.x = p.x - Math.sin(p.h) * lat;
      car.y = p.y + Math.cos(p.h) * lat;
      car.h = p.h;
      r.follow(car.x, car.y, 1000 / 60, i === 0, "c0");
      reads = 0;
      rec.fills.clear();
      r.frame([car], fx, null, 10000 + (i * 1000) / 60);
      if (i > 1) per.push(reads / 2); // the first frames: the car is new, it is looked up everywhere once
      let n = 0;
      for (const [style, count] of rec.fills) if (tones.has(style)) n += count;
      if (n > 0) specks++;
      frames++;
    }
    per.sort((a, b) => a - b);
    return { specks, frames, median: per[per.length >> 1], most: per[per.length - 1] };
  };
  console.log("\nThe dust's lookup (client/gfx/actors.ts), a car at 300 u/s:");
  let good = true;
  const all = roadsOf(t).reduce((n, r) => n + (r.roadNo ? r.pts.length - 1 : r.pts.length), 0);
  t.branches.forEach((b, k) => {
    const r = b.road, half = r.def.halfWidth;
    const a = b.forkGore ? b.forkGore.u + 160 : 100, z = b.mergeGore ? b.mergeGore.u - 160 : r.length - 100;
    // Past the mouth's taper: on its verge (between its kerb and its wall), then on its asphalt.
    const verge = drive(r, a, Math.min(z, a + 700), half + 20), tar = drive(r, a, Math.min(z, a + 700), 0);
    // Through the whole fork, on the outer verge all the way (the main road's verge, then the shortcut's).
    const fork = drive(r, 0, a, t.def.halfWidth + 20);
    console.log(`      shortcut ${k + 1} (half-width ${half}): on its verge ${verge.specks} of ${verge.frames} frames with dust, ${verge.median} segments searched a frame (most ${verge.most}); on its asphalt ${tar.specks} with dust, ${tar.median} searched (most ${tar.most}); through its fork on the outer verge ${fork.specks} of ${fork.frames} with dust, ${fork.median} searched (most ${fork.most})`);
    if (!(verge.specks > verge.frames / 2 && tar.specks === 0 && fork.specks > fork.frames / 3 && verge.most <= 30 && fork.most <= 30)) good = false;
  });
  const main = drive(t, 2000, 2700, t.def.halfWidth + 20);
  console.log(`      the main road's verge, far from a mouth: ${main.specks} of ${main.frames} frames with dust, ${main.median} segments searched a frame (most ${main.most})`);
  say(good && main.specks > main.frames / 2 && main.most <= 30, `dust on every shortcut's verge and none on its asphalt; never more than 30 of the track's ${all} segments searched in a frame (13 round where the car was, 13 more of the other road near a mouth, 1 for the road's width)`);
}

/** What moves on a shortcut is laid out and drawn there, and its bed baked there. */
async function movers(): Promise<void> {
  nodeDom();
  const { Obstacles, obstacleFit } = await import("../../client/gfx/obstacles");
  // Branch Yard with a belt, a row of barrels and a press on its first shortcut (clear of its mouths and its dirt).
  const features: Feature[] = (BRANCH_YARD.features ?? []).map((f, k) =>
    f.k === "branch" && k === 0 ? { ...f, features: [...(f.features ?? []), { k: "belt", s0: 860, s1: 1000, lat0: -56, lat1: 56, vx: 60 }, { k: "barrels", s: 1640, n: 2, period: 200, speed: 90 }, { k: "press", s: 1790, lat0: -56, lat1: 8, period: 160, down: 50 }] } : f,
  );
  const t = buildTrack({ ...BRANCH_YARD, id: "branch-yard-movers", features });
  const errs = validateTrack(t);
  const r = t.branches[0].road;
  const fit = obstacleFit(t), none = obstacleFit(testTrack("branch-yard")!);
  const rec: Recorder = { fills: new Map(), blits: 0 };
  const o = new Obstacles(quietCanvas(rec).getContext() as CanvasRenderingContext2D, t);
  const seen: string[] = [];
  let all = true;
  for (const [what, s, kind] of [["the belt", 930, KIND.belt], ["the row of barrels", 1640, KIND.tarmac], ["the press", 1790, KIND.bed]] as const) {
    const p = pointAt(r, s);
    const ox = Math.round(p.x * ZOOM - VIEW_W / 2), oy = Math.round(p.y * ZOOM - VIEW_H / 2);
    let drawn = 0;
    for (let tick = 0; tick < 240; tick++) {
      rec.blits = 0;
      o.under(tick, ox, oy);
      o.over(tick, ox, oy);
      drawn += rec.blits;
    }
    // Its bed in the baked tiles: the pixel under its middle.
    const k = kindAt(t, Math.floor(p.x * ZOOM), Math.floor(p.y * ZOOM));
    seen.push(`${what}: ${drawn} sprites drawn in 240 ticks, its middle baked as ${Object.entries(KIND).find(([, v]) => v === k)?.[0] ?? k}`);
    if (!drawn || k !== kind) all = false;
  }
  say(all && fit.used > 0 && fit.fits && none.used === 0, `what moves on a shortcut (a copy of the yard with a belt, barrels and a press on shortcut 1; validateTrack: ${errs.length ? `${errs.length} complaint(s), e.g. ${errs[0]}` : "valid"}): its sprites take ${fit.used} sheet pixels (the yard itself ${none.used}); ${seen.join("; ")}`);
}

// ---- the sheet of tiles (no browser) -------------------------------------------------------------

function tileSheet(t: Track): void {
  mkdirSync(OUT, { recursive: true });
  const W = 640, H = 360, GAP = 8;
  const list = places(t);
  for (const theme of THEMES) {
    const track = themedTrack(t, theme), sc = sceneryOf(theme);
    const cols = 3, rows = Math.ceil(list.length / cols);
    const [r, g, b] = rgbOf("#120e0b");
    const sheet = blank(cols * (W + GAP) + GAP, rows * (H + GAP) + GAP, r, g, b);
    list.forEach((pl, i) => paste(sheet, picture(windowOf(track, pl.x, pl.y, W, H), W, H, sc), GAP + (i % cols) * (W + GAP), GAP + Math.floor(i / cols) * (H + GAP)));
    const file = path.join(OUT, `tiles-${theme}.png`);
    savePng(file, sheet);
    console.log(file);
    if (!args.includes("--each")) continue;
    for (const pl of list) {
      const one = path.join(OUT, `tiles-${theme}-${pl.name}.png`);
      const big = blank(W * 2, H * 2, 0, 0, 0);
      paste(big, picture(windowOf(track, pl.x, pl.y, W, H), W, H, sc), 0, 0, 0, 0, W, H, 2);
      savePng(one, big);
      console.log(one);
    }
  }
}

// ---- a built tree, served, and a browser ------------------------------------------------------------

const VITE = path.join(ROOT, "node_modules", ".bin", "vite");
const CHROME_ARGS = "--mute-audio,--disable-background-timer-throttling,--disable-renderer-backgrounding,--enable-precise-memory-info";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const cleanups: (() => unknown)[] = [];
async function cleanup(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => {});
}

/** The working tree, built and served on 127.0.0.1:port (cross-origin isolated), and a muted browser session on it. */
async function served(tag: string, port: number): Promise<{ url: string; ab: (more: string[]) => Promise<string> }> {
  const dist = mkdtempSync(path.join(os.tmpdir(), "branch-sheet-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  console.error("building the working tree ...");
  await run(VITE, ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file = path.join(dist, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dist, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
    createReadStream(file).pipe(res);
  });
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
  const session = `brb-${tag}-${process.pid}`;
  const ab = async (more: string[]): Promise<string> => (await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 })).stdout.trim();
  cleanups.push(() => ab(["close"]));
  await ab(["--args", CHROME_ARGS, "open", "about:blank"]);
  return { url: `http://127.0.0.1:${port}`, ab };
}

// ---- the contact sheet (headless Chrome) ---------------------------------------------------------

const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];

async function shots(t: Track, port: number): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { url, ab } = await served("sheet", port);
  const list = places(t);
  const lines: string[] = [];
  const INK = "#e9dcc3", PAPER = "#120e0b", GAP = 12, HEAD = 26;
  for (const size of SIZES) {
    await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
    const cells: { pic: Picture; label: string }[] = [];
    for (const theme of THEMES) {
      for (const pl of list) {
        const file = path.join(OUT, `${pl.name}-${theme}-${size.name}.png`);
        // No caption over the picture: the world is what is to be judged.
        await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", preview: "1", freeze: "1", scene: pl.name, hud: "0", theme })}`]);
        await sleep(600); // a held scene is redrawn every frame: any frame after the first will do
        await ab(["screenshot", file]);
        let pic = decodePng(file);
        lines.push(file);
        if (size.scale > 1) {
          // On the sheet: the game canvas alone, cut out of the window.
          const box = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify((({x, y, width, height}) => [x, y, width, height])(document.getElementById('view').getBoundingClientRect()))"])) as string) as number[];
          const x0 = Math.round(box[0] * size.scale), y0 = Math.round(box[1] * size.scale), w = Math.round(box[2] * size.scale), h = Math.round(box[3] * size.scale);
          const cut = blank(w, h, 0, 0, 0);
          paste(cut, pic, 0, 0, x0, y0, w, h);
          pic = cut;
        }
        cells.push({ pic, label: `${pl.what}, ${theme}` });
        console.error(file);
      }
    }
    // The sheet: a row a shortcut and theme (fork, cut, merge).
    const cw = cells[0].pic.w, ch = cells[0].pic.h, cols = 3, rows = Math.ceil(cells.length / cols);
    const [r, g, b] = rgbOf(PAPER);
    const sheet = blank(cols * (cw + GAP) + GAP, rows * (ch + HEAD + GAP) + GAP + HEAD, r, g, b);
    text(sheet, `Branch Yard: the shortcut roads as the bake draws them (${size.name}${size.scale > 1 ? ", the game canvas" : ""})`, GAP, 8, INK, 2);
    // Row by row: the shortcut's three places in the yard's own look, then in the desert.
    const order: number[] = [];
    for (let k = 0; k < list.length / 3; k++) for (let th = 0; th < THEMES.length; th++) for (let j = 0; j < 3; j++) order.push(th * list.length + k * 3 + j);
    order.forEach((from, i) => {
      const x = GAP + (i % cols) * (cw + GAP), y = HEAD + GAP + Math.floor(i / cols) * (ch + HEAD + GAP);
      text(sheet, cells[from].label, x, y + 4, INK, 2);
      paste(sheet, cells[from].pic, x, y + HEAD);
    });
    const file = path.join(OUT, `sheet-${size.name}.png`);
    savePng(file, sheet);
    lines.push(file);
  }
  console.log(lines.join("\n"));
}

// ---- the fly-through's frame times (headless Chrome) ------------------------------------------------

const LOCK_FILE = path.join(os.tmpdir(), "scrap-rally-bench.lock");

function lockHolder(file = LOCK_FILE): { pid: number; where: string } | null {
  try {
    const [pid, where] = readFileSync(file, "utf8").split("\n");
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), where: where ?? "" } : null;
  } catch {
    return null;
  }
}

/** Does that pid still run a benchmark (as scripts/bench.ts and tools/debug/world-bench.ts ask it: by `bench.ts` in its command; this tool is started as one for --bench)? */
async function runnerAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return /bench\.ts|branch-sheet\.ts/.test((await run("ps", ["-o", "command=", "-p", String(pid)])).stdout);
  } catch (e) {
    return (e as { code?: number }).code !== 1;
  }
}

/** The benchmark's machine-wide lock, as scripts/bench.ts takes it. */
async function acquireLock(): Promise<void> {
  let told = 0;
  for (;;) {
    try {
      writeFileSync(LOCK_FILE, `${process.pid}\n${ROOT}\n${new Date().toISOString()}\n`, { flag: "wx" });
      cleanups.push(() => {
        if (lockHolder()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = lockHolder();
    let age = 0;
    try {
      age = Date.now() - statSync(LOCK_FILE).mtimeMs;
    } catch {
      /* gone meanwhile */
    }
    if (holder ? !(await runnerAlive(holder.pid)) : age > 10_000) {
      const aside = `${LOCK_FILE}.${process.pid}.stale`;
      try {
        renameSync(LOCK_FILE, aside);
        const moved = lockHolder(aside);
        if (moved && (await runnerAlive(moved.pid)) && !existsSync(LOCK_FILE)) renameSync(aside, LOCK_FILE);
        else rmSync(aside, { force: true });
      } catch {
        /* someone else was quicker: look again */
      }
      continue;
    }
    if (Date.now() - told > 60_000) {
      console.error(`another benchmark is running on this machine${holder ? ` (pid ${holder.pid}, ${holder.where})` : ""}: waiting for it to finish ...`);
      told = Date.now();
    }
    await sleep(2000);
  }
}

interface CellA {
  scene: string;
  track: string;
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over: number;
  lowMean: number;
  steps: number[];
  baked: number;
  bakeUnits: number;
  checksum: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function bench(port: number): Promise<number> {
  const RUNS = Number(arg("--runs") ?? 5);
  await acquireLock();
  const { url, ab } = await served("bench", port);
  await ab(["set", "viewport", "1280", "720", "1"]);
  const cells: { scene: string; track: string; plain?: boolean; what: string }[] = [
    { scene: "S2", track: "rust-bowl", what: "S2 rust-bowl" },
    { scene: "S2", track: "crusher-run", what: "S2 crusher-run" },
    { scene: "S2", track: "overpass-knot", what: "S2 overpass-knot" },
    { scene: "S8", track: "branch-yard", what: "S8 branch-yard (every shortcut)" },
    { scene: "S4", track: "branch-yard", what: "S4 branch-yard (the main road)" },
    { scene: "S4", track: "branch-yard", plain: true, what: "S4 branch-yard without shortcuts" },
    { scene: "S4", track: "rust-bowl", what: "S4 rust-bowl" },
    { scene: "S4", track: "crusher-run", what: "S4 crusher-run" },
    { scene: "S4", track: "overpass-knot", what: "S4 overpass-knot" },
    { scene: "S8", track: "branch-yard", plain: true, what: "S8's frames without shortcuts" },
  ];
  const S8 = 3, MAIN = 4, PLAIN = 5, LAPS = [6, 7, 8], OVER_GROUND = 9;
  const got: CellA[][] = cells.map(() => []);
  let isolated = true, ua = "";
  for (let r = 0; r < RUNS; r++) {
    const order = cells.map((_, k) => k);
    if (r % 2) order.reverse();
    for (const k of order) {
      const c = cells[k];
      await ab(["open", `${url}/?${new URLSearchParams({ debug: "1", bench: "1", metric: "A", scene: c.scene, track: c.track, ...(c.plain ? { plain: "1" } : {}) })}`]);
      const deadline = Date.now() + 180_000;
      for (;;) {
        if ((await ab(["eval", "window.scrapBench && window.scrapBench.done ? 1 : 0"])) === "1") break;
        if (Date.now() > deadline) throw new Error(`the bench page did not finish (${c.what})`);
        await sleep(250);
      }
      const out = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify(window.scrapBench)"])) as string) as { error: string; cells: CellA[]; env: { isolated: boolean; ua: string } };
      if (out.error) throw new Error(`bench error: ${out.error}`);
      got[k].push(out.cells[0]);
      isolated &&= out.env.isolated;
      ua = out.env.ua;
      console.error(`run ${r + 1}/${RUNS}  ${c.what.padEnd(34)} median ${out.cells[0].p50.toFixed(3)}  mean ${out.cells[0].mean.toFixed(4)}  p95 ${out.cells[0].p95.toFixed(3)}  ${out.cells[0].checksum}`);
    }
  }
  const f = (x: number) => x.toFixed(3);
  const med = (k: number, of: (c: CellA) => number) => median(got[k].map(of));
  const ratio = (a: number, b: number, of: (c: CellA) => number) => got[a].map((x, r) => of(x) / of(got[b][r]));
  console.log(`# The Branch Yard fly-through (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)\n`);
  console.log(`Metric A at 1280x720 (CPU raster: every frame once, a 1x1 read-back after each, 300 warm-up frames), ${RUNS} run${RUNS > 1 ? "s" : ""}, one cell a page load, the order turned round from run to run. ms a frame.${isolated ? "" : " WARNING: the page was not cross-origin isolated (a 100 us timer)."}\n`);
  console.log("| cell | frames | median (of the runs' medians) | spread (max - min) | the faster half's mean | mean | p95 | p99 | frames over 4 ms | tiles baked while measured | bake units a frame | checksums |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  cells.forEach((c, k) => {
    const p50 = got[k].map((x) => x.p50);
    console.log(`| ${c.what} | ${got[k][0].n} | ${f(median(p50))} | ${f(Math.max(...p50) - Math.min(...p50))} | ${med(k, (x) => x.lowMean).toFixed(4)} | ${med(k, (x) => x.mean).toFixed(4)} | ${f(med(k, (x) => x.p95))} | ${f(med(k, (x) => x.p99))} | ${med(k, (x) => x.over)} | ${med(k, (x) => x.baked)} | ${(med(k, (x) => x.bakeUnits) / got[k][0].n).toFixed(1)} | ${[...new Set(got[k].map((x) => x.checksum))].join(" ")} |`);
  });

  // 1. The ticket's first rule: the fly-through's median against S2's, at most 1.10.
  console.log("\n**1. Against S2 (the median of the per-run ratios of the medians; budget 1.10).** A median is a whole number of the timer's steps (5 us), so a ratio of two of them moves in jumps of about 0.08.\n");
  console.log("| | S2 rust-bowl | S2 crusher-run | S2 overpass-knot | against the cheapest |");
  console.log("|---|---:|---:|---:|---:|");
  const worst: number[] = [];
  for (const k of [S8, MAIN, PLAIN, ...LAPS]) {
    const rs = [0, 1, 2].map((s) => median(ratio(k, s, (x) => x.p50)));
    worst[k] = Math.max(...rs);
    console.log(`| ${cells[k].what} | ${rs.map(f).join(" | ")} | ${f(worst[k])} ${worst[k] <= 1.1 ? "within" : "over"} |`);
  }
  const lapsOver = LAPS.filter((k) => worst[k] > 1.1).length + (worst[PLAIN] > 1.1 ? 1 : 0);
  const first = worst[S8] <= 1.1 && worst[MAIN] <= 1.1;
  const hist = (k: number): number[] => {
    const sum = new Array<number>(41).fill(0);
    for (const x of got[k]) x.steps.forEach((n, i) => (sum[i] += n));
    return sum;
  };
  console.log(`\nFrames by the time they took, all ${RUNS} runs together (a column a timer step of 5 us):\n`);
  const cols = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  console.log(`| ms | ${cols.map((i) => (i * 0.005).toFixed(3)).join(" | ")} | slower than 0.100 |`);
  console.log(`|---|${new Array(cols.length + 1).fill("---:").join("|")}|`);
  for (const k of [0, 1, 2, S8, MAIN, PLAIN, ...LAPS]) {
    const h = hist(k);
    console.log(`| ${cells[k].what} | ${cols.map((i) => h[i]).join(" | ")} | ${h.slice(21).reduce((a, b) => a + b, 0)} |`);
  }

  // 2. The same frames without shortcuts: the main road's lap, exactly the same camera and cars.
  const mMean = ratio(MAIN, PLAIN, (x) => x.mean), mLow = ratio(MAIN, PLAIN, (x) => x.lowMean), mP50 = ratio(MAIN, PLAIN, (x) => x.p50), mP95 = ratio(MAIN, PLAIN, (x) => x.p95);
  console.log("\n**2. The same frames without shortcuts (budget 1.05, as S7's).** S4 on Branch Yard is the lap of its main road, past all six mouths; with &plain=1 the same camera and cars are drawn on the same road without its shortcut roads.\n");
  console.log("| S4 branch-yard against the same frames without shortcuts | run by run | median ratio | budget 1.05 |");
  console.log("|---|---|---:|---|");
  console.log(`| the mean of the frames | ${mMean.map(f).join(" ")} | ${f(median(mMean))} | ${median(mMean) <= 1.05 ? "within" : "OVER"} |`);
  console.log(`| the mean of their faster half | ${mLow.map(f).join(" ")} | ${f(median(mLow))} | ${median(mLow) <= 1.05 ? "within" : "OVER"} |`);
  console.log(`| the median (information: whole timer steps) | ${mP50.map(f).join(" ")} | ${f(median(mP50))} | |`);
  console.log(`| the p95 (information) | ${mP95.map(f).join(" ")} | ${f(median(mP95))} | |`);

  // 3. The lap that takes every shortcut, beside the shipped tracks' own laps of the same run.
  const dearMean = (r: number) => Math.max(...LAPS.map((k) => got[k][r].mean)), dearLow = (r: number) => Math.max(...LAPS.map((k) => got[k][r].lowMean));
  const sMean = got[S8].map((x, r) => x.mean / dearMean(r)), sLow = got[S8].map((x, r) => x.lowMean / dearLow(r));
  console.log("\n**3. The lap that takes every shortcut against the shipped tracks' own laps (budget 1.05 over the dearest of them, run by run).** Its frames have no twin without shortcuts that is a lap of a road: over the road without them they pass over bare ground (below, as information).\n");
  console.log("| S8 against the dearest of the three shipped S4 laps of the run | run by run | median ratio | budget 1.05 |");
  console.log("|---|---|---:|---|");
  console.log(`| the mean of the frames | ${sMean.map(f).join(" ")} | ${f(median(sMean))} | ${median(sMean) <= 1.05 ? "within" : "OVER"} |`);
  console.log(`| the mean of their faster half | ${sLow.map(f).join(" ")} | ${f(median(sLow))} | ${median(sLow) <= 1.05 ? "within" : "OVER"} |`);
  const gMean = ratio(S8, OVER_GROUND, (x) => x.mean), gLow = ratio(S8, OVER_GROUND, (x) => x.lowMean);
  console.log(`\nInformation: S8 against its own frames over the road without shortcuts (bare ground under the shortcuts' stretches, its cars off any road there, which the dust's lookup then searches for along the whole track every frame: not a like for like): the means ${f(median(gMean))}, the faster halves ${f(median(gLow))}.`);
  console.log(`\n${ua}`);
  const second = median(mMean) <= 1.05 && median(mLow) <= 1.05, third = median(sMean) <= 1.05 && median(sLow) <= 1.05;
  if (RUNS < 5) {
    console.log(`\nNo verdict: ${RUNS} run${RUNS > 1 ? "s" : ""} (five make one).`);
    return 2;
  }
  console.log(`\nThe rule: the fly-through is within its budget if its medians are at most 1.10 times the cheapest S2's (1). If they are not and a lap sits on a step of the timer above S2 without any shortcut (of the three shipped tracks' own laps and Branch Yard's without shortcuts, ${lapsOver} of 4 are over 1.10 too), it is held against the same frames without shortcuts instead: the main road's lap at most 1.05 times the same lap without them (2), and the lap through every shortcut at most 1.05 times the dearest shipped lap of the same run (3), each on the mean of the frames and on the mean of their faster half.`);
  const ok = first || (lapsOver > 0 && second && third);
  console.log(`Verdict: ${ok ? "WITHIN" : "OVER"}. (1) ${first ? "within" : "over"}: S8 ${f(worst[S8])}, the main road's lap ${f(worst[MAIN])} against the cheapest S2. (2) ${second ? "within" : "OVER"}: ${f(median(mMean))} and ${f(median(mLow))}. (3) ${third ? "within" : "OVER"}: ${f(median(sMean))} and ${f(median(sLow))}.`);
  return ok ? 0 : 1;
}

// ---- what a tile costs to bake (no browser) ---------------------------------------------------------

function units(t: Track): void {
  const plain = buildTrack({ ...t.def, id: `${t.def.id}-plain`, features: (t.def.features ?? []).filter((f) => f.k !== "branch") });
  // The tiles a view has in it along a road.
  const along = (roads: Track[]): [number, number][] => {
    const keys = new Set<string>();
    for (const r of roads) {
      for (let s = 0; s <= r.length; s += 40) {
        const p = pointAt(r, s);
        const x = p.x * ZOOM, y = p.y * ZOOM;
        for (let ty = Math.floor((y - VIEW_H / 2) / TILE); ty <= Math.floor((y + VIEW_H / 2) / TILE); ty++) for (let tx = Math.floor((x - VIEW_W / 2) / TILE); tx <= Math.floor((x + VIEW_W / 2) / TILE); tx++) keys.add(`${tx},${ty}`);
      }
    }
    return [...keys].map((k) => k.split(",").map(Number) as [number, number]);
  };
  const measure = (track: Track, list: [number, number][]): { mean: number; median: number; most: number; ms: number } => {
    const us: number[] = [], ms: number[] = [];
    for (const [tx, ty] of list) {
      bakeTileIndices(track, tx, ty); // once unmeasured: the compilers
      let u = 0, took = 0;
      bakeTileIndices(track, tx, ty, (_step, cost, t0) => {
        u += cost;
        took += t0;
      });
      us.push(u);
      ms.push(took);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return { mean: mean(us), median: median(us), most: Math.max(...us), ms: mean(ms) };
  };
  const mainTiles = along([t]), cutTiles = along(t.branches.map((b) => b.road));
  console.log("\nBake units a tile (Node; each tile baked to the end twice, the second time measured):\n");
  console.log("| tiles | how many | units a tile: mean | median | most | ms a tile here: mean |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [what, track, list] of [
    ["a lap of the main road, without shortcuts", plain, mainTiles],
    ["the same tiles, with them", t, mainTiles],
    ["along the shortcuts, with them", t, cutTiles],
    ["the same tiles, without them", plain, cutTiles],
  ] as const) {
    const m = measure(track, list);
    console.log(`| ${what} | ${list.length} | ${m.mean.toFixed(0)} | ${m.median.toFixed(0)} | ${m.most.toFixed(0)} | ${m.ms.toFixed(3)} |`);
  }
  console.log("\n(A frame bakes ahead for 220 units, or 1500 while a tile in view is missing: a dearer tile takes more frames, not a longer one.)");
}

// ---- rule 1 on Branch Yard (no browser) -------------------------------------------------------------

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: ProfileNode[];
}

/** One theme, in this process: Renderer.frame with six cars taking every shortcut. */
async function allocOne(t: Track, theme: Theme): Promise<void> {
  const { Session } = await import("node:inspector/promises");
  nodeDom();
  const { worldStats } = await import("../../client/gfx/world");
  const { Renderer } = await import("../../client/render");
  const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
  const WARM = option("--warm", 30000), FRAMES = option("--frames", 6000), INTERVAL = option("--interval", 128);
  const SPEED = 430, DT = 1000 / 60;
  const track = themedTrack(t, theme);
  // The way round that takes every shortcut, a frame at a time: its points, and the road's half-width there.
  const legs: { road: Track; from: number; to: number }[] = [];
  let at = 0;
  for (const b of [...t.branches].sort((p, q) => p.s0 - q.s0)) {
    legs.push({ road: t, from: at, to: b.s0 }, { road: b.road, from: 0, to: b.road.length });
    at = b.s1;
  }
  legs.push({ road: t, from: at, to: t.length });
  const xs: number[] = [], ys: number[] = [], hs: number[] = [], halves: number[] = [];
  for (const leg of legs) {
    for (let s = leg.from; s < leg.to; s += SPEED / 60) {
      const p = pointAt(leg.road, s);
      xs.push(p.x);
      ys.push(p.y);
      hs.push(p.h);
      halves.push(leg.road.def.halfWidth);
    }
  }
  const lap = xs.length;
  const session = new Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  const sink: unknown[] = new Array(1024).fill(null);
  const r = new Renderer(quietCanvas(null) as unknown as HTMLCanvasElement, track);
  const cars = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"].map((color, i) => ({ id: `c${i}`, x: 0, y: 0, h: 0, color, name: `car ${i}`, me: i === 0, wreck: false, ghost: false, car: (["sport", "racer", "truck"] as const)[i % 3] }));
  const fx = { shots: [], mines: [], sparks: [], rt: 0 };
  const times = new Float64Array(1);
  let frameNo = 0, control = false;
  const drive = (n: number): void => {
    for (let i = 0; i < n; i++, frameNo++) {
      const k = frameNo % lap;
      for (let c = 0; c < cars.length; c++) {
        const j = (k + lap - c * 9) % lap;
        // On the verge every other lap (the dust), else spread over the asphalt.
        const lane = ((frameNo / lap) | 0) & 1 ? halves[j] + 14 : ((c - 2.5) * halves[j]) / 4;
        cars[c].x = xs[j] - Math.sin(hs[j]) * lane;
        cars[c].y = ys[j] + Math.cos(hs[j]) * lane;
        cars[c].h = hs[j];
      }
      fx.rt = frameNo;
      times[0] = 10000 + frameNo * DT;
      r.follow(xs[k], ys[k], DT, false, "c0");
      r.frame(cars, fx, null, times[0]);
      if (control) sink[frameNo & 1023] = { a: frameNo, b: k, c: 1, d: 2 };
    }
  };
  const sample = async (): Promise<{ inside: number; outside: number; rows: [string, number][] }> => {
    await session.post("HeapProfiler.startSampling", { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    drive(FRAMES);
    const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as { profile: { head: ProfileNode } };
    const charged = new Map<string, number>();
    let inside = 0, outside = 0;
    const walk = (node: ProfileNode, owner: string): void => {
      const f = node.callFrame;
      const cut = f.url.includes("node_modules") ? -1 : f.url.lastIndexOf("/client/");
      const here = cut < 0 ? owner : `${f.url.slice(cut + 8)} ${f.functionName || "(anonymous)"}`;
      if (node.selfSize > 0) {
        if (here) {
          const key = cut < 0 ? `${here} > ${f.functionName || "(anonymous)"}` : here;
          charged.set(key, (charged.get(key) ?? 0) + node.selfSize);
          inside += node.selfSize;
        } else outside += node.selfSize;
      }
      for (const c of node.children ?? []) walk(c, here);
    };
    walk(profile.head, "");
    return { inside, outside, rows: [...charged].sort((a, b) => b[1] - a[1]) };
  };
  drive(WARM);
  const baked0 = worldStats.baked;
  const plain = await sample();
  const baked = worldStats.baked - baked0;
  control = true;
  drive(2000);
  const withControl = await sample();
  const f1 = (x: number) => (x / FRAMES).toFixed(1);
  console.log(`| ${theme} | ${lap} | ${baked} | **${f1(plain.inside)}** | ${f1(plain.outside)} | client/ ${f1(withControl.inside)}, outside ${f1(withControl.outside)} | ${plain.rows.length ? plain.rows.slice(0, 6).map(([k, b]) => `${k} ${f1(b)}`).join("; ") : "nothing"} |`);
  session.disconnect();
}

/** Each theme in a process of its own (no theme's compiled code or heap is another's). */
function alloc(): void {
  const self = fileURLToPath(import.meta.url);
  const pass = args.filter((a, i) => ["--warm", "--frames", "--interval"].includes(a) || ["--warm", "--frames", "--interval"].includes(args[i - 1]));
  console.log("# Rule 1 on Branch Yard: bytes a frame allocates (tools/debug/branch-sheet.ts --alloc)\n");
  console.log("Renderer.frame, six cars round the way that takes every shortcut at 430 u/s (on the verge every other lap); warm frames first, then 6000 measured (--warm, --frames); V8's sampling heap profiler, objects collected since included.\n");
  console.log("| theme | frames a lap | tiles baked while measured | client/ bytes a frame | outside | the same with the control (an object a frame) | charged to |");
  console.log("|---|---:|---:|---:|---:|---:|---|");
  for (const theme of THEMES) process.stdout.write(execFileSync(process.execPath, [...process.execArgv, self, "--alloc-one", theme, ...pass], { encoding: "utf8", maxBuffer: 16 << 20 }));
}

// ---- main -----------------------------------------------------------------------------------------

const track = testTrack("branch-yard")!;
const PORT = Number(arg("--port") ?? 3011);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)));
let code = 0;
try {
  if (args.includes("--alloc-one")) await allocOne(track, arg("--alloc-one") as Theme);
  else if (args.includes("--alloc")) alloc();
  else if (args.includes("--units")) units(track);
  else if (args.includes("--shots")) await shots(track, PORT);
  else if (args.includes("--bench")) code = await bench(PORT);
  else {
    if (args.includes("--tiles")) tileSheet(track);
    probe(track);
    console.log("");
    lists(track);
    layout(track);
    await dust(track);
    await movers();
    console.log(failed ? `\n${failed} check(s) failed.` : "\nEvery check holds.");
    code = failed ? 1 : 0;
  }
} finally {
  await cleanup();
}
process.exit(code);
