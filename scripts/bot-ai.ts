// Bot driver used by the end-to-end test (scripts/bots.ts), the headless bot laps
// (scripts/sim-test.ts) and `npm run botplay`. It plays through the real client Game, so it
// sees exactly what a player's browser sees. The driving itself is shared/botdrive.ts (the
// server's bot seats run the same step); this is the adapter that feeds it from a Game.

import { NO_CONTROLS, type Controls, type Game } from "../client/game";
import { botControls, hardParams, newBotMem, type BotLevel, type BotMem, type BotOther, type BotTune, type MistakeKind } from "../shared/botdrive";

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

  /** HARD-2: drive Hard with the Bot tune knob's values (botplay and the tests; a server room's knob does not reach a socket bot). */
  tune(t: BotTune): void {
    this.mem.hard = hardParams(t);
  }

  /** HARD-2: told of each mistake as it begins (kind, size, s, lap), or null. */
  set onMistake(fn: ((kind: MistakeKind, size: number, s: number, lap: number) => void) | null) {
    this.mem.onMistake = fn;
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
    if (!car) {
      // Between races. The race steps start over, so Hard's last-mine step must too, or its mine
      // gap (HARD.mineGap) would hold its mines back in the next race. Only these: resetBotMem
      // would also clear the slipstream and stuck state, which Normal keeps across races here.
      this.raceSteps = 0;
      this.mem.lastMine = -Infinity;
      // HARD-2: and its mistake (latched for a bend of the last race) and the latches it keeps.
      this.mem.mistake = null;
      this.mem.inBend = false;
      this.mem.flew = false;
      this.mem.hp = -1;
      // BR-BOTS: its shortcuts are chosen again for the next race (routePlan: by its seat from its lane,
      // its car type and stats then), and its route starts from the plan.
      this.mem.plan = -1;
      this.mem.planTrack = null;
      this.mem.route = 0;
      this.mem.forkDone = 0;
    } else if (raceOn) this.raceSteps++;
    const grounded = !!car && car.air === 0 && car.fall === 0 && car.wreck === 0;
    const out = botControls(
      {
        car, track: g.track, stats: g.stats, raceOn, raceSteps: this.raceSteps, carType: g.carType,
        others: grounded && (this.mem.weapons || this.mem.useWake) ? this.others() : [],
        mines: grounded && this.mem.useWake ? g.visibleMines() : [],
        cells: g.cellsPred,
        rt: g.raceTickNow(),
        lap: g.latest?.cars.get(g.you)?.lap ?? 0, // HARD-2: as the snapshots show them
        hp: g.latest?.cars.get(g.you)?.hp,
      },
      this.mem,
    );
    return car ? out : NO_CONTROLS;
  }
}
