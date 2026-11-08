// The strict fake's session engine (03 §Strict fake Hermes): the Hermes behaviours bb relies on, driven through
// bb's own canonical client and history reader. `fake.violations` stays empty in every test.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesClient, HermesRpcError, localDial } from "../../src/hermes/client.js";
import { groupTurns, listSessions, readChain, readMessages, type RestMessage } from "../../src/hermes/history.js";
import type { GatewayEvent, Snapshot } from "../../src/hermes/types.js";
import { REPLAY_BUFFER_MAX } from "./engine.js";
import { startFakeHermes, type FakeHermes, type FakeOptions } from "./index.js";

const cleanups: (() => unknown)[] = [];
const fakes: FakeHermes[] = [];
afterEach(async () => {
  n = 0;
  for (const f of fakes.splice(0)) expect(f.violations).toEqual([]);
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fake(opts: FakeOptions = {}): Promise<FakeHermes> {
  const f = await startFakeHermes(opts);
  cleanups.push(() => f.stop());
  fakes.push(f);
  return f;
}

/** bb's canonical client with every event it receives. */
async function client(f: FakeHermes) {
  const c = await HermesClient.connect((await localDial(f.folder)).dial);
  cleanups.push(() => c.close());
  const events: GatewayEvent[] = [];
  c.onEvent((e) => events.push(e));
  const until = async (check: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 5))) if (Date.now() > end) throw new Error("timeout");
  };
  const of = (type: string, session?: string) => events.filter((e) => e.type === type && (!session || e.session_id === session));
  const completes = (session: string) => of("message.complete", session);
  const create = (profile: string, request_id: string, extra: object = {}) => c.create({ profile, request_id, source: "cli", cwd: "/tmp/work", ...extra });
  const submit = (profile: string, session_id: string, text: string, extra: object = {}) =>
    c.submit({ profile, session_id, text, submission_id: `bb:thr_t:${++n}`, turn_author: { id: "bb:thr_t", name: "bb" }, ...extra });
  const turn = async (profile: string, session_id: string, text: string) => {
    const before = completes(session_id).length;
    const adm = await submit(profile, session_id, text);
    await until(() => completes(session_id).length > before);
    return adm;
  };
  return { c, events, until, of, completes, create, submit, turn };
}
/** Submission ids stay unique across clients: a repeated one is the same request to Hermes. */
let n = 0;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: HermesRpcError) => ({ reason: e.reason, ...e.data }));

/** Every recorded REST key set, by route (test/fixtures/rest/, and the T1.0 frames' `exchanges`). */
const recordedKeys = (() => {
  const dirs = [path.join(import.meta.dirname, "../fixtures/rest"), path.join(import.meta.dirname, "../fixtures/frames")];
  const list = new Set<string>();
  const messages = new Set<string>();
  for (const f of dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".json") && n !== "live-list-keys.json").map((n) => path.join(d, n)))) {
    for (const x of JSON.parse(readFileSync(f, "utf8")).exchanges as { path: string; body: { sessions?: object[]; messages?: object[] } }[]) {
      for (const r of x.body.sessions ?? []) list.add(Object.keys(r).sort().join());
      for (const r of x.body.messages ?? []) messages.add(Object.keys(r).sort().join());
    }
  }
  return { list, messages };
})();
const keysOf = (o: object) => Object.keys(o).sort().join();

