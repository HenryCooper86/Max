/* eslint-disable @typescript-eslint/no-explicit-any -- upstream wire payloads are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, EngineToolCall } from "../server/providers/live/engine";
import { createGeminiLiveEngine, geminiSchema } from "../server/providers/live/gemini-live";
import {
  createRealtimeEngine,
  grokDialect,
  localRealtimeDialect,
  openAiDialect,
  realtimeTools
} from "../server/providers/live/openai-realtime";
import { createPipelineEngine, type PipelineSettings } from "../server/providers/live/pipeline";
import type { ToolSpec } from "../server/tools";

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
    this.emit("close", 1000, Buffer.alloc(0));
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

const TOOL: ToolSpec = {
  name: "get_order",
  description: "Look up an order",
  parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }
};

const CONFIG: EngineConfig = {
  instructions: "You are Max.",
  voiceGender: "female",
  manualResponse: false,
  languages: ["en"],
  keyterms: [],
  tools: [TOOL]
};

function recorder() {
  const calls: EngineToolCall[] = [];
  const log: Array<[string, ...unknown[]]> = [];
  const events: EngineEvents = {
    onSpeechStarted: () => log.push(["speech"]),
    onRiderTranscript: (text, final) => log.push(["rider", text, final]),
    onResponseStarted: () => log.push(["response"]),
    onAgentText: (delta) => log.push(["text", delta]),
    onAgentAudio: (pcm) => log.push(["audio", pcm.length]),
    onResponseDone: (info) => log.push(["done", info.cancelled]),
    onError: (message) => log.push(["error", message]),
    onClosed: (reason) => log.push(["closed", reason]),
    onToolCall: (call) => calls.push(call)
  };
  return { calls, log, events };
}

const ENV_KEYS = ["OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "LOCAL_REALTIME_API_KEY", "GEMINI_API_KEY"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
const log = createLogger("test");

describe("realtime tools in session.update", () => {
  const dialects = [
    ["openai", openAiDialect],
    ["grok", grokDialect],
    ["local", localRealtimeDialect]
  ] as const;

  it.each(dialects)("%s offers function tools when configured and none when empty", async (_name, dialect) => {
    process.env.OPENAI_API_KEY = "k";
    process.env.XAI_API_KEY = "k";
    for (const tools of [[TOOL], []]) {
      const socket = new FakeSocket();
      const engine = createRealtimeEngine(dialect(), log, () => socket as never);
      const ready = engine.connect({ ...CONFIG, tools }, recorder().events);
      socket.emit("open");
      const session = socket.ofType("session.update")[0]!.session;
      if (tools.length) {
        expect(session.tools).toEqual([
          { type: "function", name: "get_order", description: "Look up an order", parameters: TOOL.parameters }
        ]);
        expect(session.tool_choice).toBe("auto");
      } else {
        expect(session).not.toHaveProperty("tools");
        expect(session).not.toHaveProperty("tool_choice");
      }
      socket.receive({ type: "session.updated" });
      await ready;
    }
  });

  it("realtimeTools is empty without tools", () => {
    expect(realtimeTools({ ...CONFIG, tools: [] })).toEqual({});
  });
});

describe("realtime function call flow", () => {
  async function connect(tools: ToolSpec[] = [TOOL]) {
    process.env.OPENAI_API_KEY = "k";
    const socket = new FakeSocket();
    const rec = recorder();
    const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never);
    const ready = engine.connect({ ...CONFIG, tools }, rec.events);
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await ready;
    return { engine, socket, ...rec };
  }
  const call = (id: string, name = "get_order", args = '{"orderId":"A1"}') => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: args
  });
  const outputs = (socket: FakeSocket) =>
    socket.ofType("conversation.item.create").filter((event) => event.item.type === "function_call_output");

  it("announces a call once even when repeated by every upstream event", async () => {
    const { socket, calls } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    socket.receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "get_order",
      arguments: "{}"
    });
    socket.receive({ type: "response.done", response: { status: "completed", output: [call("c1")] } });
    expect(calls).toEqual([{ callId: "c1", name: "get_order", arguments: '{"orderId":"A1"}' }]);
  });

  it("picks up calls listed only in response.done", async () => {
    const { socket, calls } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.done", response: { output: [{ type: "message" }, call("c9")] } });
    expect(calls.map((item) => item.callId)).toEqual(["c9"]);
  });

  it("ignores calls without id or name and non-function items", async () => {
    const { socket, calls } = await connect();
    socket.receive({ type: "response.output_item.done", item: { type: "function_call", name: "x" } });
    socket.receive({ type: "response.output_item.done", item: { type: "function_call", call_id: "z" } });
    socket.receive({ type: "response.output_item.done", item: { type: "message", call_id: "q", name: "n" } });
    expect(calls).toEqual([]);
  });

  it("result after response.done: output item, then exactly one response.create", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(0);
    engine.sendToolResult?.("c1", '{"status":"shipped"}');
    expect(outputs(socket)).toEqual([
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "c1", output: '{"status":"shipped"}' }
      }
    ]);
    expect(socket.ofType("response.create")).toHaveLength(1);
    // A repeated result for the same call changes nothing about the continuation.
    engine.sendToolResult?.("c1", "again");
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("result before response.done: the continuation waits for the reply to end", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    engine.sendToolResult?.("c1", "ok");
    expect(outputs(socket)).toHaveLength(1);
    expect(socket.ofType("response.create")).toHaveLength(0);
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("with two calls, continues only once both have results", async () => {
    const { engine, socket, calls } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    socket.receive({ type: "response.output_item.done", item: call("c2") });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(calls).toHaveLength(2);
    engine.sendToolResult?.("c1", "a");
    expect(socket.ofType("response.create")).toHaveLength(0);
    engine.sendToolResult?.("c2", "b");
    expect(outputs(socket)).toHaveLength(2);
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("with two calls and the first result before response.done", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    socket.receive({ type: "response.output_item.done", item: call("c2") });
    engine.sendToolResult?.("c1", "a");
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(0);
    engine.sendToolResult?.("c2", "b");
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("ignores results for unknown calls", async () => {
    const { engine, socket } = await connect();
    engine.sendToolResult?.("nope", "x");
    expect(socket.sent.filter((event) => event.type !== "session.update")).toEqual([]);
  });

  it("cancel() during pending tools prevents the continuation", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    engine.cancel();
    expect(socket.ofType("response.cancel")).toHaveLength(1);
    socket.receive({ type: "response.done", response: { status: "cancelled" } });
    engine.sendToolResult?.("c1", "late");
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(0);
  });

  it("answers with an error when the session did not register a tool handler", async () => {
    process.env.OPENAI_API_KEY = "k";
    const socket = new FakeSocket();
    const { events } = recorder();
    const engine = createRealtimeEngine(openAiDialect(), log, () => socket as never);
    const ready = engine.connect({ ...CONFIG }, { ...events, onToolCall: undefined });
    socket.emit("open");
    socket.receive({ type: "session.updated" });
    await ready;
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.output_item.done", item: call("c1") });
    expect(JSON.parse(outputs(socket)[0]!.item.output)).toEqual({ error: "tools are not available" });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("sendText sends a user input_text item and response.create", async () => {
    const { engine, socket } = await connect();
    engine.sendText?.("hello there");
    expect(socket.ofType("conversation.item.create")[0]).toEqual({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello there" }] }
    });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });

  it("sendText during an active response waits for response.done", async () => {
    const { engine, socket } = await connect();
    socket.receive({ type: "response.created" });
    engine.sendText?.("hi");
    expect(socket.ofType("conversation.item.create")).toHaveLength(1);
    expect(socket.ofType("response.create")).toHaveLength(0);
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
    socket.receive({ type: "response.created" });
    socket.receive({ type: "response.done", response: { status: "completed" } });
    expect(socket.ofType("response.create")).toHaveLength(1);
  });
});

describe("geminiSchema", () => {
  it("drops unsupported keywords at every depth but keeps property names", () => {
    expect(
      geminiSchema({
        $schema: "x",
        type: "object",
        additionalProperties: false,
        properties: {
          default: { type: "string", default: "a", const: "b" },
          nested: {
            type: "object",
            additionalProperties: true,
            properties: { n: { type: "number", examples: [1] } },
            required: ["n"]
          },
          list: {
            type: "array",
            items: { type: "object", additionalProperties: false, properties: { id: { type: "string" } } }
          }
        },
        required: ["default"]
      })
    ).toEqual({
      type: "object",
      properties: {
        default: { type: "string" },
        nested: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        list: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } }
      },
      required: ["default"]
    });
  });
});

describe("Gemini Live tools", () => {
  async function connect(tools: ToolSpec[] = [TOOL]) {
    process.env.GEMINI_API_KEY = "k";
    const socket = new FakeSocket();
    const rec = recorder();
    const engine = createGeminiLiveEngine(log, () => socket as never);
    const ready = engine.connect({ ...CONFIG, tools }, rec.events);
    socket.emit("open");
    socket.receive({ setupComplete: {} });
    await ready;
    return { engine, socket, ...rec };
  }

  it("declares sanitised function declarations in setup, or none", async () => {
    const dirty: ToolSpec = {
      name: "t",
      description: "d",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          default: { type: "string" },
          o: { type: "object", additionalProperties: false, properties: { a: { type: "string" } } }
        }
      }
    };
    const { socket } = await connect([dirty]);
    expect(socket.sent[0]!.setup.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "t",
            description: "d",
            parameters: {
              type: "object",
              properties: { default: { type: "string" }, o: { type: "object", properties: { a: { type: "string" } } } }
            }
          }
        ]
      }
    ]);
    const empty = await connect([]);
    expect(empty.socket.sent[0]!.setup).not.toHaveProperty("tools");
  });

  it("reports toolCall with parsed args and skips malformed entries", async () => {
    const { socket, calls } = await connect();
    socket.receive({
      toolCall: {
        functionCalls: [
          { id: "g1", name: "get_order", args: { orderId: "A1" } },
          { name: "noid" },
          { id: "noname" },
          { id: "g2", name: "x" }
        ]
      }
    });
    expect(calls).toEqual([
      { callId: "g1", name: "get_order", arguments: { orderId: "A1" } },
      { callId: "g2", name: "x", arguments: {} }
    ]);
  });

  it("sendToolResult wraps non-object outputs and passes objects through", async () => {
    const { engine, socket } = await connect();
    socket.receive({
      toolCall: {
        functionCalls: [
          { id: "a", name: "t1" },
          { id: "b", name: "t2" },
          { id: "c", name: "t3" },
          { id: "d", name: "t4" }
        ]
      }
    });
    engine.sendToolResult?.("a", '{"status":"ok"}');
    engine.sendToolResult?.("b", "42");
    engine.sendToolResult?.("c", "plain words");
    engine.sendToolResult?.("d", "[1,2]");
    const responses = socket.sent
      .filter((message) => message.toolResponse)
      .map((message) => message.toolResponse.functionResponses[0]);
    expect(responses).toEqual([
      { id: "a", name: "t1", response: { status: "ok" } },
      { id: "b", name: "t2", response: { result: 42 } },
      { id: "c", name: "t3", response: { result: "plain words" } },
      { id: "d", name: "t4", response: { result: [1, 2] } }
    ]);
  });

  it("ignores unknown, repeated and cancelled calls", async () => {
    const { engine, socket } = await connect();
    socket.receive({
      toolCall: {
        functionCalls: [
          { id: "a", name: "t" },
          { id: "b", name: "t" }
        ]
      }
    });
    socket.receive({ toolCallCancellation: { ids: ["b"] } });
    engine.sendToolResult?.("nope", "x");
    engine.sendToolResult?.("b", "x");
    engine.sendToolResult?.("a", "x");
    engine.sendToolResult?.("a", "x");
    expect(socket.sent.filter((message) => message.toolResponse)).toHaveLength(1);
  });

  it("sendText sends realtimeInput.text", async () => {
    const { engine, socket } = await connect();
    engine.sendText?.("hello");
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { text: "hello" } });
  });
});

describe("Pipeline engine tools", () => {
  const settings: PipelineSettings = {
    stt: { baseUrl: "http://localhost:9000/v1", apiKey: "", model: "w" },
    llm: { baseUrl: "https://llm.example/v1", apiKey: "k", model: "chat" },
    tts: { baseUrl: "https://tts.example/v1", apiKey: "k", model: "tts", voice: () => "nova", sampleRate: 24_000 }
  };
  const sseOf = (chunks: unknown[]) =>
    new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200
    });
  const textChunk = (content: string) => ({ choices: [{ delta: { content } }] });
  const toolChunk = (piece: Record<string, unknown>) => ({ choices: [{ delta: { tool_calls: [piece] } }] });

  function harness(chatReplies: Array<() => Response>) {
    const chats: any[] = [];
    const speech: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        chats.push(JSON.parse(init!.body as string));
        return chatReplies[chats.length - 1]!();
      }
      speech.push((JSON.parse(init!.body as string) as { input: string }).input);
      return new Response(Buffer.alloc(480), { status: 200 });
    });
    return { chats, speech, request };
  }

  it("offers tools, assembles streamed arguments, and continues after the result", async () => {
    const { chats, speech, request } = harness([
      () =>
        sseOf([
          toolChunk({ index: 0, id: "call_1", type: "function", function: { name: "get_order", arguments: "" } }),
          toolChunk({ index: 0, function: { arguments: '{"orderId":' } }),
          toolChunk({ index: 0, function: { arguments: '"A1"}' } })
        ]),
      () => sseOf([textChunk("It has shipped.")])
    ]);
    const rec = recorder();
    const engine = createPipelineEngine(log, settings, request as never, {});
    await engine.connect(CONFIG, rec.events);
    engine.sendText?.("where is my order");
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    expect(rec.calls[0]).toEqual({ callId: "call_1", name: "get_order", arguments: '{"orderId":"A1"}' });
    expect(chats[0].tools).toEqual([
      {
        type: "function",
        function: { name: "get_order", description: "Look up an order", parameters: TOOL.parameters }
      }
    ]);
    expect(chats[0].messages.at(-1)).toEqual({ role: "user", content: "where is my order" });
    expect(chats).toHaveLength(1);

    engine.sendToolResult?.("call_1", '{"status":"shipped"}');
    await vi.waitFor(() => expect(rec.log.at(-1)).toEqual(["done", false]));
    expect(chats).toHaveLength(2);
    const messages = chats[1].messages;
    expect(messages.slice(-3)).toEqual([
      { role: "user", content: "where is my order" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_order", arguments: '{"orderId":"A1"}' } }]
      },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"shipped"}' }
    ]);
    expect(speech).toEqual(["It has shipped."]);
    expect(rec.log).toContainEqual(["audio", 480]);
  });

  it("omits tools from the chat request when none are configured", async () => {
    const { chats, request } = harness([() => sseOf([textChunk("Hello!")])]);
    const rec = recorder();
    const engine = createPipelineEngine(log, settings, request as never, {});
    await engine.connect({ ...CONFIG, tools: [] }, rec.events);
    engine.sendText?.("hi");
    await vi.waitFor(() => expect(rec.log.at(-1)).toEqual(["done", false]));
    expect(chats[0]).not.toHaveProperty("tools");
    expect(chats[0].messages.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("keeps tool chatter out of history", async () => {
    const { chats, request } = harness([
      () => sseOf([toolChunk({ index: 0, id: "c", function: { name: "get_order", arguments: "{}" } })]),
      () => sseOf([textChunk("Done.")]),
      () => sseOf([textChunk("Sure.")])
    ]);
    const rec = recorder();
    const engine = createPipelineEngine(log, settings, request as never, {});
    await engine.connect(CONFIG, rec.events);
    engine.sendText?.("one");
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    engine.sendToolResult?.("c", "r");
    await vi.waitFor(() => expect(rec.log.filter(([kind]) => kind === "done")).toHaveLength(1));
    engine.sendText?.("two");
    await vi.waitFor(() => expect(rec.log.filter(([kind]) => kind === "done")).toHaveLength(2));
    expect(chats[2].messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("stops offering tools after four rounds so the model must answer", async () => {
    const callReply = (id: string) => () =>
      sseOf([toolChunk({ index: 0, id, function: { name: "get_order", arguments: "{}" } })]);
    const { chats, request } = harness([
      callReply("r0"),
      callReply("r1"),
      callReply("r2"),
      callReply("r3"),
      () => sseOf([textChunk("Enough.")])
    ]);
    const rec = recorder();
    const engine = createPipelineEngine(log, settings, request as never, {});
    await engine.connect(CONFIG, rec.events);
    engine.sendText?.("loop");
    for (const id of ["r0", "r1", "r2", "r3"]) {
      await vi.waitFor(() => expect(rec.calls.map((call) => call.callId)).toContain(id));
      engine.sendToolResult?.(id, "x");
    }
    await vi.waitFor(() => expect(rec.log.at(-1)).toEqual(["done", false]));
    expect(chats).toHaveLength(5);
    expect(chats[3]).toHaveProperty("tools");
    expect(chats[4]).not.toHaveProperty("tools");
  });

  it("cancel() while waiting for a tool ends the reply without another request", async () => {
    const { chats, request } = harness([
      () => sseOf([toolChunk({ index: 0, id: "c", function: { name: "get_order", arguments: "{}" } })])
    ]);
    const rec = recorder();
    const engine = createPipelineEngine(log, settings, request as never, {});
    await engine.connect(CONFIG, rec.events);
    engine.sendText?.("x");
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
    engine.cancel();
    engine.sendToolResult?.("c", "late");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chats).toHaveLength(1);
    expect(rec.log.at(-1)).toEqual(["done", true]);
  });
});
