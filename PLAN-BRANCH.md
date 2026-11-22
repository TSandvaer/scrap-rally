# PLAN-BRANCH: shortcut roads off the main road — DRAFT (pending Fable review and the user's approval)

**Why.** On 2026-11-22 the user chose shortcut roads: shorter than the main road but risky (dirt, a jump, a hole or a narrow gap). They are built after M4-TRACKS and then added to Slag Harbour and Breaker's Mile (team/DECISIONS.md:134). This is option A of PLAN-M4 2.6 (PLAN-M4.md:127).

**Not option C.** A graph track would replace the closed-ring `s` that four places rely on: `pointAt` (shared/track.ts:1064-1066), `wrapS` (:1008-1011), `nearest` (:962-963) and `advance` (server/race.ts:29-50). Option A leaves the main road's code path untouched.

**Note.** Race progress lives in `server/race.ts`. There is no `shared/race.ts`. (Drafted by an Opus planner on main 6ab9462; M4-MOVE refs are to TSandvaer/m4-move.)

## 1. Current state

- **One closed centreline.** The car is searched ±`LOCAL_WINDOW` = 12 segments around `CarState.seg` (track.ts:379, :993-997; physics.ts:44), and the index wraps modulo n (:962).
- **Feature lookups take (track, seg) or (track, s).**
  - By segment: `surfAt` (:777-785), `tyresAt[q.seg]` (physics.ts:171), islands (:236), and M4-MOVE's `barrelsAt/pressesAt/trucksAt[q.seg]` (physics.ts:188 on TSandvaer/m4-move).
  - By s: gaps, lips and holes (track.ts:1022-1052).
- **Walls are per sample.** `halfOf`/`wallOf` (track.ts:876-901), `collideWalls` -> `wallLimit` (physics.ts:224-249), and `isLost` = 2x wall (track.ts:1003-1005).
- **`seg` is already on the wire.** `CarSnap.seg` (protocol.ts:152) is sent unrounded (room.ts:1201; x is rounded at :1196). The client replays from the server's seg (game.ts:824, :865).
- **Progress.** `s` comes from `queryTrackNear` (race.ts:16, :31). Checkpoints sit at 25/50/75 % of the lap (track.ts:530).

## 2. Design

### 2.1 Representation
- **Declaring a branch.** `features` gains `{k:"branch", s0, s1, side, control:[x,y][], halfWidth, features?, recovery?}`. The fork is at main s0 and the merge at main s1. The branch's features and recovery points are placed in branch distance u.
- **Building it.** `buildTrack` builds each branch as an **open sub-road with the same `Track` shape**: its own pts, cum, halfL/R, wallL/R, feature lists, buckets and recovery points, so every per-Track lookup above works on it unchanged. The Catmull-Rom curve runs through main(s0-100), main(s0), the control points, main(s1) and main(s1+100): the branch starts and ends on the main centreline, tangent to it, with no bulge at its ends.
- **`Track.branches: PlacedBranch[]`**, empty on every shipped track. Each entry holds `{road, base, s0, s1, side, forkGore, mergeGore, mapS}`. `base` = the branch's first global segment index (the main road uses 0..n-1). `mapS[i]` = the main s for branch sample i: the projection onto the main road inside each mouth, linear between the two gores; strictly increasing (validated).
- **Cells.** Branch cells are appended after the main cells in `track.cells` (the snapshot order, room.ts:204), so shipped cell indices do not move. Pickup is already a world-space scan (room.ts:1083-1107, game.ts:1056-1064).

### 2.2 Query, seg hint, netcode
- **`CarState.seg` becomes a global index:** `seg >= n` means branch b at local segment `seg - base`. CarState, CarSnap and `cloneCar` get no new field (netcode cost zero); prediction and server agree on the road for free, because the replay starts from the server's exact seg.
- **`queryTrackNear`:** with no branches it runs today's call byte for byte. Otherwise it resolves the hint's road and searches its window (clamped, not wrapped, on a branch). If the window touches a mouth (a precomputed `mouthAt` per global segment), it also searches the other road's mouth window and keeps the nearer centreline; on a tie the hint's road (deterministic).
- **`TrackQuery` gains `road`** (a small int stored unboxed, as `side` is, track.ts:269-291). `q.seg` and `q.s` stay road-local, so calls like `surfaceAt(r, q.seg, ...)` stay as they are with `r = roadOf(track, q)`. The places that store the hint write `globalSeg(track, q)`: physics.ts:133, :235 and weapons.ts:249, :277, :339.
- **Call sites made road-aware:** physics.ts:132-174 and :233-249; weapons.ts:227-293 and :333-351; game.ts:102-117 (`wallHitSpeed`); sfx.ts:829-830; race.ts:16 and :31.

