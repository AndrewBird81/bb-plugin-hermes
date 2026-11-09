// Outside chats on demand on the isolated Hermes `bb-e2e.sh hermes` serves (never a live folder), each through
// the client that makes such rows in Hermes, so the rows are real:
//   npx tsx e2e/hermes-ctl.ts <op> <profile> [args…]      → one JSON line ({session_id, …})
//   cli|tui|desktop <profile> <text>    `hermes chat -q <text> --source <op>`        → local/<op>
//   oneshot <profile> <text>            `hermes -z <text>`                           → oneshot/oneshot (stays out)
//   turn <profile> <id> <text>          `hermes chat --resume <id> -q <text>`        → a CLI turn in that chat
//   conduit <profile> <text>            the dashboard's legacy socket (Conduit's path): create + send → desktop, no chat_id
//   conduit-turn <profile> <id> <text>  a dashboard send into that chat
//   cron <profile> <text>               `hermes cron create` + `cron run` (the gateway's scheduler) → cron/cron (stays out)
//   acp <profile> <text>                canonical `session.create{source:"acp"}` + a turn → local/acp (stays out)
//   chat-app <profile> <platform>       no platform client here: a copy of the newest local/cli row and its messages,
//                                       relabeled `<platform>` with `sqlite3` on the isolated store → <platform> (stays out)
//   hidden <profile> <text>             canonical create `hidden:true` + a turn (stays out)
//   empty <profile>                     canonical create, no turn (stays out)
//   bb <profile> <text>                 created as bb does (`bb:` request id, `gui`, `bb:` submission) (stays out)
//   title <profile> <id> <title>        `hermes sessions rename <id> <title>`
//   archive|unarchive <profile> <id>    canonical `session.mutate{operation:"archive"}`, as Desktop archives
//   compress <profile> <id>             canonical `session.mutate{operation:"compress"}`
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HermesClient, localDial } from "../src/hermes/client.js";
import { dashboardClient, TEST_ROOT, until } from "./isolated-hermes.js";

const HERMES = path.join(os.homedir(), ".hermes", "hermes-agent");
const info = JSON.parse(readFileSync("/private/tmp/bb-hermes-test/e2e-bb/hermes.json", "utf8")) as { home: string; dashboard_port: number; dashboard_token_file: string };
const H = info.home;
if (!H.startsWith(TEST_ROOT)) throw new Error("isolated homes only");
const profileHome = (p: string) => (p === "default" ? H : `${H}/profiles/${p}`);
// The environment isolated-hermes.ts runs Hermes with: nothing of the caller's.
const env = { HOME: `${H}/home`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: `${H}/tmp`, LANG: "en_US.UTF-8", TZ: "UTC", HERMES_HOME: H, HERMES_GATEWAY_LOCK_DIR: `${H}/locks` };

