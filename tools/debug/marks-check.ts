// Track marks check: do scorches and tyre marks keep their promises (client/gfx/world.ts,
// "track marks")? No browser: the World draws on canvases that keep their pixels.
//
//   npx tsx tools/debug/marks-check.ts            every check on the three tracks; exit code 1 if one fails
//
// What is checked, per track:
// - stamp = put back: the tiles in view after marks were stamped on them one by one show the
//   same colours as the same tiles baked afresh with the kept marks put on; and so do their
//   canvases, pixel for pixel (the uploaded rectangles left nothing out);
// - a mark bakes nothing: no tile is baked for the marks made;
// - only the palette, only darker: a marked pixel is a palette colour no lighter than before;
// - keep off: no pixel of a gap's void, a pit's floor or the barrier changes;
// - given away and baked again: after a lap (every tile evicted) the view shows the kept marks again;
// - the ring: of 200 scorches the last 128 come back, the first 72 do not;
// - clearing: after clearMarks() the tiles in view are the plain bake again within 24 frames,
//   and a mark made right after the clearing is there;
// - another track: a World for another track clears the marks.

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = resolve(fileURLToPath(new URL("../..", import.meta.url)));
class FakeImageData {
  data: Uint8ClampedArray;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
(globalThis as unknown as { ImageData: unknown }).ImageData = FakeImageData;
interface FakeCanvas { width: number; height: number; px?: Uint32Array; getContext?: () => unknown }
const canvases: FakeCanvas[] = [];
const blits: { src: FakeCanvas; x: number; y: number }[] = [];
const makeCtx = (canvas: FakeCanvas) => ({
  fillStyle: "",
  globalAlpha: 1,
  drawImage(src: FakeCanvas, x: number, y: number) {
    blits.push({ src, x, y });
  },
  fillRect() {},
  putImageData(img: FakeImageData, dx: number, dy: number, sx = 0, sy = 0, sw = img.width, sh = img.height) {
    canvas.px ??= new Uint32Array(canvas.width * canvas.height);
    const src = new Uint32Array(img.data.buffer);
    for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) canvas.px[(dy + y) * canvas.width + dx + x] = src[y * img.width + x];
  },
  getContextAttributes: () => ({ willReadFrequently: true }),
});
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => {
    const c: FakeCanvas = { width: 0, height: 0 };
    const ctx = makeCtx(c);
    c.getContext = () => ctx;
    canvases.push(c);
    return c;
  },
};
const load = (file: string) => import(pathToFileURL(resolve(HERE, file)).href);
const { World, MARK, scorch, skid, clearMarks, markStats, worldStats, bakeTileIndices, bakeTileMarked, poolTileIndices, SCORCHES, ZOOM, VIEW_W, VIEW_H, TILE } = await load("client/gfx/world.ts");
const { palette32 } = await load("client/gfx/palette.ts");
const { trackById } = await load("shared/tracks.ts");
const { pointAt } = await load("shared/track.ts");
const PAL32: Uint32Array = palette32();
const lum = Array.from(PAL32, (v) => 0.299 * (v & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * ((v >> 16) & 255));

let failed = 0;
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failed++;
};
const same = (a: Uint8Array, b: Uint8Array): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

