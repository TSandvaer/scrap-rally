# STATE — Scrap Rally coordination

**Resume (2026-11-16, latest):** In flight on run `run_c58bb5836634`: dispatch `ctx_579fca225027`
(task task_e50f163f2ffa) on ClickUp 123jpnbf637 "Lobby ready check" (DECISIONS 2026-11-16), workspace
~/orca/workspaces/scrap-rally/ready-check, branch `TSandvaer/ready-check` (from main), port 3001. Author done
(b3851bd, verified, 5 commits; sim 87/87, bots 43/43 x3, local smoke PASS); review APPROVE
(ctx_86cdc99dd431). User: label "Cancel ready", then merge + push + Manual Deploy. Label change running
as follow-up `ctx_7e79bb48c917` (task task_e682cec46419). On its worker_done: verify the diff is only
the label (+ test text), quick re-review, merge, check+test, push, tell the user to deploy, QA live. Separately parked: easier-start
(see next note); whichever merges second merges main in.

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
| 123jpnbf637 Lobby ready check | label follow-up ctx_7e79bb48c917 (after b3851bd, APPROVE) | ~/orca/workspaces/scrap-rally/ready-check | TSandvaer/ready-check | 3001 | 2026-11-16 |

Parked (unmerged, approved, awaiting the user's taste verdict): TSandvaer/easier-start @ 9ba7740 (123jpnbf3xa).

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
