# STATE — Scrap Rally coordination

**Resume (2026-11-14):** Orchestration set up (CLAUDE.md, .claude/skills/orca-wave). No workers
in flight, no Orca run yet. Next: create the ClickUp ticket "Finish hosting, local part" from
PLAN-HOSTING.md and start one worker with `--base-branch hosting-wip` (parked WIP, rebased on
main), port 3001.

## Branches

- `main` (local): ahead of origin by the hosting plan, botplay and orchestration-setup commits;
  not pushed (push only when the user asks).
- `hosting-wip` (local): parked hosting work for the first worker; its commit message lists
  what is done and what is open.

## In flight

None.

## Waiting on the user

- Render: create the account and connect the GitHub repo (needs a push of main first: ask).
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
