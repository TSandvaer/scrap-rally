// br-tracks (BR-TRACKS, ClickUp 123jpnbfghe; PLAN-BRANCH.md 3, user decisions 1, 2 and 6): the shortcuts of
// Slag Harbour (a narrow cut between the pier's legs, a pit on the inside of its hairpin) and Breaker's Mile
// (a jump cut across the east lobe) in numbers, with no browser: server bots in a Room on the sim clock
// (tools/debug/branch-tune.ts branchRace), one bot alone, weapons off, 3 laps, the route forced.
//
//   npx tsx tools/debug/br-tracks.ts --gain     per level and car type: the median lap on the main road and on
//                                                the shortcut, and the gain (user decision 2: about 1.5-2.5 s)
//   npx tsx tools/debug/br-tracks.ts --fall     per level and car type: the shortcut with one fall at its hazard
//                                                on lap 2 (the pit: the car is put over the pit's middle as it
//                                                reaches it; the jump: it brakes from 300 before the ramp to under
//                                                120 u/s, too slow to clear the gap): lap 2 against the main road's
//                                                lap 2 (a fall costs more than the shortcut gains: a positive cost)
//   npx tsx tools/debug/br-tracks.ts --clear    every shortcut hazard's distance to the main road (its footprint
//                                                to the main centreline, and to the main corridor's edge), every
//                                                main-road hazard's to the shortcut's centreline; the BR-BAKE
//                                                review's rule (client/gfx/world.ts predict(): > 240)
//   npx tsx tools/debug/br-tracks.ts --shots --out <dir>   the taste pictures, in headless Chrome: each shortcut's fork,
//                                                hazard and merge (the preview's tour, &scene=tour&road=1, held at
//                                                that point of the shortcut with its pack of six) at 1280x720 and
//                                                390x844@3, in the track's own look. The working tree is built into
//                                                a temp folder and served on 127.0.0.1:--port (default 3011); the
//                                                browser session is brtracks-<pid>, its audio muted, closed at the
//                                                end. Every shot muted in the game too: its M is sent only while the
//                                                stored mute (localStorage) is off, and each shot checks the speaker
//                                                icon's "muted" class and its rust ink; icons-<size>.png shows the icon
//                                                of every shot side by side.
//   --track slag-harbour|breakers-mile          one track only (default both)
//
// Its fallCost and hazardClearance are used by scripts/sim-test.ts (section BR-TRACKS).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BotLevel } from "../../shared/botdrive";
import { CAR_TYPES, type CarType } from "../../shared/cars";
import type { CarState } from "../../shared/physics";
import { pointAt, queryTrack, queryTrackNear, roadOfSeg, type Track } from "../../shared/track";
import { trackById } from "../../shared/tracks";
import { branchRace } from "./branch-tune";
import { blank, decodePng, paste, savePng, type Picture } from "./png";

/** The two tracks with a shortcut (BR-TRACKS). */
export const BR_TRACK_IDS = ["slag-harbour", "breakers-mile"];
const LEVELS: BotLevel[] = ["easy", "normal", "hard"];
const f2 = (v: number) => v.toFixed(2);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** One bot alone (seat 0), weapons off, 3 laps on route `route` (0: the main road, 1: the shortcut); `observe` may change its controls or car. */
function solo(id: string, level: BotLevel, car: CarType, route: number, observe?: (car: CarState, ctl: { throttle: number; steer: number }, visit: number) => void) {
  const t = trackById(id);
  let visit = 0, was = 0;
  const res = branchRace({
    track: id, levels: [level], cars: [car], laps: 3, weapons: false, force: [route],
    observe: observe && ((_k, c, ctl) => {
      const road = roadOfSeg(t, c.seg);
      if (road === 1 && was !== 1) visit++;
      was = road;
      observe(c, ctl, visit);
    }),
  });
  return res.rows[0];
}

export interface GainRow { level: BotLevel; car: CarType; main: number; cut: number; gain: number; falls: number }

/** Per level and car type: the median lap on the main road and on the shortcut (forced), clean. */
export function gainRows(id: string): GainRow[] {
  const out: GainRow[] = [];
  for (const level of LEVELS) {
    for (const car of CAR_TYPES) {
      const m = solo(id, level, car, 0), c = solo(id, level, car, 1);
      const main = median(m.lapTicks) / 60, cut = median(c.lapTicks) / 60;
      out.push({ level, car, main, cut, gain: main - cut, falls: m.falls + c.falls });
    }
  }
  return out;
}

