import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesClient, HermesConnection, HermesRpcError, localDial } from "../../src/hermes/client.js";
import { missingSurface } from "../../src/hermes/contract.js";
import { discoverEndpoint, mintTicket } from "../../src/hermes/control.js";
import { GATEWAY_PROTOCOL, NATIVE_HTTP_HEADER, TICKET_PREFIX } from "../../src/hermes/types.js";
import { CONTRACT_PATH, startFakeHermes, type FakeHermes, type FakeOptions } from "./index.js";
import { validate } from "./schema.js";
import { removeDir, tempDir, TEST_ROOT } from "./wire.js";

const used = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../contract/used-surface.json"), "utf8"));
const vendored = JSON.parse(readFileSync(path.join(import.meta.dirname, "gateway-contract.openrpc.json"), "utf8"));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fake(opts?: FakeOptions): Promise<FakeHermes> {
  const f = await startFakeHermes(opts);
  cleanups.push(() => f.stop());
  return f;
}
async function client(f: FakeHermes): Promise<HermesClient> {
  const c = await HermesClient.connect((await localDial(f.folder)).dial);
  cleanups.push(() => c.close());
  return c;
}
const rpcError = (p: Promise<unknown>) => p.then(() => null, (e: HermesRpcError) => ({ reason: e.reason, data: e.data }));

describe("vendored contract", () => {
  it("holds exactly the methods in used-surface.json, with every param", () => {
    expect(missingSurface(used, vendored)).toEqual([]);
    expect(vendored["x-canonical-methods"].map((m: { name: string }) => m.name)).toEqual(Object.keys(used.canonical));
    expect(vendored.methods.map((m: { name: string }) => m.name)).toEqual(Object.keys(used.legacy));
  });

  it("validates like Hermes: closed objects, $ref, anyOf, enums", () => {
    const schemas = vendored.components.schemas;
    const list = { $ref: "#/components/schemas/CanonicalListParams" };
    expect(validate({ profile: "alex", scope: "stored", limit: 5 }, list, schemas)).toEqual([]);
    expect(validate({ bogus: 1, scope: "nope", limit: 1.5 }, list, schemas).sort()).toEqual(["bogus", "limit", "scope"]);
    expect(validate({ session_id: "s", text: "t", turn_author: { id: "bb:x", name: "bb", extra: 1 } }, { $ref: "#/components/schemas/CanonicalSubmitParams" }, schemas)).toEqual(["turn_author.extra"]);
  });
});

