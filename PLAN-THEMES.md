# PLAN-THEMES: track surroundings (desert, city, jungle, scrapyard) — DRAFT (pending Fable review and the user's approval)

**Why.** The user decided on 2026-11-22 (team/DECISIONS.md:137): three new themes (desert, city, jungle) beside today's scrapyard; a
theme changes the looks and adds theme surfaces with their own feel; each track's theme is fixed in its definition; the new tracks
get their themes when the art lands; Rust Bowl, Crusher Run and Overpass Knot stay scrapyard and byte-identical. This plan replaces
"per-track colour themes: out of scope" (PLAN-GFX.md:206). Drafted by an Opus planner on main 4282640 (M4-MOVE and TOUCH-6 merged;
M4-TRACKS in `shared/longtracks.ts` and BR-SCHEMA in flight; author cap 3, CLAUDE.md:15).

## 1. Current state
- **Data.** `TrackDef` has no field for looks (shared/track.ts:134-145). The client builds the same def from the room's trackId
  (shared/tracks.ts:1-3), so a new def field reaches the client with no protocol change.
- **The bake.** Tiles hold palette indices turned into pixels through one table (client/gfx/world.ts:5-7, :799-808, :1548-1552).
  Pixels where track marks can land store level x 32 + colour (32 colours); pixels that take no marks (the OFF bit) can use 64
  (:2525-2548). The bake writes named role colours: ground (:1089-1140), barrier/verge/kerb/tarmac bands (:1276-1299), junk heaps
  (:453-476), posts (:530-552), dirt and water (:1730-1785). The art is built once per track (:336-345); the tile pool is module-level
  and keyed by track (:32-33, :54-55).
- **Sprites.** One 512x256 obstacle sheet whatever the track, repainted when another track draws (obstacles.ts:11-18,
  sprites.ts:1023-1031). Barrels use rust tones (obstacles.ts:263-267); the press slab is hazard-striped (:307).
- **Dust and marks.** Dust only off the asphalt, two fixed tones `P.bone0`/`P.bone1` (actors.ts:648, :758-768); skid/scorch marks
  recoloured through a palette-derived table (world.ts:2527-2548); the placeholder tile is `P.dirt2` (:2979).
- **Minimap.** HUD palette; one 108x108 map per track drawn in the session (hud.ts:78-81, :320, :465-467).
- **Surfaces.** Water, dirt and belts in per-segment buckets (track.ts:727-733, `surfaceAt` :849); `stepCar` applies their
  multipliers (physics.ts:191-226); water scales every force along the car, drag included, by `WATER_FORCE` (physics.ts:97-110); bots
  cost lanes with `laneCost` (botdrive.ts:392, :417-421); the only surface sound is gravel off the asphalt (sfx.ts:826-839,
  soundlogic.ts:772-789).
- **Census (run on main by the planner).** 14,132,440 B of the 16,000,000 B cap; one minimap per track incl. the 4 test tracks
  (canvas-census.ts:100, :154). **Its HUD allowance check already fails:** 1,942,744 B against `HUD_BYTES_MAX` 1,900,000
  (canvas-cap.ts:18); it is not part of npm test. Every new track adds a 46,656 B minimap.

## 2. Design
### 2.1 Data
- New `shared/theme.ts`: `Theme = "scrapyard" | "desert" | "city" | "jungle"`, `THEMES`, `isTheme`, `themeOf(def) = def.theme ??
  "scrapyard"`.
- `TrackDef` gains `theme?: Theme`. The shipped defs never get the field; `buildTrack` ignores it; `validateTrack` rejects an unknown
  theme; the theme never enters physics (only features do); schema-hash hashes built arrays and behaviour, not defs (schema-hash.ts:2-17),
  so the goldens do not change.
- The Renderer constructor (render.ts:176-183) resolves the theme once and hands it to World, Actors and the obstacles; a theme whose art
  has not landed draws as scrapyard.

### 2.2 Looks (Fable)
1. **A palette per theme:** the same 32 role names, dark-to-light ramps and SHADE/LIT links (palette.ts:85-110), own colours; plus water
   and up to 31 extra colours for no-mark pixels (barrier, props). Soot, bone, hazard and signal stay fixed in every theme (pits,
   chevrons, lips, stripes). Tarmac may only be tinted and must pass a contrast check against the mine and rivet sprites. Scrapyard uses
   today's table objects.
