// T1.4: the bot thread's Bot Chat (02 flow 3; S8 §Recommended protocol steps 1–6; 03 traps "Bot thread").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Refusal } from "../../test/fake-hermes/index.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, deltas, events, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig({ holdRetryMs: [30, 30, 60] });
});
afterEach(async () => {
  await rig.close();
});

const bot = (profile = "bob", view: object = {}) => ({ providerOptions: rig.options(profile, { kind: "bot", ...view } as never) });
const home = (profile: string) => rig.fake.profiles.find((p) => p.name === profile)!.home;
const banners = (threadId: string) =>
  deltas(rig, threadId)
    .filter((d) => d.kind === "extension.state" && d.extensionKind === "hermes/status")
    .map((d) => (d.payload as { banner: { kind: string } | null }).banner?.kind ?? null);

describe("Bot Chat by title (S8 steps 1–3)", () => {
  it("none yet → re-check, then one lazy hidden create; identity <home>#bot after the boundary", async () => {
    await startThread(rig, "thr_bot", bot());
    expect(rig.requests("session.list")).toHaveLength(0); // never at setup
    await turn(rig, "thr_bot", [text("hello bot")], bot());
    expect(rig.requests("session.list").map((r) => r.params)).toEqual([
      { profile: "bob", title: BOT_CHAT_TITLE, include_hidden: true },
      { profile: "bob", title: BOT_CHAT_TITLE, include_hidden: true },
    ]);
    const [create] = rig.requests("session.create");
    expect(create).toMatchObject({
      profile: "bob",
      params: { title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, request_id: `bb:botchat:${home("bob")}` },
    });
    expect(agentTexts(rig, "thr_bot")).toEqual(["echo(2): hello bot"]);
    expect((rig.notifications("thread/identity") as { providerThreadId: string }[]).at(-1)!.providerThreadId).toBe(`${home("bob")}#bot`);
  });

  it("an existing Bot Chat is found and resumed on every send; never created again", async () => {
    const cli = await rig.cli();
    const desk = await cli.create({ profile: "bob", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, request_id: "desktop-1" });
    await startThread(rig, "thr_b2", bot());
    await turn(rig, "thr_b2", [text("one")], bot());
    await turn(rig, "thr_b2", [text("two")], bot());
    expect(rig.requests("session.create").filter((r) => r.params.request_id !== "desktop-1")).toHaveLength(0);
    expect(rig.requests("session.list")).toHaveLength(2); // one lookup per send
    expect(rig.requests("session.resume").filter((r) => r.params.session_id === desk.session_id)).toHaveLength(1);
    expect(rig.requests("prompt.submit").map((r) => r.params.session_id)).toEqual([desk.session_id, desk.session_id]);
    expect(rig.requests("session.resume")[0]!.params.omit_messages).toBe(true);
  });

  it("the title moved to another session → the thread follows it (step 6)", async () => {
    await startThread(rig, "thr_mv", bot());
    await turn(rig, "thr_mv", [text("one")], bot());
    const first = rig.requests("prompt.submit")[0]!.params.session_id as string;
    rig.fake.session("bob", first)!.title = null; // renamed in Hermes
    const cli = await rig.cli();
    const fresh = await cli.create({ profile: "bob", title: BOT_CHAT_TITLE, hidden: true, request_id: "conduit-new" });
    await turn(rig, "thr_mv", [text("two")], bot());
    expect(rig.requests("prompt.submit").at(-1)!.params.session_id).toBe(fresh.session_id);
    const state = deltas(rig, "thr_mv").filter((d) => d.extensionKind === "hermes/persisted-turn").at(-1)!.payload as { lineage_root: string };
    expect(state.lineage_root).toBe(fresh.session_id);
  });

  it("not_found on submit → resolve by title again (S8 step 9)", async () => {
    await startThread(rig, "thr_nf", bot());
    await turn(rig, "thr_nf", [text("one")], bot());
    const submit = rig.fake.engine.handlers()["prompt.submit"]!;
    let refused = false;
    rig.fake.handle("prompt.submit", (params, ctx) => {
      if (!refused) {
        refused = true;
        throw new Refusal("not_found");
      }
      return submit(params, ctx);
    });
    await turn(rig, "thr_nf", [text("two")], bot());
    expect(statuses(rig, "thr_nf")).toEqual(["completed", "completed"]);
    expect(rig.requests("session.list").length).toBeGreaterThanOrEqual(3);
  });
});

