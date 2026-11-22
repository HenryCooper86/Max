import type { VoiceGender } from "../../../shared/agent";
import type { Logger } from "../../logger";
import { authHeaders, createChatLoop, failure, type ChatStage } from "./chat-loop";
import {
  CLIENT_INPUT_RATE,
  CLIENT_OUTPUT_RATE,
  env,
  resamplePcm16,
  wavFromPcm16,
  type EngineConfig,
  type EngineEvents,
  type EngineImage,
  type VoiceEngine
} from "./engine";

/**
 * The cascaded "Whisper pipeline": speech-to-text → chat model → text-to-speech,
 * each an OpenAI-compatible HTTP endpoint that can point at a different vendor
 * (OpenAI, Groq, xAI, a local whisper.cpp / Ollama / Kokoro server, …).
 *
 * Slower than a live speech-to-speech socket — the wearer's whole sentence is
 * transcribed before the model starts — but it runs with nearly any model,
 * including fully offline ones. Turn-taking is done here with an energy-based
 * voice activity detector, since no upstream is listening to the stream.
 */

type PipelineStage = ChatStage;

export type PipelineSettings = {
  stt: PipelineStage;
  llm: PipelineStage;
  tts: PipelineStage & {
    voice(gender: VoiceGender): string;
    /** Rate of raw PCM responses. A WAV response states its own. */
    sampleRate: number;
    /** `response_format` asked of the speech server: "pcm" or "wav". */
    format?: string;
  };
};

const OPENAI_BASE = "https://api.openai.com/v1";

type StageDefaults = { baseUrl: string; model: string };

function stage(prefix: string, name: string, defaults: StageDefaults, keys: string[]): PipelineStage {
  return {
    baseUrl: (env(`${prefix}_${name}_BASE_URL`, `${prefix}_BASE_URL`) ?? defaults.baseUrl).replace(/\/+$/, ""),
    apiKey: env(`${prefix}_${name}_API_KEY`, `${prefix}_API_KEY`, ...keys) ?? "",
    model: env(`${prefix}_${name}_MODEL`) ?? defaults.model
  };
}

function settingsFrom(
  prefix: string,
  defaults: {
    stt: StageDefaults;
    llm: StageDefaults;
    tts: StageDefaults;
    voice: [female: string, male: string];
    format: string;
  },
  keys: string[]
): PipelineSettings {
  const rate = Number(env(`${prefix}_TTS_SAMPLE_RATE`));
  return {
    stt: stage(prefix, "STT", defaults.stt, keys),
    // The relay cannot tell whether a chat model sees pictures, so the owner says so.
    llm: { ...stage(prefix, "LLM", defaults.llm, keys), images: env(`${prefix}_LLM_IMAGES`)?.toLowerCase() === "on" },
    tts: {
      ...stage(prefix, "TTS", defaults.tts, keys),
      voice: (gender) =>
        gender === "male"
          ? (env(`${prefix}_TTS_VOICE_MALE`) ?? defaults.voice[1])
          : (env(`${prefix}_TTS_VOICE`, `${prefix}_TTS_VOICE_FEMALE`) ?? defaults.voice[0]),
      sampleRate: Number.isFinite(rate) && rate >= 8000 ? rate : CLIENT_OUTPUT_RATE,
      format: env(`${prefix}_TTS_FORMAT`) ?? defaults.format
    }
  };
}

/** The hosted pipeline: OpenAI's endpoints unless a stage is pointed elsewhere. */
export function pipelineSettings(): PipelineSettings {
  return settingsFrom(
    "PIPELINE",
    {
      stt: { baseUrl: OPENAI_BASE, model: "whisper-1" },
      llm: { baseUrl: OPENAI_BASE, model: "gpt-4o-mini" },
      tts: { baseUrl: OPENAI_BASE, model: "gpt-4o-mini-tts" },
      voice: ["nova", "onyx"],
      format: "pcm"
    },
    ["OPENAI_API_KEY"]
  );
}

