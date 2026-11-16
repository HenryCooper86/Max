import type { VoiceGender } from "../../../shared/agent";
import type { Logger } from "../../logger";
import {
  CLIENT_INPUT_RATE,
  CLIENT_OUTPUT_RATE,
  env,
  pcm16Rms,
  resamplePcm16,
  wavFromPcm16,
  type EngineConfig,
  type EngineEvents,
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

type PipelineStage = { baseUrl: string; apiKey: string; model: string };

export type PipelineSettings = {
  stt: PipelineStage;
  llm: PipelineStage;
  tts: PipelineStage & { voice(gender: VoiceGender): string; sampleRate: number };
};

const OPENAI_BASE = "https://api.openai.com/v1";

function stage(prefix: string, defaultModel: string): PipelineStage {
  return {
    baseUrl: (env(`PIPELINE_${prefix}_BASE_URL`, "PIPELINE_BASE_URL") ?? OPENAI_BASE).replace(/\/+$/, ""),
    apiKey: env(`PIPELINE_${prefix}_API_KEY`, "PIPELINE_API_KEY", "OPENAI_API_KEY") ?? "",
    model: env(`PIPELINE_${prefix}_MODEL`) ?? defaultModel
  };
}

function pipelineSettings(): PipelineSettings {
  const rate = Number(env("PIPELINE_TTS_SAMPLE_RATE"));
  return {
    stt: stage("STT", "whisper-1"),
    llm: stage("LLM", "gpt-4o-mini"),
    tts: {
      ...stage("TTS", "gpt-4o-mini-tts"),
      voice: (gender) =>
        gender === "male"
          ? (env("PIPELINE_TTS_VOICE_MALE") ?? "onyx")
          : (env("PIPELINE_TTS_VOICE", "PIPELINE_TTS_VOICE_FEMALE") ?? "nova"),
      sampleRate: Number.isFinite(rate) && rate >= 8000 ? rate : CLIENT_OUTPUT_RATE
    }
  };
}

/** A local endpoint needs no key; a hosted one does. */
export function pipelineConfigured(settings: PipelineSettings = pipelineSettings()): boolean {
  return [settings.stt, settings.llm, settings.tts].every(
    (item) => Boolean(item.apiKey) || /\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.local)([:/]|$)/i.test(item.baseUrl)
  );
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
  /** Absolute floor for "loud", PCM16 RMS. */
  minLevel?: number;
};

/** Energy-based endpointing over 20 ms frames, with a slowly adapting noise
 *  floor so it works both in a quiet room and under wind noise. */
