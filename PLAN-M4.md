# PLAN-M4: car types, host bots, catch-up, pickups, obstacles, split lanes, long tracks

User requests 2026-11-20 (game ideas + "add bots as host"). Drafted by an Opus planning agent; Fable advisor review next,
then user approval (project rule; user popup 2026-11-20 kept Fable for plan reviews).
Everything here keeps the M1–M3 model: the server is authoritative, every gameplay rule lives in `shared/`, and the client predicts its own car with the same code.

## 1. Current state

| Area | Today | Touched by |
|---|---|---|
| Car stats | `CarStats {accel, topSpeed, grip, turn}`, `BASE_STATS` 520/430/7.5/3.3 (`shared/physics.ts:35-42`). Off-road multipliers are global constants: drag ×2.9, grip ×0.37 (`physics.ts:54-55`), applied when `q.dist > halfWidth` (`:78-82`). Car-car contacts assume equal masses (`:226`). Every car uses the same 30×16 capsule. | Car types, water, slipstream, boost |
| Upgrades | Percent multipliers in `statsFor(levels)` (`shared/shop.ts:59-66`). The server sets `p.stats` once in `beginRace` (`server/room.ts:460`). The client derives its stats from the `garage` message (`client/game.ts:628-632`). | Car types |
| Race step | `stepRaceCar` (`shared/weapons.ts:167-216`), order wreck > fall > air > drive. Take-off, air and fall constants at `:44-48`. `validateRunUps` (`:382`). | Every physics ticket |
| Track | One closed centerline. `wall` is constant per track (`shared/track.ts:53,189`). Features are full-width ramps, gaps and round holes keyed by s (`:13-30`). `holeAt` is a linear scan (`:280`). `pointAt` is O(n) (`:315-324`). `queryTrackNear` searches ±12 segments (`:247`). `validateTrack` (`:451`). `LIP_ZONE` is 12 units, which allows up to 720 u/s (`:147`). | Surfaces, obstacles, split lanes |
| Progress | Checkpoints are forward crossings of s, and `rd = lap·L + s` (`server/race.ts:29-60`). The HUD shows POS from `rd` (`client/main.ts:601`). | Split lanes, pickup weighting |
| Room tick | `simulate` (`room.ts:872-932`): consume input → `stepRaceCar` → `combat.act`, then car-car pairs, then combat and progress. Snapshots (`:1001-1040`) carry no race tick. "Present" means `p.session` (`:260, :412, :865`). The next host is the first player in the map (`:352`). | Host bots, race tick, pickups |
| Prediction | `reconcile` replays pending inputs through `stepRaceCar` (`game.ts:743-793`). `contact.ts` assumes `pending[i]` is applied at snapshot tick + i + 1. | Moving obstacles, slipstream, pickups |
| Bots | `BotDriver` reads the client `Game` (`scripts/bot-ai.ts:106-253`). Its shopping logic lives in `botplay.ts:52-69`. Deterministic bot laps over in-process sockets: `sim-test.ts:2399-2497`. Socket races: `scripts/bots.ts`. | Host bots, every feature |
| Sprites | One hull shape (`client/gfx/sprites.ts:56`). Colour sheets are capped at 6 (`:35`). | Car looks |

## 2. Design

### 2.0 Host-added bots (new user request): the first slice

- **The driver moves to `shared/botdrive.ts`.** It becomes a pure `botControls(view, mem): Controls`. The view holds the car, track, stats, raceOn, raceSteps and the other cars' pose and solidity. The memory holds backup and stuck state. `scripts/bot-ai.ts` keeps working as a thin adapter over `Game`, so `botplay` and the socket tests are unchanged. A server adapter goes in `server/bots.ts`. The shopping logic moves to `shared/botshop.ts`.
- **Seats.** A `Player` gets `bot: {level}`. Bots have no session. A `present(p)` helper (session or bot) replaces every presence check. Bots count toward the 6-seat cap and are always ready. They join the grid order and the reverse grid. They are never host and never time out.
- **Commands.** `{t:"addBot", level}` is host-only and lobby-only, and allowed while the room is locked. Levels:
  - **Easy**: throttle capped at 0.85, corner speeds ×0.9, no weapons.
  - **Normal**: today's driver. The user liked this pace on 2026-11-15.