export interface FallRow { level: BotLevel; car: CarType; main2: number; clean2: number; fall2: number; falls: number; cost: number }

/**
 * Per level and car type: lap 2 on the main road, on the shortcut clean, and on the shortcut with one fall at
 * its hazard (see the header); cost = the fall's lap 2 less the main road's (> 0: the fall costs more than
 * the shortcut gains). falls: the falls in the fall run (one is planted).
 */
export function fallCost(id: string, levels: BotLevel[] = LEVELS): FallRow[] {
  const t = trackById(id), r = t.branches[0].road;
  const hole = r.holes[0], ramp = r.ramps[0];
  const out: FallRow[] = [];
  for (const level of levels) {
    for (const car of CAR_TYPES) {
      const m = solo(id, level, car, 0), c = solo(id, level, car, 1);
      let planted = false, fell = false;
      const f = solo(id, level, car, 1, (cs, ctl, visit) => {
        if (cs.fall > 0 && visit === 2) fell = true; // one fall only: from then on the bot drives as it will
        if (visit !== 2 || fell || cs.air > 0) return;
        const q = queryTrackNear(t, cs.x, cs.y, cs.seg);
        if (q.road !== 1) return;
        if (hole && !planted && q.s >= hole.s - 2) {
          // Over the pit's middle (its u, its lat): the next step finds the car over the pit.
          const p = pointAt(r, hole.s);
          cs.x = p.x - Math.sin(p.h) * hole.lat;
          cs.y = p.y + Math.cos(p.h) * hole.lat;
          planted = true;
        }
        if (ramp && q.s >= ramp.s - 300 && q.s <= ramp.s + ramp.len) ctl.throttle = Math.hypot(cs.vx, cs.vy) > 120 ? -1 : 0.3;
      });
      const main2 = m.lapTicks[1] / 60, clean2 = c.lapTicks[1] / 60, fall2 = f.lapTicks[1] / 60;
      out.push({ level, car, main2, clean2, fall2, falls: f.falls, cost: fall2 - main2 });
    }
  }
  return out;
}

export interface Clearance { what: string; dist: number; edge: number }

/**
 * Every hazard of the shortcut against the main road: its footprint's nearest point (a pit's circle, a gap's
 * span across the shortcut's walls, a ramp's centreline point) to the main centreline (dist) and to the main
 * corridor's edge (edge = dist - the main wall); and every main-road hazard against the shortcut's centreline.
 */
export function hazardClearance(t: Track): Clearance[] {
  const out: Clearance[] = [];
  for (const b of t.branches) {
    const r = b.road;
    const near = (on: Track, x: number, y: number, rad: number) => queryTrack(on, x, y).dist - rad;
    for (const h of r.holes) {
      const d = near(t, h.x, h.y, h.r);
      out.push({ what: `shortcut pit u ${h.s} lat ${h.lat} r ${h.r}`, dist: d, edge: d - t.wall });
    }
    for (const g of r.gaps) {
      let d = Infinity;
      for (let u = g.s0; u <= g.s1; u += 5) {
        const p = pointAt(r, u);
        for (const lat of [-r.wall, 0, r.wall]) d = Math.min(d, near(t, p.x - Math.sin(p.h) * lat, p.y + Math.cos(p.h) * lat, 0));
      }
      out.push({ what: `shortcut gap u ${g.s0}..${g.s1}`, dist: d, edge: d - t.wall });
    }
    for (const x of r.ramps) {
      const p = pointAt(r, x.s);
      const d = near(t, p.x, p.y, 0);
      out.push({ what: `shortcut ramp u ${x.s}`, dist: d, edge: d - t.wall });
    }
    for (const h of t.holes) {
      const d = near(r, h.x, h.y, h.r);
      out.push({ what: `main pit s ${h.s} (to the shortcut)`, dist: d, edge: d - r.wall });
    }
    for (const g of t.gaps) {
      let d = Infinity;
      for (let s = g.s0; s <= g.s1; s += 5) {
        const p = pointAt(t, s);
        d = Math.min(d, near(r, p.x, p.y, 0));
      }
      out.push({ what: `main gap s ${g.s0}..${g.s1} (to the shortcut)`, dist: d, edge: d - r.wall });
    }
  }
  return out;
}

