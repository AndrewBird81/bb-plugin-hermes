// Vendor the part of Hermes' gateway contract bb uses (03 §Strict fake Hermes): the methods in
// contract/used-surface.json and every schema they reference, for the strict fake to validate against.
//   npx tsx contract/vendor.ts [<path to gateway-contract.openrpc.json>]
// Default source: ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json (read only).
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const source = process.argv[2] ?? path.join(os.homedir(), ".hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json");
const out = path.join(here, "../test/fake-hermes/gateway-contract.openrpc.json");

type Json = Record<string, unknown>;
const full = JSON.parse(readFileSync(source, "utf8")) as Json & {
  methods: Json[];
  "x-canonical-methods": Json[];
  components: { schemas: Record<string, Json> };
};
const used = JSON.parse(readFileSync(path.join(here, "used-surface.json"), "utf8")) as {
  canonical: Record<string, string[]>;
  legacy: Record<string, string[]>;
};

const pick = (methods: Json[], names: string[]) =>
  names.map((n) => {
    const m = methods.find((x) => x.name === n);
    if (!m) throw new Error(`${n} is not in ${source}`);
    return m;
  });
const canonical = pick(full["x-canonical-methods"], Object.keys(used.canonical));
const legacy = pick(full.methods, Object.keys(used.legacy));

const schemas: Record<string, Json> = {};
const walk = (v: unknown): void => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (!v || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "$ref" && typeof x === "string") {
      const name = x.split("/").at(-1)!;
      if (schemas[name]) continue;
      schemas[name] = full.components.schemas[name]!;
      walk(schemas[name]);
    } else walk(x);
  }
};
walk([canonical, legacy]);

const subset = {
  openrpc: full.openrpc,
  info: { ...(full.info as Json), "x-subset": "Methods in contract/used-surface.json and the schemas they reference. Regenerate: npx tsx contract/vendor.ts" },
  methods: legacy,
  "x-canonical-methods": canonical,
  components: { schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) },
};
writeFileSync(out, JSON.stringify(subset, null, 2) + "\n");
console.log(`vendored ${canonical.length} canonical + ${legacy.length} legacy methods, ${Object.keys(schemas).length} schemas -> ${path.relative(process.cwd(), out)}`);
