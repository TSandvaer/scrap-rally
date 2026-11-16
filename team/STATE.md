# STATE — Scrap Rally coordination

**Resume (2026-11-16, latest):** Pushed 4f9ef51 = ready check (a63375c) + engine acceleration-only
(123jpnbf6ca, review APPROVE); the user batches deploys (DECISIONS 2026-11-16): live stays d912583 until they deploy a batch;
ask before the next push; live QA after their deploy. In flight on
run `run_c58bb5836634`: dispatch `ctx_c8a5662fcae7` (task task_6f640066f3a9) on ClickUp 123jpnbf6cy
"Solid collisions" (design approved, DECISIONS 2026-11-16), workspace
~/orca/workspaces/scrap-rally/solid-collisions, branch `TSandvaer/solid-collisions` (from main before the engine merge), port
3002; taste gate before merge. easier-start APPROVED by the user: dispatch `ctx_ff922b220719` (task
task_c59a051556ca) merges main into it, workspace ~/orca/workspaces/scrap-rally/easier-start-merge, branch
`TSandvaer/easier-start-merge`, port 3001; then reviewer on the resolution, merge, and ask about push + deploy.

**Resume note (2026-11-16):** Workers all released; easier-start workspace removed at the user's
request (clean, nothing running). Branch `TSandvaer/easier-start` KEPT at 9ba7740 (reviewed, APPROVE,
unmerged, ClickUp 123jpnbf3xa `ready for qa test`): it waits for the user's taste verdict. To test it
again: either merge + push + Manual Deploy (on the user's go-ahead) and play live, or have Orca create a
fresh workspace from that branch for a local run. Live site = old balance d912583.

**Resume (2026-11-15):** Live: https://scrap-rally.onrender.com at d912583. In flight on run
`run_c58bb5836634`: dispatch `ctx_a40ce564286f` (task task_3736690503f4) on ClickUp 123jpnbf3xa "Easier
start" (no starting ammo, weapons armed 8 s after GO, half damage; DECISIONS 2026-11-15), workspace
~/orca/workspaces/scrap-rally/easier-start, branch `TSandvaer/easier-start`, port 3001. Review 1 of cfbbd43:
REQUEST_CHANGES (client sends the fire bit inside the 8 s window) + 2 nits; fixed by `ctx_d0cabb08c49a` as 9ba7740
(verified; sim 56/56, bots 44/44 x2); re-review APPROVE (`ctx_933890711ac8`). NOW AT THE TASTE GATE: the user plays the
branch from the worker workspace on :3002 (+ botplay --url ws://localhost:3002/ws); keep that workspace
until the verdict. Then: the user tries the branch locally before merge (show how), then merge, push +
Manual Deploy only on the user's go-ahead. The user's own dev server runs on :3000 from the main checkout.

## Branches

- `main` = origin/main = d912583 (deployed). Later team/ commits are local only.

## In flight

| Ticket | Dispatch | Workspace | Branch | Port | Started |
| --- | --- | --- | --- | --- | --- |
| 123jpnbf6cy Solid collisions | ctx_c8a5662fcae7 | ~/orca/workspaces/scrap-rally/solid-collisions | TSandvaer/solid-collisions | 3002 | 2026-11-16 |
| 123jpnbf3xa Easier start: merge main in | ctx_ff922b220719 | ~/orca/workspaces/scrap-rally/easier-start-merge | TSandvaer/easier-start-merge | 3001 | 2026-11-16 |

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
