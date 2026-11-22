/* eslint-disable @typescript-eslint/no-explicit-any -- messages and request bodies are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, VoiceEngine } from "../server/providers/live/engine";
import { resolveVoiceProviderId, voiceProvider } from "../server/providers/catalog";
import { createMaxSpeechEngine, maxSpeechUrl } from "../server/providers/live/max-speech";

const log = createLogger({ level: "silent" } as never);

const sseOf = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200
  });
const text = (content: string) => ({ choices: [{ delta: { content } }] });
const toolPiece = (piece: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [piece] } }] });

const config: EngineConfig = {
  instructions: "Be brief.",
  voiceGender: "female",
  manualResponse: true,
  languages: ["zh", "en"],
  keyterms: ["Max"],
  tools: [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } } as never]
};

type Fake = {
  url: string;
  /** Messages the client sent, parsed; binary frames as Buffers. */
  received: any[];
  headers: Record<string, string | string[] | undefined>;
  socket(): ServerSocket;
  send(message: unknown): void;
  close: () => Promise<void>;
};

const servers: Fake[] = [];

async function fakeServer(onMessage?: (message: any, fake: Fake) => void, greeting: "ready" | "none" = "ready") {
  const received: any[] = [];
  let current: ServerSocket | undefined;
  let headers: Fake["headers"] = {};
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const fake: Fake = {
    url: `ws://127.0.0.1:${port}/v1/speech/session`,
    received,
    get headers() {
      return headers;
    },
    socket: () => current!,
    send: (message) => current!.send(typeof message === "string" ? message : JSON.stringify(message)),
    close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
  };
  wss.on("connection", (socket, request) => {
    current = socket;
    headers = request.headers;
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        received.push(raw as Buffer);
        return;
      }
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.type === "session.update" && greeting === "ready")
        fake.send({ type: "ready", protocol: "max-speech.session.v1", engines: {} });
      onMessage?.(message, fake);
    });
  });
  servers.push(fake);
  return fake;
}

function setup(fake: Fake, replies: Array<() => Response> = [], apiKey = "") {
  const seen: string[] = [];
  const audio: Buffer[] = [];
  const chats: any[] = [];
  const toolCalls: string[] = [];
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    chats.push(JSON.parse(init!.body as string));
    return replies[chats.length - 1]!();
  });
  const events = {
    onSpeechStarted: () => seen.push("speech"),
    onRiderTranscript: (value: string, final: boolean) => seen.push(`user:${final ? "final" : "partial"}:${value}`),
    onResponseStarted: () => seen.push("start"),
    onAgentText: (delta: string) => seen.push(`text:${delta}`),
    onAgentAudio: (pcm: Buffer) => audio.push(pcm),
    onResponseDone: ({ cancelled }: { cancelled: boolean }) => seen.push(`done:${cancelled}`),
    onError: (message: string) => seen.push(`error:${message}`),
    onClosed: (reason: string) => seen.push(`closed:${reason}`),
    onToolCall: (call: { callId: string }) => toolCalls.push(call.callId)
  } as unknown as EngineEvents;
  const engine: VoiceEngine = createMaxSpeechEngine(
    log,
    { url: fake.url, apiKey, voice: undefined },
    () => ({ baseUrl: "http://llm.example/v1", apiKey: "k", model: "m" }),
    request as never
  );
  return { engine, events, seen, audio, chats, toolCalls };
}

const until = async (check: () => boolean, label = "condition") => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const speaks = (fake: Fake) => fake.received.filter((message) => message?.type === "speak");

afterEach(async () => {
  for (const fake of servers.splice(0)) {
    for (const client of [fake.socket?.()].filter(Boolean)) client.terminate();
    await fake.close();
  }
});

