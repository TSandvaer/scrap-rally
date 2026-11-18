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

**Car-car collisions.** Shape (`shared/physics.ts`): each car is a capsule along its
heading, a segment of length 15 centred on the car with radius 8, matching the drawn 30x16
car (contact at 16 between centres side by side, 31 nose to tail). Per car pair the server
resolves one contact: closest points of the two segments give the normal, both cars move
half the overlap apart and trade velocity along the normal with restitution
`CAR_RESTITUTION`. A fresh contact takes its normal from the moment the capsules first
touched along this tick's relative motion, so a deep overlap at speed pushes back the way
the cars met, never through each other. `CAR_RADIUS` stays the round hit shape for
weapons; walls stay centre-based; no ramming damage. Ghosted, wrecked and finished cars do
not collide.
The client predicts its own car's bumps (`client/contact.ts`): after each own step, in
`step()` and in every replayed step of the reconcile, a one-sided resolver moves only the
own car by exactly its half of the push and impulse, against each other solid car's pose
= latest snapshot + v·k·DT, heading turned on at the car's turning speed (from its last
two snapshots), k = the step index after that snapshot (the tick the server applies that
input). Nothing collides while the own car is wrecked or ghosted. Other cars within ~150
units (until ~220) ease over 500 ms to that same predicted pose, so a bump is seen where
it happens. The small jump of that prediction at each new snapshot goes into a critically
damped offset, so a near car's velocity never jumps. Prediction reaches 300 ms ahead of the
newest snapshot (the own car runs ~10 steps ahead at 80 ms RTT, ~15 at 150 ms, ~17 at 180
ms). Whether the own car is past that is decided once per snapshot cycle from the furthest
it ran ahead, with 2 steps of hysteresis; past it there is no prediction at all (no
predicted bumps, the server's arrive through the reconcile; near cars ease back to
interpolation), and the drawn prediction never stands still at a cap. Further away cars
stay interpolated 100 ms in the past, and rivets and hit sparks stay at the interpolation
time. `?debug=1` shows a jerk meter (velocity change between frames of each other car,
near / easing / far, reset at every race start); `?debug=1&autopilot=1` drives the own
car with the bot AI for measuring with `npm run botplay`. A live predicted contact above
`IMPACT_MIN_SPEED` closing speed shows sparks at the contact point and a small screen
shake (150 ms cooldown; replays never fire it). There is no server bump event.

**Do not chase bit-exact determinism** across JS engines; reconciliation absorbs it.

## Race logic

- Track progress uses `queryTrackNear` around the car's last segment (`car.seg`), never a
  global nearest search, so parts of the track that pass close by can't steal the car.
- Checkpoints at 25 / 50 / 75 % of the length, detected as forward **crossings** between
  last and current `s`; the finish line (s = 0) counts a lap only after all three.
- `lap` = completed laps. Race distance `rd = lap*L + s`, with `s − L` while `cp == 0` and
  `s > L/2` (cars on the grid sit just behind the line).
- Finish at `LAPS`; the race ends when every racer still on the field has finished (retired
  players are not waited for) or `FINISH_GRACE_MS` after the winner → results for
  `RESULTS_MS` → lobby. A finished car keeps driving.

## Rooms and players

- Code: 4 chars from `CODE_ALPHABET` (no 0/O/1/I/L), unique. Share link `/?room=CODE`.
- `playerId` is independent of the socket. `welcome` hands out a session token, which the
  client keeps in `sessionStorage` per room; `join` with the token within
  `RECONNECT_GRACE_MS` rebinds the same player (and car) to the new socket.
- Max 6 players. Joining mid-race → seated for the next race (`inRace: false`); their
  camera follows the leader meanwhile. No separate spectator mode.
- Host = first player; reassigned when the host is removed, or handed over from the Esc
  menu (below). An empty room is deleted.
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
- Leave: the Leave button sends `{t:"leave"}`; the server removes the player at once (no
  reconnect grace) and closes the socket. A dropped socket is still removed only when the
  grace runs out.
