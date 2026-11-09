// T1.6: replay and mirror (02 flows 5–7; 03 traps "Mirror modes", "Legacy binding", "Compaction clone").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeMarker, type Marker } from "../shared/marker.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { EARLIER_TEXT } from "./thread.js";
import { AUTO, creq, type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { agentTexts, deltas, events, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig({ rotating: ["bob"] });
});
afterEach(async () => {
  await rig.close();
});

const home = (profile: string) => rig.fake.profiles.find((p) => p.name === profile)!.home;
const view = (id: string, more: object = {}) => ({ kind: "mirror", lineage_root: id, session_id: id, ...more });
const opts = (profile: string, v: object) => ({ providerOptions: rig.options(profile, v as never) });
/** A wake as the server sends it: `labeled` when a bubble comes before the marker. */
const wake = (marker: Marker, label: string | null = "[Outside bb] hi") =>
  label ? [text(label), encodeMarker({ ...marker, labeled: true } as Marker)] : [encodeMarker(marker)];
const mirrored = (threadId: string) =>
  (deltas(rig, threadId).filter((d) => d.extensionKind === "hermes/persisted-turn").at(-1)?.payload as { mirrored: { anchor_uid: string; reply_uids: string[]; partial: boolean }[] } | undefined)?.mirrored ?? [];

/** A CLI chat with finished turns; returns its id and each turn's user uid. */
async function cliChat(profile: string, asks: string[]): Promise<{ id: string; anchors: string[] }> {
  const cli = await rig.cli();
  const snap = await cli.create({ profile, request_id: `cli-${creq()}`, source: "cli" });
  for (const [i, ask] of asks.entries()) {
    await cli.submit({ profile, session_id: snap.session_id, text: ask, submission_id: `cli-sub-${i}-${creq()}` });
    await rig.waitFor(() => rig.fake.session(profile, snap.session_id)!.rows.filter((r) => r.role === "assistant").length === i + 1);
  }
  const rows = rig.fake.session(profile, snap.session_id)!.rows;
  return { id: snap.session_id, anchors: rows.filter((r) => r.role === "user").map((r) => r.message_uid) };
}

/** The uid of the user row with this text, once Hermes stored it. */
const userRow = (profile: string, id: string, content: string) =>
  rig.waitFor(() => rig.fake.session(profile, id)!.rows.find((r) => r.role === "user" && r.content === content)?.message_uid);

const canonical = () => rig.fake.requests.filter((r) => ["session.resume", "session.create", "prompt.submit", "session.mutate"].includes(r.method) && !String(r.params.request_id ?? r.params.submission_id ?? "").startsWith("cli-"));

describe("replay (flow 5)", () => {
  it("bind renders that turn from history only; since → the note; identity after the boundary", async () => {
    const chat = await cliChat("alex", ["first ask", "second ask"]);
    await startThread(rig, "thr_imp", opts("alex", view(chat.id)));
    const before = canonical().length;
    await turn(rig, "thr_imp", wake({ op: "bind", profile_home: home("alex"), lineage_root: chat.id, legacy: false, anchor_uid: chat.anchors[0]!, since: 1 }, "[Outside bb · Oct 12] first ask"), opts("alex", view(chat.id)));
    await turn(rig, "thr_imp", wake({ op: "replay", anchor_uid: chat.anchors[1]! }, "[Outside bb · Oct 12] second ask"), opts("alex", view(chat.id)));
    expect(canonical().length).toBe(before); // no canonical call (D16)
    expect(agentTexts(rig, "thr_imp")).toEqual([EARLIER_TEXT, "echo(2): first ask", "echo(4): second ask"]);
    expect((rig.notifications("thread/identity") as { providerThreadId: string }[]).at(-1)!.providerThreadId).toBe(`${home("alex")}#${chat.id}`);
  });

  it("records each replayed turn with the reply rows it showed, so the server settles only what ran; a missing anchor records none", async () => {
    const chat = await cliChat("alex", ["first ask", "second ask"]);
    const rows = rig.fake.session("alex", chat.id)!.rows;
    const reply = (i: number) => rows.filter((r) => r.role === "assistant")[i]!.message_uid;
    await startThread(rig, "thr_rec", opts("alex", view(chat.id)));
    await turn(rig, "thr_rec", wake({ op: "bind", profile_home: home("alex"), lineage_root: chat.id, legacy: false, anchor_uid: chat.anchors[0]! }, "[Outside bb · Oct 12] first ask"), opts("alex", view(chat.id)));
    await turn(rig, "thr_rec", wake({ op: "replay", anchor_uid: chat.anchors[1]! }, "[Outside bb · Oct 12] second ask"), opts("alex", view(chat.id)));
    await turn(rig, "thr_rec", wake({ op: "replay", anchor_uid: "gone-uid" }, "[Outside bb · Oct 12] gone"), opts("alex", view(chat.id)));
    expect(mirrored("thr_rec")).toEqual([
      expect.objectContaining({ anchor_uid: chat.anchors[0], reply_uids: [reply(0)], partial: false }),
      expect.objectContaining({ anchor_uid: chat.anchors[1], reply_uids: [reply(1)], partial: false }),
      expect.objectContaining({ anchor_uid: "gone-uid", reply_uids: [], partial: true }),
    ]);
  });
});

