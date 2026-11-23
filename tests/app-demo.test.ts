/* eslint-disable @typescript-eslint/no-explicit-any -- relay events are inspected structurally */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { createLogger } from "../server/logger";
import { createAppDemoProvider, toolRequestFrom } from "../server/providers/app-demo";
import type { ToolDefinition, ToolSpec } from "../server/tools";

afterEach(() => setAssistantProfileForTests());

const spec = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object", properties: {} } });

describe("toolRequestFrom", () => {
  const tools = [spec("get_order_status"), spec("open-page"), spec("ping")];

  it("matches the tool name, case-insensitively", () => {
    expect(toolRequestFrom("please run GET_ORDER_STATUS now", tools)?.tool.name).toBe("get_order_status");
  });

  it("matches a spaced name for underscores and dashes", () => {
    expect(toolRequestFrom("get order status", tools)?.tool.name).toBe("get_order_status");
    expect(toolRequestFrom("open page", tools)?.tool.name).toBe("open-page");
  });

  it("extracts JSON arguments after the name", () => {
    expect(toolRequestFrom('get_order_status {"orderId": "A1", "n": {"x": 1}}', tools)?.args).toEqual({
      orderId: "A1",
      n: { x: 1 }
    });
  });

  it("falls back to no arguments for invalid JSON, arrays and absent braces", () => {
    expect(toolRequestFrom("ping {oops}", tools)?.args).toEqual({});
    expect(toolRequestFrom("ping {", tools)?.args).toEqual({});
    expect(toolRequestFrom("ping", tools)?.args).toEqual({});
    expect(toolRequestFrom("ping {}", tools)?.args).toEqual({});
  });

  it("returns undefined when no tool is named", () => {
    expect(toolRequestFrom("hello there", tools)).toBeUndefined();
    expect(toolRequestFrom("anything", [])).toBeUndefined();
  });
});

class FakeClient {
  OPEN = 1;
  readyState = 1;
  json: Array<Record<string, any>> = [];
  send(data: string | Buffer) {
    if (typeof data === "string") this.json.push(JSON.parse(data) as Record<string, any>);
  }
  ofType(type: string) {
    return this.json.filter((event) => event.type === type);
  }
  agentLines() {
    return this.json
      .filter((event) => event.type === "transcript" && event.speaker === "agent")
      .map((event) => event.text);
  }
}

const lookup: ToolDefinition = {
  name: "get_order_status",
  description: "Look up an order",
  handler: (args) => ({ status: "shipped", order: args.orderId })
};

async function setup(tools: ToolDefinition[] = [lookup], toolTimeoutMs?: number) {
  const client = new FakeClient();
  const provider = createAppDemoProvider(client as never, createLogger("test"), undefined, {
    serverTools: () => tools,
    toolTimeoutMs
  });
  await provider.start(
    {
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      language: "en",
      tools: [{ name: "navigate_page", description: "Go to a page" }]
    } as never,
    { sessionId: "s1" }
  );
  return { client, provider };
}

