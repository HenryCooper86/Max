/**
 * The far-end reference feed for max-aec.
 *
 * Carries the post-limiter 48 kHz signal — literally the samples handed to the
 * DAC. Tapping earlier would hide the limiter's non-linearity from a canceller
 * that models the echo path as linear, and cancellation would degrade exactly
 * when Max is loudest.
 */

export type ReferenceSink = {
  write(pcm48k: Int16Array): void;
  flush(): void;
  close(): void;
};

export type ReferenceOptions = {
  /** fd 3 of the max-aec child, or null when AEC is off. */
  stream: NodeJS.WritableStream | null;
  /** Tells max-aec to reset APM. Must happen in the same beat as the drop. */
  onReset(): void;
};

export function createReferenceSink(options: ReferenceOptions): ReferenceSink {
  const { stream } = options;
  if (stream) {
    // A dead pipe is expected when the helper exits; it must not be fatal.
    stream.on("error", () => {});
  }

  return {
    write(pcm48k: Int16Array): void {
      if (!stream || stream.destroyed) return;
      try {
        stream.write(Buffer.from(pcm48k.buffer, pcm48k.byteOffset, pcm48k.byteLength));
      } catch {
        // Same reasoning as above.
      }
    },

    flush(): void {
      // Barge-in: whatever is queued will never reach the speaker, so APM must
      // forget it or it will subtract an echo that never happened.
      options.onReset();
    },

    close(): void {
      if (stream && !stream.destroyed) stream.end();
    }
  };
}
