# PLAN-SOUND — music between races, sound effects in races

User request 2026-11-17: "lets look into sounds, music in the lobby but no music while the race is on".
User choices (popup, 2026-11-17):
- Everything is made in code (Web Audio API): an original tracker-style music loop composed for this game
  and synthesized effects. No audio files, nothing copied from existing games.
- Full set of race sounds: own engine hum rising with speed, countdown beeps + GO, rivet shots, mine drop
  and blast, hits, wrecks, bumps, jumps, landings, falls, recovery, lap, finish. Other cars' events are
  quieter with distance.
- Music on every screen outside a race: lobby, garage, results. It fades out when the countdown starts and
  comes back on the results screen. Not on the main menu.

## Design

1. Module boundaries. New client/audio.ts (AudioContext, buses, settings, voices), client/sfx.ts (synth
   recipes), client/music.ts (sequencer + the composed song). Only client/main.ts imports them. client/game.ts
   stays audio-free (bots and scripts import it under Node) and exposes what main.ts needs (events below).
2. Unlocking. Browsers only allow audio after a user gesture: create/resume the AudioContext on the first
   pointerdown/keydown (Create / Join count). Until then nothing plays and nothing errors.
3. Buses and settings. master -> music bus + sfx bus (GainNodes), a light compressor on master. Settings:
   mute (M key when not typing + a speaker button), music volume, effects volume (two sliders in a small
   popover by the speaker button). Saved in localStorage (try/catch; defaults if unavailable): music 0.5,
   effects 0.8, unmuted. Tab hidden -> master fades to 0 (visibilitychange), back when visible.
4. Music state machine driven by the room phase: lobby/results -> music plays (fade in ~1 s); countdown/racing
   -> fade out ~0.8 s then stop the sequencer; leaving the room / menu -> stop. Garage is inside the lobby.
5. Music engine: a lookahead scheduler (setTimeout ~25 ms, schedule ~100 ms ahead on the AudioContext clock),
   tracker-style patterns: bass (square/saw), lead/arpeggio (pulse), pads optional, drums from noise +
   pitched sine kick. About 110-128 BPM, an A/B structure of 16-32 bars so the loop does not grate; restarts
   from the top each time the lobby music starts. Original composition in code (note tables), scrapyard /
   garage rock-chiptune mood.
6. Effects. Recipes are short synth graphs (oscillators, noise buffer, filters, envelopes), built from a
   pre-made noise buffer; no per-frame allocation. Voice limit (~16 concurrent) with oldest-quietest stealing,
   and a per-kind rate limit (e.g. at most one rivet sound per 40 ms in total) so many cars firing do not
   clip. Other cars: gain by distance from the own car (full within ~150 units, silent beyond ~900), light
   stereo pan by screen x.
   - Engine: one persistent voice for the own car only during countdown/racing (pitch from speed, gain from
     throttle; silent while wrecked, falling or spectating); stopped outside races.
   - Countdown: three short beeps at 3-2-1 and a higher GO, timed from raceStart on the estimated server
     clock (the same clock the countdown text uses).
   - Rivet fired (own predicted shot when it leaves the gun; others when their shot first appears in a
     snapshot), mine dropped, mine blast + hit / wreck from server "ev" events (hit, wreck), bump from the own
     predicted contact feedback (the same hook as the sparks/shake: step() only, never replays), take-off /
     landing / fall / recover from the own car's stepRaceCar events in step() (not replays) and from
     snapshot air/fall transitions for other cars, lap and finish from server events (own car louder).
7. Debug sound board (?debug=1&sounds=1): a panel with a button per effect and a music play/stop, plus the
   volume settings, so the user can judge every sound quickly. Costs nothing without the flag (dynamic import).

## Tests

- sim-test (pure logic, no AudioContext): phase -> music on/off transitions incl. results and leave;
  distance gain curve; per-kind rate limit; voice stealing order; sequencer step timing math (notes land on
  the beat grid for a given BPM, lookahead never schedules in the past); countdown beep times from raceStart.
