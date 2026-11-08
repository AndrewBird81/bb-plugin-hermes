import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlServer,
  removeDir,
  snapshot,
  tempDir,
  wsGateway,
  type ControlServer,
  type WsGateway,
  type WsHandler,
} from "../../test/fake-hermes/wire.js";
import { HermesClient, HermesConnection, HermesDisconnectedError, HermesRpcError, RECONNECT_BACKOFF_MS, type ConnectionState } from "./client.js";
import { GATEWAY_PROTOCOL, type GatewayEvent } from "./types.js";

const dial = (g: WsGateway) => ({ url: g.url, protocols: [GATEWAY_PROTOCOL, "hermes-gateway-ticket.t"] });
const ev = (seq: number, type = "message.delta", extra: Record<string, unknown> = {}) => ({
  type,
  session_id: "s1",
  seq,
  replay_epoch: "E1",
  execution_generation: 1,
  payload: { text: `t${seq}` },
  ...extra,
});
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(5);
  }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function gateway(handler: WsHandler, opts?: Parameters<typeof wsGateway>[1]) {
  const g = await wsGateway(handler, opts);
  cleanups.push(() => g.close());
  return g;
}

describe("HermesClient", () => {
  it("connects once gateway.ready arrives and exposes its payload", async () => {
    const g = await gateway(() => ({}));
    const c = await HermesClient.connect(dial(g));
    expect(c.ready).toMatchObject({ session_authority: true });
    c.close();
  });

  it("refuses a server that doesn't select hermes-gateway-v1", async () => {
    const g = await gateway(() => ({}), { echoProtocol: false });
    await expect(HermesClient.connect(dial(g))).rejects.toThrow(/ws_closed/);
  });

  it("maps error frames to HermesRpcError with the bounded reason", async () => {
    const g = await gateway((m) => (m === "session.steer" ? new Error("stale_generation") : {}));
    const c = await HermesClient.connect(dial(g));
    const err = await c.steer({ session_id: "s1", execution_generation: 0, text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesRpcError);
    expect(err).toMatchObject({ reason: "stale_generation", code: 4001 });
    c.close();
  });

  it("rejects in-flight requests as outcome-unknown when the socket drops", async () => {
    const g = await gateway(() => undefined); // never answers
    const c = await HermesClient.connect(dial(g));
    const p = c.submit({ session_id: "s1", text: "hi", submission_id: "bb:t:1" });
    await tick();
    g.sockets[0]!.terminate();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(HermesDisconnectedError);
    expect(err.sent).toBe(true);
    await expect(c.describe()).rejects.toMatchObject({ sent: false });
  });

  it("drops events at or below the session cursor within the same replay epoch", async () => {
    const g = await gateway((m) => (m === "session.resume" ? snapshot("s1", { last_sequence: 5 }) : {}));
    const c = await HermesClient.connect(dial(g));
    const seen: number[] = [];
    c.onEvent((e) => {
      if (e.session_id === "s1") seen.push(e.seq!);
    });
    await c.resume({ session_id: "s1" });
    for (const s of [4, 5, 6, 6, 7]) g.event(g.sockets[0]!, ev(s));
    g.event(g.sockets[0]!, ev(1, "message.delta", { replay_epoch: "E2" })); // a new epoch is never dropped
    await tick();
    expect(seen).toEqual([6, 7, 1]);
    expect(c.cursors.get("s1")).toMatchObject({ replayEpoch: "E2", lastSequence: 1 });
    c.close();
  });

  it("passes signals without seq (sessions.changed) untouched", async () => {
    const g = await gateway(() => ({}));
    const c = await HermesClient.connect(dial(g));
    const seen: GatewayEvent[] = [];
    c.onEvent((e) => seen.push(e));
    g.event(g.sockets[0]!, { type: "sessions.changed", payload: {} });
    g.event(g.sockets[0]!, { type: "sessions.changed", payload: {} });
    await tick();
    expect(seen.map((e) => e.type)).toEqual(["sessions.changed", "sessions.changed"]);
    c.close();
  });

  it("reattach replays the gap, re-subscribes, and never doubles a frame", async () => {
    // The live S4e run: gap 83..89 by events.since, frame 90 pushed before the resume answer.
    let g: WsGateway;
    g = await gateway((m, p, sock) => {
      if (m === "session.events.since") {
        expect(p).toMatchObject({ last_sequence: 82, replay_epoch: "E1" });
        return {
          events: [81, 82, 83, 84, 85, 86, 87, 88, 89].map((s) => ev(s)),
          latest_seq: 89,
          last_sequence: 89,
          epoch: "E1",
          replay_epoch: "E1",
          truncated: false,
          snapshot_required: false,
          count: 9,
        };
      }
      if (m === "session.resume") {
        g.event(sock, ev(89)); // duplicate of the replayed tail
        g.event(sock, ev(90));
        return snapshot("s1", { last_sequence: 90, running: true, subscription_id: "sub2", execution_generation: 3 });
      }
      return {};
    });
    const c = await HermesClient.connect(dial(g));
    const seen: string[] = [];
    c.onEvent((e) => {
      if (e.session_id === "s1") seen.push(`${e.seq}${e.replayed ? "r" : ""}`);
    });
    const r = await c.reattach(undefined, "s1", { replayEpoch: "E1", lastSequence: 82, executionGeneration: 3, subscriptionId: "old", revision: 0 });
    g.event(g.sockets[0]!, ev(90)); // late duplicate of a live frame
    g.event(g.sockets[0]!, ev(91));
    await tick();
    expect(r).toMatchObject({ replayed: 7, snapshotRequired: false });
    expect(seen).toEqual(["83r", "84r", "85r", "86r", "87r", "88r", "89r", "90", "91"]);
    expect(c.cursors.get("s1")).toMatchObject({ lastSequence: 91, subscriptionId: "sub2" });
    c.close();
  });

  it("reattach reports snapshot_required and dispatches nothing from the gap", async () => {
    const g = await gateway((m) => {
      if (m === "session.events.since") {
        return { events: [ev(11)], latest_seq: 400, last_sequence: 400, epoch: "E9", replay_epoch: "E9", truncated: true, snapshot_required: true, count: 0 };
      }
      if (m === "session.resume") return snapshot("s1", { replay_epoch: "E9", last_sequence: 400 });
      return {};
    });
    const c = await HermesClient.connect(dial(g));
    const seen: GatewayEvent[] = [];
    c.onEvent((e) => seen.push(e));
    const r = await c.reattach(undefined, "s1", { replayEpoch: "E1", lastSequence: 10, executionGeneration: 0, subscriptionId: "x", revision: 0 });
    expect(r.snapshotRequired).toBe(true);
    expect(seen).toEqual([]);
    expect(c.cursors.get("s1")).toMatchObject({ replayEpoch: "E9", lastSequence: 400 });
    c.close();
  });
});

// A gateway `home` can restart: a new WS port and instance each time, served through `gateway.sock`.
async function hermesHome() {
  const home = tempDir("conn-");
  cleanups.push(() => removeDir(home));
  let n = 0;
  const live: { g: WsGateway | null; ctl: ControlServer | null; instance: string; state: string } = { g: null, ctl: null, instance: "", state: "ready" };
  const start = async () => {
    n++;
    live.instance = `inst${n}`;
    live.g = await wsGateway(() => ({}));
    live.ctl = await controlServer(home, (req) =>
      req.verb === "identify"
        ? {
            ok: true,
            protocol: 1,
            result: {
              state: live.state,
              runtime_protocol: 1,
              instance_id: live.instance,
              authority_epoch: n,
              api_origin: `http://127.0.0.1:${live.g!.port}`,
              capabilities: ["session-authority-v1"],
              served_profiles: [{ home, profile_id: home }],
            },
          }
        : { ok: true, protocol: 1, result: { ticket: `tkt-${n}-${live.ctl!.requests.length}`, instance_id: live.instance, profile_id: home, runtime_protocol: 1 } },
    );
  };
  const stop = async () => {
    await live.ctl?.close();
    await live.g?.close();
    live.ctl = null;
    live.g = null;
  };
  cleanups.push(stop);
  return { home, live, start, stop };
}

describe("HermesConnection", () => {
  it("rediscovers and mints a new host ticket on every connect, across a gateway restart", async () => {
    const h = await hermesHome();
    await h.start();
    const conn = new HermesConnection(h.home, { backoffMs: [10] });
    cleanups.push(() => conn.stop());
    const states: ConnectionState[] = [];
    conn.onState((s) => states.push(s));
    conn.start();
    await until(() => conn.state === "connected");
    expect(conn.endpoint).toMatchObject({ instanceId: "inst1", authorityEpoch: 1 });
    const first = h.live.g!.tickets[0];
    expect(h.live.ctl!.requests.at(-1)).toMatchObject({ verb: "session-ticket", params: { purpose: "interactive", scope: "host" } });

    await h.stop(); // gateway restart: new port, new instance
    await until(() => conn.state !== "connected");
    expect(conn.lastError).toMatch(/^ws_closed:|^no_gateway$/);
    await h.start();
    await until(() => conn.state === "connected");
    expect(conn.endpoint).toMatchObject({ instanceId: "inst2", authorityEpoch: 2, apiOrigin: `http://127.0.0.1:${h.live.g!.port}` });
    expect(h.live.g!.tickets[0]).not.toBe(first);
    expect(states.slice(0, 3)).toEqual(["connecting", "connected", "disconnected"]);
  });

  it("backs off 1/2/5/10 s and keeps the last delay", async () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 5000, 10_000]);
    const h = await hermesHome();
    h.live.state = "starting"; // answers, but never ready
    await h.start();
    const conn = new HermesConnection(h.home, { backoffMs: [20, 40, 80] });
    cleanups.push(() => conn.stop());
    const at: number[] = [];
    conn.onState((s) => {
      if (s === "connecting") at.push(Date.now());
    });
    conn.start();
    await until(() => at.length >= 5, 2000);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    for (const [i, want] of [20, 40, 80, 80].entries()) expect(gaps[i]).toBeGreaterThanOrEqual(want - 2);
    expect(gaps[3]!).toBeLessThan(160);
    expect(conn.lastError).toBe("not_ready:starting");
    expect(h.live.g!.tickets).toEqual([]); // no ticket while not ready
  });

  it("waits for a missing gateway, then connects; stop ends retries", async () => {
    const h = await hermesHome();
    const conn = new HermesConnection(h.home, { backoffMs: [15] });
    conn.start();
    await until(() => conn.lastError === "no_gateway");
    await h.start();
    await until(() => conn.state === "connected");
    conn.stop();
    expect(conn.state).toBe("stopped");
    await tick(60);
    expect(conn.state).toBe("stopped");
    expect(h.live.ctl!.requests.filter((r) => r.verb === "identify")).toHaveLength(1);
  });
});

describe("never starts a gateway (02 §Placement)", () => {
  it("src/hermes spawns no process", () => {
    const dir = import.meta.dirname;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(/child_process|\bspawn\(|\bexec(File)?\(/);
    }
  });
});
