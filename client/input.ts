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
      if (UP.has(e.code) || DOWN.has(e.code) || LEFT.has(e.code) || RIGHT.has(e.code)) {
        e.preventDefault();
        this.down.add(e.code);
      }
    });
    target.addEventListener("keyup", (e) => this.down.delete(e.code));
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

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}
