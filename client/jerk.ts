// Debug instrument (?debug=1): how smoothly the other cars move on screen. For every other
// car and frame it takes the drawn velocity (position change / frame time) and its change
// from the previous frame. A car gliding along changes velocity by a few units/s per frame
// (its real acceleration); a visible stutter or small jump shows up as a spike. Frames
// are split by how the car was drawn: near (fully at its predicted pose), ramp (easing
// between the interpolated and the predicted pose) or far (interpolated).

export const STUTTER_DV = 120; // units/s change between two frames counted as a stutter
export const STUTTER_DW = 1.5; // rad/s change of turning speed between two frames, the same for heading
const MAX_SAMPLES = 20000; // per bucket; the meter is reset at every race start
const TEXT_EVERY = 30; // frames between two recomputations of the overlay text (sorting)

interface Track {
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  w: number; // turning speed, rad/s
  hasV: boolean;
}

export class Bucket {
  frames = 0;
  stutters = 0; // position: velocity change > STUTTER_DV
  turnStutters = 0; // heading: turning-speed change > STUTTER_DW
  private readonly dvs: number[] = [];
  private readonly dws: number[] = [];
  private text_ = "";
  private textAt = -Infinity;

  add(dv: number, dw: number): void {
    this.frames++;
    if (dv > STUTTER_DV) this.stutters++;
    if (dw > STUTTER_DW) this.turnStutters++;
    if (this.dvs.length < MAX_SAMPLES) {
      this.dvs.push(dv);
      this.dws.push(dw);
    }
  }

  /** Overlay line; the percentiles are recomputed at most every TEXT_EVERY frames. */
  text(): string {
    if (this.frames - this.textAt >= TEXT_EVERY || this.frames < this.textAt) {
      const s = this.stats();
      this.text_ = `n ${s.frames} pos ${s.stutterPct.toFixed(1)}% p95 ${s.p95.toFixed(0)}  turn ${s.turnStutterPct.toFixed(1)}% p95 ${s.turnP95.toFixed(2)}`;
      this.textAt = this.frames;
    }
    return this.text_;
  }

  stats(): { frames: number; stutterPct: number; p95: number; p99: number; max: number; turnStutterPct: number; turnP95: number; turnP99: number } {
    const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] : 0);
    const pct = (k: number) => (this.frames ? (100 * k) / this.frames : 0);
    return {
      frames: this.frames,
      stutterPct: pct(this.stutters),
      p95: q(this.dvs, 0.95),
      p99: q(this.dvs, 0.99),
      max: this.dvs.reduce((m, v) => Math.max(m, v), 0),
      turnStutterPct: pct(this.turnStutters),
      turnP95: q(this.dws, 0.95),
      turnP99: q(this.dws, 0.99),
    };
  }
}

export class JerkMeter {
  near = new Bucket();
  ramp = new Bucket();
  far = new Bucket();
  frames = 0; // frames measured ...
  longFrames = 0; // ... and how many took over 40 ms (left out: the measurement is off then)
  readonly gaps: { at: number; ms: number }[] = []; // the first long frames: when (performance.now) and how long
  private readonly cars = new Map<string, Track>();

  reset(): void {
    this.near = new Bucket();
    this.ramp = new Bucket();
    this.far = new Bucket();
    this.frames = this.longFrames = 0;
    this.cars.clear();
  }

  /**
   * One drawn frame. weight(id): 0 = interpolated .. 1 = predicted pose. skip(id): leave this car out of this frame (wrecked, respawning,
   * ghost); its history restarts.
   */
  frame(poses: { id: string; x: number; y: number; h: number }[], weight: (id: string) => number, skip: (id: string) => boolean, dtMs: number): void {
    const seen = new Set<string>();
    const dt = dtMs / 1000;
    this.frames++;
    if (dtMs > 40) {
      this.longFrames++;
      if (this.gaps.length < 20) this.gaps.push({ at: Math.round(performance.now()), ms: Math.round(dtMs) });
    }
    for (const p of poses) {
      seen.add(p.id);
      const t = this.cars.get(p.id);
      if (!t || skip(p.id) || dtMs < 4 || dtMs > 40) {
        this.cars.set(p.id, { x: p.x, y: p.y, h: p.h, vx: 0, vy: 0, w: 0, hasV: false });
        continue;
      }
      const vx = (p.x - t.x) / dt, vy = (p.y - t.y) / dt;
      let dh = p.h - t.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      const w = dh / dt;
      const w0 = weight(p.id);
      if (t.hasV) (w0 >= 1 ? this.near : w0 > 0 ? this.ramp : this.far).add(Math.hypot(vx - t.vx, vy - t.vy), Math.abs(w - t.w));
      this.cars.set(p.id, { x: p.x, y: p.y, h: p.h, vx, vy, w, hasV: true });
    }
    for (const id of [...this.cars.keys()]) if (!seen.has(id)) this.cars.delete(id);
  }
}
