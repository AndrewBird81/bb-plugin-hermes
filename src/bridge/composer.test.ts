// T1.3: the composer (01 §4; 02 §Protocol mapping `model/list`, `thread/start`, attachments; S7 1a–1c, finding 6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsFile } from "../shared/bridge-files.js";
import { catalogFromModelOptions } from "../shared/models.js";
import { catalogState, imagesOnlyText, unofferedModelText } from "./composer.js";
import { updateThread } from "./files.js";
import { type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { deltas, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig();
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile = "alex", view: object = {}) => ({ providerOptions: rig.options(profile, view as never) });
const home = (profile: string) => rig.fake.profiles.find((p) => p.name === profile)!.home;
const warnings = (threadId: string) => deltas(rig, threadId).filter((d) => d.kind === "provider.warning").map((d) => d.summary);
const TWO_MODELS = {
  providers: [
    { slug: "stub", name: "Stub", is_current: true, models: ["stub", "stub-mini"], capabilities: { stub: { reasoning: true, can_disable_reasoning: false }, "stub-mini": { reasoning: false } } },
  ],
  model: "stub",
  provider: "stub",
};

describe("model/list (maintenance: no provider options)", () => {
  it("the bot of the thread at cwd, the switched-on bots as the profile option; saved as last-known", async () => {
    updateThread(rig.dataDir, "thr_ml", { profile: "bob", bot: false, profile_home: home("bob") });
    const res = (await rig.call("model/list", { cwd: `/x/workspaces/thr_ml` })).result as { models: Record<string, any>[] };
    expect(rig.requests("model.options")[0]).toMatchObject({ params: { profile: "bob" } });
    expect(res.models).toEqual([
      expect.objectContaining({ id: "stub/stub", isDefault: true, sessionOptions: [expect.objectContaining({ id: "profile", value: "bob", values: expect.arrayContaining([{ id: "alex", label: "Alex" }, { id: "bob", label: "Bob" }]) })] }),
    ]);
    expect(res.models[0]!.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort)).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(existsSync(modelsFile(rig.dataDir, home("bob")))).toBe(true);
    expect(rig.fake.requests.filter((r) => r.method.startsWith("session."))).toEqual([]); // never a session (r09 M6)
  });

  it("model.options slower than 2 s → the last-known list", async () => {
    await rig.call("model/list", { cwd: "/x/none" });
    rig.fake.modelOptionsDelayMs = 4000;
    const at = Date.now();
    const res = (await rig.call("model/list", { cwd: "/x/none" })).result as { models: unknown[] };
    expect(Date.now() - at).toBeLessThan(3000);
    expect(res.models).toHaveLength(1);
  });
});

describe("thread/start", () => {
  it("publishes the one-value bot chip and the bot's models", async () => {
    await startThread(rig, "thr_ch", opts("bob"));
    await rig.waitFor(() => deltas(rig, "thr_ch").length >= 2);
    const [chip, catalog] = deltas(rig, "thr_ch");
    expect(chip).toMatchObject({ extensionKind: "bb/session-options", payload: { options: [{ id: "profile", value: "bob", values: [{ id: "bob", label: "Bob" }] }] } });
    expect(catalog).toMatchObject({ extensionKind: "bb/provider-model-catalog", payload: { models: [{ id: "stub/stub" }] } });
    expect(rig.fake.requests.filter((r) => r.method.startsWith("session."))).toEqual([]);
  });
});

/** A big provider (OpenRouter-like ids): `n` reasoning models, the current one late in the list. */
const manyModels = (n: number, current: number) => {
  const models = Array.from({ length: n }, (_, i) => `vendor-${i % 7}/model-name-${i}`);
  return {
    providers: [{ slug: "openrouter", name: "OpenRouter", is_current: true, models, capabilities: Object.fromEntries(models.map((m) => [m, { reasoning: true }])) }],
    model: models[current],
    provider: "openrouter",
  };
};

describe("bb/provider-model-catalog under bb's 64 KiB state limit", () => {
  it("200 models: every model, under 65 536 bytes as bb measures it; the current one keeps its reasoning, a picked one gets it from model/list", async () => {
    rig.fake.handle("model.options", () => manyModels(200, 150));
    await startThread(rig, "thr_big", opts());
    await rig.waitFor(() => deltas(rig, "thr_big").length >= 2);
    const state = deltas(rig, "thr_big").find((d) => d.extensionKind === "bb/provider-model-catalog")!;
    // bb: `Buffer.byteLength(JSON.stringify(payload)) > EXTENSION_PAYLOAD_MAX_BYTES` (64 * 1024) → provider/unhandled.
    expect(Buffer.byteLength(JSON.stringify(state.payload))).toBeLessThanOrEqual(65536);
    const models = (state.payload as { models: Record<string, any>[] }).models;
    expect(models).toHaveLength(200);
    const ladder = (m: Record<string, any>) => m.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort);
    const current = models.find((m) => m.isDefault)!;
    expect(current.id).toBe("openrouter/vendor-3/model-name-150");
    expect(current.reasoningDiscovery).toBe("known");
    expect(ladder(current)).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    // The rest: bb asks `model/list{selectedModel}` when one is picked (its selected-model discovery).
    const later = models.filter((m) => m.reasoningDiscovery === "unknown");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((m) => m.supportedReasoningEfforts.length === 0)).toBe(true);
    const picked = later.at(-1)!;
    const res = (await rig.call("model/list", { cwd: "/x/workspaces/thr_big", selectedModel: picked.model })).result as { models: Record<string, any>[] };
    expect(res.models).toHaveLength(200);
    const answer = res.models.find((m) => m.model === picked.model)!;
    expect(answer.reasoningDiscovery).toBe("known");
    expect(ladder(answer)).toEqual(ladder(current));
  });

  it("1000 models (bb's most): the current one with its reasoning, then the catalog's first; the last ones left out", () => {
    const catalog = catalogFromModelOptions("/h", manyModels(1000, 900), 0);
    const state = catalogState(catalog);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(65536);
    const ids = state.models.map((m) => m.id);
    expect(ids[0]).toBe(catalog.models[0]!.id);
    expect(ids).toContain(catalog.current);
    expect(state.models.find((m) => m.isDefault)!.supportedReasoningEfforts).toHaveLength(8);
    const kept = ids.filter((id) => id !== catalog.current);
    expect(kept).toEqual(catalog.models.slice(0, kept.length).map((m) => m.id));
  });
});

