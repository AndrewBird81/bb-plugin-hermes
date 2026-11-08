// Record raw gateway frames and REST answers for T1.0 (03 §Recorded fixtures, T1.0 rows) from an isolated Hermes:
//   npx tsx e2e/record-frames.ts [--keep] [--only name,name]
// Writes test/fixtures/frames/<scenario>.json: { $comment, hermes, notes, frames, exchanges, model_calls }.
// Like test/fixtures/rest/record.ts: `~/.hermes/hermes-agent` run read only, HERMES_HOME under /private/tmp/bb-hermes-test/,
// its own lock dir, HOME and TMPDIR, an ephemeral gateway port, a dashboard on a free port with a session token
// (the legacy client Conduit uses) and a stub model on 127.0.0.1. Never touches the live gateway: its pid is
// checked before and after. The home is removed afterwards unless --keep.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { HermesClient, HermesRpcError, localDial } from "../src/hermes/client.js";
import { discoverEndpoint } from "../src/hermes/control.js";
import { listSessions, readMessages } from "../src/hermes/history.js";
import type { GatewayEvent, Snapshot } from "../src/hermes/types.js";
import type { RecordedExchange } from "../test/fake-hermes/index.js";

const HERMES = path.join(os.homedir(), ".hermes");
const H = "/private/tmp/bb-hermes-test/e2e-frames";
const OUT = path.join(import.meta.dirname, "../test/fixtures/frames");
const keep = process.argv.includes("--keep");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, fn: () => boolean, ms = 90_000) => {
  for (const end = Date.now() + ms; !fn(); await sleep(100)) if (Date.now() > end) throw new Error(`timeout: ${what}`);
};
const home = (profile: string) => (profile === "default" ? H : `${H}/profiles/${profile}`);

// ---- stub model: echoes the last user message. "slow" → ~6 s stream; "very slow" → ~20 s. Every call is logged.
type Msg = { role: string; content?: unknown };
type Part = { type?: string; text?: string };
const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? (c as Part[]).map((p) => p.text ?? "").join("") : "");
// Long user texts (Hermes appends skill notes) keep their head and tail.
const clip = (s: string) => (s.length > 400 ? `${s.slice(0, 200)} … ${s.slice(-200)}` : s);
let calls: { user_texts: string[]; parts: string[][]; messages: number }[] = [];
const stub = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const j = JSON.parse(body || "{}") as { messages?: Msg[]; tools?: unknown[]; stream?: boolean };
  const msgs = j.messages ?? [];
  const users = msgs.filter((m) => m.role === "user");
  const lastUser = text(users.at(-1)?.content);
  let reply = `echo(${msgs.length}): ${lastUser.slice(-120)}`;
  let delay = 0;
  if (!j.tools) reply = /summariz/i.test(JSON.stringify(msgs)) ? "Summary of the earlier turns." : "Stub chat";
  else {
    calls.push({
      messages: msgs.length,
      user_texts: users.map((m) => clip(text(m.content))),
      parts: users.map((m) => (Array.isArray(m.content) ? (m.content as Part[]).map((p) => p.type ?? "?") : ["string"])),
    });
    if (/\bvery slow\b/.test(lastUser)) delay = 1000;
    else if (/\bslow\b/.test(lastUser)) delay = 500;
    if (delay) reply += " one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen";
  }
  const id = "chatcmpl-stub";
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null) => ({ id, object: "chat.completion.chunk", created, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] });
  try {
    if (!j.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const [i, w] of reply.split(/(?<= )/).entries()) {
      if (res.destroyed) return;
      send(chunk(i === 0 ? { role: "assistant", content: w } : { content: w }, null));
      if (delay) await sleep(delay);
    }
    send({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.end("data: [DONE]\n\n");
  } catch {}
});

// ---- isolated Hermes
const procs: ChildProcess[] = [];
type Proc = ChildProcess & { lines: string[] };
function hermes(args: string[], log: string, opts: { env?: Record<string, string>; cwd?: string } = {}): Proc {
  const env = { HOME: `${H}/home`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: `${H}/tmp`, LANG: "en_US.UTF-8", HERMES_HOME: H, HERMES_GATEWAY_LOCK_DIR: `${H}/locks`, ...opts.env };
  const p = spawn(path.join(HERMES, "hermes-agent/venv/bin/python"), ["-m", "hermes_cli.main", ...args], { cwd: opts.cwd ?? H, env, stdio: ["ignore", "pipe", "pipe"] }) as Proc;
  p.lines = [];
  p.stdout!.on("data", (d) => p.lines.push(String(d)));
  p.stderr!.on("data", (d) => p.lines.push(String(d)));
  p.on("exit", () => writeFileSync(`${H}/${log}.log`, p.lines.join("")));
  procs.push(p);
  return p;
}
/** A CLI run to its end: exit code and its last output lines, scrubbed. */
async function cli(args: string[], log: string, cwd = `${H}/work`) {
  const p = hermes(args, log, { cwd });
  const code = await new Promise<number | null>((r) => p.on("exit", r));
  return { args, code, tail: scrubText(p.lines.join("")).trim().split("\n").slice(-4) };
}

