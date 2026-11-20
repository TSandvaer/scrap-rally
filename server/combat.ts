// Shots, mines, damage, wrecks, ghosting and repair for one room. Server-only: the client
// learns about hits from events and snapshots (it only predicts its own car's movement).

import { capsuleGap, type CarState } from "../shared/physics";
import type { GameEvent, MineSnap, ShotSnap } from "../shared/protocol";
import { regenPerTick, type Ammo, type Levels } from "../shared/shop";
import type { Track } from "../shared/track";
import {
  BTN_RIVET,
  DEFAULT_MINE_MODE,
  GHOST_TICKS,
  MINE_ARM_TICKS,
  MINE_CAP,
  MINE_DAMAGE,
  MINE_FADE_TICKS,
  MINE_LIFE_TICKS,
  MINE_OUT_TICKS,
  mineHits,
  moveShot,
  RIVET_COOLDOWN,
  RIVET_DAMAGE,
  shotHits,
  spawnMine,
  spawnShot,
  spinOut,
  wreckCar,
  type Command,
  type Mine,
  type MineMode,
  type Shot,
} from "../shared/weapons";

/** The parts of a player that combat reads and writes. */
export interface Fighter {
  id: string;
  car: CarState | null;
  finished: boolean;
  hp: number;
  maxHp: number;
  ghost: number; // ticks left
  cooldown: number; // ticks until the rivet gun can fire again
  ammo: Ammo;
  levels: Levels;
}

/**
 * Can be hit, can collide with other cars and can fire or drop mines: on the ground and not
 * wrecked, falling, ghosted or finished. Airborne cars pass over mines, rivets and cars.
 */
export function solid(f: Fighter): boolean {
  const c = f.car;
  return !!c && c.wreck === 0 && c.air === 0 && c.fall === 0 && f.ghost === 0 && !f.finished;
}

/** Does f's car overlap another fighter's car (car-car capsules)? */
function overlapsAnother(f: Fighter, fighters: Fighter[]): boolean {
  const c = f.car;
  return !!c && fighters.some((o) => o !== f && !!o.car && capsuleGap(c, o.car) < 0);
}

/** A mine the cap took off the track: harmless, kept for the clients' blink-out. */
interface GoneMine {
  mine: Mine;
  left: number; // ticks until it is dropped from the snapshots
}

export class Combat {
  shots: Shot[] = [];
  /** The mines on the track, oldest first. */
  mines: Mine[] = [];
  /** Mines the cap took off the track ("stay"), still shown blinking out (MINE_OUT_TICKS). */
  gone: GoneMine[] = [];
  /**
   * This race's mines mode (shared/weapons.ts MineMode): the room sets it as the race begins,
   * so the host's change during a race applies from the next one.
   */
  mode: MineMode = DEFAULT_MINE_MODE;
  readonly wrecksCaused = new Map<string, number>();
  private nextId = 1;

  constructor(
    private readonly track: Track,
    private readonly emit: (ev: GameEvent) => void,
  ) {}

  reset(): void {
    this.shots = [];
    this.mines = [];
    this.gone = [];
    this.wrecksCaused.clear();
  }

  /**
   * Weapons for one consumed command, right after the fighter's car stepped (the client
   * spawns its cosmetic shots at the same point). `minePress` is true only when a real
   * input's mine counter changed. `armed`: racing and past the weapons-armed delay.
   */
  act(f: Fighter, cmd: Command, minePress: boolean, armed: boolean): void {
    if (f.cooldown > 0) f.cooldown--;
    if (!armed || !solid(f)) return;
    const car = f.car!;
    if (cmd.buttons & BTN_RIVET && f.cooldown === 0 && f.ammo.rivets > 0) {
      this.shots.push(spawnShot(car, this.nextId++, f.id));
      f.ammo.rivets--;
      f.cooldown = RIVET_COOLDOWN;
    }
    if (minePress && f.ammo.mines > 0) {
      this.mines.push(spawnMine(car, this.nextId++, f.id));
      f.ammo.mines--;
      // "stay": one more than the cap takes the oldest off the track. It is out of `mines`
      // at once (it hits nobody any more) and only shown blinking out from here on.
      if (this.mode === "stay" && this.mines.length > MINE_CAP) this.gone.push({ mine: this.mines.shift()!, left: MINE_OUT_TICKS });
    }
  }

