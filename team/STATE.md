# STATE — Scrap Rally coordination

**Resume (2026-11-14):** Run `run_c58bb5836634`. Author worker `ctx_a048855f3d38` reported
worker_done (succeeded): ClickUp 123jpnbf3m2 on branch `TSandvaer/hosting-local` head 9365ecf,
verified (6 commits incl. WIP d82402f, workspace clean); ticket is `in review`. Reviewer
`ctx_015f5475d5ec` (task task_65f0bb1e4d86) runs in the main checkout (read-only). On its verdict:
APPROVE -> merge --no-ff into main, `npm run check && npm test`, then push main once (pre-approved,
DECISIONS 2026-11-14), tell the user to apply the Render Blueprint; REQUEST_CHANGES -> send findings
to the author dispatch. Keep the author open until merged.

## Branches

- `main` (local): ahead of origin by the hosting plan, botplay and orchestration-setup commits;
  not pushed (push only when the user asks).
- `hosting-wip` (local): parked hosting work for the first worker; its commit message lists
  what is done and what is open.

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbf3m2 Finish hosting, local part | ctx_a048855f3d38 (done, 9365ecf) | ~/orca/workspaces/scrap-rally/hosting-local | TSandvaer/hosting-local | 3001 | 2026-11-14 |
| review of 123jpnbf3m2 | ctx_015f5475d5ec | main checkout (read-only) | — | — | 2026-11-14 |

## Waiting on the user

- Render: account created and GitHub connected (user, 2026-11-14). Next for the user, after the
  push: New -> Blueprint from render.yaml, then send the onrender.com URL for the smoke test.
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
