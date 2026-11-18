/* eslint-disable @typescript-eslint/no-explicit-any -- relay events are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { setAssistantProfileForTests } from "../server/assistant";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, VoiceEngine } from "../server/providers/live/engine";
import { createLiveProvider } from "../server/providers/live/session";
import type { ToolDefinition } from "../server/tools";

afterEach(() => {
  setAssistantProfileForTests();
  vi.useRealTimers();
});

class FakeClient {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  json: Array<Record<string, any>> = [];
  send(data: string | Buffer) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, any>);
  }
  close() {
    this.readyState = 3;
  }
  ofType(type: string) {
    return this.json.filter((event) => event.type === type);
  }
}

const SERVER_TOOL: ToolDefinition = {
  name: "server_lookup",
  description: "Looks things up",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  handler: (args) => ({ found: args.q })
};

async function setup(
  options: { engine?: Partial<VoiceEngine>; serverTools?: ToolDefinition[]; toolTimeoutMs?: number } = {}
) {
  const client = new FakeClient();
  let config: EngineConfig | undefined;
  let events!: EngineEvents;
  const toolResults: Array<[string, string]> = [];
  const texts: string[] = [];
  const engine: VoiceEngine = {
    responseMode: "manual-capable",
    async connect(engineConfig, engineEvents) {
      config = engineConfig;
      events = engineEvents;
    },
    sendAudio() {},
    respond() {},
    cancel() {},
    close() {},
    sendToolResult: (callId, output) => toolResults.push([callId, output]),
    sendText: (text) => texts.push(text),
    ...options.engine
  };
  const provider = createLiveProvider(
    client as never,
    { id: "openai", label: "Test", capabilities: LIVE_CAPABILITIES, createEngine: () => engine },
    createLogger("test"),
    { serverEvent: vi.fn(), serverAudio: vi.fn(), ttsFallback: vi.fn() },
    {
      wakeWord: false,
      fetchWeather: async () => Promise.reject(new Error("offline")),
      serverTools: () => options.serverTools ?? [SERVER_TOOL],
      toolTimeoutMs: options.toolTimeoutMs
    }
  );
  await provider.start(
    {
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      language: "en",
      tools: [{ name: "client_nav", description: "Navigates the page", parameters: { type: "object", properties: {} } }]
    },
    { sessionId: "sess-1", userId: "u-1" }
  );
  await provider.startAudio();
  /** Opens a reply the way a spoken turn does. */
  const openReply = () => {
    events.onSpeechStarted();
    events.onRiderTranscript("look it up", true);
    events.onResponseStarted();
  };
  return { client, provider, engine, events, config: () => config!, toolResults, texts, openReply };
}

