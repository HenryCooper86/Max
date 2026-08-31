import { afterEach, describe, expect, it, vi } from "vitest";

// V-C Task 3 coverage for the doubao provider's watch-frame governing — the
// vision.watch counterpart of doubao-camera-frame.test.ts's camera.look
// coverage and doubao-vision-frames.test.ts's gallery.describe coverage. Same
// harness: a real AgentSessionController wired to the real createDoubaoProvider
// (mocked upstream `ws` socket), selectVisionProvider mocked at the module
// boundary so describe() is a controllable stub. See doubao-camera-frame.test.ts's
// top-of-file comment for why the mock targets server/vision's
// selectVisionProvider rather than a stubbed global fetch.
//
// vision.watch is gated to the "embedded" platform (device-actions.ts's
// PLATFORM_RESTRICTED_ACTIONS), so sessions here start with platform
// "embedded" — the same startEmbeddedSession() shape doubao-camera-frame.test.ts
// uses for camera.look.
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
import { AgentSessionController, type ProviderFactory } from "../server/session-controller";
import { metrics } from "../server/metrics";
import { WATCH_PROMPT } from "../server/vision";

// Doubao server-response event codes (EventReceive is a non-exported const enum).
const CONNECTION_STARTED = 50;
const SESSION_STARTED = 150;
const ASR_INFO = 450;
const ASR_RESPONSE = 451;
const ASR_ENDED = 459;
const TTS_ENDED = 359;
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

function watchFrameMessage(image: string) {
  return Buffer.from(JSON.stringify({ type: "vision.frames", reason: "watch", index: 0, total: 1, image }));
}

async function toggleWatchOn(
  controller: AgentSessionController,
  upstream: InstanceType<typeof MockWebSocket>,
  send: ReturnType<typeof vi.fn>
) {
  await riderTurn(upstream, "Max 开启环境观察");
  const commandId = captureDeviceCommandId(send, "vision.watch");
  await controller.handleMessage(
    Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" })),
    false
  );
  // Doubao's own model still generates a conversational reply to every
  // addressed turn, independent of the device action — close that reply out
  // (no text/audio needed here) the same way a real session's
  // ChatResponse/TtsSentence/TtsEnded cycle eventually would, so the
  // toggle-on turn does not leave awaitingReply (server/providers/doubao.ts)
  // stuck open for whatever the test does next.
  await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
}

afterEach(() => {
  upstreamInstances.length = 0;
  mockDescribeFrame.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  metrics.reset();
});

