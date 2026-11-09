// Every chat of an enabled bot as a bb thread (T2.1–T2.3; 01 §2 import, §7; 02 flows 1 "Before on", 5, 6):
// discovery of unbound chats, their 30-day import in hidden threads (at most 2 at once), the switch row's count,
// interrupted-import redo and title follow. Runs on the serial queue; Hermes I/O only through the worker.
import type { SessionRow } from "../shared/host-contract.js";
import { spawnStart } from "../shared/marker.js";
import { eligibility, type Eligibility } from "../shared/sources.js";
import { labelOf, spawnPlacement } from "./bots.js";
import { sha256, titleFrom } from "./chats.js";
import { errorCode } from "./connection.js";
import { type Binding, bindingByLineage, bindingByThread, bindingsOf, botRecord, deleteBinding, getKv, insertBinding, setKv, updateBinding } from "./db.js";
import { IMPORT_WINDOW_MS, invalidateThreadInfo, type Sync, type SyncDeps, type Target, targetOf } from "./sync.js";

/** Hidden import threads at once: each runs its own bridge process on the Hermes machine. */
export const MAX_IMPORTS = 2;
/** The switch row's count is read at most this often per bot (02 §Invariants: the only call for an off bot). */
export const COUNT_TTL_MS = 60_000;
/** kv: profile home → the `enabled_at` whose first discovery pass finished (its chats ended read). */
const FIRST_PASS = "discovered";

interface Candidate {
  profile_home: string;
  row: SessionRow;
  surface: string;
  /** Found by the bot's first pass after its switch-on (or the P2 upgrade): ends read. Later chats end unread. */
  read: boolean;
}

const key = (profileHome: string, lineageRoot: string) => `${profileHome}\0${lineageRoot}`;

