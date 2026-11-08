/**
 * Strict fake Hermes (03 §Strict fake Hermes) for client, worker, bridge, server and e2e tests.
 *
 *   const fake = await startFakeHermes({ profiles: ["alex", "bob"] });
 *   fake.folder        // the Hermes folder to configure: a real path under /private/tmp/bb-hermes-test/
 *   fake.instanceId    // check it equals diagnostics.instance_id before any assertion (03 §E2E step 6)
 *   fake.requests      // every RPC, as validated; `refused` holds the error reason Hermes would send
 *   fake.handle("session.create", (params, ctx) => …)   // add or replace a method (P1 grows here)
 *   fake.emit({ type: "sessions.changed", payload: {} }) // push an event to every socket
 *   await fake.restart({ contract: "changed" })  // new port, instance_id and authority epoch
 *   await fake.stop()  // closes everything; removes the folder if the fake made it, else only its socket
 *
 * Like Hermes c314285f07: `<folder>/gateway.sock` (`identify`, `session-ticket`), one loopback listener with
 * `/api/ws` (`hermes-gateway-v1` + a host-scoped interactive ticket) and the REST projection (`native-http`
 * ticket per request). Every request is validated against the vendored contract, `additionalProperties:false`.
 * REST answers come only from recordings in test/fixtures/rest/ (R5 C6). Standalone: `npm run fake-hermes`.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ROUTING_PARAM } from "../../src/hermes/contract.js";
import { GATEWAY_PROTOCOL, NATIVE_HTTP_HEADER, TICKET_PREFIX } from "../../src/hermes/types.js";
import { validate } from "./schema.js";
import { controlServer, removeDir, tempDir, TEST_ROOT, type ControlServer } from "./wire.js";

const here = import.meta.dirname;
const VENDORED = path.join(here, "gateway-contract.openrpc.json");
const RECORDINGS = path.join(here, "../fixtures/rest");
export const CONTRACT_PATH = "hermes-agent/apps/shared/src/gateway-contract.openrpc.json";
/** The code identity of the Hermes the contract was vendored from. */
export const CODE_VERSION = "0.22.6";
export const CODE_SHA = "c314285f077e91937c995d419b9fa40af9eb4981";

/** Session verbs whose `profile` routes and is then stripped before validation (`gateway/session_controls.py:96-100`). */
const PROFILE_IMPLICIT = new Set([
  "session.create", "session.list", "session.info", "session.resume", "session.detach", "prompt.submit", "prompt.receipt",
  "prompt.cancel", "prompt.resolve_unknown", "prompt.steer_queued", "prompt.replace_queued", "session.interrupt",
  "session.events.since", "session.mutate", "session.stats", "approval.respond", "clarify.respond",
]);

type Json = Record<string, unknown>;
interface Contract {
  methods: Json[];
  "x-canonical-methods": Json[];
  components: { schemas: Record<string, Json> };
}

export interface FakeProfile {
  /** `default` for the root, else the name under `profiles/`. */
  name: string;
  home: string;
}

export interface HandlerContext {
  /** The profile the call is routed to (its `profile` param, else the root). */
  profile: FakeProfile;
  socket: WebSocket;
  fake: FakeHermes;
}
export type Handler = (params: Json, ctx: HandlerContext) => unknown | Promise<unknown>;

/** A refusal Hermes sends as a 4001 error frame with `data.reason` (`not_found`, `stale_generation`, …). */
export class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly data: Json = {},
  ) {
    super(reason);
  }
}

/** Every recording in test/fixtures/rest/, latest first: where two answer the same read, the latest state wins. */
export const RECORDINGS_LATEST_FIRST = [
  "default-profile", "conduit-held", "legacy", "compaction-rotating", "compaction-rotating-before", "compaction-in-place",
  "compaction-in-place-before", "retry", "hidden-prompt", "steer", "bot-chat", "create",
];

export interface RecordedExchange {
  profile: string;
  path: string;
  query: Record<string, string>;
  status: number;
  body: unknown;
}

export interface FakeOptions {
  /** Under /private/tmp/bb-hermes-test/; created if missing. Default: a fresh temp folder. */
  folder?: string;
  /** Served secondary profiles, besides the root (`default`). */
  profiles?: string[];
  /** Profile folders the gateway doesn't serve (01 §2 "Not served by this machine's gateway"). */
  unserved?: string[];
  /** `changed`: serve and enforce a contract that lacks `session.steer` and `prompt.submit.turn_author`. */
  contract?: "vendored" | "changed";
  codeVersion?: string;
  /** Recording names in test/fixtures/rest/ (without `.json`) whose REST answers to serve. */
  rest?: string[];
}