/**
 * The local pipeline: open-weight models on the owner's own hardware. The
 * defaults are the usual ports of three widely used OpenAI-compatible servers —
 * Speaches (faster-whisper) for speech-to-text, Ollama for the chat model and
 * Kokoro-FastAPI for text-to-speech — and every one can be re-pointed at any
 * other compatible server (whisper.cpp, llama.cpp, vLLM, LM Studio,
 * openedai-speech, …). See docs/local-models.md.
 */
export function localPipelineSettings(): PipelineSettings {
  const settings = settingsFrom(
    "LOCAL",
    {
      stt: { baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small" },
      llm: { baseUrl: "http://localhost:11434/v1", model: "qwen3:8b" },
      tts: { baseUrl: "http://localhost:8880/v1", model: "kokoro" },
      voice: ["af_heart", "am_michael"],
      // WAV carries its own sample rate, so it works with servers that do not
      // produce 24 kHz or do not offer raw PCM at all.
      format: "wav"
    },
    []
  );
  // Thinking models spend a second or more on hidden reasoning before each spoken reply.
  // LOCAL_LLM_REASONING_EFFORT=default leaves the model's own behavior alone.
  const reasoningEffort = env("LOCAL_LLM_REASONING_EFFORT")?.toLowerCase() ?? "none";
  return reasoningEffort === "default" ? settings : { ...settings, llm: { ...settings.llm, reasoningEffort } };
}

// Speaker labels and timestamps that diarizing speech servers (MOSS-Transcribe-Diarize:
// "[0.52][S01]Hello there[1.87]") wrap around the words: [1.87], [00:01.87], [S01].
const TRANSCRIPT_MARKUP = /\[(?:\d{1,2}:)?\d{1,2}(?::\d{2})?(?:[.,]\d+)?s?\]|\[\d+(?:\.\d+)?s?\]|\[S\d{1,3}\]/g;

/** Just the words of a transcript, without diarization markup. */
export function spokenText(transcript: string): string {
  return transcript.replace(TRANSCRIPT_MARKUP, " ").replace(/\s+/g, " ").trim();
}

/** A local endpoint needs no key; a hosted one does. */
export function pipelineConfigured(settings: PipelineSettings = pipelineSettings()): boolean {
  return [settings.stt, settings.llm, settings.tts].every(
    (item) => Boolean(item.apiKey) || /\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.local)([:/]|$)/i.test(item.baseUrl)
  );
}

/** The local pipeline is offered once the owner says it is there: LOCAL_VOICE=on,
 *  or any LOCAL_* endpoint or model set. Its defaults alone are not a claim
 *  that three servers are running on this machine. */
export function localPipelineEnabled(): boolean {
  if (env("LOCAL_VOICE")?.toLowerCase() === "on") return true;
  return (
    Boolean(env("LOCAL_BASE_URL")) ||
    ["STT", "LLM", "TTS"].some((name) => env(`LOCAL_${name}_BASE_URL`, `LOCAL_${name}_MODEL`))
  );
}

/**
 * Turns a text-to-speech response into 24 kHz mono PCM16. A RIFF/WAVE body is
 * recognised whatever format was asked for, and brings its own sample rate and
 * channel count; anything else is taken as raw PCM16 mono at `fallbackRate`.
 */
export function speechToPcm(body: Buffer, fallbackRate: number): Buffer {
  if (body.length < 12 || body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WAVE") {
    return resamplePcm16(body, fallbackRate, CLIENT_OUTPUT_RATE);
  }
  let rate = fallbackRate;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let offset = 12;
  while (offset + 8 <= body.length) {
    const id = body.toString("ascii", offset, offset + 4);
    // Streaming servers write 0xFFFFFFFF (or 0) for sizes they do not know yet.
    const declared = body.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= body.length) {
      format = body.readUInt16LE(start);
      channels = Math.max(1, body.readUInt16LE(start + 2));
      rate = body.readUInt32LE(start + 4) || fallbackRate;
      bits = body.readUInt16LE(start + 14);
    }
    if (id === "data") {
      const end = declared === 0 || declared > body.length - start ? body.length : start + declared;
      return resamplePcm16(monoPcm16(body.subarray(start, end), channels, bits, format), rate, CLIENT_OUTPUT_RATE);
    }
    offset = start + declared + (declared % 2);
  }
  return Buffer.alloc(0);
}

