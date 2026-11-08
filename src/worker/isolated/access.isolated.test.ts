// T1.8 evidence on an isolated Hermes (A43, A45; A16 timing; the Bot Chat lookup on a legacy row). Skipped
// in `npm test`; run it on purpose (vitest loads the bundled skill text):
//   HERMES_ISOLATED_RUN=1 npx vitest run src/worker/isolated [--keep: HERMES_ISOLATED_KEEP=1]
// Runs `~/.hermes/hermes-agent` (read only) with HERMES_HOME=/private/tmp/bb-hermes-test/worker-access, its own
// lock dir, HOME and TMPDIR, an ephemeral gateway port, a dashboard on a free port (the legacy Conduit client)
// and a stub model on 127.0.0.1 that records the system prompt of every turn. No real model, no secrets, no
// .env. Never touches the live gateway: its pid is checked before and after. Prints one JSON evidence object.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HermesClient, localDial } from "../../hermes/client.js";
import { discoverEndpoint } from "../../hermes/control.js";
import type { GatewayEvent } from "../../hermes/types.js";
import { hermesCli, refreshPrompts, setBotAccess, SKILL_DIR, writeSkill } from "../access.js";
import { describe, expect, it } from "vitest";
import { findBotChat } from "../sessions.js";

const LIVE = path.join(os.homedir(), ".hermes");
const H = "/private/tmp/bb-hermes-test/worker-access";
const keep = process.env.HERMES_ISOLATED_KEEP === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKILL = "bb-plugin-hermes";

