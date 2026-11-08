// Change watch (02 §Contracts signals, r11 §8): `sessions.changed` is only a hint (no profile in it, and
// sibling profiles may be unwatched by Hermes), so the worker also stats each enabled profile's
// `state.db-wal` (and `state.db`) every 2 s, read-only. Both feed one debounced `changed{profile_homes}`.
// Off bots are never stat'ed (02 §Invariants).
import { stat } from "node:fs/promises";
import path from "node:path";

export const STAT_INTERVAL_MS = 2000;
export const CHANGED_DEBOUNCE_MS = 500;

const FILES = ["state.db-wal", "state.db"];

async function signature(dir: string): Promise<string> {
  const parts = await Promise.all(
    FILES.map((f) =>
      stat(path.join(dir, f)).then(
        (s) => `${s.mtimeMs}:${s.size}`,
        () => "-",
      ),
    ),
  );
  return parts.join("|");
}

export interface ChangeWatchOptions {
  intervalMs?: number;
  debounceMs?: number;
}

export class ChangeWatch {
  /** profile home → its folder on this machine. */
  private dirs = new Map<string, string>();
  private readonly sigs = new Map<string, string>();
  private readonly pending = new Set<string>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;

  constructor(
    private readonly onChanged: (profileHomes: string[]) => void,
    private readonly opts: ChangeWatchOptions = {},
  ) {}

  /** The enabled bots to watch. A new one is seeded silently; a removed one is forgotten. */
  async set(dirs: Map<string, string>): Promise<void> {
    this.dirs = new Map(dirs);
    for (const home of [...this.sigs.keys()]) if (!dirs.has(home)) this.sigs.delete(home);
    for (const home of [...this.pending]) if (!dirs.has(home)) this.pending.delete(home);
    await Promise.all([...dirs].filter(([home]) => !this.sigs.has(home)).map(async ([home, dir]) => this.sigs.set(home, await signature(dir))));
    if (dirs.size && !this.poll) {
      this.poll = setInterval(() => void this.tick(), this.opts.intervalMs ?? STAT_INTERVAL_MS);
      this.poll.unref?.();
    } else if (!dirs.size) this.stopPoll();
  }

  /** `sessions.changed`: every watched profile may have changed. */
  hint(): void {
    for (const home of this.dirs.keys()) this.pending.add(home);
    this.schedule();
  }

  close(): void {
    this.stopPoll();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.dirs.clear();
  }

  /** One stat pass (exported for tests through `set` + the interval). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [home, dir] of this.dirs) {
        const sig = await signature(dir);
        const before = this.sigs.get(home);
        this.sigs.set(home, sig);
        if (before !== undefined && before !== sig && this.dirs.has(home)) this.pending.add(home);
      }
      if (this.pending.size) this.schedule();
    } finally {
      this.ticking = false;
    }
  }

  private schedule(): void {
    if (this.flushTimer || !this.pending.size) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const homes = [...this.pending].filter((h) => this.dirs.has(h));
      this.pending.clear();
      if (homes.length) this.onChanged(homes);
    }, this.opts.debounceMs ?? CHANGED_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}
