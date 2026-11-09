// T1.3: the composer (01 §4; 02 §Protocol mapping `model/list`, `thread/start`, attachments; S7 1a–1c, finding 6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsFile, WORKER_FILE, type WorkerFile } from "../shared/bridge-files.js";
import { catalogFromModelOptions } from "../shared/models.js";
import { catalogState, imagesOnlyText, PLACEHOLDER_MODEL, unofferedModelText } from "./composer.js";
import { updateThread } from "./files.js";
import { type Rig, startRig, startThread, text, turn } from "./testing/harness.js";
import { deltas, errors, statuses } from "./testing/read.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig();
});
afterEach(async () => {
  await rig.close();
});

const opts = (profile = "alex", view: object | null = {}) => ({ providerOptions: rig.options(profile, view as never) });
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
    // The thread's bot's models; the chip shows what an untouched chip gets (`default`), never the thread's bot.
    const chip = [expect.objectContaining({ id: "profile", value: "default", values: expect.arrayContaining([{ id: "alex", label: "Alex" }, { id: "bob", label: "Bob" }]) })];
    expect(res.models).toEqual([
      expect.objectContaining({ id: PLACEHOLDER_MODEL, isDefault: true, sessionOptions: chip }),
      expect.objectContaining({ id: "stub/stub", isDefault: false, sessionOptions: chip }),
    ]);
    expect(res.models[1]!.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort)).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(existsSync(modelsFile(rig.dataDir, home("bob")))).toBe(true);
    expect(rig.fake.requests.filter((r) => r.method.startsWith("session."))).toEqual([]); // never a session (r09 M6)
  });

  it("no bot to ask here (no worker.json, or no bot on): one placeholder default, so a spawn resolves a model and reaches the plugin's refusal", async () => {
    for (const setup of [{ worker: false }, { enabled: [] }]) {
      await rig.close();
      rig = await startRig(setup);
      const res = (await rig.call("model/list", { cwd: "/x/workspaces/thr_none" })).result as { models: Record<string, any>[] };
      expect(res.models).toEqual([expect.objectContaining({ id: PLACEHOLDER_MODEL, model: PLACEHOLDER_MODEL, isDefault: true, reasoningDiscovery: "known", supportedReasoningEfforts: [] })]);
      expect(res.models[0]!.sessionOptions).toBeUndefined(); // no option conflicts with `--option profile=<bot>`
      expect(rig.fake.requests).toEqual([]);
    }
  });

  it("model.options slower than 2 s → the last-known list", async () => {
    await rig.call("model/list", { cwd: "/x/none" });
    rig.fake.modelOptionsDelayMs = 4000;
    const at = Date.now();
    const res = (await rig.call("model/list", { cwd: "/x/none" })).result as { models: unknown[] };
    expect(Date.now() - at).toBeLessThan(3000);
    expect(res.models).toHaveLength(2);
  });
});

describe("D53: a new chat runs its bot's own model unless the user picks one", () => {
  it("New Thread's list (no cwd) has \"The bot's model\" first as the default, with the chip; untouched, session.create gets no model (research 14 §4)", async () => {
    // The first bot runs `codex/terra`; bob runs `local/mlx` and is offered `codex/terra` too.
    rig.fake.handle("model.options", (params) => {
      const bob = (params as { profile?: string }).profile === "bob";
      return {
        providers: [
          { slug: "codex", name: "Codex", is_current: !bob, models: ["terra"], capabilities: { terra: { reasoning: true } } },
          { slug: "local", name: "Local", is_current: bob, models: ["mlx"], capabilities: { mlx: { reasoning: false } } },
        ],
        model: bob ? "mlx" : "terra",
        provider: bob ? "local" : "codex",
      };
    });
    const { models } = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual([PLACEHOLDER_MODEL]);
    expect(models[0]).toMatchObject({ id: PLACEHOLDER_MODEL, displayName: "The bot's model", sessionOptions: [expect.objectContaining({ id: "profile" })] });
    // bb's New Thread: bob in the chip, the list's default as the model.
    const bob = { ...opts("bob", null), sessionOptions: { profile: "bob" } };
    await startThread(rig, "thr_d53", bob);
    await turn(rig, "thr_d53", [text("hi")], { ...bob, model: models.find((m) => m.isDefault)!.id });
    const params = rig.requests("session.create")[0]!.params;
    expect(params).toMatchObject({ profile: "bob" });
    expect(params).not.toHaveProperty("model");
    expect(params).not.toHaveProperty("provider");
    expect(warnings("thr_d53")).toEqual([]);
    // A pick in that chat goes.
    await startThread(rig, "thr_pick", bob);
    await turn(rig, "thr_pick", [text("hi")], { ...bob, model: "codex/terra" });
    expect(rig.requests("session.create").at(-1)!.params).toMatchObject({ model: "terra", provider: "codex" });
  });
});

