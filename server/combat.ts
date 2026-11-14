// Shots, mines, damage, wrecks, ghosting and repair for one room. Server-only: the client
// learns about hits from events and snapshots (it only predicts its own car's movement).

import type { CarState } from "../shared/physics";
import type { GameEvent, MineSnap, ShotSnap } from "../shared/protocol";
import { regenPerTick, type Ammo, type Levels } from "../shared/shop";
import type { Track } from "../shared/track";
import {
  BTN_RIVET,
  GHOST_TICKS,
  MINE_ARM_TICKS,
  MINE_DAMAGE,
  MINE_LIFE_TICKS,
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

/** Can be hit and can collide with other cars. */
export function solid(f: Fighter): boolean {
  return !!f.car && f.car.wreck === 0 && f.ghost === 0 && !f.finished;
}

export class Combat {
  shots: Shot[] = [];
  mines: Mine[] = [];
  readonly wrecksCaused = new Map<string, number>();
  private nextId = 1;

  constructor(
    private readonly track: Track,
    private readonly emit: (ev: GameEvent) => void,
  ) {}

  reset(): void {
    this.shots = [];
    this.mines = [];
    this.wrecksCaused.clear();
  }

  /**
   * Weapons for one consumed command, right after the fighter's car stepped (the client
   * spawns its cosmetic shots at the same point). `minePress` is true only when a real
   * input's mine counter changed.
   */
  act(f: Fighter, cmd: Command, minePress: boolean, racing: boolean): void {
    if (f.cooldown > 0) f.cooldown--;
    if (!racing || !solid(f)) return;
    const car = f.car!;
    if (cmd.buttons & BTN_RIVET && f.cooldown === 0 && f.ammo.rivets > 0) {
      this.shots.push(spawnShot(car, this.nextId++, f.id));
      f.ammo.rivets--;
      f.cooldown = RIVET_COOLDOWN;
    }
    if (minePress && f.ammo.mines > 0) {
      this.mines.push(spawnMine(car, this.nextId++, f.id));
      f.ammo.mines--;
    }
  }

  /** Move shots and mines, apply hits, run wreck/ghost/repair timers. Racing phase only. */
  step(fighters: Fighter[], prev: Map<string, { x: number; y: number }>): void {
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

    const mines: Mine[] = [];
    for (const m of this.mines) {
      m.age++;
      if (m.age > MINE_LIFE_TICKS) continue;
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

    for (const f of fighters) {
      const c = f.car;
      if (!c) continue;
      if (f.hp <= 0 && c.wreck === 0) {
        // stepRaceCar respawned it this tick
        f.hp = f.maxHp;
        f.ghost = GHOST_TICKS;
      } else if (f.ghost > 0) {
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

  mineSnaps(): MineSnap[] {
    return this.mines.map((m) => ({
      k: "mine",
      id: m.id,
      o: m.owner,
      x: Math.round(m.x * 10) / 10,
      y: Math.round(m.y * 10) / 10,
      armed: m.age >= MINE_ARM_TICKS,
    }));
  }
}
