// Wire protocol. Everything that goes over the socket is defined and encoded here, so a
// later switch to a binary format or another transport touches only this file and net.ts.
//
// Two message classes:
//  - state (`snap`): full world state, stamped with the server tick. Self-contained, so a
//    lost or late snapshot is harmless (safe for an unreliable transport later).
//  - events (`ev`, `room`, `welcome`, ...): things that must arrive exactly once.

import type { Levels } from "./shop";

export const LAPS = 3;
export const MAX_PLAYERS = 6;
export const SNAPSHOT_EVERY = 2; // ticks between snapshots -> 30 Hz
export const INPUT_REDUNDANCY = 3; // each input message repeats the last N inputs
export const COUNTDOWN_MS = 3000;
export const FINISH_GRACE_MS = 30000; // race ends this long after the winner finishes
export const RESULTS_MS = 8000;
export const RECONNECT_GRACE_MS = 20000;
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const CODE_LENGTH = 4;

export type Phase = "lobby" | "countdown" | "racing" | "results";

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  inRace: boolean;
  connected: boolean;
}

/** [seq, throttle, steer, buttons]; buttons as in shared/weapons.ts */
export type InputTuple = [number, number, number, number];

export type ClientMsg =
  | { t: "create"; name: string }
  | { t: "join"; code: string; name: string; token?: string }
  | { t: "start" }
  | { t: "in"; i: InputTuple[] } // oldest first, newest last
  | { t: "ping"; c: number }
  | { t: "buy"; item: string };

export interface CarSnap {
  k: "car";
  id: string; // player id
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  seg: number;
  lap: number; // completed laps
  rd: number; // race distance, for ordering
  fin: number; // finish time in ms since the start, 0 = still racing
  hp: number;
  maxHp: number;
  wreck: number; // ticks left wrecked, 0 = driving
  ghost: boolean; // just respawned or finished: no damage, no car collisions
}

export interface ShotSnap {
  k: "shot";
  id: number;
  o: string; // owner player id
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface MineSnap {
  k: "mine";
  id: number;
  o: string;
  x: number;
  y: number;
  armed: boolean;
}

/** Generic entity list: cars, shots, mines; pickups can be added later. */
export type EntSnap = CarSnap | ShotSnap | MineSnap;

export interface ResultRow {
  id: string;
  name: string;
  color: string;
  timeMs: number; // 0 = did not finish
  earned: number; // scrap earned this race (place + wreck bonus)
}

export type GameEvent =
  | { k: "lap"; id: string; lap: number }
  | { k: "finish"; id: string; place: number; timeMs: number }
  | { k: "hit"; id: string; by: string; dmg: number; w: "rivet" | "mine" }
  | { k: "wreck"; id: string; by: string };

export type ServerMsg =
  | { t: "welcome"; code: string; you: string; token: string; laps: number }
  | {
      t: "room";
      hostId: string;
      phase: Phase;
      raceStart: number; // server time the current race starts/started, 0 = no race
      players: PlayerInfo[];
    }
  | { t: "err"; msg: string }
  | {
      t: "snap";
      tick: number;
      time: number; // server clock, ms
      phase: Phase;
      phaseEnds: number; // server time the current phase ends, 0 = open-ended
      ack: number; // last input seq the server consumed for the recipient
      ammo: [number, number]; // recipient's [rivets, mines]
      ents: EntSnap[];
    }
  | { t: "ev"; tick: number; ev: GameEvent }
  | { t: "results"; rows: ResultRow[] }
  | { t: "garage"; scrap: number; levels: Levels } // to one player
  | { t: "pong"; c: number; s: number };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: unknown): T | null {
  try {
    return JSON.parse(typeof data === "string" ? data : String(data)) as T;
  } catch {
    return null;
  }
}

export function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
