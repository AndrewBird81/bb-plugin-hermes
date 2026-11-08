// A JSON Schema check for the keywords the vendored contract uses: $ref, type, properties, required,
// additionalProperties, items, anyOf, enum, const. Returns the failing paths (empty = valid).
type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
};

const isType = (v: unknown, t: string): boolean => {
  switch (t) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "null":
      return v === null;
    default:
      return typeof v === t;
  }
};

export function validate(value: unknown, schema: Schema, schemas: Record<string, unknown>, at = ""): string[] {
  const sub = (k: string | number) => (at ? `${at}.${k}` : String(k));
  if (schema.$ref) return validate(value, schemas[schema.$ref.split("/").at(-1)!] as Schema, schemas, at);
  if (schema.anyOf) {
    const options = schema.anyOf.map((s) => validate(value, s, schemas, at));
    return options.some((p) => p.length === 0) ? [] : options.sort((a, b) => a.length - b.length)[0]!;
  }
  const here = [at || "params"];
  if ("const" in schema && value !== schema.const) return here;
  if (schema.enum && !schema.enum.includes(value)) return here;
  if (schema.type && ![schema.type].flat().some((t) => isType(value, t))) return here;
  const out: string[] = [];
  if (isType(value, "object") && (schema.properties || schema.additionalProperties !== undefined || schema.required)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) out.push(sub(k));
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties?.[k];
      if (prop) out.push(...validate(v, prop, schemas, sub(k)));
      else if (schema.additionalProperties === false) out.push(sub(k));
      else if (typeof schema.additionalProperties === "object") out.push(...validate(v, schema.additionalProperties, schemas, sub(k)));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...validate(v, schema.items!, schemas, sub(i))));
  return out;
}
