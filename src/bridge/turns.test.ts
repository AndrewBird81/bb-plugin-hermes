// T1.1: bb's own turns (02 §Protocol mapping; 03 §Unit and bridge tests that guard known traps).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeMarker, spawnStart } from "../shared/marker.js";
import { otherMachineText, switchedOffText } from "../shared/provider-options.js";
import { PLACEHOLDER_MODEL } from "./composer.js";
import { NOT_CONNECTED_TEXT, noBotText } from "./context.js";
import { DELETED_TEXT, nothingCompactedText } from "./thread.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, deltas, errors, events, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig();
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile = "alex", view: object | null = {}) => ({ providerOptions: rig.options(profile, view as never) });
const home = (profile: string) => rig.fake.profiles.find((p) => p.name === profile)!.home;
const warnings = (threadId: string) => deltas(rig, threadId).filter((d) => d.kind === "provider.warning").map((d) => d.summary);

describe("side chat", () => {
  it("creates the session lazily, submits with bb's ids, streams, then announces identity after the boundary", async () => {
    await startThread(rig, "thr_a", opts());
    expect(rig.requests("session.create")).toHaveLength(0);
    const creq = await turn(rig, "thr_a", [text("hi")], opts());
    const [create] = rig.requests("session.create");
    expect(create).toMatchObject({ profile: "alex", params: { request_id: "bb:thr_a" } });
    expect(typeof create!.params.cwd).toBe("string");
    const [submit] = rig.requests("prompt.submit");
    expect(submit!.params).toMatchObject({ text: "hi", submission_id: `bb:thr_a:${creq}`, turn_author: { id: "bb:thr_a", name: "bb" } });
    expect(agentTexts(rig, "thr_a")).toEqual(["echo(2): hi"]);
    expect(statuses(rig, "thr_a")).toEqual(["completed"]);
    const sid = rig.fake.session("alex", submit!.params.session_id as string)!.id;
    const identities = rig.notifications("thread/identity") as { providerThreadId: string }[];
    expect(identities.map((i) => i.providerThreadId)).toEqual(["pending:thr_a", `${home("alex")}#${sid}`]);
    // The identity follows the boundary's batch, never inside the turn (S1-S3 fact 1).
    const at = (method: string) => rig.rpc.messages.map((m) => m.method).lastIndexOf(method);
    expect(at("thread/identity")).toBeGreaterThan(at("thread/delta"));
    expect(rig.fake.violations).toEqual([]);
  });

  it("publishes bb's own turn as stored: anchors and replies from persisted_turn row ids (A37)", async () => {
    await startThread(rig, "thr_p", opts());
    const creq = await turn(rig, "thr_p", [text("hi")], opts());
    const s = rig.fake.session("alex", rig.requests("prompt.submit")[0]!.params.session_id as string)!;
    const states = deltas(rig, "thr_p").filter((d) => d.kind === "extension.state" && d.extensionKind === "hermes/persisted-turn");
    expect(states).toHaveLength(1);
    expect(states[0]!.payload).toMatchObject({
      profile_home: home("alex"),
      lineage_root: s.id,
      session_id: s.id,
      turns: [{ submission_id: `bb:thr_p:${creq}`, anchor_uids: [s.rows[0]!.message_uid], reply_uids: [s.rows[1]!.message_uid] }],
    });
  });

  it("reuses the session on the next turn", async () => {
    await startThread(rig, "thr_b", opts());
    await turn(rig, "thr_b", [text("one")], opts());
    await turn(rig, "thr_b", [text("two")], opts());
    expect(rig.requests("session.create")).toHaveLength(1);
    expect(rig.requests("prompt.submit").map((r) => r.params.text)).toEqual(["one", "two"]);
    expect(agentTexts(rig, "thr_b")).toEqual(["echo(2): one", "echo(4): two"]);
  });

  it("a spawn's empty start part (spawnStart) reaches no Hermes call and keeps the identity pending", async () => {
    const options = { ...opts("alex", null), sessionOptions: { profile: "alex" } };
    await startThread(rig, "thr_s", options);
    const before = rig.fake.requests.length;
    await turn(rig, "thr_s", [spawnStart()], options);
    // Only the composer's catalog read (`model.options`, never a session) may still land.
    expect(rig.fake.requests.slice(before).filter((r) => r.method !== "model.options")).toEqual([]);
    expect(statuses(rig, "thr_s")).toEqual(["completed"]);
    expect((rig.notifications("thread/identity") as { providerThreadId: string }[]).map((i) => i.providerThreadId)).toEqual(["pending:thr_s"]);
  });

  it("an unbound thread uses its profile option (A18)", async () => {
    await startThread(rig, "thr_u", opts("bob", null));
    await turn(rig, "thr_u", [text("hi")], { ...opts("bob", null), sessionOptions: { profile: "bob" } });
    expect(rig.requests("session.create")[0]).toMatchObject({ profile: "bob" });
    expect(statuses(rig, "thr_u")).toEqual(["completed"]);
  });

  it("an unbound thread with no profile and no default bot lists the switched-on bots", async () => {
    await rig.close();
    rig = await startRig({ enabled: ["alex"] });
    await startThread(rig, "thr_v", opts("alex", null));
    await turn(rig, "thr_v", [text("hi")], opts("alex", null));
    expect(errors(rig, "thr_v")).toEqual([noBotText([{ profile: "alex", profile_home: "", bot_label: "", cwd: null }])]);
    expect(rig.requests("session.create")).toHaveLength(0);
  });
});