for (const id of ["rust-bowl", "crusher-run", "overpass-knot"]) {
  console.log(`\n${id}`);
  const track = trackById(id);
  const view: FakeCanvas = { width: VIEW_W, height: VIEW_H };
  let world = new World(makeCtx(view), track);
  const hw = track.def.halfWidth as number;
  const at = (s: number, lat: number) => {
    const p = pointAt(track, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h as number };
  };
  // Where: a feature if the track has one (a pit, a gap's end), else a bend.
  const spot: number = track.holes.length ? track.holes[0].s + 40 : track.gaps.length ? track.gaps[0].s0 - 30 : 700;
  const c = pointAt(track, spot);
  const ox = Math.round(c.x * ZOOM) - VIEW_W / 2, oy = Math.round(c.y * ZOOM) - VIEW_H / 2;
  const frame = (snap = false, x = c.x, y = c.y): void => {
    blits.length = 0;
    world.aim(x, y, 1000 / 60, snap);
    world.draw(Math.round(x * ZOOM) - VIEW_W / 2, Math.round(y * ZOOM) - VIEW_H / 2, []);
  };
  const tiles: [number, number][] = [];
  for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + VIEW_H - 1) / TILE); ty++) for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + VIEW_W - 1) / TILE); tx++) tiles.push([tx, ty]);
  const scorchAt = (s: number, lat: number): void => {
    const p = at(s, lat);
    MARK[0] = p.x;
    MARK[1] = p.y;
    scorch(track);
  };
  const skidAlong = (s: number, lat: number, n: number): void => {
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const p = at(s + i * 7, lat + i * 1.5), h = p.h + 0.45;
      const cos = Math.cos(h), sin = Math.sin(h);
      const cur = [p.x - cos * 9 + sin * 6, p.y - sin * 9 - cos * 6, p.x - cos * 9 - sin * 6, p.y - sin * 9 + cos * 6];
      if (prev) {
        MARK.set([prev[0], prev[1], cur[0], cur[1], prev[2], prev[3], cur[2], cur[3]]);
        skid(track);
      }
      prev = cur;
    }
  };
  const marksEverywhere = (): void => {
    // On the road, the kerb, the verge, against the wall, on a feature if there is one, across tile borders.
    for (let k = -8; k <= 8; k++) scorchAt(spot + k * 37, ((k * 53) % (2 * track.wall)) - track.wall);
    for (const h of track.holes) scorchAt(h.s, 0), scorchAt(h.s + h.r, 6);
    for (const g of track.gaps) scorchAt(g.s0 - 4, 0), scorchAt(g.s0 + 12, hw * 0.5), scorchAt(g.s1 + 3, -hw * 0.4);
    for (let k = -3; k <= 3; k++) skidAlong(spot + k * 80 - 60, -hw + ((k + 3) * hw) / 3, 14);
    for (const g of track.gaps) skidAlong(g.s0 - 90, 0, 16);
  };
  const shown = (tx: number, ty: number): Uint8Array | null => poolTileIndices(track, tx, ty);
  const canvasOf = (tx: number, ty: number): FakeCanvas | undefined => blits.find((b) => b.x === tx * TILE - ox && b.y === ty * TILE - oy)?.src;
  const canvasDiff = (tx: number, ty: number, want: Uint8Array): number => {
    const px = canvasOf(tx, ty)?.px;
    if (!px) return want.length;
    let d = 0;
    for (let i = 0; i < want.length; i++) if (px[i] !== PAL32[want[i]]) d++;
    return d;
  };

  clearMarks();
  frame(true);
  const plain = new Map(tiles.map(([tx, ty]) => [`${tx},${ty}`, bakeTileIndices(track, tx, ty)]));
  frame(true); // bakeTileIndices dropped nothing that was needed, but be sure the view is whole
  const baked0 = worldStats.baked, uploads0 = markStats.uploads, pixels0 = markStats.pixels, made0 = markStats.scorches + markStats.skids;
  marksEverywhere();
  frame();
  const made = markStats.scorches + markStats.skids - made0;
  check(worldStats.baked === baked0, `a mark bakes nothing: ${made} marks made, ${worldStats.baked - baked0} tiles baked for them; ${markStats.uploads - uploads0} rectangles uploaded, ${markStats.pixels - pixels0} pixels in all (a tile is ${TILE * TILE})`);

  // Stamp = put back, and the canvases agree.
  const live = new Map(tiles.map(([tx, ty]) => [`${tx},${ty}`, shown(tx, ty)]));
  let diff = 0, canvasWrong = 0, changed = 0, lighter = 0, offChanged = 0, off = 0, missing = 0;
  for (const [tx, ty] of tiles) {
    const key = `${tx},${ty}`;
    const now = live.get(key);
    if (!now) {
      missing++;
      continue;
    }
    const again: Uint8Array = bakeTileMarked(track, tx, ty);
    const keep: Uint8Array = bakeTileMarked(track, tx, ty, true);
    const before = plain.get(key)!;
    diff += same(now, again);
    for (let i = 0; i < now.length; i++) {
      if (now[i] !== before[i]) {
        changed++;
        if (now[i] > 31 || lum[now[i]] > lum[before[i]]) lighter++;
        if (keep[i] === 255) offChanged++;
      }
      if (keep[i] === 255) off++;
    }
  }
  frame(); // bakeTileMarked dropped the job under way, if any; draw again for the canvases
  for (const [tx, ty] of tiles) canvasWrong += canvasDiff(tx, ty, live.get(`${tx},${ty}`) ?? new Uint8Array(TILE * TILE));
  check(missing === 0 && diff === 0, `stamp = put back: ${tiles.length} tiles in view, ${diff} pixels differ between the tiles stamped one mark at a time and the same tiles baked afresh with the marks put on (${changed} pixels marked)`);
  check(canvasWrong === 0, `the canvases show it: ${canvasWrong} canvas pixels differ from the tiles' colours`);
  check(changed > 0 && lighter === 0, `only the palette, only darker: ${lighter} of ${changed} marked pixels are off the palette or lighter than before`);
  check(offChanged === 0, `keep off: ${offChanged} of ${off} pixels of void, pit floor and barrier in view changed`);

  // Given away and baked again: a lap, then back.
  const bakedLap = worldStats.baked, back0 = markStats.putBack;
  const lap = Math.ceil((track.length / 430) * 60);
  for (let i = 1; i <= lap; i++) {
    const p = pointAt(track, spot + (i * 430) / 60);
    frame(false, p.x, p.y);
  }
  frame(true);
  let lapDiff = 0;
  for (const [tx, ty] of tiles) lapDiff += same(shown(tx, ty) ?? new Uint8Array(TILE * TILE), live.get(`${tx},${ty}`)!);
  let lapCanvas = 0;
  for (const [tx, ty] of tiles) lapCanvas += canvasDiff(tx, ty, live.get(`${tx},${ty}`)!);
  check(worldStats.baked - bakedLap > 24 && lapDiff === 0 && lapCanvas === 0, `given away and baked again: after a lap (${worldStats.baked - bakedLap} tiles baked, ${markStats.putBack - back0} marks put back on the way) the view differs in ${lapDiff} pixels from before, its canvases in ${lapCanvas}`);

  // Clearing; a mark made right after it stays. Tiles are wiped one a frame: the pool holds 24.
  clearMarks();
  scorchAt(spot, 0);
  const wiped0 = markStats.wiped;
  let frames = 0;
  for (; frames < 24; frames++) frame();
  let clearDiff = 0, clearCanvas = 0, kept = 0;
  for (const [tx, ty] of tiles) {
    const want: Uint8Array = bakeTileMarked(track, tx, ty);
    kept += same(want, plain.get(`${tx},${ty}`)!);
    clearDiff += same(shown(tx, ty) ?? new Uint8Array(TILE * TILE), want);
  }
  frame();
  for (const [tx, ty] of tiles) clearCanvas += canvasDiff(tx, ty, shown(tx, ty)!);
  check(clearDiff === 0 && clearCanvas === 0 && kept > 0 && kept < 1100, `clearing: ${frames} frames after clearMarks() the view is the plain bake but for the one scorch made right after it (${kept} pixels): ${clearDiff} pixels differ, ${clearCanvas} on the canvases (${markStats.wiped - wiped0} tiles wiped, one a frame)`);

  // The ring: 200 scorches along the track, a lap, and the last 128 are back.
  clearMarks();
  for (let i = 0; i < 12; i++) frame();
  const places: [number, number][] = [];
  for (let i = 0; i < 200; i++) {
    const p = at(spot + 300 + i * 41, ((i * 29) % 60) - 30);
    places.push([Math.round(p.x * ZOOM), Math.round(p.y * ZOOM)]);
    MARK[0] = p.x;
    MARK[1] = p.y;
    scorch(track);
  }
  for (let i = 1; i <= lap; i++) {
    const p = pointAt(track, spot + (i * 430) / 60);
    frame(false, p.x, p.y);
  }
  let back = 0, gone = 0;
  for (let i = 0; i < 200; i++) {
    const [x, y] = places[i];
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const marked: Uint8Array = bakeTileMarked(track, tx, ty);
    const bare: Uint8Array = bakeTileIndices(track, tx, ty);
    // The scorch's own middle: is it marked? (A pixel or two of a middle may lie on the barrier: look at a few.)
    let hit = false;
    for (let d = -2; d <= 2 && !hit; d++) {
      const px = x - tx * TILE + d, py = y - ty * TILE;
      if (px >= 0 && px < TILE && marked[py * TILE + px] !== bare[py * TILE + px]) hit = true;
    }
    if (i < 200 - SCORCHES) gone += hit ? 0 : 1;
    else back += hit ? 1 : 0;
  }
  check(back === SCORCHES && gone >= 200 - SCORCHES - 3, `the ring: of 200 scorches the last ${SCORCHES} are kept (${back} found), the first ${200 - SCORCHES} are not (${gone} gone; one under a later scorch still shows as marked)`);

  // Another track: its World clears the marks.
  frame(true);
  scorchAt(spot, 10);
  frame();
  const other = trackById(id === "rust-bowl" ? "crusher-run" : "rust-bowl");
  new World(makeCtx({ width: VIEW_W, height: VIEW_H }), other);
  world = new World(makeCtx(view), track);
  for (let i = 0; i < 30; i++) frame(i === 0);
  let trackDiff = 0;
  for (const [tx, ty] of tiles) trackDiff += same(shown(tx, ty) ?? new Uint8Array(TILE * TILE), plain.get(`${tx},${ty}`)!);
  check(trackDiff === 0, `another track: after a World for ${other.def.id ?? "another track"} was made, this track's view is the plain bake again (${trackDiff} pixels differ)`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed.");
process.exitCode = failed ? 1 : 0;
