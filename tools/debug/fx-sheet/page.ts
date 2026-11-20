// The page of tools/debug/fx-sheet.ts: the contact sheet of the catch-up visuals (M4-FX).
// Every tile is a piece of a 640 x 360 frame the game's own Renderer drew, enlarged in whole
// pixels; nothing on it is drawn by this page but the headings. See the runner.

import { P } from "../../../client/gfx/palette";
import { Renderer, VIEW_H, VIEW_W, type CarView, type CellView, type HudView, type WorldFx } from "../../../client/render";
import { pointAt, type Track } from "../../../shared/track";
import { trackById } from "../../../shared/tracks";

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const W = 1340, GAP = 10, LABEL = 18, HEAD = 44;
const MONO = "ui-monospace, Menlo, Consolas, monospace";

const NO_HUD: HudView = { topLeft: [], time: "", notice: "", center: "", centerSub: "", banner: "", corner: "", debug: [], hp: null };
const RACE: HudView = { ...NO_HUD, topLeft: ["LAP 2/3", "POS 3/6", "RIV  42 MINE 2"], time: "1:23.4", corner: "23 ms", hp: 0.62 };

interface Shot {
  label: string;
  track: Track;
  /** The camera, world units. */
  cam: { x: number; y: number };
  cars: CarView[];
  cells?: CellView[];
  hud?: HudView;
  now: number; // the frame's clock, ms
  /** The piece of the frame that is shown: its size in view pixels and where its middle is, from the frame's. */
  w: number;
  h: number;
  dx?: number;
  dy?: number;
  /** Or: from the frame's top-left corner. */
  corner?: boolean;
  zoom: number;
}

const rust = trackById("rust-bowl"), crusher = trackById("crusher-run");

function spot(track: Track, s: number, lat: number): { x: number; y: number; h: number } {
  const p = pointAt(track, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h };
}

function car(track: Track, i: number, s: number, lat: number, more: Partial<CarView> = {}): CarView {
  const p = spot(track, s, lat);
  return { id: `c${i}`, x: p.x, y: p.y, h: p.h, color: COLORS[i % COLORS.length], name: "", me: true, wreck: false, ghost: false, ...more };
}

function cellAt(track: Track, s: number, lat: number, air: boolean, state: number): CellView {
  const p = spot(track, s, lat);
  return { x: p.x, y: p.y, air, state };
}

