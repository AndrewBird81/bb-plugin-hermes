// Server ↔ host worker (02 §Contracts). Every call carries `root` (the folder setting): a fresh worker
// learns it from any call. Profiles are named by `profile_home` (Hermes `profile_id`); the worker maps
// it to the profile name Hermes routes and REST reads by. Outputs hold ids and bounded codes, except
// `listSessions` titles and `readTurns` user text, which the server needs for spawns and wakes and
// never stores (02 §bb access and security).
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { catalogSchema } from "./models.js";
import { folderSchema } from "./settings.js";

const profileHome = z.string().min(1);

/** The worker's view of the Hermes version (flow 11, A51). `supported: null` = unknown: no contract file. */
export const versionCheckSchema = z
  .object({
    /** Hermes `code_version` from the gateway's `identify`, else its short `code_sha`. */
    version: z.string().nullable(),
    supported: z.boolean().nullable(),
    /** Canonical methods or REST keys we use that this Hermes lacks (`method:session.steer`, `param:prompt.submit.turn_author`, `rest:list.title`). */
    missing: z.array(z.string()),
    checked_at: z.number().nullable(),
  })
  .strict();
export type VersionCheck = z.infer<typeof versionCheckSchema>;

export const watchStateSchema = z.enum(["idle", "connecting", "connected", "disconnected"]);
export type WatchState = z.infer<typeof watchStateSchema>;

export const ensureWatchOutputSchema = z
  .object({
    /** New per worker process. A new id → the server runs a full reconcile. */
    worker_boot_id: z.string(),
    connected: z.boolean(),
    /** The gateway's `instance_id` (`identify`); null while not connected. */
    instance_id: z.string().nullable(),
    version: z.string().nullable(),
    supported: z.boolean().nullable(),
    /** A bounded code when not connected or not supported (`no_gateway`, `not_ready:<state>`, `missing:2`…). */
    detail: z.string().nullable(),
  })
  .strict();
export type EnsureWatchOutput = z.infer<typeof ensureWatchOutputSchema>;

export const profileSchema = z
  .object({
    name: z.string(),
    /** Hermes `profile_id`: the profile home on the Hermes machine. An id, never shown. */
    home: z.string(),
    /** Bot Mode handle, else null (the name is shown; `default` shows as "Hermes", r11 §2). */
    handle: z.string().nullable(),
    terminal_cwd: z.string().nullable(),
    /** Listed in the host gateway's `served_profiles` (S8 §Per-profile reach). */
    served: z.boolean(),
  })
  .strict();
export type HermesProfile = z.infer<typeof profileSchema>;

export const bridgeRecordSchema = z
  .object({ pid: z.number().int(), build: z.string(), thread_id: z.string().nullable(), started_at: z.number(), alive: z.boolean() })
  .strict();

export const workerDiagnosticsSchema = z
  .object({
    pid: z.number().int(),
    started_at: z.number(),
    worker_boot_id: z.string(),
    build: z.string(),
    watch: z
      .object({
        /** The folder as configured (`~/…`), never expanded. */
        root: z.string().nullable(),
        state: watchStateSchema,
        instance_id: z.string().nullable(),
        since: z.number().nullable(),
        last_error: z.string().nullable(),
      })
      .strict(),
    version: versionCheckSchema,
    /** Bridge build registry (`bridges/<pid>.json`, A22). */
    bridges: z.array(bridgeRecordSchema),
  })
  .strict();
export type WorkerDiagnostics = z.infer<typeof workerDiagnosticsSchema>;

/** A REST list row after the worker's mapping (02 §History reader). The Bot Chat never appears: the list omits hidden rows. */
export const sessionRowSchema = z
  .object({
    /** The listed id: a rotated chain lists its tip. */
    session_id: z.string(),
    /** `chat_id`, else (a legacy row) the session's own id. */
    lineage_root: z.string(),
    title: z.string().nullable(),
    source: z.string().nullable(),
    created_source: z.string().nullable(),
    hidden: z.boolean(),
    archived: z.boolean(),
    cwd: z.string().nullable(),
    message_count: z.number().int(),
    /** Unix ms. */
    last_activity_at: z.number().nullable(),
    /** Not gateway-owned yet (`chat_id` null, D16). */
    legacy: z.boolean(),
  })
  .strict();
export type SessionRow = z.infer<typeof sessionRowSchema>;

/**
 * One turn of a chat, root to tip, by 02 §Mapping db anchor rules: rows deduped by `message_uid` (first
 * wins), read with `include_compacted`; `steer` user rows and hidden reply rows are never anchors.
 */
