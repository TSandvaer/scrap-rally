# STATE — Scrap Rally coordination

**Resume (2026-11-14):** Live on Render: https://scrap-rally.onrender.com (free, Frankfurt, commit
4902ee6, Blueprint "scrap rally"; deployed by the user). QA worker `ctx_6e1173a4d104` (task
task_f0536f7e5357, run `run_c58bb5836634`) is verifying it from the main checkout (smoke x3, two-browser
race, wss). On pass: 123jpnbf3m2 -> complete, report numbers to the user, then dispatch 123jpnbf3m8
(review nits). On fail: report to the user before any change.

## Branches

- `main`: 4902ee6 pushed to origin; later team/ commits are local only (push only when asked).

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| QA of live deploy (123jpnbf3m2) | ctx_6e1173a4d104 | main checkout (read-only) | — | — | 2026-11-14 |

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