2. **Dressing per theme:** ground speck mix, verge texture, kerb pattern, barrier paint, post sprite, props outside the walls, gap void,
   pit rim.
3. **Rule: a theme changes what is painted, never where.** Bands (world.ts:65-71), post spacing, feature outlines, traction rects and
   collision stay shared code, so BR-BAKE's mouths and posts work with any theme.
4. Cars, effects, cells, obstacle sprites and the HUD keep the global 32 colours. Barrels, press, truck and mounds pick per-theme tones
   from those 32; the press slab keeps its stripes; no prop uses one of the six car colours (palette.ts:195).
5. The minimap is unchanged (readable; BR-MAP owns hud.ts).
6. Dust tones and the placeholder colour are chosen per theme when the Renderer is built.
**Memory:** no new canvas; the tile pool holds one track (one theme) at a time; the obstacle sheet is repainted per track; palette tables
~1.5 KB of typed arrays per theme (JS heap, not canvas); census growth only 46,656 B per new test track.

**Art direction (all original)**
- **Desert, "noon on the dunes":** pale ochre sand with sparse wind-ripple dashes; a grit verge; terracotta and bone kerbs; a
  sandstone-block barrier. Props: rock outcrops, dry scrub, round succulents, half-buried car shells. Gap: a layered canyon. Water: a
  muddy flash-flood pool with a cracked rim. Dirt: red clay hardpan, never sand-coloured.
- **City, "old harbour quarter":** building roofs with vents, shadowed alleys; a paved sidewalk verge with slab joints; grey and white
  kerb stones; a concrete barrier with amber reflector studs. Props: planter trees, crates, cones, parked cars in muted non-car colours.
  Gap: a street below. Water: a rain puddle with a drain grate. Dirt: roadworks with a taped border. The cosmetic oil blots are dropped,
  so an oil slick is unmistakable.
- **Jungle, "overgrown":** dark loam and leaf litter; a moss verge with roots; mossy stone kerbs; a log rail with lashings. Props: tree
  crowns (never reaching past the barrier), ferns, fallen logs, a vine-hung wall fragment. Gap: a river gorge. Water: tea-brown. Dirt:
  black wet mud.

| Feature | Desert | City | Jungle |
|---|---|---|---|
| Tyre mound, island nose | sandbags | strapped tyre bundle | bamboo bale |
| Rolling barrels | scoured drums | orange-white traffic drums | log sections |
| Press | ore stamp | pile driver | log stamper |
| Ramp truck | sand hauler | car carrier | logging truck |

### 2.3 Theme surfaces (Opus; one must-have per theme)
- Shape like water and dirt: `{k, s0, s1, lat0, lat1}` (a ford also has `vx`), felt inside `tractionRect` (track.ts:495-503). Static,
  per-segment buckets; CarState/CarSnap get no new field, so prediction is exact.

| Kind | Model in `stepCar` | Sport / Racer / Truck | Bot `laneCost` |
|---|---|---|---|
| **sand** (desert), "bogs you, keeps your line" | drag x (1 + 0.55·(dirtDrag - 1)), grip x 0.8 | top speed 210 / 177 / 323 u/s | the drag factor - 1 |
| **oil** (city), "steering goes, brakes stay" | grip x dirtGrip x 0.25, turn x 0.4, every force along the car unchanged | grip x 0.093 / 0.075 / 0.15 | 1.8 x sqrt(Sport's grip / type's) |
| **ford** (jungle), "aim upstream" | the belt's drift (physics.ts:221-226) + drag x (1 + 0.3·(dirtDrag - 1)), grip x 0.7 | top speed 274 / 242 / 364 u/s | the drag factor - 1 |

- Fits advisor change 4 (PLAN-M4): sand and ford change drag only, as dirt does; oil leaves the forces along the car alone; nothing scales
  the throttle without the drag.
