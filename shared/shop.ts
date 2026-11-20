// The garage: upgrade and ammo catalog, prices, payouts. Pure and shared, so the server
// (authority) and the client (shop UI, prediction stats) always agree.

import { CARS, type CarType } from "./cars";
import { TICK_HZ, type CarStats } from "./physics";

export type UpgradeId = "engine" | "tyres" | "welder";
export type AmmoId = "rivets" | "mines";
export type ItemId = UpgradeId | AmmoId;

export interface Levels {
  engine: number;
  tyres: number;
  welder: number;
}

export interface Ammo {
  rivets: number;
  mines: number;
}

export interface Wallet {
  scrap: number;
  levels: Levels;
  ammo: Ammo;
}

export const UPGRADES: Record<UpgradeId, { name: string; blurb: string; prices: number[] }> = {
  engine: { name: "Engine", blurb: "+7% acceleration", prices: [400, 800, 1400] },
  tyres: { name: "Tyres", blurb: "+10% grip, +4% steering", prices: [350, 700, 1200] },
  welder: { name: "Welding rig", blurb: "Repairs 2 HP/s while driving", prices: [300, 600, 1000] },
};

export const AMMO: Record<AmmoId, { name: string; pack: number; price: number; cap: number }> = {
  rivets: { name: "Rivets", pack: 20, price: 150, cap: 100 },
  // Mines: hold at most 3 at a time (user request 2026-11-17; was 9). Mines are only bought in
  // the garage between races, so this is also at most 3 mines per race.
  mines: { name: "Scrap mines", pack: 3, price: 200, cap: 3 },
};

export const UPGRADE_IDS: UpgradeId[] = ["engine", "tyres", "welder"];
export const AMMO_IDS: AmmoId[] = ["rivets", "mines"];

export const PLACE_PAYOUT = [1000, 700, 500, 350, 250, 150];
export const WRECK_BONUS = 60;

export function startingWallet(): Wallet {
  return { scrap: 400, levels: { engine: 0, tyres: 0, welder: 0 }, ammo: { rivets: 0, mines: 0 } };
}

export function isItem(v: unknown): v is ItemId {
  return v === "engine" || v === "tyres" || v === "welder" || v === "rivets" || v === "mines";
}

/**
 * Stats a car races with: the car type's base (shared/cars.ts) with the driver's upgrades as
 * percentages of it. The engine raises acceleration only (+7 % per level); top speed stays at
 * the base value at every level (playtest 2026-11-16: a faster top speed made the engine
 * overpowered). Tyres: grip and steering. The dirt multipliers are the type's own.
 */
export function statsFor(car: CarType, l: Levels): CarStats {
  const b = CARS[car].base;
  return {
    accel: b.accel * (1 + 0.07 * l.engine),
    topSpeed: b.topSpeed,
    grip: b.grip * (1 + 0.1 * l.tyres),
    turn: b.turn * (1 + 0.04 * l.tyres),
    dirtDrag: b.dirtDrag,
    dirtGrip: b.dirtGrip,
  };
}

/** HP repaired per tick while driving. */
export function regenPerTick(l: Levels): number {
  return (2 * l.welder) / TICK_HZ;
}

/** Price of the next purchase of `item`, or null when it is maxed out. */
export function priceOf(item: ItemId, w: Wallet): number | null {
  if (item === "rivets" || item === "mines") {
    return w.ammo[item] >= AMMO[item].cap ? null : AMMO[item].price;
  }
  return UPGRADES[item].prices[w.levels[item]] ?? null;
}

/** Apply a purchase to the wallet. Returns an error message, or null on success. */
export function buy(w: Wallet, item: ItemId): string | null {
  const price = priceOf(item, w);
  if (price === null) return "Already maxed out";
  if (w.scrap < price) return "Not enough scrap";
  w.scrap -= price;
  if (item === "rivets" || item === "mines") {
    w.ammo[item] = Math.min(AMMO[item].cap, w.ammo[item] + AMMO[item].pack);
  } else {
    w.levels[item]++;
  }
  return null;
}

/**
 * Clamp every ammo count to its cap. A wallet can only go over a cap from outside `buy` (for
 * example one kept from before a cap was lowered); the room calls this before a race starts,
 * so nobody races with more than the cap.
 */
export function clampAmmo(w: Wallet): void {
  for (const id of AMMO_IDS) w.ammo[id] = Math.min(AMMO[id].cap, w.ammo[id]);
}

/**
 * Scrap earned per player. `standings` is in finishing order (finishers first);
 * non-finishers get no place money. Each wreck caused adds a bonus.
 */
export function payouts(
  standings: { id: string; fin: number }[],
  wrecksCaused: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  standings.forEach((r, i) => {
    const place = r.fin ? (PLACE_PAYOUT[i] ?? 0) : 0;
    out.set(r.id, place + WRECK_BONUS * (wrecksCaused.get(r.id) ?? 0));
  });
  return out;
}
