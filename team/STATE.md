# STATE — Scrap Rally coordination

**Resume (2026-11-14):** Live on Render: https://scrap-rally.onrender.com (commit 4902ee6), QA PASS
(RTT 40-49 ms, 30 snapshots/s, largest gap 42-59 ms); 123jpnbf3m2 complete. In flight on run
`run_c58bb5836634`: dispatch `ctx_1233e1845bdd` (task task_51db36c626c4) on ClickUp 123jpnbf3m8
(review nits), workspace ~/orca/workspaces/scrap-rally/review-nits, branch `TSandvaer/review-nits`, port 3001. Review 1
(ctx_0f23930fa286): REQUEST_CHANGES, 1 finding (refused busy sockets count against MAX_SOCKETS while
closing). Sent to the author as follow-up dispatch `ctx_3e36bd14bb42` (task task_8ea307f33fee). On its
worker_done: verify, re-review (a second REQUEST_CHANGES goes to the user), then merge, check+test. Going live needs a push and a
Manual Deploy in Render: ask the user for both.

## Branches

- `main`: 4902ee6 pushed to origin; later team/ commits are local only (push only when asked).

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbf3m8 Hosting review nits | fix round ctx_3e36bd14bb42 (after c4ca7f4, review 1 = changes) | ~/orca/workspaces/scrap-rally/review-nits | TSandvaer/review-nits | 3001 | 2026-11-14 |

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
