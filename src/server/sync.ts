// Import, wakes and bb's own turns (02 flows 5, 6, 9; §Mapping db wake atomicity). Everything that sends
// into a thread runs on one serial queue (02 §Invariants); a bb turn's end (`thread.idle`) settles what
// it showed. Hermes I/O only through the worker; no transcript text is stored.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { EXTENSION_KINDS, PERSISTED_TURNS_KEPT, persistedTurnStateSchema, type PersistedTurnState, statusStateSchema } from "../shared/extension-state.js";
import type { HistoryTurn } from "../shared/host-contract.js";
import { encodeMarker, type Marker } from "../shared/marker.js";
import { THREAD_INFO_TAG } from "../shared/rpc-contract.js";
import { outsideTag } from "../shared/sources.js";
import { type Connection, errorCode, type HostClient } from "./connection.js";
import {
  addTombstone,
  bindingByLineage,
  bindingByThread,
  type Binding,
  botRecord,
  claimRest,
  claimTurn,
  type Db,
  deleteBinding,
  getKv,
  hasTurns,
  insertBinding,
  queuedTurns,
  queuedTurnsOf,
  recordBbTurn,
  releaseTurn,
  settleTurn,
  turnRow,
  updateBinding,
} from "./db.js";
import type { Notify } from "./notify.js";

export const IMPORT_WINDOW_MS = 30 * 86_400_000;
/**
 * An init or import is over only once bb stays quiet this long after an idle finalize: bb can report a thread idle
 * with nothing queued while it still dispatches the last queued turn, whose own idle then moves `latestAttentionAt`
 * past the `markRead` (P1 live dogfood).
 */
export const SETTLE_QUIET_MS = 3_000;
/** Rest wakes for a turn whose render failed, before it settles as Hermes shows it. */
export const MAX_RENDER_RETRIES = 3;
/** A chat Hermes no longer has (its thread stays, 01 §7) is read again at most this often, this process. */
export const MISSING_RECHECK_MS = 30 * 60_000;
/** Pages of a truncated wake read before the rest waits for the next reconcile. */
const MAX_TURN_PAGES = 20;

/** 02 identity rules: the session id bb's first send will create, known before it exists (S0-S4 §S4b). */
export const expectedId = (profileHome: string, uid: number, threadId: string) =>
  `local-${createHash("sha256").update(JSON.stringify([profileHome, `uid:${uid}`, `bb:${threadId}`])).digest("hex")}`;

/** `threadInfo` reads refresh: a binding came or went, or its kind, label or switch changed. */
export const invalidateThreadInfo = (bb: BbPluginApi) => bb.rpc.experimental_invalidate([THREAD_INFO_TAG]);

/** Where Hermes I/O goes now; null while not connected (no Hermes I/O, R3 M3). */
export interface Target {
  machine: string;
  root: string;
}

export function targetOf(connection: Connection): Target | null {
  const health = connection.health();
  if (!health.machine?.online || (health.state !== "connected" && health.state !== "not_supported")) return null;
  return { machine: health.machine.id, root: health.folder };
}

/** Jobs run one at a time, in order. A job must never wait for another job: that would deadlock. */
export function createQueue(onError: (error: unknown) => void) {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job);
    tail = run.catch(onError);
    return run;
  };
}
export type Enqueue = ReturnType<typeof createQueue>;

export interface SyncDeps {
  bb: BbPluginApi;
  db: Db;
  host: HostClient;
  connection: Connection;
  notify: Notify;
}

const text = (value: string): PromptInput => ({ type: "text", mentions: [], text: value });
const isBbSubmission = (turn: HistoryTurn) => turn.submission_id?.startsWith("bb:") === true;
/**
 * The visible user bubble before a marker; none for a hidden user row (01 §7). bb's own turns are untagged;
 * every other one reads `[Outside bb]`: Hermes records no per-turn source, so bb never names an app.
 */
function label(turn: HistoryTurn, imported: boolean): PromptInput[] {
  if (turn.user_hidden || turn.user_text === null) return [];
  if (isBbSubmission(turn)) return [text(turn.user_text)];
  return [text(outsideTag(imported ? new Date(turn.ts) : undefined) + turn.user_text)];
}