describe("mirror modes (flow 6)", () => {
  it("complete → render rows; recorded as shown", async () => {
    const chat = await cliChat("alex", ["outside"]);
    await startThread(rig, "thr_c", opts("alex", view(chat.id)));
    await turn(rig, "thr_c", wake({ op: "mirror", anchor_uid: chat.anchors[0]! }), opts("alex", view(chat.id)));
    expect(agentTexts(rig, "thr_c")).toEqual(["echo(2): outside"]);
    const reply = rig.fake.session("alex", chat.id)!.rows[1]!.message_uid;
    expect(mirrored("thr_c")).toEqual([expect.objectContaining({ anchor_uid: chat.anchors[0], reply_uids: [reply], partial: false })]);
  });

  it("running as canonical work → attach from its first seq, close on its message.complete; streamed == final (A19)", async () => {
    const chat = await cliChat("alex", ["warm up"]);
    await startThread(rig, "thr_live", opts("alex", view(chat.id)));
    rig.fake.outsideTurn("alex", chat.id, "slow outside", { script: { chunkMs: 40, reply: "a reply that streams in several chunks" } });
    await rig.waitFor(() => rig.fake.session("alex", chat.id)!.running);
    // Hermes stores the user row when the turn starts (per-step flush): the wake names it.
    await turn(rig, "thr_live", wake({ op: "mirror", anchor_uid: await userRow("alex", chat.id, "slow outside") }), opts("alex", view(chat.id)));
    expect(agentTexts(rig, "thr_live")).toEqual(["a reply that streams in several chunks"]);
    expect(statuses(rig, "thr_live")).toEqual(["completed"]);
    expect(rig.requests("prompt.submit").filter((r) => String(r.params.submission_id).startsWith("bb:"))).toHaveLength(0);
  });

  it("Conduit's own turn (no canonical admission) → nothing beyond the bubble, partial; then rest renders only new rows", async () => {
    const cli = await rig.cli();
    const chat = await cli.create({ profile: "alex", title: BOT_CHAT_TITLE, hidden: true, request_id: "desk" });
    const conduit = rig.fake.conduitTurn("alex", chat.session_id, "conduit asks", { durationMs: 200, reply: "conduit reply" });
    await rig.waitFor(() => rig.fake.session("alex", chat.session_id)!.rows.length === 1);
    const anchor = rig.fake.session("alex", chat.session_id)!.rows[0]!.message_uid;
    const v = { kind: "bot", lineage_root: chat.session_id, session_id: chat.session_id };
    await startThread(rig, "thr_cd", opts("alex", v));
    await turn(rig, "thr_cd", wake({ op: "mirror", anchor_uid: anchor }, "[Outside bb] conduit asks"), opts("alex", v));
    expect(agentTexts(rig, "thr_cd")).toEqual([]);
    expect(mirrored("thr_cd")).toEqual([expect.objectContaining({ anchor_uid: anchor, reply_uids: [], partial: true })]);
    await conduit;
    await turn(rig, "thr_cd", wake({ op: "mirror", anchor_uid: anchor, rest: true }, null), opts("alex", v));
    await turn(rig, "thr_cd", wake({ op: "mirror", anchor_uid: anchor, rest: true }, null), opts("alex", v));
    expect(agentTexts(rig, "thr_cd")).toEqual(["conduit reply"]); // once, not twice
    expect(mirrored("thr_cd")).toEqual([expect.objectContaining({ anchor_uid: anchor, partial: false })]);
  });

  it("a foreign admission on bb's subscription (E3b) renders only through its wake, from its first seq", async () => {
    const cli = await rig.cli();
    const chat = await cli.create({ profile: "alex", title: BOT_CHAT_TITLE, hidden: true, request_id: "desk2" });
    const v = { kind: "bot", lineage_root: chat.session_id, session_id: chat.session_id };
    await startThread(rig, "thr_fw", opts("alex", v));
    rig.fake.nextTurn("alex", { holdMs: 150 });
    await rig.call("turn/start", { threadId: "thr_fw", providerThreadId: "x", input: [text("bb first")], clientRequestId: creq(), options: { ...AUTO, ...opts("alex", v) } });
    await rig.waitFor(() => rig.fake.session("alex", chat.session_id)!.running);
    const sent = await rig.fake.conduitTurn("alex", chat.session_id, "conduit during bb", { reply: "unused" });
    expect(sent).toMatchObject({ status: "queued", forwarded: true });
    await rig.waitFor(() => statuses(rig, "thr_fw").length === 1);
    await rig.waitFor(() => !rig.fake.session("alex", chat.session_id)!.running && rig.fake.session("alex", chat.session_id)!.rows.length === 4);
    expect(agentTexts(rig, "thr_fw")).toEqual([expect.stringContaining("bb first")]); // nothing of Conduit's yet
    const anchor = rig.fake.session("alex", chat.session_id)!.rows[2]!.message_uid;
    await turn(rig, "thr_fw", wake({ op: "mirror", anchor_uid: anchor }, "[Outside bb] conduit during bb"), opts("alex", v));
    expect(agentTexts(rig, "thr_fw")).toEqual([expect.stringContaining("bb first"), expect.stringContaining("conduit during bb")]);
  });
});

