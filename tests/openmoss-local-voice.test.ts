// OpenMOSS models in the `local` pipeline: MOSS-Transcribe-Diarize for speech-to-text
// and MOSS-TTS-Nano (through examples/moss-tts-nano/server.py) for text-to-speech.
import { describe, expect, it } from "vitest";
import { speechToPcm, spokenText } from "../server/providers/live/pipeline";

/** A 16-bit PCM WAV, interleaved when stereo. */
function wav(samples: number[], rate: number, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("MOSS-Transcribe-Diarize transcripts", () => {
  it("keep the words and drop speaker labels and timestamps", () => {
    expect(spokenText("[0.52][S01]Where is my order?[1.87]")).toBe("Where is my order?");
    expect(spokenText("[00:00.52][S01]你好[00:01.10] [00:01.20][S02]在的[00:01.90]")).toBe("你好 在的");
    expect(spokenText("[1.2s][S1] Book a table for two [2.5s]")).toBe("Book a table for two");
  });

  it("leave ordinary transcripts alone", () => {
    for (const text of ["Hello there.", "Item [A] costs 5 dollars", "Room 3B, please", "  spaced   out  "]) {
      expect(spokenText(text)).toBe(text.replace(/\s+/g, " ").trim());
    }
    expect(spokenText("")).toBe("");
  });
});

describe("MOSS-TTS-Nano speech", () => {
  it("is read from its 48 kHz stereo WAV as 24 kHz mono", () => {
    // 480 stereo frames at 48 kHz = 10 ms; both channels at 8,000.
    const stereo = wav(
      Array.from({ length: 960 }, () => 8000),
      48_000,
      2
    );
    const pcm = speechToPcm(stereo, 24_000);
    expect(pcm.length).toBe(240 * 2);
    expect(Math.abs(pcm.readInt16LE(200) - 8000)).toBeLessThanOrEqual(1);
  });
});
