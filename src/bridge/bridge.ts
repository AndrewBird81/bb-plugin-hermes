// Provider bridge (02 §Protocol mapping). One process per hosted thread (S1-S3 fact 2), but a process may
// host several threads, so state is keyed by threadId; one canonical connection per process and folder.
// `createBridge` runs in-process against any Hermes folder the provider options name (tests, the e2e
// seam's two-client harness).
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  createBridgeIo,
  createBridgeLineHandler,
  initializeParamsSchema,
  modelListParamsSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  type ProviderHealthResult,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  type ThreadDelta,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectionOptions } from "../hermes/client.js";
import { canonicalHome } from "../hermes/control.js";
import { availableModels, chipOption, fetchCatalog, placeholderModel } from "./composer.js";
import { resolveContext } from "./context.js";
import { expandHome, listedHere, readThread, readWorkerFile, threadForCwd } from "./files.js";
import { fallbackBot } from "../shared/bridge-files.js";
import { HermesLink, type History, restHistory } from "./hermes.js";
import { type BuildRegistry, openRegistry } from "./registry.js";
import { HOLD_RETRY_MS, HostedThread, type ThreadHost, type TurnParams } from "./thread.js";
import { PROVIDER_ID } from "./provider.js";

/** Identity before a Hermes session exists (02 §Protocol mapping `thread/start`; A15). */
export const pendingIdentity = (threadId: string) => `pending:${threadId}`;

/**
 * Listing B (D56): bb lists an `installed` provider on a machine unless its health there says `not_installed`
 * (research 13 §1). Hermes runs where the worker wrote `worker.json`: the saved Hermes machine, written at each
 * keep-alive whether or not the gateway answers, and removed when the Connection moves away (`release`). So Hermes is
 * listed only there, and stays listed while the gateway or the worker is down (a send then says why).
 * D58: elsewhere, the owner's `list-here` marker lists it as `unknown` (for row icons), never `ready`, so bb's
 * ready-provider default never picks it there.
 */