- Car types: each new surface's multipliers come from the type's dirt multipliers, the way water's `WATER_GRIP_OF_DIRT` does
  (physics.ts:109), so `CarStats`, shared/cars.ts and `statsFor` (shop.ts:61) stay untouched; explicit fields in `CARS` only if the taste
  gate asks for one type to break the pattern.
- Validation: water's rules for all three (inside the walls and zones, no overlap with another surface, track.ts:1592-1616; off take-off
  zones and recovery points, :1767-1780); each kind only on its own theme's tracks; sand <= 350 long (the user's mud rule,
  PLAN-M4.md:427-429); oil: water's dry-lane-or-straight rule (:1781-1789) and <= 200 long; ford 40-160 long, 20 <= |vx| <= 100, on a
  straight, no solid within 80 past it. Run-ups through any of them are driven by `validateRunUps`/`validateJumpSweep` for every type
  at L0/L3.
- Sound (later): sand a softer gravel crackle; ford a splash then a wash; oil the tyre noise drops out. Later candidates: salt pan, tram
  rails, root mat.

### 2.4 Byte identity and performance
- Shipped tracks: the new kinds only add code paths; today's arithmetic is unchanged ("x 1 is exact", physics.ts:199), the same for
  `laneCost`. Proved by schema-hash --check (15/15 now, 25/25 after M4-TRACKS), the M4-HARD bot-stream goldens, surf-bake-hash,
  `npm run bench -- --pixels --vs-ref main` at 0 px, world-shots at 0 px.
- Speed: `npm run bench -- --vs-ref gfx-baseline` must PASS (the theme record read once per tile, outside the pixel loops); new scene S7
  in bench.ts and world-bench.ts (S6's views plus an S4 lap on each themed yard, each <= S2 x 1.10, bake units per tile printed); Rule 1:
  bake-alloc and world-alloc 0 B per frame.
- Census: no new kind of canvas, total <= 16 MB; fix the HUD allowance by counting the shipped minimaps plus one test track (5.90 + 6.29 +
  2.2 = 14.39 MB with an allowance of 2.2 MB).

### 2.5 Test tracks and taste
- One yard per theme (the theme is data and the surfaces are theme-gated): Dune Yard, Block Yard, Canopy Yard, on `PREVIEW_YARD.control`
  (testtracks.ts:19), picked with `SCRAP_DEV_TRACK` (room.ts:62-77). Each has its theme surface twice, water with a dry lane, a mound
  pair, barrels, a truck, a press and a split with <= 350 units of dirt, and >= 600 units of plain road between groups.
- Preview override: a looks-only `&theme=` switch in the preview to try the art on the shipped layouts (never in the game).
- Taste gates: a contact sheet, shots at 1280x720 and 390x844@3; the user drives each yard and each themed new track on the Mac.

### 2.6 New tracks and order
- Breaker's Mile -> desert (its long straights a desert highway, the chasm a canyon). Slag Harbour -> city (the dockside, PLAN-M4.md:138,
  becomes a harbour quarter). Jungle waits for the next new track, designed for the theme.
- M4-TRACKS ships both without a theme; THEME-SCHEMA sets the field (looks only, goldens unchanged); THEME-TRACKS adds the surfaces later.
- world.ts sharing: TH-LOOK-1 takes the free Fable slot now; BR-BAKE starts once BR-SCHEMA and the open TH-LOOK ticket have both merged;
  no new TH-LOOK ticket starts between BR-SCHEMA's merge and BR-BAKE's merge.

## 3. Tickets
Every ticket's gate: `npm run check`, `npm test` twice, `npm run build`, shipped `schema-hash --check` unchanged. Fable tickets also: the
speed gate, S7, the census, Rule 1, `surf-bake-hash`, 0 px on the shipped scenes.

**Wave A (now, in the third author slot)**
- **TH-LOOK-1 (Fable): the theme machinery and the desert look.** Owns `client/gfx/theme.ts` (new), palette.ts, world.ts, obstacles.ts,
  actors.ts, render.ts, preview.ts, bench.ts, `tools/debug/theme-sheet.ts` (new), world-bench.ts, canvas-census.ts, canvas-cap.ts. Until
  THEME-SCHEMA adds the typed field it reads the optional `def.theme` without editing shared code. Accept: scrapyard at 0 px with identical
  index hashes; a desert contact sheet of every feature, band and prop; no tile uses a colour outside the theme's tables and the fixed
  colours are exact; S7 on Preview Yard via the override; the census fixed and passing. Taste: the sheet, plus Rust Bowl and Crusher Run
  in desert (preview override only).

