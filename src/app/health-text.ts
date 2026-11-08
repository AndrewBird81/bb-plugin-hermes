// The health line's text, one sentence per `healthStateSchema` state (01 §1).
import type { Health } from "../shared/rpc-contract.js";

export function healthText(health: Health): string {
  const machine = health.machine?.name ?? "the Hermes machine";
  const version = health.version === null ? "Hermes" : `Hermes ${health.version}`;
  switch (health.state) {
    case "not_configured":
      return "Not connected: pick the Hermes machine.";
    case "machine_offline":
      return `Not connected: ${machine} is offline.`;
    case "connecting":
      return `Connecting to Hermes on ${machine}…`;
    case "disconnected":
      return `Not connected to Hermes on ${machine}${health.detail === null ? "." : `: ${health.detail}.`}`;
    case "connected":
      // supported null: no contract file to check against (A51).
      return `Connected to ${version} on ${machine}: ${health.supported === null ? "version unknown" : "supported"}.`;
    case "not_supported":
      return `Connected to ${version} on ${machine}: not supported. Mirroring and import pause; chats from bb keep working.`;
  }
}

/** "Worker last seen …", or null before the worker's first answer. */
export function workerSeenText(health: Health): string | null {
  if (health.worker_last_seen_at === null) return null;
  return `Worker last seen ${new Date(health.worker_last_seen_at).toLocaleString()}.`;
}
