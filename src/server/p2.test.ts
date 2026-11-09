import { makeMessageDispatchHookContext, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeMarker } from "../shared/marker.js";
import type { BotRow, Diagnostics } from "../shared/rpc-contract.js";
import { otherMachineText } from "../shared/provider-options.js";
import { OUTSIDE_TAG_REFUSAL, outsideTag } from "../shared/sources.js";
import { allBindings, bindingByLineage, bindingByThread, botRecord, insertBinding, turnRow } from "./db.js";
import { MAX_IMPORTS } from "./discovery.js";
import { type FakeThread, MACHINE, NEO, session, turn, world, type World } from "./fake-world.js";
import { deriveProviderOptions } from "./provider-options.js";
import { RESTORE_DELAY_MS } from "./notify.js";
import { IMPORT_WINDOW_MS } from "./sync.js";

const DAY = 86_400_000;

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

const on = (w: World, profile_home = NEO) => w.rpc<BotRow>("setBot", { profile_home, on: true });
const calls = (w: World, path: string) => w.harness.inspection.sdk.callsTo(path).map((args) => args[0] as Record<string, unknown>);
const isRead = (w: World, threadId: string) => {
  const t = w.thread(threadId);
  return (t.lastReadAt ?? -1) >= t.latestAttentionAt;
};
const tombstones = (w: World) => w.db.prepare(`SELECT profile_home, lineage_root FROM tombstones ORDER BY lineage_root`).all();

/** Rows the import should make threads of, each with its history. */
function chat(w: World, id: string, rowOver: Parameters<typeof session>[1] = {}, turns = [turn(`${id}-1`), turn(`${id}-2`)]) {
  const row = session(id, rowOver);
  w.sessions.set(NEO, [...(w.sessions.get(NEO) ?? []), row]);
  w.history.set(row.lineage_root, { session_id: row.session_id, turns });
  return row;
}

const ran = new WeakMap<World, Map<string, number>>();
/**
 * bb runs every turn sent so far, thread by thread, then stays quiet; until nothing new is sent. `gap`: each
 * thread's idle comes first while bb still dispatches its last turn (02 P1 finding). Returns the most hidden
 * import threads seen at once.
 */
async function drain(w: World, { gap = false } = {}): Promise<number> {
  const seen = ran.get(w) ?? new Map<string, number>();
  ran.set(w, seen);
  let peak = hidden(w).length;
  for (let round = 0; round < 30; round++) {
    let moved = false;
    for (const t of [...w.threads.values()]) {
      if (t.deletedAt || t.inputs.length === (seen.get(t.id) ?? 0)) continue;
      seen.set(t.id, t.inputs.length);
      moved = true;
      // The bridge renders what was sent (its records settle the rows).
      if (bindingByThread(w.db, t.id)?.lineage_root) w.render(t.id);
      if (gap) {
        await w.idle(t.id);
        await w.active(t.id);
      }
      await w.idle(t.id);
      peak = Math.max(peak, hidden(w).length);
    }
    await w.quiet();
    peak = Math.max(peak, hidden(w).length);
    if (!moved) return peak;
  }
  throw new Error("drain never settled");
}
/** A thread bb holds from before this test's server. */
const fakeThread = (id: string): FakeThread => ({ id, title: null, status: "idle", archivedAt: null, deletedAt: null, pinned: false, queued: 0, lastReadAt: null, latestAttentionAt: 1, visibility: "hidden", originPluginId: "hermes", spawn: null, inputs: [] });
const hidden = (w: World) => [...w.threads.values()].filter((t) => !t.deletedAt && t.visibility === "hidden");
const mirrors = (w: World): FakeThread[] => allBindings(w.db).filter((b) => b.kind === "mirror").map((b) => w.thread(b.thread_id));
const countRow = async (w: World) => (await w.rpc<{ bots: BotRow[] }>("bots")).bots.find((b) => b.profile_home === NEO)!.import_count;

/** A connected world with neo's Bot Chat found, holding `turns`. */
async function botChatWorld(turns = [turn("u1"), turn("u2")]) {
  const w = await world();
  await w.connect();
  w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: false });
  w.history.set("root_bc", { session_id: "tip_bc", turns });
  return w;
}

describe("P1 follow-ups: spawn input", () => {
  it("no spawn input holds a marker: bot thread and side chat spawn with spawnStart(), the init follows in a send", async () => {
    const w = await botChatWorld();
    await on(w);
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    for (const spawn of calls(w, "threads.spawn")) {
      expect(JSON.stringify(spawn.input)).not.toContain("<hermes-bb>");
      expect(spawn.input).toEqual([{ type: "text", mentions: [], text: "", visibility: "agent-only" }]);
    }
    expect(w.markers("thr_1")[0]).toEqual({ op: "init", profile: "neo", bot: true });
    expect(w.markers(chat)).toEqual([{ op: "init", profile: "neo" }]);
  });

  it("a failed init send takes the thread back with no tombstone; the next keep-alive spawns again", async () => {
    const w = await botChatWorld();
    w.state.failSend = 1;
    // The keep-alive right after the switch spawns the bot thread again.
    expect(await on(w)).toMatchObject({ enabled: true, thread_id: "thr_2" });
    expect(() => w.thread("thr_1")).toThrow("404");
    expect(bindingByThread(w.db, "thr_1")).toBeNull();
    expect(tombstones(w)).toEqual([]);
    expect(bindingByThread(w.db, "thr_2")).toMatchObject({ kind: "bot" });
    expect(w.markers("thr_2")[0]).toEqual({ op: "init", profile: "neo", bot: true });
  });
});