describe("engine: create, resume, submit, stream", () => {
  it("creates by request_id (Hermes' local_identity), idempotently, and subscribes the caller", async () => {
    const f = await fake();
    const k = await client(f);
    const snap = await k.create("alex", "bb:thr_a");
    const alex = path.join(f.folder, "profiles/alex");
    const id = "local-" + createHash("sha256").update(JSON.stringify([alex, `uid:${process.getuid!()}`, "bb:thr_a"])).digest("hex");
    expect(snap).toMatchObject({ session_id: id, stored_session_id: id, running: false, revision: 0, execution_generation: 0, pending: [], prompts: [], message_count: 0, info: { source: "cli", cwd: "/tmp/work" } });
    expect((await k.create("alex", "bb:thr_a")).session_id).toBe(id);
    expect(f.session("alex", id)).toMatchObject({ created_source: "cli", source: "local", chat_id: id });
    // Other profiles get other ids for the same request id.
    expect((await k.create("bob", "bb:thr_a")).session_id).not.toBe(id);
  });

  it("a Bot Chat create returns the existing Bot Chat (S8 E1); session.list finds it by title, hidden", async () => {
    const f = await fake();
    const k = await client(f);
    const first = await k.c.create({ profile: "alex", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:a" });
    const again = await k.c.create({ profile: "alex", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:other" });
    expect(again.session_id).toBe(first.session_id);
    const found = await k.c.sessionList({ profile: "alex", title: "Bot Chat", include_hidden: true });
    expect(found).toEqual({ scope: "stored", sessions: [expect.objectContaining({ session_id: first.session_id, id: first.session_id, title: "Bot Chat", source: "local", running: true })] });
    expect(await k.c.sessionList({ profile: "bob", title: "Bot Chat", include_hidden: true })).toEqual({ sessions: [], scope: "stored" });
    // Hidden: not in the REST list, not in the live or stored lists without include_hidden.
    expect((await listSessions(f.folder, "alex", { order: "recent", archived: "include", limit: 100 })).sessions).toEqual([]);
    expect((await k.c.sessionList({ profile: "alex", scope: "stored" })).sessions).toEqual([]);
    expect((await k.c.sessionList({ profile: "alex", scope: "stored", include_hidden: true })).sessions).toHaveLength(1);
  });

  it("streams a turn as Hermes does and stores its rows: ids as persisted_turn says, uids, bb's submission_id", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_s");
    const adm = await k.submit("alex", sid, "hello one");
    expect(adm).toMatchObject({ status: "queued", outcome: null, execution_generation: null, ref: { session_id: sid } });
    await k.until(() => k.completes(sid).length === 1);
    const types = k.events.filter((e) => e.session_id === sid).map((e) => e.type);
    expect(types).toEqual(["session.info", "message.start", "session.info", "agent.step", "message.delta", "message.delta", "message.delta", "session.usage", "message.complete", "session.info"]);
    const complete = k.completes(sid)[0]!;
    expect(complete).toMatchObject({ admission_id: adm.admission_id, execution_generation: 1, payload: { text: "echo(2): hello one", outcome: "completed", status: "complete" } });
    const deltas = k.of("message.delta", sid).map((e) => e.payload!.text).join("");
    expect(deltas).toBe("echo(2): hello one");
    const persisted = complete.payload!.persisted_turn as { row_ids: number[]; user_row_id: number; final_assistant_row_id: number; submission_id: string };
    const page = await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 });
    expect(page.messages.map((m) => (m as RestMessage & { id: number }).id)).toEqual(persisted.row_ids);
    expect(page.messages.map((m) => [m.role, m.content, m.display_metadata?.submission_id ?? null])).toEqual([
      ["user", "hello one", "bb:thr_t:1"],
      ["assistant", "echo(2): hello one", null],
    ]);
    expect(persisted).toMatchObject({ user_row_id: persisted.row_ids[0], final_assistant_row_id: persisted.row_ids[1], submission_id: "bb:thr_t:1" });
    // The second turn sees the first in its context, as the recorded stub did (`echo(4)`).
    await k.turn("alex", sid, "hello two");
    expect(k.completes(sid)[1]!.payload!.text).toBe("echo(4): hello two");
    const chain = await readChain(f.folder, "alex", sid);
    expect(groupTurns(chain.messages).map((t) => t.submission_id)).toEqual(["bb:thr_t:1", "bb:thr_t:2"]);
    const resumed = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    expect(resumed).toMatchObject({ revision: 2, execution_generation: 2, message_count: 4, messages: [], messages_omitted: true, running: false });
  });

  it("flushes a canonical turn's rows per step: the user row mid-turn, the tool rows when the tool ends, the reply at the end", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_flush");
    const roles = async () => (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages.map((m) => m.role);
    f.nextTurn("alex", { tool: true, approval: {}, chunkMs: 40, reply: "a b c d e f" });
    await k.submit("alex", sid, "go");
    await k.until(() => k.of("approval.request", sid).length === 1);
    expect(await roles()).toEqual(["user"]);
    const { prompt_id } = k.of("approval.request", sid)[0]!.payload as { prompt_id: string };
    await k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id, choice: "once" });
    await k.until(() => k.of("message.delta", sid).filter((e) => e.payload!.text).length >= 1);
    expect(await roles()).toEqual(["user", "assistant", "tool"]);
    await k.until(() => k.completes(sid).length === 1);
    expect(await roles()).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("runs one turn per submission_id and queues the rest in order (FIFO)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_q");
    f.nextTurn("alex", { chunkMs: 30 });
    const a = await k.submit("alex", sid, "first");
    const b = await k.submit("alex", sid, "second");
    const repeat = await k.c.submit({ profile: "alex", session_id: sid, text: "first", submission_id: "bb:thr_t:1", turn_author: { id: "bb:thr_t", name: "bb" } });
    expect(repeat.admission_id).toBe(a.admission_id);
    expect(b.sequence).toBe(a.sequence + 1);
    const snap = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    expect(snap.pending.map((p) => [p.admission_id, p.status])).toEqual([
      [a.admission_id, "started"],
      [b.admission_id, "queued"],
    ]);
    await k.until(() => k.completes(sid).length === 2);
    expect(k.completes(sid).map((e) => e.admission_id)).toEqual([a.admission_id, b.admission_id]);
    expect(await k.c.submit({ profile: "alex", session_id: sid, text: "first", submission_id: "bb:thr_t:1", turn_author: { id: "bb:thr_t", name: "bb" } })).toMatchObject({ admission_id: a.admission_id, status: "terminal", outcome: "completed" });
    expect(await refusal(k.c.submit({ profile: "alex", session_id: sid, text: "changed", submission_id: "bb:thr_t:1" }))).toMatchObject({ reason: "admission_conflict", field: "request_id" });
  });

  it("refuses like Hermes: a submit without a subscription or a submission_id, an unknown session", async () => {
    const f = await fake();
    const k = await client(f);
    const other = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_r");
    expect(await refusal(other.c.submit({ profile: "alex", session_id: sid, text: "x", submission_id: "bb:x:1" }))).toMatchObject({ reason: "permission_denied" });
    expect(await refusal(k.c.submit({ profile: "alex", session_id: sid, text: "x" } as never))).toMatchObject({ reason: "invalid_params" });
    expect(await refusal(k.c.resume({ profile: "alex", session_id: "local-nope" }))).toMatchObject({ reason: "not_found" });
    expect(await refusal(k.c.interrupt({ profile: "alex", session_id: "local-nope", execution_generation: 0 }))).toMatchObject({ reason: "not_found" });
  });

  it("detach with end_reason null keeps the row (A24); a reason ends it", async () => {
    const f = await fake();
    const k = await client(f);
    const snap = await k.create("alex", "bb:thr_d");
    await k.turn("alex", snap.session_id, "hi");
    const resumed = await k.c.resume({ profile: "alex", session_id: snap.session_id, omit_messages: true });
    expect(await k.c.detach({ profile: "alex", session_id: snap.session_id, subscription_id: "other", end_reason: null })).toMatchObject({ detached: false });
    expect(await k.c.detach({ profile: "alex", session_id: snap.session_id, subscription_id: resumed.subscription_id, end_reason: null })).toMatchObject({ detached: true });
    expect(f.session("alex", snap.session_id)).toMatchObject({ ended_at: null, end_reason: null });
    const list = await listSessions(f.folder, "alex", { order: "recent", archived: "include", limit: 100 });
    expect(list.sessions[0]).toMatchObject({ id: snap.session_id, ended_at: null });
    const again = await k.c.resume({ profile: "alex", session_id: snap.session_id, omit_messages: true });
    await k.c.detach({ profile: "alex", session_id: snap.session_id, subscription_id: again.subscription_id, end_reason: "cli_close" });
    expect(f.session("alex", snap.session_id)).toMatchObject({ end_reason: "cli_close" });
  });

  it("signals changes: a state.db-wal touch in the profile home; sessions.changed only for the root profile", async () => {
    const f = await fake();
    const k = await client(f);
    const watcher = await client(f);
    const wal = path.join(f.folder, "profiles/alex/state.db-wal");
    const { session_id: sid } = await k.create("alex", "bb:thr_w");
    const size = statSync(wal).size;
    await k.turn("alex", sid, "hi");
    expect(statSync(wal).size).toBeGreaterThan(size);
    // T1.0 (secondary profiles): no sessions.changed on canonical sockets.
    expect(watcher.of("sessions.changed")).toEqual([]);
    expect(watcher.of("message.complete")).toEqual([]); // not subscribed: no session events
    // The live spike S4 (root profile): sessions.changed after each turn.
    const root = (await k.create("default", "bb:thr_root")).session_id;
    await k.turn("default", root, "hi");
    expect(watcher.of("sessions.changed").length).toBeGreaterThan(0);
    expect(statSync(path.join(f.folder, "state.db-wal")).size).toBeGreaterThan(0);
  });

  it("A50: image attachments staged in the profile's cache/images; anything else is invalid_params (T1.0)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_att");
    const images = path.join(f.folder, "profiles/alex/cache/images");
    mkdirSync(images, { recursive: true });
    const png = path.join(images, "pixel.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    copyFileSync(png, path.join(f.folder, "pixel.png"));
    writeFileSync(path.join(images, "note.txt"), "note");
    for (const att of [
      { path: path.join(f.folder, "pixel.png"), mime: "image/png" },
      { path: path.join(images, "note.txt"), mime: "text/plain" },
      { path: path.join(images, "missing.png"), mime: "image/png" },
    ]) {
      expect(await refusal(k.submit("alex", sid, "see it", { attachments: [att] }))).toMatchObject({ reason: "invalid_params" });
    }
    await k.submit("alex", sid, "see the attachment", { attachments: [{ path: png, mime: "image/png" }] });
    await k.until(() => k.completes(sid).length === 1);
    const [user] = (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages;
    expect(user!.content).toMatch(/^\[The user sent an image~ Here's what I can see:\nStub chat\]\n\[If you need a closer look, use vision_analyze with image_url: .*\/cache\/documents\/native-inputs\/[0-9a-f]{64}\/pixel\.png ~\]\n\nsee the attachment$/);
    expect(user!.display_metadata?.submission_id).toMatch(/^bb:/);
  });

  it("A46: /new and /reset as text get the gateway's confirm prompt, unstored, with no reset; /approve has nothing to approve", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_new");
    await k.turn("alex", sid, "one");
    for (const cmd of ["/new", "/reset", "/approve"]) await k.turn("alex", sid, cmd);
    const texts = k.completes(sid).slice(1).map((e) => e.payload!.text as string);
    expect(texts[0]).toMatch(/^⚠️ \*\*Confirm \/new\*\*/);
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe("No pending command to approve.");
    expect(k.completes(sid)[1]!.payload).not.toHaveProperty("persisted_turn");
    const snap = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    expect(snap).toMatchObject({ session_id: sid, message_count: 2, revision: 4, execution_generation: 4 });
    expect((await readChain(f.folder, "alex", sid)).messages.map((m) => m.content)).toEqual(["one", "echo(2): one"]);
  });

  it("queued rows offer steer/replace only for plain text on an interactive-surface row (session_queued_controls)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ctl");
    f.nextTurn("alex", { holdMs: 300 });
    await k.submit("alex", sid, "first");
    await k.submit("alex", sid, "queued with an author");
    const legacy = f.legacySession("alex", { turns: ["hi"] });
    await k.c.resume({ profile: "alex", session_id: legacy, omit_messages: true });
    f.nextTurn("alex", { holdMs: 300 });
    await k.c.submit({ profile: "alex", session_id: legacy, text: "first", submission_id: "bb:ctl:1" });
    await k.c.submit({ profile: "alex", session_id: legacy, text: "plain queued", submission_id: "bb:ctl:2" });
    const controls = async (id: string) => (await k.c.resume({ profile: "alex", session_id: id, omit_messages: true })).pending.map((p) => (p as unknown as { controls: string[] }).controls);
    // A gateway row's DB source is `local`; an adopted dashboard row keeps `desktop`.
    expect(await controls(sid)).toEqual([[], []]);
    expect(await controls(legacy)).toEqual([[], ["steer", "replace"]]);
  });

  it("model.options answers after a configurable delay", async () => {
    const f = await fake();
    const k = await client(f);
    f.modelOptionsDelayMs = 150;
    const t = Date.now();
    await k.c.modelOptions("alex");
    expect(Date.now() - t).toBeGreaterThanOrEqual(140);
  });
});