- **Removing bots.** Kick on a bot removes it with no blocklist entry. `host` sent to a bot is refused. A room with no humans left is deleted with its bots. Each bot gets its own chat join line, e.g. "Gasket (bot) joined".
- **Driving.** Each tick the room computes the bot's Command directly, with no jitter buffer, so a bot is a zero-latency player. Weapons, armed delay, pause, results, scrap and the wreck bonus all go through the existing code.
- **Shopping.** After payouts a bot shops by the shared rule: Easy buys upgrades only, Normal buys ammo first and then the cheapest upgrade.
- **Car types.** From M4-CARS, bots get a car type round-robin, and the host can change a bot's car from its lobby row.
- **Single player.** A solo host plus bots can start at once, because bots never block the ready check.
- **Lobby UI.** An "Add bot (Easy/Normal)" control for the host, a BOT tag in the player list, and a Remove button per bot.
- **Server CPU.** `pointAt` becomes a binary search over `cum`. With that, one bot step is a few `queryTrackNear` calls plus about 5 `pointAt` calls, roughly 5–20 µs. A server-wide cap `MAX_BOTS` (default 30, env setting) refuses more with "Server busy". The hosted instance is small, so the cost is measured and gated (see the M4-BOTS ticket).
- **Testing benefit.** `sim-test` can run full races with server bots: no sockets, deterministic, fast. Every later ticket proves its feature with server bots.

### 2.1 Car types

Base stats per type. Top speed stays 430 for all three, matching the 2026-11-16 decision that top speed made the engine overpowered.

| | accel | grip | turn | dirt drag × | dirt grip × | water grip × |
|---|---|---|---|---|---|---|
| Sport | 520 | 7.5 | 3.3 | 2.9 | 0.37 | 0.12 |
| Racer | 600 (+15%) | 6.0 (−20%) | 3.45 | 3.6 | 0.30 | 0.08 |
| Truck | 455 (−12.5%) | 9.0 (+20%) | 3.1 | 1.6 | 0.60 | 0.22 |

- **Stats with upgrades.** `CarStats` gains `dirtDrag`, `dirtGrip` and `wetGrip`. `statsFor(type, levels)` applies today's upgrade percentages to the type's base. Upgrades belong to the driver, so they apply to whichever car they drive.
- **Where to choose.** A Car row (three cards) in the lobby garage. Switching is free. `{t:"car", id}` is lobby-only. The choice is stored on the `Player`, sent in `PlayerInfo.car` (so others draw it) and in `garage.car` (so the own prediction is exact). The choice locks at `beginRace`, the same way levels do.
- **Hit shape and mass.** The same capsule and equal mass for every type, so collisions and netcode do not change. Each look is drawn inside the 30×16 footprint.
- **Balance targets.**
  - At L0, the bot's lap time with each type is within ±3% of the sport's on every shipped track.
  - `validateRunUps` passes for every type at L0 and at L3. The truck is the worst case: it needs about 45 more units of run-up to reach 350 u/s than the sport.
- **Bots.** `botdrive` scales corner target speeds by √(grip/7.5). The truck prefers dirt lanes.

### 2.2 Water and dirt

- **Feature shape.** `{k:"water"|"dirt", s0, s1, lat0, lat1}` is a rectangle in track coordinates (s along, lat across). `nearest()` must also return the signed lateral offset.
- **Aquaplaning model.**
  - Lateral grip × `wetGrip` (you keep sliding along your entry vector).
  - Throttle and brake × 0.35 (wheelspin).
  - Turn × 0.5.
  - No extra drag.

  A pool on a straight is harmless. A pool in a bend throws you wide.
