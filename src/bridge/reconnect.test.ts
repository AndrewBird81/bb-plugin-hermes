// T1.5: reconnect and restart (02 flows 8–9; S8 E11b; 03 traps "Reconnect").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTARTED_TEXT } from "./thread.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, errors, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig();
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile = "alex", view: object = {}) => ({ providerOptions: rig.options(profile, view as never) });

describe("gateway restart mid-turn (S8 E11b)", () => {
  it("bb's own unknown admission → one prompt.resolve_unknown at once; the turn fails Hermes restarted: resend?", async () => {
    await startThread(rig, "thr_rs", opts());
    await turn(rig, "thr_rs", [text("warm up")], opts());
    rig.fake.nextTurn("alex", { holdMs: 10_000 });
    await rig.call("turn/start", { threadId: "thr_rs", providerThreadId: "x", input: [text("long")], clientRequestId: creq(), options: { ...AUTO, ...opts() } });
    const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
    await rig.waitFor(() => rig.fake.session("alex", sid)!.running);
    await rig.fake.restart();
    await rig.waitFor(() => statuses(rig, "thr_rs").length === 2, 8000);
    expect(statuses(rig, "thr_rs")).toEqual(["completed", "failed"]);
    expect(errors(rig, "thr_rs")).toEqual([RESTARTED_TEXT]);
    const resolves = rig.requests("prompt.resolve_unknown");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.params).toMatchObject({ session_id: sid, execution_generation: 2 });
    expect(rig.requests("prompt.submit")).toHaveLength(2); // never resent on its own (S8 step 4)
    // Conduit is no longer refused, and the next bb send runs.
    await expect(rig.fake.conduitTurn("alex", sid, "conduit after", { durationMs: 10 })).resolves.toBeTruthy();
    await turn(rig, "thr_rs", [text("again")], opts());
    expect(agentTexts(rig, "thr_rs").at(-1)).toContain("again");
  });

  it("a restart between turns: the next send works on the new gateway", async () => {
    await startThread(rig, "thr_rb", opts());
    await turn(rig, "thr_rb", [text("one")], opts());
    await rig.fake.restart();
    await turn(rig, "thr_rb", [text("two")], opts());
    expect(statuses(rig, "thr_rb")).toEqual(["completed", "completed"]);
    expect(rig.requests("session.create")).toHaveLength(1);
    expect(agentTexts(rig, "thr_rb").at(-1)).toContain("two");
  });
});

describe("bb or daemon restart (flow 9)", () => {
  it("the next turn comes as thread/resume{providerThreadId}; nothing touches Hermes before it", async () => {
    await startThread(rig, "thr_br", opts());
    await turn(rig, "thr_br", [text("one")], opts());
    const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
    const identity = (rig.notifications("thread/identity") as { providerThreadId: string }[]).at(-1)!.providerThreadId;
    rig.restartBridge();
    const before = rig.fake.requests.length;
    const res = await rig.call("thread/resume", { threadId: "thr_br", cwd: "/work", providerThreadId: identity, options: { ...AUTO }, instructionMode: "append" });
    expect(res.result).toEqual({ providerThreadId: identity, sessionRestorable: true });
    expect(rig.fake.requests.length).toBe(before);
    await turn(rig, "thr_br", [text("two")], opts("alex", { lineage_root: sid, session_id: sid }));
    expect(rig.requests("session.create")).toHaveLength(1);
    expect(rig.requests("prompt.submit").at(-1)!.params.session_id).toBe(sid);
  });

  it("a send retried by a restarted bridge reuses its submission_id and renders the turn that already ran (A4)", async () => {
    await startThread(rig, "thr_rt", opts());
    await turn(rig, "thr_rt", [text("warm up")], opts());
    const sid = rig.requests("prompt.submit")[0]!.params.session_id as string;
    const id = creq();
    await turn(rig, "thr_rt", [text("sent once")], opts("alex", { lineage_root: sid, session_id: sid }), id);
    rig.restartBridge();
    await rig.call("thread/resume", { threadId: "thr_rt", cwd: "/work", providerThreadId: "x", options: { ...AUTO }, instructionMode: "append" });
    await turn(rig, "thr_rt", [text("sent once")], opts("alex", { lineage_root: sid, session_id: sid }), id);
    expect(rig.fake.session("alex", sid)!.rows.filter((r) => r.role === "user").map((r) => r.content)).toEqual(["warm up", "sent once"]);
    expect(agentTexts(rig, "thr_rt")).toEqual(["echo(4): sent once"]);
    expect(statuses(rig, "thr_rt")).toEqual(["completed"]);
  });

  it("the same turn sent twice (a retry) is one admission in Hermes", async () => {
    await startThread(rig, "thr_dup", opts());
    const id = creq();
    await turn(rig, "thr_dup", [text("only once")], opts(), id);
    await turn(rig, "thr_dup", [text("only once")], opts(), id);
    const submits = rig.requests("prompt.submit");
    expect(submits.map((s) => s.params.submission_id)).toEqual([`bb:thr_dup:${id}`, `bb:thr_dup:${id}`]);
    const sid = submits[0]!.params.session_id as string;
    expect(rig.fake.session("alex", sid)!.rows.filter((r) => r.role === "user")).toHaveLength(1);
    expect(agentTexts(rig, "thr_dup")).toEqual(["echo(2): only once", "echo(2): only once"]);
  });
});