describe("engine: interactions", () => {
  it("raises an approval with Hermes' choices, refuses a choice not offered, resolves once", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ap");
    await k.submit("alex", sid, "please #approval");
    await k.until(() => k.of("approval.request", sid).length === 1);
    const req = k.of("approval.request", sid)[0]!;
    expect(req.payload).toMatchObject({ kind: "approval", execution_generation: 1, choices: ["once", "deny", "session", "always"], timeout_s: 60 });
    const snap = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    expect(snap.prompts).toEqual([req.payload]);
    const prompt_id = req.payload!.prompt_id as string;
    const answer = (choice: string, gen = 1) => k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: gen, prompt_id, choice });
    expect(await refusal(answer("yes"))).toMatchObject({ reason: "invalid_params" });
    expect(await refusal(answer("once", 0))).toMatchObject({ reason: "stale_generation" });
    expect(await answer("once")).toEqual({ status: "resolved", prompt_id });
    expect(await answer("once").then((r) => r.status, (e) => e.reason)).toMatch(/already_resolved|stale_generation/);
    await k.until(() => k.completes(sid).length === 1);
    expect(k.of("approval.settled", sid).map((e) => e.payload)).toEqual([{ prompt_id, execution_generation: 1 }]);
    expect(k.of("tool.complete", sid)[0]!.payload).toMatchObject({ name: "terminal", is_error: false });
    const rows = (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages;
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("an edit approval offers once/deny only; a second respond while running is already_resolved", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ed");
    f.nextTurn("alex", { tool: true, approval: { kind: "edit" }, chunkMs: 50, reply: "a b c d e f" });
    await k.submit("alex", sid, "edit it");
    await k.until(() => k.of("approval.request", sid).length === 1);
    const { prompt_id, choices } = k.of("approval.request", sid)[0]!.payload as { prompt_id: string; choices: string[] };
    expect(choices).toEqual(["once", "deny"]);
    expect(await k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id, choice: "deny" })).toMatchObject({ status: "resolved" });
    expect(await k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id, choice: "deny" })).toEqual({ status: "already_resolved", prompt_id });
    await k.until(() => k.completes(sid).length === 1);
    expect(k.of("tool.complete", sid)[0]!.payload).toMatchObject({ name: "write_file", is_error: true });
  });

  it("times out at the deadline: *.settled and a denied tool", async () => {
    const f = await fake({ secondMs: 2 });
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_to");
    await k.submit("alex", sid, "#approval");
    await k.until(() => k.completes(sid).length === 1);
    expect(k.of("approval.settled", sid)).toHaveLength(1);
    // Hermes' blocked result; the prompt settles at the turn's end, after the tool (T1.0 approvals.json).
    const done = JSON.parse(k.of("tool.complete", sid)[0]!.payload!.result as string);
    expect(done).toMatchObject({ exit_code: -1, status: "blocked", user_summary: "No answer within 60 seconds — the command did not run." });
    expect(done.error).toMatch(/^BLOCKED: Command timed out without user response\..*Silence is not consent\.$/);
    const order = k.events.filter((e) => e.session_id === sid).map((e) => e.type);
    expect(order.indexOf("approval.settled")).toBeGreaterThan(order.indexOf("tool.complete"));
    expect(order.indexOf("approval.settled")).toBeLessThan(order.indexOf("message.complete"));
    const { prompt_id } = k.of("approval.request", sid)[0]!.payload as { prompt_id: string };
    expect(await refusal(k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id, choice: "deny" }))).toMatchObject({ reason: "stale_generation" });
  });

  it("clarify: 600 s by default; answered elsewhere it settles, and the reply uses the answer", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_cl");
    await k.submit("alex", sid, "#clarify");
    await k.until(() => k.of("clarify.request", sid).length === 1);
    const req = k.of("clarify.request", sid)[0]!.payload as { prompt_id: string; timeout_s: number; choices: string[] };
    expect(req).toMatchObject({ kind: "clarify", timeout_s: 600, choices: ["red", "blue"], multi_select: false });
    expect(f.answerElsewhere("alex", sid, req.prompt_id, "blue")).toBe(true);
    await k.until(() => k.completes(sid).length === 1);
    expect(k.of("clarify.settled", sid)).toHaveLength(1);
    expect(k.completes(sid)[0]!.payload!.text).toBe("blue");
    expect(await k.c.clarifyRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id: req.prompt_id, answer: "red" }).catch((e) => e.reason)).toBe("stale_generation");
  });

  it("an approval denied by another client settles at once, before the tool ends; ours afterwards is stale (approvals.json)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_cx");
    await k.submit("alex", sid, "#approval");
    await k.until(() => k.of("approval.request", sid).length === 1);
    const { prompt_id } = k.of("approval.request", sid)[0]!.payload as { prompt_id: string };
    expect(f.answerElsewhere("alex", sid, prompt_id, "deny")).toBe(true);
    await k.until(() => k.completes(sid).length === 1);
    const order = k.events.filter((e) => e.session_id === sid).map((e) => e.type);
    expect(order.indexOf("approval.settled")).toBeLessThan(order.indexOf("tool.complete"));
    expect(k.of("approval.settled", sid).map((e) => e.payload)).toEqual([{ prompt_id, execution_generation: 1 }]);
    expect(JSON.parse(k.of("tool.complete", sid)[0]!.payload!.result as string)).toMatchObject({ status: "blocked", user_summary: "You denied this command — it did not run." });
    expect(await refusal(k.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 1, prompt_id, choice: "deny" }))).toMatchObject({ reason: "stale_generation" });
    expect(k.of("approval.cancelled")).toEqual([]);
  });

  it("reasoning streams on gui and tui sessions only; message.complete and the REST row carry it always (reasoning.json); fails a turn on request", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_th");
    await k.turn("alex", sid, "#think about it");
    expect(k.of("reasoning.delta", sid)).toEqual([]);
    const reasoning = "Thinking about it. Still thinking. Done thinking.";
    expect(k.completes(sid)[0]!.payload).toMatchObject({ reasoning });
    expect((await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages[1]).toMatchObject({ reasoning });
    const { session_id: gui } = await k.create("alex", "bb:thr_th_gui", { source: "gui" });
    await k.turn("alex", gui, "#think about it");
    expect(k.of("reasoning.delta", gui).map((e) => e.payload)).toEqual([{ text: "Thinking about it. " }, { text: "Still thinking. " }, { text: "Done thinking." }]);
    expect(k.completes(gui)[0]!.payload).toMatchObject({ reasoning });
    await k.turn("alex", sid, "#fail");
    expect(k.completes(sid)[1]!.payload).toMatchObject({ outcome: "failed", status: "error", error: "stub failure" });
  });
});