describe("P1 follow-ups: an init or import ends read only once it is over", () => {
  it("bb's dispatch gap (idle, nothing queued, the last import turn still to run) still ends read, 0 pushes", async () => {
    const w = await botChatWorld();
    await on(w);
    // bb reports idle with an empty queue while it still dispatches the last import turn…
    await w.idle("thr_1");
    expect(isRead(w, "thr_1")).toBe(true);
    // …which then runs and ends: a root thread's turn end needs attention again.
    await w.active("thr_1");
    await w.idle("thr_1");
    await w.quiet();
    expect(isRead(w, "thr_1")).toBe(true);
    // Muted throughout; the user's level comes back only after the confirm.
    expect(w.levelCalls).toEqual([{ threadId: "thr_1", level: "muted" }]);
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levelCalls.at(-1)).toEqual({ threadId: "thr_1", level: "inherit" });
  });

  for (const n of [1, 4]) {
    it(`BUG 3 (live, every bot switched on): the init's finalize lands in the gap before the import's ${n === 1 ? "one turn starts" : "turns start"} → still 0 unread`, async () => {
      const w = await botChatWorld(Array.from({ length: n }, (_, i) => turn(`u${i + 1}`)));
      await on(w);
      // The spawn's empty turn and the init end; bb reports idle with nothing queued before the first import turn starts.
      await w.idle("thr_1");
      const readAfterInit = w.thread("thr_1").lastReadAt!;
      // Then every import turn runs, one by one; each end moves latestAttentionAt past that markRead.
      for (let i = 0; i < n; i++) {
        await w.active("thr_1");
        await w.idle("thr_1");
      }
      expect(w.thread("thr_1").latestAttentionAt).toBeGreaterThan(readAfterInit);
      await w.quiet();
      expect(isRead(w, "thr_1")).toBe(true);
      await w.elapse(RESTORE_DELAY_MS);
      expect(w.levelCalls).toEqual([
        { threadId: "thr_1", level: "muted" },
        { threadId: "thr_1", level: "inherit" },
      ]);
    });
  }

  it("a confirm that finds a later turn waits for that turn's idle", async () => {
    const w = await botChatWorld();
    await on(w);
    await w.idle("thr_1");
    // The gap turn starts before the quiet period ends: no confirm, the hold stays.
    await w.active("thr_1");
    await w.quiet();
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levelCalls).toEqual([{ threadId: "thr_1", level: "muted" }]);
    await w.idle("thr_1");
    await w.quiet();
    expect(isRead(w, "thr_1")).toBe(true);
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levelCalls.at(-1)).toEqual({ threadId: "thr_1", level: "inherit" });
  });

  it("a wake into a thread still settling clears the flag: outside activity stays unread", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    await w.idle("thr_1");
    w.history.get("root_bc")!.turns.push(turn("u2"));
    await w.changed(NEO);
    expect(w.markers("thr_1").at(-1)).toEqual({ op: "mirror", anchor_uid: "u2", labeled: true });
    // The wake runs as an input-only turn, not muted: an approval in it pushes.
    expect(w.levelCalls.at(-1)).toEqual({ threadId: "thr_1", level: "input-only" });
    await w.idle("thr_1");
    await w.quiet();
    expect(isRead(w, "thr_1")).toBe(false);
  });
});