export function createVad(
  handlers: { onStart(): void; onEnd(audio: Buffer): void },
  options: VadOptions = {}
): { push(pcm: Buffer): void; reset(): void } {
  const startFrames = options.startFrames ?? 4;
  const endFrames = Math.round((options.endSilenceMs ?? 700) / FRAME_MS);
  const minFrames = Math.round((options.minSpeechMs ?? 240) / FRAME_MS);
  const maxFrames = Math.round((options.maxSpeechMs ?? 30_000) / FRAME_MS);
  const minLevel = options.minLevel ?? 450;
  const PRE_ROLL_FRAMES = 15;

  let pending: Buffer = Buffer.alloc(0);
  let noiseFloor = 120;
  let loudRun = 0;
  let quietRun = 0;
  let speaking = false;
  let speechFrames = 0;
  let voicedFrames = 0;
  let preRoll: Buffer[] = [];
  let captured: Buffer[] = [];

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
    const level = pcm16Rms(data);
    const loud = level > Math.max(minLevel, noiseFloor * 3);
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

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_HISTORY_MESSAGES = 16;
// Sentence boundaries for both Latin and CJK punctuation.
const SENTENCE_END = /[。！？!?；;\n]|[.](?=\s|$)/u;

function authHeaders(item: PipelineStage): Record<string, string> {
  return item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {};
}

async function failure(stageName: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  const hint = response.status === 401 || response.status === 403 ? " — check the API key" : "";
  return new Error(`${stageName} HTTP ${response.status}${hint}${body ? `: ${body}` : ""}`);
}

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
  let history: ChatMessage[] = [];
  let pendingUser: string | undefined;
  /** Bumped whenever the current work must stop: barge-in, cancel, close. */
  let generation = 0;
  let abort: AbortController | undefined;
  let replyActive = false;

  function stopWork(): void {
    generation += 1;
    abort?.abort();
    abort = undefined;
  }

  function endReply(cancelled: boolean): void {
    if (!replyActive) return;
    replyActive = false;
    events?.onResponseDone({ cancelled });
  }

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
    const text = ((await response.json()) as { text?: string }).text?.trim() ?? "";
    if (closed || mine !== generation) return;
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
        response_format: "pcm"
      }),
      signal
    });
    if (!response.ok) throw await failure("Text-to-speech", response);
    const pcm = Buffer.from(await response.arrayBuffer());
    return resamplePcm16(pcm, settings.tts.sampleRate, CLIENT_OUTPUT_RATE);
  }

  /** Streams chat-completion text, handing each finished sentence to `onSentence`. */
  async function streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    onDelta: (delta: string) => void,
    onSentence: (sentence: string) => void
  ): Promise<string> {
    const response = await request(`${settings.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(settings.llm) },
      body: JSON.stringify({ model: settings.llm.model, messages, stream: true }),
      signal
    });
    if (!response.ok || !response.body) throw await failure("Chat model", response);
    const decoder = new TextDecoder();
    let buffered = "";
    let sentence = "";
    let full = "";
    const consume = (delta: string) => {
      full += delta;
      onDelta(delta);
      sentence += delta;
      for (;;) {
        const match = SENTENCE_END.exec(sentence);
        if (!match) break;
        const end = match.index + match[0].length;
        const complete = sentence.slice(0, end).trim();
        sentence = sentence.slice(end);
        if (complete) onSentence(complete);
      }
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta
            ?.content;
          if (delta) consume(delta);
        } catch {
          /* a keep-alive or partial line */
        }
      }
    }
    if (sentence.trim()) onSentence(sentence.trim());
    return full;
  }

  async function reply(userText: string | undefined, exactLine?: string): Promise<void> {
    stopWork();
    const mine = generation;
    const controller = new AbortController();
    abort = controller;
    replyActive = true;
    events?.onResponseStarted();

    // Sentences are synthesized as they complete but played strictly in order.
    let speechTail: Promise<void> = Promise.resolve();
    const speak = (sentence: string) => {
      const audio = synthesize(sentence, controller.signal);
      audio.catch(() => undefined);
      speechTail = speechTail.then(async () => {
        const pcm = await audio;
        if (!closed && mine === generation) events?.onAgentAudio(pcm);
      });
    };

    try {
      if (exactLine) {
        speak(exactLine);
      } else {
        const messages: ChatMessage[] = [
          { role: "system", content: instructions },
          ...history,
          ...(userText ? [{ role: "user" as const, content: userText }] : [])
        ];
        const full = await streamChat(
          messages,
          controller.signal,
          (delta) => {
            if (!closed && mine === generation) events?.onAgentText(delta);
          },
          speak
        );
        if (userText) history.push({ role: "user", content: userText });
        if (full.trim()) history.push({ role: "assistant", content: full.trim() });
        if (history.length > MAX_HISTORY_MESSAGES) history = history.slice(-MAX_HISTORY_MESSAGES);
      }
      await speechTail;
      if (mine === generation) endReply(false);
    } catch (error) {
      if (mine !== generation || closed) return;
      const message = error instanceof Error ? error.message : String(error);
      log.warn("pipeline reply failed", { message });
      events?.onError(message);
      // Text that did arrive still reaches the wearer: the session core falls
      // back to client-side speech when a reply ends with text and no audio.
      endReply(false);
    }
  }

  const vad = createVad(
    {
      onStart() {
        if (closed) return;
        // Barge-in: whatever is being generated or queued stops now.
        const wasReplying = replyActive;
        stopWork();
        events?.onSpeechStarted();
        if (wasReplying) endReply(true);
      },
      onEnd(audio) {
        if (closed) return;
        const mine = generation;
        transcribe(audio, mine).catch((error: unknown) => {
          if (closed || mine !== generation) return;
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
      if (userText) void reply(userText);
    },
    cancel() {
      const wasReplying = replyActive;
      stopWork();
      if (wasReplying) endReply(true);
    },
    say(text) {
      if (!closed) void reply(undefined, text);
    },
    updateInstructions(next) {
      instructions = next;
    },
    addContext(text) {
      history.push({ role: "system", content: text });
    },
    close() {
      closed = true;
      stopWork();
      vad.reset();
    }
  };
}
