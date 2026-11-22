import { describe, expect, it, vi } from "vitest";
import type { ToolActivityEvent, ToolCallEvent } from "../shared/agent";
import type { Logger } from "../server/logger";
import { createToolBroker } from "../server/tools/broker";
import type { ToolDefinition, ToolSpec } from "../server/tools";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

function setup(
  options: {
    serverTools?: ToolDefinition[];
    clientTools?: ToolSpec[];
    clientTimeoutMs?: number;
    now?: () => number;
  } = {}
) {
  const sent: Array<ToolCallEvent | ToolActivityEvent> = [];
  const broker = createToolBroker({
    sessionId: "sess",
    serverTools: () => options.serverTools ?? [],
    clientTools: options.clientTools ?? [],
    send: (event) => sent.push(event),
    language: () => "en",
    userId: "user-1",
    log,
    clientTimeoutMs: options.clientTimeoutMs,
    now: options.now
  });
  return {
    broker,
    sent,
    activity: () => sent.filter((event): event is ToolActivityEvent => event.type === "tool.activity")
  };
}

const serverTool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "srv",
  description: "server tool",
  handler: () => "done",
  ...overrides
});
const clientSpec = (name = "cli"): ToolSpec => ({
  name,
  description: "client tool",
  parameters: { type: "object", properties: {} }
});

describe("background tools", () => {
  it("knows which tools the conversation does not wait for: server tools marked so, and no others", () => {
    const { broker } = setup({
      serverTools: [serverTool({ name: "slow", background: true }), serverTool({ name: "quick" })],
      clientTools: [clientSpec("cli")]
    });
    expect(broker.runsInBackground("slow")).toBe(true);
    expect(broker.runsInBackground("quick")).toBe(false);
    expect(broker.runsInBackground("cli")).toBe(false);
    expect(broker.runsInBackground("nothing")).toBe(false);
    // The mark is the relay's business: the model's view of the tool does not carry it.
    expect(Object.keys(broker.specs()[0]!).sort()).toEqual(["description", "name", "parameters"]);
  });
});

