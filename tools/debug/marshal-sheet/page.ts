// The page of tools/debug/marshal-sheet.ts --shots: one moment of the scripted race (scene.ts)
// at a track's line, drawn by the game's own Renderer on the game's canvas, laid out as the game
// lays it out. Nothing on it is drawn by this page.
//
// ?track=rust-bowl      the track (a shipped one or a test track)
// &theme=desert         another theme on the same road (gfx/theme.ts themedTrack: looks only)
// &t=5420               the moment, ms into the script (played from its start, so the marshals
//                       have seen every change before it at its own time)
// &hud=0                no HUD
//
// Then the pixel proof, into window.marshalShot: the frame is drawn with the marshals switched
// off (twice: the control), then with them on. Every pixel that differs between off and on must
// be one the marshals' own sprites cover (the sheet's pixels of the cells they drew, read back
// from the sheet). The frame with them on stays on the canvas for the screenshot.

import { marshalSwitch } from "../../../client/gfx/marshals";
import { MARSHAL_H, MARSHAL_W } from "../../../client/gfx/sprites";
import { isTheme, themedTrack } from "../../../client/gfx/theme";
import { ZOOM } from "../../../client/gfx/world";
import { Renderer, VIEW_H, VIEW_W, type RaceView, type WorldFx } from "../../../client/render";
import { testTrack } from "../../../shared/testtracks";
import { pointAt } from "../../../shared/track";
import { trackById } from "../../../shared/tracks";
import { CAMERA, carsAt, hudAt, makeCars, raceAt } from "./scene";

const params = new URLSearchParams(location.search);
const id = params.get("track") ?? "rust-bowl";
const theme = params.get("theme");
const T = Number(params.get("t") ?? 0);
const showHud = params.get("hud") !== "0";

const base = testTrack(id) ?? trackById(id);
const track = isTheme(theme) ? themedTrack(base, theme) : base;
const canvas = document.getElementById("view") as HTMLCanvasElement;
// The context first, one that is read back: the Renderer then gets this one.
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

// What the marshals draw: every sprite taken from the marshal sheet (the one canvas of its size).
const sprites: { sheet: HTMLCanvasElement; sx: number; sy: number; w: number; h: number; x: number; y: number }[] = [];
const draw = ctx.drawImage.bind(ctx) as (...a: unknown[]) => void;
(ctx as unknown as { drawImage: (...a: unknown[]) => void }).drawImage = (...a: unknown[]): void => {
  const img = a[0] as HTMLCanvasElement;
  if (img.width === MARSHAL_W && img.height === MARSHAL_H) sprites.push({ sheet: img, sx: a[1] as number, sy: a[2] as number, w: a[3] as number, h: a[4] as number, x: a[5] as number, y: a[6] as number });
  draw(...a);
};

const renderer = new Renderer(canvas, track);
const cars = makeCars();
const race: RaceView = { phase: 0, lastLap: false, finished: 0 };
const fx: WorldFx = { shots: [], mines: [], sparks: [] };

function frame(t: number): void {
  const n = carsAt(track, t, cars);
  fx.race = raceAt(t, race);
  const cam = pointAt(track, CAMERA[0]);
  renderer.follow(cam.x, cam.y, 1000 / 60, true);
  renderer.frame(n ? cars : [], fx, showHud ? hudAt(t) : null, t);
}

const grab = (): Uint32Array => new Uint32Array(ctx.getImageData(0, 0, VIEW_W, VIEW_H).data.buffer);

// The script up to the moment, a tenth of a second a frame (every change falls on one), then
// the moment itself until the world round it is baked.
for (let u = 0; u < T; u += 100) frame(u);
for (let i = 0; i < 240; i++) frame(T);

marshalSwitch.on = false;
frame(T);
const off = grab();
frame(T);
const again = grab();
marshalSwitch.on = true;
sprites.length = 0;
frame(T);
const on = grab();

// The pixels the marshals' sprites cover in this frame.
const covered = new Uint8Array(VIEW_W * VIEW_H);
let coveredN = 0;
for (const s of sprites) {
  const cell = s.sheet.getContext("2d")!.getImageData(s.sx, s.sy, s.w, s.h).data;
  for (let j = 0; j < s.h; j++) {
    for (let i = 0; i < s.w; i++) {
      const x = s.x + i, y = s.y + j;
      if (!cell[(j * s.w + i) * 4 + 3] || x < 0 || y < 0 || x >= VIEW_W || y >= VIEW_H || covered[y * VIEW_W + x]) continue;
      covered[y * VIEW_W + x] = 1;
      coveredN++;
    }
  }
}
let differ = 0, outside = 0, control = 0;
for (let o = 0; o < on.length; o++) {
  if (off[o] !== again[o]) control++;
  if (on[o] === off[o]) continue;
  differ++;
  if (!covered[o]) outside++;
}
const line = pointAt(track, 0);
(window as unknown as { marshalShot: unknown }).marshalShot = {
  done: true, track: id, theme: theme ?? "", t: T,
  sprites: sprites.length, covered: coveredN, differ, outside, control,
  // Where the line is on the canvas, for a look at the right place.
  line: [Math.round(line.x * ZOOM - (Math.round(renderer.cam.x * ZOOM) - VIEW_W / 2)), Math.round(line.y * ZOOM - (Math.round(renderer.cam.y * ZOOM) - VIEW_H / 2))],
};
