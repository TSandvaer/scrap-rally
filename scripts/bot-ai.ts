// Bot driver used by the end-to-end test (scripts/bots.ts), the headless bot laps
// (scripts/sim-test.ts) and `npm run botplay`. It plays through the real client Game, so it
// sees exactly what a player's browser sees. The driving itself is shared/botdrive.ts (the
// server's bot seats run the same step); this is the adapter that feeds it from a Game.

import { NO_CONTROLS, type Controls, type Game } from "../client/game";
import { botControls, newBotMem, type BotLevel, type BotMem, type BotOther } from "../shared/botdrive";

export { holeLane, runUpFor, speedAfter, takeoffSpeedFor } from "../shared/botdrive";

export class BotDriver {
  private raceSteps = 0; // steps since this bot's race started (input applies)
  private readonly mem: BotMem;

  constructor(
    private readonly game: Game,
    /** Racing line offset from the centerline (units, + = right of travel). */
    readonly lateral: number,
    /** The bot level (shared/botdrive.ts): Normal unless asked (botplay's --level). */
    readonly level: BotLevel = "normal",
  ) {
    this.mem = newBotMem(lateral, level);
  }

  /** Fires rivets and drops mines (Normal, Hard); false: drives only. */
  get weapons(): boolean {
    return this.mem.weapons;
  }

  set weapons(on: boolean) {
    this.mem.weapons = on;
  }

  /** The other cars as the snapshots show them; solid = one the server lets a rivet hit. */
  private others(): BotOther[] {
    const g = this.game;
    return g.otherPoses().map((o) => {
      const s = g.latest?.cars.get(o.id);
      return { x: o.x, y: o.y, solid: !!s && !s.ghost && !s.wreck && !s.air && !s.fall, id: o.id, vx: s?.vx ?? 0, vy: s?.vy ?? 0 };
    });
  }

  /** Follow the line, brake for bends, take ramps flat out, dodge holes, shoot what is ahead. */
  controls(): Controls {
    const g = this.game;
    const car = g.car;
    const raceOn = !!car && g.raceOn();
    if (!car) this.raceSteps = 0;
    else if (raceOn) this.raceSteps++;
    const grounded = !!car && car.air === 0 && car.fall === 0 && car.wreck === 0;
    const out = botControls(
      {
        car, track: g.track, stats: g.stats, raceOn, raceSteps: this.raceSteps, carType: g.carType,
        others: grounded && (this.mem.weapons || this.mem.useWake) ? this.others() : [],
        mines: grounded && this.mem.useWake ? g.visibleMines() : [],
        cells: g.cellsPred,
        rt: g.raceTickNow(),
      },
      this.mem,
    );
    return car ? out : NO_CONTROLS;
  }
}