describe("model and reasoning", () => {
  it("the turn's model and reasoning reach session.create; default → no reasoning", async () => {
    await startThread(rig, "thr_mr", opts());
    await turn(rig, "thr_mr", [text("hi")], { ...opts(), model: "stub/stub", reasoningLevel: "high" });
    expect(rig.requests("session.create")[0]!.params).toMatchObject({ model: "stub", provider: "stub", reasoning: "high" });
    for (const [asked, sent] of [["max", "max"], ["ultra", "ultra"], ["ultracode", "xhigh"]]) {
      await startThread(rig, `thr_${asked}`, opts());
      await turn(rig, `thr_${asked}`, [text("hi")], { ...opts(), model: "stub/stub", reasoningLevel: asked });
      expect(rig.requests("session.create").at(-1)!.params.reasoning).toBe(sent);
    }
    await startThread(rig, "thr_md", opts());
    await turn(rig, "thr_md", [text("hi")], { ...opts(), model: "stub/stub", reasoningLevel: "default" });
    expect(rig.requests("session.create").at(-1)!.params.reasoning).toBeUndefined();
  });

  it("an unoffered model → the bot's current one and a warning; the turn still runs (S7 finding 6)", async () => {
    await startThread(rig, "thr_un", opts());
    await turn(rig, "thr_un", [text("hi")], { ...opts(), model: "openai/gpt-5.5" });
    expect(rig.requests("session.create")[0]!.params).toMatchObject({ model: "stub", provider: "stub" });
    expect(warnings("thr_un")).toEqual([unofferedModelText("openai/gpt-5.5", "stub/stub")]);
    expect(statuses(rig, "thr_un")).toEqual(["completed"]);
  });

  it("a mid-chat pick → session.mutate model / reasoning with the fences", async () => {
    rig.fake.handle("model.options", () => TWO_MODELS);
    await startThread(rig, "thr_mid", opts());
    await turn(rig, "thr_mid", [text("one")], { ...opts(), model: "stub/stub", reasoningLevel: "high" });
    await turn(rig, "thr_mid", [text("two")], { ...opts(), model: "stub/stub", reasoningLevel: "low" });
    await turn(rig, "thr_mid", [text("three")], { ...opts(), model: "stub/stub-mini", reasoningLevel: "low" });
    const mutates = rig.requests("session.mutate");
    expect(mutates.map((m) => [m.params.operation, m.params.payload])).toEqual([
      ["reasoning", { effort: "low" }],
      ["model", { model: "stub-mini", provider: "stub" }],
      ["reasoning", { effort: null }], // stub-mini has no reasoning: the bot's level
    ]);
    expect(mutates.every((m) => typeof m.params.expected_generation === "number" && !m.refused)).toBe(true);
  });

  it("the first bb send into an existing chat keeps its model", async () => {
    const cli = await rig.cli();
    const snap = await cli.create({ profile: "alex", request_id: "cli-chat", source: "cli" });
    const view = { kind: "mirror", lineage_root: snap.session_id, session_id: snap.session_id };
    await startThread(rig, "thr_ex", opts("alex", view));
    await turn(rig, "thr_ex", [text("hi")], { ...opts("alex", view), model: "stub/stub", reasoningLevel: "high" });
    expect(rig.requests("session.mutate")).toHaveLength(0);
  });
});

describe("attachments (A50)", () => {
  it("an image goes as {path, mime} from the profile's image cache; another file warns and the text still goes", async () => {
    const dir = path.join(rig.dataDir, "inputs");
    mkdirSync(dir);
    const png = path.join(dir, "pixel.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
    const txt = path.join(dir, "notes.txt");
    writeFileSync(txt, "notes");
    await startThread(rig, "thr_at", opts());
    await turn(rig, "thr_at", [text("see these"), { type: "localImage", path: png }, { type: "localFile", path: txt, name: "notes.txt", mimeType: "text/plain" }], opts());
    const [submit] = rig.requests("prompt.submit");
    const attachments = submit!.params.attachments as { path: string; mime: string }[];
    expect(attachments).toEqual([{ path: expect.stringContaining(path.join(home("alex"), "cache", "images", "bb-")), mime: "image/png" }]);
    expect(path.dirname(attachments[0]!.path)).toBe(path.join(home("alex"), "cache", "images"));
    expect(readFileSync(attachments[0]!.path)).toEqual(readFileSync(png));
    expect(submit!.params.text).toBe("see these");
    expect(warnings("thr_at")).toEqual([imagesOnlyText("notes.txt")]);
  });
});
