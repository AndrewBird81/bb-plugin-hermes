// An isolated Hermes for recordings, the two-client harness and e2e (03 §Rules, S8 §Experiments):
// `~/.hermes/hermes-agent` run read only with HERMES_HOME under /private/tmp/bb-hermes-test/, its own lock dir,
// HOME and TMPDIR, an ephemeral gateway port, a dashboard on a free port with a session token (the legacy
// client Conduit uses) and a stub model on 127.0.0.1 that logs what each call was sent. No real model, no
// secrets, no .env. Never touches the live gateway: `stop()` throws if its pid changed.
// Standalone (an e2e folder for the isolated bb):
//   npx tsx e2e/isolated-hermes.ts </private/tmp/bb-hermes-test/…> [--profiles alex,bob] [--keep]
// prints {home, instance_id, dashboard_port, dashboard_token_file}, appends model calls to <home>/stub-calls.jsonl,
// serves until SIGINT/SIGTERM, then stops every process and removes the home unless --keep.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { HermesClient, localDial } from "../src/hermes/client.js";
import { discoverEndpoint } from "../src/hermes/control.js";
import type { GatewayEndpoint, GatewayEvent } from "../src/hermes/types.js";

const HERMES = path.join(os.homedir(), ".hermes");
export const TEST_ROOT = "/private/tmp/bb-hermes-test/";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (what: string, fn: () => boolean, ms = 90_000) => {
  for (const end = Date.now() + ms; !fn(); await sleep(100)) if (Date.now() > end) throw new Error(`timeout: ${what}`);
};
export const livePid = () => readFileSync(path.join(HERMES, "gateway.pid"), "utf8");
export type Tap = (client: string, dir: "in" | "out", raw: string) => void;

// ---- stub model: echoes the last user message. "slow" → ~10 s stream; "very slow" → ~20 s; "think" → reasoning
// chunks first; "use a tool" → one read_file call; "run a command" → one terminal `rm -rf` of a scratch dir under
// the home (Hermes asks for approval; the recordings deny it or let it time out); "run: <command>" → that
// command in the terminal tool (e2e: the bot runs its bb wrapper, A44).
export interface ModelCall {
  messages: number;
  user_texts: string[];
  /** The assistant texts in the context, oldest first (absent in the T1.0 recordings). */
  assistant_texts?: string[];
  /** The system prompt's skill list names the plugin's bb skill (S8 E14, A43). */
  bb_skill_listed?: boolean;
  parts: string[][];
}
type Msg = { role: string; content?: unknown };
type Part = { type?: string; text?: string };
const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? (c as Part[]).map((p) => p.text ?? "").join("") : "");
// Long user texts (Hermes appends skill and interface notes) keep their head and tail.
const clip = (s: string) => (s.length > 400 ? `${s.slice(0, 200)} … ${s.slice(-200)}` : s);
function stubModel(home: string, onCall: (c: ModelCall) => void) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const j = JSON.parse(body || "{}") as { messages?: Msg[]; tools?: unknown[]; stream?: boolean };
    const msgs = j.messages ?? [];
    const users = msgs.filter((m) => m.role === "user");
    const lastUser = text(users.at(-1)?.content);
    const last = msgs.at(-1);
    let reply = `echo(${msgs.length}): ${lastUser.slice(-120)}`;
    let delay = 0;
    let tool: { name: string; arguments: object } | null = null;
    // Calls without tools are Hermes' auxiliary ones (titles, summaries, image descriptions).
    if (!j.tools) reply = /summariz/i.test(JSON.stringify(msgs)) ? "Summary of the earlier turns." : "Stub chat";
    else {
      if (last?.role === "tool") reply = `tool result: ${text(last.content).slice(0, 120)}`;
      else if (/^run: /m.test(lastUser)) tool = { name: "terminal", arguments: { command: /^run: (.*)$/m.exec(lastUser)![1] } };
      else if (/\brun a command\b/.test(lastUser)) tool = { name: "terminal", arguments: { command: `rm -rf "${home}/work/scratch"` } };
      else if (/\buse a tool\b/.test(lastUser)) tool = { name: "read_file", arguments: { path: `${home}/work/note.txt` } };
      onCall({
        messages: msgs.length,
        user_texts: users.map((m) => clip(text(m.content))),
        bb_skill_listed: /<available_skills>[\s\S]*bb-plugin-hermes[\s\S]*<\/available_skills>/.test(text(msgs.find((m) => m.role === "system")?.content)),
        assistant_texts: msgs.filter((m) => m.role === "assistant" && text(m.content)).map((m) => clip(text(m.content))),
        parts: users.map((m) => (Array.isArray(m.content) ? (m.content as Part[]).map((p) => p.type ?? "?") : ["string"])),
      });
      if (/\bvery slow\b/.test(lastUser)) delay = 1000;
      else if (/\bslow\b/.test(lastUser)) delay = 500;
      if (delay) reply += " one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen";
    }
    const id = "chatcmpl-stub";
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const chunk = (delta: object, finish: string | null) => ({ id, object: "chat.completion.chunk", created, model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] });
    const call = tool && { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } };
    try {
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        const message = call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: reply };
        res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub", choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (call) {
        send(chunk({ role: "assistant", tool_calls: [call] }, null));
        send({ ...chunk({}, "tool_calls"), usage });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (j.tools && /\bthink\b/.test(lastUser) && last?.role !== "tool") {
        for (const r of ["Thinking about it. ", "Still thinking. ", "Done thinking."]) {
          send(chunk({ role: "assistant", reasoning_content: r }, null));
          await sleep(200);
        }
      }
      for (const [i, w] of reply.split(/(?<= )/).entries()) {
        if (res.destroyed) return;
        send(chunk(i === 0 ? { role: "assistant", content: w } : { content: w }, null));
        if (delay) await sleep(delay);
      }
      send({ ...chunk({}, "stop"), usage });
      res.end("data: [DONE]\n\n");
    } catch {}
  });
}