- **Validation.**
  - A dry lane at least 48 units wide at every s, or the pool lies on a straight.
  - No water on a lip zone or a recovery point.
  - The run-up validator also drives a lane through any water that lies in a run-up.
- **Bots.** A lane-cost search replaces `holeLane`: holes and solids are blocked, water and dirt cost by car type.

### 2.3 Obstacles

Common rules for all obstacles:
- No damage. Wrecks stay weapons-only, so the wreck credit logic is unchanged.
- Airborne cars pass over every obstacle (the M3 rule).
- Rivets die on solid obstacles.
- Respawns and recoveries pick the nearest clear lane.
- Validation keeps solids at least 40 units from recovery points and from the grid.

The obstacles:
- **Tyre mound** `{k:"tyres", s, lat, r 18–30}`. A static circle. Collision is the car capsule against the circle, with a full push-out. The normal velocity is reflected with restitution 0.8 and a minimum outward speed of 90 u/s, so it feels bouncy. Tangential velocity × 0.9.
- **Rolling barrels** `{k:"barrels", s, n, period, speed≈110}`. n kinematic circles (r 9) roll across the road from wall to wall, staggered by period/n. Each one's lateral position is a pure function of `(rt + k·period/n) mod period`. At the far wall a barrel drops into a gutter and comes back in at the near wall.
  - A hit pushes the car out with restitution 0.5, adds the barrel's velocity, and gives a mild deterministic yaw kick of 0.4 rad, chosen by side.
  - Barrels are never pushed, so they are predictable.
- **Ramp truck** `{k:"truck", s, lat, len≈110}`. A parked flatbed whose ramp faces backwards.
  - The body is a solid capsule. Its rear ramp band is a narrow ramp: lip at the cab, lateral band ±14, air ticks ×1.3.
  - A car whose centre is in the band and moving forward rides up and launches over the cab. A side hit is pushed out sideways.
  - Static in M4. A moving truck (a shuttle hidden in a shed for part of its cycle, computed from `rt`) only if the user asks at the taste gate.

### 2.4 Original obstacle suggestions

- **Conveyor belt** `{k:"belt", s0, s1, lat0, lat1, vx}`. A surface that adds a fixed drift each tick. Static, so it costs almost nothing to predict.
- **Crusher press** `{k:"press", s, lat0, lat1, period, down}`. A timed gate across a lane, computed from `rt`. It is solid while down, its shadow warns about 0.5 s before it slams, and it does no damage.
- **Magnet crane** that sweeps a lateral pull across the road: later.

### 2.5 Speed pickups (lightning cells)

- **Boost.** `CarState.boost` holds the ticks left. While it runs: accel ×1.6 and top speed ×1.25 (537 u/s). The speed then decays back with about a 0.8 s time constant. The gain is about 120 units, roughly 4 car lengths.
- **Duration by gap to the leader** (shown on the HUD):

  | Gap to leader (rd) | Boost |
  |---|---|
  | Leader | 36 ticks (0.6 s) |
  | 0–400 behind | 54 ticks (0.9 s) |
  | 400–1200 behind | 72 ticks (1.2 s) |
  | Over 1200 behind | 90 ticks (1.5 s) |

- **Cells.** `{k:"cell", s, lat, air?}`, radius 14. A cell respawns 480 ticks after it is taken. The snapshot carries `cells: number[]`, the race tick each cell comes back (0 = available).
- **Who can take a cell.**
  - Ground cells: grounded, solid cars only.
  - Air cells: airborne cars with `airHeight` ≥ 0.4 only. The flight is deterministic, so the client predicts this exactly.
- **Authority and ties.**
  - The server takes cells after all cars have stepped. The winner is the car with the earliest touch fraction in the swept tick. If that is equal, the car further behind (lower `rd`) wins, then join order.
  - The client predicts only its own pickup. If the snapshot disagrees, the replay removes the boost and the smoothing hides it.