/** Down-mixes and converts WAV sample data to mono PCM16. */
function monoPcm16(data: Buffer, channels: number, bits: number, format: number): Buffer {
  if (channels === 1 && bits === 16 && format === 1) return data;
  // 16-bit integer, or 32-bit float (format 3) — what speech servers emit.
  if (!(bits === 16 && format === 1) && !(bits === 32 && format === 3)) return Buffer.alloc(0);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const output = Buffer.allocUnsafe(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * bytes;
      sum += bits === 16 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    const sample = Math.max(-1, Math.min(1, sum / channels));
    output.writeInt16LE(Math.round(sample * 32767), frame * 2);
  }
  return output;
}

// ---- Voice activity detection ----------------------------------------------

const FRAME_MS = 20;
const FRAME_BYTES = (CLIENT_INPUT_RATE / 1000) * FRAME_MS * 2;

export type VadOptions = {
  /** Consecutive loud frames that open a turn. */
  startFrames?: number;
  /** Trailing quiet that closes a turn. */
  endSilenceMs?: number;
  minSpeechMs?: number;
  maxSpeechMs?: number;
  /** Absolute floor for "loud", PCM16 RMS (measured after the rumble filter). */
  minLevel?: number;
  /** How far above the background a frame must be to count as speech. */
  noiseRatio?: number;
};

/** Wind and engine rumble carry most of their energy below this, and speech
 *  very little that a listener needs. Filtered twice over, so 60 Hz is cut by
 *  about 20 dB while 300 Hz loses about 3. */
const RUMBLE_CUTOFF_HZ = 200;
/** Listening only, at the start of a stream, to learn the background. */
const WARM_UP_FRAMES = 15;
/** How far back the quietest moment is looked for: long enough to span the
 *  gaps between words, short enough to follow a change in the background. */
const FLOOR_WINDOW_FRAMES = 100;

/**
 * Finds the wearer's turns in a stream of 20 ms frames, by loudness.
 *
 * A frame counts as speech when it stands well above the background. Three
 * things keep steady noise from passing for speech:
 *
 * - Loudness is measured with low rumble filtered down, where wind and
 *   engines are loudest and speech carries little.
 * - The background is the larger of two estimates. One follows the level
 *   while nobody is talking. The other is the quietest moment of the last two
 *   seconds, which speech keeps low (it has gaps between words) and a steady
 *   noise does not. So noise that starts and stays is recognised as the new
 *   background within two seconds, where the first estimate alone would never
 *   move again once it had mistaken the noise for a turn.
 * - The first 300 ms of a stream only listen, so a session that begins in
 *   noise learns it before it can open a turn.
 *
 * It is still a loudness detector. Speech no louder than the noise is not
 * found, and a sudden sound such as a horn opens a turn.
 */
