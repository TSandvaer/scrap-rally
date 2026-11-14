// Transport abstraction. The game only sees Transport, so a WebTransport (or other)
// implementation can be added later without touching game.ts. No DOM use here: the
// headless bot test runs this file under Node, which has a global WebSocket.

import { decode, encode, type ClientMsg, type ServerMsg } from "../shared/protocol";

export interface Transport {
  send(msg: ClientMsg): void;
  close(): void;
  onOpen: () => void;
  onMessage: (msg: ServerMsg) => void;
  onClose: () => void;
}

export interface LagSim {
  lag: number; // added round-trip time in ms, split evenly over both directions
  jitter: number; // each message is delayed a further uniform ±jitter ms (per direction)
}

/**
 * Delays events like a slow link would, but keeps them in order (as TCP does): an event is
 * never delivered before the one queued ahead of it. One FIFO queue and one timer, so ties
 * in due time cannot reorder events.
 */
class DelayLine {
  private readonly queue: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  constructor(private readonly sim: LagSim) {}
  run(fn: () => void): void {
    const delay = this.sim.lag / 2 + (Math.random() * 2 - 1) * this.sim.jitter;
    this.last = Math.max(this.last, performance.now() + Math.max(0, delay));
    this.queue.push({ at: this.last, fn });
    if (!this.timer) this.arm();
  }
  private arm(): void {
    this.timer = setTimeout(this.flush, Math.max(0, this.queue[0].at - performance.now()));
  }
  private readonly flush = (): void => {
    this.timer = null;
    try {
      while (this.queue.length && this.queue[0].at <= performance.now()) this.queue.shift()!.fn();
    } finally {
      if (this.queue.length && !this.timer) this.arm();
    }
  };
}

export function connectWs(url: string, sim?: LagSim): Transport {
  const ws = new WebSocket(url);
  const lagged = sim && (sim.lag > 0 || sim.jitter > 0);
  const up = lagged ? new DelayLine(sim) : null;
  const down = lagged ? new DelayLine(sim) : null;
  let closed = false;

  const t: Transport = {
    send(msg) {
      const data = encode(msg);
      const go = () => {
        if (!closed && ws.readyState === WebSocket.OPEN) ws.send(data);
      };
      if (up) up.run(go);
      else go();
    },
    close() {
      if (closed) return;
      closed = true;
      ws.close();
      t.onClose();
    },
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
  };

  ws.onopen = () => t.onOpen();
  ws.onmessage = (e) => {
    const msg = decode<ServerMsg>(e.data);
    if (!msg) return;
    const deliver = () => {
      if (!closed) t.onMessage(msg);
    };
    if (down) down.run(deliver);
    else deliver();
  };
  // The close travels the same delay line as the messages, so every message received
  // before it is delivered first (a restart notice must not be overtaken by the close).
  ws.onclose = () => {
    const fire = () => {
      if (closed) return;
      closed = true;
      t.onClose();
    };
    if (down) down.run(fire);
    else fire();
  };
  return t;
}
