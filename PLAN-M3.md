# Scrap Rally — Milestone 3 plan: jumps, crossings, holes, recovery, two new tracks

Reviewed by the Fable 5.2 advisor: "sound with changes"; the section "Advisor changes (binding)"
below overrides the design text where they differ.

Status (2026-11-17): T1a, T2, T3 and T1b merged; T4 (Crusher Run, Overpass Knot, bot driver)
built on TSandvaer/m3-t4, waiting for review and the user's taste gate.

User request 2026-11-16: two new, more advanced tracks with ramps to jump over obstacles and over
roads (roads crossing roads), holes, and a recovery feature: if you fall (onto the road below, into a
hole, short of a landing) your car blinks and returns to the recovery point. User choices: committed
jumps (no steering or throttle in the air); fall = blink ~1.5 s then back to the last recovery point,
no damage, no scrap lost; the host picks the track in the lobby. Original names and layouts only.

## Constraints from today's code

- shared/track.ts: one closed Catmull-Rom centerline, constant halfWidth + verge, walls at a fixed
  distance; queryTrackNear searches ±12 segments around the car's hint and falls back to a GLOBAL
  search when the car is > 2*wall away (that fallback would snap a car onto the other road at a
  crossing); minSelfClearance requires the track never to come near itself.
- Cars never leave the ground; stepRaceCar (shared/weapons.ts) already freezes and respawns wrecked
  cars deterministically, and the client predicts that exactly (bots: max reconciliation error < 7
  while wrecking). Jumps, falls and recovery should follow the same pattern.
- One hard-coded track (sharedTrack in server/room.ts, `track` const in client/game.ts).
- In flight right now and touching the same files: solid collisions (shared/physics.ts collideCars,
  client/contact.ts, client/game.ts hooks) and the easier-start merge (weapons.ts, game.ts, room.ts).
  Milestone 3 code starts only after both have merged.

## Design

1. Track features (shared/track.ts). TrackDef gains `id` and `features`, positioned by distance
   along the centerline (s) and a lateral offset where needed:
   - `ramp {s, len}`: a grounded car that crosses the ramp's end moving forward takes off.
   - `gap {s0, s1}`: no ground across the whole road (a chasm, or the stretch where this road jumps
     over another road).
   - `hole {s, lat, r}`: a round pit on the road.
   - `obstacle {s, lat, r}`: a solid scrap pile on the road (grounded cars bounce off it, airborne
     cars pass over).
   - `recovery: number[]`: recovery points (s), one before every hazard, plus the start line.
   Crossings: the track may cross itself only where one of the two sections is a `gap` (the upper,
   jumping section). Validation replaces minSelfClearance: any two far-apart sections closer than
   2*wall must be covered by a gap on one of them.
2. Airborne state (shared physics, deterministic, predicted like wrecks). CarState gains `air`
   (ticks left in the air), `airT` (total air ticks of this jump, for the height curve) and `fall`
   (ticks left blinking) plus `rec` (the recovery s chosen when the fall started).
   - Take-off at a ramp end: air = clamp(round(speed * AIR_TICKS_PER_SPEED), MIN, MAX); a car below
     the minimum take-off speed just rolls off the end (and drops into the gap if there is one).
   - In the air: velocity and heading frozen (committed jump), no throttle/steer, no wall, obstacle,
     hole or car-car contact with grounded cars; height for drawing = parabola over airT.
   - Landing (air reaches 0): if the car is inside the walls of its own section and not over a gap or
     hole it lands and drives on; otherwise it falls.
   - Grounded car whose centre enters a gap or hole: falls.
   - "Lost" (further than 2*wall from its own section, e.g. after a sideways jump): falls instead of the
     global snap.
   - Fall: fall = 90 ticks, velocity zero, rec = last recovery point at or before the car's s (wrapping);
     at the end the car is placed on the centerline at rec facing along the track, speed 0, and gets
     the same 60-tick ghost as after a wreck (server-side). Falls are not wrecks: no damage, no credit.
3. Weapons interplay: airborne cars cannot be hit by mines and do not trigger them; rivets still hit
   them (a shot at the same spot), unless that turns out confusing at the taste gate.
4. Race progress: unchanged forward-crossing logic; a recovery that moves a car back never earns or
   loses a checkpoint. Falling from the upper road onto the lower one always means recovery, so a
   crossing cannot be used as a shortcut.
