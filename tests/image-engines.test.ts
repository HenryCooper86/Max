/* eslint-disable @typescript-eslint/no-explicit-any -- upstream wire payloads are inspected structurally */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, EngineImage } from "../server/providers/live/engine";
import { createGeminiLiveEngine } from "../server/providers/live/gemini-live";
import { createMaxSpeechEngine } from "../server/providers/live/max-speech";
import {
  createRealtimeEngine,
  grokDialect,
  localRealtimeDialect,
  openAiDialect
} from "../server/providers/live/openai-realtime";
import { createPipelineEngine, type PipelineSettings } from "../server/providers/live/pipeline";

class FakeSocket {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  on(event: string, handler: (...args: unknown[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, any>);
  }
  close() {
    this.readyState = 3;
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
  receive(payload: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
  ofType(type: string) {
    return this.sent.filter((event) => event.type === type);
  }
}

const CONFIG: EngineConfig = {
  instructions: "You are Max.",
  voiceGender: "female",
  manualResponse: false,
  languages: ["en"],
  keyterms: [],
  tools: []
};
const IMAGE: EngineImage = { data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" };
const log = createLogger("test");

function events() {
  const seen: Array<[string, ...unknown[]]> = [];
  const handlers: EngineEvents = {
    onSpeechStarted: () => seen.push(["speech"]),
    onRiderTranscript: (text, final) => seen.push(["rider", text, final]),
    onResponseStarted: () => seen.push(["response"]),
    onAgentText: (delta) => seen.push(["text", delta]),
    onAgentAudio: (pcm) => seen.push(["audio", pcm.length]),
    onResponseDone: (info) => seen.push(["done", info.cancelled]),
    onError: (message) => seen.push(["error", message]),
    onClosed: (reason) => seen.push(["closed", reason])
  };
  return { seen, handlers };
}

const ENV_KEYS = ["OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "OPENAI_REALTIME_MODEL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("OpenAI Realtime pictures", () => {
  async function connect() {
    process.env.OPENAI_API_KEY = "k";
    const dialect = openAiDialect();
    const socket = new FakeSocket();
    const engine = createRealtimeEngine(dialect, log, () => socket as never);
    const ready = engine.connect(CONFIG, events().handlers);
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await ready;
    return { engine, socket };
  }

  it("sends input_image then input_text, and asks for a reply, when there are words", async () => {
    const { engine, socket } = await connect();
    engine.sendImage!(IMAGE, "what is this?");
    expect(socket.ofType("conversation.item.create")).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
            { type: "input_text", text: "what is this?" }
          ]
        }
      }
    ]);
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("sends just the image, and no reply request, without words", async () => {
    const { engine, socket } = await connect();
    engine.sendImage!({ data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(socket.ofType("conversation.item.create")).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }]
        }
      }
    ]);
    expect(socket.ofType("response.create")).toHaveLength(0);
  });

  it("with words during an active reply, waits for it to finish like sendText", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    engine.sendImage!(IMAGE, "and this?");
    expect(socket.ofType("conversation.item.create")).toHaveLength(1);
    expect(socket.ofType("response.create")).toHaveLength(0);
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("a silent picture does not disturb a tool call waiting for its result", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "c1", name: "t", arguments: "{}" }
    });
    engine.sendImage!(IMAGE);
    engine.sendToolResult!("c1", "ok");
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("is offered for the OpenAI dialect unless the model looks like a preview", () => {
    process.env.OPENAI_API_KEY = "k";
    const engineFor = (model?: string) => {
      if (model) process.env.OPENAI_REALTIME_MODEL = model;
      else delete process.env.OPENAI_REALTIME_MODEL;
      return createRealtimeEngine(openAiDialect(), log, () => new FakeSocket() as never);
    };
    expect(engineFor().sendImage).toBeTypeOf("function");
    expect(engineFor("gpt-realtime-2").sendImage).toBeTypeOf("function");
    expect(engineFor("gpt-4o-realtime-preview-2025-06-03").sendImage).toBeUndefined();
    expect(engineFor("gpt-4o-mini-realtime-preview").sendImage).toBeUndefined();
  });

  it("is not offered for Grok or a local realtime server", () => {
    for (const dialect of [grokDialect(), localRealtimeDialect()]) {
      const engine = createRealtimeEngine(dialect, log, () => new FakeSocket() as never);
      expect(engine.sendImage).toBeUndefined();
    }
  });
});

