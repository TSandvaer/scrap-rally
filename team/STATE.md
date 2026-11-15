# STATE — Scrap Rally coordination

**Resume (2026-11-15):** Live on Render: https://scrap-rally.onrender.com at commit d912583 (user
pushed-approved and clicked Manual Deploy, 2026-11-15 09:36). QA worker `ctx_f31ab9c386cc` (task
task_2c384b547416, run `run_c58bb5836634`) checks it from the main checkout (smoke x3, two-browser race,
reload rejoin). On pass: 123jpnbf3m8 -> complete, report to the user. Nothing else queued.

## Branches

- `main` = origin/main = d912583 (deployed). Later team/ commits are local only.

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| QA of live d912583 (123jpnbf3m8) | ctx_f31ab9c386cc | main checkout (read-only) | — | — | 2026-11-15 |

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
