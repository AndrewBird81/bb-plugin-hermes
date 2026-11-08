// T1.2: approvals and clarify (02 §Protocol mapping; 03 traps "Approvals"; A2, A3).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Refusal } from "../../test/fake-hermes/index.js";
import { ANSWERED_ELSEWHERE_TEXT, TIMED_OUT_TEXT } from "./interactions.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, events, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig({ secondMs: 10 });
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile = "alex", view: object = {}) => ({ providerOptions: rig.options(profile, view as never) });
type Req = { id: string; params: { threadId: string; turnId: null; payload: Record<string, any> } };
const requests = () => rig.rpc.messages.filter((m) => m.method === "interaction/request") as unknown as Req[];
const cancels = () => rig.rpc.messages.filter((m) => m.method === "notifications/cancelled").map((m) => (m.params as { requestId: string }).requestId);
const answer = (id: string, result: unknown) => rig.bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
const warnings = (threadId: string) => events(rig, threadId).filter((e) => e.type === "provider/warning").map((e) => e.summary ?? e.message);
const start = async (threadId: string, input: string, o = opts()) => {
  await rig.call("turn/start", { threadId, providerThreadId: "x", input: [text(input)], clientRequestId: creq(), options: { ...AUTO, ...o } });
};

describe("approvals", () => {
  it("a command approval: Hermes' choices only (always has no bb decision), the deadline; allow_once → once", async () => {
    await startThread(rig, "thr_ap", opts());
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "command", timeout_s: 600 } });
    await start("thr_ap", "run it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    expect(req!.params).toMatchObject({ threadId: "thr_ap", turnId: null });
    expect(req!.params.payload).toMatchObject({
      kind: "approval",
      subject: { kind: "command", command: "echo approved", itemId: expect.stringMatching(/:tool:call_/) },
      availableDecisions: ["allow_once", "deny", "allow_for_session"],
    });
    expect(req!.params.payload.reason).toMatch(/Hermes waits 600 s/);
    // Mode auto: nothing answers it but the user (A2).
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.requests("approval.respond")).toHaveLength(0);
    answer(req!.id, { decision: "allow_once", grantedPermissions: null });
    await rig.waitFor(() => statuses(rig, "thr_ap").length === 1);
    expect(rig.requests("approval.respond")[0]!.params).toMatchObject({ choice: "once", execution_generation: 1 });
    expect(statuses(rig, "thr_ap")).toEqual(["completed"]);
    expect(warnings("thr_ap")).toEqual([]);
  });

  it("an edit approval offers once/deny; deny → deny, the tool fails, nothing written", async () => {
    await startThread(rig, "thr_ed", opts());
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "edit", timeout_s: 600 } });
    await start("thr_ed", "edit it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    expect(req!.params.payload).toMatchObject({ subject: { kind: "file_change" }, availableDecisions: ["allow_once", "deny"] });
    answer(req!.id, { decision: "deny" });
    await rig.waitFor(() => statuses(rig, "thr_ed").length === 1);
    expect(rig.requests("approval.respond")[0]!.params.choice).toBe("deny");
    const tool = events(rig, "thr_ed").find((e) => e.type === "item/completed" && (e.item as { type: string }).type === "fileChange");
    expect(tool).toMatchObject({ item: { status: "failed" } });
  });

  it("timeout → closes with Timed out in Hermes (A3: the bridge withdraws the card)", async () => {
    await startThread(rig, "thr_to", opts());
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "command", timeout_s: 5 } });
    await start("thr_to", "run it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    await rig.waitFor(() => statuses(rig, "thr_to").length === 1);
    expect(cancels()).toContain(req!.id);
    expect(warnings("thr_to")).toEqual([TIMED_OUT_TEXT]);
    expect(rig.requests("approval.respond")).toHaveLength(0);
  });

  it("answered in another app → Answered elsewhere; a late bb answer is dropped", async () => {
    await startThread(rig, "thr_el", opts());
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "command", timeout_s: 600 } });
    await start("thr_el", "run it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
    const promptId = [...rig.fake.session("alex", sid)!.prompts.keys()][0]!;
    rig.fake.answerElsewhere("alex", sid, promptId, "once");
    await rig.waitFor(() => statuses(rig, "thr_el").length === 1);
    expect(cancels()).toContain(req!.id);
    expect(warnings("thr_el")).toEqual([ANSWERED_ELSEWHERE_TEXT]);
    answer(req!.id, { decision: "deny" });
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.requests("approval.respond")).toHaveLength(0);
  });

  it("already_resolved closes silently", async () => {
    await startThread(rig, "thr_ar", opts());
    rig.fake.handle("approval.respond", () => ({ status: "already_resolved", prompt_id: "x" }));
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "command", timeout_s: 30 } });
    await start("thr_ar", "run it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    answer(req!.id, { decision: "allow_once", grantedPermissions: null });
    await rig.waitFor(() => statuses(rig, "thr_ar").length === 1);
    expect(warnings("thr_ar")).toEqual([]);
  });

  it("a stale generation closes silently", async () => {
    await startThread(rig, "thr_sg", opts());
    rig.fake.handle("approval.respond", () => {
      throw new Refusal("stale_generation");
    });
    rig.fake.nextTurn("alex", { tool: true, approval: { kind: "command", timeout_s: 30 } });
    await start("thr_sg", "run it");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    answer(req!.id, { decision: "allow_once", grantedPermissions: null });
    await rig.waitFor(() => statuses(rig, "thr_sg").length === 1);
    expect(warnings("thr_sg")).toEqual([]);
  });

  it("an outside turn's approval is raised while ours waits behind it (R1 S1)", async () => {
    await startThread(rig, "thr_os", opts());
    await turn(rig, "thr_os", [text("warm up")], opts());
    const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
    rig.fake.outsideTurn("alex", sid, "outside asks", { script: { tool: true, approval: { kind: "command", timeout_s: 600 } } });
    await start("thr_os", "mine");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    answer(req!.id, { decision: "allow_once", grantedPermissions: null });
    await rig.waitFor(() => statuses(rig, "thr_os").length === 2);
    expect(rig.requests("approval.respond")).toHaveLength(1);
    expect(agentTexts(rig, "thr_os").at(-1)).toContain("mine");
  });

  it("an attach re-raises the snapshot's open prompts", async () => {
    const cli = await rig.cli();
    const snap = await cli.create({ profile: "alex", request_id: "cli-ask", source: "cli" });
    rig.fake.outsideTurn("alex", snap.session_id, "outside asks", { script: { tool: true, approval: { kind: "command", timeout_s: 600 } } });
    await rig.waitFor(() => rig.fake.session("alex", snap.session_id)!.prompts.size === 1);
    const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id, tag: "CLI" };
    await startThread(rig, "thr_rr", opts("alex", view));
    await start("thr_rr", "reply from bb", opts("alex", view));
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    expect(req!.params.payload.kind).toBe("approval");
    answer(req!.id, { decision: "allow_once", grantedPermissions: null });
    await rig.waitFor(() => statuses(rig, "thr_rr").length === 1);
    expect(rig.requests("approval.respond")).toHaveLength(1);
  });
});

describe("clarify", () => {
  it("Hermes' choices as options; the answer goes back as clarify.respond", async () => {
    await startThread(rig, "thr_cl", opts());
    rig.fake.nextTurn("alex", { clarify: { question: "red or blue?", choices: ["red (Recommended)", "blue"], timeout_s: 600 } });
    await start("thr_cl", "ask me");
    const [req] = await rig.waitFor(() => (requests().length ? requests() : null));
    const question = req!.params.payload.questions[0];
    expect(question).toMatchObject({ allowFreeText: false, multiSelect: false, options: [{ value: "red (Recommended)" }, { value: "blue" }] });
    expect(question.prompt).toMatch(/^red or blue\?/);
    answer(req!.id, { kind: "user_answer", answers: { [question.id]: { selected: ["blue"] } } });
    await rig.waitFor(() => statuses(rig, "thr_cl").length === 1);
    expect(rig.requests("clarify.respond")[0]!.params.answer).toBe("blue");
    expect(agentTexts(rig, "thr_cl")).toEqual(["blue"]);
  });
});