describe("P1 follow-ups: tombstones (Q1)", () => {
  it("bb deleting a side chat tombstones its lineage root; a pending one its expected_id; a bot thread none", async () => {
    const w = await botChatWorld();
    await on(w);
    await w.idle("thr_1");
    const { thread_id: bound } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    const sid = bindingByThread(w.db, bound)!.expected_id!;
    w.persisted(bound, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${bound}:c1`, anchor_uids: ["s1"], reply_uids: [], at: 1 }] });
    await w.idle(bound);
    const { thread_id: pending } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    const pendingId = bindingByThread(w.db, pending)!.expected_id!;
    for (const id of [bound, pending, "thr_1"]) {
      w.thread(id).deletedAt = 9;
      await w.emit("thread.deleted", id);
    }
    expect(tombstones(w)).toEqual([sid, pendingId].sort().map((lineage_root) => ({ profile_home: NEO, lineage_root })));
  });
});

describe("T2.1–T2.2: discovery and 30-day import", () => {
  it("01 §3 AC: a Bot Chat, 2 side chats and 3 CLI chats → 1 pinned + 5 others; badges by kind", async () => {
    const w = await botChatWorld();
    for (const id of ["c1", "c2", "c3"]) chat(w, id);
    await on(w);
    await drain(w);
    const sides: string[] = [];
    for (const n of [1, 2]) {
      const { thread_id } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
      const sid = bindingByThread(w.db, thread_id)!.expected_id!;
      // bb's own side chats list as `local`/`desktop` rows, first turn bb's.
      chat(w, sid, { created_source: "desktop" }, [turn(`s${n}`, { submission_id: `bb:${thread_id}:1` })]);
      if (n === 1) w.persisted(thread_id, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${thread_id}:1`, anchor_uids: [`s${n}`], reply_uids: [], at: 1 }] });
      sides.push(thread_id);
    }
    await drain(w);
    await w.changed(NEO);
    await drain(w);
    const live = [...w.threads.values()].filter((t) => !t.deletedAt && t.visibility === "visible");
    expect(live.filter((t) => t.pinned).map((t) => t.id)).toEqual(["thr_1"]);
    expect(live.filter((t) => !t.pinned)).toHaveLength(5);
    expect(allBindings(w.db).map((b) => b.kind).sort()).toEqual(["bot", "chat", "chat", "mirror", "mirror", "mirror"]);
    expect(mirrors(w).map((t) => t.title).sort()).toEqual(["Chat c1", "Chat c2", "Chat c3"]);
  });

  it("count == imported; spawned hidden with spawnStart(), bound right after, tagged and dated; 0 unread, 0 pushes, also through bb's dispatch gap; a re-run imports 0", async () => {
    const w = await botChatWorld([]);
    const ts = Date.now() - 3 * DAY;
    for (const id of ["c1", "c2"]) chat(w, id, { last_activity_at: Date.now() - (id === "c1" ? 2 : 1) * DAY }, [turn(`${id}-1`, { ts }), turn(`${id}-2`, { ts, submission_id: "bb:thr_9:1", user_text: "mine" })]);
    chat(w, "c3", { archived: true, created_source: "tui" });
    chat(w, "c4", { source: "desktop", created_source: null, legacy: true });
    expect(await countRow(w)).toBe(4);
    // Cached ≤ 60 s; the only calls naming an off bot, both read-only (02 §Invariants).
    expect(await countRow(w)).toBe(4);
    const named = w.harness.inspection.experimental_hostRpcCalls.filter((c) => JSON.stringify(c.input).includes(NEO));
    expect(named.map((c) => c.method)).toEqual(["listSessions", "firstSubmissions"]);
    await on(w);
    expect(await countRow(w)).toBeNull();
    // Oldest first, at most 2 at once, each hidden until its import is over.
    const spawns = () => calls(w, "threads.spawn").filter((a) => a.visibility === "hidden");
    expect(spawns().map((a) => a.title)).toEqual(["Chat c1", "Chat c2"]);
    expect(spawns()[0]).toMatchObject({ visibility: "hidden", sessionOptions: { profile: "neo" }, pluginMetadata: { hermes: { origin: "import" } } });
    expect(spawns()[0]!.pinned).toBeUndefined();
    const c1 = bindingByLineage(w.db, NEO, "c1")!;
    expect(c1).toMatchObject({ kind: "mirror", state: "replaying", source: "cli", legacy: false });
    expect(w.markers(c1.thread_id)).toEqual([
      { op: "bind", profile_home: NEO, lineage_root: "c1", legacy: false, anchor_uid: "c1-1", labeled: true },
      { op: "replay", anchor_uid: "c1-2", labeled: true },
    ]);
    expect(w.texts(c1.thread_id)).toEqual([`${outsideTag(new Date(ts))}text c1-1`, "mine"]);

    expect(await drain(w, { gap: true })).toBeLessThanOrEqual(MAX_IMPORTS);
    expect(mirrors(w)).toHaveLength(4);
    for (const t of mirrors(w)) {
      expect(t.visibility).toBe("visible");
      expect(isRead(w, t.id)).toBe(true);
      expect(bindingByThread(w.db, t.id)?.state).toBe("live");
    }
    expect(isRead(w, "thr_1")).toBe(true);
    expect(bindingByLineage(w.db, NEO, "c4")).toMatchObject({ legacy: true, source: "desktop" });
    // Archived in Hermes → archived in bb; never pinned.
    expect(mirrors(w).map((t) => [t.title, t.archivedAt !== null, t.pinned])).toEqual(
      expect.arrayContaining([["Chat c3", true, false], ["Chat c1", false, false]]),
    );
    // Each import thread stops once shown (its bridge process goes).
    for (const t of mirrors(w)) expect(calls(w, "threads.stop").map((a) => a.threadId)).toContain(t.id);
    // 0 pushes: every level the plugin set is muted (then the user's own level back).
    expect(new Set(w.levelCalls.map((c) => c.level))).toEqual(new Set(["muted", "inherit"]));
    for (const spawn of calls(w, "threads.spawn")) expect(JSON.stringify(spawn.input)).not.toContain("<hermes-bb>");

    const before = w.threads.size;
    await w.changed(NEO);
    await drain(w);
    expect(w.threads.size).toBe(before);
    const diagnostics = await w.rpc<Diagnostics>("diagnostics");
    expect(diagnostics.bindings).toEqual({ total: 5, duplicates: 0 });
    expect(diagnostics.errors).toEqual([]);
  });

  it("a later new chat (started while the bot is on) imports unread, with 0 pushes", async () => {
    const w = await botChatWorld([]);
    await on(w);
    await drain(w);
    chat(w, "c9", { last_activity_at: Date.now() + 1 });
    await w.changed(NEO);
    await drain(w);
    const [t] = mirrors(w);
    expect(t).toMatchObject({ visibility: "visible", title: "Chat c9" });
    expect(isRead(w, t!.id)).toBe(false);
    expect(w.levelCalls.filter((c) => c.threadId === t!.id).map((c) => c.level)).toEqual(["muted", "inherit"]);
  });

  it("the P2 upgrade: a bot already on imports its chats once, read", async () => {
    const w = await world({
      seed: (db) => db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, ?)`).run(NEO, Date.now() - 5 * DAY),
    });
    chat(w, "c1");
    await w.connect();
    await drain(w);
    expect(mirrors(w)).toHaveLength(1);
    expect(isRead(w, mirrors(w)[0]!.id)).toBe(true);
  });

  it("stays out: cron, oneshot, acp, chat-app, hidden, empty, a visible Bot Chat, bb-created (expected_id, first turn bb:) and tombstoned", async () => {
    const w = await botChatWorld([]);
    chat(w, "cron", { created_source: "cron" });
    chat(w, "one", { source: "oneshot", created_source: null });
    chat(w, "acp", { created_source: "acp" });
    chat(w, "dis", { source: "discord", created_source: null });
    chat(w, "hid", { hidden: true });
    chat(w, "emp", { message_count: 0 });
    chat(w, "bc", { title: "Bot Chat" });
    chat(w, "pend", { created_source: "desktop" });
    chat(w, "mine", { created_source: "desktop" }, [turn("m1", { submission_id: "bb:thr_gone:1" }), turn("m2")]);
    // Never by surface: a bb-created chat on any surface is out.
    chat(w, "mine2", { created_source: "cli" }, [turn("n1", { submission_id: "bb:thr_gone2:1" })]);
    chat(w, "tomb");
    w.db.prepare(`INSERT INTO tombstones (profile_home, lineage_root, at) VALUES (?, 'tomb', 1)`).run(NEO);
    w.threads.set("thr_pend", { ...fakeThread("thr_pend"), visibility: "visible" });
    insertBinding(w.db, { thread_id: "thr_pend", profile_home: NEO, lineage_root: null, session_id: null, expected_id: "pend", kind: "chat", source: null, tag: null, state: "pending", legacy: false, archived_by_switch: false, title_set: null });
    // The count reads first submissions too: bb's own chats are out of it, as of the import.
    expect(await countRow(w)).toBe(0);
    await on(w);
    await drain(w);
    await w.changed(NEO);
    await drain(w);
    expect(mirrors(w)).toEqual([]);
    expect(w.threads.size).toBe(2);
    await w.rpc("setBot", { profile_home: NEO, on: false });
    expect(await countRow(w)).toBe(0);
  });

  it("first submissions: asked once per chat, in one batch, for every surface; a chat the worker can't read waits, out of the count too", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    chat(w, "c2", { created_source: "desktop" });
    chat(w, "c3");
    w.state.unreadable = ["c3"];
    expect(await countRow(w)).toBe(2);
    await on(w);
    await drain(w);
    // The count's answers are kept: the switch-on asks only for c3 again.
    const asked = () => w.hostCalls("firstSubmissions").map((c) => (c.input as { lineage_roots: string[] }).lineage_roots);
    expect(asked()).toEqual([["c1", "c2", "c3"], ["c3"]]);
    expect(bindingByLineage(w.db, NEO, "c3")).toBeNull();
    w.state.unreadable = [];
    await w.changed(NEO);
    await drain(w);
    expect(asked()).toEqual([["c1", "c2", "c3"], ["c3"], ["c3"]]);
    expect(mirrors(w)).toHaveLength(3);
    // The first pass waited for c3, so it ends read too.
    expect(isRead(w, bindingByLineage(w.db, NEO, "c3")!.thread_id)).toBe(true);
  });

  it("a chat whose listed activity spans the window's start imports its newest turn alone, with the note", async () => {
    const w = await botChatWorld([]);
    const old = Date.now() - 40 * DAY;
    chat(w, "long", { last_activity_at: Date.now() - DAY }, [turn("l1", { ts: old - 1 }), turn("l2", { ts: old })]);
    await on(w);
    const t = bindingByLineage(w.db, NEO, "long")!;
    const since = botRecord(w.db, NEO)!.enabled_at! - IMPORT_WINDOW_MS;
    expect(w.markers(t.thread_id)).toEqual([{ op: "bind", profile_home: NEO, lineage_root: "long", legacy: false, anchor_uid: "l2", since, labeled: true }]);
  });

  it("title: Hermes' title, else the first visible message cut to 60 characters, else '<bot> chat'", async () => {
    const w = await botChatWorld([]);
    chat(w, "t1", { title: null, last_activity_at: Date.now() - 3 * DAY }, [turn("h", { user_hidden: true, user_text: null }), turn("x", { user_text: "  Plan   my week: " + "x".repeat(80) })]);
    chat(w, "t2", { title: null, last_activity_at: Date.now() - 2 * DAY }, [turn("y", { user_hidden: true, user_text: null })]);
    await on(w);
    await drain(w);
    expect(mirrors(w).map((t) => t.title)).toEqual([("Plan my week: " + "x".repeat(80)).slice(0, 60), "Neo chat"]);
  });

  it("interrupted import (flow 9): the hidden thread a previous process left is deleted with its rows, no tombstone, imported again once", async () => {
    const w = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, ?)`).run(NEO, Date.now());
        insertBinding(db, { thread_id: "thr_old", profile_home: NEO, lineage_root: "c1", session_id: "c1", expected_id: null, kind: "mirror", source: "cli", tag: null, state: "replaying", legacy: false, archived_by_switch: false, title_set: null });
        db.prepare(`INSERT INTO turns (thread_id, anchor_uid, kind, state, at) VALUES ('thr_old', 'c1-1', 'replay', 'done', 1)`).run();
      },
    });
    w.threads.set("thr_old", { ...fakeThread("thr_old"), title: "Chat c1" });
    chat(w, "c1");
    await w.connect();
    await w.flush();
    expect(w.thread.bind(null, "thr_old")).toThrow("404");
    expect(calls(w, "threads.delete")).toEqual([{ threadId: "thr_old", childThreadsConfirmed: true }]);
    expect(tombstones(w)).toEqual([]);
    expect(w.db.prepare(`SELECT COUNT(*) AS n FROM turns WHERE thread_id = 'thr_old'`).get()).toEqual({ n: 0 });
    await drain(w);
    expect(mirrors(w)).toHaveLength(1);
    expect(mirrors(w)[0]).toMatchObject({ title: "Chat c1", visibility: "visible" });
    expect(w.markers(mirrors(w)[0]!.id).map((m) => m.op)).toEqual(["bind", "replay"]);
    // A new worker boot while this process imports keeps its own import.
    chat(w, "c2");
    await w.changed(NEO);
    const c2 = bindingByLineage(w.db, NEO, "c2")!.thread_id;
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.thread(c2).deletedAt).toBeNull();
    await drain(w);
    expect(mirrors(w)).toHaveLength(2);
  });

  it("at most 2 imports at once; the next starts from a previous one's end", async () => {
    const w = await botChatWorld([]);
    for (let i = 1; i <= 5; i++) chat(w, `c${i}`, { last_activity_at: Date.now() - (10 - i) * DAY });
    await on(w);
    expect(hidden(w)).toHaveLength(2);
    expect(await drain(w)).toBe(2);
    expect(mirrors(w).map((t) => t.title)).toEqual(["Chat c1", "Chat c2", "Chat c3", "Chat c4", "Chat c5"]);
  });

  for (const step of ["threads.update", "threads.archive", "threads.stop"] as const) {
    it(`an import whose ${step} at the end fails frees its slot: the next import starts; the thread is redone at the next full reconcile`, async () => {
      const w = await botChatWorld([]);
      chat(w, "c1", { last_activity_at: Date.now() - 4 * DAY, archived: true });
      chat(w, "c2", { last_activity_at: Date.now() - 3 * DAY, archived: true });
      chat(w, "c3", { last_activity_at: Date.now() - 2 * DAY });
      await on(w);
      // Both slots' imports fail at their end: only a freed slot starts c3.
      const failing = new Set(["c1", "c2"].map((id) => bindingByLineage(w.db, NEO, id)!.thread_id));
      w.harness.inspection.sdk.stub(step, async (args: { threadId: string; visibility?: string }) => {
        if (failing.delete(args.threadId)) throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
        const t = w.thread(args.threadId);
        if (step === "threads.update" && args.visibility) t.visibility = args.visibility as "visible";
        if (step === "threads.archive") t.archivedAt = 1;
        return w.dto(args.threadId);
      });
      await drain(w);
      expect(failing.size).toBe(0);
      expect(bindingByLineage(w.db, NEO, "c3")).toMatchObject({ state: "live" });
      expect(bindingByLineage(w.db, NEO, "c1")?.state).toBe("replaying");
      expect((await w.rpc<Diagnostics>("diagnostics")).errors).toContain("unavailable");
      w.state.boot = "boot_2";
      await w.connect();
      await drain(w);
      for (const id of ["c1", "c2"]) {
        expect(w.thread(bindingByLineage(w.db, NEO, id)!.thread_id)).toMatchObject({ visibility: "visible" });
        expect(bindingByLineage(w.db, NEO, id)).toMatchObject({ state: "live" });
      }
      expect(mirrors(w)).toHaveLength(3);
    });
  }

  it("switch-off mid-import: the import stops (thread and binding go, no tombstone) and runs again at switch-on", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    const first = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    await w.rpc("setBot", { profile_home: NEO, on: false });
    expect(w.thread.bind(null, first)).toThrow("404");
    expect(bindingByLineage(w.db, NEO, "c1")).toBeNull();
    expect(tombstones(w)).toEqual([]);
    await on(w);
    await drain(w);
    expect(mirrors(w)).toHaveLength(1);
  });

  it("D48: off archives mirrored threads, on unarchives and catches them up; a chat started while off imports at the switch-on; Hermes-archived stays archived", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    chat(w, "c2", { archived: true });
    await on(w);
    await drain(w);
    const [c1, c2] = ["c1", "c2"].map((id) => bindingByLineage(w.db, NEO, id)!.thread_id);
    await w.rpc("setBot", { profile_home: NEO, on: false });
    expect([w.thread(c1!).archivedAt, w.thread(c2!).archivedAt].map((a) => a !== null)).toEqual([true, true]);
    expect(bindingByThread(w.db, c2!)?.archived_by_switch).toBe(false);
    w.history.get("c1")!.turns.push(turn("c1-3", { ts: Date.now() }));
    chat(w, "c3", { last_activity_at: Date.now() });
    await on(w);
    expect(w.thread(c1!).archivedAt).toBeNull();
    expect(w.thread(c2!).archivedAt).not.toBeNull();
    expect(w.markers(c1!).at(-1)).toEqual({ op: "mirror", anchor_uid: "c1-3", labeled: true });
    await drain(w);
    expect(bindingByLineage(w.db, NEO, "c3")).toMatchObject({ kind: "mirror", state: "live" });
  });

  it("not_supported pauses discovery and import; the count is null while not connected", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    w.state.online = false;
    await w.connect();
    expect(await countRow(w)).toBeNull();
    w.state.online = true;
    await w.connect();
    await on(w);
    await drain(w);
    w.state.supported = false;
    await w.connect();
    chat(w, "c2");
    await w.changed(NEO);
    await drain(w);
    expect(bindingByLineage(w.db, NEO, "c2")).toBeNull();
    w.state.supported = true;
    await w.connect();
    await w.changed(NEO);
    await drain(w);
    expect(bindingByLineage(w.db, NEO, "c2")).toMatchObject({ state: "live" });
  });

  it("wakes into a mirrored thread work as for bound threads (flow 6)", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    expect(bindingByThread(w.db, t)?.cursor_uid).toBe("c1-2");
    w.history.get("c1")!.turns.push(turn("c1-3"));
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers(t).filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "c1-3", labeled: true }]);
    expect(w.texts(t).at(-1)).toBe("[Outside bb] text c1-3");
  });
});

