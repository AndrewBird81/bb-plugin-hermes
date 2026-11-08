// The worker's one host-scoped canonical connection (02 §Placement) and its health: `ensureWatch` keeps
// it open on the configured folder, the client redials after drops (02 flow 8), and every new gateway
// instance or version is checked against the surface we use (flow 11). Never starts a gateway.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { HermesConnection, type ConnectionOptions } from "../hermes/client.js";
import type { EnsureWatchOutput, HermesProfile, VersionCheck, WatchState } from "../shared/host-contract.js";
import { describeProfiles } from "./describe.js";
import { checkVersion } from "./version.js";

export type WatchSignal = { state: "connected" | "disconnected"; worker_boot_id: string; instance_id: string | null };
export type Emit = (payload: WatchSignal) => Promise<void>;

/** How long a call waits for a connect attempt in flight; the next keep-alive sees the rest. */
export const SETTLE_MS = 5000;

/** `~` is the Hermes machine's home: this worker's (02 §Placement). */
export function expandRoot(root: string): string {
  return root === "~" ? homedir() : root.startsWith("~/") ? path.join(homedir(), root.slice(2)) : root;
}

/** Ids and bounded codes only (02 §bb access and security): anything else becomes `error`. */
export function boundedCode(reason: string | null): string | null {
  if (reason === null) return null;
  return /^[A-Za-z0-9_:.-]{1,64}$/.test(reason) ? reason : "error";
}

const UNCHECKED: VersionCheck = { version: null, supported: null, missing: [], checked_at: null };

export interface WatcherOptions {
  connection?: ConnectionOptions;
  settleMs?: number;
}

export class Watcher {
  readonly bootId = randomUUID();
  /** The folder as configured (`~/…`); never expanded in outputs. */
  root: string | null = null;
  state: WatchState = "idle";
  since: number | null = null;
  version: VersionCheck = UNCHECKED;
  emit: Emit | null = null;
  private conn: HermesConnection | null = null;
  private connected = false;
  private checkedKey: string | null = null;
  private checking: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: WatcherOptions = {}) {}

  get instanceId(): string | null {
    return this.connected ? (this.conn?.endpoint?.instanceId ?? null) : null;
  }

  get lastError(): string | null {
    return boundedCode(this.conn?.lastError ?? null);
  }

  /** Idempotent. A new `root` drops the old connection first. */
  async ensure(root: string, signal?: AbortSignal): Promise<EnsureWatchOutput> {
    if (this.closed) throw new Error("worker_closed");
    if (root !== this.root || !this.conn) this.open(root);
    await this.settle(signal);
    await this.checking;
    const supported = this.connected ? this.version.supported : null;
    return {
      worker_boot_id: this.bootId,
      connected: this.connected,
      instance_id: this.instanceId,
      version: this.connected ? this.version.version : null,
      supported,
      detail: !this.connected ? (this.lastError ?? "connecting") : supported === false ? `missing:${this.version.missing.length}` : null,
    };
  }

  /** Profiles of the gateway serving `root`, through `profiles.list` on the watch connection. */
  async describe(root: string, signal?: AbortSignal): Promise<HermesProfile[]> {
    const watch = await this.ensure(root, signal);
    const client = this.conn?.client;
    const endpoint = this.conn?.endpoint;
    if (!watch.connected || !client || !endpoint) throw new Error(`not_connected:${watch.detail}`);
    return describeProfiles((await client.profilesList()).profiles, endpoint);
  }

  close(): void {
    this.closed = true;
    this.emit = null;
    this.drop();
  }

  private open(root: string): void {
    this.drop();
    this.root = root;
    this.version = UNCHECKED;
    this.checkedKey = null;
    const conn = new HermesConnection(expandRoot(root), this.opts.connection);
    this.conn = conn;
    conn.onState((s) => {
      if (this.conn === conn) this.onState(conn, s);
    });
    conn.start();
  }

  private drop(): void {
    const conn = this.conn;
    this.conn = null;
    conn?.stop();
    if (this.connected) this.signal("disconnected", null);
    this.connected = false;
    this.setState("idle");
  }

  private onState(conn: HermesConnection, s: HermesConnection["state"]): void {
    const endpoint = conn.endpoint;
    if (s === "connected" && endpoint) {
      this.connected = true;
      this.setState("connected");
      // Flow 11: once per gateway instance and version.
      const key = `${endpoint.instanceId}\n${endpoint.codeVersion}\n${endpoint.codeSha}`;
      if (key !== this.checkedKey) {
        this.checkedKey = key;
        this.checking = checkVersion(conn.rootHome, endpoint).then((v) => {
          if (this.conn === conn) this.version = v;
        });
      }
      this.signal("connected", endpoint.instanceId);
      return;
    }
    const was = this.connected;
    this.connected = false;
    this.setState(s === "connecting" ? "connecting" : "disconnected");
    if (was) this.signal("disconnected", null);
  }

  private setState(state: WatchState): void {
    if (state === this.state) return;
    this.state = state;
    this.since = Date.now();
  }

  private signal(state: WatchSignal["state"], instance_id: string | null): void {
    void this.emit?.({ state, worker_boot_id: this.bootId, instance_id }).catch(() => {});
  }

  /** Wait for a connect attempt in flight, bounded by `settleMs` and the call. */
  private settle(signal?: AbortSignal): Promise<void> {
    const conn = this.conn;
    if (!conn || conn.state !== "connecting") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, this.opts.settleMs ?? SETTLE_MS);
      const off = conn.onState((s) => {
        if (s !== "connecting") done();
      });
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
