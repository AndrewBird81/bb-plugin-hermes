import { describe, expect, it } from "vitest";
import { buildFromModuleUrl } from "./bridge-registry.js";
import { hostContract } from "./host-contract.js";
import { rpcContract } from "./rpc-contract.js";
import { folderSchema, machineSchema } from "./settings.js";

describe("settings", () => {
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
  it("reads the artifact digest, else dev", () => {
    expect(buildFromModuleUrl("file:///x/plugin-host-artifacts/hermes/5d4a4f78f9046d7b2570e59aab07cb85/host.mjs")).toBe("5d4a4f78f904");
    expect(buildFromModuleUrl("file:///repo/src/bridge/entry.ts")).toBe("dev");
  });
});
