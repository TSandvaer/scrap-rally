// The in-game menu (PLAN-MENU.md, MENU-1): Esc opens and closes it in a room, in any phase.
// Everyone: Resume, Sound, Controls, Copy invite link, Retire to garage (racing with a car on
// the field, MENU-2), Leave room. The host also gets Stop and
// Restart race (countdown and race only), Lock / Unlock room, and the players list with Make
// host and Remove. A modal over the whole stage; while it is open the frame loop drives with
// NO_CONTROLS (client/main.ts), so the race keeps running and the own car coasts. The main
// and confirm views follow the room: main.ts calls render() on every room message. Built with
// textContent only.

import type { AudioEngine } from "./audio";
import type { Game } from "./game";

type View = "main" | "sound" | "controls" | "confirm";

interface Confirm {
  text: string;
  label: string; // the confirm button
  run(): void;
  applies(): boolean; // still possible (the race may have ended, the player left)
  closeAfter: boolean;
}

export interface MenuDeps {
  root: HTMLElement; // #game-menu: the backdrop, holding the panel
  game: Game;
  audio: AudioEngine;
  /** The menu opened: held driving keys are dropped (Keyboard.clear). */
  onOpen(): void;
  /** Leave the room for good (as the lobby's Leave button). */
  leave(): void;
  copyInvite(): void;
}

const KEYS: [string, string[][]][] = [
  ["Drive", [["↑", "↓", "←", "→"], ["W", "A", "S", "D"]]],
  ["Rivet gun (hold)", [["Space"], ["Z"], ["J"]]],
  ["Drop a mine (tap)", [["X"], ["K"]]],
  ["Chat", [["Enter"]]],
  ["Mute sound", [["M"]]],
  ["This menu", [["Esc"]]],
];

export class GameMenu {
  private view: View = "main";
  private confirmAsk: Confirm | null = null;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly note: HTMLElement;
  private readonly body: HTMLElement;
  private built = ""; // the view the body was last built for
  private music: HTMLInputElement | null = null;
  private effects: HTMLInputElement | null = null;
  private muteBtn: HTMLButtonElement | null = null;