- Node safety: scripts/bots.ts and botplay still run (client/game.ts imports no audio).
- Browser (worker): with an OfflineAudioContext render each effect recipe and ~4 bars of music: non-silent,
  no clipping beyond the compressor, durations as designed; in a live race, no audio errors in the console,
  music stops at countdown and resumes on results; settings persist across reload; mute works.
- npm run check clean, npm test green (twice), npm run build ok (bundle size growth noted).

## Taste gate

The user listens on the sound board and plays a race locally before merge (music, every effect, engine).

## Advisor changes (binding; Fable 5.2 review 2026-11-17: "sound with changes"; these override the text above)

1. Menu: game.phase is "lobby" outside a room (client/game.ts:161, reset :278): music only when in a room
   (game.you set) AND phase lobby/results.
2. Snapshots also change the phase without on.room (client/game.ts:495): drive music and engine from the
   frame loop (client/main.ts:475), polling the phase each frame.
3. reconcile() can revert a predicted take-off/fall a tick off (client/game.ts:563-572) and the next step()
   emits it again (:652): ~400 ms refractory per kind for own take-off, land, fall, recover.
4. No landing event exists (RaceStepEvent = takeoff | fall | recover, shared/weapons.ts:101): derive landing in
   step() from prevCar.air > 0 && car.air === 0 && car.fall === 0 (client/game.ts:650-652).
5. Own shots and mines: queue them from `fired` / `mine` in step() (client/game.ts:663-668) and drain them like
   takeImpacts(); snapshot-based detection skips the own car (as otherShots() does, :790).
6. Other cars' shots, mines and air/fall: diff the interpolation-time snapshot (bracket().a, client/game.ts:728),
   not `latest`, against a seen-id set; seed SILENTLY on the first snapshot, after a welcome and after a gap
   > ~250 ms (mines live 25 s, shared/weapons.ts:57, and snaps survive a rejoin, client/game.ts:395).
7. Server events: other cars' hit/wreck sounds delayed by INTERP_DELAY_MS like the sparks (client/main.ts:213);
   a fatal hit sends hit then wreck (server/combat.ts:158-162): the wreck suppresses that hit; a mine blast is
   `hit` with w "mine" (no separate event).
8. Bump: takeImpacts() clears its queue (client/contact.ts:199): the sound goes in the existing loop at
   client/main.ts:563.
9. Countdown: latch per raceStart with a monotonic beep index (the offset estimate jumps, client/game.ts:492);
   require hasClock() (:700); on first sight mid-countdown (rejoin, a frame late > 250 ms) set the index without
   playing; use phaseEnds like the HUD (client/main.ts:431).
10. Engine: throttle from the Controls already read at client/main.ts:481 (a second keyboard.read() eats the
   mine latch, client/input.ts:43-45); silent when !game.car, !game.connected (step returns early,
   client/game.ts:630), wrecked, falling, phase results, or finished.
11. Hidden tab: ev messages keep arriving while rAF stops: drop every trigger when document.hidden or
   ctx.state !== "running"; suspend the context when hidden and restart the sequencer from "now" on return.
12. Keys and focus: M is free (mines are X/K, client/input.ts:11): match e.code === "KeyM", ignore repeat and
   modifiers, skip text fields. Range sliders are inputs and block driving (client/input.ts:20, :59): blur the
   sliders and the speaker button after use and close the popover at countdown.
13. Node/tests: the pure logic (state machines, rate limits, curves, sequencer math, trigger decisions) lives in
   a module with no top-level AudioContext / window / localStorage, imported by sim-test.
