// T1.13 two-client harness (03 §Two-client harness, S8 §Experiments): an isolated Hermes, a legacy dashboard
// client (Conduit) and our bridge in-process (createBridge + the SDK JSON-RPC harness), a stub model that logs
// what each call saw. Runs on the real Hermes, so not in `npm test`:
//   npx vitest run --config e2e/vitest.config.ts
// Mirror wakes stand in for the server: after an outside turn, the test sends the wake the server would.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import {
  type BridgeJsonRpcTestHarness,
  experimental_assembleCapturedThreadEvents as assemble,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bridge, createBridge } from "../src/bridge/bridge.js";
import { PROVIDER_ID } from "../src/bridge/provider.js";
import { readMessages } from "../src/hermes/history.js";
import { botLabel } from "../src/shared/bots.js";
import { WORKER_FILE, type WorkerFile } from "../src/shared/bridge-files.js";
import { encodeMarker, type Marker } from "../src/shared/marker.js";
import type { ProviderOptions, ThreadView } from "../src/shared/provider-options.js";
import { BOT_CHAT_TITLE } from "../src/shared/sources.js";
import { setBotAccess } from "../src/worker/access.js";
import { type Canonical, type Dashboard, type IsolatedHermes, livePid, sleep, startIsolatedHermes } from "./isolated-hermes.js";

const H = "/private/tmp/bb-hermes-test/e2e-two";
const DATA = "/private/tmp/bb-hermes-test/e2e-two-data";
const PROFILES = ["alex", "bob", "carol"];
const AUTO = { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" } as const;

let h: IsolatedHermes;
let bridge: Bridge;
let rpc: BridgeJsonRpcTestHarness;
let check: Canonical;
let liveBefore: string;
/** Every request the bridge sent to Hermes. */
const sent: { method: string; params: Record<string, unknown> }[] = [];
/** Every session.mutate result the bridge got. */
const mutations: Record<string, unknown>[] = [];
let nextId = 1;
let nextReq = 0;
/** bb's client request id shape: `creq_` + 10 of bb's alphabet. */
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const creq = () => {
  let n = nextReq++;
  let out = "";
  for (let i = 0; i < 10; i++, n = Math.floor(n / 32)) out = ALPHABET[n % 32] + out;
  return `creq_${out}`;
};

beforeAll(async () => {
  liveBefore = livePid();
  h = await startIsolatedHermes({ home: H, profiles: PROFILES, extraConfig: { carol: "compression:\n  in_place: false\n" } });
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const enabled = PROFILES.map((p) => ({ profile: p, profile_home: h.profileHome(p), bot_label: botLabel(p), cwd: null }));
  writeFileSync(path.join(DATA, WORKER_FILE), JSON.stringify({ root: H, worker_boot_id: "boot-e2e", written_at: Date.now(), enabled } satisfies WorkerFile));
  bridge = createBridge("e2e-build", {
    holdRetryMs: [1000, 2000, 3000],
    connection: {
      backoffMs: [200, 500, 1000],
      onFrame: (dir, raw) => {
        const f = JSON.parse(raw) as { id?: number; method: string; params: Record<string, unknown>; result?: Record<string, unknown> };
        if (dir === "out") sent.push({ method: f.method, params: f.params });
        else if (f.result && "operation" in f.result) mutations.push(f.result);
      },
    },
  });
  bridge.start(DATA, "hermes");
  rpc = createHarness(bridge.handleLine);
  check = await h.canonical("check");
}, 180_000);

afterAll(async () => {
  if (process.env.E2E_DEBUG) {
    console.log("bridge → Hermes:", sent.map((s) => s.method).join(" "));
    console.log("bridge → bb:", JSON.stringify(rpc.messages.slice(-30)).slice(0, 6000));
  }
  check?.c.close();
  rpc?.restore();
  bridge?.close();
  await h?.stop();
  rmSync(DATA, { recursive: true, force: true });
  // Live locks and pids unchanged (h.stop() throws on a changed pid too).
  expect(livePid()).toBe(liveBefore);
}, 60_000);

// ---- bb side: threads, turns, what bb shows
const options = (profile: string, view: Partial<ThreadView>): { providerOptions: ProviderOptions } => ({
  providerOptions: {
    folder: H,
    machine: { id: "host-e2e", name: "hermes-mac" },
    thread: { kind: "chat", profile, profile_home: h.profileHome(profile), bot_label: botLabel(profile), enabled: true, lineage_root: null, session_id: null, legacy: false, tag: null, cwd: null, ...view },
  },
});
const bot = (profile: string) => options(profile, { kind: "bot" });
const text = (t: string): PromptInput => ({ type: "text", mentions: [], text: t });
const wake = (marker: Marker, label: string | null): PromptInput[] => [...(label ? [text(label)] : []), encodeMarker(marker)];
const call = async (method: string, params: object) => {
  const id = nextId++;
  rpc.sendRequest(id, method, params as never);
  return rpc.waitForResponse(id) as Promise<{ result?: unknown; error?: { message: string } }>;
};
type Ev = Record<string, unknown> & { type: string };
const events = (threadId: string) =>
  assemble(rpc.messages.filter((m) => m.method === "thread/delta" && (m.params as { threadId: string }).threadId === threadId), PROVIDER_ID) as unknown as Ev[];
const agentTexts = (threadId: string) =>
  events(threadId)
    .filter((e) => e.type === "item/completed" && (e.item as { type: string }).type === "agentMessage")
    .map((e) => (e.item as { text: string }).text);
const statuses = (threadId: string) => events(threadId).filter((e) => e.type === "turn/completed").map((e) => e.status as string);
const banners = (threadId: string) =>
  rpc.messages
    .filter((m) => m.method === "thread/delta" && (m.params as { threadId: string }).threadId === threadId)
    .flatMap((m) => (m.params as { deltas: { kind: string; extensionKind?: string; payload?: { banner: { kind: string } | null } }[] }).deltas)
    .filter((d) => d.kind === "extension.state" && d.extensionKind === "hermes/status")
    .map((d) => d.payload?.banner?.kind ?? null);
async function waitFor<T>(what: string, pred: () => T | undefined | null | false, ms = 90_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
  }
}
const startThread = (threadId: string, opts: object) => call("thread/start", { threadId, cwd: "/work", options: { ...AUTO, ...opts }, instructionMode: "append" });
/** Start a bb turn; resolves at once (the turn may wait). */
const begin = (threadId: string, input: PromptInput[], opts: object) =>
  call("turn/start", { threadId, providerThreadId: `pending:${threadId}`, input, clientRequestId: creq(), options: { ...AUTO, ...opts } });
