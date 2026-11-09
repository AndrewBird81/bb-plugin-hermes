import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderOptions } from "../shared/provider-options.js";
import type { BotRow, Diagnostics, ThreadInfo } from "../shared/rpc-contract.js";
import { segmentInput } from "../shared/marker.js";
import { outsideTag } from "../shared/sources.js";
import { HELD_RETRY_MS } from "./bots.js";
import { bindingByThread, botRecord, claimRest, claimTurn, getKv, setKv, MIGRATIONS, openMappingDb, turnRow } from "./db.js";
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
  w.render("thr_1");
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
      // A served, off bot counts what its switch-on would import (none here: no chats).
      { profile: "neo", profile_home: NEO, bot_label: "Neo", served: true, enabled: false, thread_id: null, import_count: 0 },
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
    const chat = await w.newThread("neo");
    const userArchived = await w.newThread("neo");
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

  it("switch-on: the worker learns the bot before the spawn, so the first spawn succeeds", async () => {
    const w = await world();
    await w.connect();
    // The fake refuses a spawn for a bot not in the last ensureWatch (model_catalog_unavailable).
    w.state.failSpawn = 0;
    expect(await on(w)).toMatchObject({ enabled: true, thread_id: "thr_1" });
    expect(w.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(await errors(w)).toEqual([]);
  });

  it("switch-on: a failed spawn is retried at the next keep-alive", async () => {
    const w = await world();
    await w.connect();
    // The spawn at switch-on and the retry right after it fail.
    w.state.failSpawn = 2;
    expect(await on(w)).toMatchObject({ enabled: true, thread_id: null });
    expect(await errors(w)).toContain("model_catalog_unavailable");
    await w.connect();
    expect((await w.rpc<{ bots: BotRow[] }>("bots")).bots[0]).toMatchObject({ enabled: true, thread_id: "thr_1" });
    expect(w.thread("thr_1")).toMatchObject({ pinned: true, title: "Neo" });
    await w.connect();
    expect(w.threads.size).toBe(1);
  });

  it("setBotAccess answered without refresh stays pending and is retried", async () => {
    const w = await world();
    await w.connect();
    w.state.refreshed = false;
    await on(w);
    expect(await errors(w)).toContain("refresh_failed:1");
    w.state.refreshed = true;
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.access.map((a) => a.on)).toEqual([true, true]);
    w.state.boot = "boot_3";
    await w.connect();
    expect(w.access).toHaveLength(2);
  });

  it("offline: bots answers the last rows (or the bots on record), and an on bot can be switched off", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    w.state.online = false;
    await w.connect();
    expect((await w.rpc<{ bots: BotRow[] }>("bots")).bots.map((b) => [b.profile, b.enabled])).toEqual([
      ["neo", true],
      ["bob", false],
    ]);
    // Never claimed unserved offline.
    const offline = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled) VALUES (?, 'bob', 0)`).run(BOB);
      },
    });
    offline.state.online = false;
    await offline.connect();
    expect((await offline.rpc<{ bots: BotRow[] }>("bots")).bots).toMatchObject([{ profile: "bob", served: true, enabled: false }]);
    await expect(offline.harness.behavior.callRpc("setBot", { profile_home: BOB, on: true })).rejects.toThrow("Hermes isn't connected.");
    expect(await off(w)).toMatchObject({ profile_home: NEO, enabled: false });
    expect(w.thread("thr_1").archivedAt).toBe(1);

    // A restart while offline: no worker answer yet, so the bots on record.
    const fresh = await world({
      seed: (db) => {
        db.prepare(`INSERT INTO bots (profile_home, name, enabled, enabled_at) VALUES (?, 'neo', 1, 1)`).run(NEO);
      },
    });
    fresh.state.online = false;
    await fresh.connect();
    expect((await fresh.rpc<{ bots: BotRow[] }>("bots")).bots).toEqual([
      { profile: "neo", profile_home: NEO, bot_label: "Neo", served: true, enabled: true, thread_id: null, import_count: null },
    ]);
    expect(await off(fresh)).toMatchObject({ profile_home: NEO, enabled: false });
    expect(botRecord(fresh.db, NEO)?.enabled).toBe(false);
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

  it("held (unverified: profiles.list isn't known to refuse): findBotChat retries at 2, 5, 10, 30 s, then binds when Conduit lets go", async () => {
    const w = await world();
    await w.connect();
    w.botChats.set(NEO, { state: "held" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await on(w);
    expect(w.hostCalls("findBotChat")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HELD_RETRY_MS[0]!);
    await w.flush();
    expect(w.hostCalls("findBotChat")).toHaveLength(2);
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: false });
    w.history.set("root_bc", { session_id: "tip_bc", turns: [] });
    await vi.advanceTimersByTimeAsync(HELD_RETRY_MS[1]!);
    await w.flush();
    expect(w.hostCalls("findBotChat")).toHaveLength(3);
    // No turns to import: live at once.
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ lineage_root: "root_bc", legacy: false, state: "live" });
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
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "tip_bc", legacy: false });
    w.history.set("root_bc", {
      session_id: "tip_bc",
      truncated: true,
      turns: [
        turn("u1", { ts }),
        turn("u2", { submission_id: "bb:thr_x:1", user_text: "mine", ts }),
        turn("u3", { user_hidden: true, user_text: null, ts }),
      ],
    });
    await on(w);
    const enabledAt = botRecord(w.db, NEO)!.enabled_at!;
    expect(w.markers("thr_1")).toEqual([
      { op: "init", profile: "neo", bot: true },
      { op: "bind", profile_home: NEO, lineage_root: "root_bc", legacy: false, anchor_uid: "u1", since: enabledAt - IMPORT_WINDOW_MS, labeled: true },
      { op: "replay", anchor_uid: "u2", labeled: true },
      { op: "replay", anchor_uid: "u3" },
    ]);
    expect(w.texts("thr_1")).toEqual([`${outsideTag(new Date(ts))}text u1`, "mine"]);
    // The bridge never takes a label for a prompt: bb's own untagged message is never submitted again.
    // inputs: the spawn's `spawnStart()`, the init, then the import.
    const segments = w.thread("thr_1").inputs.slice(2).flatMap((input) => segmentInput(input));
    expect(segments.map((s) => s.kind)).toEqual(["marker", "marker", "marker"]);
    expect(segments.map((s) => (s.kind === "marker" ? s.label : null))).toEqual([`${outsideTag(new Date(ts))}text u1`, "mine", null]);
    // The cursor passes imported turns only once the bridge's records settle them.
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "replaying", cursor_uid: null });
    expect(turnRow(w.db, "thr_1", "u2")).toMatchObject({ kind: "replay", state: "queued" });

    w.render("thr_1");
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
    // The init goes through; every import send fails.
    w.harness.inspection.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: { text?: string }[] }) => {
      if (input.some((p) => p.text?.includes('"op":"init"'))) return (w.thread(threadId).inputs.push(input as never), { ok: true, delivery: "sent" });
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
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2", labeled: true }]);
    expect(w.texts("thr_1").at(-1)).toBe("[Outside bb] text u2");
    expect(w.levels.get("thr_1")).toBe("input-only");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    w.render("thr_1");
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
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2", labeled: true }]);

    // Conduit's own turn: the bridge shows the bubble only and closes partial; the reply rows come later.
    chat.turns.push(turn("u3", { reply_uids: [] }));
    await w.changed(NEO);
    expect(w.texts("thr_1").at(-1)).toBe("[Outside bb] text u3");
    const mirrored = [record("u2", ["u2-a", "u2-b"], false, 1), record("u3", [], true, 2)];
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored });
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u3")).toMatchObject({ state: "partial", reply_uids: [] });
    chat.turns[2] = turn("u3", { reply_uids: ["u3-r"] });
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

  it("a chat deleted in Hermes doesn't stop the bot's other threads from waking (01 §7: the thread stays)", async () => {
    const w = await liveBotThread();
    const chats: string[] = [];
    for (const c of ["c1", "c2"]) {
      const chat = await w.newThread("neo");
      await w.idle(chat);
      const sid = bindingByThread(w.db, chat)!.expected_id!;
      w.history.set(sid, { session_id: sid, turns: [turn(`${c}-s1`, { submission_id: `bb:${chat}:${c}` })] });
      w.persisted(chat, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${chat}:${c}`, anchor_uids: [`${c}-s1`], reply_uids: [], at: 1 }] });
      await w.idle(chat);
      chats.push(chat);
    }
    // The first side chat's session is deleted in Hermes; the second one gets an outside turn.
    w.history.delete(bindingByThread(w.db, chats[0]!)!.lineage_root!);
    w.history.get(bindingByThread(w.db, chats[1]!)!.lineage_root!)!.turns.push(turn("c2-s2"));
    await w.changed(NEO);
    expect(w.markers(chats[1]!).filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "c2-s2", labeled: true }]);
  });

  it("a hidden user row wakes with the marker only; a later reply wakes once as rest", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2", { user_hidden: true, user_text: null, complete: false, reply_uids: [] }));
    await w.changed(NEO);
    const texts = w.texts("thr_1").length;
    w.render("thr_1");
    await w.idle("thr_1");
    w.history.get("root_bc")!.turns[1] = turn("u2", { user_hidden: true, user_text: null, reply_uids: ["r1", "r2"] });
    await w.changed(NEO);
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([
      { op: "mirror", anchor_uid: "u2" },
      { op: "mirror", anchor_uid: "u2", rest: true },
    ]);
    expect(w.texts("thr_1")).toHaveLength(texts);
    w.render("thr_1");
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
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored: [{ anchor_uid: "u3", reply_uids: ["u3-r"], partial: false, at: 1 }] });
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2", labeled: true }]);
    // u2's wake is queued now: everything settles at that idle.
    w.render("thr_1");
    await w.idle("thr_1");
    expect(turnRow(w.db, "thr_1", "u3")?.state).toBe("done");
  });

  it("a live binding with no cursor never wakes turns older than the import window", async () => {
    const w = await liveBotThread([]);
    expect(bindingByThread(w.db, "thr_1")?.cursor_uid).toBeNull();
    const day = 86_400_000;
    w.history.get("root_bc")!.turns.push(turn("old", { ts: Date.now() - 40 * day }), turn("new", { ts: Date.now() - day }));
    await w.changed(NEO);
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "new", labeled: true }]);
    expect(w.hostCalls("readTurns").at(-1)?.input).toMatchObject({ since: botRecord(w.db, NEO)!.enabled_at! - IMPORT_WINDOW_MS });
  });

  it("boot: a rest claim whose first wake ran is released and re-sent, not settled", async () => {
    const w = await liveBotThread();
    // u1 was Conduit's own turn: shown partial, so the cursor stays before it.
    w.db.prepare(`UPDATE turns SET state = 'partial', reply_uids = '[]' WHERE anchor_uid = 'u1'`).run();
    w.db.prepare(`UPDATE bindings SET cursor_uid = NULL`).run();
    w.history.get("root_bc")!.turns[0] = turn("u1", { reply_uids: ["u1-r", "u1-r2"] });
    // The import's turn request names u1; a previous run then claimed u1's rest and died before sending it.
    w.event("thr_1", "client/turn/requested", { input: [{ type: "text", text: '<hermes-bb>{"op":"bind","anchor_uid":"u1"}</hermes-bb>' }] });
    expect(claimRest(w.db, "thr_1", "u1", ["u1-r", "u1-r2"])).toBe(true);
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u1", rest: true }]);
  });

  it("a truncated wake read pages on: every turn of a long outage wakes once, in order", async () => {
    const w = await liveBotThread();
    const chat = w.history.get("root_bc")!;
    chat.pageSize = 2;
    chat.turns.push(...["u2", "u3", "u4", "u5", "u6"].map((a) => turn(a)));
    await w.changed(NEO);
    const woken = () => w.markers("thr_1").filter((m) => m.op === "mirror").map((m) => (m as { anchor_uid: string }).anchor_uid);
    expect(woken()).toEqual(["u2", "u3", "u4", "u5", "u6"]);
    w.render("thr_1");
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")?.cursor_uid).toBe("u6");
    await w.changed(NEO);
    expect(woken()).toHaveLength(5);
  });

  it("boot recovery finds a wake that ran beyond the latest 100 turn requests", async () => {
    const w = await liveBotThread();
    w.history.get("root_bc")!.turns.push(turn("u2"));
    claimTurn(w.db, { thread_id: "thr_1", anchor_uid: "u2", kind: "mirror", at: 1 });
    w.event("thr_1", "client/turn/requested", { input: [{ type: "text", text: '<hermes-bb>{"op":"mirror","anchor_uid":"u2"}</hermes-bb>' }] });
    for (let i = 0; i < 150; i++) w.event("thr_1", "client/turn/requested", { input: [{ type: "text", text: `later ${i}` }] });
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [], mirrored: [{ anchor_uid: "u2", reply_uids: ["u2-r"], partial: false, at: 1 }] });
    w.state.boot = "boot_2";
    await w.connect();
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([]);
    expect(turnRow(w.db, "thr_1", "u2")?.state).toBe("done");
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
    expect(w.markers("thr_1").filter((m) => m.op === "mirror")).toEqual([{ op: "mirror", anchor_uid: "u2", labeled: true }]);
  });
});

