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
import { z } from "zod";
import type { ConnectionOptions } from "../hermes/client.js";
import { canonicalHome } from "../hermes/control.js";
import { HermesLink, type History, restHistory } from "./hermes.js";
import { type BuildRegistry, openRegistry } from "./registry.js";
import { HOLD_RETRY_MS, HostedThread, type ThreadHost, type TurnParams } from "./thread.js";
import { PROVIDER_ID } from "./provider.js";

/** Identity before a Hermes session exists (02 §Protocol mapping `thread/start`; A15). */
export const pendingIdentity = (threadId: string) => `pending:${threadId}`;

/** `not_installed` always: hides Hermes from bb's pickers (S1-S3 §S3a). */
const HEALTH: ProviderHealthResult = {
  supported: true,
  health: {
    status: "not_installed",
    statusMessage: "Hermes chats are managed by the Hermes plugin.",
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
};

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
}

export function createBridge(build: string, opts: BridgeOptions = {}): Bridge {
  const io = createBridgeIo<Notification>();
  const notify = (method: string, params: unknown) => io.send({ jsonrpc: "2.0", method, params });
  const threads = new Map<string, HostedThread>();
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
    emit: (threadId: string, deltas: ThreadDelta[]) => notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas }),
    announce: (threadId: string, providerThreadId: string) => notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId }),
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
    [BRIDGE_REQUEST_METHODS.providerHealth]: method(providerMaintenanceParamsSchema, (_, reply) => reply(HEALTH)),
    // T1.3 fills this from `model.options`.
    [BRIDGE_REQUEST_METHODS.modelList]: method(modelListParamsSchema, (_, reply) => reply({ models: [], selectedOnlyModels: [] })),
    [BRIDGE_REQUEST_METHODS.threadStart]: method(threadStartParamsSchema, ({ threadId }, reply) => {
      const providerThreadId = pendingIdentity(threadId);
      threads.delete(threadId);
      hostThread(threadId, providerThreadId);
      notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId });
      reply({ providerThreadId, sessionRestorable: true });
    }),
    // Records the identity only; never touches Hermes (R4 M4).
    [BRIDGE_REQUEST_METHODS.threadResume]: method(threadResumeParamsSchema, ({ threadId, providerThreadId }, reply) => {
      const thread = hostThread(threadId, providerThreadId);
      reply({ providerThreadId: thread.providerThreadId, sessionRestorable: true });
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
      const parsed = requestSchema.safeParse(message);
      if (!parsed.success) return; // responses and notifications: nothing to answer
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

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
