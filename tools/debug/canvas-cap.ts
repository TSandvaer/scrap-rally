// The cap on canvas memory, for every tool that holds something against it.
//
// User decision 2026-11-21 (team/DECISIONS.md): 16 MB, counting everything the game makes: the
// sprite sheets, the world's tile pool, the HUD's label and font canvases, the catch-up art, the
// road's furniture. It replaces PLAN-GFX's 12 MB, which counted the sprites and the tiles only.
// tools/debug/canvas-census.ts counts every canvas there is against it. The tools that look at
// one part (fx-alloc, looks-alloc, fx-sheet --check) add what they do not look at as its most:
// the sprites' cap (sprites.ts SPRITE_BYTES_MAX), the tile pool (24 tiles of 256 x 256) and
// HUD_BYTES_MAX below, so all of them judge the same sum against the same number.

/** Canvas bytes (width x height x 4) the game may hold, all in. */
export const CANVAS_CAP = 16_000_000;

/**
 * The most the HUD's canvases hold: labels, name tags, centre texts, font sheets, minimaps, the
 * hp bars and the catch-up cue art. Not a pool's size but an allowance: the census counts them
 * (with every pool full and a minimap for every track there is) and fails if they are more.
 */
export const HUD_BYTES_MAX = 1_900_000;
