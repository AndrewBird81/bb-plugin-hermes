// Canonical client (02 §Components): hermes-gateway-v1 JSON-RPC over one WebSocket, per-session replay
// cursors, and a connection that rediscovers, mints a fresh ticket and redials after every drop (flow 8).
// Ported from `spike/hermes` `src/hermes/`. Never starts a gateway (02 §Placement).
import { discoverEndpoint, mintTicket } from "./control.js";
import type {
  AdmissionStatus,
  ControlHandle,
  CorrectionAck,
  CreateParams,
  Dial,
  EventsSinceResult,
  GatewayEndpoint,
  GatewayEvent,
  MutateResult,
  ProfileRow,
  PromptResponse,
  RuntimeDescribe,
  SessionListRow,
  Snapshot,
  SubmitParams,
} from "./types.js";
import { GATEWAY_PROTOCOL, TICKET_PREFIX } from "./types.js";

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** Redial delays after a drop or a failed connect; the last repeats (02 flow 8). */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000];

/** An owner refusal (`error` frame). `reason` is the bounded code (`stale_generation`, `not_found`, …). */
export class HermesRpcError extends Error {
  readonly code: number | null;
  readonly reason: string;
  readonly data: Record<string, unknown>;
  constructor(error: { code?: unknown; message?: unknown; data?: unknown }) {
    const data = (error.data && typeof error.data === "object" ? error.data : {}) as Record<string, unknown>;
    const reason = typeof data.reason === "string" ? data.reason : typeof error.message === "string" ? error.message : "request_failed";
    super(reason);
    this.code = typeof error.code === "number" ? error.code : null;
    this.reason = reason;
    this.data = data;
  }
}

/** The socket went away with the request in flight: the outcome is unknown, never resend blindly (S8 step 4). */
export class HermesDisconnectedError extends Error {
  readonly sent: boolean;
  constructor(sent: boolean) {
    super(sent ? "gateway disconnected; outcome unknown" : "gateway disconnected before send");
    this.sent = sent;
  }
}

export interface SessionCursor {
  replayEpoch: string;
  lastSequence: number;
  executionGeneration: number;
  subscriptionId: string;
  revision: number;
}

type WsCtor = new (url: string, protocols: string[]) => WebSocket;

export interface ClientOptions {
  /** Defaults to the runtime's global WebSocket. */
  WebSocket?: WsCtor;
  openTimeoutMs?: number;
  /** Raw frame tap for recorded fixtures (03 layer 4): `in` = from Hermes, `out` = to Hermes. */
  onFrame?: (dir: "in" | "out", raw: string) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Discover the gateway on `<rootHome>/gateway.sock`, mint a host-scoped ticket, and build the `/api/ws` dial. */
export async function localDial(rootHome: string): Promise<{ dial: Dial; endpoint: GatewayEndpoint }> {
  const endpoint = await discoverEndpoint(rootHome);
  const ticket = await mintTicket(endpoint, "interactive");
  return {
    dial: { url: endpoint.apiOrigin.replace(/^http/, "ws") + "/api/ws", protocols: [GATEWAY_PROTOCOL, TICKET_PREFIX + ticket] },
    endpoint,
  };
}

export class HermesClient {
  readonly cursors = new Map<string, SessionCursor>();
  ready: Record<string, unknown> | null = null;
  closed = false;
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(ev: GatewayEvent) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private readonly onFrame?: ClientOptions["onFrame"];

  private constructor(ws: WebSocket, onFrame?: ClientOptions["onFrame"]) {
    this.ws = ws;
    this.onFrame = onFrame;
    ws.addEventListener("message", (m) => this.onMessage(String(m.data)));
    ws.addEventListener("close", (e) => this.onClose(e.code, e.reason));
    ws.addEventListener("error", () => {}); // a 'close' always follows
  }

