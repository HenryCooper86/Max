import { afterEach, describe, expect, it, vi } from "vitest";

// Final-review fix-wave regression (nav-fast-follow Task 1): server/providers/doubao.ts's
// speakNavLine must allocate a FRESH TranscriptDelivery per call rather than
// reusing the session's mutable `agentDelivery` binding.
//
// All three clients dedupe agent browser-speech BY DELIVERYID (web
// useHelmetAgent.ts, iOS AgentSession.swift, Android AgentSession.kt). The
// canonical flow already consumes agentDelivery's deliveryId speaking the
// device-result reconciliation (applyDeviceReconciliation) before any
// reroute can happen, and agentDelivery only rotates on a new rider turn
// (AsrBegin) — an off-route rider hasn't spoken, so it never rotates before
// the reroute line is due. Reusing agentDelivery therefore sends the reroute
// line under an already-spoken deliveryId, which every client silently
// drops (and web additionally merges by turnId, so the line overwrites the
// earlier one in the ride log instead of just vanishing).
//
// Drives the real createDoubaoProvider through a real AgentSessionController
// (mocked upstream `ws` socket) — same harness idiom as
// doubao-camera-frame.test.ts / doubao-watch.test.ts — with the created
// provider instance captured via the providerFactory closure so the test can
// call speakNavLine directly: it has no client-event counterpart of its own
// (server/routing.ts's onRerouteAnnounced calls it straight from the relay's
// own nav-request handling, never from a message the rider's device sends).
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
  return { ...actual, selectVisionProvider: () => ({ mode: "mock" as const, describe: mockDescribeFrame }) };
});

import { createDoubaoProvider } from "../server/providers/doubao";
import type { AgentProvider } from "../server/providers/types";
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

function captureDeviceCommandId(send: ReturnType<typeof vi.fn>, action: string): string {
  const command = clientEvents(send).find((event) => event.type === "device.command" && event.action === action);
  expect(command).toBeDefined();
  return command!.commandId as string;
}

/** Same shape as doubao-camera-frame.test.ts's startEmbeddedSession(), except
 *  the provider instance createDoubaoProvider returns is captured via the
 *  providerFactory closure — AgentSessionController keeps its own provider
 *  reference private, and speakNavLine has no client-event path of its own
 *  for a test to drive it through. */
async function startSession(platform: string) {
  const send = vi.fn();
  const client = { readyState: 1, OPEN: 1, send, close: vi.fn() } as never;
  let capturedProvider!: AgentProvider;
  const providerFactory: ProviderFactory = (c, telemetry) => {
    capturedProvider = createDoubaoProvider(c, silentLog, telemetry);
    return capturedProvider;
  };
  const controller = new AgentSessionController(client, providerFactory, silentLog);

  await controller.handleMessage(
    Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, platform })),
    false
  );
  const upstream = upstreamInstances[upstreamInstances.length - 1];
  upstream.emit("open");
  await upstream.emit("message", jsonFrame(CONNECTION_STARTED, {}));
  upstream.emit("message", jsonFrame(SESSION_STARTED, { dialog_id: "dialog-live" }));
  await controller.handleMessage(Buffer.from(JSON.stringify({ type: "audio.start" })), false);

  return { controller, send, upstream, provider: capturedProvider };
}

afterEach(() => {
  upstreamInstances.length = 0;
  mockDescribeFrame.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  metrics.reset();
});

describe("doubao provider speakNavLine — reroute-line delivery identity", () => {
  it("speaks on a FRESH deliveryId, distinct from a delivery a device-result reconciliation already consumed", async () => {
    stubWeatherFetch();
    // platform "ios": torch.set is unrestricted, and this is one of the three
    // real clients the final-review verdict named as silently dropping the
    // reused-delivery reroute line.
    const { controller, send, upstream, provider } = await startSession("ios");

    // Drive an ordinary device-action turn through to its reconciliation —
    // applyDeviceReconciliation speaks "手电筒开了。" on the session's mutable
    // agentDelivery binding, exactly like navigation.start's own confirmation
    // does via attachNavOkSpeech in the real reroute-preceding flow.
    await riderTurn(upstream, "Max 打开手电筒");
    const commandId = captureDeviceCommandId(send, "torch.set");
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" })),
      false
    );

    const consumed = clientEvents(send)
      .filter((event) => event.type === "transcript")
      .at(-1);
    expect(consumed).toMatchObject({ speaker: "agent", text: "手电筒开了。" });
    const consumedDeliveryId = consumed!.deliveryId as string;

    // An off-route rider has not spoken since — agentDelivery has not
    // rotated. speakNavLine has no client-event path of its own (unlike
    // navigation.start's confirmation, a reroute has no device.command to
    // reconcile — see server/routing.ts's onRerouteAnnounced doc comment),
    // so it is invoked directly, exactly as session-controller.ts's
    // onRerouteAnnounced wiring invokes it.
    expect(provider.speakNavLine).toBeDefined();
    provider.speakNavLine!("已重新规划路线。");

    const rerouteLine = clientEvents(send)
      .filter((event) => event.type === "transcript")
      .at(-1);
    expect(rerouteLine).toMatchObject({
      speaker: "agent",
      text: "已重新规划路线。",
      final: true,
      useBrowserSpeech: true
    });
    // The regression this pins: reusing agentDelivery would make this equal
    // the already-consumed deliveryId, and every client (web/iOS/Android)
    // dedupes agent browser-speech by deliveryId — the line would be
    // silently dropped in production.
    expect(rerouteLine!.deliveryId).not.toBe(consumedDeliveryId);
  });
});
