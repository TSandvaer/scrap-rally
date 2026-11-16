# Decisions (append-only)

- 2026-11-13 — Prototype built per PLAN.md; pushed to GitHub on the user's "save it now".
- 2026-11-14 — Milestone 2 (weapons, scrap, garage) approved and built; pushed on request.
- 2026-11-14 — Hosting plan approved (PLAN-HOSTING.md); first host: Render free tier. The user
  owns a domain at simply.com; a custom subdomain is an optional step after the onrender.com
  URL works (user picks the subdomain and sets the DNS record).
- 2026-11-14 — The main session becomes the orchestrator; all work runs in separate Orca
  workspaces that report back (model: MarianLearning orca-wave). User choices: local merges
  (no push without asking), tickets in ClickUp list `scrap-rally` (1200210000012904), at most
  2 workers at a time.
- 2026-11-14 — Push pre-approved once: after ticket 123jpnbf3m2 passes review and is merged into
  local main, push main to GitHub (plain push, no force) so Render can build it. Later pushes
  still need the user's go-ahead.
- 2026-11-14 — Review nits of 123jpnbf3m2 go into one small ticket (123jpnbf3m8), dispatched only
  after the first Render deploy is verified (user, popup).
- 2026-11-14 — Push pre-approved once more: after the render.yaml QA fix (123jpnbf3m2) passes review
  and is merged, push main so the user can apply the Blueprint.
- 2026-11-14 — First deploy live (user applied the Blueprint): https://scrap-rally.onrender.com.
- 2026-11-14 — Push of main approved by the user (review nits 123jpnbf3m8, merge 5d8c534).
- 2026-11-15 — Next step: playtest with friends on the live link before any new feature; feedback becomes ClickUp tickets.
- 2026-11-15 — Playtest feedback (user vs. bots): "way too hard; why do we have weapons in the
  beginning; weapons do too much damage". User choices: new players start with no ammo (buy in
  the garage) AND no firing in the first ~8 s of a race; damage halved (rivet 4, mine 15; HP stays
  100); practice bots unchanged. Balance is a taste gate: the user tries the branch before merge.
- 2026-11-15 — Playtest (positive): catching up to the bots feels good. Keep bot pace and car handling as they are unless the user asks.
- 2026-11-16 — Lobby ready check (user): the host cannot start until every player is ready, so players can shop first. User choices: the host gets "Start anyway" after 60 s if someone is still not ready; offline (reconnecting) players are not waited for.
- 2026-11-16 — Ready check: the ready player's toggle says "Cancel ready" (user). After merge: push approved, the user clicks Manual Deploy; easier-start stays parked.
- 2026-11-16 — Playtest with a friend (old build d912583): the Engine upgrade feels overpowered because it also raised top speed. User: Engine = +7% acceleration per level only, top speed unchanged. Ready check + engine fix go live in one deploy (push approved for that). Small tuning change, no advisor review.
- 2026-11-16 — Playtest: cars drove through each other. User wants solid bumps that show instantly on their own screen (collision shape matching the drawn car, own-car prediction of bumps, small spark/shake on impact); no ramming damage. Netcode change: advisor review + user approval before dispatch.
- 2026-11-16 — Solid-collision design approved by the user (advisor: sound with changes, folded in): capsule shape, one-sided shared resolver, prediction in step() and in the reconcile replay, nearby cars drawn at the predicted pose, softer bounce (tuned at the taste gate), sparks + shake for own contacts only.
- 2026-11-16 — Taste verdict: the user approves easier-start ("just approve it; if it needs changes I will say later"). Next: merge main (ready check + engine) into it, review the resolution, merge.
- 2026-11-16 — Deploys are batched: the user waits with the next Manual Deploy until more changes are ready. Live stays d912583 for now; origin/main is 4f9ef51 (ready check + engine). Merge finished tickets locally; ask before the next push (push = prep for a deploy).
