// Tests only: a fake bb (threads, projects, push-notifications) and a fake host worker (describe,
// findBotChat, readTurns, setBotAccess) around `createFakePluginHost`, for the server's P1 tests.
import { createFakePluginHost, type ExperimentalFakeHostRpcCall, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { vi } from "vitest";
import type { z } from "zod";
import { EXTENSION_KINDS, type persistedTurnStateSchema } from "../shared/extension-state.js";
import type { BotChat, EnsureWatchOutput, HermesProfile, HistoryTurn, SessionRow } from "../shared/host-contract.js";
import { decodeMarker, type Marker } from "../shared/marker.js";
import { settingsDescriptors } from "../shared/settings.js";
import { bindingByThread, openMappingDb, setKv } from "./db.js";
import { startServer, WAKE_DEBOUNCE_MS } from "./index.js";
import { SETTLE_QUIET_MS } from "./sync.js";

export const MACHINE = "host_hermes";
export const NEO = "/h/profiles/neo";
export const BOB = "/h/profiles/bob";
export const UID = 501;

type Status = "idle" | "active" | "error";

export interface FakeThread {
  id: string;
  title: string | null;
  status: Status;
  archivedAt: number | null;
  deletedAt: number | null;
  pinned: boolean;
  queued: number;
  /** bb's read state: unread while `lastReadAt < latestAttentionAt`; a root thread's turn end moves `latestAttentionAt`. */
  lastReadAt: number | null;
  latestAttentionAt: number;
  visibility: "visible" | "hidden";
  originPluginId: string | null;
  spawn: Record<string, unknown> | null;
  /** Every input bb got: the spawn's, then each send's. */
  inputs: PromptInput[][];
}

export interface WorldOptions {
  profiles?: HermesProfile[];
  /** Seeds the mapping db before the server starts (a previous run). */
  seed?: (db: ReturnType<typeof openMappingDb>) => void;
}

const neo: HermesProfile = { name: "neo", home: NEO, handle: null, terminal_cwd: "/w/neo", served: true };
const bob: HermesProfile = { name: "bob", home: BOB, handle: null, terminal_cwd: null, served: false };

/** A REST list row of a chat (`last_activity_at`: a day ago unless given). */
export function session(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: id,
    lineage_root: id,
    title: `Chat ${id}`,
    source: "local",
    created_source: "cli",
    hidden: false,
    archived: false,
    cwd: null,
    message_count: 2,
    last_activity_at: Date.now() - 86_400_000,
    legacy: false,
    ...over,
  };
}

export function turn(anchor: string, over: Partial<HistoryTurn> = {}): HistoryTurn {
  return { anchor_uid: anchor, user_text: `text ${anchor}`, user_hidden: false, submission_id: null, reply_uids: [`${anchor}-r`], ts: Date.now() - 86_400_000, complete: true, ...over };
}

