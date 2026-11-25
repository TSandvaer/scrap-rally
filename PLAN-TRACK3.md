# PLAN-TRACK3: Rootwater Run, a third long track built for the jungle — APPROVED by the user 2026-11-25 (with the advisor changes)

User 2026-11-25 (popup "what next?"): "A third new track" — a new long track built for the jungle, giving the finished jungle look
(TH-LOOK-3: loam, moss verge, log rail, canopy, river gorge, black wet mud) and the ford (THEME-SURF physics + bots' upstream aim,
THEME-SND splash/wash, TH-LOOK-3 chevrons) a real home. User decision 9 of PLAN-THEMES ("jungle and the ford ship on Canopy Yard only
until a third new track exists") is what this plan fulfils. Keep it original: no layout, name or art copied from any existing game.

## 1. Current state (what exists)
- Shipped: Rust Bowl, Crusher Run, Overpass Knot (scrapyard, ~29-34 s laps), Slag Harbour (harbour) and Breaker's Mile (desert), both
  long (bots 50-60 s), each with one shortcut (BR-TRACKS), theme surfaces (THEME-TRACKS), marshals at s = 0, GRACE-1's scaled grace.
- Registry: shared/tracks.ts SHIPPED (lobby order); long tracks live in shared/longtracks.ts.
- Features available as data: ramp + gap (jump / gorge), hole, water (with a dry lane), dirt (black wet mud in the jungle), tyres
  (bamboo bales), barrels (log sections), press (log stamper), truck (logging truck), belt, widen + island (a split), cells (lightning,
  air/kerb), branch (shortcut road with its own features and recovery), sand/oil/ford (ford: jungle only, 40-160 long, 20<=|vx|<=100, on a
  straight, nothing solid within 80 past it).
- User rules for long tracks: spaced feature groups with plain road between (density report: share of plain road, shortest gap between
  groups); no mud/dirt stretch longer than ~350 (contiguous sand+dirt counts); bot laps 50-60 s (Normal binds; Hard may dip by a
  shortcut's gain); a clean shortcut gains ~1.5-2.5 s and a fall on it costs more.

## 2. Design
### 2.1 The track (working name: see question 1), jungle theme
A river valley loop, run anticlockwise, about the length of Breaker's Mile. The river is the spine: the road crosses it three ways.
- **The start straight** (>= 1500 units of plain road for drafting) along the valley floor, the grid and the marshals.
- **First ford** on the straight after turn 1 (full width, 140 long, drift toward the outside, vx ~ +60): the signature hazard, read by
  its chevrons; bots aim upstream.
- **A bamboo-bale chicane** (tyre mounds) on a short climb, then plain road.
- **The gorge jump**: the main road leaps the river gorge (ramp + gap ~200, an air cell over it), take-off at the long-track speeds
  (validateJumpSweep for every type at L0/L3).
- **The shortcut (branch)**: a narrow jungle cut that FORDS the river instead of jumping it — a second ford on the branch (drift the
  other way, vx ~ -70, half-width ~48) with a hole after it on the exit; ~1.5-2.5 s gain clean, a fall/drift-into-the-hole costs more.
  Easy bots never take it (risky), Normal half the seats, Hard when it pays (BR-BOTS rules).
- **Mud**: two black-mud patches (dirt, each <= 350, never contiguous with a ford or sand), half-width, on bends, with a dry line.
- **A log stamper** (press) at a narrow point and **rolling log sections** (barrels) across a straight later in the lap, in separate
  groups with plain road between.
- **A logging truck** (ramp truck) with an air cell, optional if density allows.
- **Lightning cells** on the back straight (drafting + cells as on the other long tracks).
- Recovery points spaced as on the other long tracks; one on the shortcut before its ford, one on the main road before the fork.

### 2.2 Data and code
- One new TrackDef in shared/longtracks.ts (theme "jungle"), added LAST to SHIPPED (ids and lobby order of the five stay); its own
  schema-hash golden lines and bot goldens; nothing else re-recorded.
- No physics, bot, look or sound code is expected to change: everything above exists. If validation or bots need a rule change
  (e.g. a ford on a branch road), the ticket asks first.
- Census: a sixth shipped track adds one minimap (trackList().length + 1, tools/debug/canvas-cap.ts) — check the headroom (census
  14,120,632 of 16,000,000 B today).
- Lobby: six tracks must fit the track picker on desktop and 390x844.
- Tools that list the shipped tracks (surf-bake-hash, world-shots, theme-sheet, bench scenes, the identity checks) gain the new track
  only where a list must be complete; the other five tracks' outputs stay byte-identical.

### 2.3 Tickets
- **TRACK3 (Opus):** the track def + registry + goldens + its sim/bots sections + the density report + the shortcut checks
  (br-tracks.ts, branch-sheet --track, map-sheet) + validation for every type at L0/L3 + 3 bots per level finish identically, <= 1 fall,
  Normal laps 50-60 s; a lagged socket bot through both fords and the gorge, median reconcile < 0.5; shots at 1280x720 and 390x844@3.
  Taste: the user drives it.
- **Review:** an Opus reviewer for the data/bots, plus a Fable reviewer for the drawing on a long jungle track (the jungle look so far
  ran on Canopy Yard only: fords, the gorge, the canopy, mouths and a ford on a branch, the census and the speed gate with six tracks).
- A small Fable follow-up only if the review finds a look gap on the long track (e.g. TH-LOOK-3 review note 1: a ford's flanks come
  from the nominal half-width; avoid fords on widened stretches).

## 3. Risks and open questions
1. A ford on a branch road: do validation (ford rules), physics (surfAt on a branch), bots (fordAim on the route ring) and the drawing
   (ford look on a branch road and its mouths) all support it today? If not, the shortcut drops the ford (a mud-and-hole cut instead)
   or the ticket grows.
2. Census headroom for a sixth minimap.
3. The lobby picker with six tracks.
4. The jungle's slower one-off art build (TH-LOOK-3 review note 5: Canopy Yard 18.3 ms vs 7.2) on a long track: a one-time hitch at
   track load — acceptable?
5. Length: a third long track at 50-60 s, or slightly shorter (45-55 s)?

## 4. Out of scope
New physics, new surfaces, new art, a visible sea, HARD-3.

## Advisor changes (binding; Fable 5.2 review 2026-11-25: "sound with changes"; override the text above)
1. **Prove the branch ford first (a spike at the start of TRACK3), with the fallback pre-agreed.** No ford exists on any branch yet
   (only Canopy Yard's main road, shared/testtracks.ts:259-260). By reading, validation (shared/track.ts:2620, :2367, :2053-2060,
   :2197-2201, :2228), physics (shared/physics.ts:240, :273-277), bots (shared/botdrive.ts:1752, :630-645, :2124), run-ups
   (shared/weapons.ts:844, :869-893) and the bake (client/gfx/world.ts:2172, :2216-2217) support it; the tools do not: puddle-probe reads
   the main road's fords only (:73), theme-sheet's fordCue runs on Canopy Yard only (:1707-1711), track-density's touch counters use the
   main road's themeSurfaces (:610), and sim-test has no ford-on-branch case: TRACK3 extends those. If the spike fails, the shortcut is
   a full-width mud cut with a hole (proven on Branch Yard) - see user question.
2. **The shortcut's recovery point lies between its ford and its hole, not before the ford** (the validation driver aims at the ford's
   middle, never upstream, shared/weapons.ts:627-628: a restart from rest takes the most drift and meets the hole = a fall loop); it
   stays before the first hazard (shared/track.ts:2628-2631) and off the ford (:2238-2241).
3. **The hole lies at least FORD_CLEAR (80) past the ford and off its downstream side** (the code checks solids only, :2197-2201, :659).
4. **The branch ford's drift is tuned on that road** with theme-tune --ford for every type before vx is fixed (FORD_AIM.gain 1.5 was
   tuned at half-width 64, |vx| 60, shared/botdrive.ts:584; ~36 units of drift at 70 on a 48 half-width by arithmetic).
