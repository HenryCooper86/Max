// Max Cloud conversation history: what was said in a project's sessions, kept
// for 30 days so the customer can see how their agent is doing. Only final
// transcript lines and tool outcomes are kept; never audio.

import { now } from "./context";
import { newId } from "./secrets";
import type { AnalysisResult } from "../../shared/analysis";
import type { ConversationAnalysis } from "./analysis";
import {
  conversationById,
  insertConversation,
  liveProject,
  projectConversations,
  pruneConversations,
  type ConversationRow
} from "./store";
import type { Result } from "./customers";

const CONVERSATION_RETENTION_MS = 30 * 86_400_000;
const MAX_TURNS = 400;
const MAX_TEXT = 2000;
const LIST_LIMIT = 100;

export type ConversationTurn = {
  at: number;
  speaker: "user" | "agent" | "tool";
  text: string;
  /** Tool turns: whether the call worked, and how long it took. */
  ok?: boolean;
  ms?: number;
  /** Agent turns: how long the user waited, from the end of their turn (their words final on the relay) to the
   *  first sound of this answer. */
  answerMs?: number;
};

/** The middle one of the times a conversation's answers took to begin; none when no answer was timed. */
export function medianAnswerMs(turns: readonly ConversationTurn[]): number | undefined {
  const times = turns
    .flatMap((turn) => (turn.speaker === "agent" && typeof turn.answerMs === "number" ? [turn.answerMs] : []))
    .sort((a, b) => a - b);
  if (times.length === 0) return undefined;
  const middle = Math.floor(times.length / 2);
  return times.length % 2 ? times[middle]! : Math.round((times[middle - 1]! + times[middle]!) / 2);
}

export type ConversationSummary = {
  id: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  source: string;
  /** The first thing the user said, as a title. */
  preview: string;
  /** How long the user waited for an answer to begin: the median over the conversation's answers. */
  answerMs?: number;
  /** What the analysis made of it, for a mark in the list: present once it has been analysed. */
  sentiment?: AnalysisResult["sentiment"];
  success?: boolean;
};

/** A stored analysis, or none when there is none or it cannot be read. */
function analysisOf(raw: string | null | undefined): ConversationAnalysis | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.at === "number" ? (parsed as ConversationAnalysis) : undefined;
  } catch {
    return undefined;
  }
}

const SENTIMENTS: ReadonlyArray<AnalysisResult["sentiment"]> = ["positive", "neutral", "negative"];

