// The composer (01 §4; 02 §Protocol mapping `model/list`, `thread/start`, attachments): the bot's models from
// Hermes' legacy `model.options` (2 s, else the last-known list; never a session, r09 M6), the one-value bot
// chip, reasoning per model, model validation, and images for `prompt.submit.attachments` (A50).
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AvailableModel, type PromptInput, reasoningEffortsForLevels, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { EnabledBot } from "../shared/bridge-files.js";
import { type Catalog, catalogFromModelOptions, type CatalogModel, parseModelId } from "../shared/models.js";
import { readCatalog, writeCatalog } from "./files.js";
import type { HermesLink } from "./hermes.js";

/** `model/list` waits this long for `model.options`, then answers from the last-known file (A16). */
export const MODEL_OPTIONS_TIMEOUT_MS = 2000;
/** The reasoning choice that leaves Hermes' own level (the bot's config): sent as no `reasoning` at all. */
export const DEFAULT_REASONING = "default";
/**
 * Hermes' efforts with a bb rung, lowest to highest (`hermes_constants.py:1073`; `minimal` has none). Hermes
 * clamps each to what the route takes, never escalating (`agent/reasoning_effort.py:25-42`), and doesn't
 * forward per-model effort lists (`hermes_cli/inventory.py:542-546`), so every model with reasoning offers all.
 */
const HERMES_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** bb rungs Hermes lacks → the nearest lower Hermes level (never escalating). */
const NEAREST: Record<string, string> = { ultracode: "xhigh" };

/**
 * "The bot's model", first and the default of every list (D53): never sent to Hermes (`chooseModel`), so a chat
 * runs its bot's own model unless the user picks one. With the bot's catalog it offers the current model's
 * reasoning. Without one (no bot to ask on this machine, or no bot on) it is a stand-in, so bb resolves a spawn's
 * model (`loadCatalogDefaultForProvider` refuses an empty catalog) and the spawn reaches the plugin's own refusal.
 */
export const PLACEHOLDER_MODEL = "hermes-bot-model";
export function placeholderModel(catalog: Catalog | null = null, sessionOptions?: ReturnType<typeof botOption>[]): AvailableModel {
  const current = currentModel(catalog);
  return {
    id: PLACEHOLDER_MODEL,
    model: PLACEHOLDER_MODEL,
    displayName: "The bot's model",
    description: catalog ? "The model set for the bot in Hermes" : "No Hermes bot to list models from here",
    isDefault: true,
    defaultReasoningEffort: current?.reasoning ? DEFAULT_REASONING : "medium",
    reasoningDiscovery: "known",
    supportedReasoningEfforts: current ? efforts(current) : [],
    ...(sessionOptions ? { sessionOptions } : {}),
  };
}

const currentModel = (catalog: Catalog | null) => catalog?.models.find((m) => m.id === catalog.current) ?? null;

export const unofferedModelText = (asked: string, used: string | null) =>
  `${asked} isn't one of this bot's models in Hermes; ${used ? `using ${used}` : "using the bot's default"}.`;
export const imagesOnlyText = (name: string) => `Hermes takes images only: ${name} not sent.`;

/** The bot's catalog: fresh within `timeoutMs`, else the last-known one; fresh answers are saved. */
export async function fetchCatalog(link: HermesLink, dataDir: string, bot: { profile: string; profile_home: string }, timeoutMs = MODEL_OPTIONS_TIMEOUT_MS): Promise<Catalog | null> {
  const fresh = (async () => {
    const client = await link.client(timeoutMs);
    const raw = await client.modelOptions(bot.profile, timeoutMs);
    const catalog = catalogFromModelOptions(bot.profile_home, raw, Date.now());
    writeCatalog(dataDir, catalog);
    return catalog;
  })();
  const timer = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const won = await Promise.race([fresh.catch(() => null), timer]);
  return won ?? readCatalog(dataDir, bot.profile_home);
}

function efforts(model: CatalogModel) {
  if (!model.reasoning) return [];
  const levels = HERMES_EFFORTS.filter((e) => e !== "none" || model.can_disable_reasoning !== false);
  return [{ reasoningEffort: DEFAULT_REASONING, label: "Default", description: "The bot's own level in Hermes" }, ...reasoningEffortsForLevels([...levels])];
}

/** The bot chip (A52): one value, so the bot is visible and fixed per chat; `values` = the switched-on bots for `model/list`. */
export function botOption(bot: { profile: string; bot_label: string }, values: { profile: string; bot_label: string }[] = [bot]) {
  return {
    id: "profile",
    label: "Bot",
    category: "mode",
    type: "select" as const,
    value: bot.profile,
    values: values.map((b) => ({ id: b.profile, label: b.bot_label })),
  };
}

/** "The bot's model" (the default), then the bot's models. */
export function availableModels(catalog: Catalog | null, sessionOptions?: ReturnType<typeof botOption>[]): AvailableModel[] {
  return [
    placeholderModel(catalog, sessionOptions),
    ...(catalog?.models ?? []).map((m) => ({
      id: m.id,
      model: m.id,
      displayName: m.model,
      description: m.provider_label,
      isDefault: false,
      defaultReasoningEffort: m.reasoning ? DEFAULT_REASONING : "medium",
      reasoningDiscovery: "known" as const,
      supportedReasoningEfforts: efforts(m),
      ...(sessionOptions ? { sessionOptions } : {}),
    })),
  ];
}

/** bb refuses an extension state whose `JSON.stringify` is longer (`EXTENSION_PAYLOAD_MAX_BYTES`, `start-server.js`). */
export const STATE_MAX_BYTES = 64 * 1024;

