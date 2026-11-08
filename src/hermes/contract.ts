// What bb uses of Hermes' gateway contract (flow 11, A51): `contract/used-surface.json` against a
// `gateway-contract.openrpc.json`. Pure: the worker's version check and `npm run contract:check` share it.

export interface UsedSurface {
  canonical: Record<string, string[]>;
  legacy: Record<string, string[]>;
}

interface Method {
  name: string;
  params?: { schema?: { $ref?: string } }[];
}

export interface OpenRpcContract {
  methods?: Method[];
  "x-canonical-methods"?: Method[];
  components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
}

/**
 * The host socket's routing key: Hermes accepts `profile` on every method and strips it before validating
 * the session verbs (`gateway/session_controls.py:96-100, 305-318`), so it isn't in their param schemas.
 */
export const ROUTING_PARAM = "profile";

/**
 * What this contract lacks: `method:<name>` for a missing method (canonical in `x-canonical-methods`,
 * legacy in `methods`), `param:<method>.<param>` for a param its schema doesn't declare.
 */
export function missingSurface(used: UsedSurface, contract: OpenRpcContract): string[] {
  const schemas = contract.components?.schemas ?? {};
  const missing: string[] = [];
  const check = (methods: Method[] | undefined, wanted: Record<string, string[]>) => {
    const byName = new Map((methods ?? []).map((m) => [m.name, m]));
    for (const [name, params] of Object.entries(wanted)) {
      const method = byName.get(name);
      if (!method) {
        missing.push(`method:${name}`);
        continue;
      }
      const ref = method.params?.[0]?.schema?.$ref?.split("/").at(-1);
      const props = (ref && schemas[ref]?.properties) || {};
      for (const p of params) if (p !== ROUTING_PARAM && !(p in props)) missing.push(`param:${name}.${p}`);
    }
  };
  check(contract["x-canonical-methods"], used.canonical);
  check(contract.methods, used.legacy);
  return missing;
}