describe("engine: fences", () => {
  it("interrupt and steer act only on the running generation (stale_generation); a steer joins the turn", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_f");
    expect(await refusal(k.c.steer({ profile: "alex", session_id: sid, execution_generation: 0, text: "noop" }))).toMatchObject({ reason: "stale_generation" });
    // Idle: an interrupt with the current generation answers the idle handle.
    expect(await k.c.interrupt({ profile: "alex", session_id: sid, execution_generation: 0 })).toMatchObject({ execution_state: "idle", execution_generation: 0, instance_id: f.instanceId });
    f.nextTurn("alex", { tool: true, chunkMs: 40, reply: "one two three four five six seven eight" });
    await k.submit("alex", sid, "use a tool");
    await k.until(() => k.of("tool.start", sid).length === 1);
    expect(await k.c.steer({ profile: "alex", session_id: sid, execution_generation: 1, text: "steer words" })).toEqual({ status: "queued", text: "steer words", execution_generation: 1, authority_epoch: 1 });
    expect(await refusal(k.c.interrupt({ profile: "alex", session_id: sid, execution_generation: 0 }))).toMatchObject({ reason: "stale_generation" });
    await k.until(() => k.of("message.delta", sid).filter((e) => e.payload!.text).length >= 2);
    expect(await k.c.interrupt({ profile: "alex", session_id: sid, execution_generation: 1 })).toMatchObject({ execution_state: "running" });
    await k.until(() => k.completes(sid).length === 1);
    const done = k.completes(sid)[0]!.payload as { status: string; outcome: string; persisted_turn: { complete: boolean; user_row_ids: number[] } };
    expect(done).toMatchObject({ status: "interrupted", outcome: "cancelled", persisted_turn: { complete: false } });
    expect(done.persisted_turn.user_row_ids).toHaveLength(2);
    const rows = (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages;
    const steer = rows.find((m) => m.display_kind === "steer")!;
    expect(steer).toMatchObject({ role: "user", display_content: "steer words", display_metadata: null });
    expect(groupTurns(rows)).toHaveLength(1);
    expect(await k.c.interrupt({ profile: "alex", session_id: sid, execution_generation: 1 })).toMatchObject({ execution_state: "idle" });
  });

  it("prompt.cancel withdraws a queued admission; a started one is stopped", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_c");
    f.nextTurn("alex", { chunkMs: 40, reply: "a b c d e f g h" });
    const a = await k.submit("alex", sid, "first");
    const b = await k.submit("alex", sid, "second");
    expect(await k.c.cancel({ profile: "alex", session_id: sid, admission_id: b.admission_id })).toMatchObject({ status: "terminal", outcome: "cancelled" });
    await k.until(() => k.completes(sid).some((e) => e.admission_id === b.admission_id));
    expect(k.completes(sid).find((e) => e.admission_id === b.admission_id)).toMatchObject({ payload: { outcome: "cancelled", text: "" } });
    expect(k.completes(sid).find((e) => e.admission_id === b.admission_id)!.execution_generation).toBeUndefined();
    expect(await k.c.cancel({ profile: "alex", session_id: sid, admission_id: a.admission_id })).toMatchObject({ status: "started" });
    await k.until(() => k.completes(sid).some((e) => e.admission_id === a.admission_id));
    expect(k.completes(sid).find((e) => e.admission_id === a.admission_id)!.payload).toMatchObject({ outcome: "cancelled", status: "interrupted" });
    expect(await refusal(k.c.cancel({ profile: "alex", session_id: sid, admission_id: "nope" }))).toMatchObject({ reason: "not_found" });
  });

  it("session.mutate: expected_generation required (S8 E7), revision and generation fenced, receipts replay", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_m");
    await k.turn("alex", sid, "hi");
    const m = (over: object) => k.c.mutate({ profile: "alex", session_id: sid, request_id: "bb:m:1", expected_revision: 1, expected_generation: 1, operation: "reasoning", payload: { effort: "high" }, ...over });
    expect(await refusal(k.c.mutate({ profile: "alex", session_id: sid, request_id: "bb:m:0", expected_revision: 1, operation: "compress", payload: {} }))).toMatchObject({ reason: "invalid_params" });
    expect(await refusal(m({ expected_revision: 0 }))).toEqual({ reason: "revision_conflict", revision: 1, execution_generation: 1 });
    expect(await refusal(m({ expected_generation: 0 }))).toEqual({ reason: "stale_generation", revision: 1, execution_generation: 1 });
    expect(await refusal(m({ payload: { effort: "huge" } }))).toMatchObject({ reason: "invalid_params" });
    const ok = await m({});
    expect(ok).toMatchObject({ session_id: sid, operation: "reasoning", revision: 2, effort: "high" });
    expect(await m({})).toEqual(ok); // the same request: its receipt
    const model = await k.c.mutate({ profile: "alex", session_id: sid, request_id: "bb:m:2", expected_revision: 2, expected_generation: 1, operation: "model", payload: { model: "other", provider: "stub" } });
    expect(model).toMatchObject({ revision: 3, operation: "model" });
    expect(f.session("alex", sid)).toMatchObject({ model: "other", reasoning: "high" });
  });

  it("compress in place keeps the id; the turns read the same before and after (A8)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ip");
    for (let i = 1; i <= 4; i++) await k.turn("alex", sid, `turn ${i}`);
    const before = groupTurns((await readChain(f.folder, "alex", sid)).messages).map((t) => [t.anchor_uid, ...t.replies.map((r) => r.message_uid)]);
    const snap = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    f.nextTurn("alex", { chunkMs: 30 });
    const busy = k.submit("alex", sid, "busy");
    await busy;
    await k.until(() => k.of("message.start", sid).length === 5);
    expect(await refusal(k.c.mutate({ profile: "alex", session_id: sid, request_id: "bb:cx:busy", expected_revision: 4, expected_generation: 5, operation: "compress", payload: {} }))).toMatchObject({ reason: "session_busy" });
    await k.until(() => k.completes(sid).length === 5);
    const after5 = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    const result = await k.c.mutate({ profile: "alex", session_id: sid, request_id: "bb:cx:1", expected_revision: after5.revision, expected_generation: after5.execution_generation, operation: "compress", payload: {} });
    expect(snap.revision).toBe(4);
    expect(result).toMatchObject({ session_id: sid, operation: "compress", target_session_id: sid, previous_target_session_id: sid, revision: 6, execution_generation: 6 });
    await k.turn("alex", sid, "after compaction");
    const chain = await readChain(f.folder, "alex", sid);
    const turns = groupTurns(chain.messages).map((t) => [t.anchor_uid, ...t.replies.map((r) => r.message_uid)]);
    expect(turns.slice(0, 4)).toEqual(before);
    expect(turns).toHaveLength(6);
    expect(chain.session_id).toBe(sid);
    // The default view drops compacted rows, as Hermes' does.
    const active = (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages;
    expect(active.length).toBeLessThan(chain.messages.length);
  });

  it("compress rotating: a tip segment with the same chat_id takes the rows and title; the root stays the live session (rotating-viewer.json)", async () => {
    const f = await fake({ rotating: ["bob"] });
    const k = await client(f);
    const root = (await k.c.create({ profile: "bob", title: "Bot Chat", hidden: true, request_id: "bb:botchat:b" })).session_id;
    for (let i = 1; i <= 3; i++) await k.turn("bob", root, `turn ${i}`);
    const before = groupTurns((await readChain(f.folder, "bob", root)).messages).map((t) => t.anchor_uid);
    const snap = await k.c.resume({ profile: "bob", session_id: root, omit_messages: true });
    const result = (await k.c.mutate({ profile: "bob", session_id: root, request_id: "bb:cx:r", expected_revision: snap.revision, expected_generation: snap.execution_generation, operation: "compress", payload: {} })) as unknown as { target_session_id: string };
    const tip = result.target_session_id;
    expect(tip).not.toBe(root);
    expect(result).toMatchObject({ session_id: root, previous_target_session_id: root, revision: 4, execution_generation: 4 });
    // Subscribers of the root get the result as `session.updated`, under the root id and epoch.
    const updated = k.of("session.updated", root).at(-1)!;
    expect(updated.payload).toEqual(result);
    expect(updated.replay_epoch).toBe(snap.replay_epoch);
    const resumed = await k.c.resume({ profile: "bob", session_id: root, omit_messages: true });
    expect(resumed).toMatchObject({ session_id: root, stored_session_id: root, replay_epoch: snap.replay_epoch, message_count: 4 });
    expect((await k.c.resume({ profile: "bob", session_id: tip, omit_messages: true })).session_id).toBe(root);
    expect((await k.c.sessionList({ profile: "bob", title: "Bot Chat", include_hidden: true })).sessions[0]).toMatchObject({ session_id: root });
    expect(f.session("bob", tip)).toMatchObject({ id: root, chat_id: root });
    const before6 = k.events.length;
    await k.turn("bob", root, "after rotation");
    const next = k.events.slice(before6).filter((e) => e.seq !== undefined);
    expect(new Set(next.map((e) => e.session_id))).toEqual(new Set([root]));
    expect(k.of("session.info", root).every((e) => e.payload!.stored_session_id === undefined || e.payload!.stored_session_id === root)).toBe(true);
    // The model is sent the tip's rows: 4 after compression, plus the new user row and the system prompt.
    expect(k.completes(root).at(-1)!.payload!.text).toBe("echo(6): after rotation");
    const byRoot = await readChain(f.folder, "bob", root);
    const byTip = await readChain(f.folder, "bob", tip);
    expect(byRoot).toEqual(byTip);
    expect(byRoot.session_id).toBe(tip);
    expect(new Set(byRoot.messages.map((m) => m.message_uid)).size).toBeLessThan(byRoot.messages.length);
    const turns = groupTurns(byRoot.messages).map((t) => t.anchor_uid);
    expect(turns.slice(0, 3)).toEqual(before);
    expect(turns).toHaveLength(4);
  });
});

