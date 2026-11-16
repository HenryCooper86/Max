/* eslint-disable @typescript-eslint/no-explicit-any -- upstream wire payloads are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../server/logger";
import {
  pcm16Rms,
  resamplePcm16,
  wavFromPcm16,
  type EngineConfig,
  type EngineEvents
} from "../server/providers/live/engine";
import { createGeminiLiveEngine } from "../server/providers/live/gemini-live";
import { createRealtimeEngine, grokDialect, openAiDialect } from "../server/providers/live/openai-realtime";
import {
  createPipelineEngine,
  createVad,
  pipelineConfigured,
  type PipelineSettings
} from "../server/providers/live/pipeline";

// Each engine is exercised against a scripted upstream: what it sends must
// match the vendor's wire format, and what it reports must be the same
// vendor-neutral events whatever the upstream calls them.

class FakeSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.alloc(0));
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
  receive(payload: unknown, binary = false) {
    this.emit("message", Buffer.from(JSON.stringify(payload)), binary);
  }
  ofType(type: string) {
    return this.sent.filter((event) => event.type === type);
  }
}

function recorder() {
  const log: Array<[string, ...unknown[]]> = [];
  const events: EngineEvents = {
    onSpeechStarted: () => log.push(["speech"]),
    onRiderTranscript: (text, final) => log.push(["rider", text, final]),
    onResponseStarted: () => log.push(["response"]),
    onAgentText: (delta) => log.push(["text", delta]),
    onAgentAudio: (pcm) => log.push(["audio", pcm.length]),
    onResponseDone: (info) => log.push(["done", info.cancelled]),
    onError: (message) => log.push(["error", message]),
    onClosed: (reason) => log.push(["closed", reason])
  };
  return { log, events };
}

const CONFIG: EngineConfig = {
  instructions: "You are Max.",
  voiceGender: "female",
  manualResponse: true,
  languages: ["zh", "en"],
  keyterms: ["Max"]
};

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_REALTIME_MODEL",
  "GEMINI_LIVE_MODEL"
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const log = createLogger("test");

describe("audio helpers", () => {
  it("resamples 16 kHz microphone frames to 24 kHz", () => {
    const input = Buffer.alloc(640);
    for (let index = 0; index < 320; index += 1) input.writeInt16LE(index * 10, index * 2);
    const output = resamplePcm16(input, 16_000, 24_000);
    expect(output.length).toBe(960);
    expect(output.readInt16LE(0)).toBe(0);
    // A ramp stays a ramp: sample 3 of the output sits at input position 2.
    expect(output.readInt16LE(6)).toBe(20);
    expect(resamplePcm16(input, 16_000, 16_000)).toBe(input);
  });

  it("measures level and wraps PCM in a valid WAV header", () => {
    const loud = Buffer.alloc(320);
    for (let index = 0; index < 160; index += 1) loud.writeInt16LE(index % 2 ? 8000 : -8000, index * 2);
    expect(Math.round(pcm16Rms(loud))).toBe(8000);
    expect(pcm16Rms(Buffer.alloc(320))).toBe(0);
    const wav = wavFromPcm16(loud, 16_000);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(320);
    expect(wav.length).toBe(364);
  });
});

describe("OpenAI realtime engine", () => {
  async function connect(config: EngineConfig = CONFIG) {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-test";
    const socket = new FakeSocket();
    const opened: Array<{ url: string; headers: Record<string, string> }> = [];
    const { log: seen, events } = recorder();
    const engine = createRealtimeEngine(openAiDialect(), log, (url, headers) => {
      opened.push({ url, headers });
      return socket as never;
    });
    const ready = engine.connect(config, events);
    socket.emit("open");
    socket.receive({ type: "session.created" });
    socket.receive({ type: "session.updated" });
    await ready;
    return { engine, socket, seen, opened };
  }

  it("configures a manual-response session with input transcription", async () => {
    const { engine, socket, opened } = await connect();
    expect(engine.responseMode).toBe("manual-capable");
    expect(opened[0]).toMatchObject({
      url: "wss://api.openai.com/v1/realtime?model=gpt-realtime-test",
      headers: { Authorization: "Bearer test-key" }
    });
    const session = socket.ofType("session.update")[0]!.session as Record<string, any>;
    expect(session).toMatchObject({ type: "realtime", instructions: "You are Max.", output_modalities: ["audio"] });
    expect(session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(session.audio.input.turn_detection).toMatchObject({ create_response: false, interrupt_response: true });
    expect(session.audio.input.transcription.model).toBeTruthy();
    expect(session.audio.output).toMatchObject({ format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" });
  });

  it("lets the upstream answer on its own when no wake word gates it", async () => {
    const { socket } = await connect({ ...CONFIG, manualResponse: false, voiceGender: "male" });
    const session = socket.ofType("session.update")[0]!.session as Record<string, any>;
    expect(session.audio.input.turn_detection.create_response).toBe(true);
    expect(session.audio.output.voice).toBe("cedar");
  });

  it("upsamples microphone audio and maps upstream events under either name", async () => {
    const { engine, socket, seen } = await connect();
    engine.sendAudio(Buffer.alloc(640));
    const appended = socket.ofType("input_audio_buffer.append")[0]!;
    expect(Buffer.from(appended.audio as string, "base64").length).toBe(960);

    socket.receive({ type: "input_audio_buffer.speech_started" });
    socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "Max " });
    socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "hi" });
    socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "Max, hi."
    });
    engine.respond();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_audio_transcript.delta", delta: "Hello" });
    socket.receive({ type: "response.audio_transcript.delta", delta: " there" });
    socket.receive({ type: "response.output_audio.delta", delta: Buffer.alloc(480).toString("base64") });
    socket.receive({ type: "response.audio.delta", delta: Buffer.alloc(240).toString("base64") });
    engine.cancel();
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    engine.cancel();

    expect(seen).toEqual([
      ["speech"],
      ["rider", "Max ", false],
      ["rider", "Max hi", false],
      ["rider", "Max, hi.", true],
      ["response"],
      ["text", "Hello"],
      ["text", " there"],
      ["audio", 480],
      ["audio", 240],
      ["done", true]
    ]);
    expect(socket.ofType("response.create")).toHaveLength(1);
    // Only the cancel sent while a reply was active reaches the upstream.
    expect(socket.ofType("response.cancel")).toHaveLength(1);
  });

  it("speaks exact lines out of band and reports later errors without dying", async () => {
    const { engine, socket, seen } = await connect();
    engine.say("前方右转");
    const said = socket.ofType("response.create")[0]!.response as Record<string, any>;
    expect(said.conversation).toBe("none");
    expect(said.instructions).toContain("前方右转");
    engine.addContext("[设备结果] ok");
    expect((socket.ofType("conversation.item.create")[0]!.item as Record<string, any>).role).toBe("system");
    engine.updateInstructions("new");
    expect(socket.ofType("session.update")[1]!.session).toEqual({ type: "realtime", instructions: "new" });

    socket.receive({ type: "error", error: { message: "rate limited" } });
    socket.receive({ type: "error", error: { code: "response_cancel_not_active", message: "no active response" } });
    expect(seen).toEqual([["error", "rate limited"]]);
  });

  it("rejects with the upstream's reason when the session is refused", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const socket = new FakeSocket();
    const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never);
    const ready = engine.connect(CONFIG, recorder().events);
    socket.emit("open");
    socket.receive({ type: "error", error: { message: "model not found" } });
    await expect(ready).rejects.toThrow("OpenAI Realtime: model not found");

    const refused = new FakeSocket();
    const second = createRealtimeEngine(openAiDialect(), log, () => refused as never).connect(
      CONFIG,
      recorder().events
    );
    refused.emit("unexpected-response", {}, { statusCode: 401 });
    await expect(second).rejects.toThrow(/HTTP 401 — check the API key/);

    delete process.env.OPENAI_API_KEY;
    await expect(createRealtimeEngine(openAiDialect(), log).connect(CONFIG, recorder().events)).rejects.toThrow(
      /API key is not configured/
    );
  });

  it("reports an unexpected close once the session was live", async () => {
    const { socket, seen, engine } = await connect();
    socket.emit("close", 1006, Buffer.from("gone"));
    expect(seen).toEqual([["closed", "closed (1006 gone)"]]);
    engine.close();
    expect(seen).toHaveLength(1);
  });
});

describe("Grok voice engine", () => {
  it("speaks xAI's dialect: native 16 kHz input, cumulative transcripts, force_message", async () => {
    process.env.XAI_API_KEY = "xai-test";
    const socket = new FakeSocket();
    const opened: string[] = [];
    const { log: seen, events } = recorder();
    const engine = createRealtimeEngine(grokDialect(), log, (url) => {
      opened.push(url);
      return socket as never;
    });
    const ready = engine.connect({ ...CONFIG, manualResponse: false }, events);
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await ready;

    expect(engine.responseMode).toBe("auto");
    expect(opened[0]).toBe("wss://api.x.ai/v1/realtime?model=grok-voice-latest");
    const session = socket.ofType("session.update")[0]!.session as Record<string, any>;
    expect(session).toMatchObject({ voice: "eve", turn_detection: { type: "server_vad" } });
    expect(session.type).toBeUndefined();
    expect(session.audio.input.format.rate).toBe(16_000);
    expect(session.audio.input.transcription).toMatchObject({ model: "grok-transcribe", language_hint: "zh" });

    engine.sendAudio(Buffer.alloc(640));
    expect(Buffer.from(socket.ofType("input_audio_buffer.append")[0]!.audio as string, "base64").length).toBe(640);

    // xAI only sends cumulative "updated" transcripts: answering closes the turn.
    socket.receive({ type: "conversation.item.input_audio_transcription.updated", item_id: "a", transcript: "Max" });
    socket.receive({
      type: "conversation.item.input_audio_transcription.updated",
      item_id: "a",
      transcript: "Max 你好"
    });
    socket.receive({ type: "response.created" });
    expect(seen).toEqual([
      ["rider", "Max", false],
      ["rider", "Max 你好", false],
      ["rider", "Max 你好", true],
      ["response"]
    ]);

    engine.say("好的");
    expect(socket.ofType("conversation.item.create").at(-1)!.item).toMatchObject({
      type: "force_message",
      content: [{ type: "output_text", text: "好的" }]
    });
  });
});

describe("Gemini live engine", () => {
  it("sets up an audio session and turns Gemini's stream into turns", async () => {
    process.env.GEMINI_API_KEY = "gem-test";
    process.env.GEMINI_LIVE_MODEL = "gemini-test-live";
    const socket = new FakeSocket();
    const opened: string[] = [];
    const { log: seen, events } = recorder();
    const engine = createGeminiLiveEngine(log, (url) => {
      opened.push(url);
      return socket as never;
    });
    const ready = engine.connect(CONFIG, events);
    socket.emit("open");
    // Gemini delivers JSON in binary frames.
    socket.receive({ setupComplete: {} }, true);
    await ready;

    expect(opened[0]).toContain("BidiGenerateContent?key=gem-test");
    const setup = socket.sent[0]!.setup as Record<string, any>;
    expect(setup.model).toBe("models/gemini-test-live");
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Aoede");
    expect(setup.systemInstruction.parts[0].text).toBe("You are Max.");
    expect(setup).toHaveProperty("inputAudioTranscription");
    expect(setup).toHaveProperty("outputAudioTranscription");

    engine.sendAudio(Buffer.alloc(640));
    expect((socket.sent[1]!.realtimeInput as Record<string, any>).audio.mimeType).toBe("audio/pcm;rate=16000");

    const audio = Buffer.alloc(480).toString("base64");
    socket.receive({ serverContent: { inputTranscription: { text: "Max " } } });
    socket.receive({ serverContent: { inputTranscription: { text: "你好" } } });
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } });
    socket.receive({ serverContent: { outputTranscription: { text: "你好！" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    // The wearer talks over the next reply.
    socket.receive({ serverContent: { inputTranscription: { text: "Max 停" } } });
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: audio } }] } } });
    socket.receive({ serverContent: { interrupted: true } });

    expect(seen).toEqual([
      ["speech"],
      ["rider", "Max ", false],
      ["rider", "Max 你好", false],
      ["rider", "Max 你好", true],
      ["response"],
      ["audio", 480],
      ["text", "你好！"],
      ["done", false],
      ["speech"],
      ["rider", "Max 停", false],
      ["rider", "Max 停", true],
      ["response"],
      ["audio", 480],
      ["speech"],
      ["done", true]
    ]);
  });

  it("reports why a setup was refused", async () => {
    process.env.GEMINI_API_KEY = "gem-test";
    const socket = new FakeSocket();
    const ready = createGeminiLiveEngine(log, () => socket as never).connect(CONFIG, recorder().events);
    socket.emit("close", 1008, Buffer.from("model not found"));
    await expect(ready).rejects.toThrow("Gemini Live: closed (1008 model not found)");
  });
});

function tone(frames: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(frames * 640);
  for (let index = 0; index < pcm.length / 2; index += 1)
    pcm.writeInt16LE(index % 2 ? amplitude : -amplitude, index * 2);
  return pcm;
}

/** A moment of quiet room. The detector listens for 300 ms at the start of a
 *  stream before it will open a turn, as a microphone always gives it. */
