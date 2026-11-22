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
SND-4 MERGED 2026-11-18: re-check APPROVE; main ab39ede (check clean, sim 486/486, bots 95/95, build ok); workers released, snd4
workspace and snd3-taste removed; snd4-taste stays while the user's :3009 server runs from it. NOTHING IN FLIGHT. Local main is ahead
of origin/live a41b49b with: Esc menu (MENU-1..3), SND-3, SND-5, SND-4. Next: ask the user about push + deploy.
PUSHED 2026-11-18 (user): origin/main = 3270cc8. Waiting for the user's Manual Deploy; then the muted QA worker.
LIVE 2026-11-18 (checked by curl): live serves index-DSldUeIn.js = local 3270cc8 build. snd4-taste removed (:3009 free).
QA5 live in flight: ctx_993ce6b20edf (run_fa7a81c5a7b8, main checkout, spec tmp/spec-qa-live-5.md, report
tmp/qa5-menu-music-live-report.md). On PASS: the 6 tickets -> complete.
QA5 PASS 2026-11-18 (report tmp/qa5-menu-music-live-report.md): all 6 tickets PASS on live, no console errors; not checked:
pause resume when the pauser leaves, pause during countdown, mine refunds, capped-ammo scrap-back, clipboard contents.
Tickets 123jpnbf9pg/9ph/9pj/fa3a/fa7m/fa7e commented + complete; QA worker released. NOTHING IN FLIGHT.
GHOST-RIVET 123jpnbfayd (user chose 2026-11-18; from the parked QA4 phantom-rivet note) in flight: ctx_9aae16a600e1
(run_fa7a81c5a7b8, ~/orca/workspaces/scrap-rally/ghost-rivet, :3006). No taste gate: reviewer APPROVE then merge.
ghost-rivet done 2026-11-18: a837616 (test a81cfbc red on main 6/6 per author; sim 492/492, bots 95/95; merges cleanly;
report tmp/ghost-rivet-report.md); reviewer ctx_e8ebac87fc8e (spec tmp/review-ghost-rivet.md).
GHOST-RIVET MERGED 2026-11-18: review APPROVE (no findings; red 0/6 at a81cfbc, green 6/6 at a837616); main ab1781e (check
clean, sim 492/492, bots 95/95, build ok); ticket ready for qa test; workers released, workspace + branch removed. Local main
ahead of origin (3270cc8) with the fix; not pushed. NOTHING IN FLIGHT.
NEXT (user 2026-11-18): "Polish the graphics, keeping it retro and without compromising performance" + "Use fable for
graphics always" -> graphics plan drafted by a Fable agent, Fable advisor review, user approval; graphics workers --model
claude-fable-5-2.
PLAN-GFX.md APPROVED 2026-11-18 (Fable draft + Fable advisor "sound with changes", folded in; user: 128 headings, real-phone
check, GFX-4 decals included). Tickets: GFX-0 123jpnbfb23, GFX-1 123jpnbfb24, GFX-2a 123jpnbfb26, GFX-2b 123jpnbfb28, GFX-3
123jpnbfb29, GFX-4 123jpnbfb2c. Waves: GFX-0 (palette taste gate) -> GFX-1 + GFX-3 -> GFX-2a + GFX-2b -> GFX-4.
GFX-0 in flight: ctx_27a7a271607b (Fable, run_fa7a81c5a7b8, ~/orca/workspaces/scrap-rally/gfx0, TSandvaer/gfx0, :3006).
GFX-0 done 2026-11-18: 50bbe04 (check clean, sim 492/492, bots 95/95, build ok; report gfx0/tmp/gfx0/REPORT.md). User APPROVED the
palette + mock direction (taste gate). Review APPROVE (Fable ctx_c6423d93d343, 7 non-blocking findings). User chose the
STRICTER speed gate (median paired ratio this/base > 1.05 = OVER; fixed ref = GFX-0 merge, not moving main). Fix round 1
(gate + findings 2-7, tmp/gfx0-fix1.md) sent to the author as ctx_39371bddc46c; reviewer kept for the re-check. Merge after.
GFX-3 in flight (palette approved; based on TSandvaer/gfx0 @ 50bbe04): ctx_c7bda5e6427e (Fable, ~/orca/workspaces/scrap-rally/gfx3,
TSandvaer/gfx3, :3007; style.css + index.html only).
GFX-0 fix round 1 done: fb7a664 (paired-ratio gate, fixed ref file scripts/gfx-baseline.ref, runner builds itself, exit 1 on
OVER, cleanup, unique sessions, S4/S5 cold, haz2; no-change band 0.937-1.048, +0.25 ms caught 29/30). Re-check sent to the
reviewer as ctx_e6ea892f3257 (incl. confirm-on-OVER question). After merge: append the merge SHA to scripts/gfx-baseline.ref.
GFX-0 MERGED 2026-11-18: re-check APPROVE; main 7881af6 (check clean, sim 492/492, bots 95/95, build ok); scripts/gfx-baseline.ref
pinned to 7881af6 (9fdf041). Re-check found false FAILs on unchanged builds -> user approved safeguards (lock, INVALID on noisy
runs, confirm-on-OVER, metric A gated at 1280x720): sent to the GFX-0 author as ctx_38392f0824f9 (tmp/gfx0b-safeguards.md;
same branch after merging main; scripts/bench.ts + PLAN Baseline section only). GFX-0 ticket stays in progress until then.
GFX-3 done: 8d6698d (style.css only; 0/2486 boxes moved; contrast >= today; bench ok). User APPROVED the look (taste gate).
Reviewer ctx_586956fc3a88 (Fable, tmp/review-gfx3.md). Merge on APPROVE.
GFX-3 review 1: REQUEST_CHANGES (pressed small link buttons resize; 360 px select widens the lobby 8 px; inset shadows repaint
on scroll). Fix round sent to the author as ctx_03d64bc1f2ec (tmp/gfx3-fix1.md; 360 fix only under a narrow media query, look
kept); reviewer kept for the re-check. NOTE: 3 authors active for this fix round (GFX-1, GFX-0 safeguards, GFX-3 fix) — over
the 2-worker cap; told the user. No new author starts until one finishes.
GFX-3 fix round done: 438b23e (pressed links fixed; 360 px select under max-width 374px, 0 box diffs 320-720; edge lines as
background layers, 0 scroll paints). Re-check sent to the reviewer as ctx_bd9aef13ef22. Authors active now: GFX-1, GFX-0 safeguards.
GFX-3 MERGED 2026-11-18: re-check APPROVE (no findings); main 1146a50 (check clean, sim 492/492, bots 95/95, build ok); ticket
ready for qa test; workers released, workspace + branch removed. In flight: GFX-1 (ctx_b5075af01fdf), GFX-0 safeguards
(ctx_38392f0824f9). Local main ahead of origin 3270cc8 (ghost-rivet, GFX-0, GFX-3); not pushed.
GFX-1 ready except the final gate: head 5ab1515 (4 commits + main 23f59ee merged); zero-diff extraction proven, A1-A6, edge check 0,
npm test twice green, 64 pairs; provisional gate (A, 1280x720, 5 runs vs gfx-baseline) 30 ratios 0.069-0.707, 0 OVER. Told to WAIT
for the safeguards merge (their validation is running now), then merge main + final full gate.
GFX-0 safeguards done: 101a77e (lock, INVALID exit 2 at noise > 0.10, confirm-on-OVER, A at 1280x720; unchanged PASS, +0.25 ms FAIL
11 confirmed, forced/real noise OVER not confirmed). Machine was loaded by another project (vitest, k6): 24/28 runs INVALID.
Review sent to the Fable reviewer as ctx_7fa8414062df (incl. 'verdict stands when noise cannot change it' question).
Safeguards review APPROVE (findings: test hook <1, PASS without A, PLAN counts, wording). MERGED 2026-11-18: main 2a964ca (check
clean, sim 492/492, bots 95/95, build ok). User adopted the reviewer's MARGIN RULE (popup). Round sent to the GFX-0 author as
ctx_db2f67477a12 (tmp/gfx0c-margin.md: margin rule, control cells, findings 1-4, optional stale-lock check). GFX-1 stays idle
until that merges, then: merge main + final full gate.
Margin rule done: 01a9a39 (replay 16/16 agrees with the reviewer's rules.py; control cells; findings fixed; --judge <file>;
live default gate of main 2a964ca vs gfx-baseline: PASS exit 0, 2 noise OVERs not confirmed). Re-check sent as ctx_fbd30d7d19f8
(no live benches; --judge only).
Margin rule re-check APPROVE (gap: 'partial' misses a --viewports cut; gate reports must show 30 A ratios, B 6 cells, construction
6). MERGED 2026-11-19: main 7641946 (check clean, sim 492/492, bots 95/95, build ok). GFX-0 ticket complete; author released,
gfx0 workspace + branch removed; reviewer ctx_fbd30d7d19f8 kept (Fable, knows the bench) for GFX-1's review.
GFX-1 told to merge main + run the FULL default gate (msg_1d2c9db837c0).
GFX-1 done 2026-11-19: b9802ef (main 7641946 merged; check clean, sim 492/492, bots 95/95 twice, build ok). Full gate PASS (no partial,
fixed ref, noise 0.011, 30 A ratios 0.073-0.758, B 6 ok, construction 6 ok). Tile pool 6,291,456 B. Metric G tail higher (S5 p99 up to
4.97x, max 2.45 ms) and cold first frame 24-46 ms vs ~4 ms: for the reviewer + the phone check. Review sent to ctx_8759db0cfc1e.
TASTE: frozen copy ~/orca/workspaces/scrap-rally/gfx1-taste (detached b9802ef, built), served by the orchestrator on :3009
(node pid 65779, background task b9ob7nwth); phone via http://192.168.50.109:3009/?debug=1. Stop it by PID after the gate.
GFX-1 taste gate: user APPROVED (popup). Review APPROVE (ctx_8759db0cfc1e; finding 1: tileKey > 2^31 boxes map keys, ~0.5 kB/frame,
rule 1; finding 2: plain dirt squares 8-19 frames after a far leader switch, allowed; metric G tail + cold first frame judged
acceptable, cheap fix noted at world.ts:1598-1600 if the phone shows it). Taste server stopped (background limit), gfx1-taste removed.
Orca restarted 2026-11-19: GFX-1 author/reviewer exited. Fix round for finding 1 as a new Fable worker in the gfx1 workspace:
ctx_ac24c4c10030 (tmp/gfx1-fix1.md; world.ts only; probe tmp/gfx1-review/alloc.mts). Merge after a quick re-check.
Fix 1 done: 41c20ff (two-level tile map, 30-bit tx/ty key; probe ~600 -> 129-176 B/frame vs probe-alone 104-106; checksums 15/15 same,
--pixels 0 diff, S1/S3 ratios 0.974-1.000). Leftover aim boxing (world.ts:1669, 0-32 B/frame) sent back as fix 1b: ctx_c2193c866446.
Fix 1b done: eeb8951 (aim via reused Float64Array; World.aim+draw 0.01/0.15/0.01 B/frame; 15/15 checksums, --pixels 0, replay
identical; S1/S4 0.949-1.017). Re-check by a new Fable reviewer ctx_a78759883f3e (tmp/review-gfx1-r2.md). GFX-1 pairs + reports
copied to tmp/gfx1-pairs/ and tmp/gfx1-review/. Specs ready: tmp/spec-gfx2a.md (:3006) + tmp/spec-gfx2b.md (:3008), dispatch both
(Fable) right after the GFX-1 merge.
GFX-1 MERGED 2026-11-19: re-check APPROVE (no findings); main dc74e80 (check clean, sim 492/492, bots 95/95, build ok); ticket ready
for qa test; workers released, gfx1 workspace + branch removed. Parked (bake steps allocate 1.8-2.4 kB/frame while baking) added
to GFX-4's scope (ClickUp comment).
WAVE 3 in flight (Fable): GFX-2a ctx_a885a3b7e8ba (~/orca/workspaces/scrap-rally/gfx2a, TSandvaer/gfx2a, :3006; contact sheet of
one car comes via `ask` -> show the user) and GFX-2b ctx_6fe6fc1725f2 (~/orca/workspaces/scrap-rally/gfx2b, TSandvaer/gfx2b, :3008).
Both touch render.ts call sites only; the second to merge merges main first. Local main ahead of origin 3270cc8; not pushed.
GFX-2a contact sheet: user said GO (popup) on the car design for all six colours; mine shake only when the own car is hit
(4 px; user). Orchestrator allowed 2a ONE appended preview.ts scene 'blast' (no existing scene may change).
2026-11-19 ~10:42 GFX-2b hit the Claude 5-hour session limit (commits 8a307e2 font, 62daa9e hud/minimap); user said go ->
resumed 11:22 via reply. GFX-2a running its full gate since ~11:04 (bench pid 3593, lock held; commits up to 19b1c52).
GFX-2b done: 62daa9e (font 8a307e2 + HUD/minimap; full gate PASS, noise 0.006, 30 A ratios 0.029-0.692, B 6, construction 6; HUD
0.02 B/frame; merges cleanly with main and with gfx2a). Reviewer ctx_2720833e1432 (Fable, tmp/review-gfx2b.md; judge-only, no live
bench). Pairs copied to tmp/gfx2b-pairs/. Plan: ONE combined frozen taste copy (main + gfx2a + gfx2b) once 2a reports.
GFX-2a done: 19b1c52 (full gate PASS, noise 0.012, 30 A ratios 0.064-0.780, B 6, construction 6; actors/effects ~0 B/frame; sprite
canvases 4,882,432 B, 11,173,888 B with the tile pool). Reviewer ctx_e30089c1bd60 (Fable, tmp/review-gfx2a.md). Pairs in tmp/gfx2a-pairs/.
SEMANTIC MERGE CONFLICT 2a+2b: textually clean, but render.ts:120 `const cx = vx / ZOOM, cy = vy / ZOOM;` becomes unused -> tsc
TS6199. The second branch to merge must delete it (merge main, fix, re-check). Taste copy: ~/orca/workspaces/scrap-rally/gfx2-taste
(detached main a6af6f7 + merge 520778e of gfx2a+gfx2b, that one line deleted locally, built) served on :3009 by node pid 10368
(nohup; log ~/orca/workspaces/scrap-rally/gfx2-taste-server.log); LAN now 172.16.0.31. Kill by PID after the taste gate.
TASTE 2a+2b (user, laptop only): everything looks good EXCEPT the own car jitters ~1 px against the road while driving (user
confirmed own car in a popup). Reviews: 2a APPROVE no findings (ctx_e30089c1bd60); 2b REQUEST_CHANGES (minimap gap breaks shrink to
notches on Crusher Run; non-blocking 0=O, V~U, countdown x-height, debug line cut) (ctx_2720833e1432).
Fix rounds: 2b -> ctx_7f37d62580e8 (tmp/gfx2b-fix1.md: gaps + 0/O + V/U); 2a -> ctx_b625f2dff27b (tmp/gfx2a-fix1.md: own-car jitter,
instrument first, trace script under tools/debug/). Merge order: 2b first, then 2a merges main + deletes the unused render.ts line.
Taste server :3009 (pid 10368) still up for re-tests.
2b fix 1 done: 63fa725 (gaps break >= own length; 0 distinct from O; V pointed; debug line uncut; countdown x-height left at 6;
quick look unchanged). Re-check sent to ctx_14a5f3b78b13.
GFX-2b MERGED 2026-11-19: re-check APPROVE (no findings); main 29041d0 (check clean, sim 492/492, bots 95/95, build ok); ticket
ready for qa test; workers released, gfx2b workspace + branch removed (artefacts in tmp/gfx2b-pairs/). 2a told to merge main +
delete the unused render.ts line after its jitter fix.
GFX-2a fix 1 done: ffb4323 (a22bd84 view+followed car stepped together; main 77a48d6 merged as 707e57d; unused cx/cy removed;
trace tools/debug/jitter-trace.ts: own car on screen 1450 -> 0 reversals, race 715 -> 1 flips; 20 pacing-car steps in bends left).
Re-check ctx_7e34aa105676. New taste copy gfx2-taste detached at ffb4323, served on :3009 by node pid 24346 (old pid 10368 killed).
User re-tested ffb4323: car steady, approved (popup). Merge on the reviewer's APPROVE; then GFX-4.
2a re-check (ctx_7e34aa105676): jitter fix correct on all 5 checks; REQUEST_CHANGES on one older rule-1 line: carSheet's arrow
closure allocates a 40 B context per car sprite per frame (~166 B/frame, sprites.ts:526). First REQUEST_CHANGES on 2a. Fix worker
ctx_91f1287793f6 (tmp/gfx2a-fix2.md; reviewer diff + probes in tmp/gfx2a-review/). Taste server :3009 pid 24346 still up.
2a fix 2 done: 5302085 (paintCar; probe 166 -> ~0 B/frame; no context in carSheet bytecode; 0 px diff). Re-check sent to
ctx_0c0c0bf40bef but it never ran (reviewer process had exited; stopped 20:30). Fresh Fable reviewer ctx_c7c1344222df
(tmp/review-gfx2a-r3.md). GFX-4 spec ready: tmp/spec-gfx4.md (dispatch after the 2a merge).
GFX-2a MERGED 2026-11-19: re-check APPROVE (no findings); main 57f4092 (check clean, sim 492/492, bots 95/95, build ok); ticket
ready for qa test; workers released, gfx2a workspace + branch removed (artefacts in tmp/gfx2a-pairs/).
GFX-4 in flight (Fable): ctx_297e4d30b671 (~/orca/workspaces/scrap-rally/gfx4, TSandvaer/gfx4, :3006; spec tmp/spec-gfx4.md: bake allocation fix
first, then mine scorch, skid marks only with margin). Taste copy at ffb4323 still on :3009 (pid 24346) until GFX-4's replaces it.
Local main 57f4092 ahead of origin 3270cc8 (ghost-rivet, GFX-0, GFX-3, GFX-1, GFX-2b, GFX-2a); not pushed.
GFX-4 done: f7ead2b (9c5fff5 bake alloc-free + 041eae9 speed; b6ebc6b scorch ring 128 + tyre marks ring 2048; full gate PASS,
30 A ratios 0.020-0.681; stress p99 CPU 0.125->0.125, GPU 0.545->0.585 ms). Reviewer ctx_9938f1887001 (tmp/review-gfx4.md). Report +
pairs copied to tmp/gfx4-pairs/. Taste copy gfx4-taste (detached f7ead2b) on :3009, node pid 51032 (old 24346 killed, gfx2-taste removed).
GFX-4: user APPROVED at the taste gate (popup); review APPROVE (ctx_9938f1887001; notes: remembered blast places not cleared with
the marks; own-car tyre marks x2.5 under lag 150; ring 2048 accepted). Both are this ticket's own code -> small fix round before merge
(tmp/gfx4-fix1.md) as a new Fable worker in the gfx4 workspace.
GFX-4 fix worker: ctx_0b04325d8ada.
NEW (user 2026-11-20): host chooses Mines: Stay (default) / Fade. User popups: lobby dropdown, applies next race; Fade = 25 s +
2 s blink; Stay = until hit, cap 40 (oldest blinks out). Ticket MINES-1 123jpnbfdq6; spec tmp/spec-mines1.md (Fable, touches
actors.ts). Dispatch AFTER GFX-4 merges (actors.ts/main.ts overlap).
2026-11-20: user tested the gfx4-taste copy (f7ead2b, the whole graphics round) and said "approved".
DEPLOY PLAN (user popup 2026-11-20 "Push right after GFX-4"): once GFX-4 is merged and the main gate is green -> push main to origin,
user clicks Manual Deploy in Render, then a muted live QA worker. MINES-1 follows in a later deploy.
GFX-4 fix round done: bb07a73 (0790534 blast places cleared with the marks; bb07a73 tyre marks from the cars' driving, not the
prediction on screen; live lagged pack race 83/98 -> 0/8 stamps; lag 0 slightly fewer marks). Re-check ctx_ce6a706672d8
(tmp/review-gfx4-r2.md). Taste copy gfx4-taste moved to bb07a73, :3009 node pid 12549 (old 51032 killed).
Re-check: REQUEST_CHANGES (first on GFX-4): marksOn()'s first-mark clearMarks() counts as a clearing -> blasts in that 300 ms
window leave no scorch (world.ts:1973/2040, actors.ts:322-330). Fix (b) passes; no new taste check needed. Fix 2 worker
ctx_d61d57754174 (tmp/gfx4-fix2.md). A second REQUEST_CHANGES on GFX-4 goes to the user.
Fix 2 done: 68a8e65 (dropMarks() uncounted for a first mark; marks-check 36/36, 3 FAIL on bb07a73; 0 px diff). Quick re-check APPROVE
(ctx_d227c7211199). GFX-4 MERGED 2026-11-20: main c6cbd45 (check clean, sim 492/492, bots 95/95, build ok). Graphics round complete.
Pushing main to origin now (user popup "Push right after GFX-4"); then the user clicks Manual Deploy; then muted live QA; MINES-1 next.
PUSHED 2026-11-20: origin/main 3270cc8..4819a45. Waiting for the user's Manual Deploy, then muted live QA. GFX-4 ticket ready for qa
test; GFX-4 workers released, gfx4 workspace + branch removed (taste copy gfx4-taste on :3009 still up).
MINES-1 in flight (Fable): ctx_7199ccb0ef4c (~/orca/workspaces/scrap-rally/mines1, TSandvaer/mines1, :3006; spec tmp/spec-mines1.md).
LIVE 2026-11-20 (checked by curl): live serves index-SEQmFjen.js (= the 4819a45 build). Muted live QA6 on Opus: ctx_8dbb75aa73c1
(tmp/spec-qa-live-6.md -> tmp/qa6-graphics-live-report.md). On PASS: the 6 tickets -> complete.
MINES-1 done: cfc7cb0 (sim 532/532, bots 100/100; blink 0 B/frame; 40 mines +0.03 ms). Opus reviewer ctx_84e0d120f6e7 (tmp/review-mines1.md).
Taste copy mines1-taste (detached cfc7cb0) on :3009, node pid 28890 (gfx4-taste removed, old pid 12549 killed).
MINES-1 MERGED 2026-11-20: review APPROVE (Opus) + user taste APPROVE; main 797d290 (check clean, sim 532/532, bots 100/100, build ok);
ticket ready for qa test; workers released, mines1 workspace + branch removed. Not pushed (next deploy). QA6 live still running.
QA6 LIVE PASS 2026-11-20 (tmp/qa6-graphics-live-report.md): all 6 tickets PASS, no console errors; not checked live: wrecked/
burnt looks, 128 headings, smoke/dust, scorch clearing at a new race. Tickets 123jpnbfayd, GFX-1/2a/2b/3/4 commented + complete;
QA worker released. Graphics round DONE and LIVE (4819a45). Local main a8182b8 = live + MINES-1 (797d290), not pushed.
NOTHING IN FLIGHT. Taste copy mines1-taste still on :3009.
PUSHED 2026-11-20 (user popup "Push MINES-1 now"): origin/main 4819a45..2e9ec7f. Waiting for the user's Manual Deploy; new bundle
index-pWtsH_4Y.js (live now index-SEQmFjen.js); then a short muted live QA of the Mines setting.
NEW (user 2026-11-20, game ideas): car types (sport/racer/truck with traction+acceleration), longer tracks with obstacles
(rolling barrels, ramp truck, tyre mound bounce, water/aquaplaning), catch-up mechanic (research other games), floating speed
pickups (hard to reach, airborne via ramps), branching paths. Opus Plan agent drafting PLAN-M4.md (background); then Fable advisor
review (user popup: keep the rule for plan reviews), then user approval. MINES-1 deploy still waiting for the user's Manual Deploy.
PLAN-M4 APPROVED 2026-11-20 (Opus draft, Fable advisor 'sound with changes', 13 binding changes; user decisions in the plan).
WAVE 1 in flight: M4-BOTS 123jpnbffd8 ctx_2c145cced1d2 (Opus, ~/orca/workspaces/scrap-rally/m4-bots, TSandvaer/m4-bots, :3006) and M4-LOOKS
123jpnbffd9 ctx_52d5f91b4d80 (Fable, ~/orca/workspaces/scrap-rally/m4-looks, TSandvaer/m4-looks, :3008; contact sheet via `ask` -> show the user).
M4-BOTS asked for client/menu.ts (disable Make host on bot rows, bot Remove wording): granted (no other owner).
M4-LOOKS contact sheet: user GO (popup) on Sport/Racer/Truck looks. Worker's design: state painted into each car's sheet (worst case
11,173,888 B) accepted on condition the mid-race repaint causes no hitch (measure; spread/pre-build if > ~2 ms).
M4-BOTS done: f19fdcd (sim 587/587, bots 100/100; 3 Normal + 3 Easy finish every track, identical rerun; bot step 0.42 us, room
tick 5 bots 5.25 us). Opus reviewer ctx_8860bc601f07 (tmp/review-m4-bots.md). Report + shots in tmp/m4-bots/.
Taste copy m4-bots-taste (detached f19fdcd) on :3009, node pid 38107 (mines1-taste removed, old pid 28890 killed).
M4-BOTS taste gate: user APPROVED (popup). Merge on the Opus reviewer's APPROVE.
M4-BOTS MERGED 2026-11-20: review APPROVE (no findings); main 9a71e5d (check clean, sim 587/587, bots 100/100, build ok); ticket
ready for qa test; workers released, m4-bots workspace removed (taste copy m4-bots-taste still on :3009).
WAVE 2: M4-CARS 123jpnbffdz + M4-ENV 123jpnbffe0 in ONE Opus worker ctx_99a9c55e67a2 (~/orca/workspaces/scrap-rally/m4-cars, TSandvaer/m4-cars, :3006;
spec tmp/spec-m4-cars-env.md; it waits for my word that M4-LOOKS merged before wiring CarView.car). M4-LOOKS still in flight.
M4-LOOKS done: 1a2f1e4 (gate PASS, noise 0.005, 30 A ratios 0.021-0.700; memory 11,173,888 B unchanged; repaint ~0.2 ms; 0 px diff
in 17 scenes). User APPROVED the looks in motion (popup). Fable reviewer ctx_21d8f4e7a383 (tmp/review-m4-looks.md). Evidence copied to
tmp/m4-looks/. On merge: tell M4-CARS (ctx_99a9c55e67a2) to merge main and wire CarView.car.
M4-LOOKS MERGED 2026-11-20: review APPROVE (no findings); main e1f3bdf (check clean, sim 587/587, bots 100/100, build ok); ticket
ready for qa test; workers released, m4-looks workspace removed. M4-CARS asked; told to merge main + wire CarView.car (msg_1799f1329a0f);
its branch head before that: 6dffaea (sim 628/628, bots 109/109).
M4-CARS+ENV done: 6149c7d (sim 628/628, bots 109/109 twice; Sport byte-identical; lap times per type within 3% (bot corner scaling
(grip/7.5)^(1/4)); lagged recon err 0.005; rt skew live max 7). Opus reviewer ctx_18b31c4f294b (tmp/review-m4-cars.md). Report/shots in
tmp/m4-cars/. Taste copy m4-cars-taste (detached 6149c7d) on :3009, node pid 45260 (m4-bots-taste removed, old pid 38107 killed).
M4-CARS+ENV review APPROVE (ctx_18b31c4f294b; no findings). Notes: cars lap within ~1% at equal bot caution; the Truck (forgiving,
no lap-time cost) is the one to watch for 'none dominant'; FOR M4-MOVE: live rt skew up to ~7 ticks for about one round trip after an
input gap (bots.ts:1672 bounds live <=10, replay <=3): size M4-MOVE's lagged parity bound accordingly. Merge waits for the user's
car-feel taste gate.
Car-feel taste (user): "generally its a bit too easy to outrun normal bots, otherwise it looks good". User: hold -> asked if catch-up
exists (no) -> "keep the merge, start catch-up next". M4-CARS+ENV MERGED: main cf76e01 (check clean, sim 628/628, bots 109/109, build ok);
tickets ready for qa test; workers released, m4-cars workspace removed (m4-cars-taste still on :3009, pid 45260).
WAVE 3 in flight: M4-DRAFT 123jpnbfffj + M4-CELLS 123jpnbfffk in ONE Opus worker ctx_fb2f80ebae6b (~/orca/workspaces/scrap-rally/
m4-catchup, TSandvaer/m4-catchup, :3006; spec tmp/spec-m4-catchup.md) and M4-FX 123jpnbfffm Fable ctx_7656545f063a (~/orca/workspaces/scrap-rally/
m4-fx, TSandvaer/m4-fx, :3008; spec tmp/spec-m4-fx.md; contact sheet via ask). Bot difficulty: judge again after catch-up.
Catch-up worker Q (answered): A4 'passes' = centre ahead within 4 s (measured 2.65 s; the bend finishes the pass; plan constants kept);
Normal bots get wake-tucking + pull-out-to-pass in botdrive (option a, deterministic, Easy unchanged) because fixed lanes 48 apart never draft.
M4-FX contact sheet: user GO (popup); contract confirmed (CarView.draft/boost, WorldFx.cells CellView[]+nCells state 0/share left,
HudView.draft/boost). Catch-up at d8e34e3 (666/666, 114/114) told to worker_done now; main.ts mapping as a follow-up after M4-FX merges.
Catch-up done: d8e34e3 (draft fe2fa9f,8ffe40e,a45aac4; cells c2dcb3e,48ed900,d8e34e3). A4 centre ahead 2.60 s; bots lead changes 0,1,3/lap
(was 0,0,0); autopilot lead over a Normal bot shrank (Rust Bowl 1106 -> 508 units; Overpass bot ahead); wrecks 2 -> 7 (closer racing).
Opus reviewer ctx_141516b6d00f (tmp/review-m4-catchup.md). Mapping follow-up after M4-FX merges.
Catch-up review APPROVE (non-blocking: N1 no validation rule for air cells off-centre -> add in the follow-up; N2 lead-change check
averaged -> accepted; N3 bot passes mostly time out after 4 s side by side -> user judges at the taste gate; N4 server/bots.ts glue ->
accepted). NOT merged yet: after M4-FX merges, the catch-up worker merges main, maps the fields + adds N1 rule, quick re-check, then the
user's taste gate on that branch head, then merge.
M4-FX done: 3b32b11 (gate PASS, noise 0.004, 30 A ratios 0.021-0.719; canvas 11,715,912 B of 12,000,000; 0 px diff 18 scenes; +0.04/0.07 ms
per frame with everything on). Merges cleanly with main and with m4-catchup. Fable reviewer ctx_c90a75a666fd (tmp/review-m4-fx.md).
M4-FX MERGED 2026-11-21: review APPROVE (no blocking; notes: canvas headroom 284,088 B < one more car sheet -> new art must use free cells,
and whether the 12 MB cap should also count HUD label/font canvases (~1.1 MB, already on main) is a user call before the next art ticket;
catch-up sheet bakes ~17 ms on first cell frame -> hand cells over from the countdown); main 9e15773 (check clean, sim 628/628, bots
109/109, build ok); ticket ready for qa test; workers released, m4-fx workspace removed.
Catch-up FOLLOW-UP (Opus) ctx_1153e3b15f09 in the m4-catchup workspace (tmp/spec-m4-catchup-map.md): merge main, map CarView/HudView/
WorldFx fields, bake in the countdown, N1 off-centre rule, browser check. Then quick re-check, taste copy, user taste gate, merge.
MINES-1 DEPLOYED 2026-11-21 (user: "deployed"; live bundle index-pWtsH_4Y.js = origin 2e9ec7f, checked with curl). Muted live QA7 (Opus)
ctx_58124cb2ffa5 in the main checkout (tmp/spec-qa-live-7.md -> tmp/qa7-mines-live-report.md); on PASS close ClickUp 123jpnbfdq6.
QA7 PASS (no bugs; cap 40 not checked live, sim covers it; screenshots tmp/qa7/). MINES-1 123jpnbfdq6 COMPLETE; QA worker released.
Live = origin 2e9ec7f. Local main has M4-BOTS/LOOKS/CARS/ENV/FX on top, not pushed.
Catch-up follow-up DONE: 2d1af22 (697e03e N1 air cells |lat|>=28 + test; 2d1af22 main.ts mapping pooled, cells from the countdown;
669/669 + 114/114 twice; bake in countdown frame 0, 20-26 ms; steady 0 B/frame, cold race 600-740 B/frame during V8 tier-up). Evidence
tmp/m4-catchup-followup/. Quick Opus re-check ctx_acfb6e2a085e (tmp/review-m4-catchup-map.md). TASTE COPY on :3009 =
~/orca/workspaces/scrap-rally/m4-catchup-taste (detached 2d1af22); m4-cars-taste removed. Merge after re-check APPROVE + user taste.
CATCH-UP MERGED 2026-11-21: re-check APPROVE (ctx_acfb6e2a085e, no blocking; cold-race bytes = V8 boxing, JIT artefact) + user taste
APPROVE; main 46c1524 (check clean, sim 669/669, bots 114/114, build ok); ClickUp 123jpnbfffj + 123jpnbfffk ready for qa test; workers
released; m4-catchup workspace + branch removed. Taste copy :3009 (node pid 44733) kept for the user's Normal-bot test; remove after.
Phone can't reach the Mac on Wi-Fi (Tango and Tango_IoT): the Mac sees only the router in ARP, the phone answers no ARP -> likely client
isolation on the router (hypothesis). Mac IP now 192.168.50.247. Open: user's Normal-bot verdict (fine / faster / Hard level).
Bot verdict (user popup): ADD A HARD LEVEL; N3 side-by-side fine. Taste copy :3009 stopped (PIDs 44733/44712) and worktree removed.
M4-HARD proposed as an addendum at the end of PLAN-M4.md; Fable advisor review running (Agent, read-only); then user approval, then
a ClickUp ticket + Opus worker (can run beside M4-SCHEMA).
M4-HARD APPROVED (user popup, with the 11 Fable advisor changes; PLAN-M4 addendum). WAVE 4 in flight (both Opus, base main a7fa942):
- M4-HARD 123jpnbffqh ctx_ab92893722c2 (~/orca/workspaces/scrap-rally/m4-hard, :3006; spec tmp/spec-m4-hard.md). It will `ask` to confirm
  the pace band (share of the Normal-to-flat-out gap) before locking constants. Taste gate: 3 Hard bots.
