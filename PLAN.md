# Scrap Rally — prototype plan

Browser multiplayer top-down arcade racer in the spirit of Amiga-era top-down racers
with weapons and an upgrade shop. Original name, cars, tracks, art and music: we build in
the genre, we do not recreate any existing game.

**Prototype scope:** 2–6 players join a room with a 4-character code, one track, 3 laps,
results screen. No weapons or shop yet, but nothing in the architecture may block them.

## Decisions already made (with the user)

- Transport: WebSockets via Node + `ws`, run locally first, hosted later
  (Fly.io / Render / Railway; must be a long-running single instance, rooms live in memory).
  WebTransport is a later option; the design below keeps that switch cheap.
- Codex pair programming: OFF for this project.
- Plans are reviewed by a **Fable 5.2 advisor** (Agent tool, `model: "fable"`, read-only
  Plan agent) before building. This plan (v1) was reviewed: "sound with changes"; all
  changes are folded in below.
- Git: commit as work progresses (small, coherent commits). **Never push** unless asked.

## Stack

- TypeScript everywhere, run with `tsx` (Node 24). One process: `http` + `ws` on one port.
- Dev: Vite in middleware mode inside the same server, with `server.hmr.server` set to the
  same http server so HMR does not open a second port.
- The game socket server is `new WebSocketServer({ noServer: true })`; route `upgrade`
  events by path: `/ws` → game, anything else is left for Vite's HMR (dev) or destroyed (prod).
  Attaching `ws` directly to the http server would reject Vite's HMR upgrades.
- Prod: `vite build` → server serves `dist/`. Honour `PORT`, bind `0.0.0.0`.
- Client: Canvas 2D, 640×360 internal resolution scaled up with `image-rendering: pixelated`.
- Messages: JSON, all encode/decode in `shared/protocol.ts`; floats rounded.

## Layout

```
shared/  track.ts     DONE  centerline, local-window track queries, grid, self-clearance check
         physics.ts   DONE  stepCar(car, input, stats, track), collideCars, CarStats
         protocol.ts  DONE  message types, constants, encode/decode
server/  index.ts     DONE  http + vite middleware + ws upgrade routing + heartbeat + startServer()
         room.ts      DONE  room registry, codes, players, phases, input queues, tick, snapshots
         race.ts      DONE  lap/checkpoint progress as crossings, race distance
client/  main.ts      DONE  menu / lobby / HUD flow, reconnect, fixed-step loop
         net.ts       DONE  Transport interface + WebSocket impl + ?lag=&jitter= simulator
         game.ts      DONE  prediction, reconciliation, interpolation, clock offset
         render.ts    DONE  track, cars, camera, minimap
         input.ts     DONE  keyboard (arrows / WASD)
         style.css    DONE
index.html            DONE
scripts/bots.ts       DONE  headless end-to-end test
```

## Netcode (after advisor review)

**One server clock.** A global fixed-step loop (accumulator on `performance.now()`, max
4 catch-up steps, then drop the backlog) ticks every room at 60 Hz. Each tick:
1. Consume **one input per player** from that player's queue (jitter buffer):
   - wait until 2 inputs are queued before consuming after a start or an underrun;
   - on underrun repeat the last input for up to 6 ticks, then use zero input (coast);
   - on overflow (> 6 queued) drop the oldest down to 3;
   - `ack` = seq of the last *consumed* input.
2. Step every car (`stepCar`), resolve car-car collisions, update race progress.
3. Phase timers. Every `SNAPSHOT_EVERY` (2) ticks send a snapshot (30 Hz) to each socket:
   all entities + that recipient's `ack` + server time + phase + `phaseEnds`.

**Inputs.** The client sends `{t:"in", i:[[seq,throttle,steer], ...]}` repeating the last
`INPUT_REDUNDANCY` (3) inputs; the server dedups by seq (only seq > lastQueuedSeq).
Seq restarts at 0 on every welcome (join / rejoin); the server resets the queue then too.

**Phase gating.** The client sends the *gated* input (zeroed unless it believes the race
is on: snapshot phase `racing`, or `countdown` with estimated server time ≥ `phaseEnds`).
The server zeroes inputs whenever its phase is not `racing` (anti early-start).

**Own car: prediction + reconciliation.** Client fixed 60 Hz step (rAF + accumulator,
catch-up clamped to 5 steps): gate input → `stepCar` locally → store `{seq, input}` in
pending and the resulting state in `history[seq]` → send. On a snapshot: drop pending
≤ ack, reset to the server car, replay pending; the visual jump becomes a render offset
that decays over ~100 ms. Reconciliation error = |history[ack] − server car|; shown in the
debug overlay (`?debug=1`) and asserted in the bot test.

**Other cars: interpolation** at `estServerNow − 100 ms` between buffered snapshots
(extrapolate ≤ 100 ms past the newest). `estServerNow = performance.now() + offset`, where
offset = **max** over the last ~2 s of `(snap.time − localRecvTime)` (the minimum-latency
sample; an EMA would be biased by jitter).

**Car-car collisions** are server-only; the predicted car gets smoothed corrections.
Accept some rubber-banding during sustained contact in the prototype.

