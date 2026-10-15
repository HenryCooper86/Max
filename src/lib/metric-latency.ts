import type { AgentEvent } from "../../shared/agent";

/** A frames-only metric's zero is a placeholder, not a new latency sample. */
export function displayedMetricLatency(event: Extract<AgentEvent, { type: "metric" }>): number | undefined {
  if (!Number.isFinite(event.latencyMs) || event.latencyMs < 0) return undefined;
  return event.latencyMs > 0 || (event.outgoingFps === undefined && event.droppedFrames === undefined)
    ? event.latencyMs
    : undefined;
}
