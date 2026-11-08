// The strict fake's chats per profile, through a canonical client on its gateway.sock (never a live folder):
//   npx tsx e2e/fake-sessions.ts [folder] [profiles]
import { HermesClient, localDial } from "../src/hermes/client.js";
const folder = process.argv[2] ?? "/private/tmp/bb-hermes-test/e2e-fake";
if (!folder.startsWith("/private/tmp/bb-hermes-test/")) throw new Error("test folders only");
const c = await HermesClient.connect((await localDial(folder)).dial);
const out: Record<string, unknown> = {};
for (const profile of (process.argv[3] ?? "default,alex,bob").split(",")) {
  out[profile] = (await c.sessionList({ profile, include_hidden: true, scope: "stored", limit: 100 })).sessions.map((s) => ({ id: s.session_id, title: s.title, source: s.source, messages: s.message_count }));
}
console.log(JSON.stringify(out, null, 1));
c.close();
