// Room sound (PLAN-SOUND.md SND-4): the built-in sound defaults, the volume rules and the song
// ids, shared by the server (the host's room defaults) and the client (client/soundlogic.ts,
// client/audio.ts). The songs themselves live in client/music.ts; SONG_IDS must list the same
// ids as its SONGS registry, the default first (scripts/sim-test.ts checks it).

/** The song ids of client/music.ts SONGS, the default (Neon Tailpipe) first. */
export const SONG_IDS = ["neon-tailpipe", "rust-bucket", "mirrorball"] as const;
export type SongId = (typeof SONG_IDS)[number];
export const DEFAULT_SONG_ID: SongId = "neon-tailpipe";
/** The host's "Random" song choice: the server picks a song per race cycle. */
export const RANDOM_SONG = "random";
export type SongChoice = SongId | typeof RANDOM_SONG;

/**
 * The host's sound defaults for the room: every player hears these for the settings they have
 * not changed themselves. song is the host's choice (an id or "random"); the room message
 * carries the song being played beside it.
 */
export interface RoomSound {
  musicOn: boolean;
  music: number; // music volume 0..1
  effects: number; // effects volume 0..1
  song: SongChoice;
}

/**
 * The built-in defaults: every room starts with them, and the game uses them outside a room.
 * Music 0.4 (the user, 2026-11-18; it was 0.5 before SND-4: client/soundlogic.ts LEGACY_DEFAULTS).
 */
export const BUILTIN_SOUND: Readonly<RoomSound> = { musicOn: true, music: 0.4, effects: 0.8, song: DEFAULT_SONG_ID };

/** A volume in 0..1; anything that is not a finite number falls back. */
export function clampVolume(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** The volume step of the sliders (0..100, step 5): the server snaps the host's volumes to it. */
export const VOLUME_STEPS = 20;

/** A volume in 0..1 snapped to the nearest 0.05 (k / 20 is the same double as the slider's 5k / 100). */
export function snapVolume(v: number): number {
  return Math.min(1, Math.max(0, Math.round(v * VOLUME_STEPS) / VOLUME_STEPS));
}

export function isSongId(id: unknown): id is SongId {
  return typeof id === "string" && (SONG_IDS as readonly string[]).includes(id);
}

export function isSongChoice(id: unknown): id is SongChoice {
  return id === RANDOM_SONG || isSongId(id);
}
