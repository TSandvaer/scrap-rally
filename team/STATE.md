# STATE — Scrap Rally coordination

**Resume (2026-11-14):** One worker in flight on Orca run `run_c58bb5836634`: dispatch
`ctx_a048855f3d38` (task `task_842eab3fd0e8`) on ClickUp 123jpnbf3m2 "Finish hosting, local
part", workspace /Users/thjo/orca/workspaces/scrap-rally/hosting-local, branch `TSandvaer/hosting-local` (from
hosting-wip), port 3001. On worker_done: verify branch/SHA/files, start the reviewer
(`--worktree current`), merge per .claude/skills/orca-wave. On resume: `orca orchestration
run-use` the run, then `worker-list --run run_c58bb5836634 --json`.

## Branches

- `main` (local): ahead of origin by the hosting plan, botplay and orchestration-setup commits;
  not pushed (push only when the user asks).
- `hosting-wip` (local): parked hosting work for the first worker; its commit message lists
  what is done and what is open.

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbf3m2 Finish hosting, local part | ctx_a048855f3d38 | ~/orca/workspaces/scrap-rally/hosting-local | TSandvaer/hosting-local | 3001 | 2026-11-14 |

## Waiting on the user

- Render: user creates the account (GitHub sign-in, access to TSandvaer/scrap-rally only), then
  New -> Blueprint from render.yaml after the push; sends the onrender.com URL for the smoke test.
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
