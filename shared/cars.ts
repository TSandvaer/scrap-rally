// Car types (M4-CARS, PLAN-M4.md 2.1): what a driver picks in the lobby garage. Pure and
// shared, so the server (authority) and the client (prediction stats, the lobby's car row)
// always agree. Every type has the same capsule, mass and top speed: collisions and the
// netcode do not change; the types differ in acceleration, grip, steering and how they take
// the dirt verge. Upgrades belong to the driver and apply to whichever car they drive
// (shared/shop.ts statsFor).

import { BASE_STATS, type CarStats } from "./physics";

export type CarType = "sport" | "racer" | "truck";

/** Lobby order (the car row's cards); a server bot gets CAR_TYPES[slot % 3]. */
export const CAR_TYPES: readonly CarType[] = ["sport", "racer", "truck"];

/** A new driver's car, and the car of a message that names none. */
export const DEFAULT_CAR: CarType = "sport";

export function isCarType(v: unknown): v is CarType {
  return v === "sport" || v === "racer" || v === "truck";
}

export interface CarSpec {
  name: string;
  feel: string; // one line for the lobby card
  base: CarStats; // no upgrades
}

/**
 * Base stats per type (PLAN-M4 2.1). The Sport is the car everyone drove before M4-CARS
 * (BASE_STATS, unchanged). Top speed 430 for all three (2026-11-16: a higher top speed made
 * the engine overpowered). Dirt top speed = topSpeed / dirtDrag: Sport ~148, Racer ~119,
 * Truck ~269 u/s.
 */
export const CARS: Record<CarType, CarSpec> = {
  sport: { name: "Sport", feel: "the all-rounder: even grip and pace", base: BASE_STATS },
  racer: {
    name: "Racer",
    feel: "quick off the line, loose in corners",
    base: { accel: 600, topSpeed: 430, grip: 6.0, turn: 3.45, dirtDrag: 3.6, dirtGrip: 0.3 },
  },
  truck: {
    name: "Truck",
    feel: "slow to pull, sticks in corners, shrugs off dirt",
    base: { accel: 455, topSpeed: 430, grip: 9.0, turn: 3.1, dirtDrag: 1.6, dirtGrip: 0.6 },
  },
};

export function carName(t: CarType): string {
  return CARS[t].name;
}
