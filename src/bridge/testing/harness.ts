// Test-only: a bridge in-process against the strict fake and the session engine, with the files the worker
// would write, and helpers to drive JSON-RPC and read the assembled bb events.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import {
  type BridgeJsonRpcTestHarness,
  experimental_assembleCapturedThreadEvents as assemble,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { tempDir, removeDir } from "../../../test/fake-hermes/wire.js";
import { type FakeHermes, startFakeHermes } from "../../../test/fake-hermes/index.js";
import { botLabel } from "../../shared/bots.js";
import { WORKER_FILE, type WorkerFile } from "../../shared/bridge-files.js";
import type { ProviderOptions, ThreadView } from "../../shared/provider-options.js";
import { type Bridge, createBridge } from "../bridge.js";
import { PROVIDER_ID } from "../provider.js";
import { HermesClient, localDial } from "../../hermes/client.js";

export const AUTO = { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" } as const;

export interface Rig {
  fake: FakeHermes;
  bridge: Bridge;
  rpc: BridgeJsonRpcTestHarness;
  dataDir: string;
  /** Provider options for a thread of `profile`; `view` overrides the thread view, `null` = unbound. */
  options(profile: string, view?: Partial<ThreadView> | null): ProviderOptions;
  call(method: string, params: object): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  /** Every Hermes request with this method, refusals included. */
  requests(method: string): { method: string; params: Record<string, unknown>; profile: string; refused?: string }[];
  events(threadId?: string): ReturnType<typeof assemble>;
  notifications(method: string): unknown[];
  /** Wait for an assembled event matching `pred`. */
  waitFor<T>(pred: () => T | undefined | null | false, timeoutMs?: number): Promise<T>;
  /** Another canonical client (CLI, TUI, Desktop) on the same gateway. */
  cli(): Promise<HermesClient>;
  close(): Promise<void>;
}

let nextId = 1;
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
/** bb's client request id shape (`creq_` + 10 of bb's alphabet). */
export function creq(): string {
  let out = "creq_";
  for (let i = 0; i < 10; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export async function startRig(opts: { profiles?: string[]; enabled?: string[]; worker?: boolean; holdRetryMs?: number[]; rotating?: string[]; secondMs?: number } = {}): Promise<Rig> {
  const fake = await startFakeHermes({ profiles: opts.profiles ?? ["alex", "bob"], rotating: opts.rotating, secondMs: opts.secondMs });
  const clients: HermesClient[] = [];
  const dataDir = tempDir("bridge-data-");
  const enabled = (opts.enabled ?? fake.profiles.map((p) => p.name)).map((name) => {
    const p = fake.profiles.find((x) => x.name === name)!;
    return { profile: p.name, profile_home: p.home, bot_label: botLabel(p.name), cwd: null };
  });
  if (opts.worker !== false) {
    const worker: WorkerFile = { root: fake.folder, worker_boot_id: "boot-1", written_at: Date.now(), enabled };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, WORKER_FILE), JSON.stringify(worker));
  }
  const bridge = createBridge("test-build", { holdRetryMs: opts.holdRetryMs ?? [20, 20, 40], connection: { backoffMs: [20, 50] }, secondMs: opts.secondMs });
  bridge.start(dataDir, "hermes");
  const rpc = createHarness(bridge.handleLine);
  const rig: Rig = {
    fake,
    bridge,
    rpc,
    dataDir,
    options(profile, view = {}) {
      const p = fake.profiles.find((x) => x.name === profile)!;
      const thread: ThreadView | null =
        view === null
          ? null
          : {
              kind: "chat",
              profile: p.name,
              profile_home: p.home,
              bot_label: botLabel(p.name),
              enabled: true,
              lineage_root: null,
              session_id: null,
              legacy: false,
              tag: null,
              cwd: null,
              ...view,
            };
      return { folder: fake.folder, machine: { id: "host-1", name: "hermes-mac" }, thread };
    },
    async call(method, params) {
      const id = nextId++;
      rpc.sendRequest(id, method, params as never);
      return rpc.waitForResponse(id) as never;
    },
    requests: (method) => fake.requests.filter((r) => r.method === method) as never,
    events: (threadId) =>
      assemble(
        rpc.messages.filter((m) => m.method === "thread/delta" && (!threadId || (m.params as { threadId?: string }).threadId === threadId)),
        PROVIDER_ID,
      ),
    notifications: (method) => rpc.messages.filter((m) => m.method === method).map((m) => m.params),
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const v = pred();
        if (v) return v as never;
        if (Date.now() > deadline) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    async cli() {
      const client = await HermesClient.connect((await localDial(fake.folder)).dial);
      clients.push(client);
      return client;
    },
    async close() {
      for (const c of clients) c.close();
      rpc.restore();
      bridge.close();
      await fake.stop();
      removeDir(dataDir);
    },
  };
  return rig;
}

export const text = (t: string): PromptInput => ({ type: "text", mentions: [], text: t });

/** Start a thread and run one turn; resolves when that turn has settled. */
export async function turn(rig: Rig, threadId: string, input: PromptInput[], options: object, clientRequestId = creq()): Promise<string> {
  const before = rig.events(threadId).filter((e) => e.type === "turn/completed").length;
  await rig.call("turn/start", { threadId, providerThreadId: `pending:${threadId}`, input, clientRequestId, options: { ...AUTO, ...options } });
  await rig.waitFor(() => rig.events(threadId).filter((e) => e.type === "turn/completed").length > before);
  return clientRequestId;
}

export async function startThread(rig: Rig, threadId: string, options: object): Promise<void> {
  await rig.call("thread/start", { threadId, cwd: "/work", options: { ...AUTO, ...options }, instructionMode: "append" });
}
