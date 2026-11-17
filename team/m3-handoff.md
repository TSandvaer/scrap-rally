# M3 hand-off notes (from reviews; feed into later ticket specs)

## From the M3-T1a review (ctx_794a317ea501, 2026-11-17, on 2e3c752; merged as c4d18fc)

For T1b (wiring):
1. Make CarState.air and fall required. The car literal at server/room.ts:234 and the snapshot-to-CarState
   mapping at client/game.ts:430-438 drop them (cloneCar fills in 0). TrackDef.id should be required in the
   registry (shared/tracks.ts from T2).
2. server/room.ts:304 ignores stepRaceCar's returned event: ghost on "recover" and no race progress while
   falling are still to do.
3. Advisor change #5 not wired yet: mineHits, shotHits, collideCars and client armed() ignore air and fall.
4. The reconcile snap rule (client/game.ts:476) and the prevCar no-slide rule (client/game.ts:563) check only
   wreck, not fall or recover.
(Line numbers are at 2e3c752, before T2 merged; re-locate them.)

For T4 (tracks + bots):
5. scripts/bots.ts:327 still asserts minSelfClearance; a crossing track fails it by design: switch to
   validateTrack + validateRunUps.
6. Constants (author's picks, flagged not tuned): min take-off 220 u/s gives a ~95-unit jump; at top speed 430
   ~52 air ticks ~373 units (MAX_AIR_TICKS 60 never reached at base stats); a 230-unit crossing gap needs
   ~340 u/s = ~275 units of run-up from rest. START_ZONE 300 is a fixed length, not the real start straight.
   validateRunUps defaults to BASE_STATS; Engine upgrades (+21% accel) mean faster take-offs and longer jumps,
   so also validate with max upgrades.
7. A recovery point at s=0 is not enforced (PLAN-M3 design 1 says "plus the start line"): T4 tracks list 0
   explicitly.
- T3 review note (non-blocking): hole culling at client/render.ts:494 (T3 branch) uses r*1.8 but cracks reach ~2.32r; holes with r > ~38 could pop in at the screen edge. Keep T4 holes r <= 38 or widen the cull.