describe("live session tools", () => {
  it("gives the engine server and client tools", async () => {
    const { config } = await setup();
    expect(config().tools.map((tool) => tool.name)).toEqual(["server_lookup", "client_nav"]);
    expect(config().tools[1]!.parameters).toEqual({ type: "object", properties: {} });
  });

  it("runs a server tool during an open reply and hands the output to the engine", async () => {
    const { client, events, toolResults, openReply, provider } = await setup();
    openReply();
    events.onToolCall!({ callId: "c1", name: "server_lookup", arguments: '{"q":"cat"}' });
    await vi.waitFor(() => expect(toolResults).toEqual([["c1", '{"found":"cat"}']]));
    expect(client.ofType("tool.activity").map((event) => [event.state, event.where, event.name])).toEqual([
      ["started", "server", "server_lookup"],
      ["succeeded", "server", "server_lookup"]
    ]);
    expect(client.ofType("tool.call")).toHaveLength(0);
    await provider.close();
  });

  it("reports a failing server tool to the model and the client", async () => {
    const failing: ToolDefinition = {
      ...SERVER_TOOL,
      handler: () => {
        throw new Error("backend down");
      }
    };
    const { client, events, toolResults, openReply, provider } = await setup({ serverTools: [failing] });
    openReply();
    events.onToolCall!({ callId: "c1", name: "server_lookup", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    expect(JSON.parse(toolResults[0]![1])).toEqual({ error: "backend down" });
    expect(client.ofType("tool.activity").at(-1)).toMatchObject({ state: "failed", error: "failed" }); // server detail stays off the client
    await provider.close();
  });

  it("round-trips a client tool through tool.call and tool.result", async () => {
    const { client, events, toolResults, openReply, provider } = await setup();
    openReply();
    events.onToolCall!({ callId: "c2", name: "client_nav", arguments: { page: "pricing" } });
    await vi.waitFor(() => expect(client.ofType("tool.call")).toHaveLength(1));
    expect(client.ofType("tool.call")[0]).toEqual({
      type: "tool.call",
      callId: "c2",
      name: "client_nav",
      arguments: { page: "pricing" }
    });
    expect(toolResults).toEqual([]);
    await provider.toolResult!({ type: "tool.result", callId: "c2", output: { ok: true } });
    await vi.waitFor(() => expect(toolResults).toEqual([["c2", '{"ok":true}']]));
    expect(client.ofType("tool.activity").map((event) => [event.where, event.state])).toEqual([
      ["client", "started"],
      ["client", "succeeded"]
    ]);
    await provider.close();
  });

  it("times out a client tool that never answers", async () => {
    const { client, events, toolResults, openReply, provider } = await setup({ toolTimeoutMs: 20 });
    openReply();
    events.onToolCall!({ callId: "c3", name: "client_nav", arguments: {} });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    expect(JSON.parse(toolResults[0]![1]).error).toContain("did not answer");
    expect(client.ofType("tool.activity").at(-1)).toMatchObject({ state: "failed", where: "client" });
    await provider.close();
  });

  it("answers an unknown tool with an error result", async () => {
    const { events, toolResults, openReply, provider } = await setup();
    openReply();
    events.onToolCall!({ callId: "c4", name: "ghost", arguments: {} });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    expect(JSON.parse(toolResults[0]![1]).error).toContain("no tool called ghost");
    await provider.close();
  });

  it("does not run a tool for an interrupted reply", async () => {
    const handler = vi.fn(() => "x");
    const { events, toolResults, openReply, provider } = await setup({ serverTools: [{ ...SERVER_TOOL, handler }] });
    openReply();
    events.onAgentAudio(Buffer.alloc(960));
    events.onSpeechStarted();
    events.onToolCall!({ callId: "c5", name: "server_lookup", arguments: {} });
    expect(handler).not.toHaveBeenCalled();
    expect(toolResults).toEqual([["c5", '{"error":"cancelled"}']]);
    await provider.close();
  });

  it("ignores a tool result that arrives after the session closed", async () => {
    let finish!: (value: string) => void;
    const slow: ToolDefinition = {
      ...SERVER_TOOL,
      handler: () => new Promise<string>((resolve) => (finish = resolve))
    };
    const { events, toolResults, openReply, provider } = await setup({ serverTools: [slow] });
    openReply();
    events.onToolCall!({ callId: "c6", name: "server_lookup", arguments: {} });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await provider.close();
    finish("late");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(toolResults).toEqual([]);
  });
});

describe("live session typed input", () => {
  it("shows the text as a final rider transcript and sends it to the engine", async () => {
    const { client, provider, texts } = await setup();
    await provider.textInput!("hello");
    const rider = client.json.filter((event) => event.type === "transcript" && event.speaker === "rider").at(-1)!;
    expect(rider).toMatchObject({ text: "hello", final: true });
    expect(texts).toEqual(["hello"]);
    await provider.close();
  });

  it("reports an error when the engine cannot take text", async () => {
    const { client, provider } = await setup({ engine: { sendText: undefined } });
    await provider.textInput!("hello");
    expect(client.ofType("error")).toHaveLength(1);
    expect(client.ofType("error")[0]!.message).toContain("does not accept typed messages");
    expect(client.json.some((event) => event.type === "transcript" && event.speaker === "rider")).toBe(false);
    await provider.close();
  });

  it("sends nothing after close", async () => {
    const { client, provider, texts } = await setup();
    await provider.close();
    const before = client.json.length;
    await provider.textInput!("late");
    expect(texts).toEqual([]);
    expect(client.json).toHaveLength(before);
  });
});