  constructor(private readonly deps: MenuDeps) {
    const root = deps.root;
    this.panel = el("section", "panel gm");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-labelledby", "gm-title");
    const head = el("div", "gm-head");
    this.title = el("h2", "gm-title", "Menu");
    this.title.id = "gm-title";
    this.sub = el("span", "gm-sub");
    head.append(this.title, this.sub);
    this.note = el("p", "gm-note hidden");
    this.body = el("div", "gm-body");
    this.panel.append(head, this.note, this.body);
    root.replaceChildren(this.panel);
    // A click on the dimmed stage around the panel is Resume.
    root.addEventListener("pointerdown", (e) => {
      if (e.target === root) this.close();
    });
    // Enter and Space act on the focused menu button; they must not open the chat (client/chat.ts
    // opens it on Enter anywhere) or reach the driving keys.
    root.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") e.stopPropagation();
    });
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.isOpen && e.key === "Enter" && !root.contains(e.target as Node)) e.stopPropagation();
      },
      true,
    );
    deps.audio.onChange(() => this.renderSound());
  }

  get isOpen(): boolean {
    return !this.deps.root.classList.contains("hidden");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** In a room only. Inputs are blurred and held keys dropped; Resume takes the focus. */
  open(): void {
    if (!this.deps.game.you || this.isOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    this.deps.onOpen();
    this.view = "main";
    this.confirmAsk = null;
    this.deps.root.classList.remove("hidden");
    this.render();
    this.body.querySelector<HTMLButtonElement>("button")?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.deps.root.contains(active)) active.blur();
    this.deps.root.classList.add("hidden");
    this.view = "main";
    this.confirmAsk = null;
    this.built = "";
  }

  /**
   * Bring the open menu up to date with the room (every room message): the header, the race
   * note, and the main or confirm view (host items per phase, the players list). The sound and
   * controls views do not depend on the room and are not rebuilt (a slider being dragged keeps
   * its grip). The focused button keeps the focus across a rebuild.
   */
  render(): void {
    const g = this.deps.game;
    if (!g.you) {
      this.close();
      return;
    }
    if (!this.isOpen) return;
    if (this.view === "confirm" && !this.confirmAsk?.applies()) {
      this.view = "main";
      this.confirmAsk = null;
    }
    setText(this.sub, `Room ${g.code}${g.locked ? " · locked" : ""}`);
    const racing = g.phase === "countdown" || g.phase === "racing";
    const noteText = !racing
      ? ""
      : g.ownSnap()
        ? "The race keeps running while this menu is open: your car coasts."
        : "The race keeps running while this menu is open.";
    setText(this.note, noteText);
    this.note.classList.toggle("hidden", !noteText);
    if (this.built === this.view && (this.view === "sound" || this.view === "controls")) return;

    const focused = document.activeElement instanceof HTMLElement && this.body.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    this.music = this.effects = this.muteBtn = null;
    if (this.view === "main") this.body.replaceChildren(...this.mainView());
    else if (this.view === "sound") this.body.replaceChildren(...this.soundView());
    else if (this.view === "controls") this.body.replaceChildren(...this.controlsView());
    else this.body.replaceChildren(...this.confirmView(this.confirmAsk!));
    this.built = this.view;
    setText(this.title, this.view === "sound" ? "Sound" : this.view === "controls" ? "Controls" : "Menu");
    if (focused) this.body.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
    this.renderSound();
  }

  private show(view: View): void {
    this.view = view;
    this.render();
    this.body.querySelector<HTMLElement>("button, input")?.focus();
  }

  private ask(c: Confirm): void {
    this.confirmAsk = c;
    this.show("confirm");
  }

  private mainView(): HTMLElement[] {
    const g = this.deps.game;
    const list = el("div", "gm-list");
    list.append(
      button("Resume", "resume", () => this.close(), "primary"),
      button("Sound", "sound", () => this.show("sound")),
      button("Controls", "controls", () => this.show("controls")),
      button("Copy invite link", "invite", () => this.deps.copyInvite()),
    );
    if (g.canRetire()) {
      list.append(
        button("Retire to garage", "retire", () =>
          this.ask({
            text: "Retire from this race? Your car leaves the track and you are out of this race (DNF; any wreck bonus is still paid). You go to the garage to shop and chat while the others finish, and you race again next time.",
            label: "Retire",
            run: () => g.retire(),
            applies: () => g.canRetire(),
            closeAfter: true,
          }),
        ),
      );
    }
    list.append(
      button("Leave room", "leave", () =>
        this.ask({
          text: "Leave the room for good? Your seat, scrap and upgrades in this room are gone.",
          label: "Leave room",
          run: () => this.deps.leave(),
          applies: () => !!g.you,
          closeAfter: true,
        }),
      ),
    );
    const out: HTMLElement[] = [list];
    if (!g.isHost()) {
      const host = g.player(g.hostId);
      if (host) out.push(el("p", "muted fine", `${host.name} is the host`));
      return out;
    }

    const hostBox = el("div", "gm-host");
    hostBox.append(el("div", "label", "Host controls"));
    const racing = () => g.isHost() && (g.phase === "countdown" || g.phase === "racing");
    if (racing()) {
      const row = el("div", "gm-row");
      row.append(
        button("Stop race", "stop", () =>
          this.ask({
            text: "Stop the race for everyone? Back to the lobby: no results, no scrap paid, and everyone gets back the ammo they used.",
            label: "Stop race",
            run: () => g.stopRace(),
            applies: racing,
            closeAfter: true,
          }),
        ),
        button("Restart race", "restart", () =>
          this.ask({
            text: "Restart the race? A fresh countdown on the same track for everyone connected, with the ammo used so far given back.",
            label: "Restart race",
            run: () => g.restartRace(),
            applies: racing,
            closeAfter: true,
          }),
        ),
      );
      hostBox.append(row);
    }
    const lock = button(g.locked ? "Unlock room" : "Lock room", "lock", () => g.setLocked(!g.locked));
    lock.setAttribute("aria-pressed", String(g.locked));
    hostBox.append(lock, el("p", "muted fine", g.locked ? "Locked: no new drivers can join. Drivers already in can still rejoin." : "Lock the room to keep new drivers out."));

    hostBox.append(el("div", "label", "Players"));
    const ul = el("ul", "players gm-players");
    for (const p of g.players) {
      const li = el("li", p.connected ? "" : "offline");
      const sw = el("span", "swatch");
      sw.style.background = p.color;
      li.append(sw, el("span", "name", p.name));
      if (p.id === g.you) {
        li.append(el("span", "tag-pill host", "you · host"));
        if (p.retired) li.append(el("span", "tag-pill", "retired"));
      } else {
        if (!p.connected) li.append(el("span", "tag-pill", "offline"));
        if (p.retired) li.append(el("span", "tag-pill", "retired"));
        const acts = el("span", "gm-acts");
        const make = button("Make host", `host:${p.id}`, () => g.makeHost(p.id), "small");
        make.disabled = !p.connected;
        if (!p.connected) make.title = "Offline drivers cannot be the host";
        const name = p.name;
        const id = p.id;
        const remove = button("Remove", `kick:${p.id}`, () =>
          this.ask({
            text: `Remove ${name} from the room? They are out at once and cannot come back with this seat.`,
            label: `Remove ${name}`,
            run: () => g.kick(id),
            applies: () => g.isHost() && !!g.player(id),
            closeAfter: false,
          }),
          "small danger",
        );
        acts.append(make, remove);
        li.append(acts);
      }
      ul.append(li);
    }
    hostBox.append(ul);
    if (g.players.length < 2) hostBox.append(el("p", "muted fine", "No other drivers yet."));
    out.push(hostBox);
    return out;
  }

  private soundView(): HTMLElement[] {
    const a = this.deps.audio;
    const slider = (label: string, key: "music" | "effects"): [HTMLElement, HTMLInputElement] => {
      const row = el("div", "vol");
      const id = `gm-vol-${key}`;
      const cap = el("span", "", label);
      cap.id = `${id}-label`;
      const input = el("input") as HTMLInputElement;
      input.type = "range";
      input.min = "0";
      input.max = "100";
      input.step = "5";
      input.id = id;
      input.dataset.key = key;
      input.setAttribute("aria-labelledby", cap.id);
      input.addEventListener("input", () => a.set({ [key]: Number(input.value) / 100 }));
      row.append(cap, input);
      return [row, input];
    };
    const [mRow, m] = slider("Music", "music");
    const [eRow, e] = slider("Effects", "effects");
    this.music = m;
    this.effects = e;
    this.muteBtn = button("Mute (M)", "mute", () => a.toggleMute(), "small");
    const box = el("div", "gm-sound");
    box.append(mRow, eRow, this.muteBtn);
    return [box, this.backButton()];
  }

  /** The sound view's controls follow the settings (also M pressed while it is open). */
  private renderSound(): void {
    const s = this.deps.audio.settings;
    if (this.music && document.activeElement !== this.music) this.music.value = String(Math.round(s.music * 100));
    if (this.effects && document.activeElement !== this.effects) this.effects.value = String(Math.round(s.effects * 100));
    if (this.muteBtn) {
      setText(this.muteBtn, s.muted ? "Unmute (M)" : "Mute (M)");
      this.muteBtn.setAttribute("aria-pressed", String(s.muted));
    }
  }

  private controlsView(): HTMLElement[] {
    const dl = el("dl", "gm-keys");
    for (const [what, combos] of KEYS) {
      const dd = el("dd");
      combos.forEach((keys, i) => {
        if (i > 0) dd.append(" / ");
        for (const k of keys) dd.append(el("kbd", "", k));
      });
      dl.append(el("dt", "", what), dd);
    }
    return [dl, this.backButton()];
  }

  private confirmView(c: Confirm): HTMLElement[] {
    const row = el("div", "gm-row");
    row.append(
      button(c.label, "confirm", () => {
        const after = c.closeAfter;
        this.confirmAsk = null;
        this.view = "main";
        c.run();
        if (after) this.close();
        else this.show("main");
      }, "danger"),
      button("Cancel", "cancel", () => this.show("main")),
    );
    return [el("p", "gm-ask", c.text), row];
  }

  private backButton(): HTMLButtonElement {
    return button("Back", "back", () => this.show("main"), "link");
  }
}

function el(tag: string, cls = "", text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, key: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", `btn${cls ? ` ${cls}` : ""}`, text) as HTMLButtonElement;
  b.type = "button";
  b.dataset.key = key;
  b.addEventListener("click", onClick);
  return b;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}
