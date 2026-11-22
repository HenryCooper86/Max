import { env } from "./engine";

/**
 * Turn detection and noise reduction on the hosted speech-to-speech backends.
 *
 * These models decide by themselves when the user has finished speaking, and
 * each vendor has its own settings for it. The relay passes them through from
 * the environment, and leaves the vendor's defaults alone where nothing is set.
 *
 *   OpenAI Realtime   OPENAI_TURN_DETECTION    server_vad (default) or semantic_vad,
 *                                              which waits for the user to finish a thought
 *                     OPENAI_TURN_EAGERNESS    low, medium, high or auto: semantic_vad only
 *                     OPENAI_VAD_THRESHOLD     0 to 1: server_vad only
 *                     OPENAI_VAD_SILENCE_MS    silence that ends a turn: server_vad only
 *                     OPENAI_VAD_PREFIX_MS     audio kept from before speech: server_vad only
 *                     OPENAI_NOISE_REDUCTION   near_field (a headset, a phone at the ear),
 *                                              far_field (a laptop, a room) or off
 *   Gemini Live       GEMINI_START_SENSITIVITY high or low: how readily speech is detected
 *                     GEMINI_END_SENSITIVITY   high or low: how readily a pause ends the turn
 *                     GEMINI_VAD_SILENCE_MS    silence that ends a turn
 *                     GEMINI_VAD_PREFIX_MS     speech needed before a turn starts
 */

type Read = (...names: string[]) => string | undefined;

function oneOf<T extends string>(
  read: Read,
  name: string,
  allowed: Record<string, T>,
  problems: string[]
): T | undefined {
  const raw = read(name);
  if (raw === undefined) return undefined;
  const value = allowed[raw.toLowerCase().replace(/-/g, "_")];
  if (value === undefined)
    problems.push(`${name}=${raw} is not one of ${[...new Set(Object.values(allowed))].join(", ")}`);
  return value;
}

function numberIn(read: Read, name: string, min: number, max: number, whole: boolean, problems: string[]) {
  const raw = read(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (whole && !Number.isInteger(value))) {
    problems.push(`${name}=${raw} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}`);
    return undefined;
  }
  return value;
}

/** What goes under `audio.input` of an OpenAI Realtime session, beside the format and transcription. */
export function openAiInputSettings(
  manualResponse: boolean,
  read: Read = env
): { settings: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  // Any value is passed on: a newer detection type must not need a relay release.
  const type = read("OPENAI_TURN_DETECTION") ?? "server_vad";
  const eagerness = oneOf(
    read,
    "OPENAI_TURN_EAGERNESS",
    { low: "low", medium: "medium", high: "high", auto: "auto" },
    problems
  );
  const threshold = numberIn(read, "OPENAI_VAD_THRESHOLD", 0, 1, false, problems);
  const silence = numberIn(read, "OPENAI_VAD_SILENCE_MS", 100, 5000, true, problems);
  const prefix = numberIn(read, "OPENAI_VAD_PREFIX_MS", 0, 2000, true, problems);
  const semantic = type === "semantic_vad";
  if (eagerness !== undefined && !semantic) {
    problems.push("OPENAI_TURN_EAGERNESS applies only with OPENAI_TURN_DETECTION=semantic_vad");
  }
  if (semantic && (threshold !== undefined || silence !== undefined || prefix !== undefined)) {
    problems.push("OPENAI_VAD_THRESHOLD, OPENAI_VAD_SILENCE_MS and OPENAI_VAD_PREFIX_MS apply only with server_vad");
  }
  const noise = oneOf(
    read,
    "OPENAI_NOISE_REDUCTION",
    {
      near_field: "near_field",
      near: "near_field",
      far_field: "far_field",
      far: "far_field",
      off: "off",
      none: "off"
    },
    problems
  );
  return {
    settings: {
      turn_detection: {
        type,
        create_response: !manualResponse,
        interrupt_response: true,
        ...(semantic && eagerness !== undefined ? { eagerness } : {}),
        ...(!semantic && threshold !== undefined ? { threshold } : {}),
        ...(!semantic && silence !== undefined ? { silence_duration_ms: silence } : {}),
        ...(!semantic && prefix !== undefined ? { prefix_padding_ms: prefix } : {})
      },
      ...(noise === undefined ? {} : { noise_reduction: noise === "off" ? null : { type: noise } })
    },
    problems
  };
}

/** `realtimeInputConfig` for a Gemini Live setup message, or nothing when no setting is given. */
export function geminiRealtimeInput(read: Read = env): { config?: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const start = oneOf(
    read,
    "GEMINI_START_SENSITIVITY",
    { high: "START_SENSITIVITY_HIGH", low: "START_SENSITIVITY_LOW" },
    problems
  );
  const end = oneOf(
    read,
    "GEMINI_END_SENSITIVITY",
    { high: "END_SENSITIVITY_HIGH", low: "END_SENSITIVITY_LOW" },
    problems
  );
  const silence = numberIn(read, "GEMINI_VAD_SILENCE_MS", 50, 5000, true, problems);
  const prefix = numberIn(read, "GEMINI_VAD_PREFIX_MS", 0, 2000, true, problems);
  const detection = {
    ...(start ? { startOfSpeechSensitivity: start } : {}),
    ...(end ? { endOfSpeechSensitivity: end } : {}),
    ...(silence !== undefined ? { silenceDurationMs: silence } : {}),
    ...(prefix !== undefined ? { prefixPaddingMs: prefix } : {})
  };
  if (Object.keys(detection).length === 0) return { problems };
  return { config: { automaticActivityDetection: detection }, problems };
}

/** Settings that could not be used, for the log at startup. */
export function turnSettingProblems(read: Read = env): string[] {
  return [...openAiInputSettings(false, read).problems, ...geminiRealtimeInput(read).problems];
}
