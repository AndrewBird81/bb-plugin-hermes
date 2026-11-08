// Record raw gateway frames and REST answers for T1.0 (03 §Recorded fixtures, T1.0 rows) from an isolated Hermes:
//   npx tsx e2e/record-frames.ts [--keep] [--only name,name]
// Writes test/fixtures/frames/<scenario>.json: { $comment, hermes, notes, frames, exchanges, model_calls }.
// Like test/fixtures/rest/record.ts: `~/.hermes/hermes-agent` run read only, HERMES_HOME under /private/tmp/bb-hermes-test/,
// its own lock dir, HOME and TMPDIR, an ephemeral gateway port, a dashboard on a free port with a session token
// (the legacy client Conduit uses) and a stub model on 127.0.0.1. Never touches the live gateway: its pid is
// checked before and after. The home is removed afterwards unless --keep.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HermesRpcError } from "../src/hermes/client.js";
import { listSessions, readMessages } from "../src/hermes/history.js";
import type { Snapshot } from "../src/hermes/types.js";
import type { RecordedExchange } from "../test/fake-hermes/index.js";
import { type IsolatedHermes, type ModelCall, sleep, startIsolatedHermes, until } from "./isolated-hermes.js";

const H = "/private/tmp/bb-hermes-test/e2e-frames";
const OUT = path.join(import.meta.dirname, "../test/fixtures/frames");
const keep = process.argv.includes("--keep");
let calls: ModelCall[] = [];

// ---- recording: frames from every client, REST answers, model calls; reset by save().
type Frame = { t: number; client: string; dir: "in" | "out"; frame: unknown };
let t0 = Date.now();
let frames: Frame[] = [];
let exchanges: RecordedExchange[] = [];
const REDACT = new Set(["origin_json", "user_id", "gateway_input_owner", "session_key", "auth_user_id"]);
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, REDACT.has(k) || /^(api_key|access_token|refresh_token|ticket|token)$|secret/i.test(k) ? (x === null ? null : "<redacted>") : redact(x)]),
  );
}
function scrubText(s: string): string {
  return s.replaceAll(os.homedir(), "~").replaceAll(os.hostname(), "<host>").replace(/\buid:\d+/g, "uid:<n>");
}
function tap(client: string, dir: "in" | "out", raw: string) {
  let frame = JSON.parse(raw);
  // The ready event carries Hermes' skin (colors, banners): not part of the protocol bb reads.
  if (frame?.params?.type === "gateway.ready" && frame.params.payload?.skin) frame = { ...frame, params: { ...frame.params, payload: { ...frame.params.payload, skin: "<trimmed>" } } };
  frames.push({ t: Date.now() - t0, client, dir, frame: redact(frame) });
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const url = new URL(String(input));
  if (url.pathname.startsWith("/api/sessions")) {
    const body = await res.clone().json();
    const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "profile"));
    exchanges.push({ profile: url.searchParams.get("profile")!, path: url.pathname, query, status: res.status, body: redact(body) });
  }
  return res;
};
// Dashboard rows get timestamped ids (`YYYYMMDD_HHMMSS_hex`), the shape the private-value guard refuses: renamed consistently.
const legacyIds = new Map<string, string>();
const renameIds = (json: string) =>
  json.replace(/\b\d{8}_\d{6}_[0-9a-f]{6,}\b/g, (id) => legacyIds.get(id) ?? (legacyIds.set(id, `legacy_rec_${legacyIds.size + 1}`), legacyIds.get(id)!));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]!.split(",") : null;
function save(name: string, scenario: string, notes: Record<string, unknown>) {
  const doc = { $comment: scenario, hermes: "c314285f07", notes, frames, exchanges, model_calls: calls };
  if (!only || only.includes(name)) writeFileSync(path.join(OUT, `${name}.json`), renameIds(scrubText(JSON.stringify(doc, null, 1))) + "\n");
  console.log(`recorded ${name}: ${frames.length} frames, ${exchanges.length} REST answers, ${calls.length} model calls`);
  begin();
}
function begin() {
  t0 = Date.now();
  frames = [];
  exchanges = [];
  calls = [];
}
const ALL = { order: "recent", archived: "include", limit: 100 } as const;
const PAGE = { order: "oldest", limit: 500 } as const;
const reason = (e: unknown) => (e instanceof HermesRpcError ? e.reason : String((e as Error).message));

