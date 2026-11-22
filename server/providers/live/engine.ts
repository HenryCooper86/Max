import type { VoiceGender } from "../../../shared/agent";
import type { ToolSpec } from "../../tools";

/**
 * A voice engine is the thin, vendor-specific half of a live voice backend:
 * it moves audio and text between the relay and one upstream service, and
 * nothing else. Everything a wearer experiences as "the assistant" — the
 * persona, wake word, device actions, navigation speech, vision, memory,
 * weather — lives once in ./session.ts and is shared by every engine.
 *
 * Adding a backend means implementing this type and registering it in
 * ../catalog.ts and server/index.ts.
 */

/** Relay-side audio contract, identical for every client and engine. */
export const CLIENT_INPUT_RATE = 16_000;
export const CLIENT_OUTPUT_RATE = 24_000;

/**
 * - "auto": the upstream decides when to answer; the relay can only withhold
 *   the answer (Gemini Live, Grok).
 * - "manual-capable": the upstream can wait for the relay's `respond()`, used
 *   when the wake word is on so unaddressed speech costs nothing (OpenAI).
 * - "manual-only": nothing happens until `respond()` (the cascaded pipeline).
 */
export type EngineResponseMode = "auto" | "manual-capable" | "manual-only";

export type EngineConfig = {
  instructions: string;
  voiceGender: VoiceGender;
  /** A named voice of the speech server; engines without named voices ignore it. */
  voiceId?: string;
  /** True → do not answer until `respond()` is called. */
  manualResponse: boolean;
  /** Languages the assistant speaks, most preferred first. */
  languages: string[];
  /** Words the transcriber should expect, such as the assistant's name. */
  keyterms: string[];
  /** Tools the model may call. Empty → no tools offered. */
  tools: ToolSpec[];
};

/** The model asked to run a tool. */
export type EngineToolCall = {
  /** Upstream id; pass it back to `sendToolResult`. */
  callId: string;
  name: string;
  /** JSON text or an already parsed object, as the upstream sent it. */
  arguments: unknown;
};

export type EngineEvents = {
  /** The wearer started talking. Fires for every new turn, including barge-in. */
  onSpeechStarted(): void;
  /**
   * The wearer's turn was taken to be over: the upstream's detection said so, or the relay's.
   * Only for the clock: how long the answer takes is counted from here, where an engine can say
   * it, and not from when the words of the turn were written down, which is often later.
   */
  onSpeechEnded?(): void;
  /** The wearer's words so far for the current turn (cumulative). */
  onRiderTranscript(text: string, final: boolean): void;
  onResponseStarted(): void;
  /** Next piece of the assistant's reply text. */
  onAgentText(delta: string): void;
  /** Reply audio: 24 kHz mono PCM16. */
  onAgentAudio(pcm: Buffer): void;
  onResponseDone(info: { cancelled: boolean }): void;
  /** A recoverable upstream complaint. */
  onError(message: string): void;
  /** The upstream connection ended without `close()` being called. */
  onClosed(reason: string): void;
  /** The model wants a tool run. Answer with `sendToolResult`; the model
   *  continues its reply once every call it made has an answer. */
  onToolCall?(call: EngineToolCall): void;
  /**
   * For engines that make the speech themselves from the model's text. True
   * when the session wants to read each piece of a reply before anyone hears
   * or sees it: the engine then hands the text to `holdSpeech` sentence by
   * sentence, and neither speaks it nor reports it with `onAgentText` until
   * that resolves to true. False ends the reply: the session has stopped it.
   */
  holdsSpeech?(): boolean;
  holdSpeech?(text: string): Promise<boolean>;
};

/** A picture for the model: base64 without a `data:` prefix, and its media type. */
export type EngineImage = { data: string; mimeType: string };

export type VoiceEngine = {
  readonly responseMode: EngineResponseMode;
  /** True when the upstream ends the reply that asked for a tool and answers
   *  the tool's result in a new one. Otherwise the same reply carries on. */
  readonly answersToolsInNewReply?: boolean;
  /** Resolves once the upstream accepted the session; rejects with a message
   *  fit to show the person setting the kit up. */
  connect(config: EngineConfig, events: EngineEvents): Promise<void>;
  /** Microphone audio: 16 kHz mono PCM16. */
  sendAudio(pcm: Buffer): void;
  /** The device stopped sending microphone audio, so a turn left open on the
   *  upstream (whose clock is audio time) should be ended now. */
  endInput?(): void;
  /** Answer the wearer's latest turn. A no-op for engines that answer on their own. */
  respond(): void;
  /** Stop the reply in progress, if the upstream allows it. */
  cancel(): void;
  /** Speak this exact line (relay-composed confirmations and navigation). */
  say?(text: string): void;
  /** Replace the system instructions mid-session (fresh weather, location). */
  updateInstructions?(instructions: string): void;
  /** Tell the model something happened without making it answer. */
  addContext?(text: string): void;
  /** Give the model a tool's result (text, usually JSON) and let it carry on. */
  sendToolResult?(callId: string, output: string): void;
  /**
   * Speak a line of the relay's own, in these words, while the model waits
   * for the result of this tool call: inside the reply under way, after what
   * the model has said and before what it says with the result. Only engines
   * that make the speech themselves have it.
   */
  sayDuringTool?(callId: string, line: string): void;
  /** A turn the user typed: answer it as if it had been spoken. */
  sendText?(text: string): void;
  /** A picture from the user. With `text` it is a typed turn with the picture
   *  attached and the model answers it; without, the picture joins the
   *  conversation and the model sees it with the next turn. Engines whose
   *  upstream or model cannot see pictures omit this. */
  sendImage?(image: EngineImage, text?: string): void;
  /** The newest frame of the user's live video. It starts nothing: the model
   *  sees it with the user's next turn, or as it arrives where the upstream
   *  takes video itself. `undefined`: the video has stopped. Engines that
   *  take pictures take these. */
  sendVideoFrame?(image: EngineImage | undefined): void;
  /** Replace the tools the model may call (the conversation moved to another
   *  agent). Engines whose upstream fixes the tools at connect omit this; the
   *  session then offers every tool up front and refuses the ones out of turn. */
  updateTools?(tools: ToolSpec[]): void;
  close(): void;
};

/** Linear-interpolating PCM16 resampler. Stateless per call: the 20 ms frames
 *  the clients send are long enough that the seam error is inaudible, and a
 *  stateless function cannot drift. */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);
  const outputSamples = Math.max(1, Math.round((inputSamples * toRate) / fromRate));
  const output = Buffer.allocUnsafe(outputSamples * 2);
  const step = fromRate / toRate;
  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * step;
    const left = Math.min(inputSamples - 1, Math.floor(position));
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = position - left;
    const sample = input.readInt16LE(left * 2) * (1 - fraction) + input.readInt16LE(right * 2) * fraction;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), index * 2);
  }
  return output;
}

/** Root-mean-square level of a PCM16 buffer, 0..32768. */
export function pcm16Rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = pcm.readInt16LE(index * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/** Wraps PCM16 mono in a WAV container, for speech-to-text uploads. */
export function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** First env var that is set and non-blank. */
export function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}
