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

## Advisor changes (binding; Fable 5.2 review 2026-11-18: "sound with changes"; these override the text above)

1. **Memory budget.** Car sprite cells are 32x32, not 40x40 (the car is 24x13 px, 27 px diagonal), and one shared burnt sheet
   with a colour stripe instead of one per colour. Total added canvas memory stays at or below 12 MB (tile pool ~6.3 MB).
2. **Cars are not snapped to "scrapyard 32".** Blue, green and purple (server/room.ts:74) have no ramp there. Each car colour
   gets its own three tones plus shared neutrals. Acceptance: the main body pixel equals the server colour (the minimap dots
   and tag underlines use it, render.ts:765, 789).
3. **No global nearest-colour snap on edges (replaces A2's method).** Bake per layer with an alpha threshold, then composite;
   the lookup table is used only for fills and dither. Acceptance: no pixel on a kerb, hazard or chevron edge has a colour
   outside its two adjacent layers.
4. **Unbaked visible tiles.** A per-frame bake time cap with a plain dirt-colour placeholder tile, and pre-baking the
   destination during a fall (recovery), a respawn and a spectator leader switch (render.ts:337, main.ts:744-757). New bench
   scene S5: recovery teleport and leader cut.
5. **Tile pool is module-level, keyed by track.** `syncRenderer` builds a new Renderer per track change (main.ts:694-697) and
   preview.ts keeps two alive on one canvas (201-209); a per-instance pool would double or leak ~6 MB.
6. **Sprite placement and air/fall.** Sprites are blitted in view space at integer positions with an identity transform
   (never under the 0.8 world transform). The airborne scale up to 1.35x (render.ts:660), the fall shrink to 0.3x with
   tumble and darkening (655-657, 691) and the height-dependent shadow alpha (639) use pre-baked size steps or an allowed
   scaled `drawImage` (the worker picks, the reviewer checks); shadow and fall alpha are allowed (amends rule 3).
7. **Font coverage.** `cleanName` allows every Unicode letter and digit (`\p{L}\p{N}`, room.ts:125). Names also appear in HUD
   lines ("by NAME", the pause banner, main.ts:630-631). HUD strings need "—" (591, 593, 631) and "±" (600). A size table per
   HUD element, each at least as tall as today (the countdown is 52 px, render.ts:835). The per-label `fillText` fallback
   stays and is tested with a Cyrillic name.
8. **Non-integer scale.** A 390 px phone at 3x is ~1.83 device px per view px. Before/after shots at 390x844@3x, 844x390 and
   1440x900 for GFX-1 and GFX-2. Dither only in small areas (hole, ramp); dropped if it bands or moirés.
9. **Benchmark.**
   - GFX-0 confirms whether metric A's per-frame `getImageData` pushes Chrome onto its software canvas path; A and B run in
     separate page loads; the report states that A measures CPU raster.
   - Thresholds come from the measured noise: pass = at or below baseline + 2 x the measured run-to-run spread (replaces
     "median at or below baseline" and "p95 x 1.05"; GFX-3, CSS only, keeps a 5% p95 allowance).
   - "S4 max" is replaced by p99 and a count of frames over a set time.
   - Metric C is informational only; rule 1 (no allocation) is enforced by review, scoped to `Renderer` (main.ts draw() and
     hudView() allocate today regardless: main.ts:599-608, 719-721, 767-769).
   - Open question 5 becomes mandatory: the user checks one real phone at the GFX-1 and GFX-2 taste gates.
10. **Split GFX-2 and render.ts.** GFX-1's first zero-diff extraction commit also splits out `client/gfx/hud.ts` and
    `client/gfx/actors.ts`. GFX-2 becomes GFX-2a (cars and effects: B1-B8, the main.ts wiring; owns gfx/actors.ts, main.ts)
    and GFX-2b (font, HUD, minimap: C1-C3; owns gfx/hud.ts, gfx/font.ts), which own different files and can run in
    parallel. B9 (decals) becomes its own later ticket, GFX-4, only if wanted.
11. **Palette first.** `client/gfx/palette.ts` and the `:root` mirror move into GFX-0, with a palette sheet and one baked mock
    scene as an early taste gate before GFX-1 and GFX-3 build on it.
12. **Fixed geometry.** The minimap box (`VIEW_W - 112`) and the banner strip stay where they are (hard-coded in
    client/audio.ts:324 and client/chat.ts:13): acceptance for GFX-1, GFX-2b and GFX-3.

Adopted suggestions: heading hysteresis for remote cars (no flicker between two sprites under reconciliation noise); sample
the high-resolution car master nearest-neighbour into indexed colour, gated on a 64-frame contact sheet of one car before all
six; prefilter path segments per tile before stroking; spectator, pause and countdown scenes in preview.ts (no tests read
render output, so pixel-diff fixtures are the only regression net).

### Revised tickets and waves (supersedes section 5's split; its per-ticket acceptance still applies)

- **Wave 1:** GFX-0 (bench + fixtures + palette.ts + palette sheet + one baked mock scene; owns client/bench.ts,
  client/preview.ts, client/gfx/palette.ts, the main.ts import hook; taste gate: the user judges the palette sheet and mock
  scene) alone, or with GFX-3 once the palette is approved.
- **Wave 2:** GFX-1 (world bake; owns render.ts, gfx/world.ts, gfx/hud.ts + gfx/actors.ts as zero-diff extractions only) and
  GFX-3 (DOM skin; style.css, index.html; mirrors the approved palette) in parallel.
- **Wave 3:** GFX-2a (cars + effects) and GFX-2b (font + HUD + minimap) in parallel.
- **Later, optional:** GFX-4 decals (B9).

## User decisions (2026-11-18, popups; plan approved)

- **Approved** with the advisor changes above.
- **Car headings: 128 steps** (not 64). Memory: 128 x 32x32 cells = 0.5 MB per sheet; 6 colour sheets (3 MB) + "battered"
  as ONE shared overlay sheet drawn on top of the colour sprite (0.5 MB) + one shared burnt sheet (0.5 MB) + tile pool
  (~6.3 MB) = ~10.3 MB, inside the 12 MB cap. If the shared overlay looks wrong at the taste gate, per-colour battered
  sheets are allowed with the cap raised to 14 MB (reported, not silent).
- **Real-phone check: yes.** The user opens the frozen copy on a phone (LAN URL, `?debug=1`) at the GFX-1 and GFX-2a/2b
  taste gates.
- **Track marks (B9): include** as GFX-4 in this round, after GFX-2a (it stamps into GFX-1's tiles and uses GFX-2a's blast
  events). Mine scorch first; skid marks only if the bench passes with margin; both are cut if the budget fails.

## Baseline (GFX-0, measured 2026-11-18)

The numbers every later ticket is measured against, and how to get them again. Page: `client/bench.ts`
(`?debug=1&bench=1`, its own chunk); runner: `scripts/bench.ts` (`npm run bench`). Measured on the build of commit 9b29be5
(render.ts as on main at 3c6d247) on an Apple M5 Pro (18 cores), macOS 26.6.2, HeadlessChrome 152 driven by agent-browser
0.35.1, 5 us timer.

### Running it

```
npm run build && npm run bench -- --vs-ref main            # this build against main, runs alternating: the gate
npm run build && npm run bench                             # one build alone: the tables below (14.5 min here)
npm run build && npm run bench -- --quick --only S4        # one run, metric A, 1280x720: a look, no verdict
npm run build && npm run bench -- --pixels --vs-ref main   # pixel diff of the 16 preview scenes against main
npm run bench -- --help
```

- The runner serves the built `dist/` itself on 127.0.0.1 with cross-origin isolation, which gives the page a 5 us timer
  (a plain URL target works too, with Chrome's 100 us timer). `--vs-ref <ref>` builds that ref's client in a temp
  directory; no server of ours has to run.
- One cell (metric x scene x track) per page load, so no cell warms another's caches; five runs; with a baseline the two
  builds alternate cell by cell.
- By hand: `?debug=1&bench=1[&metric=A|B|C][&scene=S3&track=crusher-run]` prints the table on screen and fills
  `window.scrapBench` (without scene and track every cell runs in the one page: a quick look only). `&hold=<frame>` draws
  one frame of a scene and stops.
- Chrome is started with `--mute-audio`, no background throttling and precise heap sizes; sessions are named
  `<--session>-base` and `<--session>-this` and are closed at the end.

### Scenes

Fixed seed, fixed clock: frame i is drawn at 10 000 ms + i/60 s, and `performance.now()` is pinned to that clock while a
frame draws (the renderer reads it for the smoke, the mine blink and the shake). Six cars, the server's colours, names
including a 12-letter one, one with æøå and one in Cyrillic.

| Scene | What it draws | Frames |
|---|---|---:|
| S1 | The starting grid, nothing moving but the countdown digits; race HUD | 600 |
| S2 | A fixed camera on a jump: three cars take it in turn, one car falling, one ghost. Crusher Run: the chasm; Overpass Knot: the crossing, a car on the lower road; Rust Bowl has no features, so the same car states on its top straight | 600 |
| S3 | A fixed camera on a fight: 12 shots, 6 mines (4 armed), 6 sparks, 2 smoking wrecks, the full HUD with notice and banner, a shake every second. Crusher Run: at the first scrap pile; Overpass Knot: at the pit | 600 |
| S4 | A lap at 430 u/s, a pack of six, the camera with look-ahead as in a race | 1462 / 1596 / 1444 (Rust Bowl / Crusher Run / Overpass Knot) |
| S5 | The own car drives into a hazard, falls for 90 frames and is put back at the recovery point as a ghost; from frame 300 there is no own car and the camera follows the leader, which becomes a car far away at frames 300, 400 and 500. The camera eases as in `main.ts` | 600 |

### Metrics

- **A (the gate):** every frame of the cell once, synchronously, each followed by a 1x1 `getImageData`, on a canvas
  created with `willReadFrequently`, after 300 unmeasured warm-up frames on a Renderer of their own. Median, p95, p99 and
  the count of frames over 4 ms (advisor change 9: p99 and a count replace "S4 max"). It measures main-thread JS plus CPU
  raster. Each cell also gets a checksum (FNV-1a of every 50th frame's pixels and the last): equal checksums mean the
  same picture.
- **G (informational):** the same on a canvas pinned to the GPU (`willReadFrequently: false`): JS, GPU raster and the
  read-back. Closer to what a player's browser does, but noisier; watch S4 and S5 here for the cost of uploading freshly
  baked tiles, which A cannot see.
- **B:** 600 `requestAnimationFrame` frames of S4 on a default canvas with no read-back, after 60 warm-up frames, starting
  at s = 0 / 3000 / 4500 (Rust Bowl / Crusher Run / Overpass Knot) so that they cross the track's features. The interval
  between frames: median, p95 and the count over 20 ms; and how long the `frame()` call took. In its own page loads.
  `--b-scene S1 --panel lobby` plays S1 under the lobby panel (GFX-3's check).
- **C (informational):** S3, 600 frames: the sum of the per-frame increases of `usedJSHeapSize`, less what reading it
  costs. Bytes allocated per frame by `Renderer.frame()`; the scene's own objects are built beforehand.

### The budget rule

Baseline = the median of the five runs. Spread (the ± column) = max - min of the five runs; for a time it counts as at
least 1% of the baseline. **Limit = baseline + 2 x spread.** A build passes a cell when the median of its own five runs is
at or below the limit; the runner prints `ok` or `OVER`. Gate on metric A (median, p95, p99, frames over 4 ms) and on
metric B's count over 20 ms; construction stays "at or below baseline + 50 ms"; G and C are read, not gated.

**Gate on a same-session comparison (`--vs-ref main`), not on the numbers printed here.** The machine drifts by more
than the differences that matter (finding 4); alternating the two builds cell by cell is what cancels it. The tables
below say what this machine did on one afternoon.

### Findings

1. **The read-back does force the software canvas (advisor change 9: confirmed).** On a default canvas with the
   per-frame `getImageData`, S3 on Crusher Run has the checksum 5f5a8a58 and a 3.1 ms median; a canvas created with
   `willReadFrequently: true` gives the same checksum and 3.3 ms; a canvas pinned to the GPU gives another picture
   (2a003e34) and 1.0 ms (one load each, 100 us timer). Without any read-back a frame() call is 0.1 ms, since it only
   records, with single frames up to 72.7 ms when Chrome flushes. So metric A makes its canvas a software one outright
   instead of letting Chrome switch during the run, and it measures CPU raster. On the GPU canvas (G) the same frames
   take about a quarter to a half of A's time on this machine.
2. **Metric B is blunt in headless Chrome.** Every run, every track, both sizes: 16.665 ms median, 16.670 ms p95, no
   frame over 20 ms, no spread. Headless frames come off a 60 Hz timer; B shows dropped frames and nothing finer, and
   `frame()` itself takes 0.11 to 0.16 ms there. It guards against a stall; it cannot rank two smooth builds. The check
   on a real phone (User decisions) is what covers that.
3. **Metric A does not depend on the window size.** The checksums at 390x844@3 equal those at 1280x720 in all 15 cells,
   and the baselines differ by -4.8% to +4.2% (medians), which is inside the spread. Both tables are given; gate on
   either one.
4. **The noise.** The spread of A's median over five runs is 9.3% of the baseline in the middle cell (1.8% in the best,
   27.1% in the worst of the 30); 11.6% for p95, 13.1% for p99. It comes in spells of about a minute in which every cell
   runs 10 to 15% faster or slower. Hypothesis, not verified: other load on the machine's performance cores.
5. **The rule holds up against itself.** One build as both sides, five alternating runs of metric A at 1280x720: 0 of 60
   comparisons over the limit. The two sides' medians differed by -3.3% to +13.7% (median -0.5%), so a regression under
   roughly 10 to 15% of a cell's median can hide in the noise. That second session's medians were -2.7% to +6.5% (median
   +1.4%) from the first session's.
6. **A's checksum is a regression net.** All 15 cells gave one checksum over ten loads, and the same again in the second
   session. A refactor that must not change the picture has to reproduce it (the comparison prints it as "same
   picture"). G's checksum is not reliable: 1 of its 15 cells gave two values over ten loads.
7. **Today's renderer allocates** about 9.1, 15.9 and 8.9 kB per frame in S3 (Rust Bowl, Crusher Run, Overpass Knot).

### Metric A at 1280x720 (CPU raster, ms per frame)

| Scene | Track | median | ± | limit | p95 | ± | limit | p99 | ± | limit | >4 ms | ± | limit | checksum |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | rust-bowl | 1.665 | 0.135 | 1.935 | 1.800 | 0.195 | 2.190 | 1.920 | 0.165 | 2.250 | 0 | 0 | 0 | f8f36adf |
| S1 | crusher-run | 1.815 | 0.090 | 1.995 | 1.950 | 0.110 | 2.170 | 2.030 | 0.145 | 2.320 | 0 | 0 | 0 | fc0beede |
| S1 | overpass-knot | 1.700 | 0.140 | 1.980 | 1.940 | 0.180 | 2.300 | 2.010 | 0.200 | 2.410 | 0 | 1 | 2 | c5ffadae |
| S2 | rust-bowl | 2.030 | 0.550 | 3.130 | 2.275 | 0.520 | 3.315 | 2.380 | 0.490 | 3.360 | 0 | 0 | 0 | 64f99498 |
| S2 | crusher-run | 2.190 | 0.065 | 2.320 | 2.455 | 0.100 | 2.655 | 2.540 | 0.135 | 2.810 | 0 | 2 | 4 | 2d2279c4 |
| S2 | overpass-knot | 3.360 | 0.330 | 4.020 | 3.685 | 0.525 | 4.735 | 3.950 | 0.535 | 5.020 | 6 | 50 | 106 | 39cf913d |
| S3 | rust-bowl | 1.740 | 0.390 | 2.520 | 1.915 | 0.420 | 2.755 | 2.060 | 0.495 | 3.050 | 0 | 0 | 0 | 27a9f7cb |
| S3 | crusher-run | 3.165 | 0.105 | 3.375 | 3.480 | 0.300 | 4.080 | 3.545 | 0.470 | 4.485 | 2 | 3 | 8 | 5f5a8a58 |
| S3 | overpass-knot | 1.980 | 0.035 | 2.050 | 2.210 | 0.090 | 2.390 | 2.320 | 0.265 | 2.850 | 0 | 1 | 2 | 7fcdfb9c |
| S4 | rust-bowl | 1.950 | 0.290 | 2.530 | 2.360 | 0.375 | 3.110 | 2.500 | 0.380 | 3.260 | 0 | 2 | 4 | a5d6f149 |
| S4 | crusher-run | 1.955 | 0.115 | 2.185 | 2.715 | 0.450 | 3.615 | 3.065 | 0.315 | 3.695 | 1 | 1 | 3 | 2d6db32c |
| S4 | overpass-knot | 2.145 | 0.100 | 2.345 | 3.235 | 0.310 | 3.855 | 3.475 | 0.845 | 5.165 | 0 | 33 | 66 | 3f8f1545 |
| S5 | rust-bowl | 1.825 | 0.050 | 1.925 | 2.340 | 0.290 | 2.920 | 2.410 | 0.295 | 3.000 | 0 | 1 | 2 | bcc0ce7c |
| S5 | crusher-run | 2.065 | 0.185 | 2.435 | 2.695 | 0.475 | 3.645 | 2.865 | 0.440 | 3.745 | 0 | 2 | 4 | ccf31322 |
| S5 | overpass-knot | 1.965 | 0.165 | 2.295 | 2.280 | 0.190 | 2.660 | 2.445 | 0.160 | 2.765 | 0 | 0 | 0 | 90e674b6 |

### Metric A at 390x844@3 (CPU raster, ms per frame)

| Scene | Track | median | ± | limit | p95 | ± | limit | p99 | ± | limit | >4 ms | ± | limit | checksum |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | rust-bowl | 1.735 | 0.295 | 2.325 | 1.920 | 0.240 | 2.400 | 2.030 | 0.215 | 2.460 | 0 | 0 | 0 | f8f36adf |
| S1 | crusher-run | 1.795 | 0.375 | 2.545 | 2.045 | 0.330 | 2.705 | 2.135 | 0.390 | 2.915 | 0 | 0 | 0 | fc0beede |
| S1 | overpass-knot | 1.730 | 0.315 | 2.360 | 1.915 | 0.280 | 2.475 | 2.005 | 0.320 | 2.645 | 0 | 1 | 2 | c5ffadae |
| S2 | rust-bowl | 2.090 | 0.190 | 2.470 | 2.265 | 0.225 | 2.715 | 2.325 | 0.345 | 3.015 | 0 | 0 | 0 | 64f99498 |
| S2 | crusher-run | 2.145 | 0.145 | 2.435 | 2.425 | 0.125 | 2.675 | 2.530 | 0.155 | 2.840 | 0 | 0 | 0 | 2d2279c4 |
| S2 | overpass-knot | 3.450 | 0.385 | 4.220 | 3.805 | 0.655 | 5.115 | 4.100 | 0.765 | 5.630 | 13 | 36 | 85 | 39cf913d |
| S3 | rust-bowl | 1.760 | 0.110 | 1.980 | 2.025 | 0.205 | 2.435 | 2.095 | 0.220 | 2.535 | 0 | 0 | 0 | 27a9f7cb |
| S3 | crusher-run | 3.125 | 0.330 | 3.785 | 3.475 | 0.160 | 3.795 | 3.620 | 0.225 | 4.070 | 2 | 2 | 6 | 5f5a8a58 |
| S3 | overpass-knot | 1.885 | 0.260 | 2.405 | 2.175 | 0.280 | 2.735 | 2.255 | 0.295 | 2.845 | 0 | 1 | 2 | 7fcdfb9c |
| S4 | rust-bowl | 1.940 | 0.205 | 2.350 | 2.230 | 0.050 | 2.330 | 2.330 | 0.100 | 2.530 | 0 | 0 | 0 | a5d6f149 |
| S4 | crusher-run | 1.940 | 0.230 | 2.400 | 2.695 | 0.305 | 3.305 | 3.290 | 0.640 | 4.570 | 1 | 2 | 5 | 2d6db32c |
| S4 | overpass-knot | 2.125 | 0.155 | 2.435 | 3.220 | 0.380 | 3.980 | 3.405 | 0.490 | 4.385 | 0 | 3 | 6 | 3f8f1545 |
| S5 | rust-bowl | 1.840 | 0.175 | 2.190 | 2.240 | 0.145 | 2.530 | 2.380 | 0.115 | 2.610 | 0 | 1 | 2 | bcc0ce7c |
| S5 | crusher-run | 2.110 | 0.275 | 2.660 | 2.590 | 0.415 | 3.420 | 2.785 | 0.520 | 3.825 | 0 | 0 | 0 | ccf31322 |
| S5 | overpass-knot | 1.920 | 0.275 | 2.470 | 2.390 | 0.310 | 3.010 | 2.550 | 0.335 | 3.220 | 0 | 1 | 2 | 90e674b6 |

### Metric B (rAF-paced, ms between frames)

At 1280x720:

| Scene | Track | median | ± | limit | p95 | ± | limit | >20 ms | ± | limit | frame() median | ± | limit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S4 | rust-bowl | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.110 | 0.025 | 0.160 |
| S4 | crusher-run | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.155 | 0.085 | 0.325 |
| S4 | overpass-knot | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.130 | 0.030 | 0.190 |

At 390x844@3:

| Scene | Track | median | ± | limit | p95 | ± | limit | >20 ms | ± | limit | frame() median | ± | limit |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S4 | rust-bowl | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.105 | 0.020 | 0.145 |
| S4 | crusher-run | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.155 | 0.010 | 0.175 |
| S4 | overpass-knot | 16.665 | 0.167 | 16.998 | 16.670 | 0.167 | 17.003 | 0 | 0 | 0 | 0.135 | 0.020 | 0.175 |

### Renderer construction and the first frame on a cold page (ms)

From the metric A page loads (25 per track and size). At 1280x720:

| Track | page loads | new Renderer() median | max | first frame median | max |
|---|---|---:|---:|---:|---:|
| rust-bowl | 25 | 0.745 | 1.060 | 3.300 | 3.850 |
| crusher-run | 25 | 1.405 | 1.785 | 3.680 | 4.965 |
| overpass-knot | 25 | 1.145 | 2.045 | 3.725 | 5.480 |

At 390x844@3:

| Track | page loads | new Renderer() median | max | first frame median | max |
|---|---|---:|---:|---:|---:|
| rust-bowl | 25 | 0.730 | 0.805 | 3.285 | 4.280 |
| crusher-run | 25 | 1.370 | 1.775 | 3.765 | 5.560 |
| overpass-knot | 25 | 1.145 | 1.205 | 3.430 | 5.870 |

### Metric G (informational: as A on a GPU canvas, ms per frame)

| Scene | Track | median 1280x720 | ± | p99 | ± | median 390x844@3 | ± | p99 | ± |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | rust-bowl | 0.700 | 0.290 | 0.865 | 0.235 | 0.675 | 0.255 | 0.795 | 0.125 |
| S1 | crusher-run | 0.715 | 0.385 | 0.815 | 0.210 | 0.710 | 0.275 | 0.850 | 0.180 |
| S1 | overpass-knot | 0.740 | 0.340 | 0.870 | 0.335 | 0.760 | 0.320 | 0.900 | 0.320 |
| S2 | rust-bowl | 0.655 | 0.275 | 0.825 | 0.270 | 0.440 | 0.290 | 0.685 | 0.280 |
| S2 | crusher-run | 0.855 | 0.475 | 1.090 | 0.275 | 0.860 | 0.370 | 1.055 | 0.205 |
| S2 | overpass-knot | 0.955 | 0.400 | 1.185 | 0.140 | 0.930 | 0.395 | 1.095 | 0.445 |
| S3 | rust-bowl | 0.810 | 0.215 | 1.040 | 0.125 | 0.825 | 0.310 | 1.050 | 0.325 |
| S3 | crusher-run | 1.620 | 0.510 | 1.955 | 0.105 | 1.595 | 0.545 | 1.860 | 0.225 |
| S3 | overpass-knot | 0.870 | 0.140 | 1.080 | 0.105 | 0.865 | 0.370 | 1.030 | 0.295 |
| S4 | rust-bowl | 0.665 | 0.195 | 0.830 | 0.110 | 0.650 | 0.310 | 0.820 | 0.230 |
| S4 | crusher-run | 0.755 | 0.290 | 1.580 | 0.585 | 0.765 | 0.175 | 1.620 | 0.175 |
| S4 | overpass-knot | 0.520 | 0.370 | 0.985 | 0.290 | 0.730 | 0.195 | 1.080 | 0.065 |
| S5 | rust-bowl | 0.630 | 0.080 | 0.795 | 0.085 | 0.615 | 0.275 | 0.715 | 0.210 |
| S5 | crusher-run | 0.800 | 0.285 | 1.600 | 0.680 | 0.760 | 0.285 | 1.565 | 0.485 |
| S5 | overpass-knot | 0.665 | 0.385 | 0.845 | 0.395 | 0.560 | 0.325 | 0.810 | 0.305 |

### Metric C (informational: heap bytes allocated per frame, S3)

| Scene | Track | bytes/frame | ± | limit | GCs | ± | limit |
|---|---|---:|---:|---:|---:|---:|---:|
| S3 | rust-bowl | 9079 | 771 | 10621 | 2 | 2 | 6 |
| S3 | crusher-run | 15937 | 790 | 17516 | 2 | 1 | 4 |
| S3 | overpass-knot | 8944 | 526 | 9997 | 0 | 2 | 4 |

### Not measured here

- Canvas memory (the 12 MB cap): by review of the pool sizes, there is no counter for it.
- A real phone, and any browser but headless Chrome 152.
- GFX-3's "metric B on S1 with the lobby panel open": run `npm run bench -- --metrics B --b-scene S1 --panel lobby --vs-ref main`.
