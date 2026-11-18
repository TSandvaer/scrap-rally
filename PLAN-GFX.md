# PLAN-GFX: graphics polish (retro, no performance cost)

User request 2026-11-18: "Polish the graphics, keeping it retro and without compromising performance" + "Use fable for
graphics always" (plans, author workers and reviewers on claude-fable-5-2). Drafted by a Fable 5.2 planning agent.

Status: draft for Fable advisor review, then user approval. Nothing was measured: every cost below is an estimate, and
GFX-0 exists to replace the estimates with numbers. The drafter viewed 10 of the screenshots (crossing, hole, scrap, jump
apex, Rust Bowl, phone ramp, lobby, Esc menu, results, retired garage).

## 1. Current-look assessment

**World** (`client/render.ts`)
- **Mixed pixel sizes.** The world is drawn as anti-aliased vector strokes at zoom 0.8 (`ZOOM`, line 10; strokes 400-419),
  then upscaled pixelated. Barriers, kerbs and diagonals come out as soft smeared edges beside hard 1 px noise specks; it
  reads as "vector art, enlarged".
- **No depth on the barrier.** It is three flat concentric strokes (407-409) with no cast shadow, though junk and cars have
  one. The verge is a uniform noise band with a ruler-straight edge against the dirt (410).
- **Ground is one tiling pattern** (185, 365-366): no ruts, stains or patches, so the tile repeat is visible on wide dirt
  areas. The tarmac has no wear, racing line or joints.
- **Junk is thin and flat**: three kinds (four in gap piles), single flat fills with a translucent shadow (567-631), evenly
  scattered with a 26-unit exclusion (223).
- **Features use smooth gradients**: hole radial gradient (502-507), ramp linear gradient (520-524) and translucent earth
  walls (448-452) are the least retro pixels on screen.
- **The whole world is redrawn every frame.** Seven full-path strokes with patterns and dashes, unculled (407-419); per
  visible feature a `clip()` plus stripe polygons plus a new gradient object (481-484, 496-508, 516-526). This is both the
  look problem and the performance opportunity.

**Cars and effects**
- **Cars are about 14 rotated `fillRect`s** (644-695), 24x13 view pixels, anti-aliased by the rotation. The six colours
  differ only in body fill, with no shading ramp.
- **Wreck is a 62% dark overlay** (686-689); smoke is four alpha circles (697-705). No damage states, though `CarSnap.hp`
  already arrives for every car (`shared/protocol.ts:132`).
- **Rivet is an alpha round-cap line** (727-738). The spark is seven alpha lines and builds a colour string per spark per
  frame (740-752). A mine hit shows the same spark as a rivet hit (`client/main.ts:311`): no blast.
- **Shadows are translucent rectangles** (633-642), including under a jumping car. No dust, skid marks or landing effect.
- **Per-frame allocation today**: three `filter`s and a `sort` (373-375), `[...cars].sort` (784), template colour strings
  (639, 691, 702, 742), array literals (449, 543-544), and `sparks.filter` plus new fx arrays in `main.ts:767-773`.

**HUD (canvas)**
- All text is `fillText` in the system monospace (759, 801-869). It is anti-aliased at 640x360 then upscaled, so
  "LAP 1/3", the timer and name tags look fuzzy-blocky and differ per OS. Name tags call `measureText` every frame (762).
- The minimap restrokes its path twice per frame (776-783) on a plain translucent square with no frame.

**DOM UI** (`client/style.css`, `index.html`)
- Already coherent (rust, bone, hard offset shadows; `:root` lines 1-12). Unpolished: flat panels, system-dependent font
  (line 11), native `<select>` chrome, and 0.92-alpha panels (line 3) letting a moving track show through text.

## 2. Visual direction

- **Palette: fixed "scrapyard 32".** About 32 colours derived from today's `PAL` (render.ts 70-93) and `:root` variables.
  Our own palette, not a published one. Ramps of 3-4 steps for dirt, gravel, tarmac, steel, rust, bone and hazard yellow,
  plus one blast orange.
- **Car colours unchanged.** The six server colours (`server/room.ts:74`) stay; the client derives one shade and one
  highlight per colour. No server change.
- **Canvas and CSS share the palette** through one new file, `client/gfx/palette.ts`, mirrored in `:root`.
- **Lighting: one sun, top-left**, as shadows already imply (+3, +4). A 1 px highlight on top-left edges, a 1 px dark on
  bottom-right edges, hard cast shadows down-right. No gradients; depth is shown with 2-3 palette steps and ordered
  (Bayer 4x4) dither.
