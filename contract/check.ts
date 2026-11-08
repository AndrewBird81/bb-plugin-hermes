// npm run contract:check [-- <gateway-contract.openrpc.json>]: does this Hermes contract still hold every
// method and param in contract/used-surface.json (flow 11, A51)? Default: the vendored subset.
import { readFileSync } from "node:fs";
import path from "node:path";
import { missingSurface } from "../src/hermes/contract.js";

const here = import.meta.dirname;
const file = process.argv[2] ?? path.relative(process.cwd(), path.join(here, "../test/fake-hermes/gateway-contract.openrpc.json"));
const used = JSON.parse(readFileSync(path.join(here, "used-surface.json"), "utf8"));
const missing = missingSurface(used, JSON.parse(readFileSync(file, "utf8")));
const count = Object.keys(used.canonical).length + Object.keys(used.legacy).length;
if (missing.length) {
  console.error(`contract:check: ${file} lacks ${missing.length}:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`contract:check: ok, ${count} methods and their params in ${file}`);
