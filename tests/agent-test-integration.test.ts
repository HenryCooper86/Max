/* eslint-disable @typescript-eslint/no-explicit-any -- the fake relay reads fields off loosely typed JSON events */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentTestClient, openSession, type ClientOptions } from "../scripts/agent-test/client";
import { main } from "../scripts/agent-test/cli";
import { runScenario, type RunOptions } from "../scripts/agent-test/run";
import { parseScenarioFile, type Scenario } from "../scripts/agent-test/scenario";

type Io = {
  send: (event: Record<string, unknown>) => void;
  ws: WebSocket;
  /** Resolves with the next client message of this type. */
  next: (type: string) => Promise<Record<string, any>>;
  start: Record<string, any>;
};
type Behavior = {
  capabilities?: Record<string, unknown>;
  greeting?: string;
  reject?: number;
  onText?: (text: string, io: Io) => void | Promise<void>;
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-process relay that speaks just enough of docs/protocol.md. */
async function fakeRelay(behavior: Behavior) {
  const headers: (string | undefined)[] = [];
  const starts: Record<string, any>[] = [];
  let seq = 0;
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => {
      headers.push(info.req.headers.authorization);
      if (behavior.reject) done(false, behavior.reject, "Unauthorized");
      else done(true);
    }
  });
  wss.on("connection", (ws) => {
    const waiters = new Map<string, ((event: Record<string, any>) => void)[]>();
    const io: Io = {
      ws,
      start: {},
      send: (event) => ws.send(JSON.stringify(event)),
      next: (type) => new Promise((resolve) => waiters.set(type, [...(waiters.get(type) ?? []), resolve]))
    };
    io.send({ type: "connection", state: "relay", detail: "" });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(data.toString()) as Record<string, any>;
      const waiting = waiters.get(event.type)?.shift();
      if (waiting) waiting(event);
      if (event.type === "session.start") {
        io.start = event;
        starts.push(event);
        io.send({
          type: "session.started",
          provider: "mock",
          mode: "mock",
          capabilities: behavior.capabilities ?? { textInput: true, tools: true }
        });
        io.send({ type: "status", state: "ready", detail: "" });
        if (behavior.greeting) {
          io.send({ type: "transcript", turnId: `g${seq++}`, speaker: "agent", text: behavior.greeting, final: true });
        }
      } else if (event.type === "text.input") {
        io.send({ type: "transcript", turnId: `r${seq++}`, speaker: "rider", text: event.text, final: true });
        void behavior.onText?.(event.text, io);
      }
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as AddressInfo).port;
  closers.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${port}`, port, headers, starts };
}

const reply = (io: Io, text: string, turnId = `a${Math.random()}`) =>
  io.send({ type: "transcript", turnId, speaker: "agent", text, final: true });

const quick = (extra: Partial<ClientOptions> = {}) => ({ settleMs: 60, turnTimeoutMs: 1500, ...extra });

describe("client against a fake relay", () => {
  it("sends the documented session.start with a bearer token and records the greeting apart from turn 1", async () => {
    const relay = await fakeRelay({
      greeting: "Hi, I'm Ava.",
      onText: (_text, io) => {
        io.send({ type: "status", state: "thinking", detail: "" });
        io.send(Buffer.from([1, 2, 3]) as never);
        reply(io, "Sure.");
        io.send({ type: "telemetry", asrMs: 0, thinkMs: 5, firstAudioMs: 0, totalMs: 6 });
        io.send({ type: "status", state: "ready", detail: "" });
      }
    });
    const client = await openSession({
      relayUrl: relay.url,
      token: "secret-token",
      context: "On the orders page.",
      language: "en",
      clientTools: [{ name: "go", description: "Go.", parameters: { type: "object" } }],
      ...quick()
    });
    expect(client.greeting).toBe("Hi, I'm Ava.");
    const turn = await client.sendTurn("hello");
    await client.close();
    expect(turn).toMatchObject({ reply: "Sure.", replies: ["Sure."], errors: [] });
    expect(turn.telemetry).toEqual([{ asrMs: 0, thinkMs: 5, firstAudioMs: 0, totalMs: 6 }]);
    expect(turn.failure).toBeUndefined();
    expect(relay.headers[0]).toBe("Bearer secret-token");
    expect(relay.starts[0]).toEqual({
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      appVersion: "agent-test",
      protocol: 1,
      tools: [{ name: "go", description: "Go.", parameters: { type: "object" } }],
      context: "On the orders page.",
      language: "en"
    });
  });

  it("joins a reply split around a server tool call even when the status goes quiet in between", async () => {
    const relay = await fakeRelay({
      onText: async (_text, io) => {
        io.send({ type: "status", state: "thinking", detail: "" });
        reply(io, "Let me check.", "a1");
        io.send({ type: "status", state: "ready", detail: "" });
        await wait(20);
        io.send({ type: "tool.activity", callId: "c1", name: "get_order_status", where: "server", state: "started" });
        await wait(450); // longer than the settle time: the running tool must keep the turn open
        io.send({
          type: "tool.activity",
          callId: "c1",
          name: "get_order_status",
          where: "server",
          state: "succeeded",
          durationMs: 150
        });
        reply(io, "It shipped.", "a2");
        io.send({ type: "status", state: "ready", detail: "" });
      }
    });
    // The settle time is far above the 20 ms pause before the tool starts, so
    // a slow runner cannot end the turn in that gap.
    const client = await openSession({ relayUrl: relay.url, ...quick({ settleMs: 300, turnTimeoutMs: 5000 }) });
    const turn = await client.sendTurn("where is my order");
    await client.close();
    expect(turn.replies).toEqual(["Let me check.", "It shipped."]);
    expect(turn.reply).toBe("Let me check. It shipped.");
    expect(turn.activity.map((a) => a.state)).toEqual(["started", "succeeded"]);
    expect(turn.activity[1]).toMatchObject({ name: "get_order_status", where: "server", durationMs: 150 });
  });

  it("waits for the relay to end the conversation when the turn expects it to", async () => {
    const relay = await fakeRelay({
      onText: async (_text, io) => {
        reply(io, "Goodbye!", "a1");
        io.send({ type: "status", state: "ready", detail: "" });
        // The relay ends the conversation once the goodbye has played out, well after the settle time.
        await wait(400);
        io.send({ type: "session.ended", reason: "agent" });
      }
    });
    const patient = await openSession({ relayUrl: relay.url, ...quick() });
    const ended = await patient.sendTurn("bye", { awaitEnd: true });
    await patient.close();
    expect(ended.failure).toBeUndefined();
    expect(ended.sessionEnded).toBe("agent");

    const hasty = await openSession({ relayUrl: relay.url, ...quick() });
    const open = await hasty.sendTurn("bye");
    await hasty.close();
    expect(open.sessionEnded).toBeUndefined();
  });

  it("answers a declared client tool from the scenario, and an undeclared one with an error", async () => {
    const results: Record<string, any>[] = [];
    const relay = await fakeRelay({
      onText: async (_text, io) => {
        for (const [callId, name] of [
          ["c1", "show_product"],
          ["c2", "mystery"]
        ] as const) {
          io.send({ type: "tool.activity", callId, name, where: "client", state: "started" });
          io.send({ type: "tool.call", callId, name, arguments: { product: "boot" } });
          const result = await io.next("tool.result");
          results.push(result);
          io.send({
            type: "tool.activity",
            callId,
            name,
            where: "client",
            state: result.error ? "failed" : "succeeded",
            ...(result.error ? { error: result.error } : {})
          });
        }
        reply(io, "Done.");
        io.send({ type: "status", state: "listening", detail: "" });
      }
    });
    const client = await openSession({
      relayUrl: relay.url,
      clientTools: [{ name: "show_product", description: "Show.", result: { shown: true } }],
      ...quick()
    });
    const turn = await client.sendTurn("show it");
    await client.close();
    expect(results[0]).toEqual({ type: "tool.result", callId: "c1", output: { shown: true } });
    expect(results[1]).toMatchObject({ callId: "c2", error: expect.stringContaining('"mystery" is not declared') });
    expect(turn.calls.map((c) => [c.name, c.arguments])).toEqual([
      ["show_product", { product: "boot" }],
      ["mystery", { product: "boot" }]
    ]);
    expect(turn.activity.at(-1)).toMatchObject({ state: "failed" });
  });

  it("fails a turn that produces nothing, saying what was received", async () => {
    const relay = await fakeRelay({ onText: (_t, io) => io.send({ type: "status", state: "thinking", detail: "" }) });
    const client = await openSession({ relayUrl: relay.url, settleMs: 20, turnTimeoutMs: 200 });
    const turn = await client.sendTurn("anyone there?");
    await client.close();
    expect(turn.failure).toContain("no complete reply within 200 ms");
    expect(turn.failure).toContain('status "thinking"');
    expect(turn.latencyMs).toBeUndefined();
  });

  it("fails fast with the relay's error when a turn is refused", async () => {
    const relay = await fakeRelay({
      onText: (_t, io) => io.send({ type: "error", message: "typed input unavailable" })
    });
    const client = await openSession({ relayUrl: relay.url, ...quick() });
    const turn = await client.sendTurn("hi");
    await client.close();
    expect(turn.failure).toContain("typed input unavailable");
    expect(turn.errors).toEqual(["typed input unavailable"]);
  });

  it("reports a close during a turn with its code and reason", async () => {
    const relay = await fakeRelay({ onText: (_t, io) => io.ws.close(4003, "minutes used up") });
    const client = await openSession({ relayUrl: relay.url, ...quick() });
    const turn = await client.sendTurn("hi");
    expect(turn.failure).toContain("close code 4003");
    expect(turn.failure).toContain("minutes used up");
    expect((await client.sendTurn("again")).failure).toContain("connection closed");
  });

  it("refuses a backend without typed input and says which accept it", async () => {
    const relay = await fakeRelay({ capabilities: { textInput: false } });
    await expect(AgentTestClient.connect({ relayUrl: relay.url, ...quick() })).rejects.toThrow(
      /does not accept typed turns.*Doubao/s
    );
  });

  it("explains a 401 refusal and a refused connection", async () => {
    const relay = await fakeRelay({ reject: 401 });
    await expect(AgentTestClient.connect({ relayUrl: relay.url, token: "bad", ...quick() })).rejects.toThrow(
      /HTTP 401.*--token/s
    );
    const closed = await fakeRelay({});
    const url = closed.url;
    await Promise.all(closers.splice(0).map((close) => close()));
    await expect(AgentTestClient.connect({ relayUrl: url, ...quick() })).rejects.toThrow(/connection refused/);
  });

  it("fetches a token from --token-url before connecting", async () => {
    const relay = await fakeRelay({});
    const tokens = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ token: req.method === "POST" ? "minted-1" : "wrong" }));
    });
    await new Promise<void>((resolve) => tokens.listen(0, resolve));
    closers.push(() => new Promise<void>((resolve) => tokens.close(() => resolve())));
    const tokenUrl = `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token`;
    const client = await AgentTestClient.connect({ relayUrl: relay.url, tokenUrl, ...quick() });
    await client.close();
    expect(relay.headers[0]).toBe("Bearer minted-1");
  });
});

const scenarios = (value: unknown): Scenario[] => {
  const parsed = parseScenarioFile(JSON.stringify(value), "t.json");
  expect(parsed.problems).toEqual([]);
  return parsed.scenarios;
};

describe("runner against a fake relay", () => {
  const options = (relayUrl: string, extra: Partial<RunOptions> = {}): RunOptions => ({
    relayUrl,
    settleMs: 40,
    turnTimeoutMs: 1500,
    ...extra
  });

  const orderBehavior: Behavior = {
    onText: async (text, io) => {
      io.send({ type: "status", state: "thinking", detail: "" });
      if (text.includes("order")) {
        io.send({ type: "tool.activity", callId: "c", name: "get_order_status", where: "server", state: "started" });
        io.send({
          type: "tool.activity",
          callId: "c",
          name: "get_order_status",
          where: "server",
          state: "succeeded",
          durationMs: 3
        });
        reply(io, "Order A-1042 shipped.");
      } else reply(io, "Hello.");
      io.send({ type: "status", state: "ready", detail: "" });
    }
  };

  it("passes and fails scripted scenarios, and runs the other assertions when the judge has no model", async () => {
    const relay = await fakeRelay(orderBehavior);
    const [good, bad, judged] = scenarios([
      {
        name: "good",
        turns: [
          {
            user: "my order",
            expect: { toolCalled: "get_order_status", replyContains: "shipped", replyMatches: "A-?1042" }
          },
          { user: "hi", expect: { toolNotCalled: "get_order_status" } }
        ]
      },
      {
        name: "bad",
        turns: [
          { user: "my order", expect: { replyContains: "delayed", toolArgs: { get_order_status: { orderId: "A" } } } }
        ]
      },
      { name: "judged", turns: [{ user: "hi", expect: { replyContains: "hello", judge: "Greets the user." } }] }
    ]);
    const passed = await runScenario(good!, options(relay.url));
    expect(passed).toMatchObject({ pass: true, scenario: "good", kind: "scripted" });
    expect(passed.turns).toHaveLength(2);
    const failed = await runScenario(bad!, options(relay.url));
    expect(failed.pass).toBe(false);
    expect(failed.turns[0]!.assertions.filter((a) => !a.pass).map((a) => a.name)).toEqual([
      "toolArgs get_order_status",
      "replyContains"
    ]);
    const noModel = await runScenario(judged!, options(relay.url));
    expect(noModel.pass).toBe(false);
    expect(noModel.turns[0]!.assertions.map((a) => [a.name, a.pass])).toEqual([
      ["replyContains", true],
      ["judge", false]
    ]);
    expect(noModel.turns[0]!.assertions[1]!.actual).toContain("needs a chat model");
  });

  it("stops a scripted scenario at the first failed turn", async () => {
    const relay = await fakeRelay({});
    const [scenario] = scenarios([{ name: "t", turns: [{ user: "a" }, { user: "b" }] }]);
    const result = await runScenario(scenario!, { ...options(relay.url), turnTimeoutMs: 100 });
    expect(result.pass).toBe(false);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]!.assertions[0]!.actual).toContain("no complete reply");
  });

  it("reports a refused connection as the run's error", async () => {
    const relay = await fakeRelay({ reject: 401 });
    const [scenario] = scenarios([{ name: "t", turns: [{ user: "a" }] }]);
    const result = await runScenario(scenario!, options(relay.url));
    expect(result).toMatchObject({ pass: false, turns: [] });
    expect(result.error).toContain("HTTP 401");
  });

  it("runs a simulated scenario end to end with a fake model endpoint", async () => {
    const relay = await fakeRelay({
      onText: (text, io) => {
        io.send({ type: "tool.activity", callId: "c", name: "book_table", where: "server", state: "started" });
        io.send({ type: "tool.activity", callId: "c", name: "book_table", where: "server", state: "succeeded" });
        reply(io, text.includes("7") ? "Booked for four at 7pm." : "For how many, and when?");
        io.send({ type: "status", state: "ready", detail: "" });
      }
    });
    const lines = ["For four at 7pm please.", "[done]"];
    const requests: Record<string, any>[] = [];
    const model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push({ ...parsed, auth: req.headers.authorization });
        const judging = parsed.messages[0].content.includes("strict evaluator");
        const content = judging
          ? JSON.stringify({ pass: true, reason: "book_table ran and the agent confirmed." })
          : lines.shift();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, resolve));
    closers.push(() => new Promise<void>((resolve) => model.close(() => resolve())));
    const settings = {
      baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      apiKey: "k",
      model: "fake"
    };

    const [scenario] = scenarios([
      {
        name: "books a table",
        simulate: { persona: "A hurried caller.", goal: "Book a table.", firstMessage: "Hi, I need a table." },
        success: "A table was booked through book_table.",
        expect: { toolCalled: "book_table", maxTurns: 3 }
      }
    ]);
    const result = await runScenario(scenario!, options(relay.url, { userModel: settings, judgeModel: settings }));
    expect(result.error).toBeUndefined();
    expect(result.pass).toBe(true);
    expect(result.turns.map((t) => t.user)).toEqual(["Hi, I need a table.", "For four at 7pm please."]);
    expect(result.turns[1]!.reply).toBe("Booked for four at 7pm.");
    expect(result.assertions.every((a) => a.pass)).toBe(true);
    expect(result.success).toMatchObject({ pass: true });
    const judgeRequest = requests.at(-1)!;
    expect(judgeRequest.auth).toBe("Bearer k");
    expect(JSON.parse(judgeRequest.messages[1].content).conversation).toContainEqual({
      role: "tool",
      text: "book_table (server tool) succeeded"
    });

    const withoutModel = await runScenario(scenario!, options(relay.url));
    expect(withoutModel.pass).toBe(false);
    expect(withoutModel.error).toContain("needs a chat model");
  });

  it("CLI: exit codes 0, 1 and 2, a JSON report, and never prints the token", async () => {
    const relay = await fakeRelay(orderBehavior);
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-"));
    const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write("a.json", { name: "passes", turns: [{ user: "my order", expect: { replyContains: "shipped" } }] });
    const failFile = path.join(dir, "fail.json");
    fs.writeFileSync(
      failFile,
      JSON.stringify({ name: "fails", turns: [{ user: "hi", expect: { replyContains: "nope" } }] })
    );
    const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-test-report-")), "report.json");
    const logs: string[] = [];
    const spy = (await import("vitest")).vi
      .spyOn(console, "log")
      .mockImplementation((...args) => void logs.push(args.join(" ")));
    const errors: string[] = [];
    const errSpy = (await import("vitest")).vi
      .spyOn(console, "error")
      .mockImplementation((...args) => void errors.push(args.join(" ")));
    try {
      const common = [
        "--relay",
        relay.url.replace("ws:", "http:"),
        "--token",
        "very-secret",
        "--settle-ms",
        "30",
        "--repeat",
        "2"
      ];
      expect(await main([...common, path.join(dir, "a.json"), "--report", report], {})).toBe(0);
      expect(await main([...common, dir], {})).toBe(1);
      expect(await main([...common, path.join(dir, "missing.json")], {})).toBe(2);
      expect(await main([...common, dir, "--filter", "zzz"], {})).toBe(2);
      expect(await main(["--bogus"], {})).toBe(2);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    const output = [...logs, ...errors].join("\n");
    expect(output).not.toContain("very-secret");
    expect(output).toContain("✓ passes #1");
    expect(output).toContain("✗ fails #2");
    expect(output).toContain("expected:");
    expect(output).toContain("100%  passes (2/2)");
    const written = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(written.summary).toMatchObject({ runs: 2, passed: 2, allPassed: true });
    expect(written.runs[0].turns[0]).toMatchObject({ reply: "Order A-1042 shipped." });
    expect(JSON.stringify(written)).not.toContain("very-secret");
    expect(relay.headers.every((h) => h === "Bearer very-secret")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