describe("engine: replay and restart", () => {
  it("session.events.since replays the gap; a new epoch or a lost gap asks for a snapshot", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ev");
    await k.turn("alex", sid, "one");
    const epoch = k.events.find((e) => e.session_id === sid)!.replay_epoch!;
    const since = await k.c.eventsSince({ profile: "alex", session_id: sid, last_sequence: 3, replay_epoch: epoch });
    expect(since).toMatchObject({ truncated: false, snapshot_required: false, replay_epoch: epoch });
    expect(since.events.map((e) => e.seq)).toEqual(k.events.filter((e) => e.session_id === sid && e.seq! > 3).map((e) => e.seq));
    expect(await k.c.eventsSince({ profile: "alex", session_id: sid, last_sequence: 3, replay_epoch: "other" })).toMatchObject({ events: [], truncated: true, snapshot_required: true });
    f.nextTurn("alex", { reply: "w ".repeat(REPLAY_BUFFER_MAX) });
    await k.turn("alex", sid, "long");
    expect(await k.c.eventsSince({ profile: "alex", session_id: sid, last_sequence: 3, replay_epoch: epoch })).toMatchObject({ events: [], truncated: true, snapshot_required: true });
  });

  it("reattach after a dropped socket: no event lost or doubled (flow 8)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_ra");
    f.nextTurn("alex", { chunkMs: 20, reply: "a b c d e f g h i j" });
    await k.submit("alex", sid, "go");
    await k.until(() => k.of("message.delta", sid).length >= 3);
    const cursor = { ...k.c.cursors.get(sid)! };
    k.c.close();
    await new Promise((r) => setTimeout(r, 60));
    const k2 = await client(f);
    await k2.c.reattach("alex", sid, cursor);
    await k2.until(() => k2.completes(sid).length === 1);
    const text = [...k.of("message.delta", sid).filter((e) => e.seq! <= cursor.lastSequence), ...k2.of("message.delta", sid)].map((e) => e.payload!.text ?? "").join("");
    expect(text).toBe("a b c d e f g h i j");
  });

  it("restart: the running admission becomes unknown; the FIFO waits; Conduit is refused until prompt.resolve_unknown (S8 E11b)", async () => {
    const f = await fake();
    let k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_rs");
    f.nextTurn("alex", { holdMs: 5000 });
    const a = await k.submit("alex", sid, "lost");
    await k.until(() => k.of("message.start", sid).length === 1);
    const before = { instance: f.instanceId, origin: f.apiOrigin };
    await f.restart();
    expect(f.instanceId).not.toBe(before.instance);
    expect(f.apiOrigin).not.toBe(before.origin);
    expect(f.authorityEpoch).toBe(2);
    k = await client(f);
    const snap = await k.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    expect(snap).toMatchObject({ authority_epoch: 2, running: false, last_sequence: 0 });
    expect(snap.pending).toEqual([expect.objectContaining({ admission_id: a.admission_id, status: "unknown", execution_generation: 1 })]);
    // The unknown admission keeps the epoch it was taken in.
    expect(snap.pending[0]).toMatchObject({ authority_epoch: 1 });
    // The unknown alone: the dashboard refuses; with a second submit queued behind it, it forwards (restart-unknown.json).
    await expect(f.conduitTurn("alex", sid, "from conduit")).rejects.toMatchObject({ code: 4090, data: { reason: "SESSION_NOT_OWNED" }, message: expect.stringContaining("outcome-unknown work") });
    const b = await k.submit("alex", sid, "after restart");
    expect(b).toMatchObject({ status: "queued", authority_epoch: 2 });
    const forwarded = await f.conduitTurn("alex", sid, "conduit behind");
    expect(forwarded).toMatchObject({ status: "queued", forwarded: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(k.completes(sid)).toEqual([]);
    expect(await refusal(k.c.resolveUnknown({ profile: "alex", session_id: sid, admission_id: a.admission_id, execution_generation: 0 }))).toMatchObject({ reason: "stale_generation" });
    expect(await k.c.resolveUnknown({ profile: "alex", session_id: sid, admission_id: a.admission_id, execution_generation: 1 })).toMatchObject({ status: "terminal", outcome: "interrupted" });
    await k.until(() => k.completes(sid).length === 2);
    expect(k.completes(sid)[0]).toMatchObject({ admission_id: b.admission_id, execution_generation: 2 });
    expect(k.completes(sid)[1]).toMatchObject({ admission_id: forwarded.admission_id, execution_generation: 3 });
    expect(await f.conduitTurn("alex", sid, "conduit after resolve")).toMatchObject({ status: "streaming" });
    // The discarded turn keeps its user row with Hermes' note; the model sees both (T1.0 restart-unknown.json).
    const rows = (await readMessages(f.folder, "alex", sid, { order: "oldest", limit: 500 })).messages;
    expect(rows.map((m) => [m.content, m.display_kind ?? null])).toEqual([
      ["lost", null],
      ["This turn did not complete. Some actions may already have run; verify their effects before resending.", "failed_turn"],
      ["after restart", null],
      ["echo(4): after restart", null],
      ["conduit behind", null],
      ["echo(6): conduit behind", null],
      ["conduit after resolve", null],
      ["echo(8): conduit after resolve", null],
    ]);
    expect(rows[0]!.display_metadata?.submission_id).toBe("bb:thr_t:1");
  });
});

