// Settings section (01 §1, T0.10): the Hermes machine picker and the health line. The folder is bb's own
// settings field above this section. The only machine picker in the plugin (01 §1).
import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { HEALTH_CHANNEL, type RpcContract } from "../shared/rpc-contract.js";
import { healthText, workerSeenText } from "./health-text.js";
import { errorText, useLive } from "./live.js";
import { BUTTON, FIELD } from "./styles.js";

type Host = Awaited<ReturnType<PluginBrowserBbSdk["hosts"]["list"]>>[number];

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
  const { value: health, error: healthError, show } = useLive("health", HEALTH_CHANNEL);
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