export const historyTurnSchema = z
  .object({
    /** `message_uid` of the user row, else of the first reply row (a turn whose user row Hermes hides). */
    anchor_uid: z.string(),
    /** What Hermes' own view shows for the user row (`display_content` ?? `content`); null when hidden or absent. */
    user_text: z.string().nullable(),
    /** The user row is hidden (`display_kind: hidden`, e.g. a Conduit Pulse prompt): render the reply only. */
    user_hidden: z.boolean(),
    /** The surface the user row records, when Hermes records one; null otherwise. The server falls back to the binding's tag. */
    surface: z.string().nullable(),
    /** `display_metadata.submission_id`; `bb:` on bb's own submits (A4: not on steers or `/retry` rows). */
    submission_id: z.string().nullable(),
    /** Reply rows shown so far, in order (assistant and tool rows; hidden rows skipped). */
    reply_uids: z.array(z.string()),
    /** Unix ms of the anchor row. */
    ts: z.number(),
    /** A later turn exists, or the session isn't running: no more reply rows will join this one. */
    complete: z.boolean(),
  })
  .strict();
export type HistoryTurn = z.infer<typeof historyTurnSchema>;

export const botChatSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), lineage_root: z.string(), session_id: z.string(), legacy: z.boolean() }).strict(),
  /** No session titled `Bot Chat`: the bot thread stays `pending` until the first send creates it (S8 step 2). */
  z.object({ state: z.literal("none") }).strict(),
  /** `runtime_coordination_required`: Conduit holds a Bot Chat the gateway hasn't adopted (S8 E6). Retry later. */
  z.object({ state: z.literal("held") }).strict(),
]);
export type BotChat = z.infer<typeof botChatSchema>;

export const botAccessSchema = z
  .object({
    /** `foreign`: the dir exists without our marker; left untouched. */
    skill: z.enum(["written", "current", "removed", "absent", "foreign"]),
    /** `kept`: off, but another bot is still on. */
    wrapper: z.enum(["written", "current", "removed", "kept", "absent"]),
    /** `hermes -p <profile> sessions refresh-prompts` ran and exited 0 (A43, A45). */
    refreshed: z.boolean(),
    /** A bounded code when something failed (`refresh_failed:<exit>`, `bb_not_found`…). */
    detail: z.string().nullable(),
  })
  .strict();
export type BotAccess = z.infer<typeof botAccessSchema>;

export const hostContract = defineRpcContract({
  /**
   * Idempotent; also the 60 s keep-alive (an idle worker dies at 300 s with no exit event, S7 §6).
   * `enabled_bots`: profile homes of the enabled bots. The worker watches them (hint + WAL stat), prewarms
   * their models and writes `bridge-data/enabled.json` for bridges (`bridge-files.ts`).
   */
  ensureWatch: {
    input: z.object({ root: folderSchema, enabled_bots: z.array(profileHome) }).strict(),
    output: ensureWatchOutputSchema,
    experimental_retryable: true,
  },
  describe: {
    input: z.object({ root: folderSchema }).strict(),
    output: z.object({ uid: z.number().int(), profiles: z.array(profileSchema) }).strict(),
    experimental_retryable: true,
  },
  diagnostics: {
    input: z.null(),
    output: workerDiagnosticsSchema,
    experimental_retryable: true,
  },
  /** The bot's `model.options`, normalized; also written to `bridge-data/models/` as the last-known list. */
  models: {
    input: z.object({ root: folderSchema, profile_home: profileHome }).strict(),
    output: catalogSchema,
    experimental_retryable: true,
  },
  /** REST list rows (every page) active since `since` (Unix ms), archived included. */
  listSessions: {
    input: z.object({ root: folderSchema, profile_home: profileHome, since: z.number().optional() }).strict(),
    output: z.object({ sessions: z.array(sessionRowSchema) }).strict(),
    experimental_retryable: true,
  },
  /**
   * A chat's turns, root to tip. `after_uid`: only turns after that anchor (unknown anchor → every turn).
   * `since` (Unix ms): only turns from then on. `truncated`: older turns exist that this answer leaves out.
   */
  readTurns: {
    input: z
      .object({ root: folderSchema, profile_home: profileHome, lineage_root: z.string().min(1), after_uid: z.string().optional(), since: z.number().optional() })
      .strict(),
    output: z.object({ session_id: z.string(), turns: z.array(historyTurnSchema), truncated: z.boolean() }).strict(),
    experimental_retryable: true,
  },
  /** `session.list{title:"Bot Chat", include_hidden:true}` (S8 step 1). Read-only. */
  findBotChat: {
    input: z.object({ root: folderSchema, profile_home: profileHome }).strict(),
    output: botChatSchema,
    experimental_retryable: true,
  },
  /**
   * Writes (on) or deletes (off) the bot's skill and the shared wrapper, then refreshes that profile's
   * prompts (flow 1). `enabled_bots`: every bot on after this change; the wrapper goes when it is empty.
   */
  setBotAccess: {
    input: z.object({ root: folderSchema, profile_home: profileHome, on: z.boolean(), enabled_bots: z.array(profileHome) }).strict(),
    output: botAccessSchema,
  },
});
export type HostContract = typeof hostContract;

export const hostSignals = {
  /** Something changed in these profiles' chats (debounced). A hint only: the server re-lists. */
  changed: { payload: z.object({ profile_homes: z.array(z.string()) }).strict() },
  watch: {
    payload: z
      .object({ state: z.enum(["connected", "disconnected"]), worker_boot_id: z.string(), instance_id: z.string().nullable() })
      .strict(),
  },
} satisfies ExperimentalHostSignals;