describe("legacy rows (D16, A23)", () => {
  it("0 session.resume and 0 session.mutate before the first bb send; that send adopts it", async () => {
    const legacy = rig.fake.legacySession("alex", { turns: ["old conduit turn"] });
    const rows = () => rig.fake.session("alex", legacy)!.rows;
    const v = view(legacy, { legacy: true });
    await startThread(rig, "thr_lg", opts("alex", v));
    await turn(rig, "thr_lg", wake({ op: "mirror", anchor_uid: rows()[0]!.message_uid }, "[Outside bb] old conduit turn"), opts("alex", v));
    const pending = rig.fake.conduitTurn("alex", legacy, "conduit again", { durationMs: 100 });
    await rig.waitFor(() => rows().length === 3);
    await turn(rig, "thr_lg", wake({ op: "mirror", anchor_uid: rows()[2]!.message_uid }, "[Outside bb] conduit again"), opts("alex", v));
    await pending;
    expect(rig.requests("session.resume")).toHaveLength(0);
    expect(rig.requests("session.mutate")).toHaveLength(0);
    expect(rig.fake.session("alex", legacy)!.chat_id).toBeNull();
    rig.fake.hold("alex", legacy, false); // the dashboard lets go of its claim (S8 E10)
    await turn(rig, "thr_lg", [text("reply from bb")], opts("alex", v));
    expect(rig.requests("session.resume")).toHaveLength(1);
    expect(rig.fake.session("alex", legacy)!.chat_id).toBe(legacy);
    expect(agentTexts(rig, "thr_lg")).toEqual(["echo(2): old conduit turn", expect.stringContaining("reply from bb")]);
  });
});

describe("compaction and rotation (flow 7, A8)", () => {
  it("a rotating compress: the live session stays the root, history follows the tip; one compacted, nothing renders twice", async () => {
    const v = opts("bob", { kind: "chat" });
    await startThread(rig, "thr_rot", v);
    for (const t of ["one", "two", "three", "four"]) await turn(rig, "thr_rot", [text(t)], v);
    const root = rig.requests("prompt.submit")[0]!.params.session_id as string;
    await turn(rig, "thr_rot", [text("/new")], v);
    const tip = rig.fake.engine.tipOf(rig.fake.session("bob", root)!).id;
    expect(tip).not.toBe(root);
    await turn(rig, "thr_rot", [text("five")], v);
    // As recorded (rotating-viewer.json): the root keeps the live session; bb keeps submitting by it.
    expect(rig.requests("prompt.submit").map((r) => r.params.session_id)).toEqual(Array(5).fill(root));
    // One compacted, from the compress result: a `stored_session_id` that stays the root adds none.
    expect(events(rig, "thr_rot").filter((e) => e.type === "thread/compacted")).toHaveLength(1);
    expect(agentTexts(rig, "thr_rot")).toEqual(["echo(2): one", "echo(4): two", "echo(6): three", "echo(8): four", expect.stringContaining("five")]);
    // The persisted state names the tip for history, the root as the lineage root.
    const state = deltas(rig, "thr_rot").filter((d) => d.extensionKind === "hermes/persisted-turn").at(-1)!.payload as { lineage_root: string; session_id: string };
    expect(state).toMatchObject({ lineage_root: root, session_id: tip });
    // A mirror of a cloned anchor renders that turn once (A8).
    const anchor = rig.fake.engine.tipOf(rig.fake.session("bob", root)!).rows.find((r) => r.role === "user")!.message_uid;
    await turn(rig, "thr_rot", wake({ op: "mirror", anchor_uid: anchor }, null), v);
    expect(agentTexts(rig, "thr_rot").filter((t) => t === "echo(2): one")).toHaveLength(2); // the first answer and the mirror render
  });
});

