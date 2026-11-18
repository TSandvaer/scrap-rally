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

The numbers every later ticket is measured against, the gate, and how to run both. Page: `client/bench.ts`
(`?debug=1&bench=1`, its own chunk); runner: `scripts/bench.ts` (`npm run bench`). The tables were measured on the build of
commit 9b29be5 (render.ts as on main at 3c6d247) on an Apple M5 Pro (18 cores), macOS 26.6.2, HeadlessChrome 152 driven by
agent-browser 0.35.1, 5 us timer. The gate is the second one: the first (limit = baseline + 2 x spread) let a slowdown of
0.25 ms per frame through in review, and the user replaced it on 2026-11-18 ("Stricter gate"). The same day it got two
safeguards ("Add safeguards"), after two unchanged builds had failed it on a loaded machine, and the margin rule ("Adopt
margin rule"), after most gate runs on that machine had ended without a verdict.

### Running it

```
npm run bench -- --vs-ref gfx-baseline     # the gate: this tree against the fixed reference. Exit 0 PASS, 1 FAIL, 2 INVALID
npm run bench                              # this tree alone: tables like the ones below, no verdict
npm run bench -- --quick --only S4         # one run, metric A, 1280x720: a look, no verdict
npm run bench -- --pixels --vs-ref main    # pixel diff of the 16 preview scenes against main
npm run bench -- --judge tmp/bench/x.json  # judge a raw results file again by the runner's rules; nothing is measured
npm run bench -- --help
```

- The runner builds what it measures: the working tree (uncommitted changes included) and the `--vs-ref` commit, each in
  a temp directory. `dist/` is not used, so a stale one cannot be measured. It serves both builds itself on 127.0.0.1 with
  cross-origin isolation, which gives the page a 5 us timer. (A built directory or a URL can be given by hand, as the
  target or with `--vs`; a URL has Chrome's 100 us timer.)
- One cell (metric x scene x track) per page load, so no cell warms another's caches; five runs; in every run the two
  builds are loaded one right after the other, alternating which goes first.
- One benchmark on the machine at a time. The runner takes a lock before it builds (`scrap-rally-bench.lock` in the
  temp directory, holding its pid), waits with a message while a live process holds it, and takes over the lock of a
  process that is gone. The lock keeps benchmarks apart; it does not keep a test run, a build or another project's work
  off the machine. That is what INVALID is for (The gate).
- The browser sessions are named `bench-<pid>-base` and `bench-<pid>-this`. Sessions, servers, temp builds and the lock
  are closed and removed on every way out: done, failed, Ctrl-C.
- By hand: `?debug=1&bench=1[&metric=A|B|C][&scene=S3&track=crusher-run]` prints the table on screen and fills
  `window.scrapBench` (without scene and track every cell runs in the one page: a quick look only). `&hold=<frame>` draws
  one frame of a scene and stops.
- Chrome is started with `--mute-audio`, no background throttling and precise heap sizes.

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
  created with `willReadFrequently`. Median, p95, p99 and the count of frames over 4 ms. It measures main-thread JS plus
  CPU raster. Each cell also gets a checksum (FNV-1a of every 50th frame's pixels and the last): equal checksums mean the
  same picture.
- **A's warm-up:** 300 unmeasured frames first, on a Renderer of their own. S1 to S3 warm up on their own frames: their
  steady state is what they measure. S4 and S5 warm up on their first second only, looped, which never shows the own car
  falling or the leader changing. So the lap ahead and the places the leaders are get drawn for the first time in the
  measured run, also by a renderer that keeps baked ground between Renderers (advisor change 5) or bakes a destination
  ahead of a leader change (advisor change 4). The recovery point is first drawn in the measured run on Rust Bowl only,
  where it lies 5200 units back. On Overpass Knot it is 340 units back, inside the view of the warm-up's own frames, and
  on Crusher Run 595 back, at that view's edge (the reviewer's geometry check). There the measured run arrives at ground
  it has seen, as a player would who has just driven past it. The comment at `warmIndex` in `client/bench.ts` claims the
  recovery point for all three tracks; the file belongs to the fixed reference and is left as it is.
- **G (informational):** the same on a canvas pinned to the GPU (`willReadFrequently: false`): JS, GPU raster and the
  read-back. Closer to what a player's browser does, but noisier; watch S4 and S5 here for the cost of uploading freshly
  baked tiles, which A cannot see.
- **B:** 600 `requestAnimationFrame` frames of S4 on a default canvas with no read-back, starting at s = 0 / 3000 / 4500
  (Rust Bowl / Crusher Run / Overpass Knot) so that they cross the track's features, after the 60 frames that lead up to
  them. The interval between frames: median, p95 and the count over 20 ms; and how long the `frame()` call took. In its
  own page loads. `--b-scene S1 --panel lobby` plays S1 under the lobby panel (GFX-3's check).
- **C (informational):** S3, 600 frames: the sum of the per-frame increases of `usedJSHeapSize`, less what reading it
  costs. Bytes allocated per frame by `Renderer.frame()`; the scene's own objects are built beforehand.

### The gate

User decisions 2026-11-18 ("Stricter gate", then "Add safeguards", then "Adopt margin rule"; the 1.05 stays). They
replace section 4's "Metric A median at or below baseline" and "p95 at or below baseline x 1.05", and advisor change 9's
"baseline + 2 x the measured spread".

- **The rule.** Five runs. In every run the baseline and this build are loaded one right after the other for each cell,
  and the ratio this build / baseline is taken for that run. A value's ratio is the median of its five per-run ratios.
  **A value is OVER when the ratio of metric A's median, or of its p95, is above 1.05.**
- **One window size.** Metric A is judged at 1280x720 only: the canvas is 640x360 whatever the window, and A does not
  depend on it (finding 3). Other sizes are printed as information.
- **Safeguard 1, a quiet machine.** The lock (Running it), and every set knows how noisy it was. The noise of a set is
  how far apart a cell's five per-run ratios of the median lie (max - min), taken as the median over the set's metric A
  cells at 1280x720. At or below 0.10 the set is quiet, above it noisy.
- **The margin rule.** In a quiet set a value is ok at or below 1.05 and OVER above it. In a noisy set each value gets a
  margin m, the larger of the set's noise and the value's own spread (max - min of its five per-run ratios): it is ok at
  or below 1.05 - m, OVER above 1.05 + m, and open in between. A verdict that the noise could not change stands; one
  that it could change is not given.
- **Safeguard 2, confirm-on-OVER.** Set 1 is the gate run. The cells holding values that are OVER in it, by the rule
  above and whether the set was quiet or noisy, are measured once more (set 2): five fresh alternating runs, in new
  browser sessions (both are closed and opened again). Set 2 also measures control cells, so that it has at least 5
  metric A cells (all of set 1's, if set 1 had fewer): the first cells in the run's order that are not in it already.
  The controls count for set 2's noise only, are never judged, and are printed as controls. A value that is OVER for the
  first time in set 2 does not count. There is one set 2; the sets are never pooled and no third run decides. It all
  happens in the one invocation, and both sets' ratios are printed.
- **The verdict.** FAIL: at least one value is OVER in set 1 and OVER in set 2, each judged by its own set's rule. PASS:
  no value is open, and every value is ok in set 1, or OVER in set 1 and ok in set 2. INVALID, no verdict: anything
  else; run the gate again when nothing else is running. The runner prints "Gate: PASS", "Gate: FAIL" or "Gate: INVALID"
  and exits with 0, 1 or 2. With any number of runs other than five it gives no verdict. A run that did not judge
  metric A at 1280x720 is INVALID. A run cut down with `--only` or `--metrics` says "partial" in its headline: a look,
  not the gate.
- **Information only:** metric A's p99 and its count of frames over 4 ms (in review the count printed OVER for a build
  that differed by one 2x2 `fillRect`), metric A at other window sizes, and metrics G and C.
- **Kept from section 4, checked by the runner, once (in set 1):** metric B's frames over 20 ms at or below the
  baseline's (0 in headless Chrome); Renderer construction at or below baseline + 50 ms. In a quiet set 1 an OVER on
  either fails the gate. In a noisy set 1 construction's ok stands, B's ok stands only when this build dropped no frame,
  and an OVER on either gives INVALID, not FAIL.
- **The fixed reference.** The baseline of the gate is not main, which moves with every merge, but one commit.
  `--vs-ref gfx-baseline` reads it from `scripts/gfx-baseline.ref`; the orchestrator writes the hash of the commit that
  merges GFX-0 into that file, once. Every ticket is measured against that same build, so a ticket's ratios hold
  everything merged since GFX-0. Slowdowns cannot add up from ticket to ticket: it is their sum that has to stay
  under 5%, not each step. A comparison with any other ref (`--vs-ref main`) is printed as "NOT the gate".
- **`client/bench.ts` belongs to the reference:** the reference build runs its own copy of the page. A later ticket
  changes the scenes or the timing loop only when the Renderer's interface forces it, keeps the scripted frames the same,
  and says so in its report.

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
   `frame()` itself takes 0.10 to 0.16 ms there. It guards against a stall; it cannot rank two smooth builds. The check
   on a real phone (User decisions) is what covers that.
3. **Metric A does not depend on the window size.** The checksums at 390x844@3 equal those at 1280x720 in all 15 cells,
   and the medians differ by -4.8% to +4.2%, which is inside the spread.
4. **One build's numbers drift; a pair's ratio much less.** Over five runs of one build the spread of A's median is 9.3%
   of the median in the middle cell (1.8% in the best, 27.1% in the worst of the 30); 11.6% for p95, 13.1% for p99. It
   comes in spells of about a minute in which every cell runs 10 to 15% faster or slower. Hypothesis, not verified:
   other load on the machine's performance cores. That is why the gate compares the two builds load by load instead of
   against the numbers printed here.
5. **What the rule lets through and what it stops** (metric A at 1280x720, five alternating runs; 15 cells, so 30 gated
   ratios a run; before the safeguards):

   | Compared | Gated ratios | OVER | Exit code |
   |---|---|---:|---:|
   | A copy of the tree with nothing changed, against its commit | 0.963 to 1.035 | 0 of 30 | 0 |
   | A copy with 0.25 ms more per frame (a busy-wait at the top of `Renderer.frame()`), against its commit | 1.047 to 1.267 | 29 of 30, every cell | 1 |
   | The first session's same-build run (before this gate), judged by this rule | 0.937 to 1.048 | 0 of 30 | - |
   | The reviewer's probe data, judged by this rule: +0.25 ms cells | 1.140 to 1.168 | 4 of 4 | - |
   | The same: +1.0 ms cells | 1.475 to 1.639 | 4 of 4 | - |
   | The same: cells with one changed pixel and no slowdown | 0.985 to 1.016 | 0 of 4 | - |

   The first rule had called the reviewer's +0.25 ms cells ok (+15.3% and +13.5% on the medians). The one ratio the new
   rule did not flag in the +0.25 ms copy is S4 on Overpass Knot's p95, at 1.047; that cell was OVER through its
   median (1.121).
6. **With nothing changed, a ratio can come within a hair of the line, and on a loaded machine across it.** The three
   sets above without a slowdown are 64 ratios from 0.937 to 1.048, and the warm-up check under "The tables" adds 12
   more, up to 1.050: no false OVER in 76 ratios, but no room either. Single runs' ratios went from 0.851 to 1.213. Then,
   in the re-review, two unchanged builds failed beside another benchmark: metric A's p95 of S3 on Rust Bowl at 1.075
   (1.109 at 390x844@3), and in a second run of that cell alone its median at 1.053, while the p95 came back at 1.015.
   The noise of those two runs was 0.212 and 0.235; of the reviewer's quiet run and of the unchanged copy above, 0.045
   and 0.044. From three quiet sessions (90 unchanged values, none above 1.05, two above 1.04) the reviewer estimates
   that about 1.2% of unchanged values land above 1.05 on a quiet machine. Hence the two safeguards and the single
   window size.
7. **The safeguards at work** (2026-11-18, 20:58 to 22:26, against `gfx-baseline` = 7881af6, metric A at 1280x720). The
   machine was not quiet for most of it: another project ran its tests on about 12 cores and a load test, beside
   Spotlight and the virus scanner (process samples every 5 s).

   | Run | Set 1 | Set 2 | Noise, set 1 / set 2 | Verdict, exit code |
   |---|---|---|---|---|
   | The unchanged tree, 15 cells and metric B's 3 | 30 ratios 0.964 to 1.038, 0 OVER; B and construction 0 OVER | none needed | 0.086 | PASS, 0 |
   | A copy with 0.25 ms more per frame, S1 and S4 (6 cells) | 12 ratios 1.074 to 1.163, 12 OVER | 11 confirmed (1.085 to 1.158), 1 not (S4 Rust Bowl's p95: 1.094, then 1.046) | 0.063 / 0.062 | FAIL, 1 |
   | Test injection: set 1's median of S1 Rust Bowl times 1.2, S1 (3 cells) | 6 ratios 0.996 to 1.176, 1 OVER | 1.026: not confirmed | 0.083 / 0.062 | PASS, 0 |
   | The unchanged tree again, 15 cells, on the final runner | 30 ratios 0.934 to 1.080, 1 OVER (S5 Crusher Run's median, 1.080) | 0.977: not confirmed | 0.091 / 0.091 | PASS, 0 |

   The last row is the case the confirmation exists for: an unchanged build with one value over the line by noise. Under
   the rule without it that run would have failed.

   - **INVALID was the usual answer that evening: 18 of the 22 gate runs on record**, each with exit code 2 and no
     verdict. On record are `validate.log` (7 attempts: the first three rows and four INVALID), `v3-final.log` (14
     attempts of the injection run after its verdict, all INVALID: 11 on set 1 at 0.116 to 0.200, 3 on set 2) and the
     fourth row's own output, all in the author's `tmp/gfx0/`. The slowdown copy needed five attempts: three were
     INVALID on set 1 (noise 0.136, 0.108, 0.104) and one on set 2 (0.116). Six more injection attempts were made by
     hand (two before its verdict, at 0.227 and 0.164, four after it, at 0.143 to 0.178), all INVALID; their output was
     overwritten and they are in no log.
   - **The guard also refuses the obvious.** In the slowdown attempt that was INVALID on set 2, all 12 values were OVER
     in set 1 (1.082 to 1.205) and again in set 2 (1.058 to 1.173). The rule gives no verdict there; the ratios are
     printed.
   - **Noise so far:** quiet 15-cell runs 0.044 and 0.045; that evening's sets under the limit 0.039 to 0.091; the sets
     over it 0.104 to 0.235. The limit of 0.10 separates them, with little room on either side.
   - **A small set is a shaky judge of noise.** A set's noise is the median over its cells, and a set 2 of one cell
     rests on one number. Three of the injection attempts had a set 1 under the limit (0.039, 0.072, 0.086) and then a
     one-cell set 2 over it (0.134, 0.185, 0.205). Even in the two quiet 15-cell runs 3 of the 30 cells lay above 0.10
     on their own. That is what set 2's control cells are for (finding 8).
   - **Three-cell runs fared worst:** the injection run (3 cells) got its verdict in 1 of its 15 attempts on record,
     the 6-cell copy in 1 of 5, the 15-cell run both times at once.
   - The first three rows were measured before a last one-line change to the runner (a verdict only with exactly five
     runs), the fourth after it. The 14 injection attempts on record after it were all INVALID; three of them ran set 2
     first.
   - **The lock:** a second runner printed "another benchmark is running on this machine (pid ..., its directory):
     waiting for it to finish" and started when the first was done; a lock left by a dead pid was taken over. A runner
     from before the lock (an older checkout) neither takes nor respects it.
8. **The margin rule and the control cells** (user decision 2026-11-18, "Adopt margin rule"; the runs above were judged
   by the rule before it). The runner can judge a raw results file again (`--judge`). The 16 recorded comparisons, by
   the margin rule; the reviewer's own replay script gives the same 16 verdicts:

   | Build | Raw results | Noise, set 1 / set 2 | Set 1's values | Margin rule | Rule before |
   |---|---|---|---|---|---|
   | unchanged | v1-same.try1 | 0.086 | 30 ok | PASS | PASS |
   | unchanged | v1-final | 0.091 / 0.091 | 29 ok, 1 OVER (ok in set 2) | PASS | PASS |
   | unchanged | reviewer's aa | 0.045 | 30 ok | PASS | PASS |
   | unchanged | probe-same | 0.044 | 30 ok | PASS | PASS |
   | unchanged | aa-1 | 0.116 | 30 open | INVALID | INVALID |
   | unchanged | reviewer's full | 0.212 | 4 open | INVALID | INVALID |
   | unchanged | reviewer's confirm | 0.235 | 2 open | INVALID | INVALID |
   | injection | v3-forced.try1 | 0.083 / 0.062 | 5 ok, 1 OVER (ok in set 2) | PASS | PASS |
   | injection | v3-final | 0.153 | 1 OVER, 5 open | INVALID | INVALID |
   | +0.25 ms | v2-slow.try5 | 0.063 / 0.062 | 12 OVER (11 OVER again) | FAIL | FAIL |
   | +0.25 ms | v2-slow.try3 | 0.059 / 0.116 | 12 OVER (12 open in set 2) | INVALID | INVALID |
   | +0.25 ms | v2-slow.try1 | 0.136 | 2 OVER, 10 open | INVALID | INVALID |
   | +0.25 ms | v2-slow.try2 | 0.108 | 2 OVER, 10 open | INVALID | INVALID |
   | +0.25 ms | v2-slow.try4 | 0.104 | 4 OVER, 8 open | INVALID | INVALID |
   | +0.25 ms | probe-slow | 0.118 | 30 open | INVALID | INVALID |
   | +0.25 and +1.0 ms, one pixel | reviewer's probe2 | 0.075 | 4 ok, 8 OVER | INVALID: no set 2 in the file | (none recorded) |

   - No unchanged build fails, no build with 0.25 ms more per frame passes, and the six runs whose sets were all quiet
     keep their verdict (five PASS, one FAIL).
   - **On these runs the margin rule changes no verdict.** Every noisy set here holds values inside its margin: an
     unchanged build sits at about 1.00 and the +0.25 ms copy at 1.05 to 1.27, and with a margin of 0.10 or more neither
     is clear of 1.05. The rule decides under noise only for a build far from the line. Not measured: such a build. By
     the arithmetic a ratio of 0.70 is ok up to a margin of 0.35.
   - The files with an OVER in a noisy set 1 and no set 2 (try1, try2, try4, v3-final) were recorded when a noisy set 1
     ended the run. The runner now takes those values to a set 2.
   - **Control cells, live** (23:06 to 23:12, a test injection of 1.5 on S5 Crusher Run's median, 15 cells): set 1 was noisy
     (0.166: 1 OVER at 1.504, 29 open), set 2 ran all the same, with the cell and four controls (S1 to S4 on Rust Bowl),
     and was quiet (0.032 over 5 cells): 1.000, not confirmed. The verdict was INVALID, exit 2, for the 29 open values.
   - **One live gate, the whole default command** (`npm run bench -- --vs-ref gfx-baseline`, 23:13 to 23:40, 27.6
     minutes with its set 2). The tree was main at 2a964ca with this runner: every file the renderer is built from is
     the reference's, and `client/style.css` carries GFX-3's DOM skin, merged since. **PASS, exit 0.** Set 1 was quiet
     (noise 0.077 over 15 cells): 30 ratios from 0.932 to 1.116, 28 ok and 2 OVER, the p95 of S3 on Crusher Run (1.116)
     and on Overpass Knot (1.057). Set 2 measured those two cells and three controls (S1 to S3 on Rust Bowl), was quiet
     (0.021 over 5 cells) and gave 0.998 and 1.016: neither confirmed. Metric B: 6 cells ok; construction: 6 ok. The
     machine was mostly idle then: in 328 process samples only the virus scanner was often busy (19 samples at half a
     core or more).
9. **A's checksum is a regression net.** All 15 cells gave one checksum over ten loads, the same again in the second
   session, and the same again after the warm-up of S4 and S5 was changed. A refactor that must not change the picture
   has to reproduce it (the comparison prints it as "same picture"). G's checksum is not reliable: 1 of its 15 cells gave
   two values over ten loads.
10. **Today's renderer allocates** about 9.1, 15.9 and 8.9 kB per frame in S3 (Rust Bowl, Crusher Run, Overpass Knot).

### The tables

Median of five runs of one build, and their spread (± = max - min). They say what this machine did on one afternoon; the
gate does not use them. They were measured before the warm-up of S4 and S5 was changed. The old warm-up against the new
one on those two scenes (six cells, median and p95): the same checksums, ratios 0.987 to 1.050.

**Metric A at 1280x720 (CPU raster, ms per frame)**

| Scene | Track | median | ± | p95 | ± | p99 | ± | >4 ms | ± | checksum |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | rust-bowl | 1.665 | 0.135 | 1.800 | 0.195 | 1.920 | 0.165 | 0 | 0 | f8f36adf |
| S1 | crusher-run | 1.815 | 0.090 | 1.950 | 0.110 | 2.030 | 0.145 | 0 | 0 | fc0beede |
| S1 | overpass-knot | 1.700 | 0.140 | 1.940 | 0.180 | 2.010 | 0.200 | 0 | 1 | c5ffadae |
| S2 | rust-bowl | 2.030 | 0.550 | 2.275 | 0.520 | 2.380 | 0.490 | 0 | 0 | 64f99498 |
| S2 | crusher-run | 2.190 | 0.065 | 2.455 | 0.100 | 2.540 | 0.135 | 0 | 2 | 2d2279c4 |
| S2 | overpass-knot | 3.360 | 0.330 | 3.685 | 0.525 | 3.950 | 0.535 | 6 | 50 | 39cf913d |
| S3 | rust-bowl | 1.740 | 0.390 | 1.915 | 0.420 | 2.060 | 0.495 | 0 | 0 | 27a9f7cb |
| S3 | crusher-run | 3.165 | 0.105 | 3.480 | 0.300 | 3.545 | 0.470 | 2 | 3 | 5f5a8a58 |
| S3 | overpass-knot | 1.980 | 0.035 | 2.210 | 0.090 | 2.320 | 0.265 | 0 | 1 | 7fcdfb9c |
| S4 | rust-bowl | 1.950 | 0.290 | 2.360 | 0.375 | 2.500 | 0.380 | 0 | 2 | a5d6f149 |
| S4 | crusher-run | 1.955 | 0.115 | 2.715 | 0.450 | 3.065 | 0.315 | 1 | 1 | 2d6db32c |
| S4 | overpass-knot | 2.145 | 0.100 | 3.235 | 0.310 | 3.475 | 0.845 | 0 | 33 | 3f8f1545 |
| S5 | rust-bowl | 1.825 | 0.050 | 2.340 | 0.290 | 2.410 | 0.295 | 0 | 1 | bcc0ce7c |
| S5 | crusher-run | 2.065 | 0.185 | 2.695 | 0.475 | 2.865 | 0.440 | 0 | 2 | ccf31322 |
| S5 | overpass-knot | 1.965 | 0.165 | 2.280 | 0.190 | 2.445 | 0.160 | 0 | 0 | 90e674b6 |

**Metric A at 390x844@3 (CPU raster, ms per frame)**

| Scene | Track | median | ± | p95 | ± | p99 | ± | >4 ms | ± | checksum |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S1 | rust-bowl | 1.735 | 0.295 | 1.920 | 0.240 | 2.030 | 0.215 | 0 | 0 | f8f36adf |
| S1 | crusher-run | 1.795 | 0.375 | 2.045 | 0.330 | 2.135 | 0.390 | 0 | 0 | fc0beede |
| S1 | overpass-knot | 1.730 | 0.315 | 1.915 | 0.280 | 2.005 | 0.320 | 0 | 1 | c5ffadae |
| S2 | rust-bowl | 2.090 | 0.190 | 2.265 | 0.225 | 2.325 | 0.345 | 0 | 0 | 64f99498 |
| S2 | crusher-run | 2.145 | 0.145 | 2.425 | 0.125 | 2.530 | 0.155 | 0 | 0 | 2d2279c4 |
| S2 | overpass-knot | 3.450 | 0.385 | 3.805 | 0.655 | 4.100 | 0.765 | 13 | 36 | 39cf913d |
| S3 | rust-bowl | 1.760 | 0.110 | 2.025 | 0.205 | 2.095 | 0.220 | 0 | 0 | 27a9f7cb |
| S3 | crusher-run | 3.125 | 0.330 | 3.475 | 0.160 | 3.620 | 0.225 | 2 | 2 | 5f5a8a58 |
| S3 | overpass-knot | 1.885 | 0.260 | 2.175 | 0.280 | 2.255 | 0.295 | 0 | 1 | 7fcdfb9c |
| S4 | rust-bowl | 1.940 | 0.205 | 2.230 | 0.050 | 2.330 | 0.100 | 0 | 0 | a5d6f149 |
| S4 | crusher-run | 1.940 | 0.230 | 2.695 | 0.305 | 3.290 | 0.640 | 1 | 2 | 2d6db32c |
| S4 | overpass-knot | 2.125 | 0.155 | 3.220 | 0.380 | 3.405 | 0.490 | 0 | 3 | 3f8f1545 |
| S5 | rust-bowl | 1.840 | 0.175 | 2.240 | 0.145 | 2.380 | 0.115 | 0 | 1 | bcc0ce7c |
| S5 | crusher-run | 2.110 | 0.275 | 2.590 | 0.415 | 2.785 | 0.520 | 0 | 0 | ccf31322 |
| S5 | overpass-knot | 1.920 | 0.275 | 2.390 | 0.310 | 2.550 | 0.335 | 0 | 1 | 90e674b6 |

**Metric B (rAF-paced, ms between frames) at 1280x720**

| Scene | Track | median | ± | p95 | ± | >20 ms | ± | frame() median | ± |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S4 | rust-bowl | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.110 | 0.025 |
| S4 | crusher-run | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.155 | 0.085 |
| S4 | overpass-knot | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.130 | 0.030 |

**Metric B at 390x844@3**

| Scene | Track | median | ± | p95 | ± | >20 ms | ± | frame() median | ± |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S4 | rust-bowl | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.105 | 0.020 |
| S4 | crusher-run | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.155 | 0.010 |
| S4 | overpass-knot | 16.665 | 0.000 | 16.670 | 0.000 | 0 | 0 | 0.135 | 0.020 |

**Renderer construction and the first frame on a cold page (ms), from the metric A page loads, at 1280x720**

| Track | page loads | new Renderer() median | max | first frame median | max |
|---|---|---:|---:|---:|---:|
| rust-bowl | 25 | 0.745 | 1.060 | 3.300 | 3.850 |
| crusher-run | 25 | 1.405 | 1.785 | 3.680 | 4.965 |
| overpass-knot | 25 | 1.145 | 2.045 | 3.725 | 5.480 |

**The same at 390x844@3**

| Track | page loads | new Renderer() median | max | first frame median | max |
|---|---|---:|---:|---:|---:|
| rust-bowl | 25 | 0.730 | 0.805 | 3.285 | 4.280 |
| crusher-run | 25 | 1.370 | 1.775 | 3.765 | 5.560 |
| overpass-knot | 25 | 1.145 | 1.205 | 3.430 | 5.870 |

**Metric G (informational: as A on a GPU canvas, ms per frame)**

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

**Metric C (informational: heap bytes allocated per frame, S3)**

| Scene | Track | bytes/frame | ± | GCs | ± |
|---|---|---:|---:|---:|---:|
| S3 | rust-bowl | 9079 | 771 | 2 | 2 |
| S3 | crusher-run | 15937 | 790 | 2 | 1 |
| S3 | overpass-knot | 8944 | 526 | 0 | 2 |

### Not measured here

- The margin rule giving a verdict from a noisy set: no recorded or live run had a noisy set with every value clear of
  its margin (finding 8). A build far from the line is what would show it.
- Metric B or construction OVER, in a quiet or a noisy set 1: every run so far had them ok.
- Both of these were walked through only on doctored copies of recorded results, judged with `--judge` (eight cases:
  a noisy set far below the line passes, far above it in both sets fails; B or construction OVER fails a quiet set and
  gives INVALID in a noisy one, as does a B that is ok while this build dropped frames). They are not measurements.
- Ctrl-C from a terminal (SIGTERM was tried).
- Canvas memory (the 12 MB cap): by review of the pool sizes, there is no counter for it.
- A real phone, and any browser but headless Chrome 152.
- GFX-3's "metric B on S1 with the lobby panel open": run `npm run bench -- --metrics B --b-scene S1 --panel lobby --vs-ref gfx-baseline`.
  It prints metric B's values with their ok or OVER, and "INVALID" as its headline, because it judges no metric A value:
  it is a look, read from the table.
