// Provider bridge skeleton (T0.7; 02 §Protocol mapping). One process per hosted thread (S1-S3 fact 2),
// but a process may host several threads, so state is keyed by threadId.
// No Hermes I/O yet: turns fail with a clear `provider.error` until P1 (T1.1).
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
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { type BuildRegistry, openRegistry } from "./registry.js";

export const TURNS_NOT_READY = "Chatting with Hermes from bb isn't available in this version of the Hermes plugin yet.";

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
interface Method {
  schema: z.ZodType;
  run(params: unknown, reply: Reply): void;
}
const method = <S extends z.ZodType>(schema: S, run: (params: z.infer<S>, reply: Reply) => void): Method => ({
  schema,
  run: run as Method["run"],
});

export interface Bridge {
  handleLine(line: string): void;
  /** Opens the build registry in the plugin's bridge dataDir. */
  start(dataDir: string): void;
  /** Removes the build registry file. */
  close(): void;
}

export function createBridge(build: string): Bridge {
  const io = createBridgeIo<Notification>();
  const notify = (method: string, params: unknown) => io.send({ jsonrpc: "2.0", method, params });
  const emit = (threadId: string, deltas: ThreadDelta[]) => notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
  /** threadId → providerThreadId. */
  const hosted = new Map<string, string>();
  let registry: BuildRegistry | null = null;

  const host = (threadId: string, providerThreadId: string) => {
    hosted.set(threadId, providerThreadId);
    registry?.setThread(threadId);
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
      host(threadId, providerThreadId);
      notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId });
      reply({ providerThreadId, sessionRestorable: true });
    }),
    // Records the identity only; never touches Hermes (R4 M4).
    [BRIDGE_REQUEST_METHODS.threadResume]: method(threadResumeParamsSchema, ({ threadId, providerThreadId }, reply) => {
      host(threadId, providerThreadId);
      reply({ providerThreadId, sessionRestorable: true });
    }),
    // No turn ever runs yet, so `interrupt` has nothing to stop; `release` forgets the thread.
    [BRIDGE_REQUEST_METHODS.threadStop]: method(threadStopParamsSchema, ({ threadId, intent }, reply) => {
      if (intent === "release") hosted.delete(threadId);
      reply({});
    }),
    [BRIDGE_REQUEST_METHODS.turnStart]: method(turnStartParamsSchema, ({ threadId, clientRequestId }, reply) => {
      reply({});
      emit(threadId, [
        { kind: "input.accepted", clientRequestId },
        { kind: "turn.open" },
        { kind: "provider.error", message: TURNS_NOT_READY, settlesTurn: true },
      ]);
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
          handler.run(checked.data, (result) => io.sendResult(id, result));
        },
      });
    },
  });

  return {
    handleLine,
    start(dataDir) {
      registry = openRegistry(dataDir, build);
    },
    close() {
      registry?.remove();
      registry = null;
    },
  };
}

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});