5. **The shortcut keeps its hole** (branchKind does not know fords, shared/botdrive.ts:1554-1559: a ford-only cut is "plain" and Easy
   bots would take it, :1568, against user decision 3).
6. **Both fords run kerb to kerb at their road's own def.halfWidth, clear of every widen and taper** (TH-LOOK-3 note 1,
   client/gfx/world.ts:2216-2217; MOUTH_CLEAR 300 > the mouth taper 120, shared/track.ts:588, :632, :2360-2361); a sim-test assertion,
   since validation does not stop a ford on a widened stretch (:2020-2025).
7. **Density gate in numbers** (scripts/sim-test.ts:13912): no mixed group, >= 1000 clear between groups, >= 85 % obstacle-free, every
   dirt stretch <= 350. Eight main-road groups is tight: the logging truck, and one of the press or the log sections, are droppable.
8. **The lists that change:** following the registry (gain lines/counts): schema-hash (tools/debug/schema-hash.ts:384), surf-bake-hash
   (:32), theme-sheet --hash (:178), canvas-census (:103), world-sheet (:194), map-sheet (:239), marshal-sheet (:143); hard-coded (add
   the id): track-density.ts:74, br-tracks.ts:48, theme-tune.ts:402, hard-tune.ts:457, sim-test's LONG_IDS and its "exactly these
   shipped tracks" checks; byte-identical: world-shots' fixed list (tools/debug/world-shots.ts:51-53) and the bench scenes (no new SPOTS
   entry, client/bench.ts:978; the 16 scenes and gfx-baseline stand).
Settled: census +46,656 B for one minimap (tools/debug/canvas-cap.ts:17, :24; headroom 1,879,368 B); the lobby picker is a native
<select> from trackList() (client/main.ts:209-216): six fit at 390x844; keep the name no longer than "Breaker's Mile".
Suggestions adopted: the Fable reviewer looks at the shortcut's centre-line dashes (client/gfx/world.ts:1598-1611) and the soot gorge
beside a jade ford (one river drawn two ways). The art-build hitch is measured on the built track (new Renderer()) and asked then.

## User decisions (2026-11-25, popups: plan approved)
1. Name: **Rootwater Run** (id "rootwater-run").
2. Bot laps 50-60 s (Normal binds; Hard may dip below 50 by the shortcut's gain), as the other long tracks.
3. If the branch-ford spike fails, the worker switches the shortcut to a full-width mud cut with a hole (Branch Yard's proven pattern)
   without asking again; the main-road ford stays either way.
4. The one-off art-build hitch is measured on the built track and asked then.