describe("refusals", () => {
  it("another machine → names --machine, before any Hermes call (01 §9)", async () => {
    await rig.close();
    rig = await startRig({ worker: false });
    await startThread(rig, "thr_m", opts());
    await turn(rig, "thr_m", [text("hi")], opts());
    expect(errors(rig, "thr_m")).toEqual([otherMachineText("hermes-mac")]);
    expect(statuses(rig, "thr_m")).toEqual(["failed"]);
    expect(rig.fake.requests).toEqual([]);
  });

  it("a spawn on a machine without Hermes, on the placeholder model: names the machine from provider options (its id when unnamed)", async () => {
    await rig.close();
    rig = await startRig({ worker: false });
    const spawned = { model: PLACEHOLDER_MODEL, sessionOptions: { profile: "neo" } };
    await startThread(rig, "thr_wm", opts("alex", null));
    await turn(rig, "thr_wm", [text("hi")], { ...opts("alex", null), ...spawned });
    const unnamed = { providerOptions: { ...rig.options("alex", null), machine: { id: "host-1", name: null } } };
    await startThread(rig, "thr_wn", unnamed);
    await turn(rig, "thr_wn", [text("hi")], { ...unnamed, ...spawned });
    const unset = { providerOptions: { ...rig.options("alex", null), machine: null } };
    await startThread(rig, "thr_wu", unset);
    await turn(rig, "thr_wu", [text("hi")], { ...unset, ...spawned });
    expect(errors(rig, "thr_wm")).toEqual([otherMachineText("hermes-mac")]);
    expect(errors(rig, "thr_wn")).toEqual([otherMachineText("host-1")]);
    expect(errors(rig, "thr_wu")).toEqual([NOT_CONNECTED_TEXT]);
    expect(rig.fake.requests).toEqual([]);
  });

  it("the Hermes machine with no bot on: the placeholder spawn says so, before any Hermes call", async () => {
    await rig.close();
    rig = await startRig({ enabled: [] });
    await startThread(rig, "thr_nb", opts("alex", null));
    await turn(rig, "thr_nb", [text("hi")], { ...opts("alex", null), model: PLACEHOLDER_MODEL });
    await startThread(rig, "thr_nn", opts("alex", null));
    await turn(rig, "thr_nn", [text("hi")], { ...opts("alex", null), model: PLACEHOLDER_MODEL, sessionOptions: { profile: "neo" } });
    expect(errors(rig, "thr_nb")).toEqual([noBotText([])]);
    expect(errors(rig, "thr_nn")).toEqual([switchedOffText("Neo")]);
    expect(rig.fake.requests).toEqual([]);
  });

  it("a switched-off bot, before any Hermes call (01 §2)", async () => {
    await startThread(rig, "thr_off", opts());
    await turn(rig, "thr_off", [text("hi")], opts("alex", { enabled: false }));
    expect(errors(rig, "thr_off")).toEqual([switchedOffText("Alex")]);
    expect(rig.fake.requests).toEqual([]);
  });

  it("not_found → Deleted in Hermes", async () => {
    await startThread(rig, "thr_d", opts());
    await turn(rig, "thr_d", [text("hi")], opts("alex", { lineage_root: "local-gone", session_id: "local-gone" }));
    expect(errors(rig, "thr_d")).toEqual([DELETED_TEXT]);
  });
});

