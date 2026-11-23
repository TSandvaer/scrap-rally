// A track's theme (THEME-SCHEMA, PLAN-THEMES.md 2.1): its surroundings, fixed in its definition
// (TrackDef.theme). The theme changes the looks (client/gfx, the TH-LOOK tickets) and which theme
// surfaces a track may carry (shared/track.ts validateTrack: sand on a desert track, oil on a city or
// a harbour one, a ford on a jungle one); it never enters physics, only the features do. A def without
// the field is the scrapyard: Rust Bowl, Crusher Run and Overpass Knot never get one. The harbour
// (HARBOUR-SCHEMA, PLAN-THEMES.md Amendment 1) is Slag Harbour's; the client draws a theme whose art
// has not landed (client/gfx/theme.ts LANDED) as the scrapyard.
//
// No runtime import of shared/track.ts here (it imports this file).

import type { TrackDef } from "./track";

export type Theme = "scrapyard" | "desert" | "city" | "jungle" | "harbour";

/** Every theme, today's scrapyard first. */
export const THEMES: readonly Theme[] = ["scrapyard", "desert", "city", "jungle", "harbour"];

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** A track's theme: its definition's, or the scrapyard when it names none. */
export function themeOf(def: Pick<TrackDef, "theme">): Theme {
  return def.theme ?? "scrapyard";
}
