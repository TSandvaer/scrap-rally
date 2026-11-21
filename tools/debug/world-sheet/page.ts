// The page of tools/debug/world-sheet.ts: the contact sheet of the road's furniture (M4-WORLD:
// water, dirt, tyre mounds, split lanes, the conveyor belt, rolling barrels, the crusher press,
// the ramp truck). Every tile is a piece of a 640 x 360 frame the game's own Renderer drew,
// shown twice: enlarged in whole pixels, and beside that at the game's own scale (1 view pixel =
// 1 pixel). Nothing on it is drawn by this page but the headings. See the runner.

import { P } from "../../../client/gfx/palette";
import { PUDDLE_TRACTION_INSET, tractionRect, type PuddleRect } from "../../../client/gfx/puddle-shape";
import { ZOOM } from "../../../client/gfx/world";
import { Renderer, VIEW_H, VIEW_W, type CarView, type CellView, type WorldFx } from "../../../client/render";
import { testTrack } from "../../../shared/testtracks";
import { barrelLat, pointAt, type Track } from "../../../shared/track";
import { sheetYard } from "./yard";

const COLORS = ["#e8552d", "#33a3e8", "#f2c230", "#5cc46b", "#c46ad6", "#e8e2d4"];
const W = 1340, GAP = 12, LABEL = 18, HEAD = 44;
const MONO = "ui-monospace, Menlo, Consolas, monospace";

interface Shot {
  label: string;
  track: Track;
  /** The middle of the piece shown, world units. */
  cam: { x: number; y: number };
  cars?: CarView[];
  cells?: CellView[];
  /** The race tick; absent = nothing that moves is drawn. */
  rt?: number;
  /** The size of the piece, view pixels. */
  w: number;
  h: number;
  /** How much the larger tile is enlarged (default 2). */
  zoom?: number;
  /** No tile at the game's scale beside it (a whole frame has one of its own). */
  alone?: boolean;
  /**
   * A third tile, enlarged again, with these puddles' rectangles drawn over it by this page:
   * the declared one dotted, the traction one (tractionRect) as a line.
   */
  rects?: PuddleRect[];
}

const yard = sheetYard(), preview = testTrack("preview-yard")!;

function spot(track: Track, s: number, lat: number): { x: number; y: number; h: number } {
  const p = pointAt(track, s);
  return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat, h: p.h };
}

function car(track: Track, i: number, s: number, lat: number, more: Partial<CarView> = {}): CarView {
  const p = spot(track, s, lat);
  // `me`: no name tag over it (a tile shows the road, not the names); the whole frames name their cars.
  return { id: `c${i}`, x: p.x, y: p.y, h: p.h, color: COLORS[i % COLORS.length], name: "", me: !more.name, wreck: false, ghost: false, ...more };
}

function cellAt(track: Track, s: number, lat: number, air: boolean): CellView {
  const p = spot(track, s, lat);
  return { x: p.x, y: p.y, air, state: 0 };
}