  /**
   * Move shots and mines, apply hits, run wreck/ghost/repair timers. Racing phase only.
   * recovered: fighters whose car stepRaceCar placed at a recovery point this tick (the room
   * gave them GHOST_TICKS before the car-car pass; it starts counting down next tick, like
   * the ghost after a wreck respawn).
   */
  step(fighters: Fighter[], prev: Map<string, { x: number; y: number }>, recovered: ReadonlySet<Fighter> = new Set()): void {
    const live: Shot[] = [];
    for (const s of this.shots) {
      const x0 = s.x, y0 = s.y;
      let alive = moveShot(s, this.track);
      if (alive) {
        for (const f of fighters) {
          if (f.id === s.owner || !solid(f)) continue;
          const c = f.car!;
          const p = prev.get(f.id) ?? c;
          if (shotHits(x0, y0, s.x, s.y, p.x, p.y, c.x, c.y)) {
            this.damage(f, RIVET_DAMAGE, s.owner, "rivet");
            alive = false;
            break;
          }
        }
      }
      if (alive) live.push(s);
    }
    this.shots = live;

    const fade = this.mode === "fade";
    const mines: Mine[] = [];
    for (const m of this.mines) {
      m.age++;
      if (fade && m.age > MINE_LIFE_TICKS) continue;
      let alive = true;
      if (m.age >= MINE_ARM_TICKS) {
        for (const f of fighters) {
          if (!solid(f) || !mineHits(m, f.car!)) continue;
          spinOut(f.car!, m.x, m.y);
          this.damage(f, MINE_DAMAGE, m.owner, "mine");
          alive = false;
          break;
        }
      }
      if (alive) mines.push(m);
    }
    this.mines = mines;
    if (this.gone.length) this.gone = this.gone.filter((g) => --g.left > 0);

    for (const f of fighters) {
      const c = f.car;
      if (!c) continue;
      if (f.hp <= 0 && c.wreck === 0) {
        // stepRaceCar respawned it this tick
        f.hp = f.maxHp;
        f.ghost = GHOST_TICKS;
      } else if (f.ghost > 0 && !recovered.has(f) && (f.ghost > 1 || !overlapsAnother(f, fighters))) {
        // A ghost never runs out while the car still overlaps another car (two cars put at
        // the same spot would otherwise be shoved apart the moment it ends).
        f.ghost--;
      }
      if (c.wreck === 0 && f.hp > 0 && f.hp < f.maxHp) {
        f.hp = Math.min(f.maxHp, f.hp + regenPerTick(f.levels));
      }
    }
  }

  damage(f: Fighter, dmg: number, by: string, w: "rivet" | "mine"): void {
    f.hp -= dmg;
    this.emit({ k: "hit", id: f.id, by, dmg, w });
    if (f.hp > 0) return;
    f.hp = 0;
    wreckCar(f.car!);
    this.emit({ k: "wreck", id: f.id, by });
    if (by !== f.id) this.wrecksCaused.set(by, (this.wrecksCaused.get(by) ?? 0) + 1);
  }

  shotSnaps(): ShotSnap[] {
    return this.shots.map((s) => ({
      k: "shot",
      id: s.id,
      o: s.owner,
      x: Math.round(s.x * 10) / 10,
      y: Math.round(s.y * 10) / 10,
      vx: Math.round(s.vx),
      vy: Math.round(s.vy),
    }));
  }

  /**
   * The mines on the track, then those blinking out after the cap took them off it (not armed).
   * `out` (ticks until it is gone) goes only with a mine that blinks out: a "fade" mine in the
   * last MINE_FADE_TICKS of its life, and a mine the cap took.
   */
  mineSnaps(): MineSnap[] {
    const fade = this.mode === "fade";
    const snaps: MineSnap[] = [];
    for (const m of this.mines) {
      const s = mineSnap(m, m.age >= MINE_ARM_TICKS);
      const left = MINE_LIFE_TICKS - m.age + 1; // it is gone on the step that takes its age past its life
      if (fade && left <= MINE_FADE_TICKS) s.out = left;
      snaps.push(s);
    }
    for (const g of this.gone) {
      const s = mineSnap(g.mine, false);
      s.out = g.left;
      snaps.push(s);
    }
    return snaps;
  }
}

function mineSnap(m: Mine, armed: boolean): MineSnap {
  return { k: "mine", id: m.id, o: m.owner, x: Math.round(m.x * 10) / 10, y: Math.round(m.y * 10) / 10, armed };
}
