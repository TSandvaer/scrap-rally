// Keyboard input: arrows or WASD to drive, Space / Z / J for the rivet gun (hold),
// X / K to drop a mine (tap). Touch and gamepad come later.

import type { Controls } from "./game";

const UP = new Set(["ArrowUp", "KeyW"]);
const DOWN = new Set(["ArrowDown", "KeyS"]);
const LEFT = new Set(["ArrowLeft", "KeyA"]);
const RIGHT = new Set(["ArrowRight", "KeyD"]);
const FIRE = new Set(["Space", "KeyZ", "KeyJ"]);
const MINE = new Set(["KeyX", "KeyK"]);
const ALL = [UP, DOWN, LEFT, RIGHT, FIRE, MINE];

export class Keyboard {
  private readonly down = new Set<string>();
  private minePressed = false; // latched until read, so a tap shorter than a step counts

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      const k = keyId(e);
      if (!ALL.some((set) => set.has(k))) return;
      e.preventDefault();
      if (MINE.has(k) && !e.repeat) this.minePressed = true;
      this.down.add(k);
    });
    target.addEventListener("keyup", (e) => this.down.delete(keyId(e)));
    target.addEventListener("blur", () => this.down.clear());
  }

  /**
   * Forget every held key, e.g. when the chat input takes focus: typing only blocks new
   * keydowns, so a key held at that moment would otherwise keep driving until its keyup.
   */
  clear(): void {
    this.down.clear();
    this.minePressed = false;
  }

  read(): Controls {
    const any = (keys: Set<string>) => [...keys].some((k) => this.down.has(k));
    const mine = this.minePressed;
    this.minePressed = false;
    return {
      throttle: (any(UP) ? 1 : 0) - (any(DOWN) ? 1 : 0),
      steer: (any(RIGHT) ? 1 : 0) - (any(LEFT) ? 1 : 0),
      fire: any(FIRE),
      mine,
    };
  }
}

/** Physical key id; synthetic events (automation, some remappers) only carry `key`. */
function keyId(e: KeyboardEvent): string {
  if (e.code) return e.code;
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return `Key${e.key.toUpperCase()}`;
  return e.key;
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}
