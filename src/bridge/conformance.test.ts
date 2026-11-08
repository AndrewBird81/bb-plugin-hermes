// Layer 2 (03): the SDK conformance kit against the bridge driving the strict fake's engine, every scenario
// 03 lists, the turn scenarios included. Placeholder identity at start (A15): `pending:<threadId>`.
import {
  experimental_captureBridgeJsonRpcOutput as captureOutput,
  experimental_formatConformanceReport as formatReport,
  experimental_runBridgeConformance as runConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PROVIDER_ID } from "./provider.js";
import { AUTO, type Rig, startRig, text } from "./testing/harness.js";

let rig: Rig;
beforeEach(async () => {
  rig = await startRig();
  rig.rpc.restore(); // the kit captures stdout itself
});
afterEach(async () => {
  await rig.close();
});

it("passes every conformance scenario on real turns", async () => {
  const output = captureOutput();
  try {
    const report = await runConformance({
      providerId: PROVIDER_ID,
      transport: { send: rig.bridge.handleLine, takeMessages: output.takeMessages },
      timeoutMs: 8000,
      session: {
        cwd: rig.dataDir,
        promptInput: [text("hello")],
        // An empty prompt: nothing reaches Hermes and the turn settles with no activity.
        zeroWorkPromptInput: [text(" ")],
        interruptiblePromptInput: [text(`#slow ${"word ".repeat(40)}`)],
        // The only declared mode (A2, D17), plus the server's provider options for this thread.
        options: { ...AUTO, providerOptions: rig.options("alex") },
      },
    });
    const failed = report.results.filter((r) => r.status !== "pass");
    expect(failed, formatReport(report)).toEqual([]);
    expect(report.results.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "handshake/initialize",
        "session/start-identity",
        "session/start-identity-announced",
        "session/resume-identity",
        "session/resume-id-uniqueness",
        "session/threads-independent",
        "turn/lifecycle",
        "turn/settles-without-activity",
        "stop/interrupt-settles-before-result",
        "stop/release-not-interrupted",
        "events/schema-valid",
        "item/opens-before-delta",
      ]),
    );
  } finally {
    output.restore();
  }
  // Real turns ran: two lifecycle prompts and the interrupted one reached Hermes; the zero-work one didn't.
  expect(rig.requests("prompt.submit").map((r) => r.params.text)).toEqual(expect.arrayContaining(["hello", expect.stringMatching(/^#slow/)]));
  expect(rig.requests("prompt.submit").some((r) => String(r.params.text).trim() === "")).toBe(false);
  expect(rig.requests("session.interrupt").length + rig.requests("prompt.cancel").length).toBeGreaterThan(0);
  expect(rig.fake.violations).toEqual([]);
}, 60_000);