describe("Conduit holds the chat (S8 step 3, E6)", () => {
  it("runtime_coordination_required → turn stays open with the banner, retries, never a second create; sends once free", async () => {
    const legacy = rig.fake.legacySession("bob", { title: BOT_CHAT_TITLE, hidden: true, held: true, turns: ["from conduit"] });
    await startThread(rig, "thr_h", bot());
    await rig.call("turn/start", { threadId: "thr_h", providerThreadId: "x", input: [text("from bb")], clientRequestId: creq(), options: { ...AUTO, ...bot() } });
    await rig.waitFor(() => rig.requests("session.list").filter((r) => r.refused).length >= 3);
    expect(banners("thr_h")).toEqual(["held"]);
    expect(statuses(rig, "thr_h")).toEqual([]);
    expect(rig.requests("session.create").length).toBeLessThanOrEqual(1);
    rig.fake.hold("bob", legacy, false);
    await rig.waitFor(() => statuses(rig, "thr_h").length === 1);
    expect(statuses(rig, "thr_h")).toEqual(["completed"]);
    expect(banners("thr_h")).toEqual(["held", null]);
    expect(rig.requests("prompt.submit").map((r) => r.params.session_id)).toEqual([legacy]);
    expect(rig.fake.session("bob", legacy)!.chat_id).toBe(legacy); // adopted by bb's send (D16)
    expect(rig.requests("session.create")).toHaveLength(0);
  });

  it("Stop drops the wait: nothing reaches Hermes", async () => {
    rig.fake.legacySession("bob", { title: BOT_CHAT_TITLE, hidden: true, held: true });
    await startThread(rig, "thr_hs", bot());
    await rig.call("turn/start", { threadId: "thr_hs", providerThreadId: "x", input: [text("from bb")], clientRequestId: creq(), options: { ...AUTO, ...bot() } });
    await rig.waitFor(() => banners("thr_hs").length === 1);
    await rig.call("thread/stop", { threadId: "thr_hs", providerThreadId: "x", intent: "interrupt", activeTurnId: null });
    expect(statuses(rig, "thr_hs")).toEqual(["interrupted"]);
    expect(banners("thr_hs")).toEqual(["held", null]);
    expect(rig.requests("prompt.submit")).toHaveLength(0);
  });

  it("Conduit busy on an adopted Bot Chat: bb's turn queues and shows Hermes' waiting status (step 5, E3a)", async () => {
    const cli = await rig.cli();
    const chat = await cli.create({ profile: "bob", title: BOT_CHAT_TITLE, hidden: true, request_id: "desk" });
    const conduit = rig.fake.conduitTurn("bob", chat.session_id, "conduit asks", { durationMs: 300 });
    await startThread(rig, "thr_w", bot());
    await turn(rig, "thr_w", [text("bb asks")], bot());
    await conduit;
    const waits = events(rig, "thr_w").filter((e) => e.type === "item/completed" && (e.item as { tool?: string }).tool === "hermes.wait");
    expect(waits).toHaveLength(1);
    expect(agentTexts(rig, "thr_w")).toEqual([expect.stringContaining("bb asks")]);
  });
});

describe("/new in a bot thread", () => {
  it("with no Bot Chat yet: nothing to compact, no session created", async () => {
    await startThread(rig, "thr_bn", bot());
    await turn(rig, "thr_bn", [text("/new")], bot());
    expect(rig.requests("session.create")).toHaveLength(0);
    expect(rig.requests("session.mutate")).toHaveLength(0);
    expect(statuses(rig, "thr_bn")).toEqual(["completed"]);
  });

  it("compacts the same Bot Chat: same lineage, context.compacted (01 §4 AC)", async () => {
    await startThread(rig, "thr_bc", bot("alex"));
    await turn(rig, "thr_bc", [text("one")], bot("alex"));
    await turn(rig, "thr_bc", [text("/new")], bot("alex"));
    expect(rig.requests("session.create")).toHaveLength(1);
    expect(rig.requests("session.mutate").map((m) => m.params.operation)).toEqual(["compress"]);
    expect(events(rig, "thr_bc").some((e) => e.type === "thread/compacted")).toBe(true);
  });
});

describe("a rotated Bot Chat (S8 E8; rotating-viewer.json)", () => {
  it("the title on the tip is the same chat: lineage root stays the root, session_id names the tip", async () => {
    await rig.close();
    rig = await startRig({ rotating: ["bob"] });
    await startThread(rig, "thr_rot", bot());
    await turn(rig, "thr_rot", [text("one")], bot());
    await turn(rig, "thr_rot", [text("two")], bot());
    const root = rig.requests("prompt.submit")[0]!.params.session_id as string;
    // Another app compresses: bb's socket hears nothing about the tip.
    const cli = await rig.cli();
    const snap = await cli.resume({ profile: "bob", session_id: root, omit_messages: true });
    await cli.mutate({ profile: "bob", session_id: root, request_id: "desk-compress", expected_revision: snap.revision, expected_generation: snap.execution_generation, operation: "compress", payload: {} });
    const tip = rig.fake.engine.tipOf(rig.fake.session("bob", root)!).id;
    expect(tip).not.toBe(root);
    await turn(rig, "thr_rot", [text("three")], bot());
    expect(rig.requests("session.create").filter((r) => r.params.title === BOT_CHAT_TITLE)).toHaveLength(1);
    expect(statuses(rig, "thr_rot")).toEqual(["completed", "completed", "completed"]);
    const state = deltas(rig, "thr_rot").filter((d) => d.extensionKind === "hermes/persisted-turn").at(-1)!.payload as { lineage_root: string; session_id: string };
    expect(state).toEqual(expect.objectContaining({ lineage_root: root, session_id: tip }));
  });
});
