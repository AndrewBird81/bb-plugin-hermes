#!/usr/bin/env node
// A thread's bb event log, one line per event (seq, time, type, data), from `e2e/sbb thread log <id> --json`:
//   node e2e/tlog.mjs <thread> [type-regex]
import { execFileSync } from "node:child_process";
const [thread, filter] = process.argv.slice(2);
const events = JSON.parse(execFileSync(new URL("./sbb", import.meta.url).pathname, ["thread", "log", thread, "--json", "--all"], { encoding: "utf8", maxBuffer: 64 << 20 }));
const t0 = events[0]?.createdAt ?? 0;
for (const e of events) {
  if (filter && !new RegExp(filter).test(e.type + " " + JSON.stringify(e.data))) continue;
  console.log(`${e.seq}\t+${((e.createdAt - t0) / 1000).toFixed(1)}s\t${e.type}\t${JSON.stringify(e.data).slice(0, 220)}`);
}
