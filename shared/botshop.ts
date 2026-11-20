// What a bot buys in the garage (M4-BOTS): one rule for the server's bot seats (server/bots.ts)
// and the socket bots of `npm run botplay`. Pure: it plans the purchases, the caller makes them.

import type { BotLevel } from "./botdrive";
import { AMMO, priceOf, UPGRADE_IDS, type ItemId, type Wallet } from "./shop";

/**
 * The purchases a bot makes with this wallet, in order. Normal: a rivet pack while under 40
 * rivets and a mine pack while under 3 mines, then each upgrade once, cheapest first. Easy
 * (never shoots): the upgrades only. Anything it cannot afford by then is skipped.
 */
export function botShopping(w: Wallet, level: BotLevel): ItemId[] {
  const wallet: Wallet = { scrap: w.scrap, levels: { ...w.levels }, ammo: { ...w.ammo } };
  const wishes: ItemId[] = [];
  if (level === "normal") {
    if (wallet.ammo.rivets < 40) wishes.push("rivets");
    if (wallet.ammo.mines < 3) wishes.push("mines");
  }
  const upgrades = [...UPGRADE_IDS].sort((x, y) => (priceOf(x, wallet) ?? 1e9) - (priceOf(y, wallet) ?? 1e9));
  wishes.push(...upgrades);
  const out: ItemId[] = [];
  let budget = wallet.scrap;
  for (const item of wishes) {
    const price = priceOf(item, wallet);
    if (price === null || price > budget) continue;
    out.push(item);
    budget -= price;
    if (item === "rivets" || item === "mines") wallet.ammo[item] += AMMO[item].pack;
    else wallet.levels[item]++;
  }
  return out;
}