export interface RequestRecord {
  method: string;
  params: Json;
  profile: string;
  refused?: string;
}

export interface FakeHermes {
  readonly folder: string;
  readonly instanceId: string;
  readonly authorityEpoch: number;
  readonly apiOrigin: string;
  /** Served profiles, the root first. */
  readonly profiles: FakeProfile[];
  /** Profile folders the gateway doesn't serve. */
  readonly unserved: FakeProfile[];
  readonly requests: RequestRecord[];
  /** Every ticket minted on `gateway.sock`, with its purpose and profile. */
  readonly tickets: { purpose: string; profile_id: string; scope: string }[];
  /** Results the fake built that its own contract refuses: a bug in a handler. Tests assert it stays empty. */
  readonly violations: string[];
  handle(method: string, fn: Handler): void;
  emit(event: Json): void;
  restart(opts?: Pick<FakeOptions, "contract" | "codeVersion">): Promise<void>;
  stop(): Promise<void>;
}

export function changedContract(c: Contract): Contract {
  const out = structuredClone(c);
  out["x-canonical-methods"] = out["x-canonical-methods"].filter((m) => m.name !== "session.steer");
  const submit = out.components.schemas.CanonicalSubmitParams as { properties: Json };
  delete submit.properties.turn_author;
  return out;
}

