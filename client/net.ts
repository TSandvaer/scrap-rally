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
 * Delays messages like a slow link would, but keeps them in order (as TCP does): a
 * message is never delivered before the one sent ahead of it.
 */
class DelayLine {
  private last = 0;
  constructor(private readonly sim: LagSim) {}
  run(fn: () => void): void {
    const delay = this.sim.lag / 2 + (Math.random() * 2 - 1) * this.sim.jitter;
    const at = Math.max(this.last, performance.now() + Math.max(0, delay));
    this.last = at;
    setTimeout(fn, at - performance.now());
  }
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
  ws.onclose = () => {
    if (closed) return;
    closed = true;
    t.onClose();
  };
  return t;
}
