// Fixes from the P1 stack review: labeled markers, bot-thread wakes, the Bot Chat create flag, switched-off
// bots, the Conduit banner, per-thread files, outside-turn matching.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Refusal } from "../../test/fake-hermes/index.js";
import { encodeMarker } from "../shared/marker.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { readThread, updateThread } from "./files.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, deltas, events, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig({ holdRetryMs: [20, 20] });
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile: string, view: object = {}) => ({ providerOptions: rig.options(profile, view as never) });
const userRow = (profile: string, id: string, content: string) =>
  rig.waitFor(() => rig.fake.session(profile, id)!.rows.find((r) => r.role === "user" && r.content === content)?.message_uid);
const mirrored = (threadId: string) =>
  (deltas(rig, threadId).filter((d) => d.extensionKind === "hermes/persisted-turn").at(-1)?.payload as { mirrored: { anchor_uid: string; partial: boolean }[] }).mirrored;

it("a labeled replay: bb's own earlier message is the label, never a prompt", async () => {
  const cli = await rig.cli();
  const snap = await cli.create({ profile: "alex", request_id: "cli-lab", source: "cli" });
  await cli.submit({ profile: "alex", session_id: snap.session_id, text: "mine", submission_id: "cli-lab-1" });
  const anchor = await userRow("alex", snap.session_id, "mine");
  await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.rows.length === 2);
  const view = { kind: "chat", lineage_root: snap.session_id, session_id: snap.session_id };
  await startThread(rig, "thr_lab", opts("alex", view));
  await turn(rig, "thr_lab", [text("mine"), encodeMarker({ op: "replay", anchor_uid: anchor, labeled: true })], opts("alex", view));
  expect(rig.requests("prompt.submit").filter((r) => String(r.params.submission_id).startsWith("bb:"))).toHaveLength(0);
  expect(agentTexts(rig, "thr_lab")).toEqual(["echo(2): mine"]);
});

