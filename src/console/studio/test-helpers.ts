import type { ToolActivityEvent, TranscriptItem } from "../../../sdk/src/index";

/** One thing on the screen: something said, or a tool the agent used. */
export type TimelineEntry =
  | { kind: "say"; id: string; role: TranscriptItem["role"]; text: string; final: boolean; at: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      state: "started" | "succeeded" | "failed";
      durationMs?: number;
      error?: string;
      at: number;
    };

export type TestState = { entries: TimelineEntry[]; hiddenLines: number };

export type AgentEvent =
  | { type: "transcript"; transcript: readonly TranscriptItem[] }
  | {
      type: "toolactivity";
      event: Pick<ToolActivityEvent, "callId" | "name" | "state" | "durationMs" | "error">;
      at: number;
    }
  | { type: "clear" };

export const EMPTY_TEST_STATE: TestState = { entries: [], hiddenLines: 0 };

/**
 * Folds an SDK event into what the screen shows. Spoken lines are replaced in
 * place by id (a partial line becomes a final one); tool lines keep their spot.
 */
export function applyAgentEvent(state: TestState, event: AgentEvent): TestState {
  if (event.type === "clear") {
    const visibleLines = state.entries.filter((entry) => entry.kind === "say").length;
    return { entries: [], hiddenLines: state.hiddenLines + visibleLines };
  }

  // A Map retains the order of speech and tool calls as existing lines are updated.
  const entries = new Map(state.entries.map((entry) => [entry.id, entry]));
  if (event.type === "toolactivity") {
    const id = `tool:${event.event.callId}`;
    entries.set(id, { ...event.event, kind: "tool", id, at: event.at });
  } else {
    // The SDK includes the full transcript, including lines cleared from this view.
    for (const item of event.transcript.slice(state.hiddenLines)) {
      const id = `say:${item.id}`;
      entries.set(id, { ...item, kind: "say", id });
    }
  }
  return { entries: [...entries.values()], hiddenLines: state.hiddenLines };
}

/** 83 seconds becomes "01:23". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