function sections(): { title: string; note: string; shots: Shot[] }[] {
  const hw = rust.def.halfWidth;
  const gap = crusher.gaps.find((g) => !g.scrap) ?? crusher.gaps[0]; // the chasm, not a scrap pile
  const over = (gap.s0 + gap.s1) / 2;
  // A cell alone, the camera on it.
  const cell = (label: string, track: Track, s: number, lat: number, air: boolean, state: number, now: number): Shot => {
    const c = cellAt(track, s, lat, air, state);
    return { label, track, cam: c, cars: [], cells: [c], now, w: 62, h: 48, dx: air ? 5 : 0, dy: air ? 6 : 0, zoom: 4 };
  };
  // A boosting car alone, the camera on it.
  const burn = (label: string, i: number, look: CarView["car"], s: number, boost: number, now: number, more: Partial<CarView> = {}): Shot => {
    const c = car(rust, i, s, 0, { car: look, boost, ...more });
    return { label, track: rust, cam: c, cars: [c], now, w: 62, h: 64, dy: more.height ? 8 : 0, zoom: 4 };
  };
  // A follower and the car it follows, `ahead` units in front; the camera between them.
  const draft = (label: string, ahead: number, w: number, now: number): Shot => {
    const s = 180;
    const follower = car(rust, 0, s, 0, { draft: w }), leader = car(rust, 1, s + ahead, 0, { car: "racer" });
    return { label, track: rust, cam: spot(rust, s + 62, 0), cars: [follower, leader], now, w: 64, h: 168, zoom: 3 };
  };
  const hud = (label: string, more: Partial<HudView>): Shot => ({ label, track: rust, cam: spot(rust, 300, 150), cars: [], hud: { ...RACE, ...more }, now: 1000, w: 132, h: 108, corner: true, zoom: 2 });

  // The whole frame: a pack through Rust Bowl's first bend (the cars drive up and to the right: no name tag over a flame).
  const bend = (i: number, s: number, lat: number, more: Partial<CarView>) => car(rust, i, s, lat, { me: i === 0, name: more.name ?? "", ...more });
  const kerb = hw - 6;
  const whole: Shot = {
    label: "a whole frame (640 x 360, 2x): the own car in a slipstream and boosting, cells on the kerbs of the bend and one floating",
    track: rust,
    cam: spot(rust, 1270, 0),
    cars: [
      bend(1, 1262, -2, { car: "racer", name: "Racer", boost: 40 }),
      bend(2, 1420, 30, { car: "truck", name: "Truck", boost: 70 }),
      bend(3, 1085, 34, { car: "sport", name: "Sport" }),
      bend(4, 1030, 30, { car: "racer", name: "Racer 2", draft: 1 }),
      bend(5, 1500, -34, { car: "sport", name: "Sport 2" }),
      bend(0, 1205, -6, { car: "sport", draft: 0.75, boost: 54 }),
    ],
    cells: [cellAt(rust, 1130, -kerb, false, 0), cellAt(rust, 1230, kerb, false, 0), cellAt(rust, 1310, -kerb, false, 1), cellAt(rust, 1360, kerb, false, 0.05), cellAt(rust, 1450, -kerb, false, 0), cellAt(rust, 1345, 6, true, 0)],
    hud: { ...RACE, draft: 0.75, boost: 54 },
    now: 1140,
    w: VIEW_W,
    h: VIEW_H,
    zoom: 2,
  };

  return [
    {
      title: "LIGHTNING CELLS",
      note: "4x. On the ground it crackles; floating it bobs 2 px up and down over its shadow; taken it is an outline, blinking yellow when it is about to be back.",
      shots: [
        cell("ground: on tarmac", rust, 300, 0, false, 0, 0),
        cell("ground: on the kerb", rust, 300, hw + 2, false, 0, 95),
        cell("ground: on the verge", rust, 300, hw + 26, false, 0, 190),
        cell("ground: taken", rust, 300, hw - 6, false, 1, 0),
        cell("ground: about to be back", rust, 300, hw - 6, false, 0.05, 140),
        cell("floating: high in its bob", rust, 300, 0, true, 0, 255),
        cell("floating: low in its bob", rust, 300, 0, true, 0, 935),
        cell("floating over a chasm", crusher, over, -20, true, 0, 255),
        cell("floating: taken", rust, 300, 0, true, 1, 0),
        cell("floating: about to be back", rust, 300, 0, true, 0.05, 140),
      ],
    },
    {
      title: "BOOST FLAME",
      note: "4x. Two pipes on the sport and the truck, one on the racer; it flickers, is short over the boost's last 9 ticks, and grows with a car in the air.",
      shots: [
        burn("sport", 0, "sport", 180, 60, 0),
        burn("racer", 1, "racer", 180, 60, 50),
        burn("truck", 2, "truck", 180, 60, 100),
        burn("sport, in a bend", 3, "sport", 7420, 60, 100),
        burn("racer, in a bend", 4, "racer", 7520, 60, 0),
        burn("truck, in a bend", 5, "truck", 2600, 60, 50),
        burn("the boost about to end", 0, "sport", 180, 5, 0),
        burn("in the air", 2, "truck", 180, 60, 0, { height: 0.9 }),
      ],
    },
    {
      title: "SLIPSTREAM",
      note: "3x. Streaks of air run back past the follower, out of the leader's wake: more, longer and lighter the stronger the draft (leader 50, 110, 160 units ahead).",
      shots: [draft("draft 1.0", 50, 1, 60), draft("draft 0.58", 110, 0.58, 60), draft("draft 0.17", 160, 0.17, 60), draft("draft 1.0, 100 ms later", 50, 1, 160)],
    },
    {
      title: "HUD",
      note: "2x. A panel of two lamps under the lap panel, there only while one is on: DRAFT with a meter of its strength, BOOST with the seconds left.",
      shots: [hud("neither: as today", {}), hud("DRAFT 0.58", { draft: 0.58 }), hud("BOOST, 72 ticks left", { boost: 72 }), hud("both: draft 1.0, 24 ticks left", { draft: 1, boost: 24 })],
    },
    { title: "IN A RACE", note: "", shots: [whole] },
  ];
}

