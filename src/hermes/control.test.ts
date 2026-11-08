import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlServer, removeDir, tempDir, type ControlAnswer, type ControlServer } from "../../test/fake-hermes/wire.js";
import { ControlError, controlSocketPath, discoverEndpoint, mintTicket } from "./control.js";

const identify = (home: string, over: Record<string, unknown> = {}) => ({
  protocol: 1,
  kind: "hermes-gateway",
  state: "ready",
  runtime_protocol: 1,
  instance_id: "inst1",
  authority_epoch: 7,
  api_origin: "http://127.0.0.1:58355",
  capabilities: ["session-authority-v1", "event-replay-v1"],
  code_version: "0.14.2",
  code_sha: "c314285f07",
  served_profiles: [
    { home, profile_id: home },
    { home: path.join(home, "profiles/alex"), profile_id: path.join(home, "profiles/alex") },
  ],
  ...over,
});
const ok = (result: unknown) => ({ ok: true, protocol: 1, id: 1, result });

let home: string;
let server: ControlServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (home) removeDir(home);
});

async function serve(answer: ControlAnswer, opts?: { pointer?: boolean }) {
  home = tempDir("ctl-");
  server = await controlServer(home, answer, opts);
  return home;
}

describe("discovery", () => {
  it("returns the endpoint, served profiles and code identity", async () => {
    await serve(() => ok(identify(home)));
    expect(await discoverEndpoint(home)).toEqual({
      apiOrigin: "http://127.0.0.1:58355",
      profileId: home,
      instanceId: "inst1",
      authorityEpoch: 7,
      controlHome: home,
      servedProfiles: [
        { home, profile_id: home },
        { home: path.join(home, "profiles/alex"), profile_id: path.join(home, "profiles/alex") },
      ],
      codeVersion: "0.14.2",
      codeSha: "c314285f07",
    });
  });

  it("refuses a draining owner, a missing authority, an unserved root and a non-loopback origin", async () => {
    let over: Record<string, unknown> = { state: "draining" };
    await serve(() => ok(identify(home, over)));
    await expect(discoverEndpoint(home)).rejects.toThrow("not_ready:draining");
    over = { capabilities: ["event-replay-v1"] };
    await expect(discoverEndpoint(home)).rejects.toThrow("session_authority_unavailable");
    over = { served_profiles: [{ home: "/elsewhere", profile_id: "/elsewhere" }] };
    await expect(discoverEndpoint(home)).rejects.toThrow("profile_mismatch");
    for (const api_origin of ["http://10.0.0.2:8000", "http://127.0.0.1:8000/x", "http://127.0.0.1"]) {
      over = { api_origin };
      await expect(discoverEndpoint(home)).rejects.toThrow("invalid_api_origin");
    }
  });

  it("follows the gateway.sock.path pointer when the socket path is too long", async () => {
    await serve(() => ok(identify(home)), { pointer: true });
    expect(existsSync(path.join(home, "gateway.sock"))).toBe(false);
    expect(controlSocketPath(home)).toBe(server!.socketPath);
    expect((await discoverEndpoint(home)).instanceId).toBe("inst1");
  });

  it("refuses a pointer to a socket not named for this home", async () => {
    await serve(() => ok(identify(home)), { pointer: true });
    const other = tempDir("ctl-other-");
    writeFileSync(path.join(other, "gateway.sock.path"), server!.socketPath);
    expect(() => controlSocketPath(other)).toThrow("invalid_control_pointer");
    removeDir(other);
  });

  it("reports no_gateway when nothing listens", async () => {
    home = tempDir("ctl-");
    const err = await discoverEndpoint(home).catch((e) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect(err.reason).toBe("no_gateway");
  });

  it("surfaces the server's refusal string", async () => {
    await serve(() => ({ ok: false, protocol: 1, id: 1, error: "PermissionError: stale runtime instance" }));
    await expect(discoverEndpoint(home)).rejects.toMatchObject({ reason: "PermissionError: stale runtime instance" });
  });
});

describe("tickets", () => {
  it("mints a host-scoped interactive ticket and checks the grant", async () => {
    let grant: Record<string, unknown> = {};
    await serve((req) => (req.verb === "identify" ? ok(identify(home)) : ok(grant)));
    const ep = await discoverEndpoint(home);
    grant = { ticket: "tkt", instance_id: "inst1", profile_id: home, runtime_protocol: 1 };
    expect(await mintTicket(ep, "interactive")).toBe("tkt");
    expect(server!.requests.at(-1)).toEqual({
      protocol: 1,
      id: 1,
      verb: "session-ticket",
      params: { profile_id: home, instance_id: "inst1", purpose: "interactive", scope: "host" },
    });
    grant = { ...grant, instance_id: "other" };
    await expect(mintTicket(ep, "interactive")).rejects.toThrow("bootstrap_identity_changed");
  });

  it("mints a native-http ticket bound to the profile it reads, without a scope", async () => {
    const alex = () => path.join(home, "profiles/alex");
    await serve((req) =>
      req.verb === "identify" ? ok(identify(home)) : ok({ ticket: "rest", instance_id: "inst1", profile_id: req.params?.profile_id, runtime_protocol: 1 }),
    );
    const ep = await discoverEndpoint(home);
    expect(await mintTicket(ep, "native-http", alex())).toBe("rest");
    expect(server!.requests.at(-1)?.params).toEqual({ profile_id: alex(), instance_id: "inst1", purpose: "native-http" });
  });
});
