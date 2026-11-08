// One hosted bb thread on the Hermes side (02 §Protocol mapping, flows 2–9). A bb turn is a list of units run
// in order: bb's own admissions (`prompt.submit`) and renders of outside turns (markers). Events reach a unit
// by `admission_id`; every admission seen on bb's subscription is logged with its first seq, so a later wake
// can attach to a foreign one (E3b) without ever rendering an outside turn that has no marker.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { PromptInput, ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { HermesDisconnectedError, HermesRpcError, type HermesClient } from "../hermes/client.js";
import type { RestMessage } from "../hermes/history.js";
import type { AdmissionStatus, GatewayEvent, Snapshot } from "../hermes/types.js";
import { EXTENSION_KINDS, PERSISTED_TURNS_KEPT, type PersistedTurnState, type StatusState } from "../shared/extension-state.js";
import { type Marker, segmentInput } from "../shared/marker.js";
import type { SourceTag } from "../shared/sources.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { botIdentity, chatIdentity, isPending, resolveContext, type ThreadContext, UserFacingError } from "./context.js";
import { readThreads, updateThread } from "./files.js";
import { findTurn, type History, type HermesLink } from "./hermes.js";
import { renderRows, StreamRenderer, textItem } from "./render.js";

export const DELETED_TEXT = "Deleted in Hermes.";
export const RESTARTED_TEXT = "Hermes restarted: resend?";
export const EARLIER_TEXT = "Earlier messages stay in Hermes.";
export const INIT_REFUSED_TEXT = "This chat is already set up.";
/** Flow 3 step 4: 2, 5, 10, 30 s, then every 60 s. */
export const HOLD_RETRY_MS = [2000, 5000, 10_000, 30_000, 60_000];
/** How long Stop waits for Hermes to settle an interrupted turn before settling it here. */
const STOP_SETTLE_MS = 5000;
const LOGGED_ADMISSIONS = 32;
const LOGGED_EVENTS = 5000;
/** A Conduit (dashboard) send that Hermes passed into the gateway queue (S8 E3b): Stop may interrupt it. */
const FORWARDED = /^desktop-forward-/;

export interface ThreadHost {
  readonly dataDir: string;
  readonly pluginId: string;
  readonly holdRetryMs: readonly number[];
  emit(threadId: string, deltas: ThreadDelta[]): void;
  announce(threadId: string, providerThreadId: string): void;
  link(root: string): HermesLink;
  history(root: string): History;
}

type Outcome = { status: "completed" | "interrupted" | "failed"; error?: string };
type PersistedTurn = { row_ids?: number[]; submission_id?: string | null };

interface AdmissionLog {
  id: string;
  firstSeq: number | null;
  events: GatewayEvent[];
  generation: number | null;
  started: boolean;
  done: boolean;
  inputId: string | null;
  text: string | null;
}

class Deferred<T> {
  resolve!: (v: T) => void;
  readonly promise = new Promise<T>((r) => (this.resolve = r));
}

/** A rendered admission: bb's own, or an outside one a wake attached to. */
interface Unit {
  own: boolean;
  admissionId: string | null;
  submissionId: string | null;
  renderer: StreamRenderer;
  settled: Deferred<Outcome & { persisted: PersistedTurn | null }>;
  done: boolean;
  /** Outside unit only: the tag for "Running in <app>". */
  tag: SourceTag | null;
}

class BbTurn {
  stopped = false;
  units: Unit[] = [];
  /** Steers that became queued submits: awaited after the segments. */
  queued: Promise<void>[] = [];
  private wake = new Set<() => void>();
  readonly finished = new Deferred<void>();
  submits = 0;
  /** Mirror markers rendered in this turn. */
  mirrors = 0;
  constructor(readonly clientRequestId: string) {}

  /** Wait `ms`, or less when Stop comes. Resolves true when still running. */
  sleep(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake.delete(done);
        resolve(!this.stopped);
      };
      const timer = setTimeout(done, ms);
      this.wake.add(done);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const fn of [...this.wake]) fn();
  }

  nextSubmissionId(threadId: string): string {
    const n = this.submits++;
    return `bb:${threadId}:${this.clientRequestId}${n ? `:${n}` : ""}`;
  }
}

class Stopped extends Error {}

interface SessionState {
  root: string;
  profile: string;
  profileHome: string;
  /** The live id events carry. */
  id: string;
  /** The chain's tip, from `stored_session_id` (flow 7). */
  stored: string;
  lineageRoot: string;
  subscriptionId: string;
  client: HermesClient;
  unsubscribe: () => void;
}