// ---- stub model: echoes; records whether each tool-bearing call's system prompt lists our skill.
type Msg = { role: string; content?: unknown };
const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");
const seen: { lastUser: string; listed: boolean; skillsBlock: boolean }[] = [];
const stub = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const j = JSON.parse(body || "{}") as { messages?: Msg[]; tools?: unknown[]; stream?: boolean };
  const msgs = j.messages ?? [];
  const system = text(msgs.find((m) => m.role === "system")?.content);
  const lastUser = text([...msgs].reverse().find((m) => m.role === "user")?.content);
  const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(system)?.[1] ?? null;
  if (j.tools) seen.push({ lastUser: lastUser.slice(-40), listed: block?.includes(SKILL) ?? false, skillsBlock: block !== null });
  const reply = j.tools ? `echo: ${lastUser.slice(-60)}` : "Stub chat";
  const id = "chatcmpl-stub";
  const created = Math.floor(Date.now() / 1000);
  if (!j.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: object, finish: string | null) => ({ id, object: "chat.completion.chunk", created, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] });
  res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: reply }, null))}\n\n`);
  res.write(`data: ${JSON.stringify({ ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});

const ENV = { HOME: `${H}/home`, PATH: `${H}/bin:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: `${H}/tmp`, LANG: "en_US.UTF-8", HERMES_GATEWAY_LOCK_DIR: `${H}/locks` };
const procs: ChildProcess[] = [];
function hermes(args: string[], log: string, extraEnv: Record<string, string> = {}): ChildProcess & { lines: string[] } {
  const p = spawn(path.join(LIVE, "hermes-agent/venv/bin/python"), ["-m", "hermes_cli.main", ...args], { cwd: H, env: { ...ENV, HERMES_HOME: H, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }) as ChildProcess & { lines: string[] };
  p.lines = [];
  p.stdout!.on("data", (d) => p.lines.push(String(d)));
  p.stderr!.on("data", (d) => p.lines.push(String(d)));
  p.on("exit", () => writeFileSync(`${H}/${log}.log`, p.lines.join("")));
  procs.push(p);
  return p;
}

function config(port: number): string {
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
`;
}

const livePid = () => readFileSync(path.join(LIVE, "gateway.pid"), "utf8");
/** Processes whose command line names the isolated home (ours only). */
const ownProcs = () => spawnSync("pgrep", ["-f", H], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
const sqlite = (db: string, sql: string) => {
  const r = spawnSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" });
  return (r.stdout.trim() || r.stderr.trim().slice(0, 120)) as string;
};

async function main(): Promise<Record<string, any>> {
  const evidence: Record<string, any> = {};
  const before = livePid();
  rmSync(H, { recursive: true, force: true });
  for (const d of ["", "/locks", "/home", "/tmp", "/work", "/bin", "/plugin/host-data", "/profiles/alex", "/profiles/bob"]) mkdirSync(H + d, { recursive: true, mode: 0o700 });
  // The installer layout the worker looks for (`<root>/hermes-agent/venv/bin/hermes`): the live install's CLI, read only,
  // run against H. Its checkout belongs to the live data root, so Hermes first prepares a runtime inside H (`installs/`).
  mkdirSync(`${H}/hermes-agent/venv/bin`, { recursive: true });
  symlinkSync(path.join(LIVE, "hermes-agent/venv/bin/hermes"), `${H}/hermes-agent/venv/bin/hermes`);
  writeFileSync(`${H}/bin/bb`, "#!/bin/sh\necho stub-bb \"$@\"\n");
  chmodSync(`${H}/bin/bb`, 0o755);
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const port = (stub.address() as { port: number }).port;
  for (const home of [H, `${H}/profiles/alex`, `${H}/profiles/bob`]) writeFileSync(`${home}/config.yaml`, config(port), { mode: 0o600 });
  const alex = `${H}/profiles/alex`;
  const workerEnv = { ...ENV, BB_CLI: `${H}/bin/bb` };
  const cli = hermesCli(H);

  // ---- A45, no gateway: refresh-prompts runs, starts nothing.
  const procsBefore = ownProcs();
  const t0 = Date.now();
  const cold = await refreshPrompts(cli!, H, "alex", workerEnv);
  evidence.a45_no_gateway = {
    cli: cli === `${H}/hermes-agent/venv/bin/hermes` ? "<root>/hermes-agent/venv/bin/hermes" : cli,
    result: cold,
    ms: Date.now() - t0,
    gateway_files_after: ["gateway.sock", "gateway.pid", "gateway.sock.path"].filter((f) => existsSync(path.join(H, f))),
    own_processes_before: procsBefore,
    own_processes_after: ownProcs(),
    epoch_row: sqlite(`file:${alex}/state.db?mode=ro&immutable=1`, "SELECT key, value FROM state_meta WHERE key LIKE 'prompt_refresh%'"),
  };

  // ---- gateway + dashboard (Conduit's path).
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
  const gwPid = () => JSON.parse(readFileSync(`${H}/gateway.pid`, "utf8")).pid as number;
  const pidBefore = gwPid();
  const warm = await refreshPrompts(cli!, H, "alex", workerEnv);
  evidence.a45_gateway_running = { result: warm, gateway_pid_unchanged: gwPid() === pidBefore };

  const c = await HermesClient.connect((await localDial(H)).dial);
  const events: GatewayEvent[] = [];
  c.onEvent((e) => events.push(e));
  const until = async (fn: () => boolean, ms = 90_000) => {
    for (const end = Date.now() + ms; !fn(); await sleep(100)) if (Date.now() > end) throw new Error("timeout");
  };
  let n = 0;
  const turn = async (session_id: string, words: string) => {
    const from = events.length;
    await c.rpc("prompt.submit", { profile: "alex", session_id, text: words, submission_id: `bb:thr_iso:${++n}` });
    await until(() => events.slice(from).some((e) => e.type === "message.complete" && e.session_id === session_id));
    return seen.at(-1)!;
  };
  const create = async (rid: string) => (await c.create({ profile: "alex", request_id: rid, source: "cli", cwd: `${H}/work` })).session_id;

  // ---- A16: model.options timing on the isolated gateway (stub provider: no remote catalog).
  const m0 = performance.now();
  await c.modelOptions("alex", 60_000);
  const m1 = performance.now();
  await c.modelOptions("alex", 60_000);
  evidence.a16_model_options_ms = { first: Math.round(m1 - m0), second: Math.round(performance.now() - m1) };

  // ---- A43: continuing and new sessions, skill on and off.
  const s1 = await create("bb:iso:s1");
  const a = await turn(s1, "turn 1, no skill yet");
  await writeSkill(alex, alex, `${H}/plugin/host-data/bin/bb-hermes`); // skill only, no refresh
  const b = await turn(s1, "turn 2, skill written, not refreshed");
  const s2 = await create("bb:iso:s2");
  const newWithSkill = await turn(s2, "new session after the skill");
  const on = await setBotAccess({ rootHome: H, profileHome: alex, on: true, enabledBots: [alex], dataDir: `${H}/plugin/host-data`, env: workerEnv });
  const c3 = await turn(s1, "turn 3, after setBotAccess on (refresh)");
  const off = await setBotAccess({ rootHome: H, profileHome: alex, on: false, enabledBots: [], dataDir: `${H}/plugin/host-data`, env: workerEnv });
  const d = await turn(s1, "turn 4, after setBotAccess off (refresh)");
  const s3 = await create("bb:iso:s3");
  const newWithout = await turn(s3, "new session after off");
  evidence.a43 = {
    continuing: { before_skill: a, skill_no_refresh: b, after_on_refresh: c3, after_off_refresh: d },
    new_session_with_skill: newWithSkill,
    new_session_after_off: newWithout,
    set_on: on,
    set_off: off,
    skill_dir_after_off: existsSync(path.join(alex, SKILL_DIR)),
    wrapper_after_off: existsSync(`${H}/plugin/host-data/bin/bb-hermes`),
    gateway_pid_unchanged: gwPid() === pidBefore,
  };

  // ---- The Bot Chat lookup on a legacy row: does findBotChat adopt it?
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
  const dashPort = await new Promise<number>((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
  const dash = hermes(["dashboard", "--host", "127.0.0.1", "--port", String(dashPort), "--isolated", "--skip-build", "--no-open"], "dashboard", { HERMES_DASHBOARD_SESSION_TOKEN: token });
  for (let i = 0; !dash.lines.join("").includes("HERMES_DASHBOARD_READY"); i++) {
    if (i > 240) throw new Error("dashboard did not start");
    await sleep(500);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${dashPort}/api/ws?token=${token}`);
  let k = 0;
  const pending = new Map<number, (f: { result?: Record<string, unknown>; error?: unknown }) => void>();
  const dashEvents: GatewayEvent[] = [];
  ws.onmessage = (m) => {
    const f = JSON.parse(String(m.data));
    if (f.id && pending.has(f.id)) pending.get(f.id)!(f);
    else if (f.method === "event") dashEvents.push(f.params);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const drpc = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++k;
      pending.set(id, (f) => (f.error ? reject(new Error(JSON.stringify(f.error))) : resolve(f.result!)));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  const created = await drpc("session.create", { profile: "bob", source: "desktop", title: "Bot Chat", hidden: true });
  const from = dashEvents.length;
  await drpc("prompt.submit", { session_id: created.session_id, profile: "bob", text: "conduit's bot chat" });
  for (const end = Date.now() + 90_000; !dashEvents.slice(from).some((e) => e.type === "message.complete"); await sleep(100)) if (Date.now() > end) throw new Error("timeout");
  const bobDb = `${H}/profiles/bob/state.db`;
  const rows = () => ({
    sessions: JSON.parse(sqlite(bobDb, "SELECT id, chat_id, source, hidden, title FROM sessions WHERE title = 'Bot Chat'") || "[]"),
    state_meta: sqlite(bobDb, "SELECT key FROM state_meta WHERE key LIKE 'gateway.local_policy.v1:%' OR key LIKE 'gateway.local_legacy.v1:%'"),
  });
  const beforeLookup = rows();
  const held = await findBotChat(c, "bob").catch((e) => ({ error: (e as Error).message }));
  const whileHeld = rows();
  ws.close();
  let afterLeave: unknown = null;
  let rowsAfter: unknown = null;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    afterLeave = await findBotChat(c, "bob").catch((e) => ({ error: (e as Error).message }));
    if ((afterLeave as { state?: string }).state !== "held") break;
  }
  rowsAfter = rows();
  evidence.bot_chat_lookup_on_legacy = { before_lookup: beforeLookup, while_held: { result: held, rows: whileHeld }, after_conduit_left: { result: afterLeave, rows: rowsAfter } };

  c.close();
  evidence.live_gateway_pid_unchanged = livePid() === before;
  return evidence;
}

async function cleanup() {
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

describe.skipIf(process.env.HERMES_ISOLATED_RUN !== "1")("isolated Hermes: setBotAccess (A43, A45)", () => {
  it("lists the skill in new and continuing sessions after refresh-prompts, and stops after off", { timeout: 300_000 }, async () => {
    let ev: Record<string, any>;
    try {
      ev = await main();
    } finally {
      await cleanup();
    }
    writeFileSync(`${H}-evidence.json`, JSON.stringify(ev, null, 1) + "\n");
    expect(ev.live_gateway_pid_unchanged).toBe(true);
    expect(ev.a45_no_gateway).toMatchObject({ result: { refreshed: true, detail: null }, gateway_files_after: [] });
    expect(ev.a45_no_gateway.own_processes_after).toBe(ev.a45_no_gateway.own_processes_before);
    expect(ev.a45_no_gateway.epoch_row).toContain('"prompt_refresh.epoch"');
    expect(ev.a45_gateway_running).toEqual({ result: { refreshed: true, detail: null }, gateway_pid_unchanged: true });
    const { continuing } = ev.a43;
    expect([continuing.before_skill.listed, continuing.skill_no_refresh.listed, continuing.after_on_refresh.listed, continuing.after_off_refresh.listed]).toEqual([false, false, true, false]);
    expect([ev.a43.new_session_with_skill.listed, ev.a43.new_session_after_off.listed]).toEqual([true, false]);
    expect(ev.a43.set_on).toMatchObject({ skill: "current", wrapper: "written", refreshed: true });
    expect(ev.a43.set_off).toMatchObject({ skill: "removed", wrapper: "removed", refreshed: true });
    // The Bot Chat lookup adopts an unheld legacy Bot Chat (reported to the lead; findBotChat runs on user actions only).
    const lookup = ev.bot_chat_lookup_on_legacy;
    expect(lookup.while_held.result).toEqual({ state: "held" });
    expect(lookup.while_held.rows.sessions[0].chat_id).toBeNull();
    expect(lookup.after_conduit_left.result).toMatchObject({ state: "found", legacy: false });
    expect(lookup.after_conduit_left.rows.sessions[0].chat_id).toBe(lookup.after_conduit_left.rows.sessions[0].id);
  });
});
