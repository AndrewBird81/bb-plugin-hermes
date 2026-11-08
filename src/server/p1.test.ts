import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderOptions } from "../shared/provider-options.js";
import type { BotRow, Diagnostics, ThreadInfo } from "../shared/rpc-contract.js";
import { formatTag } from "../shared/sources.js";
import { HELD_RETRY_MS } from "./bots.js";
import { bindingByThread, botRecord, claimTurn, MIGRATIONS, openMappingDb, turnRow } from "./db.js";
import { BOB, MACHINE, NEO, turn, UID, world, type World } from "./fake-world.js";
import { RESTORE_DELAY_MS } from "./notify.js";
import { deriveProviderOptions } from "./provider-options.js";
import { IMPORT_WINDOW_MS } from "./sync.js";

afterEach(() => vi.useRealTimers());

const on = (w: World, profile_home = NEO) => w.rpc<BotRow>("setBot", { profile_home, on: true });
const off = (w: World, profile_home = NEO) => w.rpc<BotRow>("setBot", { profile_home, on: false });
const calls = (w: World, path: string) => w.harness.inspection.sdk.callsTo(path).map((args) => (args[0] as { threadId: string }).threadId);
const errors = async (w: World) => (await w.rpc<Diagnostics>("diagnostics")).errors;

/** A connected world with neo on and its Bot Chat bound and live (turn `u1` imported). */
async function liveBotThread(turns = [turn("u1")]) {
  const w = await world();
  await w.connect();
  w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: false });
  w.history.set("root_bc", { session_id: "tip_bc", turns });
  await on(w);
  await w.idle("thr_1");
  expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "live" });
  return w;
}

describe("switches (T1.9)", () => {
  it("fresh install: every bot off, 0 skills, 0 threads; unserved bots are refused", async () => {
    const w = await world();
    await w.connect();
    const { bots } = await w.rpc<{ bots: BotRow[] }>("bots");
    expect(bots).toEqual([
      { profile: "neo", profile_home: NEO, bot_label: "Neo", served: true, enabled: false, thread_id: null, import_count: null },
      { profile: "bob", profile_home: BOB, bot_label: "Bob", served: false, enabled: false, thread_id: null, import_count: null },
    ]);
    expect(w.access).toEqual([]);
    expect(w.threads.size).toBe(0);
    await expect(w.harness.behavior.callRpc("setBot", { profile_home: BOB, on: true })).rejects.toThrow("Not served");
  });

  it("on: skill, a pinned bot thread with an init marker, muted until its init ends read", async () => {
    const w = await world();
    await w.connect();
    const row = await on(w);
    expect(row).toMatchObject({ enabled: true, thread_id: "thr_1" });
    expect(w.access).toEqual([{ profile_home: NEO, on: true, enabled_bots: [NEO] }]);
    expect(w.hostCalls("ensureWatch").at(-1)?.input).toEqual({ root: "~/.hermes", enabled_bots: [NEO] });
    expect(w.thread("thr_1").spawn).toMatchObject({
      projectId: "proj_personal",
      providerId: "hermes",
      environment: { type: "host", hostId: MACHINE, workspace: { type: "personal" } },
      sessionOptions: { profile: "neo" },
      title: "Neo",
      pinned: true,
      pluginMetadata: { hermes: { origin: "switch" } },
    });
    expect(w.markers("thr_1")).toEqual([{ op: "init", profile: "neo", bot: true }]);
    expect(w.levels.get("thr_1")).toBe("muted");
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ kind: "bot", state: "pending", profile_home: NEO });
    // findBotChat said none: stays pending until the first send creates the Bot Chat.
    expect(w.hostCalls("findBotChat")).toHaveLength(1);
    expect(calls(w, "threads.markRead")).toEqual([]);
    await w.idle("thr_1");
    expect(calls(w, "threads.markRead")).toEqual(["thr_1"]);
  });

  it("off → on: 0 new threads; only threads the switch archived come back", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    const { thread_id: userArchived } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    w.thread(userArchived).archivedAt = 5;

    await off(w);
    expect(botRecord(w.db, NEO)?.enabled).toBe(false);
    expect([w.thread("thr_1").archivedAt, w.thread(chat).archivedAt, w.thread(userArchived).archivedAt]).toEqual([1, 1, 5]);
    expect(bindingByThread(w.db, userArchived)?.archived_by_switch).toBe(false);
    expect(w.access.at(-1)).toEqual({ profile_home: NEO, on: false, enabled_bots: [] });
    expect(w.hostCalls("ensureWatch").at(-1)?.input).toEqual({ root: "~/.hermes", enabled_bots: [] });

    const before = w.threads.size;
    await on(w);
    expect(w.threads.size).toBe(before);
    expect([w.thread("thr_1").archivedAt, w.thread(chat).archivedAt, w.thread(userArchived).archivedAt]).toEqual([null, null, 5]);
    expect(bindingByThread(w.db, chat)?.archived_by_switch).toBe(false);
  });

  it("a failed setBotAccess (off) is retried at the next reconnect, so the skill never stays", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    w.state.failAccess = true;
    await off(w);
    expect(w.access.at(-1)?.on).toBe(true);
    w.state.failAccess = false;
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.access.at(-1)).toEqual({ profile_home: NEO, on: false, enabled_bots: [] });
  });

  it("a deleted bot thread is re-created, pinned, at the next reconcile", async () => {
    const w = await liveBotThread();
    w.thread("thr_1").deletedAt = 9;
    await w.emit("thread.deleted", "thr_1");
    expect(bindingByThread(w.db, "thr_1")).toBeNull();
    await w.changed(NEO);
    const bot = (await w.rpc<{ bots: BotRow[] }>("bots")).bots[0]!;
    expect(bot.thread_id).not.toBe("thr_1");
    expect(w.thread(bot.thread_id!)).toMatchObject({ pinned: true, title: "Neo" });
  });

  it("held: findBotChat retries at 2, 5, 10, 30 s, then binds when Conduit lets go", async () => {
    const w = await world();
    await w.connect();
    w.botChats.set(NEO, { state: "held" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await on(w);
    expect(w.hostCalls("findBotChat")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HELD_RETRY_MS[0]!);
    await w.flush();
    expect(w.hostCalls("findBotChat")).toHaveLength(2);
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: true });
    w.history.set("root_bc", { session_id: "tip_bc", turns: [] });
    await vi.advanceTimersByTimeAsync(HELD_RETRY_MS[1]!);
    await w.flush();
    expect(w.hostCalls("findBotChat")).toHaveLength(3);
    // No turns to import: live at once.
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ lineage_root: "root_bc", legacy: true, state: "live" });
    await vi.advanceTimersByTimeAsync(60_000);
    await w.flush();
    expect(w.hostCalls("findBotChat")).toHaveLength(3);
  });
});

