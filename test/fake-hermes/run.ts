// Standalone strict fake for the isolated-bb e2e (03 §E2E step 5):
//   npm run fake-hermes -- <folder under /private/tmp/bb-hermes-test/> [--profiles alex,bob] [--rotating bob]
//                          [--second-ms 1000] [--changed-contract]
// Serves the session engine (engine.ts) for the profiles given (default alex, bob) and every REST recording.
// Prints one JSON line {folder, instance_id, api_origin, control} and writes the same to <folder>/fake-hermes.json;
// after each restart it prints and writes the new one. Serves until SIGINT/SIGTERM, then removes its socket.
//
// Knobs from outside the process, on the loopback control endpoint (`control`): POST /<op> with a JSON body,
// answered with JSON ({error} and status 400 when it fails):
//   /nextTurn        {profile, script}                  script the next turn (engine.ts TurnScript)
//   /outsideTurn     {profile, session_id, text}        another canonical client's turn (CLI) → AdmissionStatus
//   /conduitTurn     {profile, session_id, text, durationMs?}  a dashboard send → {forwarded}
//   /legacySession   {profile, title?, hidden?, turns?, held?} a dashboard (Conduit) chat → {session_id}
//   /hold            {profile, session_id, on}          the dashboard's claim on a legacy row
//   /answerElsewhere {profile, session_id, prompt_id, answer}
//   /modelOptionsDelay {ms}
//   /restart         {contract?, codeVersion?}          running turns → unknown; new port, instance, epoch
//   /session         {profile, session_id}              engine state of a chat (ids, fences, pending, prompts)
// SIGHUP restarts too. Prompt words script turns from bb's composer as well: #slow #tool #approval #edit
// #clarify #think #fail.
import { writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Session } from "./engine.js";
import { RECORDINGS_LATEST_FIRST, startFakeHermes, type FakeHermes } from "./index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const folder = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(profiles|rotating|second-ms)$/));
if (!folder) {
  console.error("usage: npm run fake-hermes -- <folder> [--profiles alex,bob] [--rotating bob] [--second-ms 1000] [--changed-contract]");
  process.exit(2);
}
const list = (v: string | undefined) => (v ? v.split(",").filter(Boolean) : undefined);
const fake = await startFakeHermes({
  folder,
  profiles: list(flag("profiles")),
  rotating: list(flag("rotating")),
  secondMs: flag("second-ms") ? Number(flag("second-ms")) : undefined,
  contract: args.includes("--changed-contract") ? "changed" : "vendored",
  rest: RECORDINGS_LATEST_FIRST,
});

/** A chat's engine state without its object graph. */
function state(s: Session) {
  return {
    session_id: s.id,
    lineage_root: fake.engine.rootOf(s).id,
    title: s.title,
    hidden: s.hidden,
    source: s.source,
    created_source: s.created_source,
    chat_id: s.chat_id,
    held: s.held,
    revision: s.revision,
    execution_generation: s.generation,
    running: s.running?.admission.admission_id ?? null,
    pending: s.queue.map((a) => fake.engine.admissionStatus(a)),
    prompts: [...s.prompts.values()].map((p) => p.prompt),
    rows: s.rows.length,
  };
}

type Body = Record<string, any>;
const ops: Record<string, (b: Body, f: FakeHermes) => unknown> = {
  nextTurn: (b, f) => f.nextTurn(b.profile, b.script ?? {}),
  outsideTurn: (b, f) => f.outsideTurn(b.profile, b.session_id, b.text),
  conduitTurn: (b, f) => f.conduitTurn(b.profile, b.session_id, b.text, { durationMs: b.durationMs, reply: b.reply }),
  legacySession: (b, f) => ({ session_id: f.legacySession(b.profile, { title: b.title, hidden: b.hidden, turns: b.turns, held: b.held }) }),
  hold: (b, f) => f.hold(b.profile, b.session_id, b.on !== false),
  answerElsewhere: (b, f) => ({ answered: f.answerElsewhere(b.profile, b.session_id, b.prompt_id, b.answer) }),
  modelOptionsDelay: (b, f) => void (f.modelOptionsDelayMs = Number(b.ms) || 0),
  restart: async (b, f) => {
    await f.restart({ contract: b.contract, codeVersion: b.codeVersion });
    return announce();
  },
  session: (b, f) => {
    const s = f.session(b.profile, b.session_id);
    if (!s) throw new Error("not_found");
    return state(s);
  },
};

const control = http.createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { ok: true }));
  };
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const op = ops[(req.url ?? "/").slice(1)];
  if (req.method !== "POST" || !op) return reply(404, { error: "unknown op" });
  try {
    reply(200, await op(raw ? JSON.parse(raw) : {}, fake));
  } catch (err) {
    reply(400, { error: (err as Error).message });
  }
});
await new Promise<void>((r) => control.listen(0, "127.0.0.1", () => r()));

function announce() {
  const info = { folder: fake.folder, instance_id: fake.instanceId, api_origin: fake.apiOrigin, control: `http://127.0.0.1:${(control.address() as { port: number }).port}` };
  writeFileSync(path.join(fake.folder, "fake-hermes.json"), JSON.stringify(info) + "\n");
  console.log(JSON.stringify(info));
  return info;
}
announce();

process.on("SIGHUP", () => void fake.restart().then(announce));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void fake.stop().then(() => control.close(() => process.exit(0))));
}
