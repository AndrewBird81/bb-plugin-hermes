// One hosted bb thread on the Hermes side (02 §Protocol mapping, flows 2–9). A bb turn is a list of units run
// in order: bb's own admissions (`prompt.submit`) and renders of outside turns (markers). Events reach a unit
// by `admission_id`; every admission seen on bb's subscription is logged with its first seq, so a later wake
// can attach to a foreign one (E3b) without ever rendering an outside turn that has no marker.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { PromptInput, ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { HermesDisconnectedError, HermesRpcError, type HermesClient } from "../hermes/client.js";
import type { RestMessage } from "../hermes/history.js";
import type { AdmissionStatus, GatewayEvent, PendingPrompt, Snapshot } from "../hermes/types.js";
import { DEAD_REQUESTS_KEPT, EXTENSION_KINDS, PERSISTED_TURNS_KEPT, type PersistedTurnState, type StatusState } from "../shared/extension-state.js";
import { type Marker, type Segment, segmentInput } from "../shared/marker.js";
import { BOT_CHAT_TITLE } from "../shared/sources.js";
import { botIdentity, chatIdentity, isPending, resolveContext, type ThreadContext, UserFacingError } from "./context.js";
import { readThread, updateThread } from "./files.js";
import { readProviderOptions } from "../shared/provider-options.js";
import { findTurn, type History, type HermesLink } from "./hermes.js";
import { chooseModel, composerStates, fetchCatalog, type ModelChoice, prepareAttachments } from "./composer.js";
import { ANSWERED_ELSEWHERE_TEXT, answerFor, type PromptCard, promptCard, TIMED_OUT_TEXT } from "./interactions.js";
import { renderRows, rowText, StreamRenderer, textItem } from "./render.js";

export const DELETED_TEXT = "Deleted in Hermes.";
export const RESTARTED_TEXT = "Hermes restarted: resend?";
export const EARLIER_TEXT = "Earlier messages stay in Hermes.";
export const invalidMarkerText = (error: string) => `The Hermes plugin sent a message this version can't read (${error}); nothing was sent to Hermes.`;
export const STOPPED_WATCHING_TEXT = "Stopped watching in bb; the full reply shows below when it ends.";
export const INIT_REFUSED_TEXT = "This chat is already set up.";
/** Flow 3 step 4: 2, 5, 10, 30 s, then every 60 s. */
export const HOLD_RETRY_MS = [2000, 5000, 10_000, 30_000, 60_000];
/** How long Stop waits for Hermes to settle an interrupted turn before settling it here. */
const STOP_SETTLE_MS = 5000;
const LOGGED_ADMISSIONS = 32;
/** How long one chain read serves an import's replay markers. */
const REPLAY_CACHE_MS = 15_000;
const LOGGED_EVENTS = 5000;
/** A Conduit (dashboard) send Hermes passed into the gateway queue: its submission id (S8 E3b, T1.0). Stop may interrupt it. */
const FORWARDED = /^desktop-forward-/;

export interface ThreadHost {
  readonly dataDir: string;
  readonly pluginId: string;
  readonly holdRetryMs: readonly number[];
  /** One Hermes second, for prompt deadlines (tests shorten it with the fake's). */
  readonly secondMs: number;
  emit(threadId: string, deltas: ThreadDelta[]): void;
  /** A request to the runtime (`interaction/request`); `cancel` withdraws it (`notifications/cancelled`, A3). */
  request(method: string, params: unknown): { id: string; result: Promise<unknown> };
  cancel(id: string): void;
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
  /** Seqs already rendered: a re-attach never renders an event twice. */
  fed: Set<number>;
  /** Stop cut its reply mid-stream: that reply row isn't recorded as shown, so `rest` brings it whole. */
  cut?: boolean;
}

class BbTurn {
  stopped = false;
  units: Unit[] = [];
  /** Steers that became queued submits: awaited after the segments. */
  queued: Promise<void>[] = [];
  private wake = new Set<() => void>();
  readonly finished = new Deferred<void>();
  private submits = new Map<string, number>();
  /** A steer that can't run (a malformed marker): the turn settles failed with this. */
  failure: string | null = null;
  /** Steers carrying a marker: their segments run in order after the turn's own (R1 M6). */
  deferred: { requestId: string; segments: Segment[] }[] = [];
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

  /** One `submission_id` per prompt: `bb:<thread>:<request>`, then `:1`, `:2` for more prompts of the same request. */
  nextSubmissionId(threadId: string, requestId = this.clientRequestId): string {
    const n = this.submits.get(requestId) ?? 0;
    this.submits.set(requestId, n + 1);
    return `bb:${threadId}:${requestId}${n ? `:${n}` : ""}`;
  }
}

class Stopped extends Error {}