/**
 * The `bb/provider-model-catalog` payload within `STATE_MAX_BYTES`: bb's schema has no shared ladder, and a big
 * provider's full ladders don't fit. "The bot's model" and the current model first, then the catalog's order, keep
 * theirs while they fit; the rest go `reasoningDiscovery: "unknown"`, which bb fills by asking
 * `model/list{selectedModel}` when one is picked (`refineSelectedModel`). Models that don't fit even so are left
 * out, the last in that order first; the first two never are.
 */
export function catalogState(catalog: Catalog): { models: AvailableModel[]; selectedOnlyModels: [] } {
  const full = availableModels(catalog);
  const kept = (i: number) => full[i]!.id === PLACEHOLDER_MODEL || full[i]!.id === catalog.current;
  const order = [...full.keys()].sort((a, b) => Number(kept(b)) - Number(kept(a)));
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const models: (AvailableModel | null)[] = full.map((m) => (m.supportedReasoningEfforts.length ? { ...m, reasoningDiscovery: "unknown", supportedReasoningEfforts: [] } : m));
  // The array's JSON: its entries, a comma between two, and the wrapper.
  let size = bytes({ models: [], selectedOnlyModels: [] }) + models.reduce((n, m) => n + bytes(m) + 1, -1);
  // Room for the first two's ladders before any other model's.
  const room = order.filter(kept).reduce((n, i) => n + bytes(full[i]) - bytes(models[i]), 0);
  for (const i of [...order].reverse()) {
    if (size + room <= STATE_MAX_BYTES || kept(i)) break;
    size -= bytes(models[i]) + 1;
    models[i] = null;
  }
  for (const i of order) {
    if (!models[i] || models[i] === full[i]) continue;
    const grown = size + bytes(full[i]) - bytes(models[i]);
    if (grown > STATE_MAX_BYTES) break;
    models[i] = full[i]!;
    size = grown;
  }
  return { models: models.filter((m) => m !== null), selectedOnlyModels: [] };
}

/** `bb/session-options` (the chip) and `bb/provider-model-catalog` (S7 1c) for one thread's bot. */
export function composerStates(bot: { profile: string; bot_label: string }, catalog: Catalog | null): ThreadDelta[] {
  const states: ThreadDelta[] = [{ kind: "extension.state", extensionKind: "bb/session-options", payload: { options: [botOption(bot)] } }];
  if (catalog) states.push({ kind: "extension.state", extensionKind: "bb/provider-model-catalog", payload: catalogState(catalog) as never });
  return states;
}

export interface ModelChoice {
  model: string | null;
  provider: string | null;
  /** Hermes' effort; null = the bot's own level. */
  reasoning: string | null;
  warning: string | null;
}

/**
 * The turn's model against the bot's catalog (S7 finding 6): an unoffered one → the bot's current model and a
 * warning; never blocks the turn. No catalog → nothing asked of Hermes (the bot's defaults).
 */
export function chooseModel(catalog: Catalog | null, asked: string | undefined, reasoning: string | undefined): ModelChoice {
  const effort = !reasoning || reasoning === DEFAULT_REASONING ? null : (NEAREST[reasoning] ?? reasoning);
  // The bot's own model, with the picked level if it takes one.
  if (asked === PLACEHOLDER_MODEL) return { model: null, provider: null, reasoning: currentModel(catalog)?.reasoning ? effort : null, warning: null };
  if (!asked || !catalog) return { model: null, provider: null, reasoning: effort, warning: null };
  const offered = catalog.models.find((m) => m.id === asked);
  const pick = offered ?? catalog.models.find((m) => m.id === catalog.current) ?? null;
  const parts = pick ? parseModelId(pick.id) : null;
  return {
    model: parts?.model ?? null,
    provider: parts?.provider ?? null,
    reasoning: pick?.reasoning === false ? null : effort,
    warning: offered ? null : unofferedModelText(asked, pick?.id ?? null),
  };
}

/** Hermes accepts these as `prompt.submit.attachments`, from `<profile home>/cache/images/` only (A50, T1.0). */
const IMAGE_MIMES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const EXT_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export interface Attachments {
  attachments: { path: string; mime: string }[];
  warnings: string[];
}

/** Copy each image into the profile's image cache (a unique name) for `{path, mime}`; anything else warns, the text still goes. */
export function prepareAttachments(parts: readonly PromptInput[], profileHome: string): Attachments {
  const out: Attachments = { attachments: [], warnings: [] };
  const dir = path.join(profileHome, "cache", "images");
  const place = (mime: string, write: (target: string) => void) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `bb-${randomUUID()}${IMAGE_MIMES[mime]}`);
    write(target);
    out.attachments.push({ path: target, mime });
  };
  for (const part of parts) {
    if (part.type === "text") continue;
    if (part.type === "image") {
      const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(part.url);
      if (m && IMAGE_MIMES[m[1]!]) place(m[1]!, (t) => writeFileSync(t, Buffer.from(m[2]!, "base64")));
      else out.warnings.push(imagesOnlyText("an image link"));
      continue;
    }
    const name = part.type === "localFile" ? (part.name ?? path.basename(part.path)) : path.basename(part.path);
    const mime = (part.type === "localFile" ? part.mimeType : undefined) ?? EXT_MIME[path.extname(part.path).toLowerCase()];
    try {
      if (mime && IMAGE_MIMES[mime]) place(mime, (t) => copyFileSync(part.path, t));
      else out.warnings.push(imagesOnlyText(name));
    } catch {
      out.warnings.push(`Couldn't read ${name}; not sent.`);
    }
  }
  return out;
}

/** The enabled bot for a profile home, from the worker's list. */
export const enabledBot = (enabled: readonly EnabledBot[], profileHome: string | null) => enabled.find((b) => b.profile_home === profileHome) ?? null;
