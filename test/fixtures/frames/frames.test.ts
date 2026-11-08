// The recorded frames of T1.0 (03 §Recorded fixtures): what bb may rely on, asserted on the recordings.
// Regenerate with `npx tsx e2e/record-frames.ts` (isolated Hermes, stub model).
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MessagesPage } from "../../../src/hermes/history.js";
import type { RecordedExchange } from "../../fake-hermes/index.js";

type Frame = { t: number; client: string; dir: "in" | "out"; frame: { method?: string; params?: any; result?: any; error?: any; id?: number } };
type Recording = { $comment: string; notes: Record<string, any>; frames: Frame[]; exchanges: RecordedExchange[]; model_calls: { user_texts: string[] }[] };
const dir = import.meta.dirname;
const names = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const load = (name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as Recording;
const events = (r: Recording, client: string, sid?: string) =>
  r.frames.filter((f) => f.client === client && f.dir === "in" && f.frame.method === "event" && (!sid || f.frame.params?.session_id === sid)).map((f) => f.frame.params);
const sent = (r: Recording, client: string, method: string) => r.frames.filter((f) => f.client === client && f.dir === "out" && f.frame.method === method).map((f) => f.frame.params);
const pages = (r: Recording) => r.exchanges.filter((x) => x.path.endsWith("/messages")).map((x) => x.body as MessagesPage);
const lastUser = (r: Recording) => r.model_calls.map((c) => c.user_texts.at(-1) ?? "");

describe("recorded frames (T1.0)", () => {
  it("cover every T1.0 row of 03 §Recorded fixtures", () => {
    expect(names.sort()).toEqual(
      [
        "adoption", "approvals", "attachments", "chat-continue", "conduit-coordination", "conduit-forward", "conduit-turn", "detach", "lease-wait",
        "reasoning", "rest-midturn", "restart-unknown", "rotating-viewer", "slash-new", "viewer",
      ].sort(),
    );
    for (const n of names) expect(load(n).$comment, n).toBeTruthy();
  });

  it("hold no credentials, user ids, origin_json, home paths or timestamped ids", () => {
    for (const n of names) {
      const text = readFileSync(path.join(dir, `${n}.json`), "utf8");
      expect(text, n).not.toContain(os.homedir());
      expect(text, n).not.toMatch(/"(origin_json|user_id|session_key|gateway_input_owner|auth_user_id|ticket|token|api_key)": "(?!<redacted>)/);
      expect(text, n).not.toMatch(/uid:\d+/);
      expect(text, n).not.toMatch(/\b\d{8}_\d{6}_[0-9a-f]{6,}\b/);
    }
  });

  it("E11b: a gateway restart mid bb turn leaves bb's admission unknown; Conduit is refused until prompt.resolve_unknown", () => {
    const r = load("restart-unknown");
    const { notes } = r;
    expect(notes.instance_changed).toBe(true);
    expect(notes.pending_after_restart).toEqual([{ admission_id: notes.admission.admission_id, status: "unknown", outcome: null, execution_generation: notes.snapshot_execution_generation }]);
    expect(notes.conduit_before_resolve).toMatchObject({ code: 4090, data: { reason: "SESSION_NOT_OWNED" } });
    expect(notes.conduit_before_resolve.message).toContain("outcome-unknown work in the gateway's durable queue");
    expect(sent(r, "bb", "prompt.resolve_unknown")).toEqual([{ profile: "alex", session_id: notes.session, admission_id: notes.admission.admission_id, execution_generation: notes.snapshot_execution_generation }]);
    expect(notes.resolve_unknown).toMatchObject({ status: "terminal", outcome: "interrupted" });
    // Accepted: run by the dashboard, or forwarded behind bb's second submit (next test).
    expect(["streaming", "queued"]).toContain(notes.conduit_after_resolve.status);
    expect(notes.conduit_after_resolve_completed).toBe(true);
    // The lost turn keeps its user row, with an assistant note; the model saw it in the next turn's context.
    const rows = pages(r).at(-1)!.messages;
    const lost = rows.findIndex((m) => m.display_metadata?.submission_id === "bb:thr_rec_bot:3");
    expect(rows[lost + 1]).toMatchObject({ role: "assistant" });
    expect(String(rows[lost + 1]!.content)).toMatch(/^This turn did not complete/);
    expect(r.model_calls.some((c) => c.user_texts.includes("very slow turn before the restart") && c.user_texts.at(-1) !== "very slow turn before the restart")).toBe(true);
  });

  it("after a restart, a second canonical submit on the unknown session is queued; it runs only after resolve_unknown, and Conduit's send meanwhile is forwarded", () => {
    const { notes } = load("restart-unknown");
    expect(notes.second_submit).toMatchObject({ status: "queued" });
    expect(notes.second_ran_before_resolve).toBe(false);
    expect(notes.second_ran_after_resolve).toBe(true);
    // With work queued behind the unknown admission, the dashboard forwards instead of refusing.
    expect(notes.conduit_behind_second).toMatchObject({ status: "queued", forwarded: true });
  });

  it("E3a: while Conduit's dashboard turn holds the turn lease, bb's socket gets agent.print + status.update lifecycle texts, then the turn", () => {
    const { notes } = load("lease-wait");
    expect(notes.dashboard_submit).toMatchObject({ status: "streaming" });
    const texts = notes.bb_status_events.filter((e: any) => e.type === "status.update").map((e: any) => e.payload);
    expect(texts).toEqual([
      { kind: "lifecycle", text: "⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn..." },
      { kind: "lifecycle", text: "Session is free; loading the latest transcript..." },
    ]);
    expect(notes.bb_status_events.filter((e: any) => e.type === "agent.print").map((e: any) => e.payload.text)).toEqual(texts.map((t: any) => t.text));
    expect(notes.bb_event_types).toEqual(expect.arrayContaining(["message.start", "message.delta", "message.complete"]));
  });

  it("a rotating compress: a subscriber of the root keeps every event under the root id and epoch; stored_session_id stays the root", () => {
    const { notes } = load("rotating-viewer");
    expect(notes.tip).not.toBe(notes.root);
    expect(notes.compress).toMatchObject({ operation: "compress", target_session_id: notes.tip, previous_target_session_id: notes.root });
    for (const e of [...notes.viewer_during_compress, ...notes.viewer_during_next_turn]) {
      if (e.session !== null) expect(e, e.type).toMatchObject({ session: "root", epoch: "same" });
      expect(e.stored, e.type).not.toBe("tip");
    }
    expect(notes.viewer_during_compress.map((e: any) => e.type)).toContain("session.updated");
    expect(notes.viewer_during_next_turn.map((e: any) => e.type)).toEqual(expect.arrayContaining(["message.start", "message.delta", "message.complete"]));
    expect(notes.resume_root_after).toMatchObject({ session: "root", stored: "root", epoch: "same" });
  });

  it("approvals: answered by another client or timed out → approval.settled on every subscriber, no cancelled event; a late answer is stale_generation", () => {
    const { notes } = load("approvals");
    for (const k of ["answered_elsewhere", "timed_out"]) {
      for (const who of ["bb_saw", "other_saw"]) {
        const seen = notes[k][who] as { type: string; payload: any }[];
        expect(seen.map((e) => e.type), `${k} ${who}`).toEqual(["approval.request", "approval.settled"]);
        expect(seen[1]!.payload).toEqual({ prompt_id: seen[0]!.payload.prompt_id, execution_generation: seen[0]!.payload.execution_generation });
      }
      expect(notes[k].bb_respond_after).toEqual({ refused: "stale_generation" });
    }
    expect(notes.answered_elsewhere.request_choices).toEqual(["once", "deny", "session", "always"]);
    expect(notes.answered_elsewhere.other_respond).toMatchObject({ status: "resolved" });
    expect(notes.timed_out.bb_saw[0].payload.timeout_s).toBe(8);
    expect(notes.scratch_still_there).toBe(true); // denied and timed out: the command never ran
  });

  it("reasoning: reasoning.delta streams only on a tui/gui session; every source gets it in message.complete", () => {
    const { notes } = load("reasoning");
    expect(notes.gui.reasoning_deltas).toEqual(["Thinking about it. ", "Still thinking. ", "Done thinking."]);
    expect(notes.cli.reasoning_deltas).toEqual([]);
    expect(notes.cli.event_types).not.toContain("reasoning.delta");
    for (const s of ["cli", "gui"]) expect(notes[s].complete_reasoning, s).toBe("Thinking about it. Still thinking. Done thinking.");
    // thinking.delta is Hermes' spinner text, never the model's reasoning.
    expect(notes.gui.event_types).toContain("thinking.delta");
  });

  it("REST mid-turn (real CLI): the user row is stored at the start; a tool step's rows after the step; the reply at the end", () => {
    const { notes } = load("rest-midturn");
    const plain = notes.polls["slow cli turn"] as { t: number; rows: string[] }[];
    expect(plain.find((p) => p.rows.length === 1)!.rows).toEqual(["user"]);
    expect(plain.at(-1)!.rows).toEqual(["user", "assistant"]);
    const tool = notes.polls["use a tool slow"] as { t: number; rows: string[] }[];
    const step = tool.find((p) => p.rows.length === 5)!;
    expect(step.rows.slice(2)).toEqual(["user", "assistant+tool_calls", "tool"]);
    expect(tool.at(-1)!.rows.slice(2)).toEqual(["user", "assistant+tool_calls", "tool", "assistant"]);
    expect(tool.at(-1)!.t - step.t).toBeGreaterThan(5000); // the slow reply streamed after the step was readable
  });

  it("A50: attachments are images staged directly in the profile's cache/images; anything else is invalid_params", () => {
    const r = load("attachments");
    const tries = Object.fromEntries(r.notes.tries.map((t: any) => [t.label, t]));
    expect(tries["image in cache/images"].admission).toMatchObject({ status: "queued" });
    for (const refused of ["image in work", "text file in work", "text file in cache/images", "missing file"]) expect(tries[refused].admission.refused, refused).toBe("invalid_params");
    expect(sent(r, "bb", "prompt.submit")[1].attachments).toEqual([{ path: "/private/tmp/bb-hermes-test/e2e-frames/profiles/alex/cache/images/pixel.png", mime: "image/png" }]);
    // Hermes copies the bytes into its content store; a model without vision gets a description and the stored path.
    const [seen] = tries["image in cache/images"].model_saw;
    expect(seen.last_user).toMatch(/^\[The user sent an image/);
    expect(seen.last_user).toContain("/profiles/alex/cache/documents/native-inputs/");
    expect(seen.last_user).toMatch(/see the attachment 2$/);
  });

  it("A19: a viewer that resumed a session gets the live events of a CLI turn and of another canonical client's turn", () => {
    const r = load("viewer");
    const sid = r.notes.session;
    expect(r.notes.cli.code).toBe(0);
    for (const turn of ["viewer_event_types_cli_turn", "viewer_event_types_other_turn"]) expect(r.notes[turn]).toEqual(expect.arrayContaining(["message.start", "message.delta", "message.complete"]));
    expect(sent(r, "viewer", "prompt.submit")).toEqual([]);
    const done = events(r, "viewer", sid).filter((e) => e.type === "message.complete").map((e) => e.payload.text);
    expect(done).toHaveLength(2);
    expect(done[0]).toMatch(/^echo\(4\): slow turn from the cli/);
    expect(done[1]).toMatch(/^echo\(6\): slow turn from another canonical client/);
    // Streamed text == final text for the CLI turn.
    const cliDeltas = events(r, "viewer", sid).filter((e) => e.type === "message.delta" && e.admission_id === events(r, "viewer", sid).find((x) => x.type === "message.complete")!.admission_id);
    expect(cliDeltas.map((e) => e.payload.text).join("")).toBe(done[0]);
  });

  it("A24: detach with end_reason null leaves the row usable; with a reason it ends the row", () => {
    const { notes } = load("detach");
    expect(notes.detached.detached).toBe(true);
    expect(notes.kept_row_after_detach.row).toMatchObject({ ended: 0, end_reason: null });
    expect(notes.ended_row_after_detach.row).toMatchObject({ ended: 1, end_reason: "user_closed" });
    expect(pages(load("detach")).at(-1)!.messages.map((m) => m.content)).toEqual(["before detach", "echo(2): before detach", "after detach", "echo(4): after detach"]);
  });

  it("A20 failed: `hermes chat -c` continues a bb chat with source cli, from any cwd; a bb chat with source gui is never picked", () => {
    const { notes } = load("chat-continue");
    expect(notes.cli_runs.map((x: any) => x.code)).toEqual([0, 0, 0, 0]);
    expect(notes.continue_one_went_to).toBe("bb_cli");
    expect(notes.continue_one_elsewhere_went_to).toBe("bb_cli");
    // bb_gui was the newest chat when `-c` ran again.
    expect(notes.continue_two_went_to).toBe("bb_cli");
  });

  it("A46: /new and /reset as prompt.submit text reset nothing: Hermes answers a confirm text, not stored; /approve has nothing to approve", () => {
    const r = load("slash-new");
    const { notes } = r;
    for (const cmd of ["/new", "/reset"]) {
      expect(notes[cmd].admission.status, cmd).toBe("queued");
      expect(notes[cmd].snapshot).toMatchObject({ session_id: notes.session, message_count: 4 });
      expect(notes[cmd].sessions_in_list, cmd).toBe(notes.sessions_in_list_before);
    }
    const replies = events(r, "bb", notes.session).filter((e) => e.type === "message.complete").map((e) => String(e.payload.text));
    expect(replies.filter((t) => t.startsWith("⚠️ **Confirm /new**"))).toHaveLength(2);
    expect(lastUser(r).some((t) => t.startsWith("/"))).toBe(false);
    expect(pages(r).find((p) => p.session_id === notes.session && p.messages.length === 6)!.messages.map((m) => m.content)).toEqual([
      "slash turn one", "echo(2): slash turn one", "slash turn two", "echo(4): slash turn two", "after the slash commands", "echo(6): after the slash commands",
    ]);
    expect(notes.approve.events).toContain("message.complete: No pending command to approve.");
    expect(notes.approve.row_after).toEqual(notes.approve.row_before);
    expect(pages(r).at(-1)!.messages.map((m) => m.content)).toEqual(["approve turn one", "echo(2): approve turn one", "after the approved reset", "echo(4): after the approved reset"]);
  });

  it("Conduit: a dashboard turn stores the user row at send and the replies at the end; the canonical client gets no event of it", () => {
    const r = load("conduit-turn");
    const { notes } = r;
    expect(notes.dashboard_submit).toMatchObject({ status: "streaming" });
    const polls = notes.rest_polls as { t: number; roles: string[] }[];
    expect(polls[0]!.roles).toEqual(["user", "assistant", "user"]);
    expect(polls.filter((p) => p.roles.length === 3).length).toBeGreaterThan(5);
    expect(polls.at(-1)!.roles).toEqual(["user", "assistant", "user", "assistant"]);
    // Not even sessions.changed: only the dashboard client gets that signal.
    expect(notes.canonical_event_types_during.every((t: string) => t.startsWith("signal:") && t !== "signal:sessions.changed")).toBe(true);
    expect(events(r, "bb").filter((e) => e.type === "sessions.changed")).toEqual([]);
    expect(events(r, "conduit").filter((e) => e.type === "sessions.changed").length).toBeGreaterThan(0);
  });

  it("E3b: Conduit's send during a bb turn is forwarded to the gateway's queue; bb sees its events live", () => {
    const r = load("conduit-forward");
    const { notes } = r;
    expect(notes.dashboard_submit).toMatchObject({ status: "queued", forwarded: true });
    expect(notes.canonical_admissions).toEqual([notes.bb_admission.admission_id, notes.dashboard_submit.admission_id]);
    const forwarded = events(r, "bb", notes.session).filter((e) => e.admission_id === notes.dashboard_submit.admission_id).map((e) => e.type);
    expect(forwarded).toEqual(expect.arrayContaining(["message.start", "message.delta", "message.complete"]));
    // Conduit gets no stream of it: start and complete only.
    expect(notes.conduit_event_types).not.toContain("message.delta");
    const row = pages(r).at(-1)!.messages.find((m) => m.content === "conduit during the bb turn")!;
    expect(String(row.display_metadata?.submission_id)).toMatch(/^desktop-forward-[0-9a-f]{32}$/);
    // The forwarded turn's model call saw bb's turn.
    expect(r.model_calls.at(-1)!.user_texts.some((t) => t.startsWith("slow bb turn"))).toBe(true);
  });

  it("E6: while Conduit holds a legacy Bot Chat, bb's lookup, create and resume are refused; ~21 s after it leaves, the resume adopts it; both then send", () => {
    const r = load("conduit-coordination");
    const { notes } = r;
    for (const k of ["list", "create", "resume"]) expect(notes.while_held[k], k).toEqual({ refused: "runtime_coordination_required" });
    expect(notes.while_held.canonical_session).toBeNull();
    expect(notes.while_held.row.row).toMatchObject({ source: "desktop", chat_id: null, title: "Bot Chat" });
    expect(sent(r, "bb", "session.create").filter((p) => p.title === "Bot Chat")).toHaveLength(1);
    expect(notes.resume_attempts_after_leave).toEqual(["runtime_coordination_required"]);
    expect(notes.adopted_after_s).toBeGreaterThanOrEqual(15);
    expect(notes.adopted_after_s).toBeLessThanOrEqual(60);
    expect(notes.adopted_session).toBe(notes.legacy);
    expect(notes.row_after_adoption.row).toMatchObject({ source: "desktop", chat_id: notes.legacy, has_session_key: 1 });
    expect(notes.conduit_after_adoption_completed).toBe(true);
    // Hermes appends interface notes to a user message: compare the heads.
    expect(r.model_calls.at(-1)!.user_texts.slice(-2).map((t) => t.split("\n")[0])).toEqual(["bb after adoption", "conduit after adoption"]);
  });

  it("A23: session.resume of a gateway-owned row changes nothing; a session.mutate on a legacy row claims its history (no adoption)", () => {
    const { notes } = load("adoption");
    expect(notes.owned_after_resume).toEqual(notes.owned_before_resume);
    expect(notes.legacy_before_mutate).toMatchObject({ row: { source: "desktop", chat_id: null }, state_meta: [] });
    expect(notes.mutate_attempts).toEqual([]);
    expect(notes.mutate).toMatchObject({ operation: "rename", revision: 1 });
    expect(notes.legacy_after_mutate.row).toMatchObject({ source: "desktop", chat_id: null, has_session_key: 0, title: "Renamed legacy" });
    expect(notes.legacy_after_mutate.state_meta).toEqual(["gateway.history_control.v1.<id>"]);
    expect(notes.conduit_after_mutate).toMatchObject({ status: "streaming" });
  });
});
