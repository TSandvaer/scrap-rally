// Puddles (M4-WORLD; user decisions 2026-11-21): does the baked world keep what
// client/gfx/puddle-shape.ts promises? No browser.
//
//   npx tsx tools/debug/puddle-probe.ts            Preview Yard and the contact sheet's own yard
//   npx tsx tools/debug/puddle-probe.ts --detail   a line per miss (up to 20 a puddle)
//
// A water pool and a dirt patch are rectangles in a track's data. The world draws each as a
// puddle inside that rectangle (gfx/world.ts puddleEdge), and what a car is to feel (M4-SURF) is
// the rectangle less PUDDLE_TRACTION_INSET on every side (tractionRect). The promise: all of
// the traction rectangle is drawn as the puddle. Per puddle of every test track, the tiles under
// it are baked and every pixel is looked at where its middle lies on the track (distance along,
// offset across: shared/track.ts queryTrack, not the bake's own arithmetic):
// - every pixel inside the traction rectangle is the puddle's (water, or dirt), or is hidden
//   under something that stands or lies on the puddle (a tyre mound, the ramp truck, a press's
//   bed), or, for dirt, is off the road (dirt is drawn on asphalt and kerb; the verge is loose
//   ground already);
// - no pixel of the puddle lies outside its declared rectangle (its bounds);
// - how much of the declared rectangle the puddle fills, how much of the puddle the traction
//   rectangle covers, and how near the puddle's edge comes to the traction rectangle at its
//   nearest (world units; the bake's sampling is a pixel, 1.25 units).
// And the three original shipped tracks have no pixel of water or of a dirt patch at all (M4-TRACKS: the
// two long shipped tracks, Slag Harbour and Breaker's Mile, have puddles: they are probed like the test
// tracks).
// The theme surfaces (TH-LOOK-2; PLAN-THEMES.md 2.3) are puddles as well and are held to the same
// promise: a sand patch (a desert track's, Track.sand) and an oil slick (a city track's, Track.oil),
// each drawn inside its declared rectangle with all of its traction rectangle the surface's own
// pixels. A track is probed in its own theme, as the game draws it; a ford (a jungle track's) has no
// look yet (TH-LOOK-3) and is not probed.
// Exit code 1 if a pixel breaks a promise.

import { PUDDLE_TRACTION_INSET, tractionRect, type PuddleRect } from "../../client/gfx/puddle-shape";
import { bakeTileKinds, KIND, TILE, ZOOM } from "../../client/gfx/world";
import { TEST_TRACKS, testTrack } from "../../shared/testtracks";
import { pointAt, queryTrack, type Track } from "../../shared/track";
import { trackById, trackList } from "../../shared/tracks";
import { sheetYard } from "./world-sheet/yard";

const DETAIL = process.argv.includes("--detail");
let failed = false;

