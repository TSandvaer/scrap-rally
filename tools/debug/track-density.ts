// track-density (M4-TRACKS, ClickUp 123jpnbffz6): how packed a track is, and how the bots race it, no browser.
// The user's rules for the long tracks (PLAN-M4.md "User feedback for M4-TRACKS"): obstacles in spaced
// groups with clear road between them, never two obstacle kinds back to back without a breather,
// plain racing stretches between the feature sections; no dirt stretch longer than ~350 units.
//
//   npx tsx tools/debug/track-density.ts                 the density report of the two long tracks
//   npx tsx tools/debug/track-density.ts --all           ... of every track there is (shipped and test tracks)
//   npx tsx tools/debug/track-density.ts --race          ... and the bot races on the two long tracks
//   npx tsx tools/debug/track-density.ts --png <dir>     ... and a map of each: <dir>/density-<id>.png
//   --track <id>                                         one track only
//
// The density report, per track:
// - every feature's footprint along the track (s0..s1: a ramp to the end of its take-off zone, a
//   gap, a pit or a tyre mound across its diameter, a barrel row its barrels' width, a press its
//   depth, a truck rear to cab, a pool, dirt patch or belt its rectangle, a widen with its tapers);
// - each footprint's kind: split (a widen, its island and whatever lies inside the widen), jump (a
//   ramp, its gap and an air cell over it), truck (a ramp truck and the air cell over its flight),
//   tyres, pits, barrels, press, belt, water, dirt, and kerb cell (a ground cell on its own: a
//   pickup, not an obstacle);
// - groups: footprints less than GROUP_JOIN apart along the track are one group (one section a
//   driver meets at once), and so are footprints of the same kind less than SAME_JOIN apart (two
//   rows of barrels, a chicane of mounds); a group with more than one kind is "mixed" (two kinds
//   back to back without a breather);
// - the breather: the shortest road between two obstacles of different kinds, round the lap;
// - the plain-road share: the share of the lap with no footprint at all (cells included), and the
//   obstacle-free share (kerb cells allowed); the longest plain stretch;
// - the gaps between consecutive obstacle groups, round the lap, and the shortest;
// - every dirt stretch: its declared length (the rule's ~350), its traction length (12 less at
//   each end), where it lies across the road and whether it is a split lane;
// - the straights: runs where the heading stays within STRAIGHT_TOL of where the run began (the
//   drafting straights), the longest three, and what lies on each.
//
// --race (the two long tracks): server bots in a Room on the sim clock, the host retired at GO,
// 3 laps, three bots per level (Easy, Normal, Hard; Sport, Racer, Truck by add order) with weapons
// off and on, and five mixed bots with weapons (Hard, Normal, Easy, Hard, Normal); every race run
// twice (a rerun must be identical). Per bot: each lap's time, falls, wrecks, wall hits (>= 50 u/s),
// and the ticks in contact with a tyre mound, an island's side or nose, a barrel, a press that is
// down and a truck's body (the probes of surf-tune.ts, split-tune.ts and move-tune.ts, independent of
// shared/physics.ts), truck jumps and ramp jumps, ticks on dirt and on water, the lane taken round
// each island lap by lap.

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BotLevel } from "../../shared/botdrive";
import type { CarState } from "../../shared/physics";
import type { ServerMsg } from "../../shared/protocol";
import { TEST_TRACKS, testTrack } from "../../shared/testtracks";
import { trackById, trackList } from "../../shared/tracks";
import { LIP_ZONE, pointAt, queryTrackNear, SURF_DIRT, SURF_WATER, surfaceAt, tractionRect, type Track } from "../../shared/track";
import { CAR_HP } from "../../shared/weapons";
import { wallHitSpeed } from "../../client/game";
import { Room, type Conn, type Player, type Session } from "../../server/room";
import { moveContact } from "./move-tune";
import { blank, savePng } from "./png";
import { islandContact } from "./split-tune";
import { touchesMound } from "./surf-tune";