- **Placement rules (validated).**
  - Ground cells at |lat| ≥ halfWidth − 8 (on the kerb), in dirt or water, or on a split lane's far lane.
  - Air cells must lie on the arc of take-offs between 300 u/s and the maximum speed.
  - No cell within 250 units before a lip, unless a boosted run-up still lands.
  - None on the grid or the start straight.
  - Seed cells on today's tracks: Rust Bowl kerbs, the Crusher Run chasm (air), Overpass Knot's crossing (air).
- **Bots.** Normal bots take a cell when it is within 30 units of their lane. Air cells come with the jumps they already take. Easy bots ignore cells.

### 2.6 Different paths: three options

- **A. Separate branch polylines** that rejoin the main road. Progress on a branch would be mapped to the main s with a linear map. This changes the seg hint, `queryTrackNear`, walls, recovery and the bake. Too large for M4.
- **B. Split lanes (recommended).** The road widens: `{k:"widen", s0, s1, left, right}`, tapered over 120 units. An island `{k:"island", s0, s1, lat0, lat1}` is a solid band with tyre-stack noses at both ends.
  - `buildTrack` precomputes per-sample `halfL/halfR/wallL/wallR`. `collideWalls`, the on-road test, `isLost`, `wallLimit` (also `client/game.ts` `wallHitSpeed`) and corridor validation read them per segment.
  - **s, checkpoints, `rd`, laps and positions are unchanged.** The shorter inside lane is simply faster.
  - Validation: each lane at least 72 wide, and run-ups checked once per lane.
  - Bots: a lane choice per bot id and car type. The truck takes the dirt lane.
  - Both lanes stay on screen, so you see your rival on the other path.
- **C. A full graph track.** Out of scope.

### 2.7 Long tracks (original)

- **Slag Harbour.** A dockside yard. A split with a flooded short lane (ground cell in the water) against a dry long lane. Rolling barrels off a quay. A parked ramp truck with an air cell over its landing. A tyre-mound chicane. A conveyor stretch.
- **Breaker's Mile.** Two straights of at least 1500 units for drafting. A dirt shortcut split (truck lane). A crusher press gate. A chasm jump with an air cell. A pit pair.
- **Length.** Each lap 50–60 s for bots, against 29–34 s today. Laps stay at 3.

### 2.8 Catch-up

