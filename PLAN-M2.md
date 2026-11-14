# Scrap Rally — Milestone 2 plan: weapons, scrap, garage

Builds on the finished prototype (PLAN.md). Same rules: original names and art, server
authoritative, all wire formats in shared/protocol.ts, small commits, no push unless asked.

Reviewed by the Fable 5.2 advisor (v1 draft): "sound with changes". All changes are folded
in below. On originality the advisor noted that engine/tyres/armor + mines + prize money is
close to a known game's shop; mechanics may be shared (project rule), but to make the
garage our own, the currency is **scrap** and the third upgrade is a **welding rig** (repair
during the race) instead of plain armor.

## Player-facing scope

- **Rivet gun** (front, hold to fire): 8 damage, cooldown 9 ticks (150 ms), range 650,
  900 u/s plus the car's own velocity. Ammo packs of 20, cap 100.
- **Scrap mine** (rear, tap to drop): arms after 0.4 s, lives 25 s, 30 damage + spin-out
  (deterministic heading kick away from the mine, speed × 0.3). Packs of 3, cap 9.
  Mines hit anyone once armed, including their owner.
- **Starting kit** for a new player: 400 scrap, 40 rivets, 3 mines.
- **Hit points**: 100. At 0 the car is **wrecked**: stops dead for 90 ticks (1.5 s), then
  respawns on the centerline at its current track distance with full HP and 60 ticks of
  ghosting (no damage, no car collisions, cannot fire). Lap/checkpoint progress is kept.
- **Finished cars** are ghosted and cannot fire (no farming during the 30 s grace).
- **Scrap payout** per race, by place among racers: 1000 / 700 / 500 / 350 / 250 / 150,
  DNF 0, plus 60 per wreck you cause.
- **Garage** (lobby only; purchases are never applied mid-race):
  - Engine L1-3: accel and topSpeed +7 % per level — 400 / 800 / 1400
  - Tyres L1-3: grip +10 %, turn +4 % per level — 350 / 700 / 1200
  - Welding rig L1-3: repairs 2 / 4 / 6 HP per second while driving — 300 / 600 / 1000
  - Rivets (20) 150, Mines (3) 200, up to the caps.
  - Scrap, levels and ammo live on the Player: they persist across races and across a
    reconnect within `RECONNECT_GRACE_MS` (20 s); after that the seat is gone.
- **Grid**: players not in the last race first (join order), then the last race's
  standings reversed (leader starts last). First race: join order.
- **Controls**: rivet gun = Space / Z / J (hold); mine = X / K (tap). Space no longer brakes;
  Down / S brake and reverse. No Shift (Sticky Keys on Windows).

## Shared code

- `shared/shop.ts` (new): catalog (ids, prices, levels, caps, starting kit),
  `statsFor(levels): CarStats`, `regenFor(levels)`, pure `payouts(standings, wreckCredits)`.
- `shared/weapons.ts` (new): weapon constants (all timers in ticks), shot stepping with a
  **swept segment-vs-circle** hit test (closing speed ~29 units/tick vs a 26-unit car),
  `spinOut(car, mineX, mineY)`, `respawnPose(track, car)`, and
  `stepRaceCar(car, input, stats, track)`: if `car.wreck > 0` it counts down, holds the car
  still with zero velocity and on reaching 0 applies `respawnPose`; otherwise it calls
  `stepCar`. Server and client both step cars only through this function, so the client
  predicts the freeze and the respawn teleport exactly like the server.
- `shared/physics.ts`: `CarState` gains `wreck` (ticks left), `cloneCar` copies it.
- `shared/protocol.ts`:
  - `InputTuple` = `[seq, throttle, steer, buttons]`. `buttons` bit 0 = rivet held,
    bits 1-3 = **mine counter** (mod 8, incremented once per mine key press).
  - `CarSnap` gains `hp`, `maxHp` (100 for now), `wreck`, `ghost`.
  - New entities in `ents`: `{k:"shot", id, o, x, y, vx, vy}`, `{k:"mine", id, o, x, y, armed}`.
  - `snap` gains the recipient's `ammo: [rivets, mines]` (per recipient, like `ack`).
  - Events: `hit {id, by, dmg, w}`, `wreck {id, by}`. Result rows gain `earned`.
  - `garage` (server -> one player): `{scrap, levels: {engine, tyres, welder}}`.
    `buy` (client -> server): `{t:"buy", item}`; refusals arrive as `err`.

## Server

- `server/combat.ts` (new): shots and mines per room; spawn, step, hits, damage, wreck
  credit, ghosting, regen. Combat steps only in `racing`; shots and mines are cleared in
  `start()` and `toLobby()`.