describe("vision.watch toggled on speaks a watch observation", () => {
  it("describes the watch frame with WATCH_PROMPT and speaks the answer under a FRESH delivery", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有慢车。");
    const { controller, send, upstream } = await startEmbeddedSession();

    await toggleWatchOn(controller, upstream, send);

    const confirmation = clientEvents(send).find(
      (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "已开启环境观察。"
    );
    expect(confirmation).toBeDefined();

    await controller.handleMessage(watchFrameMessage("F"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(mockDescribeFrame).toHaveBeenCalledWith(["F"], WATCH_PROMPT);

    const answer = clientEvents(send).find(
      (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
    );
    expect(answer).toBeDefined();
    expect(answer!.useBrowserSpeech).toBe(true);
    // FRESH delivery: watch lines belong to no rider turn, so they must not
    // carry the toggle-on confirmation's turn/delivery ids.
    expect(answer!.turnId).not.toBe(confirmation!.turnId);
    expect(answer!.deliveryId).not.toBe(confirmation!.deliveryId);

    await controller.close();
  });
});

describe("vision.watch drops a frame while a rider turn is open (speech gate)", () => {
  it("drops the frame — no describe call — and does not queue it once the turn closes", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有慢车。");
    const { controller, send, upstream } = await startEmbeddedSession();

    await toggleWatchOn(controller, upstream, send);

    // Hold a new rider turn open: hearing has started (AsrInfo), but AsrEnded
    // has not fired yet, so the turn never finalizes — the same "turn
    // mid-flight" state a live ride would be in while Max is still listening.
    await upstream.emit("message", jsonFrame(ASR_INFO, {}));

    await controller.handleMessage(watchFrameMessage("F"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(metrics.watchDrops.speech).toBe(1);

    // Close the turn (unaddressed, so it resolves immediately with no reply).
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "随便说点什么" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The dropped frame was never queued: nothing speaks the watch answer
    // after the turn that gated it closes.
    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
      )
    ).toBe(false);

    await controller.close();
  });
});

describe("vision.watch drops a frame while a reply is composing (post-AsrEnded, pre-first-audio)", () => {
  it("drops the frame during the thinking window, then speaks a later frame once the reply resolves", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有慢车。");
    const { controller, send, upstream } = await startEmbeddedSession();

    await toggleWatchOn(controller, upstream, send);

    // A new addressed turn: AsrEnded has fired (riderTurnFinalized = true),
    // but no ChatResponse/TtsSentence/TtsEnded has arrived yet — Doubao is
    // still composing the reply. riderTurnFinalized alone reads
    // speech-CLOSED here; awaitingReply (server/providers/doubao.ts) is what
    // must still gate a watch frame arriving in this exact gap.
    await riderTurn(upstream, "Max 现在几点了");

    await controller.handleMessage(watchFrameMessage("F"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(metrics.watchDrops.speech).toBe(1);
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
      )
    ).toBe(false);

    // The reply resolves (TtsEnded — no real audio arrived, same as an
    // empty/suppressed reply): the thinking window closes and the gate
    // reopens for the next frame.
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));

    await controller.handleMessage(watchFrameMessage("F2"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(mockDescribeFrame).toHaveBeenCalledWith(["F2"], WATCH_PROMPT);
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
      )
    ).toBe(true);

    await controller.close();
  });
});

describe("vision.watch releases the speech gate when the upstream dies mid-reply", () => {
  it("speaks a watch frame after a disconnect + in-place reconnect, instead of staying gated forever", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有慢车。");
    const { controller, send, upstream } = await startEmbeddedSession();

    await toggleWatchOn(controller, upstream, send);

    // Same awaitingReply=true setup as the thinking-window test above:
    // AsrEnded fired, but no ChatResponse/TtsSentence/TtsEnded has arrived.
    await riderTurn(upstream, "Max 现在几点了");

    // The Doubao socket dies before ever delivering that reply — the close
    // handler (server/providers/doubao.ts) must release the gate here, not
    // leave it stuck on a reply that can never arrive on a dead socket.
    upstream.emit("close");

    // In-place reconnect: same real socket-event path doubao-session.test.ts's
    // "revives a dropped upstream in place" uses — real timers, past the
    // ~500 ms first-retry backoff.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const resumedUpstream = upstreamInstances[upstreamInstances.length - 1];
    expect(resumedUpstream).not.toBe(upstream);
    resumedUpstream.emit("open");
    await resumedUpstream.emit("message", jsonFrame(CONNECTION_STARTED, {}));
    resumedUpstream.emit("message", jsonFrame(SESSION_STARTED, { dialog_id: "dialog-resumed" }));

    await controller.handleMessage(watchFrameMessage("F"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Speaks — not dropped as "speech". Before the fix, awaitingReply stayed
    // true across the disconnect/reconnect and this frame would have been
    // silently dropped, unbounded, until the rider's next AsrInfo.
    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(mockDescribeFrame).toHaveBeenCalledWith(["F"], WATCH_PROMPT);
    expect(metrics.watchDrops.speech).toBe(0);
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
      )
    ).toBe(true);

    await controller.close();
  });
});

describe("vision.watch is disabled by default", () => {
  it("never calls describe for a watch frame before any toggle", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有慢车。");
    const { controller, send } = await startEmbeddedSession();

    await controller.handleMessage(watchFrameMessage("F"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(metrics.watchDrops.disabled).toBe(1);
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有慢车。"
      )
    ).toBe(false);

    await controller.close();
  });
});