What other racing games do:
- **Rubber-banding:** the AI speeds up when you lead and slows down when it is ahead. It reads as rigged because it devalues driving well ([Game Developer](https://gamedeveloper.com/design/rubber-banding-as-a-design-requirement), [CheatCC](https://www.cheatcc.com/articles/why-mario-kart-s-rubber-band-ai-feels-rigged-not-just-hard/), [AV Club](https://www.avclub.com/5-games-totally-ruined-by-rubberbanding-ai)).
- **Drag on human leaders:** GTA Online's host-set Catch-Up mode increases the leaders' drag, and players report the advanced variants as unreliable ([Sportskeeda](https://www.sportskeeda.com/gta/gta-online-s-new-catch-up-modes-explained-post-chop-shop-update)).
- **Slipstream:** used by Mario Kart and GTA. It only helps a car that is already close, and the risk is a tug of war if it is too strong ([MarioWiki](https://www.mariowiki.com/Slipstreaming), [GameSpew](https://www.gamespew.com/2022/04/slipstream-review/)).
- **Weighted items:** Mario Kart 8 picks its item table by distance to the frontrunner ([MarioWiki](https://www.mariowiki.com/Mario_Kart_8_item_probability_distributions)). SuperTuxKart weights by position and gives trailing karts zippers, described as a moderate effect ([SuperTuxKart](https://www.supertuxkart.net/Powerups)).
- **Research:** CHI 2024 found comebacks that help without guaranteeing a win stay enjoyable, while taking control away hurts ([Gonçalves et al.](https://techandpeople.github.io/downloads/2024_chi_balancing.pdf)).
- **Shortcuts:** risk-for-time routes are skill-based comebacks.

Why the gap exists here: every car has the same top speed, so a follower can never pass on a straight. The weapons are already asymmetric: rivets fire forward (only the chaser can use them on the leader) and mines drop behind (the leader's defence).

**Recommendation:**
1. **Slipstream, always on, no stored state.**
   - The leading car must be grounded, not wrecked and doing at least 250 u/s. The follower must be grounded, 20–180 units behind along the leader's heading, and within 22 + 0.1·distance of its line.
   - Strength w = 1 up to 60 units, falling linearly to 0 at 180. The follower's drag × (1 − 0.09·w), so its terminal speed rises by up to +10% (473 u/s).
   - It is computed from start-of-tick poses. The speed carries about 1 s after pulling out, so a pass takes about 1.5–2 s.
2. **Cells weighted by gap to the leader**, as in 2.5.
3. **Risky split lanes** with cells on them.
4. **No hidden rubber band** on humans. Bot pace stays as it is; difficulty is an explicit, labelled bot level.

All constants live in `shared/catchup.ts`.

How it is tested:
- On a straight test track, a follower 50 units behind at 430 u/s:
  - with no draft, the gap stays within ±1;
  - with the draft, it passes within 4 s.
- A car 250 units back is exactly the same as driving alone.
- Two Normal server bots on Rust Bowl over 3 laps: lead changes per lap between 1 and 4 (not a tug of war).

How it is tuned: `tools/debug/draft-tune.ts` prints time-to-pass for a sweep of the constants. Then the taste gate.

## 3. Netcode, performance, determinism

- **Race tick `rt`.** Counts `simulate` ticks while racing; paused ticks do not count. It goes in every snapshot. The client's step k runs at `latest.rt + pending.length + 1`, the same assumption `contact.ts` makes. An underrun skews it by one tick, which the reconcile absorbs.
- **One signature change.** `stepRaceCar(c, input, stats, env)` with `env = {track, rt, draft}`. It is made once, in M4-CATCHUP. `CarState` gains `boost`. `cloneCar`, `CarSnap` and `sameState` are extended.
- **Where moving things are drawn.** Barrels and the press are drawn at the own car's predicted `rt`, the same rule as near cars, so the own car's hits look right.
- **Slipstream on the client** uses the predicted poses at k−1. The error is small and continuous.
- **Performance.**
  - Per-segment buckets for surfaces, solids and cells, built in `buildTrack`. No linear scans per tick.
  - `pointAt` becomes a binary search.
  - The renderer follows PLAN-GFX §4: fixed pools, baked sprites, zero allocation per frame.
  - The speed gate on bench scenes S1–S4 is checked against the fixed GFX-0 base.
  - A new scene S5 (6 cars, barrels, press, truck, 2 pools, 3 cells) must stay within the S2 median ×1.10.
- **Determinism tests.**
  - sim-test parity for every feature: `stepRaceCar` on a clone gives exactly the server's pose, including barrels at `rt` and boosts.
  - Bot laps on every track: zero state mismatches, no error above `LARGE_ERR`, identical results on a rerun.
  - In `bots.ts`, a lagged socket bot on a feature track keeps a median reconciliation error below 0.5 and a bounded count of large errors.

## 4. Tickets

Ownership rule:
- **Fable tickets** own only `client/gfx/*`, `client/render.ts`, `client/preview.ts`, `client/bench.ts` and `tools/debug/*`.
- **Opus tickets** own everything else, including `client/main.ts`, which maps game state into `CarView`/`WorldFx`.
- **Contracts:** each Fable ticket adds its own fields to `CarView`/`WorldFx`, and the next Opus ticket fills them.
- **Shared files:** `shared/physics.ts`, `shared/weapons.ts`, `shared/track.ts` and `shared/botdrive.ts` are touched by at most one Opus ticket at a time, strictly in sequence. Each ticket appends its own `sim-test`/`bots` section; the second to merge merges main first.
- **Every ticket's gate:** `npm run check`, `npm test` and `npm run build` pass.

**Wave 1**
- **M4-BOTS (Opus).** Owns `shared/botdrive.ts` (new), `shared/botshop.ts` (new), `shared/track.ts` (`pointAt` only), `server/bots.ts` (new), `server/room.ts`, `shared/protocol.ts`, `client/game.ts`, `client/main.ts`, `index.html`, `style.css`, `scripts/bot-ai.ts`, `scripts/botplay.ts`, `scripts/sim-test.ts` and `scripts/bots.ts` sections.
  - Accept:
    - 3 server bots finish each shipped track within the existing bounds, identically on a rerun.
    - Each addBot/kick/host refusal is tested.
    - Solo human + bots: the race starts at once.
    - A humans-gone room is deleted.
    - Bots shop deterministically.
    - Median bot step ≤ 0.05 ms (printed; fail above 0.2 ms).
    - `botplay` is unchanged.
  - Taste: the user plays solo with 3 bots.
- **M4-LOOKS (Fable).** Sport, Racer and Truck hulls inside 30×16. Sheets keyed by (look, colour). `CarView.car`.
  - Accept: contact sheet of 3 looks × 6 colours × battered/burnt; added canvas ≤ 3.5 MB; speed gate passes.
  - Taste: the contact sheet.

**Wave 2** (after wave 1)
- **M4-CARS (Opus).** Owns `shared/cars.ts` (new), `shop.ts`, `physics.ts`, `weapons.ts`, `protocol.ts`, `botdrive.ts`, `room.ts`, `server/bots.ts`, `game.ts`, `main.ts`, `index.html`, `style.css`, scripts.
  - Accept:
    - Bot lap times per type within ±3% of the sport.
    - `validateRunUps` passes for every type at L0 and L3 on all tracks.
    - The car is locked per race, kept across a rejoin, and switched free in the lobby.
    - A socket bot of each type: median reconciliation error < 0.5.
  - Taste: the user drives all three ("distinct, none dominant").
- **M4-FX (Fable).** Wake streaks, boost flame, ground and floating cell sprites, HUD DRAFT and BOOST cues.
  - Accept: speed gate passes; screenshots.

**Wave 3**
- **M4-CATCHUP (Opus).** Slipstream, `rt`, `env`, boost, cells with validation, cells seeded on today's tracks, `draft-tune`. Owns `shared/catchup.ts` (new), `physics.ts`, `weapons.ts`, `track.ts`, `protocol.ts`, `botdrive.ts`, `room.ts`, `combat.ts`, `game.ts`, `contact.ts`, `main.ts`, scripts.
  - Accept: the catch-up tests in 2.8; tie rule tests; air cells taken only in flight; the lagged-bot bounds hold.
  - Taste: the user passes a Normal bot by drafting and finds cells hard but fair.
- **M4-WORLD (Fable).** Looks for water, dirt, mounds, widened road and islands, belt, barrels, press and truck, built against the schema in 2.2–2.6 on preview test tracks.
  - Accept: speed gate passes; S5 within budget.
  - Taste: screenshots.

**Wave 4**
- **M4-SURF (Opus).** Water, dirt, belt, mounds, widen and islands, per-segment arrays and buckets, validation, bot lane costs. Owns `track.ts`, `physics.ts`, `weapons.ts`, `botdrive.ts`, `game.ts`, `main.ts`, scripts.
  - Accept: server bots finish a test track with every surface and solid, with no fall; validation rejects each rule broken.
  - Taste: drive the test track.

**Wave 5**
- **M4-MOVE (Opus).** Barrels, press and parked ramp truck, computed from `rt`, plus their placement in `WorldFx`. Same owned files as M4-SURF.
  - Accept: parity at `rt`; bots get through the barrels, take the truck jump, and time the press.
  - Taste: drive it.

**Wave 6**
- **M4-TRACKS (Opus).** Slag Harbour and Breaker's Mile, registry, bounds.
  - Accept: both validate for all types at L0/L3; server bot laps of 50–60 s with ≤ 1 fall; socket bot bounds hold.
  - Taste: the user drives both.
- **M4-MAP (Fable, parallel).** Minimap for split lanes; S5 on the real tracks.

## 5. Out of scope, risks, open questions

**Out of scope:** branch polylines and graph tracks, a moving ramp truck, car mass and ramming, obstacle damage, rubber-banding, a Hard bot level, per-track laps, a track editor.

**Risks:**
- `shared/physics.ts` is a serial bottleneck across waves 2–5.
- The per-segment wall refactor touches many call sites.
- Underruns give the moving obstacles one-tick errors.
- The narrow-ramp band has edge cases.
- Server CPU on the small hosted instance as rooms add bots.
- Sprite memory.

**Open questions (recommended answer first):**
1. **Payouts snowball across races** (1000 vs 150 per race, plus upgrades). Not in M4. Measure after catch-up lands, then maybe flatten to 1000/800/650/500/400/300.
2. **Cell boost weighted by gap to the leader?** Yes, with the duration shown on the HUD.
3. **A host "Catch-up on/off" setting?** Not at first; add it only if the taste gate asks.
4. **Ramp truck static or moving?** Static first.
5. **Bot levels?** Easy and Normal, with Normal at today's pace.

### Critical Files for Implementation
- /Users/thjo/DEV/scrap-rally/shared/physics.ts
- /Users/thjo/DEV/scrap-rally/shared/weapons.ts
- /Users/thjo/DEV/scrap-rally/shared/track.ts
- /Users/thjo/DEV/scrap-rally/server/room.ts
- /Users/thjo/DEV/scrap-rally/client/game.ts
- /Users/thjo/DEV/scrap-rally/scripts/bot-ai.ts
## Advisor changes (binding; Fable 5.2 review 2026-11-20: "sound with changes"; these override the text above)

1. **Presence is not one helper everywhere.** `server/room.ts:704` and `:890` stay session checks (else a bot is held 60 ticks after
   every resume); `:260` gets a bot exemption (`:444` clears `ready` every race); `:352` picks the first HUMAN as host; `:249` `empty`
   means "no humans"; `:741` and `:894` skip `consumeInput` for bots; `:308-312` match on token, so bots get unguessable tokens or are
   excluded.
2. **Bot behaviour keyed by seat/add order, not by the random id** (`room.ts:122,268`): lane choice, racing-line offset, mine stagger
   (`bot-ai.ts:250`), names and car round-robin — so "identical on a rerun" holds.
3. **Easy's throttle cap never applies on a ramp approach** (0.85 gives ~365 u/s terminal, Overpass Knot needs ~367 by
   `takeoffSpeedFor`, `bot-ai.ts:63-72`, `track.ts:137-138`). Acceptance adds "Easy bots finish every track".
4. **Water model made consistent:** throttle x0.35 with unchanged drag gives ~150 u/s terminal (`physics.ts:81-92`), not "harmless".
   Scale drag by the same factor (or drop the throttle factor) so a pool on a straight costs little and a pool in a bend throws you wide.
5. **Ramp truck:** no "air ticks x1.3" (breaks `airHeight` `weapons.ts:131-137` and `drawnHeight` `contact.ts:275`) unless an air-total
   field is added to `CarState`/`CarSnap`; the narrow band needs a lateral lip test (`lipAt` is s-only, `track.ts:296`); define the band
   below 220 u/s (solid) and a landing that overlaps a solid.
6. **Barrels:** no level-triggered yaw kick (contacts re-apply every overlapping tick, a pinned car spins): drop it or apply once per
   contact with stored state; define a car squeezed between a barrel and a wall.
7. **Jumps validated at overspeed:** `validateRunUps` starts from rest only (`weapons.ts:382-424`); add an arrival-speed sweep up to
   537 u/s (boost) and 473 (draft) for every lip and car type (flights grow from ~372 to ~450/537 units, `MAX_AIR_TICKS` clamp
   `weapons.ts:47`); replace "no cell within 250 units of a lip" with a simulation (a 90-tick boost covers 700+ units).
8. **Slipstream continuity:** taper w laterally (no hard edge); no draft predicted when the own car is past `CAP_STEPS`
   (`contact.ts:173`); state whether ghosts and finished cars give a draft (recommended: no).
9. **`rt` skew bounded and specified:** underrun rebuffers to `QUEUE_START` (`room.ts:1094-1113`), resume hold up to 60 ticks
   (`:888-891`), inputs consumed during the countdown while `rt` is 0 (`:894-897`); the client clamps `rt` at GO; the lagged-bot test on a
   barrel track bounds the skew.
10. **Boost band from the latest snapshot's `rd`** (rd is server-only, `race.ts:1-3`): the client predicts the duration from it;
    "leader" = the leading car that has not finished; band-edge mismatches expected and corrected by reconcile.
11. **Ticket split changes:**
    - M4-CATCHUP splits into **M4-ENV** (`rt`, the `env` signature, `boost` plumbing, no behaviour change; ~24 `stepRaceCar` calls in
      sim-test), **M4-DRAFT** and **M4-CELLS**. M4-ENV runs in wave 2 together with M4-CARS's `statsFor` change so sim-test churns once.
    - An **Opus schema slice (M4-SCHEMA)** comes before M4-WORLD: Feature types, per-sample arrays, preview test tracks; Fable tickets
      never edit `shared/track.ts`.
    - M4-SURF splits into **surfaces + mounds** and **widen + islands** (the `track.wall` refactor: `weapons.ts:211,282`,
      `track.ts:255,284,387-420`, `game.ts:93`).
    - Fable-added `CarView`/`WorldFx` fields are optional (`render.ts:57-73`) so `npm run check` passes before `main.ts` fills them.
    - `tools/debug/*` ownership is per file (e.g. `draft-tune.ts` belongs to M4-DRAFT).
12. **CPU gate:** gate on total room tick time with 5 bots; `MAX_BOTS` default 10 (not 30); measure on the hosted instance.
13. **Widen validation:** the half-width on the inside of a bend stays below the local radius, or `nearest()` degenerates.

Adopted suggestions: a `pointAt` equivalence test (binary vs linear) on every track; a truck corner-cutting test (its dirt top speed
~269 u/s vs the sport's 148); the ±3% lap target is a guide, the taste gate is the real check; tune the draft with weapons on; air cells
off-centre (or the lane-0 bot always takes them). Wave 1 (M4-BOTS + M4-LOOKS) confirmed as the right first slice.

## User decisions (2026-11-20, popups; plan approved)

- **Approved** with the advisor changes, and these defaults: the car choice can change between races (locked per race); the ramp
  truck is parked, not moving; bot names like "Gasket (bot)" (an original name list, assigned by add order); race payouts unchanged
  for now (measure the snowball after catch-up lands).
- **Different paths = split lanes** (road widens around an island into two lanes with different trade-offs). True branching roads:
  a later milestone.
- **Bots:** Normal bots buy ammo + upgrades and use rivets/mines; Easy bots buy upgrades only and never shoot. A human joining a
  FULL room replaces the last-added bot (lobby only; in a race the join is refused as today).
- **Catch-up always on**, no host toggle (add one later only if the taste gate asks). Boost duration weighted by the gap to the
  leader, shown on the HUD.
- Wave 1 starts now: M4-BOTS (Opus) and M4-LOOKS (Fable).

## Notes from implementation (2026-11-20)

- M4-ENV review: after an input gap (underrun or resume hold) the client's live `rt` can be off by up to ~7 ticks for about one round
  trip (scripts/bots.ts bounds live <= 10, replay <= 3). Section 3's "one tick" understates this; M4-MOVE must size its lagged parity bound
  for moving obstacles accordingly (a barrel at ~110 u/s can be mispredicted by up to ~13 units in that window).
- M4-CARS: bot corner scaling uses (grip/7.5)^(1/4) (the square root gave ~5% spread); with equal bot caution all three types lap within
  ~1%, so the types differ in feel (acceleration, grip, dirt, recovery), not raw lap time.

