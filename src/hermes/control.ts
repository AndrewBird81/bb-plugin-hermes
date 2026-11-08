// Hermes' control socket (`<root>/gateway.sock`): one JSON line in, one out. Discovery and tickets only:
// nothing here can start, stop or replace a gateway (02 §Placement, r09 M5).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { GatewayEndpoint, ServedProfile } from "./types.js";

const MAX_RESPONSE = 512 * 1024;

export class ControlError extends Error {
  /** A bounded code (`no_gateway`, `not_ready:draining`, …) or Hermes' own refusal string. */
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** The home as Hermes keys it: the real path (`gateway/control_socket.py:212-214`). */
export function canonicalHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}

/**
 * Where to connect for `home` (`resolve_client_socket_path`, `gateway/control_socket.py:122-133`):
 * `gateway.sock`, else the target named by `gateway.sock.path`, written when the direct path is too long
 * for `sun_path`. The target must be `…/hermes-gw-<sha256(home)[:16]>/control.sock`, as Desktop checks
 * (`apps/desktop/electron/local-gateway.ts:598-616`).
 */
export function controlSocketPath(home: string): string {
  const real = canonicalHome(home);
  const direct = path.join(real, "gateway.sock");
  if (existsSync(direct)) return direct;
  let target: string;
  try {
    target = readFileSync(path.join(real, "gateway.sock.path"), "utf8").replace(/^\uFEFF/, "").trim();
  } catch {
    throw new ControlError("no_gateway");
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  if (!path.isAbsolute(target) || path.basename(target) !== "control.sock" || path.basename(path.dirname(target)) !== `hermes-gw-${hash}`) {
    throw new ControlError("invalid_control_pointer");
  }
  if (!existsSync(target)) throw new ControlError("no_gateway");
  return target;
}

/** Send one request to `home`'s control socket; resolve the `result` of an `ok` answer. */
export function controlQuery(home: string, request: object, timeoutMs = 5000): Promise<Record<string, unknown>> {
  let socketPath: string;
  try {
    socketPath = controlSocketPath(home);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    let done = false;
    const finish = (err: Error | null, result?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new ControlError("control_timeout")), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(request) + "\n"));
    sock.on("error", (err: NodeJS.ErrnoException) =>
      finish(new ControlError(err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "no_gateway" : `control_${err.code ?? "error"}`)),
    );
    sock.on("end", () => finish(new ControlError("incomplete_control_response")));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_RESPONSE) return finish(new ControlError("oversized_control_response"));
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let answer: { ok?: unknown; protocol?: unknown; result?: unknown; error?: unknown };
      try {
        answer = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(new ControlError("invalid_control_response"));
      }
      if (answer.ok !== true || answer.protocol !== 1 || !answer.result || typeof answer.result !== "object") {
        // `error` is a bounded server string such as "PermissionError: stale runtime instance".
        return finish(new ControlError(typeof answer.error === "string" ? answer.error.slice(0, 200) : "invalid_control_response"));
      }
      finish(null, answer.result as Record<string, unknown>);
    });
  });
}

/**
 * The ready gateway serving `rootHome`. Mirrors `hermes_cli/gateway_runtime.py:100-160`: runtime protocol 1,
 * state `ready`, `session-authority-v1`, the root listed in `served_profiles`, a loopback `api_origin`.
 */
export async function discoverEndpoint(rootHome: string): Promise<GatewayEndpoint> {
  const id = await controlQuery(rootHome, { protocol: 1, verb: "identify", id: 1 });
  if (id.runtime_protocol !== 1) throw new ControlError("runtime_protocol");
  if (id.state !== "ready") throw new ControlError(`not_ready:${String(id.state).slice(0, 32)}`);
  const caps = id.capabilities;
  if (!Array.isArray(caps) || !caps.includes("session-authority-v1")) throw new ControlError("session_authority_unavailable");
  const served: ServedProfile[] = (Array.isArray(id.served_profiles) ? id.served_profiles : []).filter(
    (p): p is ServedProfile => typeof p?.home === "string" && typeof p?.profile_id === "string" && p.profile_id !== "",
  );
  const want = canonicalHome(rootHome);
  const root = served.find((p) => canonicalHome(p.home) === want);
  if (!root) throw new ControlError("profile_mismatch");
  const origin = id.api_origin;
  if (!isLoopbackOrigin(origin)) throw new ControlError("invalid_api_origin");
  if (typeof id.instance_id !== "string" || !id.instance_id || typeof id.authority_epoch !== "number") {
    throw new ControlError("invalid_runtime_identity");
  }
  return {
    apiOrigin: origin,
    profileId: root.profile_id,
    instanceId: id.instance_id,
    authorityEpoch: id.authority_epoch,
    controlHome: rootHome,
    servedProfiles: served,
    codeVersion: typeof id.code_version === "string" && id.code_version ? id.code_version : null,
    codeSha: typeof id.code_sha === "string" && id.code_sha ? id.code_sha : null,
  };
}

function isLoopbackOrigin(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.port !== "" && u.origin === v
      && (/^127\./.test(u.hostname) || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * Mint a 30 s single-use ticket (`gateway/runtime_bootstrap.py`). `interactive` is host-scoped: one socket
 * drives every served profile (S8 §Per-profile reach). `native-http` is bound to the one profile it reads
 * (`profileId`, a served `profile_id`), as Desktop mints it (`apps/desktop/electron/local-gateway.ts:487`).
 */
export async function mintTicket(
  endpoint: GatewayEndpoint,
  purpose: "interactive" | "native-http",
  profileId = endpoint.profileId,
): Promise<string> {
  const params: Record<string, string> = { profile_id: profileId, instance_id: endpoint.instanceId, purpose };
  if (purpose === "interactive") params.scope = "host";
  const grant = await controlQuery(endpoint.controlHome, { protocol: 1, id: 1, verb: "session-ticket", params });
  if (
    grant.instance_id !== endpoint.instanceId ||
    grant.profile_id !== profileId ||
    grant.runtime_protocol !== 1 ||
    typeof grant.ticket !== "string" ||
    !grant.ticket
  ) {
    throw new ControlError("bootstrap_identity_changed");
  }
  return grant.ticket;
}