function config(port: number, extra = ""): string {
  return `model:
  default: stub
  provider: stub
  base_url: http://127.0.0.1:${port}/v1
providers:
  stub:
    name: stub
    base_url: http://127.0.0.1:${port}/v1
    api_key: stub
    api_mode: chat_completions
    default_model: stub
    discover_models: false
    context_length: 65536
    models:
      stub:
        name: Stub echo
fallback_providers: []
approvals:
  mode: manual
toolsets:
  - hermes-cli
terminal:
  backend: local
  cwd: ${H}/work
${extra}`;
}

const livePid = () => readFileSync(path.join(HERMES, "gateway.pid"), "utf8");
let gateway: Proc;
async function startGateway(notInstance?: string) {
  gateway = hermes(["gateway", "run"], `gateway-${procs.length}`);
  for (let i = 0; ; i++) {
    try {
      const ep = await discoverEndpoint(H);
      if (ep.instanceId !== notInstance) return ep;
    } catch (err) {
      if (i > 240) throw err;
    }
    await sleep(500);
  }
}
/** SIGKILL: the turn's outcome is lost, as in a crash (S8 E11b). Hermes may relaunch itself: kill its pid file's pid too. */
async function killGateway() {
  try {
    const rec = JSON.parse(readFileSync(`${H}/gateway.pid`, "utf8")) as { pid: number; hermes_home: string };
    if (rec.hermes_home === H) process.kill(rec.pid, "SIGKILL");
  } catch {}
  gateway.kill("SIGKILL");
  await new Promise((r) => (gateway.exitCode !== null || gateway.signalCode ? r(null) : gateway.on("exit", r)));
}

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
function tap(client: string) {
  return (dir: "in" | "out", raw: string) => {
    let frame = JSON.parse(raw);
    // The ready event carries Hermes' skin (colors, banners): not part of the protocol bb reads.
    if (frame?.params?.type === "gateway.ready" && frame.params.payload?.skin) frame = { ...frame, params: { ...frame.params, payload: { ...frame.params.payload, skin: "<trimmed>" } } };
    frames.push({ t: Date.now() - t0, client, dir, frame: redact(frame) });
  };
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

// ---- read-only peek into the isolated state.db: the row's ownership columns and its state_meta keys.
function dbRow(profile: string, id: string) {
  const db = new Database(`${home(profile)}/state.db`, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT id, source, chat_id, session_key IS NOT NULL AS has_session_key, ended_at IS NOT NULL AS ended, end_reason, title FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    const meta = (db.prepare("SELECT key FROM state_meta WHERE key LIKE ?").all(`%${id}%`) as { key: string }[]).map((r) => r.key.replace(id, "<id>")).sort();
    return { row: row ?? null, state_meta: meta };
  } finally {
    db.close();
  }
}

// ---- canonical client (src/hermes, as bb's bridge and worker use it)
async function canonical(name: string) {
  const c = await HermesClient.connect((await localDial(H)).dial, { onFrame: tap(name) });
  const events: GatewayEvent[] = [];
  c.onEvent((e) => events.push(e));
  const completes = (sid: string, from = 0) => events.slice(from).filter((e) => e.type === "message.complete" && e.session_id === sid).length;
  const turn = async (profile: string, session_id: string, text: string, submission_id: string, extra: object = {}) => {
    const from = events.length;
    const adm = await c.submit({ profile, session_id, text, submission_id, turn_author: { id: "bb:thr_rec", name: "bb" }, ...extra });
    await until(`${name} turn`, () => completes(session_id, from) > 0);
    return adm;
  };
  const create = async (profile: string, request_id: string, source: "cli" | "gui" = "cli") => (await c.create({ profile, request_id, source, cwd: `${H}/work` })).session_id;
  return { c, events, completes, turn, create };
}

// ---- a legacy dashboard client (Conduit's path): `/api/ws?token=` on the dashboard, legacy methods.
type LegacyFrame = { id?: number; result?: Record<string, unknown>; error?: { code?: number; message?: string; data?: unknown } };
async function dashboard(port: number, token: string, name = "conduit") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  let n = 0;
  const pending = new Map<number, (f: LegacyFrame) => void>();
  const events: GatewayEvent[] = [];
  const t = tap(name);
  ws.onmessage = (m) => {
    t("in", String(m.data));
    const f = JSON.parse(String(m.data));
    if (f.id && pending.has(f.id)) pending.get(f.id)!(f);
    else if (f.method === "event") events.push(f.params);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  /** The whole answer frame: a refusal is data here, not an exception. */
  const call = (method: string, params: object) =>
    new Promise<LegacyFrame>((resolve) => {
      const id = ++n;
      pending.set(id, resolve);
      const raw = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      t("out", raw);
      ws.send(raw);
    });
  const rpc = async (method: string, params: object) => {
    const f = await call(method, params);
    if (f.error) throw new Error(JSON.stringify(f.error));
    return f.result!;
  };
  const completes = (sid: string, from = 0) => events.slice(from).filter((e) => e.type === "message.complete" && e.session_id === sid).length;
  return { call, rpc, events, completes, close: () => ws.close() };
}
const freePort = () =>
  new Promise<number>((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

async function main() {
  const before = livePid();
  rmSync(H, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const d of ["", "/locks", "/home", "/tmp", "/work", "/elsewhere", "/profiles/alex", "/profiles/bob", "/profiles/carol"]) mkdirSync(H + d, { recursive: true, mode: 0o700 });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  writeFileSync(`${H}/config.yaml`, config(port), { mode: 0o600 });
  for (const p of ["alex", "bob", "carol"]) writeFileSync(`${H}/profiles/${p}/config.yaml`, config(port), { mode: 0o600 });

  let endpoint = await startGateway();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const dashPort = await freePort();
  const dash = hermes(["dashboard", "--host", "127.0.0.1", "--port", String(dashPort), "--isolated", "--skip-build", "--no-open"], "dashboard", { env: { HERMES_DASHBOARD_SESSION_TOKEN: token } });
  await until("dashboard", () => dash.lines.join("").includes("HERMES_DASHBOARD_READY"), 120_000);
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
  const conduit = await dashboard(dashPort, token);
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

  // ---- E11b: the gateway killed mid bb turn, started again: bb's admission is unknown; Conduit is refused until prompt.resolve_unknown.
  {
    const from = bb.events.length;
    const adm = await bb.c.submit({ profile: "alex", session_id: bot, text: "very slow turn before the restart", submission_id: "bb:thr_rec_bot:3", turn_author: { id: "bb:thr_rec", name: "bb" } });
    await until("bb turn streams", () => bb.events.slice(from).filter((e) => e.session_id === bot && e.type === "message.delta").length >= 3);
    const oldInstance = endpoint.instanceId;
    await killGateway();
    await sleep(500);
    endpoint = await startGateway(oldInstance);
    const after = await canonical("bb");
    const snap: Snapshot = await after.c.resume({ profile: "alex", session_id: bot, omit_messages: true });
    const unknown = snap.pending.find((p) => p.admission_id === adm.admission_id);
    const refused = await conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "conduit after the restart" });
    const resolved = await after.c.resolveUnknown({ profile: "alex", session_id: bot, admission_id: adm.admission_id, execution_generation: unknown?.execution_generation ?? snap.execution_generation }).catch((e) => ({ refused: reason(e) }));
    const cFrom = conduit.events.length;
    const accepted = await conduit.call("prompt.submit", { session_id: live, profile: "alex", text: "conduit after resolve_unknown" });
    await until("conduit turn", () => conduit.completes(live, cFrom) > 0).catch(() => {});
    await sleep(1000);
    await readMessages(H, "alex", bot, PAGE);
    save("restart-unknown", "E11b: bb's turn running on the Bot Chat; the gateway SIGKILLed and started again; bb resumes; Conduit sends; bb resolves the unknown admission; Conduit sends again (alex).", {
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
    const d = await dashboard(dashPort, token);
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
    const d2 = await dashboard(dashPort, token);
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

    const d = await dashboard(dashPort, token);
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
    const d2 = await dashboard(dashPort, token);
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

  if (livePid() !== before) throw new Error("the live gateway pid changed");
  console.log("live gateway pid unchanged");
}

try {
  await main();
} finally {
  try {
    const rec = JSON.parse(readFileSync(`${H}/gateway.pid`, "utf8")) as { pid: number; hermes_home: string };
    if (rec.hermes_home === H) process.kill(rec.pid, "SIGINT");
  } catch {}
  for (const p of procs) if (p.exitCode === null && !p.signalCode) p.kill("SIGINT");
  await sleep(4000);
  for (const p of procs) if (p.exitCode === null && !p.signalCode) p.kill("SIGKILL");
  stub.close();
  if (!keep) rmSync(H, { recursive: true, force: true });
}