/** A turn's input: its label, then the marker, `labeled` when a label is there, so the bridge never submits it. */
function turnInput(turn: HistoryTurn, imported: boolean, marker: Exclude<Marker, { op: "init" }>): PromptInput[] {
  const visible = label(turn, imported);
  return [...visible, encodeMarker(visible.length ? { ...marker, labeled: true } : marker)];
}

const hasNew = (now: string[], shown: string[]) => now.some((uid) => !shown.includes(uid));

export function createSync({ bb, db, host, connection, notify, enqueue }: SyncDeps & { enqueue: Enqueue }) {
  /** Threads running a turn (`thread.active` … `thread.idle`): wakes wait for idle (bb's own turn may not be recorded yet). */
  const active = new Set<string>();
  /**
   * Threads whose init or import must end read: `markRead` at each idle finalize, cleared (and the notification
   * hold released) only once a quiet re-read confirms the thread read and over. A wake into it clears it: outside
   * activity is unread (01 §8).
   */
  const readAtIdle = new Set<string>();
  const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Threads confirmed read, re-checked a bounded number of times after `SETTLE_QUIET_MS`: bb can move
   * `latestAttentionAt` just after the last step (e2e: an import's end, 11 ms after its `markRead`).
   */
  const readCheck = new Map<string, number>();
  const READ_CHECKS = 2;
  const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Jobs still queued at dispose arm no timer (review 14). */
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
    [...confirmTimers.values(), ...readTimers.values()].forEach(clearTimeout);
  });
  /** Imports that haven't sent every turn yet: they stay `replaying` at idle and resume at the next reconcile. */
  const unfinished = new Set<string>();
  /**
   * Mirrored chats this server process is importing (hidden threads, flow 5): `replaying` until the import is
   * confirmed over, then `onImportOver` shows them. A `replaying` mirror binding not in here was interrupted.
   */
  const importing = new Map<string, { archived: boolean; cutoff: number }>();
  /**
   * Per `threadId \0 anchor`: renders that ended with no bridge record, this process. A render that keeps failing
   * gets `MAX_RENDER_RETRIES` rest wakes, never a bb turn every few seconds.
   */
  const renderFailures = new Map<string, number>();
  /** Per thread: the bridge's `mirrored` records as last read, its newest `PERSISTED_TURNS_KEPT` (review-2 1). */
  const lastMirrored = new Map<string, PersistedTurnState["mirrored"]>();
  /**
   * Threads whose chat Hermes answers 404 (deleted there; bb's sends fail "Deleted in Hermes", 01 §7): a known
   * state, not an error at every reconcile. Thread id → when it was last read.
   */
  const missing = new Map<string, number>();
  /** Threads the server deleted itself (an import redo, a failed init): their late jobs and events end silently. */
  const gone = new Set<string>();
  let onImportOver: (threadId: string) => Promise<void> = async () => {};
  const persistedKind = `${bb.pluginId}/${EXTENSION_KINDS.persistedTurn}`;
  const statusKind = `${bb.pluginId}/${EXTENSION_KINDS.status}`;
  /** `threadId \0 requestId` of dead cards already handled (memory: one stop per dead card set). */
  const handledDead = new Set<string>();
  const fail = (code: string) => connection.recordError(code);
  const paused = () => connection.health().state === "not_supported";

  async function send(threadId: string, input: PromptInput[]): Promise<void> {
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input });
  }

  /**
   * A plugin spawn's marker, sent after `insertBinding` (the spawn input is `spawnStart()`, so bb's `titleFallback`
   * is never a marker). A failed send takes the thread back (binding first: no tombstone), so a retry spawns again.
   */
  async function sendInit(threadId: string, init: Extract<Marker, { op: "init" }>): Promise<void> {
    try {
      await send(threadId, [encodeMarker(init)]);
    } catch (error) {
      gone.add(threadId);
      deleteBinding(db, threadId);
      readAtIdle.delete(threadId);
      notify.release(threadId);
      invalidateThreadInfo(bb);
      await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: true }).catch(() => fail("spawn_cleanup_failed"));
      throw error;
    }
  }

  /** Claims, then sends; a failed send releases the claim (R1 M1). False on failure. */
  async function sendClaimed(binding: Binding, anchorUid: string, input: PromptInput[], level: "muted" | "input-only"): Promise<boolean> {
    await notify.hold(binding.thread_id, level);
    try {
      await send(binding.thread_id, input);
      return true;
    } catch (error) {
      releaseTurn(db, binding.thread_id, anchorUid);
      // Nothing to run quietly any more, unless an init, an import or a wake sent before still holds it (review-2 10).
      const holds = readAtIdle.has(binding.thread_id) || importing.has(binding.thread_id) || queuedTurnsOf(db, binding.thread_id).length > 0;
      if (level === "input-only" && !holds) notify.release(binding.thread_id);
      // bb takes no send into an archived thread (A49): not an error; `thread.unarchived` wakes it.
      const archived = await bb.sdk.threads.get({ threadId: binding.thread_id }).then((t) => t.archivedAt !== null, () => false);
      if (!archived) fail(errorCode(error, "send_failed"));
      return false;
    }
  }

  /** The anchor every turn up to which (in `turns`) is complete and shown; turns after it are read again. */
  function advanceCursor(binding: Binding, turns: HistoryTurn[]): void {
    let cursor = binding.cursor_uid;
    for (const turn of turns) {
      const row = turnRow(db, binding.thread_id, turn.anchor_uid);
      if (!turn.complete || !row || row.state !== "done") break;
      cursor = turn.anchor_uid;
    }
    if (cursor !== binding.cursor_uid) updateBinding(db, binding.thread_id, { cursor_uid: cursor });
  }

  /**
   * The turns an import shows: those since `since`, `truncated` when older ones stay in Hermes. A mirrored chat
   * with no turn since then (its listed activity is a turn that spans the window's start) shows its newest turn alone.
   */
  async function readImportTurns(profileHome: string, lineageRoot: string, since: number, target: Target, newestAlone: boolean) {
    const read = await host.call("readTurns", { root: target.root, profile_home: profileHome, lineage_root: lineageRoot, since }, { hostId: target.machine });
    if (read.turns.length || !read.truncated || !newestAlone) return read;
    const all = await host.call("readTurns", { root: target.root, profile_home: profileHome, lineage_root: lineageRoot }, { hostId: target.machine });
    return { session_id: all.session_id, turns: all.turns.slice(-1), truncated: all.turns.length > 1 || all.truncated };
  }

  /**
   * Flow 5 for a `replaying` binding (the bot thread, or a mirrored chat's hidden thread): turns since
   * `enabled_at − 30 d`, oldest first; the first carries `bind` (with `since` when older turns stay in Hermes),
   * the rest `replay`. Resumable: turns already in `turns` are skipped, so an interrupted import continues
   * (flow 9). `read`: the turns the caller already read. Returns the number of turns sent.
   * A turn after the cutoff is news, not history: it wakes as an outside turn once the thread is live (unread,
   * `[Outside bb]`). The bot thread's cutoff is `enabled_at`; a mirrored chat's, its discovery pass's start when it
   * ends read, else none.
   */
  async function importNow(binding: Binding, enabledAt: number, target: Target, read?: Awaited<ReturnType<typeof readImportTurns>>): Promise<number> {
    if (paused() || !binding.lineage_root) return 0;
    unfinished.add(binding.thread_id);
    const since = enabledAt - IMPORT_WINDOW_MS;
    const mirror = binding.kind === "mirror";
    read ??= await readImportTurns(binding.profile_home, binding.lineage_root, since, target, mirror);
    if (read.session_id !== binding.session_id) updateBinding(db, binding.thread_id, { session_id: read.session_id });
    let bound = hasTurns(db, binding.thread_id, "replay");
    let sent = 0;
    const cutoff = mirror ? (importing.get(binding.thread_id)?.cutoff ?? Infinity) : enabledAt;
    for (const turn of read.turns) {
      if (turn.ts > cutoff) break;
      if (turnRow(db, binding.thread_id, turn.anchor_uid)) continue;
      if (!claimTurn(db, { thread_id: binding.thread_id, anchor_uid: turn.anchor_uid, kind: "replay", at: turn.ts, reply_uids: turn.reply_uids })) continue;
      const marker: Exclude<Marker, { op: "init" }> = bound
        ? { op: "replay", anchor_uid: turn.anchor_uid }
        : {
            op: "bind",
            profile_home: binding.profile_home,
            lineage_root: binding.lineage_root,
            legacy: binding.legacy,
            anchor_uid: turn.anchor_uid,
            ...(read.truncated ? { since } : {}),
          };
      // A mirrored chat's import decided at its start whether it ends read (01 §8).
      if (!mirror) readAtIdle.add(binding.thread_id);
      if (!(await sendClaimed(binding, turn.anchor_uid, turnInput(turn, true, marker), "muted"))) {
        // A mirrored chat's import frees its slot at once; the next reconcile redoes it.
        if (mirror) importing.delete(binding.thread_id);
        return sent;
      }
      bound = true;
      sent++;
    }
    unfinished.delete(binding.thread_id);
    // The cursor passes imported turns only once the bridge's records settle them (`advanceCursor`). A mirrored
    // chat goes live only once its import is confirmed over (`onImportOver`).
    if (!mirror && !queuedTurnsOf(db, binding.thread_id).length) updateBinding(db, binding.thread_id, { state: "live" });
    return sent;
  }

  /**
   * Flow 6 for one `live` binding of an enabled bot: anchors not in `turns` and not bb's wake as
   * `mirror`; a shown, now complete turn with new reply rows wakes as `mirror{rest:true}`. `settle`: the
   * thread just went idle (a running bb turn no longer holds wakes back).
   */
  async function reconcileNow(binding: Binding, target: Target, { settle = false } = {}): Promise<void> {
    if (binding.state !== "live" || !binding.lineage_root) return;
    if ((!settle && active.has(binding.thread_id)) || paused()) return;
    const missingSince = missing.get(binding.thread_id);
    if (missingSince !== undefined && Date.now() - missingSince < MISSING_RECHECK_MS) return;
    let read: Awaited<ReturnType<typeof readAfter>>;
    try {
      read = await readAfter(binding, target);
    } catch (error) {
      if (!errorCode(error, "").startsWith("history_http_404")) throw error;
      missing.set(binding.thread_id, Date.now());
      return;
    }
    missing.delete(binding.thread_id);
    if (read.session_id !== binding.session_id) updateBinding(db, binding.thread_id, { session_id: read.session_id });
    for (const turn of read.turns) {
      const row = turnRow(db, binding.thread_id, turn.anchor_uid);
      if (!row) {
        // bb's own submit: never a wake (the `persisted-turn` record covers rows without `bb:`).
        if (isBbSubmission(turn)) {
          recordBbTurn(db, binding.thread_id, turn.anchor_uid, turn.reply_uids, turn.ts);
          continue;
        }
        if (!claimTurn(db, { thread_id: binding.thread_id, anchor_uid: turn.anchor_uid, kind: "mirror", at: turn.ts, reply_uids: turn.reply_uids })) continue;
        // Outside activity is unread: an init or import still settling no longer ends read, nor muted.
        dropReadFlag(binding.thread_id);
        const input = turnInput(turn, false, { op: "mirror", anchor_uid: turn.anchor_uid });
        // Keep Hermes' order: stop at a failed send; the next re-list retries from there.
        if (!(await sendClaimed(binding, turn.anchor_uid, input, "input-only"))) break;
      } else if (row.kind !== "bb" && row.state !== "queued" && turn.complete && hasNew(turn.reply_uids, row.reply_uids)) {
        // Only once the turn is over: a turn bb stopped watching shows its reply when done (01 §5).
        if (!claimRest(db, binding.thread_id, turn.anchor_uid, turn.reply_uids)) continue;
        if (!(await sendClaimed(binding, turn.anchor_uid, [encodeMarker({ op: "mirror", anchor_uid: turn.anchor_uid, rest: true })], "input-only"))) break;
      }
    }
    advanceCursor(bindingByThread(db, binding.thread_id) ?? binding, read.turns);
  }

  /**
   * Turns after the cursor, in pages: a `truncated` answer is read on from its last turn, so a long
   * outage wakes every turn in order and the cursor never passes a turn no page returned.
   */
  async function readAfter(binding: Binding, target: Target): Promise<{ session_id: string; turns: HistoryTurn[] }> {
    const turns: HistoryTurn[] = [];
    let after = binding.cursor_uid;
    // No cursor yet (nothing shown, or only a running turn): never older than the import window.
    const enabledAt = botRecord(db, binding.profile_home)?.enabled_at ?? Date.now();
    const window = after ? {} : { since: enabledAt - IMPORT_WINDOW_MS };
    for (let page = 1; ; page++) {
      const read = await host.call(
        "readTurns",
        { root: target.root, profile_home: binding.profile_home, lineage_root: binding.lineage_root!, ...(after ? { after_uid: after } : window) },
        { hostId: target.machine },
      );
      turns.push(...read.turns);
      // With `since`, `truncated` means older turns left out: nothing newer to read on.
      if (!after || !read.truncated || !read.turns.length || page === MAX_TURN_PAGES) return { session_id: read.session_id, turns };
      after = read.turns.at(-1)!.anchor_uid;
    }
  }

  /**
   * The bridge's `mirrored` records (mirror and replay turns; one per anchor, every reply row it showed) settle
   * queued rows with what was really shown, and `partial` when Conduit's reply comes later. At every ingest: the
   * bridge keeps only its newest `PERSISTED_TURNS_KEPT`, so a long import's oldest records age out before its idle
   * (review-2 1). A never-rendered anchor's record is its render; a rest claim settles only from a record that covers
   * its reply rows (an earlier render's record isn't this one, review-2 2). A row with no such record stays queued:
   * its turn may not have run yet (bb's dispatch gap), or its render failed (`confirmNow` settles it then).
   */
  function settleMirrored(threadId: string, state: PersistedTurnState): void {
    lastMirrored.set(threadId, state.mirrored);
    const newest = new Map(state.mirrored.map((m) => [m.anchor_uid, m]));
    for (const row of queuedTurnsOf(db, threadId)) {
      const record = row.kind !== "bb" ? newest.get(row.anchor_uid) : undefined;
      if (!record || (row.prev_state && !row.reply_uids.every((uid) => record.reply_uids.includes(uid)))) continue;
      settleTurn(db, threadId, row.anchor_uid, record.partial ? "partial" : "done", record.reply_uids);
    }
  }

  /**
   * bb's own turns as Hermes stored them (A37): `bb` rows, and the session a `pending` binding now has.
   * A Hermes thread with no binding yet (a `bb thread spawn` whose profile wasn't on record) is bound here.
   * Mirror records settle queued wakes too.
   */
  function applyPersisted(threadId: string, state: PersistedTurnState): void {
    let binding = bindingByThread(db, threadId);
    if (!binding) {
      if (bindingByLineage(db, state.profile_home, state.lineage_root)) return fail("duplicate_binding");
      const uid = getKv(db, "worker_uid");
      insertBinding(db, {
        thread_id: threadId,
        profile_home: state.profile_home,
        lineage_root: null,
        session_id: null,
        expected_id: typeof uid === "number" ? expectedId(state.profile_home, uid, threadId) : null,
        kind: "chat",
        source: null,
        tag: null,
        state: "pending",
        legacy: false,
        archived_by_switch: false,
        title_set: null,
      });
      binding = bindingByThread(db, threadId)!;
      invalidateThreadInfo(bb);
    }
    if (binding.profile_home !== state.profile_home) return fail("persisted_turn_profile");
    if (!binding.lineage_root) {
      const other = bindingByLineage(db, state.profile_home, state.lineage_root);
      if (other) return fail("duplicate_binding");
      if (binding.kind === "bot") {
        // bb's first send found (and adopted) the Bot Chat: its older turns import after that turn (flow 5).
        updateBinding(db, threadId, { lineage_root: state.lineage_root, session_id: state.session_id, legacy: false, state: "replaying" });
        unfinished.add(threadId);
      } else {
        // A side chat's turns before bb's first are history, not news: wakes start after it.
        const last = state.turns.at(-1)?.anchor_uids.at(-1) ?? null;
        updateBinding(db, threadId, { lineage_root: state.lineage_root, session_id: state.session_id, state: "live", cursor_uid: last });
      }
    } else if (binding.lineage_root === state.lineage_root) {
      if (binding.session_id !== state.session_id) updateBinding(db, threadId, { session_id: state.session_id });
      // bb's own send there adopted a legacy chat (D16): wakes may attach to its canonical turns from now on.
      if (binding.legacy && state.turns.length) updateBinding(db, threadId, { legacy: false });
    } else if (binding.kind === "bot") {
      // The `Bot Chat` title moved to another chat (flow 3 step 6): follow it; its earlier turns aren't news. The old
      // chat's turns are in the bot thread already: it never imports as a mirrored chat (review 10).
      if (bindingByLineage(db, state.profile_home, state.lineage_root)) return fail("duplicate_binding");
      addTombstone(db, state.profile_home, binding.lineage_root, Date.now());
      const last = state.turns.at(-1)?.anchor_uids.at(-1) ?? null;
      updateBinding(db, threadId, { lineage_root: state.lineage_root, session_id: state.session_id, cursor_uid: last });
    }
    for (const record of state.turns) for (const anchor of record.anchor_uids) recordBbTurn(db, threadId, anchor, record.reply_uids, record.at);
    settleMirrored(threadId, state);
  }

  /** The latest `persisted-turn` and `status` payloads of a thread, from its events (the event itself is debounced). */
  async function latestStates(threadId: string): Promise<{ persisted: unknown; status: unknown }> {
    const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/extensionState/updated"], order: "desc", limit: "50" });
    const out: { persisted: unknown; status: unknown } = { persisted: undefined, status: undefined };
    for (const row of rows) {
      if (row.type !== "thread/extensionState/updated") continue;
      if (out.persisted === undefined && row.data.kind === persistedKind) out.persisted = row.data.payload;
      if (out.status === undefined && row.data.kind === statusKind) out.status = row.data.payload;
    }
    return out;
  }

  /** `persisted-turn` (bb's own turns, A37), then `status.dead_requests` (dead cards, A3). */
  async function ingestPersistedNow(threadId: string): Promise<void> {
    const states = await latestStates(threadId);
    if (states.persisted !== undefined) {
      const parsed = persistedTurnStateSchema.safeParse(states.persisted);
      if (parsed.success) applyPersisted(threadId, parsed.data);
      else fail("persisted_turn_invalid");
    }
    await deadCards(threadId, states.status);
  }

  /** Never throws: a dead-card failure must not stop the caller's own work. */
  async function deadCards(threadId: string, status: unknown): Promise<void> {
    if (status === undefined) return;
    const parsed = statusStateSchema.safeParse(status);
    if (!parsed.success) return fail("status_invalid");
    try {
      await stopForDeadNow(threadId, parsed.data.dead_requests ?? []);
    } catch (error) {
      fail(errorCode(error, "dead_card_failed"));
    }
  }

  /**
   * bb's pending provider cards whose Hermes prompt is gone (A3). bb 0.49.0 refuses to cancel a provider's
   * card ("stop the turn instead"); stopping the idle thread closes it (`interrupted`), and a message queued
   * behind it then dispatches. Mid-turn: wait for `thread.idle` (its finalize reads again). Never an answer;
   * one stop per dead card set, even if a card stays.
   */
  async function stopForDeadNow(threadId: string, dead: string[]): Promise<void> {
    const todo = dead.filter((id) => !handledDead.has(`${threadId}\0${id}`));
    if (!todo.length) return;
    const pending = await bb.sdk.threads.interactions.list({ threadId });
    // bb's daemon stores `<per-process scope>:<JSON-RPC id>`; the bridge's ids are unique across processes.
    const matches = (stored: string) => todo.filter((id) => stored === id || stored.endsWith(`:${id}`));
    const live = new Set(
      pending.flatMap((i) => (i.status === "pending" && i.origin?.kind === "provider" ? matches(i.origin.providerRequestId) : [])),
    );
    if (live.size) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "idle" && thread.status !== "error") return;
      await bb.sdk.threads.stop({ threadId });
    }
    // Handled: stopped now, or no card pending (closed already); either way never again.
    for (const id of todo) handledDead.add(`${threadId}\0${id}`);
  }

  /**
   * A thread went idle (or failed): if nothing is queued in bb, its turns are over. Replays are done,
   * an import goes `live`, init and imports end read, the notification level comes back, and the
   * binding is reconciled with `settle`.
   */
  async function finalizeNow(threadId: string, target: Target | null, enabled: (profileHome: string) => boolean): Promise<void> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status !== "idle" && thread.status !== "error") return;
    // A message queued behind a dead card waits for it: the stop runs even with a queue.
    if (thread.queuedMessageCount > 0) return deadCards(threadId, (await latestStates(threadId)).status);
    let binding: Binding | null;
    let flagged: boolean;
    try {
      await ingestPersistedNow(threadId);
      binding = bindingByThread(db, threadId);
      if (binding?.state === "replaying" && unfinished.has(threadId)) {
        // An import still to send (a bot thread bound by bb's own first send): send it; its idle finalizes.
        const enabledAt = botRecord(db, binding.profile_home)?.enabled_at;
        const sent = target && enabledAt != null && enabled(binding.profile_home) ? await importNow(binding, enabledAt, target) : 0;
        // Turns just sent haven't run: their idle finalizes.
        if (sent > 0 || unfinished.has(threadId)) return;
      }
      if (binding?.state === "replaying" && binding.kind !== "mirror" && !unfinished.has(threadId)) updateBinding(db, threadId, { state: "live" });
      flagged = readAtIdle.has(threadId) || importing.has(threadId);
      if (readAtIdle.has(threadId)) await bb.sdk.threads.markRead({ threadId });
    } catch (error) {
      // An init or import whose last idle failed here still ends: no further idle may come (review-2 5).
      if (readAtIdle.has(threadId) || importing.has(threadId)) confirmLater(threadId, thread.latestAttentionAt);
      throw error;
    }
    if (flagged || (binding && queuedTurnsOf(db, threadId).length)) confirmLater(threadId, thread.latestAttentionAt);
    if (!flagged) notify.release(threadId);
    const live = bindingByThread(db, threadId);
    if (live && target && enabled(live.profile_home)) await reconcileNow(live, target, { settle: true });
  }

  /** The thread's activity is news now (a wake, the user's own send): it no longer ends read, nor muted. */
  function dropReadFlag(threadId: string): void {
    readCheck.delete(threadId);
    if (readAtIdle.delete(threadId)) notify.release(threadId);
  }

  /** A read-confirmed thread: once quiet, still read? Else marked read again, at most `READ_CHECKS` times. */
  function checkReadLater(threadId: string): void {
    clearTimeout(readTimers.get(threadId));
    if (disposed) return;
    readTimers.set(
      threadId,
      setTimeout(() => {
        readTimers.delete(threadId);
        void enqueue(async () => {
          const left = readCheck.get(threadId);
          if (left === undefined) return;
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.status !== "idle" || thread.queuedMessageCount > 0) return void readCheck.delete(threadId);
          if ((thread.lastReadAt ?? -Infinity) < thread.latestAttentionAt) await bb.sdk.threads.markRead({ threadId });
          if (left > 1) {
            readCheck.set(threadId, left - 1);
            checkReadLater(threadId);
          } else readCheck.delete(threadId);
        }).catch((error) => gone.has(threadId) || fail(errorCode(error, "confirm_failed")));
      }, SETTLE_QUIET_MS),
    );
  }

  /** After `SETTLE_QUIET_MS`, on the queue; a later idle finalize starts the wait again. */
  function confirmLater(threadId: string, attentionAt: number): void {
    clearTimeout(confirmTimers.get(threadId));
    if (disposed) return;
    confirmTimers.set(
      threadId,
      setTimeout(() => {
        confirmTimers.delete(threadId);
        void enqueue(() => confirmNow(threadId, attentionAt)).catch((error) => gone.has(threadId) || fail(errorCode(error, "confirm_failed")));
      }, SETTLE_QUIET_MS),
    );
  }

  /**
   * The thread is quiet: idle, nothing queued, no turn ended since the finalize (`latestAttentionAt` as it was).
   * Otherwise a turn is still coming, and its idle finalize tries again. Then a queued row with no record covering
   * it: missing from a full window, it ran and its record aged out (`done` with its claimed reply rows: the bridge
   * can't skip rows it showed in a later rest wake any more). Else its render failed: `partial` with the rows its
   * record shows, so the next natural reconcile's rest wake shows the others; after `MAX_RENDER_RETRIES` rest wakes,
   * `done` with Hermes' reply rows (one `render_failed`). And an init or import is over once read.
   */
  async function confirmNow(threadId: string, attentionAt: number): Promise<void> {
    if (gone.has(threadId)) return;
    const unrecorded = queuedTurnsOf(db, threadId);
    if (!readAtIdle.has(threadId) && !importing.has(threadId) && !unrecorded.length) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status !== "idle" && thread.status !== "error") return;
    if (thread.queuedMessageCount > 0 || thread.latestAttentionAt !== attentionAt) return;
    const records = lastMirrored.get(threadId) ?? [];
    for (const row of unrecorded) {
      const record = records.find((m) => m.anchor_uid === row.anchor_uid);
      if (!record && records.length >= PERSISTED_TURNS_KEPT) {
        settleTurn(db, threadId, row.anchor_uid, "done", row.reply_uids);
        continue;
      }
      // Nothing to show again (review-2 9): never retried, and the cursor may pass it.
      if (!row.reply_uids.length) {
        settleTurn(db, threadId, row.anchor_uid, "done", []);
        continue;
      }
      const key = `${threadId}\0${row.anchor_uid}`;
      const failures = (renderFailures.get(key) ?? 0) + 1;
      renderFailures.set(key, failures);
      if (failures <= MAX_RENDER_RETRIES) settleTurn(db, threadId, row.anchor_uid, "partial", record?.reply_uids ?? []);
      else {
        // Its claim holds the reply rows Hermes had: never woken again.
        settleTurn(db, threadId, row.anchor_uid, "done", row.reply_uids);
        renderFailures.delete(key);
        fail("render_failed");
      }
    }
    if (!readAtIdle.has(threadId) && !importing.has(threadId)) return;
    // Quiet since the finalize, so unread only if its `markRead` never ran (it threw): read now.
    if (readAtIdle.has(threadId) && (thread.lastReadAt ?? -Infinity) < thread.latestAttentionAt) await bb.sdk.threads.markRead({ threadId });
    if (importing.has(threadId)) await onImportOver(threadId);
    if (readAtIdle.delete(threadId)) {
      readCheck.set(threadId, READ_CHECKS);
      checkReadLater(threadId);
    }
    // A wake the import's end sent keeps its hold: its own finalize releases it (review-2 3).
    if (!queuedTurnsOf(db, threadId).length) notify.release(threadId);
  }

  /**
   * Boot (flow 9): a `queued` row whose bb turn exists settles at that thread's idle; one with no bb
   * turn is released, so the reconcile that follows sends it again (or the import resumes).
   */
  async function recoverQueuedNow(finalize: (threadId: string) => void): Promise<void> {
    for (const row of queuedTurns(db)) {
      const binding = bindingByThread(db, row.thread_id);
      if (!binding) {
        releaseTurn(db, row.thread_id, row.anchor_uid);
        continue;
      }
      // An interrupted mirrored import: redone (thread, binding and rows deleted) by the reconcile that follows.
      if (binding.kind === "mirror" && binding.state === "replaying" && !importing.has(row.thread_id)) continue;
      let sent = false;
      try {
        // A rest claim shares its anchor with the first wake, which ran: only a queued message proves it was sent.
        // Re-sending a rest is safe (the bridge skips reply rows already shown).
        sent = row.prev_state ? await queuedWakeExists(row.thread_id, row.anchor_uid) : await wakeExists(row.thread_id, row.anchor_uid);
      } catch (error) {
        fail(errorCode(error, "recover_failed"));
        continue;
      }
      if (sent) finalize(row.thread_id);
      else releaseTurn(db, row.thread_id, row.anchor_uid);
    }
  }

  async function queuedWakeExists(threadId: string, anchorUid: string): Promise<boolean> {
    return JSON.stringify(await bb.sdk.threads.queuedMessages.list({ threadId })).includes(anchorUid);
  }

  /** bb holds a turn (queued or requested) whose input names this anchor. */
  async function wakeExists(threadId: string, anchorUid: string): Promise<boolean> {
    if (await queuedWakeExists(threadId, anchorUid)) return true;
    // Every turn request of the thread, newest first, page by page (R1 M1: a wake that ran is never sent twice).
    let before: string | undefined;
    for (;;) {
      const page = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "100", ...(before ? { beforeSeq: before } : {}) });
      if (JSON.stringify(page).includes(anchorUid)) return true;
      if (page.length < 100) return false;
      before = String(page.at(-1)!.seq);
    }
  }

  return {
    active,
    readAtIdle,
    dropReadFlag,
    gone,
    importing,
    setImportOver: (handler: typeof onImportOver) => void (onImportOver = handler),
    readImportTurns,
    sendInit,
    importNow, reconcileNow, applyPersisted, ingestPersistedNow, finalizeNow, recoverQueuedNow };
}

export type Sync = ReturnType<typeof createSync>;
