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

/**
 * True for the events on which a client drops the speech it has buffered and
 * not yet played: the user started to speak, or said or typed something. A
 * phone call drops it only when the caller starts to speak.
 * Takes the event as it is sent, and never throws.
 */
export function interruptsPlayback(event: string, client: "app" | "phone" = "app"): boolean {
  if (!event.includes('"status"') && !event.includes('"transcript"')) return false;
  try {
    const parsed = JSON.parse(event) as { type?: unknown; state?: unknown; speaker?: unknown };
    if (parsed.type === "status") return parsed.state === "hearing" || (client === "app" && parsed.state === "asr");
    return client === "app" && parsed.type === "transcript" && parsed.speaker === "rider";
  } catch {
    return false;
  }
}