Tests added: an audio trigger log exposed on scrapDebug (client/main.ts:92), asserted in the browser: under
?lag=150&jitter=40 exactly 4 countdown cues per race, own shot sounds == fired count, no duplicate take-off within
the refractory; no music on the menu; a rejoin with mines on the track plays 0 drop sounds; no triggers while hidden.
Optional (adopted): unlock on pointerup/click/keydown until ctx.state === "running", and re-evaluate the music on
unlock (a reload-rejoin has no gesture); handle the iOS "interrupted" state; per-kind caps instead of voice
stealing; disconnect nodes on `ended`; engine via setTargetAtTime. Laps: the final lap only emits `finish`.

## Tickets (two, sequential: both touch client/main.ts)

- SND-1 "Audio core, settings and lobby music": client/audio.ts, client/music.ts, client/soundlogic.ts (pure,
  tested), client/soundboard.ts (debug, dynamic import), the speaker button + popover + M key, unlock, hidden-tab
  handling, the phase-driven music (changes 1, 2, 11, 12, 13), sim-test for the pure parts, PLAN.md Sound section.
  Taste gate: the user listens to the music (sound board + lobby) before merge.
- SND-2 "Race sound effects": client/sfx.ts, client/game.ts hooks (changes 3-6, 10), client/main.ts wiring
  (7-9), the engine, countdown, the trigger log + its browser checks. Taste gate: the user plays a race locally.
Out of scope: chat sounds, voice lines, per-track music, music during races, audio files.

## Addendum 2026-11-17 (user taste feedback during SND-2)

- Engine: a petrol engine with three presets (4-cyl, V8, buggy); buggy is the default, the others selectable on the
  sound board.
- Rivet = machine-gun round (crack + thump, per-shot variation); mine hit/blast = explosion (boom, crack, rumble tail).
- Surface sound for the own car, as a persistent per-frame voice from the predicted pose: a gravel crunch while off
  the asphalt (q.dist > halfWidth, as the physics' off-road test). (A kerb rumble was asked for, then dropped by the
  user the same day.)
- Crash: car-car contacts and own-car wall hits sound like bending metal, scaled by impact speed; wall impacts derived
  in step() (never in replays) from the velocity into the wall, with a threshold and a ~200 ms refractory.

## SND-4 — host-set room sound defaults (2026-11-18; Fable review "sound with changes", folded in)

User: "the host should be able to set music on/off + volume of music/effects that will be the base for the players sound until
they make their own change". User choices (popup): per setting and remembered (a setting a player moved is theirs in every
room; untouched settings follow the host); live follow when the host changes them; a "Use host's sound" reset button. The
master Mute (M) stays personal.

1. Room state: soundDefaults {musicOn, music 0..1, effects 0..1} on the Room, initial = built-in defaults (music 0.5 on,
   effects 0.8), carried in the room message, kept on host handover, gone with the room. Host-only C->S {t:"soundDefaults",
   musicOn?, music?, effects?} in any phase, following setLocked (server/room.ts:516-523): host check, err on a wrong type (no
   silent clamp), volumes snapped to 0.05, no broadcast when unchanged, a per-room Bucket (~2 changes/s, like chat's,
   room.ts:327). Built-in defaults + clampVolume move to a new shared/sound.ts (the server imports nothing from client/).
2. One source of truth: engine.settings stays the EFFECTIVE values (its readers unchanged: audio.ts:43-47, 276-281;
   menu.ts:315-317; soundboard.ts:220); the engine gains `own` (only keys the player moved) and `room` (or null outside a room),
   combined by one pure effectiveSound(own, room) in soundlogic. Writes mark only the moved keys: toggleMute (audio.ts:122) and
   the engine preset (soundboard.ts:523) never mark music/effects as own; the save writes only own keys + muted + engine.