/** The tiles of a track under a rectangle of it (track coordinates), `pad` world units more all round. */
function tilesUnder(track: Track, r: PuddleRect, pad: number): [number, number][] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let s = r.s0 - pad; s <= r.s1 + pad + 6; s += 6) {
    for (const lat of [r.lat0 - pad, r.lat1 + pad]) {
      const p = pointAt(track, s);
      const x = (p.x - Math.sin(p.h) * lat) * ZOOM, y = (p.y + Math.cos(p.h) * lat) * ZOOM;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const out: [number, number][] = [];
  for (let ty = Math.floor((y0 - 2) / TILE); ty <= Math.floor((y1 + 2) / TILE); ty++) for (let tx = Math.floor((x0 - 2) / TILE); tx <= Math.floor((x1 + 2) / TILE); tx++) out.push([tx, ty]);
  return out;
}

function probe(track: Track): void {
  const kinds = new Map<string, Uint8Array>();
  const kindsOf = (tx: number, ty: number): Uint8Array => {
    let k = kinds.get(`${tx},${ty}`);
    if (!k) kinds.set(`${tx},${ty}`, (k = bakeTileKinds(track, tx, ty)));
    return k;
  };
  const puddles: { what: string; kind: number; rect: PuddleRect }[] = [
    ...track.water.map((w) => ({ what: "water", kind: KIND.water as number, rect: w })),
    ...track.dirt.map((d) => ({ what: "dirt", kind: KIND.dirt as number, rect: d })),
    ...track.sand.map((d) => ({ what: "sand", kind: KIND.sand as number, rect: d })),
    ...track.oil.map((d) => ({ what: "oil", kind: KIND.oil as number, rect: d })),
  ];
  console.log(`\n## ${track.def.name}: ${track.water.length} pools, ${track.dirt.length} dirt patches${track.sand.length || track.oil.length ? `, ${track.sand.length} sand patches, ${track.oil.length} oil slicks` : ""}\n`);
  if (!puddles.length) return;
  console.log("| puddle (s0..s1 x lat0..lat1) | declared | puddle fills | traction rect | of the puddle | traction pixels | not the puddle's | nearest the edge comes | puddle pixels outside its bounds |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const { what, kind, rect } of puddles) {
    const t = tractionRect(rect);
    let declared = 0, drawn = 0, inTraction = 0, misses = 0, hidden = 0, outside = 0, nearest = Infinity;
    const lines: string[] = [];
    for (const [tx, ty] of tilesUnder(track, rect, 16)) {
      const k = kindsOf(tx, ty);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const is = k[y * TILE + x];
          const wx = (tx * TILE + x + 0.5) / ZOOM, wy = (ty * TILE + y + 0.5) / ZOOM;
          const q = queryTrack(track, wx, wy);
          const inRect = q.s >= rect.s0 && q.s <= rect.s1 && q.lat >= rect.lat0 && q.lat <= rect.lat1;
          if (is === kind) {
            // Another puddle of the kind may lie in the same tiles: only what is nearer this rectangle than 16 units is held against it.
            const far = Math.max(rect.s0 - q.s, q.s - rect.s1, rect.lat0 - q.lat, q.lat - rect.lat1);
            if (far > 16) continue;
            drawn++;
            if (!inRect) {
              outside++;
              if (DETAIL && lines.length < 20) lines.push(`  outside its bounds: s=${q.s.toFixed(2)} lat=${q.lat.toFixed(2)} (${far.toFixed(2)} out)`);
            }
          }
          if (!inRect) continue;
          declared++;
          const inT = q.s >= t.s0 && q.s <= t.s1 && q.lat >= t.lat0 && q.lat <= t.lat1;
          // What may lie where the puddle would be: something on it, or (dirt) ground off the road.
          const over = is === KIND.solid || is === KIND.bed || is === KIND.isle || is === KIND.belt || (kind === KIND.dirt && (is === KIND.verge || is === KIND.barrier || is === KIND.rail || is === 0));
          if (inT) {
            inTraction++;
            if (is !== kind) {
              if (over) hidden++;
              else {
                misses++;
                if (DETAIL && lines.length < 20) lines.push(`  in the traction rect but kind ${is}: s=${q.s.toFixed(2)} lat=${q.lat.toFixed(2)}`);
              }
            }
          } else if (is !== kind && !over) {
            // Ground inside the bounds that is not the puddle's: how near the traction rectangle does it come?
            const ds = Math.max(t.s0 - q.s, q.s - t.s1, 0), dl = Math.max(t.lat0 - q.lat, q.lat - t.lat1, 0);
            nearest = Math.min(nearest, Math.hypot(ds, dl));
          }
        }
      }
    }
    const area = (r: PuddleRect) => (r.s1 - r.s0) * (r.lat1 - r.lat0);
    const ok = misses === 0 && outside === 0;
    if (!ok) failed = true;
    console.log(
      `| ${what} ${rect.s0}..${rect.s1} x ${rect.lat0}..${rect.lat1} | ${rect.s1 - rect.s0} x ${rect.lat1 - rect.lat0} | ${((100 * drawn) / declared).toFixed(0)} % | ${t.s1 - t.s0} x ${t.lat1 - t.lat0} = ${((100 * area(t)) / area(rect)).toFixed(0)} % of declared | ${((100 * inTraction) / drawn).toFixed(0)} % | ${inTraction} (${hidden} under something on it) | ${misses}${misses ? " FAIL" : ""} | ${Number.isFinite(nearest) ? nearest.toFixed(2) : "-"} | ${outside}${outside ? " FAIL" : ""} |`,
    );
    for (const l of lines) console.log(l);
  }
}

console.log(`# Puddle probe: the baked world against tractionRect (inset ${PUDDLE_TRACTION_INSET} units)`);
const ORIGINAL = ["rust-bowl", "crusher-run", "overpass-knot"];
const long = trackList().filter((e) => !ORIGINAL.includes(e.id)).map((e) => trackById(e.id));
for (const track of [...TEST_TRACKS.map((d) => testTrack(d.id)!), sheetYard(), ...long]) probe(track);

// The three original shipped tracks: nothing of this on them.
console.log("\n## Shipped tracks (the three original ones)\n");
for (const id of ORIGINAL) {
  const track = trackById(id);
  let wet = 0, tiles = 0;
  const seen = new Set<string>();
  for (const p of track.pts) {
    const tx = Math.floor((p.x * ZOOM) / TILE), ty = Math.floor((p.y * ZOOM) / TILE);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${tx + dx},${ty + dy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tiles++;
        for (const k of bakeTileKinds(track, tx + dx, ty + dy)) if (k >= KIND.dirt) wet++;
      }
    }
  }
  if (wet) failed = true;
  console.log(`${wet ? "FAIL" : "ok  "}  ${track.def.name}: ${wet} pixels of water, dirt patch or any other furniture in its ${tiles} tiles`);
}
console.log(failed ? "\nFAILED" : "\nAll promises kept.");
if (failed) process.exit(1);