function config(port: number, home: string, approvalTimeoutS: number, extra = ""): string {
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
  timeout: ${approvalTimeoutS}
toolsets:
  - hermes-cli
terminal:
  backend: local
  cwd: ${home}/work
${extra}`;
}

export const freePort = () =>
  new Promise<number>((r) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

type Proc = ChildProcess & { lines: string[] };

// ---- a legacy dashboard client (Conduit's path): `/api/ws?token=` on the dashboard, legacy methods.
export type LegacyFrame = { id?: number; result?: Record<string, unknown>; error?: { code?: number; message?: string; data?: unknown } };
export type Dashboard = Awaited<ReturnType<typeof dashboardClient>>;
export async function dashboardClient(port: number, token: string, name: string, tap?: Tap) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  let n = 0;
  const pending = new Map<number, (f: LegacyFrame) => void>();
  const events: GatewayEvent[] = [];
  ws.onmessage = (m) => {
    tap?.(name, "in", String(m.data));
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
      tap?.(name, "out", raw);
      ws.send(raw);
    });
  const rpc = async (method: string, params: object) => {
    const f = await call(method, params);
    if (f.error) throw new Error(JSON.stringify(f.error));
    return f.result!;
  };
  const completes = (sid: string, from = 0) => events.slice(from).filter((e) => e.type === "message.complete" && e.session_id === sid).length;
  /** Open a stored chat by id; the answer's `session_id` is the dashboard's live id for it. */
  const open = async (profile: string, stored: string) => String((await rpc("session.resume", { session_id: stored, profile })).session_id);
  /** Conduit's Bot Chat lookup: exact title, resolved to the live tip (`tui_gateway/methods_session.py:509-534`). */
  const findByTitle = async (profile: string, title: string) => {
    const [row] = ((await rpc("session.list", { profile, title })).sessions ?? []) as { session_id: string; resolved_id?: string }[];
    return row ? (row.resolved_id ?? row.session_id) : null;
  };
  /** Send and wait for the dashboard's `message.complete` (also when the send was forwarded). */
  const send = async (profile: string, live: string, text: string) => {
    const from = events.length;
    const answer = await call("prompt.submit", { session_id: live, profile, text });
    if (!answer.error) await until(`${name} turn`, () => completes(live, from) > 0);
    return answer;
  };
  return { call, rpc, open, findByTitle, send, events, completes, close: () => ws.close() };
}

// ---- a canonical client (src/hermes, as bb's bridge and worker use it)
export type Canonical = Awaited<ReturnType<typeof canonicalClient>>;
async function canonicalClient(home: string, name: string, tap?: Tap) {
  const c = await HermesClient.connect((await localDial(home)).dial, tap ? { onFrame: (dir, raw) => tap(name, dir, raw) } : {});
  const events: GatewayEvent[] = [];
  c.onEvent((e) => events.push(e));
  const completes = (sid: string, from = 0) => events.slice(from).filter((e) => e.type === "message.complete" && e.session_id === sid).length;
  const turn = async (profile: string, session_id: string, text: string, submission_id: string, extra: object = {}) => {
    const from = events.length;
    const adm = await c.submit({ profile, session_id, text, submission_id, turn_author: { id: "bb:thr_rec", name: "bb" }, ...extra });
    await until(`${name} turn`, () => completes(session_id, from) > 0);
    return adm;
  };
  const create = async (profile: string, request_id: string, source: "cli" | "gui" = "cli") => (await c.create({ profile, request_id, source, cwd: `${home}/work` })).session_id;
  return { c, events, completes, turn, create };
}

export interface IsolatedOptions {
  /** Under /private/tmp/bb-hermes-test/; removed and created again. */
  home: string;
  /** Secondary profiles served by the root's gateway. */
  profiles: string[];
  /** Extra config.yaml lines per profile (e.g. `compression:\n  in_place: false\n`). */
  extraConfig?: Record<string, string>;
  /** Every frame of every client this instance opens. */
  tap?: Tap;
  onModelCall?: (c: ModelCall) => void;
  /** `approvals.timeout`, seconds (Hermes' default 300). */
  approvalTimeoutS?: number;
  /**
   * The installer's layout the worker's version check reads (A51): a copy of the live checkout's gateway
   * contract under `<home>/hermes-agent/`. No CLI there: the worker's `refresh-prompts` would run it with
   * the daemon's real HOME (its caches), so it reports `hermes_not_found` instead.
   */
  installerLayout?: boolean;
}

export async function startIsolatedHermes(opts: IsolatedOptions) {
  const H = opts.home;
  if (!H.startsWith(TEST_ROOT)) throw new Error(`the isolated home must be under ${TEST_ROOT}`);
  const before = livePid();
  const procs: Proc[] = [];
  const calls: ModelCall[] = [];
  const stub = stubModel(H, (c) => {
    calls.push(c);
    opts.onModelCall?.(c);
  });
  const profileHome = (p: string) => (p === "default" ? H : `${H}/profiles/${p}`);
  /** Every Hermes process here runs with this environment: nothing of the caller's. */
  // TZ=UTC: Hermes writes the zone into every system prompt ("Conversation started: … (UTC, …)"), and
  // recordings must not carry the machine's (docs/variables.md).
  const baseEnv = { HOME: `${H}/home`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: `${H}/tmp`, LANG: "en_US.UTF-8", TZ: "UTC", HERMES_HOME: H, HERMES_GATEWAY_LOCK_DIR: `${H}/locks` };
  const spawnHermes = (args: string[], log: string, o: { env?: Record<string, string>; cwd?: string } = {}): Proc => {
    const env = { ...baseEnv, ...o.env };
    const p = spawn(path.join(HERMES, "hermes-agent/venv/bin/python"), ["-m", "hermes_cli.main", ...args], { cwd: o.cwd ?? H, env, stdio: ["ignore", "pipe", "pipe"] }) as Proc;
    p.lines = [];
    p.stdout!.on("data", (d) => p.lines.push(String(d)));
    p.stderr!.on("data", (d) => p.lines.push(String(d)));
    p.on("exit", () => writeFileSync(`${H}/${log}.log`, p.lines.join("")));
    procs.push(p);
    return p;
  };

  rmSync(H, { recursive: true, force: true });
  for (const d of ["", "/locks", "/home", "/tmp", "/work", "/elsewhere", ...opts.profiles.map((p) => `/profiles/${p}`)]) mkdirSync(H + d, { recursive: true, mode: 0o700 });
  writeFileSync(`${H}/work/note.txt`, "a note for read_file\n");
  if (opts.installerLayout) {
    mkdirSync(`${H}/hermes-agent/apps/shared/src`, { recursive: true });
    copyFileSync(path.join(HERMES, "hermes-agent/apps/shared/src/gateway-contract.openrpc.json"), `${H}/hermes-agent/apps/shared/src/gateway-contract.openrpc.json`);
  }
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const stubPort = (stub.address() as { port: number }).port;
  for (const p of ["default", ...opts.profiles]) writeFileSync(`${profileHome(p)}/config.yaml`, config(stubPort, H, opts.approvalTimeoutS ?? 300, opts.extraConfig?.[p]), { mode: 0o600 });

  let gateway: Proc;
  const startGateway = async (notInstance?: string): Promise<GatewayEndpoint> => {
    gateway = spawnHermes(["gateway", "run"], `gateway-${procs.length}`);
    for (let i = 0; ; i++) {
      try {
        const ep = await discoverEndpoint(H);
        if (ep.instanceId !== notInstance) return ep;
      } catch (err) {
        // A fresh home first installs its own Python runtime (Hermes "prepares dependencies for this data root").
        if (i > 1200) throw err;
      }
      await sleep(500);
    }
  };
  /** Hermes may relaunch itself under another interpreter: signal the pid its pid file names, if it is ours. */
  const signalGateway = (signal: NodeJS.Signals) => {
    try {
      const rec = JSON.parse(readFileSync(`${H}/gateway.pid`, "utf8")) as { pid: number; hermes_home: string };
      if (rec.hermes_home === H) process.kill(rec.pid, signal);
    } catch {}
  };
  const dashboardToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const dashboardPort = await freePort();
  let endpoint: GatewayEndpoint;
  try {
    endpoint = await startGateway();
    const dash = spawnHermes(["dashboard", "--host", "127.0.0.1", "--port", String(dashboardPort), "--isolated", "--skip-build", "--no-open"], "dashboard", { env: { HERMES_DASHBOARD_SESSION_TOKEN: dashboardToken } });
    await until("dashboard", () => dash.lines.join("").includes("HERMES_DASHBOARD_READY"), 120_000);
  } catch (error) {
    // Leave nothing running; keep the home for its logs.
    signalGateway("SIGKILL");
    for (const p of procs) p.kill("SIGKILL");
    stub.close();
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const stop = async (keep: boolean) => {
    signalGateway("SIGINT");
    for (const p of procs) if (p.exitCode === null && !p.signalCode) p.kill("SIGINT");
    await sleep(4000);
    for (const p of procs) if (p.exitCode === null && !p.signalCode) p.kill("SIGKILL");
    stub.close();
    if (!keep) rmSync(H, { recursive: true, force: true });
    if (livePid() !== before) throw new Error("the live gateway pid changed");
  };
  return {
    home: H,
    env: baseEnv,
    profileHome,
    calls,
    dashboardPort,
    dashboardToken,
    get endpoint() {
      return endpoint;
    },
    canonical: (name = "bb") => canonicalClient(H, name, opts.tap),
    dashboard: (name = "conduit") => dashboardClient(dashboardPort, dashboardToken, name, opts.tap),
    /** SIGKILL, as a crash: a running turn's outcome is lost (S8 E11b). Then a new gateway (new instance id). */
    async restartGateway() {
      const old = endpoint.instanceId;
      signalGateway("SIGKILL");
      gateway.kill("SIGKILL");
      await new Promise((r) => (gateway.exitCode !== null || gateway.signalCode ? r(null) : gateway.on("exit", r)));
      await sleep(500);
      endpoint = await startGateway(old);
      return endpoint;
    },
    /** A `hermes` CLI run to its end, in the work dir by default: exit code and its output. */
    async cli(args: string[], log: string, cwd = `${H}/work`) {
      const p = spawnHermes(args, log, { cwd });
      const code = await new Promise<number | null>((r) => p.on("exit", r));
      return { args, code, output: p.lines.join("") };
    },
    /** Read only: a row's ownership columns and its state_meta keys (the id replaced by `<id>`). */
    dbRow(profile: string, id: string) {
      const db = new Database(`${profileHome(profile)}/state.db`, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("SELECT id, source, chat_id, session_key IS NOT NULL AS has_session_key, ended_at IS NOT NULL AS ended, end_reason, title FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
        const meta = (db.prepare("SELECT key FROM state_meta WHERE key LIKE ?").all(`%${id}%`) as { key: string }[]).map((r) => r.key.replace(id, "<id>")).sort();
        return { row: row ?? null, state_meta: meta };
      } finally {
        db.close();
      }
    },
    /** Stops every process; removes the home unless `keep`. Throws if the live gateway's pid changed. */
    /** Every call waits for the same stop (a signal may arrive twice through npx/tsx). */
    stop(keep = false) {
      return (stopping ??= stop(keep));
    },
  };
}
export type IsolatedHermes = Awaited<ReturnType<typeof startIsolatedHermes>>;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const home = args.find((a) => !a.startsWith("--"));
  if (!home?.startsWith(TEST_ROOT)) {
    console.error(`usage: npx tsx e2e/isolated-hermes.ts <${TEST_ROOT}…> [--profiles alex,bob] [--keep]`);
    process.exit(2);
  }
  const i = args.indexOf("--profiles");
  const profiles = i >= 0 ? args[i + 1]!.split(",") : ["alex", "bob"];
  const h = await startIsolatedHermes({ home, profiles, installerLayout: true, onModelCall: (c) => appendFileSync(`${home}/stub-calls.jsonl`, JSON.stringify(c) + "\n") });
  writeFileSync(`${home}/dashboard-token`, h.dashboardToken, { mode: 0o600 });
  console.log(JSON.stringify({ home, instance_id: h.endpoint.instanceId, dashboard_port: h.dashboardPort, dashboard_token_file: `${home}/dashboard-token` }));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void h.stop(args.includes("--keep")).then(() => process.exit(0), (e) => (console.error(e), process.exit(1))));
}
