// branch-yard (BR-SCHEMA, PLAN-BRANCH.md 2.8, 2.10): a track's shortcut roads in numbers and on paper,
// no browser. Per branch: its length against the main road's from fork to merge (the gain, in units and
// as seconds at a nominal speed: an estimate, not a bot's lap: BR-BOTS measures those), its half-width,
// each gore (u, s, the centrelines' angle), each mouth's length, where each gore's nose zone ends (the
// first sample BRANCH_SEP clear of the main road), the closest the corridors come past the noses, its
// dirt (each patch's length), ramps, gaps and holes, and how much of it is "out of sight" (more than
// --sight units from every main centreline point); a probe of the union round every mouth (is a point
// inside the nearer road's wall exactly when it is inside either road's corridor, advisor change 1);
// then validateTrack. --png file.png draws the roads (asphalt edges grey, walls black, centrelines,
// noses red, dirt brown, holes and gaps dark, ramps orange; 1 px = --scale units).
// unionProbe is used by scripts/sim-test.ts.
//
//   npx tsx tools/debug/branch-yard.ts                       Branch Yard (shared/testtracks.ts)
//   npx tsx tools/debug/branch-yard.ts --png tmp/branch-yard.png --scale 6
//   npx tsx tools/debug/branch-yard.ts --track <test track id>

import { BRANCH_GUIDE, BRANCH_SEP, buildTrack, halfOn, LOCAL_WINDOW, pointAt, queryRoads, queryTrack, roadOf, segDir, validateTrack, type Track, type Vec } from "../../shared/track";
import { BRANCH_YARD, TEST_TRACKS } from "../../shared/testtracks";
import { blank, savePng, type Picture } from "./png";

const f1 = (v: number) => v.toFixed(1);

/** Inside road r's corridor: its own nearest centreline point (the whole road) within its wall there. */
function inside(r: Track, x: number, y: number): boolean {
  const q = queryTrack(r, x, y);
  return q.dist <= halfOn(r, q.seg, q.s, q.side) + r.def.verge;
}

/**
 * The union (PLAN-BRANCH 2.3, advisor change 1): round each mouth, from BRANCH_GUIDE before the fork to
 * 2 * LOCAL_WINDOW segments past the gore (and the same at the merge), points every `step` units across
 * both corridors and beyond (3 walls either side of the branch's centreline): is a point inside the
 * nearer road's wall (queryRoads, the rule physics and the bake share) exactly when it is inside either
 * road's corridor? Returns the points probed and those where the two disagree (the first few described).
 */
export function unionProbe(t: Track, step = 3): { probes: number; wrong: number; first: string[] } {
  let probes = 0, wrong = 0;
  const first: string[] = [];
  for (const [k, b] of t.branches.entries()) {
    const r = b.road;
    for (const [g, sign] of [[b.forkGore, 1], [b.mergeGore, -1]] as const) {
      if (!g) continue;
      const reach = 2 * LOCAL_WINDOW * (r.length / (r.pts.length - 1));
      const u0 = sign > 0 ? -BRANCH_GUIDE : g.u - reach, u1 = sign > 0 ? g.u + reach : r.length + BRANCH_GUIDE;
      for (let u = u0; u <= u1; u += step) {
        const p = u < 0 ? pointAt(t, b.s0 + u) : u > r.length ? pointAt(t, b.s1 + u - r.length) : pointAt(r, u);
        const nx = -Math.sin(p.h), ny = Math.cos(p.h);
        for (let lat = -3 * t.wall; lat <= 3 * t.wall; lat += step) {
          const x = p.x + nx * lat, y = p.y + ny * lat;
          const q = queryRoads(t, x, y);
          const rq = roadOf(t, q.road);
          const near = q.dist <= halfOn(rq, q.seg, q.s, q.side) + rq.def.verge;
          const union = inside(t, x, y) || inside(r, x, y);
          probes++;
          if (near !== union) {
            wrong++;
            if (first.length < 5) first.push(`branch ${k + 1} u ${f1(u)} lat ${f1(lat)}: the nearer road (${q.road}) says ${near ? "in" : "out"}, the union ${union ? "in" : "out"}`);
          }
        }
      }
    }
  }
  return { probes, wrong, first };
}