/** The two long tracks (shared/longtracks.ts). */
export const LONG_TRACK_IDS = ["slag-harbour", "breakers-mile"];
/** Footprints closer than this along the track are one group (about 0.7 s at 430 u/s) ... */
export const GROUP_JOIN = 300;
/** ... and footprints of the same kind closer than this (about 1.6 s): one section of rows or mounds. */
export const SAME_JOIN = 700;
/** A straight: the heading stays within this (radians, ~4 degrees) of where it began. */
export const STRAIGHT_TOL = 0.07;
/** An air cell belongs to the jump (or truck) whose take-off is at most this far before it. */
const AIR_CELL_REACH = 600;

export interface Footprint {
  what: string;
  kind: string;
  s0: number;
  s1: number;
  obstacle: boolean; // false: a kerb cell (a pickup on its own)
}

export interface Group {
  s0: number;
  s1: number; // may be past the track's length (a group over the start line)
  kinds: string[];
  members: string[];
}

export interface Mud {
  s0: number;
  s1: number;
  length: number; // declared (the rule's ~350)
  traction: number; // what a car feels (tractionRect)
  lat0: number;
  lat1: number;
  splitLane: boolean;
}

export interface Straight {
  s0: number;
  s1: number;
  length: number;
  on: string[]; // the footprints on it
  plain: number; // its longest run with no footprint on it
}

export interface Density {
  id: string;
  name: string;
  length: number;
  footprints: Footprint[];
  groups: Group[];
  gaps: number[]; // gaps[i]: from groups[i]'s end to the next group's start, round the lap
  shortestGap: number;
  breather: { gap: number; a: string; b: string }; // the shortest road between two obstacles of different kinds
  mixed: Group[];
  plain: number; // share of the lap with no footprint at all
  clear: number; // share with no obstacle (kerb cells allowed)
  longestPlain: number;
  mud: Mud[];
  straights: Straight[];
}

const f0 = (v: number) => v.toFixed(0);

/** Every feature's footprint along the track, with its kind (see the top of this file). */
export function footprints(t: Track): Footprint[] {
  const out: Footprint[] = [];
  const inWiden = (s0: number, s1: number) => t.widens.some((w) => s0 >= w.s0 && s1 <= w.s1);
  for (const w of t.widens) out.push({ what: `widen ${f0(w.s0)}..${f0(w.s1)}`, kind: "split", s0: w.s0, s1: w.s1, obstacle: true });
  for (const i of t.islands) out.push({ what: `island ${f0(i.s0)}..${f0(i.s1)}`, kind: "split", s0: i.s0, s1: i.s1, obstacle: true });
  const surf = (name: string, kind: string, f: { s0: number; s1: number }) =>
    out.push({ what: `${name} ${f0(f.s0)}..${f0(f.s1)}`, kind: inWiden(f.s0, f.s1) ? "split" : kind, s0: f.s0, s1: f.s1, obstacle: true });
  for (const w of t.water) surf("water", "water", w);
  for (const d of t.dirt) surf("dirt", "dirt", d);
  for (const b of t.belts) surf("belt", "belt", b);
  for (const r of t.ramps) out.push({ what: `ramp ${f0(r.s)}`, kind: "jump", s0: r.s, s1: r.s + r.len + LIP_ZONE, obstacle: true });
  for (const g of t.gaps) out.push({ what: `gap ${f0(g.s0)}..${f0(g.s1)}`, kind: "jump", s0: g.s0, s1: g.s1, obstacle: true });
  for (const h of t.holes) out.push({ what: `pit ${f0(h.s)}`, kind: inWiden(h.s - h.r, h.s + h.r) ? "split" : "pits", s0: h.s - h.r, s1: h.s + h.r, obstacle: true });
  for (const m of t.tyres) out.push({ what: `tyres ${f0(m.s)}`, kind: inWiden(m.s - m.r, m.s + m.r) ? "split" : "tyres", s0: m.s - m.r, s1: m.s + m.r, obstacle: true });
  for (const b of t.barrels) out.push({ what: `barrels ${f0(b.s)}`, kind: "barrels", s0: b.s - 9, s1: b.s + 9, obstacle: true });
  for (const p of t.presses) out.push({ what: `press ${f0(p.s)}`, kind: "press", s0: p.s - 12, s1: p.s + 12, obstacle: true });
  for (const k of t.trucks) out.push({ what: `truck ${f0(k.s)}`, kind: "truck", s0: k.s, s1: k.s + k.len, obstacle: true });
  for (const c of t.cells) {
    const s0 = c.s - 14, s1 = c.s + 14;
    if (c.air) {
      const ahead = (lip: number) => c.s - lip >= 0 && c.s - lip <= AIR_CELL_REACH;
      const jump = t.ramps.some((r) => ahead(r.s + r.len));
      const truck = t.trucks.some((k) => ahead(k.lip));
      out.push({ what: `air cell ${f0(c.s)}`, kind: truck && !jump ? "truck" : "jump", s0, s1, obstacle: true });
    } else {
      out.push({ what: `cell ${f0(c.s)}`, kind: inWiden(s0, s1) ? "split" : "kerb cell", s0, s1, obstacle: inWiden(s0, s1) });
    }
  }
  return out.sort((a, b) => a.s0 - b.s0 || a.s1 - b.s1);
}