describe("side chats and bb's own turns (T1.10, T1.11)", () => {
  it("re-listed before its first boundary → no mirror; bb's own turn never wakes, even without its submission_id", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    const chat = await w.newThread("neo");
    await w.idle(chat);
    const sid = bindingByThread(w.db, chat)!.expected_id!;
    // bb's first send created the session; Hermes lists it before the bridge's turn boundary.
    await w.active(chat);
    w.history.set(sid, { session_id: sid, turns: [turn("s1", { submission_id: null, complete: false })] });
    await w.changed(NEO);
    expect(w.markers(chat)).toEqual([]);

    // The turn settles: the bridge publishes `persisted-turn`; the `submission_id` read still failed.
    w.history.set(sid, { session_id: sid, turns: [turn("s1", { submission_id: null })] });
    w.persisted(chat, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${chat}:c1`, anchor_uids: ["s1"], reply_uids: ["s1-r"], at: 1 }] });
    await w.idle(chat);
    expect(bindingByThread(w.db, chat)).toMatchObject({ state: "live", lineage_root: sid, session_id: sid, cursor_uid: "s1" });
    expect(turnRow(w.db, chat, "s1")).toMatchObject({ kind: "bb", state: "done" });

    // An outside turn after it wakes; bb's never does.
    w.history.get(sid)!.turns.push(turn("s2"));
    await w.changed(NEO);
    expect(w.markers(chat)).toEqual([{ op: "mirror", anchor_uid: "s2", labeled: true }]);
    expect(w.texts(chat).at(-1)).toBe("[Outside bb] text s2");
  });

  it("no outside turn names an app: bot thread (live and legacy) and side chat, live and imported, all read [Outside bb]", async () => {
    const APP = /\b(CLI|TUI|Desktop|Conduit|GUI)\b/;
    const w = await world();
    await w.connect();
    const ts = Date.now() - 86_400_000;
    w.botChats.set(NEO, { state: "found", lineage_root: "root_bc", session_id: "root_bc", legacy: false });
    w.history.set("root_bc", { session_id: "root_bc", turns: [turn("i1", { ts })] });
    await on(w);
    await w.idle("thr_1");
    await w.idle("thr_1");
    w.history.get("root_bc")!.turns.push(turn("l1"));
    await w.changed(NEO);
    const chat = await w.newThread("neo");
    await w.idle(chat);
    const sid = bindingByThread(w.db, chat)!.expected_id!;
    w.history.set(sid, { session_id: sid, turns: [turn("s1", { submission_id: `bb:${chat}:c1` }), turn("s2")] });
    w.persisted(chat, { profile_home: NEO, lineage_root: sid, session_id: sid, turns: [{ submission_id: `bb:${chat}:c1`, anchor_uids: ["s1"], reply_uids: [], at: 1 }] });
    await w.idle(chat);
    await w.changed(NEO);
    expect(w.texts("thr_1")).toEqual([`${outsideTag(new Date(ts))}text i1`, "[Outside bb] text l1"]);
    expect(w.texts(chat)).toEqual(["[Outside bb] text s2"]);
    for (const t of [...w.texts("thr_1"), ...w.texts(chat)]) expect(t).not.toMatch(APP);
    // Nothing app-shaped reaches the bridge either: the thread view has no tag.
    for (const id of ["thr_1", chat]) expect(Object.keys(deriveProviderOptions(w.db, { settings: {}, threadId: id }).thread ?? {})).not.toContain("tag");
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

  it("bot thread: bb's first send adopts a legacy Bot Chat → bound from its record, then older turns import once", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    // findBotChat is read-only: an unadopted Bot Chat reads as none, so the bot thread stays pending.
    expect(bindingByThread(w.db, "thr_1")?.state).toBe("pending");
    const ts = Date.now() - 86_400_000;
    w.history.set("root_conduit", {
      session_id: "root_conduit",
      turns: [turn("c1", { ts }), turn("c2", { ts }), turn("b1", { submission_id: null, user_text: "hi", ts: ts + 1 })],
    });
    await w.active("thr_1");
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_conduit", session_id: "root_conduit", turns: [{ submission_id: "bb:thr_1:c1", anchor_uids: ["b1"], reply_uids: ["b1-r"], at: 1 }] });
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "replaying", lineage_root: "root_conduit", legacy: false });
    expect(w.markers("thr_1")).toEqual([
      { op: "init", profile: "neo", bot: true },
      { op: "bind", profile_home: NEO, lineage_root: "root_conduit", legacy: false, anchor_uid: "c1", labeled: true },
      { op: "replay", anchor_uid: "c2", labeled: true },
    ]);
    // bb's own turn is already in the thread: never imported, never woken.
    expect(turnRow(w.db, "thr_1", "b1")).toMatchObject({ kind: "bb" });
    expect(w.texts("thr_1")).toEqual([`${outsideTag(new Date(ts))}text c1`, `${outsideTag(new Date(ts))}text c2`]);
    w.render("thr_1");
    await w.idle("thr_1");
    expect(bindingByThread(w.db, "thr_1")).toMatchObject({ state: "live", cursor_uid: "b1" });
    await w.changed(NEO);
    expect(w.markers("thr_1")).toHaveLength(3);
  });

  it("thread.created binds a `bb thread spawn` chat with its expected_id; our own spawns and off bots' are skipped", async () => {
    const w = await world();
    await w.connect();
    expect(bindingByThread(w.db, await w.newThread("neo"))).toBeNull();
    const bot = (await on(w)).thread_id!;
    const chat = await w.newThread("neo");
    const expected = `local-${createHash("sha256").update(JSON.stringify([NEO, `uid:${UID}`, `bb:${chat}`])).digest("hex")}`;
    expect(bindingByThread(w.db, chat)).toMatchObject({ kind: "chat", state: "pending", profile_home: NEO, expected_id: expected });
    expect(bindingByThread(w.db, await w.newThread("zed"))).toBeNull();
    await w.emit("thread.created", bot);
    expect(bindingByThread(w.db, bot)?.kind).toBe("bot");
  });

  it("bb's New Thread binds at thread.created from the chip's selection, before its first turn (research 13 §3)", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    const chat = await w.newThread("neo", { via: "newThread" });
    expect(bindingByThread(w.db, chat)).toMatchObject({ kind: "chat", state: "pending", profile_home: NEO });
    expect(await w.rpc<Record<string, ThreadInfo | null>>("threadInfo", { keys: [chat] })).toEqual({ [chat]: { kind: "chat", profile_home: NEO, bot_label: "Neo", enabled: true } });
  });

  it("stopHosted stops idle threads now and busy ones at their idle", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    await w.idle("thr_1");
    const chat = await w.newThread("neo");
    w.thread(chat).status = "active";
    expect(await w.rpc("stopHosted")).toEqual({ stopped: 1, pending: 1, failed: 0 });
    expect(calls(w, "threads.stop")).toEqual(["thr_1"]);
    await w.idle(chat);
    expect(calls(w, "threads.stop")).toEqual(["thr_1", chat]);
  });

  it("threadInfo answers every key; deriveProviderOptions gives the thread view", async () => {
    const w = await liveBotThread();
    const info = await w.rpc<Record<string, ThreadInfo | null>>("threadInfo", { keys: ["thr_1", "thr_other"] });
    expect(info).toEqual({ thr_1: { kind: "bot", profile_home: NEO, bot_label: "Neo", enabled: true }, thr_other: null });
    const options: ProviderOptions = deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1" });
    expect(options).toEqual({
      folder: "~/.hermes",
      // The name as hosts.list gave it at the last check, for "Hermes runs on <machine>".
      machine: { id: MACHINE, name: "hermes-mac" },
      thread: {
        kind: "bot",
        profile: "neo",
        profile_home: NEO,
        bot_label: "Neo",
        enabled: true,
        lineage_root: "root_bc",
        session_id: "tip_bc",
        legacy: false,
        cwd: "/w/neo",
      },
      project: false,
    });
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_other" }).thread).toBeNull();
    // D54: a thread in a project (not the personal one, "No project") works in bb's folder for it.
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1", projectId: "proj_personal" }).project).toBe(false);
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1", projectId: "proj_demo" }).project).toBe(true);
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_other", projectId: "proj_demo" }).project).toBe(true);
    await off(w);
    expect(deriveProviderOptions(w.db, { settings: {}, threadId: "thr_1" }).thread?.enabled).toBe(false);
  });
});

describe("dead cards (A3)", () => {
  /** bb's `thread.idle` with a message queued behind the card. */
  const idleWithQueue = async (w: World, threadId: string) => {
    Object.assign(w.thread(threadId), { status: "idle", queued: 1 });
    await w.harness.behavior.emitThreadEvent("thread.idle", { thread: w.dto(threadId), lastAssistantText: null });
    await w.flush();
  };

  it("a dead request's pending card: the idle thread is stopped once (mid-turn: at idle); none for others, never an answer", async () => {
    const w = await liveBotThread();
    // As bb's daemon stores it: `<random UUID per bridge process>:<JSON-RPC id>`.
    const scope = "3f2b6c1e-9a4d-4e7b-8c21-5d0f7a9e1b42";
    const card = (id: string, request: string, status = "pending") => ({ threadId: "thr_1", id, status, origin: { kind: "provider", providerRequestId: `${scope}:${request}` } });
    w.cards.push(card("int_1", "hermes-0a1b2c3d-7"), card("int_2", "hermes-0a1b2c3d-8"), card("int_3", "hermes-0a1b2c3d-3", "resolved"), card("int_5", "hermes-0a1b2c3d-17"), {
      threadId: "thr_1",
      id: "int_4",
      status: "pending",
      origin: { kind: "plugin" },
    });
    const stops = () => calls(w, "threads.stop").length;
    await w.active("thr_1");
    // `-7` must not match `…-17`.
    w.status("thr_1", { banner: null, since: null, dead_requests: ["hermes-0a1b2c3d-7", "hermes-0a1b2c3d-3"] });
    await w.emit("experimental_thread.events" as never, "thr_1");
    expect(stops()).toBe(0);
    await idleWithQueue(w, "thr_1");
    expect(calls(w, "threads.stop")).toEqual(["thr_1"]);
    // The fake leaves int_1 pending: later reads must not stop again.
    await w.emit("experimental_thread.events" as never, "thr_1");
    await idleWithQueue(w, "thr_1");
    await w.idle("thr_1");
    expect(stops()).toBe(1);
    const touched = w.harness.inspection.sdk.calls.filter((c) => /interactions\.(respond|resolve|cancel)/.test(c.path));
    expect(touched).toEqual([]);
  });

  it("a dead id with no pending card stops nothing; a failing card check never blocks persisted-turn", async () => {
    const w = await liveBotThread();
    w.status("thr_1", { banner: null, since: null, dead_requests: ["hermes-0a1b2c3d-9"] });
    await w.emit("experimental_thread.events" as never, "thr_1");
    expect(calls(w, "threads.stop")).toEqual([]);

    w.harness.inspection.sdk.stub("threads.interactions.list", async () => {
      throw Object.assign(new Error("HTTP 503"), { code: "unavailable" });
    });
    w.status("thr_1", { banner: null, since: null, dead_requests: ["hermes-0a1b2c3d-10"] });
    w.history.get("root_bc")!.turns.push(turn("b1", { submission_id: null }));
    w.persisted("thr_1", { profile_home: NEO, lineage_root: "root_bc", session_id: "tip_bc", turns: [{ submission_id: "bb:thr_1:c1", anchor_uids: ["b1"], reply_uids: [], at: 1 }] });
    await w.emit("experimental_thread.events" as never, "thr_1");
    expect(turnRow(w.db, "thr_1", "b1")).toMatchObject({ kind: "bb" });
    expect(await errors(w)).toContain("unavailable");
  });
});

describe("folder guard (R8)", () => {
  it("a folder that moved without setConnection: not_configured, 0 Hermes I/O, no machine for bridges, until set again", async () => {
    // A reinstall reset the folder setting to its default; data.db kept the machine and its folder.
    const w = await world({ seed: (db) => setKv(db, "machine_folder", "/private/tmp/bb-hermes-test/old") });
    await w.harness.behavior.experimental_emitHostSignal(MACHINE, "watch", { state: "connected", worker_boot_id: "boot_1", instance_id: null });
    await w.flush();
    expect(await w.rpc("health")).toMatchObject({ state: "not_configured", detail: "folder_changed" });
    expect(w.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    expect(deriveProviderOptions(w.db, { settings: { folder: "~/.hermes" }, threadId: "thr_x" }).machine).toBeNull();
    expect(await w.connect()).toMatchObject({ state: "connected" });
    expect(deriveProviderOptions(w.db, { settings: { folder: "~/.hermes" }, threadId: "thr_x" }).machine).toEqual({ id: MACHINE, name: "hermes-mac" });
  });

  it("a P0 db (machine, no folder) counts as matching; a folder saved in bb's settings keeps the machine", async () => {
    const w = await world();
    expect(getKv(w.db, "machine_folder")).toBe("~/.hermes");
    await w.connect();
    await w.harness.behavior.setSettings({ folder: "/private/tmp/bb-hermes-test/other" });
    await w.flush();
    expect(getKv(w.db, "machine_folder")).toBe("/private/tmp/bb-hermes-test/other");
    expect((await w.rpc<{ state: string }>("health")).state).toBe("connected");
  });

  it("after a folder change, another folder's pending off waits (skill_left_outside_root) and is retried when the folder comes back", async () => {
    const w = await world();
    await w.connect();
    await on(w);
    w.state.failAccess = true;
    await off(w);
    w.state.failAccess = false;
    const calls = w.access.length;
    await w.harness.behavior.setSettings({ folder: "/private/tmp/bb-hermes-test/other" });
    await w.flush();
    expect(await errors(w)).toContain("skill_left_outside_root");
    expect(getKv(w.db, "access_pending")).toEqual({ [NEO]: false });
    expect(w.access).toHaveLength(calls);
    await w.harness.behavior.setSettings({ folder: "~/.hermes" });
    await w.flush();
    expect(w.access.at(-1)).toEqual({ profile_home: NEO, on: false, enabled_bots: [] });
    expect(getKv(w.db, "access_pending")).toEqual({});

    // The worker itself says the profile isn't under the root: kept, said, not cleared.
    const v = await world();
    await v.connect();
    await on(v);
    v.state.failAccess = true;
    await off(v);
    v.state.failAccess = false;
    v.state.outside = true;
    v.state.boot = "boot_2";
    await v.connect();
    expect(getKv(v.db, "access_pending")).toEqual({ [NEO]: false });
    expect(await errors(v)).toEqual(expect.arrayContaining(["profile_outside_root", "skill_left_outside_root"]));
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
