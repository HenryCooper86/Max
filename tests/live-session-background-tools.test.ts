/* eslint-disable @typescript-eslint/no-explicit-any -- relay events are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_CAPABILITIES } from "../shared/agent";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { createLogger } from "../server/logger";
import type { EngineConfig, EngineEvents, VoiceEngine } from "../server/providers/live/engine";
import { createLiveProvider } from "../server/providers/live/session";
import type { ToolDefinition } from "../server/tools";

// Tools marked `background: true`: the assistant starts them, keeps talking,
// and reports the result when it comes.

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

/** A background tool whose work finishes when the test says so. */
function slowTool(name = "make_report") {
  const finish: Array<(value: unknown) => void> = [];
  const fail: Array<(error: Error) => void> = [];
  const signals: AbortSignal[] = [];
  const tool: ToolDefinition = {
    name,
    description: "Makes a long report",
    parameters: { type: "object", properties: { topic: { type: "string" } } },
    background: true,
    timeoutMs: 60_000,
    handler: (_args, context) =>
      new Promise((resolve, reject) => {
        finish.push(resolve);
        fail.push(reject);
        signals.push(context.signal);
      })
  };
  return { tool, finish, fail, signals };
}

async function setup(
  serverTools: ToolDefinition[],
  engineExtra: Partial<VoiceEngine> = {},
  pageTools: Array<{ name: string; description: string; background?: boolean }> = []
) {
  const client = new FakeClient();
  let events!: EngineEvents;
  const toolResults: Array<[string, any]> = [];
  const texts: string[] = [];
  const contexts: string[] = [];
  const engine: VoiceEngine = {
    responseMode: "manual-capable",
    async connect(_config: EngineConfig, engineEvents) {
      events = engineEvents;
    },
    sendAudio() {},
    respond() {},
    cancel() {},
    close() {},
    sendToolResult: (callId, output) => toolResults.push([callId, JSON.parse(output)]),
    sendText: (text) => texts.push(text),
    addContext: (text) => contexts.push(text),
    ...engineExtra
  };
  const provider = createLiveProvider(
    client as never,
    { id: "openai", label: "Test", capabilities: LIVE_CAPABILITIES, createEngine: () => engine },
    createLogger("test"),
    { serverEvent: vi.fn(), serverAudio: vi.fn(), ttsFallback: vi.fn() },
    { wakeWord: false, fetchWeather: async () => Promise.reject(new Error("offline")), serverTools: () => serverTools }
  );
  await provider.start(
    { type: "session.start", sampleRate: 16000, channels: 1, language: "en", tools: pageTools },
    { sessionId: "sess-1", userId: "u-1" }
  );
  await provider.startAudio();
  /** A spoken turn and the start of the assistant's reply to it. */
  const openReply = (said = "make me the report") => {
    events.onSpeechStarted();
    events.onRiderTranscript(said, true);
    events.onResponseStarted();
  };
  /** The assistant says something and finishes. */
  const finishReply = (text = "On it.") => {
    events.onAgentText(text);
    events.onAgentAudio(Buffer.alloc(96));
    events.onResponseDone({ cancelled: false });
  };
  const statuses = () => client.ofType("status").map((event) => event.state as string);
  return { client, provider, events: () => events, toolResults, texts, contexts, openReply, finishReply, statuses };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("background tools", () => {
  it("tells the model at once that the work has started, and reports the result when it is done", async () => {
    const report = slowTool();
    const { client, provider, events, toolResults, texts, openReply, finishReply } = await setup([report.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: '{"topic":"sales"}' });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    // The model's call is answered straight away, while the work goes on.
    expect(toolResults[0]).toEqual(["c1", expect.objectContaining({ status: "started" })]);
    expect(report.finish).toHaveLength(1);
    expect(client.ofType("tool.activity").map((event) => event.state)).toEqual(["started"]);
    // The assistant says so and the turn ends. Nothing is reported yet.
    finishReply("I have started the report.");
    await flush();
    expect(texts).toEqual([]);

    report.finish[0]!({ pages: 12, url: "https://example.com/r/1" });
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain('"make_report"');
    expect(texts[0]).toContain('{"pages":12,"url":"https://example.com/r/1"}');
    expect(texts[0]).toContain("The user did not say this");
    expect(client.ofType("tool.activity").map((event) => event.state)).toEqual(["started", "succeeded"]);
    // The note is for the model: the user sees no caption for it.
    expect(client.ofType("transcript").filter((event) => event.speaker === "rider")).toHaveLength(1);
    // The reply that reports it is heard like any other.
    events().onResponseStarted();
    finishReply("Your report is ready: twelve pages.");
    expect(client.ofType("transcript").at(-1)).toMatchObject({ speaker: "agent", final: true });
    expect(client.ofType("transcript").at(-1)!.text).toContain("twelve pages");
    await provider.close();
  });

  it("does the same for a tool the page runs, when the page marks it so", async () => {
    const { client, provider, events, toolResults, texts, openReply, finishReply } = await setup([], {}, [
      { name: "export_page", description: "Exports the page as a PDF", background: true },
      { name: "scroll", description: "Scrolls the page" }
    ]);
    openReply("export this page");
    events().onToolCall!({ callId: "c1", name: "export_page", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    // The model is answered at once; the page has the call and is working on it.
    expect(toolResults[0]).toEqual(["c1", expect.objectContaining({ status: "started" })]);
    expect(client.ofType("tool.call")).toEqual([expect.objectContaining({ callId: "c1", name: "export_page" })]);
    finishReply("I have started the export.");
    await flush();
    expect(texts).toEqual([]);

    await provider.toolResult!({ type: "tool.result", callId: "c1", output: { file: "page.pdf" } });
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain('"export_page"');
    expect(texts[0]).toContain('{"file":"page.pdf"}');

    // A page tool without the mark is waited for, as before.
    events().onResponseStarted();
    events().onToolCall!({ callId: "c2", name: "scroll", arguments: "{}" });
    await flush();
    expect(toolResults).toHaveLength(1);
    await provider.toolResult!({ type: "tool.result", callId: "c2", output: { done: true } });
    await vi.waitFor(() => expect(toolResults).toHaveLength(2));
    expect(toolResults[1]).toEqual(["c2", { done: true }]);
    await provider.close();
  });

  it("waits for a quiet moment: not over the user, and not in the middle of a reply", async () => {
    vi.useFakeTimers();
    const report = slowTool();
    const { provider, events, texts, openReply, finishReply } = await setup([report.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(1);
    finishReply();

    // The user asks something else, and the assistant is answering it when the work finishes.
    openReply("what time is it");
    report.finish[0]!("done");
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts).toEqual([]);
    finishReply("It is noon.");
    // Then the user starts to speak again.
    events().onSpeechStarted();
    events().onRiderTranscript("and tomorr", false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts).toEqual([]);
    events().onRiderTranscript("and tomorrow?", true);
    events().onResponseStarted();
    finishReply("Tomorrow too.");
    // Now it is quiet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Its result: done");
    await provider.close();
  });

  it("keeps the work going when the user moves on, unlike an ordinary tool", async () => {
    const report = slowTool();
    const { provider, events, toolResults, texts, openReply, finishReply } = await setup([report.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    finishReply();
    openReply("never mind, tell me a joke");
    finishReply("Why did the chicken cross the road?");
    expect(report.signals[0]!.aborted).toBe(false);
    report.finish[0]!({ ok: true });
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    await provider.close();
  });

  it("reports a failure too, without the handler's detail reaching the page", async () => {
    const report = slowTool();
    const { client, provider, events, toolResults, texts, openReply, finishReply } = await setup([report.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    finishReply();
    report.fail[0]!(new Error("the printer at 10.0.0.7 is on fire"));
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain("did not succeed");
    expect(texts[0]).toContain("on fire");
    expect(client.ofType("tool.activity").at(-1)).toMatchObject({ state: "failed", error: "failed" });
    await provider.close();
  });

  it("reports several results in one go", async () => {
    const report = slowTool("make_report");
    const booking = slowTool("book_room");
    const { provider, events, toolResults, texts, openReply, finishReply } = await setup([report.tool, booking.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    events().onToolCall!({ callId: "c2", name: "book_room", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(2));
    // Both finish while the assistant is still talking.
    report.finish[0]!("report done");
    booking.finish[0]!("room 4");
    await flush();
    expect(texts).toEqual([]);
    finishReply();
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain("report done");
    expect(texts[0]).toContain("room 4");
    await provider.close();
  });

  it("refuses a fifth while four are running, and takes one again when a place is free", async () => {
    const report = slowTool();
    const { provider, events, toolResults, openReply, finishReply } = await setup([report.tool]);
    openReply();
    for (let i = 1; i <= 5; i += 1) events().onToolCall!({ callId: `c${i}`, name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(5));
    expect(toolResults.slice(0, 4).every(([, output]) => output.status === "started")).toBe(true);
    expect(toolResults[4]![1].error).toContain("too many background tasks");
    expect(report.finish).toHaveLength(4);
    finishReply();
    report.finish[0]!("one done");
    await flush();
    openReply("another one please");
    events().onToolCall!({ callId: "c6", name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(6));
    expect(toolResults[5]![1].status).toBe("started");
    await provider.close();
  });

  it("does not ask whether the user is still there while they wait for a result", async () => {
    vi.useFakeTimers();
    setAssistantProfileForTests(
      assistantProfileFrom({
        name: "Ava",
        device: "app",
        conversation: { idleReminderSeconds: 5, maxIdleReminders: 2, idleReminders: ["Still with me?"] }
      })
    );
    const report = slowTool();
    const said: string[] = [];
    const { provider, events, texts, openReply, finishReply } = await setup([report.tool], {
      say: (line) => said.push(line)
    });
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(1);
    finishReply();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(said).toEqual([]);
    report.finish[0]!("done");
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts).toHaveLength(1);
    // After the report the silence clock runs again.
    events().onResponseStarted();
    finishReply("Your report is done.");
    await vi.advanceTimersByTimeAsync(6000);
    expect(said).toEqual(["Still with me?"]);
    await provider.close();
  });

  it("lets a backend that answers tools in a new reply say its piece first, but does not wait for ever", async () => {
    vi.useFakeTimers();
    const report = slowTool();
    const { provider, events, texts, openReply, finishReply } = await setup([report.tool], {
      answersToolsInNewReply: true
    });
    // The reply that asked for the tool ends, and the work finishes before the
    // backend has started the reply to "started".
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(1);
    events().onResponseDone({ cancelled: false });
    report.finish[0]!("done");
    await vi.advanceTimersByTimeAsync(2000);
    expect(texts).toEqual([]);
    events().onResponseStarted();
    finishReply("I have started it.");
    await vi.advanceTimersByTimeAsync(1000);
    expect(texts).toHaveLength(1);

    // Next time that reply never comes. The result is reported all the same.
    events().onResponseStarted();
    finishReply("Here is your report.");
    openReply("another");
    events().onToolCall!({ callId: "c2", name: "make_report", arguments: "{}" });
    await vi.advanceTimersByTimeAsync(1);
    events().onResponseDone({ cancelled: false });
    report.finish[1]!("done again");
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("done again");
    await provider.close();
  });

  it("stops the work and reports nothing once the session has closed", async () => {
    const report = slowTool();
    const { provider, events, toolResults, texts, openReply, finishReply } = await setup([report.tool]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    finishReply();
    await provider.close();
    expect(report.signals[0]!.aborted).toBe(true);
    report.finish[0]!("too late");
    await flush();
    await flush();
    expect(texts).toEqual([]);
  });

  it("gives the result as context when the backend cannot be made to speak up", async () => {
    const report = slowTool();
    const { provider, events, toolResults, texts, contexts, openReply, finishReply } = await setup([report.tool], {
      sendText: undefined
    });
    openReply();
    events().onToolCall!({ callId: "c1", name: "make_report", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    finishReply();
    report.finish[0]!("done");
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]).toContain("Its result: done");
    expect(texts).toEqual([]);
    await provider.close();
  });

  it("leaves an ordinary tool as it was: the model waits for its result", async () => {
    const plain: ToolDefinition = { name: "lookup", description: "Looks up", handler: () => ({ found: 1 }) };
    const { provider, events, toolResults, texts, openReply, finishReply } = await setup([plain]);
    openReply();
    events().onToolCall!({ callId: "c1", name: "lookup", arguments: "{}" });
    await vi.waitFor(() => expect(toolResults).toEqual([["c1", { found: 1 }]]));
    finishReply();
    await flush();
    expect(texts).toEqual([]);
    await provider.close();
  });
});