describe("Bot Chat import (T1.11)", () => {
  it("bind, then one replay per turn; tagged with source and date, bb's own untagged; silent; live at idle", async () => {
    const w = await world();
    await w.connect();
    const ts = Date.now() - 2 * 86_400_000;
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: true });
    w.history.set("root_bc", {
      session_id: "tip_bc",
      truncated: true,
      turns: [
        turn("u1", { surface: "desktop", ts }),
        turn("u2", { submission_id: "bb:thr_x:1", user_text: "mine", ts }),
        turn("u3", { user_hidden: true, user_text: null, ts }),
      ],
    });
    await on(w);
    const enabledAt = botRecord(w.db, NEO)!.enabled_at!;
    expect(w.markers("thr_1")).toEqual([
      { op: "init", profile: "neo", bot: true },
      { op: "bind", profile_home: NEO, lineage_root: "root_bc", legacy: true, anchor_uid: "u1", since: enabledAt - IMPORT_WINDOW_MS },
      { op: "replay", anchor_uid: "u2" },
      { op: "replay", anchor_uid: "u3" },
    ]);
    expect(w.texts("thr_1")).toEqual([`${formatTag("Conduit", new Date(ts))}text u1`, "mine"]);
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "replaying", cursor_uid: "u3" });
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ kind: "replay", state: "queued" });

    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")?.state).toBe("live");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ kind: "replay", state: "done" });
    expect(calls(w, "threads.markRead")).toEqual(["thr_1"]);
    // 0 pushes: muted throughout, never another level.
    expect(w.levelCalls).toEqual([{ threadId: "thr_1", level: "muted" }]);
    // A re-list imports nothing again.
    await w.changed(NEO);
    expect(w.markers("thr_1")).toHaveLength(4);
  });

  it("an import whose send failed stays replaying at idle and resumes at the next reconcile", async () => {
    const w = await world();
    await w.connect();
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: false });
    w.history.set("root_bc", { session_id: "tip_bc", turns: [turn("u1"), turn("u2")] });
    w.state.failSend = 0;
    w.harness.inspection.sdk.stub("threads.send", async () => {
      throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
    });
    await on(w);
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")?.state).toBe("replaying");
    expect(turnRow(w.db, "thr_1", "u1")).toBeNull();
    w.harness.inspection.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: never[] }) => {
      w.thread(threadId).inputs.push(input);
      return { ok: true, delivery: "sent" };
    });
    await w.changed(NEO);
    expect(w.markers("thr_1").map((m) => m.op)).toEqual(["init", "bind", "replay"]);
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")?.state).toBe("live");
  });
});