// ---- the taste pictures (headless Chrome) ------------------------------------------------------------

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = promisify(execFile);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const SIZES = [
  { name: "1280x720", w: 1280, h: 720, scale: 1 },
  { name: "390x844@3", w: 390, h: 844, scale: 3 },
];

/** Where each picture is held: u along the shortcut (the tour's &s on &road=1; its camera stands ahead of its lead car). */
export function shotPlaces(t: Track): { name: string; u: number }[] {
  const b = t.branches[0], r = b.road;
  const hazard = Math.min(...r.ramps.map((x) => x.s), ...r.gaps.map((g) => g.s0), ...r.holes.map((h) => h.s - h.r));
  return [
    { name: "fork", u: Math.max(0, (b.forkGore?.u ?? 200) - 260) },
    { name: "hazard", u: hazard - 140 },
    { name: "merge", u: (b.mergeGore?.u ?? r.length - 200) - 80 },
  ];
}

/** The game's stored mute (client/audio.ts STORE_KEY "scrap-rally:sound", its `muted`), read in the page. */
async function storedMute(ab: (more: string[]) => Promise<string>): Promise<boolean> {
  const got = await ab(["eval", "(() => { try { const o = JSON.parse(localStorage.getItem('scrap-rally:sound') ?? 'null'); return o !== null && o.muted === true ? 'muted' : 'sound'; } catch { return 'sound'; } })()"]);
  return got.includes("muted");
}