const ROOM = tone(20, 0);

/** A steady hiss: every sample random, at about the given loudness. */
function hiss(frames: number, rms: number, seed = 7): Buffer {
  const pcm = Buffer.alloc(frames * 640);
  let state = seed;
  for (let index = 0; index < pcm.length / 2; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const value = (state / 0x7fffffff) * 2 - 1;
    pcm.writeInt16LE(Math.round(value * rms * Math.sqrt(3)), index * 2);
  }
  return pcm;
}

/** A low rumble: a 60 Hz tone, where wind and engines are loudest. */
function rumble(frames: number, amplitude: number): Buffer {
  const pcm = Buffer.alloc(frames * 640);
  for (let index = 0; index < pcm.length / 2; index += 1) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 60 * index) / 16000)), index * 2);
  }
  return pcm;
}

function mixed(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(Math.min(a.length, b.length));
  for (let index = 0; index < out.length; index += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, a.readInt16LE(index) + b.readInt16LE(index))), index);
  }
  return out;
}

describe("voice activity detection", () => {
  it("opens on sustained speech and closes after trailing silence", () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const vad = createVad(
      { onStart: () => starts.push(1), onEnd: (audio) => ends.push(audio.length) },
      { endSilenceMs: 200 }
    );
    vad.push(tone(10, 0));
    // A click shorter than the start threshold is not speech.
    vad.push(tone(2, 9000));
    vad.push(tone(5, 0));
    expect(starts).toHaveLength(0);

    vad.push(tone(30, 9000));
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);
    vad.push(tone(10, 0));
    expect(ends).toHaveLength(1);
    // Speech plus pre-roll and the closing silence, in whole 20 ms frames.
    expect(ends[0]! % 640).toBe(0);
    expect(ends[0]!).toBeGreaterThanOrEqual(30 * 640);
  });

  it("handles audio that arrives in ragged pieces", () => {
    const starts: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: () => undefined });
    const speech = Buffer.concat([ROOM, tone(20, 9000)]);
    for (let offset = 0; offset < speech.length; offset += 333) vad.push(speech.subarray(offset, offset + 333));
    expect(starts).toHaveLength(1);
  });

  it("does not take steady noise for speech, from the first frame or for minutes after", () => {
    const starts: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: () => undefined });
    // Two minutes of loud hiss, starting with the stream: no quiet to learn from.
    for (let block = 0; block < 60; block += 1) vad.push(hiss(100, 3000, block + 1));
    expect(starts).toHaveLength(0);
  });

  it("still hears speech over that noise", () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: (audio) => ends.push(audio.length) });
    vad.push(hiss(150, 1000));
    expect(starts).toHaveLength(0);
    vad.push(mixed(hiss(30, 1000, 3), tone(30, 6000)));
    expect(starts).toHaveLength(1);
    vad.push(hiss(60, 1000, 5));
    expect(ends).toHaveLength(1);
  });

  it("is far less sensitive to rumble below the speech band", () => {
    const starts: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: () => undefined });
    vad.push(ROOM);
    // Wind and engine rumble arriving in a quiet room, six times the level
    // at which speech would open a turn.
    vad.push(rumble(150, 4000));
    expect(starts).toHaveLength(0);
  });

  it("lets go of a noise that starts mid-stream instead of staying open on it", () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: () => ends.push(1) });
    vad.push(ROOM);
    vad.push(tone(40, 0));
    // A fan switches on. It is taken for a turn once, then learned.
    vad.push(hiss(100 * 60, 3000));
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });

  it("keeps what it learned about the room when a turn is cut short", () => {
    const starts: number[] = [];
    const vad = createVad({ onStart: () => starts.push(1), onEnd: () => undefined });
    vad.push(hiss(150, 3000));
    vad.reset();
    vad.push(hiss(300, 3000, 9));
    expect(starts).toHaveLength(0);
  });
});

