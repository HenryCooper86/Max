import { afterEach, describe, expect, it, vi } from "vitest";

// C1 + I2(a) regression coverage.
//
// C1: cameraFrame's vision-model call must never block the serialized
// message queue that also carries mic PCM and audio.stop
// (server/session-controller.ts's messageQueue) — a pending vision call used
// to sit `await`ed inside that chain, delaying the rider's live audio. These
// tests drive a real AgentSessionController wired to the real
// createDoubaoProvider (mocked upstream `ws` socket, same technique as
// doubao-session.test.ts / doubao-wake.test.ts), so the client -> controller
// -> provider path under test is the real one, not a stand-in.
//
// I2(a): cameraFrame must only ever act on a commandId this relay actually
// issued for camera.look — never on a hand-rolled or reused id.
//
// describeFrame is mocked at the module boundary (server/vision.ts), not via
// a stubbed global fetch: server/providers/doubao.ts builds describeFrame
// once, at module load, via createDescriber({ ... }) with no explicit
// fetchImpl — createDescriber's default parameter binds `fetchImpl` to
// whatever `fetch` resolves to AT THAT MOMENT (import time), which is well
// before any `vi.stubGlobal("fetch", ...)` a test could later perform. A
// stubbed global therefore never reaches it. Mocking createDescriber's return
// value sidesteps that entirely and is also a more direct seam for these tests.
const { MockWebSocket, upstreamInstances } = vi.hoisted(() => {
  const upstreamInstances: MockWebSocket[] = [];
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    handlers: Record<string, (...args: unknown[]) => unknown> = {};
    sent: unknown[] = [];
    constructor(
      public url: string,
      public opts: unknown
    ) {
      upstreamInstances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => unknown) {
      this.handlers[event] = cb;
      return this;
    }
    send(data: unknown) {
      this.sent.push(data);
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.handlers.close?.();
    }
    emit(event: string, ...args: unknown[]) {
      return this.handlers[event]?.(...args);
    }
  }
  return { MockWebSocket, upstreamInstances };
});

vi.mock("ws", () => ({ WebSocket: MockWebSocket }));

const { mockDescribeFrame } = vi.hoisted(() => ({ mockDescribeFrame: vi.fn() }));
vi.mock("../server/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/vision")>();
  return { ...actual, createDescriber: () => mockDescribeFrame };
});

import { createDoubaoProvider } from "../server/providers/doubao";
import { AgentSessionController, type ProviderFactory } from "../server/session-controller";
import { metrics } from "../server/metrics";

// Doubao server-response event codes (EventReceive is a non-exported const enum).
const CONNECTION_STARTED = 50;
const SESSION_STARTED = 150;
const ASR_INFO = 450;
const ASR_RESPONSE = 451;
const ASR_ENDED = 459;
const FULL_SERVER_RESPONSE = 0b1001;

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function jsonFrame(event: number, payload: Record<string, unknown>, sessionId = "s") {
  const header = Buffer.from([0x11, (FULL_SERVER_RESPONSE << 4) | 0b0100, 0b0001 << 4, 0x00]);
  const session = Buffer.from(sessionId);
  const body = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([header, uint32(event), uint32(session.length), session, uint32(body.length), body]);
}

async function riderTurn(upstream: InstanceType<typeof MockWebSocket>, text: string) {
  await upstream.emit("message", jsonFrame(ASR_INFO, {}));
  await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text }] }));
  await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
}

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function clientEvents(send: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([data]: unknown[]) => typeof data === "string")
    .map(([data]: unknown[]) => JSON.parse(data as string) as Record<string, unknown>);
}

function stubWeatherFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Points describeFrame at a promise the test controls, so it can prove
 *  behaviour while the "vision call" is still pending. */
function gateDescribeFrame() {
  let resolveVision!: (value: string | null) => void;
  const gate = new Promise<string | null>((resolve) => {
    resolveVision = resolve;
  });
  mockDescribeFrame.mockImplementation(() => gate);
  return { resolveVision };
}

async function startEmbeddedSession() {
  const send = vi.fn();
  const client = { readyState: 1, OPEN: 1, send, close: vi.fn() } as never;
  const providerFactory: ProviderFactory = (c, telemetry) => createDoubaoProvider(c, silentLog, telemetry);
  const controller = new AgentSessionController(client, providerFactory, silentLog);

  await controller.handleMessage(
    Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, platform: "embedded" })),
    false
  );
  const upstream = upstreamInstances[upstreamInstances.length - 1];
  upstream.emit("open");
  await upstream.emit("message", jsonFrame(CONNECTION_STARTED, {}));
  upstream.emit("message", jsonFrame(SESSION_STARTED, { dialog_id: "dialog-live" }));
  await controller.handleMessage(Buffer.from(JSON.stringify({ type: "audio.start" })), false);

  return { controller, send, upstream };
}

function captureDeviceCommandId(send: ReturnType<typeof vi.fn>, action: string): string {
  const command = clientEvents(send).find((event) => event.type === "device.command" && event.action === action);
  expect(command).toBeDefined();
  return command!.commandId as string;
}

afterEach(() => {
  upstreamInstances.length = 0;
  mockDescribeFrame.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  metrics.reset();
});