  /** Open the socket; resolve once the owner's `gateway.ready` event arrives. */
  static connect(dial: Dial, opts: ClientOptions = {}): Promise<HermesClient> {
    const Ctor: WsCtor = opts.WebSocket ?? (globalThis.WebSocket as unknown as WsCtor);
    const ws = new Ctor(dial.url, dial.protocols);
    const client = new HermesClient(ws, opts.onFrame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("open_timeout"));
      }, opts.openTimeoutMs ?? 10_000);
      const fail = (code: number, reason: string) => {
        clearTimeout(timer);
        reject(new Error(`ws_closed:${code}${reason ? ":" + reason : ""}`));
      };
      client.closeListeners.add(fail);
      ws.addEventListener("open", () => {
        if (ws.protocol !== GATEWAY_PROTOCOL) ws.close(1002, "protocol_mismatch");
      });
      const off = client.onEvent((ev) => {
        if (ev.type !== "gateway.ready") return;
        clearTimeout(timer);
        off();
        client.closeListeners.delete(fail);
        client.ready = ev.payload ?? {};
        resolve(client);
      });
    });
  }

  /** Every event, after replay dedupe. Returns an unsubscribe function. */
  onEvent(fn: (ev: GatewayEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onDisconnect(fn: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  rpc<T = unknown>(method: string, params: object = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    if (this.closed || this.ws.readyState !== 1) return Promise.reject(new HermesDisconnectedError(false));
    const id = ++this.nextId;
    const raw = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.onFrame?.("out", raw);
      this.ws.send(raw);
    });
  }

  private onMessage(raw: string): void {
    this.onFrame?.("in", raw);
    let frame: { id?: unknown; method?: string; params?: GatewayEvent; result?: unknown; error?: Record<string, unknown> };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const p = typeof frame.id === "number" && !frame.method ? this.pending.get(frame.id) : undefined;
    if (p) {
      this.pending.delete(frame.id as number);
      clearTimeout(p.timer);
      if (frame.error) p.reject(new HermesRpcError(frame.error));
      else p.resolve(frame.result ?? {});
      return;
    }
    if (frame.method === "event" && frame.params && typeof frame.params.type === "string") this.dispatch(frame.params);
    // Server→client requests (sudo, secret, batch clarify) need capabilities bb never advertises: ignored.
  }

  /** Dedupe (S0-S4 §S4e, 02 §Invariants): drop `seq <= cursor` within the same replay epoch. */
  private dispatch(ev: GatewayEvent): void {
    const cursor = ev.session_id ? this.cursors.get(ev.session_id) : undefined;
    if (cursor && typeof ev.seq === "number" && typeof ev.replay_epoch === "string") {
      if (ev.replay_epoch === cursor.replayEpoch && ev.seq <= cursor.lastSequence) return;
      cursor.replayEpoch = ev.replay_epoch;
      cursor.lastSequence = ev.seq;
      if (typeof ev.execution_generation === "number") cursor.executionGeneration = ev.execution_generation;
    }
    for (const fn of [...this.listeners]) fn(ev);
  }

  private onClose(code: number, reason: string): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new HermesDisconnectedError(true));
      this.pending.delete(id);
    }
    for (const fn of [...this.closeListeners]) fn(code, reason);
  }

  private track(snap: Snapshot): Snapshot {
    this.cursors.set(snap.session_id, {
      replayEpoch: snap.replay_epoch,
      lastSequence: snap.last_sequence,
      executionGeneration: snap.execution_generation,
      subscriptionId: snap.subscription_id,
      revision: snap.revision,
    });
    return snap;
  }

  // Typed verbs: exactly the params in `contract/used-surface.json`.

  describe() {
    return this.rpc<RuntimeDescribe>("runtime.describe");
  }

  profilesList(profile?: string) {
    return this.rpc<{ profiles: ProfileRow[]; bot_mode_protocol?: boolean }>("profiles.list", profile ? { profile } : {});
  }

  sessionList(params: { profile?: string; title?: string; include_hidden?: boolean; scope?: "live" | "stored"; limit?: number } = {}) {
    return this.rpc<{ sessions: SessionListRow[]; scope: string }>("session.list", params);
  }

  /** Legacy method (02 §Protocol mapping `model/list`): never creates a session (r09 M6). */
  modelOptions(profile: string, timeoutMs?: number) {
    return this.rpc<{ providers: unknown[]; model?: string; provider?: string }>("model.options", { profile }, timeoutMs);
  }

  async create(params: CreateParams): Promise<Snapshot> {
    return this.track(await this.rpc<Snapshot>("session.create", params));
  }

  async resume(params: { profile?: string; session_id: string; omit_messages?: boolean }): Promise<Snapshot> {
    return this.track(await this.rpc<Snapshot>("session.resume", params));
  }

  submit(params: SubmitParams) {
    return this.rpc<AdmissionStatus>("prompt.submit", params);
  }

  cancel(params: { session_id: string; admission_id: string }) {
    return this.rpc<AdmissionStatus>("prompt.cancel", params);
  }

  resolveUnknown(params: { session_id: string; admission_id: string; execution_generation: number }) {
    return this.rpc<AdmissionStatus>("prompt.resolve_unknown", params);
  }

  interrupt(params: { profile?: string; session_id: string; execution_generation: number }) {
    return this.rpc<ControlHandle>("session.interrupt", params);
  }

  steer(params: { profile?: string; session_id: string; execution_generation: number; text: string }) {
    return this.rpc<CorrectionAck>("session.steer", params);
  }

  approvalRespond(params: { profile?: string; session_id: string; execution_generation: number; prompt_id: string; choice: string }) {
    return this.rpc<PromptResponse>("approval.respond", params);
  }

  clarifyRespond(params: { session_id: string; execution_generation: number; prompt_id: string; answer: string }) {
    return this.rpc<PromptResponse>("clarify.respond", params);
  }

  mutate(params: {
    session_id: string;
    request_id: string;
    expected_revision: number;
    expected_generation?: number;
    operation: string;
    payload: Record<string, unknown>;
  }) {
    return this.rpc<MutateResult>("session.mutate", params);
  }

  eventsSince(params: { profile?: string; session_id: string; last_sequence: number; replay_epoch?: string }) {
    return this.rpc<EventsSinceResult>("session.events.since", params);
  }

  /** No `profile` key (R1 S6); `end_reason: null` keeps the row (A24). */
  detach(params: { session_id: string; subscription_id: string; end_reason: string | null }) {
    return this.rpc<{ session_id: string; subscription_id: string; detached: boolean }>("session.detach", params);
  }

  /**
   * Re-attach a session after a reconnect, no event lost or doubled (flow 8):
   * 1. `session.events.since` from the cursor replays the gap;
   * 2. `session.resume{omit_messages}` re-subscribes this socket.
   * Both pass the same dedupe. `snapshotRequired` (gap lost, or a new epoch): re-read the transcript.
   */
  async reattach(
    profile: string | undefined,
    sessionId: string,
    cursor: SessionCursor,
  ): Promise<{ snapshot: Snapshot; replayed: number; snapshotRequired: boolean }> {
    this.cursors.set(sessionId, { ...cursor });
    const gap = await this.eventsSince({
      ...(profile ? { profile } : {}),
      session_id: sessionId,
      last_sequence: cursor.lastSequence,
      replay_epoch: cursor.replayEpoch,
    });
    let replayed = 0;
    if (!gap.snapshot_required) {
      for (const ev of gap.events) {
        const before = this.cursors.get(sessionId)!.lastSequence;
        this.dispatch({ ...ev, replayed: true });
        if (this.cursors.get(sessionId)!.lastSequence !== before) replayed++;
      }
    }
    const kept = this.cursors.get(sessionId)!;
    const snapshot = await this.rpc<Snapshot>("session.resume", { ...(profile ? { profile } : {}), session_id: sessionId, omit_messages: true });
    // Keep the higher watermark: the snapshot may lag frames already dispatched above.
    const sameEpoch = snapshot.replay_epoch === kept.replayEpoch;
    this.cursors.set(sessionId, {
      replayEpoch: snapshot.replay_epoch,
      lastSequence: sameEpoch ? Math.max(kept.lastSequence, snapshot.last_sequence) : snapshot.last_sequence,
      executionGeneration: snapshot.execution_generation,
      subscriptionId: snapshot.subscription_id,
      revision: snapshot.revision,
    });
    return { snapshot, replayed, snapshotRequired: gap.snapshot_required || gap.truncated || !sameEpoch };
  }
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "stopped";