describe("Whisper pipeline engine", () => {
  const settings: PipelineSettings = {
    stt: { baseUrl: "http://localhost:9000/v1", apiKey: "", model: "whisper-test" },
    llm: { baseUrl: "https://llm.example/v1", apiKey: "llm-key", model: "chat-test" },
    tts: {
      baseUrl: "https://tts.example/v1",
      apiKey: "tts-key",
      model: "tts-test",
      voice: () => "nova",
      sampleRate: 24_000
    }
  };

  function sse(deltas: string[]): Response {
    const body = deltas
      .map((delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`)
      .join("");
    return new Response(`${body}data: [DONE]\n\n`, { status: 200 });
  }

  it("needs a key for hosted stages but not for local ones", () => {
    expect(pipelineConfigured(settings)).toBe(true);
    expect(pipelineConfigured({ ...settings, llm: { ...settings.llm, apiKey: "" } })).toBe(false);
  });

  it("transcribes a turn, then streams the answer sentence by sentence in order", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
        auth: headers.Authorization
      });
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: " Max 现在几点 " });
      if (url.endsWith("/chat/completions")) return sse(["现在", "三点。", "需要", "导航吗？"]);
      // The first sentence takes longer to synthesize than the second.
      const text = (JSON.parse(init!.body as string) as { input: string }).input;
      await new Promise((resolve) => setTimeout(resolve, text.startsWith("现在") ? 30 : 1));
      return new Response(Buffer.alloc(text.startsWith("现在") ? 480 : 240), { status: 200 });
    });
    const { log: seen, events } = recorder();
    const engine = createPipelineEngine(log, settings, request as never, { endSilenceMs: 200 });
    await engine.connect({ ...CONFIG, languages: ["zh"] }, events);
    expect(engine.responseMode).toBe("manual-only");

    engine.sendAudio(ROOM);
    engine.sendAudio(tone(30, 9000));
    engine.sendAudio(tone(12, 0));
    await vi.waitFor(() => expect(seen.some(([kind]) => kind === "rider")).toBe(true));
    expect(seen).toEqual([["speech"], ["rider", "Max 现在几点", true]]);
    const stt = calls[0]!;
    expect(stt.url).toBe("http://localhost:9000/v1/audio/transcriptions");
    expect(stt.auth).toBeUndefined();
    expect((stt.body as FormData).get("model")).toBe("whisper-test");
    expect((stt.body as FormData).get("language")).toBe("zh");

    engine.respond();
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["done", false]));
    expect(seen.slice(2)).toEqual([
      ["response"],
      ["text", "现在"],
      ["text", "三点。"],
      ["text", "需要"],
      ["text", "导航吗？"],
      ["audio", 480],
      ["audio", 240],
      ["done", false]
    ]);
    const chat = calls.find((call) => call.url.endsWith("/chat/completions"))!;
    expect(chat.auth).toBe("Bearer llm-key");
    expect(chat.body).toMatchObject({
      model: "chat-test",
      stream: true,
      messages: [
        { role: "system", content: "You are Max." },
        { role: "user", content: "Max 现在几点" }
      ]
    });
    const spoken = calls.filter((call) => call.url.endsWith("/audio/speech")).map((call) => (call.body as any).input);
    expect(spoken).toEqual(["现在三点。", "需要导航吗？"]);

    // The exchange is remembered for the next turn.
    engine.sendAudio(ROOM);
    engine.sendAudio(tone(30, 9000));
    engine.sendAudio(tone(12, 0));
    await vi.waitFor(() => expect(seen.filter(([kind]) => kind === "rider")).toHaveLength(2));
    engine.respond();
    await vi.waitFor(() => expect(seen.filter(([kind]) => kind === "done")).toHaveLength(2));
    const second = calls.filter((call) => call.url.endsWith("/chat/completions"))[1]!;
    expect((second.body as any).messages).toHaveLength(4);
  });

  it("drops a reply the wearer talks over", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "讲个故事" });
      if (url.endsWith("/chat/completions")) return sse(["很久以前。"]);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return new Response(Buffer.alloc(480), { status: 200 });
    });
    const { log: seen, events } = recorder();
    const engine = createPipelineEngine(log, settings, request as never, { endSilenceMs: 200 });
    await engine.connect(CONFIG, events);
    engine.sendAudio(ROOM);
    engine.sendAudio(tone(30, 9000));
    engine.sendAudio(tone(12, 0));
    await vi.waitFor(() => expect(seen.some(([kind]) => kind === "rider")).toBe(true));
    engine.respond();
    await vi.waitFor(() => expect(seen.some(([kind]) => kind === "text")).toBe(true));

    engine.sendAudio(tone(30, 9000));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen.filter(([kind]) => kind === "audio")).toHaveLength(0);
    expect(seen.filter(([kind]) => kind === "done")).toEqual([["done", true]]);
    engine.close();
  });

  it("reports a failing stage and still ends the turn", async () => {
    const request = vi.fn(async () => new Response("bad key", { status: 401 }));
    const { log: seen, events } = recorder();
    const engine = createPipelineEngine(log, settings, request as never, { endSilenceMs: 200 });
    await engine.connect(CONFIG, events);
    engine.sendAudio(ROOM);
    engine.sendAudio(tone(30, 9000));
    engine.sendAudio(tone(12, 0));
    await vi.waitFor(() => expect(seen.some(([kind]) => kind === "error")).toBe(true));
    expect(seen).toEqual([
      ["speech"],
      ["error", "Speech-to-text HTTP 401 — check the API key: bad key"],
      ["rider", "", true]
    ]);
  });
});