3. Migration: a legacy saved value counts as own only if it differs from the built-in default (today every save writes every
   key, audio.ts:72-74, 114-116). An SND-3 entry with music 0 becomes own musicOn:false, volume from musicBack if > 0; then
   musicBack is dropped. SND-3's on/off becomes a real musicOn flag; moving a Music slider above 0 while off also sets own
   musicOn:true (keeps SND-3's rule).
4. UI: the host's personal controls are the same as everyone's (a host with untouched settings hears the room defaults); a
   "Room sound (for everyone)" block (music on/off, music volume, effects volume) sits in the Esc menu's Sound view for the host
   only, rendered from the room message, client-throttled with a trailing send. Every player's own controls show the effective
   values, mark settings that follow the host ("host's"), and show "Use host's sound" when they have own changes (resets
   musicOn/music/effects, keeps muted and engine; hidden/relabelled outside a room). The Sound view updates in place on room
   messages (menu.ts:148 skips rebuilding it today), incl. on handover while open; Esc-menu sliders blur on change
   (menu.ts:299, 316) so live host changes show.
5. Outside a room: soundFrame (main.ts:604) feeds `game.you ? game.soundDefaults : null` into the engine; game.leave()
   (game.ts:352-356) resets it.
Tests: the migration matrix (M-only entry, default-equal values, SND-3 off with musicBack); an own value equal to the host's
stays pinned when the host changes; mute and engine preset do not mark music/effects as own; reset keeps muted and engine;
partial patch, NaN and string values; host-only, rate limit, unchanged = no broadcast; handover with the Sound view open; a second
room with different defaults; rejoin; rewrite (not delete) sim-test sound() (scripts/sim-test.ts:3084) and SND-3's musicSwitch.
Bots: a default change reaches clients. Browser (muted): a guest follows untouched settings live, keeps own ones, reset works.
Ticket: one medium ticket SND-4, after SND-3 and MENU-3 merge (MENU-3 also changes the room message, server/room.ts, client/menu.ts).

## SND-5 — more songs, and the host picks the lobby song (2026-11-18)

User: "generate some more retro game music, 2 or 3 more melodies the host can choose from. (1 should be in the 80 disco
genre)". Popup: 3 new songs; styles synthwave chase, surf-rock chiptune, funky garage groove (all three picked) plus the
required 80s disco -> FOUR new original songs (the orchestrator chose four because three styles were picked on top of disco;
the user may trim). Host picks, everyone hears it (players can still turn music down/off).
- SND-5 (content, now): client/music.ts gets a SONGS registry (id, title, bpm, structure, per-song instrument settings) with
  "Rust Bucket Shuffle" (id rust-bucket, the default, unchanged) plus four new songs, each ~50-70 s per loop with an A/B
  structure, composed in code as note tables, original (nothing transcribed from existing songs or games):
  1. 80s disco: four-on-the-floor kick, offbeat open hats, octave-jumping bass, string-like stabs, ~118-124 BPM.
  2. Synthwave chase: driving pulsing bass arpeggios, bright saw lead, gated snare, ~110-128 BPM.
  3. Surf-rock chiptune: fast twangy lead (vibrato/slide), galloping beat, ~150-170 BPM.
  4. Funky garage groove: slap-style chip bass, wah-ish lead stabs, swing, ~95-110 BPM.
  MusicPlayer gains setSong(id) (takes effect at the next start; if playing, a short crossfade or restart from the top) and
  exposes the song list; the sound board gets a song picker + per-song WAV render. Levels balanced against Rust Bucket.
  client/main.ts is not touched (SND-4 wires the room choice).
- SND-4 gains the host's song choice: room soundDefaults.song (a song id or "random"), host-only via the same command; the
  host picks it with a "Music" dropdown next to the Track selector in the lobby (everyone sees the song name); "random" is
  resolved by the server to a concrete song id each time the lobby opens, so everyone hears the same song.

- 2026-11-18 user decisions on SND-5: keep only Mirrorball Pit Stop (80s disco) and Neon Tailpipe (synthwave); Gravel Surf and
  Grease Monkey Strut dropped. Neon Tailpipe is the DEFAULT song (SND-4's built-in room default song = neon tailpipe).
