# Scrap Rally — hosting plan

Goal: a public URL where friends can create and join rooms and race, on a single long-running
instance (rooms live in memory, PLAN.md). Cheapest setup that is good enough for playtests.

Reviewed by the Fable 5.2 advisor: "sound with changes"; all changes folded in below.

## Facts checked (2026-11-14)

- Local: npm 11.17 blocks dependency install scripts unless approved (`allow-scripts` is empty).
  The lockfile includes the Linux builds of esbuild, rolldown and lightningcss (x64 + arm64).
  Docker 29.7 is installed and running locally. No host CLI (fly / railway / render) is installed.
- Probe: `vite build --ssr server/index.ts` bundles the server into one 33 kB ESM file whose
  only imports are Node built-ins, `ws`, and a lazy `import("vite")` (dev only). Run with plain
  `node` + `NODE_ENV=production` it served `dist/` (200) and 30 snapshots/s over `/ws`.
- Probe: when the server restarts, a connected client's rejoin gets `err "No room with code"`
  and the client stays `connected=false` with its old seat: the HUD would show
  "reconnecting…" forever. Restarts are routine on a host (every deploy; free tiers restart).
- Code reading (advisor, checked): two tabs sharing a seat token (a duplicated tab copies
  `sessionStorage`) kick each other forever: "seat taken over" err, close, token rejoin, repeat.
- Hosts (third-party pricing pages vary; confirm at signup):
  - Render free web service: spins down after 15 min with no HTTP request *and* no WebSocket
    message (WebSocket traffic keeps it awake, per Render's changelog); ~1 min cold start; may be
    restarted at any time; small CPU share. Paid instance for always-on.
  - Fly.io: no free allowance for new organizations; smallest always-on machine about $2/month;
    card needed after a short trial.
  - Railway: 30-day trial with $5 credit, then Hobby $5/month including $5 of usage.

## Recommendation

Start on **Render's free tier**: no cost, builds the Dockerfile from the GitHub repo, and a racing
session keeps it awake; the first visitor after a quiet spell waits ~1 min. The smoke script
measures whether the free CPU share keeps the 60 Hz loop on time; if it does not (or restarts
get in the way), move the same Dockerfile to Fly.io (~$2/month, always on). EU region near
Denmark. The user picks the host; I never create accounts or enter payment details.

## Changes

1. **Production server without tsx** (`package.json`, `.gitignore`):
   - `build`: `vite build && vite build --ssr server/index.ts --outDir dist-server`
   - `start`: `NODE_ENV=production node dist-server/index.js`
   - Dev scripts and tests unchanged (`tsx`). `dist-server` added to `.gitignore`.
2. **Dockerfile** (multi-stage) + `.dockerignore` (`node_modules`, `dist`, `dist-server`, `.git`):
   - build stage: `node:24-slim` (pinned minor; glibc, not Alpine), `npm ci --ignore-scripts`,
     `npm run build`. No `NODE_ENV` here (it would drop the dev dependencies the build needs).
   - runtime stage: `node:24-slim`, `ENV NODE_ENV=production` (the server picks prod mode from
     it; without it the CMD would try to load Vite and crash), `npm ci --omit=dev
     --ignore-scripts` (only `ws`), copy `dist/` and `dist-server/`, `USER node`,
     `CMD ["node", "dist-server/index.js"]`. The server honours `PORT` and binds `0.0.0.0`.
3. **Protocol**: `err` gains a `code`: `gone` (no such room), `full`, `taken` (seat taken over),
   `restarting`, `busy` (server full); other errors keep plain messages.
4. **Server, for a public playtest** (`server/index.ts`, `server/room.ts`):
   - `GET /healthz` → 200 "ok".
   - Caps sized to a small instance, overridable by env: `MAX_ROOMS` (default 20) and
     `MAX_SOCKETS` (default 150). Over the cap: `create` gets `err busy "Server is full"`, new
     sockets beyond `MAX_SOCKETS` are refused. Sockets that have not joined a room within 10 s
     are closed (the client opens its socket only on create/join).
   - Message rate: counted per socket in `index.ts` before decoding; beyond 240 messages in a
     1-second window the excess is dropped (a Wi-Fi stall can flush a burst of queued inputs;
     dropping is gentler than closing, and the token rejoin covers the rest).
   - SIGTERM/SIGINT: send `err restarting "Server restarting"` to every socket, `close(1012)`,
     then `process.exit(0)`, with a 2.5 s hard timer. This also makes Node as PID 1 react to
     SIGTERM without `--init`.
5. **Client** (`client/game.ts`, `client/main.ts`):
   - While rejoining after a drop (`you` set, not connected), an `err` with code `gone` or `full`
     means the seat is gone: `Game` stops itself (detaches the transport before closing so no
     new reconnect is scheduled) and fires `connection("lost", reason)`.
   - `err taken` (seat taken over) is fatal too: no rejoin, so two tabs cannot ping-pong.
   - `err restarting`: show "Server restarting…", then the normal reconnect runs; if the room
     is gone afterwards, the rule above ends it.
   - `connection("lost")` carries a reason; `main.ts` shows it in the menu ("The room is gone —
     the server restarted", "This seat was taken over in another tab", ...).
6. **Host config**, for the chosen host only: Render `render.yaml` (Docker runtime, free plan,
   EU region, health check `/healthz`, one instance, `autoDeploy: false` so a push is not a
   deploy); Fly `fly.toml` (`auto_stop_machines = "off"`, `min_machines_running = 1`, health
   check) and the first deploy with `--ha=false` / `fly scale count 1` (Fly creates two machines
   by default, which would split in-memory rooms).
7. **Smoke script** `scripts/smoke.ts <base-url>`: GET `/healthz` and `/`; two WebSocket clients
   create + join, the host starts, they race ~10 s; reports RTT, snapshots per second and the
   largest gap between snapshots (the number that decides Render free vs Fly). Works for
   localhost, the local container and the public URL (`wss://` for `https://`).

## Verification

1. `npm run check`, `npm test` green, plus new bot-test checks: restart the in-process server on
   the same port mid-lobby → the client gets `lost` with the "room is gone" reason and no socket
   stays open; a second client using the same token → the first gets `taken` and does not
   come back.
2. `npm run build && npm start` on the Mac: smoke script passes.
3. `docker build` + `docker run -p 3000:3000`: smoke script passes; the image has no dev
   dependencies; `docker stop` exits in under 3 s and a connected client sees the restart notice.
4. Go-ahead points for the user: (a) push to GitHub (the host builds from the repo), (b) the
   first deploy. Then smoke script against the public URL, and two agent-browser sessions racing
   on it (screenshots, RTT in the HUD).

## What needs the user

- Choose the host and region; create the account; connect the GitHub repo (or install the host
  CLI and log in). Payment details, if any, are entered by the user.
- Every push and deploy needs an explicit go-ahead.

## Not in scope

Custom domain, persistence of rooms across restarts, multiple instances, analytics.
