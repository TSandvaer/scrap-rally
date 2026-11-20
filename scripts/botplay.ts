// Practice opponents: join bots to a room you created in the browser.
//
//   npm run dev                       (terminal 1, then open http://localhost:3000 and create a room)
//   npm run botplay -- ABCD 3         (terminal 2: 3 bots join room ABCD; you press Start)
//
// Options: --calm (bots do not shoot or drop mines), --url ws://host:port/ws.
// Bots race every race the host starts, spend their scrap in the garage between races,
// report ready in the lobby once they have shopped, and leave on Ctrl+C. The host's Esc menu
// works on them: a removed bot stops (the others play on), a stopped or restarted race is
// logged, and a bot made the host hands it straight back (bots never start races).

import { Game, lostMessage, type TokenStore } from "../client/game";
import { connectWs } from "../client/net";
import { botShopping } from "../shared/botshop";
import { trackName } from "../shared/tracks";
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
  readyDue: boolean; // a room update arrived: check (once) whether to report ready
}

/** Between races: top up rivets and mines, then each affordable upgrade, cheapest first (shared/botshop.ts). */
function shop(b: Bot): void {
  const g = b.game;
  const wallet = { scrap: g.scrap, levels: { ...g.levels }, ammo: { rivets: g.serverAmmo[0], mines: g.serverAmmo[1] } };
  for (const item of botShopping(wallet, "normal")) g.buy(item);
}

const bots: Bot[] = [];
for (let i = 0; i < count; i++) {
  const name = NAMES[i];
  const game = new Game(() => connectWs(url), memoryTokens());
  const bot: Bot = { name, game, driver: new BotDriver(game, LANES[i]), shopped: false, readyDue: false };
  bot.driver.weapons = !flag("--calm");
  game.on.error = (msg) => console.log(`${name}: ${msg}`);
  game.on.connection = (state, reason) => {
    if (state !== "lost") return;
    // Removed by the host, or a locked room: this bot is done, the others play on.
    console.log(`${name}: ${reason === "kicked" || reason === "locked" ? lostMessage(reason, true) : "connection lost"}`);
    if (reason !== "kicked" && reason !== "locked") process.exitCode = 1;
    bots.splice(bots.indexOf(bot), 1);
    game.leave();
    if (!bots.length) {
      console.log("no bots left");
      process.exit();
    }
  };
  game.on.welcome = () => console.log(`${name} joined ${game.code}`);
  let trackId = "";
  let phase = "";
  let raceStart = 0;
  let hostId = "";
  let paused = false;
  let sound = "";
  game.on.room = () => {
    bot.readyDue = true; // also after the host picks another track (that resets ready)
    const lead = bots[0] === bot; // log room-wide news once
    if (lead && game.trackId !== trackId) console.log(`  track: ${trackName(game.trackId)}`);
    // The host's room sound (SND-4): bots play no audio; it is only news.
    const d = game.soundDefaults;
    const snd = `music ${d.musicOn ? `on ${Math.round(d.music * 100)}%` : "off"}, effects ${Math.round(d.effects * 100)}%, song ${d.song === game.song ? game.song : `${d.song} (${game.song})`}`;
    if (lead && snd !== sound) console.log(`  room sound: ${snd}`);
    sound = snd;
    const wasRace = phase === "countdown" || phase === "racing";
    if (lead && wasRace && game.phase === "countdown" && game.raceStart !== raceStart) console.log("  race restarted by the host");
    if (lead && wasRace && game.phase === "lobby") console.log("  race stopped by the host");
    // A pause needs nothing from a bot: Game.step() predicts and sends nothing while it lasts.
    if (lead && game.paused && !paused) console.log(`  race paused by ${game.pausedBy}`);
    if (lead && paused && !game.paused && (game.phase === "countdown" || game.phase === "racing")) console.log("  race resumed");
    // Made the host: hand it back to who gave it (else the first driver who is not a bot).
    if (game.isHost() && hostId && hostId !== game.you) {
      const botIds = new Set(bots.map((b) => b.game.you));
      const back = [game.player(hostId), ...game.players].find((p) => p && p.connected && !botIds.has(p.id));
      if (back) {
        console.log(`${name} was made the host: handing it back to ${back.name}`);
        game.makeHost(back.id);
      } else if (game.canResume()) {
        // Nobody to hand it back to: a bot never keeps the race paused.
        console.log(`${name} is the host of a paused race: resuming it`);
        game.resume();
      }
    }
    trackId = game.trackId;
    phase = game.phase;
    raceStart = game.raceStart;
    hostId = game.hostId;
    paused = game.paused;
  };
  game.on.event = (ev) => {
    if (bots[0] !== bot) return; // log each event once
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
        // Ready after shopping (the buys go first on the socket); a broke bot readies at once.
        if (b.readyDue && (b.shopped || b.game.scrap === 0)) {
          b.readyDue = false;
          if (b.game.me()?.ready === false && !b.game.isHost()) b.game.setReady(true);
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
