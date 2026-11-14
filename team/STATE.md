# STATE — Scrap Rally coordination

**Resume (2026-11-14):** No workers in flight (run `run_c58bb5836634` idle). render.yaml QA fix
merged as 4902ee6 and pushed (d2fcc9e..4902ee6); 123jpnbf3m2 back to `ready for qa test`; workspaces
cleaned. Waiting on the user to apply the Render Blueprint and send the onrender.com URL; then
`npm run smoke -- <url>` + a two-browser race on it, report RTT / snapshot rate, then dispatch
123jpnbf3m8 (review nits, incl. the PLAN-HOSTING.md:74 wording).

## Branches

- `main`: 4902ee6 pushed to origin; later team/ commits are local only (push only when asked).

## In flight

None.

## Waiting on the user

- Render: account created and GitHub connected (user, 2026-11-14). Next for the user, after the
  push: New -> Blueprint from render.yaml, then send the onrender.com URL for the smoke test.
- First deploy: go-ahead.
- Custom domain at simply.com: subdomain choice and DNS record, after the onrender.com URL works.