let h!: IsolatedHermes;
const canonical = (name: string) => h.canonical(name);
const dashboard = () => h.dashboard();
const home = (profile: string) => h.profileHome(profile);
const dbRow = (profile: string, id: string) => h.dbRow(profile, id);
async function cli(args: string[], log: string, cwd = `${H}/work`) {
  const r = await h.cli(args, log, cwd);
  return { args: r.args, code: r.code, tail: scrubText(r.output).trim().split("\n").slice(-4) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  h = await startIsolatedHermes({
    home: H,
    profiles: ["alex", "bob", "carol", "dave"],
    extraConfig: { dave: "compression:\n  in_place: false\n" },
    approvalTimeoutS: 8,
    tap,
    onModelCall: (c) => calls.push(c),
  });
  begin();

  // ---- A19: a turn by another canonical client (the real CLI, then a second canonical client), seen live by a viewer that resumed the session.
  {
    const bb = await canonical("bb");
    const viewer = await canonical("viewer");
    const sid = await bb.create("alex", "bb:thr_rec_viewer");
    await bb.turn("alex", sid, "first turn by bb", "bb:thr_rec_viewer:1");
    await viewer.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    const from = viewer.events.length;
    const run = await cli(["-p", "alex", "chat", "--resume", sid, "-q", "slow turn from the cli"], "cli-viewer");
    await until("viewer sees the cli turn", () => viewer.completes(sid, from) > 0, 30_000).catch(() => {});
    const cliEvents = viewer.events.slice(from).filter((e) => e.session_id === sid).map((e) => e.type);
    const from2 = viewer.events.length;
    const other = await canonical("other");
    await other.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    await other.turn("alex", sid, "slow turn from another canonical client", "tui:rec:1");
    await until("viewer sees the other turn", () => viewer.completes(sid, from2) > 0, 30_000);
    const otherEvents = viewer.events.slice(from2).filter((e) => e.session_id === sid).map((e) => e.type);
    await readMessages(H, "alex", sid, PAGE);
    save("viewer", "A19: a viewer resumes a session (omit_messages) and watches a turn run by the real CLI (`hermes chat --resume <id> -q`), then one by another canonical client (alex).", {
      session: sid,
      cli: run,
      viewer_event_types_cli_turn: [...new Set(cliEvents)],
      viewer_event_types_other_turn: [...new Set(otherEvents)],
    });
    bb.c.close();
    viewer.c.close();
    other.c.close();
  }

  // ---- A24: detach with end_reason null keeps the row; with a reason, the last viewer leaving ends it.
  {
    const bb = await canonical("bb");
    const kept = await bb.create("alex", "bb:thr_rec_detach");
    await bb.turn("alex", kept, "before detach", "bb:thr_rec_detach:1");
    const sub = bb.c.cursors.get(kept)!.subscriptionId;
    const detached = await bb.c.detach({ profile: "alex", session_id: kept, subscription_id: sub, end_reason: null });
    await sleep(1000);
    const keptRow = dbRow("alex", kept);
    const ended = await bb.create("alex", "bb:thr_rec_detach_end");
    await bb.turn("alex", ended, "before detach with a reason", "bb:thr_rec_detach_end:1");
    const detachedEnd = await bb.c.detach({ profile: "alex", session_id: ended, subscription_id: bb.c.cursors.get(ended)!.subscriptionId, end_reason: "user_closed" });
    await sleep(1000);
    const endedRow = dbRow("alex", ended);
    await listSessions(H, "alex", ALL);
    // The kept row takes another turn after a fresh resume.
    const again = await canonical("bb2");
    await again.c.resume({ profile: "alex", session_id: kept, omit_messages: true });
    await again.turn("alex", kept, "after detach", "bb:thr_rec_detach:2");
    await readMessages(H, "alex", kept, PAGE);
    save("detach", "A24: session.detach end_reason null on an idle session, then end_reason user_closed on another; the first resumes and takes a turn (alex).", {
      kept,
      ended,
      detached,
      detached_end: detachedEnd,
      kept_row_after_detach: keptRow,
      ended_row_after_detach: endedRow,
    });
    bb.c.close();
    again.c.close();
  }

  // ---- A20: does `hermes chat -c` pick a bb session? bb sessions with source cli, then gui (carol).
  {
    const bb = await canonical("bb");
    const own = await cli(["-p", "carol", "chat", "-q", "the cli's own chat"], "cli-own");
    const ownId = (await listSessions(H, "carol", ALL)).sessions[0]?.id;
    const bbCli = await bb.create("carol", "bb:thr_rec_cont_cli", "cli");
    await bb.turn("carol", bbCli, "bb chat with source cli", "bb:thr_rec_cont_cli:1");
    const c1 = await cli(["-p", "carol", "chat", "-c", "-q", "continue one"], "cli-c1");
    const c1Elsewhere = await cli(["-p", "carol", "chat", "-c", "-q", "continue one elsewhere"], "cli-c1b", `${H}/elsewhere`);
    const bbGui = await bb.create("carol", "bb:thr_rec_cont_gui", "gui");
    await bb.turn("carol", bbGui, "bb chat with source gui", "bb:thr_rec_cont_gui:1");
    const c2 = await cli(["-p", "carol", "chat", "-c", "-q", "continue two"], "cli-c2");
    const list = await listSessions(H, "carol", ALL);
    const where = async (needle: string) => {
      for (const s of list.sessions) if ((await readMessages(H, "carol", s.id, PAGE)).messages.some((m) => m.role === "user" && m.content === needle)) return s.id;
      return null;
    };
    const ids: Record<string, string | undefined> = { cli_own: ownId, bb_cli: bbCli, bb_gui: bbGui };
    const name = (id: string | null) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
    save("chat-continue", "A20: the CLI's own chat, then a bb chat with source cli (cwd = the CLI's cwd), `hermes chat -c` (same cwd, then another), a bb chat with source gui, `-c` again (carol).", {
      sessions: ids,
      cli_runs: [own, c1, c1Elsewhere, c2],
      continue_one_went_to: name(await where("continue one")),
      continue_one_elsewhere_went_to: name(await where("continue one elsewhere")),
      continue_two_went_to: name(await where("continue two")),
    });
    bb.c.close();
  }

  // ---- A46: "/new" and "/reset" as prompt.submit text (alex).
  {
    const bb = await canonical("bb");
    const sid = await bb.create("alex", "bb:thr_rec_slash");
    await bb.turn("alex", sid, "slash turn one", "bb:thr_rec_slash:1");
    await bb.turn("alex", sid, "slash turn two", "bb:thr_rec_slash:2");
    const listBefore = (await listSessions(H, "alex", ALL)).sessions.length;
    const out: Record<string, unknown> = {};
    for (const [i, cmd] of ["/new", "/reset"].entries()) {
      const from = bb.events.length;
      const adm = await bb.c.submit({ profile: "alex", session_id: sid, text: cmd, submission_id: `bb:thr_rec_slash:${i + 3}` }).catch((e) => ({ refused: reason(e) }));
      await sleep(4000);
      const snap = await bb.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
      out[cmd] = {
        admission: adm,
        event_types: [...new Set(bb.events.slice(from).filter((e) => e.session_id === sid).map((e) => e.type))],
        snapshot: { session_id: snap.session_id, stored_session_id: snap.stored_session_id, message_count: snap.message_count, revision: snap.revision },
        sessions_in_list: (await listSessions(H, "alex", ALL)).sessions.length,
      };
      await readMessages(H, "alex", sid, { ...PAGE, include_compacted: true });
    }
    await bb.turn("alex", sid, "after the slash commands", "bb:thr_rec_slash:5");
    await readMessages(H, "alex", sid, { ...PAGE, include_compacted: true });
    // Hermes asks to confirm: answer "/approve" in a second chat to see what the reset does.
    const sid2 = await bb.create("alex", "bb:thr_rec_slash2");
    await bb.turn("alex", sid2, "approve turn one", "bb:thr_rec_slash2:1");
    const before2 = dbRow("alex", sid2);
    await bb.turn("alex", sid2, "/new", "bb:thr_rec_slash2:2");
    const fromA = bb.events.length;
    const approve = await bb.c.submit({ profile: "alex", session_id: sid2, text: "/approve", submission_id: "bb:thr_rec_slash2:3" }).catch((e) => ({ refused: reason(e) }));
    await sleep(4000);
    const approveEvents = bb.events.slice(fromA).filter((e) => e.session_id === sid2 || !e.session_id).map((e) => (e.type === "message.complete" ? `message.complete: ${String(e.payload?.text).slice(0, 120)}` : e.type));
    const snap2 = await bb.c.resume({ profile: "alex", session_id: sid2, omit_messages: true }).then((s) => ({ session_id: s.session_id, stored_session_id: s.stored_session_id, message_count: s.message_count }), (e) => ({ refused: reason(e) }));
    const after2 = dbRow("alex", sid2);
    await bb.turn("alex", sid2, "after the approved reset", "bb:thr_rec_slash2:4").catch(() => {});
    await listSessions(H, "alex", ALL);
    await readMessages(H, "alex", sid2, { ...PAGE, include_compacted: true });
    save("slash-new", "A46: two turns, then /new and then /reset sent as prompt.submit text, then a turn; a second chat: a turn, /new, /approve, a turn (alex).", {
      session: sid,
      sessions_in_list_before: listBefore,
      ...out,
      approve: { session: sid2, row_before: before2, admission: approve, events: [...new Set(approveEvents)], snapshot: snap2, row_after: after2 },
    });
    bb.c.close();
  }

  // ---- A50: attachments {path, mime} on prompt.submit: an image and a text file, in the work dir and in the profile's cache/images.
  {
    const bb = await canonical("bb");
    const sid = await bb.create("alex", "bb:thr_rec_attach");
    // A 1×1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(`${H}/work/pixel.png`, png);
    writeFileSync(`${H}/work/note.txt`, "a note to attach\n");
    mkdirSync(`${home("alex")}/cache/images`, { recursive: true });
    writeFileSync(`${home("alex")}/cache/images/pixel.png`, png);
    writeFileSync(`${home("alex")}/cache/images/note.txt`, "a note to attach\n");
    const tries: Record<string, unknown>[] = [];
    let n = 0;
    for (const [label, file, mime] of [
      ["image in work", `${H}/work/pixel.png`, "image/png"],
      ["image in cache/images", `${home("alex")}/cache/images/pixel.png`, "image/png"],
      ["text file in work", `${H}/work/note.txt`, "text/plain"],
      ["text file in cache/images", `${home("alex")}/cache/images/note.txt`, "text/plain"],
      ["missing file", `${H}/work/missing.png`, "image/png"],
    ] as const) {
      const at = calls.length;
      const from = bb.events.length;
      const adm = await bb.c.submit({ profile: "alex", session_id: sid, text: `see the attachment ${++n}`, submission_id: `bb:thr_rec_attach:${n}`, attachments: [{ path: file, mime }] }).catch((e) => ({ refused: reason(e), data: (e as HermesRpcError).data }));
      if (!("refused" in adm)) await until("attachment turn", () => bb.completes(sid, from) > 0).catch(() => {});
      tries.push({ label, admission: adm, model_saw: calls.slice(at).map((c) => ({ last_user: c.user_texts.at(-1), parts: c.parts.at(-1) })) });
    }
    await readMessages(H, "alex", sid, PAGE);
    save("attachments", "A50: prompt.submit attachments [{path, mime}]: a PNG in the work dir, the same PNG in the profile's cache/images, a text file, a missing file (alex).", { session: sid, tries });
    bb.c.close();
  }

  // ---- Conduit on a gateway-owned Bot Chat (alex): a dashboard turn, then a forwarded one (E2, E3b).
  const bb = await canonical("bb");
  const bot = (await bb.c.create({ profile: "alex", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:alex" })).session_id;
  await bb.turn("alex", bot, "hello bot", "bb:thr_rec_bot:1");
  const conduit = await dashboard();
  const opened = await conduit.rpc("session.resume", { session_id: bot, profile: "alex" });
  const live = String(opened.session_id);
  {
    const from = bb.events.length;
    const polls: { t: number; roles: string[] }[] = [];
    const sent = await conduit.rpc("prompt.submit", { session_id: live, profile: "alex", text: "slow conduit turn" });
    const cFrom = conduit.events.length;
    for (const end = Date.now() + 60_000; conduit.completes(live, cFrom) === 0 && Date.now() < end; await sleep(1000)) {
      polls.push({ t: Date.now() - t0, roles: (await readMessages(H, "alex", bot, PAGE)).messages.map((m) => m.role) });
    }
    await sleep(1500);
    polls.push({ t: Date.now() - t0, roles: (await readMessages(H, "alex", bot, PAGE)).messages.map((m) => m.role) });
    save("conduit-turn", "Conduit (dashboard client) sends on a gateway-owned Bot Chat while it is idle; bb's canonical client is subscribed; REST polled each second (alex).", {
      session: bot,
      dashboard_submit: sent,
      canonical_event_types_during: [...new Set(bb.events.slice(from).map((e) => (e.session_id === bot ? e.type : `signal:${e.type}`)))],
      rest_polls: polls,
    });
  }
  {
    const from = bb.events.length;
    const cFrom = conduit.events.length;
    const adm = await bb.c.submit({ profile: "alex", session_id: bot, text: "slow bb turn", submission_id: "bb:thr_rec_bot:2", turn_author: { id: "bb:thr_rec", name: "bb" } });
    await until("bb turn starts", () => bb.events.slice(from).some((e) => e.session_id === bot && e.type === "message.delta"));
    const forwarded = await conduit.rpc("prompt.submit", { session_id: live, profile: "alex", text: "conduit during the bb turn" });
    await until("both turns", () => bb.completes(bot, from) >= 2);
    await sleep(1000);
    await readMessages(H, "alex", bot, PAGE);
    const admissions = [...new Set(bb.events.slice(from).filter((e) => e.session_id === bot && e.admission_id).map((e) => e.admission_id))];
    save("conduit-forward", "E3b: bb runs a slow turn on the Bot Chat; Conduit sends during it: the dashboard forwards it to the gateway's queue (alex).", {
      session: bot,
      bb_admission: adm,
      dashboard_submit: forwarded,
      canonical_admissions: admissions,
      conduit_event_types: [...new Set(conduit.events.slice(cFrom).filter((e) => e.session_id === live).map((e) => e.type))],
    });
  }

  // ---- E3a/E9a: Conduit's own turn holds the turn lease; bb submits meanwhile: what bb's socket gets while it waits.
  {
    const from = bb.events.length;
    const cFrom = conduit.events.length;
    const conduitTurn = conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "slow conduit turn holding the lease" });
    await until("conduit's user row", () => conduit.events.slice(cFrom).some((e) => e.type === "message.start"));
    const adm = await bb.c.submit({ profile: "alex", session_id: bot, text: "bb during the conduit turn", submission_id: "bb:thr_rec_bot:lease", turn_author: { id: "bb:thr_rec", name: "bb" } });
    const sent = await conduitTurn;
    await until("bb's turn after conduit's", () => bb.completes(bot, from) > 0, 90_000);
    await sleep(1000);
    await readMessages(H, "alex", bot, PAGE);
    const mine = bb.events.slice(from).filter((e) => e.session_id === bot);
    save("lease-wait", "E3a/E9a: Conduit runs its own (dashboard) turn on the Bot Chat; bb submits during it and waits for the turn lease (alex).", {
      session: bot,
      dashboard_submit: sent.error ?? sent.result,
      bb_admission: adm,
      bb_event_types: [...new Set(mine.map((e) => e.type))],
      bb_status_events: mine.filter((e) => !/^message\.(delta|start|complete)$|^thinking\.delta$|^session\.usage$/.test(e.type)).map((e) => ({ type: e.type, payload: e.payload })),
    });
  }

  // ---- E11b: the gateway killed mid bb turn, started again: bb's admission is unknown; Conduit is refused until prompt.resolve_unknown.
  {
    const from = bb.events.length;
    const adm = await bb.c.submit({ profile: "alex", session_id: bot, text: "very slow turn before the restart", submission_id: "bb:thr_rec_bot:3", turn_author: { id: "bb:thr_rec", name: "bb" } });
    await until("bb turn streams", () => bb.events.slice(from).filter((e) => e.session_id === bot && e.type === "message.delta").length >= 3);
    const oldInstance = h.endpoint.instanceId;
    const endpoint = await h.restartGateway();
    const after = await canonical("bb");
    const snap: Snapshot = await after.c.resume({ profile: "alex", session_id: bot, omit_messages: true });
    const unknown = snap.pending.find((p) => p.admission_id === adm.admission_id);
    const refused = await conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "conduit after the restart" });
    // A second canonical submit while bb's admission is unknown: queued behind it, or refused? Then Conduit again.
    const sFrom = after.events.length;
    const second = await after.c.submit({ profile: "alex", session_id: bot, text: "second submit while unknown", submission_id: "bb:thr_rec_bot:4" }).catch((e) => ({ refused: reason(e) }));
    await sleep(4000);
    const secondRanBeforeResolve = after.completes(bot, sFrom) > 0;
    const conduitBehindSecond = await conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "conduit behind the second submit" });
    const resolved = await after.c.resolveUnknown({ profile: "alex", session_id: bot, admission_id: adm.admission_id, execution_generation: unknown?.execution_generation ?? snap.execution_generation }).catch((e) => ({ refused: reason(e) }));
    if (!("refused" in second)) await until("the second submit runs", () => after.completes(bot, sFrom) > 0, 60_000).catch(() => {});
    const secondRanAfterResolve = after.completes(bot, sFrom) > 0;
    const cFrom = conduit.events.length;
    const accepted = await conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "conduit after resolve_unknown" });
    await until("conduit turn", () => conduit.completes(live, cFrom) > 0).catch(() => {});
    await sleep(1000);
    await readMessages(H, "alex", bot, PAGE);
    save("restart-unknown", "E11b: bb's turn running on the Bot Chat; the gateway SIGKILLed and started again; bb resumes and submits a second prompt; Conduit sends; bb resolves the unknown admission; Conduit sends again (alex).", {
      second_submit: second,
      second_ran_before_resolve: secondRanBeforeResolve,
      second_ran_after_resolve: secondRanAfterResolve,
      conduit_behind_second: conduitBehindSecond.error ?? conduitBehindSecond.result,
      session: bot,
      instance_changed: endpoint.instanceId !== oldInstance,
      admission: adm,
      pending_after_restart: snap.pending.map((p) => ({ admission_id: p.admission_id, status: p.status, outcome: p.outcome, execution_generation: p.execution_generation })),
      snapshot_execution_generation: snap.execution_generation,
      conduit_before_resolve: refused.error ?? refused.result,
      resolve_unknown: resolved,
      conduit_after_resolve: accepted.error ?? accepted.result,
      conduit_after_resolve_completed: conduit.completes(live, cFrom) > 0,
    });
    after.c.close();
  }
  bb.c.close();
  conduit.close();

  // ---- E6: Conduit mints bob's Bot Chat (legacy) and holds it; bb's lookup, create and resume; adoption once Conduit leaves.
  {
    const k = await canonical("bb");
    const d = await dashboard();
    const minted = await d.rpc("session.create", { profile: "bob", source: "desktop", title: "Bot Chat", hidden: true, follow_profile_config: true });
    const mLive = String(minted.session_id);
    const legacy = String(minted.stored_session_id);
    const cFrom = d.events.length;
    await d.rpc("prompt.submit", { session_id: mLive, profile: "bob", text: "conduit mints the bot chat" });
    await until("conduit mint turn", () => d.completes(mLive, cFrom) > 0);
    const held: Record<string, unknown> = {};
    held.list = await k.c.sessionList({ profile: "bob", title: "Bot Chat", include_hidden: true }).catch((e) => ({ refused: reason(e) }));
    held.create = await k.c.create({ profile: "bob", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:bob" }).then((s) => ({ session_id: s.session_id }), (e) => ({ refused: reason(e) }));
    held.resume = await k.c.resume({ profile: "bob", session_id: legacy, omit_messages: true }).then((s) => ({ session_id: s.session_id }), (e) => ({ refused: reason(e) }));
    held.canonical_session = (await k.c.profilesList({ include_sessions: true })).profiles.find((p) => p.name === "bob")?.canonical_session ?? null;
    held.row = dbRow("bob", legacy);
    await listSessions(H, "bob", ALL);
    d.close();
    const left = Date.now();
    let adopted: Snapshot | null = null;
    const attempts: string[] = [];
    while (!adopted && Date.now() - left < 180_000) {
      await sleep(3000);
      adopted = await k.c.resume({ profile: "bob", session_id: legacy, omit_messages: true }).catch((e) => (attempts.push(reason(e)), null));
    }
    const adoptedAfterS = Math.round((Date.now() - left) / 1000);
    const rowAfter = dbRow("bob", legacy);
    if (adopted) await k.turn("bob", adopted.session_id, "bb after adoption", "bb:thr_rec_bob:1");
    const d2 = await dashboard();
    const reopened = await d2.rpc("session.resume", { session_id: legacy, profile: "bob" });
    const c2From = d2.events.length;
    const again = await d2.call("prompt.submit", { session_id: String(reopened.session_id), profile: "bob", text: "conduit after adoption" });
    await until("conduit after adoption", () => d2.completes(String(reopened.session_id), c2From) > 0).catch(() => {});
    await sleep(1000);
    await readMessages(H, "bob", legacy, PAGE);
    save("conduit-coordination", "E6: Conduit mints bob's Bot Chat on the dashboard and holds it; bb looks it up, creates, resumes; Conduit leaves; bb retries the resume every 3 s; then bb and Conduit each send (bob).", {
      legacy,
      while_held: held,
      resume_attempts_after_leave: [...new Set(attempts)],
      adopted_after_s: adopted ? adoptedAfterS : null,
      adopted_session: adopted?.session_id ?? null,
      row_after_adoption: rowAfter,
      conduit_after_adoption: again.error ?? again.result,
      conduit_after_adoption_completed: d2.completes(String(reopened.session_id), c2From) > 0,
    });
    k.c.close();
    d2.close();
  }

  // ---- A23: resuming a gateway-owned row migrates nothing; a session.mutate on a legacy row claims it (alex).
  {
    const k = await canonical("bb");
    const owned = await k.create("alex", "bb:thr_rec_owned");
    await k.turn("alex", owned, "a gateway-owned chat", "bb:thr_rec_owned:1");
    k.c.close();
    await sleep(500);
    const ownedBefore = dbRow("alex", owned);
    const k2 = await canonical("bb");
    const resumed = await k2.c.resume({ profile: "alex", session_id: owned, omit_messages: true });
    const ownedAfter = dbRow("alex", owned);

    const d = await dashboard();
    const made = await d.rpc("session.create", { profile: "alex", source: "desktop" });
    const cFrom = d.events.length;
    await d.rpc("prompt.submit", { session_id: String(made.session_id), profile: "alex", text: "a legacy chat to rename" });
    await until("legacy turn", () => d.completes(String(made.session_id), cFrom) > 0);
    const legacy = String(made.stored_session_id);
    d.close();
    const legacyBefore = dbRow("alex", legacy);
    await listSessions(H, "alex", ALL);
    const attempts: unknown[] = [];
    let mutated: unknown = null;
    let revision = 0;
    for (const left = Date.now(); !mutated && Date.now() - left < 180_000; ) {
      try {
        mutated = await k2.c.mutate({ profile: "alex", session_id: legacy, request_id: `bb:rename:legacy:${attempts.length}`, expected_revision: revision, operation: "rename", payload: { title: "Renamed legacy" } });
      } catch (e) {
        const err = e as HermesRpcError;
        attempts.push({ reason: reason(e), data: err.data });
        if (typeof err.data?.current_revision === "number") revision = err.data.current_revision;
        else if (err.reason !== "runtime_coordination_required") break;
        await sleep(3000);
      }
    }
    const legacyAfter = dbRow("alex", legacy);
    await listSessions(H, "alex", ALL);
    const d2 = await dashboard();
    const reopened = await d2.rpc("session.resume", { session_id: legacy, profile: "alex" });
    const c2From = d2.events.length;
    const conduitAfter = await d2.call("prompt.submit", { session_id: String(reopened.session_id), profile: "alex", text: "conduit after the rename" });
    await until("conduit after rename", () => d2.completes(String(reopened.session_id), c2From) > 0).catch(() => {});
    save("adoption", "A23: a gateway-owned row before and after a session.resume; a legacy (dashboard) row before and after a session.mutate rename, sent with no resume; Conduit then sends on it (alex).", {
      owned,
      owned_before_resume: ownedBefore,
      owned_after_resume: ownedAfter,
      owned_resume: { session_id: resumed.session_id, stored_session_id: resumed.stored_session_id },
      legacy,
      legacy_before_mutate: legacyBefore,
      mutate_attempts: attempts,
      mutate: mutated,
      legacy_after_mutate: legacyAfter,
      conduit_after_mutate: conduitAfter.error ?? conduitAfter.result,
    });
    k2.c.close();
    d2.close();
  }

  // ---- A rotating compress (dave, compression.in_place false): what a canonical subscriber of the old id sees.
  {
    const bb = await canonical("bb");
    const viewer = await canonical("viewer");
    const root = await bb.create("dave", "bb:thr_rec_rotview");
    for (let i = 1; i <= 6; i++) await bb.turn("dave", root, `rotating turn ${i} ` + "lorem ipsum ".repeat(30), `bb:thr_rec_rotview:${i}`);
    const before = await viewer.c.resume({ profile: "dave", session_id: root, omit_messages: true });
    const from = viewer.events.length;
    const s1 = await bb.c.resume({ profile: "dave", session_id: root, omit_messages: true });
    const compress = (await bb.c.mutate({ profile: "dave", session_id: root, request_id: "bb:compress:rotview", expected_revision: s1.revision, expected_generation: s1.execution_generation, operation: "compress", payload: {} })) as unknown as Record<string, unknown>;
    const tip = String(compress.target_session_id ?? compress.session_id);
    await sleep(2000);
    const atCompress = viewer.events.length;
    await bb.turn("dave", root, "after rotation by the root id", "bb:thr_rec_rotview:7");
    await sleep(1000);
    const name = (id: unknown) => (id === root ? "root" : id === tip ? "tip" : id ? "other" : null);
    const seen = (list: typeof viewer.events) =>
      list.map((e) => ({ type: e.type, session: name(e.session_id), seq: e.seq ?? null, epoch: e.replay_epoch ? (e.replay_epoch === before.replay_epoch ? "same" : "new") : null, stored: name(e.payload?.stored_session_id) }));
    const after = await viewer.c.resume({ profile: "dave", session_id: root, omit_messages: true });
    await listSessions(H, "dave", ALL);
    save("rotating-viewer", "A rotating compress (dave, in_place false): a viewer subscribed to the root id; bb compresses, then submits by the root id; the viewer resumes the root again.", {
      root,
      tip,
      compress,
      viewer_during_compress: seen(viewer.events.slice(from, atCompress)),
      viewer_during_next_turn: [...new Map(seen(viewer.events.slice(atCompress)).map((e) => [`${e.type}/${e.session}/${e.epoch}/${e.stored}`, e])).values()],
      bb_turn_after_rotation_session: name(bb.events.filter((e) => e.type === "message.complete").at(-1)?.session_id),
      resume_root_after: { session: name(after.session_id), stored: name(after.stored_session_id), epoch: after.replay_epoch === before.replay_epoch ? "same" : "new", last_sequence: after.last_sequence },
    });
    bb.c.close();
    viewer.c.close();
  }

  // ---- A rotated Bot Chat (dave, in_place false): what each title lookup returns before and after the compress.
  {
    const bb = await canonical("bb");
    const d = await dashboard();
    const root = (await bb.c.create({ profile: "dave", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:dave" })).session_id;
    for (let i = 1; i <= 6; i++) await bb.turn("dave", root, `bot chat turn ${i} ` + "lorem ipsum ".repeat(30), `bb:thr_rec_rotbot:${i}`);
    const lookups = async () => ({
      canonical: await bb.c.sessionList({ profile: "dave", title: "Bot Chat", include_hidden: true }),
      dashboard: (await d.rpc("session.list", { profile: "dave", title: "Bot Chat" })).sessions,
      profiles_list: (await bb.c.profilesList({ include_sessions: true })).profiles.find((p) => p.name === "dave")?.canonical_session ?? null,
    });
    const before = await lookups();
    const s1 = await bb.c.resume({ profile: "dave", session_id: root, omit_messages: true });
    const compress = (await bb.c.mutate({ profile: "dave", session_id: root, request_id: "bb:compress:rotbot", expected_revision: s1.revision, expected_generation: s1.execution_generation, operation: "compress", payload: {} })) as unknown as { target_session_id: string };
    await sleep(1000);
    const after = await lookups();
    await bb.turn("dave", root, "bot chat after rotation", "bb:thr_rec_rotbot:7");
    const afterTurn = await lookups();
    await listSessions(H, "dave", ALL);
    const tip = compress.target_session_id;
    const name = (id: unknown) => (id === root ? "root" : id === tip ? "tip" : id ?? null);
    const named = (l: Awaited<ReturnType<typeof lookups>>) => ({
      canonical: l.canonical.sessions.map((r) => ({ ...r, session_id: name(r.session_id), resolved_id: name(r.resolved_id) })),
      dashboard: (l.dashboard as Record<string, unknown>[]).map((r) => ({ session_id: name(r.session_id), resolved_id: name(r.resolved_id), title: r.title })),
      profiles_list: l.profiles_list && { ...l.profiles_list, id: name(l.profiles_list.id), resolved_id: name(l.profiles_list.resolved_id) },
    });
    save("rotated-bot-chat", "A Bot Chat in a rotating profile (dave, in_place false): session.list{title, include_hidden} (canonical), the dashboard's title lookup and profiles.list canonical_session, before and after a compress, and after a turn by the root id. Ids named root/tip.", {
      root,
      tip,
      before: named(before),
      after_compress: named(after),
      after_turn: named(afterTurn),
    });
    bb.c.close();
    d.close();
  }

  // ---- reasoning: the stub streams reasoning_content before its reply; a cli session, then a gui one (bb's source, A20).
  {
    const bb = await canonical("bb");
    const out: Record<string, unknown> = {};
    for (const source of ["cli", "gui"] as const) {
      const sid = await bb.create("alex", `bb:thr_rec_think_${source}`, source);
      const from = bb.events.length;
      await bb.turn("alex", sid, "please think first", `bb:thr_rec_think_${source}:1`);
      await readMessages(H, "alex", sid, PAGE);
      const mine = bb.events.slice(from).filter((e) => e.session_id === sid);
      out[source] = {
        session: sid,
        event_types: [...new Set(mine.map((e) => e.type))],
        reasoning_deltas: mine.filter((e) => e.type === "reasoning.delta").map((e) => e.payload?.text ?? null),
        complete_reasoning: mine.find((e) => e.type === "message.complete")?.payload?.reasoning ?? null,
      };
    }
    save("reasoning", "A turn whose model streams reasoning_content chunks, then the reply: in a source cli session, then a source gui one (alex).", out);
    bb.c.close();
  }

  // ---- approvals: one answered by another canonical client (deny), one left to time out (approvals.timeout 8 s).
  {
    const bb = await canonical("bb");
    const other = await canonical("other");
    const sid = await bb.create("alex", "bb:thr_rec_approve");
    mkdirSync(`${H}/work/scratch`, { recursive: true });
    await other.c.resume({ profile: "alex", session_id: sid, omit_messages: true });
    const kinds = (list: typeof bb.events) => list.filter((e) => e.session_id === sid && /approval|prompt|settled|cancel/.test(e.type)).map((e) => ({ type: e.type, payload: e.payload }));
    let from = bb.events.length;
    let oFrom = other.events.length;
    await bb.c.submit({ profile: "alex", session_id: sid, text: "please run a command", submission_id: "bb:thr_rec_approve:1" });
    await until("approval request", () => bb.events.slice(from).some((e) => e.session_id === sid && e.type === "approval.request"), 60_000);
    const req = bb.events.slice(from).find((e) => e.type === "approval.request")!;
    const promptId = String(req.payload?.prompt_id);
    const gen = Number(req.execution_generation ?? req.payload?.execution_generation);
    const denied = await other.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: gen, prompt_id: promptId, choice: "deny" }).catch((e) => ({ refused: reason(e) }));
    await until("turn after deny", () => bb.completes(sid, from) > 0, 60_000);
    const late = await bb.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: gen, prompt_id: promptId, choice: "deny" }).catch((e) => ({ refused: reason(e) }));
    const answered = { request_choices: req.payload?.choices, other_respond: denied, bb_respond_after: late, bb_saw: kinds(bb.events.slice(from)), other_saw: kinds(other.events.slice(oFrom)) };
    from = bb.events.length;
    oFrom = other.events.length;
    await bb.c.submit({ profile: "alex", session_id: sid, text: "please run a command again", submission_id: "bb:thr_rec_approve:2" });
    await until("approval request 2", () => bb.events.slice(from).some((e) => e.session_id === sid && e.type === "approval.request"), 60_000);
    const req2 = bb.events.slice(from).find((e) => e.type === "approval.request")!;
    await until("turn after the timeout", () => bb.completes(sid, from) > 0, 60_000);
    const afterTimeout = await bb.c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: Number(req2.execution_generation ?? req2.payload?.execution_generation), prompt_id: String(req2.payload?.prompt_id), choice: "deny" }).catch((e) => ({ refused: reason(e) }));
    await readMessages(H, "alex", sid, PAGE);
    save("approvals", "Two approvals (a terminal rm -rf of a scratch dir under the isolated home): the first denied by another canonical client, the second left to time out (approvals.timeout 8 s) (alex).", {
      session: sid,
      answered_elsewhere: answered,
      timed_out: { bb_saw: kinds(bb.events.slice(from)), other_saw: kinds(other.events.slice(oFrom)), bb_respond_after: afterTimeout },
      scratch_still_there: existsSync(`${H}/work/scratch`),
    });
    bb.c.close();
    other.c.close();
  }

  // ---- REST read mid-turn: real CLI turns (a slow reply; a tool step, then a slow reply), REST polled every 500 ms.
  {
    const bb = await canonical("bb");
    const sid = await bb.create("alex", "bb:thr_rec_midturn");
    await bb.turn("alex", sid, "warm up", "bb:thr_rec_midturn:1");
    bb.c.close();
    const polls: Record<string, { t: number; rows: string[] }[]> = {};
    for (const ask of ["slow cli turn", "use a tool slow"]) {
      const run = h.cli(["-p", "alex", "chat", "--resume", sid, "-q", ask], `cli-midturn-${ask.length}`);
      let done = false;
      void run.then(() => (done = true));
      const t1 = Date.now();
      const list: { t: number; rows: string[] }[] = [];
      while (!done) {
        const rows = (await readMessages(H, "alex", sid, PAGE)).messages.slice(2).map((m) => `${m.role}${m.tool_calls ? "+tool_calls" : ""}`);
        if (JSON.stringify(rows) !== JSON.stringify(list.at(-1)?.rows)) list.push({ t: Date.now() - t1, rows });
        await sleep(500);
      }
      list.push({ t: Date.now() - t1, rows: (await readMessages(H, "alex", sid, PAGE)).messages.slice(2).map((m) => `${m.role}${m.tool_calls ? "+tool_calls" : ""}`) });
      polls[ask] = list;
      // Keep only this turn's rows next time.
      await sleep(500);
    }
    save("rest-midturn", "REST messages polled every 500 ms while the real CLI runs a turn on a session (alex): a slow reply, then a tool step and a slow reply. Each poll lists the rows after the warm-up turn when they change.", { session: sid, polls });
  }
}

// Interrupted: stop the isolated Hermes first (a killed recorder would leave its gateway and dashboard running).
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void (h ? h.stop(keep) : Promise.resolve()).finally(() => process.exit(1)));
try {
  await main();
} finally {
  if (h) await h.stop(keep);
  console.log("stopped; live gateway pid unchanged");
}