export interface TurnParams {
  clientRequestId: string;
  input: PromptInput[];
  options: { providerOptions?: unknown; sessionOptions?: Record<string, string | boolean>; model?: string; reasoningLevel?: string };
}

export class HostedThread {
  ctx: ThreadContext | null = null;
  session: SessionState | null = null;
  turn: BbTurn | null = null;
  private readonly logs = new Map<string, AdmissionLog>();
  private persisted: PersistedTurnState["turns"];
  private mirrored: PersistedTurnState["mirrored"];
  private banner: StatusState["banner"] = null;

  constructor(
    readonly threadId: string,
    public providerThreadId: string,
    private readonly host: ThreadHost,
  ) {
    const saved = readThreads(host.dataDir)[threadId];
    this.persisted = saved?.turns ?? [];
    this.mirrored = saved?.mirrored ?? [];
  }

  private emit(deltas: ThreadDelta[]): void {
    if (deltas.length) this.host.emit(this.threadId, deltas);
  }

  private state(kind: string, payload: unknown): ThreadDelta {
    return { kind: "extension.state", extensionKind: `${this.host.pluginId}/${kind}` as `${string}/${string}`, payload: payload as never };
  }

  private setBanner(banner: StatusState["banner"]): void {
    if (JSON.stringify(banner) === JSON.stringify(this.banner)) return;
    this.banner = banner;
    this.emit([this.state(EXTENSION_KINDS.status, { banner, since: banner ? Date.now() : null } satisfies StatusState)]);
  }

  // ---- turns -----------------------------------------------------------------------------------------

  async runTurn(params: TurnParams): Promise<void> {
    const turn = new BbTurn(params.clientRequestId);
    this.turn = turn;
    this.emit([{ kind: "input.accepted", clientRequestId: params.clientRequestId }, { kind: "turn.open" }]);
    if (this.banner?.kind === "running_elsewhere") this.setBanner(null);
    let outcome: Outcome = { status: "completed" };
    try {
      for (const segment of segmentInput(params.input)) {
        if (turn.stopped) break;
        if (segment.kind === "invalid") {
          this.emit([{ kind: "provider.error", message: `Ignored a malformed Hermes plugin marker (${segment.error}).` }]);
        } else if (segment.kind === "marker") {
          await this.runMarker(turn, segment.marker, params);
        } else {
          const ctx = this.resolve(params);
          const unitOutcome = await this.submitPrompt(turn, ctx, segment.parts);
          if (unitOutcome.status === "failed") outcome = unitOutcome;
        }
      }
      await Promise.all(turn.queued);
      for (const unit of turn.units) {
        const result = await unit.settled.promise;
        if (result.status === "failed" && outcome.status !== "failed") outcome = result;
      }
    } catch (error) {
      if (!(error instanceof Stopped)) outcome = { status: "failed", error: errorText(error) };
    }
    if (turn.stopped && outcome.status !== "failed") outcome = { status: "interrupted" };
    await this.settleTurn(turn, outcome);
  }

  private async settleTurn(turn: BbTurn, outcome: Outcome): Promise<void> {
    const closing: ThreadDelta[] = [];
    for (const unit of turn.units) if (!unit.done) closing.push(...this.closeUnit(unit, { status: "interrupted" }));
    const persisted = await this.recordPersisted(turn).catch(() => null);
    const clearHeld = this.banner?.kind === "held";
    if (clearHeld) this.banner = null; // cleared in the same batch below
    closing.push(
      outcome.status === "failed" && outcome.error
        ? { kind: "provider.error", message: outcome.error, settlesTurn: true }
        : { kind: "turn.boundary", status: outcome.status },
    );
    if (persisted) closing.push(this.state(EXTENSION_KINDS.persistedTurn, persisted));
    if (clearHeld) closing.push(this.state(EXTENSION_KINDS.status, { banner: null, since: null } satisfies StatusState));
    if (this.turn === turn) this.turn = null;
    this.emit(closing);
    // Identity changes only right after a boundary, never mid-turn (S1-S3 fact 1).
    const identity = this.wantedIdentity();
    if (identity && identity !== this.providerThreadId) {
      this.providerThreadId = identity;
      this.host.announce(this.threadId, identity);
    }
    turn.finished.resolve();
  }

