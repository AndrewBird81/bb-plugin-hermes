// A bot's model catalog (01 §4 Composer, 02 §Protocol mapping `model/list`): Hermes' legacy
// `model.options{profile}` normalized once, for the worker (`models`, prewarm, last-known file) and the
// bridge (`model/list`, `bb/provider-model-catalog`, model validation). No Node imports: the app may read it.
import { z } from "zod";

export const catalogModelSchema = z
  .object({
    /** bb's model id: `<provider slug>/<model>`. Slugs hold no `/`; the model may (`parseModelId`). */
    id: z.string(),
    provider: z.string(),
    model: z.string(),
    /** The provider's display name (`openai-codex` → its `name`). */
    provider_label: z.string(),
    /** `capabilities[model].reasoning`: show the reasoning picker. */
    reasoning: z.boolean(),
    /** `capabilities[model].can_disable_reasoning`; null when Hermes doesn't say. */
    can_disable_reasoning: z.boolean().nullable(),
  })
  .strict();
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const catalogSchema = z
  .object({
    profile_home: z.string(),
    /** The bot's current model id (`<provider>/<model>`), the default for new chats; null when Hermes names none. */
    current: z.string().nullable(),
    models: z.array(catalogModelSchema),
    /** Unix ms of the `model.options` answer this came from. */
    fetched_at: z.number(),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;

export function modelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** `<provider>/<model>` → its parts; null for an id with no provider. */
export function parseModelId(id: string): { provider: string; model: string } | null {
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
}

interface ModelOptionsProvider {
  slug?: unknown;
  name?: unknown;
  is_current?: unknown;
  models?: unknown;
  capabilities?: unknown;
}

/**
 * `model.options` (`{providers:[{slug, name, is_current, models[], capabilities{<model>:{reasoning, can_disable_reasoning?}}}], model, provider}`,
 * r11 §1) → a catalog. Unauthenticated or empty providers contribute nothing; unknown fields are ignored.
 */
export function catalogFromModelOptions(
  profileHome: string,
  raw: { providers?: unknown; model?: unknown; provider?: unknown },
  fetchedAt: number,
): Catalog {
  const models: CatalogModel[] = [];
  const providers = Array.isArray(raw.providers) ? (raw.providers as ModelOptionsProvider[]) : [];
  for (const p of providers) {
    if (typeof p?.slug !== "string" || !p.slug || p.slug.includes("/") || !Array.isArray(p.models)) continue;
    const caps = (p.capabilities && typeof p.capabilities === "object" ? p.capabilities : {}) as Record<string, { reasoning?: unknown; can_disable_reasoning?: unknown }>;
    for (const m of p.models) {
      if (typeof m !== "string" || !m) continue;
      const cap = Object.hasOwn(caps, m) ? caps[m] : undefined;
      models.push({
        id: modelId(p.slug, m),
        provider: p.slug,
        model: m,
        provider_label: typeof p.name === "string" && p.name ? p.name : p.slug,
        reasoning: cap?.reasoning === true,
        can_disable_reasoning: typeof cap?.can_disable_reasoning === "boolean" ? cap.can_disable_reasoning : null,
      });
    }
  }
  const current =
    typeof raw.provider === "string" && typeof raw.model === "string" && raw.provider && raw.model ? modelId(raw.provider, raw.model) : null;
  return { profile_home: profileHome, current, models, fetched_at: fetchedAt };
}