describe("max speech url", () => {
  it("derives the websocket url from an http address and keeps a ws one", () => {
    expect(maxSpeechUrl(undefined)).toBe("ws://localhost:8790/v1/speech/session");
    expect(maxSpeechUrl("http://box:8790")).toBe("ws://box:8790/v1/speech/session");
    expect(maxSpeechUrl("https://speech.example/")).toBe("wss://speech.example/v1/speech/session");
    expect(maxSpeechUrl("ws://box:1/custom/path")).toBe("ws://box:1/custom/path");
  });

  it("normalises a bare or /v1 address of any scheme to the session path", () => {
    expect(maxSpeechUrl("http://host:8790/v1")).toBe("ws://host:8790/v1/speech/session");
    expect(maxSpeechUrl("https://host/v1/")).toBe("wss://host/v1/speech/session");
    expect(maxSpeechUrl("ws://host:8790")).toBe("ws://host:8790/v1/speech/session");
    expect(maxSpeechUrl("wss://host/v1")).toBe("wss://host/v1/speech/session");
  });
});

describe("max speech catalog entry", () => {
  it("is configured by MAX_SPEECH_URL or MAX_SPEECH=on and counts as local", () => {
    const saved = { url: process.env.MAX_SPEECH_URL, on: process.env.MAX_SPEECH };
    try {
      delete process.env.MAX_SPEECH_URL;
      delete process.env.MAX_SPEECH;
      expect(resolveVoiceProviderId("max-speech")).toBe("max-speech");
      expect(voiceProvider("max-speech").configured()).toBe(false);
      process.env.MAX_SPEECH = "on";
      expect(voiceProvider("max-speech").configured()).toBe(true);
      delete process.env.MAX_SPEECH;
      process.env.MAX_SPEECH_URL = "http://box:8790";
      expect(voiceProvider("max-speech")).toMatchObject({ local: true });
      expect(voiceProvider("max-speech").configured()).toBe(true);
    } finally {
      for (const [name, value] of [
        ["MAX_SPEECH_URL", saved.url],
        ["MAX_SPEECH", saved.on]
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("max speech engine", () => {
  it("prefers the assistant's voice id over MAX_SPEECH_VOICE", async () => {
    const fake = await fakeServer();
    const { engine, events } = setup(fake, [], "secret");
    await engine.connect({ ...config, voiceId: "v_0123456789" }, events);
    expect(fake.received[0]).toMatchObject({ type: "session.update", voice: "v_0123456789" });
    engine.close();
  });

  it("connects, sends the session settings and the bearer key, and waits for ready", async () => {
    const fake = await fakeServer();
    const { engine, events } = setup(fake, [], "secret");
    expect(engine.responseMode).toBe("manual-only");
    await engine.connect(config, events);
    expect(fake.received[0]).toEqual({
      type: "session.update",
      languages: ["zh", "en"],
      gender: "female"
    });
    expect(fake.headers.authorization).toBe("Bearer secret");
    engine.sendAudio(Buffer.from([1, 2, 3, 4]));
    await until(() => fake.received.some(Buffer.isBuffer), "audio");
    expect(fake.received.find(Buffer.isBuffer)).toEqual(Buffer.from([1, 2, 3, 4]));
    engine.close();
  });

  it("sends keyterms once the server is ready, unless it says it cannot use them", async () => {
    const accepting = await fakeServer();
    const first = setup(accepting);
    await first.engine.connect(config, first.events);
    await until(() => accepting.received.length >= 2, "keyterms update");
    expect(accepting.received[1]).toEqual({ type: "session.update", keyterms: ["Max"] });
    first.engine.close();

    const refusing = await fakeServer((message, server) => {
      if (message.type === "session.update" && !message.keyterms)
        server.send({ type: "ready", protocol: "max-speech.session.v1", engines: {}, keyterms: false });
    }, "none");
    const second = setup(refusing);
    await second.engine.connect(config, second.events);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refusing.received.filter((message) => message?.type === "session.update")).toHaveLength(1);
    expect(refusing.received.some((message) => message?.keyterms)).toBe(false);
    second.engine.close();
  });

  it("shows a server warning once and keeps going", async () => {
    const fake = await fakeServer();
    const { engine, events, seen } = setup(fake);
    await engine.connect(config, events);
    const warning = { type: "warning", code: "language_unsupported", message: "ja will not be recognised" };
    fake.send(warning);
    fake.send(warning);
    fake.send({ type: "warning", code: "keyterms_unsupported", message: "keyterms are ignored" });
    await until(() => seen.includes("error:keyterms are ignored"), "second warning");
    expect(seen.filter((item) => item === "error:ja will not be recognised")).toHaveLength(1);
    engine.close();
  });

  it("shows a warning that arrived before ready once the connection is up", async () => {
    const fake = await fakeServer((message, server) => {
      if (message.type !== "session.update" || message.keyterms) return;
      server.send({ type: "warning", code: "language_unknown", message: "xx ignored" });
      server.send({ type: "ready", protocol: "max-speech.session.v1", engines: {} });
    }, "none");
    const { engine, events, seen } = setup(fake);
    await engine.connect(config, events);
    await until(() => seen.includes("error:xx ignored"), "early warning");
    engine.close();
  });

  it("says the session limit was reached when the server refuses with busy", async () => {
    const fake = await fakeServer((_message, server) => {
      server.send({ type: "error", code: "busy", message: "this server already has 2 live session(s)" });
      server.socket().close(1013, "busy");
    }, "none");
    const { engine, events } = setup(fake);
    await expect(engine.connect(config, events)).rejects.toThrow(
      "Max Speech is at its limit of live sessions; try again when another has ended"
    );
  });

  it("explains an idle close", async () => {
    const fake = await fakeServer();
    const { engine, events, seen } = setup(fake);
    await engine.connect(config, events);
    fake.send({ type: "error", code: "idle_timeout", message: "nothing received for 600 s" });
    fake.socket().close(1000, "idle_timeout");
    await until(() => seen.some((item) => item.startsWith("closed:")), "close");
    expect(seen).toContain("closed:Max Speech closed the session after it sat idle");
    engine.close();
  });

  it("runs a spoken turn: transcripts, a streamed reply, audio, done", async () => {
    const fake = await fakeServer((message, server) => {
      if (message.type === "speak" && message.final) {
        server.send({ type: "audio.start", id: message.id, sampleRate: 24000 });
        server.socket().send(Buffer.from([9, 9]));
        server.send({ type: "audio.done", id: message.id, cancelled: false });
      }
    });
    const { engine, events, seen, audio, chats } = setup(fake, [() => sseOf([text("Hi th"), text("ere.")])]);
    await engine.connect(config, events);
    fake.send({ type: "speech.started" });
    fake.send({ type: "transcript.partial", text: "hel" });
    fake.send({ type: "transcript.final", text: "hello", ms: { turn: 120, stt: 40 } });
    await until(() => seen.includes("user:final:hello"));
    expect(seen).toEqual(["speech", "user:partial:hel", "user:final:hello"]);

    engine.respond();
    await until(() => seen.includes("done:false"));
    expect(chats[0].messages.at(-1)).toEqual({ role: "user", content: "hello" });
    const sent = speaks(fake);
    expect(sent.map((message) => [message.text, message.final])).toEqual([
      ["Hi th", false],
      ["ere.", false],
      ["", true]
    ]);
    expect(new Set(sent.map((message) => message.id)).size).toBe(1);
    expect(audio).toEqual([Buffer.from([9, 9])]);
    expect(seen.filter((item) => item.startsWith("done"))).toEqual(["done:false"]);
    engine.close();
  });

  it("does not respond to an empty turn", async () => {
    const fake = await fakeServer();
    const { engine, events, seen, chats } = setup(fake);
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "", ms: { turn: 1, stt: 1 } });
    await until(() => seen.includes("user:final:"));
    engine.respond();
    expect(chats).toHaveLength(0);
    engine.close();
  });

  it("cancels the reply and drops its audio when the wearer barges in", async () => {
    const fake = await fakeServer();
    const { engine, events, seen, audio } = setup(fake, [
      () => sseOf([text("One. "), text("Two.")]),
      () => sseOf([text("Fresh.")])
    ]);
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "hello", ms: {} });
    await until(() => seen.includes("user:final:hello"));
    engine.respond();
    await until(() => speaks(fake).length >= 2, "speak messages");
    const id = speaks(fake)[0].id;
    fake.send({ type: "audio.start", id, sampleRate: 24000 });
    fake.send({ type: "speech.started" });
    await until(() => seen.includes("done:true"), "barge-in");
    expect(fake.received.filter((message) => message?.type === "cancel")).toEqual([{ type: "cancel", id }]);
    expect(seen.indexOf("speech")).toBeLessThan(seen.indexOf("done:true"));
    // Late audio for the cancelled reply goes nowhere.
    fake.socket().send(Buffer.from([7, 7]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(audio).toEqual([]);
    engine.close();
  });

  it("rejects with a useful message when nothing is listening", async () => {
    const fake = await fakeServer();
    await fake.close();
    const { engine, events } = setup(fake);
    await expect(engine.connect(config, events)).rejects.toThrow(/Max Speech is not reachable at ws:\/\/127\.0\.0\.1/);
  });

  it("says the models are loading when the server refuses with 1013", async () => {
    const fake = await fakeServer((_message, server) => {
      server.send({ type: "error", code: "loading", message: "models are loading" });
      server.socket().close(1013, "loading");
    }, "none");
    const { engine, events } = setup(fake);
    await expect(engine.connect(config, events)).rejects.toThrow("Max Speech is still loading its models");
  });

  it("reports an unexpected close and unblocks the reply in flight", async () => {
    const fake = await fakeServer();
    const { engine, events, seen } = setup(fake, [() => sseOf([text("Hello.")])]);
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "hi", ms: {} });
    await until(() => seen.includes("user:final:hi"));
    engine.respond();
    await until(() => speaks(fake).length >= 1);
    fake.socket().close(1011, "boom");
    await until(() => seen.some((item) => item.startsWith("closed:")));
    await until(() => seen.includes("done:false"));
    engine.close();
  });

  it("does not report a close the relay asked for", async () => {
    const fake = await fakeServer();
    const { engine, events, seen } = setup(fake);
    await engine.connect(config, events);
    engine.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([]);
  });

  it("runs a tool round and speaks the answer on one reply id", async () => {
    const fake = await fakeServer((message, server) => {
      if (message.type === "speak" && message.final)
        server.send({ type: "audio.done", id: message.id, cancelled: false });
    });
    const { engine, events, seen, chats, toolCalls } = setup(fake, [
      () => sseOf([toolPiece({ index: 0, id: "c1", function: { name: "lookup", arguments: "{}" } })]),
      () => sseOf([text("It is sunny.")])
    ]);
    events.onToolCall = (call) => {
      toolCalls.push(call.callId);
      engine.sendToolResult?.(call.callId, '{"ok":true}');
    };
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "weather?", ms: {} });
    await until(() => seen.includes("user:final:weather?"));
    engine.respond();
    await until(() => seen.includes("done:false"));
    expect(toolCalls).toEqual(["c1"]);
    expect(chats).toHaveLength(2);
    expect(speaks(fake).map((message) => message.text)).toEqual(["It is sunny.", ""]);
    expect(new Set(speaks(fake).map((message) => message.id)).size).toBe(1);
    engine.close();
  });

  it("says a relay line verbatim as one final speak", async () => {
    const fake = await fakeServer((message, server) => {
      if (message.type === "speak") server.send({ type: "audio.done", id: message.id, cancelled: false });
    });
    const { engine, events, seen } = setup(fake);
    await engine.connect(config, events);
    engine.say?.("Turn left.");
    await until(() => seen.includes("done:false"));
    expect(speaks(fake)).toHaveLength(1);
    expect(speaks(fake)[0]).toMatchObject({ text: "Turn left.", final: true });
    engine.close();
  });

  it("stops sending speech once the server ended the reply, and reports the error once", async () => {
    const fake = await fakeServer((message, server) => {
      if (message.type === "speak" && !message.final) {
        server.send({ type: "error", code: "tts_failed", message: "synthesis failed", id: message.id });
        server.send({ type: "error", code: "tts_failed", message: "synthesis failed", id: message.id });
        server.send({ type: "audio.done", id: message.id, cancelled: false });
      }
    });
    let push!: (chunk: unknown) => void;
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        end = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      }
    });
    const { engine, events, seen } = setup(fake, [() => new Response(body, { status: 200 })]);
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "hi", ms: {} });
    await until(() => seen.includes("user:final:hi"));
    engine.respond();
    push(text("One. "));
    await until(() => seen.includes("error:synthesis failed"), "server error");
    await new Promise((resolve) => setTimeout(resolve, 30));
    push(text("Two. "));
    push(text("Three."));
    end();
    await until(() => seen.includes("done:false"));
    expect(speaks(fake).map((message) => message.text)).toEqual(["One. "]);
    expect(seen.filter((item) => item.startsWith("error:"))).toEqual(["error:synthesis failed"]);
    engine.close();
  });

  it("finishes the text already sent when the chat model fails, and ends after the audio", async () => {
    const fake = await fakeServer();
    // The model drops only once its first words have been read: an errored
    // stream discards what it still holds, so a timer could lose them on a slow machine.
    let drop!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(text("Half a"))}\n\n`));
        drop = () => controller.error(new Error("model dropped"));
      }
    });
    const { engine, events, seen, audio } = setup(fake, [() => new Response(body, { status: 200 })]);
    await engine.connect(config, events);
    fake.send({ type: "transcript.final", text: "hi", ms: {} });
    await until(() => seen.includes("user:final:hi"));
    engine.respond();
    await until(() => speaks(fake).some((message) => message.text === "Half a"), "first speak");
    drop();
    await until(() => speaks(fake).some((message) => message.final), "final speak");
    const id = speaks(fake)[0].id;
    expect(speaks(fake).map((message) => [message.text, message.final])).toEqual([
      ["Half a", false],
      ["", true]
    ]);
    // The reply stays open until its audio is done.
    expect(seen.some((item) => item.startsWith("done"))).toBe(false);
    fake.send({ type: "audio.start", id, sampleRate: 24000 });
    fake.socket().send(Buffer.from([5, 5]));
    fake.send({ type: "audio.done", id, cancelled: false });
    await until(() => seen.includes("done:false"));
    expect(audio).toEqual([Buffer.from([5, 5])]);
    // Late audio after the reply ended is dropped.
    fake.socket().send(Buffer.from([6, 6]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(audio).toEqual([Buffer.from([5, 5])]);
    engine.close();
  });

  it("includes the server's last error when it closes with 1011 before ready", async () => {
    const fake = await fakeServer((_message, server) => {
      server.send({ type: "error", code: "load_failed", message: "no such model" });
      server.socket().close(1011, "internal");
    }, "none");
    const { engine, events } = setup(fake);
    await expect(engine.connect(config, events)).rejects.toThrow(
      "Max Speech could not start its models: load_failed: no such model"
    );
  });

  it("explains a 1008 close as a refused connection", async () => {
    const fake = await fakeServer((_message, server) => server.socket().close(1008, "unauthorized"), "none");
    const { engine, events } = setup(fake);
    await expect(engine.connect(config, events)).rejects.toThrow(
      /refused the connection at ws:.*\(check MAX_SPEECH_API_KEY \/ origin\)/
    );
  });

  it("surfaces an invalid url as a rejected connect", async () => {
    const prior = process.env.MAX_SPEECH_URL;
    process.env.MAX_SPEECH_URL = "not a url";
    try {
      const engine = createMaxSpeechEngine(log, undefined, () => ({ baseUrl: "", apiKey: "", model: "" }));
      await expect(engine.connect(config, {} as EngineEvents)).rejects.toThrow(/not a valid URL/);
    } finally {
      if (prior === undefined) delete process.env.MAX_SPEECH_URL;
      else process.env.MAX_SPEECH_URL = prior;
    }
  });

  it("ends the server's turn when the device stops sending audio", async () => {
    const fake = await fakeServer();
    const { engine, events } = setup(fake);
    await engine.connect(config, events);
    engine.endInput?.();
    await until(() => fake.received.some((message) => message?.type === "turn.end"), "turn.end");
    engine.close();
  });
});