/** Footprints less than GROUP_JOIN apart (SAME_JOIN for the same kind), merged into groups round the lap (a group may run over the start line). */
export function groupsOf(t: Track, list: Footprint[]): Group[] {
  const L = t.length;
  const groups: Group[] = [];
  for (const f of list) {
    const g = groups[groups.length - 1];
    if (g && f.s0 - g.s1 < (g.kinds.length === 1 && g.kinds[0] === f.kind ? SAME_JOIN : GROUP_JOIN)) {
      g.s1 = Math.max(g.s1, f.s1);
      if (!g.kinds.includes(f.kind)) g.kinds.push(f.kind);
      g.members.push(f.what);
    } else groups.push({ s0: f.s0, s1: f.s1, kinds: [f.kind], members: [f.what] });
  }
  // Over the start line: the last group joins the first one when they are that close round the lap.
  if (groups.length > 1) {
    const last = groups[groups.length - 1], first = groups[0];
    const same = first.kinds.length === 1 && last.kinds.length === 1 && first.kinds[0] === last.kinds[0];
    if (first.s0 + L - last.s1 < (same ? SAME_JOIN : GROUP_JOIN)) {
      groups.pop();
      first.s0 = last.s0 - L;
      for (const k of last.kinds) if (!first.kinds.includes(k)) first.kinds.push(k);
      first.members.unshift(...last.members);
    }
  }
  return groups;
}

