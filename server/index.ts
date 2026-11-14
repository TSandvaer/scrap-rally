// One process, one port: HTTP (Vite middleware in dev, dist/ in prod) plus the game
// WebSocket on /ws. Upgrades on any other path are left to Vite's HMR (dev) or refused.

import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { TICK_HZ } from "../shared/physics";
import { decode, encode, LAPS, type ClientMsg } from "../shared/protocol";
import { Rooms, type Session } from "./room";

export interface ServerOptions {
  port: number;
  vite: boolean;
  laps?: number;
  host?: string;
  hp?: number; // car hit points; tests use a low value so wrecks happen quickly
  maxRooms?: number; // default MAX_ROOMS env or 20
  maxSockets?: number; // default MAX_SOCKETS env or 150
}

export interface RunningServer {
  port: number;
  rooms: Rooms;
  /** Open game sockets right now. */
  sockets(): number;
  /** Hard stop (tests): drop every socket without notice. */
  close(): Promise<void>;
  /** Graceful stop: tell every client the server is restarting, then close. */
  shutdown(): Promise<void>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const STEP_MS = 1000 / TICK_HZ;
const MAX_CATCH_UP = 4;
const HEARTBEAT_MS = 10_000;
// Guards for a public server, sized for a small instance (override with env vars).
const DEFAULT_MAX_ROOMS = 20;
const DEFAULT_MAX_SOCKETS = 150;
const JOIN_TIMEOUT_MS = 10_000; // a socket that has not joined a room by then is closed
const REFUSED_CLOSE_MS = 1000; // a socket refused as "busy" is cut off if its close stalls
// Inputs arrive at 60/s plus a ping every 2 s. A Wi-Fi stall can flush a burst of queued
// messages; beyond this many per second the excess is dropped (not closed) on purpose.
const MAX_MSGS_PER_SEC = 240;

function envInt(name: string): number | undefined {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(DIST, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(DIST + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) file = path.join(DIST, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("dist/ not built: run `npm run build`");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const httpServer = http.createServer();
  const maxRooms = opts.maxRooms ?? envInt("MAX_ROOMS") ?? DEFAULT_MAX_ROOMS;
  const maxSockets = opts.maxSockets ?? envInt("MAX_SOCKETS") ?? DEFAULT_MAX_SOCKETS;
  const rooms = new Rooms(opts.laps ?? LAPS, opts.hp, maxRooms);

  let vite: { close(): Promise<void> } | null = null;
  let viteMiddlewares: http.RequestListener | null = null;
  if (opts.vite) {
    const { createServer } = await import("vite");
    const v = await createServer({
      root: ROOT,
      configFile: false,
      appType: "spa",
      server: { middlewareMode: true, hmr: { server: httpServer } },
    });
    viteMiddlewares = v.middlewares;
    vite = v;
  }
  httpServer.on("request", (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (viteMiddlewares) viteMiddlewares(req, res);
    else serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  // Refused sockets still closing. ws adds every upgraded socket to wss.clients, so these
  // are subtracted in the cap check: a slot a player frees must not look taken meanwhile.
  let refused = 0;
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/ws") {
      // A browser WebSocket cannot read an HTTP 503, so over the cap the socket is accepted
      // only to say "busy" and is closed right away (1013 = try again later).
      const full = wss.clients.size - refused >= maxSockets;
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!full) {
          wss.emit("connection", ws, req);
          return;
        }
        refused++;
        ws.on("error", () => ws.terminate());
        ws.send(encode({ t: "err", code: "busy", msg: "The server is full right now, try again later" }));
        ws.close(1013, "server full");
        const kill = setTimeout(() => ws.terminate(), REFUSED_CLOSE_MS); // no lingering handshake
        ws.on("close", () => {
          clearTimeout(kill);
          refused--;
        });
      });
    } else if (!vite) {
      socket.destroy();
    }
  });

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    const session: Session = {
      conn: {
        send: (msg) => {
          if (ws.readyState === ws.OPEN) ws.send(encode(msg));
        },
        close: () => ws.close(),
      },
      room: null,
      player: null,
    };
    // The client opens its socket only to create or join; one that never gets a seat goes.
    const joinTimer = setTimeout(() => {
      if (!session.room) ws.close();
    }, JOIN_TIMEOUT_MS);
    let windowStart = performance.now();
    let count = 0;
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => {
      const now = performance.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MSGS_PER_SEC) return; // counted before decoding; excess dropped
      rooms.onMessage(session, decode<ClientMsg>(data), now);
    });
    ws.on("close", () => {
      clearTimeout(joinTimer);
      rooms.onClose(session, performance.now());
    });
    ws.on("error", () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  // Global fixed-step loop: every room ticks at TICK_HZ on one clock.
  let last = performance.now();
  let acc = 0;
  let timer: NodeJS.Timeout;
  const loop = () => {
    const now = performance.now();
    acc += now - last;
    last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCH_UP) {
      rooms.step(now);
      acc -= STEP_MS;
      steps++;
    }
    if (acc >= STEP_MS) acc = 0; // too far behind: drop the backlog
    timer = setTimeout(loop, Math.max(1, STEP_MS - acc));
  };
  timer = setTimeout(loop, STEP_MS);

  await new Promise<void>((resolve) => httpServer.listen(opts.port, opts.host ?? "0.0.0.0", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const stop = async (graceful: boolean) => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    for (const ws of wss.clients) {
      if (graceful) {
        ws.send(encode({ t: "err", code: "restarting", msg: "Server restarting" }));
        ws.close(1012, "restarting");
      } else {
        ws.terminate();
      }
    }
    wss.close();
    await vite?.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return {
    port,
    rooms,
    sockets: () => wss.clients.size,
    close: () => stop(false),
    shutdown: () => stop(true),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const prod = process.env.NODE_ENV === "production";
  const server = await startServer({ port: Number(process.env.PORT) || 3000, vite: !prod });
  console.log(`Scrap Rally ${prod ? "(prod)" : "(dev)"} on http://localhost:${server.port}`);
  // Hosts stop us with SIGTERM on every deploy/restart; Ctrl+C is SIGINT. Tell players,
  // then exit (a hard timer makes sure we do, e.g. as PID 1 in a container).
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: telling players the server is restarting`);
    setTimeout(() => process.exit(0), 2500).unref();
    server.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}
