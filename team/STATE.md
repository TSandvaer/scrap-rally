# STATE — Scrap Rally coordination

**Resume (2026-11-14):** Render rejected render.yaml (autoDeploy + autoDeployTrigger both set).
QA fix in flight on run `run_c58bb5836634`: dispatch `ctx_8b442e1260de` (task task_8c2e7a0aa447),
workspace ~/orca/workspaces/scrap-rally/render-yaml-fix, branch `TSandvaer/render-yaml-fix`, ticket 123jpnbf3m2 back to
in progress. On worker_done: verify, reviewer, merge, check+test, then ask the user to approve the
push (the earlier pre-approval covered one push only), then the user applies the Blueprint.
Afterwards: dispatch 123jpnbf3m8 (review nits).

## Branches

- `main`: d2fcc9e pushed to origin; later team/ commits are local only (push only when asked).

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbf3m2 QA fix (render.yaml) | ctx_8b442e1260de | ~/orca/workspaces/scrap-rally/render-yaml-fix | TSandvaer/render-yaml-fix | — | 2026-11-14 |

## Waiting on the user

- Render: account created and GitHub connected (user, 2026-11-14). Next for the user, after the
  push: New -> Blueprint from render.yaml, then send the onrender.com URL for the smoke test.
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