describe("specs", () => {
  it("merges server and client tools; server wins on a name clash", () => {
    const { broker } = setup({
      serverTools: [serverTool({ name: "same", description: "from server" }), serverTool({ name: "bare" })],
      clientTools: [{ ...clientSpec("same"), description: "from client" }, clientSpec("only_client")]
    });
    const specs = broker.specs();
    expect(specs.map((spec) => spec.name)).toEqual(["same", "bare", "only_client"]);
    expect(specs[0].description).toBe("from server");
    expect(specs[1].parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("server tools", () => {
  it("runs the handler with context and reports started/succeeded with duration", async () => {
    let clock = 1000;
    const handler = vi.fn(() => {
      clock += 42;
      return { ok: 1 };
    });
    const { broker, activity } = setup({ serverTools: [serverTool({ handler })], now: () => clock });
    const outcome = await broker.run({ callId: "c1", name: "srv", arguments: '{"a":1}' });
    expect(outcome).toEqual({ ok: true, output: '{"ok":1}' });
    const [args, context] = handler.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(args).toEqual({ a: 1 });
    expect(context).toMatchObject({ callId: "c1", sessionId: "sess", language: "en", userId: "user-1" });
    expect(activity()).toEqual([
      { type: "tool.activity", callId: "c1", name: "srv", where: "server", state: "started" },
      { type: "tool.activity", callId: "c1", name: "srv", where: "server", state: "succeeded", durationMs: 42 }
    ]);
  });

  it("supports async handlers and object arguments", async () => {
    const { broker } = setup({ serverTools: [serverTool({ handler: async (args) => `hi ${String(args.n)}` })] });
    expect(await broker.run({ callId: "c", name: "srv", arguments: { n: "bob" } })).toEqual({
      ok: true,
      output: "hi bob"
    });
  });

  it("turns a throw into a failed outcome and a failed activity", async () => {
    const { broker, activity } = setup({
      serverTools: [
        serverTool({
          handler: () => {
            throw new Error("db down");
          }
        })
      ]
    });
    const outcome = await broker.run({ callId: "c", name: "srv", arguments: "" });
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.output)).toEqual({ error: "db down" });
    expect(activity().at(-1)).toMatchObject({ state: "failed", error: "failed", durationMs: expect.any(Number) });
  });

  it("turns a rejected promise into a failure", async () => {
    const { broker } = setup({ serverTools: [serverTool({ handler: () => Promise.reject(new Error("nope")) })] });
    expect((await broker.run({ callId: "c", name: "srv", arguments: {} })).ok).toBe(false);
  });

  it("times out a slow handler and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const { broker, activity } = setup({
      serverTools: [
        serverTool({
          timeoutMs: 20,
          handler: (_args, context) => {
            signal = context.signal;
            return new Promise(() => undefined);
          }
        })
      ]
    });
    const outcome = await broker.run({ callId: "c", name: "srv", arguments: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("timed out");
    expect(signal?.aborted).toBe(true);
    expect(activity().at(-1)?.state).toBe("failed");
  });

  it("fails on bad arguments before running the handler", async () => {
    const handler = vi.fn();
    const { broker, activity } = setup({ serverTools: [serverTool({ handler })] });
    const outcome = await broker.run({ callId: "c", name: "srv", arguments: "{broken" });
    expect(outcome.ok).toBe(false);
    expect((await broker.run({ callId: "c2", name: "srv", arguments: "[1]" })).output).toContain("JSON object");
    expect(handler).not.toHaveBeenCalled();
    expect(activity().filter((event) => event.state === "failed")).toHaveLength(2);
  });

  it("reads the server tool list on every call", async () => {
    let tools: ToolDefinition[] = [];
    const broker = createToolBroker({
      sessionId: "s",
      serverTools: () => tools,
      clientTools: [],
      send: () => undefined,
      log
    });
    expect((await broker.run({ callId: "a", name: "srv", arguments: {} })).ok).toBe(false);
    tools = [serverTool()];
    expect((await broker.run({ callId: "b", name: "srv", arguments: {} })).ok).toBe(true);
  });
});

describe("client tools", () => {
  it("sends tool.call and resolves with the client's result", async () => {
    const { broker, sent, activity } = setup({ clientTools: [clientSpec()] });
    const pending = broker.run({ callId: "c1", name: "cli", arguments: '{"x":2}' });
    await Promise.resolve();
    expect(sent.find((event) => event.type === "tool.call")).toEqual({
      type: "tool.call",
      callId: "c1",
      name: "cli",
      arguments: { x: 2 }
    });
    broker.clientResult({ type: "tool.result", callId: "c1", output: { page: "pricing" } });
    expect(await pending).toEqual({ ok: true, output: '{"page":"pricing"}' });
    expect(activity().map((event) => [event.where, event.state])).toEqual([
      ["client", "started"],
      ["client", "succeeded"]
    ]);
  });

  it("treats a result with an error string as failure", async () => {
    const { broker, activity } = setup({ clientTools: [clientSpec()] });
    const pending = broker.run({ callId: "c1", name: "cli", arguments: {} });
    broker.clientResult({ type: "tool.result", callId: "c1", error: "denied", output: "ignored" });
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.output)).toEqual({ error: "denied" });
    expect(activity().at(-1)).toMatchObject({ state: "failed", where: "client", error: "denied" });
  });

  it("treats a blank error as success", async () => {
    const { broker } = setup({ clientTools: [clientSpec()] });
    const pending = broker.run({ callId: "c1", name: "cli", arguments: {} });
    broker.clientResult({ type: "tool.result", callId: "c1", error: "  ", output: "fine" });
    expect(await pending).toEqual({ ok: true, output: "fine" });
  });

  it("times out when the client never answers; the late answer is ignored", async () => {
    const { broker, activity } = setup({ clientTools: [clientSpec()], clientTimeoutMs: 20 });
    const outcome = await broker.run({ callId: "c1", name: "cli", arguments: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("did not answer");
    expect(activity().at(-1)?.state).toBe("failed");
    expect(() => broker.clientResult({ type: "tool.result", callId: "c1", output: 1 })).not.toThrow();
  });

  it("ignores results for unknown call ids and duplicates", async () => {
    const { broker } = setup({ clientTools: [clientSpec()] });
    broker.clientResult({ type: "tool.result", callId: "nope", output: 1 });
    const pending = broker.run({ callId: "c1", name: "cli", arguments: {} });
    broker.clientResult({ type: "tool.result", callId: "c1", output: "first" });
    broker.clientResult({ type: "tool.result", callId: "c1", output: "second" });
    expect(await pending).toEqual({ ok: true, output: "first" });
  });

  it("does not call a client tool shadowed by a server tool", async () => {
    const { broker, sent } = setup({ serverTools: [serverTool({ name: "cli" })], clientTools: [clientSpec("cli")] });
    await broker.run({ callId: "c", name: "cli", arguments: {} });
    expect(sent.some((event) => event.type === "tool.call")).toBe(false);
  });

  it("fails bad client arguments without sending tool.call", async () => {
    const { broker, sent } = setup({ clientTools: [clientSpec()] });
    expect((await broker.run({ callId: "c", name: "cli", arguments: "{x" })).ok).toBe(false);
    expect(sent.some((event) => event.type === "tool.call")).toBe(false);
  });
});

describe("unknown tools and close", () => {
  it("fails an unknown tool without activity", async () => {
    const { broker, sent } = setup();
    const outcome = await broker.run({ callId: "c", name: "ghost", arguments: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("no tool called ghost");
    expect(sent).toEqual([]);
  });

  it("close() resolves pending client calls with an error and aborts server handlers", async () => {
    let signal: AbortSignal | undefined;
    const { broker } = setup({
      clientTools: [clientSpec()],
      serverTools: [
        serverTool({
          handler: (_args, context) => {
            signal = context.signal;
            return new Promise(() => undefined);
          }
        })
      ]
    });
    const client = broker.run({ callId: "c1", name: "cli", arguments: {} });
    const server = broker.run({ callId: "c2", name: "srv", arguments: {} });
    await Promise.resolve();
    await Promise.resolve();
    broker.close();
    const outcome = await client;
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("session ended");
    expect(signal?.aborted).toBe(true);
    // The aborted handler never settles on its own; the broker still bounds it by its timeout.
    void server;
  });

  it("refuses new calls after close()", async () => {
    const { broker, sent } = setup({ serverTools: [serverTool()] });
    broker.close();
    const outcome = await broker.run({ callId: "c", name: "srv", arguments: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("session ended");
    expect(sent).toEqual([]);
  });
});
