// The worker's one host-scoped canonical connection (02 §Placement) and its health: `ensureWatch` keeps
// it open on the configured folder, the client redials after drops (02 flow 8), and every new gateway
// instance or version is checked against the surface we use (flow 11). P1: for the enabled bots it also
// keeps `worker.json` current, prewarms their models and watches their chats (hint + WAL stat). Off bots
// get no Hermes I/O (02 §Invariants). Never starts a gateway.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { HermesConnection, type ConnectionOptions } from "../hermes/client.js";
import { canonicalHome } from "../hermes/control.js";
import { bridgeDataDir, type EnabledBot } from "../shared/bridge-files.js";
import { botLabel } from "../shared/bots.js";
import type { EnsureWatchOutput, HermesProfile, VersionCheck, WatchState } from "../shared/host-contract.js";
import { profileNameFromHome } from "./access.js";
import { ChangeWatch, type ChangeWatchOptions } from "./changes.js";
import { describeProfiles } from "./describe.js";
import { ModelCache } from "./models.js";
import { checkRestKeys, checkVersion } from "./version.js";
import { WorkerFileWriter } from "./worker-file.js";

export type WatchSignal = { state: "connected" | "disconnected"; worker_boot_id: string; instance_id: string | null };
export type Emit = (payload: WatchSignal) => Promise<void>;
export type EmitChanged = (payload: { profile_homes: string[] }) => Promise<void>;

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
  changes?: ChangeWatchOptions;
  /** How long `models` waits for a fetch before the last-known catalog (tests shorten it). */
  modelsWaitMs?: number;
}

/** What one keep-alive tells the worker besides the folder. */
export interface Reconcile {
  enabledBots: readonly string[];
  /** The `models` setting, for `worker.json`. */
  models?: readonly string[];
  /** The worker's dataDir; bridges' files go to the sibling `bridge-data`. */
  dataDir: string;
}

interface KnownProfile {
  profile: HermesProfile;
  /** The profile's folder on this machine. */
  dir: string;
}

