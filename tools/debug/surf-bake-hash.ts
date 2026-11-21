// surf-bake-hash (M4-SURF, ClickUp 123jpnbffyz): proves moving PUDDLE_TRACTION_INSET and
// tractionRect from client/gfx/puddle-shape.ts into shared/track.ts left the baked world's pixels
// alone. For the Preview Yard and every shipped track it bakes every tile the road touches
// (client/gfx/world.ts bakeTileIndices: the palette index of every pixel) and prints a sha256 per
// track. Run it on the commit before the move and after it: the hashes must be equal. No browser.
//
//   npx tsx tools/debug/surf-bake-hash.ts

import { createHash } from "node:crypto";
import { bakeTileIndices, TILE, ZOOM } from "../../client/gfx/world";
import { testTrack } from "../../shared/testtracks";
import { pointAt, type Track } from "../../shared/track";
import { trackById, trackList } from "../../shared/tracks";

/** Every tile within the walls (plus a margin) of a track, in a fixed order. */
function tilesOf(t: Track): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (let s = 0; s < t.length; s += 20) {
    const p = pointAt(t, s);
    for (let lat = -t.wall - 40; lat <= t.wall + 40; lat += 20) {
      const x = (p.x - Math.sin(p.h) * lat) * ZOOM, y = (p.y + Math.cos(p.h) * lat) * ZOOM;
      const k = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([Math.floor(x / TILE), Math.floor(y / TILE)]);
    }
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

const tracks: Track[] = [testTrack("preview-yard")!, ...trackList().map((e) => trackById(e.id))];
for (const t of tracks) {
  const h = createHash("sha256");
  const tiles = tilesOf(t);
  for (const [tx, ty] of tiles) h.update(bakeTileIndices(t, tx, ty));
  console.log(`${t.def.id.padEnd(15)} ${tiles.length} tiles  ${h.digest("hex")}`);
}