describe("strict fake Hermes", () => {
  it("serves P0 methods for several profiles over a host ticket, each result valid", async () => {
    const f = await fake({ profiles: ["alex", "bob"], unserved: ["solo"] });
    const c = await client(f);
    expect(await c.describe()).toMatchObject({ instance_id: f.instanceId, profile_id: f.folder, authority_epoch: 1 });
    expect((await c.profilesList()).profiles.map((p) => p.name)).toEqual(["default", "alex", "bob"]);
    expect(await c.sessionList({ profile: "alex", title: "Bot Chat", include_hidden: true, scope: "stored", limit: 5 })).toEqual({ sessions: [], scope: "stored" });
    expect((await c.modelOptions("bob")).providers).toHaveLength(1);
    expect(f.requests.map((r) => [r.method, r.profile, r.refused])).toEqual([
      ["runtime.describe", "default", undefined],
      ["profiles.list", "default", undefined],
      ["session.list", "alex", undefined],
      ["model.options", "bob", undefined],
    ]);
    expect(f.violations).toEqual([]);
    expect(f.tickets).toEqual([{ purpose: "interactive", profile_id: f.folder, scope: "host" }]);
    const ep = await discoverEndpoint(f.folder);
    expect(ep.servedProfiles.map((p) => path.basename(p.home))).toEqual([path.basename(f.folder), "alex", "bob"]);
    expect(existsSync(path.join(f.folder, "profiles/solo"))).toBe(true);
    expect(ep).toMatchObject({ codeVersion: "0.22.6", instanceId: f.instanceId, apiOrigin: f.apiOrigin });
  });

  it("refuses what Hermes refuses: unknown keys, unknown methods, unserved profiles", async () => {
    const f = await fake();
    const c = await client(f);
    expect(await rpcError(c.rpc("session.list", { profile: "alex", bogus: 1 }))).toEqual({ reason: "invalid_params", data: { reason: "invalid_params", fields: ["bogus"] } });
    expect(await rpcError(c.rpc("session.list", { profile: "nobody" }))).toMatchObject({ reason: "profile_mismatch" });
    expect(await rpcError(c.rpc("session.archive", {}))).toMatchObject({ reason: "unknown method: session.archive" });
    // `profile` routes, then is stripped before validation, as on a host socket (contract has no `profile` here).
    expect(await rpcError(c.detach({ session_id: "s", subscription_id: "x", end_reason: null }))).toMatchObject({ reason: "not_implemented_in_fake" });
    expect(await rpcError(c.rpc("session.detach", { profile: "alex", session_id: "s", subscription_id: "x", end_reason: null }))).toMatchObject({ reason: "not_implemented_in_fake" });
    expect(f.requests.at(-1)).toMatchObject({ profile: "alex", params: { session_id: "s" } });
  });

  it("only opens /api/ws with a fresh, single-use interactive ticket", async () => {
    const f = await fake();
    const ep = await discoverEndpoint(f.folder);
    const url = f.apiOrigin.replace("http", "ws") + "/api/ws";
    const t = await mintTicket(ep, "interactive");
    await HermesClient.connect({ url, protocols: [GATEWAY_PROTOCOL, TICKET_PREFIX + t] }).then((c) => c.close());
    await expect(HermesClient.connect({ url, protocols: [GATEWAY_PROTOCOL, TICKET_PREFIX + t] })).rejects.toThrow(/ws_closed/);
    await expect(HermesClient.connect({ url, protocols: [GATEWAY_PROTOCOL] })).rejects.toThrow(/ws_closed/);
    const rest = await mintTicket(ep, "native-http");
    await expect(HermesClient.connect({ url, protocols: [GATEWAY_PROTOCOL, TICKET_PREFIX + rest] })).rejects.toThrow(/ws_closed/);
    // Host scope is for interactive tickets only (`gateway/runtime_bootstrap.py:43`).
    const { controlQuery } = await import("../../src/hermes/control.js");
    await expect(
      controlQuery(f.folder, { protocol: 1, id: 1, verb: "session-ticket", params: { profile_id: f.folder, instance_id: f.instanceId, purpose: "native-http", scope: "host" } }),
    ).rejects.toThrow("PermissionError: bootstrap binding rejected");
    await expect(mintTicket({ ...ep, instanceId: "old" }, "interactive")).rejects.toThrow("PermissionError: stale runtime instance");
  });

  it("guards REST with a native-http ticket bound to the profile read", async () => {
    const f = await fake();
    const ep = await discoverEndpoint(f.folder);
    const alex = path.join(f.folder, "profiles/alex");
    const get = async (p: string, headers: Record<string, string>) => {
      const res = await fetch(f.apiOrigin + p, { headers });
      return [res.status, await res.json()];
    };
    expect(await get("/api/sessions?profile=alex", {})).toEqual([401, { detail: "Unauthorized" }]);
    expect(await get("/api/sessions?profile=alex", { [NATIVE_HTTP_HEADER]: await mintTicket(ep, "interactive") })).toEqual([401, { detail: "Unauthorized" }]);
    expect(await get("/api/sessions?profile=bob", { [NATIVE_HTTP_HEADER]: await mintTicket(ep, "native-http", alex) })).toEqual([403, { detail: "profile_scope_mismatch" }]);
    expect(await get("/api/sessions?profile=alex", { [NATIVE_HTTP_HEADER]: await mintTicket(ep, "native-http", alex), Origin: "http://x" })).toEqual([401, { detail: "Unauthorized" }]);
    expect(await get("/api/sessions?profile=alex", { [NATIVE_HTTP_HEADER]: await mintTicket(ep, "native-http", alex) })).toEqual([404, { detail: "not recorded" }]);
  });

  it("restarts with a new port, instance and epoch; the connection follows", async () => {
    const f = await fake();
    const conn = new HermesConnection(f.folder, { backoffMs: [10] });
    cleanups.push(() => conn.stop());
    conn.start();
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
    await until(() => conn.state === "connected");
    const before = { origin: f.apiOrigin, instance: f.instanceId };
    await f.restart();
    expect(f.apiOrigin).not.toBe(before.origin);
    expect(f.instanceId).not.toBe(before.instance);
    expect(f.authorityEpoch).toBe(2);
    await until(() => conn.state === "connected" && conn.endpoint?.instanceId === f.instanceId);
    expect(conn.endpoint).toMatchObject({ apiOrigin: f.apiOrigin, authorityEpoch: 2 });
  });

  it("serves a changed contract on request: it lacks a method and a param we use, and enforces that", async () => {
    const f = await fake();
    const file = path.join(f.folder, CONTRACT_PATH);
    expect(missingSurface(used, JSON.parse(readFileSync(file, "utf8")))).toEqual([]);
    await f.restart({ contract: "changed", codeVersion: "0.23.0" });
    expect(missingSurface(used, JSON.parse(readFileSync(file, "utf8")))).toEqual(["param:prompt.submit.turn_author", "method:session.steer"]);
    expect((await discoverEndpoint(f.folder)).codeVersion).toBe("0.23.0");
    const c = await client(f);
    expect(await rpcError(c.steer({ session_id: "s", execution_generation: 1, text: "x" }))).toMatchObject({ reason: "unknown method: session.steer" });
    expect(await rpcError(c.submit({ session_id: "s", text: "x", submission_id: "bb:t:1", turn_author: { id: "bb:t", name: "bb" } }))).toMatchObject({
      reason: "invalid_params",
      data: { fields: ["turn_author"] },
    });
  });

  it("falls back to gateway.sock.path when the folder's socket path is too long", async () => {
    const folder = path.join(tempDir("long-"), "x".repeat(80));
    cleanups.push(() => removeDir(path.dirname(folder)));
    const f = await fake({ folder });
    expect(existsSync(path.join(f.folder, "gateway.sock"))).toBe(false);
    expect(existsSync(path.join(f.folder, "gateway.sock.path"))).toBe(true);
    expect((await discoverEndpoint(f.folder)).instanceId).toBe(f.instanceId);
  });

  it("refuses a folder outside the test root", async () => {
    await expect(startFakeHermes({ folder: "/private/tmp/elsewhere" })).rejects.toThrow(TEST_ROOT);
  });
});

describe("npm run fake-hermes", () => {
  it("prints its folder and instance_id, serves another process, and removes its socket on SIGTERM", async () => {
    const folder = path.join(tempDir("runner-"), "hermes");
    cleanups.push(() => removeDir(path.dirname(folder)));
    const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "run.ts"), folder], { stdio: ["ignore", "pipe", "inherit"] });
    cleanups.push(() => child.kill("SIGKILL"));
    const line = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d))));
    const info = JSON.parse(line) as { folder: string; instance_id: string; api_origin: string };
    expect(info.folder).toBe(folder);
    const conn = new HermesConnection(folder);
    cleanups.push(() => conn.stop());
    conn.start();
    await new Promise<void>((r) => conn.onState((s) => s === "connected" && r()));
    expect(conn.endpoint?.instanceId).toBe(info.instance_id);
    expect((await conn.client!.describe()).instance_id).toBe(info.instance_id);
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    expect(existsSync(path.join(folder, "gateway.sock"))).toBe(false);
  }, 30_000);
});