- `server/room.ts`:
  - `queueInputs` accepts 4-tuples (3-tuples treated as buttons 0).
  - Inputs are consumed every tick even while wrecked (result discarded), so `ack` keeps
    moving and the queue does not overflow.
  - Tick order per car: consume input -> `stepRaceCar` -> fire (shot spawned at the nose
    using the post-step pose and velocity). The client spawns its cosmetic shot at the
    same point in its step.
  - Underrun repeats and the coast fallback **clear the rivet bit but keep the mine
    counter**, so a repeat never fires and never drops a mine.
  - Mines: the server drops one when the consumed counter differs from the last consumed
    counter. After any queue reset the first consumed input only sets the baseline.
  - Rivets: fire when the bit is set, cooldown elapsed, ammo > 0, not wrecked, not
    ghosted/finished, phase `racing`. Cooldown counts car steps.
  - `p.stats = statsFor(p.levels)` is computed once in `start()`.
  - `bind()` sends `garage` right after `welcome`; also after a purchase and after payouts.
  - Public `buy(p, item)` (lobby only, enough scrap, below caps); `endRace` uses `payouts()`.
  - Test knob like `laps`: `startServer({ ..., hp })` sets the car HP (bots use a low value
    so wrecks actually happen in a one-lap race).

## Client

- `client/game.ts`:
  - Prediction uses `statsFor(levels)` from the latest `garage` message. Levels are never
    updated optimistically.
  - The own `CarSnap.wreck` seeds the predicted `wreck` counter; replay goes through
    `stepRaceCar`, so the freeze and respawn are predicted. Reconcile **snaps** (no smoothing)
    whenever the wreck state of the old and new predicted car differs.
  - Input to the server: the rivet bit and new mine presses are only applied while
    `raceOn()` (same gating as throttle). The keyboard latches mine key presses so a tap
    shorter than one step is not lost.
  - Cosmetic own shots: spawned when the client sends a rivet input and its own predicted
    ammo/cooldown allow it, never while wrecked or finished. Predicted ammo = snapshot ammo
    minus shots fired in pending inputs, so it self-corrects. Cooldown counter in ticks,
    reset on welcome. The server's copies of our own shots are not drawn; damage is only
    shown from server events and snapshots.
  - Other shots and all mines come from snapshots, interpolated like cars.
- `client/render.ts`: shot and mine sprites, wreck smoke, ghost flicker, HP bar and ammo in
  the HUD. Hit sparks only if time allows.
- `client/main.ts`, `index.html`, `style.css`: garage panel in the lobby (scrap, three
  upgrade rows with level pips and price, two ammo rows, Buy buttons disabled when not
  affordable or capped); `earned` column in results. Wreck toasts only if time allows.
- `client/input.ts`: fire keys, latched mine presses.

## Tests

- `scripts/sim-test.ts` (new, deterministic, no sockets): drives a `Room` directly with fake
  `Conn`s and scripted inputs (priming two inputs before expecting consumption), setting
  `p.car`/`p.progress` directly where needed:
  - a rivet hits a car ahead (hp -8, `hit` event); never its owner; dies at range and at the
    wall; the swept test catches a head-on pass;
  - a mine arms after 24 ticks, then damages and spins the first car over it (incl. owner);
  - 0 HP wrecks: frozen 90 ticks, respawn at the same s with full HP, ghosted 60 ticks,
    lap/checkpoint progress kept, attacker credited; `stepRaceCar` on a cloned car gives the
    same pose as the server (prediction parity);
  - fire only in `racing`, only with ammo, respects cooldown; underrun repeats never fire or
    drop; a mine tap survives an overflow trim;
  - `payouts()` and `buy()` (scrap, phase, caps); finished cars are ghosted and cannot fire.
- `scripts/bots.ts` extended (server started with a low HP knob), two races in a row:
  - before race 1 the lagged bot buys Engine L1 (scrap deducted) and a too-expensive buy is
    refused;
  - bots hold the rivet gun when a car is in a 30° cone ahead within 500 units and drop a mine
    every ~8 s;
  - expected scrap after race 1 = start - spend + place table + 60 × counted `wreck` events
    (computed from events, not from `earned`);
  - scrap, levels and ammo survive the drop/rejoin; race 2 uses the reverse grid;
  - at least one hit and one wreck happen; every wrecked bot keeps max reconciliation
    error < 50; the lagged bot's median stays < 0.5 with upgraded stats and weapons.
- `package.json`: `"test": "tsx scripts/sim-test.ts && tsx scripts/bots.ts"`.

## Order of work (each step its own commit, `npm run check` + tests green)

1. Shared shop/weapons/protocol + server combat and room integration + `sim-test.ts`.
2. Client prediction changes (stats, wreck, input buttons) + rendering of shots, mines, HP.
3. Garage UI + payouts in results.
4. Bot test extension; browser check with two sessions (screenshots: garage, a race with
   shots and a wreck). Update PLAN.md.

## Known limitations accepted for this milestone

- No lag compensation: you aim at other cars as you see them (~100 ms + one-way latency in
  the past), so fast targets need a little lead.
- Mines appear for their owner after ~RTT + 100 ms.
- If the server runs extra underrun ticks during a wreck, the predicted respawn can be a tick
  off; reconcile snaps in that case.
- No sound yet.
