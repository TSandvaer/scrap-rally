// Host-added bot seats (M4-BOTS, PLAN-M4.md 2.0). A bot is a Player with no session: each tick
// the room asks botStep for its Command (no jitter buffer: a zero-latency driver), and from
// there weapons, the armed delay, pause, results, scrap and the wreck bonus are the code every
// player goes through. Everything a bot does differently by seat (name, racing line, mine
// timing) is keyed by its slot, never by the random player id, so a rerun is identical.

import { botControls, newBotMem, resetBotMem, type BotLevel, type BotMem, type BotMine, type BotOther } from "../shared/botdrive";
import { botShopping } from "../shared/botshop";
import { CAR_TYPES, type CarType } from "../shared/cars";
import type { CarStats } from "../shared/physics";
import { buy, type ItemId, type Wallet } from "../shared/shop";
import type { Track } from "../shared/track";
import { BTN_RIVET, type Command } from "../shared/weapons";
import { solid, type Fighter } from "./combat";

/** Server-wide bot cap (env MAX_BOTS): more are refused with "Server busy" (PLAN-M4 advisor change 12). */
export const DEFAULT_MAX_BOTS = 10;

export function maxBotsFromEnv(): number {
  const v = Number(process.env.MAX_BOTS);
  return Number.isInteger(v) && v >= 0 && process.env.MAX_BOTS !== "" ? v : DEFAULT_MAX_BOTS;
}

// By slot (the lowest one free in the room when the bot is added). Names are original and,
// with " (bot)", no longer than a player's name (12). A room has at most 5 bots (one human).
const NAMES = ["Gasket", "Lugnut", "Piston", "Clutch", "Axle", "Sprock"];
const LANES = [-24, 24, 0, -12, 12, -36]; // the racing lines botplay's bots use, in order
const MINE_OFFSETS = [0, 96, 192, 288, 384, 48]; // steps into the 8 s mine cycle: never two at once

export const BOT_SLOTS = NAMES.length;

/** The bot part of a Player. */
export interface BotSeat {
  level: BotLevel;
  slot: number; // 0..BOT_SLOTS-1, unique among the room's bots
  order: number; // add order in the room (a joining human replaces the highest)
  mem: BotMem;
  steps: number; // racing steps this race (the mine timing)
}

export function botName(slot: number): string {
  return `${NAMES[slot]} (bot)`;
}

/** A new bot's car type (M4-CARS): round-robin by seat, Sport, Racer, Truck, Sport, ... */
export function botCar(slot: number): CarType {
  return CAR_TYPES[slot % CAR_TYPES.length];
}

export function newBotSeat(level: BotLevel, slot: number, order: number): BotSeat {
  return { level, slot, order, mem: newBotMem(LANES[slot], level, MINE_OFFSETS[slot]), steps: 0 };
}

/** A new race: the step count and the driver's memory start over (the settings stay). */
export function resetBotSeat(seat: BotSeat): void {
  seat.steps = 0;
  resetBotMem(seat.mem);
}

/**
 * Optional instrumentation (sim-test's CPU gate): set to an array and every botStep pushes its
 * duration in ms. null in the server.
 */
export const botTiming: { samples: number[] | null } = { samples: null };

/**
 * The bot's command for this tick, from the start-of-tick poses of every car in the race.
 * racing: inputs apply (the race phase, not paused). mines: the mines on the track (the
 * slipstream lanes avoid them). minePress: drop a mine this tick.
 */
export function botStep(
  p: Fighter & { stats: CarStats; bot: BotSeat; carType: CarType },
  racers: readonly Fighter[],
  track: Track,
  racing: boolean,
  mines: readonly BotMine[] = [],
): { cmd: Command; minePress: boolean } {
  const t0 = botTiming.samples ? performance.now() : 0;
  const seat = p.bot;
  const car = p.car;
  if (racing && car) seat.steps++;
  const others: BotOther[] = [];
  if (car && (seat.mem.weapons || seat.mem.useWake) && car.air === 0 && car.fall === 0 && car.wreck === 0) {
    for (const q of racers) if (q !== p && q.car) others.push({ x: q.car.x, y: q.car.y, solid: solid(q), id: q.id, vx: q.car.vx, vy: q.car.vy });
  }
  const ctl = botControls({ car, track, stats: p.stats, raceOn: racing, raceSteps: seat.steps, others, carType: p.carType, mines }, seat.mem);
  const out = { cmd: { throttle: ctl.throttle, steer: ctl.steer, buttons: ctl.fire ? BTN_RIVET : 0 }, minePress: ctl.mine };
  if (botTiming.samples) botTiming.samples.push(performance.now() - t0);
  return out;
}

/** The bot shops (shared/botshop.ts) with the shop's own rule; returns what it bought. */
export function shopBot(wallet: Wallet, level: BotLevel): ItemId[] {
  const bought: ItemId[] = [];
  for (const item of botShopping(wallet, level)) if (buy(wallet, item) === null) bought.push(item);
  return bought;
}