const HEALTH_TEXT = {
  ready: "Hermes runs on this machine.",
  unknown: "Hermes runs on another machine; listed here by list-here.",
  not_installed: "Hermes runs on another machine.",
} as const;
const health = (status: keyof typeof HEALTH_TEXT): ProviderHealthResult => ({
  supported: true,
  health: {
    status,
    statusMessage: HEALTH_TEXT[status],
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
});

type Notification = { jsonrpc: "2.0"; method: string; params: unknown };
type Reply = (result: unknown) => void;
type Fail = (code: number, message: string) => void;
interface Method {
  schema: z.ZodType;
  run(params: unknown, reply: Reply, fail: Fail): void | Promise<void>;
}
const method = <S extends z.ZodType>(schema: S, run: (params: z.infer<S>, reply: Reply, fail: Fail) => void | Promise<void>): Method => ({
  schema,
  run: run as Method["run"],
});

export interface Bridge {
  handleLine(line: string): void;
  /** Opens the build registry in the plugin's bridge dataDir. */
  start(dataDir: string, pluginId?: string): void;
  /** Removes the build registry file and closes Hermes connections. */
  close(): void;
}

export interface BridgeOptions {
  /** The history reader per Hermes folder; default: Hermes' REST projection (02 §History reader). */
  history?: (root: string) => History;
  /** Flow 3 step 4's retry delays; tests shorten them. */
  holdRetryMs?: readonly number[];
  /** Canonical connection options (tests shorten the backoff). */
  connection?: ConnectionOptions;
  /** One Hermes second in ms, for prompt deadlines; tests match the fake's `secondMs`. */
  secondMs?: number;
}

export function createBridge(build: string, opts: BridgeOptions = {}): Bridge {
  const io = createBridgeIo<Notification>();
  const notify = (method: string, params: unknown) => io.send({ jsonrpc: "2.0", method, params });
  const threads = new Map<string, HostedThread>();
  /** Our requests to the runtime, by id, awaiting its response line. */
  const outbound = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextRequest = 0;
  const processTag = randomUUID().slice(0, 8);
  const links = new Map<string, HermesLink>();
  const histories = new Map<string, History>();
  let registry: BuildRegistry | null = null;
  let dataDir: string | null = null;
  let pluginId = PROVIDER_ID;

  const host: ThreadHost = {
    get dataDir() {
      if (!dataDir) throw new Error("bridge not started");
      return dataDir;
    },
    get pluginId() {
      return pluginId;
    },
    holdRetryMs: opts.holdRetryMs ?? HOLD_RETRY_MS,
    secondMs: opts.secondMs ?? 1000,
    emit: (threadId: string, deltas: ThreadDelta[]) => notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas }),
    announce: (threadId: string, providerThreadId: string) => notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId }),
    request(method: string, params: unknown) {
      // Unique across bridge processes: bb's `providerRequestId` is `<daemon's per-process scope>:<this id>`
      // (`daemon-bundle.mjs` `vje`), so the server matches a dead card by this id's suffix (T1.14).
      const id = `hermes-${processTag}-${++nextRequest}`;
      const result = new Promise<unknown>((resolve, reject) => outbound.set(id, { resolve, reject }));
      io.send({ jsonrpc: "2.0", id, method, params } as never);
      return { id, result };
    },
    cancel(id: string) {
      const pending = outbound.get(id);
      if (!pending) return;
      outbound.delete(id);
      notify("notifications/cancelled", { requestId: id });
      pending.reject(new Error("cancelled"));
    },
    link(root: string) {
      const key = canonicalHome(root);
      let link = links.get(key);
      if (!link) links.set(key, (link = new HermesLink(root, opts.connection)));
      return link;
    },
    history(root: string) {
      const key = canonicalHome(root);
      let history = histories.get(key);
      if (!history) histories.set(key, (history = (opts.history ?? restHistory)(root)));
      return history;
    },
  };

  /** The chip and catalog for a thread whose bot is known; a refusal (other machine, switched off) waits for the turn to say it. */
  const publishComposer = (thread: HostedThread, options: unknown) => {
    const o = (options ?? {}) as { providerOptions?: unknown; sessionOptions?: Record<string, string | boolean> };
    let ctx;
    try {
      ctx = resolveContext({ providerOptions: o.providerOptions, sessionOptions: o.sessionOptions, saved: readThread(host.dataDir, thread.threadId), dataDir: host.dataDir, cwd: thread.cwd });
    } catch {
      return;
    }
    void thread.publishComposer(ctx).catch(() => undefined);
  };

  /** `model/list`: the models of the thread at `cwd`'s bot (else `fallbackBot`'s), with the chip (`chipOption`, A18). */
  const modelList = async (cwd: string | undefined) => {
    const worker = dataDir ? readWorkerFile(dataDir) : null;
    const known = worker ? threadForCwd(host.dataDir, cwd)?.entry : undefined;
    const own = known ? worker!.enabled.find((b) => b.profile_home === known.profile_home || b.profile === known.profile) : undefined;
    const bot = own ?? fallbackBot(worker?.enabled ?? []);
    if (!worker || !bot) return { models: [placeholderModel()], selectedOnlyModels: [] };
    const catalog = await fetchCatalog(host.link(expandHome(worker.root)), host.dataDir, bot);
    return { models: availableModels(catalog, [chipOption(worker.enabled, own)!], worker.models), selectedOnlyModels: [] };
  };

  const hostThread = (threadId: string, providerThreadId: string): HostedThread => {
    let thread = threads.get(threadId);
    if (!thread) threads.set(threadId, (thread = new HostedThread(threadId, providerThreadId, host)));
    else if (providerThreadId && !providerThreadId.startsWith("pending:")) thread.providerThreadId = providerThreadId;
    registry?.setThread(threadId);
    return thread;
  };

  const methods: Record<string, Method> = {
    [BRIDGE_REQUEST_METHODS.initialize]: method(initializeParamsSchema, (_, reply) =>
      reply({
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          sessionRestore: true,
          approvalEnforcedBy: "provider",
          fork: "none",
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
        },
      }),
    ),
    [BRIDGE_REQUEST_METHODS.providerHealth]: method(providerMaintenanceParamsSchema, (_, reply) =>
      reply(health(dataDir === null ? "not_installed" : readWorkerFile(dataDir) ? "ready" : listedHere(dataDir) ? "unknown" : "not_installed")),
    ),
    // A maintenance process: no provider options, so the thread's bot comes from its `threads/` record by cwd (S7 1c).
    [BRIDGE_REQUEST_METHODS.modelList]: method(modelListParamsSchema, async ({ cwd }, reply) => reply(await modelList(cwd))),
    [BRIDGE_REQUEST_METHODS.threadStart]: method(threadStartParamsSchema, ({ threadId, cwd, options }, reply) => {
      const providerThreadId = pendingIdentity(threadId);
      threads.delete(threadId);
      const thread = hostThread(threadId, providerThreadId);
      thread.cwd = cwd;
      notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId });
      reply({ providerThreadId, sessionRestorable: true });
      publishComposer(thread, options);
    }),
    // Records the identity only; never touches a session (R4 M4). Republishes the chip and the bot's models.
    [BRIDGE_REQUEST_METHODS.threadResume]: method(threadResumeParamsSchema, ({ threadId, providerThreadId, cwd, options }, reply) => {
      const thread = hostThread(threadId, providerThreadId);
      thread.cwd = cwd;
      thread.noteOptions((options as { providerOptions?: unknown } | undefined)?.providerOptions);
      reply({ providerThreadId: thread.providerThreadId, sessionRestorable: true });
      publishComposer(thread, options);
    }),
    [BRIDGE_REQUEST_METHODS.threadStop]: method(threadStopParamsSchema, async ({ threadId, intent }, reply) => {
      const thread = threads.get(threadId);
      if (intent === "release") {
        threads.delete(threadId);
        await thread?.release();
      } else await thread?.stop();
      reply({});
    }),
    [BRIDGE_REQUEST_METHODS.turnStart]: method(turnStartParamsSchema, ({ threadId, providerThreadId, clientRequestId, input, options }, reply) => {
      const thread = hostThread(threadId, providerThreadId);
      reply({});
      void thread.runTurn({ clientRequestId, input, options: options as TurnParams["options"] }).catch((error) => {
        process.stderr.write(`hermes bridge: turn failed: ${(error as Error).stack ?? error}\n`);
      });
    }),
    [BRIDGE_REQUEST_METHODS.turnSteer]: method(turnSteerParamsSchema, async (params, reply, fail) => {
      const thread = threads.get(params.threadId);
      const accepted = await thread?.steer(params.clientRequestId, params.input, { clientRequestId: params.clientRequestId, input: params.input, options: (params as { options?: TurnParams["options"] }).options ?? {} });
      if (accepted) reply({});
      else fail(BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "no active turn");
    }),
  };

  const handleLine = createBridgeLineHandler({
    handleParsedMessage(message) {
      const response = responseSchema.safeParse(message);
      if (response.success) {
        const pending = outbound.get(String(response.data.id));
        outbound.delete(String(response.data.id));
        if (response.data.error) pending?.reject(new Error(response.data.error.message ?? "request failed"));
        else pending?.resolve(response.data.result);
        return;
      }
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success) return; // notifications: nothing to answer
      const { id, method: name, params } = parsed.data;
      runBridgeRequest({
        request: { id },
        sendError: io.sendError,
        async handleRequest() {
          const handler = methods[name];
          if (!handler) return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${name}`);
          const checked = handler.schema.safeParse(params ?? {});
          if (!checked.success) {
            const issue = checked.error.issues[0];
            return io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${name}: ${issue?.path.join(".")} ${issue?.message}`);
          }
          await handler.run(
            checked.data,
            (result) => io.sendResult(id, result),
            (code, text) => io.sendError(id, code, text),
          );
        },
      });
    },
  });

  return {
    handleLine,
    start(dir, id) {
      dataDir = dir;
      if (id) pluginId = id;
      registry = openRegistry(dir, build);
    },
    close() {
      registry?.remove();
      registry = null;
      for (const link of links.values()) link.stop();
      links.clear();
    },
  };
}

const responseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.never().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
});

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