describe("segmentation (R1 M6)", () => {
  it("merged [text, mirror, text] → 2 submits + 1 render, in order; markers never submit", async () => {
    const cli = await rig.cli();
    const snap = await cli.create({ profile: "alex", request_id: "cli-1", source: "cli" });
    await cli.submit({ profile: "alex", session_id: snap.session_id, text: "outside ask", submission_id: "cli-sub-1" });
    await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.rows.length === 2);
    const anchor = rig.fake.session("alex", snap.session_id)!.rows[0]!.message_uid;
    const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id };
    await startThread(rig, "thr_s", opts("alex", view));
    await turn(rig, "thr_s", [text("first"), text("[Outside bb] outside ask"), encodeMarker({ op: "mirror", anchor_uid: anchor, labeled: true }), text("second")], opts("alex", view));
    expect(rig.requests("prompt.submit").map((r) => r.params.text)).toEqual(["outside ask", "first", "second"]);
    expect(agentTexts(rig, "thr_s")).toEqual(["echo(4): first", "echo(2): outside ask", "echo(6): second"]);
    expect(statuses(rig, "thr_s")).toHaveLength(1);
  });
});

describe("Stop and steer fencing (S8 step 8, R1 M4)", () => {
  const sessionOf = () => rig.requests("prompt.submit")[0]!.params.session_id as string;

  it("Stop on bb's own running turn → session.interrupt with its generation; settles before the result", async () => {
    await startThread(rig, "thr_i", opts());
    await turn(rig, "thr_i", [text("warm up")], opts());
    rig.fake.nextTurn("alex", { holdMs: 5000 });
    await rig.call("turn/start", { threadId: "thr_i", providerThreadId: "x", input: [text("long")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => rig.fake.session("alex", sessionOf())!.running);
    const res = await rig.call("thread/stop", { threadId: "thr_i", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    expect(res.result).toEqual({});
    expect(statuses(rig, "thr_i")).toEqual(["completed", "interrupted"]);
    expect(rig.requests("session.interrupt").map((r) => r.params.execution_generation)).toEqual([2]);
    expect(rig.requests("prompt.cancel")).toHaveLength(0);
  });

  it("an outside turn running and ours queued → Stop cancels ours, never session.interrupt", async () => {
    await startThread(rig, "thr_q", opts());
    await turn(rig, "thr_q", [text("warm up")], opts());
    rig.fake.outsideTurn("alex", sessionOf(), "outside long", { script: { holdMs: 5000 } });
    await rig.call("turn/start", { threadId: "thr_q", providerThreadId: "x", input: [text("mine")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => rig.requests("prompt.submit").length === 2);
    await rig.call("thread/stop", { threadId: "thr_q", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    expect(rig.requests("prompt.cancel")).toHaveLength(1);
    expect(rig.requests("session.interrupt")).toHaveLength(0);
    expect(statuses(rig, "thr_q")).toEqual(["completed", "interrupted"]);
    expect(rig.fake.session("alex", sessionOf())!.running?.admission.text).toBe("outside long");
  });

  it("steer → session.steer into bb's own running turn; else a queued submit", async () => {
    await startThread(rig, "thr_st", opts());
    await turn(rig, "thr_st", [text("warm up")], opts());
    rig.fake.nextTurn("alex", { holdMs: 300 });
    await rig.call("turn/start", { threadId: "thr_st", providerThreadId: "x", input: [text("long")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => rig.fake.session("alex", sessionOf())!.running);
    await rig.waitFor(() => events(rig, "thr_st").some((e) => e.type === "turn/started" && statuses(rig, "thr_st").length === 1));
    const steer = await rig.call("turn/steer", { threadId: "thr_st", providerThreadId: "x", expectedTurnId: "t", clientRequestId: creq(), input: [text("also this")], options: { ...AUTO, ...opts() } });
    expect(steer.result).toEqual({});
    expect(rig.requests("session.steer").map((r) => r.params.text)).toEqual(["also this"]);
    await rig.waitFor(() => statuses(rig, "thr_st").length === 2);

    // Ours queued behind an outside turn: the steer becomes another queued submit, never session.steer.
    rig.fake.outsideTurn("alex", sessionOf(), "outside long", { script: { holdMs: 200 } });
    const second = creq();
    await rig.call("turn/start", { threadId: "thr_st", providerThreadId: "x", input: [text("mine")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => rig.requests("prompt.submit").length === 3);
    await rig.call("turn/steer", { threadId: "thr_st", providerThreadId: "x", expectedTurnId: "t", clientRequestId: second, input: [text("and that")], options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => statuses(rig, "thr_st").length === 3);
    expect(rig.requests("session.steer")).toHaveLength(1);
    expect(rig.requests("prompt.submit").at(-1)!.params).toMatchObject({ text: "and that", submission_id: `bb:thr_st:${second}` });
    expect(agentTexts(rig, "thr_st").slice(-2)).toEqual([expect.stringContaining("mine"), expect.stringContaining("and that")]);
  });
});

describe("/new and /reset (S8 step 7, A46)", () => {
  it("compresses the same chat with expected_generation; never a new session", async () => {
    await startThread(rig, "thr_n", opts());
    for (const t of ["one", "two", "three", "four"]) await turn(rig, "thr_n", [text(t)], opts());
    await turn(rig, "thr_n", [text("/new")], opts());
    for (const t of ["five", "six"]) await turn(rig, "thr_n", [text(t)], opts());
    await turn(rig, "thr_n", [text("/reset")], opts());
    expect(rig.requests("session.create")).toHaveLength(1);
    expect(rig.requests("prompt.submit")).toHaveLength(6);
    const mutates = rig.requests("session.mutate");
    expect(mutates.map((m) => m.params.operation)).toEqual(["compress", "compress"]);
    expect(mutates.every((m) => typeof m.params.expected_generation === "number" && !m.refused)).toBe(true);
    expect(events(rig, "thr_n").filter((e) => e.type === "thread/compacted")).toHaveLength(2);
    expect(warnings("thr_n")).toEqual([]);
  });

  it("a chat too short to compact: Hermes' noop → no context.compacted, a notice instead", async () => {
    await startThread(rig, "thr_ns", opts());
    for (const t of ["one", "two", "three"]) await turn(rig, "thr_ns", [text(t)], opts());
    await turn(rig, "thr_ns", [text("/new")], opts());
    expect(rig.requests("session.mutate").map((m) => m.params.operation)).toEqual(["compress"]);
    expect(events(rig, "thr_ns").filter((e) => e.type === "thread/compacted")).toEqual([]);
    expect(warnings("thr_ns")).toEqual([nothingCompactedText({ headline: "No changes from compression: 6 messages", note: null })]);
    expect(warnings("thr_ns")[0]).toBe("Nothing to compact yet: Hermes keeps the first and last messages (No changes from compression: 6 messages).");
    expect(statuses(rig, "thr_ns")).toEqual(["completed", "completed", "completed", "completed"]);
  });
});

describe("release (A24)", () => {
  it("detaches with the profile and end_reason null; no interruption", async () => {
    await startThread(rig, "thr_r", opts("bob"));
    await turn(rig, "thr_r", [text("hi")], opts("bob"));
    await rig.call("thread/stop", { threadId: "thr_r", providerThreadId: "x", intent: "release", activeTurnId: null });
    const [detach] = rig.requests("session.detach");
    expect(detach).toMatchObject({ profile: "bob", params: { end_reason: null } });
    expect(rig.fake.session("bob", detach!.params.session_id as string)!.end_reason).toBeNull();
    expect(statuses(rig, "thr_r")).toEqual(["completed"]);
  });
});

describe("event mapping (02 §Protocol mapping)", () => {
  it("reasoning, a tool and the reply become items; usage reaches bb", async () => {
    await startThread(rig, "thr_e", opts());
    await turn(rig, "thr_e", [text("look #tool #think")], opts());
    const items = events(rig, "thr_e").filter((e) => e.type === "item/completed").map((e) => (e.item as { type: string }).type);
    expect(items).toEqual(["reasoning", "fileRead", "agentMessage"]);
    expect(events(rig, "thr_e").map((e) => e.type)).toEqual(expect.arrayContaining(["thread/tokenUsage/updated", "thread/contextWindowUsage/updated"]));
  });
});

describe("release mid-turn", () => {
  it("never fabricates an interruption", async () => {
    await startThread(rig, "thr_rm", opts());
    rig.fake.nextTurn("alex", { holdMs: 2000 });
    await rig.call("turn/start", { threadId: "thr_rm", providerThreadId: "x", input: [text("long")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    await rig.waitFor(() => rig.requests("prompt.submit").length === 1);
    await rig.call("thread/stop", { threadId: "thr_rm", providerThreadId: "x", intent: "release", activeTurnId: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses(rig, "thr_rm")).toEqual([]);
    expect(rig.requests("session.interrupt")).toHaveLength(0);
  });
});