describe("T2.3: title follow", () => {
  it("follows Hermes' title until the user renames the thread in bb; a null title changes nothing; bot threads and side chats never follow", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    const row = w.sessions.get(NEO)!.find((r) => r.lineage_root === "c1")!;
    row.title = "Renamed in Hermes";
    await w.changed(NEO);
    expect(w.thread(t).title).toBe("Renamed in Hermes");
    row.title = null;
    await w.changed(NEO);
    expect(w.thread(t).title).toBe("Renamed in Hermes");
    // The user renames it in bb: never retitled again.
    w.thread(t).title = "Mine";
    row.title = "Again in Hermes";
    await w.changed(NEO);
    expect(w.thread(t).title).toBe("Mine");

    // A side chat listed with a Hermes title keeps bb's; so does the bot thread.
    const { thread_id: side } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    const sid = bindingByThread(w.db, side)!.expected_id!;
    w.persisted(side, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${side}:1`, anchor_uids: ["s1"], reply_uids: [], at: 1 }] });
    await w.idle(side);
    chat(w, sid, { title: "Hermes names it", created_source: "desktop" }, [turn("s1", { submission_id: `bb:${side}:1` })]);
    await w.changed(NEO);
    expect(w.thread(side).title).toBe("New Neo chat");
    expect(w.thread("thr_1").title).toBe("Neo");
    expect(calls(w, "threads.update").filter((a) => a.title !== undefined).map((a) => a.threadId)).toEqual([t]);
  });
});

describe("T2.3: dispatch hook (D15)", () => {
  const hook = (w: World) => w.harness.inspection.registrations.hooks["message.dispatch"]!;
  const text = (value: string) => ({ type: "text" as const, mentions: [], text: value });
  const hermes = { providerId: "hermes" };
  const refused = { action: "reject", message: OUTSIDE_TAG_REFUSAL };

  it("a recalled [Outside bb] line is refused with the text; a wake, an import, a plain send and a non-Hermes thread pass", async () => {
    const w = await world();
    const decide = (input: ReturnType<typeof text | typeof encodeMarker>[], thread = hermes) =>
      hook(w)(makeMessageDispatchHookContext({ thread, input: { blocks: input, text: "" } }));
    expect(await decide([text("[Outside bb] hello")])).toEqual(refused);
    expect(await decide([text("[Outside bb · Oct 12] hello")])).toEqual(refused);
    expect(await decide([text("[Outside bb] hello"), encodeMarker({ op: "mirror", anchor_uid: "u1", labeled: true })])).toEqual({ action: "proceed" });
    expect(await decide([text(`${outsideTag(new Date())}hi`), encodeMarker({ op: "replay", anchor_uid: "u2", labeled: true })])).toEqual({ action: "proceed" });
    expect(await decide([text("hello [Outside bb] there")])).toEqual({ action: "proceed" });
    expect(await decide([{ type: "text", mentions: [], text: "", visibility: "agent-only" }])).toEqual({ action: "proceed" });
    // A broken marker is no marker.
    expect(await decide([text("[Outside bb] x"), { type: "text", mentions: [], text: "<hermes-bb>{</hermes-bb>", visibility: "agent-only" }])).toEqual(refused);
    expect(await decide([text("[Outside bb] hello")], { providerId: "codex" })).toEqual({ action: "proceed" });
  });

  it("merged rows: a group holding a marker proceeds (the bridge refuses the tagged segment itself); otherwise any recalled row refuses", async () => {
    const w = await world();
    const wake = [text("[Outside bb] from the CLI"), encodeMarker({ op: "mirror", anchor_uid: "u1", labeled: true })];
    const decide = (rows: (typeof wake)[]) =>
      hook(w)(
        makeMessageDispatchHookContext({
          thread: hermes,
          input: { blocks: rows.flat(), text: "" },
          queuedMessages: rows.map((content) => makeQueueEntry({ content })),
        }),
      );
    expect(await decide([wake, [text("[Outside bb] recalled")]])).toEqual({ action: "proceed" });
    expect(await decide([[text("my reply")], [text("[Outside bb] recalled")]])).toEqual(refused);
    expect(await decide([wake, [text("my reply")]])).toEqual({ action: "proceed" });
    expect(await decide([wake, wake])).toEqual({ action: "proceed" });
  });
});

describe("BUG 4: another machine", () => {
  const hook = (w: World) => w.harness.inspection.registrations.hooks["message.dispatch"]!;
  const send = (w: World, host: { id: string } | null, providerId = "hermes") =>
    hook(w)(makeMessageDispatchHookContext({ thread: { providerId }, host, input: { blocks: [{ type: "text", mentions: [], text: "hi" }], text: "hi" } }));

  it("provider options carry the Hermes machine's name as hosts.list gave it", async () => {
    const w = await world();
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_x" }).machine).toEqual({ id: MACHINE, name: null });
    await w.connect();
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_x" }).machine).toEqual({ id: MACHINE, name: "hermes-mac" });
    // Another machine saved: no stale name.
    w.db.prepare(`UPDATE kv SET value = '"host_other"' WHERE key = 'machine'`).run();
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_x" }).machine).toEqual({ id: "host_other", name: null });
  });

  it("the dispatch hook refuses a Hermes thread on another machine with its name; the Hermes machine, an unknown host and other providers pass", async () => {
    const w = await world();
    await w.connect();
    expect(await send(w, { id: "host_work" })).toEqual({ action: "reject", message: otherMachineText("hermes-mac") });
    expect(otherMachineText("hermes-mac")).toBe("Hermes runs on hermes-mac: add `--machine hermes-mac`.");
    expect(await send(w, { id: MACHINE })).toEqual({ action: "proceed" });
    expect(await send(w, null)).toEqual({ action: "proceed" });
    expect(await send(w, { id: "host_work" }, "codex")).toEqual({ action: "proceed" });
  });
});

describe("A49: a thread the user archived", () => {
  it("a wake into it is refused by bb: the claim goes back, no error; unarchiving it wakes at once", async () => {
    const w = await botChatWorld([turn("u1")]);
    chat(w, "c1");
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    for (const id of [t, "thr_1"]) w.thread(id).archivedAt = 5;
    w.history.get("c1")!.turns.push(turn("c1-3"));
    w.history.get("root_bc")!.turns.push(turn("u2"));
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers(t).filter((m) => m.op === "mirror")).toEqual([]);
    expect(turnRow(w.db, t, "c1-3")).toBeNull();
    expect((await w.rpc<Diagnostics>("diagnostics")).errors).toEqual([]);
    for (const id of [t, "thr_1"]) {
      w.thread(id).archivedAt = null;
      await w.emit("thread.unarchived", id);
    }
    expect(w.markers(t).filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "c1-3", labeled: true }]);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2", labeled: true }]);
    expect((await w.rpc<Diagnostics>("diagnostics")).errors).toEqual([]);
  });
});

describe("review 2: a failed render never loses its reply", () => {
  it("a wake whose render failed (no bridge record, thread.failed) settles partial with no reply rows once quiet; a rest wake shows the reply", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    await drain(w);
    w.history.get("root_bc")!.turns.push(turn("u2"));
    await w.changed(NEO);
    // The bridge's history read timed out: the turn fails, no record.
    Object.assign(w.thread("thr_1"), { status: "error", queued: 0 });
    await w.emit("thread.failed" as never, "thr_1");
    expect(turnRow(w.db, "thr_1", "u2")?.state).toBe("queued");
    await w.quiet();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([
      { op: "mirror", anchor_uid: "u2", labeled: true },
      { op: "mirror", anchor_uid: "u2", rest: true },
    ]);
    w.render("thr_1");
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ state: "done", reply_uids: ["u2-r"] });
  });

  it("bb's dispatch gap never settles a row the bridge hasn't recorded yet", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    await drain(w);
    w.history.get("root_bc")!.turns.push(turn("u2"));
    await w.changed(NEO);
    // Idle with nothing queued before the wake ran: no record yet.
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")?.state).toBe("queued");
    await w.active("thr_1");
    w.render("thr_1");
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ state: "done", reply_uids: ["u2-r"] });
    await w.quiet();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toHaveLength(1);
  });

  it("an import turn whose render failed shows its reply by a rest wake once the thread is live", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    const t = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    // The bridge records c1-1 only; c1-2's render failed.
    w.persisted(t, { profile_home: NEO, lineage_root: "c1", session_id: "c1", turns: [], mirrored: [{ anchor_uid: "c1-1", reply_uids: ["c1-1-r"], partial: false, at: 1 }] });
    await w.idle(t);
    await w.quiet();
    expect(bindingByThread(w.db, t)?.state).toBe("live");
    expect(turnRow(w.db, t, "c1-2")).toMatchObject({ state: "queued" });
    expect(w.markers(t).at(-1)).toEqual({ op: "mirror", anchor_uid: "c1-2", rest: true });
  });
});

describe("e2e: unread race at an import's end", () => {
  it("latestAttentionAt moving just after the end's stop is marked read again after a quiet period (D48 switch-on)", async () => {
    const w = await botChatWorld([]);
    await on(w);
    await drain(w);
    await w.rpc("setBot", { profile_home: NEO, on: false });
    chat(w, "c9", { last_activity_at: Date.now() });
    w.state.lateAttention = true;
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c9")!.thread_id;
    expect(w.thread(t).visibility).toBe("visible");
    await w.quiet();
    expect(isRead(w, t)).toBe(true);
  });
});

describe("e2e: diagnostics after an A38 redo", () => {
  it("jobs for a hidden thread the server deleted itself end silently", async () => {
    const w = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, ?)`).run(NEO, Date.now());
        insertBinding(db, { thread_id: "thr_old", profile_home: NEO, lineage_root: "c1", session_id: "c1", expected_id: null, kind: "mirror", source: "cli", tag: null, state: "replaying", legacy: false, archived_by_switch: false, title_set: null });
        for (const a of ["c1-1", "c1-2"]) db.prepare(`INSERT INTO turns (thread_id, anchor_uid, kind, state, at) VALUES ('thr_old', ?, 'replay', 'queued', 1)`).run(a);
      },
    });
    w.threads.set("thr_old", { ...fakeThread("thr_old"), title: "Chat c1" });
    // Its import's sends ran before the restart: boot recovery finds them.
    for (const a of ["c1-1", "c1-2"]) w.event("thr_old", "client/turn/requested", { input: [{ type: "text", text: `<hermes-bb>{"op":"replay","anchor_uid":"${a}"}</hermes-bb>` }] });
    chat(w, "c1");
    await w.connect();
    await w.emit("thread.idle", "thr_old").catch(() => undefined);
    await drain(w);
    expect(mirrors(w)).toHaveLength(1);
    expect((await w.rpc<Diagnostics>("diagnostics")).errors).toEqual([]);
  });
});