export function createDiscovery(deps: SyncDeps & { sync: Sync }) {
  const { bb, db, host, connection, notify, sync } = deps;
  const fail = (code: string) => connection.recordError(code);
  /** Candidates waiting for an import slot, by profile home and lineage root. */
  const pending = new Map<string, Candidate>();
  /** A chat whose first turn bb sent (A4): a side chat bb made, whose thread went before tombstones did. A first turn never changes. */
  const firstTurnBb = new Map<string, boolean>();
  /** Listed chats with no turn to import, until their activity moves. */
  const empty = new Set<string>();
  /** When this process's first pass of each bot began: a chat active after it is news, not import. */
  const passStart = new Map<string, number>();
  const counts = new Map<string, { at: number; count: number }>();

  const tombstoned = (profileHome: string, id: string) =>
    db.prepare(`SELECT 1 FROM tombstones WHERE profile_home = ? AND lineage_root = ?`).get(profileHome, id) !== undefined;
  const firstPasses = () => (getKv(db, FIRST_PASS) as Record<string, number> | null) ?? {};

  /**
   * 02 §Invariants allow-list, with `bbCreated` from the bindings' `expected_id`s and, for a `desktop`/`gui` chat
   * (bb's side chats are stored so), its first turn when `readFirst` may read it.
   */
  async function eligible(profileHome: string, row: SessionRow, readFirst: Target | null): Promise<Eligibility> {
    const expected = new Set(bindingsOf(db, profileHome).flatMap((b) => (b.expected_id ? [b.expected_id] : [])));
    const facts = {
      bbCreated: expected.has(row.session_id) || expected.has(row.lineage_root),
      tombstoned: tombstoned(profileHome, row.lineage_root) || tombstoned(profileHome, row.session_id),
    };
    const verdict = eligibility(row, facts);
    if (verdict.kind !== "chat" || (verdict.surface !== "desktop" && verdict.surface !== "gui")) return verdict;
    const k = key(profileHome, row.lineage_root);
    if (!firstTurnBb.has(k) && readFirst) {
      const read = await host.call("readTurns", { root: readFirst.root, profile_home: profileHome, lineage_root: row.lineage_root }, { hostId: readFirst.machine });
      // A truncated answer leaves the oldest turns out: the first is unknown, and the chat counts as not bb's.
      firstTurnBb.set(k, !read.truncated && read.turns[0]?.submission_id?.startsWith("bb:") === true);
    }
    return firstTurnBb.get(k) ? eligibility(row, { ...facts, bbCreated: true }) : verdict;
  }

  /** 01 §7: Hermes' title, until the user renames the thread in bb. A null Hermes title never changes bb's. */
  async function followTitleNow(binding: Binding, row: SessionRow): Promise<void> {
    if (!row.title || !binding.title_set || sha256(row.title) === binding.title_set) return;
    const thread = await bb.sdk.threads.get({ threadId: binding.thread_id });
    if (sha256(thread.title ?? "") !== binding.title_set) return;
    await bb.sdk.threads.update({ threadId: binding.thread_id, title: row.title });
    updateBinding(db, binding.thread_id, { title_set: sha256(row.title) });
  }

  /**
   * One enabled bot's list (02 flow 6 [P2]): mirrored threads follow their titles; unbound allowed chats active
   * since `enabled_at − 30 d` become candidates. The Bot Chat never gets its own thread.
   */
  async function discoverNow(profileHome: string, target: Target): Promise<void> {
    const bot = botRecord(db, profileHome);
    if (!bot?.enabled || bot.enabled_at == null || connection.health().state === "not_supported") return;
    const { sessions } = await host.call("listSessions", { root: target.root, profile_home: profileHome, since: bot.enabled_at - IMPORT_WINDOW_MS }, { hostId: target.machine });
    const firstPass = firstPasses()[profileHome] !== bot.enabled_at;
    if (firstPass && !passStart.has(profileHome)) passStart.set(profileHome, Date.now());
    for (const k of [...pending.keys()]) if (pending.get(k)!.profile_home === profileHome) pending.delete(k);
    for (const row of sessions) {
      const binding = bindingByLineage(db, profileHome, row.lineage_root);
      if (binding) {
        if (binding.kind === "mirror") await followTitleNow(binding, row).catch((error) => fail(errorCode(error, "title_follow_failed")));
        continue;
      }
      if (empty.has(`${key(profileHome, row.lineage_root)}\0${row.last_activity_at}`)) continue;
      const verdict = await eligible(profileHome, row, target);
      if (verdict.kind !== "chat") continue;
      const read = firstPass && row.last_activity_at !== null && row.last_activity_at <= passStart.get(profileHome)!;
      pending.set(key(profileHome, row.lineage_root), { profile_home: profileHome, row, surface: verdict.surface, read });
    }
    const busy = [...sync.importing.keys()].some((id) => bindingByThread(db, id)?.profile_home === profileHome);
    if (firstPass && !busy && ![...pending.values()].some((c) => c.profile_home === profileHome)) {
      setKv(db, FIRST_PASS, { ...firstPasses(), [profileHome]: bot.enabled_at });
      passStart.delete(profileHome);
    }
  }

  /** Imports start while a slot is free, oldest chat first. The next starts from a previous one's end, never by waiting. */
  async function startImportsNow(target: Target): Promise<void> {
    while (sync.importing.size < MAX_IMPORTS && pending.size) {
      const next = [...pending.values()].sort((a, b) => (a.row.last_activity_at ?? 0) - (b.row.last_activity_at ?? 0))[0]!;
      pending.delete(key(next.profile_home, next.row.lineage_root));
      try {
        await startImportNow(next, target);
      } catch (error) {
        fail(errorCode(error, "import_failed"));
      }
    }
  }

  /** Flow 5 for one chat: a hidden thread, bound right after its spawn, muted; then its turns. */
  async function startImportNow({ profile_home, row, surface, read }: Candidate, target: Target): Promise<void> {
    const bot = botRecord(db, profile_home);
    if (!bot?.enabled || bot.enabled_at == null || bindingByLineage(db, profile_home, row.lineage_root)) return;
    const turns = await sync.readImportTurns(profile_home, row.lineage_root, bot.enabled_at - IMPORT_WINDOW_MS, target, true);
    if (!turns.turns.length) return void empty.add(`${key(profile_home, row.lineage_root)}\0${row.last_activity_at}`);
    const firstText = turns.turns.find((t) => !t.user_hidden && t.user_text !== null && titleFrom(t.user_text) !== null)?.user_text;
    const title = row.title ?? (firstText ? titleFrom(firstText) : null) ?? `${labelOf(bot)} chat`;
    const thread = await bb.sdk.threads.spawn({
      ...(await spawnPlacement(bb, target.machine)),
      visibility: "hidden",
      sessionOptions: { profile: bot.name },
      title,
      input: [spawnStart()],
      pluginMetadata: { hermes: { origin: "import" } },
    });
    // Right after the spawn (02 §Invariants: one thread per Hermes chat).
    insertBinding(db, {
      thread_id: thread.id,
      profile_home,
      lineage_root: row.lineage_root,
      session_id: turns.session_id,
      expected_id: null,
      kind: "mirror",
      source: surface,
      tag: null,
      state: "replaying",
      legacy: row.legacy,
      archived_by_switch: false,
      title_set: sha256(title),
    });
    sync.importing.set(thread.id, { archived: row.archived });
    if (read) sync.readAtIdle.add(thread.id);
    invalidateThreadInfo(bb);
    await notify.hold(thread.id, "muted");
    await sync.importNow(bindingByThread(db, thread.id)!, bot.enabled_at, target, turns);
  }

  /** The import is over (every turn ran, confirmed): shown, archived as in Hermes (never pinned), stopped, live. */
  async function endImportNow(threadId: string): Promise<void> {
    const entry = sync.importing.get(threadId);
    sync.importing.delete(threadId);
    if (entry && bindingByThread(db, threadId)) {
      await bb.sdk.threads.update({ threadId, visibility: "visible" });
      if (entry.archived) await bb.sdk.threads.archive({ threadId });
      // Its bridge process goes; the next send or wake starts one.
      await bb.sdk.threads.stop({ threadId });
      updateBinding(db, threadId, { state: "live" });
      if (sync.readAtIdle.has(threadId)) await bb.sdk.threads.markRead({ threadId });
    }
    const target = targetOf(connection);
    if (target) await startImportsNow(target);
  }
  sync.setImportOver(endImportNow);

  /**
   * Interrupted import (flow 5, R3 S2, A38): binding and turns go first, so `thread.deleted` adds no tombstone;
   * then the hidden thread. Discovery imports the chat again from scratch.
   */
  async function redoNow(binding: Binding): Promise<void> {
    deleteBinding(db, binding.thread_id);
    sync.importing.delete(binding.thread_id);
    sync.readAtIdle.delete(binding.thread_id);
    invalidateThreadInfo(bb);
    await bb.sdk.threads.delete({ threadId: binding.thread_id, childThreadsConfirmed: true }).catch((error) => fail(errorCode(error, "import_cleanup_failed")));
  }

  /** Switch-off: this bot's imports stop (redone at the next switch-on); the slots go to other bots. */
  async function dropProfileNow(profileHome: string): Promise<void> {
    for (const k of [...pending.keys()]) if (pending.get(k)!.profile_home === profileHome) pending.delete(k);
    for (const b of bindingsOf(db, profileHome)) if (b.kind === "mirror" && b.state === "replaying") await redoNow(b);
    counts.delete(profileHome);
    const target = targetOf(connection);
    if (target) await startImportsNow(target);
  }

  /**
   * The switch row's "Imports N chats" for an off bot (02 flow 1 "Before on"): the chats a switch-on now would
   * import, by the same filter. Only `listSessions` (02 §Invariants): a `desktop` chat's first turn counts only
   * if an earlier pass read it.
   */
  async function importCount(profileHome: string, target: Target): Promise<number> {
    const cached = counts.get(profileHome);
    if (cached && Date.now() - cached.at < COUNT_TTL_MS) return cached.count;
    const { sessions } = await host.call("listSessions", { root: target.root, profile_home: profileHome, since: Date.now() - IMPORT_WINDOW_MS }, { hostId: target.machine });
    let count = 0;
    for (const row of sessions) if (!bindingByLineage(db, profileHome, row.lineage_root) && (await eligible(profileHome, row, null)).kind === "chat") count++;
    counts.set(profileHome, { at: Date.now(), count });
    return count;
  }

  return { discoverNow, startImportsNow, redoNow, dropProfileNow, importCount, forgetCount: (profileHome: string) => counts.delete(profileHome) };
}

export type Discovery = ReturnType<typeof createDiscovery>;