describe("engine: Conduit and other outside clients", () => {
  it("a held legacy Bot Chat refuses lookup, create and resume (E6); released, the resume adopts it once", async () => {
    const f = await fake();
    const k = await client(f);
    const id = f.legacySession("bob", { title: "Bot Chat", hidden: true, turns: ["from conduit"], held: true });
    const coordination = { reason: "runtime_coordination_required" };
    expect(await refusal(k.c.sessionList({ profile: "bob", title: "Bot Chat", include_hidden: true }))).toMatchObject(coordination);
    expect(await refusal(k.c.create({ profile: "bob", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:b" }))).toMatchObject(coordination);
    expect(await refusal(k.c.resume({ profile: "bob", session_id: id, omit_messages: true }))).toMatchObject(coordination);
    // REST reads it meanwhile and adopts nothing (A48).
    expect((await readChain(f.folder, "bob", id)).messages.map((m) => m.content)).toEqual(["from conduit", "echo(2): from conduit"]);
    expect(f.session("bob", id)).toMatchObject({ chat_id: null, source: "desktop" });
    f.hold("bob", id, false);
    const snap = await k.c.resume({ profile: "bob", session_id: id, omit_messages: true });
    expect(snap).toMatchObject({ session_id: id, info: { source: "gui" } });
    expect(f.session("bob", id)).toMatchObject({ chat_id: id, source: "desktop" });
    expect((await k.c.sessionList({ profile: "bob", title: "Bot Chat", include_hidden: true })).sessions[0]).toMatchObject({ session_id: id });
    await k.turn("bob", id, "from bb");
    expect(groupTurns((await readChain(f.folder, "bob", id)).messages).map((t) => t.user!.content)).toEqual(["from conduit", "from bb"]);
  });

  it("a session.mutate leaves a legacy row legacy (T1.0 adoption.json: no chat_id after it)", async () => {
    const f = await fake();
    const k = await client(f);
    const id = f.legacySession("alex", { turns: ["hi"] });
    expect(await k.c.mutate({ profile: "alex", session_id: id, request_id: "bb:m", expected_revision: 0, expected_generation: 0, operation: "reasoning", payload: { effort: "low" } })).toMatchObject({ revision: 1, execution_generation: 0 });
    expect(f.session("alex", id)).toMatchObject({ chat_id: null, source: "desktop" });
  });

  it("a dashboard turn on an idle chat: the user row at once, the reply at the end, no canonical events; bb's send waits (E2, E3a)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_dash");
    const seqBefore = k.events.filter((e) => e.session_id === sid).length;
    const conduit = f.conduitTurn("alex", sid, "from conduit", { durationMs: 300 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await readChain(f.folder, "alex", sid)).messages.map((m) => m.content)).toEqual(["from conduit"]);
    expect(k.events.filter((e) => e.session_id === sid)).toHaveLength(seqBefore);
    await k.submit("alex", sid, "from bb");
    await k.until(() => k.of("status.update", sid).length === 1);
    // lease-wait.json: agent.print and status.update lifecycle, then "Session is free" once the lease is free.
    const waiting = "⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...";
    expect(k.of("agent.print", sid)[0]!.payload).toEqual({ text: waiting });
    expect(k.of("status.update", sid)[0]!.payload).toEqual({ kind: "lifecycle", text: waiting });
    // No user row until the lease is free.
    expect((await readChain(f.folder, "alex", sid)).messages.map((m) => m.content)).toEqual(["from conduit"]);
    expect(await conduit).toEqual({ status: "streaming", user_row_id: expect.any(Number) });
    await k.until(() => k.completes(sid).length === 1);
    // The model saw Conduit's turn (echo counts it).
    expect(k.completes(sid)[0]!.payload!.text).toBe("echo(4): from bb");
    expect(k.of("status.update", sid).map((e) => e.payload!.text)).toEqual([waiting, "Session is free; loading the latest transcript..."]);
    expect(k.completes(sid)[0]!.payload!.persisted_turn).toMatchObject({ complete: false });
    expect(groupTurns((await readChain(f.folder, "alex", sid)).messages).map((t) => [t.user!.content, t.submission_id])).toEqual([
      ["from conduit", null],
      ["from bb", "bb:thr_t:1"],
    ]);
    // A dashboard turn signals through the WAL only (T1.0 conduit-turn.json).
    expect(k.of("sessions.changed")).toEqual([]);
  });

  it("a dashboard send during a bb turn is forwarded: its own admission, submission id desktop-forward-…, live on bb's subscription (E3b)", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_fw");
    f.nextTurn("alex", { chunkMs: 20 });
    await k.submit("alex", sid, "bb first");
    await k.until(() => k.of("message.start", sid).length === 1);
    const forwarded = await f.conduitTurn("alex", sid, "conduit second");
    expect(forwarded).toEqual({ status: "queued", admission_id: expect.stringMatching(/^[0-9a-f]{32}$/), forwarded: true });
    await k.until(() => k.completes(sid).length === 2);
    expect(k.of("message.start", sid).map((e) => e.admission_id)[1]).toBe(forwarded.admission_id);
    expect(k.completes(sid)[1]!.payload!.text).toBe("echo(4): conduit second");
    const turns = groupTurns((await readChain(f.folder, "alex", sid)).messages);
    expect(turns[1]!.submission_id).toMatch(/^desktop-forward-[0-9a-f]{32}$/);
  });

  it("another canonical client's turn (a CLI) streams live on bb's subscription with its own admission", async () => {
    const f = await fake();
    const k = await client(f);
    const { session_id: sid } = await k.create("alex", "bb:thr_cli");
    const st = f.outsideTurn("alex", sid, "from the cli");
    await k.until(() => k.completes(sid).length === 1);
    expect(k.completes(sid)[0]).toMatchObject({ admission_id: st.admission_id, payload: { text: "echo(2): from the cli" } });
    const turn = groupTurns((await readChain(f.folder, "alex", sid)).messages)[0]!;
    expect(turn.submission_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("engine: REST projection", () => {
  it("every engine REST row has exactly a recorded row's key set", async () => {
    const f = await fake({ rotating: ["bob"] });
    const k = await client(f);
    const a = (await k.create("alex", "bb:thr_k")).session_id;
    await k.turn("alex", a, "plain");
    f.nextTurn("alex", { tool: true, chunkMs: 20, reply: "a b c d" });
    await k.submit("alex", a, "tool");
    await k.until(() => k.of("tool.start", a).length === 1);
    await k.c.steer({ profile: "alex", session_id: a, execution_generation: 2, text: "steer" });
    await k.until(() => k.completes(a).length === 2);
    const s = await k.c.resume({ profile: "alex", session_id: a, omit_messages: true });
    await k.c.mutate({ profile: "alex", session_id: a, request_id: "c1", expected_revision: s.revision, expected_generation: s.execution_generation, operation: "compress", payload: {} });
    const b = (await k.create("bob", "bb:thr_k2")).session_id;
    for (const t of ["one", "two", "three"]) await k.turn("bob", b, t);
    const sb: Snapshot = await k.c.resume({ profile: "bob", session_id: b, omit_messages: true });
    await k.c.mutate({ profile: "bob", session_id: b, request_id: "c2", expected_revision: sb.revision, expected_generation: sb.execution_generation, operation: "compress", payload: {} });
    const legacy = f.legacySession("alex", { turns: ["conduit"] });
    let lists = 0;
    let messages = 0;
    for (const profile of ["alex", "bob"]) {
      const list = await listSessions(f.folder, profile, { order: "recent", archived: "include", limit: 100 });
      for (const row of list.sessions) {
        expect(recordedKeys.list.has(keysOf(row)), `${profile} list row ${row.id}`).toBe(true);
        lists++;
        for (const compacted of [false, true]) {
          const page = await readMessages(f.folder, profile, row.id, { order: "oldest", limit: 500, include_compacted: compacted });
          for (const m of page.messages) {
            expect(recordedKeys.messages.has(keysOf(m)), `${row.id} ${m.role} ${m.display_kind}`).toBe(true);
            messages++;
          }
        }
      }
    }
    expect(lists).toBe(3);
    expect(messages).toBeGreaterThan(20);
    const legacyRow = (await listSessions(f.folder, "alex", { order: "recent", archived: "include", limit: 100 })).sessions.find((r) => r.id === legacy)!;
    expect(legacyRow).toMatchObject({ source: "desktop", created_source: "desktop", chat_id: null, hidden: 0 });
    const tipRow = (await listSessions(f.folder, "bob", { order: "recent", archived: "include", limit: 100 })).sessions[0]!;
    expect(tipRow).toMatchObject({ chat_id: b, _lineage_root_id: b, continuation_kind: "compression" });
  });

  it("pages like Hermes: list limit and offset, messages latest by default, oldest by offset", async () => {
    const f = await fake();
    const k = await client(f);
    for (const r of ["p1", "p2", "p3"]) {
      const id = (await k.create("alex", `bb:${r}`)).session_id;
      await k.turn("alex", id, r);
    }
    const page = await listSessions(f.folder, "alex", { order: "recent", archived: "include", limit: 2 });
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(page.sessions).toHaveLength(2);
    const rest = await listSessions(f.folder, "alex", { order: "recent", archived: "include", limit: 2, offset: 2 });
    expect(rest.sessions).toHaveLength(1);
    const id = page.sessions[0]!.id;
    for (let i = 0; i < 3; i++) await k.turn("alex", id, `more ${i}`);
    const latest = await readMessages(f.folder, "alex", id, { limit: 2, order: "latest" });
    expect(latest.messages.map((m) => m.content)).toEqual(["more 2", "echo(8): more 2"]);
    const oldest = await readMessages(f.folder, "alex", id, { order: "oldest", limit: 2, offset: 2 });
    expect(oldest.messages.map((m) => m.content)).toEqual(["more 0", "echo(4): more 0"]);
    expect(oldest.pagination).toEqual({ limit: 2, offset: 2, order: "oldest", returned: 2 });
  });
});
