// move-alloc (M4-MOVE, ClickUp 123jpnbffz5): does what moves allocate in the server's hot path? V8's
// sampling heap profiler, no browser.
//
//   npx tsx tools/debug/move-alloc.ts            five server bots, 3 laps, the Move Yard and the bare loop
//   --blind      the bots blind to the barrels and presses (botdrive MOVE.see = false): they hit them,
//                so the contact code runs (barrels, the squeeze, presses, the truck's body)
//   --interval 64   the profiler's mean sampling interval, bytes
//
// What is driven: the real server room (server/room.ts) with five server bots (Easy, Normal, Hard,
// Normal, Hard; weapons on: rivets fly past and into the barrels, the presses and the truck), on the
// Move Yard and on the same loop with nothing on it (its control points, no features), each for 3 laps
// after a warm-up race (the optimising compiler has to be done). Every sampled allocation is charged to
// the innermost function of shared/ or server/ on its stack (objects collected since included), and the
// bytes a room tick each gets are printed for the Move Yard beside the bare loop, with the totals.
// M4-MOVE's own functions (collideBarrels, squeezeBarrels, collidePresses, collideTrucks, truckRamp,
// onTruckLip, shotIntoMovers, moverBlockers, truckAhead and their helpers) are listed by name. An
// inlined function is charged to its caller, so read the totals: 2026-11-22, the room with five bots
// made ~32.1 KB a tick on the bare loop (the bots' lane searches, track queries, snapshots: before
// M4-MOVE), 33.6 KB on the Move Yard (seeing bots: their lane search runs its full search with what
// moves in view) and 32.9 KB with blind bots; M4-MOVE's own functions ~50-100 B of it (number boxing:
// no array or object a tick).

import { Session } from "node:inspector";
import { MOVE, type BotLevel } from "../../shared/botdrive";
import { MOVE_YARD } from "../../shared/testtracks";
import { registerTestTrack } from "../../shared/tracks";
import { CAR_HP } from "../../shared/weapons";
import { Room, type Player, type Session as GameSession } from "../../server/room";

const args = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const interval = arg("--interval", 64);
if (args.includes("--blind")) MOVE.see = false;

const MOVE_FNS = new Set([
  "collideBarrels", "squeezeBarrels", "collidePresses", "collideTrucks", "truckRamp", "barrelAt", "axisDist", "segToBox", "segMeetsBox", "wallBounce",
  "onTruckLip", "shotIntoMovers", "pointSegDist2", "segSegDist", "moverBlockers", "mover", "crossWindow", "truckAhead",
]);

/** One race of the five bots on track `id` (the dev flag on); `tick` is called round every room tick. */
function race(id: string, laps: number, tick: (fn: () => void) => void): number {
  const old = process.env.SCRAP_DEV_TRACK;
  process.env.SCRAP_DEV_TRACK = id;
  try {
    const room = new Room("ALOC", laps, CAR_HP, id);
    let now = 1000, t = 0;
    const host = room.addPlayer("Host", { conn: { send() {}, close() {} }, room: null, player: null } as GameSession, now) as Player;
    for (const l of ["easy", "normal", "hard", "normal", "hard"] as BotLevel[]) room.addBot(host, l, now);
    room.start(host, now);
    const step = () => {
      t++;
      now += 1000 / 60;
      room.tick(t, now);
    };
    while (room.phase !== "racing") step();
    room.retire(host);
    let ticks = 0;
    while (room.phase === "racing" && ticks < 60 * 60 * 5) {
      tick(step);
      ticks++;
    }
    return ticks;
  } finally {
    if (old === undefined) delete process.env.SCRAP_DEV_TRACK;
    else process.env.SCRAP_DEV_TRACK = old;
  }
}

interface Node {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: Node[];
}

/** Bytes charged per function (innermost frame of ours on the stack: shared/ or server/), from a sampling profile. */
function charge(root: Node): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (n: Node, ours: string | null) => {
    const url = n.callFrame.url;
    const mine = /\/(shared|server)\//.test(url) ? `${n.callFrame.functionName || "(anonymous)"} ${url.replace(/^.*\/(shared|server)\//, "$1/")}:${n.callFrame.lineNumber + 1}` : null;
    const at = mine ?? ours;
    if (at && n.selfSize > 0) out.set(at, (out.get(at) ?? 0) + n.selfSize);
    for (const c of n.children) walk(c, at);
  };
  walk(root, null);
  return out;
}

async function profile(id: string): Promise<{ ticks: number; bytes: Map<string, number> }> {
  const s = new Session();
  s.connect();
  const post = <T>(m: string, p?: object) => new Promise<T>((res, rej) => s.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r as T))));
  race(id, 3, (f) => f()); // warm-up
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", { samplingInterval: interval, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const ticks = race(id, 3, (f) => f());
  const { profile: p } = await post<{ profile: { head: Node } }>("HeapProfiler.stopSampling");
  s.disconnect();
  return { ticks, bytes: charge(p.head) };
}

// The bare loop: the Move Yard's control points with nothing on it, registered as a track for this run.
registerTestTrack({ ...MOVE_YARD, id: "move-bare", name: "Move Yard (bare)", features: [] });

const yard = await profile(MOVE_YARD.id);
const plain = await profile("move-bare");
const perTick = (m: Map<string, number>, ticks: number) => [...m].map(([k, v]) => [k, v / ticks] as const).sort((a, b) => b[1] - a[1]);
const rows = perTick(yard.bytes, yard.ticks), base = new Map(perTick(plain.bytes, plain.ticks));
const total = (r: readonly (readonly [string, number])[]) => r.reduce((a, [, v]) => a + v, 0);
console.log(`Move Yard${MOVE.see ? "" : " (bots blind to the barrels and presses)"}: ${yard.ticks} room ticks with five bots; the bare loop ${plain.ticks}; sampling every ~${interval} B`);
const mine = rows.filter(([k]) => MOVE_FNS.has(k.split(" ")[0]));
console.log(`  M4-MOVE's functions: ${mine.length ? mine.map(([k, v]) => `${k} ${v.toFixed(2)} B/tick`).join("; ") : "none sampled (0 B a tick)"}`);
console.log(`  all of shared/ and server/: ${total(rows).toFixed(1)} B/tick on the Move Yard, ${total([...base]).toFixed(1)} on the bare loop`);
console.log("  the top 12 on the Move Yard (beside the bare loop):");
for (const [k, v] of rows.slice(0, 12)) console.log(`    ${v.toFixed(1).padStart(8)} B/tick (bare ${(base.get(k) ?? 0).toFixed(1).padStart(7)})  ${k}`);