- **Signature 1: hard pixels.** The static world is baked into cached tiles and snapped to the palette once at bake time,
  so anti-aliased mush becomes clean pixel art. Cars and effects become pre-rendered sprites. Same shapes, same layout,
  crisper.
- **Signature 2: depth and memory.** A baked cast shadow along the barrier and junk. Stretch: decals stamped into the cached
  tiles (mine scorch, skid marks), so the track remembers the race at near-zero frame cost.

## 3. Polish items

Cost is relative to today's frame. Rd-risk is readability risk.

### A. World (new `client/gfx/world.ts`, extracted from render.ts)

| Item | What changes | Cost and how it stays cheap | Rd-risk |
|---|---|---|---|
| A1 Tile cache | Ground, decor, track, start line and features baked into 256x256 view-pixel tiles at the fixed 0.8 scale. A frame blits the 6-12 visible tiles. | Large saving: about 20 strokes, clips and gradients become at most 12 `drawImage`. The camera is already integer-snapped (360-361), so blits are 1:1. | None (same picture) |
| A2 Palette snap | At bake, each tile goes through a 15-bit RGB lookup table to the palette, with ordered dither on gradients. | Bake-time only, on one scratch canvas created with `willReadFrequently`. Zero per frame. | Low; kerb, hazard and chevron colours are exact palette entries |
| A3 Barrier depth | Barrier cast shadow, 1 px top-left highlight, posts every N units; ragged dithered gravel-to-dirt edge. | Baked, zero | Low; the wall gets more visible |
| A4 Surface wear | Seeded ruts and oil stains on dirt, a faint darker racing line, patch joints, grid-slot marks at the start. | Baked, zero | Medium: wear stays within two adjacent ramp steps so mines and holes still pop. Check with the hole and mine scenes |
| A5 Junk | Two-tone shading and hard shadows; 2-3 new original kinds (engine block, pallet, coiled wire); clustering into small heaps. | Baked, zero | None (outside the walls) |
| A6 Features | Hole, ramp and gap gradients become dithered steps. Chevrons, hazard lip and stripes keep exact colours and sizes. | Baked; removes per-frame clips and gradient objects | Checked scene by scene against the m3-t3 shots |

Tile cache mechanics:
- A fixed pool of 24 tile canvases (about 6 MB), allocated once and recycled least-recently-used.
- At most one bake per frame, started one tile ahead of the camera. Top speed 430 u/s is one new tile row every ~0.75 s.
- A camera snap (new renderer, spectate cut) bakes the visible set synchronously, once.
- One bake costs about one of today's track draws on a smaller clip, so the worst frame should stay at or under today's
  typical frame. The bench must prove this.

### B. Cars and effects (new `client/gfx/sprites.ts`)

| Item | What changes | Cost | Rd-risk |
|---|---|---|---|
| B1 Car sprites | Per colour, a sheet of 64 headings, pre-rendered from a higher-resolution master, downsampled and palette-snapped. Three-tone body, glass, lamps, visible wheels, 1 px dark outline. Built lazily per colour, cached at module level so it survives a `new Renderer`. | Saving: one `drawImage` instead of ~14 rects plus a rotate. Six colours at 64 frames of 40x40 is about 2.5 MB. | Medium: 5.6° heading steps. Fallback 128 headings. Ghost blink timing and alpha unchanged (650) |
| B2 Damage and wreck | Two extra sheets: "battered" (hp under 40%: dents, dark panel) and "burnt" (wreck: charred, 2-frame ember flicker). Driven by the existing `hp` and `wreck`. | Zero extra per frame | Low; a wreck must still read as that player's colour, so keep a colour stripe |
| B3 Shadows | Car shadow becomes the sprite's silhouette, hard-edged. A jumping car's shadow uses the same offsets (99-100). | Equal | None; jump height cue unchanged |
| B4 Rivet | Hard 3 px bright head plus two dimmer trailing pixels along the velocity. No stroke, no alpha. | Lower | Higher contrast on tarmac than today |
| B5 Hit spark and mine blast | Spark is a 6-frame sprite strip indexed by age. A mine hit (`w:"mine"`, already in the event) gets an 8-frame 32x32 blast strip plus the existing shake. | Lower; removes per-frame colour strings | Blast is 8 frames (~130 ms) and must not hide cars longer |
| B6 Mine | Pre-rendered sprite, two armed blink frames and one unarmed; same size and 250 ms blink; 1 px bright rim so it holds on worn tarmac. | Lower | At least as visible as today in the mine scene |
| B7 Smoke | Three dithered puff sprites replace the alpha circles; same motion. | Lower | None |
| B8 Dust and landing puff | Fixed pool of 48 particles in typed arrays, 2x2 px, emitted when a car is on the verge and on landing. | Small extra: up to 48 `fillRect` plus one `queryTrackNear` per car. Bench-gated. | Low; drawn under cars |
| B9 Decals (stretch) | A mine blast stamps a scorch into the cached tiles; a ring of the last 128 decals is restamped on tile re-bake. Skid marks stamp when lateral slip passes a threshold. | A stamp re-uploads one tile; cap one stamp per car per 2 frames. Cut if the bench fails. | Scorch visibly unlike a hole: no rim, lighter |