describe("ux-v1.1 §3: the bot chip", () => {
  /** Marks bots unserved in the worker's file, as the worker writes it when the gateway stops serving them. */
  const unserve = (...profiles: string[]) => {
    const file = path.join(rig.dataDir, WORKER_FILE);
    const worker = JSON.parse(readFileSync(file, "utf8")) as WorkerFile;
    writeFileSync(file, JSON.stringify({ ...worker, enabled: worker.enabled.map((b) => (profiles.includes(b.profile) ? { ...b, served: false } : b)) }));
  };
  const chip = (models: Record<string, any>[]) => models[0]!.sessionOptions[0] as { value: string; values: { id: string; label: string; description?: string }[] };

  it("`default` reads \"Hermes bot\", \"Default profile\", in the chip and its menu; the sidebar label stays Hermes", async () => {
    const { models } = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    expect(chip(models)).toMatchObject({ value: "default", values: [{ id: "default", label: "Hermes bot", description: "Default profile" }, { id: "alex", label: "Alex" }, { id: "bob", label: "Bob" }] });
    await startThread(rig, "thr_def", opts("default"));
    await rig.waitFor(() => deltas(rig, "thr_def").length >= 2);
    expect(deltas(rig, "thr_def")[0]).toMatchObject({ extensionKind: "bb/session-options", payload: { options: [{ value: "default", values: [{ id: "default", label: "Hermes bot", description: "Default profile" }] }] } });
    expect(rig.options("default").thread?.bot_label).toBe("Hermes");
  });

  it("an unserved bot is left out of the chip; its own thread still shows it", async () => {
    unserve("bob");
    const { models } = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    expect(chip(models).values.map((v) => v.id)).toEqual(["default", "alex"]);
    await startThread(rig, "thr_bob", opts("bob"));
    await rig.waitFor(() => deltas(rig, "thr_bob").length >= 2);
    const catalog = deltas(rig, "thr_bob").find((d) => d.extensionKind === "bb/provider-model-catalog")!;
    expect(chip((catalog.payload as { models: Record<string, any>[] }).models)).toMatchObject({ value: "default", values: [{ id: "bob" }, { id: "default" }, { id: "alex" }] });
    await startThread(rig, "thr_alex", opts("alex"));
    await rig.waitFor(() => deltas(rig, "thr_alex").length >= 2);
    const alexCatalog = deltas(rig, "thr_alex").find((d) => d.extensionKind === "bb/provider-model-catalog")!;
    expect(chip((alexCatalog.payload as { models: Record<string, any>[] }).models).values.map((v) => v.id)).toEqual(["default", "alex"]);
    // No served bot: no chip, as with no bot on.
    unserve("default", "alex");
    const none = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    expect(none.models).toEqual([expect.objectContaining({ id: PLACEHOLDER_MODEL })]);
    expect(none.models[0]!.sessionOptions).toBeUndefined();
  });
});

describe("item 14: an untouched chip shows the bot the chat gets", () => {
  it("every catalog's chip shows the served default bot, never a thread's: bb sends no selection for an untouched chip, and the bridge then uses default", async () => {
    // An alex chat in a project publishes the project's catalog; bob's thread lists by its workspace cwd.
    updateThread(rig.dataDir, "thr_ws", { profile: "bob", bot: false, profile_home: home("bob") });
    await startThread(rig, "thr_alex", opts("alex"));
    await rig.waitFor(() => deltas(rig, "thr_alex").length >= 2);
    const published = deltas(rig, "thr_alex").find((d) => d.extensionKind === "bb/provider-model-catalog")!;
    const lists = [
      (published.payload as { models: Record<string, any>[] }).models,
      ((await rig.call("model/list", {})).result as { models: Record<string, any>[] }).models,
      ((await rig.call("model/list", { cwd: "/x/workspaces/thr_ws" })).result as { models: Record<string, any>[] }).models,
    ];
    for (const models of lists) expect(new Set(models.map((m) => m.sessionOptions[0].value))).toEqual(new Set(["default"]));
    // A New Thread sent untouched: no session options, so the chat is default's, as its chip showed.
    await startThread(rig, "thr_untouched", opts("alex", null));
    await turn(rig, "thr_untouched", [text("hi")], { ...opts("alex", null), model: PLACEHOLDER_MODEL });
    expect(rig.requests("session.create").at(-1)!.profile).toBe("default");
  });

  it("with default off, the chip shows the first served bot and an untouched send is refused, never sent elsewhere", async () => {
    await rig.close();
    rig = await startRig({ enabled: ["alex", "bob"] });
    const { models } = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    expect(models[0]!.sessionOptions[0]).toMatchObject({ value: "alex" });
    await startThread(rig, "thr_off", opts("alex", null));
    await turn(rig, "thr_off", [text("hi")], { ...opts("alex", null), model: PLACEHOLDER_MODEL });
    expect(errors(rig, "thr_off")).toEqual([expect.stringContaining("Pick a bot")]);
    expect(rig.requests("session.create")).toHaveLength(0);
  });
});