/** A bb turn to its end. */
async function turn(threadId: string, input: PromptInput[], opts: object, ms = 90_000) {
  const before = statuses(threadId).length;
  await begin(threadId, input, opts);
  await waitFor(`${threadId} turn`, () => statuses(threadId).length > before, ms);
  return statuses(threadId).at(-1);
}

// ---- Hermes side
const botChats = async (profile: string) => (await check.c.sessionList({ profile, title: BOT_CHAT_TITLE, include_hidden: true })).sessions;
const userRows = async (profile: string, id: string) => (await readMessages(H, profile, id, { order: "oldest", limit: 500 })).messages.filter((m) => m.role === "user");
const lastCall = (ask: string) => [...h.calls].reverse().find((c) => c.user_texts.at(-1)?.split("\n")[0] === ask);
/** A Conduit send that must work: after every bb action (S8 verdict). */
async function conduitSends(d: Dashboard, profile: string, live: string, ask: string) {
  const answer = await d.send(profile, live, ask);
  expect(answer.error, `Conduit refused: ${JSON.stringify(answer.error)}`).toBeUndefined();
}
const bridgeCalls = (method: string, sessionId?: string) => sent.filter((s) => s.method === method && (!sessionId || s.params.session_id === sessionId));

describe("two clients on one Hermes conversation (S8)", () => {
  let conduit: Dashboard;
  let alexBot: string;
  let alexLive: string;

  it("E1: bb's first send creates the one Bot Chat lazily; later sends and Conduit's title lookup find the same one", async () => {
    await startThread("thr_alex", bot("alex"));
    expect(bridgeCalls("session.list")).toHaveLength(0); // never at setup
    expect(await turn("thr_alex", [text("hello from bb")], bot("alex"))).toBe("completed");
    expect(await turn("thr_alex", [text("bb again")], bot("alex"))).toBe("completed");
    const chats = await botChats("alex");
    expect(chats).toHaveLength(1);
    alexBot = chats[0]!.session_id;
    expect(bridgeCalls("session.create").filter((s) => s.params.title === BOT_CHAT_TITLE)).toHaveLength(1);
    conduit = await h.dashboard();
    expect(await conduit.findByTitle("alex", BOT_CHAT_TITLE)).toBe(alexBot);
    alexLive = await conduit.open("alex", alexBot);
    await conduitSends(conduit, "alex", alexLive, "conduit after bb created it");
    expect((await botChats("alex")).map((s) => s.session_id)).toEqual([alexBot]);
  });

  it("E2: Conduit A1 → bb B1 → Conduit A2 → bb B2: one transcript in order; each call saw every earlier turn; bb shows all four", async () => {
    await startThread("thr_e2", options("alex", { kind: "bot", lineage_root: alexBot, session_id: alexBot, tag: "Conduit" }));
    const v = options("alex", { kind: "bot", lineage_root: alexBot, session_id: alexBot, tag: "Conduit" });
    for (const [who, ask] of [["conduit", "A1"], ["bb", "B1"], ["conduit", "A2"], ["bb", "B2"]] as const) {
      if (who === "conduit") {
        await conduitSends(conduit, "alex", alexLive, ask);
        const anchor = (await userRows("alex", alexBot)).at(-1)!;
        expect(anchor.content).toBe(ask);
        expect(await turn("thr_e2", wake({ op: "mirror", anchor_uid: anchor.message_uid }, `[Conduit] ${ask}`), v)).toBe("completed");
      } else expect(await turn("thr_e2", [text(ask)], v)).toBe("completed");
    }
    const asks = (await userRows("alex", alexBot)).map((m) => String(m.content).split("\n")[0]);
    expect(asks.slice(-4)).toEqual(["A1", "B1", "A2", "B2"]);
    // Each model call saw every earlier ask, from both apps.
    for (const [i, ask] of ["A1", "B1", "A2", "B2"].entries()) {
      const seen = lastCall(ask)!.user_texts.map((t) => t.split("\n")[0]);
      expect(seen.slice(-(i + 1)), ask).toEqual(["A1", "B1", "A2", "B2"].slice(0, i + 1));
    }
    // bb shows the same replies, in the same order, as Hermes stored them.
    const replies = (await readMessages(H, "alex", alexBot, { order: "oldest", limit: 500 })).messages.filter((m) => m.role === "assistant").map((m) => m.content);
    expect(agentTexts("thr_e2")).toEqual(replies.slice(-4));
    expect(bridgeCalls("session.create").filter((s) => s.params.title === BOT_CHAT_TITLE)).toHaveLength(1);
  });

  it("E3a: bb sends during a Conduit turn: bb's turn waits (Hermes' waiting status), then runs with Conduit's reply in context", async () => {
    const v = bot("alex");
    const pending = conduit.send("alex", alexLive, "slow conduit while bb waits");
    await waitFor("conduit's row", () => conduit.events.some((e) => e.type === "message.start" && e.session_id === alexLive));
    await sleep(500);
    expect(await turn("thr_alex", [text("bb during conduit")], v)).toBe("completed");
    expect((await pending).error).toBeUndefined();
    const waits = events("thr_alex").filter((e) => e.type === "item/completed" && (e.item as { tool?: string }).tool === "hermes.wait");
    expect(waits.length).toBeGreaterThanOrEqual(1);
    const ctx = lastCall("bb during conduit")!;
    expect(ctx.user_texts.map((t) => t.split("\n")[0]).slice(-2)).toEqual(["slow conduit while bb waits", "bb during conduit"]);
    expect(ctx.assistant_texts!.at(-1)).toMatch(/^echo\(\d+\): slow conduit while bb waits/);
    await conduitSends(conduit, "alex", alexLive, "conduit after E3a");
  });

  it("E3b: Conduit sends during a bb turn: forwarded into the gateway's queue; bb renders it through its wake", async () => {
    const v = options("alex", { kind: "bot", lineage_root: alexBot, session_id: alexBot, tag: "Conduit" });
    const before = statuses("thr_alex").length;
    await begin("thr_alex", [text("slow bb turn for E3b")], v);
    await waitFor("bb streams", () => check.events.length >= 0 && bridgeCalls("prompt.submit").some((s) => s.params.text === "slow bb turn for E3b"));
    await sleep(1500);
    const forwarded = await conduit.call("prompt.submit", { session_id: alexLive, profile: "alex", text: "conduit during bb" });
    expect(forwarded.result).toMatchObject({ status: "queued", forwarded: true });
    await waitFor("bb turn", () => statuses("thr_alex").length > before);
    await waitFor("forwarded turn ran", () => lastCall("conduit during bb"));
    await sleep(1500);
    const anchor = (await userRows("alex", alexBot)).find((m) => m.content === "conduit during bb")!;
    expect(String(anchor.display_metadata?.submission_id)).toMatch(/^desktop-forward-/);
    const shown = agentTexts("thr_alex").length;
    expect(await turn("thr_alex", wake({ op: "mirror", anchor_uid: anchor.message_uid }, "[Conduit] conduit during bb"), v)).toBe("completed");
    expect(agentTexts("thr_alex").slice(shown)).toEqual([expect.stringContaining("conduit during bb")]);
    expect(lastCall("conduit during bb")!.user_texts.map((t) => t.split("\n")[0]).slice(-2)).toEqual(["slow bb turn for E3b", "conduit during bb"]);
    await conduitSends(conduit, "alex", alexLive, "conduit after E3b");
  });

  it("E7: compaction in place: bb's /new and Conduit's compress keep one session; both continue", async () => {
    const v = bot("alex");
    expect(await turn("thr_alex", [text("/new")], v)).toBe("completed");
    const compress = bridgeCalls("session.mutate", alexBot).at(-1)!;
    expect(compress.params).toMatchObject({ operation: "compress", expected_generation: expect.any(Number) });
    expect(bridgeCalls("prompt.submit").filter((s) => s.params.text === "/new")).toHaveLength(0);
    await conduitSends(conduit, "alex", alexLive, "conduit after bb compacted");
    const compressed = await conduit.call("session.compress", { session_id: alexLive, profile: "alex" });
    expect(compressed.error).toBeUndefined();
    expect(await turn("thr_alex", [text("bb after both compactions")], v)).toBe("completed");
    await conduitSends(conduit, "alex", alexLive, "conduit after both compactions");
    expect((await botChats("alex")).map((s) => s.session_id)).toEqual([alexBot]);
  });

  it("E6: Conduit mints bob's Bot Chat and holds it: bb's send waits with the held banner, no fork; it sends once Conduit lets go", async () => {
    const d = await h.dashboard();
    const minted = await d.rpc("session.create", { profile: "bob", source: "desktop", title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true });
    const live = String(minted.session_id);
    const legacy = String(minted.stored_session_id);
    await conduitSends(d, "bob", live, "conduit mints bob's bot chat");
    await startThread("thr_bob", bot("bob"));
    await begin("thr_bob", [text("bb while conduit holds")], bot("bob"));
    await waitFor("held banner", () => banners("thr_bob").includes("held"), 30_000);
    await sleep(4000);
    expect(statuses("thr_bob")).toEqual([]);
    expect(h.dbRow("bob", legacy).row).toMatchObject({ chat_id: null, source: "desktop" });
    await conduitSends(d, "bob", live, "conduit while bb waits");
    d.close();
    await waitFor("bb's send after Conduit left", () => statuses("thr_bob").length === 1, 120_000);
    expect(statuses("thr_bob")).toEqual(["completed"]);
    expect(banners("thr_bob").at(-1)).toBeNull();
    expect((await botChats("bob")).map((s) => s.session_id)).toEqual([legacy]);
    expect(bridgeCalls("prompt.submit").filter((s) => s.params.profile === "bob").map((s) => s.params.session_id)).toEqual([legacy]);
    expect(lastCall("bb while conduit holds")!.user_texts.map((t) => t.split("\n")[0])).toEqual(["conduit mints bob's bot chat", "conduit while bb waits", "bb while conduit holds"]);
    const d2 = await h.dashboard();
    await conduitSends(d2, "bob", await d2.open("bob", (await d2.findByTitle("bob", BOT_CHAT_TITLE))!), "conduit after adoption");
    d2.close();
  });

  it("E8: rotating compaction (carol): bb's /new rotates; bb keeps the root id, Conduit's title lookup finds the tip; both write one conversation", async () => {
    const v = bot("carol");
    await startThread("thr_carol", v);
    for (let i = 1; i <= 6; i++) expect(await turn("thr_carol", [text(`carol turn ${i} ` + "lorem ipsum ".repeat(30))], v)).toBe("completed");
    const [row] = await botChats("carol");
    const root = row!.session_id;
    expect(await turn("thr_carol", [text("/new")], v)).toBe("completed");
    const compress = mutations.at(-1) as { session_id: string; target_session_id: string };
    expect(compress).toMatchObject({ operation: "compress", session_id: root });
    const tip = compress.target_session_id;
    expect(tip).not.toBe(root);
    // The canonical lookup keeps the root id (the stable live id, as in rotating-viewer); the dashboard's resolves to the tip.
    expect((await botChats("carol")).map((s) => s.session_id)).toEqual([root]);
    const d = await h.dashboard();
    expect(await d.findByTitle("carol", BOT_CHAT_TITLE)).toBe(tip);
    expect(await turn("thr_carol", [text("bb after the rotation")], v)).toBe("completed");
    await conduitSends(d, "carol", await d.open("carol", tip), "conduit on the tip");
    expect(await turn("thr_carol", [text("bb after conduit on the tip")], v)).toBe("completed");
    await conduitSends(d, "carol", await d.open("carol", tip), "conduit after bb on the tip");
    d.close();
    // One conversation: REST reads the chain from either id; the four asks in order; each call saw the others.
    for (const id of [root, tip]) {
      const asks = (await userRows("carol", id)).map((m) => String(m.content).split("\n")[0]);
      expect(asks.slice(-4), id === root ? "root" : "tip").toEqual(["bb after the rotation", "conduit on the tip", "bb after conduit on the tip", "conduit after bb on the tip"]);
    }
    expect(lastCall("conduit after bb on the tip")!.user_texts.map((t) => t.split("\n")[0]).slice(-4)).toEqual(["bb after the rotation", "conduit on the tip", "bb after conduit on the tip", "conduit after bb on the tip"]);
    expect(bridgeCalls("session.create").filter((s) => s.params.profile === "carol" && s.params.title === BOT_CHAT_TITLE)).toHaveLength(1);
  });

  it("E10: a Conduit chat (legacy): mirrored with 0 resume/mutate; bb's reply waits while held, then adopts it; Conduit continues", async () => {
    const d = await h.dashboard();
    const made = await d.rpc("session.create", { profile: "alex", source: "desktop" });
    const live = String(made.session_id);
    const legacy = String(made.stored_session_id);
    await conduitSends(d, "alex", live, "a conduit chat");
    const v = options("alex", { kind: "mirror", lineage_root: legacy, session_id: legacy, legacy: true, tag: "Conduit" });
    await startThread("thr_e10", v);
    const anchor = (await userRows("alex", legacy))[0]!;
    expect(await turn("thr_e10", wake({ op: "bind", profile_home: h.profileHome("alex"), lineage_root: legacy, legacy: true, anchor_uid: anchor.message_uid }, "[Conduit] a conduit chat"), v)).toBe("completed");
    expect(bridgeCalls("session.resume", legacy)).toHaveLength(0);
    expect(bridgeCalls("session.mutate", legacy)).toHaveLength(0);
    expect(h.dbRow("alex", legacy)).toMatchObject({ row: { chat_id: null }, state_meta: [] });
    await begin("thr_e10", [text("bb replies in the conduit chat")], v);
    await waitFor("held banner", () => banners("thr_e10").includes("held"), 30_000);
    await conduitSends(d, "alex", live, "conduit while bb waits in its chat");
    d.close();
    await waitFor("bb's reply after Conduit left", () => statuses("thr_e10").length === 2, 120_000);
    expect(statuses("thr_e10")).toEqual(["completed", "completed"]);
    expect(h.dbRow("alex", legacy).row).toMatchObject({ chat_id: legacy, source: "desktop" });
    const d2 = await h.dashboard();
    await conduitSends(d2, "alex", await d2.open("alex", legacy), "conduit after bb adopted its chat");
    d2.close();
    const asks = (await userRows("alex", legacy)).map((m) => String(m.content).split("\n")[0]);
    expect(asks).toEqual(["a conduit chat", "conduit while bb waits in its chat", "bb replies in the conduit chat", "conduit after bb adopted its chat"]);
  });

  it("E11b: the gateway restarts mid bb turn: bb resolves its unknown admission, the turn fails, Conduit sends again", async () => {
    const v = bot("alex");
    await begin("thr_alex", [text("very slow bb turn before the restart")], v);
    await waitFor("bb streams", () => lastCall("very slow bb turn before the restart"));
    await sleep(3000);
    const before = statuses("thr_alex").length;
    await h.restartGateway();
    check.c.close();
    check = await h.canonical("check");
    await waitFor("bb's turn settles", () => statuses("thr_alex").length > before, 60_000);
    expect(statuses("thr_alex").at(-1)).toBe("failed");
    expect(bridgeCalls("prompt.resolve_unknown", alexBot)).toHaveLength(1);
    const d = await h.dashboard();
    await conduitSends(d, "alex", await d.open("alex", alexBot), "conduit after the restart");
    d.close();
  });

  it("E14: setBotAccess (in-process) writes the wrapper and skill; new and continuing sessions list it; off removes it", async () => {
    const alex = h.profileHome("alex");
    // The installer layout the worker looks for: the live install's CLI, read only, linked into this folder.
    mkdirSync(`${H}/hermes-agent/venv/bin`, { recursive: true });
    symlinkSync(path.join(os.homedir(), ".hermes/hermes-agent/venv/bin/hermes"), `${H}/hermes-agent/venv/bin/hermes`);
    // A stand-in for bb: the wrapper must never reach a real bb from here.
    mkdirSync(`${H}/bin`, { recursive: true });
    writeFileSync(`${H}/bin/bb`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = { ...h.env, BB_CLI: `${H}/bin/bb`, BB_SERVER_URL: "http://127.0.0.1:48886" };
    const on = await setBotAccess({ rootHome: H, profileHome: alex, on: true, enabledBots: [alex], dataDir: `${H}/plugin`, env });
    expect(on).toMatchObject({ skill: "written", wrapper: "written", refreshed: true, detail: null });
    expect(readFileSync(`${H}/plugin/bin/bb-hermes`, "utf8")).toContain("BB_SERVER_URL=http://127.0.0.1:48886");
    expect(existsSync(`${alex}/skills/bb-plugin-hermes/SKILL.md`)).toBe(true);
    const chat = options("alex", { kind: "chat" });
    await startThread("thr_e14", chat);
    expect(await turn("thr_e14", [text("skill check in a new chat")], chat)).toBe("completed");
    expect(lastCall("skill check in a new chat")!.bb_skill_listed).toBe(true);
    expect(await turn("thr_alex", [text("skill check in the continuing bot chat")], bot("alex"))).toBe("completed");
    expect(lastCall("skill check in the continuing bot chat")!.bb_skill_listed).toBe(true);
    const off = await setBotAccess({ rootHome: H, profileHome: alex, on: false, enabledBots: [], dataDir: `${H}/plugin`, env });
    expect(off).toMatchObject({ skill: "removed", wrapper: "removed", refreshed: true });
    expect(existsSync(`${alex}/skills/bb-plugin-hermes`)).toBe(false);
    const chat2 = options("alex", { kind: "chat" });
    await startThread("thr_e14b", chat2);
    expect(await turn("thr_e14b", [text("skill check after off")], chat2)).toBe("completed");
    expect(lastCall("skill check after off")!.bb_skill_listed).toBe(false);
    const d = await h.dashboard();
    await conduitSends(d, "alex", await d.open("alex", alexBot), "conduit after the skill changes");
    d.close();
  });

  it("never a second Bot Chat in any profile", async () => {
    for (const p of PROFILES) expect((await botChats(p)).length, p).toBeLessThanOrEqual(1);
  });
});