### C. HUD (new `client/gfx/font.ts`; `hud`, `nameTag`, `minimap` in render.ts)

| Item | What changes | Cost | Rd-risk |
|---|---|---|---|
| C1 Bitmap font | Our own 5x7 glyph set at 1x and 2x. Each HUD line cached in a small canvas keyed by its text, redrawn only when the text changes (the timer at 10 Hz). Name tags cached per name. | Lower: ~8 `drawImage` instead of 6-12 `fillText` and `measureText` | Names: the server's `cleanName` (`server/room.ts:124`) decides the character set. Cover Latin-1 incl. æøå; a missing glyph falls back to today's `fillText` for that label |
| C2 HUD panels | Same positions and sizes; 1 px bevel, hp bar with tick marks. | Baked backgrounds | None |
| C3 Minimap | Background, frame and track line baked once (108x108); start-line tick; own dot outlined in white; gap breaks kept. Removes the per-frame copy and sort. | Lower | Own dot easier to find |

### D. DOM skin (style.css, index.html only)

- **Opaque plate panels**: 1 px inset highlight and dark edge, corner rivets, a hazard-stripe header strip, all hard-stop
  gradients.
- **Controls**: custom `<select>` arrow, consistent focus ring, buttons with a pressed state.
- **Shared look** for the results and garage rows and the level pips.
- **Forbidden**: `backdrop-filter`, blur, animated shadows, layout transitions.
- **Cost**: zero per frame; opaque panels composite slightly cheaper than the 0.92 alpha.
- **Rd-risk**: text contrast at least as high as today; phone layouts (media queries at style.css 573, 847, 862, 1132)
  must not shift.

## 4. Performance budget and benchmark

**What exists today**
- `?debug=1` overlay lines (`main.ts:597-599`).
- `client/preview.ts`: fixed scenes with `&freeze=1` and `&t=`, loaded by dynamic import (`main.ts:786-791`), but with
  empty effects (`preview.ts:245`).
- The m3-t3 worker's pixel-diff method (`tmp/m3-t3-shots/REPORT.md`).
- No frame-time measurement exists.

**Add in GFX-0**
- **`?debug=1&bench=1`** in a new `client/bench.ts`, a dynamic import like preview, so it never ships in the main chunk.
- **Fixed scenes**, seeded with a fixed clock:
  - S1: Rust Bowl grid, 6 cars.
  - S2: Crusher Run feature cluster, 6 cars, one airborne, one falling, one ghost.
  - S3: firefight with 12 shots, 6 mines, 6 sparks, 2 wrecks, full HUD.
  - S4: full lap fly-through of each track at 430 u/s (the tile-bake worst case).
- **Metric A (synchronous)**: 600 calls of `renderer.frame()` per scene, each followed by a 1x1 `getImageData` to force
  rasterisation. Median, p95 and max in ms.
- **Metric B (paced)**: 600 `requestAnimationFrame` frames of S4. p95 interval and the count of frames over 20 ms.
- **Metric C (allocation)**: heap delta over 600 frames of S3 where `performance.memory` exists.
- **Output**: `window.scrapBench` and on screen. Run with agent-browser at 1280x720 and at 390 px, five alternating runs
  of the baseline build and the candidate build on the same machine; compare medians of medians.
- **Extra scenes** in `preview.ts`: fx, wreck, damage, mine. Baseline numbers committed in this file.

**Budget (pass or fail, per scene, per ticket)**
- Metric A median at or below baseline.
- Metric A p95 at or below baseline × 1.05 (noise allowance).
- S4 max at or below baseline S4 p95 × 1.5.
- Metric B over-20 ms count at or below baseline.
- Renderer construction at or below baseline + 50 ms.
- Total canvas memory added at or below 12 MB.