**Wave B (after BR-SCHEMA and M4-TRACKS merge; before BR-PHYS, about half a day)**
- **THEME-SCHEMA (Opus).** Owns `shared/theme.ts` (new); track.ts (the field, the sand/oil/ford types, structural validation, theme
  gating); testtracks.ts (the 3 yards); longtracks.ts (the two themes); schema-hash.ts (yards hashed separately); its own sim-test section.
  Accept: one test per validation rule broken; the yards validate; shipped and new-track hashes unchanged.

**Wave C:** BR-PHYS and BR-BAKE in parallel, as planned; BR-BAKE also draws branches in desert.

**Wave D (beside BR-BOTS and BR-MAP)**
- **TH-LOOK-2 (Fable): the city look, plus the sand and oil looks.** Same files as TH-LOOK-1, plus puddle-probe.ts (the drawn outlines
  hold their traction rects). Taste: Block Yard and both new tracks.

**Wave E (after BR-BOTS; beside BR-TRACKS)**
- **THEME-SURF (Opus).** Owns track.ts (buckets, validation that needs physics), physics.ts, botdrive.ts, `tools/debug/theme-tune.ts`
  (new), its own sim-test and bots sections. Accept: clone parity on every yard; 3 bots per level and type finish each yard, identically
  on a rerun, <= 1 fall; socket bots median reconcile < 0.5; top speeds printed per type; M4-HARD goldens identical; the bot-step bound
  (PLAN-M4.md:208). Taste: the user drives the yards ("each surface has its own feel").
- **TH-LOOK-3 (Fable): the jungle look and the ford look**, with S7 on Canopy Yard.

**Wave F**
- **THEME-TRACKS (Opus).** In longtracks.ts: sand drifts on Breaker's Mile and an oil slick on Slag Harbour, in spaced groups; re-records
  only those two tracks' goldens; reports density and surface lengths. Taste: the user drives both tracks.
- **Later: THEME-SND (Opus)** on sfx.ts and soundlogic.ts, once BR-PHYS has merged and frees sfx.ts.

## 4. Risks, open questions, out of scope
**Risks:** world.ts carries BR-BAKE and three theme tickets in a strict series; hazards may read worse in some themes (mines on bleached
tarmac, holes in ochre ground); decoration can be taken for a hazard (oil blots, parked cars, sand spilled on the asphalt); heavier props
make the bake slower; only 32 colours where marks land; bots may struggle on oil in bends.

**Open questions (recommended answer first)**
1. One test yard per theme rather than one Theme Yard switched by a flag? **Yes, one yard per theme.**
2. Breaker's Mile desert, Slag Harbour city, jungle on the next new track? **Yes.**
3. Each theme surface only on its own theme's tracks? **Yes.**
4. THEME-SCHEMA before BR-PHYS (a half-day hold) or beside BR-BOTS (later themes on the new tracks)? **Before BR-PHYS.**
5. Should the minimap change with the theme? **No.**
6. Surface sounds now or later? **Later.**
7. Each car type's feel on the new surfaces derived from its dirt multipliers? **Yes.**
8. The census HUD allowance fails on main today; fix it by counting the shipped minimaps plus one test track? **Yes.**

**Out of scope:** weather, day/night, theme music, animated scenery, a theme picker, themed cars/HUD/menus, re-theming the shipped tracks,
a moving ford current.

## Advisor changes (binding; Fable 5.2 review 2026-11-22: "sound with changes"; override the text above)
1. **Palette tables per tile (its art), not per race:** `PAL32`/`PAL_OFF` (world.ts:799-808) and `MARKED`/`SHOWN_I`/`SHOWN` (:2527-2548)
   are module constants; the pool is LRU across tracks (`claim` :2456-2470; `tileAt` matches `t.home === art.tiles`), so "one theme at a
   time" is false; `sendMarks` repaints any pool tile through the one `SHOWN` (:2856-2862) and client/preview.ts:678 swaps tracks on one
   page. Arts are keyed `WeakMap<Track, Art>` (:336), so the `&theme=` override keys by track AND theme.