export function createVad(
  handlers: { onStart(): void; onEnd(audio: Buffer): void },
  options: VadOptions = {}
): { push(pcm: Buffer): void; reset(): void } {
  const startFrames = options.startFrames ?? 4;
  const endFrames = Math.round((options.endSilenceMs ?? 700) / FRAME_MS);
  const minFrames = Math.round((options.minSpeechMs ?? 240) / FRAME_MS);
  const maxFrames = Math.round((options.maxSpeechMs ?? 30_000) / FRAME_MS);
  const minLevel = options.minLevel ?? 450;
  const noiseRatio = options.noiseRatio ?? 2.5;
  const PRE_ROLL_FRAMES = 15;
  // One-pole high-pass, y[n] = k · (y[n-1] + x[n] - x[n-1]), applied twice.
  const highPass = 1 / (1 + (2 * Math.PI * RUMBLE_CUTOFF_HZ) / CLIENT_INPUT_RATE);

  let pending: Buffer = Buffer.alloc(0);
  let noiseFloor = 120;
  let loudRun = 0;
  let quietRun = 0;
  let speaking = false;
  let speechFrames = 0;
  let voicedFrames = 0;
  let preRoll: Buffer[] = [];
  let captured: Buffer[] = [];
  let firstIn = 0;
  let firstOut = 0;
  let secondOut = 0;
  let seen = 0;
  const recent = new Float32Array(FLOOR_WINDOW_FRAMES);

  /** Loudness of a frame with the rumble taken out. */
  function levelOf(data: Buffer): number {
    let sum = 0;
    const samples = data.length / 2;
    for (let index = 0; index < samples; index += 1) {
      const sample = data.readInt16LE(index * 2);
      const first = highPass * (firstOut + sample - firstIn);
      secondOut = highPass * (secondOut + first - firstOut);
      firstIn = sample;
      firstOut = first;
      sum += secondOut * secondOut;
    }
    return Math.sqrt(sum / samples);
  }

  /** The quietest of the recent frames. */
  function quietest(): number {
    const count = Math.min(seen, FLOOR_WINDOW_FRAMES);
    let lowest = Infinity;
    for (let index = 0; index < count; index += 1) if (recent[index]! < lowest) lowest = recent[index]!;
    return count ? lowest : 0;
  }

  function finish(): void {
    const audio = Buffer.concat(captured);
    const enoughSpeech = voicedFrames >= minFrames;
    speaking = false;
    captured = [];
    loudRun = 0;
    quietRun = 0;
    speechFrames = 0;
    voicedFrames = 0;
    if (enoughSpeech) handlers.onEnd(audio);
  }

  function frame(data: Buffer): void {
    const level = levelOf(data);
    recent[seen % FLOOR_WINDOW_FRAMES] = level;
    seen += 1;
    if (seen <= WARM_UP_FRAMES) {
      // Learning the background: follow it quickly, open nothing.
      noiseFloor = seen === 1 ? level : noiseFloor * 0.7 + level * 0.3;
      preRoll.push(data);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      return;
    }
    const loud = level > Math.max(minLevel, Math.max(noiseFloor, quietest()) * noiseRatio);
    if (!speaking) {
      // Track the room only while nobody is talking.
      if (!loud) noiseFloor = noiseFloor * 0.95 + level * 0.05;
      preRoll.push(data);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      loudRun = loud ? loudRun + 1 : 0;
      if (loudRun >= startFrames) {
        speaking = true;
        captured = preRoll;
        preRoll = [];
        speechFrames = captured.length;
        voicedFrames = loudRun;
        quietRun = 0;
        handlers.onStart();
      }
      return;
    }
    captured.push(data);
    speechFrames += 1;
    if (loud) {
      voicedFrames += 1;
      quietRun = 0;
    } else {
      quietRun += 1;
    }
    if (quietRun >= endFrames || speechFrames >= maxFrames) finish();
  }

  return {
    push(pcm) {
      pending = pending.length ? Buffer.concat([pending, pcm]) : pcm;
      let offset = 0;
      while (pending.length - offset >= FRAME_BYTES) {
        frame(pending.subarray(offset, offset + FRAME_BYTES));
        offset += FRAME_BYTES;
      }
      pending = pending.subarray(offset);
    },
    reset() {
      // Ends the turn in hand. What was learned about the background is kept:
      // the room has not changed because the assistant started talking.
      pending = Buffer.alloc(0);
      speaking = false;
      captured = [];
      preRoll = [];
      loudRun = 0;
      quietRun = 0;
      speechFrames = 0;
      voicedFrames = 0;
    }
  };
}

// ---- Engine -----------------------------------------------------------------