function main(): void {
  const view = document.createElement("canvas");
  const renderers = new Map<Track, Renderer>();
  const list = sections();
  // Lay the tiles out: a heading a section, the tiles left to right, a new row when one does not fit.
  const places: { shot: Shot; x: number; y: number }[] = [];
  const heads: { title: string; note: string; y: number }[] = [];
  let y = 46;
  for (const sec of list) {
    heads.push({ title: sec.title, note: sec.note, y });
    y += HEAD;
    let x = 20, row = 0;
    for (const shot of sec.shots) {
      const tw = shot.w * shot.zoom, th = shot.h * shot.zoom;
      if (x + tw > W - 20 && x > 20) {
        x = 20;
        y += row + LABEL + GAP;
        row = 0;
      }
      places.push({ shot, x, y });
      x += tw + GAP;
      row = Math.max(row, th);
    }
    y += row + LABEL + GAP + 12;
  }
  const sheet = document.getElementById("sheet") as HTMLCanvasElement;
  sheet.width = W;
  sheet.height = y;
  const g = sheet.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.fillStyle = P.soot1;
  g.fillRect(0, 0, W, y);
  g.textBaseline = "alphabetic";
  g.font = `bold 18px ${MONO}`;
  g.fillStyle = P.bone2;
  g.fillText("SCRAP RALLY  M4-FX: catch-up visuals", 20, 28);
  g.font = `12px ${MONO}`;
  g.fillStyle = P.bone0;
  g.fillText("every tile is a piece of a frame the game's renderer drew, enlarged in whole pixels", 440, 27);
  for (const h of heads) {
    g.font = `bold 14px ${MONO}`;
    g.fillStyle = P.rust3;
    g.fillText(h.title, 20, h.y + 14);
    g.font = `12px ${MONO}`;
    g.fillStyle = P.bone0;
    g.fillText(h.note, 20, h.y + 31);
  }
  for (const { shot, x, y: top } of places) {
    let r = renderers.get(shot.track);
    if (!r) renderers.set(shot.track, (r = new Renderer(view, shot.track)));
    const fx: WorldFx = { shots: [], mines: [], sparks: [], cells: shot.cells };
    r.follow(shot.cam.x, shot.cam.y, 16, true);
    // Twice: a car's place on screen settles on the second frame it is seen in.
    for (let k = 0; k < 2; k++) r.frame(shot.cars, fx, shot.hud ?? null, shot.now);
    const sx = shot.corner ? 0 : Math.round(VIEW_W / 2 + (shot.dx ?? 0) - shot.w / 2), sy = shot.corner ? 0 : Math.round(VIEW_H / 2 + (shot.dy ?? 0) - shot.h / 2);
    g.drawImage(view, sx, sy, shot.w, shot.h, x, top, shot.w * shot.zoom, shot.h * shot.zoom);
    g.font = `12px ${MONO}`;
    g.fillStyle = P.bone1;
    g.fillText(shot.label, x, top + shot.h * shot.zoom + 13);
  }
  (window as unknown as { fxSheet: unknown }).fxSheet = { done: true, tiles: places.length, width: W, height: y };
}

main();