describe("app demo provider", () => {
  it("announces a mock session with tool and text capabilities", async () => {
    const { client } = await setup();
    expect(client.ofType("session.started")[0]).toMatchObject({
      provider: "mock",
      capabilities: { tools: true, textInput: true }
    });
    expect(client.ofType("status")[0]).toMatchObject({ state: "ready" });
  });

  it("runs a server tool named in typed text and speaks the output in the browser", async () => {
    const { client, provider } = await setup();
    await expect(provider.textInput!('get order status {"orderId":"A1"}')).resolves.toBe(true);
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.ofType("tool.activity").map((event) => [event.where, event.state, event.name])).toEqual([
      ["server", "started", "get_order_status"],
      ["server", "succeeded", "get_order_status"]
    ]);
    const rider = client.json.find((event) => event.type === "transcript" && event.speaker === "rider")!;
    expect(rider).toMatchObject({ text: 'get order status {"orderId":"A1"}', final: true });
    const reply = client.json.filter((event) => event.type === "transcript" && event.speaker === "agent").at(-1)!;
    expect(reply.final).toBe(true);
    expect(reply.useBrowserSpeech).toBe(true);
    expect(reply.text).toContain("get_order_status returned:");
    expect(reply.text).toContain('{"status":"shipped","order":"A1"}');
    await provider.close();
  });

  it("reports a failing tool in the spoken reply", async () => {
    const failing: ToolDefinition = {
      ...lookup,
      handler: () => {
        throw new Error("boom");
      }
    };
    const { client, provider } = await setup([failing]);
    await provider.textInput!("get_order_status");
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.ofType("tool.activity").at(-1)).toMatchObject({ state: "failed", error: "failed" }); // server detail stays off the client
    expect(client.agentLines().at(-1)).toContain("get_order_status failed:");
  });

  it("round-trips a client tool through tool.call and tool.result", async () => {
    const { client, provider } = await setup();
    await provider.textInput!('navigate page {"to":"/pricing"}');
    await vi.waitFor(() => expect(client.ofType("tool.call")).toHaveLength(1));
    const call = client.ofType("tool.call")[0]!;
    expect(call).toMatchObject({ name: "navigate_page", arguments: { to: "/pricing" } });
    await provider.toolResult!({ type: "tool.result", callId: call.callId, output: "done" });
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.agentLines().at(-1)).toBe("navigate_page returned: done");
  });

  it("answers a message without a tool with a demo reply that lists the tools", async () => {
    const { client, provider } = await setup();
    await provider.textInput!("hello");
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.ofType("tool.activity")).toHaveLength(0);
    const reply = client.agentLines().at(-1)!;
    expect(reply).toContain('Demo mode got: "hello"');
    expect(reply).toContain("get_order_status, navigate_page");
    expect(client.json.filter((event) => event.speaker === "agent").at(-1)!.useBrowserSpeech).toBe(true);
  });

  it("greets once when the microphone opens, using the configured greeting or a default", async () => {
    const { client, provider } = await setup();
    await provider.startAudio!();
    await provider.stopAudio!();
    await provider.startAudio!();
    expect(client.agentLines().filter((line) => line.startsWith("Hi, I'm"))).toHaveLength(1);
  });

  it("stops sending after close", async () => {
    const { client, provider } = await setup();
    await provider.close();
    const before = client.json.length;
    await provider.textInput!("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.json).toHaveLength(before);
  });
});

describe("app demo provider with rules for tools", () => {
  it("does not run a tool the owner's rules cover: demo mode has no judge to read the call", async () => {
    const ran: string[] = [];
    const refund: ToolDefinition = {
      name: "refund",
      description: "Refunds an order",
      handler: () => ran.push("refund")
    };
    const find: ToolDefinition = { name: "find_order", description: "Finds an order", handler: () => ran.push("find") };
    setAssistantProfileForTests(
      assistantProfileFrom({
        name: "Ava",
        device: "app",
        guardrails: { toolRules: ["Do not refund more than 100 dollars."], checkedTools: ["refund"] }
      })
    );
    const { client, provider } = await setup([refund, find]);
    await provider.textInput!('refund {"amount": 900}');
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.agentLines()[0]).toContain("Demo mode does not run refund");
    expect(client.ofType("tool.activity")).toEqual([]);
    await provider.textInput!("find order");
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(2));
    expect(ran).toEqual(["find"]);
  });

  it("does not run a tool whose result the rules cover either: nothing here could read it", async () => {
    const ran: string[] = [];
    const find: ToolDefinition = { name: "find_order", description: "Finds an order", handler: () => ran.push("find") };
    setAssistantProfileForTests(
      assistantProfileFrom({
        name: "Ava",
        device: "app",
        guardrails: { resultRules: ["Another customer's personal details."] }
      })
    );
    const { client, provider } = await setup([find]);
    await provider.textInput!("find order");
    await vi.waitFor(() => expect(client.agentLines()).toHaveLength(1));
    expect(client.agentLines()[0]).toContain("Demo mode does not run find_order");
    expect(ran).toEqual([]);
  });
});
