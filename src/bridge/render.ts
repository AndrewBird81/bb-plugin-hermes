// Hermes → bb deltas (02 §Protocol mapping, the event table). Two inputs, one item vocabulary:
// - `StreamRenderer`: the live events of one Hermes admission (bb's own, a forwarded Conduit one, or an
//   outside canonical turn being mirrored);
// - `renderRows`: a finished turn's reply rows from the history reader (replay and mirror, flows 5–6).
// The runtime's assembler mints bb ids; we key items by Hermes ids, prefixed per admission/anchor so a
// re-render never collides (A8).
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { RestMessage } from "../hermes/history.js";
import type { GatewayEvent } from "../hermes/types.js";

type Item = Extract<ThreadDelta, { kind: "item.open" }>["item"];
type Key = { providerItemId: string };
type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Hermes' tool names → bb item shapes (terminal → command, write/patch → fileChange, read → fileRead, web search). */
export function toolItem(name: string, args: Json, cwd: string): Item {
  switch (name) {
    case "terminal":
      return { type: "command", command: str(args.command) ?? "", cwd };
    case "write_file":
      return { type: "fileChange", changes: [{ path: str(args.path) ?? "", kind: "add" }] };
    case "patch":
      return { type: "fileChange", changes: [{ path: str(args.path) ?? "", kind: "update" }] };
    case "read_file":
      return { type: "fileRead", path: str(args.path) ?? "" };
    case "web_search":
      return { type: "webSearch", queries: [str(args.query) ?? ""] };
    default:
      return { type: "tool", tool: name, server: "hermes", args };
  }
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The settled item: the start shape plus what the result adds. */
function closedItem(start: Item, result: unknown, diff: string | null): Item {
  const parsed = parseJson(result);
  if (start.type === "command") {
    const r = obj(parsed);
    return {
      ...start,
      ...(typeof r.output === "string" ? { aggregatedOutput: r.output } : typeof parsed === "string" ? { aggregatedOutput: parsed } : {}),
      ...(typeof r.exit_code === "number" ? { exitCode: r.exit_code } : {}),
    };
  }
  if (start.type === "fileChange" && diff) return { ...start, changes: start.changes.map((c) => ({ ...c, diff })) };
  if (start.type === "tool") return { ...start, result: parsed };
  return start;
}

/**
 * One admission's live stream. `feed` maps each event to deltas; `finish` closes what is still open.
 * `text` accumulates the reply as streamed, so a mirror can check streamed == final (A19, R1 S2).
 */
export class StreamRenderer {
  text = "";
  private seg = 0;
  private message: Key | null = null;
  private reasoning: Key | null = null;
  private waiting: Key | null = null;
  private readonly tools = new Map<string, Item>();
  private plan: { key: Key; steps: { step: string; status?: "pending" | "active" | "completed" }[] } | null = null;

  constructor(
    private readonly prefix: string,
    private readonly cwd: string,
  ) {}

  private key(kind: string): Key {
    return { providerItemId: `${this.prefix}:${kind}:${this.seg++}` };
  }

  private closeText(out: ThreadDelta[]): void {
    if (this.message) out.push({ kind: "item.textClose", key: this.message, channel: "agentMessage" });
    if (this.reasoning) out.push({ kind: "item.textClose", key: this.reasoning, channel: "reasoningText" });
    this.message = this.reasoning = null;
  }

  private closeWaiting(out: ThreadDelta[]): void {
    if (!this.waiting) return;
    out.push({ kind: "item.close", key: this.waiting, status: "completed", item: WAIT_ITEM });
    this.waiting = null;
  }

  feed(ev: GatewayEvent): ThreadDelta[] {
    const p = obj(ev.payload);
    const out: ThreadDelta[] = [];
    switch (ev.type) {
      case "message.delta": {
        this.closeWaiting(out);
        if (p.text === null) {
          this.closeText(out);
          break;
        }
        const text = str(p.text);
        if (!text) break;
        if (this.reasoning) {
          out.push({ kind: "item.textClose", key: this.reasoning, channel: "reasoningText" });
          this.reasoning = null;
        }
        if (!this.message) {
          this.message = this.key("msg");
          out.push({ kind: "item.open", key: this.message, item: { type: "agentMessage", text: "" } });
        }
        out.push({ kind: "item.textDelta", key: this.message, channel: "agentMessage", text });
        this.text += text;
        break;
      }
      case "message.interim": {
        const text = str(p.text);
        if (!text || p.already_streamed === true) break;
        this.closeText(out);
        const key = this.key("msg");
        out.push(...textItem(key, text));
        this.text += text;
        break;
      }
      case "reasoning.delta":
      case "reasoning.available": {
        const text = str(p.text);
        if (!text) break;
        this.closeWaiting(out);
        if (this.message) {
          out.push({ kind: "item.textClose", key: this.message, channel: "agentMessage" });
          this.message = null;
        }
        if (!this.reasoning) {
          this.reasoning = this.key("rsn");
          out.push({ kind: "item.open", key: this.reasoning, item: { type: "reasoning", content: [], summary: [] } });
        }
        out.push({ kind: "item.textDelta", key: this.reasoning, channel: "reasoningText", text });
        if (ev.type === "reasoning.available") this.closeText(out);
        break;
      }
      case "tool.start":
      case "subagent.start": {
        this.closeWaiting(out);
        this.closeText(out);
        const id = toolId(ev.type, p);
        if (!id || this.tools.has(id)) break;
        const item =
          ev.type === "tool.start"
            ? toolItem(str(p.tool_name) ?? str(p.name) ?? "tool", obj(p.args), this.cwd)
            : ({ type: "tool", tool: "subagent", server: "hermes", args: { goal: str(p.goal) ?? "" } } as Item);
        this.tools.set(id, item);
        out.push({ kind: "item.open", key: { providerItemId: `${this.prefix}:tool:${id}` }, item });
        break;
      }
      case "tool.progress":
      case "subagent.progress": {
        const id = toolId(ev.type, p);
        const message = str(p.message) ?? str(p.text) ?? str(p.tool_preview);
        if (id && this.tools.has(id) && message) out.push({ kind: "item.progress", key: { providerItemId: `${this.prefix}:tool:${id}` }, message });
        break;
      }
      case "tool.complete":
      case "subagent.complete": {
        const id = toolId(ev.type, p);
        const start = id ? this.tools.get(id) : undefined;
        if (!id || !start) break;
        this.tools.delete(id);
        const failed = p.is_error === true || p.status === "failed" || p.status === "error";
        out.push({
          kind: "item.close",
          key: { providerItemId: `${this.prefix}:tool:${id}` },
          status: failed ? "failed" : "completed",
          item: closedItem(start, ev.type === "tool.complete" ? p.result : (p.summary ?? null), str(p.inline_diff) ?? null),
        });
        break;
      }
      case "todo.updated": {
        const steps = (Array.isArray(p.todos) ? p.todos : []).map((t) => {
          const todo = obj(t);
          const status = todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "active" : "pending";
          return { step: str(todo.content) ?? str(todo.title) ?? "", status } as const;
        });
        if (!this.plan) {
          this.plan = { key: this.key("plan"), steps };
          out.push({ kind: "item.open", key: this.plan.key, item: { type: "planSteps", steps } });
        } else this.plan.steps = steps;
        break;
      }
      case "session.usage": {
        const u = obj(p.usage);
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
        const total = {
          inputTokens: n(u.input),
          cachedInputTokens: n(u.cache_read),
          outputTokens: n(u.output),
          reasoningOutputTokens: n(u.reasoning),
          totalTokens: n(u.total),
        };
        const max = typeof u.context_max === "number" ? u.context_max : null;
        out.push({ kind: "usage", last: total, total, modelContextWindow: max });
        if (typeof u.context_used === "number") {
          out.push({ kind: "contextWindow", attach: "currentOrLast", estimated: u.context_estimated === true, used: u.context_used, size: max });
        }
        break;
      }
      case "status.update": {
        const text = str(p.text) ?? "";
        // S8 step 5: Hermes' cross-process turn lease (`agent/turn_facade_lease.py:340`).
        if (/Another Hermes process|other Hermes process/.test(text) && !this.waiting) {
          this.waiting = this.key("wait");
          out.push({ kind: "item.open", key: this.waiting, item: WAIT_ITEM, presentation: WAIT_PRESENTATION });
        } else if (/Session is free/.test(text)) this.closeWaiting(out);
        break;
      }
      case "error": {
        const message = str(p.message);
        if (message) out.push({ kind: "provider.error", message });
        break;
      }
      // `thinking.delta` is spinner text, `agent.step` an iteration counter (S0-S4 cheat-sheet 7).
      default:
        break;
    }
    return out;
  }

  /** Stop watching mid-reply: an open reply ends visibly cut ("…"). True when there was one. */
  cut(): ThreadDelta[] {
    if (!this.message) return [];
    const key = this.message;
    this.text += "…";
    return [{ kind: "item.textDelta", key, channel: "agentMessage", text: "…" }];
  }

  /** The provider item id of the tool running now: the item an approval gates. */
  runningToolKey(): string | null {
    const id = [...this.tools.keys()].at(-1);
    return id ? `${this.prefix}:tool:${id}` : null;
  }

  /** Close every open item; a turn that didn't complete leaves its tools interrupted. */
  finish(completed: boolean): ThreadDelta[] {
    const out: ThreadDelta[] = [];
    this.closeWaiting(out);
    this.closeText(out);
    for (const [id, item] of this.tools) {
      out.push({ kind: "item.close", key: { providerItemId: `${this.prefix}:tool:${id}` }, status: completed ? "completed" : "interrupted", item });
    }
    this.tools.clear();
    if (this.plan) out.push({ kind: "item.close", key: this.plan.key, status: "completed", item: { type: "planSteps", steps: this.plan.steps } });
    this.plan = null;
    return out;
  }
}

const WAIT_ITEM: Item = { type: "tool", tool: "hermes.wait", server: "hermes" };
const WAIT_PRESENTATION = {
  icon: { glyph: "Clock" },
  label: { pending: "Waiting for another Hermes process…", completed: "Waited for another Hermes process" },
};

function toolId(type: string, p: Json): string | undefined {
  if (type.startsWith("subagent.")) return str(p.subagent_id) ?? str(p.delegation_id) ?? (typeof p.task_index === "number" ? `task-${p.task_index}` : undefined);
  return str(p.tool_call_id) ?? str(p.tool_id);
}

export function textItem(key: Key, text: string): ThreadDelta[] {
  return [
    { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
    { kind: "item.textDelta", key, channel: "agentMessage", text },
    { kind: "item.textClose", key, channel: "agentMessage" },
  ];
}

/** What a row shows: the display projection's text when it has one. */
export const rowText = (row: RestMessage): string => row.display_content ?? row.content ?? "";

/**
 * A finished turn's reply rows (oldest first) as deltas. User rows aren't rendered here: the visible
 * input of the bb turn is the user's bubble. Hidden and steer rows are skipped; a steer's words were the
 * user's own and show in Hermes' view only.
 */
export function renderRows(rows: readonly RestMessage[], prefix: string, cwd: string): ThreadDelta[] {
  const out: ThreadDelta[] = [];
  const open = new Map<string, { key: Key; item: Item }>();
  for (const row of rows) {
    if (row.display_kind === "hidden" || row.role === "user" || row.role === "system") continue;
    if (row.role === "assistant") {
      if (row.reasoning) {
        const key = { providerItemId: `${prefix}:${row.message_uid}:rsn` };
        out.push(
          { kind: "item.open", key, item: { type: "reasoning", content: [], summary: [] } },
          { kind: "item.textDelta", key, channel: "reasoningText", text: row.reasoning },
          { kind: "item.textClose", key, channel: "reasoningText" },
        );
      }
      const text = rowText(row);
      if (text) out.push(...textItem({ providerItemId: `${prefix}:${row.message_uid}:msg` }, text));
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const c = obj(call);
        const fn = obj(c.function);
        const id = str(c.call_id) ?? str(c.id);
        if (!id) continue;
        const item = toolItem(str(fn.name) ?? "tool", obj(parseJson(fn.arguments)), cwd);
        const key = { providerItemId: `${prefix}:tool:${id}` };
        open.set(id, { key, item });
        out.push({ kind: "item.open", key, item });
      }
    } else if (row.role === "tool") {
      const call = row.tool_call_id ? open.get(row.tool_call_id) : undefined;
      if (!call) continue;
      open.delete(row.tool_call_id!);
      out.push({ kind: "item.close", key: call.key, status: "completed", item: closedItem(call.item, row.content, null) });
    }
  }
  for (const { key, item } of open.values()) out.push({ kind: "item.close", key, status: "completed", item });
  return out;
}
