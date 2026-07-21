import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentEvent } from "../shared/agent";
import { AgentSessionController, normalizeRawData, parseClientEvent } from "../server/session-controller";
import { createMockProvider } from "../server/providers/mock";
import { metrics } from "../server/metrics";
import type { AgentProvider, ProviderSessionContext, SessionStartEvent } from "../server/providers/types";
import { recordUserMemoryEvent, resetUserMemoryForTests, userConversationMemory } from "../server/user-memory";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

function waitForOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForEvents(socket: WebSocket, requiredTypes: string[]) {
  const seen = new Set<string>();
  const events: AgentEvent[] = [];

  return new Promise<AgentEvent[]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${requiredTypes.join(", ")}`)), 5000);

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(data.toString()) as AgentEvent;
      events.push(event);
      seen.add(event.type);
      if (requiredTypes.every((type) => seen.has(type))) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}

async function startMockRelay() {
  server = http.createServer();
  wss = new WebSocketServer({ server, path: "/agent" });
  wss.on("connection", (client) => {
    const session = new AgentSessionController(client, createMockProvider);
    client.on("message", (data, isBinary) => void session.handleMessage(data, isBinary));
    client.on("close", () => void session.close());
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server port");
  return address.port;
}

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  wss = undefined;
  server = undefined;
  metrics.reset();
  resetUserMemoryForTests();
});

describe("/agent WebSocket relay", () => {
  it("runs a mock session lifecycle with JSON and binary audio", async () => {
    const port = await startMockRelay();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await waitForOpen(socket);

    const eventsPromise = waitForEvents(socket, [
      "session.started",
      "ride.context",
      "session.memory",
      "status",
      "weather",
      "transcript"
    ]);

    socket.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: 16000,
        channels: 1,
        testerId: "qa-rider-1",
        testerRegion: "Asia/Shanghai",
        voiceGender: "female",
        voicePersonality: "concise",
        scenario: "commute"
      })
    );
    socket.send(JSON.stringify({ type: "audio.start" }));
    socket.send(Buffer.from([1, 2, 3, 4]));

    const events = await eventsPromise;
    expect(events.some((event) => event.type === "session.started" && event.provider === "mock")).toBe(true);
    expect(events.some((event) => event.type === "weather")).toBe(true);
    expect(events.some((event) => event.type === "transcript" && event.speaker === "rider")).toBe(true);

    socket.terminate();
  });
});

describe("session controller ordering and lifecycle", () => {
  function makeControllerProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
    return {
      start: async () => undefined,
      startAudio: async () => undefined,
      sendAudio: async () => undefined,
      stopAudio: async () => undefined,
      close: async () => undefined,
      ...overrides
    };
  }

  const startEvent = Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1 }));

  it("serializes async provider calls in WebSocket wire order", async () => {
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const provider = makeControllerProvider({
      start: async () => {
        calls.push("start:begin");
        await startGate;
        calls.push("start:end");
      },
      startAudio: async () => {
        calls.push("audio:start");
      },
      sendAudio: async () => {
        calls.push("audio:frame");
      }
    });
    const client = { readyState: 1, OPEN: 1, send: vi.fn() } as never;
    const controller = new AgentSessionController(client, () => provider);

    const starting = controller.handleMessage(startEvent, false);
    const audioStarting = controller.handleMessage(Buffer.from(JSON.stringify({ type: "audio.start" })), false);
    const audioFrame = controller.handleMessage(Buffer.from([1, 2]), true);
    await Promise.resolve();
    expect(calls).toEqual(["start:begin"]);

    releaseStart();
    await Promise.all([starting, audioStarting, audioFrame]);
    expect(calls).toEqual(["start:begin", "start:end", "audio:start", "audio:frame"]);
    await controller.close();
  });

  it("rejects pre-start traffic and repeated session.start events", async () => {
    const sendAudio = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const clientSend = vi.fn();
    const client = { readyState: 1, OPEN: 1, send: clientSend } as never;
    const controller = new AgentSessionController(client, () => makeControllerProvider({ start, sendAudio }));

    await controller.handleMessage(Buffer.from([1, 2]), true);
    await controller.handleMessage(startEvent, false);
    await controller.handleMessage(startEvent, false);

    expect(sendAudio).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    const errors = clientSend.mock.calls
      .map(([payload]) => JSON.parse(String(payload)) as { type?: string; message?: string })
      .filter((event) => event.type === "error");
    expect(errors.map((event) => event.message)).toEqual([
      "session.start must complete before audio",
      "session.start has already been received"
    ]);
    await controller.close();
  });

  it("loads server-owned memory for an authenticated user and records new final turns", async () => {
    const aliceId = "11111111-1111-4111-8111-111111111111";
    recordUserMemoryEvent(
      aliceId,
      { type: "session.memory", language: "zh", destination: "上海站", lastIntent: "navigation" },
      10
    );
    recordUserMemoryEvent(aliceId, { type: "transcript", speaker: "rider", text: "上次去上海站" }, 11);

    let capturedEvent: SessionStartEvent | undefined;
    let capturedContext: ProviderSessionContext | undefined;
    const client = { readyState: 1, OPEN: 1, send: vi.fn() } as never;
    const controller = new AgentSessionController(
      client,
      (_socket, telemetry) =>
        makeControllerProvider({
          start: async (event, context) => {
            capturedEvent = event;
            capturedContext = context;
            telemetry.serverEvent(
              { type: "transcript", speaker: "agent", text: "我记得，上次目的地是上海站。", final: true },
              1
            );
          }
        }),
      undefined,
      "127.0.0.1",
      undefined,
      { id: aliceId, username: "alice" }
    );

    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          memory: { language: "en", destination: "stale client destination" }
        })
      ),
      false
    );

    expect(capturedEvent?.memory?.destination).toBe("上海站");
    expect(capturedContext?.previousConversation?.turns.map((turn) => turn.text)).toEqual(["上次去上海站"]);
    expect(capturedContext?.previousConversation?.facts).toEqual([]);
    expect(userConversationMemory(aliceId)?.turns.map((turn) => turn.text)).toEqual([
      "上次去上海站",
      "我记得，上次目的地是上海站。"
    ]);
    await controller.close();
  });

  it("does not let a new authenticated user inherit another user's client snapshot", async () => {
    let capturedEvent: SessionStartEvent | undefined;
    const client = { readyState: 1, OPEN: 1, send: vi.fn() } as never;
    const controller = new AgentSessionController(
      client,
      () =>
        makeControllerProvider({
          start: async (event) => {
            capturedEvent = event;
          }
        }),
      undefined,
      "127.0.0.1",
      undefined,
      { id: "22222222-2222-4222-8222-222222222222", username: "bob" }
    );

    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          memory: { language: "en", destination: "Alice's private destination", lastIntent: "navigation" }
        })
      ),
      false
    );

    expect(capturedEvent?.memory).toBeUndefined();
    await controller.close();
  });

  it("closes an unrecoverable socket when provider session startup fails", async () => {
    const close = vi.fn();
    const send = vi.fn();
    const client = { readyState: 1, OPEN: 1, send, close } as never;
    const provider = makeControllerProvider({
      start: async () => {
        throw new Error("upstream unavailable");
      }
    });
    const controller = new AgentSessionController(client, () => provider);

    await controller.handleMessage(startEvent, false);

    expect(close).toHaveBeenCalledWith(1011, "provider start failed");
    expect(
      send.mock.calls
        .map(([payload]) => JSON.parse(String(payload)) as { type?: string; message?: string })
        .some((event) => event.type === "error" && event.message === "语音服务暂时不可用，请重新连接。")
    ).toBe(true);
    await controller.close();
  });
});

describe("client event validation", () => {
  it("accepts a valid session.start event", () => {
    const event = parseClientEvent(
      Buffer.from(
        JSON.stringify({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          testerId: "qa-rider-1",
          testerRegion: "Asia/Shanghai",
          testingCampaignId: "safety-regression",
          testingTestCaseId: "emergency-safe-guidance",
          testingRunId: "release-run-1",
          testingAssignmentId: "assignment-1",
          appVersion: "0.1.0",
          gitCommit: "abcdef0",
          deviceLabel: "macOS browser",
          browserLanguage: "en-US",
          networkType: "4g",
          platform: "web",
          voiceGender: "male",
          voicePersonality: "rally",
          rideMode: "navigation",
          scenario: "wind",
          lat: 37.57,
          lon: 126.98
        })
      )
    );

    expect(event.type).toBe("session.start");
    if (event.type === "session.start") {
      expect(event.voiceGender).toBe("male");
      expect(event.scenario).toBe("wind");
      expect(event.testerId).toBe("qa-rider-1");
      expect(event.testerRegion).toBe("Asia/Shanghai");
      expect(event.testingCampaignId).toBe("safety-regression");
      expect(event.testingTestCaseId).toBe("emergency-safe-guidance");
      expect(event.testingRunId).toBe("release-run-1");
      expect(event.testingAssignmentId).toBe("assignment-1");
      expect(event.platform).toBe("web");
      expect(event.deviceLabel).toBe("macOS browser");
    }
  });

  it("rejects unsafe tester ids and regions", () => {
    const base = { type: "session.start", sampleRate: 16000, channels: 1 };
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, testerId: "qa\u0000rider" })))).toThrow(
      "Invalid testerId"
    );
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, testerId: "x".repeat(100) })))).toThrow(
      "Invalid testerId"
    );
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ ...base, testerRegion: "Asia\u0000Shanghai" })))
    ).toThrow("Invalid testerRegion");
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, testerRegion: "x".repeat(120) })))).toThrow(
      "Invalid testerRegion"
    );
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ ...base, testingCampaignId: "release\u0000readiness" })))
    ).toThrow("Invalid testingCampaignId");
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, deviceLabel: "x".repeat(140) })))).toThrow(
      "Invalid deviceLabel"
    );
  });

  it("accepts a valid location.update and rejects malformed coordinates", () => {
    const event = parseClientEvent(Buffer.from(JSON.stringify({ type: "location.update", lat: 35.1, lon: 129.07 })));
    expect(event).toEqual({ type: "location.update", lat: 35.1, lon: 129.07 });

    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ type: "location.update", lat: 91, lon: 0 })))).toThrow(
      "Invalid lat"
    );
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ type: "location.update", lat: 10, lon: "east" })))
    ).toThrow("Invalid lon");
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ type: "location.update", lat: 10 })))).toThrow(
      "Invalid lon"
    );
  });

  it("rejects unsupported client event values before they reach a provider", () => {
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 44100, channels: 1 })))
    ).toThrow("Invalid sampleRate");
    expect(() =>
      parseClientEvent(
        Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, scenario: "trackday" }))
      )
    ).toThrow("Invalid scenario");
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ type: "unknown" })))).toThrow(
      "Unsupported client event"
    );
  });

  it("accepts a valid memory snapshot and rejects malformed ones", () => {
    const event = parseClientEvent(
      Buffer.from(
        JSON.stringify({
          type: "session.start",
          sampleRate: 16000,
          channels: 1,
          memory: { language: "en", destination: "busan station", lastIntent: "navigation", responseMode: "concise" }
        })
      )
    );
    expect(event.type === "session.start" && event.memory?.destination).toBe("busan station");

    const base = { type: "session.start", sampleRate: 16000, channels: 1 };
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, memory: "yes" })))).toThrow("Invalid memory");
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, memory: { language: "fr" } })))).toThrow(
      "Invalid memory.language"
    );
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ ...base, memory: { lastIntent: "hacking" } })))).toThrow(
      "Invalid memory.lastIntent"
    );
    expect(() =>
      parseClientEvent(Buffer.from(JSON.stringify({ ...base, memory: { destination: "x".repeat(300) } })))
    ).toThrow("Invalid memory.destination");
  });

  it("accepts and validates the guided-demo toggle", () => {
    const event = parseClientEvent(Buffer.from(JSON.stringify({ type: "demo.guided", enabled: true })));
    expect(event).toEqual({ type: "demo.guided", enabled: true });
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ type: "demo.guided" })))).toThrow(
      "Invalid demo.guided enabled flag"
    );
  });

  it("accepts bounded client audio-quality metrics", () => {
    expect(
      parseClientEvent(
        Buffer.from(
          JSON.stringify({
            type: "testing.metric",
            droppedFrames: 2,
            outgoingFps: 49,
            jitterMs: 1.5,
            clippingPct: 0.2,
            silencePct: 18
          })
        )
      )
    ).toEqual({
      type: "testing.metric",
      droppedFrames: 2,
      outgoingFps: 49,
      jitterMs: 1.5,
      clippingPct: 0.2,
      silencePct: 18
    });
    expect(() => parseClientEvent(Buffer.from(JSON.stringify({ type: "testing.metric", clippingPct: 101 })))).toThrow(
      "Invalid testing.metric clippingPct"
    );
  });

  it("normalizes fragmented binary frames", () => {
    expect(normalizeRawData([Buffer.from([1, 2]), Buffer.from([3, 4])])).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});

describe("turn.feedback validation", () => {
  it("accepts a valid turn.feedback event", () => {
    const event = parseClientEvent(
      Buffer.from(
        JSON.stringify({
          type: "turn.feedback",
          turnId: "turn-1",
          speaker: "agent",
          text: "今天晴天。",
          reason: "回答不对"
        })
      )
    );
    expect(event).toEqual({
      type: "turn.feedback",
      turnId: "turn-1",
      speaker: "agent",
      text: "今天晴天。",
      reason: "回答不对"
    });
  });

  it("rejects malformed turn.feedback events", () => {
    expect(() =>
      parseClientEvent(
        Buffer.from(
          JSON.stringify({ type: "turn.feedback", turnId: "turn-1", speaker: "narrator", text: "x", reason: "r" })
        )
      )
    ).toThrow("Invalid turn.feedback speaker");
    expect(() =>
      parseClientEvent(
        Buffer.from(
          JSON.stringify({ type: "turn.feedback", turnId: "turn-1", speaker: "agent", text: "  ", reason: "r" })
        )
      )
    ).toThrow("Invalid turn.feedback text");
    expect(() =>
      parseClientEvent(
        Buffer.from(
          JSON.stringify({
            type: "turn.feedback",
            turnId: "turn-1",
            speaker: "agent",
            text: "x",
            reason: "r".repeat(121)
          })
        )
      )
    ).toThrow("Invalid turn.feedback reason");
  });
});
