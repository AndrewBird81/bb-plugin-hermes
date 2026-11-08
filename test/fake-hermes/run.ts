// Standalone strict fake for the isolated-bb e2e (03 §E2E step 5):
//   npm run fake-hermes -- <folder under /private/tmp/bb-hermes-test/> [--changed-contract]
// Serves every REST recording (profiles alex and bob). Prints one JSON line {folder, instance_id, api_origin},
// serves until SIGINT/SIGTERM, then removes its socket.
import { RECORDINGS_LATEST_FIRST, startFakeHermes } from "./index.js";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
if (!folder) {
  console.error("usage: npm run fake-hermes -- <folder> [--changed-contract]");
  process.exit(2);
}
const fake = await startFakeHermes({ folder, contract: args.includes("--changed-contract") ? "changed" : "vendored", rest: RECORDINGS_LATEST_FIRST });
console.log(JSON.stringify({ folder: fake.folder, instance_id: fake.instanceId, api_origin: fake.apiOrigin }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void fake.stop().then(() => process.exit(0)));
}
