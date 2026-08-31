import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../shared/agent";

export type TranscriptDelivery = {
  turnId: string;
  deliveryId: string;
};

/** Allocates stable identifiers for every partial/final event in one logical turn. */
export function createTranscriptDelivery(): TranscriptDelivery {
  return { turnId: randomUUID(), deliveryId: randomUUID() };
}

export function transcriptEvent(
  delivery: TranscriptDelivery,
  speaker: "rider" | "agent",
  text: string,
  options: { final?: boolean; useBrowserSpeech?: boolean } = {}
): Extract<AgentEvent, { type: "transcript" }> {
  return {
    type: "transcript",
    ...delivery,
    speaker,
    text,
    ...options
  };
}