export function createPipelineEngine(
  log: Logger,
  settings: PipelineSettings = pipelineSettings(),
  request: typeof fetch = fetch,
  vadOptions: VadOptions = {}
): VoiceEngine {
  let events: EngineEvents | undefined;
  let config: EngineConfig | undefined;
  let instructions = "";
  let closed = false;
  let pendingUser: string | undefined;

  async function transcribe(audio: Buffer, mine: number): Promise<void> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(wavFromPcm16(audio, CLIENT_INPUT_RATE))], { type: "audio/wav" }),
      "speech.wav"
    );
    form.append("model", settings.stt.model);
    form.append("response_format", "json");
    const language = config?.languages.length === 1 ? config.languages[0] : undefined;
    if (language) form.append("language", language);
    if (config?.keyterms.length) form.append("prompt", config.keyterms.join(", "));
    const response = await request(`${settings.stt.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: authHeaders(settings.stt),
      body: form,
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw await failure("Speech-to-text", response);
    const text = spokenText(((await response.json()) as { text?: string }).text ?? "");
    if (closed || mine !== chat.generation) return;
    pendingUser = text || undefined;
    // An empty transcript still closes the turn the VAD opened.
    events?.onRiderTranscript(text, true);
  }

  async function synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
    const response = await request(`${settings.tts.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(settings.tts) },
      body: JSON.stringify({
        model: settings.tts.model,
        voice: settings.tts.voice(config?.voiceGender ?? "female"),
        input: text,
        response_format: settings.tts.format ?? "pcm"
      }),
      signal
    });
    if (!response.ok) throw await failure("Text-to-speech", response);
    return speechToPcm(Buffer.from(await response.arrayBuffer()), settings.tts.sampleRate);
  }

  const chat = createChatLoop({
    log,
    request,
    label: "pipeline",
    stage: () => settings.llm,
    events: () => events,
    tools: () => config?.tools ?? [],
    instructions: () => instructions,
    closed: () => closed,
    newSpeaker({ signal, current }) {
      // Sentences are synthesized as they complete but played strictly in order.
      let speechTail: Promise<void> = Promise.resolve();
      const speak = (sentence: string) => {
        const audio = synthesize(sentence, signal);
        audio.catch(() => undefined);
        speechTail = speechTail.then(async () => {
          const pcm = await audio;
          if (current()) events?.onAgentAudio(pcm);
        });
        // `finish` reports a failure, but runs later or not at all after a barge-in. Until then
        // an unobserved rejection here would take the whole relay down.
        speechTail.catch(() => undefined);
      };
      return { sentence: speak, finish: () => speechTail };
    }
  });

  /** A picture waits for the next user turn; with words it is that turn. */
  function sendImage(image: EngineImage, text?: string): void {
    if (closed) return;
    chat.addImage(image);
    if (!text) return;
    pendingUser = undefined;
    void chat.reply(text);
  }

  const vad = createVad(
    {
      onStart() {
        if (closed) return;
        // Barge-in: whatever is being generated or queued stops now.
        const wasReplying = chat.replying;
        chat.stop();
        events?.onSpeechStarted();
        if (wasReplying) chat.endReply(true);
      },
      onEnd(audio) {
        if (closed) return;
        const mine = chat.generation;
        transcribe(audio, mine).catch((error: unknown) => {
          if (closed || mine !== chat.generation) return;
          const message = error instanceof Error ? error.message : String(error);
          log.warn("pipeline transcription failed", { message });
          events?.onError(message);
          events?.onRiderTranscript("", true);
        });
      }
    },
    vadOptions
  );

  return {
    responseMode: "manual-only",
    async connect(engineConfig, engineEvents) {
      events = engineEvents;
      config = engineConfig;
      instructions = engineConfig.instructions;
      if (!pipelineConfigured(settings)) {
        throw new Error(
          "Voice pipeline: set PIPELINE_API_KEY (or OPENAI_API_KEY), or point the stages at local servers"
        );
      }
    },
    sendAudio(pcm) {
      if (!closed) vad.push(pcm);
    },
    respond() {
      if (closed) return;
      const userText = pendingUser;
      pendingUser = undefined;
      if (userText) void chat.reply(userText);
    },
    cancel() {
      const wasReplying = chat.replying;
      chat.stop();
      if (wasReplying) chat.endReply(true);
    },
    say(text) {
      if (!closed) void chat.reply(undefined, text);
    },
    updateInstructions(next) {
      instructions = next;
    },
    updateTools(tools) {
      // Read per chat request, so the next reply already sees the new set.
      if (config) config = { ...config, tools };
    },
    addContext(text) {
      chat.addContext(text);
    },
    sendToolResult(callId, output) {
      chat.sendToolResult(callId, output);
    },
    // Only when the owner said the chat model sees pictures (PIPELINE_LLM_IMAGES / LOCAL_LLM_IMAGES).
    ...(settings.llm.images ? { sendImage } : {}),
    sendText(text) {
      if (closed) return;
      pendingUser = undefined;
      void chat.reply(text);
    },
    close() {
      closed = true;
      chat.stop();
      vad.reset();
    }
  };
}
