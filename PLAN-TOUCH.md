# PLAN-TOUCH: on-screen touch controls for phones — PROPOSED (advisor review, then user approval)

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
