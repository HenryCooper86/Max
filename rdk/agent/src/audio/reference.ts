/**
 * The far-end reference feed for max-aec.
 *
 * Carries the post-limiter 48 kHz signal — literally the samples handed to the
 * DAC. Tapping earlier would hide the limiter's non-linearity from a canceller
 * that models the echo path as linear, and cancellation would degrade exactly
 * when Max is loudest.
 *
 * Wire format, little-endian:
 *
 *     uint32 length | <length bytes of PCM16>     audio
 *     uint32 0                                    reset
 *
 * The reset is a frame rather than a signal because ordering is the whole
 * point. Barge-in kills aplay, so reference already queued will never be heard;
 * APM has to forget precisely that audio and no more. A SIGUSR1 races the pipe —
 * Node buffers writes once the pipe's 64 KB fills, so frames written before the
 * barge-in can land after the signal. max-aec would treat them as about-to-play
 * audio, find no echo to match, and gate the mic while the rider is speaking.
 * In-band, the reset cannot overtake or be overtaken by the audio around it.
 */

export type ReferenceSink = {
  write(pcm48k: Int16Array): void;
  flush(): void;
  close(): void;
};

export type ReferenceOptions = {
  /** fd 3 of the max-aec child, or null when AEC is off. */
  stream: NodeJS.WritableStream | null;
};

function frameHeader(byteLength: number): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(byteLength, 0);
  return header;
}

export function createReferenceSink(options: ReferenceOptions): ReferenceSink {
  const { stream } = options;
  if (stream) {
    // A dead pipe is expected when the helper exits; it must not be fatal.
    stream.on("error", () => {});
  }

  const send = (chunk: Buffer): void => {
    if (!stream || stream.destroyed) return;
    try {
      stream.write(chunk);
    } catch {
      // Same reasoning as above.
    }
  };

  return {
    write(pcm48k: Int16Array): void {
      // A zero-length audio frame is indistinguishable from a reset on the wire.
      if (pcm48k.length === 0) return;
      send(frameHeader(pcm48k.byteLength));
      send(Buffer.from(pcm48k.buffer, pcm48k.byteOffset, pcm48k.byteLength));
    },

    flush(): void {
      send(frameHeader(0));
    },

    close(): void {
      if (stream && !stream.destroyed) stream.end();
    }
  };
}