function sections(): { title: string; note: string; shots: Shot[] }[] {
  const at = (label: string, track: Track, s: number, lat: number, w: number, h: number, more: Partial<Shot> = {}): Shot => ({ label, track, cam: spot(track, s, lat), w, h, ...more });
  // The barrel that starts the row's cycle, alone, the piece centred on it.
  const row = yard.barrels[0];
  const turn = (rt: number): Shot => {
    const lat = barrelLat(row, 0, rt);
    return { label: `tick ${rt}`, track: yard, cam: { x: row.x + row.nx * lat, y: row.y + row.ny * lat }, rt, w: 30, h: 30, zoom: 4 };
  };
  // The presses of the sheet's yard: across the whole road in a bend, on the dirt lane, over the kerb.
  const press = (label: string, s: number, lat: number, rt: number, w: number, h: number, cars: CarView[] = []): Shot => at(label, yard, s, lat, w, h, { rt, cars });
  const pack = (track: Track, s: number, more: Partial<CarView>[] = []): CarView[] =>
    [0, 1, 2, 3, 4, 5].map((i) => car(track, i, s - 150 + i * 62, [-34, 30, -6, 40, -40, 12][i], { name: `Car ${i + 1}`, me: i === 0, car: (["sport", "racer", "truck"] as const)[i % 3], ...more[i] }));

  return [
    {
      title: "WATER",
      note: "Flat steel grey (the one ground with no speckle), a dark edge, wet ground round it, ripples. Kerbs and the road's paint show through. Drivable: a car slides on it.",
      shots: [
        at("on asphalt", yard, 1225, -2, 150, 110),
        at("over the kerb onto the verge", yard, 1365, 62, 150, 110),
        at("a flooded lane beside an island", yard, 6040, -74, 170, 110, { cars: [car(yard, 1, 6090, -70)] }),
        at("right across the road (Preview Yard)", preview, 1535, 0, 180, 150, { cars: [car(preview, 0, 1500, -20)] }),
      ],
    },
    {
      title: "DIRT",
      note: "The yard's earth on the road: ragged, thrown a little past its edge, wheel ruts along it. Drivable: slow and loose, as the verge.",
      shots: [
        at("on asphalt", yard, 1040, -34, 150, 110),
        at("the start of a dirt lane", yard, 6020, 76, 170, 110, { cars: [car(yard, 2, 6070, 70, { car: "truck" })] }),
        at("under a mound (see TYRE MOUNDS)", yard, 668, 0, 120, 130),
      ],
    },
    {
      title: "TYRE MOUNDS",
      note: "Solid and bouncy: tyres heaped in rings, the outer ring painted in the kerb's two colours, a cast shadow. Radius 18, 24 and 30.",
      shots: [
        at("on dirt (r 24)", yard, 705, 0, 110, 90),
        at("on asphalt (r 30)", yard, 850, -22, 110, 90, { cars: [car(yard, 3, 800, 30)] }),
        at("across the kerb (r 18)", yard, 930, 72, 110, 90),
        at("a chicane of three (Preview Yard)", preview, 880, 0, 330, 120, { cars: [car(preview, 0, 800, -10), car(preview, 4, 960, -30, { car: "racer" })] }),
      ],
    },
    {
      title: "SPLIT LANES",
      note: "The road widens round an island: the track's own barrier round a strip of the yard, a nose of tyre stacks at either end, a painted wedge before each nose. Solid; both lanes are road.",
      shots: [
        at("the nose and its wedge", yard, 5880, 0, 220, 170, { cars: [car(yard, 0, 5830, -40), car(yard, 1, 5930, 62, { car: "racer" })] }),
        at("a flooded lane and a dirt lane", yard, 6300, 0, 220, 250, { cars: [car(yard, 2, 6260, -80, { car: "truck" }), car(yard, 5, 6330, 70)] }),
        at("a split in a bend", yard, 8100, 0, 300, 290, { cars: [car(yard, 3, 8040, -52), car(yard, 4, 8160, 50, { car: "racer" })] }),
      ],
    },
    {
      title: "CONVEYOR BELT",
      note: "Rusted steel slats between two rollers; it carries a car across the road. The arrows run with it (here to the right of travel, then 13 ticks on; the last two run to the left). Drivable.",
      shots: [
        at("on asphalt, tick 0", yard, 1535, 0, 150, 160, { rt: 0, cars: [car(yard, 1, 1520, -20)] }),
        at("13 ticks on", yard, 1535, 0, 150, 160, { rt: 13, cars: [car(yard, 1, 1520, -7)] }),
        at("over the kerb, in a bend", yard, 4015, 47, 170, 160, { rt: 0 }),
        at("without a tick: the belt alone", preview, 8950, 0, 170, 160),
      ],
    },
    {
      title: "ROLLING BARRELS",
      note: "Solid. A rust-red drum, steel hoops, a white label that goes round as it rolls. First row: one turn, every 4th tick (4x). Its lane is worn, the kerbs hazard-striped; a hatch in one barrier, a grated gutter in the other.",
      shots: [
        ...[40, 44, 48, 52, 55, 59, 63, 67].map(turn),
        at("a row of three: verge, kerb, dirt, asphalt", yard, 1060, 0, 120, 200, { rt: 20, cars: [car(yard, 2, 1010, 30)] }),
        at("38 ticks on", yard, 1060, 0, 120, 200, { rt: 58, cars: [car(yard, 2, 1025, 30)] }),
        at("74 ticks on", yard, 1060, 0, 120, 200, { rt: 94, cars: [car(yard, 2, 1032, 30)] }),
        at("a row of four in a bend, the other way", yard, 8660, 0, 220, 130, { rt: 20 }),
        at("the lane alone (no tick)", yard, 8660, 0, 220, 130),
      ],
    },
    {
      title: "CRUSHER PRESS",
      note: "A cycle: up (only its bed shows, a dark lamp at each corner), 0.5 s of warning (the slab's shadow closes in and darkens, the lamps blink), down (solid: the slab over the cars), then its shadow leaves.",
      shots: [
        press("on dirt: up", 6560, 76, 40, 110, 120, [car(yard, 0, 6510, 70)]),
        press("warning, 3 ticks in", 6560, 76, 93, 110, 120, [car(yard, 0, 6515, 70)]),
        press("warning, 20 ticks in", 6560, 76, 110, 110, 120, [car(yard, 0, 6520, 70)]),
        press("warning, 28 ticks in", 6560, 76, 118, 110, 120, [car(yard, 0, 6522, 70)]),
        press("down", 6560, 76, 140, 110, 120, [car(yard, 0, 6528, 70)]),
        press("going up, 3 ticks in", 6560, 76, 183, 110, 120, [car(yard, 0, 6530, 70)]),
        press("across a road in a bend: up", 4300, 0, 40, 170, 130),
        press("warning", 4300, 0, 108, 170, 130, [car(yard, 4, 4240, -20, { car: "racer" })]),
        press("down, a car in the air over it", 4300, 0, 150, 170, 130, [car(yard, 4, 4290, -20, { car: "racer", height: 0.8 }), car(yard, 1, 4250, 34)]),
        press("over the kerb: warning", 6800, 89, 112, 110, 150),
        press("over the kerb: down", 6800, 89, 140, 110, 150),
      ],
    },
    {
      title: "RAMP TRUCK",
      note: "Parked, solid, its ramp facing backwards. The ramp plate and the deck are striped and lit as every ramp, the arrows point up it, and the hazard lip is where a car takes off: at the cab, which it flies over.",
      shots: [
        at("on asphalt", yard, 1715, -26, 170, 100),
        at("a car on the ramp, one in the air over the cab", yard, 1715, -26, 170, 100, { cars: [car(yard, 0, 1690, -26), car(yard, 1, 1780, -26, { height: 0.9, car: "racer" })] }),
        at("on dirt, in a bend", yard, 3475, 26, 130, 160),
        at("across the kerb", yard, 3765, 52, 130, 150, { cars: [car(yard, 3, 3700, -10)] }),
      ],
    },
    {
      title: "IN A RACE (Preview Yard, whole frames at 2x)",
      note: "",
      shots: [
        { label: "the chicane's last mound, a row of barrels, a pool right across the road; cells on the kerbs", track: preview, cam: { x: 2150, y: 600 }, rt: 24, cars: pack(preview, 1330), cells: [cellAt(preview, 1180, -58, false), cellAt(preview, 1380, 58, false), cellAt(preview, 1530, -30, false)], w: VIEW_W, h: VIEW_H, alone: true },
        { label: "the ramp truck (a car in the air over its cab) and a pool on the inside of the bend", track: preview, cam: spot(preview, 3650, 0), rt: 0, cars: [...pack(preview, 3700).slice(1), car(preview, 0, 3550, 30, { height: 0.85, name: "You", me: true })], cells: [cellAt(preview, 3640, 34, true), cellAt(preview, 3900, -30, false), cellAt(preview, 3760, 58, false)], w: VIEW_W, h: VIEW_H, alone: true },
        { label: "the split: a dirt lane with the press about to slam, the island, a flooded lane", track: preview, cam: spot(preview, 6640, 0), rt: 112, cars: [car(preview, 0, 6770, 78, { name: "You", me: true }), car(preview, 1, 6690, 60, { car: "racer", name: "Car 2" }), car(preview, 2, 6560, 90, { car: "truck", name: "Car 3" }), car(preview, 3, 6620, -70, { name: "Car 4" }), car(preview, 4, 6480, -90, { car: "racer", name: "Car 5" }), car(preview, 5, 6900, -60, { car: "truck", name: "Car 6" })], cells: [cellAt(preview, 6450, -110, false), cellAt(preview, 6700, 118, false), cellAt(preview, 6300, 118, false)], w: VIEW_W, h: VIEW_H, alone: true },
      ],
    },
  ];
}

