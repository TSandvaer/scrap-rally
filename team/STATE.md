# STATE — Scrap Rally coordination

**Resume (2026-11-17, latest):** local main 0060d31 (not pushed; origin/main 4f9ef51; live d912583) = ready check +
engine + easier-start + solid collisions incl. the near-car fix (user approved at re-test with ?lag=80; collisions
workspace removed). Milestone 3 wave 1 in flight on run `run_c58bb5836634`: M3-T1a ctx_0a4724b3a60b (workspace
~/orca/workspaces/scrap-rally/m3-t1a, branch TSandvaer/m3-t1a, port 3001) and M3-T2 ctx_ed4c152e2a67 (workspace
~/orca/workspaces/scrap-rally/m3-t2, branch TSandvaer/m3-t2, port 3002). File split: T2's registry goes in a new
shared/tracks.ts (T1a owns shared/track.ts); both append their own scripts/sim-test.ts section, so the second to merge
merges main first. Next: on worker_done verify, reviewer, merge; then M3-T1b + M3-T3. Ask before any push.
T1a done 2026-11-17: 2e3c752 (verified clean; sim 162/162, bots 50/50); reviewer ctx_794a317ea501 on it. Note: T2's
worker pkill'ed all `tsx server/index.ts` processes (user's :3000 server gone; user told; template now says kill by PID).
T2 done 2026-11-17: a4eeb9e (verified clean; sim 142/142, bots 61/61); reviewer ctx_6c8fe004a7e1 on it. Only shared file
with T1a: scripts/sim-test.ts (both appended; T2 also changed one harness line for the new Room signature).
T1a MERGED 2026-11-17: review APPROVE; main c4d18fc (check clean, sim 162/162, bots 50/50); review notes for T1b/T4
in team/m3-handoff.md. T2 review APPROVE (ctx_6c8fe004a7e1, kept for the merge review); T2 merge into main conflicted in
sim-test.ts -> aborted; T2 author merging main into its branch (ctx_72c21d106231).
T2 merged main as 95197b9 (verified clean; sim 184/184, bots 61/61); merge review ctx_ac3c76591fb9 (same reviewer).
Next wave prepared: tmp/spec-m3-t1b.md (port 3001) + tmp/spec-m3-t3.md (port 3002), with a shared draw contract
(Pose gains optional height/falling/ghost; T1b fills them in game.ts, T3 reads them in render.ts). Dispatch both after T2 merges.
T2 MERGED 2026-11-17: merge review APPROVE; main d0858a4 (check clean, sim 184/184, bots 61/61); ticket ready for qa test;
T2 workers released, workspace removed. Wave 2 (T1b + T3) dispatching now.
Wave 2 in flight: M3-T1b ctx_8627be7f4a8e (~/orca/workspaces/scrap-rally/m3-t1b, TSandvaer/m3-t1b, :3001) and M3-T3 ctx_aef162895d1f
(~/orca/workspaces/scrap-rally/m3-t3, TSandvaer/m3-t3, :3002; taste gate: the user looks at the screenshots before merge).
T1b: asked whether it may make TrackDef.id required in shared/track.ts -> yes (option A, only that line). T3 done: 2add760
(verified clean; 27 screenshots copied to tmp/m3-t3-shots/); reviewer ctx_e3e0a5e6a15f; AT THE TASTE GATE (screenshots shown
to the user 2026-11-17).
T3 review APPROVE (ctx_e3e0a5e6a15f; non-blocking: hole culling radius 1.8r vs cracks ~2.32r, matters only for r > ~38;
for T4 track design). T3 merge waits for the user's screenshot verdict. T1b done: cec3be6 (verified clean; sim 212/212,
bots 68/68; rec err 0.011 jump / 0.012 fall); reviewer ctx_5f98910a53ce. No file overlap T1b/T3; T3's preview tracks have ids.
T3 MERGED 2026-11-17 after the user's OK on the screenshots: main e653afc (check clean, sim 184/184, bots 61/61, build ok);
T3 workers released, workspace removed. T1b merges next (review pending), then M3-T4.
T1b review 1: REQUEST_CHANGES (otherPoses freezes far cars at a wreck/fall START: new 33 ms hitch, also on Rust Bowl;
plus a test that cannot fail). Sent to the author with `git merge main` (e653afc) as ctx_0274dcaa4905; reviewer kept for re-review.
T1b fix round: a63e979 (main e653afc merged in as 62b8884; sim 215/215, bots 68/68); re-review ctx_45a04c0b27d9.
M3-T4 spec prepared: tmp/spec-m3-t4.md (port 3001; dispatch after T1b merges).
T1b MERGED 2026-11-17: re-review APPROVE; main 3b07003 (check clean, sim 215/215, bots 68/68, build ok); T1b workers
released, workspace removed. M3-T4 dispatching now (spec also fixes the near-car height read in client/main.ts:505-507).
M3-T4 in flight: ctx_9d8c9f1f3ec4 (~/orca/workspaces/scrap-rally/m3-t4, TSandvaer/m3-t4, :3001); taste gate: the user drives both tracks.
T4 done 2026-11-17: 2cb0eed (verified clean; sim 241/241, bots 76/76; both tracks validate at base + max upgrades; bots 0
falls); reviewer ctx_cf34b3f6bb64; AT THE TASTE GATE: the user drives both tracks from the T4 workspace on :3001 (in parallel
with the review). Note: a user dev server from the removed m3-t3 workspace still listens on :3002 (user's; not touched).
T4 review 1: REQUEST_CHANGES (Crusher Run jumps on the start straight; bots drift off their lane, also on Rust Bowl). Sent with
the user's decisions (move jumps; thin the hole field) as ctx_3a7d69da31d9 (+ msg on holes); reviewer kept for re-review.
T4 fix round: 50fc79c (Crusher Run jumps past the start straight, 3 pits, startStraightEnd in validateTrack, bots hold lanes;
sim 244/244, bots 76/76); re-review ctx_c6e2e468ea28. User must restart :3001 dev server + botplay before re-driving Crusher Run.
T4 re-review APPROVE (non-blocking: a test-fixture message filter would also hide grid-zone errors; hides nothing today).
Merge waits only for the user's drive verdict on the new Crusher Run (+ Overpass Knot).
T4 MERGED 2026-11-17 (user: "looks good to merge"): main 9fb740b (check clean, sim 244/244, bots 76/76, build ok). MILESTONE 3
COMPLETE LOCALLY (not pushed). T4 workers released; workspace m3-t4 KEPT until the user stops the dev server running from it
(:3001, PID 16470), then remove it with tmp/cleanup-m3-t4.sh. Next: mine cap 3 (user, same message).
Mine cap in flight: ClickUp 123jpnbf8nx, ctx_54bbd53edc78 (~/orca/workspaces/scrap-rally/mine-cap, TSandvaer/mine-cap, :3002).
Mine cap done: 226f986 (verified clean; sim 254/254, bots 77/77); reviewer ctx_bf09de786a08.
Mine cap MERGED 2026-11-17: review APPROVE (no findings); main d79b508 (check clean, sim 254/254, bots 77/77, build ok);
workers released, workspace removed. Nothing in flight. Local main is 92 commits ahead of origin/main 4f9ef51; live d912583.
Next: ask the user about push + Manual Deploy; then the QA worker on the live site.
PUSHED 2026-11-17: origin/main = 274f052 (user approved). Waiting for the user's Manual Deploy in Render; then the QA worker.
CHAT-1 in flight (plan PLAN-CHAT.md approved): ClickUp 123jpnbf8ry, ctx_8f67ea39effb (~/orca/workspaces/scrap-rally/chat, TSandvaer/chat, :3002);
taste gate: the user tries it in two browser windows before merge.
CHAT-1 done: 2209777 (verified clean; sim 284/284, bots 82/82, build ok); reviewer ctx_f4e3ad0a7720; user taste test from the
chat workspace on :3002 in parallel.
CHAT-1 review 1: REQUEST_CHANGES (join/say/leave churn bypasses the per-player bucket and wipes the history). Sent to the
author as ctx_c0f123f7738d (room-wide budget + churn test; author uses :3003); reviewer kept for re-review.
CHAT-1 fix round: 0459d89 (room say budget 15 burst / 3 per s; join/leave line budget 12 / 0.5 per s; sim 288/288, bots 82/82);
re-review ctx_f411df817a52. Merge waits for the re-review and the user's taste verdict.
CHAT-1 re-review APPROVE (churn probe 27 lines, takeover churn within the room budget). Merge waits ONLY for the user's taste verdict.
CHAT-1 MERGED 2026-11-17 (user: "looks good"): main 972fac5 (check clean, sim 288/288, bots 82/82, build ok); workers released.
Chat workspace KEPT while the user's dev server runs from it (:3002, PID 44275); then tmp/cleanup-chat.sh. m3-t4 workspace removed
(its :3001 server is gone). origin/main 274f052 (pushed, deploy pending the user's Manual Deploy); local main 17 commits ahead
(chat + team notes): push again before the deploy if the chat should go live in the same deploy.
PUSHED AGAIN 2026-11-17 (user): origin/main = 19d759b (incl. chat). Waiting for the user's Manual Deploy; then the QA worker.
DEPLOYED 2026-11-17 (user): live serves 19d759b (bundle has chatlog / Crusher Run / Overpass Knot; /healthz ok). QA worker
ctx_eb48b9676708 (spec tmp/spec-qa-live-3.md) on 8 'ready for qa test' tickets.
LIVE QA 2026-11-17: all 8 PASS, no bugs (smoke x3: 30 snap/s, RTT median 25-40 ms, largest gap <= 83 ms; wss; no console
errors). Not checked live: Start anyway, half damage, a bot in the air. All 8 tickets -> complete. Report: tmp/qa3/QA3-REPORT.md.
Nothing in flight; all workspaces removed (chat workspace removed after the user's :3002 server stopped).
SOUND (plan PLAN-SOUND.md approved 2026-11-17): SND-1 123jpnbf9be in flight, ctx_af130886dcb7 (~/orca/workspaces/scrap-rally/snd1,
TSandvaer/snd1, :3002; taste gate: the user listens to the music). SND-2 123jpnbf9bf (race effects) queued until SND-1 merges.
SND-1 done: 7074946 (verified clean; sim 297/297, bots 82/82, build ok; song "Rust Bucket Shuffle" 122 BPM, 32 bars); 30 s WAV
copied to tmp/snd1/scrap-rally-music-30s.wav; reviewer ctx_114b837e377f; AT THE TASTE GATE (the user listens).
SND-1 review 1: REQUEST_CHANGES (label click leaves a range slider focused -> blocks driving/chat; speaker button over the
minimap). Sent to the author as ctx_2d61c5070ddf (author uses :3003); reviewer kept for re-review. Music APPROVED by the user.
SND-2 123jpnbf9bf started early on top of TSandvaer/snd1 (7074946): ctx_98dd2f7f0f8c (~/orca/workspaces/scrap-rally/snd2,
TSandvaer/snd2, :3004); it must not edit client/audio.ts, index.html, client/style.css (SND-1's fix round); it merges SND-1's final head
or main before its own review/merge.
SND-1 fix round: da6a69a (captions no longer <label>; speaker button placed clear of minimap/HUD via layout()); re-review
ctx_8dad4e11ceee. Note: the fix also touched client/main.ts (+2) and client/soundboard.ts, which SND-2 owns: SND-2's merge of snd1
may conflict there (small).
SND-1 MERGED 2026-11-17: re-review APPROVE, music approved by the user; main 2c4777a (check clean, sim 297/297, bots 82/82,
build ok); workers released, snd1 workspace removed. SND-2 told to `git merge main` before worker_done (msg_c8b362515d6d); its
no-edit rule on audio.ts/index.html/style.css is lifted.
SND-2 done: 8838ace (main 2c4777a merged in; sim 311/311, bots 82/82, build ok; trigger-log checks pass); WAV + report copied to
tmp/snd2/; reviewer ctx_d357bd4d32ab (also asked about an unexplained one-off seat loss and a context staying suspended);
AT THE TASTE GATE: the user plays a race from the snd2 workspace on :3004.
SND-2 review 1: REQUEST_CHANGES (audio.ts resume-on-visible never re-arms the gesture unlock if resume() fails -> silent until
reload). Sent to the author (uses :3005). Seat-loss note: nothing in SND-1/2 sends leave (reviewer's untested guess: a reload
without the sessionStorage token joined a new seat, the old one ran out its 20 s grace).
2026-11-17: the user's game on :3004 froze while the SND-2 worker edited sfx.ts/audio.ts/soundlogic.ts in that workspace (server
healthy; likely half-edited code hot-reloaded). Told the user to wait for worker_done, then restart. Rule added to orca-wave (3b).
SND-2 round 2 done: 895b985 (audio.ts re-arm fix + taste: buggy/4-cyl/V8 engines, machine-gun rivets, explosion, metal
crashes car+wall, gravel; kerb dropped; sim 319/319, bots 82/82, build ok). Re-review ctx_5057f654f962. FROZEN TASTE COPY for the
user: ~/orca/workspaces/scrap-rally/snd2-taste (detached at 895b985, npm ci done); remove with `git worktree remove` after the verdict.
SND-2 re-review APPROVE (no findings). Merge waits ONLY for the user's race verdict (frozen copy on :3004).
SND-2 MERGED 2026-11-18 (user: "its approved"): main 48aca02 (check clean, sim 319/319, bots 82/82, build ok); workers released,
snd2 workspace and the snd2-taste copy removed. SOUND COMPLETE LOCALLY (SND-1 + SND-2). Nothing in flight. origin/main 19d759b,
live 19d759b: the sound is not pushed or deployed; ask the user.
PUSHED 2026-11-18 (user): origin/main = a41b49b (sound). Waiting for the user's Manual Deploy; then a muted QA worker on the live site.
DEPLOYED 2026-11-18 (user started the deploy; live bundle index-CjYhpY-u.js contains "Rust Bucket" + AudioContext). Muted QA
worker ctx_7d867674fde1 (spec tmp/spec-qa-live-4.md) on SND-1 + SND-2.
ESC MENU (plan PLAN-MENU.md approved 2026-11-18): MENU-1 123jpnbf9pg in flight, ctx_2196bb24b636 (~/orca/workspaces/scrap-rally/menu1,
TSandvaer/menu1, :3006; taste gate via a frozen copy). Queued: MENU-2 123jpnbf9ph (retire), then MENU-3 123jpnbf9pj (pause).
LIVE SOUND QA 2026-11-18 (ctx_7d867674fde1): SND-1 + SND-2 PASS -> both complete. One reproduced edge case predating SND-2
(phantom own rivet after a predicted recovery, client/game.ts:631-635 armed() vs the lagging ghost) parked in
~/.claude/parking/scrap-rally/adhoc-2026-11-18.md. MENU-1: ☰ button for everyone (user).
MENU-1 done: 78143f3 (verified clean; sim 358/358, bots 86/86, build ok); reviewer ctx_f240bf70baf7; FROZEN TASTE COPY
~/orca/workspaces/scrap-rally/menu1-taste (detached at 78143f3, npm ci done; remove with `git worktree remove` after the verdict).
MENU-1 review APPROVE (no findings). Merge waits ONLY for the user's taste verdict (frozen copy on :3004).
MENU-1 MERGED 2026-11-18 (user: "all accepted"): main 94fc2af (check clean, sim 358/358, bots 86/86, build ok); worker
released, menu1 workspace removed; the menu1-taste copy stays while the user's :3004 server runs from it.
MENU-2 123jpnbf9ph in flight: ctx_63357609b130 (~/orca/workspaces/scrap-rally/menu2, TSandvaer/menu2, :3006). Then MENU-3 (pause).
MENU-2 done: 82b8fe5 (verified clean; sim 381/381, bots 90/90, build ok; design choices in tmp/menu2/menu2-report.md); reviewer
ctx_3f08f2bd7fdd; FROZEN TASTE COPY ~/orca/workspaces/scrap-rally/menu2-taste (detached at 82b8fe5, npm ci done) on :3005 (the user's
menu1-taste server still runs on :3004).
MENU-2 review APPROVE + 4 notes; user decided retired players rank by distance; fix round sent to the author (ctx_63357609b130,
spec tmp/fix-menu2-review1.md). The menu2-taste copy (82b8fe5) predates these fixes.
MENU-2 fix round: 903f3b1 (verified clean; sim 387/387, bots 90/90); re-review ctx_19012f3cf47a; menu2-taste moved to 903f3b1 (:3005).
MENU-2 re-review APPROVE (no findings). Merge waits ONLY for the user's taste verdict (menu2-taste on :3005).
MENU-2 MERGED 2026-11-18 (user: "good"): main 980fa7e (check clean, sim 387/387, bots 90/90, build ok); workers released,
menu2 workspace + menu2-taste removed (menu1-taste stays: the user's :3004 server runs from it).
MENU-3 123jpnbf9pj in flight: ctx_719f299ee99f (~/orca/workspaces/scrap-rally/menu3, TSandvaer/menu3, :3006).
MENU-3 done: 8916137 (sim 420/420, bots 92/92; adds a server-side resume hold, not in the spec; design notes in
tmp/menu3/MENU-3-report.md); reviewer ctx_97c8c95b896f; FROZEN COPY ~/orca/workspaces/scrap-rally/menu3-taste (8916137) on :3009.
MENU-3: user approved the taste test; merge waits only for the review.
MENU-3 MERGED 2026-11-18: review APPROVE (non-blocking: dead canPause(), a cosmetic local rivet for inputs discarded at the
pause, hold length not pinned in a test); main dd5708b (check clean, sim 420/420, bots 92/92, build ok). ESC MENU COMPLETE LOCALLY
(MENU-1..3). Workers released; menu3 workspace, menu3-taste and menu1-taste removed.
SND-3: user approved ("sound controls ... approved"); merge into main conflicted in sim-test.ts (runner list) -> aborted; the SND-3
worker merges main into its branch (ctx_b38e18ff6cd2); then a quick merge check and the merge.
SND-3 MERGED 2026-11-18: branch 75721e4 (main merged in; net diff = the reviewed 4 files, test-list-only resolution) -> main bdd0759
(check clean, sim 427/427, bots 92/92, build ok); workers released, snd3 workspace removed; snd3-taste stays while the user's
:3005 server runs from it. SND-5 early WAVs copied to tmp/snd5/ (Mirrorball Pit Stop, Neon Tailpipe, Gravel Surf, Grease Monkey Strut).
SND-5 done: 0241e5c (Neon Tailpipe default + Mirrorball; Rust unchanged; sim 407/407 on its old base); conflicts with main ->
worker merging main first, then review.
SND-5 merged main: faad7a3 (merges cleanly; sim 447/447, bots 92/92); reviewer ctx_b7ddee34c881. The songs were already approved
by ear (user); merge on review APPROVE.
SND-5 MERGED 2026-11-18: review APPROVE (nit: one style check proves the fifth, not the octave); main 066fc97 (check clean, sim
447/447, bots 92/92, build ok); workers released, snd5 workspace removed.
SND-4 123jpnbfa7e in flight: ctx_926803ba25ea (~/orca/workspaces/scrap-rally/snd4, TSandvaer/snd4, :3006). After it: ask about push + deploy
(Esc menu + music controls + songs + SND-4).
SND-4 done: dfb3dbd (merges cleanly; sim 479/479, bots 95/95, build ok); reviewer ctx_81157ecfcd96; FROZEN COPY
~/orca/workspaces/scrap-rally/snd4-taste (dfb3dbd) on :3009 (snd3-taste still serves the user's :3005).
SND-4 review 1: REQUEST_CHANGES (host Room Music drag through 0 can turn the room's music off: throttled patch merge vs a lagging
room message; + keyboard-focused popover/lobby sliders hide host changes; + sound board slider). Sent to the author; reviewer kept.
SND-4 fix round: 19ba4c8 (roomMusicSlid always sends musicOn + drag replay test; grabbed-only skip; board slider; sim 482/482,
bots 95/95); re-review ctx_fabd7ad935db; snd4-taste moved to 19ba4c8 (:3009).
SND-4 re-review: REQUEST_CHANGES #2 (grabbed sticks in WebKit) -> user: fix then merge; sent to the author; reviewer kept for a quick re-check.
SND-4: user approved the taste test; merge after the WebKit fix + re-check.
SND-4 round 3: 770d402 (SliderGrip ends a drag on pointerup too; default music 0.4 with legacy-0.5 migration; sim 486/486, bots 95/95;
merges cleanly); re-check ctx_3f1ecf523cbc. Merge on APPROVE.
SND-3 123jpnbfa3a in flight in parallel: ctx_f56ecded07e9 (~/orca/workspaces/scrap-rally/snd3, TSandvaer/snd3, :3007; files audio.ts, index.html, style.css only).
SND-3 done: 47606ac (sim 394/394, bots 90/90); review APPROVE (ctx_1b41cd13cc04; notes: switch-on restores the volume
remembered at the last switch-off; storage can't tell own from default -> SND-4); FROZEN COPY ~/orca/workspaces/scrap-rally/snd3-taste
(47606ac) on :3005. Merge waits for the user's taste verdict (and needs main merged in: possible 1-line sim-test runner conflict with MENU-3).
SND-4 (host sound defaults) plan approved (PLAN-SOUND.md); ClickUp 123jpnbfa7e; dispatch after MENU-3 + SND-3 merge. SND-4 also gains the host's song choice (PLAN-SOUND.md SND-5 section).
SND-5 123jpnbfa7m (four new songs) in flight: ctx_e20700e1079f (~/orca/workspaces/scrap-rally/snd5, TSandvaer/snd5, :3008; files music.ts,
soundboard.ts, sim-test append). Early WAV preview requested. Still pending: remove m3-t4 workspace once the
user stops :3001 (PID 16470).

**Resume (2026-11-16):** main 0dec6c9 (local, 15 ahead of origin) = ready check + engine
(pushed 4f9ef51) + easier-start (merged locally, user-approved, reviews APPROVE). Deploys are batched:
live is a41b49b; ask before the next push. In flight on run `run_c58bb5836634`: dispatch
`ctx_c8a5662fcae7` on ClickUp 123jpnbf6cy "Solid collisions" (workspace
~/orca/workspaces/scrap-rally/solid-collisions, branch TSandvaer/solid-collisions, port 3002; must merge main
before its own merge). Taste test moved AFTER merge (user, 2026-11-16): merge on reviewer APPROVE + gate,
then the user plays from the main checkout; M3 starts on the user's OK.
Update 2026-11-16: author done, head 0ca2619 (main merged in; sim 117/117, bots 50/50; verified clean);
ticket in review; reviewer ctx_d881cd9c7151 on new run run_3bffa6014793 (author still on run_c58bb5836634).
MERGED 2026-11-16: review APPROVE (3 non-blocking notes in the ClickUp comment); main 72f5697 = collisions
(gate: check clean, sim 117/117, bots 50/50); ticket ready for qa test; reviewer released. NOW AT THE TASTE TEST:
the user plays from the main checkout (:3000; try ?lag=80 too, prediction goes inelastic with latency).
Author worker + workspace kept until the verdict (restitution tuning goes to it). Then: cleanup, start M3-T1a + M3-T2.
VERDICT 2026-11-17: collisions good, but near cars stutter (only near own car, small jumps). Fix sent to the author
as follow-up dispatch ctx_15dbcec1753f (run run_c58bb5836634; spec tmp/fix-near-car-stutter.md: measure jerk near vs far,
lag 0/80, fix, before/after numbers). Then reviewer, merge, user re-test, then M3.
Stutter fix done 2026-11-17: fa93f5f (verified clean; one commit on main 23455cf; sim 119/119, bots 50/50; near
stutter 74% -> 0.014% at lag 80). Reviewer ctx_2cb05dd0f689 (run run_c58bb5836634) on fa93f5f.
Review 1 of fa93f5f: REQUEST_CHANGES (stutter returns at ~125-130 ms RTT near the 250 ms cap; bumps against an undrawn
pose past the cap; a vacuous spring test; debug meter sorts 50k samples per frame; heading mismatch). Sent to the author
as ctx_713c5ec66cd1 (spec tmp/fix-stutter-review1.md, incl. a ?lag=140 measurement). Reviewer kept for the re-review;
a second REQUEST_CHANGES goes to the user.
Fix round done: 1d0bab5 (verified clean; cap 300 ms, no bumps past it; sim 122/122, bots 50/50; near stutter <= 0.10% up
to RTT 210). Re-review ctx_6f083a1803ba on 1d0bab5.
MERGED 2026-11-17: re-review APPROVE; main 18ce581 (check clean, sim 122/122, bots 50/50); ticket ready for qa test;
reviewer released. AT THE USER'S RE-TEST from main (:3000, also ?lag=80). Author worker + workspace kept until the verdict. Milestone 3 queued (below), starts after collisions merge.

**Resume (2026-11-15):** Live: https://scrap-rally.onrender.com at d912583. In flight on run
`run_c58bb5836634`: dispatch `ctx_a40ce564286f` (task task_3736690503f4) on ClickUp 123jpnbf3xa "Easier
start" (no starting ammo, weapons armed 8 s after GO, half damage; DECISIONS 2026-11-15), workspace
~/orca/workspaces/scrap-rally/easier-start, branch `TSandvaer/easier-start`, port 3001. Review 1 of cfbbd43:
REQUEST_CHANGES (client sends the fire bit inside the 8 s window) + 2 nits; fixed by `ctx_d0cabb08c49a` as 9ba7740
(verified; sim 56/56, bots 44/44 x2); re-review APPROVE (`ctx_933890711ac8`). NOW AT THE TASTE GATE: the user plays the
branch from the worker workspace on :3002 (+ botplay --url ws://localhost:3002/ws); keep that workspace
until the verdict. Then: the user tries the branch locally before merge (show how), then merge, push +
Manual Deploy only on the user's go-ahead. The user's own dev server runs on :3000 from the main checkout.

## Branches

- `main` = origin/main = d912583 (deployed). Later team/ commits are local only.

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbfa7e SND-4 | ctx_926803ba25ea | ~/orca/workspaces/scrap-rally/snd4 | TSandvaer/snd4 | 3006 | 2026-11-18 |

## Queued (milestone 3, PLAN-M3.md; start after solid collisions 123jpnbf6cy and easier-start 123jpnbf3xa merge)

1. 123jpnbf6e6 M3-T1a shared track features + jump/fall/recovery physics + validation  } in parallel
2. 123jpnbf6e7 M3-T2 per-room track + host track selection (plumbing)                  }
3. 123jpnbf6e8 M3-T1b server/client wiring (after T1a + T2)                            } in parallel
4. 123jpnbf6e9 M3-T3 rendering (after T1a; taste gate: screenshots)                    }
5. 123jpnbf6ea M3-T4 Crusher Run + Overpass Knot + jumping bots (last; taste gate: user drives both)

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