**Hard rules for workers**
1. Nothing in `Renderer.frame()` or below may allocate: no array or object literals, spreads, `filter`, `map`, `sort`
   copies, template strings, gradients, patterns, `Path2D`, `save`/`clip` or `getImageData`. Use scratch arrays, typed
   pools and pre-built sprites.
2. Every new visual is either baked (tile, sprite, cached label) or a `drawImage`/`fillRect` from a fixed pool with a
   stated cap.
3. No `shadowBlur`, `filter`, gradients or `globalCompositeOperation` changes per frame. `globalAlpha` only for the ghost
   and fall blinks.
4. Bench before and after go in the report. Any item that fails the budget is cut, not tuned later.

## 5. Tickets

Each is one Fable worker (author and reviewer on claude-fable-5-2). Shared acceptance for all four: `npm run check`,
`npm test` and `npm run build` green; no diff in `shared/` or `server/`; before and after screenshots at 1280x720 and
390 px.

**GFX-0: bench and fixtures** (small)
- Owns: `client/bench.ts` (new), `client/preview.ts`, the import hook lines in `client/main.ts`.
- Acceptance: bench runs on all three tracks and prints metrics A, B and C; two consecutive runs agree within 10% on
  medians; baseline table and baseline screenshots of all scenes committed to this plan; zero pixel diff on existing
  scenes.
- No taste gate.

**GFX-3: DOM skin** (parallel with GFX-0 or GFX-1)
- Owns: `client/style.css`, `index.html`. No `.ts` files.
- Acceptance: lobby, garage, Esc menu, pause, results and sound view shot before and after at both sizes; no layout shift
  on phone; none of the forbidden CSS properties present (grep); metric B on S1 with the lobby panel open at or below
  baseline.
- Taste gate: the user compares the screenshot pairs.

**GFX-1: world bake** (after GFX-0)
- Owns: `client/render.ts`, `client/gfx/world.ts`, `client/gfx/palette.ts` (new).
- First commit: a pure extraction of the world drawing into `world.ts` with zero pixel diff. Then A1 to A6.
- Acceptance: budget passes on every scene; every m3-t3 scene reshot, with ramps, gaps, holes, scrap, crossing shade and
  minimap breaks present; tile pool fixed at 24. No `?gfx=old` flag: the user gets a frozen copy of the build instead.
- Taste gate: the user drives the frozen copy on all three tracks, including on a phone.

**GFX-2: sprites, effects, HUD** (after GFX-1 merges; never parallel with it)
- Owns: `client/render.ts`, `client/gfx/sprites.ts`, `client/gfx/font.ts`, and `client/main.ts` for fx wiring
  (`w:"mine"`, pooled fx arrays, hp into `CarView`).
- Items: B1 to B8 and C1 to C3; B9 only if the budget still passes with it.
- Acceptance: budget passes; metric C heap delta at or below baseline; ghost blink timing identical (on and off frames at
  the same `t` as the m3-t3 shots); name tags correct for a name with æøå; mine, rivet and wreck scenes shot at both sizes.
- Taste gate: frozen copy, a race with bots (`npm run botplay`).

**Sequencing**
- Wave 1: GFX-0 and GFX-3 in parallel.
- Wave 2: GFX-1, with GFX-3 alongside if it is still open.
- Wave 3: GFX-2.
- `main.ts` is touched only by GFX-0 and then GFX-2; `render.ts` only by GFX-1 and then GFX-2.

## 6. Out of scope and open questions

**Out of scope**: physics, netcode, server, protocol, track layouts; zoom or camera changes; WebGL; integer-only canvas
scaling (the phone would letterbox to 1x); new tracks; touch-control redesign; audio; per-track colour themes.

**Open questions (drafter's recommendation in each)**
1. **Palette snap on the world (A2)?** The largest visible change: crisper, slightly grittier. Recommended: yes, judged on
   the GFX-1 frozen copy; a single bake-step toggle, so reverting is cheap.
2. **Car headings in 64 steps?** Authentic to the genre but visibly stepped in slow turns. Recommended: 64, with 128 as the
   fallback if it bothers the user at the taste gate.
3. **A pixel web font for DOM headings?** A self-hosted SIL OFL file, ~15-30 KB, the worker verifying and committing the
   licence. Recommended: no for now; system monospace in the DOM, our own bitmap font on the canvas only. Revisit after
   GFX-3.
4. **Persistent decals (B9)?** Recommended: mine scorch yes, skid marks only if the bench passes with margin; both are the
   first things cut.
5. **Phone check at the taste gates?** Headless numbers are a proxy. Recommended: the user drives the frozen copy on one
   real phone for GFX-1 and GFX-2, with the `?debug=1` frame time visible.
