# Scrap Rally

Browser multiplayer top-down arcade racer: original game in the genre of Amiga-era top-down
racers with weapons and an upgrade shop. TypeScript; Node 24 + `ws` server; Vite; Canvas 2D.
Plans: `PLAN.md` (architecture, netcode, status), `PLAN-M2.md` (weapons, scrap, garage),
`PLAN-HOSTING.md` (deploy). Live coordination: `team/STATE.md`; decisions: `team/DECISIONS.md`.

## How work runs: orchestrator + Orca workers

- The session in this main checkout is the **orchestrator**: it plans, writes tickets,
  dispatches, verifies, has workers review, merges, and keeps `team/STATE.md` current. It does
  not write feature code; every code change is made by a supervised Orca worker in its own
  workspace. Procedure: `.claude/skills/orca-wave/SKILL.md`.
- Tickets: ClickUp list `scrap-rally` (id `1200210000012904`).
- At most **3 author workers** at a time (user, 2026-11-22; reviewers and QA do not count); never two workers on the same files.
- **Local merges**: workers commit to local branches and never push; the orchestrator merges into
  local `main` after a reviewer worker's APPROVE. Push to GitHub (`origin` =
  TSandvaer/scrap-rally) only when the user asks.

## Project rules

- New plans and significant plan changes: Fable 5.2 advisor review first (Agent tool,
  subagent_type "Plan", model "fable", read-only), then the user approves.
- Codex is OFF for this project (answer the Codex question "no").
- Keep it original: genre and mechanics are fine; no names, cars, tracks, art or music copied
  from existing games.
- npm install scripts are not approved: install with `npm ci --ignore-scripts`. Never approve
  install scripts without asking.
- Never push, deploy, or touch hosting/DNS/accounts without the user's go-ahead.
- The codex-effekt episode ep-20261105-100442 from another session is still open; do not close
  it with guessed values.

## Commands

`npm run dev` (PORT, default 3000) · `npm run check` · `npm run sim` · `npm run bots` ·
`npm test` · `npm run build` · `npm start` · `npm run botplay -- <CODE> [n]`.
Browser automation: agent-browser sends Space with an empty key and code; fire with Z.

## Orchestration rules

The shared orchestrator disciplines below (continuity, wake signals, staleness checks, main-
thread bloat) apply. **Away/unattended mode is OFF** for this project: no auto-decided gates,
no `decisions-while-away.md`; gate decisions go to the user via popups.

@~/.claude/orchestration-rules.md