export async function startFakeHermes(opts: FakeOptions = {}): Promise<FakeHermes> {
  const ownFolder = !opts.folder;
  if (opts.folder && !path.resolve(opts.folder).startsWith(TEST_ROOT + "/")) throw new Error(`fake Hermes folder must be under ${TEST_ROOT}`);
  if (opts.folder) mkdirSync(opts.folder, { recursive: true, mode: 0o700 });
  // The real path, as Hermes keys homes (`gateway/control_socket.py:212-214`).
  const folder = opts.folder ? realpathSync(opts.folder) : tempDir("fake-");
  const profiles: FakeProfile[] = [
    { name: "default", home: folder },
    ...(opts.profiles ?? ["alex", "bob"]).map((name) => ({ name, home: path.join(folder, "profiles", name) })),
  ];
  const unserved = (opts.unserved ?? []).map((name) => ({ name, home: path.join(folder, "profiles", name) }));
  for (const p of [...profiles.slice(1), ...unserved]) mkdirSync(p.home, { recursive: true, mode: 0o700 });
  const recorded: RecordedExchange[] = (opts.rest ?? []).flatMap(
    (name) => (JSON.parse(readFileSync(path.join(RECORDINGS, `${name}.json`), "utf8")) as { exchanges: RecordedExchange[] }).exchanges,
  );

  const handlers = new Map<string, Handler>(Object.entries(p0Handlers()));
  const tickets = new Map<string, { purpose: string; profile_id: string; scope: string; expires: number }>();
  const sockets = new Set<WebSocket>();
  let contract: Contract;
  let codeVersion = opts.codeVersion ?? CODE_VERSION;
  let instanceId = "";
  let epoch = 0;
  let port = 0;
  let control: ControlServer | null = null;
  let server: http.Server | null = null;

  const profileNamed = (v: unknown): FakeProfile | undefined =>
    profiles.find((p) => v === p.name || v === p.home || (v === "current" && p.name === "default"));

  const writeContract = (kind: FakeOptions["contract"]) => {
    const vendored = JSON.parse(readFileSync(VENDORED, "utf8")) as Contract;
    contract = kind === "changed" ? changedContract(vendored) : vendored;
    const file = path.join(folder, CONTRACT_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(contract, null, 2) + "\n");
  };

  const identify = () => ({
    protocol: 1,
    kind: "hermes-gateway",
    pid: process.pid,
    start_time: 0,
    hermes_home: folder,
    profile: "default",
    supervisor: "none",
    launch_supervisor: "manual",
    code_sha: CODE_SHA,
    code_version: codeVersion,
    served_profiles: profiles.map((p) => ({ profile_id: p.home, home: p.home })),
    instance_id: instanceId,
    runtime_protocol: 1,
    authority_epoch: epoch,
    state: "ready",
    api_origin: `http://127.0.0.1:${port}`,
    parked_profiles: {},
    capabilities: ["session-authority-v1", "durable-admission-v1", "event-replay-v1"],
  });

  // `gateway/control_socket.py:372-400` and `gateway/runtime_bootstrap.py:37-55`.
  const sessionTicket = (req: Json) => {
    const params = req.params as Json | undefined;
    const keys = Object.keys(params ?? {});
    if (!params || !["profile_id", "instance_id", "purpose"].every((k) => k in params) || keys.some((k) => !["profile_id", "instance_id", "purpose", "scope", "subject", "restart_wait"].includes(k))) {
      throw new Error("PermissionError: invalid bootstrap parameters");
    }
    if (params.instance_id !== instanceId) throw new Error("PermissionError: stale runtime instance");
    const scope = (params.scope as string | undefined) ?? "profile";
    const served = profiles.some((p) => p.home === params.profile_id);
    if (!served || !["interactive", "native-http"].includes(params.purpose as string) || !["profile", "host"].includes(scope) || (scope === "host" && params.purpose !== "interactive")) {
      throw new Error("PermissionError: bootstrap binding rejected");
    }
    const ticket = randomBytes(32).toString("base64url");
    const grant = { purpose: params.purpose as string, profile_id: params.profile_id as string, scope };
    tickets.set(ticket, { ...grant, expires: Date.now() + 30_000 });
    fake.tickets.push(grant);
    return { ticket, expires_in_seconds: 30, instance_id: instanceId, profile_id: params.profile_id, runtime_protocol: 1 };
  };

  const redeem = (ticket: string | undefined, purpose: string) => {
    const grant = ticket ? tickets.get(ticket) : undefined;
    if (!grant || grant.expires <= Date.now() || grant.purpose !== purpose) return null;
    tickets.delete(ticket!);
    return grant;
  };

  const methodSchema = (method: string): { params: Json; result: Json } | null => {
    const m = contract["x-canonical-methods"].find((x) => x.name === method) ?? contract.methods.find((x) => x.name === method);
    if (!m) return null;
    return {
      params: (m.params as { schema: Json }[])[0]!.schema,
      result: (m.result as { schema: Json }).schema,
    };
  };

  const onRpc = async (sock: WebSocket, raw: string) => {
    const f = JSON.parse(raw) as { id?: number; method?: string; params?: Json };
    const reply = (body: Json) => sock.send(JSON.stringify({ jsonrpc: "2.0", id: f.id, ...body }));
    const refuse = (reason: string, data: Json = {}) => reply({ error: { code: 4001, message: reason, data: { reason, ...data } } });
    const method = f.method ?? "";
    let params = f.params ?? {};
    const record: RequestRecord = { method, params, profile: "default" };
    fake.requests.push(record);
    const schema = methodSchema(method);
    if (!schema) {
      record.refused = "method_not_found";
      return reply({ error: { code: -32601, message: `unknown method: ${method}` } });
    }
    let profile = profiles[0]!;
    if (typeof params[ROUTING_PARAM] === "string" && params[ROUTING_PARAM]) {
      const named = profileNamed(params[ROUTING_PARAM]);
      if (!named) return refuse((record.refused = "profile_mismatch"));
      profile = named;
      record.profile = named.name;
      if (PROFILE_IMPLICIT.has(method)) {
        const { [ROUTING_PARAM]: _, ...rest } = params;
        params = rest;
      }
    }
    const problems = validate(params, schema.params, contract.components.schemas);
    if (problems.length) {
      record.refused = "invalid_params";
      return refuse("invalid_params", { fields: problems });
    }
    const handler = handlers.get(method);
    if (!handler) return refuse((record.refused = "not_implemented_in_fake"));
    try {
      const result = await handler(params, { profile, socket: sock, fake });
      const bad = validate(result, schema.result, contract.components.schemas, "result");
      if (bad.length) fake.violations.push(`${method}: ${bad.join(", ")}`);
      reply({ result });
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      record.refused = err.reason;
      refuse(err.reason, err.data);
    }
  };

  // REST projection (`hermes_cli/web_routers/sessions.py:182, 739`), behind `native-http` (`hermes_cli/dashboard_auth/native_http.py`).
  const onHttp = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const header = req.headers[NATIVE_HTTP_HEADER.toLowerCase()];
    if (header === undefined || "origin" in req.headers) return send(401, { detail: "Unauthorized" });
    const grant = redeem(Array.isArray(header) ? undefined : header, "native-http");
    if (!grant) return send(401, { detail: "Unauthorized" });
    const owner = profiles.find((p) => p.home === grant.profile_id)!;
    const selectors = url.searchParams.getAll("profile");
    if (selectors.some((v) => profileNamed(v)?.home !== owner.home)) return send(403, { detail: "profile_scope_mismatch" });
    if (req.method !== "GET" || !/^\/api\/sessions(\/[^/]+\/messages)?$/.test(url.pathname)) return send(404, { detail: "Not Found" });
    const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "profile"));
    const hit = recorded.find(
      (x) => x.profile === owner.name && x.path === url.pathname && JSON.stringify(Object.entries(x.query).sort()) === JSON.stringify(Object.entries(query).sort()),
    );
    if (!hit) return send(404, { detail: "not recorded" });
    send(hit.status, hit.body);
  };

  const start = async () => {
    instanceId = randomBytes(16).toString("hex");
    epoch++;
    const wss = new WebSocketServer({ noServer: true, handleProtocols: () => GATEWAY_PROTOCOL });
    server = http.createServer(onHttp);
    // `/api/ws`: no Origin, the gateway subprotocol plus exactly one ticket subprotocol, redeemed once.
    server.on("upgrade", (req, socket, head) => {
      const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
      const ticketProtos = offered.filter((p) => p.startsWith(TICKET_PREFIX));
      const grant =
        new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/api/ws" && !("origin" in req.headers) && offered.includes(GATEWAY_PROTOCOL) && ticketProtos.length === 1
          ? redeem(ticketProtos[0]!.slice(TICKET_PREFIX.length), "interactive")
          : null;
      if (!grant) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        ws.on("message", (data) => void onRpc(ws, String(data)));
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { skin: {}, change_events: true, heartbeat: 30, replay_epoch: randomBytes(16).toString("hex"), session_authority: true } } }));
      });
    });
    const previous = port;
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    if (port === previous) {
      await new Promise((r) => server!.close(r));
      return start();
    }
    control = await controlServer(
      folder,
      (req) => {
        try {
          if (req.verb === "identify") return { ok: true, protocol: 1, id: req.id, result: identify() };
          if (req.verb === "session-ticket") return { ok: true, protocol: 1, id: req.id, result: sessionTicket(req) };
          return { ok: false, protocol: 1, id: req.id, error: `unknown verb: '${String(req.verb)}'` };
        } catch (err) {
          return { ok: false, protocol: 1, id: req.id, error: (err as Error).message };
        }
      },
      // Hermes' `sun_path` rule (`gateway/control_socket.py:116-119`).
      { pointer: Buffer.byteLength(path.join(folder, "gateway.sock")) > 100 },
    );
  };

  const shutdown = async () => {
    for (const s of sockets) s.terminate();
    sockets.clear();
    tickets.clear();
    await control?.close();
    rmSync(path.join(folder, "gateway.sock"), { force: true });
    if (server) await new Promise((r) => server!.close(r));
    control = null;
    server = null;
  };

  const fake: FakeHermes = {
    folder,
    get instanceId() {
      return instanceId;
    },
    get authorityEpoch() {
      return epoch;
    },
    get apiOrigin() {
      return `http://127.0.0.1:${port}`;
    },
    profiles,
    unserved,
    requests: [],
    tickets: [],
    violations: [],
    handle: (method, fn) => void handlers.set(method, fn),
    emit: (event) => {
      for (const s of sockets) s.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }));
    },
    restart: async (o = {}) => {
      await shutdown();
      if (o.contract) writeContract(o.contract);
      if (o.codeVersion) codeVersion = o.codeVersion;
      await start();
    },
    stop: async () => {
      await shutdown();
      if (ownFolder) removeDir(folder);
    },
  };

  writeContract(opts.contract);
  await start();
  return fake;
}