describe("review 4: a turn after the cutoff is news, not an import", () => {
  it("a Bot Chat found after the switch-on imports only its turns from before enabled_at; later ones wake as outside turns, unread", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await drain(w);
    const enabledAt = botRecord(w.db, NEO)!.enabled_at!;
    // Another bot's DM creates the Bot Chat days later, then talks in it.
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "root_bc", legacy: false });
    w.history.set("root_bc", { session_id: "root_bc", turns: [turn("old", { ts: enabledAt - DAY }), turn("new", { ts: enabledAt + DAY })] });
    await w.changed(NEO);
    await drain(w);
    expect(w.markers("thr_1").filter((m) => m.op !== "init")).toEqual([
      { op: "bind", profile_home: NEO, lineage_root: "root_bc", legacy: false, anchor_uid: "old", labeled: true },
      { op: "mirror", anchor_uid: "new", labeled: true },
    ]);
    expect(w.texts("thr_1")).toEqual([`${outsideTag(new Date(enabledAt - DAY))}text old`, "[Outside bb] text new"]);
    expect(isRead(w, "thr_1")).toBe(false);
  });

  it("a first-pass chat's turn that comes while it waits for a slot wakes after its import, unread", async () => {
    const w = await botChatWorld([]);
    for (let i = 1; i <= 3; i++) chat(w, `c${i}`, { last_activity_at: Date.now() - (10 - i) * DAY });
    await on(w);
    w.history.get("c3")!.turns.push(turn("c3-3", { ts: Date.now() + 1 }));
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c3")!.thread_id;
    expect(w.markers(t).map((m) => m.op)).toEqual(["bind", "replay", "mirror"]);
    expect(w.texts(t).at(-1)).toBe("[Outside bb] text c3-3");
    expect(isRead(w, t)).toBe(false);
    expect(isRead(w, bindingByLineage(w.db, NEO, "c1")!.thread_id)).toBe(true);
  });
});

