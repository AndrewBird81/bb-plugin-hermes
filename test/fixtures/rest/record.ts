// Record Hermes' REST projection for the strict fake (03 §Recorded fixtures, T0.5) from an isolated Hermes:
//   npx tsx test/fixtures/rest/record.ts [--keep]
// Runs `~/.hermes/hermes-agent` (read only) with HERMES_HOME=/private/tmp/bb-hermes-test/hermes-rec, its own
// lock dir and HOME, an ephemeral gateway port, a dashboard on a free port and a stub model on 127.0.0.1.
// No real model, no secrets, no .env. Never touches the live gateway: it checks its pid before and after.
// Profiles: `alex` (compaction in place, Hermes' default) and `bob` (`compression.in_place: false`).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HermesClient, localDial } from "../../../src/hermes/client.js";
import { discoverEndpoint } from "../../../src/hermes/control.js";
import { listSessions, readMessages } from "../../../src/hermes/history.js";
import type { GatewayEvent } from "../../../src/hermes/types.js";
import type { RecordedExchange } from "../../fake-hermes/index.js";

const HERMES = path.join(os.homedir(), ".hermes");
const H = "/private/tmp/bb-hermes-test/hermes-rec";
const OUT = import.meta.dirname;
const keep = process.argv.includes("--keep");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- stub model: echoes the last user message; "use a tool" → one read_file call; "slow" → ~6 s stream.
type Msg = { role: string; content?: unknown };
const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");
const stub = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const j = JSON.parse(body || "{}") as { messages?: Msg[]; tools?: unknown[]; stream?: boolean };
  const msgs = j.messages ?? [];
  const last = msgs.at(-1);
  const lastUser = text([...msgs].reverse().find((m) => m.role === "user")?.content);
  let reply = `echo(${msgs.length}): ${lastUser.slice(-120)}`;
  let toolCall = false;
  let slow = false;
  if (!j.tools) reply = /summariz/i.test(JSON.stringify(msgs)) ? "Summary of the earlier turns." : "Stub chat";
  else if (last?.role === "tool") reply = `read the note (${text(last.content).length} chars)`;
  else if (lastUser.includes("use a tool")) toolCall = true;
  else slow = /\bslow\b/.test(lastUser);
  if (toolCall || slow) await sleep(3000);
  const id = "chatcmpl-stub";
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null) => ({ id, object: "chat.completion.chunk", created, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] });
  const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${H}/work/note.txt` }) } };
  if (!j.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    const message = toolCall ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: reply };
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub", choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (toolCall) send(chunk({ role: "assistant", tool_calls: [call] }, null));
  else for (const [i, w] of reply.split(/(?<= )/).entries()) {
    send(chunk(i === 0 ? { role: "assistant", content: w } : { content: w }, null));
    if (slow) await sleep(500);
  }
  send({ ...chunk({}, toolCall ? "tool_calls" : "stop"), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.end("data: [DONE]\n\n");
});

// ---- isolated Hermes
const procs: ChildProcess[] = [];
function hermes(args: string[], log: string, extraEnv: Record<string, string> = {}): ChildProcess {
  // TZ=UTC: Hermes writes the zone into every system prompt (docs/variables.md).
  const env = { HOME: `${H}/home`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: `${H}/tmp`, LANG: "en_US.UTF-8", TZ: "UTC", HERMES_HOME: H, HERMES_GATEWAY_LOCK_DIR: `${H}/locks`, ...extraEnv };
  const p = spawn(path.join(HERMES, "hermes-agent/venv/bin/python"), ["-m", "hermes_cli.main", ...args], { cwd: H, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  p.stdout!.on("data", (d) => lines.push(String(d)));
  p.stderr!.on("data", (d) => lines.push(String(d)));
  p.on("exit", () => writeFileSync(`${H}/${log}.log`, lines.join("")));
  (p as ChildProcess & { lines: string[] }).lines = lines;
  procs.push(p);
  return p;
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

// ---- canonical client helpers (our own client, src/hermes)
async function canonical() {
  const c = await HermesClient.connect((await localDial(H)).dial);
  const events: GatewayEvent[] = [];
  c.onEvent((e) => events.push(e));
  const until = async (fn: () => boolean, ms = 90_000) => {
    for (const end = Date.now() + ms; !fn(); await sleep(100)) if (Date.now() > end) throw new Error("timeout");
  };
  const turn = async (profile: string, session_id: string, text: string, submission_id: string, extra: object = {}) => {
    const from = events.length;
    const adm = await c.rpc("prompt.submit", { profile, session_id, text, submission_id, turn_author: { id: "bb:thr_rec", name: "bb" }, ...extra });
    await until(() => events.slice(from).some((e) => e.type === "message.complete" && e.session_id === session_id));
    return adm;
  };
  const create = async (profile: string, request_id: string) => (await c.create({ profile, request_id, source: "cli", cwd: `${H}/work` })).session_id;
  return { c, events, until, turn, create };
}

// ---- recording: every REST response history.ts reads, captured at fetch, redacted.
let exchanges: RecordedExchange[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const url = new URL(String(input));
  const body = await res.clone().json();
  const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== "profile"));
  exchanges.push({ profile: url.searchParams.get("profile")!, path: url.pathname, query, status: res.status, body: redact(body) });
  return res;
};
const REDACT = new Set(["origin_json", "user_id", "gateway_input_owner", "session_key"]);
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.has(k) || /^(api_key|access_token|refresh_token|ticket)$|secret/i.test(k) ? (x === null ? null : "<redacted>") : redact(x)]));
}
// Dashboard rows get timestamped ids (`YYYYMMDD_HHMMSS_hex`), the shape the private-value guard refuses: renamed consistently.
const legacyIds = new Map<string, string>();
const renameIds = (json: string) =>
  json.replace(/\b\d{8}_\d{6}_[0-9a-f]{6,}\b/g, (id) => legacyIds.get(id) ?? (legacyIds.set(id, `legacy_rec_${legacyIds.size + 1}`), legacyIds.get(id)!));
function save(name: string, scenario: string, notes: Record<string, unknown> = {}) {
  writeFileSync(path.join(OUT, `${name}.json`), renameIds(JSON.stringify({ $comment: scenario, hermes: "c314285f07", notes, exchanges }, null, 1)) + "\n");
  console.log(`recorded ${name}: ${exchanges.length} responses`);
  exchanges = [];
}
const ALL = { order: "recent", archived: "include", limit: 100 } as const;
const PAGE = { order: "oldest", limit: 500 } as const;

// ---- a legacy dashboard client (Conduit's path): `/api/ws?token=` on the dashboard, legacy methods.
async function dashboard(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  let n = 0;
  const pending = new Map<number, (f: { result?: unknown; error?: unknown }) => void>();
  const events: GatewayEvent[] = [];
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    if (f.id && pending.has(f.id)) pending.get(f.id)!(f);
    else if (f.method === "event") events.push(f.params);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const rpc = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++n;
      pending.set(id, (f) => (f.error ? reject(new Error(JSON.stringify(f.error))) : resolve(f.result as Record<string, unknown>)));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const turn = async (profile: string, text: string) => {
    const created = await rpc("session.create", { profile, source: "desktop" });
    const from = events.length;
    await rpc("prompt.submit", { session_id: created.session_id, profile, text });
    for (const end = Date.now() + 90_000; !events.slice(from).some((e) => e.type === "message.complete"); await sleep(100)) if (Date.now() > end) throw new Error("timeout");
  };
  return { turn, close: () => ws.close() };
}

async function main() {
  const before = livePid();
  rmSync(H, { recursive: true, force: true });
  for (const d of ["", "/locks", "/home", "/tmp", "/work", "/profiles/alex", "/profiles/bob"]) mkdirSync(H + d, { recursive: true, mode: 0o700 });
  writeFileSync(`${H}/work/note.txt`, "a note for read_file\n");
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  writeFileSync(`${H}/config.yaml`, config(port), { mode: 0o600 });
  writeFileSync(`${H}/profiles/alex/config.yaml`, config(port), { mode: 0o600 });
  writeFileSync(`${H}/profiles/bob/config.yaml`, config(port, "compression:\n  in_place: false\n"), { mode: 0o600 });

  hermes(["gateway", "run"], "gateway");
  for (let i = 0; ; i++) {
    try {
      await discoverEndpoint(H);
      break;
    } catch (err) {
      if (i > 240) throw err;
      await sleep(500);
    }
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const dashPort = await new Promise<number>((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
  const dash = hermes(["dashboard", "--host", "127.0.0.1", "--port", String(dashPort), "--isolated", "--skip-build", "--no-open"], "dashboard", { HERMES_DASHBOARD_SESSION_TOKEN: token });
  for (let i = 0; !(dash as ChildProcess & { lines: string[] }).lines.join("").includes("HERMES_DASHBOARD_READY"); i++) {
    if (i > 240) throw new Error("dashboard did not start");
    await sleep(500);
  }

  const k = await canonical();

  // create: a bb side chat, two turns with bb: submission ids (A1, A4).
  const create = await k.create("alex", "bb:thr_rec_create");
  await k.turn("alex", create, "hello one", "bb:thr_rec_create:1");
  await k.turn("alex", create, "hello two", "bb:thr_rec_create:2");
  const repeat = await k.c.rpc("prompt.submit", { profile: "alex", session_id: create, text: "hello two", submission_id: "bb:thr_rec_create:2", turn_author: { id: "bb:thr_rec", name: "bb" } }).catch((e) => ({ refused: e.reason }));
  await listSessions(H, "alex", ALL);
  await readMessages(H, "alex", create, PAGE);
  save("create", "A bb-created chat (alex): session.create source cli, two prompt.submit with bb: submission ids; then the same submission_id again.", { session: create, repeated_submit: repeat });

  // bot-chat: the profile's hidden "Bot Chat" as bb creates it (02 flow 3 step 2).
  const bot = (await k.c.create({ profile: "alex", title: "Bot Chat", hidden: true, follow_profile_config: true, request_id: "bb:botchat:alex" })).session_id;
  await k.turn("alex", bot, "hello bot", "bb:thr_rec_bot:1");
  await listSessions(H, "alex", ALL);
  await readMessages(H, "alex", bot, PAGE);
  save("bot-chat", "The hidden Bot Chat (alex) as bb creates it, one turn: is it in the REST list?", { session: bot });

  // steer + queued: a tool turn, steered mid-turn; a second bb prompt queued behind it (A4).
  const steer = await k.create("alex", "bb:thr_rec_steer");
  await k.turn("alex", steer, "start", "bb:thr_rec_steer:1");
  const from = k.events.length;
  await k.c.rpc("prompt.submit", { profile: "alex", session_id: steer, text: "please use a tool", submission_id: "bb:thr_rec_steer:2" });
  await k.until(() => k.events.slice(from).some((e) => e.type === "tool.start" || e.type === "message.start"));
  const gen = k.c.cursors.get(steer)?.executionGeneration ?? [...k.events].reverse().find((e) => typeof e.execution_generation === "number")?.execution_generation;
  const steered = await k.c.steer({ profile: "alex", session_id: steer, execution_generation: gen!, text: "steer words" }).catch((e) => ({ refused: e.reason }));
  const queued = await k.c.rpc("prompt.submit", { profile: "alex", session_id: steer, text: "queued behind", submission_id: "bb:thr_rec_steer:3" });
  await k.until(() => k.events.slice(from).filter((e) => e.type === "message.complete" && e.session_id === steer).length >= 2);
  await readMessages(H, "alex", steer, PAGE);
  save("steer", "A tool turn steered mid-turn (session.steer), and a bb prompt queued behind it (alex).", { session: steer, steer: steered, queued });

  // hidden-prompt: prompt.submit display_kind hidden, then a visible turn.
  const hidden = await k.create("alex", "bb:thr_rec_hidden");
  await k.turn("alex", hidden, "hidden instruction", "bb:thr_rec_hidden:1", { display_kind: "hidden" });
  await k.turn("alex", hidden, "visible after", "bb:thr_rec_hidden:2");
  await readMessages(H, "alex", hidden, PAGE);
  save("hidden-prompt", "A hidden prompt (prompt.submit display_kind hidden), then a visible turn (alex).", { session: hidden });

  // retry: a turn, then "/retry" sent as prompt text.
  const retry = await k.create("alex", "bb:thr_rec_retry");
  await k.turn("alex", retry, "first ask", "bb:thr_rec_retry:1");
  await k.turn("alex", retry, "/retry", "bb:thr_rec_retry:2");
  await readMessages(H, "alex", retry, PAGE);
  save("retry", "A turn, then /retry as prompt.submit text (alex).", { session: retry });

  // compaction in place (alex, Hermes' default): 4 turns, compress, 1 turn.
  const inPlace = await k.create("alex", "bb:thr_rec_inplace");
  for (let i = 1; i <= 4; i++) await k.turn("alex", inPlace, `in place turn ${i} ` + "lorem ipsum ".repeat(30), `bb:thr_rec_inplace:${i}`);
  await readMessages(H, "alex", inPlace, PAGE);
  await readMessages(H, "alex", inPlace, { ...PAGE, include_compacted: true });
  save("compaction-in-place-before", "compaction-in-place before its compress.", { session: inPlace });
  const s1 = await k.c.resume({ profile: "alex", session_id: inPlace, omit_messages: true });
  const c1 = await k.c.mutate({ profile: "alex", session_id: inPlace, request_id: "bb:compress:inplace", expected_revision: s1.revision, expected_generation: s1.execution_generation, operation: "compress", payload: {} });
  await k.turn("alex", inPlace, "after compaction", "bb:thr_rec_inplace:5");
  await readMessages(H, "alex", inPlace, PAGE);
  await readMessages(H, "alex", inPlace, { ...PAGE, include_compacted: true });
  save("compaction-in-place", "Compaction in place (alex): 4 turns, session.mutate compress, 1 turn. Default view and include_compacted.", { session: inPlace, compress: c1 });

  // compaction rotating (bob, in_place false): 8 turns, compress, 1 turn on the tip (cloned tail).
  const rot = await k.create("bob", "bb:thr_rec_rotate");
  for (let i = 1; i <= 8; i++) await k.turn("bob", rot, `rotating turn ${i} ` + "lorem ipsum ".repeat(30), `bb:thr_rec_rotate:${i}`);
  await readMessages(H, "bob", rot, PAGE);
  save("compaction-rotating-before", "compaction-rotating before its compress.", { root: rot });
  const s2 = await k.c.resume({ profile: "bob", session_id: rot, omit_messages: true });
  const c2 = (await k.c.mutate({ profile: "bob", session_id: rot, request_id: "bb:compress:rotate", expected_revision: s2.revision, expected_generation: s2.execution_generation, operation: "compress", payload: {} })) as unknown as { target_session_id: string };
  // Resuming the root reaches the tip (S8 E8); a submit to the root lands there.
  await k.c.resume({ profile: "bob", session_id: rot, omit_messages: true });
  await k.turn("bob", rot, "after rotation", "bb:thr_rec_rotate:9");
  await listSessions(H, "bob", ALL);
  await readMessages(H, "bob", rot, PAGE);
  await readMessages(H, "bob", c2.target_session_id, PAGE);
  save("compaction-rotating", "Rotating compaction (bob, compression.in_place false): 8 turns, compress, 1 turn on the tip.", { root: rot, compress: c2 });

  // legacy: a dashboard (Conduit) chat, the dashboard client gone: not gateway-owned yet (D16).
  const d1 = await dashboard(dashPort, token);
  await d1.turn("alex", "conduit legacy chat");
  d1.close();
  await sleep(1000);
  const legacyList = await listSessions(H, "alex", ALL);
  const legacy = legacyList.sessions.find((s) => s.source === "desktop")!;
  await readMessages(H, "alex", legacy.id, PAGE);
  save("legacy", "A dashboard (Conduit) chat after its client left: source desktop, no chat_id (alex).", { session: legacy.id });

  // conduit-held: a dashboard chat still open. REST reads it; the canonical resume is refused, so nothing adopted it (A48).
  const d2 = await dashboard(dashPort, token);
  await d2.turn("bob", "conduit holds this chat");
  const heldList = await listSessions(H, "bob", ALL);
  const held = heldList.sessions.find((s) => s.source === "desktop")!;
  await readMessages(H, "bob", held.id, PAGE);
  const resume = await k.c.resume({ profile: "bob", session_id: held.id, omit_messages: true }).then(() => "adopted", (e) => e.reason);
  await listSessions(H, "bob", ALL);
  d2.close();
  save("conduit-held", "A dashboard (Conduit) chat while the dashboard holds it: REST list and messages, then the list again (bob).", { session: held.id, canonical_resume_while_held: resume });

  // Every served profile is reachable through the root's socket (A36): the root's list too.
  await listSessions(H, "default", ALL);
  save("default-profile", "The root profile's list: no chats.");

  k.c.close();
  if (livePid() !== before) throw new Error("the live gateway pid changed");
}

try {
  await main();
} finally {
  // Hermes may relaunch itself under another interpreter: also stop the pid its own pid file names, if it is ours.
  try {
    const rec = JSON.parse(readFileSync(`${H}/gateway.pid`, "utf8")) as { pid: number; hermes_home: string };
    if (rec.hermes_home === H) process.kill(rec.pid, "SIGINT");
  } catch {}
  for (const p of procs) p.kill("SIGINT");
  await sleep(4000);
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  stub.close();
  if (!keep) rmSync(H, { recursive: true, force: true });
}