  private wantedIdentity(): string | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (ctx.kind === "bot") return botIdentity(ctx.profileHome);
    const root = this.session?.lineageRoot ?? ctx.lineageRoot;
    return root ? chatIdentity(ctx.profileHome, root) : null;
  }

  private resolve(params: TurnParams): ThreadContext {
    const saved = readThreads(this.host.dataDir)[this.threadId];
    const ctx = resolveContext({ providerOptions: params.options.providerOptions, sessionOptions: params.options.sessionOptions, saved, dataDir: this.host.dataDir });
    // The server's view lags a session this process created (until it reads `persisted-turn`): keep ours.
    if (this.ctx && this.ctx.profileHome === ctx.profileHome && !ctx.lineageRoot && this.ctx.lineageRoot) {
      ctx.lineageRoot = this.ctx.lineageRoot;
      ctx.sessionId = this.ctx.sessionId;
      if (ctx.kind === "chat" && this.ctx.kind === "bot") ctx.kind = "bot";
    }
    if (this.session && (this.session.root !== ctx.root || this.session.profileHome !== ctx.profileHome)) this.dropSession();
    this.ctx = ctx;
    if (!saved || saved.profile !== ctx.profile || saved.profile_home !== ctx.profileHome) {
      updateThread(this.host.dataDir, this.threadId, { profile: ctx.profile, bot: ctx.kind === "bot", profile_home: ctx.profileHome });
    }
    return ctx;
  }

  // ---- bb's own sends ----------------------------------------------------------------------------------

  private async submitPrompt(turn: BbTurn, ctx: ThreadContext, parts: PromptInput[]): Promise<Outcome> {
    const text = parts
      .filter((p): p is Extract<PromptInput, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (/^\/(new|reset)(\s|$)/.test(text)) {
      await this.compress(turn, ctx);
      return { status: "completed" };
    }
    if (!text) return { status: "completed" };
    const unit = this.newUnit(true, null);
    unit.submissionId = turn.nextSubmissionId(this.threadId);
    turn.units.push(unit);
    try {
      await this.submit(turn, ctx, unit, text);
    } catch (error) {
      unit.done = true;
      if (error instanceof Stopped) throw error;
      const outcome: Outcome = { status: "failed", error: errorText(error) };
      unit.settled.resolve({ ...outcome, persisted: null });
      return outcome;
    }
    return unit.settled.promise;
  }

  private async submit(turn: BbTurn, ctx: ThreadContext, unit: Unit, text: string, retried = false): Promise<void> {
    const session = await this.ensureSession(turn, ctx);
    if (turn.stopped) throw new Stopped();
    let status: AdmissionStatus;
    try {
      status = await this.retrying(session, (client) =>
        client.submit({
          profile: session.profile,
          session_id: session.id,
          text,
          submission_id: unit.submissionId!,
          turn_author: { id: `bb:${this.threadId}`, name: "bb" },
        }),
      );
    } catch (error) {
      if (reasonOf(error) === "not_found" && !retried) {
        this.dropSession();
        if (ctx.kind === "bot") return this.submit(turn, ctx, unit, text, true); // resolve by title again (S8 step 9)
        throw new UserFacingError(DELETED_TEXT);
      }
      throw error;
    }
    this.attach(unit, status.admission_id);
    if (turn.stopped) await this.stopUnit(unit);
  }

  /** Route an admission's events to a unit, replaying what arrived before we knew its id. */
  private attach(unit: Unit, admissionId: string): void {
    unit.admissionId = admissionId;
    const log = this.log(admissionId);
    for (const ev of [...log.events]) this.feedUnit(unit, ev);
  }

  /**
   * An RPC whose socket dropped mid-flight has an unknown outcome: wait for the redial and send it again.
   * Only for idempotent calls (`prompt.submit` keeps its `submission_id`, A4).
   */
  private async retrying<T>(session: SessionState, call: (client: HermesClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(session.client);
      } catch (error) {
        if (!(error instanceof HermesDisconnectedError) || attempt >= 3) throw error;
        session.client = await this.host.link(session.root).client();
      }
    }
  }

  // ---- sessions ----------------------------------------------------------------------------------------

  private dropSession(): void {
    this.session?.unsubscribe();
    this.session = null;
  }

  private async ensureSession(turn: BbTurn, ctx: ThreadContext): Promise<SessionState> {
    if (this.session && !this.session.client.closed) return this.session;
    this.dropSession();
    const client = await this.host.link(ctx.root).client();
    let snap: Snapshot;
    let lineageRoot: string;
    if (ctx.kind === "bot") {
      ({ snap, lineageRoot } = await this.withHold(turn, () => this.openBotChat(client, ctx)));
    } else if (ctx.sessionId || ctx.lineageRoot) {
      // Resuming adopts a legacy row once, on this first bb send only (D16, A23).
      const id = (ctx.sessionId ?? ctx.lineageRoot)!;
      snap = await this.withHold(turn, () => this.resume(client, ctx.profile, id));
      lineageRoot = ctx.lineageRoot ?? snap.session_id;
    } else {
      snap = await client.create({
        profile: ctx.profile,
        request_id: `bb:${this.threadId}`,
        // `gui`, as Desktop's side chats: `hermes chat -c` picks up `cli` chats (A20 failed, T1.0).
        source: "gui",
        cwd: ctx.cwd ?? homedir(),
      });
      lineageRoot = snap.session_id;
    }
    return this.adopt(ctx, client, snap, lineageRoot);
  }

  private async resume(client: HermesClient, profile: string, id: string): Promise<Snapshot> {
    try {
      return await client.resume({ profile, session_id: id, omit_messages: true });
    } catch (error) {
      if (reasonOf(error) === "not_found") throw new UserFacingError(DELETED_TEXT);
      throw error;
    }
  }

  private adopt(ctx: ThreadContext, client: HermesClient, snap: Snapshot, lineageRoot: string): SessionState {
    const link = this.host.link(ctx.root);
    const session: SessionState = {
      root: ctx.root,
      profile: ctx.profile,
      profileHome: ctx.profileHome,
      id: snap.session_id,
      stored: snap.stored_session_id,
      lineageRoot,
      subscriptionId: snap.subscription_id,
      client,
      unsubscribe: link.subscribe(snap.session_id, (ev) => this.onEvent(ev)),
    };
    this.session = session;
    ctx.lineageRoot = lineageRoot;
    ctx.sessionId = snap.stored_session_id;
    this.notePending(snap.pending);
    return session;
  }

  /**
   * Flow 3 steps 1–3 (S8 §Recommended protocol): the Bot Chat by title on every send, never by a stored id;
   * none → re-check, then one lazy create (it returns any Bot Chat made meanwhile, E1); then resume.
   */
  private async openBotChat(client: HermesClient, ctx: ThreadContext): Promise<{ snap: Snapshot; lineageRoot: string }> {
    const lookup = async () => {
      const { sessions } = await client.sessionList({ profile: ctx.profile, title: BOT_CHAT_TITLE, include_hidden: true });
      return sessions.find((s) => s.title === BOT_CHAT_TITLE) ?? null;
    };
    const row = (await lookup()) ?? (await lookup());
    if (row) {
      const snap = await this.resume(client, ctx.profile, row.session_id);
      // `id` is the chain's root: the title moves to a rotated tip, the root stays (S8 E8).
      return { snap, lineageRoot: (row as { id?: string }).id ?? row.session_id };
    }
    if (this.botChatCreated) throw new HermesRpcError({ message: "runtime_coordination_required" });
    this.botChatCreated = true;
    const snap = await client.create({
      profile: ctx.profile,
      title: BOT_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
      request_id: `bb:botchat:${ctx.profileHome}`,
    });
    return { snap, lineageRoot: snap.session_id };
  }

  /** One create per bot thread's wait: retries only look up (flow 3 step 4: never a second create). */
  private botChatCreated = false;

  /**
   * Flow 3 step 4: `runtime_coordination_required` (Conduit holds a chat the gateway hasn't adopted) keeps
   * the bb turn open with the banner and retries at 2, 5, 10, 30 s, then every 60 s. Stop drops the wait.
   */
  private async withHold<T>(turn: BbTurn, attempt: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        const result = await attempt();
        this.botChatCreated = false;
        return result;
      } catch (error) {
        if (reasonOf(error) !== "runtime_coordination_required") throw error;
        this.setBanner({ kind: "held" });
        const delays = this.host.holdRetryMs;
        if (!(await turn.sleep(delays[Math.min(n, delays.length - 1)]!))) throw new Stopped();
      }
    }
  }

  /** `/new`, `/reset`: a compaction of the same chat, never a new session (S8 step 7, A46). */
  private async compress(turn: BbTurn, ctx: ThreadContext): Promise<void> {
    if (!ctx.sessionId && !ctx.lineageRoot && ctx.kind !== "bot") return; // nothing in Hermes yet
    const session = await this.ensureSession(turn, ctx);
    for (let attempt = 0; ; attempt++) {
      if (!session.client.cursors.has(session.id)) await session.client.resume({ profile: session.profile, session_id: session.id, omit_messages: true });
      const cursor = session.client.cursors.get(session.id)!;
      try {
        const result = await session.client.mutate({
          profile: session.profile,
          session_id: session.id,
          request_id: randomUUID(),
          expected_revision: cursor.revision,
          expected_generation: cursor.executionGeneration,
          operation: "compress",
          payload: {},
        });
        if (typeof result.revision === "number") cursor.revision = result.revision;
        const generation = (result as { execution_generation?: unknown }).execution_generation;
        if (typeof generation === "number") cursor.executionGeneration = generation;
        this.emit([{ kind: "context.compacted" }]);
        return;
      } catch (error) {
        const reason = reasonOf(error);
        if (attempt === 0 && (reason === "revision_conflict" || reason === "stale_generation")) {
          await session.client.resume({ profile: session.profile, session_id: session.id, omit_messages: true });
          continue;
        }
        if (reason === "session_busy") throw new UserFacingError("Hermes is busy with this chat; send /new again when it's done.");
        throw error;
      }
    }
  }

  // ---- events --------------------------------------------------------------------------------------------

  private log(id: string): AdmissionLog {
    let log = this.logs.get(id);
    if (!log) {
      log = { id, firstSeq: null, events: [], generation: null, started: false, done: false, inputId: null, text: null };
      this.logs.set(id, log);
      while (this.logs.size > LOGGED_ADMISSIONS) this.logs.delete(this.logs.keys().next().value!);
    }
    return log;
  }

  private notePending(pending: Snapshot["pending"] | unknown): void {
    if (!Array.isArray(pending)) return;
    for (const p of pending as Snapshot["pending"]) {
      if (!p?.admission_id) continue;
      const log = this.log(p.admission_id);
      log.inputId = p.input_id ?? log.inputId;
      log.text = p.text ?? log.text;
      if (p.status === "started") log.started = true;
      if (typeof p.execution_generation === "number") log.generation = p.execution_generation;
    }
  }

  onEvent(ev: GatewayEvent): void {
    if (ev.type === "session.info") {
      const p = ev.payload ?? {};
      this.notePending(p.pending);
      // Keep the fences current for `session.mutate` (the snapshot's are stale after a turn).
      const cursor = this.session?.client.cursors.get(this.session.id);
      if (cursor && typeof p.revision === "number") cursor.revision = p.revision;
      if (cursor && typeof p.execution_generation === "number") cursor.executionGeneration = p.execution_generation;
      const stored = typeof p.stored_session_id === "string" ? p.stored_session_id : null;
      if (stored && this.session && stored !== this.session.stored) {
        // Rotating compaction: follow the tip (flow 7). Cloned rows keep their uids, so nothing re-renders (A8).
        this.session.stored = stored;
        // The tip's events may carry its own id: listen there too (the old id keeps answering, S8 E8).
        const tip = this.host.link(this.session.root).subscribe(stored, (e) => this.onEvent(e));
        const previous = this.session.unsubscribe;
        this.session.unsubscribe = () => (previous(), tip());
        this.session.id = stored;
        if (this.ctx) this.ctx.sessionId = stored;
        if (this.turn) this.emit([{ kind: "context.compacted" }]);
      }
    }
    const id = ev.admission_id;
    if (!id) return;
    const log = this.log(id);
    if (log.firstSeq === null && typeof ev.seq === "number") log.firstSeq = ev.seq;
    if (typeof ev.execution_generation === "number") log.generation = ev.execution_generation;
    if (ev.type === "message.start") log.started = true;
    if (ev.type === "message.complete") log.done = true;
    if (log.events.length < LOGGED_EVENTS) log.events.push(ev);
    const unit = this.turn?.units.find((u) => u.admissionId === id && !u.done);
    if (unit) this.feedUnit(unit, ev);
  }

  private newUnit(own: boolean, tag: SourceTag | null): Unit {
    return {
      own,
      admissionId: null,
      submissionId: null,
      renderer: new StreamRenderer(`adm-${randomUUID().slice(0, 8)}`, this.ctx?.cwd ?? homedir()),
      settled: new Deferred(),
      done: false,
      tag,
    };
  }

  private feedUnit(unit: Unit, ev: GatewayEvent): void {
    if (unit.done) return;
    if (ev.type !== "message.complete") return this.emit(unit.renderer.feed(ev));
    const p = ev.payload ?? {};
    const deltas: ThreadDelta[] = [];
    // Streamed == final (A19, R1 S2): a gap lost across a reconnect is filled from the final text.
    const final = typeof p.text === "string" ? p.text : "";
    if (final.length > unit.renderer.text.length && final.startsWith(unit.renderer.text)) {
      deltas.push(...unit.renderer.feed({ type: "message.delta", payload: { text: final.slice(unit.renderer.text.length) } }));
    }
    // `status` complete|interrupted|error; a cancelled queued admission carries only `outcome` (Hermes `_settle_cancelled`).
    const status = p.status === "interrupted" || p.outcome === "cancelled" ? "interrupted" : p.status === "error" || p.outcome === "failed" ? "failed" : "completed";
    const error = status === "failed" ? (str(p.error) ?? str(p.failure_reason) ?? "Hermes couldn't finish this turn.") : undefined;
    deltas.push(...this.closeUnit(unit, { status, error }, (p.persisted_turn as PersistedTurn | undefined) ?? null));
    this.emit(deltas);
  }

  private closeUnit(unit: Unit, outcome: Outcome, persisted: PersistedTurn | null = null): ThreadDelta[] {
    if (unit.done) return [];
    unit.done = true;
    unit.settled.resolve({ ...outcome, persisted });
    return unit.renderer.finish(outcome.status === "completed");
  }

  // ---- Stop and steer ------------------------------------------------------------------------------------

  /** `thread/stop{interrupt}` (02 §Protocol mapping; S8 step 8; D27 narrowed). Settles before it returns. */
  async stop(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.stop();
    await Promise.all(turn.units.filter((u) => !u.done).map((u) => this.stopUnit(u)));
    const timer = setTimeout(() => {
      for (const unit of turn.units) if (!unit.done) this.emit(this.closeUnit(unit, { status: "interrupted" }));
    }, STOP_SETTLE_MS);
    await turn.finished.promise;
    clearTimeout(timer);
  }

  private async stopUnit(unit: Unit): Promise<void> {
    const session = this.session;
    if (!session || !unit.admissionId) return; // not submitted yet: the loop drops it
    const log = this.log(unit.admissionId);
    try {
      if (unit.own && !log.started) {
        // Queued behind another turn: retire it; it never runs (R1 M4). Never `session.interrupt`.
        await session.client.cancel({ profile: session.profile, session_id: session.id, admission_id: unit.admissionId });
        this.emit(this.closeUnit(unit, { status: "interrupted" }));
      } else if ((unit.own || FORWARDED.test(unit.admissionId)) && log.generation !== null) {
        await session.client.interrupt({ profile: session.profile, session_id: session.id, execution_generation: log.generation });
      } else {
        // Another app's turn: bb stops watching; the reply still shows when it ends (01 §5).
        this.emit(this.closeUnit(unit, { status: "interrupted" }));
        if (unit.tag) this.setBanner({ kind: "running_elsewhere", app: unit.tag });
      }
    } catch (error) {
      if (reasonOf(error) === "stale_generation" || reasonOf(error) === "not_found") this.emit(this.closeUnit(unit, { status: "interrupted" }));
      else throw error;
    }
  }

  /**
   * `turn/steer`: into bb's own running admission (`session.steer`), otherwise a queued `prompt.submit` that
   * renders in this turn after the current one. Never into another client's turn (R1 M4).
   */
  async steer(clientRequestId: string, input: PromptInput[], params: TurnParams): Promise<boolean> {
    const turn = this.turn;
    if (!turn || turn.stopped) return false;
    this.emit([{ kind: "input.accepted", clientRequestId }]);
    const text = input
      .filter((p): p is Extract<PromptInput, { type: "text" }> => p.type === "text" && p.visibility !== "agent-only")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (!text) return true;
    const running = turn.units.find((u) => u.own && !u.done && u.admissionId && this.log(u.admissionId).started);
    const session = this.session;
    if (running && session) {
      const generation = this.log(running.admissionId!).generation;
      try {
        if (generation !== null) {
          const ack = await session.client.steer({ profile: session.profile, session_id: session.id, execution_generation: generation, text });
          if (ack.status !== "rejected") return true;
        }
      } catch (error) {
        if (reasonOf(error) !== "stale_generation") throw error;
      }
    }
    const ctx = this.ctx ?? this.resolve(params);
    const unit = this.newUnit(true, null);
    unit.submissionId = `bb:${this.threadId}:${clientRequestId}`;
    turn.units.push(unit);
    turn.queued.push(
      this.submit(turn, ctx, unit, text).catch((error) => {
        if (unit.done) return;
        unit.done = true;
        unit.settled.resolve({ status: "failed", error: errorText(error), persisted: null });
      }),
    );
    return true;
  }

  // ---- markers: init, replay and mirror (flows 2, 5, 6) -----------------------------------------------

  private async runMarker(turn: BbTurn, marker: Marker, params: TurnParams): Promise<void> {
    switch (marker.op) {
      case "init":
        if (!isPending(this.providerThreadId)) throw new UserFacingError(INIT_REFUSED_TEXT);
        updateThread(this.host.dataDir, this.threadId, { profile: marker.profile, bot: marker.bot === true });
        return;
      case "bind": {
        const ctx = this.resolve(params);
        ctx.lineageRoot = marker.lineage_root;
        ctx.legacy = marker.legacy;
        if (marker.since !== undefined) this.emit(textItem({ providerItemId: `note:${marker.anchor_uid}` }, EARLIER_TEXT));
        return this.replay(ctx, marker.anchor_uid);
      }
      case "replay":
        return this.replay(this.resolve(params), marker.anchor_uid);
      case "mirror":
        return this.mirror(turn, this.resolve(params), marker.anchor_uid, marker.rest === true);
    }
  }

  private async chainRows(ctx: ThreadContext): Promise<RestMessage[]> {
    const id = this.session?.stored ?? ctx.sessionId ?? ctx.lineageRoot;
    if (!id) throw new UserFacingError("This thread isn't bound to a Hermes chat yet.");
    return (await this.host.history(ctx.root).chain(ctx.profile, id)).messages;
  }

  /** Render reply rows of a turn from history, leaving out `skip`; returns the uids rendered. */
  private renderReplies(ctx: ThreadContext, anchorUid: string, replies: RestMessage[], skip: ReadonlySet<string> = new Set()): string[] {
    const rows = replies.filter((r) => !skip.has(r.message_uid));
    this.emit(renderRows(rows, `row-${anchorUid.slice(0, 12)}`, ctx.cwd ?? homedir()));
    return rows.map((r) => r.message_uid);
  }

  /** Replay (flow 5): render that turn from history only; no canonical call (D16). */
  private async replay(ctx: ThreadContext, anchorUid: string): Promise<void> {
    const found = findTurn(await this.chainRows(ctx), anchorUid);
    if (found) this.renderReplies(ctx, anchorUid, found.turn.replies);
  }

  /** What a mirror turn showed: the server wakes `mirror{rest:true}` only for reply rows not in it. */
  private noteMirrored(turn: BbTurn, anchorUid: string, uids: string[], partial: boolean): void {
    const before = this.mirrored.find((m) => m.anchor_uid === anchorUid);
    const record = { anchor_uid: anchorUid, reply_uids: [...new Set([...(before?.reply_uids ?? []), ...uids])], partial, at: Date.now() };
    this.mirrored = [...this.mirrored.filter((m) => m.anchor_uid !== anchorUid), record].slice(-PERSISTED_TURNS_KEPT);
    turn.mirrors++;
  }

  /**
   * A wake (flow 6 step 4), by the turn's state: complete → render rows; running as canonical work (CLI, TUI,
   * Desktop, forwarded Conduit) → attach to its admission from its first seq and close on its
   * `message.complete`; no canonical admission (Conduit's own) → nothing beyond the bubble, `partial`.
   * `rest`: only the reply rows not shown yet. Never `session.resume` on a legacy row (A23).
   */
  private async mirror(turn: BbTurn, ctx: ThreadContext, anchorUid: string, rest: boolean): Promise<void> {
    const found = findTurn(await this.chainRows(ctx), anchorUid);
    const shown = new Set(this.mirrored.find((m) => m.anchor_uid === anchorUid)?.reply_uids ?? []);
    if (found && (rest || found.complete)) {
      const uids = this.renderReplies(ctx, anchorUid, found.turn.replies, rest ? shown : new Set());
      return this.noteMirrored(turn, anchorUid, uids, !found.complete);
    }
    if (!ctx.legacy) {
      const session = await this.ensureSession(turn, ctx);
      const admission = this.runningOutside(found?.turn.user?.content ?? null);
      if (admission) {
        const unit = this.newUnit(false, ctx.tag);
        turn.units.push(unit);
        await this.replayGap(session, admission);
        this.attach(unit, admission.id);
        if (admission.done && !unit.done) this.emit(this.closeUnit(unit, { status: "completed" }));
        const outcome = await unit.settled.promise;
        const after = findTurn(await this.chainRows(ctx), anchorUid);
        return this.noteMirrored(turn, anchorUid, after?.turn.replies.map((r) => r.message_uid) ?? [], outcome.status !== "completed" || !after?.complete);
      }
    }
    // Conduit's own turn (no canonical admission): its reply rows come by `mirror{rest:true}` (S8 step 6).
    this.noteMirrored(turn, anchorUid, [], true);
  }

  /** The outside admission running in the gateway, matched by its text when several are pending. */
  private runningOutside(userText: string | null): AdmissionLog | null {
    const outside = [...this.logs.values()].filter((l) => !(l.inputId ?? "").startsWith(`bb:${this.threadId}:`) && !this.ownAdmission(l.id));
    const live = outside.filter((l) => !l.done && (l.started || l.events.length));
    return live.find((l) => userText !== null && l.text === userText) ?? live.at(-1) ?? null;
  }

  private ownAdmission(id: string): boolean {
    return this.turn?.units.some((u) => u.own && u.admissionId === id) ?? false;
  }

  /** Events of the admission from its first seq that this socket didn't see (it attached late). */
  private async replayGap(session: SessionState, log: AdmissionLog): Promise<void> {
    if (log.firstSeq !== null && log.events.length && log.events[0]!.type === "message.start") return;
    const cursor = session.client.cursors.get(session.id);
    const since = await session.client
      .eventsSince({ profile: session.profile, session_id: session.id, last_sequence: 0, ...(cursor ? { replay_epoch: cursor.replayEpoch } : {}) })
      .catch(() => null);
    if (!since || since.snapshot_required) return;
    const have = new Set(log.events.map((e) => e.seq));
    const missing = since.events.filter((e) => e.admission_id === log.id && !have.has(e.seq));
    log.events = [...missing, ...log.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    log.firstSeq = log.events[0]?.seq ?? log.firstSeq;
    if (missing.some((e) => e.type === "message.complete")) log.done = true;
  }

  // ---- persisted turns (A37) -----------------------------------------------------------------------------

  /**
   * bb's own turns as Hermes stored them: `message.complete.persisted_turn.row_ids` → REST rows → uids; else
   * the `bb:` submission row and the rows after it. Anchors are the user rows (steers and `/retry` included).
   * Plus the outside turns this thread rendered (`mirrored`).
   */
  private async recordPersisted(turn: BbTurn): Promise<PersistedTurnState | null> {
    const ctx = this.ctx;
    const own = turn.units.filter((u) => u.own && u.submissionId);
    const sessionId = this.session?.stored ?? ctx?.sessionId ?? ctx?.lineageRoot;
    const lineageRoot = this.session?.lineageRoot ?? ctx?.lineageRoot ?? sessionId;
    if (!ctx || !sessionId || !lineageRoot || (!own.length && !turn.mirrors)) return null;
    if (own.length) {
      const results = await Promise.all(own.map(async (u) => ({ unit: u, result: await u.settled.promise })));
      const rows = (await this.host.history(ctx.root).latest(ctx.profile, sessionId).catch(() => ({ messages: [] as RestMessage[] }))).messages;
      const byId = new Map(rows.map((r) => [(r as RestMessage & { id?: number }).id, r]));
      for (const { unit, result } of results) {
        let turnRows: RestMessage[] = (result.persisted?.row_ids ?? []).map((id) => byId.get(id)).filter((r): r is RestMessage => !!r);
        if (!turnRows.length) {
          const at = rows.findIndex((r) => r.display_metadata?.submission_id === unit.submissionId);
          if (at < 0) continue;
          const end = rows.findIndex((r, i) => i > at && r.role === "user" && r.display_kind !== "steer");
          turnRows = rows.slice(at, end < 0 ? undefined : end);
        }
        if (!turnRows.length) continue;
        this.persisted = [
          ...this.persisted.filter((t) => t.submission_id !== unit.submissionId),
          {
            submission_id: unit.submissionId!,
            anchor_uids: turnRows.filter((r) => r.role === "user").map((r) => r.message_uid),
            reply_uids: turnRows.filter((r) => r.role !== "user").map((r) => r.message_uid),
            at: Date.now(),
          },
        ].slice(-PERSISTED_TURNS_KEPT);
      }
    }
    const { persisted: turns, mirrored } = this;
    updateThread(this.host.dataDir, this.threadId, { profile: ctx.profile, bot: ctx.kind === "bot", profile_home: ctx.profileHome, turns, mirrored });
    return { profile_home: ctx.profileHome, lineage_root: lineageRoot, session_id: sessionId, turns, mirrored };
  }

  // ---- release ---------------------------------------------------------------------------------------------

  /** `thread/stop{release}`: detach without ending the row (`end_reason: null`, A24). No interruption is shown. */
  async release(): Promise<void> {
    const session = this.session;
    this.turn?.stop();
    this.session = null;
    if (!session) return;
    session.unsubscribe();
    await session.client
      .detach({ profile: session.profile, session_id: session.id, subscription_id: session.subscriptionId, end_reason: null })
      .catch(() => undefined);
  }
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function reasonOf(error: unknown): string | null {
  return error instanceof HermesRpcError ? error.reason : null;
}

function errorText(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof HermesRpcError) return `Hermes refused this message (${error.reason}).`;
  if (error instanceof HermesDisconnectedError) return "Lost the connection to Hermes; check the chat in Hermes before resending.";
  if (error instanceof Error && error.message.startsWith("hermes_unreachable")) return "Hermes isn't reachable on this machine right now.";
  return `Hermes plugin error: ${error instanceof Error ? error.message : String(error)}`;
}
