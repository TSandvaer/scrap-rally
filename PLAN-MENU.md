# PLAN-MENU — in-game Esc menu with host controls

User request 2026-11-18: "click ESC and get an in game menu. As a host: pause game, stop game, remove player,
any other meaningful feature. As a player: exit to lobby, any other meaningful feature."
User choices (popup 2026-11-18):
- Stop game = abort the race: everyone back to the lobby, no results, no scrap paid.
- Remove player = removed at once ("You were removed by the host") and blocked from rejoining this room (best
  effort: by their rejoin token; no accounts exist), plus a chat line "X was removed".
- Player "Exit to lobby" during a race = retire: the car leaves the race (DNF), the player goes to the lobby/garage
  screen (shop, chat) while the others finish, and is in the next race.
- Extras (all four chosen): host hands over host; host locks the room (no new joins, rejoins still work); settings &
  controls in the menu for everyone (sound volume/mute, key-bindings help, copy invite link); host restarts the race.
- Pause (always included): the host pauses the race for everyone ("Paused by <host>"), resume with a 3-2-1.

## Design

1. Opening. Esc opens/closes the menu in a room (any phase). Esc while the chat input is focused or the chat is open
   closes the chat first (existing behaviour); Esc on the menu closes it. Opening the menu blurs inputs and calls
   Keyboard.clear() (like the chat), so a held key stops. For a non-host the race keeps running while the menu is open
   (the car coasts: no inputs); the menu says so. On the main menu Esc does nothing.
2. Menu items. Everyone: Resume (close), Sound (the existing volume/mute controls), Controls (key help), Copy invite
   link, Retire to garage (racing only; confirm), Leave room (confirm). Host adds: Pause/Resume race (racing or
   countdown), Stop race (confirm), Restart race (confirm), Players list with per-player Remove (confirm) and Make host,
   Lock/Unlock room. Buttons that do not apply to the phase are hidden or disabled.
3. Protocol (shared/protocol.ts), all host-only unless noted, refused with an `err` otherwise:
   - {t:"pause"} / {t:"resume"} (countdown/racing); {t:"stop"} (countdown/racing -> lobby, no payouts, no result
     line); {t:"restart"} (countdown/racing -> a fresh countdown on the same track; everyone connected races; ready flags
     are not required for a restart); {t:"kick", id}; {t:"host", id} (hand over); {t:"lock", locked: boolean}.
   - Any player: {t:"retire"} (racing; your car is marked DNF and removed from the field: not solid, not drawn, no
     inputs; you get the lobby/garage view until the race ends).
   - Room message gains: paused (boolean), pausedBy (name), resumeAt (server time of the 3-2-1 end, 0 = none),
     locked (boolean). PlayerInfo gains retired (boolean) for the current race.
   - S->C to a removed player: {t:"err", msg:"You were removed by the host", code:"kicked"} then close; the client
     shows it on the menu screen and does not auto-rejoin.
4. Pause model (server/room.ts). While paused the room does not step cars, combat, mines or timers: tick-based state
   (wreck/ghost/air/fall ticks, mine life) freezes naturally. Wall-clock fields shift on resume by the paused
   duration: raceStart (so the race clock, finish times and WEAPONS_ARM_MS stay right), phaseEnds (countdown end,
   finish grace). Snapshots keep flowing (frozen positions) so clients stay connected; inputs received while paused
   are acked but not applied. Resume: resumeAt = now + 3000; until then still paused but clients show 3-2-1; at
   resumeAt the room steps again. Safety: if the host leaves/is removed while paused, the new host can resume; a pause
   auto-resumes after 120 s. Stop/restart/kick work while paused.
5. Client (client/game.ts): while paused, stop prediction (no step, no new pending inputs), show "PAUSED by <name>"
   then the 3-2-1; on resume re-sync from the next snapshot (reconcile as after a stall); the race clock in the HUD
   uses the shifted raceStart. Sounds: the engine is silent while paused; music stays off (still a race).
6. Kick + block: the server removes the player at once (remove()), adds their rejoin token to a per-room blocklist,
   and refuses joins with that token ("You were removed from this room"). Chat line "X was removed". The blocklist dies
   with the room.
7. Lock: a locked room refuses new joins ("Room is locked") but accepts rejoins with a valid token. Shown in the lobby
   (a lock icon) to everyone.
8. Retire: server marks the player's car retired for this race (DNF in results, no payout for place), removes it from
   solid()/snapshots' active cars; the client shows the lobby/garage panel (shopping allowed, chat). A race where
   everyone left racing retires ends like any race end. The player races again next race.
9. Host handover: {t:"host", id} sets hostId to a connected player; chat line "X is now the host".

## Tests

- sim-test: every host-only command refused for non-hosts and in the wrong phase; pause freezes car positions,
  mine lifetimes and wreck/ghost ticks; resume shifts raceStart/phaseEnds by the paused time (race time and weapons arm
  unaffected), 3-2-1 before stepping, auto-resume at 120 s, new host can resume; stop -> lobby with no payouts and no
  result line; restart -> fresh countdown, same track; kick removes at once, blocks the token, chat line; lock refuses
  new joins and accepts token rejoins; retire marks DNF, removes from the field, payouts exclude the place; host handover.