describe("OpenAI Realtime live video", () => {
  async function connect() {
    process.env.OPENAI_API_KEY = "k";
    const socket = new FakeSocket();
    const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never);
    const ready = engine.connect(CONFIG, events().handlers);
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await ready;
    return { engine, socket };
  }
  const frame = (name: string): EngineImage => ({ data: name, mimeType: "image/jpeg" });
  const item = (id: string, name: string) => ({
    type: "conversation.item.create",
    item: {
      id,
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${name}` }]
    }
  });

  it("holds the newest frame until the user begins to speak, then shows it ahead of the turn", async () => {
    const { engine, socket } = await connect();
    engine.sendVideoFrame!(frame("F1"));
    engine.sendVideoFrame!(frame("F2"));
    expect(socket.ofType("conversation.item.create")).toEqual([]);
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(socket.ofType("conversation.item.create")).toEqual([item("frame_1", "F2")]);
    // The same frame is not shown twice, and nothing asks for a reply: the turn itself does.
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(socket.ofType("conversation.item.create")).toHaveLength(1);
    expect(socket.ofType("response.create")).toEqual([]);
  });

  it("shows it ahead of a typed turn too", async () => {
    const { engine, socket } = await connect();
    engine.sendVideoFrame!(frame("F1"));
    engine.sendText!("what is this?");
    expect(socket.ofType("conversation.item.create")).toEqual([
      item("frame_1", "F1"),
      {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: "what is this?" }] }
      }
    ]);
  });

  it("keeps the last two frames in the conversation and takes older ones out", async () => {
    const { engine, socket } = await connect();
    for (const name of ["F1", "F2", "F3", "F4"]) {
      engine.sendVideoFrame!(frame(name));
      socket.receive({ type: "input_audio_buffer.speech_started" });
    }
    expect(socket.ofType("conversation.item.create").map((event) => event.item.id)).toEqual([
      "frame_1",
      "frame_2",
      "frame_3",
      "frame_4"
    ]);
    expect(socket.ofType("conversation.item.delete")).toEqual([
      { type: "conversation.item.delete", item_id: "frame_1" },
      { type: "conversation.item.delete", item_id: "frame_2" }
    ]);
  });

  it("shows nothing once the video has stopped", async () => {
    const { engine, socket } = await connect();
    engine.sendVideoFrame!(frame("F1"));
    engine.sendVideoFrame!(undefined);
    socket.receive({ type: "input_audio_buffer.speech_started" });
    expect(socket.ofType("conversation.item.create")).toEqual([]);
  });

  it("is offered where pictures are", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.XAI_API_KEY = "k";
    const make = (dialect: ReturnType<typeof openAiDialect>) =>
      createRealtimeEngine(dialect, log, () => new FakeSocket() as never);
    expect(make(openAiDialect()).sendVideoFrame).toBeTypeOf("function");
    expect(make(grokDialect()).sendVideoFrame).toBeUndefined();
  });
});

describe("Gemini Live video", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it("is passed on as it comes, a frame a second at most", async () => {
    process.env.GEMINI_API_KEY = "k";
    const socket = new FakeSocket();
    const engine = createGeminiLiveEngine(log, () => socket as never);
    const ready = engine.connect(CONFIG, events().handlers);
    socket.emit("open");
    socket.receive({ setupComplete: {} });
    await ready;
    const setup = socket.sent.length;
    const frame = (name: string): EngineImage => ({ data: name, mimeType: "image/jpeg" });
    engine.sendVideoFrame!(frame("F1"));
    vi.advanceTimersByTime(500);
    engine.sendVideoFrame!(frame("F2"));
    vi.advanceTimersByTime(500);
    engine.sendVideoFrame!(frame("F3"));
    // The end of the video is nothing Gemini is told.
    engine.sendVideoFrame!(undefined);
    expect(socket.sent.slice(setup)).toEqual([
      { realtimeInput: { video: { data: "F1", mimeType: "image/jpeg" } } },
      { realtimeInput: { video: { data: "F3", mimeType: "image/jpeg" } } }
    ]);
  });
});

describe("Gemini Live pictures", () => {
  async function connect() {
    process.env.GEMINI_API_KEY = "k";
    const socket = new FakeSocket();
    const engine = createGeminiLiveEngine(log, () => socket as never);
    const ready = engine.connect(CONFIG, events().handlers);
    socket.emit("open");
    socket.receive({ setupComplete: {} });
    await ready;
    return { engine, socket };
  }

  it("sends a video frame, then the words as realtime text", async () => {
    const { engine, socket } = await connect();
    const setup = socket.sent.length;
    engine.sendImage!(IMAGE, "what is this?");
    expect(socket.sent.slice(setup)).toEqual([
      { realtimeInput: { video: { data: "/9j/4AAQSkZJRg==", mimeType: "image/jpeg" } } },
      { realtimeInput: { text: "what is this?" } }
    ]);
  });

  it("sends only the frame without words", async () => {
    const { engine, socket } = await connect();
    const setup = socket.sent.length;
    engine.sendImage!({ data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(socket.sent.slice(setup)).toEqual([
      { realtimeInput: { video: { data: "iVBORw0KGgo=", mimeType: "image/png" } } }
    ]);
  });
});

describe("chat-model engines and pictures", () => {
  const settings = (images: boolean): PipelineSettings => ({
    stt: { baseUrl: "http://localhost:9000/v1", apiKey: "", model: "w" },
    llm: { baseUrl: "https://llm.example/v1", apiKey: "k", model: "chat", images },
    tts: { baseUrl: "https://tts.example/v1", apiKey: "k", model: "tts", voice: () => "nova", sampleRate: 24_000 }
  });
  const sse = (text: string) =>
    new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200
    });

  it("the pipeline sends a user message of parts, text then image_url", async () => {
    const chats: any[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) {
        chats.push(JSON.parse(init!.body as string));
        return sse("A cat.");
      }
      return new Response(Buffer.alloc(480), { status: 200 });
    });
    const rec = events();
    const engine = createPipelineEngine(log, settings(true), request as never, {});
    await engine.connect(CONFIG, rec.handlers);
    engine.sendImage!(IMAGE, "what is this?");
    await vi.waitFor(() => expect(rec.seen.at(-1)).toEqual(["done", false]));
    expect(chats[0].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } }
      ]
    });
  });

  it("a silent picture starts nothing and rides with the next typed turn", async () => {
    const chats: any[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) {
        chats.push(JSON.parse(init!.body as string));
        return sse("Red.");
      }
      return new Response(Buffer.alloc(480), { status: 200 });
    });
    const rec = events();
    const engine = createPipelineEngine(log, settings(true), request as never, {});
    await engine.connect(CONFIG, rec.handlers);
    engine.sendImage!(IMAGE);
    expect(request).not.toHaveBeenCalled();
    expect(rec.seen).toEqual([]);
    engine.sendText!("what colour was it?");
    await vi.waitFor(() => expect(rec.seen.at(-1)).toEqual(["done", false]));
    expect(chats[0].messages.at(-1).content).toEqual([
      { type: "text", text: "what colour was it?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } }
    ]);
  });

  it("a frame of live video rides with the next turn, spoken or typed, and only where pictures are on", async () => {
    const chats: any[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) {
        chats.push(JSON.parse(init!.body as string));
        return sse("A cup.");
      }
      return new Response(Buffer.alloc(480), { status: 200 });
    });
    const rec = events();
    const engine = createPipelineEngine(log, settings(true), request as never, {});
    await engine.connect(CONFIG, rec.handlers);
    engine.sendVideoFrame!({ data: "T0xE", mimeType: "image/jpeg" });
    engine.sendVideoFrame!(IMAGE);
    expect(request).not.toHaveBeenCalled();
    engine.sendText!("what am I holding?");
    await vi.waitFor(() => expect(rec.seen.at(-1)).toEqual(["done", false]));
    expect(chats[0].messages.at(-1).content).toEqual([
      { type: "text", text: "what am I holding?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } }
    ]);
    expect(createPipelineEngine(log, settings(false), request as never, {}).sendVideoFrame).toBeUndefined();
  });

  it("offers sendImage only when the owner turned pictures on", () => {
    const request = vi.fn();
    expect(createPipelineEngine(log, settings(false), request as never, {}).sendImage).toBeUndefined();
    expect(createPipelineEngine(log, settings(true), request as never, {}).sendImage).toBeTypeOf("function");

    const stage = (images: boolean) => () => ({ baseUrl: "http://llm.example/v1", apiKey: "k", model: "m", images });
    const speech = (images: boolean) =>
      createMaxSpeechEngine(
        log,
        { url: "ws://127.0.0.1:1/x", apiKey: "", voice: undefined },
        stage(images),
        request as never
      );
    expect(speech(false).sendImage).toBeUndefined();
    expect(speech(true).sendImage).toBeTypeOf("function");
  });
});