describe("Stop on outside turns (01 §5, D27 narrowed)", () => {
  const stop = (threadId: string) => rig.call("thread/stop", { threadId, providerThreadId: "x", intent: "interrupt", activeTurnId: null });
  const banners = (threadId: string) =>
    deltas(rig, threadId)
      .filter((d) => d.extensionKind === "hermes/status")
      .map((d) => (d.payload as { banner: unknown }).banner);

  it("a CLI turn: bb stops watching, the banner says Running outside bb, Hermes keeps running it", async () => {
    const chat = await cliChat("alex", ["warm up"]);
    await startThread(rig, "thr_sc", opts("alex", view(chat.id)));
    rig.fake.outsideTurn("alex", chat.id, "slow outside", { script: { chunkMs: 50, reply: "one two three four five six seven" } });
    await rig.waitFor(() => rig.fake.session("alex", chat.id)!.running);
    const anchor = await userRow("alex", chat.id, "slow outside");
    await rig.call("turn/start", { threadId: "thr_sc", providerThreadId: "x", input: wake({ op: "mirror", anchor_uid: anchor }), clientRequestId: creq(), options: { ...AUTO, ...opts("alex", view(chat.id)) } });
    await rig.waitFor(() => events(rig, "thr_sc").some((e) => e.type === "item/agentMessage/delta"));
    await stop("thr_sc");
    expect(statuses(rig, "thr_sc")).toEqual(["interrupted"]);
    expect(rig.requests("session.interrupt")).toHaveLength(0);
    expect(banners("thr_sc")).toEqual([null, { kind: "running_elsewhere" }]);
    expect(rig.fake.session("alex", chat.id)!.running).toBeTruthy();
  });

  it("a forwarded Conduit turn: Stop interrupts it, fenced by its generation (S8 step 8)", async () => {
    const cli = await rig.cli();
    const chat = await cli.create({ profile: "alex", title: BOT_CHAT_TITLE, hidden: true, request_id: "desk3" });
    const v = { kind: "bot", lineage_root: chat.session_id, session_id: chat.session_id };
    await startThread(rig, "thr_sf", opts("alex", v));
    rig.fake.nextTurn("alex", { holdMs: 100 });
    await rig.call("turn/start", { threadId: "thr_sf", providerThreadId: "x", input: [text("bb first")], clientRequestId: creq(), options: { ...AUTO, ...opts("alex", v) } });
    await rig.waitFor(() => rig.fake.session("alex", chat.session_id)!.running);
    rig.fake.nextTurn("alex", { holdMs: 5000 });
    await rig.fake.conduitTurn("alex", chat.session_id, "conduit during bb");
    await rig.waitFor(() => statuses(rig, "thr_sf").length === 1);
    await rig.waitFor(() => rig.fake.session("alex", chat.session_id)!.running?.admission.submission_id?.startsWith("desktop-forward-"));
    await rig.call("turn/start", { threadId: "thr_sf", providerThreadId: "x", input: wake({ op: "mirror", anchor_uid: await userRow("alex", chat.session_id, "conduit during bb") }, "[Outside bb] conduit during bb"), clientRequestId: creq(), options: { ...AUTO, ...opts("alex", v) } });
    await rig.waitFor(() => events(rig, "thr_sf").filter((e) => e.type === "turn/started").length === 2);
    await new Promise((r) => setTimeout(r, 30));
    await stop("thr_sf");
    expect(rig.requests("session.interrupt")).toHaveLength(1);
    expect(statuses(rig, "thr_sf")).toEqual(["completed", "interrupted"]);
  });
});