/** The follow-up sheet (?only=puddles): the pools and the dirt patches alone, on straights and in bends, each with its traction rectangle. */
function puddles(): { title: string; note: string; shots: Shot[] }[] {
  const of = (track: Track, kind: "water" | "dirt", s0: number): PuddleRect => {
    const f = (kind === "water" ? track.water : track.dirt).find((w) => w.s0 === s0);
    if (!f) throw new Error(`no ${kind} at ${s0}`);
    return f;
  };
  const shot = (label: string, track: Track, kind: "water" | "dirt", s0: number, w: number, h: number, cars: CarView[] = []): Shot => {
    const f = of(track, kind, s0);
    const size = `${f.s1 - f.s0} x ${f.lat1 - f.lat0}`;
    return { label: `${label} (${size})`, track, cam: spot(track, (f.s0 + f.s1) / 2, (f.lat0 + f.lat1) / 2), w, h, cars, rects: [f] };
  };
  return [
    {
      title: "WATER, ON A STRAIGHT",
      note: `A pool is drawn as a puddle inside its declared rectangle (dotted): round corners, an edge in lobes, a murky blue-grey that nothing else has. What a car feels is the rectangle ${PUDDLE_TRACTION_INSET} units in on every side (the line): all of it is under water. Third tile: the same, with the two rectangles drawn over it.`,
      shots: [
        shot("on asphalt", yard, "water", 1170, 150, 110),
        shot("right across the road, Preview Yard", preview, "water", 1450, 180, 150, [car(preview, 0, 1500, -20)]),
        shot("over the kerb onto the verge", yard, "water", 1310, 150, 110),
        shot("a flooded lane, Preview Yard", preview, "water", 6000, 430, 110, [car(preview, 1, 6300, -80)]),
      ],
    },
    {
      title: "WATER, IN A BEND",
      note: "",
      shots: [
        shot("the inside of a bend, Preview Yard", preview, "water", 3800, 150, 270),
        shot("the inside of a tight bend", yard, "water", 2760, 170, 150),
        shot("right across a tight bend", yard, "water", 4540, 190, 180, [car(yard, 3, 4600, 20)]),
      ],
    },
    {
      title: "DIRT, ON A STRAIGHT",
      note: `A dirt patch is a puddle of the yard's earth, drawn the same way; inside the line the ground is loose.`,
      shots: [
        shot("right across the road (a tyre mound on it)", yard, "dirt", 640, 160, 150),
        shot("half the road (a row of barrels crosses it)", yard, "dirt", 1010, 150, 110),
        shot("a dirt lane, Preview Yard", preview, "dirt", 6000, 640, 110, [car(preview, 2, 6400, 76, { car: "truck" })]),
      ],
    },
    {
      title: "DIRT, IN A BEND",
      note: "",
      shots: [
        shot("the outside of a tight bend", yard, "dirt", 2960, 180, 170),
        shot("right across a tight bend", yard, "dirt", 4780, 190, 200, [car(yard, 4, 4860, -20, { car: "racer" })]),
        shot("in a bend (the ramp truck on it)", yard, "dirt", 3380, 150, 200),
      ],
    },
  ];
}

