// Bridge build registry (02 §Bridge state): each bridge process writes `bridges/<pid>.json` in its
// dataDir; the worker reads them for `diagnostics` (redeploy check, flow 12). Node-only.
import { z } from "zod";

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
 * The build a host process runs: the content digest bb names its artifact directory after
 * (`…/plugin-host-artifacts/<plugin>/<digest>/host.mjs`), cut to 12 characters. The worker and the
 * bridges share one artifact, so they report the same build. `dev` outside an installed artifact.
 */
export function buildFromModuleUrl(moduleUrl: string): string {
  const m = ARTIFACT.exec(decodeURIComponent(moduleUrl));
  return m?.[1] ? m[1].slice(0, 12) : "dev";
}
