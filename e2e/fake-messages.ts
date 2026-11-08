// A chat's stored rows on the strict fake, through Hermes' REST projection (src/hermes/history.ts):
//   npx tsx e2e/fake-messages.ts <profile> <session_id> [folder]
import { readMessages } from "../src/hermes/history.js";
const [profile, id, folder = "/private/tmp/bb-hermes-test/e2e-fake"] = process.argv.slice(2);
if (!folder.startsWith("/private/tmp/bb-hermes-test/")) throw new Error("test folders only");
const page = await readMessages(folder, profile!, id!, { order: "oldest", limit: 500 });
for (const m of page.messages) console.log([m.role, m.display_kind ?? "", m.display_metadata?.submission_id ?? "", String(m.content ?? "").slice(0, 80)].join("\t"));
