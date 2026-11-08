/**
 * The strict fake's session engine (03 §Strict fake Hermes): a stateful Hermes for the behaviours bb's bridge,
 * worker and e2e depend on. Shapes come from Hermes c314285f07: the recorded frames in test/fixtures/frames/
 * (ported from `spike/hermes` `src/hermes/fixtures/`), the REST recordings in test/fixtures/rest/ and its source
 * (`gateway/session_controls.py`, `gateway/session_authority.py`, `gateway/session_events.py`,
 * `gateway/session_pending_controls.py`, `hermes_state_runtime.py`, `gateway/session_mutations.py`).
 *
 * Corrected by the T1.0 recordings (test/fixtures/frames/*.json): attachments, `/new` `/reset` `/approve` as text,
 * the lost turn after a restart, forwarded dashboard sends, change signals.
 *
 * Per profile: sessions (canonical and legacy rows), messages with `message_uid`s, a FIFO of admissions per
 * session, `revision`, `execution_generation`, a replay ring (512 frames) per session, subscriptions per socket.
 * REST rows are clones of a recorded row of the same kind with the values filled in (`restRow`, `restMessage`):
 * every engine REST row has exactly a recorded row's key set.
 *
 * The stub model echoes like `test/fixtures/rest/record.ts`'s: `echo(<context size>): <text>`. Words in the
 * prompt script a turn (reachable from bb's composer in e2e): `#slow` streams slowly, `#tool` calls read_file,
 * `#approval` / `#edit` raise an approval before the tool runs, `#clarify` asks, `#think` streams reasoning,
 * `#fail` fails the turn. `nextTurn(profile, script)` scripts the next turn of a profile instead.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { FakeProfile, Handler } from "./index.js";
import { Refusal } from "./index.js";

type Json = Record<string, unknown>;
const hex = (n = 16) => randomBytes(n).toString("hex");
const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise<void>((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

/** Hermes' per-session replay ring (`tui_gateway/event_replay.py` `_REPLAY_BUFFER_MAX`). */
export const REPLAY_BUFFER_MAX = 512;
/** `gateway/session_queued_controls.py`: queued-row verbs, for plain text rows of interactive-surface rows only. */
const QUEUE_CONTROLS = ["steer", "replace"];
const INTERACTIVE_SOURCES = new Set(["cli", "tui", "gui", "desktop", "acp"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Text commands the gateway answers itself, not stored (T1.0 slash-new.json, A46). */
const CONFIRM_NEW =
  "⚠️ **Confirm /new**\n\nThis starts a fresh session and discards the current conversation history.\n\nChoose:\n• **Approve Once** — proceed this time only\n• **Always Approve** — proceed and silence this prompt permanently\n• **Cancel** — keep current conversation\n\n_Text fallback: reply `/approve`, `/always`, or `/cancel`._";
const COMMAND_REPLIES: Record<string, string> = { "/new": CONFIRM_NEW, "/reset": CONFIRM_NEW, "/approve": "No pending command to approve." };
/** The note Hermes stores for a turn `prompt.resolve_unknown` discards (T1.0 restart-unknown.json). */
const LOST_TURN = "This turn did not complete. Some actions may already have run; verify their effects before resending.";
const STEER_WRAP = (t: string) =>
  `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\n${t}\n[/OUT-OF-BAND USER MESSAGE]`;
const WAITING = "⏳ Another Hermes process is using this session; waiting for it to finish before starting your turn...";
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

// ---- recorded REST shapes (R5 C6: shapes recorded, values filled)
const RECORDINGS = path.join(import.meta.dirname, "../fixtures/rest");
const recording = (name: string) => JSON.parse(readFileSync(path.join(RECORDINGS, `${name}.json`), "utf8")) as { exchanges: { path: string; body: Json }[] };
const listOf = (name: string) => recording(name).exchanges.find((x) => x.path === "/api/sessions")!.body as { sessions: Json[] } & Json;
const pageOf = (name: string, i = 0) => recording(name).exchanges.filter((x) => x.path.endsWith("/messages"))[i]!.body as { messages: Json[] } & Json;
export const TEMPLATES = {
  listPage: { ...listOf("default-profile"), sessions: [] } as Json,
  messagesPage: { ...pageOf("create"), messages: [] } as Json,
  row: listOf("create").sessions[0]!,
  legacyRow: listOf("legacy").sessions.find((s) => s.source === "desktop")!,
  tipRow: listOf("compaction-rotating").sessions[0]!,
  user: pageOf("create").messages[0]!,
  assistant: pageOf("create").messages[1]!,
  toolCall: pageOf("steer").messages[3]!,
  tool: pageOf("steer").messages[4]!,
  steer: pageOf("steer").messages[5]!,
  hiddenCarrier: pageOf("compaction-rotating").messages.find((m) => m.display_kind === "hidden")!,
  inPlaceCarrier: pageOf("compaction-in-place", 1).messages.find((m) => "display_content" in m)!,
};
/** A clone of a recorded row with these values; a key the recording lacks is a bug in the engine. */
function fill(template: Json, values: Json): Json {
  const out = structuredClone(template);
  for (const [k, v] of Object.entries(values)) {
    if (!(k in out)) throw new Error(`fake REST row: no recorded key ${k}`);
    out[k] = v;
  }
  return out;
}

// ---- state
export interface TurnScript {
  /** The reply text; default `echo(<context size>): <prompt>`. */
  reply?: string;
  /** Delay between streamed chunks (ms). */
  chunkMs?: number;
  /** Streamed reasoning before the reply (`reasoning.delta`). */
  reasoning?: string;
  /** A read_file tool call before the reply. */
  tool?: boolean;
  /** An approval before the tool runs (Hermes' choices: a command gets once/deny/session/always, an edit once/deny). */
  approval?: { kind?: "command" | "edit"; timeout_s?: number };
  /** A clarify before the reply (600 s by default, as Hermes). */
  clarify?: { question?: string; choices?: string[]; timeout_s?: number };
  /** The turn fails with this error. */
  fail?: string;
  /** Hold the turn this long (ms) after its start, before any output. */
  holdMs?: number;
}

export interface Row extends Json {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  message_uid: string;
  timestamp: number;
  active: number;
  compacted: number;
}

export interface Admission {
  admission_id: string;
  request_id: string;
  session: Session;
  sequence: number;
  status: "queued" | "started" | "unknown" | "terminal";
  outcome: string | null;
  generation: number | null;
  text: string;
  digest: string;
  submission_id: string | null;
  display_kind: string | null;
  attachments: Json[] | null;
  turn_author: Json | null;
  script: TurnScript;
  /** The user row, once the turn flushed it (at its start). */
  userRow?: Row;
}

interface Prompt {
  prompt: Json;
  resolve: (answer: string | null) => void;
}

interface Turn {
  admission: Admission;
  generation: number;
  interrupted: boolean;
  aborted: boolean;
  steers: string[];
  wake: () => void;
}

export interface Session {
  id: string;
  profile: FakeProfile;
  title: string | null;
  hidden: boolean;
  archived: boolean;
  /** `local` for gateway rows (the surface in `created_source`), `desktop` for a dashboard (Conduit) row. */
  source: string;
  created_source: string;
  /** The lineage root; null on a legacy row until a resume adopts it. */
  chat_id: string | null;
  cwd: string | null;
  model: string;
  provider: string;
  reasoning: string | null;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
  end_reason: string | null;
  rows: Row[];
  parent: Session | null;
  tip: Session | null;
  revision: number;
  generation: number;
  queue: Admission[];
  running: Turn | null;
  epoch: string;
  seq: number;
  ring: Json[];
  subscribers: Map<WebSocket, string>;
  prompts: Map<string, Prompt>;
  /** The dashboard holds a claim on this not-yet-adopted row (`runtime_coordination_required`). */
  held: boolean;
  /** A dashboard (Conduit) turn holds the turn lease: canonical turns wait. */
  lease: Promise<void> | null;
  mounted: boolean;
}

export interface EngineHooks {
  instanceId(): string;
  authorityEpoch(): number;
  sockets(): Iterable<WebSocket>;
  /** Hermes seconds in ms, for prompt deadlines (tests shorten it). */
  secondMs: number;
  /** Profiles with `compression.in_place: false`. */
  rotating: Set<string>;
  /** Engine failures (a bug in the fake) land in `fake.violations`. */
  violations: string[];
}

export class Engine {
  readonly sessions = new Map<string, Session[]>();
  private rowId = 0;
  private sequence = 0;
  private scripts = new Map<string, TurnScript[]>();
  private replayCursors = new Map<WebSocket, Map<string, number>>();
  private uid = process.getuid?.() ?? 0;

  constructor(private readonly hooks: EngineHooks) {}

  // ---- lookups
  private all(p: FakeProfile): Session[] {
    let list = this.sessions.get(p.home);
    if (!list) this.sessions.set(p.home, (list = []));
    return list;
  }
  private find(p: FakeProfile, id: string): Session | undefined {
    return this.all(p).find((s) => s.id === id);
  }
  /** Any id of a chain → its tip (a rotated chain resolves to its newest segment, S8 E8). */
  tipOf(s: Session): Session {
    while (s.tip) s = s.tip;
    return s;
  }
  rootOf(s: Session): Session {
    while (s.parent) s = s.parent;
    return s;
  }
  session(p: FakeProfile, id: string): Session | undefined {
    const s = this.find(p, id);
    return s && this.tipOf(s);
  }
  private require(p: FakeProfile, id: unknown): Session {
    const s = typeof id === "string" ? this.session(p, id) : undefined;
    if (!s) throw new Refusal("not_found");
    return s;
  }
  private legacy(s: Session) {
    return s.chat_id === null;
  }
  /** The session holding this title: a hidden one included, the newest first (`resolve_titled_session`). */
  private titled(p: FakeProfile, title: string): Session | undefined {
    return this.all(p).filter((s) => !s.tip && s.title === title).sort((a, b) => b.started_at - a.started_at)[0];
  }
  private chainRows(s: Session): Row[] {
    const segs: Session[] = [];
    for (let x: Session | null = this.rootOf(s); x; x = x.tip) segs.push(x);
    return segs.flatMap((x) => x.rows);
  }
  private ref(s: Session) {
    return { profile_id: s.profile.home, session_id: s.id };
  }

  // ---- events
  private send(sock: WebSocket, params: Json) {
    if (sock.readyState === 1) sock.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  }
  /** Publish on a session's stream: stamped, sequenced, kept in the ring, sent to its subscribers. */
  private publish(s: Session, type: string, payload: Json, stamp: Json = {}) {
    const frame = { ...stamp, type, session_id: s.id, payload: structuredClone(payload), replay_epoch: s.epoch, seq: ++s.seq };
    s.ring.push(frame);
    if (s.ring.length > REPLAY_BUFFER_MAX) s.ring.shift();
    for (const sock of s.subscribers.keys()) this.send(sock, frame);
  }
  private stamp(s: Session, a: Admission): Json {
    return { authority_epoch: this.hooks.authorityEpoch(), execution_generation: a.generation, admission_id: a.admission_id };
  }
  /**
   * A `state.db-wal` touch under the profile home (02 flow 6). `sessions.changed` reaches canonical sockets only
   * for the root profile's gateway writes: the T1.0 recordings (secondary profiles) show none, not even for a
   * dashboard turn (WAL only); the live spike S4 (root profile) shows it after each turn.
   */
  changed(p: FakeProfile, opts: { dashboard?: boolean } = {}) {
    appendFileSync(path.join(p.home, "state.db-wal"), "x");
    if (p.name !== "default" || opts.dashboard) return;
    for (const sock of this.hooks.sockets()) this.send(sock, { type: "sessions.changed", session_id: "", payload: {} });
  }
  private pendingEntry(a: Admission): Json {
    return {
      ...this.admissionStatus(a),
      input_id: a.request_id,
      text: a.text,
      controls:
        a.status === "queued" && !a.turn_author && !a.attachments && a.display_kind !== "hidden" && a.text.trim() && INTERACTIVE_SOURCES.has(a.session.source) ? QUEUE_CONTROLS : [],
      steering: false,
    };
  }
  private pending(s: Session) {
    return s.queue.filter((a) => a.status !== "terminal").map((a) => this.pendingEntry(a));
  }
  private publishInfo(s: Session, stamp: Json = {}) {
    this.publish(
      s,
      "session.info",
      {
        stored_session_id: s.id,
        pending: this.pending(s),
        authority_epoch: this.hooks.authorityEpoch(),
        desktop_protocol: "hermes-gateway-v1",
        running: !!s.running,
        execution_generation: s.generation,
        revision: s.revision,
      },
      stamp,
    );
  }
  admissionStatus(a: Admission): Json {
    return {
      admission_id: a.admission_id,
      ref: this.ref(a.session),
      sequence: a.sequence,
      status: a.status,
      outcome: a.outcome,
      authority_epoch: this.hooks.authorityEpoch(),
      execution_generation: a.generation,
    };
  }

  // ---- sessions
  private newSession(p: FakeProfile, id: string, over: Partial<Session>): Session {
    const t = now();
    const s: Session = {
      id,
      profile: p,
      title: null,
      hidden: false,
      archived: false,
      source: "local",
      created_source: "cli",
      chat_id: id,
      cwd: null,
      model: "stub",
      provider: "stub",
      reasoning: null,
      started_at: t,
      last_activity_at: t,
      ended_at: null,
      end_reason: null,
      rows: [],
      parent: null,
      tip: null,
      revision: 0,
      generation: 0,
      queue: [],
      running: null,
      epoch: hex(),
      seq: 0,
      ring: [],
      subscribers: new Map(),
      prompts: new Map(),
      held: false,
      lease: null,
      mounted: false,
      ...over,
    };
    this.all(p).push(s);
    return s;
  }

  private snapshot(s: Session, sock: WebSocket, omit: boolean): Json {
    const subscription_id = hex();
    s.subscribers.set(sock, subscription_id);
    s.mounted = true;
    // A reconnect's `session.events.since` then `session.resume`: frames published in between follow at once
    // (`SessionEvents.catch_up`).
    const cursor = this.replayCursors.get(sock)?.get(s.id);
    this.replayCursors.get(sock)?.delete(s.id);
    if (cursor !== undefined) for (const f of s.ring) if ((f.seq as number) > cursor) this.send(sock, f);
    const rows = this.chainRows(s).filter((r) => r.active);
    return {
      session_id: s.id,
      stored_session_id: s.id,
      messages: omit ? [] : rows.map((r) => ({ role: r.role, content: r.content, timestamp: r.timestamp, row_id: r.id, display_kind: r.display_kind ?? null, display_metadata: r.display_metadata ?? null })),
      ...(omit ? { messages_omitted: true } : {}),
      message_count: rows.length,
      todo_state: null,
      running: !!s.running,
      authority_epoch: this.hooks.authorityEpoch(),
      replay_epoch: s.epoch,
      last_sequence: s.seq,
      subscription_id,
      revision: s.revision,
      execution_generation: s.generation,
      pending: this.pending(s),
      prompts: [...s.prompts.values()].map((p) => p.prompt),
      info: {
        desktop_protocol: "hermes-gateway-v1",
        // An adopted dashboard row resumes as `gui` on the wire (S8 E10).
        source: s.source === "desktop" ? "gui" : s.created_source,
        model: s.model,
        provider: s.provider,
        profile_id: s.profile.home,
        profile_name: s.profile.name,
        cwd: s.cwd,
        title: s.title,
        reasoning_effort: s.reasoning ?? "medium",
        started_at: s.started_at,
        last_active_at: s.last_activity_at,
        version: "0.22.6",
      },
      pending_connection: null,
      open_requests: [],
    };
  }

  /** `session.resume` adopts a legacy row once (r12 §6): it keeps `source`, gains a `chat_id` (`bind_legacy_target`). */
  private adopt(s: Session) {
    if (!this.legacy(s)) return;
    if (s.held || s.lease) throw new Refusal("runtime_coordination_required");
    s.chat_id = s.id;
    this.changed(s.profile);
  }

  // ---- methods
  handlers(): Record<string, Handler> {
    return {
      "session.create": (params, { profile, socket }) => {
        const title = typeof params.title === "string" ? params.title : null;
        const existing = title ? this.titled(profile, title) : undefined;
        if (existing) {
          // A titled create returns the session that holds the title (S8 E1); a held legacy one is refused (E6).
          if (this.legacy(existing) && (existing.held || existing.lease)) throw new Refusal("runtime_coordination_required");
          return this.snapshot(existing, socket, false);
        }
        const request = typeof params.request_id === "string" ? params.request_id : hex();
        // `hermes_state_keys.local_identity`: deterministic per (profile_id, principal, request_id).
        const id = "local-" + createHash("sha256").update(JSON.stringify([profile.home, `uid:${this.uid}`, request])).digest("hex");
        const known = this.find(profile, id);
        if (known) return this.snapshot(this.tipOf(known), socket, false);
        const s = this.newSession(profile, id, {
          title,
          hidden: params.hidden === true,
          created_source: (params.source as string | undefined) ?? "cli",
          cwd: (params.cwd as string | null | undefined) ?? null,
          model: (params.model as string | null | undefined) ?? "stub",
          provider: (params.provider as string | null | undefined) ?? "stub",
          reasoning: (params.reasoning as string | null | undefined) ?? null,
        });
        this.changed(profile);
        return this.snapshot(s, socket, false);
      },

      "session.list": (params, { profile }) => {
        const limit = (params.limit as number | undefined) ?? 200;
        if (limit < 1 || limit > 200 || ("title" in params && "scope" in params)) throw new Refusal("invalid_params");
        if (typeof params.title === "string") {
          const s = this.titled(profile, params.title);
          if (!s) return { sessions: [], scope: "stored" };
          if (this.legacy(s) && (s.held || s.lease)) throw new Refusal("runtime_coordination_required");
          return {
            sessions: [{ session_id: s.id, id: s.id, resolved_id: s.id, title: s.title ?? "", root_title: s.title ?? "", source: s.source, started_at: s.started_at, message_count: this.count(s), running: s.mounted }],
            scope: "stored",
          };
        }
        const stored = params.scope === "stored";
        const rows = this.all(profile)
          .filter((s) => !s.tip && (stored || s.mounted) && (params.include_hidden || !(s.hidden || s.archived)))
          .sort((a, b) => b.started_at - a.started_at)
          .slice(0, limit)
          .map((s) => ({ id: s.id, session_id: s.id, resolved_id: s.id, title: s.title ?? "", source: s.source, started_at: s.started_at, message_count: this.count(s), model: s.model, running: !!s.running }));
        return { sessions: rows, scope: stored ? "stored" : "live" };
      },

      "session.resume": (params, { profile, socket }) => {
        const s = typeof params.title === "string" ? this.titled(profile, params.title) : this.session(profile, params.session_id as string);
        if (!s) throw new Refusal("not_found");
        this.adopt(s);
        return this.snapshot(s, socket, params.omit_messages === true);
      },

      "session.detach": (params, { profile, socket }) => {
        const result = { session_id: params.session_id, subscription_id: params.subscription_id, detached: false };
        const s = this.find(profile, params.session_id as string);
        if (!s || s.subscribers.get(socket) !== params.subscription_id) return result;
        s.subscribers.delete(socket);
        // A reason ends the idle row once no viewer is left; `end_reason: null` is only a viewer leaving (A24).
        if (typeof params.end_reason === "string" && !s.subscribers.size && !s.running) {
          s.ended_at = now();
          s.end_reason = params.end_reason;
          this.changed(profile);
        }
        return { ...result, detached: true };
      },

      "prompt.submit": (params, { profile, socket }) => this.submit(profile, socket, params),

      "prompt.cancel": (params, { profile }) => {
        const s = this.require(profile, params.session_id);
        const a = s.queue.find((x) => x.admission_id === params.admission_id) ?? this.terminal.get(params.admission_id as string);
        if (!a || a.session !== s) throw new Refusal("not_found");
        if (a.status === "unknown") throw new Refusal("unknown_execution");
        if (a.status === "started") {
          this.interruptTurn(s);
          return this.admissionStatus(a);
        }
        if (a.status === "queued") {
          this.settle(s, a, "cancelled");
          // A queued row owns no generation: its completion carries its own identity only (`_settle_cancelled`).
          this.publish(s, "message.complete", { text: "", content: "", admission_id: a.admission_id, outcome: "cancelled" }, { authority_epoch: this.hooks.authorityEpoch(), admission_id: a.admission_id });
          this.publishInfo(s);
        }
        return this.admissionStatus(a);
      },

      "prompt.resolve_unknown": (params, { profile }) => {
        const s = this.require(profile, params.session_id);
        const a = s.queue.find((x) => x.admission_id === params.admission_id) ?? this.terminal.get(params.admission_id as string);
        if (!a || a.session !== s) throw new Refusal("not_found");
        if (a.status === "terminal" && a.outcome === "interrupted" && a.generation === params.execution_generation) return this.admissionStatus(a);
        if (a.status !== "unknown" || a.generation !== params.execution_generation) throw new Refusal("stale_generation");
        this.settle(s, a, "interrupted");
        // The discarded turn keeps its user row (flushed at its start), closed by a note (`close_discarded_turn`).
        if (!a.userRow) a.userRow = this.addRow(s, this.userRow(a));
        this.addRow(s, { tpl: "assistant", role: "assistant", content: LOST_TURN, display_kind: "failed_turn", finish_reason: null });
        s.revision++;
        this.publishInfo(s);
        this.changed(profile);
        void this.drain(s);
        return this.admissionStatus(a);
      },

      "session.interrupt": (params, { profile }) => {
        const s = this.require(profile, params.session_id);
        if (params.execution_generation !== s.generation) throw new Refusal("stale_generation");
        const handle = this.handle(s);
        this.interruptTurn(s);
        return handle;
      },

      "session.steer": (params, { profile }) => {
        const s = this.require(profile, params.session_id);
        if (!s.running || params.execution_generation !== s.generation) throw new Refusal("stale_generation");
        s.running.steers.push(params.text as string);
        return { status: "queued", text: params.text, execution_generation: s.generation, authority_epoch: this.hooks.authorityEpoch() };
      },

      "approval.respond": (params, ctx) => this.respond(ctx.profile, ctx.socket, params, "approval", params.choice as string),
      "clarify.respond": (params, ctx) => this.respond(ctx.profile, ctx.socket, params, "clarify", params.answer as string),

      "session.mutate": (params, { profile }) => this.mutate(profile, params),

      "session.events.since": (params, { profile, socket }) => {
        const s = this.require(profile, params.session_id);
        const seq = (params.last_sequence as number | undefined) ?? 0;
        const first = (s.ring[0]?.seq as number | undefined) ?? s.seq + 1;
        const missing = params.replay_epoch !== s.epoch || seq > s.seq || seq + 1 < first;
        const events = missing ? [] : s.ring.filter((f) => (f.seq as number) > seq);
        if (!missing) {
          let m = this.replayCursors.get(socket);
          if (!m) this.replayCursors.set(socket, (m = new Map()));
          m.set(s.id, Math.max(seq, ...events.map((f) => f.seq as number)));
        }
        return { events, latest_seq: s.seq, last_sequence: s.seq, epoch: s.epoch, replay_epoch: s.epoch, truncated: missing, snapshot_required: missing, count: events.length, open_requests: [] };
      },
    };
  }

  private count(s: Session) {
    return this.chainRows(s).filter((r) => r.active).length;
  }
  private handle(s: Session): Json {
    return {
      ref: this.ref(s),
      instance_id: this.hooks.instanceId(),
      authority_epoch: this.hooks.authorityEpoch(),
      revision: s.revision,
      execution_generation: s.generation,
      execution_state: s.running ? "running" : "idle",
    };
  }

  /** Settled admissions, by id: receipts outlive the queue. */
  private terminal = new Map<string, Admission>();
  private settle(s: Session, a: Admission, outcome: string) {
    a.status = "terminal";
    a.outcome = outcome;
    s.queue = s.queue.filter((x) => x !== a);
    this.terminal.set(a.admission_id, a);
  }

  private interruptTurn(s: Session) {
    if (!s.running) return;
    s.running.interrupted = true;
    s.running.wake();
  }

  // ---- submit and the FIFO
  private submit(profile: FakeProfile, socket: WebSocket | null, params: Json, opts: { admissionId?: string; script?: TurnScript } = {}): Json {
    const s = this.require(profile, params.session_id);
    if (socket && !s.subscribers.has(socket)) throw new Refusal("permission_denied");
    const request = (params.submission_id ?? params.input_id) as string | undefined;
    if (typeof request !== "string" || !request) throw new Refusal("invalid_params");
    // A50: images only, staged in the profile's cache/images (T1.0 attachments.json); anything else is refused.
    const images = path.join(profile.home, "cache", "images") + path.sep;
    for (const att of (params.attachments as { path: string; mime: string }[] | null | undefined) ?? []) {
      if (!IMAGE_MIMES.has(att.mime) || !path.resolve(att.path).startsWith(images) || !existsSync(att.path)) throw new Refusal("invalid_params");
    }
    const payload = { text: params.text, attachments: params.attachments ?? null, display_kind: params.display_kind ?? null, turn_author: params.turn_author ?? null };
    const digest = JSON.stringify(payload);
    // One run per request id: an exact repeat answers the same admission (`admit_session_input`).
    const old = [...s.queue, ...this.terminal.values()].find((a) => a.session === s && a.request_id === request);
    if (old) {
      if (old.digest !== digest) throw new Refusal("admission_conflict", { field: "request_id", detail: "this request id was already admitted with another payload" });
      return this.admissionStatus(old);
    }
    const a: Admission = {
      admission_id: opts.admissionId ?? hex(),
      request_id: request,
      session: s,
      sequence: ++this.sequence,
      status: "queued",
      outcome: null,
      generation: null,
      text: params.text as string,
      digest,
      submission_id: request,
      display_kind: (params.display_kind as string | null | undefined) ?? null,
      attachments: (params.attachments as Json[] | null | undefined) ?? null,
      turn_author: (params.turn_author as Json | null | undefined) ?? null,
      script: opts.script ?? this.scriptFor(profile, params.text as string),
    };
    s.queue.push(a);
    const status = this.admissionStatus(a);
    this.publishInfo(s);
    void this.drain(s);
    return status;
  }

  private scriptFor(p: FakeProfile, text: string): TurnScript {
    const queued = this.scripts.get(p.name)?.shift();
    if (queued) return queued;
    const has = (w: string) => new RegExp(`(^|\\s)#${w}\\b`).test(text);
    return {
      chunkMs: has("slow") ? 300 : undefined,
      tool: has("tool") || has("approval") || has("edit") || undefined,
      approval: has("edit") ? { kind: "edit" } : has("approval") ? { kind: "command" } : undefined,
      clarify: has("clarify") ? {} : undefined,
      reasoning: has("think") ? "Thinking about it." : undefined,
      fail: has("fail") ? "stub failure" : undefined,
    };
  }

  /** Run the FIFO head when nothing runs and nothing unknown blocks it (S8 E11b: paused behind `unknown`). */
  private async drain(s: Session) {
    if (s.running) return;
    if (s.queue.some((a) => a.status === "unknown")) return;
    const next = s.queue.find((a) => a.status === "queued");
    if (!next) return;
    try {
      await this.run(s, next);
    } catch (err) {
      this.hooks.violations.push(`turn ${next.admission_id}: ${(err as Error).stack ?? err}`);
      s.running = null;
      return;
    }
    // A rotation mid-run moves the FIFO to the tip.
    void this.drain(this.tipOf(s));
  }

  private async run(s: Session, a: Admission) {
    const gen = ++s.generation;
    a.status = "started";
    a.generation = gen;
    let wake: () => void = () => {};
    const turn: Turn = { admission: a, generation: gen, interrupted: false, aborted: false, steers: [], wake: () => wake() };
    s.running = turn;
    const stamp = this.stamp(s, a);
    const pause = (ms: number) =>
      new Promise<void>((r) => {
        const t = ms > 0 ? setTimeout(r, ms) : setImmediate(r);
        wake = () => {
          ms > 0 ? clearTimeout(t as NodeJS.Timeout) : clearImmediate(t as NodeJS.Immediate);
          r();
        };
      });
    const stop = () => turn.interrupted || turn.aborted;
    this.publish(s, "message.start", {}, stamp);
    this.publishInfo(s, stamp);
    if (s.lease) {
      // The dashboard holds the turn lease: wait, then reload (`agent/turn_facade_lease.py`, S8 E3a).
      this.publish(s, "status.update", { kind: "status", text: WAITING }, stamp);
      await s.lease;
    }
    const command = COMMAND_REPLIES[a.text.trim()];
    const context = this.count(s) + 2;
    // Canonical turns flush their rows per step (`_flush_messages_to_session_db`): the user row first, so REST
    // shows it mid-turn; the tool rows when the tool ends; the reply at the end. Commands store nothing.
    const user = command ? null : (a.userRow = this.addRow(s, this.userRow(a)));
    if (user) this.changed(s.profile);
    const rows: Row[] = user ? [user] : [];
    const steers: Row[] = [];
    let steered = 0;
    const flushSteers = () => {
      for (const t of turn.steers.slice(steered)) steers.push(this.addRow(s, { tpl: "steer", role: "user", content: STEER_WRAP(t), display_kind: "steer", display_content: t }));
      steered = turn.steers.length;
    };
    if (a.script.holdMs) await pause(a.script.holdMs);
    if (turn.aborted) return;
    if (command) {
      // The gateway answers these itself: no model call, nothing stored, no reset (A46).
      this.publish(s, "message.complete", { text: command, content: command, admission_id: a.admission_id, outcome: "completed", status: "complete" }, stamp);
      this.settle(s, a, "completed");
      s.running = null;
      s.revision++;
      this.publishInfo(s, stamp);
      return;
    }
    this.publish(s, "agent.step", { iteration: 1 }, stamp);
    const prompt = user!.content as string;
    let error: string | null = null;
    if (a.script.reasoning && !stop()) this.publish(s, "reasoning.delta", { text: a.script.reasoning }, stamp);
    if (a.script.tool && !stop()) {
      const callId = `call_${hex(4)}`;
      const toolPath = path.join(s.cwd ?? s.profile.home, "note.txt");
      const args = a.script.approval?.kind === "edit" ? { path: toolPath, content: "ok" } : { path: toolPath };
      const name = a.script.approval?.kind === "edit" ? "write_file" : a.script.approval ? "terminal" : "read_file";
      const toolArgs = name === "terminal" ? { command: "echo approved" } : args;
      const start = { tool_id: callId, name, context: name === "terminal" ? "echo approved" : toolPath, tool_call_id: callId, tool_name: name, args: toolArgs };
      this.publish(s, "tool.generating", { name }, stamp);
      this.publish(s, "message.delta", { text: null }, stamp);
      this.publish(s, "tool.start", start, stamp);
      let result = JSON.stringify({ content: "1|a note for read_file", total_lines: 1 });
      let isError = false;
      if (a.script.approval) {
        const edit = a.script.approval.kind === "edit";
        const choice = await this.ask(
          s,
          turn,
          "approval",
          {
            command: edit ? `Edit ${toolPath}` : "echo approved",
            description: edit ? "Approve proposed file change" : "Run a terminal command",
            // `gateway/session_pending_controls.py:22-34`: never widened.
            choices: edit ? ["once", "deny"] : ["once", "deny", "session", "always"],
            ...(edit ? { edit: { tool_name: "write_file", path: toolPath, old_text: null, new_text: "ok", arguments: args, paths: [] } } : {}),
            timeout_s: a.script.approval.timeout_s ?? 60,
          },
          pause,
        );
        if (choice === null || choice === "deny") {
          isError = true;
          result = JSON.stringify({ error: choice === null ? "approval timed out" : "denied by the user" });
        } else result = edit ? JSON.stringify({ bytes_written: 2 }) : JSON.stringify({ output: "approved", exit_code: 0 });
      }
      if (!turn.aborted) {
        if (turn.interrupted) {
          isError = true;
          result = JSON.stringify({ output: "[Command interrupted]", exit_code: 130 });
        }
        this.publish(s, "tool.complete", { ...start, is_error: isError, result, duration_s: 0.01, inline_diff: null }, stamp);
        rows.push(
          this.addRow(s, { tpl: "toolCall", role: "assistant", content: "", tool_calls: [{ id: callId, call_id: callId, response_item_id: `fc_${callId}`, type: "function", function: { name, arguments: JSON.stringify(toolArgs) } }], finish_reason: "tool_calls" }),
          this.addRow(s, { tpl: "tool", role: "tool", content: result, tool_call_id: callId, tool_name: name }),
        );
        // A steer joins at the next step, after the tool rows.
        flushSteers();
        this.changed(s.profile);
        this.publish(s, "agent.step", { iteration: 2 }, stamp);
      }
    }
    if (a.script.clarify && !stop()) {
      const answer = await this.ask(
        s,
        turn,
        "clarify",
        { question: a.script.clarify.question ?? "red or blue?", choices: a.script.clarify.choices ?? ["red", "blue"], multi_select: false, timeout_s: a.script.clarify.timeout_s ?? 600 },
        pause,
      );
      if (!stop()) a.script = { ...a.script, reply: a.script.reply ?? (answer ?? "no answer") };
    }
    if (turn.aborted) return;
    let text = "";
    if (a.script.fail && !stop()) error = a.script.fail;
    else if (!stop()) {
      const reply = a.script.reply ?? `echo(${context}): ${prompt.slice(-120)}`;
      const turnId = hex();
      for (const chunk of reply.split(/(?<= )/)) {
        if (stop()) break;
        this.publish(s, "message.delta", { text: chunk, turn_id: turnId, segment: 0, offset: text.length }, stamp);
        text += chunk;
        await pause(a.script.chunkMs ?? 0);
      }
    }
    if (turn.aborted) return;
    flushSteers();
    const final = text ? [this.addRow(s, { tpl: "assistant", role: "assistant", content: text, finish_reason: "stop" })] : [];
    rows.push(...steers, ...final);
    s.revision++;
    s.last_activity_at = now();
    const outcome = error ? "failed" : turn.interrupted ? "cancelled" : "completed";
    const usage = { model: s.model, input: 10, output: 5, reasoning: 0, prompt: 10, completion: 5, total: 15, calls: 1, context_used: 10, context_max: 65536, context_percent: 0 };
    this.publish(s, "session.usage", { usage }, stamp);
    this.publish(
      s,
      "message.complete",
      {
        text,
        content: text,
        admission_id: a.admission_id,
        outcome,
        status: error ? "error" : turn.interrupted ? "interrupted" : "complete",
        ...(error ? { error } : {}),
        usage,
        persisted_turn: {
          row_ids: rows.map((r) => r.id),
          complete: !turn.interrupted && !error,
          user_row_id: user!.id,
          user_row_ids: [user!.id, ...steers.map((r) => r.id)],
          ...(final.length ? { final_assistant_row_id: final.at(-1)!.id } : {}),
          submission_id: a.submission_id,
        },
      },
      stamp,
    );
    this.settle(s, a, outcome === "cancelled" ? "cancelled" : outcome);
    s.running = null;
    this.clearPrompts(s, gen);
    this.publishInfo(s, stamp);
    this.changed(s.profile);
  }

  /** A canonical turn's user row; an image rides as Hermes' vision note before the text (T1.0 attachments.json). */
  private userRow(a: Admission): Partial<Row> & { tpl: string } {
    const notes = (a.attachments ?? []).map((att) => {
      const file = att.path as string;
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      const stored = path.join(a.session.profile.home, "cache", "documents", "native-inputs", digest, path.basename(file));
      return `[The user sent an image~ Here's what I can see:\nStub chat]\n[If you need a closer look, use vision_analyze with image_url: ${stored} ~]\n\n`;
    });
    return { tpl: "user", role: "user", content: notes.join("") + a.text, display_kind: a.display_kind, display_metadata: { gateway_input_owner: "<redacted>", submission_id: a.submission_id } };
  }

  private addRow(s: Session, r: Partial<Row> & { tpl?: string }): Row {
    const { tpl, ...values } = r;
    // A compaction copy keeps its row's uid (R1 M2); anything new gets a fresh one.
    const row = { ...values, id: ++this.rowId, session_id: s.id, message_uid: (values.message_uid as string | undefined) ?? hex(), timestamp: now(), active: 1, compacted: 0, tpl } as unknown as Row;
    if (!("display_metadata" in row)) row.display_metadata = null;
    s.rows.push(row);
    return row;
  }

  /** Raise an approval or clarify on the session and wait for an answer, its deadline or a Stop. */
  private async ask(s: Session, turn: Turn, kind: "approval" | "clarify", fields: Json, pause: (ms: number) => Promise<void>): Promise<string | null> {
    const prompt_id = hex(5);
    const prompt = { kind, prompt_id, execution_generation: turn.generation, ...fields };
    let answer: string | null = null;
    let settled = false;
    const done = new Promise<void>((resolve) => {
      s.prompts.set(prompt_id, {
        prompt,
        resolve: (v) => {
          answer = v;
          settled = true;
          resolve();
        },
      });
    });
    this.publish(s, `${kind}.request`, prompt, this.stamp(s, turn.admission));
    const timeout = (fields.timeout_s as number) * this.hooks.secondMs;
    await Promise.race([done, pause(timeout)]);
    turn.wake(); // clears the deadline timer
    if (s.prompts.delete(prompt_id) && !turn.aborted) {
      // Answered, timed out (deny / no answer) or stopped: the prompt settles on the stream.
      this.publish(s, `${kind}.settled`, { prompt_id, execution_generation: turn.generation }, this.stamp(s, turn.admission));
    }
    return settled ? answer : null;
  }

  private clearPrompts(s: Session, gen: number) {
    for (const [id, p] of s.prompts) if (p.prompt.execution_generation === gen) {
      s.prompts.delete(id);
      p.resolve(null);
    }
  }

  private respond(profile: FakeProfile, socket: WebSocket, params: Json, kind: "approval" | "clarify", answer: string): Json {
    const s = this.require(profile, params.session_id);
    if (!s.subscribers.has(socket)) throw new Refusal("permission_denied");
    if (!s.running || params.execution_generation !== s.generation) throw new Refusal("stale_generation");
    const pending = s.prompts.get(params.prompt_id as string);
    if (!pending) return { status: "already_resolved", prompt_id: params.prompt_id };
    if (pending.prompt.kind !== kind) throw new Refusal("invalid_params");
    if (kind === "approval" && !(pending.prompt.choices as string[]).includes(answer)) throw new Refusal("invalid_params");
    pending.resolve(answer);
    return { status: "resolved", prompt_id: params.prompt_id };
  }

  // ---- mutations (`gateway/session_mutations.py`, `hermes_state_runtime.mutate_runtime_session`)
  private receipts = new Map<string, { digest: string; result: Json }>();
  private mutate(profile: FakeProfile, params: Json): Json {
    const { operation, payload } = params as { operation: string; payload: Json };
    const fenced = ["delete", "rewind", "reset", "branch", "model", "compress", "reasoning", "workspace", "editor_mcp", "edit_policy"];
    if (fenced.includes(operation) && (params.expected_generation === undefined || params.expected_generation === null)) throw new Refusal("invalid_params");
    const valid =
      (operation === "compress" && Object.keys(payload).every((k) => ["focus", "preview", "partial", "keep_last"].includes(k))) ||
      (operation === "model" && typeof payload.model === "string" && Object.keys(payload).every((k) => ["model", "provider", "reasoning"].includes(k))) ||
      (operation === "reasoning" && Object.keys(payload).join() === "effort" && (payload.effort === null || REASONING.has(payload.effort as string)));
    if (!valid) throw new Refusal("invalid_params");
    const key = `${profile.home}|${params.session_id}|${params.request_id}`;
    const digest = JSON.stringify([operation, payload, params.expected_revision, params.expected_generation]);
    const replay = this.receipts.get(key);
    if (replay?.digest === digest) return replay.result;
    const s = this.require(profile, params.session_id);
    const fences = { revision: s.revision, execution_generation: s.generation };
    if (params.expected_revision !== s.revision) throw new Refusal("revision_conflict", fences);
    if (params.expected_generation !== s.generation) throw new Refusal("stale_generation", fences);
    // A mutation on a legacy row keeps it legacy: no `chat_id` (T1.0 adoption.json; A23's code read was wrong).
    let result: Json;
    if (operation === "compress") {
      if (s.running) throw new Refusal("session_busy");
      result = this.compress(s, params);
    } else {
      if (operation === "model") {
        s.model = payload.model as string;
        if (typeof payload.provider === "string") s.provider = payload.provider;
        if (typeof payload.reasoning === "string") s.reasoning = payload.reasoning;
      } else s.reasoning = payload.effort as string | null;
      s.revision++;
      result = { session_id: s.id, revision: s.revision, execution_generation: s.generation, operation, ...payload };
      this.publish(s, "session.updated", result);
    }
    this.receipts.set(key, { digest, result });
    this.changed(profile);
    return result;
  }

  /**
   * In place (Hermes' default): the id stays; the summarized rows go inactive (`compacted`) and active copies with
   * the same uids follow, with a carrier for the middle replies. Rotating (`compression.in_place: false`): a new
   * tip with the same `chat_id`, the title and the live state move there; resuming any id of the chain reaches it.
   */
  private compress(s: Session, params: Json): Json {
    const before = s.rows.filter((r) => r.active);
    const users = before.filter((r) => r.role === "user");
    const replies = before.filter((r) => r.role !== "user");
    const kept = new Set([replies[0], replies.at(-1)].filter(Boolean).map((r) => r!.message_uid));
    const carrierOf = replies.slice(1, -1).at(-1);
    const copy = (target: Session, r: Row, over: Json = {}) => this.addRow(target, { ...this.strip(r), ...over });
    let target = s;
    if (this.hooks.rotating.has(s.profile.name)) {
      target = this.newSession(s.profile, hex(), {
        title: s.title,
        hidden: s.hidden,
        archived: s.archived,
        source: s.source,
        created_source: s.created_source,
        chat_id: this.rootOf(s).id,
        cwd: s.cwd,
        model: s.model,
        provider: s.provider,
        reasoning: s.reasoning,
        parent: s,
        revision: s.revision,
        generation: s.generation,
        queue: s.queue,
        subscribers: s.subscribers,
        mounted: true,
      });
      s.tip = target;
      s.title = null;
      s.queue = [];
      for (const a of target.queue) a.session = target;
      if (users[0]) copy(target, users[0]);
      this.addRow(target, { tpl: "hiddenCarrier", role: "assistant", content: "[CONTEXT COMPACTION — REFERENCE ONLY] Summary of the earlier turns.", display_kind: "hidden", _compressed_summary: true });
      for (const u of users.slice(-2)) copy(target, u);
    } else {
      for (const r of before) {
        r.active = 0;
        r.compacted = 1;
      }
      for (const r of before) {
        if (r.role === "user" || kept.has(r.message_uid)) copy(target, r);
        else if (r === carrierOf)
          this.addRow(target, { tpl: "inPlaceCarrier", role: "assistant", content: `[PRIOR CONTEXT — for reference only; not a new message]\n${r.content}\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]`, display_content: r.content, _compressed_summary: true, message_uid: r.message_uid });
      }
    }
    target.revision = ++s.revision;
    target.generation = ++s.generation;
    const result = {
      session_id: s.id,
      revision: target.revision,
      execution_generation: target.generation,
      operation: "compress",
      target_session_id: target.id,
      previous_target_session_id: s.id,
      message_count: target.rows.filter((r) => r.active).length,
      summary: { noop: false, aborted: false, refused_would_grow: false, fallback_used: false, headline: `Compressed: ${before.length} → ${target.rows.filter((r) => r.active).length} messages`, token_line: "", note: "" },
    };
    // Viewers follow `session.info.stored_session_id` to the tip (02 flow 7).
    this.publish(s, "session.info", { stored_session_id: target.id, pending: this.pending(target), authority_epoch: this.hooks.authorityEpoch(), desktop_protocol: "hermes-gateway-v1", running: false, execution_generation: target.generation, revision: target.revision });
    void params;
    return result;
  }

  private strip(r: Row): Partial<Row> & { tpl?: string } {
    const { id: _i, session_id: _s, timestamp: _t, active: _a, compacted: _c, ...rest } = r;
    return rest as Partial<Row> & { tpl?: string };
  }

  // ---- REST projection (`hermes_cli/web_routers/sessions.py:182, 739`)
  /** An engine answer for a REST read, or null when the engine has nothing for it (a recording may). */
  rest(p: FakeProfile, pathname: string, query: Record<string, string>, recordedList: boolean): { status: number; body: Json } | null {
    if (pathname === "/api/sessions") {
      if (!this.all(p).length && recordedList) return null;
      const limit = Math.min(Number(query.limit ?? 20), 100);
      const offset = Number(query.offset ?? 0);
      const archived = query.archived ?? "exclude";
      const order = query.order ?? "created";
      if (!["exclude", "only", "include"].includes(archived)) return { status: 400, body: { detail: "archived must be one of: exclude, only, include" } };
      if (!["created", "recent"].includes(order)) return { status: 400, body: { detail: "order must be one of: created, recent" } };
      const rows = this.all(p)
        .filter((s) => !s.tip && !s.hidden && (archived === "include" || (archived === "only") === s.archived) && this.count(s) >= Number(query.min_messages ?? 0))
        .sort((a, b) => (order === "recent" ? b.last_activity_at - a.last_activity_at : b.started_at - a.started_at));
      return { status: 200, body: fill(TEMPLATES.listPage, { sessions: rows.slice(offset, offset + limit).map((s) => this.restRow(s)), total: rows.length, limit, offset }) };
    }
    const m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
    const s = m && this.session(p, decodeURIComponent(m[1]!));
    if (!s) return null;
    const all = this.chainRows(s).filter((r) => query.include_compacted === "true" || r.active);
    const explicit = query.limit !== undefined;
    const limit = explicit ? Math.min(Number(query.limit), 500) : 500;
    const offset = Number(query.offset ?? 0);
    const latest = query.order === "latest" || (query.order === undefined && !explicit);
    const page = latest ? all.slice(Math.max(0, all.length - offset - limit), all.length - offset) : all.slice(offset, offset + limit);
    return {
      status: 200,
      body: fill(TEMPLATES.messagesPage, {
        session_id: s.id,
        profile: p.name,
        messages: page.map((r) => this.restMessage(r)),
        pagination: { limit, offset, order: query.order ?? (explicit ? "oldest" : "latest"), returned: page.length },
      }),
    };
  }

  restRow(s: Session): Json {
    const root = this.rootOf(s);
    const rows = this.chainRows(s).filter((r) => r.active);
    const firstUser = rows.find((r) => r.role === "user");
    const values: Json = {
      id: s.id,
      runtime_revision: s.revision,
      runtime_generation: s.generation,
      source: s.source,
      created_source: s.created_source,
      chat_id: s.chat_id,
      model: s.model,
      started_at: s.started_at,
      ended_at: s.ended_at,
      end_reason: s.end_reason,
      message_count: s.rows.filter((r) => r.active).length,
      cwd: s.cwd,
      title: s.title,
      last_activity_at: s.last_activity_at,
      profile_name: s.profile.name,
      archived: s.archived,
      hidden: s.hidden ? 1 : 0,
      last_active: s.last_activity_at,
      preview: firstUser ? String(firstUser.content).slice(0, 60) : "",
      profile: s.profile.name,
      is_default_profile: s.profile.name === "default",
      user_id: s.chat_id === null ? null : "<redacted>",
      session_key: s.chat_id === null ? null : "<redacted>",
      origin_json: s.chat_id === null ? null : "<redacted>",
      chat_type: s.chat_id === null ? null : "dm",
    };
    if (s.parent) return fill(TEMPLATES.tipRow, { ...values, _lineage_root_id: root.id, _lineage_ids: this.lineage(s), continuation_kind: "compression" });
    return fill(s.source === "desktop" ? TEMPLATES.legacyRow : TEMPLATES.row, values);
  }

  private lineage(s: Session): string[] {
    const ids: string[] = [];
    for (let x: Session | null = this.rootOf(s); x; x = x.tip) ids.push(x.id);
    return ids;
  }

  private restMessage(r: Row): Json {
    const { tpl, ...values } = r as Row & { tpl?: keyof typeof TEMPLATES };
    const template = TEMPLATES[tpl ?? "assistant"] as Json;
    const out: Json = { ...values };
    if (!("display_kind" in template)) delete out.display_kind;
    else if (!("display_kind" in out)) out.display_kind = null;
    return fill(template, out);
  }

  // ---- outside clients and knobs
  nextTurn(profile: FakeProfile, script: TurnScript) {
    let q = this.scripts.get(profile.name);
    if (!q) this.scripts.set(profile.name, (q = []));
    q.push(script);
  }

  /** A turn by another canonical client (CLI, TUI, Desktop): its own admission, live on every subscriber. */
  outsideTurn(profile: FakeProfile, sessionId: string, text: string, opts: { admissionId?: string; script?: TurnScript } = {}): Json {
    return this.submit(profile, null, { session_id: sessionId, text, submission_id: randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-") }, opts);
  }

  /**
   * A dashboard (Conduit) send (S8 §How Conduit and Desktop share). Gateway work queued or running on the session
   * → forwarded into its FIFO as `desktop-forward-…` (E3b). Else the dashboard runs it itself: the user row at
   * once, the reply rows at the end, no canonical events, the turn lease held meanwhile (E2, E3a). An `unknown`
   * admission refuses it (E11b).
   */
  async conduitTurn(profile: FakeProfile, sessionId: string, text: string, opts: { durationMs?: number; reply?: string } = {}): Promise<Json> {
    const s = this.require(profile, sessionId);
    if (s.queue.some((a) => a.status === "unknown")) {
      throw Object.assign(new Error(`Session ${s.id} has outcome-unknown work in the gateway's durable queue. Resume it through the gateway (hermes chat --resume, Desktop or the TUI) to resolve it; nothing was run here.`), {
        code: 4090,
        data: { reason: "SESSION_NOT_OWNED" },
      });
    }
    if (s.running || s.queue.length) {
      // Forwarded into the gateway's queue: an ordinary admission whose submission id names the dashboard (E3b).
      const st = this.submit(profile, null, { session_id: sessionId, text, submission_id: `desktop-forward-${hex()}` });
      return { status: "queued", admission_id: st.admission_id, forwarded: true };
    }
    const context = this.count(s) + 2;
    let release!: () => void;
    s.lease = new Promise<void>((r) => (release = r));
    const claimed = this.legacy(s) && !s.held;
    if (claimed) s.held = true;
    const user = this.addRow(s, { tpl: "user", role: "user", content: text, display_kind: null, display_metadata: null });
    s.last_activity_at = now();
    this.changed(profile, { dashboard: true });
    await sleep(opts.durationMs ?? 50);
    this.addRow(s, { tpl: "assistant", role: "assistant", content: opts.reply ?? `echo(${context}): ${text.slice(-120)}`, finish_reason: "stop" });
    s.last_activity_at = now();
    s.lease = null;
    release();
    this.changed(profile, { dashboard: true });
    return { status: "streaming", user_row_id: user.id };
  }

  /** A dashboard (Conduit) chat the gateway doesn't own yet: `source: desktop`, no `chat_id` (D16, A48). */
  legacySession(profile: FakeProfile, opts: { title?: string; hidden?: boolean; turns?: string[]; held?: boolean } = {}): string {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const id = `${stamp.slice(0, 8)}_${stamp.slice(8)}_${hex(3)}`;
    const s = this.newSession(profile, id, { title: opts.title ?? null, hidden: opts.hidden ?? false, source: "desktop", created_source: "desktop", chat_id: null, held: opts.held ?? false });
    for (const [i, t] of (opts.turns ?? []).entries()) {
      this.addRow(s, { tpl: "user", role: "user", content: t, display_kind: null, display_metadata: null });
      this.addRow(s, { tpl: "assistant", role: "assistant", content: `echo(${2 * i + 2}): ${t}`, finish_reason: "stop" });
    }
    this.changed(profile, { dashboard: true });
    return id;
  }

  hold(profile: FakeProfile, sessionId: string, on: boolean) {
    this.require(profile, sessionId).held = on;
  }

  /** Another client answers a pending prompt (`*.settled` follows). */
  answerElsewhere(profile: FakeProfile, sessionId: string, promptId: string, answer: string): boolean {
    const p = this.require(profile, sessionId).prompts.get(promptId);
    p?.resolve(answer);
    return !!p;
  }

  /**
   * The dashboard dropped pending approvals (interrupt, reap, teardown): its `approval.cancelled` broadcast
   * (`tui_gateway/session_lifecycle.py:585`), each wait resolved as deny.
   */
  cancelApprovals(profile: FakeProfile, sessionId: string, reason = "interrupt") {
    const s = this.require(profile, sessionId);
    const ids = [...s.prompts.entries()].filter(([, p]) => p.prompt.kind === "approval").map(([id]) => id);
    for (const sock of this.hooks.sockets()) this.send(sock, { type: "approval.cancelled", session_id: s.id, payload: { session_id: s.id, stored_session_id: s.id, reason, cancelled_count: ids.length, request_ids: ids } });
    for (const id of ids) s.prompts.get(id)?.resolve("deny");
  }

  /** A gateway restart: running turns become `unknown` and stop; replay rings and subscriptions are gone. */
  restart() {
    for (const list of this.sessions.values()) {
      for (const s of list) {
        if (s.running) {
          s.running.aborted = true;
          s.running.admission.status = "unknown";
          s.running.wake();
          s.running = null;
        }
        for (const p of s.prompts.values()) p.resolve(null);
        s.prompts.clear();
        s.subscribers.clear();
        s.mounted = false;
        s.epoch = hex();
        s.seq = 0;
        s.ring = [];
      }
    }
    this.replayCursors.clear();
  }

  dropSocket(sock: WebSocket) {
    for (const list of this.sessions.values()) for (const s of list) s.subscribers.delete(sock);
    this.replayCursors.delete(sock);
  }
}
