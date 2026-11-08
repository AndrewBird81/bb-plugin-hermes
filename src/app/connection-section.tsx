// Settings section (01 §1, T0.10): the Hermes machine picker and the health line. The folder is bb's own
// settings field above this section. The only machine picker in the plugin (01 §1).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  experimental_PluginRpcCallError,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { HEALTH_CHANNEL as HealthChannel, Health, RpcContract } from "../shared/rpc-contract.js";
import { healthText, workerSeenText } from "./health-text.js";

// A value, not an import: the shared module loads zod and the SDK at runtime. The type keeps it in step.
const HEALTH: typeof HealthChannel = "health";

type Host = Awaited<ReturnType<PluginBrowserBbSdk["hosts"]["list"]>>[number];

const FIELD = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const BUTTON = "inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function errorText(cause: unknown): string {
  const error = experimental_PluginRpcCallError.from(cause);
  return error.issues?.length ? error.issues.map((issue) => issue.message).join(" ") : error.message;
}

/** `health`, refetched on the server's signal and when the realtime connection comes back. */
function useHealth() {
  const rpc = useRpc<RpcContract>();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shows only the newest answer (a refetch racing a save).
  const latest = useRef(0);
  const show = useCallback((request: Promise<Health>) => {
    const seq = ++latest.current;
    return request.then((next) => {
      if (seq !== latest.current) return;
      setHealth(next);
      setError(null);
    });
  }, []);
  const refetch = useCallback(() => {
    show(rpc.call("health", null)).catch((cause: unknown) => setError(errorText(cause)));
  }, [show, rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(HEALTH, refetch);
  // Signals aren't replayed: reconcile on every return to "connected" after the first.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection !== "connected") wasConnected.current = false;
    else if (!wasConnected.current) {
      wasConnected.current = true;
      refetch();
    }
  }, [connection, refetch]);
  return { health, error, show };
}

function useHosts() {
  const sdk = useSdk();
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    sdk.hosts.list().then(setHosts, (cause: unknown) => setError(errorText(cause)));
  }, [sdk]);
  return { hosts, error };
}

export function ConnectionSection() {
  const rpc = useRpc<RpcContract>();
  const { health, error: healthError, show } = useHealth();
  const { hosts, error: hostsError } = useHosts();
  const [machine, setMachine] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const id = useId();

  // The picker starts from the saved machine (health's target); an edit is kept until saved.
  const machineValue = machine ?? health?.machine?.id ?? "";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    show(rpc.call("setConnection", { machine: machineValue }))
      .catch((cause: unknown) => setSaveError(errorText(cause)))
      .finally(() => setSaving(false));
  };

  // A saved machine bb no longer lists still shows, so the picker never misreports it.
  const listed = hosts?.some((host) => host.id === machineValue) ?? false;
  const unlisted = machineValue !== "" && !listed ? (health?.machine?.name ?? "Unknown machine") : null;

  return (
    <div className="flex flex-col gap-4 text-sm">
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-machine`} className="font-medium text-foreground">
            Hermes machine
          </label>
          <select
            id={`${id}-machine`}
            aria-describedby={`${id}-machine-hint`}
            className={FIELD}
            value={machineValue}
            disabled={health === null || hosts === null}
            onChange={(event) => setMachine(event.target.value)}
          >
            <option value="">Not connected</option>
            {unlisted !== null && <option value={machineValue}>{unlisted}</option>}
            {hosts?.map((host) => (
              <option key={host.id} value={host.id}>
                {host.status === "connected" ? host.name : `${host.name} (offline)`}
              </option>
            ))}
          </select>
          <p id={`${id}-machine-hint`} className="text-muted-foreground">
            The bb machine that runs Hermes.
          </p>
          {hostsError !== null && <p className="text-destructive">Can't list machines: {hostsError}</p>}
        </div>
        {saveError !== null && (
          <p role="alert" className="text-destructive">
            {saveError}
          </p>
        )}
        <div>
          <button type="submit" className={BUTTON} disabled={saving || health === null}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      <div role="status" className="flex flex-col gap-0.5">
        {health !== null && <p className="text-foreground">{healthText(health)}</p>}
        {health !== null && workerSeenText(health) !== null && <p className="text-muted-foreground">{workerSeenText(health)}</p>}
        {health === null && healthError === null && <p className="text-muted-foreground">Checking the connection…</p>}
        {healthError !== null && <p className="text-destructive">Can't read health: {healthError}</p>}
      </div>
    </div>
  );
}
