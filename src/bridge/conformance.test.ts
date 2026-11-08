// Layer 2 (03): the SDK conformance kit, for the scenarios the skeleton supports. Turn scenarios
// (zero-work, interrupt, threads-independent) need real turns and wait for P1 (T1.1).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimental_captureBridgeJsonRpcOutput as captureOutput,
  experimental_formatConformanceReport as formatReport,
  experimental_runBridgeConformance as runConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { expect, it } from "vitest";
import { createBridge } from "./bridge.js";
import { PROVIDER_ID } from "./provider.js";

it("passes the conformance scenarios the skeleton supports", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-hermes-test-"));
  const bridge = createBridge("dev");
  bridge.start(dataDir);
  const output = captureOutput();
  try {
    const report = await runConformance({
      providerId: PROVIDER_ID,
      transport: { send: bridge.handleLine, takeMessages: output.takeMessages },
      session: {
        cwd: dataDir,
        promptInput: [{ type: "text", mentions: [], text: "hello" }],
        // The only declared mode (A2, D17).
        options: { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" },
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
        "turn/lifecycle",
        "events/schema-valid",
        "item/opens-before-delta",
        "stop/release-not-interrupted",
      ]),
    );
  } finally {
    output.restore();
    bridge.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
