import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_JSON_RPC_ERRORS,
  bridgeCapabilitiesSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  providerHealthResultSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  type BridgeJsonRpcTestHarness,
  experimental_assembleCapturedThreadEvents as assemble,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIST_HERE_FILE, WORKER_FILE } from "../shared/bridge-files.js";
import { bridgeFileSchema } from "../shared/bridge-registry.js";
import { type Bridge, createBridge } from "./bridge.js";
import { placeholderModel } from "./composer.js";
import { NOT_CONNECTED_TEXT } from "./context.js";
import { PROVIDER_ID } from "./provider.js";

const cwd = "/work";
const autoMode = { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" };

let dataDir: string;
let bridge: Bridge;
let rpc: BridgeJsonRpcTestHarness;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "bb-hermes-test-"));
  bridge = createBridge("abc123def456");
  bridge.start(dataDir);
  rpc = createHarness(bridge.handleLine);
});
afterEach(() => {
  rpc.restore();
  bridge.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const registryFile = () => bridgeFileSchema.parse(JSON.parse(readFileSync(join(dataDir, "bridges", `${process.pid}.json`), "utf8")));
const call = async (id: number, method: string, params: Record<string, never> | object) => {
  rpc.sendRequest(id, method, params as never);
  return rpc.waitForResponse(id);
};

describe("bridge handshake", () => {
  it("initialize declares the 02 handshake", async () => {
    const res = await call(1, "initialize", { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, client: { name: "t", version: "0" } });
    expect(res.result).toMatchObject({ protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION });
    const caps = bridgeCapabilitiesSchema.parse((res.result as { capabilities: unknown }).capabilities);
    expect(caps).toMatchObject({
      grammarVersions: [3, 3],
      sessionRestore: true,
      approvalEnforcedBy: "provider",
      fork: "none",
      threadArchive: false,
      threadRename: false,
    });
  });

  it("D56: health is ready only where the worker wrote worker.json (the Hermes machine), else not_installed; models are then the placeholder", async () => {
    const health = async (id: number) => providerHealthResultSchema.parse((await call(id, "provider/health", { providerId: PROVIDER_ID })).result);
    expect(await health(1)).toMatchObject({ supported: true, health: { status: "not_installed" } });
    expect((await call(2, "model/list", { cwd })).result).toEqual({ models: [placeholderModel()], selectedOnlyModels: [] });
    // The worker's file, with no bot on and no gateway behind it: still the Hermes machine, so listed.
    writeFileSync(join(dataDir, WORKER_FILE), JSON.stringify({ root: "/nowhere", worker_boot_id: "b", written_at: 1, enabled: [] }));
    expect(await health(3)).toMatchObject({ supported: true, health: { status: "ready" } });
    // Released (the Connection moved away): unlisted again.
    rmSync(join(dataDir, WORKER_FILE));
    expect(await health(4)).toMatchObject({ health: { status: "not_installed" } });
  });

  it("D58: list-here alone lists Hermes as unknown; worker.json wins with ready; neither is not_installed", async () => {
    const health = async (id: number) => providerHealthResultSchema.parse((await call(id, "provider/health", { providerId: PROVIDER_ID })).result).health;
    const workerFile = join(dataDir, WORKER_FILE);
    const listHere = join(dataDir, LIST_HERE_FILE);
    expect(await health(1)).toMatchObject({ status: "not_installed" });
    writeFileSync(listHere, "");
    expect(await health(2)).toMatchObject({ status: "unknown", statusMessage: "Hermes runs on another machine; listed here by list-here." });
    writeFileSync(workerFile, JSON.stringify({ root: "/nowhere", worker_boot_id: "b", written_at: 1, enabled: [] }));
    expect(await health(3)).toMatchObject({ status: "ready", statusMessage: "Hermes runs on this machine." });
    rmSync(listHere);
    rmSync(workerFile);
    expect(await health(4)).toMatchObject({ status: "not_installed" });
  });

  it("thread/start answers and announces pending:<threadId>", async () => {
    const res = await call(1, "thread/start", { threadId: "thr_a", cwd, options: autoMode, instructionMode: "append" });
    expect(res.result).toEqual({ providerThreadId: "pending:thr_a", sessionRestorable: true });
    expect(rpc.messages).toContainEqual({ jsonrpc: "2.0", method: "thread/identity", params: { threadId: "thr_a", providerThreadId: "pending:thr_a" } });
    expect(registryFile().threadId).toBe("thr_a");
  });

  it("thread/resume records the identity and emits nothing else", async () => {
    rpc.takeMessages();
    const res = await call(1, "thread/resume", { threadId: "thr_b", cwd, providerThreadId: "/h/neo#bot", options: autoMode, instructionMode: "append" });
    expect(res.result).toEqual({ providerThreadId: "/h/neo#bot", sessionRestorable: true });
    expect(rpc.takeMessages()).toEqual([res]);
    expect(registryFile().threadId).toBe("thr_b");
  });

  it("thread/stop answers both intents", async () => {
    for (const [id, intent] of [[1, "interrupt"], [2, "release"]] as const) {
      expect((await call(id, "thread/stop", { threadId: "thr_a", providerThreadId: "pending:thr_a", intent, activeTurnId: null })).result).toEqual({});
    }
  });

  it("turn/start without the server's options fails the turn before any Hermes call", async () => {
    await call(1, "thread/start", { threadId: "thr_a", cwd, options: autoMode, instructionMode: "append" });
    rpc.takeMessages();
    const input = [{ type: "text", mentions: [], text: "hi" }];
    const res = await call(2, "turn/start", { threadId: "thr_a", providerThreadId: "pending:thr_a", input, clientRequestId: "creq_abcdefghij", options: autoMode });
    expect(res.result).toEqual({});
    const events = assemble(rpc.takeMessages(), PROVIDER_ID);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["turn/started", "provider/error", "turn/completed"]));
    expect(events.find((e) => e.type === "provider/error")).toMatchObject({ message: NOT_CONNECTED_TEXT });
    expect(events.find((e) => e.type === "turn/completed")).toMatchObject({ status: "failed" });
  });

  it("answers unknown methods and invalid params; ignores the rest", async () => {
    expect((await call(1, "thread/fork", {})).error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND);
    expect((await call(2, "thread/stop", {})).error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS);
    rpc.takeMessages();
    bridge.handleLine("not json");
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "some/notification", params: {} }));
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }));
    await rpc.flushWork();
    expect(rpc.takeMessages()).toEqual([]);
  });
});

describe("build registry", () => {
  it("is written at start and removed at close", () => {
    expect(registryFile()).toMatchObject({ build: "abc123def456", threadId: null });
    expect(registryFile().startedAt).toBeLessThanOrEqual(Date.now());
    bridge.close();
    expect(() => registryFile()).toThrow(/ENOENT/);
  });
});

describe("entry", () => {
  it("importing it starts nothing", async () => {
    const before = rpc.messages.length;
    const { experimental_providerBridge: entry } = await import("./entry.js");
    expect(entry.experimental_apiVersion).toBe(1);
    expect(typeof entry.handleLine).toBe("function");
    expect(rpc.messages.length).toBe(before);
  });
});