export class Watcher {
  readonly bootId = randomUUID();
  /** The folder as configured (`~/…`); never expanded in outputs. */
  root: string | null = null;
  state: WatchState = "idle";
  since: number | null = null;
  emit: Emit | null = null;
  emitChanged: EmitChanged | null = null;
  /** Enabled bots (profile homes) as of the last keep-alive. */
  enabled: readonly string[] = [];
  /** Every profile `profiles.list` named, by profile home. */
  readonly profiles = new Map<string, KnownProfile>();
  readonly models: ModelCache;
  private readonly changes: ChangeWatch;
  private readonly workerFile = new WorkerFileWriter();
  private dataDir: string | null = null;
  private rpcVersion: VersionCheck = UNCHECKED;
  /** `rest:` keys the REST key check found missing (flow 11); null until it ran for this instance. */
  private restMissing: string[] | null = null;
  private restKey: string | null = null;
  private conn: HermesConnection | null = null;
  private connected = false;
  private checkedKey: string | null = null;
  private checking: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: WatcherOptions = {}) {
    this.models = new ModelCache(
      (home, timeoutMs) => {
        const client = this.connected ? this.conn?.client : null;
        if (!client) return Promise.reject(new Error("not_connected"));
        return client.modelOptions(this.profileName(home), timeoutMs);
      },
      () => (this.dataDir ? bridgeDataDir(this.dataDir) : null),
    );
    this.changes = new ChangeWatch((profile_homes) => void this.emitChanged?.({ profile_homes }).catch(() => {}), opts.changes);
  }

  /** The RPC contract check merged with the REST key check: a missing REST key makes it unsupported. */
  get version(): VersionCheck {
    const v = this.rpcVersion;
    if (!this.restMissing?.length) return v;
    return { ...v, supported: false, missing: [...v.missing, ...this.restMissing] };
  }

  /** The expanded folder, once a call named it. */
  get rootHome(): string | null {
    return this.root === null ? null : expandRoot(this.root);
  }

  /** The name Hermes routes `profile_home` by: from `profiles.list`, else its folder (`default` = the root). */
  profileName(profileHome: string): string {
    const known = this.profiles.get(profileHome)?.profile.name;
    const name = known ?? (this.rootHome ? profileNameFromHome(this.rootHome, profileHome) : null);
    if (!name) throw new Error("unknown_profile");
    return name;
  }

  /** The watch connection's client, or a bounded refusal. */
  client() {
    const client = this.connected ? this.conn?.client : null;
    if (!client) throw new Error(`not_connected:${this.lastError ?? "connecting"}`);
    return client;
  }

  get instanceId(): string | null {
    return this.connected ? (this.conn?.endpoint?.instanceId ?? null) : null;
  }

  get lastError(): string | null {
    return boundedCode(this.conn?.lastError ?? null);
  }

  /** Idempotent. A new `root` drops the old connection first. */
  async ensure(root: string, signal?: AbortSignal, reconcile?: Reconcile): Promise<EnsureWatchOutput> {
    if (this.closed) throw new Error("worker_closed");
    if (root !== this.root || !this.conn) this.open(root);
    await this.settle(signal);
    await this.checking;
    if (reconcile) await this.reconcile(reconcile);
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
    const rows = (await client.profilesList({ include_sessions: false })).profiles;
    const described = await describeProfiles(rows, endpoint);
    this.profiles.clear();
    described.forEach((profile, i) => this.profiles.set(profile.home, { profile, dir: canonicalHome(rows[i]!.path) }));
    return described;
  }

  /** The Connection moved away (`release`, D56): stop watching, forget the folder and bots, remove `worker.json`. */
  async release(dataDir: string): Promise<boolean> {
    this.drop();
    this.root = null;
    this.enabled = [];
    this.profiles.clear();
    await this.changes.set(new Map());
    return this.workerFile.remove(bridgeDataDir(dataDir));
  }

  close(): void {
    this.closed = true;
    this.emit = null;
    this.emitChanged = null;
    this.changes.close();
    this.drop();
  }

  /**
   * P1 keep-alive work for the enabled bots: refresh the profile map, write `worker.json`, watch their
   * chats, prewarm their models, and key-check REST once per gateway instance. Best effort: a failure
   * here never fails the keep-alive.
   */
  private async reconcile({ enabledBots, models = [], dataDir }: Reconcile): Promise<void> {
    this.enabled = [...enabledBots];
    this.dataDir = dataDir;
    const root = this.root!;
    if (this.connected) await this.describe(root).catch(() => {});
    const enabled: EnabledBot[] = [];
    const dirs = new Map<string, string>();
    for (const home of this.enabled) {
      const known = this.profiles.get(home);
      if (known) enabled.push({ profile: known.profile.name, profile_home: home, bot_label: botLabel(known.profile.name, known.profile.handle), cwd: known.profile.terminal_cwd, served: known.profile.served });
      dirs.set(home, known?.dir ?? canonicalHome(home));
    }
    await this.workerFile.write(bridgeDataDir(dataDir), root, this.bootId, enabled, models).catch(() => {});
    await this.changes.set(dirs);
    if (!this.connected) return;
    this.models.prewarm(this.enabled);
    const key = this.checkedKey;
    if (key !== this.restKey && this.enabled.length) {
      const names = this.enabled.flatMap((h) => {
        try {
          return [this.profileName(h)];
        } catch {
          return [];
        }
      });
      const missing = await checkRestKeys(this.rootHome!, names).catch(() => null);
      if (missing && this.checkedKey === key) {
        this.restMissing = missing;
        this.restKey = key;
      }
    }
  }

  private open(root: string): void {
    this.drop();
    this.root = root;
    this.rpcVersion = UNCHECKED;
    this.restMissing = null;
    this.restKey = null;
    this.checkedKey = null;
    this.profiles.clear();
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
        this.restMissing = null;
        this.checking = checkVersion(conn.rootHome, endpoint).then((v) => {
          if (this.conn === conn) this.rpcVersion = v;
        });
      }
      // A hint only (r11 §8): every enabled bot may have changed.
      conn.client?.onEvent((ev) => {
        if (ev.type === "sessions.changed" && this.conn === conn) this.changes.hint();
      });
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
