# STATE — Scrap Rally coordination

**Resume (2026-11-14):** No workers in flight (run `run_c58bb5836634` idle). Ticket 123jpnbf3m2
merged as d2fcc9e, pushed (88aebaa..d2fcc9e), ClickUp `ready for qa test`; workspaces cleaned up.
Waiting on the user to apply the Render Blueprint and send the onrender.com URL; then run
`npm run smoke -- <url>` (+ `--expect-restart` only if a restart is wanted) and a two-browser race on
it, report RTT / snapshot rate. Open question to the user: a small ticket for the 3 review nits.

## Branches

- `main`: d2fcc9e pushed to origin; later team/ commits are local only (push only when asked).

## In flight

None.

## Waiting on the user

- Render: account created and GitHub connected (user, 2026-11-14). Next for the user, after the
  push: New -> Blueprint from render.yaml, then send the onrender.com URL for the smoke test.
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