### 2.3 Walls and mouths
- **The rule.** In a mouth the branch's half-width equals the main road's on both sides, and the main road has no widen there. `buildTrack` enforces this from u=0 to the gore, then tapers the branch to its own width over `WIDEN_TAPER` (track.ts:431).
- **What that buys.** "The nearer road's wall" is then exactly the union of the two corridors: a car is pushed iff it is outside both. No wall is opened or closed by hand; past the gore each road's own wall stands. The bake's nearest-piece rule (world.ts:1004-1022) draws the same union (2.7).
- **The gore nose.** Where the corridors part, `buildTrack` generates a tyre-stack nose: a `PlacedTyres` in both roads' buckets, reusing `collideTyres` (physics.ts:184-217); rivets already die on tyres (weapons.ts:340).
- **Off both roads.** `isLost` on the nearer road = a fall, as today. Verge and gravel are the same bands on each road.

### 2.4 Progress and fairness
- **`mainS(track, q)`** returns q.s on the main road and the interpolated `mapS` on a branch; race.ts:16 and :31 call it. Laps, checkpoints, rd, positions, the boost band and the spectator leader follow unchanged.
- **No checkpoint can be skipped:** the map is continuous and monotone from s0 to s1, so a branch car crosses every checkpoint inside the branch in order; reversing lowers s; a fall recovers behind the car (2.5); in a mouth the projection keeps the jump in s from a road switch to a few units, so "at most one target per update" holds (race.ts:38-39).
- **Grid and lap line:** the zone rule (track.ts:1231-1236) keeps branches off the grid and the start straight, so s=0 is never on a branch. Ghosts and finished cars unchanged.

### 2.5 Recovery, jumps, features
- **Placement:** `place()` (weapons.ts:270-281) writes the global seg. **Recovery** uses the last branch recovery point at or before u, else the main recovery point at or before s0. **Respawn:** a wreck respawns on its own road (:289-294).
- **Features reused (in u):** ramps, gaps, holes, water, dirt, belts, tyres, widens and islands, barrels, press and truck. Reworked: a branch-relative zone rule and the run-ups (2.8). Mouths carry no features.
- **Narrow gap:** the branch's own `halfWidth` (>= 36, i.e. 72 wide), or a pair of mounds leaving at least `LANE_MIN` = 72 clear (track.ts:433).

### 2.6 Bots
- **Who takes it:** decided once per race from seat slot (server/bots.ts:27, :50-51), car type and level, never the random id (PLAN-M4 advisor change 2). Route cost = length + `laneCost` x surface length (botdrive.ts:371) + a risk margin per level. Easy: never a jump or hole shortcut; dirt only in the truck. Normal: alternate seats. Hard: whenever it costs less. A jump shortcut is skipped at the fork below `takeoffSpeedFor` (botdrive.ts:293).
- **Driving the line:** a route cursor replaces `pointAt(track, q.s + d)` for the aim point and the bend look-ahead (botdrive.ts:910, :929-930, :963); it follows the chosen road and continues onto the main road past a merge (`pointAt` wraps, track.ts:1066, so an open road must not use it). `laneFor`, `splitFor` and `rampAhead` run on the current road. Validation keeps `MOUTH_CLEAR` (300) of plain road past every gore, so no look-ahead crosses a mouth. `mem.lateral` is scaled to the branch's width.

### 2.7 Rendering (Fable; never edits shared/track.ts)
- **Bake:** branch pieces join `cuts` (world.ts:371-389) with a road id; a run breaks on a road change, as on a gap (:974). Width differences via the per-piece wL/wR path (:400-410, :1022). Dashes, groove and patches use branch u. The nearest-piece field then draws the Y-junction, kerbs and barrier of the union with no new case. Barrier posts skip points inside another road's corridor (today's posts, :530-541, would land on the branch's tarmac in a mouth). Junk and ruts test every road (`away`, :366-369). Painted fork arrows in the mouth.
- **Rules held:** no new canvas (tiles from the fixed pool, world.ts:54-55, within `CANVAS_CAP` 16 MB, canvas-cap.ts:12); no per-frame allocation (PLAN-GFX.md:152-153); culling unchanged (per-tile piece bounding box, world.ts:931-937); the dust lookup in `gfx/actors.ts` (:637) and `obstacles.ts` also search branch roads.
- **Minimap:** bounds include branch points (hud.ts:469); each branch is an extra run in the same line style, joining the main line at both ends.