- bots.ts (sockets): a paused race over sockets with a lagged bot (no reconciliation jump after resume beyond the usual
  bound), kick of a bot (it gets the kicked err and cannot rejoin), retire of a bot mid-race.
- Browser (muted): Esc opens/closes the menu; Esc with the chat open closes the chat only; host and player menus show
  the right items per phase; screenshots of both menus.
- npm run check clean, npm test twice, build ok.

## Advisor changes (binding; Fable 5.2 review 2026-11-18: "sound with changes"; these override the text above)

1. Kicked/locked clients must not auto-rejoin: an uncoded err falls to on.error and the close triggers scheduleReconnect,
   resending the stored token 15x (client/game.ts:369-373, :462-488, :52). Add ErrCode "kicked" and "locked"
   (shared/protocol.ts:137) + matching ConnReasons; stop() on both like "taken" (:463). KEEP the stored token (so retyping
   the code still hits the block).
2. Kick detaches the session first: copy leave() (server/room.ts:287-296), then err, then close (remove() alone leaves
   session.player set and chat() :299 has no membership check). Check the blocklist before addPlayer (:690); cap its size;
   a host cannot kick themself.
3. Chat lines: remove() always writes "left the room" (:282): a kick writes only "X was removed" (no double line);
   "removed" and "now the host" lines go through comingsBudget (:316-322).
4. Pause is not an early return from tick: grace removal (:488-490), snapshots (:492), auto-resume and room deletion
   (:740) keep running; only the phase timers (:436-438) and the simulation are skipped. Do not shift disconnectedAt or
   chat buckets; forceStartAt is lobby-only (:187).
5. Shift phaseEnds only when nonzero (0 = open-ended while racing, :436-437).
6. While paused keep calling consumeInput and discard the command (ack and mineBase advance, :451, :630-651);
   resetQueue for everyone at resume (else the pre-pause throttle repeats for 6 ticks, :646-649).
7. The room message carries pausedAt (and resumeAt); the client freezes its race-time view while paused: raceOn()
   (client/game.ts:619), the HUD clock, GO!, arm timer and "race closes" (client/main.ts:449-473, client/game.ts:624) and the
   GO cue (client/soundlogic.ts:312-317) must not advance. Gate step() after the ping (client/game.ts:656-661); paused ->
   engineTarget/gravelTarget silent (client/soundlogic.ts:566, :593).
8. The resume 3-2-1 has its own cue latch keyed on resumeAt (CountdownCues latches per raceStart, :308). Resuming during
   the countdown phase restarts the full countdown instead of stacking a 3-2-1.
9. Restart runs the toLobby cleanup first (start() only resets connected players, :361; offline ones keep stale cars,
   :522-528); clear paused state in both paths; the client calls resetOwnCar() when raceStart changes (client/game.ts:449),
   or the teleport breaks the bots' 50-unit bound (scripts/bots.ts:627-633).
10. Ammo on stop/restart: p.ammo is the wallet's own object (:216), so an aborted race would burn bought ammo. Snapshot
   each racer's ammo at start() and restore it on stop/restart (orchestrator default; aborted race = as if never run).
11. Retire model: a `retired` flag excluded at :444 (else the race waits out the 30 s grace, or forever with no finisher,
   :484); endRace rows keyed on progress, not car (:498), so the DNF row and wreck bonus survive; all racers retired with no
   finisher -> back to the lobby with no results (today's :485 behaviour, orchestrator default); buy() refuses outside the
   lobby (:406) -> allow it for a retired, carless player; reset the flag in start/toLobby. The client reuses the "you're in
   the next one" spectator state (client/main.ts:470) plus the garage panel.
12. Esc: chat's handler preventDefaults without stopPropagation (client/chat.ts:69-72), so does the sound popover
   (client/audio.ts:221): the menu's window handler ignores defaultPrevented and isComposing events. Keyboard.clear() is
   one-shot (client/input.ts:20-27): force NO_CONTROLS while the menu is open (client/main.ts:505).
13. Handover: the target must be connected; clear the new host's stale ready (:596); the open menu re-renders on every room
   message.
Adopted suggestions: pause auto-resumes when the pausing host unbinds (a disconnected host keeps hostId for 20 s, :281);
a short re-pause cooldown (5 s); after Stop, "Start anyway" is available at once (exempt from the lobbyAt reset, :187/:521).
Extra tests (advisor): a kicked socket cannot chat; a tokenless rejoin after a kick is allowed (documented); kick during pause
and of an offline player; pause during finish grace and during countdown; grace removal while paused; retire as the last racer
with and without finishers; restart with an offline player; no cue replay on resume; Esc with the chat or the popover open.

## Tickets (three, sequential: all touch server/room.ts, shared/protocol.ts, client/game.ts, client/main.ts)

- MENU-1 "Esc menu + host room controls": the menu shell and everyone items (resume, sound, controls help, copy invite link,
  leave room), host stop / restart / lock / hand over / kick + block (changes 1-3, 9, 10, 12, 13). Taste gate: the user tries
  the menu locally.
- MENU-2 "Retire to garage" (change 11).
- MENU-3 "Pause for everyone" (changes 4-8 + the adopted pause suggestions).
Out of scope: votes, kicking by IP, timed bans, spectator camera, changing laps/track mid-race.
