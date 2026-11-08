// Port the recorded canonical frames of `spike/hermes` (`src/hermes/fixtures/*.json`, Hermes c314285f07, live,
// read-only spike S4) into test/fixtures/frames/, redacted, for the strict fake's frame-shape checks:
//   npx tsx test/fixtures/frames/port-spike.ts
// Redaction: the skin, the owner's MCP servers and toolsets, prompts and tool inventories become "<omitted>";
// titles of the owner's own chats become "<title>"; session ids become stable stand-ins of the same shape.
// Everything else stays as recorded.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const SPIKE = ["s4b-create-submit-stream", "s4c-clarify", "s4d-steer-interrupt", "s4e-reconnect-replay", "s4f-viewer-resume", "s4g-mutate", "t1-s4c-acp-editor-mcp-approval"];
const OMIT = new Set(["skin", "mcp_servers", "enabled_toolsets", "tools", "skills", "tool_availability", "tool_availability_warnings", "unknown_toolsets", "system_prompt", "credential_hint", "editor"]);

const ids = new Map<string, string>();
const standIn = (id: string) => ids.get(id) ?? (ids.set(id, "local-" + createHash("sha256").update(`spike-session-${ids.size + 1}`).digest("hex")), ids.get(id)!);
function redact(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\blocal-[0-9a-f]{64}\b/g, standIn);
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => {
      if (OMIT.has(k) && x !== null) return [k, "<omitted>"];
      if ((k === "title" || k === "root_title") && typeof x === "string" && !/^\[bb-spike\]|^Bot Chat$/.test(x)) return [k, "<title>"];
      return [k, redact(x)];
    }),
  );
}

for (const name of SPIKE) {
  const raw = execFileSync("jj", ["file", "show", "-r", "spike/hermes", `src/hermes/fixtures/${name}.json`], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  const frames = (JSON.parse(raw) as { dir: string; frame: unknown }[]).map(({ dir, frame }) => ({ dir, frame: redact(frame) }));
  const out = { $comment: `Ported from spike/hermes src/hermes/fixtures/${name}.json (port-spike.ts), redacted.`, hermes: "c314285f07", frames };
  writeFileSync(path.join(import.meta.dirname, `spike-${name}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`ported ${name}: ${frames.length} frames`);
}
