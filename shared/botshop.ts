// What a bot buys in the garage (M4-BOTS): one rule for the server's bot seats (server/bots.ts)
// and the socket bots of `npm run botplay`. Pure: it plans the purchases, the caller makes them.

import type { BotLevel } from "./botdrive";
import { AMMO, priceOf, UPGRADE_IDS, type ItemId, type UpgradeId, type Wallet } from "./shop";

/**
 * Hard's upgrade order (M4-HARD advisor change 8): the engine (acceleration: the only upgrade that
 * makes a bot faster), then the welding rig (it keeps the car out of a wreck), then the tyres (a
 * bot's bend speeds come from its car's base grip, so tyres give it no pace).
 */
export const HARD_UPGRADES: readonly UpgradeId[] = ["engine", "welder", "tyres"];

/**
 * The purchases a bot makes with this wallet, in order. Normal: a rivet pack while under 40
 * rivets and a mine pack while under 3 mines, then each upgrade once, cheapest first. Easy
 * (never shoots): the upgrades only. Hard: a rivet pack while under 20 rivets and a mine pack
 * while under 2 mines (it fires only shots that hit, so it needs fewer), then each upgrade once
 * in HARD_UPGRADES order, then the ammo topped up as Normal's. Anything it cannot afford by then
 * is skipped.
 */
export function botShopping(w: Wallet, level: BotLevel): ItemId[] {
  const wallet: Wallet = { scrap: w.scrap, levels: { ...w.levels }, ammo: { ...w.ammo } };
  const wishes: ItemId[] = [];
  if (level === "hard") {
    if (wallet.ammo.rivets < 20) wishes.push("rivets");
    if (wallet.ammo.mines < 2) wishes.push("mines");
    wishes.push(...HARD_UPGRADES, "rivets", "mines");
    return plan(wallet, wishes, (item, wal) => item === "rivets" ? wal.ammo.rivets < 40 : item === "mines" ? wal.ammo.mines < 3 : true);
  }
  if (level === "normal") {
    if (wallet.ammo.rivets < 40) wishes.push("rivets");
    if (wallet.ammo.mines < 3) wishes.push("mines");
  }
  const upgrades = [...UPGRADE_IDS].sort((x, y) => (priceOf(x, wallet) ?? 1e9) - (priceOf(y, wallet) ?? 1e9));
  wishes.push(...upgrades);
  return plan(wallet, wishes, () => true);
}

/** Buy the wishes in order (on a copy of the wallet) while affordable and still wanted. */
function plan(wallet: Wallet, wishes: ItemId[], wanted: (item: ItemId, w: Wallet) => boolean): ItemId[] {
  const out: ItemId[] = [];
  let budget = wallet.scrap;
  for (const item of wishes) {
    const price = priceOf(item, wallet);
    if (price === null || price > budget || !wanted(item, wallet)) continue;
    out.push(item);
    budget -= price;
    if (item === "rivets" || item === "mines") wallet.ammo[item] += AMMO[item].pack;
    else wallet.levels[item]++;
  }
  return out;
}
