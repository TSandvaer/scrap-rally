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
}

export interface RunningServer {
  port: number;
  rooms: Rooms;
  close(): Promise<void>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const STEP_MS = 1000 / TICK_HZ;
const MAX_CATCH_UP = 4;
const HEARTBEAT_MS = 10_000;

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
  const rooms = new Rooms(opts.laps ?? LAPS, opts.hp);

  let vite: { close(): Promise<void> } | null = null;
  if (opts.vite) {
    const { createServer } = await import("vite");
    const v = await createServer({
      root: ROOT,
      configFile: false,
      appType: "spa",
      server: { middlewareMode: true, hmr: { server: httpServer } },
    });
    httpServer.on("request", v.middlewares);
    vite = v;
  } else {
    httpServer.on("request", serveStatic);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
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
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => rooms.onMessage(session, decode<ClientMsg>(data), performance.now()));
    ws.on("close", () => rooms.onClose(session, performance.now()));
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

  return {
    port,
    rooms,
    async close() {
      clearTimeout(timer);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await vite?.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const prod = process.env.NODE_ENV === "production";
  const server = await startServer({ port: Number(process.env.PORT) || 3000, vite: !prod });
  console.log(`Scrap Rally ${prod ? "(prod)" : "(dev)"} on http://localhost:${server.port}`);
}
