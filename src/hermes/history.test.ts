import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeHermes, type FakeHermes } from "../../test/fake-hermes/index.js";
import { removeDir, tempDir } from "../../test/fake-hermes/wire.js";
import { HistoryError, listSessions, readMessages } from "./history.js";

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../../test/fixtures/rest", `${name}.json`), "utf8"));
const ALL = { order: "recent", archived: "include", limit: 100 } as const;
const PAGE = { order: "oldest", limit: 500 } as const;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fake(opts: Parameters<typeof startFakeHermes>[0]): Promise<FakeHermes> {
  const f = await startFakeHermes(opts);
  cleanups.push(() => f.stop());
  return f;
}

describe("history reader", () => {
  it("reads the list and a transcript over a fresh native-http ticket per request, bound to the profile", async () => {
    const f = await fake({ rest: ["compaction-rotating"] });
    const rec = fixture("compaction-rotating");
    const list = await listSessions(f.folder, "bob", ALL);
    expect(list).toEqual(rec.exchanges[0].body);
    const page = await readMessages(f.folder, "bob", rec.notes.root, PAGE);
    expect(page).toEqual(rec.exchanges[1].body);
    const bob = path.join(f.folder, "profiles/bob");
    expect(f.tickets).toEqual([
      { purpose: "native-http", profile_id: bob, scope: "profile" },
      { purpose: "native-http", profile_id: bob, scope: "profile" },
    ]);
    expect(f.requests).toEqual([]); // no canonical call
  });

  it("fails clearly: unrecorded reads, unserved profiles", async () => {
    const f = await fake({ rest: ["create"], unserved: ["solo"] });
    await expect(readMessages(f.folder, "alex", "nope", PAGE)).rejects.toEqual(new HistoryError(404, "not recorded"));
    await expect(listSessions(f.folder, "solo")).rejects.toMatchObject({ reason: "profile_not_served" });
  });

  it("waits for a gateway that is restarting, then reads", async () => {
    const folder = path.join(tempDir("hist-"), "hermes");
    cleanups.push(() => removeDir(path.dirname(folder)));
    mkdirSync(folder);
    const read = listSessions(folder, "default", ALL, { waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    await fake({ folder, rest: ["default-profile"] });
    expect(await read).toMatchObject({ sessions: [], total: 0 });
  });

  it("gives up after waitMs when no gateway comes", async () => {
    const folder = tempDir("hist-none-");
    cleanups.push(() => removeDir(folder));
    await expect(listSessions(folder, "default", {}, { waitMs: 1500 })).rejects.toMatchObject({ reason: "no_gateway" });
  });
});