describe("thread/start", () => {
  it("publishes the one-value bot chip and the bot's models, each with the chip of every switched-on bot", async () => {
    await startThread(rig, "thr_ch", opts("bob"));
    await rig.waitFor(() => deltas(rig, "thr_ch").length >= 2);
    const [chip, catalog] = deltas(rig, "thr_ch");
    expect(chip).toMatchObject({ extensionKind: "bb/session-options", payload: { options: [{ id: "profile", value: "bob", values: [{ id: "bob", label: "Bob" }] }] } });
    expect(catalog).toMatchObject({ extensionKind: "bb/provider-model-catalog", payload: { models: [{ id: PLACEHOLDER_MODEL, isDefault: true }, { id: "stub/stub" }] } });
    // Research 13 §6: a project's New Thread reads this catalog (its scope is the project's folder), so each model
    // carries the chip with every switched-on bot, this thread's bot picked, as `model/list` answers.
    const values = [{ id: "default", label: "Hermes bot", description: "Default profile" }, { id: "alex", label: "Alex" }, { id: "bob", label: "Bob" }];
    for (const model of (catalog!.payload as { models: Record<string, unknown>[] }).models)
      expect(model.sessionOptions).toEqual([{ id: "profile", label: "Bot", category: "mode", type: "select", value: "default", values }]);
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
    expect(models).toHaveLength(201);
    const ladder = (m: Record<string, any>) => m.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort);
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual([PLACEHOLDER_MODEL]);
    const current = models.find((m) => m.id === "openrouter/vendor-3/model-name-150")!;
    expect(current.reasoningDiscovery).toBe("known");
    expect(ladder(current)).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(ladder(models[0]!)).toEqual(["default"]);
    // Bare entries before any chip, chips before ladders: the first two carry the chip.
    expect([models[0]!.sessionOptions, current.sessionOptions].every((o) => o?.[0]?.id === "profile")).toBe(true);
    // The rest: bb asks `model/list{selectedModel}` when one is picked (its selected-model discovery).
    const later = models.filter((m) => m.reasoningDiscovery === "unknown");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((m) => m.supportedReasoningEfforts.length === 0)).toBe(true);
    const picked = later.at(-1)!;
    const res = (await rig.call("model/list", { cwd: "/x/workspaces/thr_big", selectedModel: picked.model })).result as { models: Record<string, any>[] };
    expect(res.models).toHaveLength(201);
    const answer = res.models.find((m) => m.model === picked.model)!;
    expect(answer.reasoningDiscovery).toBe("known");
    expect(ladder(answer)).toEqual(ladder(current));
  });

  it("1000 models (bb's most): the bot's model and the current one with their reasoning, then the catalog's first; the last ones left out", () => {
    const catalog = catalogFromModelOptions("/h", manyModels(1000, 900), 0);
    const state = catalogState(catalog);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(65536);
    const ids = state.models.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual([PLACEHOLDER_MODEL, catalog.models[0]!.id]);
    expect(ids).toContain(catalog.current);
    expect(state.models.find((m) => m.isDefault)!.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(["default"]);
    expect(state.models.find((m) => m.id === catalog.current)!.supportedReasoningEfforts).toHaveLength(8);
    const kept = ids.filter((id) => id !== catalog.current && id !== PLACEHOLDER_MODEL);
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

  it("\"The bot's model\" is the bot's own model and level: it offers only Default, and no level bb carried over reaches Hermes", async () => {
    const { models } = (await rig.call("model/list", {})).result as { models: Record<string, any>[] };
    // bb keeps its carried level (`medium`) wherever a model offers it; offered only Default, it moves there.
    expect(models[0]).toMatchObject({ id: PLACEHOLDER_MODEL, defaultReasoningEffort: "default", supportedReasoningEfforts: [expect.objectContaining({ reasoningEffort: "default" })] });
    expect(models[0]!.supportedReasoningEfforts).toHaveLength(1);
    for (const [threadId, level] of [["thr_ph", "medium"], ["thr_ph_high", "high"], ["thr_ph_def", "default"]] as const) {
      await startThread(rig, threadId, opts());
      await turn(rig, threadId, [text("hi")], { ...opts(), model: PLACEHOLDER_MODEL, reasoningLevel: level });
      const params = rig.requests("session.create").at(-1)!.params;
      expect([params.model, params.provider, params.reasoning]).toEqual([undefined, undefined, undefined]);
      expect(warnings(threadId)).toEqual([]);
    }
    expect(JSON.stringify(rig.fake.requests)).not.toContain(PLACEHOLDER_MODEL);
    // A level is picked with a model.
    await startThread(rig, "thr_pick_level", opts());
    await turn(rig, "thr_pick_level", [text("hi")], { ...opts(), model: "stub/stub", reasoningLevel: "high" });
    expect(rig.requests("session.create").at(-1)!.params).toMatchObject({ model: "stub", reasoning: "high" });
  });

  it("back to \"The bot's model\" mid-chat gives the reasoning back to the bot", async () => {
    await startThread(rig, "thr_back", opts());
    await turn(rig, "thr_back", [text("one")], { ...opts(), model: "stub/stub", reasoningLevel: "high" });
    await turn(rig, "thr_back", [text("two")], { ...opts(), model: PLACEHOLDER_MODEL, reasoningLevel: "medium" });
    expect(rig.requests("session.mutate").map((m) => [m.params.operation, m.params.payload])).toEqual([["reasoning", { effort: null }]]);
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
