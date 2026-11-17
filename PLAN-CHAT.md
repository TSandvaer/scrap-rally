# PLAN-CHAT — live room chat

User request 2026-11-17: "a live chat in the game, meaning anyone (host + joined) can communicate inside
the game. When game is closed all chat is lost. While the game is running it should be possible to chat
and scroll to see the entire game conversation."

User choices (popup, 2026-11-17):
- Chat is always open: lobby, garage, results AND during races. Enter to type, Enter to send, Esc to leave
  the box. While typing, your car gets no input (the existing `isTyping` guard in client/input.ts:52).
- Joiners and rejoiners see the whole conversation (server keeps the room's history).
- Game lines: join/leave + race results.

## Design

1. Lifetime. History lives in memory on the `Room` (server/room.ts) as a ring of the last 300 lines.
   When the room is deleted (`Rooms.step`, room.empty) the history is gone with it. Nothing is persisted.
   A new room that later reuses the code starts empty.
2. Protocol (shared/protocol.ts).
   - C->S `{ t: "chat"; text: string }`, accepted in every phase from a bound player of the room.
   - S->C `{ t: "chat"; line: ChatLine }` to everyone in the room (live), and
     S->C `{ t: "chatlog"; lines: ChatLine[] }` to one player on join and on rejoin (bind), before or right
     after the room message, so the client renders the full history once.
   - `ChatLine = { n: number /* room-local seq */; kind: "say" | "join" | "leave" | "result"; from?: string /* player id */; name: string; text: string }`.
     The client de-duplicates by `n` (a rejoin may receive a live line and the log).
3. Server rules (server/room.ts).
   - Text: strip control/format characters (\p{C}) except normal spaces, collapse runs of whitespace, trim;
     empty after cleaning -> ignored; longer than 200 code points -> cut to 200.
   - Rate limit per player: token bucket, 5 messages, refill 1 per second; over the limit -> `err`
     "Slow down" (new ErrCode or plain msg) and the line is dropped.
   - Name is the sender's current name at send time, stored in the line.
   - Game lines: "join" when a player first joins (not on a reconnect of the same player), "leave" when a
     player is removed for good (Leave button or reconnect grace expired), "result" once per race from the
     finish order (e.g. "Race won by X — 2nd Y, 3rd Z", DNFs omitted).
4. Client (new client/chat.ts + small hooks in client/main.ts, client/game.ts message handling, index.html,
   client/style.css).
   - A chat panel in the bottom-left of the stage, present in every phase. Lines render with textContent
     only (never innerHTML). Player lines show the name in that player's car colour; game lines are grey.
   - Closed state (default): the last ~4 lines fade in over the view and fade out after ~8 s; an unread
     count when lines are hidden. Enter (when focus is not in another text field) opens it and focuses the
     input; Enter sends (and keeps the box open in lobby/garage, closes it in a race), Esc closes.
   - Open state: the full history in a scrollable list (wheel, drag, touch). Stays at the bottom unless the
     user scrolled up; then a "new messages" pill jumps back down.
   - Phone width: a small chat button opens/closes it; the open panel must not hide the lobby/garage
     buttons (overlay with a close button is fine).
   - Bots (botplay, bots.ts Game clients) ignore chat messages without errors.
5. Out of scope: persistence, private messages, moderation tools beyond length + rate limit, emojis
   picker, sound, chat from bots, typing indicators.

## Tests

- sim-test: chat accepted in lobby, countdown, race, results; cleaning (control chars, whitespace, empty
  ignored, cut at 200); rate limit (6th in a burst refused, accepted again after refill); non-member and
  unbound sessions refused; history capped at 300 and sent on join and on rejoin (same lines, in order);
  join / leave / result game lines (no "join" on reconnect); a deleted room's code reused starts with an
  empty history.
- bots.ts (sockets): two clients chat both ways during a race; a late joiner receives the full log;
  existing bot checks stay green (bots ignore chat).
- Browser (worker): screenshots of lobby with chat, race with fading lines, open scrolled history, phone
  width; XSS check: a message `<img src=x onerror=alert(1)>` renders as text.
- npm run check clean, npm test green (twice).

## Advisor changes (binding; Fable 5.2 review 2026-11-17: "sound with changes"; these override the text above)

1. Leave. There is no leave message today; Leave only closes the socket and the player is removed after the
   20 s reconnect grace (server/room.ts:213-222). Add C->S `{ t: "leave" }`: the Leave button sends it, the
   server removes the player at once (`remove()`), then the socket closes. The "leave" game line is emitted
   only in `remove()` (so a dropped connection says "left" when the grace expires; a takeover ("taken") or a
   reconnect emits neither join nor leave).
2. ChatLine carries `color` (colours are reassigned after a player is removed, room.ts:149,154), like
   ResultRow. Game lines: `from` absent, `name` = the player the line is about ("" for results).
3. Order instead of dedup: `addPlayer` appends and broadcasts the "join" line BEFORE `bind`; `bind()` sends
   `chatlog` right after `welcome` (room.ts:208), so a joiner sees its own join line exactly once, via the log.
   The client REPLACES its list on `chatlog`, and clears it on a welcome with a different room code and on
   leave. No dedup by `n` (n restarts when a code is reused).
4. Cleaning order: type-check `text` is a string (like cleanName, room.ts:84-87); collapse `\s+` to one space
   FIRST, then strip \p{C} except U+200C/U+200D (ZWNJ/ZWJ: joined emoji and some scripts), then trim, then cut
   to 200 code points.
5. Client cap: the input has maxlength="200" (a frame over 4096 bytes closes the socket, server/index.ts:115).
6. The rate bucket lives on Player (not Session), so a reconnect does not refill it. Over the limit: a plain
   `err` "Slow down" (it already toasts), throttled to about one per second per player. No new ErrCode.
7. Enter handling: the window handler acts only while in a room (the menu inputs own Enter, main.ts:132-133),
   ignores e.repeat and e.isComposing, and preventDefaults when the target is not a text field, including a
   focused button (Ready / Start / Leave would otherwise re-click) and the track <select>.
8. Held keys: isTyping only blocks new keydowns (client/input.ts:20). Add Keyboard.clear() and call it when
   the chat input gains focus; blur the input on send in a race and on Esc. client/input.ts is in scope.
9. Layout: in the lobby/garage the chat docks INSIDE the lobby panel (the centred panel is up to 780 px and a
   bottom-left overlay would cover Start/Leave on windows under ~1250 px, style.css:45-47,328). In races
   the overlay sits bottom-left ABOVE the full-width banner strip (render.ts:851-855) and clear of the debug
   box (render.ts:866); minimap and HUD are clear. Phone: the stage is 100vh with no phone CSS today
   (style.css:28-34,338): use dvh/visualViewport so the on-screen keyboard does not cover the input, input
   font >= 16 px. Clip each line against stacked combining marks.
10. Extra tests: colour kept after the sender is removed; chatlog arrives after welcome with the join line
   exactly once; the bucket survives a rejoin; non-string text refused; a "taken" takeover emits no
   join/leave; no result line when a race ends through toLobby (room.ts:377); the leave message removes at
   once and emits one leave line; client: Enter with a button focused does not re-click it; a key held when
   the chat opens stops driving.

Confirmed fine by the advisor: names are set only at create/join (no rename abuse); cleanName + textContent
cover injection; worst case ~260 KB per bind / ~6 MB across 20 rooms; endRace always has a winner; bots
already ignore unknown messages. Accepted risk: duplicate names allow impersonation (colour is the tell).

## Tickets

One ticket, one worker (protocol + server + client are small and tightly coupled; the advisor accepts one
ticket because changes 1-3 above fix the contract):
CHAT-1 "Live room chat". Ownership: shared/protocol.ts, server/room.ts, client/chat.ts (new),
client/main.ts, client/game.ts (message handling + leave), client/input.ts (clear), index.html, client/style.css,
scripts/sim-test.ts, scripts/bots.ts, PLAN.md (protocol section).
Taste gate: the user tries it locally (two browser windows + botplay) before merge.
