# PLAN-TOUCH: on-screen touch controls for phones — APPROVED 2026-11-21 (with the advisor changes and the user decisions below)

**Why.** User 2026-11-21, on the live site from a phone: "How do i drive on my phone? There is no controls". Today the
game is keyboard only (`client/input.ts`: arrows/WASD, Space/Z/J fire, X/K mine; its header says "Touch and gamepad come
later"; PLAN.md "Later": touch / gamepad controls). The lobby, garage and HUD already fit 390 px and 360 px wide.
User choices (popups 2026-11-21): **on-screen buttons** (not a joystick or tilt), built **now**, in parallel with M4-WORLD.

## Design

1. **Same controls as the keyboard.** A `TouchPad` in `client/input.ts` produces the existing `Controls`
   (`throttle` -1/0/1, `steer` -1/0/1, `fire` held, `mine` latched until read, as the keyboard does). `main.ts` merges
   keyboard and touch per step: throttle and steer = clamp(sum), fire = OR, mine = OR. Digital on purpose: a phone player
   steers exactly like a keyboard player (fair, and prediction/replay need nothing new).
2. **Buttons** (DOM, over the canvas, in the GFX-3 key-cap skin, semi-transparent):
   - Left thumb: **◀ steer left** and **steer right ▶**, side by side; sliding a finger from one to the other switches.
   - Right thumb: **GAS** (largest), **BRAKE/REVERSE**, **FIRE** (hold), **MINE** (tap). Weapon buttons show the ammo count
     (rivets / mines) so you know when they are empty.
   - Sizes: at least 56 CSS px per button (thumb), 8 px apart; bottom corners; `env(safe-area-inset-*)` respected; they never
     cover the HUD panels, the minimap, the ☰ menu button or the chat/audio overlays.
3. **When shown.** Only on touch devices (`(pointer: coarse)` or the first `touchstart`), only while the car can drive
   (countdown, race; hidden in the lobby, garage, results, Esc menu, while chatting and for a spectator). Desktop unchanged.
4. **Multi-touch done right.** Pointer Events with `setPointerCapture`; each button tracks its own set of pointer ids;
   a finger that slides is re-hit-tested on `pointermove` (steer switch); everything is released on `pointerup`,
   `pointercancel`, `lostpointercapture`, window `blur` and `visibilitychange` (no stuck gas). The pad's state machine is a
   pure reducer (pointer events in, held buttons out) so it can be unit-tested in Node.
5. **No browser fights.** `touch-action: none` on the buttons and the game stage (no scroll, pinch-zoom or double-tap zoom
   during a race), `user-select: none`, no long-press callout/context menu, no 300 ms tap delay. The chat input and the
   lobby keep normal touch behaviour.
6. **Orientation.** Works in portrait and landscape; layout adapts by media query (landscape: the two clusters at the
   sides; portrait: along the bottom edge under the play view). No forced rotation.
7. **Cost.** No per-frame DOM writes: classes change only on press/release; ammo counts update only when they change.
   Nothing touches the renderer (PLAN-GFX rule 1 unaffected).

## Open question for the user (with the approval)

- **Gas: hold the GAS button, or auto-gas?** Recommended: hold GAS (same as the keyboard; braking = let go or BRAKE).
  Alternative: an "Auto-gas" switch in the Esc menu for touch players (the car accelerates unless BRAKE is held), which
  frees the right thumb for weapons.

## Ticket TOUCH-1 (Opus)

Owns `client/input.ts` (TouchPad), `client/main.ts` (merge + show/hide per phase + ammo counts), `index.html` (button
markup), `client/style.css` (touch control rules only), an appended `scripts/sim-test.ts` section (the reducer:
multi-touch sequences, slide between steer buttons, cancel/blur release, mine latch, merge with the keyboard), and
`tools/debug/touch-drive.ts` (drives a race in headless Chrome with CDP touch emulation, multi-touch).
Not `client/gfx/*`, `render.ts`, `preview.ts`, `shared/*`, `server/*`.
- Accept:
  - The reducer tests above pass; keyboard input is unchanged (existing tests identical).
  - Headless Chrome with touch emulation at 390x844 portrait and 844x390 landscape: a full race driven by touch only
    (gas + steer + fire + mine), with two fingers down at once; screenshots of both orientations and of 360 px.
  - Buttons hidden on desktop (no coarse pointer) and in every non-driving phase; no scroll/zoom during a race.
  - `npm run check`, `npm test`, `npm run build`.
- Taste gate: the user drives on a real phone. The phone cannot reach the Mac over the local Wi-Fi (2026-11-21), so this
  gate runs on the live site after review, merge and a push the user approves (desktop is unaffected by the change).

## Advisor changes (binding; Fable 5.2 review 2026-11-21: "sound with changes"; override the text above)

1. **Read and clear touch wherever the keyboard is.** Read the pad every step at `client/main.ts:863` (so the menu-open path
   `:864` drains the mine latch as for keys); `pad.clear()` at `main.ts:108` (chat focus), `main.ts:260` (menu open) and on
   every hide (a hidden button's pointerup/lostpointercapture is not guaranteed). `client/game.ts:954,967,972-978` already ignore
   input while paused, unarmed or in the countdown.
2. **Show rule per frame, not in `updatePanels`:** countdown/racing AND own car present AND not finished (`fin`) AND
   `!garageOpen()` AND `!menu.isOpen` AND `!chat.open` (finish arrives by event `main.ts:343`; a retired player's garage opens
   while the phase is still racing `main.ts:378`). Cache the boolean; write a class only on change (as the phase poll `main.ts:902`).
3. **Placement must avoid, at 390x844 portrait and 844x390 landscape:** the chat overlay and its 44 px open button
   (`style.css:1141-1147,1161`; landscape bottom-left of the view `style.css:1073-1076`), the speaker and ☰ (top 10-84 px of the
   right bar, `audio.ts:462-473`, `style.css:1176-1189`), the ping label (view bottom-right, `gfx/hud.ts:692`), the HUD panels and
   the minimap. Portrait: top-align the view (advisor suggestion, adopted) and put the pad in the space below it. Landscape: the
   right cluster as a single column under the speaker/☰ (4 x 56 + 3 x 8 = 248 px); the steer pair at the bottom-left. While the
   pad is shown, the chat open button moves out of the pad's way (the worker proposes the spot and shows it in screenshots);
   opening chat hides the pad (rule 2).
4. **`touch-action: none` only on `#view` and the pad**, never `#stage` (it holds the lobby and chat, whose scrolling must keep
   working, `index.html:10,34,115`, `style.css:86,949`); plus `-webkit-touch-callout: none`, `-webkit-user-select: none` and a
   `contextmenu` preventDefault on the pad.
5. **Safe areas:** do not add `viewport-fit=cover` (so `env(safe-area-inset-*)` stays 0); drop the safe-area line in design 2.
6. **Hit-testing:** one listener per cluster with hit tests against cached rects (pure; no layout reads on move; rects refreshed
   on resize/orientation change). Show on `pointerdown` with `pointerType === "touch"` (not `touchstart`) or `(pointer: coarse)`;
   drive the CSS from a class (existing rules are media-only, `style.css:861,1156,1427`). A driving keydown hides the pad again
   (hybrid laptops, iPad with a keyboard; advisor suggestion, adopted).
7. **Touch wording:** the pause banner ("Esc, then Resume race", `main.ts:756`) and the key help (`index.html:27-31`) get touch
   wording when the pad is in use.
8. **Ownership:** add `client/menu.ts` (the gas-mode switch); `tools/debug/README.md` append-only (M4-WORLD also edits it).
9. **Acceptance:** the repo has no CDP client (`package.json:24-30`); tools use the agent-browser CLI (`tools/debug/fx-sheet.ts:307`),
   whose multi-touch support must be verified first (if it cannot do two fingers, the reducer tests carry multi-touch and the
   browser check drives one finger at a time). The tool asserts `matchMedia("(pointer: coarse)")` under emulation. "A full race"
   becomes "a lap plus input assertions". Ammo counts come from `game.predictedAmmo()` (`main.ts:681`). Buttons get `aria-label`s.
10. **Gas mode:** advisor recommends **auto-gas as the touch default** (throttle 1 unless BRAKE is held; still digital; off whenever
    the pad is hidden), with hold-GAS as a switch in the Esc menu, because with hold-GAS the right thumb cannot hold GAS and FIRE
    together, which keyboard players can. User decides.
11. **Real-phone gate checks what emulation cannot:** thumb reach and occlusion, iOS edge-swipe back from the steer side,
    double-tap zoom and the long-press callout, URL-bar / dvh changes, rotation mid-race, the chat keyboard round trip, audio,
    and frame rate.

## User decisions (2026-11-21, popups; these override design 2 and advisor change 10)

- **Approved** with the advisor changes.
- **Layout like a keyboard** (user: "You have two thumbs, just place up/brake on the right and mines/shot on the left"):
  - **Right thumb: an 8-way pad** like the arrow keys: up = gas, down = brake/reverse, left/right = steer, and the four
    corners = gas or brake plus steer at once. One finger slides between all nine zones (centre = nothing). Digital output, the
    same `Controls` as the keyboard.
  - **Left thumb: FIRE (hold) and MINE (tap)**, each showing its ammo.
  - **No auto-gas and no gas-mode switch** (so `client/menu.ts` is not needed unless the touch wording lives there).
  - **No heal button** (the Welding rig keeps repairing on its own).
- Placement per advisor change 3, with the clusters swapped: in landscape the 8-way pad is the right-side cluster under the
  speaker/☰ (about 3 x 56 + 2 x 8 = 184 px square), the weapons at the bottom-left; in portrait both sit in the space below the
  top-aligned view.
- Push: the merged lobby fix (3c2c9e6) goes live together with touch controls, in one push the user approves.

## Addendum 2026-11-21 (after the phone test): TOUCH-2, a floating thumbstick replaces the 8-way pad — APPROVED by the user 2026-11-21

**Why.** User, after driving TOUCH-1 on a real phone (live c655bd8): "the controls on the phone is bad ... how can you hold down
speed and turn at the same time. Intuitively it should be like the knob on a controller push up and to the sides or down and to
the sides. the arrows on the right is not a good solution". User choices (popups): the stick **floats under the thumb**;
**any push up = full gas**.

**Design.**
1. **Right half of the screen = stick zone.** A touch that lands there sets the stick's centre at that point for the life of the
   touch; the knob follows the thumb, clamped to radius R. Lifting the thumb hides the stick (centre fades, no output).
2. **Output** (same `Controls`, no protocol change: `server/room.ts:955-961` already accepts and clamps fractional
   throttle/steer to -1..1, and `shared/physics.ts:57-60` documents both as -1..1):
   - steer = proportional to the sideways offset (dead zone, then linear or a mild curve up to 1 at a set share of R);
   - throttle = +1 when the knob is above the centre beyond a dead zone, -1 when below, 0 inside it (user: "any push up = full
     gas"); diagonals give gas or brake plus proportional steer.
   - Values quantized (e.g. steps of 1/64) so prediction and the server see identical numbers and messages stay short.
3. **Left side unchanged:** FIRE (hold) and MINE (tap) with ammo; the Chat-button move and all TOUCH-1 show/clear rules stay.
4. **Tuning panel (the sponsor's knob, so a third round is not guessed):** on touch devices with `?debug=1`, a small panel
   (opened from the Esc menu or a debug corner) with sliders for R, the steer dead zone, the steer curve/full-lock share, the
   throttle dead zone, and the stick zone's split line; live effect while driving; values kept in localStorage and shown as text
   to copy back; defaults ship from the user's chosen values.
5. Keyboard players unchanged; bots unchanged.

**Ticket TOUCH-2 (Opus)** owns `client/input.ts`, `client/main.ts`, `index.html`, `client/style.css`, `client/menu.ts` (only if
the tuning panel opens from it), an appended sim-test section (stick reducer: centre on touch-down, clamp, dead zones, steer
curve, throttle sign, quantization, release, merge with keys) and `tools/debug/touch-drive.ts` (update). Accept: the reducer
tests; touch-drive drives a lap with the stick (gas + steer at once, diagonals, brake/reverse) at 390x844 and 844x390 with the
pad gone; the tuning panel changes the feel live and persists; keyboard tests identical; check/test/build. Taste gate: the user on
the phone, live, using the tuning panel; then the chosen values become the defaults.

### TOUCH-2 advisor changes (binding; Fable 5.2 review 2026-11-21: "sound with changes"; override the addendum above)

1. **No own quantization:** `client/game.ts:974-975` already rounds throttle and steer to 2 decimals before predicting, stores that
   cmd in `pending` (`:1021`) and sends it (`:1028`); the server only clamps (`server/room.ts:960-961`). Quantize the stick to 0.01
   or not at all; a sim-test shows stick output survives `round(v, 2)` and a JSON round-trip unchanged.
2. **No physics/server change:** throttle is used by sign and as a multiplier (`shared/physics.ts:103-106`), steer linearly
   (`:119`), the engine sound uses `Math.abs` (`client/soundlogic.ts:815`), skid marks come from motion (`gfx/actors.ts:569`), bots
   already send fractional values (`shared/botdrive.ts:642,653`). The worker checks the reconcile replay and `client/contact.ts`.
3. **Fairness:** steer is capped at 1 (the keyboard's value); dead zone and curve live client-side in `client/input.ts`; full lock
   is reachable well inside R.
4. **The stick zone is an element:** a child of `.touch-ctl` (z-index under the speaker and ☰, `style.css:1472-1477`) to the right of
   the split line, from below `--touch-top` (`style.css:1468`) to the bottom, INCLUDING the view in both orientations; it carries
   `touch-action: none` and the callout rules (`style.css:1479-1489`). Redo the portrait chat offset (`style.css:1634-1638`, uses
   `--pad`, which goes away) and show the Chat button stays tappable; check the ping label.
5. **Reducer:** keep `PadEvent`, `release`/`clear`, the mine latch, `readPad`, `mergeControls`, `show()`, `setTouch`, `padWanted`
   (`main.ts:931-935`); replace `pad: {id, zone}[]` by one stick `{id, cx, cy, x, y}` (the first finger in the zone owns it, later
   ones are ignored); remove `padZone`, `zoneControls`, `caps` and the lit bits 0-8 (`input.ts:108-118,217,301-309`); `clear()` also
   hides the knob; the knob moves by `transform` only, written on pointermove (amends design rule 7).
6. **Tuning panel lazy-loaded** like `main.ts:1043-1049`, gated on `debug` (`main.ts:29`); only the parameter object and its
   defaults live in `input.ts`; localStorage wrapped in try/catch as `client/audio.ts:87-95`; stored values apply only under ?debug=1.
7. **Tests:** rewrite the zone parts of `tools/debug/touch-drive.ts` (`:244-246,299-308,401,420`) and the sim-test section at
   `scripts/sim-test.ts:10027`; assert a fractional steer together with throttle 1 from one finger.
Adopted suggestions: a touch landing within R of a screen edge shifts the centre inward so full lock stays reachable; the knob shows
the throttle state (gas / brake / neutral colour) since the thumb hides the car. Later: left-handed swap. No haptics (absent on iOS).

## Addendum 2026-11-22 (after the TOUCH-4 phone test): TOUCH-5, point to steer — PENDING (Fable review, then the user's approval)

**Why.** User 2026-11-22, live b1a62a7 (stick v2: lock 0.9, curve 3): "It's still to hard on the phone I constantly oversteer".
Two rounds of numbers (TOUCH-3 radius, TOUCH-4 lock/curve) did not fix it. Cause in the code: the stick's sideways offset is a
turn RATE (`shared/physics.ts:144-145`: `c.h += steer * turn * turnScale * DT`, turn 3.1-3.45 rad/s, about 180°/s at full lock),
and the camera never rotates (`client/render.ts` only translates). Any off-centre thumb keeps the car rotating, and with the car
heading down the screen, stick-right turns it to the screen's left. User choice (popup): **point to steer**, with an A/B switch
in the `?debug=1` panel.

**Design.**
1. **Point mode.** The stick's direction on screen is the direction the car should face (camera north-up, so screen axes = world
   axes; the worker verifies the mapping incl. ZOOM and y-down against `Math.cos/sin(c.h)` in `shared/physics.ts:110`). Past a dead
   zone (`pointDead` x R) the stick gives a target angle θ = atan2(dy, dx); inside it: steer 0 and throttle 0 (coast).
2. **Steer = a heading hold:** `err = wrapAngle(θ - h)` with h the own predicted car's heading before the step (`game.car`, read at
   `client/main.ts:883` where the controls are sampled once per 60 Hz step); `steer = clamp(err / aimFull, -1, 1)`, aimFull = the
   error at which steer saturates (default ~35°); hundredths as today. As the car comes round, steer falls to 0, so it settles
   without the overshoot of a held rate (per tick the error shrinks by turn·turnScale·DT/aimFull ≈ 0.1 of itself: no discrete
   overshoot).
3. **Throttle:** pushed past the dead zone = gas 1. If |err| > `brakeAngle` (default ~110°) and the forward speed vf > a brake
   speed (~150 u/s): brake (-1) so the car slows into the tight turn. If |err| > brakeAngle and the car is nearly stopped (nose in a
   wall): reverse (-1) with the steer sign flipped (turnScale is negative in reverse) so the nose still swings toward θ. Thumb up =
   coast, as today. At rest `turnScale = vf/140` gives no turning, so from rest point mode gives gas in any direction.
4. **A/B.** `StickParams` gains `mode` ("point" | "rate"), `pointDead`, `aimFull`, `brakeAngle`. Default mode = **point** for every
   touch player (rate is the known-bad one); the TUNE panel gets a Mode switch and sliders for the new values; values saved before
   keep working (missing keys = defaults; stored values apply only under ?debug=1, TOUCH-2 advisor change 6). Rate mode stays
   exactly as TOUCH-4 (its tests stay).
5. **Stick centre near an edge:** in point mode every direction must reach past the dead zone, so the centre keeps
   pointDead·R + EDGE_PX from each edge.
6. **Knob:** drawn as today; its gas/brake/neutral colour follows the point-mode throttle.
7. **Unchanged:** keyboard, bots, server, protocol, netcode (the steer is computed once per step on the client, stored in the cmd,
   sent and replayed as stored like any steer value), FIRE/MINE, the show/hide rules.

**Ticket TOUCH-5 (Opus)** owns `client/input.ts`, `client/touchtune.ts`, `client/main.ts` (only to hand the pad the own predicted
car's heading and forward speed at the step), an appended sim-test section and `tools/debug/touch-drive.ts`. NOT `client/game.ts`,
`shared/*`, `server/*` (M4-SURF-2 runs in parallel there). Accept: pure-function tests (aligned -> 0, saturates at aimFull,
symmetric, wraps at ±π, dead-zone coast, brake and reverse rules); a closed-loop sim per car type (targets 90° and 170° off: the
heading settles within a stated number of ticks with overshoot < 5°; a scripted pointer that follows the track direction drives a
lap of Rust Bowl with wall hits under a stated bound); touch-drive drives in point mode at 390x844 and 844x390; rate mode
unchanged (TOUCH-4 tests pass); the panel switch and persistence; check, test twice, build. Taste gate: the user on the phone,
live (push + Manual Deploy), A/B with the panel switch; the chosen values become the defaults; then the user decides whether rate
mode stays as an option.

### TOUCH-5 advisor changes (binding; Fable 5.2 review 2026-11-22: "sound with changes"; override the addendum above)

Confirmed: the heading loop is first-order (`shared/physics.ts:144-145`; worst per-tick gain ~0.105 at aimFull 35° for the Racer
with tyres 3, `shared/shop.ts:67`; water halves it, `WATER_TURN = 0.5`); wreck/fall/air ignore input (`shared/weapons.ts:199-215,
237-248`) and the countdown zeroes the cmd (`client/game.ts:975-981`); the camera never rotates (`client/render.ts:276,282`,
`client/gfx/actors.ts:367-368`), so θ = atan2(dy, dx) needs no flip; `game.car` at `client/main.ts:883` is what the step predicts
from and replay uses the stored `p.cmd` (`client/game.ts:861`).
1. **Read `game.car` fresh every catch-up iteration** (reconcile replaces the object, `game.ts:867`); `car === null` -> throttle 0,
   steer 0.
2. **Throttle = one total function of (err, signed vf)** with signed thresholds: when |err| > brakeAngle -> brake above brakeSpeed,
   reverse at vf <= a small positive speed (incl. all negative vf), gas in between; angle hysteresis on leaving reverse (no
   reverse/gas chatter: gas at vf < 0 brakes at `BRAKE = 900`, `physics.ts:64,130`).
3. **Stuck rule (nose in a wall):** head-on with the thumb along the track gives err ~90° < brakeAngle, gas forever at vf ~0. Reverse
   after gas has been commanded with |vf| under a small speed for N ticks and |err| > ~aimFull; the counter lives in `TouchPad`.
4. **Flip the steer sign by vf with a margin** (vf < -~20 u/s; keep flipping while still rolling backward under gas), not by
   "reverse commanded" (`turnScale` uses the post-throttle vf, `physics.ts:130-144`; `WALL_BOUNCE = 0.35`).
5. **Knob colour and panel readout refresh per step:** `read()` takes and stores `{h, vf}` and calls the change-only `setGas`
   (today `drawKnob` runs only on pointer move, `client/input.ts:425`; `peek()` has no car, `:366-368`).
6. **`client/touchtune.ts` handles the non-numeric `mode`** separately in load, save and the copy text (`:11-19,50-53,74,78` assume
   numbers); the aimFull slider minimum >= 10° (below ~3.7° it chatters).
7. **Existing tests are edited, not "unchanged":** `scripts/sim-test.ts:10463` (the six-key defaults literal),
   `tools/debug/touch-drive.ts:643,789` (`L.ranges === 6`) and `:830`; the rate-only `expected()` (`:356`) and `steerOffset`
   (`:395-399`) scenarios store `mode: "rate"` under ?debug=1.
8. **The sim-test section goes after `scripts/sim-test.ts:10467`** (end of the touch section), not at the file's end (M4-SURF-2 adds
   768 lines there).
9. **Lap test pointer = look-ahead aim** at a centre-line point ahead of the car (a tangent pointer runs wide), with a human-like lag
   (~150 ms, 10 Hz updates); 90°/170° tests from rest, 140 u/s and top speed; a head-on-wall escape test and a water case.
Ownership confirmed: no `client/game.ts`, `shared/*` or `server/*` (`car` is public; h, vx, vy suffice, vf computed in `main.ts`).
The Mode switch reuses the `btn small` classes (or `client/style.css` joins the ticket). Optional, adopted: the revert to rate is a
one-line default change; in touch-drive record `g.car.h` in the `g.step` wrapper (`:363-378`). After the phone test, ask the user
whether point mode needs a straight-line brake (today only pointing behind brakes, and it also turns).