function main(): void {
  const view = document.createElement("canvas");
  const renderers = new Map<Track, Renderer>();
  const only = new URLSearchParams(location.search).get("only") === "puddles";
  const list = only ? puddles() : sections();
  // Lay the tiles out: a heading a section, the tiles left to right, a new row when one does not fit.
  const places: { shot: Shot; x: number; y: number }[] = [];
  const heads: { title: string; lines: string[]; y: number }[] = [];
  const size = (shot: Shot) => {
    const z = shot.zoom ?? 2;
    return { z, w: shot.w * z + (shot.alone ? 0 : GAP / 2 + shot.w) + (shot.rects ? GAP / 2 + shot.w * z : 0), h: shot.h * z };
  };
  // A note is broken into lines that fit the sheet.
  const wrap = (note: string): string[] => {
    const out: string[] = [];
    for (const word of note.split(" ")) {
      if (out.length && (out[out.length - 1] + " " + word).length <= 176) out[out.length - 1] += " " + word;
      else out.push(word);
    }
    return out;
  };
  let y = 46;
  for (const sec of list) {
    const lines = sec.note ? wrap(sec.note) : [];
    heads.push({ title: sec.title, lines, y });
    y += HEAD - 16 + lines.length * 16;
    let x = 20, row = 0;
    for (const shot of sec.shots) {
      const t = size(shot);
      if (x + t.w > W - 20 && x > 20) {
        x = 20;
        y += row + LABEL + GAP;
        row = 0;
      }
      places.push({ shot, x, y });
      x += t.w + GAP + 6;
      row = Math.max(row, t.h);
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
  g.fillText(only ? "SCRAP RALLY  M4-WORLD: puddles (follow-up sheet)" : "SCRAP RALLY  M4-WORLD: the road's furniture", 20, 28);
  g.font = `12px ${MONO}`;
  g.fillStyle = P.bone0;
  g.fillText(only ? "every tile: a piece of a frame the game's renderer drew: 2x, the game's own scale, and 2x with the rectangles over it" : "every tile: a piece of a frame the game's renderer drew, enlarged (2x; a barrel's turn 4x), and beside it at the game's own scale", only ? 530 : 470, 27);
  for (const h of heads) {
    g.font = `bold 14px ${MONO}`;
    g.fillStyle = P.rust3;
    g.fillText(h.title, 20, h.y + 14);
    g.font = `12px ${MONO}`;
    g.fillStyle = P.bone0;
    h.lines.forEach((line, k) => g.fillText(line, 20, h.y + 31 + k * 16));
  }
  for (const { shot, x, y: top } of places) {
    let r = renderers.get(shot.track);
    if (!r) renderers.set(shot.track, (r = new Renderer(view, shot.track)));
    const fx: WorldFx = { shots: [], mines: [], sparks: [], cells: shot.cells, rt: shot.rt };
    if (shot.rt === undefined) delete fx.rt;
    if (!shot.cells) delete fx.cells;
    r.follow(shot.cam.x, shot.cam.y, 16, true);
    // Twice: a car's place on screen settles on the second frame it is seen in.
    for (let k = 0; k < 2; k++) r.frame(shot.cars ?? [], fx, null, 1000);
    const z = shot.zoom ?? 2;
    const sx = Math.round(VIEW_W / 2 - shot.w / 2), sy = Math.round(VIEW_H / 2 - shot.h / 2);
    g.drawImage(view, sx, sy, shot.w, shot.h, x, top, shot.w * z, shot.h * z);
    if (!shot.alone) g.drawImage(view, sx, sy, shot.w, shot.h, x + shot.w * z + GAP / 2, top, shot.w, shot.h);
    if (shot.rects) {
      // The third tile, and over it the rectangles: this page's own drawing, nothing of the game's.
      const left = x + shot.w * z + GAP + shot.w, ox = Math.round(shot.cam.x * ZOOM) - VIEW_W / 2 + sx, oy = Math.round(shot.cam.y * ZOOM) - VIEW_H / 2 + sy;
      g.drawImage(view, sx, sy, shot.w, shot.h, left, top, shot.w * z, shot.h * z);
      const dot = (s: number, lat: number, colour: string, size: number) => {
        const q = spot(shot.track, s, lat);
        const px = q.x * ZOOM - ox, py = q.y * ZOOM - oy;
        if (px < 0 || py < 0 || px >= shot.w || py >= shot.h) return;
        g.fillStyle = colour;
        g.fillRect(Math.round(left + px * z - size / 2), Math.round(top + py * z - size / 2), size, size);
      };
      const outline = (r: PuddleRect, colour: string, step: number, size: number) => {
        for (let s = r.s0; s <= r.s1; s += step) for (const lat of [r.lat0, r.lat1]) dot(s, lat, colour, size);
        for (let lat = r.lat0; lat <= r.lat1; lat += step) for (const s of [r.s0, r.s1]) dot(s, lat, colour, size);
      };
      for (const r of shot.rects) {
        outline(r, P.bone2, 5, 2);
        outline(tractionRect(r), P.red, 0.5, 2);
      }
    }
    g.font = `12px ${MONO}`;
    g.fillStyle = P.bone1;
    g.fillText(shot.label, x, top + shot.h * z + 13);
  }
  (window as unknown as { worldSheet: unknown }).worldSheet = { done: true, tiles: places.length, width: W, height: y };
}

main();
