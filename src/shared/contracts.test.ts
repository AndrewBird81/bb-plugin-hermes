import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { botLabel } from "./bots.js";
import { buildFromModuleUrl } from "./bridge-registry.js";
import { bannerText, statusStateSchema } from "./extension-state.js";
import { hostContract } from "./host-contract.js";
import { catalogFromModelOptions, catalogSchema, parseModelId } from "./models.js";
import { readProviderOptions, switchedOffText } from "./provider-options.js";
import { rpcContract } from "./rpc-contract.js";
import { folderSchema, machineSchema, settingsDescriptors } from "./settings.js";

describe("settings", () => {
  it("bb's settings form holds only the folder: the machine is picked by name in the app", () => {
    expect(Object.keys(settingsDescriptors)).toEqual(["folder"]);
  });

  it("validates machine and folder", () => {
    expect(machineSchema.safeParse("").success).toBe(true);
    expect(machineSchema.safeParse("host_abc123").success).toBe(true);
    expect(machineSchema.safeParse("a b").success).toBe(false);
    for (const ok of ["~", "~/.hermes", "/private/tmp/bb-hermes-test/home"]) expect(folderSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["", ".hermes", "~user/x", "relative/path"]) expect(folderSchema.safeParse(bad).success).toBe(false);
  });
});

describe("contracts", () => {
  it("host calls are strict", () => {
    expect(hostContract.ensureWatch.input.safeParse({ root: "~/.hermes", enabled_bots: [] }).success).toBe(true);
    expect(hostContract.ensureWatch.input.safeParse({ root: "~/.hermes", enabled_bots: [], extra: 1 }).success).toBe(false);
    expect(hostContract.diagnostics.input.safeParse(null).success).toBe(true);
  });

  it("setConnection takes a machine and an optional folder", () => {
    expect(rpcContract.setConnection.input.safeParse({ machine: "" }).success).toBe(true);
    expect(rpcContract.setConnection.input.safeParse({ machine: "host_x", folder: "/private/tmp/h" }).success).toBe(true);
    expect(rpcContract.setConnection.input.safeParse({ machine: "host_x", folder: "h" }).success).toBe(false);
  });
});

describe("buildFromModuleUrl", () => {
  it("is the plugin version and the artifact digest, else dev", () => {
    expect(buildFromModuleUrl("file:///x/plugin-host-artifacts/hermes/5d4a4f78f9046d7b2570e59aab07cb85/host.mjs")).toBe(`${pkg.version}+5d4a4f78f904`);
    expect(buildFromModuleUrl("file:///repo/src/bridge/entry.ts")).toBe(`${pkg.version}+dev`);
  });
});

describe("P1 host calls", () => {
  const root = "~/.hermes";
  it("name profiles by home and carry the folder", () => {
    expect(hostContract.readTurns.input.safeParse({ root, profile_home: "/h/p/neo", lineage_root: "s1", after_uid: "u1" }).success).toBe(true);
    expect(hostContract.readTurns.input.safeParse({ root, profile: "neo", lineage_root: "s1" }).success).toBe(false);
    expect(hostContract.setBotAccess.input.safeParse({ root, profile_home: "/h/p/neo", on: false, enabled_bots: [] }).success).toBe(true);
    expect(hostContract.findBotChat.output.safeParse({ state: "held" }).success).toBe(true);
    expect(hostContract.findBotChat.output.safeParse({ state: "found", lineage_root: "a", session_id: "b", legacy: true }).success).toBe(true);
  });
});

describe("models", () => {
  it("normalizes model.options (r11 §1) and parses ids back", () => {
    const raw = {
      providers: [
        { slug: "openai-codex", name: "Codex", is_current: true, models: ["gpt-6.1-sol", "x/y"], capabilities: { "gpt-6.1-sol": { reasoning: true, can_disable_reasoning: false } } },
        { slug: "empty", name: "Empty", models: [] },
        { slug: "bad/slug", models: ["m"] },
      ],
      model: "gpt-6.1-sol",
      provider: "openai-codex",
    };
    const catalog = catalogFromModelOptions("/h", raw, 5);
    expect(catalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.current).toBe("openai-codex/gpt-6.1-sol");
    expect(catalog.models.map((m) => [m.id, m.reasoning, m.can_disable_reasoning])).toEqual([
      ["openai-codex/gpt-6.1-sol", true, false],
      ["openai-codex/x/y", false, null],
    ]);
    expect(parseModelId("openai-codex/x/y")).toEqual({ provider: "openai-codex", model: "x/y" });
    expect(parseModelId("stub")).toBeNull();
  });
});

describe("bot labels", () => {
  it("default shows as Hermes; others by handle, else name", () => {
    expect(botLabel("default", "hermes")).toBe("Hermes");
    expect(botLabel("neo", "neo")).toBe("Neo");
    expect(botLabel("neo")).toBe("Neo");
  });
});

describe("provider options and extension states", () => {
  it("read leniently on the bridge side", () => {
    // An older server's options (no `project`): not in a project.
    expect(readProviderOptions({ folder: "~/.hermes", machine: null, thread: null })).toEqual({ folder: "~/.hermes", machine: null, thread: null, project: false });
    expect(readProviderOptions({ folder: "~/.hermes" })).toBeNull();
    // bb's host daemon merges its own keys in (bb-app 0.49.0): dropped, never a refusal.
    expect(readProviderOptions({ folder: "~/.hermes", machine: null, thread: null, project: true, additionalWorkspaceWriteRoots: ["/tmp/x"] })).toEqual({
      folder: "~/.hermes",
      machine: null,
      thread: null,
      project: true,
    });
    expect(readProviderOptions(undefined)).toBeNull();
  });

  it("status banners have fixed text", () => {
    expect(statusStateSchema.safeParse({ banner: { kind: "running_elsewhere" }, since: 1 }).success).toBe(true);
    // Never an app's name (owner ruling): an `app` field is refused.
    expect(statusStateSchema.safeParse({ banner: { kind: "running_elsewhere", app: "CLI" }, since: 1 }).success).toBe(false);
    expect(bannerText({ kind: "held" })).toBe("Open in another Hermes app: sends when it's free");
    expect(bannerText({ kind: "running_elsewhere" })).toBe("Running outside bb");
    expect(switchedOffText("Neo")).toBe("Neo is switched off in the Hermes plugin settings.");
  });
});
