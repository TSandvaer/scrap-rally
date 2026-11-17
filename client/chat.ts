// Room chat panel (PLAN-CHAT.md). Docked inside the lobby panel in the lobby (log and input
// always shown); an overlay at the bottom-left of the race view in every other phase, where it
// is closed by default (the last few lines fade out, an unread count) and Enter or the chat
// button opens the full, scrollable history. Lines are rendered with textContent only.

import { CHAT_HISTORY, type ChatLine } from "../shared/protocol";
import { VIEW_H, VIEW_W } from "./render";

const FEED_LINES = 4; // closed overlay: at most this many recent lines ...
const FEED_MS = 8000; // ... each shown this long (the fade is in style.css, chat-fade)
const BOTTOM_SLACK = 24; // px from the bottom that still counts as "at the bottom"
// Race view (640x360) rows the overlay keeps clear of: the banner strip at the bottom
// (render.ts hud: VIEW_H - 26 .. VIEW_H - 6) and, with ?debug=1, the debug box (x 6..226).
const BANNER_TOP = 28;
const DEBUG_RIGHT = 232;

export type ChatMode = "off" | "docked" | "overlay";

export interface ChatDeps {
  root: HTMLElement; // #chat
  dock: HTMLElement; // its place in the lobby panel
  stage: HTMLElement; // its place over the race view
  view: HTMLCanvasElement;
  me(): string; // own player id
  send(text: string): void;
  onFocus(): void; // the input took focus (held driving keys are dropped)
}

export class ChatPanel {
  mode: ChatMode = "off";
  /** Overlay only: the history and the input are shown. Docked, they always are. */
  open = false;
  unread = 0;
  private readonly root: HTMLElement;
  private readonly log: HTMLOListElement;
  private readonly feed: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly pill: HTMLButtonElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly unreadEl: HTMLElement;
  private debug = false;

