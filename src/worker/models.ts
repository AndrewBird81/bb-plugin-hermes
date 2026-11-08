// Model catalogs (02 §Contracts `models`, A16): `model.options{profile}` takes ~15 s cold (r11 §1), so
// the worker prewarms every enabled bot and keeps the answer: in memory, and as the last-known file
// `bridge-data/models/<hash>.json` the bridge's 2 s `model/list` falls back to.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelsFile, modelsFileSchema } from "../shared/bridge-files.js";
import { catalogFromModelOptions, type Catalog } from "../shared/models.js";

/** A catalog younger than this is fresh; prewarm refreshes older ones (each keep-alive checks). */
export const MODELS_FRESH_MS = 10 * 60_000;
/** A cold `model.options` may take ~15 s; give a background fetch room. */
export const PREWARM_TIMEOUT_MS = 60_000;
/** `models` waits this long for a fetch before answering with the last-known catalog (host RPC: 30 s, retried at 15 s). */
export const MODELS_WAIT_MS = 10_000;

export type ModelOptions = (profileHome: string, timeoutMs: number) => Promise<{ providers?: unknown; model?: unknown; provider?: unknown }>;

export class ModelCache {
  private readonly catalogs = new Map<string, Catalog>();
  private readonly inflight = new Map<string, Promise<Catalog>>();

  constructor(
    private readonly fetchOptions: ModelOptions,
    /** The bridges' dataDir, where last-known catalogs live; null before the first call names it. */
    private readonly dir: () => string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start a background refresh for each bot without a fresh catalog. */
  prewarm(profileHomes: readonly string[]): void {
    for (const home of profileHomes) if (!this.fresh(home)) void this.refresh(home).catch(() => {});
  }

  /** The current catalog: fresh, else what a fetch returns within `waitMs`, else the last-known one. */
  async get(profileHome: string, waitMs = MODELS_WAIT_MS): Promise<Catalog> {
    const fresh = this.fresh(profileHome);
    if (fresh) return fresh;
    const fetching = this.refresh(profileHome);
    const result = await Promise.race([fetching.then((c) => ({ c }), (err: unknown) => ({ err })), sleep(waitMs).then(() => null)]);
    if (result && "c" in result) return result.c;
    const last = this.catalogs.get(profileHome) ?? (await this.readLastKnown(profileHome));
    if (last) return last;
    throw result && "err" in result ? result.err : new Error("models_timeout");
  }

  private fresh(profileHome: string): Catalog | null {
    const c = this.catalogs.get(profileHome);
    return c && this.now() - c.fetched_at < MODELS_FRESH_MS ? c : null;
  }

  /** One fetch per bot at a time; a success replaces the memory and file copies. */
  private refresh(profileHome: string): Promise<Catalog> {
    const running = this.inflight.get(profileHome);
    if (running) return running;
    const p = (async () => {
      const raw = await this.fetchOptions(profileHome, PREWARM_TIMEOUT_MS);
      const catalog = catalogFromModelOptions(profileHome, raw, this.now());
      this.catalogs.set(profileHome, catalog);
      await this.writeLastKnown(catalog).catch(() => {});
      return catalog;
    })().finally(() => this.inflight.delete(profileHome));
    this.inflight.set(profileHome, p);
    return p;
  }

  private async readLastKnown(profileHome: string): Promise<Catalog | null> {
    const dir = this.dir();
    if (!dir) return null;
    try {
      const parsed = modelsFileSchema.safeParse(JSON.parse(await readFile(modelsFile(dir, profileHome), "utf8")));
      return parsed.success && parsed.data.profile_home === profileHome ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async writeLastKnown(catalog: Catalog): Promise<void> {
    const dir = this.dir();
    if (!dir) return;
    const file = modelsFile(dir, catalog.profile_home);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(catalog) + "\n");
    await rename(tmp, file);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