/** The length of the union of the footprints (clipped to the lap). */
function covered(t: Track, list: Footprint[]): { length: number; longestFree: number } {
  const L = t.length;
  const spans = list.map((f) => [Math.max(0, f.s0), Math.min(L, f.s1)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let len = 0, at = -Infinity, longest = 0, firstStart = spans.length ? spans[0][0] : L;
  for (const [a, b] of spans) {
    if (a > at) {
      if (at > -Infinity) longest = Math.max(longest, a - at);
      len += b - a;
      at = b;
    } else if (b > at) {
      len += b - at;
      at = b;
    }
  }
  longest = Math.max(longest, spans.length ? L - at + firstStart : L); // round the start line
  return { length: len, longestFree: longest };
}

/** The straights: maximal runs of samples whose heading stays within STRAIGHT_TOL of the run's first, at least 300 long. */
export function straightsOf(t: Track, list: Footprint[]): Straight[] {
  const { pts, cum } = t;
  const n = pts.length;
  const head = (i: number) => {
    const a = pts[i % n], b = pts[(i + 1) % n];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const runs: Straight[] = [];
  for (let i = 0; i < n; i++) {
    const h0 = head(i);
    let j = i;
    while (j - i < n) {
      const d = head(j + 1) - h0;
      if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > STRAIGHT_TOL) break;
      j++;
    }
    const s0 = cum[i], s1 = cum[i] + (cum[Math.min(j + 1, n)] - cum[i]) + (j + 1 > n ? cum[(j + 1) % n] : 0);
    runs.push({ s0, s1, length: s1 - s0, on: [], plain: 0 });
  }
  // Keep the longest runs that do not overlap one taken already.
  runs.sort((a, b) => b.length - a.length);
  const kept: Straight[] = [];
  for (const r of runs) {
    if (r.length < 300) break;
    const L = t.length;
    if (kept.some((k) => [0, L, -L].some((off) => r.s0 + off < k.s1 && k.s0 < r.s1 + off))) continue;
    kept.push(r);
  }
  for (const k of kept) {
    const L = t.length;
    const cuts: [number, number][] = [];
    for (const f of list) {
      for (const off of [0, L]) {
        if (f.s0 + off < k.s1 && k.s0 < f.s1 + off) {
          if (!k.on.includes(f.what)) k.on.push(f.what);
          cuts.push([Math.max(k.s0, f.s0 + off), Math.min(k.s1, f.s1 + off)]);
        }
      }
    }
    cuts.sort((a, b) => a[0] - b[0]);
    let at = k.s0;
    for (const [a, b] of cuts) {
      k.plain = Math.max(k.plain, a - at);
      at = Math.max(at, b);
    }
    k.plain = Math.max(k.plain, k.s1 - at);
  }
  return kept.slice(0, 3);
}

export function densityOf(t: Track): Density {
  const L = t.length;
  const list = footprints(t);
  const obstacles = list.filter((f) => f.obstacle);
  const groups = groupsOf(t, obstacles);
  const gaps = groups.map((g, i) => {
    const next = groups[(i + 1) % groups.length];
    return (next.s0 - g.s1 + L * (i + 1 === groups.length ? 1 : 0) + L) % L;
  });
  const all = covered(t, list), obs = covered(t, obstacles);
  let breather = { gap: Infinity, a: "", b: "" };
  for (const a of obstacles) {
    for (const b of obstacles) {
      if (a.kind === b.kind) continue;
      const gap = Math.max(0, Math.min(...[0, L, -L].map((off) => Math.max(b.s0 + off - a.s1, a.s0 - b.s1 - off))));
      if (gap < breather.gap) breather = { gap, a: a.what, b: b.what };
    }
  }
  const mud: Mud[] = t.dirt.map((d) => {
    const tr = tractionRect(d);
    return {
      s0: d.s0, s1: d.s1, length: d.s1 - d.s0, traction: Math.max(0, tr.s1 - tr.s0), lat0: d.lat0, lat1: d.lat1,
      splitLane: t.islands.some((i) => d.s0 < i.s1 && d.s1 > i.s0 && (d.lat0 >= i.lat1 || d.lat1 <= i.lat0)),
    };
  });
  return {
    id: t.def.id, name: t.def.name, length: L, footprints: list, groups, gaps,
    shortestGap: gaps.length > 1 ? Math.min(...gaps) : gaps.length ? gaps[0] : L, breather,
    mixed: groups.filter((g) => g.kinds.length > 1),
    plain: 1 - all.length / L, clear: 1 - obs.length / L, longestPlain: all.longestFree, mud, straights: straightsOf(t, list),
  };
}

export function densityReport(d: Density): string[] {
  const pc = (v: number) => `${(v * 100).toFixed(1)} %`;
  const out = [`## ${d.name} (${d.id}): lap ${f0(d.length)} units`];
  out.push(`plain road (nothing on it, cells included): ${pc(d.plain)} of the lap; obstacle-free (kerb cells allowed): ${pc(d.clear)}; longest plain stretch ${f0(d.longestPlain)}`);
  out.push(`obstacle groups (footprints < ${GROUP_JOIN} apart, of one kind < ${SAME_JOIN}, are one group): ${d.groups.length}; shortest gap between two groups ${f0(d.shortestGap)}; mixed groups (two kinds back to back): ${d.mixed.length ? d.mixed.map((g) => `${f0(g.s0)}..${f0(g.s1)} [${g.kinds.join("+")}]`).join(", ") : "none"}`);
  out.push(`shortest breather between two obstacles of different kinds: ${f0(d.breather.gap)} (${d.breather.a} | ${d.breather.b})`);
  d.groups.forEach((g, i) => {
    out.push(`  group ${i + 1}: s ${f0(g.s0)}..${f0(g.s1)} (${f0(g.s1 - g.s0)} long) ${g.kinds.join("+")}: ${g.members.join(", ")}; then ${f0(d.gaps[i])} of road with no obstacle`);
  });
  out.push(`dirt stretches (rule: <= ~350 declared): ${d.mud.length ? d.mud.map((m) => `${f0(m.s0)}..${f0(m.s1)} = ${f0(m.length)} (traction ${f0(m.traction)}), lat ${f0(m.lat0)}..${f0(m.lat1)}${m.splitLane ? ", a split lane" : ""}`).join("; ") : "none"}`);
  out.push(`longest straights (heading within ${(STRAIGHT_TOL * 180 / Math.PI).toFixed(0)} deg): ${d.straights.map((s) => `${f0(s.s0)}..${f0(s.s1)} = ${f0(s.length)}${s.on.length ? ` (on it: ${s.on.join(", ")}; its longest plain run ${f0(s.plain)})` : " (plain)"}`).join("; ")}`);
  return out;
}

// ---- the map ----------------------------------------------------------------------------------

const KIND_RGB: Record<string, [number, number, number]> = {
  split: [220, 70, 70], jump: [240, 160, 30], truck: [0, 200, 200], tyres: [200, 200, 200], pits: [120, 0, 120], barrels: [240, 120, 0],
  press: [170, 40, 220], belt: [220, 220, 40], water: [40, 110, 230], dirt: [160, 110, 40], "kerb cell": [255, 240, 0],
};

/** A map of the track: the corridor, every feature, a band outside the right wall (green: plain road; a kind's colour: its footprint), s every 1000 (white, red every 5000), recovery points (green). */
export function densityPng(t: Track, file: string, W = 1100): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of t.pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const pad = 260;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const sc = W / (x1 - x0), H = Math.ceil((y1 - y0) * sc);
  const pic = blank(W, H, 30, 40, 30);
  const put = (x: number, y: number, c: readonly number[], rad = 0) => {
    const px = Math.round((x - x0) * sc), py = Math.round((y - y0) * sc);
    for (let j = -rad; j <= rad; j++) {
      for (let i = -rad; i <= rad; i++) {
        const X = px + i, Y = py + j;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        pic.data.set([c[0], c[1], c[2]], (Y * W + X) * 4);
      }
    }
  };
  const at = (s: number, lat: number) => {
    const p = pointAt(t, s);
    return { x: p.x - Math.sin(p.h) * lat, y: p.y + Math.cos(p.h) * lat };
  };
  const step = 1 / sc / 1.5;
  const fill = (s0: number, s1: number, l0: number, l1: number, c: readonly number[]) => {
    for (let s = s0; s <= s1; s += step) for (let lat = l0; lat <= l1; lat += step) { const p = at(s, lat); put(p.x, p.y, c); }
  };
  const disc = (s: number, lat: number, r: number, c: readonly number[]) => {
    for (let ds = -r; ds <= r; ds += step) for (let dl = -r; dl <= r; dl += step) if (ds * ds + dl * dl <= r * r) { const p = at(s + ds, lat + dl); put(p.x, p.y, c); }
  };
  for (let s = 0; s < t.length; s += step) {
    const i = pointAt(t, s).seg;
    for (let lat = -t.wallL[i]; lat <= t.wallR[i]; lat += step) {
      const p = at(s, lat);
      put(p.x, p.y, lat >= -t.halfL[i] && lat <= t.halfR[i] ? [70, 70, 76] : [112, 92, 62]);
    }
  }
  // The band: plain (green) or the kind of the footprint there.
  const list = footprints(t);
  for (let s = 0; s < t.length; s += step) {
    const i = pointAt(t, s).seg;
    const f = list.find((g) => s >= g.s0 && s <= g.s1);
    const c = f ? KIND_RGB[f.kind] ?? [255, 255, 255] : [60, 170, 60];
    for (let lat = t.wallR[i] + 18; lat <= t.wallR[i] + 40; lat += step) { const p = at(s, lat); put(p.x, p.y, c); }
  }
  for (const w of t.water) fill(w.s0, w.s1, w.lat0, w.lat1, KIND_RGB.water);
  for (const d of t.dirt) fill(d.s0, d.s1, d.lat0, d.lat1, KIND_RGB.dirt);
  for (const b of t.belts) fill(b.s0, b.s1, b.lat0, b.lat1, KIND_RGB.belt);
  for (const i of t.islands) fill(i.s0, i.s1, i.lat0, i.lat1, [200, 60, 60]);
  for (const g of t.gaps) fill(g.s0, g.s1, -t.wall, t.wall, [0, 0, 0]);
  for (const r of t.ramps) fill(r.s, r.s + r.len, -t.def.halfWidth, t.def.halfWidth, KIND_RGB.jump);
  for (const h of t.holes) disc(h.s, h.lat, h.r, [0, 0, 0]);
  for (const m of t.tyres) disc(m.s, m.lat, m.r, [20, 20, 20]);
  for (const b of t.barrels) fill(b.s - 9, b.s + 9, -t.wall, t.wall, KIND_RGB.barrels);
  for (const p of t.presses) fill(p.s - 12, p.s + 12, p.lat0, p.lat1, KIND_RGB.press);
  for (const k of t.trucks) fill(k.s, k.s + k.len, k.lat - 20, k.lat + 20, KIND_RGB.truck);
  for (const c of t.cells) disc(c.s, c.lat, 14, c.air ? [255, 255, 255] : KIND_RGB["kerb cell"]);
  for (let s = 0; s < t.length; s += 1000) { const p = at(s, 0); put(p.x, p.y, s % 5000 === 0 ? [255, 0, 0] : [255, 255, 255], s % 5000 === 0 ? 4 : 2); }
  for (const r of t.recovery) { const p = at(r, 0); put(p.x, p.y, [0, 255, 0], 3); }
  savePng(file, pic);
}

// ---- the races --------------------------------------------------------------------------------

class HostConn implements Conn {
  readonly msgs: ServerMsg[] = [];
  send(m: ServerMsg): void {
    if (m.t === "results") this.msgs.push(m);
  }
  close(): void {}
}

export interface LongRace {
  track: string;
  phase: string;
  ticks: number;
  finish: string[]; // name:seconds in finish order
  cars: string[]; // by add order
  laps: number[][]; // per bot, each lap's time (s)
  falls: number[];
  wrecks: number[];
  walls: number[];
  mounds: number[];
  sides: number[];
  noses: number[];
  barrels: number[];
  presses: number[];
  trucks: number[];
  truckJumps: number[];
  rampJumps: number[];
  cells: number[]; // lightning cells taken (a boost starts or is topped up)
  waits: number[]; // ticks standing (< 20 u/s) within 120 before a press
  dirt: number[]; // ticks on dirt
  water: number[]; // ticks on water
  lanes: string[][]; // per bot, per island: "L"/"R" lap by lap
  digest: string;
}

/** A race of server bots of `levels` on a registered track, the host retired at GO; weapons false: no bot shoots or drops a mine. */
export function longRace(trackId: string, levels: BotLevel[], laps = 3, weapons = true): LongRace {
  const room = new Room("LONG", laps, CAR_HP, trackId);
  let now = 1000, tick = 0;
  const conn = new HostConn();
  const host = room.addPlayer("Host", { conn, room: null, player: null } as Session, now) as Player;
  const bots = levels.map((l) => {
    const b = room.addBot(host, l, now);
    if (typeof b === "string") throw new Error(b);
    if (!weapons) b.bot!.mem.weapons = false;
    return b;
  });
  const e = room.start(host, now);
  if (e) throw new Error(e);
  const step = () => {
    tick++;
    now += 1000 / 60;
    room.tick(tick, now);
  };
  while (room.phase !== "racing") step();
  if (room.retire(host)) throw new Error("retire");
  const t = room.track;
  const n = bots.length;
  const zero = () => Array(n).fill(0) as number[];
  const out: LongRace = {
    track: trackId, phase: "", ticks: 0, finish: [], cars: bots.map((b) => b.carType), laps: bots.map(() => []), falls: zero(), wrecks: zero(),
    walls: zero(), mounds: zero(), sides: zero(), noses: zero(), barrels: zero(), presses: zero(), trucks: zero(), truckJumps: zero(),
    rampJumps: zero(), cells: zero(), waits: zero(), dirt: zero(), water: zero(), lanes: bots.map(() => t.islands.map(() => "")), digest: "",
  };
  const prev = bots.map((b) => ({ ...b.car! }));
  const lapAt = bots.map(() => 0);
  const lapRt = bots.map(() => 0);
  const parts: number[] = [];
  while (room.phase === "racing" && out.ticks < 60 * 60 * 8) {
    step();
    out.ticks++;
    const rt = room.rt;
    bots.forEach((b, k) => {
      const c = b.car;
      if (!c) return;
      const p = prev[k];
      if (b.progress && b.progress.lap > lapAt[k]) {
        out.laps[k].push((rt - lapRt[k]) / 60);
        lapAt[k] = b.progress.lap;
        lapRt[k] = rt;
      }
      if (c.fall > 0 && p.fall === 0) out.falls[k]++;
      if (c.wreck > 0 && p.wreck === 0) out.wrecks[k]++;
      if (c.boost > p.boost + 1) out.cells[k]++;
      const q = queryTrackNear(t, c.x, c.y, c.seg);
      if (Math.hypot(c.vx, c.vy) < 20 && t.presses.some((g) => g.s - q.s > 0 && g.s - q.s < 120)) out.waits[k]++;
      if (c.air > 0 && p.air === 0) {
        if (t.trucks.some((tr) => q.s >= tr.s && q.s <= tr.s + tr.len + 20)) out.truckJumps[k]++;
        else out.rampJumps[k]++;
      }
      if (c.air === 0 && c.fall === 0 && c.wreck === 0 && p.air === 0 && !b.progress?.fin) {
        if (wallHitSpeed(p, c, t) >= 50) out.walls[k]++;
        if (touchesMound(t, c)) out.mounds[k]++;
        const isle = islandContact(t, c);
        if (isle === "side") out.sides[k]++;
        else if (isle === "nose") out.noses[k]++;
        const hit = moveContact(t, c, rt);
        if (hit === "barrel") out.barrels[k]++;
        else if (hit === "press") out.presses[k]++;
        else if (hit === "truck") out.trucks[k]++;
        const f = surfaceAt(t, q.seg, q.s, q.lat);
        if (f?.kind === SURF_DIRT) out.dirt[k]++;
        else if (f?.kind === SURF_WATER) out.water[k]++;
        const q0 = queryTrackNear(t, p.x, p.y, p.seg);
        t.islands.forEach((isl, i) => {
          const m = (isl.s0 + isl.s1) / 2;
          if (q0.s < m && q.s >= m && q.s - q0.s < 50) out.lanes[k][i] += q.lat < isl.mid ? "L" : "R";
        });
      }
      parts.push(c.x, c.y, c.vx, c.vy);
      prev[k] = { ...c } as CarState;
    });
  }
  out.phase = room.phase;
  const res = conn.msgs.filter((m): m is Extract<ServerMsg, { t: "results" }> => m.t === "results").pop();
  out.finish = res ? res.rows.filter((r) => r.name !== "Host").map((r) => `${r.name}:${(r.timeMs / 1000).toFixed(2)}`) : [];
  let h = 0;
  for (const v of parts) h = (Math.imul(h ^ Math.floor(v * 1e6), 16777619) + 1) | 0;
  out.digest = (h >>> 0).toString(16);
  return out;
}

/** One race's line for the report. */
export function longRow(name: string, r: LongRace): string {
  const j = (a: number[]) => a.join("/");
  const laps = r.laps.map((l) => l.map((x) => x.toFixed(2)).join(",")).join(" | ");
  return `${name.padEnd(18)} ${r.phase} ${(r.ticks / 60).toFixed(1)} s | cars ${r.cars.join("/")} | laps ${laps} | falls ${j(r.falls)} wrecks ${j(r.wrecks)} walls ${j(r.walls)} | mound ${j(r.mounds)} side ${j(r.sides)} nose ${j(r.noses)} barrel ${j(r.barrels)} press ${j(r.presses)} truck ${j(r.trucks)} | truck jumps ${j(r.truckJumps)} ramp jumps ${j(r.rampJumps)} | cells ${j(r.cells)} press waits ${j(r.waits)} | dirt ${j(r.dirt)} water ${j(r.water)} | lanes ${r.lanes.map((l) => l.join(":")).join(" ")} | ${r.digest}`;
}

/** The races of the report: per level 3 bots weapons off and on, and 5 mixed with weapons; each twice. */
export function raceSet(trackId: string): { name: string; a: LongRace; same: boolean }[] {
  const out: { name: string; a: LongRace; same: boolean }[] = [];
  const levels: BotLevel[] = ["easy", "normal", "hard"];
  for (const weapons of [false, true]) {
    for (const level of levels) {
      const a = longRace(trackId, [level, level, level], 3, weapons), b = longRace(trackId, [level, level, level], 3, weapons);
      out.push({ name: `${level}${weapons ? " +weapons" : ""}`, a, same: JSON.stringify(a) === JSON.stringify(b) });
    }
  }
  const mix: BotLevel[] = ["hard", "normal", "easy", "hard", "normal"];
  const a = longRace(trackId, mix, 3, true), b = longRace(trackId, mix, 3, true);
  out.push({ name: "5 mixed +weapons", a, same: JSON.stringify(a) === JSON.stringify(b) });
  return out;
}

if (process.argv[1]?.endsWith("track-density.ts")) {
  const args = process.argv.slice(2);
  const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const only = arg("--track");
  const ids = only ? [only] : args.includes("--all") ? [...trackList().map((e) => e.id), ...TEST_TRACKS.map((d) => d.id)] : LONG_TRACK_IDS;
  const png = arg("--png");
  if (png) mkdirSync(png, { recursive: true });
  for (const id of ids) {
    const t = testTrack(id) ?? trackById(id);
    console.log(densityReport(densityOf(t)).join("\n"));
    if (png) {
      const file = path.join(png, `density-${id}.png`);
      densityPng(t, file);
      console.log(`map: ${file}`);
    }
    if (args.includes("--race") && !testTrack(id)) {
      for (const r of raceSet(id)) console.log(longRow(r.name, r.a), r.same ? "rerun SAME" : "rerun DIFFERS");
    }
    console.log("");
  }
}