export interface ConnectionOptions extends ClientOptions {
  /** Tests shorten it; defaults to `RECONNECT_BACKOFF_MS`. */
  backoffMs?: number[];
}

/**
 * One long-lived canonical connection to the gateway serving `rootHome` (worker, bridge). Every connect
 * rediscovers on `gateway.sock` and mints a new ticket; after a drop or a failure it waits 1/2/5/10 s
 * and tries again until `stop()` (02 flow 8). A missing gateway is waited for, never started.
 */
export class HermesConnection {
  state: ConnectionState = "disconnected";
  client: HermesClient | null = null;
  endpoint: GatewayEndpoint | null = null;
  /** A bounded reason for the last failed connect or drop (`no_gateway`, `not_ready:draining`, `ws_closed:1006`). */
  lastError: string | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly backoff: number[];

  constructor(
    readonly rootHome: string,
    private readonly opts: ConnectionOptions = {},
  ) {
    this.backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
  }

  /** Called on every state change; read `client` and `endpoint` when `connected`. */
  onState(fn: (state: ConnectionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.state === "connecting" || this.state === "connected") return;
    void this.connectOnce();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client;
    this.client = null;
    this.set("stopped");
    client?.close();
  }

  private set(state: ConnectionState): void {
    this.state = state;
    for (const fn of [...this.listeners]) fn(state);
  }

  private async connectOnce(): Promise<void> {
    this.timer = null;
    this.set("connecting");
    try {
      const { dial, endpoint } = await localDial(this.rootHome);
      const client = await HermesClient.connect(dial, this.opts);
      if (this.state === "stopped") return client.close();
      this.attempt = 0;
      this.lastError = null;
      this.client = client;
      this.endpoint = endpoint;
      client.onDisconnect((code) => {
        if (this.client !== client) return;
        this.client = null;
        this.lastError = `ws_closed:${code}`;
        this.retry();
      });
      this.set("connected");
    } catch (err) {
      if (this.state === "stopped") return;
      this.lastError = (err as { reason?: string }).reason ?? (err as Error).message;
      this.retry();
    }
  }

  private retry(): void {
    if (this.state === "stopped") return;
    this.set("disconnected");
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 10_000;
    this.attempt++;
    this.timer = setTimeout(() => void this.connectOnce(), delay);
  }
}
