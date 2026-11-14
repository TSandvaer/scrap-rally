// Practice opponents: join bots to a room you created in the browser.
//
//   npm run dev                       (terminal 1, then open http://localhost:3000 and create a room)
//   npm run botplay -- ABCD 3         (terminal 2: 3 bots join room ABCD; you press Start)
//
// Options: --calm (bots do not shoot or drop mines), --url ws://host:port/ws.
// Bots race every race the host starts, spend their scrap in the garage between races,
// and leave on Ctrl+C.

import { Game, type TokenStore } from "../client/game";
import { connectWs } from "../client/net";
import { AMMO, priceOf, UPGRADE_IDS, type ItemId } from "../shared/shop";
import { BotDriver } from "./bot-ai";

const NAMES = ["Sprocket", "Gasket", "Lugnut", "Piston", "Bolt"];
const LANES = [-24, 24, 0, -12, 12];
const STEP_MS = 1000 / 60;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--url"));
const code = (positional[0] ?? "").toUpperCase();
const count = Math.max(1, Math.min(5, Number(positional[1] ?? 3) || 3));
const url = option("--url") ?? `ws://localhost:${process.env.PORT || 3000}/ws`;

if (!/^[A-Z0-9]{4}$/.test(code)) {
  console.log("Usage: npm run botplay -- <ROOM CODE> [count 1-5] [--calm] [--url ws://host:port/ws]");
  process.exit(1);
}

function memoryTokens(): TokenStore {
  const m = new Map<string, string>();
  return { get: (c) => m.get(c) ?? null, set: (c, t) => void m.set(c, t) };
}

interface Bot {
  name: string;
  game: Game;
  driver: BotDriver;
  shopped: boolean;
}

/** Between races: top up rivets, then buy the cheapest affordable upgrade, a few times. */
function shop(b: Bot): void {
  const g = b.game;
  const wallet = { scrap: g.scrap, levels: { ...g.levels }, ammo: { rivets: g.serverAmmo[0], mines: g.serverAmmo[1] } };
  const wishes: ItemId[] = [];
  if (wallet.ammo.rivets < 40) wishes.push("rivets");
  if (wallet.ammo.mines < 3) wishes.push("mines");
  const upgrades = [...UPGRADE_IDS].sort((x, y) => (priceOf(x, wallet) ?? 1e9) - (priceOf(y, wallet) ?? 1e9));
  wishes.push(...upgrades);
  let budget = wallet.scrap;
  for (const item of wishes) {
    const price = priceOf(item, wallet);
    if (price === null || price > budget) continue;
    g.buy(item);
    budget -= price;
    if (item === "rivets" || item === "mines") wallet.ammo[item] += AMMO[item].pack;
    else wallet.levels[item]++;
  }
}

const bots: Bot[] = [];
for (let i = 0; i < count; i++) {
  const name = NAMES[i];
  const game = new Game(() => connectWs(url), memoryTokens());
  const bot: Bot = { name, game, driver: new BotDriver(game, LANES[i]), shopped: false };
  bot.driver.weapons = !flag("--calm");
  game.on.error = (msg) => console.log(`${name}: ${msg}`);
  game.on.connection = (state) => {
    if (state === "lost") {
      console.log(`${name}: connection lost`);
      process.exitCode = 1;
    }
  };
  game.on.welcome = () => console.log(`${name} joined ${game.code}`);
  game.on.event = (ev) => {
    if (i !== 0) return; // log each event once
    const who = (id: string) => game.player(id)?.name ?? "?";
    if (ev.k === "finish") console.log(`  ${who(ev.id)} finished #${ev.place} in ${(ev.timeMs / 1000).toFixed(2)}s`);
    if (ev.k === "wreck") console.log(`  ${who(ev.by)} wrecked ${who(ev.id)}`);
  };
  game.join(code, name);
  bots.push(bot);
}

console.log(`${count} bot(s) joining ${code} at ${url}${flag("--calm") ? " (calm: no weapons)" : ""}. Ctrl+C to stop.`);

let last = performance.now();
let acc = 0;
const loop = setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  let n = 0;
  while (acc >= STEP_MS && n < 5) {
    for (const b of bots) {
      if (b.game.phase === "lobby" && b.game.connected) {
        if (!b.shopped && b.game.scrap > 0 && b.game.latest) {
          b.shopped = true;
          shop(b);
        }
      } else {
        b.shopped = false;
      }
      b.game.step(b.driver.controls(), STEP_MS);
    }
    acc -= STEP_MS;
    n++;
  }
  if (acc >= STEP_MS) acc = 0;
}, 4);

process.on("SIGINT", () => {
  clearInterval(loop);
  for (const b of bots) b.game.leave();
  console.log("\nbots left");
  process.exit(0);
});
