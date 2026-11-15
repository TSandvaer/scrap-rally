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
