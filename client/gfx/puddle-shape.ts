// The traction area of a puddle (M4-WORLD; user decisions 2026-11-21): moved by M4-SURF into
// shared/track.ts unchanged (PUDDLE_TRACTION_INSET, tractionRect, PuddleRect), where the physics
// reads it; the bake (client/gfx/world.ts) imports it from there. Re-exported here so the debug
// tools that import this file (tools/debug/puddle-probe.ts, world-sheet/page.ts) keep working.

export { PUDDLE_TRACTION_INSET, tractionRect, type PuddleRect } from "../../shared/track";
