// Cross-check on an isolated Hermes only: e2e/eligibility (state.db) against the same rules applied to Hermes' REST
// projection as the plugin reads it (src/worker/sessions.ts, src/shared/sources.ts; bb-created by a `bb:` first
// submission). Prints both counts and every chat one side has and the other lacks; exits 1 on a difference.
//   npx tsx e2e/checks/eligibility-rest.ts <folder under /private/tmp/bb-hermes-test/> <profile> [since unix s]
import { readMessages } from "../../src/hermes/history.js";
import { BOT_CHAT_TITLE, eligibility } from "../../src/shared/sources.js";
import { listProfileSessions } from "../../src/worker/sessions.js";
import { count } from "../eligibility.js";

const [folder, profile, sinceArg] = process.argv.slice(2) as [string, string, string?];
if (!folder?.startsWith("/private/tmp/bb-hermes-test/") || !profile) {
  console.error("usage: npx tsx e2e/checks/eligibility-rest.ts </private/tmp/bb-hermes-test/…> <profile> [since]");
  process.exit(2);
}
const since = sinceArg ? Number(sinceArg) : Math.floor(Date.now() / 1000) - 30 * 86_400;
const db = count({ folder, profile, since, list: true });
const rest: string[] = [];
for (const row of await listProfileSessions(folder, profile, since * 1000)) {
  if (row.title === BOT_CHAT_TITLE) continue;
  const first = (await readMessages(folder, profile, row.session_id, { order: "oldest", limit: 1 })).messages.find((m) => m.role === "user");
  const bbCreated = String(first?.display_metadata?.submission_id ?? "").startsWith("bb:");
  if (eligibility(row, { bbCreated, tombstoned: false }).kind === "chat") rest.push(row.lineage_root);
}
const fromDb = db.chats!.map((c) => c.lineage_root);
const onlyDb = fromDb.filter((id) => !rest.includes(id));
const onlyRest = rest.filter((id) => !fromDb.includes(id));
console.log(JSON.stringify({ profile, since, eligibility: db.would_import, rest: rest.length, only_eligibility: onlyDb, only_rest: onlyRest, out: db.out }));
process.exit(onlyDb.length || onlyRest.length ? 1 : 0);