5. Track selection: Room.trackId (default rust-bowl); host sends {t:"track", id} in the lobby (only);
   the room message carries trackId; changing the track resets everyone's ready flag. The server
   builds tracks from a shared registry; the client builds its Game.track and the renderer from it
   (no more module-level `track`). Lobby: a selector for the host, name + minimap preview for all.
6. Rendering: ramps (striped wedge with arrows), gaps (dark void with hazard edges; at a crossing the
   lower road is visible underneath), holes (dark pits), scrap-pile obstacles; airborne cars drawn
   bigger with a shadow that moves away with height; a falling car shrinks and blinks, a recovered car
   blinks during its ghost time. At a crossing the upper section is drawn after the lower one.
7. Two new tracks (original): "Crusher Run" (ramps over scrap piles that block the road, a field of
   holes, a chasm jump) and "Overpass Knot" (a figure-eight whose upper pass jumps over the lower road,
   plus one more pit). Each has recovery points before every hazard.
8. Bots: the bot driver (scripts/bot-ai.ts) holds full throttle and steers straight onto ramps,
   steers around holes, and knows the minimum take-off speed; practice bots can race every track.

## Tickets (each its own worker, sequenced)

- T1 Track features + airborne/fall/recovery physics (shared), track validation, server use; sim-test
  with small synthetic test tracks (jump clears / falls short / rolls off; hole; obstacle; lost; fall
  timing and recovery point; prediction parity: stepRaceCar on a clone equals the server).
- T2 Track selection: per-room track, protocol, client Game.track, lobby selector + preview, ready reset.
  Can run in parallel with T1 (different files) once the in-flight work has merged.
- T3 Rendering of the new features (after T1).
- T4 The two tracks + bot driver + bot test per track (every bot finishes a lap on each; the lagged
  bot's reconciliation error stays bounded through jumps and falls) (after T1-T3).
- Taste gates: the user drives both tracks locally before T4 merges (and looks at T3's visuals).

## Advisor changes (binding)

1. queryTrackNear loses its global fallback (all callers already pass a seg hint). "Lost" is an explicit
   dist > 2*wall test: a car falls, a shot dies. No checkpoint credit can snap across a crossing.
2. Crossing validation: the GROUND corridors (±wall, outside gaps) of two sections never intersect
   (about 230 units of gap at a perpendicular crossing, not 432); sections that come near each other are
   more than 2*LOCAL_WINDOW + margin segment indices apart; no feature in the grid zone (~400 units
   behind s = 0) or on the start straight.
3. Run-up validator (the main track test): for every recovery point, simulate stepRaceCar at full
   throttle from rest; it must clear the next hazard and land on the road (no fall loop).
4. Take-off is level-triggered at the start of stepRaceCar: grounded, inside a ~12-unit lip zone past a
   ramp end, forward speed >= minimum -> airborne; otherwise grounded over a gap or hole -> fall.
   Precedence: wreck > fall > air > drive.
5. Airborne and falling cars are not solid(): no rivets, mines or car contact, and they cannot fire or
   drop mines (mirrored on the client: armed(), cosmetic-shot targets, contact prediction, from the
   snapshot's air/fall). A wreck respawn onto a hazard goes to the recovery point; the recovery ghost
   lasts while the car still overlaps another car.
6. CarState gains only `air` and `fall`; the recovery point is derived at fall end (the car has not
   moved) and the air arc from the frozen speed. stepRaceCar returns an event (took off / fell /
   recovered) so the server sets the ghost. cloneCar, the snapshot, the reconcile snap test and the
   prevCar no-slide rule are extended; race progress is skipped while falling.
7. Cut from v1: solid obstacles (scrap piles are drawn over a gap: you must jump them, falling in means
   recovery), upper-after-lower draw order (the stroke breaks at gaps with butt caps; airborne cars are
   drawn last; the minimap breaks too), rivets hitting airborne cars, the lobby minimap preview.
8. Tickets: T1a shared physics + validation + sim-test only, in parallel with T2 plumbing (per-room
   track, trackId in the room message and on rejoin, client Game.track, renderer rebuilt per track, host
   selector). Then T1b server + client wiring; T3 rendering in parallel with T1b against T1a's schema;
   T4 the two tracks + bot driver last.
9. Tests: deterministic headless bot laps per track in sim-test (finish within N ticks, falls <= K); one
   socket race on Overpass Knot; strict prediction parity from a solo lagged bot doing a jump and a
   scripted roll-off fall (max error < 7); in multi-car races bound the count of large errors, not the max.

## Out of scope

Height-mapped terrain, bridges you drive on, air control, ramming, more than two new tracks, track
editor, sound.
