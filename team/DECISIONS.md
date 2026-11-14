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
