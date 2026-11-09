#!/usr/bin/env node
// P2 e2e on the strict fake (T2.5 Step 2): every check prints PASS or FAIL with its decisive values.
// Needs, in this order: `bb-e2e.sh install <repo>`, `bb-e2e.sh fake /private/tmp/bb-hermes-test/e2e-fake` (fresh),
// `bb-e2e.sh start`, `bb-e2e.sh connect …`, and a headless Chrome for Testing in UTC on --remote-debugging-port=49222
// (pushes are counted by a `window.Notification` hook in an open bb page: bb's web channel).
//   node e2e/checks/p2-fake.mjs            (~10 min; restarts bb-app twice; leaves the fake and bb running)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const E2E = path.join(here, "..");
const RUN = "/private/tmp/bb-hermes-test/e2e-bb";
const TMP = "/private/tmp/bb-hermes-test/e2e-p2";
const FOLDER = "/private/tmp/bb-hermes-test/e2e-fake";
const DATA_DB = `${process.env.HOME}/.bb-hermes-e2e/plugins/hermes/data.db`;
const HOME_OF = { default: FOLDER, alex: `${FOLDER}/profiles/alex`, bob: `${FOLDER}/profiles/bob` };
mkdirSync(TMP, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20 });
const sbb = (...a) => sh(path.join(E2E, "sbb"), a);
const sbbj = (...a) => JSON.parse(sbb(...a, "--json"));
const db = (sql) => JSON.parse(sh("sqlite3", ["-readonly", "-json", DATA_DB, sql]) || "[]");
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
let n = 0;
function rpc(method, input) {
  const file = path.join(TMP, `rpc-${++n}.json`);
  writeFileSync(file, JSON.stringify(input ?? null));
  return JSON.parse(sbb("plugin", "rpc", "call", "hermes", method, ...(input === undefined ? [] : ["--input-file", file]), "--json"));
}
const control = () => JSON.parse(readFileSync(`${RUN}/fake.json`, "utf8")).control;
async function ctl(op, body = {}) {
  const res = await fetch(`${control()}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw new Error(`${op}: ${out.error}`);
  return out;
}
const chat = async (body) => (await ctl("outsideChat", body)).session_id;
async function until(what, fn, ms = 60_000, every = 500) {
  for (const end = Date.now() + ms; ; await sleep(every)) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
  }
}

// ---- results
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

// ---- bb state
const thread = (id) => sbbj("thread", "get", id).thread;
const isRead = (t) => t.latestAttentionAt == null || (t.lastReadAt ?? 0) >= t.latestAttentionAt;
const events = (id) => JSON.parse(sbb("thread", "log", id, "--json", "--all"));
const sends = (id) => events(id).filter((e) => e.type === "client/turn/requested").map((e) => e.data.input.map((i) => i.text ?? "").join(" | "));
const replies = (id) => events(id).filter((e) => e.type === "item/completed" && e.data.item.type === "agentMessage").map((e) => e.data.item.text);
const hermesThreads = () => sbbj("thread", "list", "--include-archived", "--include-hidden").filter((t) => t.providerId === "hermes");
const bindings = (profile) => db(`SELECT * FROM bindings WHERE profile_home = ${q(HOME_OF[profile])}`);
const bindingOf = (root) => db(`SELECT * FROM bindings WHERE lineage_root = ${q(root)}`)[0];
const bots = () => Object.fromEntries(rpc("bots").bots.map((b) => [b.profile, b]));
const setBot = (profile, on) => rpc("setBot", { profile_home: HOME_OF[profile], on });
const diagnostics = () => rpc("diagnostics");
/** Errors the harness itself causes: the fake folder has no `hermes` CLI for refresh-prompts. */
const HARNESS = /^(hermes_not_found|set_bot_access_incomplete)$/;
const productErrors = () => diagnostics().errors.filter((e) => !HARNESS.test(e));
/** The plugin's error codes in bb's server log since `since` (ms), harness ones left out: unlike diagnostics' bounded list, a window. */
function logErrors(since) {
  const lines = readFileSync(`${process.env.HOME}/.bb-hermes-e2e/logs/server.1.log`, "utf8").split("\n");
  const out = [];
  for (const line of lines) {
    if (!line.includes("[plugin:hermes] error ")) continue;
    try {
      const l = JSON.parse(line);
      const code = l.msg.slice("[plugin:hermes] error ".length);
      if (l.time >= since && !HARNESS.test(code)) out.push(code);
    } catch {}
  }
  return out;
}
const allLive = (profile, count) => {
  const b = bindings(profile);
  return b.length >= count && b.every((x) => x.state === "live") ? b : null;
};

// ---- pushes: bb's web channel into an open page, through a Notification hook (CDP)
async function cdp(expression) {
  const pages = await (await fetch("http://127.0.0.1:49222/json/list")).json();
  const page = pages.find((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:48886"));
  if (!page) throw new Error("no bb page in Chrome");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const out = await new Promise((resolve) => {
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if (f.id === 1) resolve(f.result?.result?.value);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  ws.close();
  return out;
}
async function openPage() {
  const pages = await (await fetch("http://127.0.0.1:49222/json/list")).json();
  if (!pages.some((p) => p.type === "page" && p.url.startsWith("http://127.0.0.1:48886"))) await fetch("http://127.0.0.1:49222/json/new?http://127.0.0.1:48886/", { method: "PUT" });
  await sleep(4000);
  await cdp(`window.__notes = window.__notes ?? []; window.Notification = class { static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } constructor(t, o) { window.__notes.push({ t, body: o?.body ?? "", at: Date.now() }); } close() {} addEventListener() {} }; true`);
}
const pushes = async (since = 0) => JSON.parse((await cdp("JSON.stringify(window.__notes ?? [])")) ?? "[]").filter((p) => p.at >= since);

// ---- bb-app restart (the fake keeps running)
async function restartBb(note) {
  const pid = Number(readFileSync(`${RUN}/bb-app.pid`, "utf8"));
  process.kill(pid, "SIGINT");
  await until(`bb-app ${pid} exits`, () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  sh("rm", ["-f", `${RUN}/bb-app.pid`]);
  console.log(`      (${note}: bb-app stopped, starting again)`);
  sh(path.join(E2E, "bb-e2e.sh"), ["start"]);
  await until("plugin connected to the fake", () => {
    try {
      return diagnostics().instance_id === JSON.parse(readFileSync(`${RUN}/fake.json`, "utf8")).instance_id;
    } catch {
      return false;
    }
  }, 180_000, 2000);
}

// =====================================================================================================
const t0 = Date.now();
check("fake connected (instance_id)", diagnostics().instance_id === JSON.parse(readFileSync(`${RUN}/fake.json`, "utf8")).instance_id);

// ---- 0. a clean isolated bb: every bot off, no Hermes thread
for (const p of ["default", "alex", "bob"]) setBot(p, false);
await sleep(2000);
for (const t of hermesThreads()) sbb("thread", "delete", t.id, "--yes");
await until("no bindings", () => db("SELECT count(*) AS n FROM bindings")[0].n === 0);

// ---- setup
const ids = {};
ids.cli = await chat({ profile: "alex", kind: "cli", turns: ["cli one", "cli two"] });
ids.tui = await chat({ profile: "alex", kind: "tui", turns: ["tui one"] });
ids.desktop = await chat({ profile: "alex", kind: "desktop", title: "Planning", turns: ["desk one"] });
ids.archived = await chat({ profile: "alex", kind: "cli", archived: true, turns: ["archived one"] });
ids.d20 = await chat({ profile: "alex", kind: "cli", daysAgo: 20, turns: ["twenty days ago"] });
ids.long25 = await chat({ profile: "alex", kind: "cli", turns: Array.from({ length: 25 }, (_, i) => `twenty-five turn ${i + 1}`) });
ids.conduit = (await ctl("legacySession", { profile: "alex", turns: ["conduit one", "conduit two"] })).session_id;
const out = {};
for (const kind of ["cron", "oneshot", "acp", "discord", "hidden", "empty", "bb"]) out[kind] = await chat({ profile: "alex", kind });
out.d40 = await chat({ profile: "alex", kind: "cli", daysAgo: 40, turns: ["forty days ago"] });
ids.alexBot = await chat({ profile: "alex", kind: "cli", title: "Bot Chat", turns: ["a visible chat titled Bot Chat"] });
const many = (label, k) => Array.from({ length: k }, (_, i) => `${label} ${i + 1}`);
ids.bobBot = await chat({ profile: "bob", kind: "desktop", title: "Bot Chat", hidden: true, turns: many("bob bot chat turn", 30) });
ids.bobSlow = await chat({ profile: "bob", kind: "cli", turns: many("bob slow turn", 10) });
ids.defBot = await chat({ profile: "default", kind: "desktop", title: "Bot Chat", hidden: true, turns: many("default bot chat turn", 45) });
const expectedAlex = [ids.cli, ids.tui, ids.desktop, ids.archived, ids.d20, ids.conduit, ids.long25];

const counts = await until("switch rows count (60 s cache)", () => {
  const b = bots();
  return b.alex.import_count === 7 && b.bob.import_count === 1 ? b : null;
}, 90_000, 3000).catch(() => bots());
check("switch rows: Imports 7 (alex), 1 (bob), 0 (default)", counts.alex.import_count === 7 && counts.bob.import_count === 1 && counts.default.import_count === 0, `alex ${counts.alex.import_count}, bob ${counts.bob.import_count}, default ${counts.default.import_count}`);

await openPage();
const pushStart = Date.now();
const reqStart = (await ctl("requests")).next;

// ---- 1. import at switch-on (alex)
setBot("alex", true);
await until("alex imported", () => allLive("alex", 8), 120_000);
const ab = bindings("alex");
const mirrors = ab.filter((b) => b.kind === "mirror");
check("1 imported threads == switch row == 7", mirrors.length === 7, `${mirrors.length}`);
check("1 imported chats are exactly the eligible ones", JSON.stringify(mirrors.map((b) => b.lineage_root).sort()) === JSON.stringify([...expectedAlex].sort()));
const botA = ab.find((b) => b.kind === "bot");
check("2 the chat titled Bot Chat is bound only to the bot thread", botA?.lineage_root === ids.alexBot && !mirrors.some((b) => b.lineage_root === ids.alexBot));
check("2 out: no thread for cron, oneshot, acp, chat app, hidden, empty, bb-created, 40 days old", !Object.values(out).some((id) => bindingOf(id)));
await sleep(3000);
for (const b of ab) {
  const t = thread(b.thread_id);
  const first = sends(b.thread_id).find((s) => s.includes("[Outside bb"));
  check(`1 ${b.kind} ${t.title}: read, ${b.lineage_root === ids.archived ? "archived" : "not archived"}, ${b.kind === "bot" ? "pinned" : "not pinned"}`, isRead(t) && (t.archivedAt !== null) === (b.lineage_root === ids.archived) && (t.pinnedAt !== null) === (b.kind === "bot"), `lastReadAt − latestAttentionAt = ${(t.lastReadAt ?? 0) - (t.latestAttentionAt ?? 0)} ms; first send "${first?.slice(0, 40)}"`);
}
check("1 titles: Hermes' title, else the first message", thread(bindingOf(ids.desktop).thread_id).title === "Planning" && thread(bindingOf(ids.cli).thread_id).title === "cli one");
check("1 imported bubbles tagged with the date", sends(bindingOf(ids.d20).thread_id).some((s) => /^\[Outside bb · [A-Z][a-z]{2} \d{1,2}\] twenty days ago/.test(s)));
const reqs = (await ctl("requests", { from: reqStart })).calls.map((c) => c.method);
const writes = reqs.filter((m) => !["profiles.list", "model.options", "session.list", "runtime.describe"].includes(m));
check("1 0 Hermes writes during the import (canonical calls)", writes.length === 0, `${[...new Set(reqs)].join(", ")}`);
check("1 0 pushes during the import", (await pushes(pushStart)).length === 0, JSON.stringify(await pushes(pushStart)));
check("1 no plugin errors during the import (server log)", logErrors(pushStart).length === 0, JSON.stringify(logErrors(pushStart)));
setBot("alex", false);
await sleep(3000);
setBot("alex", true);
await sleep(15_000);
check("1 a re-run (off, on) imports 0 new", bindings("alex").length === 8 && hermesThreads().filter((t) => bindings("alex").some((b) => b.thread_id === t.id)).length === 8);
// A 25-turn import, then a later outside turn: no imported reply shows twice (> 20 records).
const l25 = bindingOf(ids.long25).thread_id;
await ctl("outsideTurn", { profile: "alex", session_id: ids.long25, text: "after the 25-turn import" });
await until("turn after the 25-turn import", () => sends(l25).some((x) => x.startsWith("[Outside bb] after the 25-turn import")), 30_000);
await sleep(8000);
const r25 = replies(l25).filter((r) => /twenty-five turn \d+$/.test(r));
check("a 25-turn mirrored import: a later turn re-renders no imported reply", r25.length === 25 && new Set(r25).size === 25, `${r25.length} replies, ${new Set(r25).size} distinct`);

// ---- turns during an import, and a user send queued behind it (bob, a slow import)
await ctl("restDelay", { ms: 1500 });
const bobPushStart = Date.now();
setBot("bob", true);
const slowB = await until("bob's chat importing", () => db(`SELECT * FROM bindings WHERE lineage_root = ${q(ids.bobSlow)} AND state = 'replaying'`)[0], 60_000, 200);
const bobBotB = await until("bob's bot thread", () => bindings("bob").find((b) => b.kind === "bot"), 60_000, 200);
await ctl("outsideTurn", { profile: "bob", session_id: ids.bobSlow, text: "arrived during the chat's import" });
await ctl("outsideTurn", { profile: "bob", session_id: ids.bobBot, text: "arrived during the bot thread's import" });
sbb("thread", "tell", bobBotB.thread_id, "a user send during the import");
await sleep(3000);
await ctl("restDelay", { ms: 0 });
await until("bob imported", () => allLive("bob", 2), 180_000);
await until("bob's threads idle", () => [bobBotB.thread_id, slowB.thread_id].every((id) => thread(id).status === "idle"), 120_000, 1000);
await sleep(5000);
const slowSends = sends(slowB.thread_id);
const slowT = thread(slowB.thread_id);
check("turn during a chat's import wakes after it as [Outside bb], unread", slowSends.at(-1)?.startsWith("[Outside bb] arrived during the chat's import") && slowSends.filter((s) => s.includes("arrived during")).length === 1 && !isRead(slowT), `last send "${slowSends.at(-1)?.slice(0, 50)}", read ${isRead(slowT)}`);
const botSends = sends(bobBotB.thread_id);
check("bob bot thread: 30 imported turns once each", new Set(botSends.filter((s) => /bob bot chat turn \d+/.test(s))).size === 30 && botSends.filter((s) => /bob bot chat turn \d+/.test(s)).length === 30);
check("turn during the bot thread's import wakes after it as [Outside bb]", botSends.filter((s) => s.startsWith("[Outside bb] arrived during the bot thread's import")).length === 1, botSends.slice(-3).map((s) => s.slice(0, 45)).join(" / "));
check("the user send queued behind the import ran once and got its reply", botSends.filter((s) => s === "a user send during the import").length === 1 && replies(bobBotB.thread_id).some((r) => r.includes("a user send during the import")));
const lvl = sbbj("push-notifications", "thread", bobBotB.thread_id);
const bobPushes = (await pushes(bobPushStart)).map((p) => p.t);
check("the user send is not muted: the bot thread's level is back to its own after the import", lvl.effective !== "muted", `${JSON.stringify(lvl)}; pushes since bob's switch-on: ${JSON.stringify(bobPushes)}`);
// Baseline: a send from the CLI into an idle thread pushes its reply (bb's rule for an unread reply).
const basePush = Date.now();
sbb("thread", "tell", bobBotB.thread_id, "baseline user send");
await until("baseline reply", () => replies(bobBotB.thread_id).some((r) => r.includes("baseline user send")), 30_000);
await sleep(8000);
const dup = replies(bobBotB.thread_id).filter((r) => /bob bot chat turn \d+$/.test(r));
check("imported turns aren't re-rendered by a later wake (> 20 turns)", dup.length === new Set(dup).size, `${dup.length} replies, ${new Set(dup).size} distinct`);
check("baseline: a user send's reply pushes once", (await pushes(basePush)).length === 1, JSON.stringify((await pushes(basePush)).map((p) => p.body)));

// ---- bb restart mid-import of a bot thread (default: 40 turns)
await ctl("restDelay", { ms: 2500 });
const defPushStart = Date.now();
setBot("default", true);
const queuedOf = (id) => db(`SELECT count(*) AS n FROM turns WHERE thread_id = ${q(id)} AND state = 'queued'`)[0].n;
const defBot = await until("default bot thread mid-import", () => bindings("default").find((b) => b.kind === "bot" && queuedOf(b.thread_id) > 0), 90_000, 100);
await sleep(1500);
const before = sends(defBot.thread_id).length;
// A slow REST past the restart would time the worker's host calls out (its 30 s deadline): normal speed again.
await ctl("restDelay", { ms: 0 });
const restartAt = Date.now();
await restartBb("bot thread mid-import");
await sleep(10_000);
check("no plugin errors after a bb restart (server log, shutdown included)", logErrors(restartAt).length === 0, JSON.stringify(logErrors(restartAt)));
const defLive = await until("default bot thread imported", () => bindings("default").find((b) => b.kind === "bot" && b.state === "live" && sends(b.thread_id).filter((x) => /default bot chat turn \d+/.test(x)).length >= 45), 300_000, 3000);
await until("default bot thread idle", () => thread(defLive.thread_id).status === "idle", 120_000, 1000);
await sleep(5000);
const defSends = sends(defLive.thread_id).filter((s) => /default bot chat turn \d+/.test(s));
const defT = thread(defLive.thread_id);
check("bb restart mid-import of a bot thread: same thread, 45 turns once each", defLive.thread_id === defBot.thread_id && defSends.length === 45 && new Set(defSends).size === 45, `${before} sends before the restart, ${defSends.length} turn sends after`);
check("… ends read, 0 pushes", isRead(defT) && (await pushes(defPushStart)).length === 0, `lastReadAt − latestAttentionAt = ${(defT.lastReadAt ?? 0) - (defT.latestAttentionAt ?? 0)} ms; pushes ${JSON.stringify(await pushes(defPushStart))}`);

// A 45-turn Bot Chat import, then one user send: no reply twice, and the send's reply pushes once.
const defUser = Date.now();
sbb("thread", "tell", defLive.thread_id, "a user send after the 45-turn import");
await until("user send reply (45)", () => replies(defLive.thread_id).some((r) => r.includes("a user send after the 45-turn import")), 30_000);
await sleep(10_000);
const r45 = replies(defLive.thread_id).filter((r) => /default bot chat turn \d+$/.test(r));
check("45-turn Bot Chat: a user send re-renders no imported reply", r45.length === 45 && new Set(r45).size === 45, `${r45.length} replies, ${new Set(r45).size} distinct`);
check("45-turn Bot Chat: the user send's reply pushes once", (await pushes(defUser)).length === 1, JSON.stringify((await pushes(defUser)).map((p) => p.body)));

// ---- 5. D48: off, turns and a new chat while off, on
const alexBefore = bindings("alex").map((b) => b.thread_id).sort();
setBot("alex", false);
await sleep(3000);
check("5 off archives every alex thread", bindings("alex").every((b) => thread(b.thread_id).archivedAt !== null));
await ctl("outsideTurn", { profile: "alex", session_id: ids.cli, text: "cli three while off" });
ids.whileOff = await chat({ profile: "alex", kind: "tui", turns: ["started while off"] });
await sleep(2000);
setBot("alex", true);
await until("alex back", () => allLive("alex", alexBefore.length + 1), 120_000);
await sleep(8000);
const alexAfter = bindings("alex");
check("5 the same threads back, no duplicates, the new chat imported", alexBefore.every((id) => alexAfter.some((b) => b.thread_id === id)) && alexAfter.length === alexBefore.length + 1 && diagnostics().bindings.duplicates === 0);
check("5 the Hermes-archived chat stays archived; the others unarchived", alexAfter.every((b) => (thread(b.thread_id).archivedAt !== null) === (b.lineage_root === ids.archived)));
check("5 the turn made while off shows", sends(bindingOf(ids.cli).thread_id).some((s) => s.startsWith("[Outside bb] cli three while off")));
const woT = thread(bindingOf(ids.whileOff).thread_id);
check("5 the chat started while off ends read (finding 1)", isRead(woT), `lastReadAt − latestAttentionAt = ${(woT.lastReadAt ?? 0) - (woT.latestAttentionAt ?? 0)} ms`);

// ---- 3. discovery, replies from bb, Conduit adoption
const discPush = Date.now();
const tNew = Date.now();
ids.newCli = await chat({ profile: "alex", kind: "cli", turns: ["a new cli chat while on"] });
const nb = await until("new chat bound", () => bindingOf(ids.newCli), 30_000, 100);
const tBound = Date.now();
await until("new chat live", () => bindingOf(ids.newCli)?.state === "live", 30_000, 100);
const tLive = Date.now();
await sleep(3000);
check("3 a new chat becomes a thread, unread, no push", !isRead(thread(nb.thread_id)) && (await pushes(discPush)).length === 0, `bound ${tBound - tNew} ms, live ${tLive - tNew} ms`);
let r0 = (await ctl("requests")).next;
sbb("thread", "tell", nb.thread_id, "reply from bb into the cli chat");
await until("bb reply", () => replies(nb.thread_id).some((r) => r.includes("reply from bb")), 30_000);
const calls = (await ctl("requests", { from: r0 })).calls.map((c) => c.method);
const st = await ctl("session", { profile: "alex", session_id: ids.newCli });
check("3 a reply from bb continues the same Hermes session", !calls.includes("session.create") && calls.includes("prompt.submit") && st.rows === 4, calls.join(" "));
const kT = bindingOf(ids.conduit).thread_id;
sbb("thread", "tell", kT, "reply from bb into the conduit chat");
await until("conduit reply", () => replies(kT).some((r) => r.includes("reply from bb into the conduit")), 30_000);
const kS = await ctl("session", { profile: "alex", session_id: ids.conduit });
await sleep(3000);
check("3 a legacy Conduit chat is adopted in place on bb's reply", kS.chat_id === ids.conduit && kS.session_id === ids.conduit && db(`SELECT count(*) AS n FROM bindings WHERE lineage_root = ${q(ids.conduit)}`)[0].n === 1);
check("3 bindings.legacy cleared after the adoption (finding 3)", bindingOf(ids.conduit).legacy === 0, `legacy ${bindingOf(ids.conduit).legacy}`);
await ctl("conduitTurn", { profile: "alex", session_id: ids.conduit, text: "conduit after adoption" });
await until("conduit turn mirrored", () => sends(kT).some((s) => s.startsWith("[Outside bb] conduit after adoption")), 30_000);
check("3 a later Conduit turn mirrors into the same thread", true);

// ---- 4. title follow
const tuiT = bindingOf(ids.tui).thread_id;
await ctl("title", { profile: "alex", session_id: ids.tui, title: "Hermes title one" });
const tTitle = Date.now();
await until("title follows", () => thread(tuiT).title === "Hermes title one", 30_000);
check("4 a Hermes title change follows", true, `${Date.now() - tTitle} ms`);
sbb("thread", "update", tuiT, "--title", "My bb name");
await ctl("title", { profile: "alex", session_id: ids.tui, title: "Hermes title two" });
await sleep(10_000);
check("4 after a bb rename it no longer follows", thread(tuiT).title === "My bb name");

// ---- 6. dispatch hook (D15)
const refused = (text) => {
  try {
    sbb("thread", "tell", bindingOf(ids.cli).thread_id, text);
    return false;
  } catch (e) {
    return /Remove the \[Outside bb\] tag to send\./.test(String(e.stderr ?? e.message));
  }
};
check("6 '[Outside bb] hi' is refused", refused("[Outside bb] hi"));
check("6 a recalled imported line is refused", refused("[Outside bb · Nov 9] cli one"));

// ---- 8. mirror rules
const d20T = bindingOf(ids.d20).thread_id;
await ctl("nextTurn", { profile: "alex", script: { chunkMs: 400, reply: "a slow outside reply one two three four five six seven eight nine ten" } });
await ctl("outsideTurn", { profile: "alex", session_id: ids.d20, text: "slow outside turn" });
for (let i = 1; i <= 3; i++) {
  await sleep(1500);
  await ctl("title", { profile: "alex", session_id: ids.d20, title: `relist ${i}` });
}
await sleep(12_000);
check("8 3 re-lists during one outside turn → 1 bubble", sends(d20T).filter((s) => s.includes("slow outside turn")).length === 1);
const c1 = sends(d20T).length;
await ctl("compress", { profile: "alex", session_id: ids.d20 });
await ctl("title", { profile: "alex", session_id: ids.d20, title: "after compress" });
await sleep(10_000);
check("8 a compaction adds no repeated turn", sends(d20T).length === c1);
await ctl("retry", { profile: "alex", session_id: ids.d20 });
await sleep(10_000);
const after = sends(d20T);
check("8 a /retry adds exactly one turn: the message again and its new reply", after.length === c1 + 1 && after.at(-1).startsWith("[Outside bb] slow outside turn"));

// ---- A49: an archived thread
const deskT = bindingOf(ids.desktop).thread_id;
sbb("thread", "archive", deskT);
const errs = productErrors().length;
const s0 = sends(deskT).length;
await ctl("outsideTurn", { profile: "alex", session_id: ids.desktop, text: "while archived" });
await sleep(10_000);
check("A49 a wake into an archived thread is refused silently; it stays archived", sends(deskT).length === s0 && thread(deskT).archivedAt !== null && productErrors().length === errs);
sbb("thread", "unarchive", deskT);
const tU = Date.now();
await until("missed turn after unarchive", () => sends(deskT).length > s0, 30_000);
check("A49 unarchive mirrors the missed turn at once", true, `${Date.now() - tU} ms`);

// ---- a chat deleted in Hermes: its thread stays; reconnects log no error for it
const deletedAt = Date.now();
await ctl("delete", { profile: "alex", session_id: ids.tui });
await sleep(8000);
check("a chat deleted in Hermes: its thread stays", hermesThreads().some((t) => t.id === tuiT));
sbb("thread", "tell", tuiT, "a send after the delete");
const deletedErr = await until("send fails", () => events(tuiT).find((e) => e.type === "provider/error" && e.createdAt >= deletedAt), 30_000).catch(() => null);
check("… a send to it fails 'Deleted in Hermes'", /Deleted in Hermes/.test(deletedErr?.data?.message ?? ""), deletedErr?.data?.message ?? "no provider/error");

// ---- 7. A38: bb stopped mid-import
await ctl("restDelay", { ms: 6000 });
ids.long = await chat({ profile: "alex", kind: "cli", turns: many("long chat turn", 40) });
const hidden = await until("long chat importing", () => db(`SELECT * FROM bindings WHERE lineage_root = ${q(ids.long)} AND state = 'replaying'`)[0], 90_000, 300);
await sleep(3000);
check("7 (setup) the import thread is hidden, mid-import", thread(hidden.thread_id).visibility === "hidden", `${sends(hidden.thread_id).length} sends`);
await ctl("restDelay", { ms: 0 });
await restartBb("A38");
const redone = await until("long chat imported again", () => db(`SELECT * FROM bindings WHERE lineage_root = ${q(ids.long)} AND state = 'live'`)[0], 300_000, 2000);
await sleep(5000);
const longSends = sends(redone.thread_id).filter((s) => /long chat turn \d+/.test(s));
const goneOld = !hermesThreads().some((t) => t.id === hidden.thread_id);
check("7 after restart: the hidden thread deleted, the chat imported again once", goneOld && redone.thread_id !== hidden.thread_id && longSends.length === 40 && new Set(longSends).size === 40 && db(`SELECT count(*) AS n FROM bindings WHERE lineage_root = ${q(ids.long)}`)[0].n === 1);
const d = diagnostics();
check("7 duplicates 0; no plugin errors since a chat was deleted in Hermes, A38's restart and redo included", d.bindings.duplicates === 0 && logErrors(deletedAt).length === 0, `errors ${JSON.stringify(logErrors(deletedAt))}`);
check("7 no HTTP 409 in bb's server log since the run started", !readFileSync(`${process.env.HOME}/.bb-hermes-e2e/logs/server.1.log`, "utf8").split("\n").some((l) => { try { const j = JSON.parse(l); return j.time >= t0 && /\b409\b/.test(l); } catch { return false; } }));

// ---- 9. no marker shown; a side chat too
const side = rpc("newChat", { profile: "alex" }).thread_id;
await sleep(6000);
sbb("thread", "tell", side, "side chat hello");
await until("side chat reply", () => replies(side).length > 0, 30_000);
await sleep(2000);
const fallbacks = hermesThreads().map((t) => t.titleFallback ?? null);
check("9 every Hermes thread's titleFallback is null or marker-free", fallbacks.every((f) => f === null || !/<hermes-bb>/.test(f)), `${fallbacks.length} threads, ${JSON.stringify([...new Set(fallbacks)])}`);

// ---- a big catalog (bridge sqsvkmqs)
await ctl("models", { count: 120 });
const cat = rpc("newChat", { profile: "bob" }).thread_id;
const catalog = await until("catalog", () => events(cat).filter((e) => e.type === "thread/extensionState/updated" && e.data.kind === "bb/provider-model-catalog").at(-1), 30_000);
check("a 120-model catalog fits bb's 64 KiB state and reaches the thread", catalog.data.payload.models.length === 120 && JSON.stringify(catalog.data.payload).length < 65536 && !events(cat).some((e) => /unhandled/.test(e.type)), `${JSON.stringify(catalog.data.payload).length} bytes`);
await ctl("models", { count: 1 });

// ---- 11. end
const end = diagnostics();
check("11 diagnostics at the end: connected, supported, duplicates 0, no product errors", end.health.state === "connected" && end.health.supported === true && end.bindings.duplicates === 0 && productErrors().length === 0, `${JSON.stringify(end.bindings)} ${JSON.stringify(end.errors)}`);
check("11 no plugin errors in the server log over the whole run", logErrors(pushStart).length === 0, JSON.stringify(logErrors(pushStart)));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)} s`);
writeFileSync(path.join(TMP, "p2-fake-ids.json"), JSON.stringify({ ids, out }, null, 1));
process.exit(failed.length ? 1 : 0);
