// Track registry: every track a room can race on, by id. The server builds a room's track
// from here and the client builds the same one from the room's trackId, so both sides run
// the same geometry. Add a track by adding one entry to SHIPPED.

import { buildTrack, RUST_BOWL, type Track, type TrackDef } from "./track";

export interface TrackEntry {
  id: string; // stable id on the wire ({t:"track"}, room.trackId)
  name: string; // display name in the lobby
  def: TrackDef;
}

export const DEFAULT_TRACK_ID = "rust-bowl";

const SHIPPED: TrackEntry[] = [{ id: DEFAULT_TRACK_ID, name: RUST_BOWL.name, def: RUST_BOWL }];

const entries = new Map<string, TrackEntry>(SHIPPED.map((e) => [e.id, e]));
const built = new Map<string, Track>(); // built once per id; a Track is never mutated

/** Every selectable track, in lobby order. */
export function trackList(): TrackEntry[] {
  return [...entries.values()];
}

export function isTrackId(id: unknown): id is string {
  return typeof id === "string" && entries.has(id);
}

/** Display name for an id; the id itself when it is unknown. */
export function trackName(id: string): string {
  return entries.get(id)?.name ?? id;
}

/** The built track for an id, or null when the id is unknown. */
export function findTrack(id: string): Track | null {
  const e = entries.get(id);
  if (!e) return null;
  let t = built.get(id);
  if (!t) {
    t = buildTrack(e.def);
    built.set(id, t);
  }
  return t;
}

/** The built track for a known id; throws on an unknown one. */
export function trackById(id: string): Track {
  const t = findTrack(id);
  if (!t) throw new Error(`Unknown track ${id}`);
  return t;
}

/**
 * Tests only: add a track to the registry of this process (an in-process server and its
 * bots see it too). The shipped registry is SHIPPED above.
 */
export function registerTestTrack(id: string, name: string, def: TrackDef): void {
  if (entries.has(id)) throw new Error(`Track ${id} is already registered`);
  entries.set(id, { id, name, def });
}
