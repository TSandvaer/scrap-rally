// The cap on canvas memory, for every tool that holds something against it.
//
// User decision 2026-11-21 (team/DECISIONS.md): 16 MB, counting everything the game makes: the
// sprite sheets, the world's tile pool, the HUD's label and font canvases, the catch-up art, the
// road's furniture. It replaces PLAN-GFX's 12 MB, which counted the sprites and the tiles only.
// tools/debug/canvas-census.ts counts every canvas there is against it. The tools that look at
// one part (fx-alloc, looks-alloc, fx-sheet --check) add what they do not look at as its most:
// the sprites' cap (sprites.ts SPRITE_BYTES_MAX), the tile pool (24 tiles of 256 x 256) and
// HUD_BYTES_MAX below, so all of them judge the same sum against the same number.

import { trackList } from "../../shared/tracks";

/** Canvas bytes (width x height x 4) the game may hold, all in. */
export const CANVAS_CAP = 16_000_000;

/** One minimap's canvas: 108 x 108 (client/gfx/hud.ts MAP; the census checks every minimap is that size). */
export const MINIMAP_BYTES = 108 * 108 * 4;

/**
 * The minimaps a session holds at its most (M4-TRACKS, coordinator 2026-11-22): one a shipped track
 * (shared/tracks.ts trackList(), so the allowance follows the registry), and one test track (the
 * dev-only SCRAP_DEV_TRACK puts one at a time in front of the player; off on Render).
 */
export const MINIMAPS = trackList().length + 1;

/**
 * The HUD's canvases but the minimaps, at their most: labels, name tags, centre texts, font sheets,
 * the hp bars and the catch-up cue art. M4-WORLD's allowance (1_900_000 with four minimaps: the three
 * shipped tracks then and Preview Yard) less those four minimaps.
 */
export const HUD_OTHER_MAX = 1_900_000 - 4 * MINIMAP_BYTES;

/**
 * The most the HUD's canvases hold: the canvases above and a minimap each for MINIMAPS tracks. Not a
 * pool's size but an allowance: the census counts them (with every pool full and every minimap a
 * session can hold) and fails if they are more.
 */
export const HUD_BYTES_MAX = HUD_OTHER_MAX + MINIMAPS * MINIMAP_BYTES;