2. **`SHADE_I`/`LIT_I` are 64 entries per theme** (built from `PALETTE`, 33 entries, world.ts:91-92; the shadow pass `SHADE_I[v & 63] |
   (v & OFF)` at :1515 would turn any extra colour 33-63 in shadow into 0 = soot0).
3. **Per-theme SHADE, LIT and burn tones:** fixed colours shade into theme ramps in palette.ts (`bone0: "gravel0"`, `haz0: "dirt1"`, LIT
   `soot3: "dirt0"`); the burn tones are `DIRT0`/`DIRT1` (world.ts:2535-2536). Gate with `theme-sheet --check`: luminance SHADE <=
   colour <= LIT and charred < singed <= soot < base.
4. **Fix 2.2 item 4:** mounds and the truck are baked into tiles (world.ts:41-45, `C_SOLID` :118) and take theme-table colours; only the
   barrels and the press slab are sheet sprites on the global `fxPalette()` (obstacles.ts:322, sprites.ts:648-653).
5. **Census fix moved into M4-TRACKS** (orchestrator, 2026-11-22; its criterion 7 runs the census and its two tracks push the HUD to 9
   minimaps): derive the count from `trackList().length + 1`, update "a minimap for every track"; total <= 16 MB (fx-alloc.ts:252,
   looks-alloc.ts:248, fx-sheet.ts:260). Removed from TH-LOOK-1.
6. **Surfaces:** verge - `onRoad` is `q.dist <= halfOf` (physics.ts:194): require theme surfaces inside the asphalt, or define how they
   stack with `dirtDrag` on the verge. Oil dry lane - `widestDry` blocks water, islands, tyres and trucks only (track.ts:1507-1516): oil
   counts as blocked, and water as blocked for oil. Ford cue - "aim upstream" needs a baked direction cue (the belt's are animated arrows,
   obstacles.ts:14; animation is out of scope). Oil vs water - oil is nearly water (turn 0.4 vs `WATER_TURN` 0.5, grip 0.093 vs 0.123):
   `theme-tune` prints an A/B against water (exit slip angle, speed loss, lateral offset) before the taste gate.
7. **Sequencing:** the cap of 3 is full (M4-TRACKS, BR-SCHEMA, HARD-2): TH-LOOK-1 takes the first free slot. TH-LOOK-1 gates BR-BAKE, so
   it merges the machinery (scrapyard 0 px) with a PROVISIONAL desert and the art is judged later (its merge does not wait on the desert
   taste gate). THEME-SCHEMA builds the lists (`track.sand`, `oil`, `fords`) and their draw rects, because TH-LOOK-2 (wave D) draws them
   before THEME-SURF (wave E). THEME-SURF also owns testtracks.ts and shares schema-hash.golden.json with BR-TRACKS under the
   second-to-merge rule. Keep `Renderer(canvas, track)` (render.ts:176) with its two required arguments (main.ts:144, :967).
8. **`def.theme` before the field exists:** under `strict` `track.def.theme` does not compile; use one cast in one function in
   client/gfx/theme.ts with an `isTheme` guard (still compiles after THEME-SCHEMA); TH-LOOK-2 swaps to shared/theme.ts.
9. **Readability:** water stays blue-grey in every theme (the user's 2026-11-21 decision, palette.ts:6-9; tea-brown water beside black mud
   and a ford = three browns with three physics); voids stay soot-dominant with the fixed rim ("a street below" must not read as
   drivable); no decoration on tarmac in any theme; extend the numeric check to the six `CAR_COLORS` (palette.ts:195) against each
   theme's ground, verge and surfaces, plus rivets and cells, at 390x844@3.
10. **Gating in `validateSchema`'s surfaces block** (track.ts:1581, :1600-1602) via `themeOf(track.def)`; the existing yards are
   theme-less and unaffected.
Adopted suggestions: count contiguous sand plus dirt against the 350 rule; `&theme=` in the art key only in the preview.
Added open question 9: jungle and the ford ship on a yard only until a third new track exists - acceptable? **Recommended: yes.**