async function shots(ids: string[], out: string, port: number): Promise<void> {
  mkdirSync(out, { recursive: true });
  const dist = mkdtempSync(path.join(os.tmpdir(), "br-tracks-dist-"));
  const session = `brtracks-${process.pid}`;
  const ab = async (more: string[]): Promise<string> => (await run("agent-browser", ["--session", session, ...more], { timeout: 120_000, maxBuffer: 64 << 20 })).stdout.trim();
  let server: http.Server | null = null, opened = false;
  try {
    console.error("building the working tree ...");
    await run(path.join(ROOT, "node_modules", ".bin", "vite"), ["build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, maxBuffer: 16 << 20 });
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      let file = path.join(dist, pathname === "/" ? "index.html" : pathname);
      if (!file.startsWith(dist + path.sep) || !existsSync(file) || !statSync(file).isFile()) file = path.join(dist, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((done, fail) => {
      server!.once("error", fail);
      server!.listen(port, "127.0.0.1", () => done());
    });
    await ab(["--args", "--mute-audio", "open", "about:blank"]);
    opened = true;
    for (const size of SIZES) {
      await ab(["set", "viewport", String(size.w), String(size.h), String(size.scale)]);
      const icons = new Map<string, number>(); // the speaker icon's rust ink in each shot of this size, by its hash
      const crops: Picture[] = []; // ... and its box cut out of each, for icons-<size>.png
      for (const id of ids) {
        for (const pl of shotPlaces(trackById(id))) {
          const file = path.join(out, `${id}-${pl.name}-${size.name}.png`);
          await ab(["open", `http://127.0.0.1:${port}/?${new URLSearchParams({ debug: "1", preview: "1", freeze: "1", scene: "tour", track: id, road: "1", s: pl.u.toFixed(0), hud: "0" })}`]);
          // Silent: the game's M too (a synthetic key, never a pressed one). M toggles a mute the game keeps in
          // localStorage (client/audio.ts STORE_KEY), so it is sent only while the stored mute is off: every
          // shot is muted (the BR-TRACKS review: sent on every load, every second shot was not).
          const before = await storedMute(ab);
          if (!before) await ab(["eval", "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM' })); true"]);
          await new Promise((done) => setTimeout(done, 700)); // a held scene is redrawn every frame: any frame after the first will do
          if (!(await storedMute(ab))) throw new Error(`br-tracks --shots: ${file}: the game is not muted after its M`);
          // The speaker icon (#sound-btn) shows it: its "muted" class, and its box, cut out of the shot below.
          const box = JSON.parse(JSON.parse(await ab(["eval", "JSON.stringify((() => { const b = document.getElementById('sound-btn'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, b.classList.contains('muted')]; })())"])) as string) as [number, number, number, number, boolean] | null;
          if (!box || !box[4]) throw new Error(`br-tracks --shots: ${file}: the speaker icon does not show the mute`);
          await ab(["screenshot", file]);
          // The icon's ink, where it is in its box: the muted icon is drawn in rust (client/style.css .sound-btn.muted,
          // #e8752d at opacity 0.8: red high, blue low), the sounding one in bone grey; its box is see-through, so the
          // scene behind differs from shot to shot (dimmed to at most ~110 red), the ink's pixels do not.
          const pic = decodePng(file), h = createHash("sha256");
          const x0 = Math.round(box[0] * size.scale), y0 = Math.round(box[1] * size.scale), w = Math.round(box[2] * size.scale), hh = Math.round(box[3] * size.scale);
          let ink = 0;
          for (let y = y0; y < y0 + hh; y++) {
            for (let x = x0; x < x0 + w; x++) {
              const o = (y * pic.w + x) * 4, r = pic.data[o], g = pic.data[o + 1], b = pic.data[o + 2];
              const on = r > 160 && r - b > 100 && r - g > 50;
              if (on) ink++;
              h.update(on ? "1" : "0");
            }
          }
          if (ink === 0) throw new Error(`br-tracks --shots: ${file}: no rust ink in the speaker icon (not muted)`);
          const crop = blank(w, hh, 0, 0, 0);
          paste(crop, pic, 0, 0, x0, y0, w, hh);
          crops.push(crop);
          const icon = h.digest("hex");
          icons.set(icon, (icons.get(icon) ?? 0) + 1);
          console.log(`${file}  (u ${pl.u.toFixed(0)}; muted, ${before ? "already" : "by its M"}; the icon's rust ink ${ink} px, ${icon.slice(0, 12)})`);
        }
      }
      // The icons side by side, enlarged (to about 120 px high), in the order shot.
      const z = Math.max(1, Math.round(120 / crops[0].h)), gap = 8;
      const strip = blank(gap + crops.reduce((a, c) => a + c.w * z + gap, 0), crops[0].h * z + 2 * gap, 40, 40, 40);
      let at = gap;
      for (const c of crops) {
        paste(strip, c, at, gap, 0, 0, c.w, c.h, z);
        at += c.w * z + gap;
      }
      const stripFile = path.join(out, `icons-${size.name}.png`);
      savePng(stripFile, strip);
      console.log(stripFile);
      console.log(`${size.name}: the speaker icon in ${[...icons.values()].reduce((a, b) => a + b, 0)} shots: muted in all (the "muted" class, rust ink in every one; its edges blend with the scene behind)`);
    }
  } finally {
    if (opened) await ab(["close"]).catch(() => "");
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    rmSync(dist, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const one = args.includes("--track") ? args[args.indexOf("--track") + 1] : null;
  const ids = one ? [one] : BR_TRACK_IDS;
  if (args.includes("--shots")) {
    const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "";
    if (!out) throw new Error("br-tracks --shots: give --out <dir>");
    await shots(ids, path.resolve(out), Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 3011));
    return;
  }
  for (const id of ids) {
    const t = trackById(id), b = t.branches[0];
    console.log(`## ${t.def.name} (${id}): shortcut main ${b.s0}..${b.s1} (${(b.s1 - b.s0).toFixed(0)}), ${b.road.length.toFixed(0)} long, half-width ${b.road.def.halfWidth}`);
    if (args.includes("--gain")) {
      console.log("clean laps, one bot alone, weapons off, median of 3 (s): main | shortcut | gain");
      for (const g of gainRows(id)) console.log(`  ${g.level.padEnd(6)} ${g.car.padEnd(5)} ${f2(g.main)} | ${f2(g.cut)} | ${f2(g.gain)}${g.falls ? `  falls ${g.falls}` : ""}`);
    }
    if (args.includes("--fall")) {
      console.log("lap 2 (s): main | shortcut clean | shortcut with one fall at its hazard | the fall's cost against the main road");
      for (const f of fallCost(id)) console.log(`  ${f.level.padEnd(6)} ${f.car.padEnd(5)} ${f2(f.main2)} | ${f2(f.clean2)} | ${f2(f.fall2)} (falls ${f.falls}) | ${f.cost >= 0 ? "+" : ""}${f2(f.cost)}`);
    }
    if (args.includes("--clear")) {
      console.log("hazards against the other road (centreline; corridor edge), rule > 240:");
      for (const c of hazardClearance(t)) console.log(`  ${c.what}: ${c.dist.toFixed(1)}; ${c.edge.toFixed(1)}${c.dist > 240 ? "" : "  UNDER 240"}`);
    }
  }
}

if (process.argv[1]?.endsWith("br-tracks.ts")) await main();
