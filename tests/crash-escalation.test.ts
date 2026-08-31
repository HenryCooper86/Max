import { describe, expect, it, vi } from "vitest";
import {
  createLogNotifier,
  crashCancelSmsBody,
  crashSmsBody,
  handleCrashAlert,
  handleCrashCancel,
  selectCrashNotifier,
  type CrashAlertEvent,
  type CrashNotifier
} from "../server/crash-escalation";

const alert = (overrides: Partial<CrashAlertEvent> = {}): CrashAlertEvent => ({
  type: "crash.alert",
  incidentId: "i1",
  contactOptIn: true,
  contactNumber: "+8613800000000",
  lat: 31.23,
  lon: 121.47,
  speedKmhRecent: 42,
  detectedAt: 1754200000000,
  ...overrides
});

describe("crashSmsBody", () => {
  it("names the incident, the location, and an amap link", () => {
    const body = crashSmsBody(alert());
    expect(body).toContain("Max");
    expect(body).toContain("31.23");
    expect(body).toContain("https://uri.amap.com/marker?position=121.47,31.23");
  });

  it("omits the location line when there is no fix", () => {
    const body = crashSmsBody(alert({ lat: undefined, lon: undefined }));
    expect(body).not.toContain("amap");
    expect(body).toContain("位置未知");
  });

  it("has a false-alarm follow-up", () => {
    expect(crashCancelSmsBody()).toContain("误报");
  });
});

describe("notifier selection", () => {
  it("defaults to the log notifier and falls back on unknown names", () => {
    expect(createLogNotifier().name).toBe("log");
    expect(selectCrashNotifier("log").name).toBe("log");
    expect(selectCrashNotifier("aliyun-sms").name).toBe("log");
  });
});

describe("handleCrashAlert", () => {
  it("acks unconfigured when only the log notifier exists", async () => {
    const send = vi.fn();
    const audit = vi.fn();
    await handleCrashAlert(alert(), createLogNotifier(), send, audit as never);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "crash.ack", incidentId: "i1", status: "unconfigured" })
    );
    expect(audit).toHaveBeenCalledWith("relay", "crash.alert", "session", "i1", expect.any(Object));
  });

  it("acks unconfigured without calling notify when the rider did not opt in", async () => {
    const send = vi.fn();
    const notify = vi.fn();
    const notifier: CrashNotifier = { name: "spy", notify, followUp: vi.fn() };
    await handleCrashAlert(alert({ contactOptIn: false, contactNumber: undefined }), notifier, send, vi.fn() as never);
    expect(notify).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: "unconfigured" }));
  });

  it("acks failed when the notifier throws", async () => {
    const send = vi.fn();
    const notifier: CrashNotifier = {
      name: "boom",
      notify: vi.fn().mockRejectedValue(new Error("sms down")),
      followUp: vi.fn()
    };
    await handleCrashAlert(alert(), notifier, send, vi.fn() as never);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "crash.ack", status: "failed" }));
  });
});

describe("handleCrashCancel", () => {
  it("audits and forwards the follow-up", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn();
    await handleCrashCancel(
      { type: "crash.cancel", incidentId: "i1" },
      { name: "spy", notify: vi.fn(), followUp },
      audit as never
    );
    expect(followUp).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith("relay", "crash.cancel", "session", "i1", expect.any(Object));
  });
});

import http from "node:http";
import { afterEach } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AgentSessionController } from "../server/session-controller";
import { createMockProvider } from "../server/providers/mock";
import { metrics } from "../server/metrics";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  wss = undefined;
  server = undefined;
  metrics.reset();
});

describe("crash escalation over the relay", () => {
  it("answers crash.alert with a truthful crash.ack", async () => {
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

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/agent`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no crash.ack")), 5000);
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "session.started") {
          socket.send(JSON.stringify({ type: "crash.alert", incidentId: "e2e-1", contactOptIn: false }));
        }
        if (event.type === "crash.ack") {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });

    socket.send(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1 }));

    const event = await ack;
    expect(event).toMatchObject({ type: "crash.ack", incidentId: "e2e-1", status: "unconfigured" });
    socket.terminate();
  });
});

import { createCrashSimulator } from "../server/hazard-injector";
import { scenarioDefaultMode, scenarioLabel } from "../shared/ride";

describe("crash demo scenario", () => {
  it("is registered with label and emergency mode", () => {
    expect(scenarioLabel("crash")).toBe("事故");
    expect(scenarioDefaultMode("crash")).toBe("emergency");
  });

  it("emits crash.simulate after the delay, but never to the embedded board", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sim = createCrashSimulator({ send });
    sim.start(6000);
    vi.advanceTimersByTime(5999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith({ type: "crash.simulate" });

    send.mockClear();
    const embedded = createCrashSimulator({ send, platform: () => "embedded" });
    embedded.start(1000);
    vi.advanceTimersByTime(2000);
    expect(send).not.toHaveBeenCalled();

    sim.stop();
    embedded.stop();
    vi.useRealTimers();
  });

  it("stop() cancels a scheduled simulate", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const sim = createCrashSimulator({ send });
    sim.start(1000);
    sim.stop();
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("mock provider crash injection", () => {
  afterEach(() => vi.useRealTimers());

  function makeClient() {
    const messages: Array<Record<string, unknown>> = [];
    const client = {
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => messages.push(JSON.parse(raw))
    } as unknown as Parameters<typeof createMockProvider>[0];
    return { client, messages };
  }

  it("fires crash.simulate after startAudio when the rider picks the scenario directly", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1, scenario: "crash" });
    await provider.startAudio();
    vi.advanceTimersByTime(6000);

    expect(messages).toContainEqual({ type: "crash.simulate" });

    await provider.close();
  });

  it("never fires crash.simulate on the embedded platform", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({
      type: "session.start",
      sampleRate: 16000,
      channels: 1,
      scenario: "crash",
      platform: "embedded"
    });
    await provider.startAudio();
    vi.advanceTimersByTime(6000);

    expect(messages).not.toContainEqual({ type: "crash.simulate" });

    await provider.close();
  });
});
