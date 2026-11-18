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

export type TestState = { entries: TimelineEntry[] };

export type AgentEvent =
  | { type: "transcript"; transcript: readonly TranscriptItem[] }
  | {
      type: "toolactivity";
      event: Pick<ToolActivityEvent, "callId" | "name" | "state" | "durationMs" | "error">;
      at: number;
    }
  | { type: "clear" };

export const EMPTY_TEST_STATE: TestState = { entries: [] };

/**
 * Folds an SDK event into what the screen shows. Spoken lines are replaced in
 * place by id (a partial line becomes a final one); tool lines keep their spot.
 */
export function applyAgentEvent(state: TestState, event: AgentEvent): TestState {
  if (event.type === "clear") return EMPTY_TEST_STATE;
  if (event.type === "toolactivity") {
    const id = `tool:${event.event.callId}`;
    const next: TimelineEntry = {
      kind: "tool",
      id,
      name: event.event.name,
      state: event.event.state,
      at: event.at,
      ...(event.event.durationMs !== undefined ? { durationMs: event.event.durationMs } : {}),
      ...(event.event.error ? { error: event.event.error } : {})
    };
    const index = state.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return { entries: [...state.entries, next] };
    return { entries: state.entries.map((entry, i) => (i === index ? next : entry)) };
  }
  const entries = [...state.entries];
  for (const item of event.transcript) {
    const say: TimelineEntry = {
      kind: "say",
      id: `say:${item.id}`,
      role: item.role,
      text: item.text,
      final: item.final,
      at: item.at
    };
    const index = entries.findIndex((entry) => entry.id === say.id);
    if (index < 0) entries.push(say);
    else entries[index] = say;
  }
  return { entries };
}

/** 83 seconds becomes "01:23". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