function report(t: Track, nominal: number, sight: number): void {
  console.log(`${t.def.id}: main ${f1(t.length)} long, wall ${t.wall}, ${t.pts.length} samples, ${t.branches.length} branch(es)`);
  for (const [k, b] of t.branches.entries()) {
    const r = b.road, fg = b.forkGore, mg = b.mergeGore;
    const mainLen = b.s1 - b.s0, gain = mainLen - r.length;
    console.log(`\nbranch ${k + 1}: main ${f1(b.s0)}..${f1(b.s1)} (${f1(mainLen)}), side ${b.side}, half-width ${r.def.halfWidth}, ${r.pts.length} samples, base ${b.base}`);
    console.log(`  length ${f1(r.length)}: gain ${f1(gain)} units = ${(gain / nominal).toFixed(2)} s at ${nominal} u/s (estimate)`);
    for (const [g, name] of [[fg, "fork"], [mg, "merge"]] as const) {
      if (!g) {
        console.log(`  ${name} gore: none (the corridors never part)`);
        continue;
      }
      const mouth = name === "fork" ? Math.max(g.u, g.s - b.s0) : Math.max(r.length - g.u, b.s1 - g.s);
      console.log(`  ${name} gore: u ${f1(g.u)}, s ${f1(g.s)}, angle ${((g.angle * 180) / Math.PI).toFixed(1)} deg, mouth ${f1(mouth)}, nose (${f1(g.x)}, ${f1(g.y)}) lat ${f1(g.noseMain.lat)}`);
    }
    // The gap to the main road along the branch, and the out-of-sight stretch.
    let open0 = NaN, open1 = NaN, minGap = Infinity, minAt = 0, far = 0, farMax = 0;
    const gaps: number[] = [];
    for (let i = 0; i < r.pts.length; i++) {
      const p = r.pts[i];
      const q = queryTrack(t, p.x, p.y);
      const d = segDir(r, i);
      const qx = p.x - q.nx * q.dist, qy = p.y - q.ny * q.dist;
      const wA = d.x * (qy - p.y) - d.y * (qx - p.x) < 0 ? r.wallL[i] : r.wallR[i];
      const gap = q.dist - wA - t.wall;
      const u = r.cum[i];
      if (fg && u > fg.u && Number.isNaN(open0) && gap >= BRANCH_SEP) open0 = u;
      if (mg && u < mg.u && gap >= BRANCH_SEP) open1 = u;
      gaps.push(gap);
      if (q.dist > sight) far += i > 0 ? r.cum[i] - r.cum[i - 1] : 0;
      farMax = Math.max(farMax, q.dist);
    }
    for (let i = 0; i < r.pts.length; i++) if (r.cum[i] >= open0 && r.cum[i] <= open1 && gaps[i] < minGap) { minGap = gaps[i]; minAt = r.cum[i]; }
    console.log(`  noses end at u ${f1(open0)} and ${f1(open1)} (first/last sample ${BRANCH_SEP} clear); closest between them: gap ${f1(minGap)} at u ${f1(minAt)}`);
    console.log(`  farthest from the main centreline ${f1(farMax)}; ${f1(far)} units more than ${sight} from it (out of sight)`);
    for (const d of r.dirt) console.log(`  dirt u ${f1(d.s0)}..${f1(d.s1)}: ${f1(d.s1 - d.s0)} long, lat ${d.lat0}..${d.lat1}`);
    for (const x of r.ramps) console.log(`  ramp u ${f1(x.s)} len ${x.len}`);
    for (const x of r.gaps) console.log(`  gap u ${f1(x.s0)}..${f1(x.s1)}: ${f1(x.s1 - x.s0)}`);
    for (const x of r.holes) console.log(`  hole u ${f1(x.s)} lat ${x.lat} r ${x.r}`);
    console.log(`  recovery u ${r.recovery.map(f1).join(", ") || "none"}`);
  }
  const u = unionProbe(t);
  console.log(`\nunion probe: ${u.probes} points round the mouths, ${u.wrong} where the nearer road's wall and the union of the corridors disagree${u.first.length ? `: ${u.first.join("; ")}` : ""}`);
  const errs = validateTrack(t);
  console.log(`\nvalidateTrack: ${errs.length ? errs.join("\n  ") : "valid"}`);
}