export async function world({ profiles = [neo, bob], seed }: WorldOptions = {}) {
  const threads = new Map<string, FakeThread>();
  const events = new Map<string, { type: string; data: unknown; seq: number }[]>();
  const prompts = new Map<string, { createdAt: number; id: string; input: PromptInput[] }[]>();
  const levels = new Map<string, string>();
  const levelCalls: { threadId: string; level: string }[] = [];
  /** Inputs the fake bridge has rendered, per thread (`render`). */
  const rendered = new Map<string, number>();
  /** bb's pending interaction cards (provider ones carry `origin.providerRequestId`). */
  const cards: { threadId: string; id: string; status: string; origin: { kind: string; providerRequestId?: string } }[] = [];
  /** Hermes chats by lineage root. */
  /** `pageSize`: an `after_uid` read returns at most this many turns, oldest first, `truncated` when more follow. */
  const history = new Map<string, { session_id: string; turns: HistoryTurn[]; truncated?: boolean; pageSize?: number }>();
  const botChats = new Map<string, BotChat>();
  /** REST list rows per profile home (`listSessions`). */
  const sessions = new Map<string, SessionRow[]>();
  const access: { profile_home: string; on: boolean; enabled_bots: string[] }[] = [];
  /** `root`: the folder these profiles live in. `outside`: the worker refuses every profile as outside the root. */
  const state = { root: "~/.hermes", outside: false, failSpawn: 0, watched: [] as string[], failSend: 0, failAccess: false, refreshed: true, online: true, boot: "boot_1", supported: true, seq: 0, ids: 0, clock: 1_000, unreadable: [] as string[], lateAttention: false };

  const thread = (id: string) => {
    const t = threads.get(id);
    if (!t || t.deletedAt) throw new Error("HTTP 404: thread not found");
    return t;
  };
  const dto = (t: FakeThread) =>
    makeThreadResponse({
      id: t.id,
      providerId: "hermes",
      title: t.title,
      status: t.status,
      archivedAt: t.archivedAt,
      deletedAt: t.deletedAt,
      pinnedAt: t.pinned ? 1 : null,
      queuedMessageCount: t.queued,
      lastReadAt: t.lastReadAt,
      latestAttentionAt: t.latestAttentionAt,
      visibility: t.visibility,
      originPluginId: t.originPluginId,
    });

  const answer = (): EnsureWatchOutput => ({ worker_boot_id: state.boot, connected: true, instance_id: "inst_fake", version: "0.9.0", supported: state.supported, detail: state.supported ? null : "missing:1" });

  function hostCall(call: ExperimentalFakeHostRpcCall): unknown {
    const input = call.input as { root: string; profile_home: string; on: boolean; enabled_bots: string[]; lineage_root: string; after_uid?: string; since?: number };
    switch (call.method) {
      case "ensureWatch":
        state.watched = input.enabled_bots;
        return answer();
      case "describe":
        // Profiles of the folder the call names: another folder has none of these.
        return { uid: UID, profiles: input.root === state.root ? profiles : [] };
      case "setBotAccess":
        if (state.failAccess) throw Object.assign(new Error("offline"), { code: "host_offline" });
        if (input.root !== state.root || state.outside) {
          access.push({ profile_home: input.profile_home, on: input.on, enabled_bots: input.enabled_bots });
          return { skill: "absent", wrapper: "absent", refreshed: false, detail: "profile_outside_root" };
        }
        access.push({ profile_home: input.profile_home, on: input.on, enabled_bots: input.enabled_bots });
        return { skill: input.on ? "written" : "removed", wrapper: "written", refreshed: state.refreshed, detail: state.refreshed ? null : "refresh_failed:1" };
      case "listSessions": {
        const since = input.since;
        return { sessions: (sessions.get(input.profile_home) ?? []).filter((r) => since === undefined || (r.last_activity_at ?? -1) >= since) };
      }
      case "firstSubmissions": {
        // The first user row's submission_id; a chat it can't read is left out.
        const { lineage_roots } = call.input as { lineage_roots: string[] };
        const readable = lineage_roots.filter((r) => history.has(r) && !state.unreadable.includes(r));
        return { submissions: Object.fromEntries(readable.map((r) => [r, history.get(r)!.turns.find((t) => !t.user_hidden)?.submission_id ?? null])) };
      }
      case "findBotChat":
        return botChats.get(input.profile_home) ?? { state: "none" };
      case "readTurns": {
        const chat = history.get(input.lineage_root);
        if (!chat) throw Object.assign(new Error("not found"), { code: "not_found" });
        let turns = chat.turns;
        const after = input.after_uid;
        const at = after ? turns.findIndex((t) => t.anchor_uid === after) : -1;
        if (at >= 0) turns = turns.slice(at + 1);
        const since = input.since;
        const all = turns.length;
        if (since !== undefined) turns = turns.filter((t) => t.ts >= since);
        if (chat.pageSize !== undefined && after !== undefined && turns.length > chat.pageSize)
          return { session_id: chat.session_id, turns: turns.slice(0, chat.pageSize), truncated: true };
        // As the worker: `since` leaving older turns out is `truncated`.
        return { session_id: chat.session_id, turns, truncated: chat.truncated ?? turns.length < all };
      }
      default:
        throw new Error(`unexpected host call ${call.method}`);
    }
  }

  const fake = createFakePluginHost({
    pluginId: "hermes",
    experimental_callHostRpc: hostCall,
    sdk: {
      hosts: { list: async () => [makeHostResponse({ id: MACHINE, name: "hermes-mac", status: state.online ? "connected" : "disconnected" })] },
      projects: { list: async () => [{ id: "proj_personal", kind: "personal" }] },
      plugins: {
        callRpc: async ({ method, input }) => {
          const { threadId, threadIds, level } = input as { threadId: string; threadIds: string[]; level: string };
          if (method === "threadNotifications.list")
            return { threads: Object.fromEntries(threadIds.map((id) => [id, { own: levels.get(id) ?? "inherit", ancestorCap: null }])) };
          levels.set(threadId, level);
          levelCalls.push({ threadId, level });
          return { own: level, ancestorCap: null };
        },
      },
      threads: {
        spawn: async (args) => {
          const a = args as unknown as Record<string, unknown>;
          // bb fills the model catalog at spawn; the bridge lists only bots in worker.json (ensureWatch's enabled_bots).
          const home = profiles.find((p) => p.name === (a.sessionOptions as { profile?: string } | undefined)?.profile)?.home;
          if (state.failSpawn > 0 || !home || !state.watched.includes(home)) {
            state.failSpawn = Math.max(0, state.failSpawn - 1);
            throw Object.assign(new Error("HTTP 503: The hermes model catalog is empty"), { code: "model_catalog_unavailable" });
          }
          const id = `thr_${++state.ids}`;
          threads.set(id, {
            id,
            title: (a.title as string) ?? null,
            status: "idle",
            archivedAt: null,
            deletedAt: null,
            pinned: a.pinned === true,
            queued: 0,
            lastReadAt: null,
            latestAttentionAt: ++state.clock,
            visibility: a.visibility === "hidden" ? "hidden" : "visible",
            originPluginId: "hermes",
            spawn: a,
            inputs: [a.input as PromptInput[]],
          });
          return dto(threads.get(id)!);
        },
        send: async ({ threadId, input }) => {
          if (state.failSend > 0) {
            state.failSend--;
            throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
          }
          // bb 0.49.0 `ensureThreadIsWritable`: an archived thread takes no send.
          if (thread(threadId).archivedAt !== null) throw Object.assign(new Error("HTTP 409: Thread is archived"), { code: "thread_not_writable" });
          thread(threadId).inputs.push(input as PromptInput[]);
          return { ok: true, delivery: "sent" };
        },
        get: async ({ threadId }) => dto(thread(threadId)),
        list: async (args) => (args?.threadIds ?? []).flatMap((id: string) => (threads.get(id) ? [dto(threads.get(id)!)] : [])),
        archive: async ({ threadId }) => ((thread(threadId).archivedAt = 1), dto(thread(threadId))),
        unarchive: async ({ threadId }) => ((thread(threadId).archivedAt = null), dto(thread(threadId))),
        stop: async ({ threadId }) => {
          // `lateAttention`: bb moves `latestAttentionAt` just after the stop answers (e2e: 11 ms after the markRead).
          if (state.lateAttention) setImmediate(() => (thread(threadId).latestAttentionAt = ++state.clock));
          return dto(thread(threadId));
        },
        markRead: async ({ threadId }) => ((thread(threadId).lastReadAt = ++state.clock), dto(thread(threadId))),
        update: async ({ threadId, title, visibility }) => {
          if (title !== undefined) thread(threadId).title = title ?? null;
          if (visibility !== undefined) thread(threadId).visibility = visibility;
          return dto(thread(threadId));
        },
        delete: async ({ threadId }) => {
          thread(threadId).deletedAt = ++state.clock;
          // bb announces it after the delete answers.
          setImmediate(() => void fake.harness.behavior.emitThreadEvent("thread.deleted", { thread: dto(threads.get(threadId)!) } as never));
          return { ok: true };
        },
        promptHistory: async ({ threadId }) => prompts.get(threadId) ?? [],
        getPluginMetadata: async () => ({ metadata: {} }),
        events: {
          list: async ({ threadId, types, order, limit, beforeSeq }) => {
            const rows = (events.get(threadId) ?? []).filter(
              (e) => (!types || (types as readonly string[]).includes(e.type)) && (beforeSeq === undefined || e.seq < Number(beforeSeq)),
            );
            const out = rows.map((e) => ({ id: `ev_${e.seq}`, scope: { kind: "thread" }, threadId, seq: e.seq, createdAt: e.seq, type: e.type, data: e.data }));
            const ordered = order === "desc" ? out.reverse() : out;
            return limit ? ordered.slice(0, Number(limit)) : ordered;
          },
        },
        queuedMessages: { list: async () => ({ messages: [] }) },
        interactions: {
          // No `cancel`: bb 0.49.0 refuses it for provider cards, and the server never calls it. A stop
          // leaves the cards as they are here, so a repeat is visible.
          list: async ({ threadId }) => cards.filter((c) => c.threadId === threadId).map(({ threadId: _, ...c }) => c),
        },
      },
    },
  });

  seed?.(openMappingDb(fake.bb));
  setKv(openMappingDb(fake.bb), "machine", MACHINE);
  const settings = fake.bb.settings.define(settingsDescriptors);
  await startServer(fake.bb, settings);
  const { harness } = fake;
  const db = openMappingDb(fake.bb);

  /** Lets queued jobs and fire-and-forget handlers run (every fake answers at once). */
  async function flush(rounds = 20) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  const rpc = async <T>(method: string, input: unknown = null) => {
    const out = (await harness.behavior.callRpc(method, input)) as T;
    await flush();
    return out;
  };

  /** A thread's marker inputs, in order (`spawnStart()`'s empty part is none). */
  const markers = (threadId: string): Marker[] =>
    thread(threadId).inputs.flatMap((input) => input.flatMap((p) => (p.type === "text" && p.visibility === "agent-only" ? [decodeMarker(p.text)].filter((m) => m !== null) : [])));
  /** Waits `ms` on the clock the test runs: fake timers advance, real ones elapse. */
  const elapse = async (ms: number) => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
    await flush();
  };
  /** A thread's visible text parts, in order. */
  const texts = (threadId: string): string[] =>
    thread(threadId).inputs.flatMap((input) => input.flatMap((p) => (p.type === "text" && p.visibility !== "agent-only" ? [p.text] : [])));

  return {
    ...fake,
    db,
    state,
    threads,
    history,
    botChats,
    sessions,
    access,
    levels,
    levelCalls,
    cards,
    prompts,
    rpc,
    flush,
    elapse,
    /** bb stayed quiet long enough for an init or import to be confirmed over. */
    quiet: () => elapse(SETTLE_QUIET_MS + 10),
    markers,
    texts,
    hostCalls: (method: string) => harness.inspection.experimental_hostRpcCalls.filter((c) => c.method === method),
    connect: () => rpc("setConnection", { machine: MACHINE }),
    /** bb ran every queued turn of a thread: a turn ended (a root thread needs attention), `thread.idle` with an empty queue. */
    async idle(threadId: string) {
      const t = thread(threadId);
      t.status = "idle";
      t.queued = 0;
      t.latestAttentionAt = ++state.clock;
      await harness.behavior.emitThreadEvent("thread.idle", { thread: dto(t), lastAssistantText: null });
      await flush();
    },
    async active(threadId: string) {
      thread(threadId).status = "active";
      await harness.behavior.emitThreadEvent("thread.active", { thread: dto(thread(threadId)) });
      await flush();
    },
    /** The worker's `changed` signal, past the debounce. */
    async changed(...homes: string[]) {
      await harness.behavior.experimental_emitHostSignal(MACHINE, "changed", { profile_homes: homes });
      await elapse(WAKE_DEBOUNCE_MS + 100);
    },
    /** The bridge published `persisted-turn` for this thread. */
    persisted(threadId: string, payload: z.input<typeof persistedTurnStateSchema>) {
      const list = events.get(threadId) ?? [];
      list.push({ type: "thread/extensionState/updated", seq: ++state.seq, data: { kind: `hermes/${EXTENSION_KINDS.persistedTurn}`, payload, providerThreadId: "p" } });
      events.set(threadId, list);
    },
    /**
     * The bridge rendered every mirror and import marker sent since its last render: `persisted-turn.mirrored`
     * records (cumulative), the reply rows Hermes has, `partial` while the turn runs.
     */
    render(threadId: string) {
      const binding = bindingByThread(db, threadId)!;
      const t = thread(threadId);
      const markersSince = t.inputs.slice(rendered.get(threadId) ?? 0).flatMap((input) =>
        input.flatMap((p) => (p.type === "text" && p.visibility === "agent-only" ? [decodeMarker(p.text)].filter((m) => m !== null && m.op !== "init") : [])),
      ) as Exclude<Marker, { op: "init" }>[];
      rendered.set(threadId, t.inputs.length);
      const last = [...(events.get(threadId) ?? [])].reverse().find((e) => (e.data as { kind?: string }).kind === `hermes/${EXTENSION_KINDS.persistedTurn}`);
      const prev = (last?.data as { payload?: z.input<typeof persistedTurnStateSchema> } | undefined)?.payload;
      const chat = history.get(binding.lineage_root!);
      const mirrored = markersSince.map((m) => {
        const h = chat?.turns.find((x) => x.anchor_uid === m.anchor_uid);
        return { anchor_uid: m.anchor_uid, reply_uids: h?.complete ? h.reply_uids : [], partial: !h?.complete, at: ++state.clock };
      });
      this.persisted(threadId, {
        profile_home: binding.profile_home,
        lineage_root: binding.lineage_root!,
        session_id: chat?.session_id ?? binding.lineage_root!,
        turns: prev?.turns ?? [],
        mirrored: [...(prev?.mirrored ?? []), ...mirrored],
      });
    },
    /** The bridge published `status` for this thread. */
    status(threadId: string, payload: unknown) {
      const list = events.get(threadId) ?? [];
      list.push({ type: "thread/extensionState/updated", seq: ++state.seq, data: { kind: `hermes/${EXTENSION_KINDS.status}`, payload, providerThreadId: "p" } });
      events.set(threadId, list);
    },
    /** A recorded bb event of this thread (e.g. `client/thread/start`). */
    event(threadId: string, type: string, data: unknown) {
      const list = events.get(threadId) ?? [];
      list.push({ type, seq: ++state.seq, data });
      events.set(threadId, list);
    },
    async emit<E extends Parameters<typeof harness.behavior.emitThreadEvent>[0]>(event: E, threadId: string) {
      await harness.behavior.emitThreadEvent(event, { thread: dto(threads.get(threadId)!) } as never);
      await flush();
    },
    dto: (id: string) => dto(thread(id)),
    thread,
  };
}

export type World = Awaited<ReturnType<typeof world>>;