describe("review 3: a server restart mid-import", () => {
  it("keeps the hold of a thread with queued rows and re-flags the bot thread's import for read", async () => {
    const w = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, ?)`).run(NEO, Date.now());
        insertBinding(db, { thread_id: "thr_bot", profile_home: NEO, lineage_root: "root_bc", session_id: "root_bc", expected_id: null, kind: "bot", source: null, tag: null, state: "replaying", legacy: false, archived_by_switch: false, title_set: null });
        db.prepare(`INSERT INTO turns (thread_id, anchor_uid, kind, state, at) VALUES ('thr_bot', 'u1', 'replay', 'queued', 1)`).run();
        db.prepare(`INSERT INTO kv (key, value) VALUES ('notify_restore', '{"thr_bot":"all"}')`).run();
      },
    });
    expect(w.levelCalls).toEqual([]);
    w.threads.set("thr_bot", { ...fakeThread("thr_bot"), visibility: "visible", pinned: true, inputs: [[encodeMarker({ op: "bind", profile_home: NEO, lineage_root: "root_bc", legacy: false, anchor_uid: "u1" })]] });
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "root_bc", legacy: false });
    w.history.set("root_bc", { session_id: "root_bc", turns: [turn("u1")] });
    w.event("thr_bot", "client/turn/requested", { input: [{ type: "text", text: '<hermes-bb>{"op":"bind","anchor_uid":"u1"}</hermes-bb>' }] });
    await w.connect();
    await drain(w);
    expect(turnRow(w.db, "thr_bot", "u1")?.state).toBe("done");
    expect(isRead(w, "thr_bot")).toBe(true);
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levelCalls).toEqual([{ threadId: "thr_bot", level: "all" }]);
  });
});

describe("review 8: the first pass across a restart", () => {
  it("keeps its start: a chat begun after it (before the restart) ends unread, an older one read", async () => {
    const enabledAt = Date.now() - 3 * DAY;
    const w = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, ?)`).run(NEO, enabledAt);
        db.prepare(`INSERT INTO kv (key, value) VALUES ('discovered', ?)`).run(JSON.stringify({ [NEO]: { enabled_at: enabledAt, started_at: Date.now() - 2 * DAY, finished: false } }));
      },
    });
    chat(w, "old", { last_activity_at: Date.now() - 2.5 * DAY }, [turn("o1", { ts: Date.now() - 2.5 * DAY })]);
    chat(w, "new", { last_activity_at: Date.now() - DAY });
    await w.connect();
    await drain(w);
    expect(isRead(w, bindingByLineage(w.db, NEO, "old")!.thread_id)).toBe(true);
    expect(isRead(w, bindingByLineage(w.db, NEO, "new")!.thread_id)).toBe(false);
  });
});

