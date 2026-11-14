// Bot driver used by the end-to-end test (scripts/bots.ts) and by `npm run botplay`.
// It plays through the real client Game, so it sees exactly what a player's browser sees.

import { NO_CONTROLS, track, type Controls, type Game } from "../client/game";
import { angleDiff, clamp, speedOf } from "../shared/physics";
import { pointAt, queryTrackNear } from "../shared/track";

export class BotDriver {
  weapons = true;
  private raceSteps = 0; // steps since this bot's race started (input applies)
  private slow = 0;
  private reversing = 0;

  constructor(
    private readonly game: Game,
    /** Racing line offset from the centerline (units, + = right of travel). */
    readonly lateral: number,
  ) {}

  /** Follow the line, brake for bends, shoot what is ahead, drop a mine now and then. */
  controls(): Controls {
    const g = this.game;
    const c = g.car;
    if (!c) {
      this.raceSteps = 0;
      return NO_CONTROLS;
    }
    if (g.raceOn()) this.raceSteps++;
    const q = queryTrackNear(track, c.x, c.y, c.seg);
    const v = speedOf(c);
    const t = pointAt(track, q.s + 55 + v * 0.3);
    const tx = t.x - Math.sin(t.h) * this.lateral;
    const ty = t.y + Math.cos(t.h) * this.lateral;
    let steer = clamp(angleDiff(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
    const near = pointAt(track, q.s + 20).h;
    const far = pointAt(track, q.s + 20 + Math.max(120, v * 0.9)).h;
    const bend = Math.abs(angleDiff(near, far));
    const target = bend > 1.4 ? 200 : bend > 0.9 ? 260 : bend > 0.5 ? 330 : 1000;
    let throttle = v > target + 25 ? -1 : v > target ? 0 : 1;

    // Spun into a wall after a mine: back out for a moment.
    if (g.raceOn() && c.wreck === 0 && v < 20) this.slow++;
    else this.slow = 0;
    if (this.slow > 90) {
      this.reversing = 50;
      this.slow = 0;
    }
    if (this.reversing > 0) {
      this.reversing--;
      throttle = -1;
      steer = -steer;
    }

    let fire = false;
    if (this.weapons) {
      fire = g.otherPoses().some((o) => {
        const s = g.latest?.cars.get(o.id);
        if (!s || s.ghost || s.wreck) return false;
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        return d > 1 && d < 500 && Math.abs(angleDiff(c.h, Math.atan2(o.y - c.y, o.x - c.x))) < Math.PI / 12;
      });
    }
    // No mines in the first 6 s (no start-line minefield), then one every 8 s, staggered by lane.
    const offset = Math.round(Math.abs(this.lateral) * 7) % 480;
    const mine = this.weapons && this.raceSteps > 360 && this.raceSteps % 480 === offset;
    return { throttle, steer, fire, mine };
  }
}