**Do not chase bit-exact determinism** across JS engines; reconciliation absorbs it.

## Race logic

- Track progress uses `queryTrackNear` around the car's last segment (`car.seg`), never a
  global nearest search, so parts of the track that pass close by can't steal the car.
- Checkpoints at 25 / 50 / 75 % of the length, detected as forward **crossings** between
  last and current `s`; the finish line (s = 0) counts a lap only after all three.
- `lap` = completed laps. Race distance `rd = lap*L + s`, with `s − L` while `cp == 0` and
  `s > L/2` (cars on the grid sit just behind the line).
- Finish at `LAPS`; the race ends when every racer has finished or `FINISH_GRACE_MS` after
  the winner → results for `RESULTS_MS` → lobby. A finished car keeps driving.

## Rooms and players

- Code: 4 chars from `CODE_ALPHABET` (no 0/O/1/I/L), unique. Share link `/?room=CODE`.
- `playerId` is independent of the socket. `welcome` hands out a session token, which the
  client keeps in `sessionStorage` per room; `join` with the token within
  `RECONNECT_GRACE_MS` rebinds the same player (and car) to the new socket.
- Max 6 players. Joining mid-race → seated for the next race (`inRace: false`); their
  camera follows the leader meanwhile. No separate spectator mode.
- Host = first player; reassigned when the host is removed. An empty room is deleted.
- Host clicks Start (works solo for testing) → 3 s countdown → race.
- Ready check: in the lobby every player except the host toggles Ready (`ready` message;
  the host's Start counts as the host's ready). Start is refused while a connected
  non-host is not ready ("Waiting for n players to get ready"); offline players (in their
  reconnect grace) are not waited for and sit the race out. Ready is kept across a
  rebind, reset for everyone when a race starts, never set outside the lobby, and
  unchanged by buying. A new host after a reassignment need not be ready.
- Start anyway: `start` with `force` is accepted from `forceStartAt` (in the `room`
  message) = `FORCE_START_MS` (60 s) after the later of the lobby opening and the last
  new player joining (a rejoin does not move it), and races every connected player,
  ready or not. The client shows the button only once it has a server clock estimate.
- Heartbeat: protocol-level ping every 10 s, terminate sockets that missed a pong.
  App-level `ping`/`pong` for the RTT shown in the HUD. `maxPayload` 4 KB.

## Ready for weapons and shop later

- Snapshots carry a generic `ents` list with a kind field (`k: "car"` today).
- `stepCar` takes per-car `CarStats` (the shop will modify them).
- Reliable one-off things travel as events (`ev`), separate from state snapshots.
- Player identity survives reconnects, so money/upgrades can persist across races.

## Verification

1. `npm run check` (tsc) clean.
2. `npm run bots`: starts the real server in-process (`startServer({ port: 0, vite: false,
   laps: 1 })`) and drives bots that follow the racing line:
   - create + join by code, host starts, phases go lobby → countdown → racing → results → lobby;
   - every bot finishes the lap; results arrive in order;
   - one bot runs with simulated 80 ms ± 10 ms latency; median reconciliation error < 0.5
     units, and no error > 50 (no teleports);
   - a bot disconnects mid-race and rejoins with its token: same player id, car continues;
   - a third bot joining mid-race gets `inRace: false` and no car;
   - `minSelfClearance(track) > 2 * track.wall`.
3. `npm run dev`, open two browser tabs, create + join, race; agent-browser screenshots of
   the lobby and a race in progress.

## Status (2026-11-13)

Prototype built and verified. Small deviations from the text above:
- Phase timers run at the *start* of a server tick, so the first racing tick already
  applies inputs (the plan listed them last).
- The `room` message also carries `raceStart`, so mid-race joiners can show the race clock.
- `?lag=` is added round-trip time (split over both directions), `?jitter=` is ± ms per
  message per direction; delayed messages stay in order, like TCP.
- The bot test uses 4 bots: Alpha (host), Bravo (80 ± 10 ms), Charlie (drops and rejoins),
  Delta (joins mid-race). It also checks unknown-code and non-host-start refusals.
- Verification step 3 used two separate browser sessions instead of two tabs of one
  browser (headless background tabs are throttled).

Verification results: `npm run check` clean; `npm run bots` 19/19 on 3 consecutive runs
(lagged bot: median reconciliation error 0.004, max 0.48, RTT ~78 ms); dev server + browsers:
create, join by invite link, lobby, countdown, race, reload-rejoin, mid-race spectator;
`npm run build` + `npm start` serves dist/ and the game socket.

Known gap: a race only ends after someone finishes (+ grace) or every racer has left; there
is no overall race time limit yet.

## Milestone 2

Weapons, scrap and the garage: see [PLAN-M2.md](PLAN-M2.md) (approved and built 2026-11-14).

## Hosting

Public deploy (Render free tier first, Dockerfile portable to Fly.io): see
[PLAN-HOSTING.md](PLAN-HOSTING.md) (approved 2026-11-14).

## Later (not in the prototype)

Weapons (projectiles, mines) as entities, between-race shop with money, more tracks,
touch / gamepad controls, sound and music, hosting, optional WebTransport transport.
