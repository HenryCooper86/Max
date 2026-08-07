/**
 * Watch-frame governor: calls the vision model conservatively, with metered
 * rules that drop observations rather than queueing them. A stale observation
 * offered to the rider later is worse than silence; the model's answer to "is
 * this safe?" must reflect what was in the frame when it was taken, not when
 * the queue finally processes it.
 *
 * The sentinel values exist because the model's null-on-failure does not
 * distinguish "nothing to say" (無 in Chinese, the model's chosen empty
 * response) from "the service broke" (null). A rider told "I couldn't see the
 * scene and I have no guidance" (empty) is less safe than "I saw it and it was
 * clear" (nothing notable). Only the empty marker triggers a drop; failure
 * silence is logged and the ride continues.
 */

export type WatchDropReason =
  "disabled" | "budget" | "adas-window" | "speech" | "cooldown" | "nothing-notable" | "model-failure";

export function createVisionGovernor(options: {
  describe(frames: string[], question?: string): Promise<string | null>;
  speak(line: string): void;
  isSpeechOpen(): boolean;
  onDrop(reason: WatchDropReason): void;
  now?: () => number; // injectable clock
  hourlyCap?: number; // default 40
  cooldownMs?: number; // default 120_000
  adasWindowMs?: number; // default 30_000
}): {
  setEnabled(on: boolean): void;
  noteHazard(): void;
  handleWatchFrame(image: string): Promise<void>;
} {
  const {
    describe,
    speak,
    isSpeechOpen,
    onDrop,
    now = Date.now,
    hourlyCap = 40,
    cooldownMs = 120_000,
    adasWindowMs = 30_000
  } = options;

  let enabled = false;
  let hazardAt = -1;
  let lastSpokenAt = -1;
  const describeTimestamps: number[] = [];

  function isNothingNotable(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === "無" || trimmed === "無。" || trimmed === "无" || trimmed === "无。";
  }

  return {
    setEnabled(on: boolean): void {
      enabled = on;
    },

    noteHazard(): void {
      hazardAt = now();
    },

    async handleWatchFrame(image: string): Promise<void> {
      const currentTime = now();

      // Rule 1: disabled
      if (!enabled) {
        onDrop("disabled");
        return;
      }

      // Rule 2: budget — rolling 3,600,000 ms window
      const windowStart = currentTime - 3_600_000;
      // Remove old timestamps outside the window
      while (describeTimestamps.length > 0 && describeTimestamps[0]! < windowStart) {
        describeTimestamps.shift();
      }
      if (describeTimestamps.length >= hourlyCap) {
        onDrop("budget");
        return;
      }

      // Rule 3: adas-window
      if (hazardAt >= 0 && currentTime - hazardAt < adasWindowMs) {
        onDrop("adas-window");
        return;
      }

      // Rule 4: speech open
      if (isSpeechOpen()) {
        onDrop("speech");
        return;
      }

      // Rule 5: cooldown
      if (lastSpokenAt >= 0 && currentTime - lastSpokenAt < cooldownMs) {
        onDrop("cooldown");
        return;
      }

      // Record this describe call and call the model
      describeTimestamps.push(currentTime);

      // Import WATCH_PROMPT from vision.ts
      const { WATCH_PROMPT } = await import("./vision");
      const answer = await describe([image], WATCH_PROMPT);

      // Handle answer
      if (answer === null) {
        onDrop("model-failure");
        return;
      }

      if (isNothingNotable(answer)) {
        onDrop("nothing-notable");
        return;
      }

      // Success: speak and record timestamp
      speak(answer);
      lastSpokenAt = currentTime;
    }
  };
}