describe("camera.frame does not block the relay's message queue (C1)", () => {
  it("lets a subsequent audio frame reach the provider while the vision call is still pending", async () => {
    stubWeatherFetch();
    const { resolveVision } = gateDescribeFrame();
    const { controller, send, upstream } = await startEmbeddedSession();

    await riderTurn(upstream, "Max 你能看到什么");
    const commandId = captureDeviceCommandId(send, "camera.look");
    expect(mockDescribeFrame).not.toHaveBeenCalled();

    const cameraFrameBuffer = Buffer.from(JSON.stringify({ type: "camera.frame", commandId, image: "AAAA" }));
    const cameraFramePromise = controller.handleMessage(cameraFrameBuffer, false);

    let audioProcessed = false;
    const audioFramePromise = controller.handleMessage(Buffer.from([9, 9, 9, 9]), true).then(() => {
      audioProcessed = true;
    });

    // The vision call behind camera.frame is gated open-ended — resolveVision
    // has not been called. If cameraFrame awaited it inside the message
    // queue, this binary audio frame — queued right behind it, exactly as a
    // rider's live mic frames would be — would still be waiting too.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(audioProcessed).toBe(true);
    expect(upstream.sent.some((frame) => Buffer.isBuffer(frame) && frame.includes(Buffer.from([9, 9, 9, 9])))).toBe(
      true
    );

    resolveVision("前面是一条空路。");
    await Promise.all([cameraFramePromise, audioFramePromise]);
    await controller.close();
  });
});

describe("camera.frame speaks the filler before the description (C1's ordering consequence)", () => {
  it("keeps the device-result filler ahead of the async description when camera.frame arrives first, board wire-order style", async () => {
    stubWeatherFetch();
    const { resolveVision } = gateDescribeFrame();
    const { controller, send, upstream } = await startEmbeddedSession();

    await riderTurn(upstream, "Max 你能看到什么");
    const commandId = captureDeviceCommandId(send, "camera.look");

    // rdk/agent/src/main.ts's onFrame fires inside dispatch(), before the
    // device.result promise it returns — so camera.frame reaches the relay
    // strictly before device.result for the same command. Reproduce that
    // wire order here, back to back with no await between them.
    const cameraFrameBuffer = Buffer.from(JSON.stringify({ type: "camera.frame", commandId, image: "AAAA" }));
    const deviceResultBuffer = Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" }));
    const cameraFramePromise = controller.handleMessage(cameraFrameBuffer, false);
    await controller.handleMessage(deviceResultBuffer, false);

    // The filler ("我看看…") does not depend on the vision call and must
    // already be transcribed, while the description is still stuck on the gate.
    const agentTranscriptsSoFar = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    expect(agentTranscriptsSoFar.some((event) => event.text === "我看看…")).toBe(true);
    expect(agentTranscriptsSoFar.some((event) => event.text === "前面是一条空路。")).toBe(false);

    resolveVision("前面是一条空路。");
    await cameraFramePromise;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const agentTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    const fillerIndex = agentTranscripts.findIndex((event) => event.text === "我看看…");
    const descriptionIndex = agentTranscripts.findIndex((event) => event.text === "前面是一条空路。");
    expect(fillerIndex).toBeGreaterThanOrEqual(0);
    expect(descriptionIndex).toBeGreaterThan(fillerIndex);

    await controller.close();
  });
});

describe("camera.frame ignores an unrecognised commandId (I2a)", () => {
  it("never calls describeFrame for a commandId this relay never issued", async () => {
    stubWeatherFetch();
    gateDescribeFrame();
    const { controller, send } = await startEmbeddedSession();

    const cameraFrameBuffer = Buffer.from(
      JSON.stringify({ type: "camera.frame", commandId: "never-issued", image: "AAAA" })
    );
    await controller.handleMessage(cameraFrameBuffer, false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(clientEvents(send).some((event) => event.type === "transcript" && event.speaker === "agent")).toBe(false);

    await controller.close();
  });

  it("never calls describeFrame when the commandId was issued for a different action", async () => {
    stubWeatherFetch();
    gateDescribeFrame();
    const { controller, send, upstream } = await startEmbeddedSession();

    await riderTurn(upstream, "Max 打开手电筒");
    const torchCommandId = captureDeviceCommandId(send, "torch.set");

    const cameraFrameBuffer = Buffer.from(
      JSON.stringify({ type: "camera.frame", commandId: torchCommandId, image: "AAAA" })
    );
    await controller.handleMessage(cameraFrameBuffer, false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).not.toHaveBeenCalled();

    await controller.close();
  });

  it("still describes a legitimate camera.look frame — the gate only blocks impostors", async () => {
    stubWeatherFetch();
    const { resolveVision } = gateDescribeFrame();
    const { controller, send, upstream } = await startEmbeddedSession();

    await riderTurn(upstream, "Max 你能看到什么");
    const commandId = captureDeviceCommandId(send, "camera.look");

    const cameraFrameBuffer = Buffer.from(JSON.stringify({ type: "camera.frame", commandId, image: "AAAA" }));
    await controller.handleMessage(cameraFrameBuffer, false);
    resolveVision("前面是一条空路。");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(mockDescribeFrame).toHaveBeenCalledWith("AAAA");
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前面是一条空路。"
      )
    ).toBe(true);

    await controller.close();
  });
});
