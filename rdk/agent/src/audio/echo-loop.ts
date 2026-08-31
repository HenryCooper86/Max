/**
 * Detects the signature of an acoustic echo loop in a transcript: the rider
 * "says" a prefix of what the agent just said, because the microphone heard the
 * speaker and ASR transcribed it.
 *
 * This shipped to a live rider once (2026-07-25, see rdk/README.md under "AEC").
 * Catching it should not depend on a human reading a transcript and noticing.
 */

export type Turn = { speaker: "rider" | "agent"; text: string };

/** Below this many characters a match is more likely a real short utterance
 *  ("好的", "没错") than an echo. */
const MIN_ECHO_CHARS = 6;

/** Consecutive echo-looking exchanges before we call it a loop. */
const DEFAULT_MIN_RUN = 2;

function normalise(text: string): string {
  return text.replace(/[\s，,。.、!！?？]/g, "");
}

export function looksLikeEcho(previousAgent: string, riderText: string): boolean {
  const agent = normalise(previousAgent);
  const rider = normalise(riderText);
  if (rider.length < MIN_ECHO_CHARS) return false;
  return agent.startsWith(rider);
}

export function detectEchoLoop(turns: Turn[], minRun: number = DEFAULT_MIN_RUN): boolean {
  let run = 0;
  for (let i = 1; i < turns.length; i += 1) {
    const previous = turns[i - 1]!;
    const current = turns[i]!;
    if (previous.speaker !== "agent" || current.speaker !== "rider") continue;
    if (looksLikeEcho(previous.text, current.text)) {
      run += 1;
      if (run >= minRun) return true;
    } else {
      run = 0;
    }
  }
  return false;
}