- Room chat (see [PLAN-CHAT.md](PLAN-CHAT.md), built 2026-11-17): C->S `{t:"chat", text}` in
  any phase from a bound player; S->C `{t:"chat", line}` live to the room and
  `{t:"chatlog", lines}` right after every `welcome` (join, rejoin, takeover). `ChatLine =
  {n, kind: say|join|leave|removed|host|result, from?, name, color, text}`; name and colour as at the time
  of the line. The room keeps the last 300 lines in memory; they go with the room. Text is
  cleaned on the server (whitespace collapsed, `\p{C}` stripped except ZWNJ/ZWJ, trimmed,
  cut to 200 code points; empty or non-string ignored) and rate-limited per player (5 at
  once, one more per second; over that a plain `err` "Slow down", at most about once a
  second). Room-wide budgets stop a join / say / leave churn (every new seat has a full
  bucket and Leave frees it at once) from flushing the history: say lines also share 15 at
  once, 3 more per second per room (over it: "Slow down"); join and leave lines share 12, one
  more per 2 s, and are skipped when it is empty. Game lines: "join" before the joiner's bind (so the joiner sees it once, in its
  log), "leave" only when a player is removed for good, one "result" per race from the end
  of the race (none when a race ends because every racer left). The client replaces its list
  on `chatlog` and clears it on leave and in another room.
