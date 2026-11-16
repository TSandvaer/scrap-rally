# STATE — Scrap Rally coordination

**Resume (2026-11-16, latest):** 123jpnbf637 (lobby ready check) merged as a63375c and pushed
(d912583..a63375c); workspace removed, branch deleted. Waiting for the user's Manual Deploy of a63375c,
then a QA worker checks the live lobby (smoke now needs this build). easier-start still parked (next note).

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

None. Parked (unmerged, approved, awaiting the user's taste verdict): TSandvaer/easier-start @ 9ba7740
(123jpnbf3xa); it must merge main (ready check) before it can merge.

## Waiting on the user

- Render: done (account, GitHub, Blueprint, first deploy). Later deploys: user clicks Manual Deploy.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