function draw(t: Track, png: string, scale: number): void {
  const roads = [t, ...t.branches.map((b) => b.road)];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of roads) for (const p of r.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = 2 * t.wall;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const pic = blank(Math.ceil((x1 - x0) / scale), Math.ceil((y1 - y0) / scale), 112, 150, 96);
  const plot = (x: number, y: number, c: [number, number, number]) => {
    const px = Math.floor((x - x0) / scale), py = Math.floor((y - y0) / scale);
    if (px < 0 || py < 0 || px >= pic.w || py >= pic.h) return;
    const o = (py * pic.w + px) * 4;
    pic.data[o] = c[0]; pic.data[o + 1] = c[1]; pic.data[o + 2] = c[2]; pic.data[o + 3] = 255;
  };
  const line = (a: Vec, b: Vec, c: [number, number, number]) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (scale / 2)));
    for (let k = 0; k <= steps; k++) plot(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps, c);
  };
  const offset = (r: Track, i: number, lat: number): Vec => {
    const n = r.pts.length;
    const a = segDir(r, r.roadNo > 0 ? Math.max(0, i - 1) : (i - 1 + n) % n), b = segDir(r, i);
    let dx = a.x + b.x, dy = a.y + b.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    return { x: r.pts[i].x - dy * lat, y: r.pts[i].y + dx * lat };
  };
  const at = (r: Track, s: number, lat: number): Vec => {
    const p = pointAt(r, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
  };
  for (const r of roads) {
    const segs = r.roadNo > 0 ? r.pts.length - 1 : r.pts.length;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % r.pts.length;
      line(offset(r, i, -r.halfL[i]), offset(r, j, -r.halfL[j]), [150, 150, 150]);
      line(offset(r, i, r.halfR[i]), offset(r, j, r.halfR[j]), [150, 150, 150]);
      line(offset(r, i, -r.wallL[i]), offset(r, j, -r.wallL[j]), [20, 20, 20]);
      line(offset(r, i, r.wallR[i]), offset(r, j, r.wallR[j]), [20, 20, 20]);
      if (i % 2 === 0) line(r.pts[i], r.pts[j], r.roadNo > 0 ? [40, 90, 200] : [240, 240, 240]);
    }
    for (const d of r.dirt) for (let s = d.s0; s <= d.s1; s += scale) line(at(r, s, d.lat0), at(r, s, d.lat1), [140, 100, 50]);
    for (const g of r.gaps) for (let s = g.s0; s <= g.s1; s += scale) line(at(r, s, -r.wall), at(r, s, r.wall), [30, 20, 20]);
    for (const x of r.ramps) for (let s = x.s; s <= x.s + x.len; s += scale) line(at(r, s, -r.def.halfWidth), at(r, s, r.def.halfWidth), [230, 140, 40]);
    for (const h of r.holes) for (let a = 0; a < 64; a++) line({ x: h.x, y: h.y }, { x: h.x + Math.cos(a / 10) * h.r, y: h.y + Math.sin(a / 10) * h.r }, [30, 20, 20]);
  }
  for (const b of t.branches) {
    for (const g of [b.forkGore, b.mergeGore]) {
      if (!g) continue;
      for (let a = 0; a < 64; a++) line({ x: g.x, y: g.y }, { x: g.x + Math.cos(a / 10) * g.noseMain.r, y: g.y + Math.sin(a / 10) * g.noseMain.r }, [220, 30, 30]);
    }
  }
  savePng(png, pic as Picture);
  console.log(`written ${png} (${pic.w}x${pic.h}, 1 px = ${scale} units)`);
}

if (process.argv[1]?.endsWith("branch-yard.ts")) {
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(k);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
  };
  const id = arg("--track", BRANCH_YARD.id);
  const def = TEST_TRACKS.find((d) => d.id === id);
  if (!def) throw new Error(`no test track ${id}`);
  const t = buildTrack(def);
  // --speed: units/s for the seconds estimate; --sight: about half the view's diagonal at the game's zoom.
  report(t, Number(arg("--speed", "380")), Number(arg("--sight", "450")));
  const png = arg("--png", "");
  if (png) draw(t, png, Number(arg("--scale", "6")));
}