describe("wakes (T1.11)", () => {
  it("3 re-lists during one outside turn → 1 wake, input-only, then the user's level again", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2", { complete: false, reply_uids: [] }));
    await w.changed(NEO);
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2" }]);
    expect(w.texts("thr_1").at(-1)).toBe("[CLI] text u2");
    expect(w.levels.get("thr_1")).toBe("input-only");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ kind: "mirror", state: "partial", reply_uids: [] });
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY_MS);
    await w.flush();
    expect(w.levels.get("thr_1")).toBe("inherit");
  });

  it("the bridge's mirrored record decides rest: a streamed turn never rests; Conduit's own turn rests once", async () => {
    const w = await liveBotThread();
    const chat = w.history.get("root_bc")!;
    // A CLI turn, running at the wake; the bridge streams it whole. Hermes' re-read at idle still lags.
    chat.turns.push(turn("u2", { complete: false, reply_uids: [] }));
    await w.changed(NEO);
    const record = (anchor: string, reply_uids: string[], partial: boolean, at: number) => ({ anchor_uid: anchor, reply_uids, partial, at });
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored: [record("u2", ["u2-a", "u2-b"], false, 1)] });
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ state: "done", reply_uids: ["u2-a", "u2-b"] });
    chat.turns[1] = turn("u2", { reply_uids: ["u2-a", "u2-b"] });
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2" }]);

    // Conduit's own turn: the bridge shows the bubble only and closes partial; the reply rows come later.
    chat.turns.push(turn("u3", { surface: null, reply_uids: [] }));
    await w.changed(NEO);
    expect(w.texts("thr_1").at(-1)).toBe("[Conduit] text u3");
    const mirrored = [record("u2", ["u2-a", "u2-b"], false, 1), record("u3", [], true, 2)];
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored });
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u3")).toMatchObject({ state: "partial", reply_uids: [] });
    chat.turns[2] = turn("u3", { surface: null, reply_uids: ["u3-r"] });
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror").at(-1)).toEqual({ op: "mirror", anchor_uid: "u3", rest: true });
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored: [...mirrored, record("u3", ["u3-r"], false, 3)] });
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u3")).toMatchObject({ state: "done", reply_uids: ["u3-r"] });
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toHaveLength(3);
    expect(bindingByThread(w.db, "thr_1")?.cursor_uid).toBe("u3");
  });

  it("a hidden user row wakes with the marker only; a later reply wakes once as rest", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2", { user_hidden: true, user_text: null, complete: false, reply_uids: [] }));
    await w.changed(NEO);
    const texts = w.texts("thr_1").length;
    await w.idle("thr_1");
    w.history.get("root_bc")!.turns[1] = turn("u2", { user_hidden: true, user_text: null, reply_uids: ["r1", "r2"] });
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([
      { op: "mirror", anchor_uid: "u2" },
      { op: "mirror", anchor_uid: "u2", rest: true },
    ]);
    expect(w.texts("thr_1")).toHaveLength(texts);
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ state: "done", reply_uids: ["r1", "r2"] });
    expect(bindingByThread(w.db, "thr_1")?.cursor_uid).toBe("u2");
  });

  it("a failed send deletes its claim; the next re-list wakes it", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2"), turn("u3"));
    w.state.failSend = 1;
    await w.changed(NEO);
    expect(turnRow(w.db, "thr_1", "u2")).toBeNull();
    // Order kept: u3 waits behind the failed u2.
    expect(turnRow(w.db, "thr_1", "u3")).toBeNull();
    expect(await errors(w)).toContain("unavailable");
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror").map((m) => (m as { anchor_uid: string }).anchor_uid)).toEqual(["u2", "u3"]);
  });

  it("orphaned queued rows recover on boot: no bb turn → re-sent; a bb turn → settled at idle", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2"), turn("u3"));
    // A previous run claimed u2 and died before its send; it sent u3's wake.
    claimTurn(w.db, { thread_id: "thr_1", anchor_uid: "u2", kind: "mirror", at: 1 });
    claimTurn(w.db, { thread_id: "thr_1", anchor_uid: "u3", kind: "mirror", at: 2 });
    w.event("thr_1", "client/turn/requested", { input: [{ type: "text", text: '<hermes-bb>{"op":"mirror","anchor_uid":"u3"}</hermes-bb>' }] });
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2" }]);
    expect(turnRow(w.db, "thr_1", "u3")?.state).toBe("done");
  });

  it("not_supported pauses wakes", async () => {
    const w = await liveBotThread();
    w.state.supported = false;
    expect((await w.connect()) as { state: string }).toMatchObject({ state: "not_supported" });
    w.history.get("root_bc")!.turns.push(turn("u2"));
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([]);
    w.state.supported = true;
    await w.connect();
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2" }]);
  });
});

