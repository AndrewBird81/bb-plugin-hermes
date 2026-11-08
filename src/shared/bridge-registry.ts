// Bridge build registry (02 §Bridge state): each bridge process writes `bridges/<pid>.json` in its
// dataDir; the worker reads them for `diagnostics` (redeploy check, flow 12). Node-only.
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };

export const BRIDGES_DIR = "bridges";

export const bridgeFileSchema = z
  .object({
    build: z.string(),
    /** null for a bridge that hosts no thread yet (bb's maintenance process for health and models). */
    threadId: z.string().nullable(),
    startedAt: z.number(),
  })
  .strict();
export type BridgeFile = z.infer<typeof bridgeFileSchema>;

const ARTIFACT = /\/plugin-host-artifacts\/[^/]+\/([0-9a-f]{12,})\//;

/**
 * The build a host process runs: `<plugin version>+<digest>`, the digest being the one bb names its
 * artifact directory after (`…/plugin-host-artifacts/<plugin>/<digest>/host.mjs`), cut to 12 characters;
 * `dev` outside an installed artifact. The version is bundled, so a release whose host code is unchanged
 * still reports (and builds) a new artifact, which the redeploy check needs (flow 12, A26). The worker
 * and the bridges share one artifact, so they report the same build.
 */
export function buildFromModuleUrl(moduleUrl: string): string {
  const m = ARTIFACT.exec(decodeURIComponent(moduleUrl));
  return `${pkg.version}+${m?.[1] ? m[1].slice(0, 12) : "dev"}`;
}
