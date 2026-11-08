// The bridge's Hermes side: one canonical connection per bridge process and folder (S1-S3 fact 2), with
// per-session event fan-out, and the history reader the replay and mirror renderers read (02 §History reader).
import { HermesConnection, type ConnectionOptions, type HermesClient } from "../hermes/client.js";
import { type ChainTurn, groupTurns, readChain, readMessages, type RestMessage } from "../hermes/history.js";
import type { GatewayEvent } from "../hermes/types.js";

/** How long a command waits for the gateway before failing the turn. */
export const CONNECT_TIMEOUT_MS = 20_000;

export class HermesUnreachable extends Error {
  constructor(readonly reason: string | null) {
    super(`hermes_unreachable${reason ? `:${reason}` : ""}`);
  }
}

export class HermesLink {
  private readonly connection: HermesConnection;
  private readonly sessions = new Map<string, Set<(ev: GatewayEvent) => void>>();
  private readonly reconnectListeners = new Set<(client: HermesClient) => void>();
  private wired: HermesClient | null = null;
  private everConnected = false;

  constructor(
    readonly rootHome: string,
    opts: ConnectionOptions = {},
  ) {
    this.connection = new HermesConnection(rootHome, opts);
    this.connection.onState((state) => {
      if (state !== "connected" || !this.connection.client) return;
      const client = this.connection.client;
      this.wire(client);
      if (this.everConnected) for (const fn of [...this.reconnectListeners]) fn(client);
      this.everConnected = true;
    });
  }

  private wire(client: HermesClient): void {
    if (this.wired === client) return;
    this.wired = client;
    client.onEvent((ev) => {
      if (!ev.session_id) return;
      for (const fn of [...(this.sessions.get(ev.session_id) ?? [])]) fn(ev);
    });
  }

  /** The connected client; starts the connection on first use and waits for it (never starts a gateway). */
  async client(timeoutMs = CONNECT_TIMEOUT_MS): Promise<HermesClient> {
    const ready = this.connection.client;
    if (this.connection.state === "connected" && ready && !ready.closed) return ready;
    this.connection.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new HermesUnreachable(this.connection.lastError));
      }, timeoutMs);
      const off = this.connection.onState((state) => {
        if (state !== "connected" || !this.connection.client) return;
        clearTimeout(timer);
        off();
        resolve(this.connection.client);
      });
    });
  }

  /** Events of one session id, after the client's replay dedupe. */
  subscribe(sessionId: string, fn: (ev: GatewayEvent) => void): () => void {
    let set = this.sessions.get(sessionId);
    if (!set) this.sessions.set(sessionId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.sessions.delete(sessionId);
    };
  }

  /** Called with the new client after a drop and a successful redial (flow 8). */
  onReconnect(fn: (client: HermesClient) => void): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  stop(): void {
    this.connection.stop();
  }
}

/** What the bridge reads from history: a chain's rows, root to tip, compression ancestors included. */
export interface History {
  /** Every row of the chain `sessionId` belongs to (`readChain`); `groupTurns` dedupes them (A8). */
  chain(profile: string, sessionId: string): Promise<{ session_id: string; messages: RestMessage[] }>;
  /** The newest page of the chain: enough to find the turn bb just ran. */
  latest(profile: string, sessionId: string): Promise<{ session_id: string; messages: RestMessage[] }>;
}

/** The REST history reader over `native-http` (02 §History reader). */
export function restHistory(rootHome: string): History {
  return {
    chain: (profile, sessionId) => readChain(rootHome, profile, sessionId),
    async latest(profile, sessionId) {
      const page = await readMessages(rootHome, profile, sessionId, { limit: 500, include_compacted: true });
      return { session_id: page.session_id, messages: page.messages };
    },
  };
}

export interface FoundTurn {
  turn: ChainTurn;
  /** A later turn started, or the last reply is a final assistant message (no tool calls pending). */
  complete: boolean;
}

/** The turn anchored at `anchorUid` in a chain's rows; null when the anchor isn't there (yet). */
export function findTurn(rows: RestMessage[], anchorUid: string): FoundTurn | null {
  const turns = groupTurns(rows);
  const at = turns.findIndex((t) => t.anchor_uid === anchorUid);
  if (at < 0) return null;
  const turn = turns[at]!;
  const last = turn.replies.at(-1);
  const final = last?.role === "assistant" && !(Array.isArray(last.tool_calls) && last.tool_calls.length > 0);
  return { turn, complete: at < turns.length - 1 || final };
}