### 2.8 Validation
- **Shape:** branch length < main s1 - s0, strictly (the report prints the seconds a bot saves on a clean run); `halfWidth` >= 36; centreline angle at the gore <= 35°; mouth length <= 600; `mapS` strictly increasing.
- **Separation:** corridors of different roads overlap only in mouths, or where one is a gap (today's crossing check, track.ts:1277-1309, over all roads). Elsewhere the corridors stay >= 40 apart, ruling out drafting through a wall (two cars at facing walls >= 56 apart vs a draft reach of at most 48 = 22 + 0.1x180 + 8, catchup.ts:31-33).
- **Features and run-ups:** `validateSchema` takes its zone rule as a parameter (track.ts:1442); branches pass it with features kept in [gore + `MOUTH_CLEAR`, merge gore - `MOUTH_CLEAR`]; a recovery point before the first hazard; solids >= 40 from recovery points. `validateRunUps` and `validateJumpSweep` drive from the main recovery point before the fork through the branch, for every car type at L0 and L3.

### 2.9 Byte-identity and performance
- **Shipped tracks have no branch**, so every path is today's. Checks: `schema-hash --check` (15/15 today, 25/25 after M4-TRACKS), `surf-bake-hash` per shipped track, `map-sheet --ref main` 0 px, the M4-HARD bot-stream goldens.
- **Cost:** a mouth adds one window search, only on mouth segments; lookups stay in per-segment buckets per road, no linear scans. Gates: median bot step <= 0.05 ms (fail above 0.2 ms) and room tick time with 5 Hard bots (PLAN-M4.md:208, :312, :398).

### 2.10 Branch Yard and taste
- A roomy loop in `TEST_TRACKS` (testtracks.ts:117-118), picked with `SCRAP_DEV_TRACK` (room.ts:62-77), with three shortcuts and plain road between them: a dirt cut with at most ~350 units of dirt (PLAN-M4.md:427-429); a jump cut; a narrow cut with holes. At least one goes out of sight of the main road.
- Taste gates: the user drives a frozen copy on the Mac; the phone only on the live site after a push the user approves.

## 3. Tickets
All start after M4-TRACKS merges. At most 2 workers at a time, never on the same files. Every ticket's gate: `npm run check`, `npm test` twice, `npm run build`, and schema-hash unchanged unless stated.

**Wave 1**
- **BR-SCHEMA (Opus).** Owns track.ts (types, building, `mapS`, `mainS`, `queryRoads` for the bake, structural validation), testtracks.ts (Branch Yard), its own sim-test section. Accept: one test per validation rule broken; Branch Yard validates; shipped hashes identical.

**Wave 2 (parallel)**
- **BR-PHYS (Opus).** Owns track.ts (query), physics.ts, weapons.ts, server/race.ts, client/game.ts, client/sfx.ts, its own sim-test section, `tools/debug/branch-walls.ts` (new). Accept: points round each mouth pushed iff outside both corridors; clone parity on Branch Yard; a scripted car through each branch gets the same cp/lap sequence as on the main road and recovers on the branch; run-ups pass for every type at L0 and L3; socket bots (main road) keep a median reconcile error < 0.5.
- **BR-BAKE (Fable).** Owns world.ts, obstacles.ts, actors.ts, preview.ts, bench.ts, `tools/debug/branch-sheet.ts` (new). Accept: shipped `surf-bake-hash` identical; the drawn union matches `queryRoads` within 1 px; the speed gate passes plus a Branch Yard fly-through within S2 x 1.10; Rule 1; canvas census unchanged. Taste: screenshots.

**Wave 3 (parallel)**
- **BR-BOTS (Opus).** Owns botdrive.ts, server/bots.ts, scripts/bot-ai.ts, its own sim-test and bots sections, `tools/debug/branch-tune.ts` (new). Accept: bot streams on shipped tracks byte-identical; 3 bots per level finish Branch Yard, identically on a rerun; choices printed per seat; <= 1 fall per bot per race; the bot-step bound.
- **BR-MAP (Fable).** Owns hud.ts, map-sheet.ts. Accept: shipped minimaps 0 px; on Branch Yard each branch joined at both ends.

**Wave 4.** Taste gate: the user drives Branch Yard and races 3 Hard bots.

**Wave 5**
- **BR-TRACKS (Opus).** Adds shortcuts to Slag Harbour and Breaker's Mile and re-records only those two tracks' goldens. Accept: every type validates at L0 and L3; bot laps 50-60 s; the density report covers the shortcut. Taste: the user drives both tracks.

## 4. Risks, open questions, out of scope
**Risks**
- Equal mouth widths carry the design: a later widen in a mouth would silently split physics from the drawing (validation and `branch-walls` guard it).
- world.ts is 3284 lines; posts, furniture and gap caps near mouths are the fiddly parts.
- Wrapping on open roads: `wrapS`/`pointAt` (track.ts:1008-1011, :1066) and `hazardsAhead` (weapons.ts:499-515) all wrap.
- Bots in mouths: the query can flip the road under a bot; the route cursor must not flip with it.
- Bisector differences: the walls agree by construction; reconciliation absorbs the rest (PLAN.md:116).

**Open questions for the user (recommended answer first)**
1. How many shortcuts per new track? **One each**: a hole or narrow one on Slag Harbour, a jump on Breaker's Mile.
2. How much should a clean shortcut gain? **About 1.5-2.5 s a lap.** A fall costs more (`FALL_TICKS` 90 plus the restart, weapons.ts:57).
3. Which bots take shortcuts? **Easy never risky ones, Normal on half the seats, Hard whenever it pays.**
4. Mark the fork? **Yes, painted arrows, no text.**
5. How does the minimap show them? **The same line style as the main road.**

**Out of scope:** graph tracks (option C), branches off branches, two branches in one mouth, a moving fork gate, shortcuts on Rust Bowl, Crusher Run and Overpass Knot, a track editor.