  constructor(private readonly deps: ChatDeps) {
    const root = (this.root = deps.root);
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.log = q<HTMLOListElement>(".chat-log");
    this.feed = q(".chat-feed");
    this.input = q<HTMLInputElement>(".chat-input");
    this.pill = q<HTMLButtonElement>(".chat-pill");
    this.openBtn = q<HTMLButtonElement>(".chat-open");
    this.unreadEl = q(".chat-unread");

    this.openBtn.addEventListener("click", () => this.openBox());
    q<HTMLButtonElement>(".chat-close").addEventListener("click", () => this.closeBox());
    q<HTMLButtonElement>(".chat-send").addEventListener("click", () => this.submit(true));
    this.pill.addEventListener("click", () => this.toBottom());
    this.log.addEventListener("scroll", () => {
      if (this.atBottom()) show(this.pill, false);
    });
    this.input.addEventListener("focus", () => {
      deps.onFocus();
      if (this.mode === "overlay" && !this.open) this.setOpen(true);
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // an IME is composing: its Enter is not ours
      if (e.key === "Enter") {
        e.preventDefault();
        if (!e.repeat) this.submit(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeBox();
      }
    });
    // Enter opens the chat, in a room only (the menu inputs own their Enter), unless another
    // text field has focus. On a focused button or the track <select>, Enter would act on it
    // (Ready / Start / Leave clicked again), so its default is prevented.
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || this.mode === "off" || e.isComposing || isTextField(e.target)) return;
      e.preventDefault();
      if (!e.repeat) this.openBox();
    });
    new ResizeObserver(() => this.layout()).observe(deps.view);
    window.addEventListener("resize", () => this.layout());
  }

  /** Replace the whole history (the room's chatlog, or [] on leave). */
  reset(lines: readonly ChatLine[]): void {
    this.log.replaceChildren(...lines.slice(-CHAT_HISTORY).map((l) => this.lineEl(l)));
    this.feed.replaceChildren();
    this.unread = 0;
    this.renderUnread();
    show(this.pill, false);
    this.toBottom();
  }

  /** A live line. */
  add(line: ChatLine): void {
    const stick = this.atBottom() || line.from === this.deps.me();
    this.log.append(this.lineEl(line));
    while (this.log.childElementCount > CHAT_HISTORY) this.log.firstElementChild!.remove();
    if (stick) this.toBottom();
    else show(this.pill, true);
    if (this.mode !== "overlay" || this.open) return;
    // Closed overlay: the line fades in over the view and out again; counted as unread.
    const el = this.lineEl(line);
    el.classList.add("fade");
    el.style.animationDuration = `${FEED_MS}ms`;
    el.addEventListener("animationend", () => el.remove());
    this.feed.append(el);
    while (this.feed.childElementCount > FEED_LINES) this.feed.firstElementChild!.remove();
    if (line.from !== this.deps.me()) {
      this.unread++;
      this.renderUnread();
    }
  }

  /** Lobby: docked in the lobby panel; countdown, race and results: over the view. */
  setMode(mode: ChatMode, debug = false): void {
    this.debug = debug;
    this.root.classList.toggle("debug", debug);
    if (mode === this.mode) return;
    const typing = document.activeElement === this.input; // moving the node drops the focus
    this.mode = mode;
    show(this.root, mode !== "off");
    this.root.classList.toggle("docked", mode === "docked");
    this.root.classList.toggle("overlay", mode === "overlay");
    if (mode === "docked") this.deps.dock.append(this.root);
    else if (mode === "overlay") this.deps.stage.append(this.root);
    if (mode === "off") this.input.value = "";
    this.feed.replaceChildren();
    this.unread = 0;
    this.renderUnread();
    this.setOpen(mode === "overlay" && typing);
    if (typing && mode !== "off") this.input.focus();
    this.layout();
    this.toBottom();
  }

  /** Open the chat and put the cursor in the input. */
  openBox(): void {
    if (this.mode === "off") return;
    if (this.mode === "overlay") this.setOpen(true);
    this.input.focus();
  }

  /** Esc, the close button, or a message sent in a race: back to driving. */
  closeBox(): void {
    if (this.mode === "overlay") this.setOpen(false);
    this.input.blur();
  }

  /** Enter or Send. In the lobby the box stays open; in a race it closes after sending. */
  private submit(fromButton: boolean): void {
    const text = this.input.value.trim();
    this.input.value = "";
    if (text) this.deps.send(text);
    if (this.mode === "overlay") this.closeBox();
    else if (text || fromButton) this.input.focus();
    else this.closeBox(); // Enter on an empty line in the lobby: back out of the input
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle("open", open);
    if (open) {
      this.feed.replaceChildren();
      this.unread = 0;
      this.renderUnread();
      this.toBottom();
    }
  }

  private renderUnread(): void {
    this.unreadEl.textContent = String(this.unread);
    show(this.unreadEl, this.unread > 0);
    this.openBtn.classList.toggle("has-unread", this.unread > 0);
  }

  private atBottom(): boolean {
    const l = this.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight <= BOTTOM_SLACK;
  }

  private toBottom(): void {
    this.log.scrollTop = this.log.scrollHeight;
    show(this.pill, false);
  }

  /** Where the race view is drawn, for the overlay's place (CSS variables on the root). */
  private layout(): void {
    if (this.mode !== "overlay") return;
    const v = this.deps.view.getBoundingClientRect();
    const s = this.deps.stage.getBoundingClientRect();
    const st = this.root.style;
    const left = v.left - s.left + (this.debug ? (v.width * DEBUG_RIGHT) / VIEW_W : 0);
    st.setProperty("--view-left", `${Math.round(left)}px`);
    st.setProperty("--view-bottom", `${Math.round(s.bottom - v.bottom + (v.height * BANNER_TOP) / VIEW_H)}px`);
    st.setProperty("--view-w", `${Math.round(v.width)}px`);
    st.setProperty("--view-h", `${Math.round(v.height)}px`);
  }

  private lineEl(l: ChatLine): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `chat-line ${l.kind === "say" ? "say" : "game"}`;
    if (l.kind === "say" && l.from === this.deps.me()) li.classList.add("me");
    if (l.name) {
      const name = span("chat-name", l.name);
      name.style.color = l.color;
      li.append(name, " ");
    }
    li.append(span("chat-text", l.text));
    return li;
  }
}

/**
 * Size the stage to the visual viewport, so an on-screen keyboard does not cover the chat
 * input (--app-h / --app-top in style.css). Not while pinch-zoomed.
 */
export function fitViewport(): void {
  const vv = window.visualViewport;
  const fit = () => {
    const zoomed = !!vv && Math.abs(vv.scale - 1) > 0.01;
    const h = vv && !zoomed ? vv.height : window.innerHeight;
    const top = vv && !zoomed ? vv.offsetTop : 0;
    const st = document.documentElement.style;
    st.setProperty("--app-h", `${Math.round(h)}px`);
    st.setProperty("--app-top", `${Math.round(top)}px`);
  };
  fit();
  vv?.addEventListener("resize", fit);
  vv?.addEventListener("scroll", fit);
  window.addEventListener("resize", fit);
}

function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function show(el: HTMLElement, on: boolean): void {
  el.classList.toggle("hidden", !on);
}
