import type { SessionStartEvent } from "../shared/agent";
import { assistant } from "./assistant";
import { createEqualizer, type Equalizer } from "./audio-eq";
import { config } from "./runtime-config";

/**
 * The equaliser one session's reply audio runs through: the wearer's own
 * settings when the relay allows them, otherwise the assistant profile's
 * default. Every backend calls this once per session.start.
 */
export function sessionEqualizer(event: Pick<SessionStartEvent, "equalizer">, sampleRate = 24_000): Equalizer {
  const requested = config.voiceEqualizerAdjustable ? event.equalizer : undefined;
  return createEqualizer(requested ?? assistant().equalizer, sampleRate);
}
