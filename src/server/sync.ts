// Import, wakes and bb's own turns (02 flows 5, 6, 9; §Mapping db wake atomicity). Everything that sends
// into a thread runs on one serial queue (02 §Invariants); a bb turn's end (`thread.idle`) settles what
// it showed. Hermes I/O only through the worker; no transcript text is stored.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { EXTENSION_KINDS, persistedTurnStateSchema, type PersistedTurnState, statusStateSchema } from "../shared/extension-state.js";
import type { HistoryTurn } from "../shared/host-contract.js";
import { encodeMarker, type Marker } from "../shared/marker.js";
import { THREAD_INFO_TAG } from "../shared/rpc-contract.js";
import { formatTag, SOURCE_TAGS, tagFor, type SourceTag } from "../shared/sources.js";
import { type Connection, errorCode, type HostClient } from "./connection.js";
import {
  bindingByLineage,
  bindingByThread,
  type Binding,
  botRecord,
  claimRest,
  claimTurn,
  type Db,
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
/** Pages of a truncated wake read before the rest waits for the next reconcile. */
const MAX_TURN_PAGES = 20;

/** 02 identity rules: the session id bb's first send will create, known before it exists (S0-S4 §S4b). */
export const expectedId = (profileHome: string, uid: number, threadId: string) =>
  `local-${createHash("sha256").update(JSON.stringify([profileHome, `uid:${uid}`, `bb:${threadId}`])).digest("hex")}`;

/** `threadInfo` reads refresh: a binding came or went, or its kind, label, tag or switch changed. */
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
const asTag = (value: string | null): SourceTag | null => (SOURCE_TAGS as readonly string[]).includes(value ?? "") ? (value as SourceTag) : null;

/** A chat's own tag: a side chat is a `gui` session (Desktop lists it); the Bot Chat is Conduit's (S8 §Today, A5, 01 §6). */
export const chatTag = (binding: Pick<Binding, "kind" | "tag">): SourceTag => asTag(binding.tag) ?? (binding.kind === "chat" ? "Desktop" : "Conduit");

/** The tag an outside turn carries: the surface its user row records, else the chat's own. */
export function turnTag(binding: Binding, turn: HistoryTurn): SourceTag {
  const fromSurface = turn.surface ? tagFor({ source: turn.surface, created_source: turn.surface, legacy: binding.legacy }) : null;
  return fromSurface ?? chatTag(binding);
}

/** The visible user bubble before a marker; none for a hidden user row (01 §7). bb's own turns are untagged. */
function label(binding: Binding, turn: HistoryTurn, imported: boolean): PromptInput[] {
  if (turn.user_hidden || turn.user_text === null) return [];
  if (isBbSubmission(turn)) return [text(turn.user_text)];
  return [text(formatTag(turnTag(binding, turn), imported ? new Date(turn.ts) : undefined) + turn.user_text)];
}

/** A turn's input: its label, then the marker, `labeled` when a label is there, so the bridge never submits it. */
function turnInput(binding: Binding, turn: HistoryTurn, imported: boolean, marker: Exclude<Marker, { op: "init" }>): PromptInput[] {
  const visible = label(binding, turn, imported);
  return [...visible, encodeMarker(visible.length ? { ...marker, labeled: true } : marker)];
}

const hasNew = (now: string[], shown: string[]) => now.some((uid) => !shown.includes(uid));

export function createSync({ bb, db, host, connection, notify }: SyncDeps) {
  /** Threads running a turn (`thread.active` … `thread.idle`): wakes wait for idle (bb's own turn may not be recorded yet). */
  const active = new Set<string>();
  /** Threads whose init or import must end read (`markRead` at idle). */
  const readAtIdle = new Set<string>();
  /** Imports that haven't sent every turn yet: they stay `replaying` at idle and resume at the next reconcile. */
  const unfinished = new Set<string>();
  const persistedKind = `${bb.pluginId}/${EXTENSION_KINDS.persistedTurn}`;
  const statusKind = `${bb.pluginId}/${EXTENSION_KINDS.status}`;
  /** `threadId \0 requestId` of dead cards already handled (memory: one stop per dead card set). */
  const handledDead = new Set<string>();
  const fail = (code: string) => connection.recordError(code);
  const paused = () => connection.health().state === "not_supported";

  async function send(threadId: string, input: PromptInput[]): Promise<void> {
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input });
  }

  /** Claims, then sends; a failed send releases the claim (R1 M1). False on failure. */
  async function sendClaimed(binding: Binding, anchorUid: string, input: PromptInput[], level: "muted" | "input-only"): Promise<boolean> {
    await notify.hold(binding.thread_id, level);
    try {
      await send(binding.thread_id, input);
      return true;
    } catch (error) {
      releaseTurn(db, binding.thread_id, anchorUid);
      fail(errorCode(error, "send_failed"));
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
   * Flow 5 for a `replaying` binding (the bot thread in P1): turns since `enabled_at − 30 d`, oldest
   * first; the first carries `bind` (with `since` when older turns stay in Hermes), the rest `replay`.
   * Resumable: turns already in `turns` are skipped, so an interrupted import continues (flow 9).
   */
  async function importNow(binding: Binding, enabledAt: number, target: Target): Promise<void> {
    if (paused() || !binding.lineage_root) return;
    unfinished.add(binding.thread_id);
    const since = enabledAt - IMPORT_WINDOW_MS;
    const read = await host.call(
      "readTurns",
      { root: target.root, profile_home: binding.profile_home, lineage_root: binding.lineage_root, since },
      { hostId: target.machine },
    );
    if (read.session_id !== binding.session_id) updateBinding(db, binding.thread_id, { session_id: read.session_id });
    let bound = hasTurns(db, binding.thread_id, "replay");
    for (const turn of read.turns) {
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
      readAtIdle.add(binding.thread_id);
      if (!(await sendClaimed(binding, turn.anchor_uid, turnInput(binding, turn, true, marker), "muted"))) return;
      bound = true;
    }
    unfinished.delete(binding.thread_id);
    // Imported turns are shown once their bb turns end: the cursor may pass them now.
    let cursor = binding.cursor_uid;
    for (const turn of read.turns) {
      if (!turn.complete) break;
      cursor = turn.anchor_uid;
    }
    updateBinding(db, binding.thread_id, { cursor_uid: cursor, ...(queuedTurnsOf(db, binding.thread_id).length ? {} : { state: "live" }) });
  }

  /**
   * Flow 6 for one `live` binding of an enabled bot: anchors not in `turns` and not bb's wake as
   * `mirror`; a shown, now complete turn with new reply rows wakes as `mirror{rest:true}`. `settle` (the
   * thread just went idle): queued turns no `mirrored` record settled take what Hermes now shows (fallback).
   */
  async function reconcileNow(binding: Binding, target: Target, { settle = false } = {}): Promise<void> {
    if (binding.state !== "live" || !binding.lineage_root) return;
    if (!settle && active.has(binding.thread_id)) return;
    if (paused()) {
      if (settle) for (const row of queuedTurnsOf(db, binding.thread_id)) settleTurn(db, binding.thread_id, row.anchor_uid, "done");
      return;
    }
    const read = await readAfter(binding, target);
    if (read.session_id !== binding.session_id) updateBinding(db, binding.thread_id, { session_id: read.session_id });
    if (settle) {
      const byAnchor = new Map(read.turns.map((t) => [t.anchor_uid, t]));
      for (const row of queuedTurnsOf(db, binding.thread_id)) {
        const turn = byAnchor.get(row.anchor_uid);
        settleTurn(db, binding.thread_id, row.anchor_uid, turn && !turn.complete ? "partial" : "done", turn?.reply_uids);
      }
    }
    for (const turn of read.turns) {
      const row = turnRow(db, binding.thread_id, turn.anchor_uid);
      if (!row) {
        // bb's own submit: never a wake (the `persisted-turn` record covers rows without `bb:`).
        if (isBbSubmission(turn)) {
          recordBbTurn(db, binding.thread_id, turn.anchor_uid, turn.reply_uids, turn.ts);
          continue;
        }
        if (!claimTurn(db, { thread_id: binding.thread_id, anchor_uid: turn.anchor_uid, kind: "mirror", at: turn.ts, reply_uids: turn.reply_uids })) continue;
        const input = turnInput(binding, turn, false, { op: "mirror", anchor_uid: turn.anchor_uid });
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
      if (!read.truncated || !read.turns.length || page === MAX_TURN_PAGES) return { session_id: read.session_id, turns };
      after = read.turns.at(-1)!.anchor_uid;
    }
  }

  /**
   * The bridge's `mirrored` records settle queued mirror turns with the reply rows it really showed, and
   * `partial` when Conduit's reply comes later. Only at idle (queue empty), so every queued wake has run
   * and the newest record per anchor is the last render. A rest claim keeps the rows shown before it.
   */
  function settleMirrored(threadId: string, state: PersistedTurnState): void {
    const newest = new Map(state.mirrored.map((m) => [m.anchor_uid, m]));
    for (const row of queuedTurnsOf(db, threadId)) {
      const record = row.kind === "mirror" || row.prev_state ? newest.get(row.anchor_uid) : undefined;
      if (!record) continue;
      const shown = row.prev_state ? [...new Set([...row.reply_uids, ...record.reply_uids])] : record.reply_uids;
      settleTurn(db, threadId, row.anchor_uid, record.partial ? "partial" : "done", shown);
    }
  }

  /**
   * bb's own turns as Hermes stored them (A37): `bb` rows, and the session a `pending` binding now has.
   * A Hermes thread with no binding yet (a `bb thread spawn` whose profile wasn't on record) is bound here.
   * `settle` (at idle): mirror records settle queued wakes too.
   */
  function applyPersisted(threadId: string, state: PersistedTurnState, { settle = false } = {}): void {
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
    } else if (binding.kind === "bot") {
      // The `Bot Chat` title moved to another chat (flow 3 step 6): follow it; its earlier turns aren't news.
      if (bindingByLineage(db, state.profile_home, state.lineage_root)) return fail("duplicate_binding");
      const last = state.turns.at(-1)?.anchor_uids.at(-1) ?? null;
      updateBinding(db, threadId, { lineage_root: state.lineage_root, session_id: state.session_id, cursor_uid: last });
    }
    for (const record of state.turns) for (const anchor of record.anchor_uids) recordBbTurn(db, threadId, anchor, record.reply_uids, record.at);
    if (settle) settleMirrored(threadId, state);
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
  async function ingestPersistedNow(threadId: string, options: { settle?: boolean } = {}): Promise<void> {
    const states = await latestStates(threadId);
    if (states.persisted !== undefined) {
      const parsed = persistedTurnStateSchema.safeParse(states.persisted);
      if (parsed.success) applyPersisted(threadId, parsed.data, options);
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
    await ingestPersistedNow(threadId, { settle: true });
    const binding = bindingByThread(db, threadId);
    if (binding?.state === "replaying" && unfinished.has(threadId)) {
      // An import still to send (a bot thread bound by bb's own first send): send it; its idle finalizes.
      const enabledAt = botRecord(db, binding.profile_home)?.enabled_at;
      if (target && enabledAt != null && enabled(binding.profile_home)) await importNow(binding, enabledAt, target);
      if (bindingByThread(db, threadId)?.state === "replaying") return;
    }
    for (const row of binding ? queuedTurnsOf(db, threadId) : []) if (row.kind === "replay") settleTurn(db, threadId, row.anchor_uid, "done");
    if (binding?.state === "replaying" && !unfinished.has(threadId)) updateBinding(db, threadId, { state: "live" });
    if (readAtIdle.delete(threadId)) await bb.sdk.threads.markRead({ threadId });
    notify.release(threadId);
    const live = bindingByThread(db, threadId);
    if (live && target && enabled(live.profile_home)) await reconcileNow(live, target, { settle: true });
  }

  /**
   * Boot (flow 9): a `queued` row whose bb turn exists settles at that thread's idle; one with no bb
   * turn is released, so the reconcile that follows sends it again (or the import resumes).
   */
  async function recoverQueuedNow(finalize: (threadId: string) => void): Promise<void> {
    for (const row of queuedTurns(db)) {
      if (!bindingByThread(db, row.thread_id)) {
        releaseTurn(db, row.thread_id, row.anchor_uid);
        continue;
      }
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

  return { active, readAtIdle, importNow, reconcileNow, applyPersisted, ingestPersistedNow, finalizeNow, recoverQueuedNow };
}

export type Sync = ReturnType<typeof createSync>;