describe("a wake in a bot thread watches the bound session", () => {
  it("no title lookup, no create, no hold; attaches to the running turn; Stop shows Running in Conduit", async () => {
    const cli = await rig.cli();
    const chat = await cli.create({ profile: "bob", title: BOT_CHAT_TITLE, hidden: true, request_id: "desk-w" });
    rig.fake.outsideTurn("bob", chat.session_id, "from conduit", { script: { chunkMs: 60, reply: "a b c d e f g h i j" } });
    const anchor = await userRow("bob", chat.session_id, "from conduit");
    const view = { kind: "bot", lineage_root: chat.session_id, session_id: chat.session_id };
    await startThread(rig, "thr_bw", opts("bob", view));
    await rig.call("turn/start", { threadId: "thr_bw", providerThreadId: "x", input: [text("[Conduit] from conduit"), encodeMarker({ op: "mirror", anchor_uid: anchor, labeled: true })], clientRequestId: creq(), options: { ...AUTO, ...opts("bob", view) } });
    await rig.waitFor(() => events(rig, "thr_bw").some((e) => e.type === "item/agentMessage/delta"));
    await rig.call("thread/stop", { threadId: "thr_bw", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    expect(statuses(rig, "thr_bw")).toEqual(["interrupted"]);
    const banners = deltas(rig, "thr_bw").filter((d) => d.extensionKind === "hermes/status").map((d) => d.payload);
    expect(banners).toEqual([{ banner: { kind: "running_elsewhere", app: "Conduit" }, since: expect.any(Number) }]);
    expect(rig.requests("session.list")).toHaveLength(0);
    expect(rig.requests("session.create").filter((r) => r.params.request_id !== "desk-w")).toHaveLength(0);
  });

  it("a legacy bound Bot Chat: no resume, no lookup; the turn closes partial", async () => {
    const legacy = rig.fake.legacySession("bob", { title: BOT_CHAT_TITLE, hidden: true, held: true, turns: ["old"] });
    const pending = rig.fake.conduitTurn("bob", legacy, "conduit asks", { durationMs: 150 });
    const anchor = await userRow("bob", legacy, "conduit asks");
    const view = { kind: "bot", lineage_root: legacy, session_id: legacy, legacy: true };
    await startThread(rig, "thr_bl", opts("bob", view));
    await turn(rig, "thr_bl", [text("[Conduit] conduit asks"), encodeMarker({ op: "mirror", anchor_uid: anchor, labeled: true })], opts("bob", view));
    await pending;
    expect(rig.fake.requests.filter((r) => ["session.list", "session.resume", "session.create"].includes(r.method))).toEqual([]);
    expect(mirrored("thr_bl")).toEqual([expect.objectContaining({ anchor_uid: anchor, partial: true })]);
  });
});

it("a Bot Chat create that fails for another reason doesn't leave later sends held", async () => {
  const create = rig.fake.engine.handlers()["session.create"]!;
  let failed = false;
  rig.fake.handle("session.create", (params, ctx) => {
    if (!failed) {
      failed = true;
      throw new Refusal("internal_error");
    }
    return create(params, ctx);
  });
  const view = { kind: "bot" };
  await startThread(rig, "thr_cf", opts("bob", view));
  await turn(rig, "thr_cf", [text("one")], opts("bob", view));
  await turn(rig, "thr_cf", [text("two")], opts("bob", view));
  expect(statuses(rig, "thr_cf")).toEqual(["failed", "completed"]);
  expect(deltas(rig, "thr_cf").filter((d) => d.extensionKind === "hermes/status")).toEqual([]);
  expect(rig.requests("session.create")).toHaveLength(2);
});

it("a switched-off bot: its session and reconnect hook go; a gateway restart resumes nothing for it", async () => {
  await startThread(rig, "thr_so", opts("alex"));
  await turn(rig, "thr_so", [text("one")], opts("alex"));
  const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
  await rig.call("thread/resume", { threadId: "thr_so", cwd: "/w", providerThreadId: "x", options: { ...AUTO, ...opts("alex", { enabled: false, lineage_root: sid, session_id: sid }) }, instructionMode: "append" });
  const before = rig.fake.requests.length;
  await rig.fake.restart();
  await new Promise((r) => setTimeout(r, 300));
  expect(rig.fake.requests.slice(before).filter((r) => r.profile === "alex")).toEqual([]);
});

it("Stop drops the session: a gateway restart afterwards resumes nothing", async () => {
  await startThread(rig, "thr_sd", opts("alex"));
  rig.fake.nextTurn("alex", { holdMs: 3000 });
  await rig.call("turn/start", { threadId: "thr_sd", providerThreadId: "x", input: [text("long")], clientRequestId: creq(), options: { ...AUTO, ...opts("alex") } });
  await rig.waitFor(() => rig.requests("prompt.submit").length === 1);
  await rig.call("thread/stop", { threadId: "thr_sd", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
  const before = rig.fake.requests.length;
  await rig.fake.restart();
  await new Promise((r) => setTimeout(r, 300));
  expect(rig.fake.requests.slice(before).map((r) => r.method)).toEqual([]);
});

it("an outside turn whose text matches no running admission isn't guessed at", async () => {
  const cli = await rig.cli();
  const snap = await cli.create({ profile: "alex", request_id: "cli-g", source: "cli" });
  rig.fake.outsideTurn("alex", snap.session_id, "another turn", { script: { holdMs: 300 } });
  await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.running);
  const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id, tag: "CLI" };
  await startThread(rig, "thr_g", opts("alex", view));
  // A hidden user row (no text): the wake has no label and nothing to match.
  await turn(rig, "thr_g", [encodeMarker({ op: "mirror", anchor_uid: "uid-of-a-hidden-row" })], opts("alex", view));
  expect(agentTexts(rig, "thr_g")).toEqual([]);
  expect(mirrored("thr_g")).toEqual([expect.objectContaining({ partial: true })]);
});

it("each thread's record is its own file: one bridge's write never drops another's", () => {
  updateThread(rig.dataDir, "thr_one", { profile: "alex" });
  updateThread(rig.dataDir, "thr_two", { profile: "bob" });
  updateThread(rig.dataDir, "thr_one", { bot: true });
  expect(readThread(rig.dataDir, "thr_two")).toMatchObject({ profile: "bob" });
  expect(readThread(rig.dataDir, "thr_one")).toMatchObject({ profile: "alex", bot: true });
});

describe("second review", () => {
  it("steering a queued wake renders it through its marker: its label never reaches Hermes", async () => {
    const cli = await rig.cli();
    const snap = await cli.create({ profile: "alex", request_id: "cli-st", source: "cli" });
    await cli.submit({ profile: "alex", session_id: snap.session_id, text: "outside ask", submission_id: "cli-st-1" });
    const anchor = await userRow("alex", snap.session_id, "outside ask");
    await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.rows.length === 2);
    const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id, tag: "CLI" };
    await startThread(rig, "thr_sw", opts("alex", view));
    rig.fake.nextTurn("alex", { holdMs: 200 });
    await rig.call("turn/start", { threadId: "thr_sw", providerThreadId: "x", input: [text("mine")], clientRequestId: creq(), options: { ...AUTO, ...opts("alex", view) } });
    await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.running);
    const res = await rig.call("turn/steer", {
      threadId: "thr_sw",
      providerThreadId: "x",
      expectedTurnId: "t",
      clientRequestId: creq(),
      input: [text("[CLI] outside ask"), encodeMarker({ op: "mirror", anchor_uid: anchor, labeled: true })],
      options: { ...AUTO, ...opts("alex", view) },
    });
    expect(res.result).toEqual({});
    await rig.waitFor(() => statuses(rig, "thr_sw").length === 1);
    expect(rig.requests("prompt.submit").filter((r) => String(r.params.submission_id).startsWith("bb:")).map((r) => r.params.text)).toEqual(["mine"]);
    expect(rig.requests("session.steer")).toHaveLength(0);
    expect(agentTexts(rig, "thr_sw")).toEqual([expect.stringContaining("mine"), "echo(2): outside ask"]);
  });

  it("a malformed marker fails the turn and nothing of it reaches Hermes, its label included", async () => {
    await startThread(rig, "thr_iv", opts("alex"));
    const bad = { type: "text" as const, mentions: [], text: '<hermes-bb>{"op":"mirror"}</hermes-bb>', visibility: "agent-only" as const };
    await turn(rig, "thr_iv", [text("before"), text("[CLI] label"), bad], opts("alex"));
    expect(statuses(rig, "thr_iv")).toEqual(["failed"]);
    expect(rig.requests("prompt.submit")).toHaveLength(0);
    expect(rig.requests("session.create")).toHaveLength(0);
  });

  it("after Stop, a later outside turn with the same text isn't matched to the stale admission", async () => {
    const cli = await rig.cli();
    const snap = await cli.create({ profile: "alex", request_id: "cli-stale", source: "cli" });
    const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id, tag: "CLI" };
    await startThread(rig, "thr_stale", opts("alex", view));
    rig.fake.outsideTurn("alex", snap.session_id, "same", { script: { chunkMs: 40, reply: "one two three four five six" } });
    const first = await userRow("alex", snap.session_id, "same");
    const wake = (anchor: string) => [text("[CLI] same"), encodeMarker({ op: "mirror", anchor_uid: anchor, labeled: true })];
    await rig.call("turn/start", { threadId: "thr_stale", providerThreadId: "x", input: wake(first), clientRequestId: creq(), options: { ...AUTO, ...opts("alex", view) } });
    await rig.waitFor(() => events(rig, "thr_stale").some((e) => e.type === "item/agentMessage/delta"));
    await rig.call("thread/stop", { threadId: "thr_stale", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    await rig.waitFor(() => !rig.fake.session("alex", snap.session_id)!.running);
    rig.fake.outsideTurn("alex", snap.session_id, "same", { script: { chunkMs: 20, reply: "second reply" } });
    const second = await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.rows.filter((r) => r.role === "user" && r.content === "same")[1]?.message_uid);
    await turn(rig, "thr_stale", wake(second), opts("alex", view));
    expect(statuses(rig, "thr_stale")).toEqual(["interrupted", "completed"]);
    expect(agentTexts(rig, "thr_stale").at(-1)).toBe("second reply");
  });

  it("Stop with no turn running drops the session: switching an idle bot off leaves no reconnect", async () => {
    await startThread(rig, "thr_idle", opts("alex"));
    await turn(rig, "thr_idle", [text("one")], opts("alex"));
    await rig.call("thread/stop", { threadId: "thr_idle", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    const before = rig.fake.requests.length;
    await rig.fake.restart();
    await new Promise((r) => setTimeout(r, 300));
    expect(rig.fake.requests.slice(before)).toEqual([]);
  });
});
