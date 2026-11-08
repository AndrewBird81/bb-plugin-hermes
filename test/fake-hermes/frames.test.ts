// The engine speaks Hermes' frames: every event and result it sends has a recorded frame's keys
// (test/fixtures/frames/, Hermes c314285f07). What no recording covers yet is listed, so T1.0 can close it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { HermesClient, localDial } from "../../src/hermes/client.js";
import type { GatewayEvent } from "../../src/hermes/types.js";
import { startFakeHermes, type FakeHermes } from "./index.js";

type Frame = { jsonrpc: string; id?: number; method?: string; params?: Record<string, any>; result?: Record<string, any>; error?: unknown };
type Recorded = { client?: string; dir: string; frame: Frame };
// The T1.0 recordings (canonical clients only: `conduit` speaks the dashboard's legacy protocol) and the spike's.
const dir = path.join(import.meta.dirname, "../fixtures/frames");
const files = [
  ...readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)),
  ...readdirSync(path.join(dir, "spike")).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, "spike", f)),
];

/** Per event type: top-level key sets, and the union of payload keys. Per method: result key unions. */
const events = new Map<string, { tops: Set<string>; payload: Set<string> }>();
const results = new Map<string, Set<string>>();
for (const file of files) {
  const methodOf = new Map<string, string>();
  for (const { client = "spike", dir: d, frame } of (JSON.parse(readFileSync(file, "utf8")) as { frames: Recorded[] }).frames) {
    if (client === "conduit") continue;
    if (d === "out" && frame.method && frame.id !== undefined) methodOf.set(`${client}:${frame.id}`, frame.method);
    if (d === "in" && frame.method === "event") {
      const e = events.get(frame.params!.type) ?? { tops: new Set(), payload: new Set() };
      e.tops.add(Object.keys(frame.params!).sort().join());
      for (const k of Object.keys(frame.params!.payload ?? {})) e.payload.add(k);
      events.set(frame.params!.type, e);
    }
    if (d === "in" && frame.result && frame.id !== undefined) {
      // Request ids restart per socket: a result answers the latest request with its id on that client.
      const m = methodOf.get(`${client}:${frame.id}`)!;
      const set = results.get(m) ?? new Set();
      for (const k of Object.keys(frame.result)) set.add(k);
      results.set(m, set);
    }
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

it("every engine event and result has recorded keys; unrecorded event types are known", async () => {
  const f: FakeHermes = await startFakeHermes({ rotating: ["bob"], secondMs: 5 });
  cleanups.push(() => f.stop());
  const outFrames: Frame[] = [];
  const inFrames: Frame[] = [];
  const c = await HermesClient.connect((await localDial(f.folder)).dial, {
    onFrame: (d, raw) => (d === "out" ? outFrames : inFrames).push(JSON.parse(raw)),
  });
  cleanups.push(() => c.close());
  const seen: GatewayEvent[] = [];
  c.onEvent((e) => seen.push(e));
  const until = async (check: () => boolean) => {
    for (const end = Date.now() + 5000; !check(); await new Promise((r) => setTimeout(r, 5))) if (Date.now() > end) throw new Error("timeout");
  };
  const done = (sid: string, n: number) => until(() => seen.filter((e) => e.type === "message.complete" && e.session_id === sid).length >= n);
  let n = 0;
  const submit = (sid: string, text: string) => c.submit({ profile: "alex", session_id: sid, text, submission_id: `bb:f:${++n}`, turn_author: { id: "bb:f", name: "bb" } });

  const { session_id: sid } = await c.create({ profile: "alex", request_id: "bb:frames", source: "cli", cwd: "/tmp" });
  await submit(sid, "plain");
  await done(sid, 1);
  f.nextTurn("alex", { tool: true, approval: { kind: "edit" }, clarify: {}, reasoning: "hm", chunkMs: 20, reply: "a b c d e" });
  await submit(sid, "everything");
  await until(() => seen.some((e) => e.type === "approval.request"));
  const ap = seen.find((e) => e.type === "approval.request")!.payload as { prompt_id: string };
  await c.approvalRespond({ profile: "alex", session_id: sid, execution_generation: 2, prompt_id: ap.prompt_id, choice: "once" });
  await until(() => seen.some((e) => e.type === "clarify.request"));
  const cl = seen.find((e) => e.type === "clarify.request")!.payload as { prompt_id: string };
  await c.clarifyRespond({ profile: "alex", session_id: sid, execution_generation: 2, prompt_id: cl.prompt_id, answer: "blue" });
  await until(() => seen.filter((e) => e.type === "message.delta" && e.payload?.text).length >= 3);
  await c.steer({ profile: "alex", session_id: sid, execution_generation: 2, text: "also" });
  await c.interrupt({ profile: "alex", session_id: sid, execution_generation: 2 });
  await done(sid, 2);
  const conduit = f.conduitTurn("alex", sid, "from conduit", { durationMs: 100 });
  await new Promise((r) => setTimeout(r, 20));
  await submit(sid, "waits for the dashboard");
  await conduit;
  await done(sid, 3);
  await submit(sid, "#approval");
  await until(() => seen.filter((e) => e.type === "approval.request").length === 2);
  f.cancelApprovals("alex", sid);
  await done(sid, 4);
  const snap = await c.resume({ profile: "alex", session_id: sid, omit_messages: true });
  await c.mutate({ profile: "alex", session_id: sid, request_id: "m1", expected_revision: snap.revision, expected_generation: snap.execution_generation, operation: "reasoning", payload: { effort: "low" } });
  await c.eventsSince({ profile: "alex", session_id: sid, last_sequence: 1, replay_epoch: snap.replay_epoch });
  await c.sessionList({ profile: "alex", title: "x" });
  await c.detach({ profile: "alex", session_id: sid, subscription_id: snap.subscription_id, end_reason: null });

  const unrecorded = new Set<string>();
  for (const e of seen) {
    const rec = events.get(e.type);
    if (!rec) {
      unrecorded.add(e.type);
      continue;
    }
    const { replayed: _, ...top } = e;
    expect(rec.tops.has(Object.keys(top).sort().join()), `${e.type} top-level keys ${Object.keys(top)}`).toBe(true);
    // `session.updated` spreads the mutation's payload (recorded: rename's `title`, sidebar's `pinned`); a
    // reasoning or model pick's own keys (`effort`, `model`) are unrecorded.
    const own = e.type === "session.updated" ? new Set(["effort", "model", "provider", "reasoning"]) : new Set<string>();
    for (const k of Object.keys(e.payload ?? {})) if (!own.has(k)) expect(rec.payload.has(k), `${e.type} payload key ${k}`).toBe(true);
  }
  // Shapes the bridge relies on that no recording shows yet (T1.0): payloads per Hermes' contracts (events.py).
  expect([...unrecorded].sort()).toEqual(["approval.cancelled", "reasoning.delta", "status.update"]);

  const sentMethod = new Map(outFrames.map((fr) => [fr.id, fr.method!]));
  const checked = new Set<string>();
  for (const fr of inFrames) {
    if (!fr.result || fr.id === undefined) continue;
    const m = sentMethod.get(fr.id)!;
    const rec = results.get(m);
    if (!rec) continue;
    checked.add(m);
    const own = m === "session.mutate" ? new Set(["effort", "model", "provider", "reasoning"]) : new Set<string>();
    for (const k of Object.keys(fr.result)) if (!own.has(k)) expect(rec.has(k), `${m} result key ${k}`).toBe(true);
  }
  expect([...checked].sort()).toEqual(["approval.respond", "clarify.respond", "prompt.submit", "session.create", "session.detach", "session.events.since", "session.interrupt", "session.list", "session.mutate", "session.resume", "session.steer"]);
  expect(f.violations).toEqual([]);
});