describe("e2e: a legacy chat adopted by bb's first send", () => {
  it("clears bindings.legacy from persisted-turn, for a mirrored thread too", async () => {
    const w = await botChatWorld([]);
    chat(w, "c4", { source: "desktop", created_source: null, legacy: true });
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c4")!.thread_id;
    expect(bindingByThread(w.db, t)?.legacy).toBe(true);
    w.persisted(t, { profile_home: NEO, lineage_root: "c4", session_id: "c4", turns: [{ submission_id: `bb:${t}:1`, anchor_uids: ["b1"], reply_uids: [], at: 1 }] });
    await w.idle(t);
    expect(bindingByThread(w.db, t)?.legacy).toBe(false);
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: t }).thread?.legacy).toBe(false);
  });
});

describe("review 5: the user's own send behind an init or import", () => {
  it("releases the hold (approvals push) and drops the read flag; a plugin wake doesn't", async () => {
    const w = await botChatWorld([]);
    await on(w);
    await drain(w);
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    expect(w.levels.get(chat)).toBe("muted");
    const hook = w.harness.inspection.registrations.hooks["message.dispatch"]!;
    const dispatch = (initiator: "user" | "system", blocks: ReturnType<typeof encodeMarker>[] | { type: "text"; mentions: never[]; text: string }[]) =>
      hook(makeMessageDispatchHookContext({ thread: { id: chat, providerId: "hermes" }, initiator, input: { blocks, text: "" } }));
    expect(await dispatch("system", [encodeMarker({ op: "mirror", anchor_uid: "x" })])).toEqual({ action: "proceed" });
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levels.get(chat)).toBe("muted");
    expect(await dispatch("user", [{ type: "text", mentions: [], text: "plan my week" }])).toEqual({ action: "proceed" });
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levels.get(chat)).toBe("inherit");
    // The init and the user's turn end: the user's reply stays unread (their own turn's attention is bb's).
    await w.idle(chat);
    await w.quiet();
    expect(calls(w, "threads.markRead").map((a) => a.threadId)).not.toContain(chat);
  });
});