- M4-SCHEMA 123jpnbffqj ctx_293724109f66 (~/orca/workspaces/scrap-rally/m4-schema, :3008; spec tmp/spec-m4-schema.md). Data only, no taste.
Whichever merges second merges main first and re-proves its hashes. Then M4-WORLD (Fable) needs the 12 MB canvas cap decision first.
M4-HARD pace band answered (user popups): 40-55% of the Normal-to-flat-out gap; rivet hit rate ~70-80% ('add a little miss').
M4-SCHEMA done: acee696 (golden hashes 07d6ed0 first; schema-hash SAME x12; 717/717 + 114/114 twice; Preview Yard test track hidden).
Evidence tmp/m4-schema/. Opus reviewer ctx_59d389e53131 (tmp/review-m4-schema.md). No taste gate (data only): merge on APPROVE + gate.
Canvas cap (user popup): 16 MB counting everything (HUD/font included; ~12.8 MB today) -> M4-WORLD can start after M4-SCHEMA merges.
M4-HARD done: 247a80c (golden cdedecb first; Easy/Normal hashes 7/7 same; gap closed 41.5-53.6% = 3.7-6.3% faster; traffic falls H0/N5;
rivets H77%/N61%, mines H51%/N25%; Hard won 18/18 3v3; step 1.3 us; 692/692 + 116/116 twice). Evidence tmp/m4-hard/. Opus reviewer
ctx_fbba44ce9791 (tmp/review-m4-hard.md). TASTE COPY :3009 = ~/orca/workspaces/scrap-rally/m4-hard-taste (detached 247a80c, node pid 11831).
m4-hard conflicts with m4-schema only in the appended sim-test section + tools/debug/README.md: merge SCHEMA first, then the Hard worker
merges main, resolves, re-proves golden hashes, re-runs tests; quick re-check; merge.
M4-SCHEMA review APPROVE (ctx_59d389e53131, released; tmp/m4-schema/m4-schema-review.md). Fix round ctx_b013b9ca1eac (follow-up of
ctx_293724109f66): F1 widen-vs-radius rule must use wall - car half-width (track.ts:1127; near miss sim-test.ts:9510), F2 0-tick barrel
gutter (track.ts:1075), F3 try to remove the +34 B/query boxed lat (track.ts:578). Then merge (no taste). For M4-SURF later: the
schema hash needs a wall-contact scenario before the collideWalls refactor (review F4); M4-MOVE owns the truck landing; M4-SURF per-sample isLost.
M4-HARD review REQUEST_CHANGES (ctx_fbba44ce9791, released; tmp/m4-hard/m4-hard-review.md): BLOCKING bot-ai.ts:48 socket Hard bots keep
lastMine across races -> no mines after race 1 (server seats fine: resetBotMem). Plus apexMineFree hint for mines behind (:483). Fix sent to
ctx_ab92893722c2 (one round; a second REQUEST_CHANGES goes to the user). Easy/Normal hashes verified real by the reviewer; 18/18 = pace
(with Normal's driving Hard wins 9/18). Taste copy :3009 unaffected (lobby bots = server seats).
M4-SCHEMA fix round done (1a4eb17: reach = wall - half car; barrel gutter >= 1 tick; lat getter +8 B/call); MERGED 2026-11-21 main 8c67b5c
(check clean, sim 719/719, bots 114/114, build ok); ClickUp 123jpnbffqj complete; workers released; m4-schema workspace + branch removed.
M4-HARD fix round running as ctx_e36d7bf88127; queued after it: merge main (8c67b5c), keep both appended sections, re-prove golden 7/7 +
schema-hash 12/12. Then a quick Opus re-check, the user's taste verdict (copy on :3009), merge. Next: M4-WORLD (Fable; 16 MB cap all-in).
M4-WORLD 123jpnbffqz in flight (Fable): ctx_b0111cbb62bb (~/orca/workspaces/scrap-rally/m4-world, :3008; spec tmp/spec-m4-world.md;
base main bbc1fad). Contact sheet via ask FIRST -> relay to the user. Bench scene for obstacles is S6 (S5 already = recovery teleport).
M4-HARD fix round + main merge done: f825945 (27f8006 lastMine reset on null car; apex ignores mines behind; style; merge keeps both
sim-test sections). Golden 7/7 + schema-hash 12/12 SAME; 743/743 + 118/118; band 41.5-53.6%; rivets 78%/61%. Quick Opus re-check
ctx_b4c667487139 (tmp/review-m4-hard-recheck.md). Taste copy :3009 is still 247a80c (differs only in the socket-bot fix and the apex
mine-behind detail). Merge after re-check APPROVE + the user's taste verdict.
M4-HARD MERGED 2026-11-21: re-check APPROVE (ctx_b4c667487139) + user taste APPROVE; main 5d6bc85 (check clean, sim 743/743, bots
118/118, build ok); ClickUp 123jpnbffqh ready for qa test; workers released; m4-hard workspace + branch removed; taste copy :3009 stopped.
M4-WORLD contact sheet: user 'Go with changes' = murky blue-grey water tone; then puddle rule (final): water/dirt drawn organic INSIDE the
declared rect; traction area = rect inset by PUDDLE_TRACTION_INSET (tractionRect), fully inside the drawn puddle; M4-SURF moves both into
shared/track.ts. Worker sends a follow-up puddle sheet via ask. Local main is 101 commits ahead of origin (2e9ec7f) at 736c275; push only on the user's go.
PUSHED 2026-11-21 (user popup 'Push now'): origin/main 2e9ec7f..e409e09 (M4 so far: bots E/N/H, car types, catch-up, schema). Waiting for the
user's Manual Deploy; local build of e409e09 gives bundle index-B6F4Id_2.js -> verify live, then a muted live QA (QA8, Opus).
M4-WORLD puddles (62fe276): water #3a5068 ok, inset 12 kept, shapes 'More irregular' -> one more puddles sheet via ask.
DEPLOYED 2026-11-21: live serves index-B6F4Id_2.js (= local build of e409e09; checked with curl). Muted live QA8 (Opus) ctx_aeab51f0ac4f
(tmp/spec-qa-live-8.md -> tmp/qa8-m4-live-report.md); on PASS close the M4 tickets that are ready for qa test.
LOBBY-FIT 123jpnbffrm (Opus) ctx_e5bb0bfb07f9 (~/orca/workspaces/scrap-rally/lobby-fit, :3006; spec tmp/spec-lobby-fit.md): Normal label
overflows its button (style.css:685), car picker text clipped, bot names truncated. Next push after its review.
QA8 PASS (ctx_aeab51f0ac4f, released; tmp/qa8-m4-live-report.md): all M4 tickets live, no bugs. COMPLETE in ClickUp: M4-BOTS, M4-HARD,
M4-LOOKS, M4-CARS, M4-ENV, M4-DRAFT, M4-CELLS, M4-FX (+ M4-SCHEMA earlier). Not checked live: Remove click, Hard vs Normal live, cards locked
in a race, a cell in view during the countdown. Lobby bot names drop '(bot)' (user popup). Puddles sheet 2: GO.
LOBBY-FIT done: 4140d9f (Normal 10.1/10.1 px; picker own arrow; lobby names without '(bot)'; host 360 no longer 31 px over;
743/743 + 118/118). Evidence tmp/lobby-fit/. Opus reviewer ctx_e5dd0297c233 (tmp/review-lobby-fit.md). Then merge; push needs the user's go.
LOBBY-FIT MERGED 2026-11-21: review APPROVE; main 3c2c9e6 (check clean, sim 743/743, bots 118/118, build ok); workers released;
workspace + branch removed. Flaky: bots 'knot lagged reconciliation' failed once in the review run (6 large, max 29.02), passed on rerun -> parked.
TOUCH: user wants on-screen buttons now (PLAN-TOUCH.md proposed; Fable advisor review running). Push of 3c2c9e6 waits for the user's go.
PLAN-TOUCH APPROVED (Fable: sound with changes; user: 8-way pad right, FIRE/MINE left, no auto-gas, no heal). TOUCH-1 123jpnbffvf (Opus)
ctx_43c14e2d36e7 (~/orca/workspaces/scrap-rally/touch-1, :3006; spec tmp/spec-touch-1.md). Push lobby fix + touch together (user popup);
the phone taste gate runs on the live site after that push.
M4-WORLD done: ccd0cf1 (0 px diff on 22 scenes; S6 within S2 x1.10; census 13.99/16 MB; puddle-probe 0 misses; 743/743 + 118/118; gate
PASS x2, FAIL x1 on one metric-B cell that main also shows 8/30). Evidence tmp/m4-world/. Fable reviewer ctx_a549b6c3d252
(tmp/review-m4-world.md). User judges the Preview Yard screenshots (tmp/m4-world/shots/). Leftovers: main.ts fills WorldFx.rt (M4-MOVE);
M4-SURF moves PUDDLE_TRACTION_INSET + tractionRect into shared/track.ts.
M4-WORLD: user approved the look (screenshots). Fable review REQUEST_CHANGES (ctx_a549b6c3d252, released; tmp/m4-world/REVIEW-m4-world.md):
belt arrows drawn past a narrow belt's far edge (obstacles.ts:170,361-372). Fix round sent to ctx_b0111cbb62bb (+ sprites.ts:498 comment,
measure actors.ts:639 verge scan; keep the press's leaving shadow). One round; a second REQUEST_CHANGES goes to the user. Reviewer's
own gate run PASS; Rule 1 holds (the 5.2 B/frame is on main too); census 13.99/16 MB.
TOUCH-1 done: c72a574 (touch-drive 54/54 incl. real two-finger touch over DevTools; 3-lap race by touch, 1366/1366 step Controls;
hidden in every non-driving phase; 765/765 + 118/118 on runs 2-3, run 1 had a bots contact flake 55<60). Evidence tmp/touch-1/.
Opus reviewer ctx_5e8bb5d9979b (tmp/review-touch-1.md). Conflicts with m4-world only in tools/debug/README.md (second to merge resolves).
Known: a second-finger tap on Menu/Chat while a thumb holds the pad makes no click in Chrome (reviewer judges).
TOUCH-1 review APPROVE (ctx_5e8bb5d9979b, released; tmp/touch-1/review-verdict.txt): no findings; second-finger Menu/Chat tap = Chrome
behaviour (bare control page shows it; optional fix: open menu/chat on touch pointerup) -> judge at the phone gate. MERGED into main f57a8e3;
gate running. M4-WORLD fix round: a53c73b committed, worker silent ~46 min -> nudged (ctx_15e23180e27f) to finish in the foreground; it must
merge main (README conflict with touch) before its merge.
TOUCH-1 gate on main: check clean, sim 765/765, bots 118/118, build ok; ClickUp 123jpnbffvf ready for qa test; workspace removed.
PUSHED 2026-11-21 (user popup): origin/main e409e09..c655bd8 (touch + lobby fix). Waiting for the user's Manual Deploy; local build of
c655bd8 gives index-DnnpZQ-5.js -> verify live, then the user's real-phone touch test (PLAN-TOUCH advisor change 11 checklist).
Phone test: user REJECTED the 8-way pad (no gas+steer at once). TOUCH-2 (floating thumbstick right half, up = full gas, proportional
steer, tuning panel behind ?debug=1) proposed in PLAN-TOUCH.md; Fable advisor review running. Then the user approves, then an Opus worker.
Orca restarted ~16:19: run re-bound; M4-WORLD fix-round worker ctx_15e23180e27f alive (rate-limit retries; branch a53c73b, not reported);
the TOUCH-2 advisor review was cut off and has been resumed. Live = c655bd8 (index-DnnpZQ-5.js).
TOUCH-2 APPROVED (Fable: sound with changes; user popup). ClickUp 123jpnbffxe (Opus) ctx_e4caf0e87fbe (~/orca/workspaces/scrap-rally/
touch-2, :3006; spec tmp/spec-touch-2.md; base 654f417). TOUCH-1 ticket keeps 'ready for qa test' with a comment: pad rejected, superseded.
M4-WORLD fix round done: 3955676 (a53c73b belt arrows within the belt, 2916-belt sweep 0 outside; verge scan 302 -> 14 segments; main merged,
README both lines; 765/765 + 118/118; gate PASS on a53c73b). Quick Fable re-check ctx_ec7f2fc79661 (tmp/review-m4-world-recheck.md):
belt fix, Rule 1 after the actors.ts change, census. Author idles on purpose (ctx_b0424fd8bd4b) in case of changes.
M4-WORLD re-check APPROVE (ctx_ec7f2fc79661, released; tmp/m4-world/REVIEW-m4-world-round2.md; non-blocking: arrows past a short /
wall-to-wall belt's END inside a bend -> M4-SURF validation rule, noted in PLAN-M4; dust after a put-back near a split). MERGED main 35f9f15;
gate running. Leftovers for M4-SURF/MOVE/TRACKS written to PLAN-M4 'Notes from implementation (M4-SCHEMA / M4-WORLD)'.
M4-WORLD gate on main 35f9f15: check clean, sim 765/765, bots 118/118, build ok; ClickUp 123jpnbffqz COMPLETE; m4-world workspace +
branch removed (the author's idle 'New messages' dispatch ctx_b0424fd8bd4b closed as lost with it: expected, nothing to restart).
Running: TOUCH-2 only. Local main ahead of origin (c655bd8) by the obstacle art + team notes; push with TOUCH-2 after the user's go.
TOUCH-2 done: 486880e (floating stick, knob colour, edge shift only as far as full output needs (deviation), lazy ?debug=1 tuning panel
3.38 kB; defaults R60 steerDead .12 lock .7 curve 1.4 gasDead .3 split .5; touch-drive 92/92; 776/776 + 118/118 twice). Evidence
tmp/touch-2/shots/. Opus reviewer ctx_d85a4b2e953b (tmp/review-touch-2.md). Then merge, push (user's go), phone tuning gate.
TOUCH-2 review APPROVE (ctx_d85a4b2e953b, released). Notes for the phone gate: a landing within ~43 px of the right edge starts with steer
on (EDGE_PX has no slider); debug nit: moving the split slider while a thumb holds the stick draws the gate offset (output fine). MERGED
main 59f7d55; gate running. Then ask the user to push (touch-2 + obstacle art + team notes).
TOUCH-2 gate on main: check clean, sim 776/776, bots 118/118, build ok; ClickUp 123jpnbffxe ready for qa test; workspace removed.
PUSHED 2026-11-21 (user popup): origin/main c655bd8..8c39954. Waiting for the user's Manual Deploy; local build gives index-B8dHVCS9.js ->
verify live, then the user tunes the stick on the phone with ?debug=1 and sends the values; they become the defaults (small follow-up).
DEPLOYED: live serves index-B8dHVCS9.js (= 8c39954, curl). User: 'It's too sensitive on the phone' -> pointed to ?debug=1 TUNE with a
starting set (R 90, Full lock 0.95, Curve 2.0, Steer dead 0.15); waiting for the user's copied values -> new STICK_DEFAULTS (small ticket).
Fallback if still twitchy at R 120 / lock 1 / curve 3: a touch-only max-steer cap (fairness note: below the keyboard's max).
User's tuned values: radius 95 (rest default). TOUCH-3 123jpnbffye (Opus) ctx_383040c1e557 (~/orca/workspaces/scrap-rally/touch-3,
:3006; spec tmp/spec-touch-3.md): new STICK_DEFAULTS + fit checks at R 95. Then quick review, merge, push on the user's go.
M4-SURF-1 123jpnbffyz (Opus) ctx_5e2e79169b9d (~/orca/workspaces/scrap-rally/m4-surf-1, :3008; spec tmp/spec-m4-surf-1.md):
water/dirt (tractionRect moved to shared), belt drift, tyre mounds, lane-cost bots, validation, buckets, dev flag to drive Preview Yard.
Taste gate on the Mac (frozen copy). Order after: SURF-2 (widen + islands), M4-MOVE, M4-TRACKS + M4-MAP.
User 2026-11-21: 'youre orchestrating your job is to pick up any tickets that can be started from the board and delegate work' ->
keep slots full unprompted (memory updated). Board: no 'to do' was left; queued M4-SURF-2 123jpnbffz4 (after SURF-1), M4-MOVE
123jpnbffz5 (after SURF-2), M4-TRACKS 123jpnbffz6 (after MOVE), M4-MAP 123jpnbffz7 (Fable; after SURF-2, beside MOVE/TRACKS).
TOUCH-1 complete (superseded). QA9 live (Opus, not an author) ctx_e6b6ff0465ff: LOBBY-FIT + TOUCH-2 on 8c39954 -> close on PASS.
SLOT RULE: 2 authors max (CLAUDE.md). Next free slot -> the next startable ticket in the order above (or TOUCH follow-ups).
TOUCH-3 done: 424c2f7 (R 95; hint capped 176 at 360x740, moved under the minimap at 844x390; 777/777 + 118/118; touch-drive 96/96).
Quick Opus review ctx_627ab8cbd55c (tmp/review-touch-3.md). Slot reused: M4-MAP 123jpnbffz7 (Fable) ctx_485a831c0ecb
(~/orca/workspaces/scrap-rally/m4-map, :3006; spec tmp/spec-m4-map.md) - needs only the split DATA, so it starts now beside SURF-1.
QA9 live PASS (ctx_e6b6ff0465ff, released; tmp/qa9-live-report.md): LOBBY-FIT 119/119, TOUCH-2 pass, smoke pass, no errors.
ClickUp LOBBY-FIT 123jpnbffrm + TOUCH-2 123jpnbffxe COMPLETE.
TOUCH-3 review APPROVE (ctx_627ab8cbd55c, released; note: at 360 wide the 190 px gate is wider than the 180 px zone, drawing only).
MERGED main 90cca64; gate running. Slot free after cleanup: nothing startable (SURF-2 waits for SURF-1; MOVE/TRACKS after it).
TOUCH-3 gate: check clean, sim 777/777, bots 118/118, build ok; ClickUp 123jpnbffye ready for qa test; workspace removed.
PUSHED 2026-11-21 (user popup): origin/main 8c39954..7defc76. Waiting for the user's Manual Deploy; expected bundle index-B58xVwLA.js.
DEPLOYED (live index-B58xVwLA.js, curl). User tuned again: lock 0.9, curve 3 -> TOUCH-4 123jpnbffzn (Opus) ctx_1e8acbbfd5ca
(~/orca/workspaces/scrap-rally/touch-4, :3010; spec tmp/spec-touch-4.md) as a one-off 3rd worker (user popup).
M4-MAP: user picked A (island in casing tone, 2 px); worker finishing.
M4-SURF-1 done: e465e2a (golden + wall-contact first 2b9e300; water x0.35 forces/grip dirtGrip/3/steer x0.5; straight pool 0-1 ticks,
bend pool +18-19 units wide; Surf Yard; 0 falls all levels x types; schema-hash 15/15, golden 7/7, Hard 4/4; 810/810 + 123/123 twice).
Opus reviewer ctx_5e4241c749eb (tmp/review-m4-surf-1.md). TASTE COPY :3009 = ~/orca/workspaces/scrap-rally/surf1-taste (detached e465e2a,
SCRAP_DEV_TRACK=surf-yard, node pid 62645): Create room -> Surf Yard. Known: lobby Track dropdown blank on a test track (dev only).
TOUCH-4 done: d9b8a42 (defaults v2; curve 3 + rounding -> felt dead zone ~0.26 R; 777/777 + 118/118 x2; touch-drive 96/96).
Opus reviewer ctx_c8ccf2bf8248 (tmp/review-touch-4.md). surf-1 vs m4-map: README-only conflict (second to merge keeps both).
2026-11-21 late: all three reviews APPROVE. TOUCH-4 MERGED a043ebf (gate 777/777 + 118/118, build ok; ClickUp ready for qa test).
M4-MAP MERGED 9f3b29f (gate 777/777 + 118/118, build ok; ClickUp complete; nits only). M4-SURF-1 MERGED 2c7b70c (README conflict
resolved keeping both; gate running). SURF-1 review F1 (laneFor mound look-ahead gap; a straight fix made mound contact worse),
F2 (look-ahead no lap wrap), F3/F4 nits -> folded into the M4-SURF-2 spec (tmp/spec-m4-surf-2.md). Authors + reviewers released,
workspaces touch-4, m4-map, m4-surf-1, surf1-taste removed; :3009 taste copy stopped (pid 62645 + npm 62594).
Next: SURF-2 dispatch on a green gate; then ask the user to push (v2 stick to the phone).
SURF-1 gate green on 2c7b70c: 811/811 + 123/123, build ok; ClickUp 123jpnbffyz ready for qa test.
M4-SURF-2 123jpnbffz4 (Opus) in flight: ctx_9b00420cc97a (~/orca/workspaces/scrap-rally/m4-surf-2, :3008; spec tmp/spec-m4-surf-2.md;
base main 726b7b7). Taste gate: the user drives a split on the test track (frozen copy). Then M4-MOVE, then M4-TRACKS.
PUSHED (user popup): origin/main = b1a62a7. Expected live bundle after Manual Deploy: index-CZXDyCOY.js (gate build of 2c7b70c;
only team/ changed since). SURF-2 asked to change client/sfx.ts:829 (gravel sound uses halfOf in a split): yes, that line only.
DEPLOYED 2026-11-22 (user): live index-CZXDyCOY.js (curl), bundle holds steerLock:.9,steerCurve:3. QA10 live worker ctx_29619ea77ece
(muted; spec tmp/spec-qa-live-10.md; report tmp/qa10-live-report.md): TOUCH-4 + TOUCH-3 stick, SURF-1 + MAP regression.
User on the phone (v2 live): "still to hard ... I constantly oversteer" -> point to steer (popups; PLAN-TOUCH.md TOUCH-5 addendum,
Fable "sound with changes", approved). TOUCH-5 123jpnbfgbc (Opus) in flight: ctx_ef45d3475cfa (~/orca/workspaces/scrap-rally/touch-5,
:3006; spec tmp/spec-touch-5.md; base main f2ca592). Taste gate: the user on the phone, live (push + deploy), A/B via the TUNE switch.
QA10 live PASS (ctx_29619ea77ece, released; tmp/qa10-live-report.md): smoke 30.0/s, RTT ~40 ms; stick v2 24/24 CDP touch passes at
3 sizes; Crusher Run 3 bots finish, 0 falls; minimap unchanged; no console errors. ClickUp complete: TOUCH-3, TOUCH-4, M4-SURF-1.
M4-SURF-2 done: 512dc98 (7 commits on 726b7b7; report tmp/m4-surf-2/m4-surf-2-report.md): exact-taper walls per side, island sides =
wall, noses = mound contact (26 deep), Split Yard test track, bots lane per seat/type, F1 mound contacts -> 0/0/0,0/0/0,0/1/0, F2-F4 done;
shipped tracks SAME (schema-hash 15/15, Hard goldens, map-sheet 0 px); sim 840/840 + bots 128/128 twice. Opus reviewer ctx_758bdaf628ba
(tmp/review-m4-surf-2.md). TASTE COPY :3009 = ~/orca/workspaces/scrap-rally/split-taste (detached 512dc98, SCRAP_DEV_TRACK=split-yard,
node pid 3163, npm pid 3142): Create room -> Split Yard. ClickUp 123jpnbffz4 in review.
SURF-2 review 1 REQUEST_CHANGES: F1 physics walls use the exact taper but the bake draws linear-in-t between samples (world.ts:404-409,
1022, 1072, 1276) -> up to 4.7 units off the drawn barrier; fix = interpolate like the bake; the trial fix pushes the weapons-on
island bound (Normal Racer 33 > 20) -> bots get island margin / lane recovery first. Fix round sent to the author as ctx_43c279b87152
(tmp/m4-surf-2/review-1-fix.md); reviewer ctx_758bdaf628ba kept for the re-review. Taste copy :3009 (512dc98) gets refreshed after.
TOUCH-5 done: 12c11c0 (6 commits; report tmp/touch-5/touch5-report.md): point default, defaults {"mode":"point",...,"pointDead":0.3,
"aimFull":35,"brakeAngle":110}; closed loops <= 120 ticks dry / 300 water, 0° overshoot; Rust Bowl lap <= 3 wall hits; wall escape
<= 174 ticks; 830/830 + 123/123 twice; touch-drive 52/52 + 62/62. Merges clean; sim-test run-list line conflicts with SURF-2 (keep both).
Opus reviewer ctx_09e09c787a72 (tmp/review-touch-5.md). On APPROVE: merge, gate, ask the user to push (phone taste = live only).
SURF-2 fix round 1 done: 860795c (f02ecde walls interpolate like the bake, gap 0.0000 on all 5 widens; 860795c bots back off islands,
weapons-on contacts <= 1-2, bound 8; N2 hoisted; 840/840 + 128/128 twice; report tmp/m4-surf-2/m4-surf-2-fix1-report.md). Re-review
sent to ctx_758bdaf628ba. TASTE COPY :3009 refreshed to 860795c (node pid 62281, npm pid 62260; same worktree split-taste).
SURF-2 re-review APPROVE (ctx_857a55d25a38, released). User popup: "Merge now, drive later". MERGED ae4db2c; gate 840/840 + 128/128,
build ok; ClickUp 123jpnbffz4 ready for qa test; author released, workspace m4-surf-2 removed. Taste copy :3009 STAYS UP (split-taste,
860795c) until the user has driven it. TOUCH-5 review 1 REQUEST_CHANGES (F1 no test catches a per-frame car read; F2 brake blips at
~150 u/s): fix round sent to ctx_ef45d3475cfa (tmp/touch-5/review-1-fix.md; merge main first; reviewer ctx_09e09c787a72 kept).
M4-MOVE 123jpnbffz5 (Opus) in flight: ctx_2677067f1bc7 (~/orca/workspaces/scrap-rally/m4-move, :3008; spec tmp/spec-m4-move.md; base
ae4db2c). Its criterion 9 (WorldFx.rt fill in client/main.ts) waits until TOUCH-5 merges: then tell it "go for 9, git merge main".
MOVE asked: server/combat.ts Combat.step rt param + :126, server/room.ts:1062 pass raceTick (rivets die on barrels/press) -> yes, those lines only.
TOUCH-5 fix round 1 done: 89ed7be (main ae4db2c merged; F2 brake hysteresis start >180 release 150; F1 touch-drive forces catch-up
frames, stale-read mutation fails 3 checks; 861/861 + 128/128 twice; report tmp/touch-5/touch5-fix1-report.md). Re-review sent to
ctx_09e09c787a72.
M4-MOVE part 1 done: dc42d82 (8 commits on ae4db2c; report tmp/m4-move/m4-move-report.md): barrels/press/truck solid at rt, yaw kick
dropped, no x1.3, Move Yard (SCRAP_DEV_TRACK=move-yard), bots 0 contacts weapons off; shipped SAME; 866/866 + 133/133 twice. Merges
clean with main and touch-5. Only criterion 9 left (main.ts fx.rt = game.drawTick(); after TOUCH-5 merges). Opus reviewer ctx_b64bf57fdff3
(tmp/review-m4-move.md) on part 1 now; criterion 9 = a delta review later; taste copy after criterion 9 (art static until then).
TOUCH-5 re-review APPROVE (ctx_a0987104e2a7, released; tmp/touch-5/touch5-review-2.md; note: a turn pointed behind at 150-180 u/s
never brakes now, uses more room). MERGED 56e6a45; gate running. MOVE told 'go for criterion 9' (merge main, fx.rt = game.drawTick()).
TOUCH-5 gate green (861/861 + 128/128, build index-C6OiUqFq.js); ClickUp 123jpnbfgbc ready for qa test; author released, workspace
touch-5 removed. PUSHED (user popup): origin/main = 8c61117 (TOUCH-5 + SURF-2). Expected live bundle after Manual Deploy: index-C6OiUqFq.js.
MOVE criterion 9 done: 333fdfa (merge ac6eddf clean; fx.rt = game.drawTick(); barrels within 2.3 px of barrelLat, press slab shows
exactly when down; 887/887 + 133/133 twice; shots in the m4-move workspace tmp/m4-move/shots/). MOVE part-1 review REQUEST_CHANGES
(ctx_b64bf57fdff3; tmp/m4-move/m4-move-review-1.md): F1 press-island skip too wide (car trapped in the slab), F2 clearSpot respawn
over a hole; F3 decided: band rivets pass that truck; F4 truck side-gap rule; notes: 2 seats jump vs comment, spectator rt < 0 in
countdown. Fix round sent to ctx_ea8124df2107 (tmp/m4-move/review-1-fix.md); reviewer ctx_b64bf57fdff3 kept for the re-review
(fixes + the criterion-9 delta ac6eddf/333fdfa). Move Yard taste copy after the fix round.
DEPLOYED 2026-11-22 (user): live index-C6OiUqFq.js (curl), bundle holds {mode:`point`,...,aimFull:35,brakeAngle:110}. QA11 live worker
ctx_1c351f557824 (muted; spec tmp/spec-qa-live-11.md; report tmp/qa11-live-report.md): TOUCH-5 point mode + SURF-2 regression.
User on the phone: point mode "much better but now the push area need to be smaller again" -> user tunes Size R / Aim dead with
?debug=1 and pastes values (popup) -> TOUCH-6 makes them the defaults. QA11 stalled once (ended turn on background passes) -> told to
re-run in the foreground. MOVE fix round 1 done: 84b1323 (7366491 F1-F4 + notes, repro tests; 893/893 + 133/133 x2; shipped SAME).
Re-review (fixes + criterion 9) sent to ctx_b64bf57fdff3.
QA11 live PASS (ctx_1c351f557824, released; tmp/qa11-live-report.md): point mode faces the stick (<5 deg at 250 ms), brakes/turns
round, wall back-out, Mode switch; SURF-2 regression ok (3 bots x2 on Overpass Knot, 0 falls). ClickUp complete: TOUCH-5, M4-SURF-2.
User popups: rate stick stays debug-only; no straight-line brake. User stick values: radius 67 (rest unchanged) -> TOUCH-6
123jpnbfgh3 (Opus) in flight: ctx_2e38d6f098e2 (~/orca/workspaces/scrap-rally/touch-6, :3006; spec tmp/spec-touch-6.md).
User drove the Split Yard: "mud area is too long" (dirt lane 700) -> M4-TRACKS rule <= ~350 (PLAN-M4.md + ClickUp comment); splits
otherwise fine. Branch roads = shortcuts, shorter but risky; plan now, build after M4-TRACKS: an Opus Plan agent is drafting PLAN-BRANCH
(then Fable review, then the user's approval). Split taste copy :3009 stays until the Move Yard copy needs the port.
MOVE re-review @84b1323 REQUEST_CHANGES (F3 edge: rivetInBand tests each tick's start, not the spawn; 128/3900 pass; ctx_178052ad9776;
tmp/m4-move/m4-move-review-2.md). 2nd round -> user popup: send back. Fix round 2 sent to ctx_ab8415d5a6c7; reviewer to re-check it only.
PLAN-BRANCH approved (user popup, recommended answers; Fable "sound with changes", 9 binding). Tickets (all 'to do', start after
M4-TRACKS): BR-SCHEMA 123jpnbfgh9 -> BR-PHYS 123jpnbfgha + BR-BAKE 123jpnbfghb (Fable) -> BR-BOTS 123jpnbfghc + BR-MAP 123jpnbfghd
(Fable) -> Branch Yard taste -> BR-TRACKS 123jpnbfghe.
MOVE F3-edge fixed: 76719f1 (probe 128/3900 -> 0/3900; 893/893 + 133/133 x2); re-check sent to ctx_178052ad9776. Themes (desert, city,
jungle + scrapyard; looks + surfaces; fixed per track): an Opus Plan agent drafts PLAN-THEMES (then Fable review, user approval).
MOVE re-check APPROVE (ctx_5178711f0093). User popups: merge now / drive later; start M4-TRACKS now; BR-SCHEMA beside it; cap 3.
M4-MOVE MERGED 158a691; gate running. IN FLIGHT (3 authors): TOUCH-6 ctx_2e38d6f098e2 (:3006); M4-TRACKS 123jpnbffz6 ctx_25b6cddb77d6
(~/orca/workspaces/scrap-rally/m4-tracks, :3008; spec tmp/spec-m4-tracks.md; new tracks in shared/longtracks.ts); BR-SCHEMA 123jpnbfgh9
ctx_d7d9decab927 (~/orca/workspaces/scrap-rally/br-schema, :3010; spec tmp/spec-br-schema.md). Next free slot: a Fable theme-art worker
once PLAN-THEMES is approved. TASTE COPY :3009 = Move Yard: worktree ~/orca/workspaces/scrap-rally/split-taste now detached at 158a691,
SCRAP_DEV_TRACK=move-yard, node pid 22388, npm pid 22367 (the split copy is stopped).
TOUCH-6 done: eaf4a31 (R 67; 9720 point directions reach past the dead zone; DRIVE hint 134 px; 861/861 + 128/128 x2; touch-drive
127/127; report tmp/touch-6/touch6-report.md). Opus reviewer ctx_46accd6d22e2 (tmp/review-touch-6.md). On APPROVE: merge, gate, push popup.
MOVE gate green on 158a691 (893/893 + 133/133, build ok); ClickUp 123jpnbffz5 ready for qa test. TOUCH-6 review APPROVE (6 mutations
caught; nits outside its files: style.css:1703 comment, tools/debug/README.md:29 entry). TOUCH-6 MERGED 4282640; gate running. MOVE and
TOUCH-6 workers released, workspaces m4-move + touch-6 removed. Authors now: M4-TRACKS, BR-SCHEMA (1 slot free; nothing startable until
PLAN-THEMES is approved or BR-SCHEMA merges). Next: push popup (MOVE + TOUCH-6) after the gate.
PLAN-THEMES drafted (PLAN-THEMES.md: TH-LOOK-1 Fable desert look first; THEME-SCHEMA before BR-PHYS; census HUD allowance already
fails on main 1,942,744 > 1,900,000, folded into TH-LOOK-1). HARD-2 addendum (PLAN-M4.md end). Both under Fable review in parallel.
The free 3rd slot goes to whichever is approved first (HARD-2 likely: small, user-facing).
HARD-2 approved (Fable "sound with changes", 10 binding; user popup). HARD-2 123jpnbfghz (Opus) in flight: ctx_779075f2c605
(~/orca/workspaces/scrap-rally/hard-2, :3006; spec tmp/spec-hard-2.md). Authors now 3/3: M4-TRACKS, BR-SCHEMA, HARD-2.
M4-TRACKS asked: (A) extend airCellReach in shared/weapons.ts to fly truck lips -> yes (weapons.ts joins it for that); edits to
pre-existing 'every registered track' checks -> yes, loop over the 3 originals; surfShipped rule (3 originals SAME, others SAME or new)
sent to BR-SCHEMA too. PLAN-THEMES review still running; TH-LOOK-1 waits for approval AND a free slot.
PLAN-THEMES approved (Fable "sound with changes", 10 binding; user popup, recommended answers). Tickets: TH-LOOK-1 123jpnbfgj0 (Fable;
first free slot) -> THEME-SCHEMA 123jpnbfgj1 (after BR-SCHEMA + M4-TRACKS, before BR-PHYS) -> TH-LOOK-2 123jpnbfgj2 (after BR-BAKE) ->
THEME-SURF 123jpnbfgj3 (after BR-BOTS) + TH-LOOK-3 123jpnbfgj4 -> THEME-TRACKS 123jpnbfgj5. Census HUD fix sent to M4-TRACKS.
TOUCH-6 gate green on 4282640 (893/893 + 133/133, build index-CucohtTX.js). Next: push popup (MOVE + TOUCH-6).
PUSHED (user popup): origin/main = 28e251c (TOUCH-6 + M4-MOVE). Expected live bundle after Manual Deploy: index-CucohtTX.js.
M4-MOVE taste APPROVED by the user (barrels, ramp, press; bots ok). Move Yard copy on :3009 can go when the next taste copy needs it.
DEPLOYED (user): live index-CucohtTX.js (curl), bundle holds radius:67. QA12 live worker dispatched (muted; spec
tmp/spec-qa-live-12.md; report tmp/qa12-live-report.md): TOUCH-6 + M4-MOVE regression.
QA12 live PASS (ctx_b97a15d62f9f, released): stick R 67 at 3 sizes, Crusher Run 3 bots 0 falls, 0 console errors. ClickUp complete:
TOUCH-6, M4-MOVE.
BR-SCHEMA done: 221beef (branch data, Branch Yard, 19 rule tests; 930/930 + 133/133 x2; shipped SAME; done text tmp/br-schema-done.md).
Opus reviewer ctx_d7ef3257a313 (tmp/review-br-schema.md). Cap rule (user popup): idle authors in review do not count. TH-LOOK-1
123jpnbfgj0 (Fable) in flight: ctx_79748d316f06 (~/orca/workspaces/scrap-rally/th-look-1, :3011; spec tmp/spec-th-look-1.md).
Active authors: M4-TRACKS, HARD-2, TH-LOOK-1 (BR-SCHEMA idle in review).
MARSHALS-1 123jpnbfgjb (Fable) on the board: two flag marshals at the start/finish line; starts after TH-LOOK-1 merges (render.ts),
beside BR-BAKE; asks before touching client/main.ts or game.ts (HARD-2).
M4-TRACKS done: 4d4e97b (Slag Harbour 19,324 / Breaker's Mile 20,426; Normal laps 51.8-59.0 s, 0 falls; density plain 89.4/90.6 %,
shortest gaps 1041/1338, mud 330; census fixed: HUD allowance from trackList().length+1; 907/907 + 143/143 x2; report
tmp/m4-tracks/m4-tracks-report.md). Conflicts with br-schema (sim-test, golden): second to merge resolves. Opus reviewer ctx_ca6629690be1
(tmp/review-m4-tracks.md). TASTE COPY :3009 = M4-TRACKS 4d4e97b (worktree split-taste, no dev flag; node pid 16214, npm pid 16191);
the Move Yard copy is stopped. Active authors: HARD-2, TH-LOOK-1 (M4-TRACKS + BR-SCHEMA idle in review). Nothing else startable yet.
GFX-1 in flight: ctx_b5075af01fdf (Fable, ~/orca/workspaces/scrap-rally/gfx1, TSandvaer/gfx1, :3008; base main 9fdf041). Tell it
when the safeguards merge (it merges main before its final gate run).
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
| 123jpnbfffj+123jpnbfffk M4-DRAFT+CELLS | ctx_fb2f80ebae6b | ~/orca/workspaces/scrap-rally/m4-catchup | TSandvaer/m4-catchup | 3006 | 2026-11-20 |
| 123jpnbfffm M4-FX | ctx_7656545f063a | ~/orca/workspaces/scrap-rally/m4-fx | TSandvaer/m4-fx | 3008 | 2026-11-20 |
| 123jpnbfb23 GFX-0 | ctx_27a7a271607b | ~/orca/workspaces/scrap-rally/gfx0 | TSandvaer/gfx0 | 3006 | 2026-11-18 |

## Queued (milestone 3, PLAN-M3.md; start after solid collisions 123jpnbf6cy and easier-start 123jpnbf3xa merge)

1. 123jpnbf6e6 M3-T1a shared track features + jump/fall/recovery physics + validation  } in parallel
2. 123jpnbf6e7 M3-T2 per-room track + host track selection (plumbing)                  }
3. 123jpnbf6e8 M3-T1b server/client wiring (after T1a + T2)                            } in parallel
4. 123jpnbf6e9 M3-T3 rendering (after T1a; taste gate: screenshots)                    }
5. 123jpnbf6ea M3-T4 Crusher Run + Overpass Knot + jumping bots (last; taste gate: user drives both)

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
