// A Conduit-style send on the isolated Hermes served by `bb-e2e.sh hermes`: the dashboard's legacy client opens
// a chat (by id, or the profile's Bot Chat by title) and sends; prints when the send was answered and done.
//   npx tsx e2e/conduit-send.ts <profile> <session_id|"Bot Chat"> <text>
import { readFileSync } from "node:fs";
import { dashboardClient } from "./isolated-hermes.js";
const [profile, target, text] = process.argv.slice(2) as [string, string, string];
const info = JSON.parse(readFileSync("/private/tmp/bb-hermes-test/e2e-bb/hermes.json", "utf8")) as { dashboard_port: number; dashboard_token_file: string };
const d = await dashboardClient(info.dashboard_port, readFileSync(info.dashboard_token_file, "utf8").trim(), "conduit");
const stored = target === "Bot Chat" ? await d.findByTitle(profile, target) : target;
const live = await d.open(profile, stored!);
const t0 = Date.now();
const answer = await d.send(profile, live, text);
console.log(JSON.stringify({ stored, answer: answer.error ?? answer.result, done_after_ms: Date.now() - t0, sent_at: t0 }));
d.close();