function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: `${H}/work`, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.stdin.end(stdin ?? "");
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.slice(0, 4).join(" ")} exited ${code}: ${out.slice(-400)}`))));
  });
}
const hermes = (args: string[]) => run(path.join(HERMES, "venv/bin/python"), ["-m", "hermes_cli.main", ...args]);

/** The newest session of a profile, read-only: `hermes -z` prints no id. */
function newest(profile: string, where: string): string {
  return execFileSync("sqlite3", ["-readonly", `${profileHome(profile)}/state.db`, `SELECT id FROM sessions WHERE ${where} ORDER BY started_at DESC LIMIT 1`], { encoding: "utf8" }).trim();
}

async function canonical<T>(fn: (c: HermesClient) => Promise<T>): Promise<T> {
  const c = await HermesClient.connect((await localDial(H)).dial);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

/** A canonical create and, with text, one turn to its end. */
async function created(profile: string, params: Record<string, unknown>, text?: string, submission?: string) {
  return canonical(async (c) => {
    const events: { type: string; session_id?: string }[] = [];
    c.onEvent((e) => events.push(e as never));
    const s = await c.create({ profile, cwd: `${H}/work`, ...params } as never);
    if (text !== undefined) {
      await c.submit({ profile, session_id: s.session_id, text, submission_id: submission ?? crypto.randomUUID() });
      await until("turn", () => events.some((e) => e.type === "message.complete" && e.session_id === s.session_id), 60_000);
    }
    return { session_id: s.stored_session_id ?? s.session_id };
  });
}

async function mutate(profile: string, id: string, operation: string, payload: object) {
  return canonical(async (c) => {
    const s = await c.resume({ profile, session_id: id, omit_messages: true });
    return c.mutate({ profile, session_id: id, request_id: `e2e:${operation}:${Date.now()}`, expected_revision: s.revision, expected_generation: s.execution_generation, operation, payload } as never);
  });
}

async function dashboard<T>(fn: (d: Awaited<ReturnType<typeof dashboardClient>>) => Promise<T>): Promise<T> {
  const d = await dashboardClient(info.dashboard_port, readFileSync(info.dashboard_token_file, "utf8").trim(), "conduit");
  try {
    return await fn(d);
  } finally {
    d.close();
  }
}

const [op, profile = "alex", ...rest] = process.argv.slice(2);
const ops: Record<string, () => Promise<unknown>> = {
  cli: async () => {
    await hermes(["-p", profile, "chat", "-q", rest[0]!, "--source", "cli"]);
    return { session_id: newest(profile, "source = 'local' AND created_source = 'cli'") };
  },
  tui: async () => {
    await hermes(["-p", profile, "chat", "-q", rest[0]!, "--source", "tui"]);
    return { session_id: newest(profile, "source = 'local' AND created_source = 'tui'") };
  },
  desktop: async () => {
    await hermes(["-p", profile, "chat", "-q", rest[0]!, "--source", "desktop"]);
    return { session_id: newest(profile, "source = 'local' AND created_source = 'desktop'") };
  },
  oneshot: async () => {
    await hermes(["-p", profile, "-z", rest[0]!]);
    return { session_id: newest(profile, "source = 'oneshot'") };
  },
  turn: async () => {
    await hermes(["-p", profile, "chat", "--resume", rest[0]!, "-q", rest[1]!]);
    return { session_id: rest[0] };
  },
  conduit: () =>
    dashboard(async (d) => {
      const made = await d.rpc("session.create", { profile, source: "desktop" });
      await d.send(profile, String(made.session_id), rest[0]!);
      return { session_id: String(made.stored_session_id) };
    }),
  "conduit-turn": () =>
    dashboard(async (d) => {
      const live = await d.open(profile, rest[0]!);
      const answer = await d.send(profile, live, rest[1]!);
      return { session_id: rest[0], answer: answer.error ?? "ok" };
    }),
  cron: async () => {
    const made = await hermes(["-p", profile, "cron", "create", "every 24h", rest[0]!, "--name", `e2e-${Date.now()}`]);
    const job = /Created job: (\S+)/.exec(made)![1]!;
    await hermes(["-p", profile, "cron", "run", job]);
    return { job, session_id: newest(profile, "source = 'cron'") };
  },
  acp: () => created(profile, { source: "acp" }, rest[0]),
  "chat-app": async () => {
    const db = `${profileHome(profile)}/state.db`;
    const from = newest(profile, "source = 'local' AND created_source = 'cli' AND message_count > 0");
    const id = `${new Date().toISOString().replace(/\D/g, "").slice(0, 8)}_${new Date().toISOString().replace(/\D/g, "").slice(8, 14)}_${crypto.randomUUID().slice(0, 6)}`;
    const cols = (table: string) => execFileSync("sqlite3", ["-readonly", db, `SELECT group_concat(name, ',') FROM pragma_table_info('${table}')`], { encoding: "utf8" }).trim().split(",");
    const pick = (table: string, over: Record<string, string>, skip: string[] = []) => {
      const names = cols(table).filter((c) => !skip.includes(c));
      return `(${names.join(",")}) SELECT ${names.map((c) => over[c] ?? c).join(",")}`;
    };
    const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
    execFileSync("sqlite3", [db, `BEGIN;
INSERT INTO sessions ${pick("sessions", { id: q(id), source: q(rest[0]!), created_source: q(rest[0]!), chat_id: "'e2e-chat'", title: "NULL", archived: "0", hidden: "0", started_at: "strftime('%s','now')", last_activity_at: "strftime('%s','now')" })} FROM sessions WHERE id = ${q(from)};
INSERT INTO messages ${pick("messages", { session_id: q(id), timestamp: "strftime('%s','now')", message_uid: "lower(hex(randomblob(16)))" }, ["id"])} FROM messages WHERE session_id = ${q(from)} ORDER BY id;
COMMIT;`]);
    return { session_id: id, copied_from: from };
  },
  hidden: () => created(profile, { source: "cli", hidden: true }, rest[0]),
  empty: () => created(profile, { source: "cli" }),
  bb: () => {
    const thread = `thr_e2e${Date.now()}`;
    return created(profile, { source: "gui", request_id: `bb:${thread}` }, rest[0], `bb:${thread}:1`);
  },
  title: async () => {
    await hermes(["-p", profile, "sessions", "rename", rest[0]!, ...rest.slice(1)]);
    return { session_id: rest[0], title: rest.slice(1).join(" ") };
  },
  archive: () => mutate(profile, rest[0]!, "archive", { archived: true }),
  unarchive: () => mutate(profile, rest[0]!, "archive", { archived: false }),
  compress: () => mutate(profile, rest[0]!, "compress", {}),
};
if (!op || !ops[op]) {
  console.error(`usage: npx tsx e2e/hermes-ctl.ts <${Object.keys(ops).join("|")}> <profile> [args…]`);
  process.exit(2);
}
console.log(JSON.stringify(await ops[op]!()));
process.exit(0);
