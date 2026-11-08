// Low-level test wires: a Hermes control socket and a scriptable hermes-gateway-v1 WebSocket server.
// Grown from `spike/hermes` `src/hermes/test/fake-gateway.ts`. Everything lives under /private/tmp/bb-hermes-test/.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { GATEWAY_PROTOCOL, TICKET_PREFIX } from "../../src/hermes/types.js";

export const TEST_ROOT = "/private/tmp/bb-hermes-test";

/** A fresh real-path folder under `TEST_ROOT`. */
export function tempDir(prefix: string): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  return realpathSync(mkdtempSync(path.join(TEST_ROOT, prefix)));
}

/** Remove a folder made by `tempDir`; refuses anything outside `TEST_ROOT`. */
export function removeDir(dir: string): void {
  if (!dir.startsWith(TEST_ROOT + "/")) throw new Error(`refusing to remove ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

export type ControlAnswer = (request: { verb?: string; params?: Record<string, unknown> } & Record<string, unknown>) => unknown;

export interface ControlServer {
  /** Where it listens: `<home>/gateway.sock`, or the pointer target. */
  socketPath: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}

/**
 * Listen as `<home>`'s control socket. `pointer: true` listens on the short fallback path and writes
 * `<home>/gateway.sock.path`, as Hermes does when the direct path doesn't fit `sun_path`.
 */
export function controlServer(home: string, answer: ControlAnswer, opts: { pointer?: boolean } = {}): Promise<ControlServer> {
  const requests: Record<string, unknown>[] = [];
  let socketPath = path.join(home, "gateway.sock");
  let fallbackRoot: string | null = null;
  if (opts.pointer) {
    fallbackRoot = tempDir("gw-");
    const hash = createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 16);
    mkdirSync(path.join(fallbackRoot, `hermes-gw-${hash}`), { mode: 0o700 });
    socketPath = path.join(fallbackRoot, `hermes-gw-${hash}`, "control.sock");
  }
  const server = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      requests.push(req);
      s.end(JSON.stringify(answer(req)) + "\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () => {
      if (opts.pointer) writeFileSync(path.join(home, "gateway.sock.path"), socketPath, { mode: 0o600 });
      resolve({
        socketPath,
        requests,
        close: () =>
          new Promise((r) =>
            server.close(() => {
              rmSync(path.join(home, "gateway.sock.path"), { force: true });
              if (fallbackRoot) removeDir(fallbackRoot);
              r();
            }),
          ),
      });
    }),
  );
}

export type WsHandler = (method: string, params: Record<string, unknown>, sock: WebSocket) => unknown;

export interface WsGateway {
  url: string;
  port: number;
  sockets: WebSocket[];
  /** The ticket each accepted connection presented. */
  tickets: string[];
  event: (sock: WebSocket, params: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

/**
 * A hermes-gateway-v1 server on 127.0.0.1. Selects `hermes-gateway-v1` only next to a ticket subprotocol
 * (`echoProtocol: false` selects none), sends `gateway.ready`, and answers each request with `handler`:
 * a value → `result`, an `Error` → an `error` frame with that reason, `undefined` → no answer.
 */
export function wsGateway(handler: WsHandler, opts: { echoProtocol?: boolean; port?: number; ready?: Record<string, unknown> } = {}): Promise<WsGateway> {
  const wss = new WebSocketServer({
    port: opts.port ?? 0,
    host: "127.0.0.1",
    handleProtocols: (protocols) =>
      opts.echoProtocol !== false && protocols.has(GATEWAY_PROTOCOL) && [...protocols].some((p) => p.startsWith(TICKET_PREFIX))
        ? GATEWAY_PROTOCOL
        : false,
  });
  const sockets: WebSocket[] = [];
  const tickets: string[] = [];
  const event = (sock: WebSocket, params: Record<string, unknown>) => sock.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  wss.on("connection", (sock, req) => {
    sockets.push(sock);
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    tickets.push(offered.find((p) => p.startsWith(TICKET_PREFIX))?.slice(TICKET_PREFIX.length) ?? "");
    event(sock, { type: "gateway.ready", payload: { session_authority: true, ...opts.ready } });
    sock.on("message", async (raw) => {
      const f = JSON.parse(String(raw));
      const result = await handler(f.method, f.params ?? {}, sock);
      if (result instanceof Error) {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, error: { code: 4001, message: result.message, data: { reason: result.message } } }));
      } else if (result !== undefined) {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, result }));
      }
    });
  });
  return new Promise((resolve) =>
    wss.on("listening", () => {
      const { port } = wss.address() as { port: number };
      resolve({
        url: `ws://127.0.0.1:${port}/api/ws`,
        port,
        sockets,
        tickets,
        event,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.terminate();
            wss.close(() => r());
          }),
      });
    }),
  );
}

/** A minimal `session.resume`/`session.create` snapshot. */
export const snapshot = (session_id: string, over: Record<string, unknown> = {}) => ({
  session_id,
  stored_session_id: session_id,
  messages: [],
  message_count: 0,
  running: false,
  authority_epoch: 1,
  replay_epoch: "E1",
  last_sequence: 0,
  subscription_id: "sub",
  revision: 0,
  execution_generation: 0,
  pending: [],
  prompts: [],
  info: {},
  ...over,
});
