import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRow } from "../shared/rpc-contract.js";
import { bindingByThread } from "./db.js";
import { NEO, turn, world, type World } from "./fake-world.js";
import { RESTORE_DELAY_MS } from "./notify.js";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

const on = (w: World, profile_home = NEO) => w.rpc<BotRow>("setBot", { profile_home, on: true });
const calls = (w: World, path: string) => w.harness.inspection.sdk.callsTo(path).map((args) => args[0] as Record<string, unknown>);
const isRead = (w: World, threadId: string) => {
  const t = w.thread(threadId);
  return (t.lastReadAt ?? -1) >= t.latestAttentionAt;
};
const tombstones = (w: World) => w.db.prepare(`SELECT profile_home, lineage_root FROM tombstones ORDER BY lineage_root`).all();

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