describe("review 6 and 11: a stalled import never holds a slot", () => {
  it("an import whose end failed is redone at the next reconcile, not only at a worker reboot", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    const first = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    w.harness.inspection.sdk.stub("threads.stop", async () => {
      throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
    });
    await drain(w);
    expect(bindingByThread(w.db, first)?.state).toBe("replaying");
    w.harness.inspection.sdk.stub("threads.stop", async ({ threadId }: { threadId: string }) => w.dto(threadId));
    await w.changed(NEO);
    await drain(w);
    expect(bindingByLineage(w.db, NEO, "c1")).toMatchObject({ state: "live" });
    expect(bindingByLineage(w.db, NEO, "c1")!.thread_id).not.toBe(first);
  });

  it("a send failure mid-import frees its slot at once; the import runs again at the next reconcile", async () => {
    const w = await botChatWorld([]);
    for (let i = 1; i <= 3; i++) chat(w, `c${i}`, { last_activity_at: Date.now() - (10 - i) * DAY });
    // c1's bind goes out, its replay fails; c2 and c3 then take the slots.
    let sends = 0;
    w.harness.inspection.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: never[] }) => {
      const t = w.thread(threadId);
      if (bindingByThread(w.db, threadId)?.kind === "mirror" && ++sends === 2) throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
      t.inputs.push(input);
      t.queued++;
      return { ok: true, delivery: "sent" };
    });
    await on(w);
    expect(hidden(w).map((t) => t.title).sort()).toEqual(["Chat c1", "Chat c2", "Chat c3"]);
    await drain(w);
    expect(["c2", "c3"].map((id) => bindingByLineage(w.db, NEO, id)?.state)).toEqual(["live", "live"]);
    await w.changed(NEO);
    await drain(w);
    expect(bindingByLineage(w.db, NEO, "c1")).toMatchObject({ state: "live" });
    expect(mirrors(w)).toHaveLength(3);
  });
});

describe("review 7: D48 unarchive failures", () => {
  it("a failed unarchive keeps archived_by_switch (retried at the next switch-on); a failing bot-thread unarchive doesn't abort the switch-on", async () => {
    const w = await botChatWorld([]);
    chat(w, "c1");
    await on(w);
    await drain(w);
    const t = bindingByLineage(w.db, NEO, "c1")!.thread_id;
    await w.rpc("setBot", { profile_home: NEO, on: false });
    chat(w, "c2", { last_activity_at: Date.now() });
    w.harness.inspection.sdk.stub("threads.unarchive", async () => {
      throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
    });
    await on(w);
    // The switch-on went on: c2 imports.
    expect(bindingByLineage(w.db, NEO, "c2")).not.toBeNull();
    expect(bindingByThread(w.db, t)?.archived_by_switch).toBe(true);
    expect(bindingByThread(w.db, "thr_1")?.archived_by_switch).toBe(true);
    w.harness.inspection.sdk.stub("threads.unarchive", async ({ threadId }: { threadId: string }) => ((w.thread(threadId).archivedAt = null), w.dto(threadId)));
    await w.rpc("setBot", { profile_home: NEO, on: false });
    await on(w);
    expect([w.thread(t).archivedAt, w.thread("thr_1").archivedAt]).toEqual([null, null]);
    expect(bindingByThread(w.db, t)?.archived_by_switch).toBe(false);
  });
});

describe("review 10: the bot thread follows a new Bot Chat", () => {
  it("tombstones the old one: renamed and visible in Hermes now, its turns are in the bot thread already and never import again", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    await drain(w);
    w.history.set("root_new", { session_id: "root_new", turns: [turn("b2", { submission_id: null })] });
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_new", session_id: "root_new", turns: [{ submission_id: "bb:thr_1:c2", anchor_uids: ["b2"], reply_uids: [], at: 2 }] });
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")?.lineage_root).toBe("root_new");
    expect(tombstones(w)).toEqual([{ profile_home: NEO, lineage_root: "root_bc" }]);
    // The old Bot Chat, renamed in Hermes, now lists.
    chat(w, "root_bc", { title: "Old Bot Chat" }, [turn("u1")]);
    await w.changed(NEO);
    await drain(w);
    expect(mirrors(w)).toEqual([]);
  });
});

describe("review 12 and 13", () => {
  it("a side chat's title never comes from a wake's label (an entry with a marker)", async () => {
    const w = await botChatWorld([]);
    await on(w);
    await drain(w);
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    w.prompts.set(chat, [
      { createdAt: 1, id: "p1", input: [{ type: "image", url: "x" } as never] },
      { createdAt: 2, id: "p2", input: [{ type: "text", mentions: [], text: "[Outside bb] from the CLI" }, encodeMarker({ op: "mirror", anchor_uid: "s2", labeled: true })] },
    ]);
    await w.idle(chat);
    expect(w.thread(chat).title).toBe("New Neo chat");
    w.prompts.get(chat)!.push({ createdAt: 3, id: "p3", input: [{ type: "text", mentions: [], text: "my own words" }] });
    await w.idle(chat);
    expect(w.thread(chat).title).toBe("my own words");
  });

  it("a failed wake send releases its input-only hold when nothing else holds the thread", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    await drain(w);
    await w.elapse(RESTORE_DELAY_MS);
    w.history.get("root_bc")!.turns.push(turn("u2"));
    w.state.failSend = 1;
    await w.changed(NEO);
    expect(turnRow(w.db, "thr_1", "u2")).toBeNull();
    await w.elapse(RESTORE_DELAY_MS);
    expect(w.levelCalls.at(-1)).toEqual({ threadId: "thr_1", level: "inherit" });
  });
});

describe("review 14: dispose", () => {
  it("jobs still queued at dispose arm no timer", async () => {
    const w = await botChatWorld([turn("u1")]);
    await on(w);
    w.render("thr_1");
    const t = w.thread("thr_1");
    Object.assign(t, { status: "idle", queued: 0, latestAttentionAt: ++w.state.clock });
    // The idle's finalize (markRead, then a confirm timer) is still on the queue when the plugin goes.
    await w.harness.behavior.emitThreadEvent("thread.idle", { thread: w.dto("thr_1"), lastAssistantText: null });
    await w.harness.lifecycle.dispose();
    await w.flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});
