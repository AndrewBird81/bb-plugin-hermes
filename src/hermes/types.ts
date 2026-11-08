// The hermes-gateway-v1 subset bb uses (`apps/shared/src/gateway-contract.openrpc.json` at c314285f07,
// `contract/used-surface.json`). Hand-written: only the fields bb reads are typed; the rest rides as unknown.

export const GATEWAY_PROTOCOL = "hermes-gateway-v1";
export const TICKET_PREFIX = "hermes-gateway-ticket.";
/** Header of a `native-http` REST request (`hermes_cli/dashboard_auth/native_http.py:15`). */
export const NATIVE_HTTP_HEADER = "X-Hermes-Gateway-Ticket";

export interface ServedProfile {
  /** The profile home, as the gateway resolved it. */
  home: string;
  profile_id: string;
}

/** A ready gateway, from `identify` on `<root>/gateway.sock` (`hermes_cli/gateway_runtime.py:100-160`). */
export interface GatewayEndpoint {
  /** `http://127.0.0.1:<ephemeral>`: `/api/ws` and the REST projection. */
  apiOrigin: string;
  /** The served `profile_id` of the root home: host tickets are minted for it. */
  profileId: string;
  instanceId: string;
  authorityEpoch: number;
  /** The root home holding `gateway.sock` (or its `gateway.sock.path` pointer). */
  controlHome: string;
  servedProfiles: ServedProfile[];
  codeVersion: string | null;
  codeSha: string | null;
}

/** What the client dials: URL and subprotocols. The ticket rides as a subprotocol, never in the URL. */
export interface Dial {
  url: string;
  protocols: string[];
}

export interface SessionRef {
  profile_id: string;
  session_id: string;
}

export type AdmissionState = "queued" | "started" | "unknown" | "terminal";

export interface AdmissionStatus {
  admission_id: string;
  ref: SessionRef;
  sequence: number;
  status: AdmissionState;
  outcome: string | null;
  authority_epoch: number;
  execution_generation: number | null;
}

export interface PendingPrompt {
  kind: "approval" | "clarify";
  prompt_id: string;
  execution_generation: number;
  choices: string[];
  command?: string | null;
  description?: string | null;
  question?: string | null;
  multi_select?: boolean | null;
  timeout_s?: number | null;
}

export interface Snapshot {
  session_id: string;
  stored_session_id: string;
  messages: unknown[];
  messages_omitted?: boolean | null;
  message_count: number;
  running: boolean;
  authority_epoch: number;
  replay_epoch: string;
  last_sequence: number;
  subscription_id: string;
  revision: number;
  execution_generation: number;
  pending: (AdmissionStatus & { input_id: string; text: string })[];
  prompts: PendingPrompt[];
  info: Record<string, unknown> & { source?: string | null; model?: string | null; title?: string | null };
}

export interface ReplayEvent {
  type: string;
  session_id: string;
  payload: Record<string, unknown>;
  replay_epoch: string;
  seq: number;
  authority_epoch?: number | null;
  execution_generation?: number | null;
  admission_id?: string | null;
}

/** `params` of a `{"method":"event"}` frame. Session events carry seq/replay_epoch; signals don't. */
export type GatewayEvent = Partial<ReplayEvent> & { type: string; payload?: Record<string, unknown>; replayed?: boolean };

export interface EventsSinceResult {
  events: ReplayEvent[];
  last_sequence: number;
  replay_epoch: string;
  truncated: boolean;
  snapshot_required: boolean;
}

export interface RuntimeDescribe {
  instance_id: string;
  profile_id: string;
  authority_epoch: number;
  capabilities: string[];
  session_create: { sources: string[]; parameters: string[] };
}

export interface SessionListRow {
  session_id: string;
  title: string;
  source: string | null;
  message_count: number;
  running: boolean;
  resolved_id?: string | null;
}

export interface ProfileRow {
  name: string;
  path: string;
  is_default?: boolean;
  model?: string | null;
  provider?: string | null;
  display_name?: string;
  canonical_session?: { id: string; resolved_id: string; title?: string } | null;
}

export interface ControlHandle {
  ref: SessionRef;
  instance_id: string;
  authority_epoch: number;
  revision: number;
  execution_generation: number;
  execution_state: "idle" | "running" | "waiting" | "unknown" | "terminal";
}

export interface CorrectionAck {
  status: "queued" | "redirected" | "rejected";
  text: string;
  execution_generation: number;
  authority_epoch: number;
}

export interface PromptResponse {
  status: "resolved" | "already_resolved";
  prompt_id: string;
}

export interface MutateResult {
  session_id: string;
  operation: string;
  revision: number | null;
}

/** `session.create` params bb sends (02 §Protocol mapping); unknown keys are refused by Hermes. */
export interface CreateParams {
  profile?: string;
  request_id?: string;
  source?: "cli" | "tui" | "gui";
  cwd?: string;
  model?: string;
  provider?: string;
  reasoning?: string;
  title?: string;
  hidden?: boolean;
  follow_profile_config?: boolean;
}

export interface SubmitParams {
  profile?: string;
  session_id: string;
  text: string;
  attachments?: { path: string; mime: string }[];
  submission_id: string;
  turn_author?: { id: string; name: string };
}