interface PromptEntry {
  card: PromptCard;
  prompt: PendingPrompt & Record<string, unknown>;
  requestId: string | null;
  answered: boolean;
}

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
  /** Hermes prompts on this session, whichever admission raised them (R1 S1). */
  private readonly prompts = new Map<string, PromptEntry>();
  private persisted: PersistedTurnState["turns"];
  private mirrored: PersistedTurnState["mirrored"];
  private banner: StatusState["banner"] = null;

  constructor(
    readonly threadId: string,
    public providerThreadId: string,
    private readonly host: ThreadHost,
  ) {
    const saved = readThread(host.dataDir, threadId);
    this.persisted = saved?.turns ?? [];
    this.deadRequests = saved?.dead_requests ?? [];
    this.mirrored = saved?.mirrored ?? [];
  }

  /** Released by bb: nothing more is said for this thread (a release never fabricates an interruption). */
  private released = false;

  private emit(deltas: ThreadDelta[]): void {
    if (deltas.length && !this.released) this.host.emit(this.threadId, deltas);
  }

  private state(kind: string, payload: unknown): ThreadDelta {
    return { kind: "extension.state", extensionKind: `${this.host.pluginId}/${kind}` as `${string}/${string}`, payload: payload as never };
  }

  private setBanner(banner: StatusState["banner"]): void {
    if (JSON.stringify(banner) === JSON.stringify(this.banner)) return;
    this.banner = banner;
    this.bannerSince = banner ? Date.now() : null;
    this.emit([this.statusState()]);
  }

  private bannerSince: number | null = null;
  /** Cards bb still shows for prompts Hermes settled elsewhere or timed out: the server cancels them (A3). */
  private deadRequests: string[];

  private statusState(): ThreadDelta {
    const state: StatusState = { banner: this.banner, since: this.banner ? this.bannerSince : null, ...(this.deadRequests.length ? { dead_requests: this.deadRequests } : {}) };
    return this.state(EXTENSION_KINDS.status, state);
  }

  /** bb 0.49.0 can't close a card from the bridge (T1.14): publish its id, cumulative, for the server to cancel. */
  private markDead(requestId: string): void {
    this.deadRequests = [...this.deadRequests.filter((id) => id !== requestId), requestId].slice(-DEAD_REQUESTS_KEPT);
    updateThread(this.host.dataDir, this.threadId, { dead_requests: this.deadRequests });
    this.emit([this.statusState()]);
  }

  // ---- turns -----------------------------------------------------------------------------------------

  async runTurn(params: TurnParams): Promise<void> {
    const turn = new BbTurn(params.clientRequestId);
    this.turn = turn;
    this.botChatCreated = false;
    this.emit([{ kind: "input.accepted", clientRequestId: params.clientRequestId }, { kind: "turn.open" }]);
    // "Running outside bb" ends with the next turn here (the `rest` wake when the reply lands). A new bridge
    // process doesn't know the banner an earlier one set, so the clear goes out whenever none is held.
    if (this.banner?.kind !== "held") {
      this.banner = null;
      this.emit([this.statusState()]);
    }
    this.noteOptions(params.options.providerOptions);
    if (!this.off) for (const entry of this.prompts.values()) this.raise(entry);
    let outcome: Outcome = { status: "completed" };
    try {
      const segments = segmentInput(params.input);
      const invalid = segments.find((s) => s.kind === "invalid");
      // A marker that doesn't decode: the turn fails and nothing of it reaches Hermes, its label included.
      if (invalid) throw new UserFacingError(invalidMarkerText(invalid.error));
      outcome = await this.runSegments(turn, segments, params, params.clientRequestId);
      while (turn.deferred.length && !turn.stopped) {
        const next = turn.deferred.shift()!;
        const result = await this.runSegments(turn, next.segments, params, next.requestId);
        if (result.status === "failed") outcome = result;
      }
      await Promise.all(turn.queued);
      for (const unit of turn.units) {
        const result = await unit.settled.promise;
        if (result.status === "failed" && outcome.status !== "failed") outcome = result;
      }
      if (turn.failure) outcome = { status: "failed", error: turn.failure };
    } catch (error) {
      if (!(error instanceof Stopped)) outcome = { status: "failed", error: errorText(error) };
    }
    if (turn.stopped && outcome.status !== "failed") outcome = { status: "interrupted" };
    await this.settleTurn(turn, outcome);
  }

  /** Segments in order: markers render, prompts submit (each with its own `submission_id`). */
  private async runSegments(turn: BbTurn, segments: Segment[], params: TurnParams, requestId: string): Promise<Outcome> {
    let outcome: Outcome = { status: "completed" };
    for (const segment of segments) {
      if (turn.stopped) break;
      if (segment.kind === "marker") await this.runMarker(turn, segment.marker, params);
      else if (segment.kind === "prompt") {
        const result = await this.submitPrompt(turn, this.resolve(params), segment.parts, params, requestId);
        if (result.status === "failed") outcome = result;
      }
    }
    return outcome;
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
    if (clearHeld) closing.push(this.statusState());
    if (this.turn === turn) this.turn = null;
    // A card outlives its bb turn (bb keeps it pending until answered or cancelled): it stays live.
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

  /** Provider options said the bot is switched off: no Hermes I/O for it, a reconnect included (02 §Invariants). */
  private off = false;

  /** Every command's provider options: a switched-off bot drops the session and its reconnect hook. */
  noteOptions(providerOptions: unknown): void {
    const options = readProviderOptions(providerOptions);
    // No machine (unset, or the folder changed) is off too: no Hermes I/O.
    this.off = !options?.machine || options.thread?.enabled === false;
    if (this.off) this.dropSession();
  }

  private resolve(params: TurnParams): ThreadContext {
    this.noteOptions(params.options.providerOptions);
    const saved = readThread(this.host.dataDir, this.threadId);
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

  private async submitPrompt(turn: BbTurn, ctx: ThreadContext, parts: PromptInput[], params: TurnParams, requestId: string): Promise<Outcome> {
    const text = parts
      .filter((p): p is Extract<PromptInput, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (/^\/(new|reset)(\s|$)/.test(text)) {
      await this.compress(turn, ctx);
      return { status: "completed" };
    }
    const { attachments, warnings } = prepareAttachments(parts, ctx.profileHome);
    if (!text && !attachments.length) {
      if (warnings.length) this.emit(warnings.map((summary) => ({ kind: "provider.warning", summary })));
      return { status: "completed" };
    }
    const choice = chooseModel(await this.catalog(ctx), params.options.model, params.options.reasoningLevel);
    for (const summary of [...warnings, ...(choice.warning ? [choice.warning] : [])]) this.emit([{ kind: "provider.warning", summary }]);
    const unit = this.newUnit(true);
    unit.submissionId = turn.nextSubmissionId(this.threadId, requestId);
    turn.units.push(unit);
    try {
      await this.submit(turn, ctx, unit, text, choice, attachments);
    } catch (error) {
      unit.done = true;
      if (error instanceof Stopped) throw error;
      const outcome: Outcome = { status: "failed", error: errorText(error) };
      unit.settled.resolve({ ...outcome, persisted: null });
      return outcome;
    }
    return unit.settled.promise;
  }

  private async submit(
    turn: BbTurn,
    ctx: ThreadContext,
    unit: Unit,
    text: string,
    choice: ModelChoice | null = null,
    attachments: { path: string; mime: string }[] = [],
    retried = false,
  ): Promise<void> {
    const session = await this.ensureSession(turn, ctx, choice);
    if (turn.stopped) throw new Stopped();
    if (choice) await this.applyChoice(session, choice);
    let status: AdmissionStatus;
    try {
      status = await this.retrying(session, (client) =>
        client.submit({
          profile: session.profile,
          session_id: session.id,
          text,
          ...(attachments.length ? { attachments } : {}),
          submission_id: unit.submissionId!,
          turn_author: { id: `bb:${this.threadId}`, name: "bb" },
        }),
      );
    } catch (error) {
      if (reasonOf(error) === "not_found" && !retried) {
        this.dropSession();
        if (ctx.kind === "bot") return this.submit(turn, ctx, unit, text, choice, attachments, true); // resolve by title again (S8 step 9)
        throw new UserFacingError(DELETED_TEXT);
      }
      throw error;
    }
    if (unit.admissionId !== status.admission_id) this.attach(unit, status.admission_id);
    // A retried send (same `submission_id`, A4) may answer an admission that ran before this process saw it.
    if (!unit.done && status.status !== "queued") {
      const log = this.log(status.admission_id);
      await this.replayGap(session, log);
      this.attach(unit, status.admission_id);
      if (!unit.done && (status.status === "terminal" || log.done)) await this.finishFromHistory(unit);
    }
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

  // ---- composer (T1.3) ---------------------------------------------------------------------------------

  private catalog(ctx: ThreadContext) {
    return fetchCatalog(this.host.link(ctx.root), this.host.dataDir, { profile: ctx.profile, profile_home: ctx.profileHome });
  }

  /** The chip and the bot's models for this thread (`thread/start`, `init`; S7 1a, 1c). */
  async publishComposer(ctx: ThreadContext): Promise<void> {
    this.emit(composerStates({ profile: ctx.profile, bot_label: ctx.botLabel }, await this.catalog(ctx)));
  }

  private remember(choice: ModelChoice | null): void {
    if (choice) updateThread(this.host.dataDir, this.threadId, { asked: { model: choice.model ? `${choice.provider}/${choice.model}` : null, reasoning: choice.reasoning } });
  }

  /**
   * A model or reasoning pick that changed since bb's last send → `session.mutate` while idle, fenced; the first
   * bb send into an existing chat only records it (the chat keeps its model). `null` reasoning = the bot's level.
   */
  private async applyChoice(session: SessionState, choice: ModelChoice): Promise<void> {
    const before = readThread(this.host.dataDir, this.threadId)?.asked ?? null;
    const model = choice.model ? `${choice.provider}/${choice.model}` : null;
    this.remember(choice);
    if (!before) return;
    const changes: { operation: "model" | "reasoning"; payload: Record<string, unknown> }[] = [];
    if (model && model !== before.model) changes.push({ operation: "model", payload: { model: choice.model, provider: choice.provider } });
    if (choice.reasoning !== before.reasoning && (choice.reasoning !== null || before.reasoning !== null)) changes.push({ operation: "reasoning", payload: { effort: choice.reasoning } });
    for (const change of changes) {
      try {
        await this.mutate(session, change.operation, change.payload);
      } catch (error) {
        this.emit([{ kind: "provider.warning", summary: `Hermes kept the chat's ${change.operation} (${errorText(error)})` }]);
      }
    }
  }

  /** `session.mutate` with the fences; one retry at fresh fences (a value pick is harmless to re-apply). */
  private async mutate(session: SessionState, operation: string, payload: Record<string, unknown>): Promise<void> {
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
          operation,
          payload,
        });
        if (typeof result.revision === "number") cursor.revision = result.revision;
        const generation = (result as { execution_generation?: unknown }).execution_generation;
        if (typeof generation === "number") cursor.executionGeneration = generation;
        // A rotating compress names the new tip here: history reads follow it; the live id stays (flow 7).
        const target = (result as { target_session_id?: unknown }).target_session_id;
        if (typeof target === "string" && target) {
          session.stored = target;
          if (this.ctx) this.ctx.sessionId = target;
        }
        return;
      } catch (error) {
        const reason = reasonOf(error);
        if (attempt > 0 || (reason !== "revision_conflict" && reason !== "stale_generation")) throw error;
        await session.client.resume({ profile: session.profile, session_id: session.id, omit_messages: true });
      }
    }
  }

  // ---- sessions ----------------------------------------------------------------------------------------

  /** Unsubscribe and forget the session; admissions not seen to finish go too (a later match would hang on them). */
  /**
   * Unsubscribe and forget the session; admissions not seen to finish go too (a later match would hang on
   * them). Its open cards can't be answered or seen to settle any more: they die (`dead_requests`).
   */
  private dropSession(): void {
    this.lingering = false;
    this.session?.unsubscribe();
    this.session = null;
    for (const [id, log] of this.logs) if (!log.done) this.logs.delete(id);
    for (const [promptId, entry] of this.prompts) {
      this.prompts.delete(promptId);
      if (entry.requestId && !entry.answered) this.markDead(entry.requestId);
    }
  }

  /** Stop kept the session for live cards: drop it once the last one settles or dies. */
  private lingering = false;

  private liveCards(): boolean {
    return [...this.prompts.values()].some((e) => e.requestId !== null && !e.answered);
  }

  /** After Stop: keep listening (and the reconnect hook) while a card is live, so its settling is seen. */
  private dropUnlessCardsLive(): void {
    if (this.liveCards()) this.lingering = true;
    else this.dropSession();
  }

  private maybeDropLingering(): void {
    if (this.lingering && !this.turn && !this.liveCards()) this.dropSession();
  }

  private async ensureSession(turn: BbTurn, ctx: ThreadContext, choice: ModelChoice | null = null): Promise<SessionState> {
    // A bot thread resolves its Bot Chat by title on every send (S8 step 1); other threads keep theirs.
    if (ctx.kind === "bot") return this.withHold(turn, () => this.openBotChat(ctx));
    if (this.session && !this.session.client.closed) return this.session;
    this.dropSession();
    const client = await this.host.link(ctx.root).client();
    if (ctx.sessionId || ctx.lineageRoot) {
      // Resuming adopts a legacy row once, on this first bb send only (D16, A23).
      const id = (ctx.sessionId ?? ctx.lineageRoot)!;
      const snap = await this.withHold(turn, () => this.resume(client, ctx.profile, id));
      return this.adopt(ctx, client, snap, ctx.lineageRoot ?? snap.session_id);
    }
    const snap = await client.create({
      profile: ctx.profile,
      request_id: `bb:${this.threadId}`,
      // `gui`, as Desktop's side chats: `hermes chat -c` picks up `cli` chats (A20 failed, T1.0).
      source: "gui",
      cwd: ctx.cwd ?? homedir(),
      ...(choice?.model ? { model: choice.model } : {}),
      ...(choice?.provider ? { provider: choice.provider } : {}),
      ...(choice?.reasoning ? { reasoning: choice.reasoning } : {}),
    });
    this.remember(choice);
    return this.adopt(ctx, client, snap, snap.session_id);
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
      unsubscribe: () => undefined,
    };
    const offEvents = link.subscribe(snap.session_id, (ev) => this.onEvent(ev));
    const offReconnect = link.onReconnect((fresh) => void this.reattach(session, fresh).catch(() => undefined));
    session.unsubscribe = () => (offEvents(), offReconnect());
    this.session = session;
    ctx.lineageRoot = lineageRoot;
    ctx.sessionId = snap.stored_session_id;
    this.notePending(snap.pending);
    // Every attach re-raises the snapshot's open prompts (02 §Protocol mapping).
    for (const prompt of snap.prompts ?? []) this.addPrompt(prompt as PendingPrompt & Record<string, unknown>, null);
    return session;
  }

  /**
   * Flow 3 steps 1–3 (S8 §Recommended protocol): the Bot Chat by title, never by a stored id; none → re-check,
   * then one lazy create (it returns any Bot Chat made meanwhile, E1); else resume. The same session as last
   * time keeps its subscription; another one (re-minted, renamed, rotated) is followed (step 6).
   */
  private async openBotChat(ctx: ThreadContext, create: false): Promise<SessionState | null>;
  private async openBotChat(ctx: ThreadContext, create?: true): Promise<SessionState>;
  private async openBotChat(ctx: ThreadContext, create = true): Promise<SessionState | null> {
    const client = await this.host.link(ctx.root).client();
    const lookup = async () => {
      // Hermes resolves the title itself (exact `Bot Chat`, projected along its chain): its answer is the Bot
      // Chat even when the row it names shows another title (a rotated root's is empty; `session_controls.py:575-589`).
      const { sessions } = await client.sessionList({ profile: ctx.profile, title: BOT_CHAT_TITLE, include_hidden: true });
      return sessions[0] ?? null;
    };
    const row = (await lookup()) ?? (await lookup());
    const current = this.session;
    if (row && current && !current.client.closed && current.client === client && (row.session_id === current.id || row.session_id === current.stored)) return current;
    this.dropSession();
    if (row) {
      const lineageRoot = await this.chainRoot(ctx, row.session_id);
      const snap = await this.resume(client, ctx.profile, row.session_id);
      return this.adopt(ctx, client, snap, lineageRoot);
    }
    if (!create) return null;
    if (this.botChatCreated) throw new HermesRpcError({ message: "runtime_coordination_required" });
    this.botChatCreated = true;
    let snap: Snapshot;
    try {
      snap = await client.create({
        profile: ctx.profile,
        title: BOT_CHAT_TITLE,
        hidden: true,
        follow_profile_config: true,
        request_id: `bb:botchat:${ctx.profileHome}`,
      });
    } catch (error) {
      // Only a hold makes the create "done" for this wait; any other failure may be retried by the next send.
      if (reasonOf(error) !== "runtime_coordination_required") this.botChatCreated = false;
      throw error;
    }
    return this.adopt(ctx, client, snap, snap.session_id);
  }

  /**
   * The lineage root of the chain `sessionId` belongs to. `session.list{title}` names the session that holds the
   * title, and a rotating compress moves the title to the tip (S8 E8; `session_controls.py:575-589`,
   * `session_local_title.py:21-23`), so neither its `session_id` nor its `id` is the root. The chain's first
   * row is (REST answers any chain id with the whole chain, T0.5); an empty chain is its own root.
   */
  private async chainRoot(ctx: ThreadContext, sessionId: string): Promise<string> {
    if (this.session && (sessionId === this.session.id || sessionId === this.session.stored)) return this.session.lineageRoot;
    const rows = await this.host
      .history(ctx.root)
      .chain(ctx.profile, sessionId)
      .then((c) => c.messages)
      .catch(() => [] as RestMessage[]);
    if (ctx.lineageRoot && rows.some((r) => r.session_id === ctx.lineageRoot)) return ctx.lineageRoot;
    return rows[0]?.session_id ?? sessionId;
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
    // A bot with no Bot Chat yet has nothing to compact: `/new` is no reason to create one (S8 step 2).
    const session = ctx.kind === "bot" ? await this.withHold(turn, () => this.openBotChat(ctx, false)) : await this.ensureSession(turn, ctx);
    if (!session) return;
    try {
      await this.mutate(session, "compress", {});
    } catch (error) {
      if (reasonOf(error) === "session_busy") throw new UserFacingError("Hermes is busy with this chat; send /new again when it's done.");
      throw error;
    }
    this.emit([{ kind: "context.compacted" }]);
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
      // Our submit is pending here before its reply may come back: route its events from now on.
      const unit = this.turn?.units.find((u) => u.own && !u.admissionId && u.submissionId === p.input_id);
      if (unit) this.attach(unit, p.admission_id);
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
      // A rotating compress keeps a root subscriber's events, epoch and `stored_session_id` on the root
      // (rotating-viewer.json): the live id never changes. Only the tip for history reads moves (flow 7).
      if (stored && this.session && stored !== this.session.stored && stored !== this.session.id) {
        this.session.stored = stored;
        if (this.ctx) this.ctx.sessionId = stored;
        if (this.turn) this.emit([{ kind: "context.compacted" }]);
      }
    }
    if (ev.type === "approval.request" || ev.type === "clarify.request") this.addPrompt(ev.payload as PendingPrompt & Record<string, unknown>, ev.admission_id ?? null);
    else if (ev.type === "approval.settled" || ev.type === "clarify.settled") this.settlePrompt(String(ev.payload?.prompt_id ?? ""), false);
    else if (ev.type === "approval.cancelled") for (const id of (ev.payload?.request_ids as unknown[] | undefined) ?? []) this.settlePrompt(String(id), true);
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

  private newUnit(own: boolean): Unit {
    return {
      own,
      admissionId: null,
      submissionId: null,
      renderer: new StreamRenderer(`adm-${randomUUID().slice(0, 8)}`, this.ctx?.cwd ?? homedir()),
      settled: new Deferred(),
      done: false,
      fed: new Set(),
    };
  }

  private feedUnit(unit: Unit, ev: GatewayEvent): void {
    if (unit.done) return;
    if (typeof ev.seq === "number") {
      if (unit.fed.has(ev.seq)) return;
      unit.fed.add(ev.seq);
    }
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

  // ---- reconnect and restart (T1.5, flows 8–9) -----------------------------------------------------------

  /**
   * After a drop: `events.since` from the cursor, then resume (the client's `reattach`: no duplicate, no gap).
   * A gap lost (`snapshot_required`, a new epoch, `truncated`) leaves the snapshot. bb's own `unknown`
   * admissions (the gateway restarted mid-turn) → `prompt.resolve_unknown` at once and the turn fails
   * "Hermes restarted: resend?" (S8 E11b); until then Conduit is refused. Open prompts are raised again.
   */
  private async reattach(session: SessionState, client: HermesClient): Promise<void> {
    if (this.session !== session) return;
    if (this.off) return this.dropSession();
    const cursor = session.client.cursors.get(session.id);
    session.client = client;
    let snap: Snapshot;
    try {
      snap = cursor ? (await client.reattach(session.profile, session.id, cursor)).snapshot : await client.resume({ profile: session.profile, session_id: session.id, omit_messages: true });
    } catch (error) {
      if (reasonOf(error) === "not_found") this.dropSession();
      return;
    }
    session.subscriptionId = snap.subscription_id;
    this.notePending(snap.pending);
    const open = new Set((snap.prompts ?? []).map((p) => p.prompt_id));
    for (const [id, entry] of this.prompts) {
      if (open.has(id)) continue;
      this.prompts.delete(id); // gone with the old owner
      if (entry.requestId && !entry.answered) {
        this.host.cancel(entry.requestId);
        this.markDead(entry.requestId);
      }
    }
    for (const prompt of snap.prompts ?? []) this.addPrompt(prompt as PendingPrompt & Record<string, unknown>, null);
    const mine = `bb:${this.threadId}:`;
    for (const p of snap.pending ?? []) {
      if (p.status !== "unknown" || !(p.input_id ?? "").startsWith(mine) || typeof p.execution_generation !== "number") continue;
      await client
        .resolveUnknown({ profile: session.profile, session_id: session.id, admission_id: p.admission_id, execution_generation: p.execution_generation })
        .catch(() => undefined);
      const unit = this.turn?.units.find((u) => u.admissionId === p.admission_id && !u.done);
      if (unit) this.emit(this.closeUnit(unit, { status: "failed", error: RESTARTED_TEXT }));
    }
    // bb's own admissions that ended while we were away, their completion not replayed: from history.
    for (const unit of this.turn?.units ?? []) {
      if (unit.done || !unit.own || !unit.admissionId) continue;
      if ((snap.pending ?? []).some((p) => p.admission_id === unit.admissionId)) continue;
      await this.finishFromHistory(unit);
    }
  }

  /** Render a finished admission of bb's from its stored rows and close it. */
  private async finishFromHistory(unit: Unit): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || unit.done) return;
    const rows = await this.chainRows(ctx).catch(() => [] as RestMessage[]);
    const at = rows.findIndex((r) => r.display_metadata?.submission_id === unit.submissionId);
    if (at < 0) return;
    const turnFound = findTurn(rows, rows[at]!.message_uid);
    const shown = new Set<string>();
    if (unit.renderer.text) for (const r of turnFound?.turn.replies ?? []) if (r.role === "assistant" && rowText(r) && unit.renderer.text.startsWith(rowText(r))) shown.add(r.message_uid);
    if (turnFound) this.renderReplies(ctx, rows[at]!.message_uid, turnFound.turn.replies, shown);
    this.emit(this.closeUnit(unit, { status: "completed" }));
  }

  // ---- approvals and clarify (T1.2) ----------------------------------------------------------------------

  private addPrompt(prompt: PendingPrompt & Record<string, unknown>, admissionId: string | null): void {
    if (!prompt?.prompt_id || this.prompts.has(prompt.prompt_id)) return;
    const unit = admissionId ? this.turn?.units.find((u) => u.admissionId === admissionId) : undefined;
    const entry: PromptEntry = { card: this.card(prompt, unit), prompt, requestId: null, answered: false };
    this.prompts.set(prompt.prompt_id, entry);
    this.raise(entry);
  }

  private card(prompt: PendingPrompt & Record<string, unknown>, unit: Unit | undefined): PromptCard {
    return promptCard(prompt, unit?.renderer.runningToolKey() ?? null, Date.now(), this.host.secondMs);
  }

  /** bb routes a request only into an open turn: raise now if one is open, else when the next one opens. */
  private raise(entry: PromptEntry): void {
    if (!this.turn || entry.requestId || entry.answered) return;
    const { id, result } = this.host.request("interaction/request", { threadId: this.threadId, providerThreadId: this.providerThreadId, turnId: null, payload: entry.card.payload });
    entry.requestId = id;
    result.then(
      (resolution) => this.answer(entry, id, resolution),
      () => {
        if (entry.requestId === id) entry.requestId = null;
      },
    );
  }

  /** Only bb's user answers: the bridge never answers for them (A2), and sends only a choice Hermes offered. */
  private async answer(entry: PromptEntry, id: string, resolution: unknown): Promise<void> {
    if (entry.requestId !== id || !this.prompts.has(entry.card.promptId)) return;
    if (this.off) {
      // Switched off: no Hermes I/O; the card dies.
      this.prompts.delete(entry.card.promptId);
      this.markDead(id);
      return;
    }
    const answer = answerFor(entry.card, resolution);
    const session = this.session;
    if (answer === null || !session) {
      entry.requestId = null;
      return;
    }
    entry.answered = true;
    const base = { profile: session.profile, session_id: session.id, execution_generation: entry.card.generation, prompt_id: entry.card.promptId };
    try {
      if (entry.card.kind === "approval") await session.client.approvalRespond({ ...base, choice: answer });
      else await session.client.clarifyRespond({ ...base, answer });
    } catch (error) {
      // Settled meanwhile (another app, the deadline, Stop): nothing to say (02 §Protocol mapping).
      if (reasonOf(error) === "stale_generation" || reasonOf(error) === "not_found") return;
      if (this.turn) this.emit([{ kind: "provider.warning", summary: `Hermes didn't take the answer (${errorText(error)})` }]);
    }
  }

  /** Hermes settled a prompt: ours closes silently; one bb didn't answer closes with why. */
  private settlePrompt(promptId: string, dropped: boolean): void {
    const entry = this.prompts.get(promptId);
    if (!entry) return;
    this.prompts.delete(promptId);
    if (!entry.answered && entry.requestId) {
      // Withdraw it (a later bb honours `notifications/cancelled`; 0.49.0 doesn't) and have the server close it.
      this.host.cancel(entry.requestId);
      this.markDead(entry.requestId);
    }
    this.maybeDropLingering();
    if (entry.answered || dropped || !this.turn) return;
    const timedOut = entry.card.deadline !== null && Date.now() >= entry.card.deadline - 1000;
    this.emit([{ kind: "provider.warning", summary: timedOut ? TIMED_OUT_TEXT : ANSWERED_ELSEWHERE_TEXT }]);
  }

  // ---- Stop and steer ------------------------------------------------------------------------------------

  /** `thread/stop{interrupt}` (02 §Protocol mapping; S8 step 8; D27 narrowed). Settles before it returns. */
  async stop(): Promise<void> {
    const turn = this.turn;
    if (!turn) return this.dropUnlessCardsLive();
    turn.stop();
    await Promise.all(turn.units.filter((u) => !u.done).map((u) => this.stopUnit(u)));
    const timer = setTimeout(() => {
      for (const unit of turn.units) if (!unit.done) this.emit(this.closeUnit(unit, { status: "interrupted" }));
    }, STOP_SETTLE_MS);
    await turn.finished.promise;
    clearTimeout(timer);
    // Stop leaves nothing listening once no card is live: the next send resolves its session again.
    this.dropUnlessCardsLive();
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
      } else if ((unit.own || FORWARDED.test(log.inputId ?? "")) && log.generation !== null) {
        await session.client.interrupt({ profile: session.profile, session_id: session.id, execution_generation: log.generation });
      } else {
        // Another app's turn: bb stops watching; the reply still shows when it ends (01 §5). A reply cut
        // mid-stream says so, so the full copy the `rest` wake brings doesn't read as a repeat.
        const cut = unit.renderer.cut();
        unit.cut = cut.length > 0;
        this.emit([...cut, ...this.closeUnit(unit, { status: "interrupted" })]);
        if (unit.cut) this.emit(textItem({ providerItemId: `${unit.admissionId}:cut` }, STOPPED_WATCHING_TEXT));
        this.setBanner({ kind: "running_elsewhere" });
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
    const segments = segmentInput(input);
    const invalid = segments.find((s) => s.kind === "invalid");
    if (invalid) {
      // Nothing of it reaches Hermes; the turn it joined fails (as a turn with that input would).
      this.emit([{ kind: "input.accepted", clientRequestId }]);
      turn.failure ??= invalidMarkerText(invalid.error);
      return true;
    }
    this.emit([{ kind: "input.accepted", clientRequestId }]);
    if (segments.some((s) => s.kind === "marker")) {
      // bb steers the next queued message into the turn: a queued wake (its label, its marker) renders in
      // order after the turn's own work, through `runMarker`; never as text to Hermes (02 §Invariants).
      turn.deferred.push({ requestId: clientRequestId, segments });
      return true;
    }
    const text = segments
      .flatMap((s) => (s.kind === "prompt" ? s.parts : []))
      .filter((p): p is Extract<PromptInput, { type: "text" }> => p.type === "text")
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
    const unit = this.newUnit(true);
    unit.submissionId = turn.nextSubmissionId(this.threadId, clientRequestId);
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
        try {
          await this.publishComposer(this.resolve(params));
        } catch {
          // Not a switched-on bot (yet): the chip comes with the first send.
        }
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

  /**
   * Replay (flow 5): render that turn from history only; no canonical call (D16). An import sends one replay
   * per turn in a row: one chain read serves them (re-read when the anchor isn't in it).
   */
  private async replay(ctx: ThreadContext, anchorUid: string): Promise<void> {
    const cached = this.replayRows && Date.now() - this.replayRows.at < REPLAY_CACHE_MS ? this.replayRows.rows : null;
    let found = cached ? findTurn(cached, anchorUid) : null;
    if (!found) {
      const rows = await this.chainRows(ctx);
      this.replayRows = { rows, at: Date.now() };
      found = findTurn(rows, anchorUid);
    }
    if (found) this.renderReplies(ctx, anchorUid, found.turn.replies);
  }

  private replayRows: { rows: RestMessage[]; at: number } | null = null;

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
    const session = await this.watch(ctx);
    if (session) {
      const admission = this.runningOutside(found?.turn.user ? rowText(found.turn.user) : null);
      if (admission) {
        const unit = this.newUnit(false);
        turn.units.push(unit);
        await this.replayGap(session, admission);
        this.attach(unit, admission.id);
        if (admission.done && !unit.done) this.emit(this.closeUnit(unit, { status: "completed" }));
        const outcome = await unit.settled.promise;
        const after = findTurn(await this.chainRows(ctx), anchorUid);
        // A cut reply's text row was shown only in part: leave it to the `rest` wake.
        const shown = (after?.turn.replies ?? []).filter((r) => !(unit.cut && r.role === "assistant" && rowText(r)));
        return this.noteMirrored(turn, anchorUid, shown.map((r) => r.message_uid), outcome.status !== "completed" || !after?.complete);
      }
    }
    // Conduit's own turn (no canonical admission): its reply rows come by `mirror{rest:true}` (S8 step 6).
    this.noteMirrored(turn, anchorUid, [], true);
  }

  /**
   * The bound session, to watch an outside turn: never a title lookup, a create or a hold, and never a resume
   * of a legacy row (A23). Null when there's nothing bound or Hermes won't let us watch.
   */
  private async watch(ctx: ThreadContext): Promise<SessionState | null> {
    if (this.session && !this.session.client.closed) return this.session;
    const id = ctx.sessionId ?? ctx.lineageRoot;
    if (ctx.legacy || !id) return null;
    try {
      const client = await this.host.link(ctx.root).client();
      return this.adopt(ctx, client, await client.resume({ profile: ctx.profile, session_id: id, omit_messages: true }), ctx.lineageRoot ?? id);
    } catch {
      return null;
    }
  }

  /** The outside admission running in the gateway whose text is the turn's user text; null rather than a guess. */
  private runningOutside(userText: string | null): AdmissionLog | null {
    if (userText === null) return null;
    const mine = `bb:${this.threadId}:`;
    return [...this.logs.values()].find((l) => !l.done && l.text === userText && !(l.inputId ?? "").startsWith(mine) && !this.ownAdmission(l.id)) ?? null;
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
    let tip = sessionId;
    if (own.length) {
      const results = await Promise.all(own.map(async (u) => ({ unit: u, result: await u.settled.promise })));
      const page = await this.host
        .history(ctx.root)
        .latest(ctx.profile, sessionId)
        .catch(() => ({ session_id: sessionId, messages: [] as RestMessage[] }));
      // REST names the chain's tip (T0.5): the live socket keeps the root after a rotation (rotating-viewer.json).
      tip = page.session_id;
      if (this.session) this.session.stored = tip;
      const rows = page.messages;
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
    return { profile_home: ctx.profileHome, lineage_root: lineageRoot, session_id: tip, turns, mirrored };
  }

  // ---- release ---------------------------------------------------------------------------------------------

  /** `thread/stop{release}`: detach without ending the row (`end_reason: null`, A24). No interruption is shown. */
  async release(): Promise<void> {
    const session = this.session;
    this.released = true;
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
