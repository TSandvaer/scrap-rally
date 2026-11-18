// The HUD, in view pixels (identity transform): name tags over the other cars, the minimap
// (its box at VIEW_W - 112 is fixed: client/audio.ts and client/chat.ts lay out around it)
// and the text panels (lap / position, time, notice, countdown, banner strip, corner, debug).

import type { Track } from "../../shared/track";
import type { CarView, HudView } from "../render";
import { groundRuns, polyPath, VIEW_H, VIEW_W, ZOOM } from "./world";

const PAL = {
  hudBg: "rgba(18,14,11,0.72)",
  hudText: "#efe6d2",
  accent: "#e8752d",
};

export class Hud {
  private readonly mini: { scale: number; ox: number; oy: number; path: Path2D };
  /** The minimap's track line ends flat at a gap (butt caps); a closed path keeps round caps. */
  private readonly cap: CanvasLineCap;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    track: Track,
  ) {
    this.cap = track.gaps.length ? "butt" : "round";
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of track.pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const box = 96;
    const scale = box / Math.max(maxX - minX, maxY - minY);
    const ox = VIEW_W - 10 - box + (box - (maxX - minX) * scale) / 2 - minX * scale;
    const oy = 10 + (box - (maxY - minY) * scale) / 2 - minY * scale;
    const mp = polyPath(groundRuns(track), (p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }), !track.gaps.length);
    this.mini = { scale, ox, oy, path: mp };
  }

  /** A car's name over it; (cx, cy) is the camera in world coordinates. */
  nameTag(c: CarView, cx: number, cy: number): void {
    const ctx = this.ctx;
    const x = Math.round(VIEW_W / 2 + (c.x - cx) * ZOOM);
    const y = Math.round(VIEW_H / 2 + (c.y - cy) * ZOOM) - 20;
    if (x < -40 || x > VIEW_W + 40 || y < -20 || y > VIEW_H + 20) return;
    ctx.font = "bold 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(c.name).width + 6;
    ctx.fillStyle = PAL.hudBg;
    ctx.fillRect(Math.round(x - w / 2), y - 6, Math.round(w), 12);
    ctx.fillStyle = c.color;
    ctx.fillRect(Math.round(x - w / 2), y + 5, Math.round(w), 1);
    ctx.fillStyle = PAL.hudText;
    ctx.fillText(c.name, x, y);
  }

  minimap(cars: CarView[]): void {
    const ctx = this.ctx;
    const m = this.mini;
    ctx.fillStyle = "rgba(18,14,11,0.55)";
    ctx.fillRect(VIEW_W - 112, 4, 108, 108);
    ctx.lineJoin = "round";
    ctx.lineCap = this.cap; // breaks at gaps (shots leave round caps set)
    ctx.strokeStyle = "#1c1916";
    ctx.lineWidth = 5;
    ctx.stroke(m.path);
    ctx.strokeStyle = "#a99c86";
    ctx.lineWidth = 2;
    ctx.stroke(m.path);
    const sorted = [...cars].sort((a, b) => Number(a.me) - Number(b.me));
    for (const c of sorted) {
      const x = m.ox + c.x * m.scale, y = m.oy + c.y * m.scale;
      ctx.fillStyle = "#000";
      ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, c.me ? 6 : 5, c.me ? 6 : 5);
      ctx.fillStyle = c.color;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, c.me ? 4 : 3, c.me ? 4 : 3);
    }
  }

  hud(h: HudView): void {
    const ctx = this.ctx;
    ctx.textBaseline = "middle";
    if (h.topLeft.length) {
      const barH = h.hp === null ? 0 : 12;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(6, 6, 118, 10 + h.topLeft.length * 14 + barH);
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      h.topLeft.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? PAL.accent : PAL.hudText;
        ctx.fillText(line, 12, 18 + i * 14);
      });
      if (h.hp !== null) {
        const y = 12 + h.topLeft.length * 14;
        ctx.fillStyle = "#120d0a";
        ctx.fillRect(12, y, 106, 7);
        ctx.fillStyle = h.hp > 0.5 ? "#7bc95a" : h.hp > 0.25 ? "#e8b83a" : "#e8452d";
        ctx.fillRect(13, y + 1, Math.round(104 * Math.max(0, Math.min(1, h.hp))), 5);
      }
    }
    if (h.time) {
      ctx.font = "bold 13px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      const w = ctx.measureText(h.time).width + 14;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), 6, Math.round(w), 20);
      ctx.fillStyle = PAL.hudText;
      ctx.fillText(h.time, VIEW_W / 2, 16);
    }
    if (h.notice) {
      ctx.font = "bold 10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      const w = ctx.measureText(h.notice).width + 12;
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), 29, Math.round(w), 15);
      ctx.fillStyle = PAL.accent;
      ctx.fillText(h.notice, VIEW_W / 2, 37);
    }
    if (h.center) {
      ctx.textAlign = "center";
      ctx.font = "bold 52px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(h.center, VIEW_W / 2 + 3, VIEW_H / 2 - 20 + 3);
      ctx.fillStyle = PAL.accent;
      ctx.fillText(h.center, VIEW_W / 2, VIEW_H / 2 - 20);
      if (h.centerSub) {
        ctx.font = "bold 12px ui-monospace, Menlo, monospace";
        const w = ctx.measureText(h.centerSub).width + 16;
        ctx.fillStyle = PAL.hudBg;
        ctx.fillRect(Math.round(VIEW_W / 2 - w / 2), VIEW_H / 2 + 14, Math.round(w), 20);
        ctx.fillStyle = PAL.hudText;
        ctx.fillText(h.centerSub, VIEW_W / 2, VIEW_H / 2 + 24);
      }
    }
    if (h.banner) {
      ctx.font = "bold 11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = PAL.hudBg;
      ctx.fillRect(0, VIEW_H - 26, VIEW_W, 20);
      ctx.fillStyle = PAL.hudText;
      ctx.fillText(h.banner, VIEW_W / 2, VIEW_H - 16);
    }
    if (h.corner) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(239,230,210,0.7)";
      ctx.fillText(h.corner, VIEW_W - 8, VIEW_H - 8);
    }
    if (h.debug.length) {
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(6, VIEW_H - 40 - h.debug.length * 11, 220, 6 + h.debug.length * 11);
      ctx.fillStyle = "#9fe08a";
      h.debug.forEach((line, i) => ctx.fillText(line, 10, VIEW_H - 34 - (h.debug.length - 1 - i) * 11 - 11));
    }
  }
}