- In-game menu and host room controls (see [PLAN-MENU.md](PLAN-MENU.md), MENU-1 built
  2026-11-18). Esc opens and closes the menu in a room in any phase (`client/menu.ts`; not on
  the main menu; the chat input and the sound popover take their own Esc first), and so does
  the ☰ button under the speaker (every device, in a room; touch screens have no Esc). While it is
  open the frame loop drives with no controls: the race keeps running and the car coasts.
  Everyone: Resume, Sound, Controls, Copy invite link, Retire to garage, Leave room.
  - Retire (MENU-2, built 2026-11-18): `{t:"retire"}` from any racer while racing (refused with
    an `err` in other phases, without a car, after finishing, or twice). The car leaves the
    field at once (not stepped or solid, no inputs, not in snapshots); the player is DNF but
    keeps their progress, so `endRace` (rows keyed on progress, not car) writes their row
    (ranked among the non-finishers by the distance driven when they retired, like any DNF:
    user decision 2026-11-18, so retiring cannot buy the front of the reversed grid) and pays
    their wreck bonus. The race-end check
    only waits for cars: it ends as soon as everyone left has finished; everyone retired with no
    finisher → lobby, no results. `PlayerInfo.retired` (reset in clearRace and beginRace, so by
    the lobby, a stop and a restart). A retired player may `buy` during the race; a stop or
    restart gives back the start-of-race ammo and then replays the ammo packs they bought on it
    as if in the lobby: a pack the cap leaves no room for is refunded (a stop or restart never
    costs scrap, never undoes a purchase, never adds ammo). The client drops
    its predicted car on the room message (engine and gravel silent), shows the lobby panel as
    the garage (shop, docked chat, no start/ready, "You retired — you're in the next race"),
    and others get a toast for a retirement seen live (`Game.on.retired`; not for players
    already retired when a client joins or rejoins) and a "retired" pill (lobby list, host's
    players list).
  Host only (C->S, refused with an `err` from anyone else):
  - `{t:"stop"}` (countdown/race): back to the lobby as if the race never ran: no results, no
    result line, no scrap, the grid order of the last finished race kept, and every racer's
    ammo restored from a snapshot taken when the race began ("aborted race = never run").
    "Start anyway" is available at once afterwards, except for a player who joined during the
    aborted race (still `FORCE_START_MS` to shop).
  - `{t:"restart"}` (countdown/race): the race is cleared as on the way to the lobby (an
    offline racer's car too), ammo restored, then a fresh countdown on the same track for
    everyone connected, ready or not (a late joiner too). The client drops its predicted car
    when `raceStart` changes, so the grid teleport is no reconciliation jump.
  - `{t:"kick", id}` (any phase, not yourself): the session is detached first (no chat or
    input from it), then `err` code `kicked`, then the socket closes. One chat line "X was
    removed" (kind `removed`, through the join/leave budget), no "left the room". The token is
    blocked in this room (at most `BLOCKLIST_MAX` = 64, oldest forgotten; gone with the room);
    a join with it gets `err` code `kicked`. Best effort: a join without a token (another
    browser, cleared storage) is a new player, which a locked room refuses.
  - `{t:"host", id}`: to a connected player; both lose a stale ready flag; chat line "X is now
    the host" (kind `host`, budgeted).
  - `{t:"lock", locked}`: a locked room refuses new players (`err` code `locked`); a rejoin with
    a seat token still works. The `room` message carries `locked`.
  The client stops on `kicked` and `locked` like on `taken` (no reconnect loop), keeps the
  stored token (retyping the code meets the block again) and says why on the menu screen.

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

## Milestone 3

Jumps, road crossings, holes, recovery points and two new tracks: see [PLAN-M3.md](PLAN-M3.md)
(approved 2026-11-16, Fable-reviewed).

## Sound

Plan: [PLAN-SOUND.md](PLAN-SOUND.md) (approved 2026-11-17, Fable-reviewed). Everything is made in code
with Web Audio; no audio files. SND-1 (built 2026-11-17): music in the lobby (garage) and on the
results screen, none in the countdown or the race, never on the menu.

- `client/audio.ts`: `AudioEngine` creates/resumes the AudioContext on a gesture (pointerup / click /
  keydown, re-armed while it is not running, e.g. iOS "interrupted"), suspends it while the tab is
  hidden, and owns the chain music bus + sfx bus -> light compressor -> master (mute) plus a shared
  noise buffer. `SoundControls`: the speaker button (top right) + popover with music / effects
  sliders and mute, and M (KeyM, no repeat or modifiers, not in text fields). Settings in
  localStorage `scrap-rally:sound` (defaults music 0.5, effects 0.8, unmuted). Controls blur after
  use and the popover closes at the countdown, so they never hold the driving keys.
- `client/music.ts`: "Rust Bucket Shuffle", an original 122 BPM song in E minor, 32 bars
  (A Em-Em-C-D-Em-Em-Am-B hook, B C-D-Em-Em-C-D-B-B with arpeggio, A2, B2 with a fill), ~63 s loop;
  square bass, pulse lead and arpeggio, noise drums with a sine kick and a scrap-metal clank.
  `MusicPlayer` is polled every frame (client/main.ts soundFrame) with the room and phase.
- `client/soundlogic.ts` (pure, tested in sim-test): settings parsing and clamping, the M key test,
  the music state machine (start / fade out 0.8 s / stop / resume, fade in 1 s), and the lookahead
  `StepClock` (25 ms timer, 100 ms ahead on the audio clock, never in the past, skips missed steps,
  restarts from now after a hidden tab).
- Debug sound board `?debug=1&sounds=1` (client/soundboard.ts, dynamic import): music play / stop /
  follow game, volumes, an offline 4-bar level check (`window.scrapSound.check(bars, volume)`) and a
  30 s WAV export. SND-2 adds the race effects to the sfx bus and its buttons to this board.

SND-2 (built 2026-11-17): race effects, all synthesized on the effects bus.

- `client/sfx.ts`: 14 recipes (countdown beep + GO, rivet, mine drop, mine blast, hit, wreck, bump,
  take-off, landing, fall, recover, lap, finish) built from oscillators, the shared noise buffer,
  filters and envelopes when they start; every source stops with its voice and the nodes disconnect
  on `ended`. The rivet is a machine-gun round (a noise crack on a falling sine thump, varied
  +-8% per shot); the mine blast an explosion (crack, 120 -> 35 Hz boom, a low-passed noise
  rumble closing over ~1.1 s, light saturation; other cars' blasts capped at 2 at once).
- Impacts and surface (user feedback 2026-11-17): an own car contact (client/contact.ts impacts,
  closing speed) below 150 u/s is a soft thud, from it a metal crash (crunch noise, four inharmonic
  partials bending down, a groan when hard; force 0 -> 1 at 450 u/s). A wall hit is derived in
  `Game.step()` only (`wallHitSpeed`: the velocity before the step into the wall normal, once the
  step ends against the wall, `wallLimit()` in shared/physics.ts), from 50 u/s, one per 200 ms, a
  thud below 110 u/s, else metal on a concrete thump. Gravel: while the own predicted car's centre
  is off the asphalt (`queryTrackNear` dist > halfWidth, the physics' off-road test) and it rolls,
  a persistent voice of crackling grains (denser and brighter with speed) over a noise band, faded
  in and out at the edge; silent airborne, wrecked, falling, finished, outside races. (No kerb sound:
  the user dropped it.)
- Engine (user feedback 2026-11-17: "sounds electric"): a petrol engine, one persistent voice moved
  once a frame with setTargetAtTime: one oscillator plays a whole engine cycle (a PeriodicWave of
  decaying firing pulses at their positions and strengths, so uneven engines lope), a sub sine at
  half the firing rate, noise chuffing with every firing, a soft clipper driven harder on throttle,
  a low-pass opening with revs and throttle, two slow LFOs for an unsteady idle. Presets `ENGINES`:
  4-cyl buzz (32 -> 205 Hz firing rate), V8 rumble (27 -> 150 Hz), old rattly Buggy (25 -> 170 Hz,
  the default, picked by the user). The choice is sound setting `engine` (sound board "Engine: use
  in game"). rpm follows speed (a rev at a standstill, higher in the air), load the throttle of the
  controls the frame loop stepped with; silent with no car, disconnected, wrecked, falling,
  finished, on results and outside races; stopped in the lobby.
  `RaceSounds` plays what the triggers decide; other cars by distance from the own car (the camera
  when spectating): full within 150 units, silent from 900, x0.75, light pan (max 0.5) by screen x.
- Triggers (`client/soundlogic.ts` `SoundTriggers`, pure, tested in sim-test): own take-off /
  landing / fall / recovery, shots and mines from `Game.step()` only (`takeOwnSounds()`; landing =
  `prevCar.air > 0 && car.air === 0 && car.fall === 0`), a 400 ms refractory for the first four;
  other cars' shots, mines and air/fall from `Game.interpSnapshot()` (the drawn snapshot) against
  the ids and states seen, seeded silently on the first snapshot, after a welcome and after a gap
  > 250 ms; server events through `EventGate`: other cars' after the interpolation delay, a hit
  waits for a snapshot of its tick so a wreck of the same tick replaces it (a fatal mine keeps its
  blast); bumps from the existing `takeImpacts()` loop; countdown cues latched per raceStart with a
  monotonic index on the HUD's clock, none before `hasClock()`, a cue > 250 ms late passed silently.
  Per-kind caps (concurrent and gap) for other cars; the own car's always play. Nothing triggers
  while audio does not run (locked, suspended, tab hidden) and nothing is kept for later.
- Debug: `scrapDebug.sounds.log` (every trigger with src, own, outcome played / far / capped,
  entity id, race), `dropped.silent`, `triggers.refractoryDrops`. The sound board has a button per
  effect, a 3 s rivet burst, other cars at 100 / 400 / 700 units and a blast at 450, a rev per
  engine (idle -> top -> idle) and the in-game engine picker, `scrapSound.effects.check()` (levels
  per effect, offline), effects and engine WAVs.
- Unlock after a hidden tab (review fix): on return the gesture unlock is armed while the context
  does not run, so a resume() that leaves it suspended is recovered by the next key or click.

## Later (not in the prototype)

Weapons (projectiles, mines) as entities, between-race shop with money, more tracks,
touch / gamepad controls, hosting, optional WebTransport transport.