function marksOf(raw: string | null | undefined): Pick<ConversationSummary, "sentiment" | "success"> {
  const result = analysisOf(raw)?.result;
  return {
    ...(result?.sentiment && SENTIMENTS.includes(result.sentiment) ? { sentiment: result.sentiment } : {}),
    ...(typeof result?.success === "boolean" ? { success: result.success } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Collects one session's turns from the events the relay sends its client. */
export function conversationRecorder(clock: () => number = now) {
  const turns: ConversationTurn[] = [];
  // Speech arrives as growing partial lines per turn; keep the latest final text of each.
  const spoken = new Map<string, number>();
  const startedAt = clock();
  /** How long the answer now being spoken took to begin: it belongs to that answer's line. */
  let waited: number | undefined;
  /** Which of the agent's turns that answer is, once it is known: a line the relay speaks in between is not it. */
  let waitedTurn: string | undefined;
  /** The agent's turn whose words are coming in. */
  let agentOpen: string | undefined;

  return {
    startedAt,
    event(payload: unknown): void {
      if (!isRecord(payload) || turns.length >= MAX_TURNS) return;
      if (payload.type === "metric") {
        // Sent with the first sound of an answer: the time from the user's last word to it.
        const ms = payload.latencyMs;
        if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
          waited = Math.min(Math.round(ms), 600_000);
          waitedTurn = agentOpen;
        }
        return;
      }
      if (payload.type === "transcript" && payload.final !== true && payload.speaker !== "rider") {
        // The words of an answer under way say which turn its first sound belonged to.
        if (typeof payload.turnId !== "string") return;
        agentOpen = payload.turnId;
        if (waited !== undefined) waitedTurn ??= payload.turnId;
        return;
      }
      if (payload.type === "transcript" && payload.final === true && typeof payload.text === "string") {
        const text = payload.text.trim().slice(0, MAX_TEXT);
        if (!text) return;
        const speaker = payload.speaker === "rider" ? "user" : "agent";
        const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
        if (speaker === "agent" && turnId === agentOpen) agentOpen = undefined;
        const key = `${speaker}:${turnId ?? turns.length}`;
        const index = spoken.get(key);
        if (index !== undefined) {
          turns[index] = { ...turns[index]!, text };
          return;
        }
        spoken.set(key, turns.length);
        // A line of the relay's own, spoken while the answer is under way, does not take the answer's time.
        const mine = speaker === "agent" && (waitedTurn === undefined || waitedTurn === turnId);
        const answerMs = mine ? waited : undefined;
        // An answer that was cut off before it had words leaves its time with nobody.
        if (mine || speaker === "user") {
          waited = undefined;
          waitedTurn = undefined;
        }
        if (speaker === "user") agentOpen = undefined;
        turns.push({ at: clock(), speaker, text, ...(answerMs !== undefined ? { answerMs } : {}) });
        return;
      }
      if (payload.type === "tool.activity" && typeof payload.name === "string") {
        if (payload.state !== "succeeded" && payload.state !== "failed") return;
        const error = typeof payload.error === "string" ? `: ${payload.error.slice(0, 300)}` : "";
        turns.push({
          at: clock(),
          speaker: "tool",
          text: `${payload.name.slice(0, 64)}${payload.state === "failed" ? error : ""}`,
          ok: payload.state === "succeeded",
          ...(typeof payload.durationMs === "number" ? { ms: Math.round(payload.durationMs) } : {})
        });
      }
    },
    turns(): ConversationTurn[] {
      return turns.slice();
    }
  };
}

export type ConversationRecorder = ReturnType<typeof conversationRecorder>;

/** Saves a finished session's conversation (when it has any turns) and drops ones past retention. */
export function saveConversation(input: {
  customerId: string;
  projectId: string;
  source: string;
  seconds: number;
  recorder: ConversationRecorder;
}): string | undefined {
  const at = now();
  pruneConversations(at - CONVERSATION_RETENTION_MS);
  const turns = input.recorder.turns();
  // Nothing said, or the project was deleted while the session ran: nothing to keep.
  if (!turns.length || !liveProject(input.projectId, input.customerId)) return undefined;
  const id = newId("conv_");
  const row: ConversationRow = {
    id,
    customer_id: input.customerId,
    project_id: input.projectId,
    started_at: input.recorder.startedAt,
    ended_at: at,
    seconds: Math.max(0, Math.round(input.seconds)),
    source: input.source,
    preview: (turns.find((turn) => turn.speaker === "user") ?? turns[0])?.text.slice(0, 120) ?? "",
    turns: JSON.stringify(turns),
    answer_ms: medianAnswerMs(turns) ?? null
  };
  insertConversation(row);
  return id;
}

/** Drops conversations past retention; the relay calls it hourly so quiet projects expire too. */
export function pruneOldConversations(): number {
  return pruneConversations(now() - CONVERSATION_RETENTION_MS);
}

export function listConversations(
  customerId: string,
  projectId: string
): Result<{ conversations: ConversationSummary[] }> {
  if (!liveProject(projectId, customerId)) return { ok: false, status: 404, error: "Project not found." };
  const conversations = projectConversations(projectId, customerId, LIST_LIMIT).map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seconds: row.seconds,
    source: row.source,
    preview: row.preview,
    ...(typeof row.answer_ms === "number" ? { answerMs: row.answer_ms } : {}),
    ...marksOf(row.analysis)
  }));
  return { ok: true, value: { conversations } };
}

export function readConversation(
  customerId: string,
  conversationId: string
): Result<{
  conversation: ConversationSummary & {
    projectId: string;
    turns: ConversationTurn[];
    analysis?: ConversationAnalysis;
  };
}> {
  const row = typeof conversationId === "string" ? conversationById(conversationId, customerId) : undefined;
  if (!row || !liveProject(row.project_id, customerId)) {
    return { ok: false, status: 404, error: "Conversation not found." };
  }
  let turns: ConversationTurn[];
  try {
    turns = JSON.parse(row.turns) as ConversationTurn[];
  } catch {
    turns = [];
  }
  return {
    ok: true,
    value: {
      conversation: {
        id: row.id,
        projectId: row.project_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        seconds: row.seconds,
        source: row.source,
        preview: row.preview,
        ...(typeof row.answer_ms === "number" ? { answerMs: row.answer_ms } : {}),
        ...marksOf(row.analysis),
        turns,
        ...(analysisOf(row.analysis) ? { analysis: analysisOf(row.analysis) } : {})
      }
    }
  };
}
