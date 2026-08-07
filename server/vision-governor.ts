/**
 * Watch-frame governor: calls the vision model conservatively, with metered
 * rules that drop observations rather than queueing them. A stale observation
 * offered to the rider later is worse than silence; the model's answer to "is
 * this safe?" must reflect what was in the frame when it was taken, not when
 * the queue finally processes it.
 *
 * Rules run once at frame arrival to decide whether to call the model at all
 * (Rules 1-5 below). The describe() round trip can then take up to ~10 s on
 * the live path, during which a rider turn can open, a hazard can land, or
 * watching can be disabled — so once the model answers, the "disabled",
 * "adas-window", and "speech" gates are re-checked, in that same order,
 * before the answer is spoken. Budget and cooldown are not re-checked post-
 * describe: this frame's budget slot was already reserved pre-describe, and
 * an in-flight describe already holds newer frames off the cooldown gate.
 * Every drop — pre- or post-describe — is metered via onDrop, never queued
 * or replayed.
 *
 * The sentinel values exist because the model's null-on-failure does not
 * distinguish "nothing to say" (无 in Chinese, the model's chosen empty
 * response) from "the service broke" (null). A rider told "I couldn't see the
 * scene and I have no guidance" (empty) is less safe than "I saw it and it was
 * clear" (nothing notable). Both are silent: the empty marker drops as
 * "nothing-notable" and failure drops as "model-failure", each metered via
 * onDrop, and the ride continues either way.
 */

import { WATCH_PROMPT } from "./vision";

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
  let describeInFlight = false;
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

      // Rule 4: speech open or describe in flight
      if (isSpeechOpen() || describeInFlight) {
        onDrop("speech");
        return;
      }

      // Rule 5: cooldown
      if (lastSpokenAt >= 0 && currentTime - lastSpokenAt < cooldownMs) {
        onDrop("cooldown");
        return;
      }

      // Record this describe call and mark in-flight
      describeTimestamps.push(currentTime);
      describeInFlight = true;

      try {
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

        // Post-describe re-check, same order as the pre-describe rules
        // above: the round trip can take up to ~10 s on the live path, long
        // enough for the ride to have changed underneath this frame.

        // Rule 1 (re-check): disabled
        if (!enabled) {
          onDrop("disabled");
          return;
        }

        // Rule 3 (re-check): adas-window
        const recheckTime = now();
        if (hazardAt >= 0 && recheckTime - hazardAt < adasWindowMs) {
          onDrop("adas-window");
          return;
        }

        // Rule 4 (re-check): speech open. describeInFlight is not
        // re-checked here — it is still true for this very call until the
        // finally block below runs, so it would always (wrongly) drop.
        if (isSpeechOpen()) {
          onDrop("speech");
          return;
        }

        // Success: speak and anchor the cooldown at the moment the words
        // actually went out, not when the frame arrived — the 2 min gap is
        // between spoken observations.
        speak(answer);
        lastSpokenAt = now();
      } finally {
        describeInFlight = false;
      }
    }
  };
}