/** What P0 calls (worker `describe`, models, health). Shapes from the isolated Hermes run (T0.5). */
function p0Handlers(): Record<string, Handler> {
  return {
    "runtime.describe": (_p, { profile, fake }) => ({
      instance_id: fake.instanceId,
      profile_id: profile.home,
      authority_epoch: fake.authorityEpoch,
      capabilities: ["durable-admission-v1", "event-replay-v1", "local-cli-create-v1"],
      session_create: { sources: ["acp", "cli", "gui", "oneshot", "tool", "tui"], parameters: ["cwd", "follow_profile_config", "model", "provider", "reasoning", "request_id", "source", "title"] },
    }),
    // Every profile folder, the root first, then by name (`hermes_cli/profiles.py:983-1001`).
    "profiles.list": (_p, { fake }) => ({
      profiles: [fake.profiles[0]!, ...[...fake.profiles.slice(1), ...fake.unserved].sort((a, b) => a.name.localeCompare(b.name))].map((p) => ({
        name: p.name,
        path: p.home,
        is_default: p.name === "default",
        model: "stub",
        provider: "stub",
        display_name: p.name === "default" ? "" : p.name,
        last_session: null,
        worker_session: null,
        canonical_session: null,
      })),
      bot_mode_protocol: true,
      install_id: "",
    }),
    "session.list": (p) => ({ sessions: [], scope: (p.scope as string | undefined) ?? "live" }),
    "model.options": () => ({
      providers: [{ slug: "stub", name: "stub", is_current: true, models: ["stub"], total_models: 1, capabilities: { stub: { fast: false, reasoning: true } } }],
      model: "stub",
      provider: "stub",
    }),
  };
}
