// Keyboard input: arrows or WASD. Touch and gamepad come later.

import type { Input } from "../shared/physics";

const UP = new Set(["ArrowUp", "KeyW"]);
const DOWN = new Set(["ArrowDown", "KeyS", "Space"]);
const LEFT = new Set(["ArrowLeft", "KeyA"]);
const RIGHT = new Set(["ArrowRight", "KeyD"]);

export class Keyboard {
  private readonly down = new Set<string>();

  constructor(target: Window) {
    target.addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      const k = keyId(e);
      if (UP.has(k) || DOWN.has(k) || LEFT.has(k) || RIGHT.has(k)) {
        e.preventDefault();
        this.down.add(k);
      }
    });
    target.addEventListener("keyup", (e) => this.down.delete(keyId(e)));
    target.addEventListener("blur", () => this.down.clear());
  }

  read(): Input {
    const any = (keys: Set<string>) => [...keys].some((k) => this.down.has(k));
    return {
      throttle: (any(UP) ? 1 : 0) - (any(DOWN) ? 1 : 0),
      steer: (any(RIGHT) ? 1 : 0) - (any(LEFT) ? 1 : 0),
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