describe("side chats and bb's own turns (T1.10, T1.11)", () => {
  it("newChat: placeholder title, init marker, expected_id; refuses off and unknown bots", async () => {
    const w = await world();
    await w.connect();
    await expect(w.harness.behavior.callRpc("newChat", { profile: "neo" })).rejects.toThrow("Neo is switched off in the Hermes plugin settings.");
    await expect(w.harness.behavior.callRpc("newChat", { profile: "zed" })).rejects.toThrow("Unknown bot");
    await on(w);
    const { thread_id } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    expect(w.thread(thread_id).spawn).toMatchObject({ title: "New Neo chat", sessionOptions: { profile: "neo" }, pluginMetadata: { hermes: { origin: "newChat" } } });
    expect(w.thread(thread_id).pinned).toBe(false);
    expect(w.markers(thread_id)).toEqual([{ op: "init", profile: "neo" }]);
    const expected = `local-${createHash("sha256").update(JSON.stringify([NEO, `uid:${UID}`, `bb:${thread_id}`])).digest("hex")}`;
    expect(bindingByThread(w.db, thread_id)).toMatchObject({ kind: "chat", state: "pending", expected_id: expected });
    expect(w.levels.get(thread_id)).toBe("muted");
    await w.idle(thread_id);
    expect(calls(w, "threads.markRead")).toContain(thread_id);
  });

  it("re-listed before its first boundary → no mirror; bb's own turn never wakes, even without its submission_id", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    await w.idle(chat);
    const sid = bindingByThread(w.db, chat)!.expected_id!;
    // bb's first send created the session; Hermes lists it before the bridge's turn boundary.
    await w.active(chat);
    w.history.set(sid, { session_id: sid, turns: [turn("s1", { submission_id: null, complete: false })] });
    await w.changed(NEO);
    expect(w.markers(chat)).toHaveLength(1);

    // The turn settles: the bridge publishes `persisted-turn`; the `submission_id` read still failed.
    w.history.set(sid, { session_id: sid, turns: [turn("s1", { submission_id: null })] });
    w.persisted(chat, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${chat}:c1`, anchor_uids: ["s1"], reply_uids: ["s1-r"], at: 1 }] });
    await w.idle(chat);
    expect(bindingByThread(w.db, chat)).toMatchObject({ state: "live", lineage_root: sid, session_id: sid, cursor_uid: "s1" });
    expect(turnRow(w.db, chat, "s1")).toMatchObject({ kind: "bb", state: "done" });

    // An outside turn after it wakes; bb's never does.
    w.history.get(sid)!.turns.push(turn("s2", { surface: "tui" }));
    await w.changed(NEO);
    expect(w.markers(chat).slice(1)).toEqual([{ op: "mirror", anchor_uid: "s2" }]);
    expect(w.texts(chat).at(-1)).toBe("[TUI] text s2");
  });

  it("a bb turn with no persisted record yet is never woken while its thread runs", async () => {
    const w = await liveBotThread();
    await w.active("thr_1");
    w.history.get("root_bc")!.turns.push(turn("b1", { submission_id: null }));
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([]);
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [{ submission_id: "bb:thr_1:c1", anchor_uids: ["b1"], reply_uids: [], at: 1 }] });
    await w.emit("experimental_thread.events" as never, "thr_1");
    await w.idle("thr_1");
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([]);
  });

  it("bot thread: bb's first send creates the Bot Chat → bound from its record, nothing imported; a moved title is followed", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    await w.active("thr_1");
    w.botChats.set(NEO, { state: "found", lineage_root: "root_new", session_id: "root_new", legacy: false });
    w.history.set("root_new", { session_id: "root_new", turns: [turn("b1", { submission_id: null })] });
    // Lookups wait while bb's turn runs.
    await w.changed(NEO);
    expect(bindingByThread(w.db, "thr_1")?.state).toBe("pending");
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_new", session_id: "root_new", turns: [{ submission_id: "bb:thr_1:c1", anchor_uids: ["b1"], reply_uids: [], at: 1 }] });
    await w.idle("thr_1");
    await w.changed(NEO);
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "live", lineage_root: "root_new", cursor_uid: "b1" });
    expect(w.markers("thr_1").map((m) => m.op)).toEqual(["init"]);

    // Hermes moved the `Bot Chat` title to a new chat; bb's next turn ran there.
    w.history.set("root_moved", { session_id: "root_moved", turns: [turn("x1"), turn("b2", { submission_id: null })] });
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_moved", session_id: "root_moved", turns: [{ submission_id: "bb:thr_1:c2", anchor_uids: ["b2"], reply_uids: [], at: 2 }] });
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ lineage_root: "root_moved", cursor_uid: "b2" });
    expect(w.markers("thr_1").map((m) => m.op)).toEqual(["init"]);
  });

  it("the first visible message becomes the title, cut to 60 characters", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    const { thread_id } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    const long = "  Plan   my week: " + "x".repeat(80);
    w.prompts.set(thread_id, [{ createdAt: 1, id: "p1", input: [{ type: "text", mentions: [], text: long }] }]);
    await w.idle(thread_id);
    expect(w.thread(thread_id).title).toBe(("Plan my week: " + "x".repeat(80)).slice(0, 60));
    // Renamed in bb afterwards: never touched again.
    w.thread(thread_id).title = "Mine";
    await w.idle(thread_id);
    expect(w.thread(thread_id).title).toBe("Mine");
  });

  it("thread.created binds a `bb thread spawn` chat; our own spawns are skipped", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    w.threads.set("thr_cli", { ...w.thread("thr_1"), id: "thr_cli", originPluginId: null, pinned: false, inputs: [] });
    w.event("thr_cli", "client/thread/start", { request: { method: "thread/start", params: { options: { sessionOptions: { profile: "neo" } } } } });
    await w.emit("thread.created", "thr_cli");
    expect(bindingByThread(w.db, "thr_cli")).toMatchObject({ kind: "chat", state: "pending", profile_home: NEO });
    await w.emit("thread.created", "thr_1");
    expect(bindingByThread(w.db, "thr_1")?.kind).toBe("bot");
  });

  it("stopHosted stops idle threads now and busy ones at their idle", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    const { thread_id: chat } = await w.rpc<{ thread_id: string }>("newChat", { profile: "neo" });
    w.thread(chat).status = "active";
    expect(await w.rpc("stopHosted")).toEqual({ stopped: 1, pending: 1, failed: 0 });
    expect(calls(w, "threads.stop")).toEqual(["thr_1"]);
    await w.idle(chat);
    expect(calls(w, "threads.stop")).toEqual(["thr_1", chat]);
  });

  it("threadInfo answers every key; deriveProviderOptions gives the thread view", async () => {
    const w = await liveBotThread();
    const info = await w.rpc<Record<string, ThreadInfo | null>>("threadInfo", { keys: ["thr_1", "thr_other"] });
    expect(info).toEqual({ thr_1: { kind: "bot", profile_home: NEO, bot_label: "Neo", enabled: true, tag: null }, thr_other: null });
    const options: ProviderOptions = deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1" });
    expect(options).toEqual({
      folder: "~/.hermes",
      machine: { id: MACHINE, name: null },
      thread: {
        kind: "bot",
        profile: "neo",
        profile_home: NEO,
        bot_label: "Neo",
        enabled: true,
        lineage_root: "root_bc",
        session_id: "tip_bc",
        legacy: false,
        tag: null,
        cwd: "/w/neo",
      },
    });
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_other" }).thread).toBeNull();
    await off(w);
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1" }).thread?.enabled).toBe(false);
  });
});

describe("migrations", () => {
  it("a P0 db upgrades in one transaction, data intact", () => {
    const { bb } = createFakePluginHost({ pluginId: "hermes" });
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, 1));
    db.prepare(`INSERT INTO bindings (thread_id, profile_home, kind, state) VALUES ('thr_p0', '/h', 'chat', 'live')`).run();
    db.prepare(`INSERT INTO bots (profile_home, name, enabled) VALUES ('/h', 'neo', 1)`).run();

    // A failing statement after ours rolls the whole upgrade back.
    expect(() => bb.storage.migrate(db, [...MIGRATIONS, "CREATE TABLE broken ("])).toThrow();
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("bindings")).not.toContain("cursor_uid");

    openMappingDb(bb);
    expect(columns("bindings")).toContain("cursor_uid");
    expect(columns("bots")).toEqual(expect.arrayContaining(["handle", "cwd"]));
    expect(columns("turns")).toContain("prev_state");
    expect(bindingByThread(db, "thr_p0")).toMatchObject({ state: "live", cursor_uid: null });
    expect(botRecord(db, "/h")).toMatchObject({ name: "neo", enabled: true, handle: null, cwd: null });
  });
});
