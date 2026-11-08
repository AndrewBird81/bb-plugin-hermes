// Approvals and `clarify` (02 §Protocol mapping; D11): a Hermes prompt becomes a bb `interaction/request`
// with Hermes' own choices only and the request's deadline, and bb's answer goes back as Hermes' choice.
// Never auto-approve; never widen the choices (03 §Rules).
import { USER_QUESTION_MAX_OPTIONS, type PendingInteractionApprovalDecision } from "@get-bb/plugin-sdk/provider-bridge";
import type { PendingPrompt } from "../hermes/types.js";

/**
 * bb 0.49.0 can't withdraw a card the bridge raised (A3 failed: `notifications/cancelled` reaches only the
 * daemon's tool-call tracker; the server ends provider interactions only on a thread stop, delete, host
 * removal or provider exit). So the text tells the user the card is dead: any answer goes nowhere.
 */
export const ANSWERED_ELSEWHERE_TEXT = "Answered elsewhere. Its card here no longer does anything: dismiss it to continue.";
export const TIMED_OUT_TEXT = "Timed out in Hermes. Its card here no longer does anything: dismiss it to continue.";

/** Hermes' approval choices → bb's decisions. `always` (allow-list it forever) has no bb decision: left out, never widened. */
const DECISIONS: Record<string, PendingInteractionApprovalDecision> = { once: "allow_once", session: "allow_for_session", deny: "deny" };

type Json = Record<string, unknown>;

export interface PromptCard {
  promptId: string;
  kind: "approval" | "clarify";
  generation: number;
  choices: string[];
  /** Unix ms when Hermes gives up on it; null when it said no timeout. */
  deadline: number | null;
  payload: Json;
}

function deadlineText(timeoutS: number | null | undefined, now: number): string | null {
  if (typeof timeoutS !== "number" || timeoutS <= 0) return null;
  const at = new Date(now + timeoutS * 1000);
  return `Hermes waits ${timeoutS} s for an answer (until ${at.toTimeString().slice(0, 5)}).`;
}

/** The card for a Hermes prompt (an event payload or a snapshot's `prompts[]` entry). `itemId`: the tool item it gates. */
export function promptCard(prompt: PendingPrompt & Json, itemId: string | null, now = Date.now(), secondMs = 1000): PromptCard {
  const timeout = typeof prompt.timeout_s === "number" ? prompt.timeout_s : null;
  const deadline = timeout && timeout > 0 ? now + timeout * secondMs : null;
  const choices = Array.isArray(prompt.choices) ? prompt.choices.filter((c): c is string => typeof c === "string") : [];
  const base = { promptId: prompt.prompt_id, kind: prompt.kind, generation: prompt.execution_generation, choices, deadline };
  const when = deadlineText(timeout, now);
  if (prompt.kind === "approval") {
    const edit = prompt.edit && typeof prompt.edit === "object" ? (prompt.edit as Json) : null;
    const command = typeof prompt.command === "string" ? prompt.command : "";
    const subject = edit
      ? { kind: "file_change", itemId: itemId ?? prompt.prompt_id, writeScope: typeof edit.path === "string" ? edit.path : null, sessionGrant: null }
      : { kind: "command", itemId: itemId ?? prompt.prompt_id, command, cwd: null, actions: [{ type: "unknown", command }], sessionGrant: null };
    const reason = [typeof prompt.description === "string" ? prompt.description : null, edit ? command : null, when].filter(Boolean).join(" · ") || null;
    const availableDecisions = choices.map((c) => DECISIONS[c]).filter((d): d is PendingInteractionApprovalDecision => !!d);
    return { ...base, payload: { kind: "approval", subject, reason, availableDecisions } };
  }
  const question = typeof prompt.question === "string" && prompt.question ? prompt.question : "Hermes has a question.";
  // bb shows at most 4 options; with more, every choice goes in the question and the answer is typed.
  const fits = choices.length > 0 && choices.length <= USER_QUESTION_MAX_OPTIONS;
  const listed = !fits && choices.length ? `\n${choices.map((c) => `- ${c}`).join("\n")}` : "";
  return {
    ...base,
    payload: {
      kind: "user_question",
      questions: [
        {
          id: prompt.prompt_id,
          prompt: `${question}${listed}${when ? `\n\n${when}` : ""}`,
          shortLabel: "Hermes asks",
          multiSelect: prompt.multi_select === true && fits,
          allowFreeText: !fits,
          required: true,
          ...(fits ? { options: choices.map((c) => ({ label: c, value: c })) } : {}),
        },
      ],
    },
  };
}

/** bb's resolution → the Hermes answer (`choice` for an approval, `answer` for clarify); null = no usable answer. */
export function answerFor(card: PromptCard, resolution: unknown): string | null {
  const r = resolution && typeof resolution === "object" ? (resolution as Json) : null;
  if (!r) return null;
  if (card.kind === "approval") {
    const decision = r.decision;
    const choice = Object.entries(DECISIONS).find(([, d]) => d === decision)?.[0];
    return choice && card.choices.includes(choice) ? choice : null;
  }
  const answer = (r.answers as Record<string, { selected?: unknown; freeText?: unknown }> | undefined)?.[card.promptId];
  if (!answer) return null;
  const selected = Array.isArray(answer.selected) ? answer.selected.filter((s): s is string => typeof s === "string") : [];
  const text = [...selected, ...(typeof answer.freeText === "string" && answer.freeText.trim() ? [answer.freeText.trim()] : [])].join(", ");
  return text || null;
}
