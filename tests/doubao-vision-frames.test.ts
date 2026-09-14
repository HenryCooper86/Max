import { afterEach, describe, expect, it, vi } from "vitest";

// V-B Task 4 coverage for the doubao provider's visionFrames() — the
// gallery.describe counterpart of doubao-camera-frame.test.ts's camera.look
// coverage. Same harness: a real AgentSessionController wired to the real
// createDoubaoProvider (mocked upstream `ws` socket), selectVisionProvider
// mocked at the module boundary so describe() is a controllable stub. See
// doubao-camera-frame.test.ts's top-of-file comment for why the mock targets
// server/vision's selectVisionProvider rather than a stubbed global fetch.
//
// gallery.describe is gated to the "ios" platform (device-actions.ts's
// PLATFORM_RESTRICTED_ACTIONS), so sessions here start with platform "ios"
// instead of camera-frame's "embedded".
//
// Deviation from the brief's literal contract-1 assertion, called out
// up front: the brief's pseudocode asks for `describe` to be called with
// question "里面有什么". V-A's matchGalleryDescribe (server/device-actions.ts,
// locked in by tests/device-actions.test.ts) always captures the WHOLE
// triggering utterance as the question — e.g. `extractDeviceCommand("刚才录的
// 视频里有什么")` yields `question: "刚才录的视频里有什么"`, never a shorter
// extracted sub-phrase — and the gallery reference ("我刚拍的…") that
// `matchGalleryDescribe` requires before it will look at the question at all
// must appear in that SAME utterance. So no dispatched utterance can produce
// a bare "里面有什么" as the captured question; the two-turn wake + follow-up
// technique below (mirroring doubao-camera-frame.test.ts's "threads the
// rider's question" test) is used to strip the leading "Max " the same way
// that test strips it, and the resulting captured question is asserted
// exactly as the real grammar produces it.
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

async function startIosSession() {
  const send = vi.fn();
  const client = { readyState: 1, OPEN: 1, send, close: vi.fn() } as never;
  const providerFactory: ProviderFactory = (c, telemetry) => createDoubaoProvider(c, silentLog, telemetry);
  const controller = new AgentSessionController(client, providerFactory, silentLog);

  await controller.handleMessage(
    Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" })),
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

function visionFrameMessage(commandId: string, index: number, total: number, image: string) {
  return Buffer.from(JSON.stringify({ type: "vision.frames", commandId, reason: "gallery", index, total, image }));
}

/** Points describe() at a promise the test controls, so it can prove
 *  behaviour while the "vision call" is still pending — same idiom as
 *  doubao-camera-frame.test.ts's gateDescribeFrame(). */
function gateDescribeFrame() {
  let resolveVision!: (value: string | null) => void;
  const gate = new Promise<string | null>((resolve) => {
    resolveVision = resolve;
  });
  mockDescribeFrame.mockImplementation(() => gate);
  return { resolveVision };
}

afterEach(() => {
  upstreamInstances.length = 0;
  mockDescribeFrame.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  metrics.reset();
});

describe("gallery.describe frame sets thread the question and speak the answer", () => {
  it("assembles two out-of-order chunks, threads the captured question, and speaks the stubbed answer", async () => {
    stubWeatherFetch();
    mockDescribeFrame.mockResolvedValue("前方有一段畅通的道路，路边停着两辆车。");
    const { controller, send, upstream } = await startIosSession();

    // Open the wake window with an explicit "Max", then ask the gallery
    // question as an addressed follow-up with no repeated wake word — same
    // technique doubao-camera-frame.test.ts uses so the captured question is
    // exactly this turn's raw text, not "Max <text>".
    await riderTurn(upstream, "Max 你好");
    await riderTurn(upstream, "我刚拍的视频里面有什么");
    const commandId = captureDeviceCommandId(send, "gallery.describe");

    // Out of order, exactly like the assembler's own "regardless of arrival
    // order" contract (tests/vision-frames.test.ts).
    await controller.handleMessage(visionFrameMessage(commandId, 1, 2, "F1"), false);
    await controller.handleMessage(visionFrameMessage(commandId, 0, 2, "F0"), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDescribeFrame).toHaveBeenCalledTimes(1);
    expect(mockDescribeFrame).toHaveBeenCalledWith(["F0", "F1"], "我刚拍的视频里面有什么");
    expect(
      clientEvents(send).some(
        (event) =>
          event.type === "transcript" &&
          event.speaker === "agent" &&
          event.final === true &&
          event.useBrowserSpeech === false &&
          event.text === "前方有一段畅通的道路，路边停着两辆车。"
      )
    ).toBe(true);

    await controller.close();
  });
});

describe("gallery.describe frame sets that never complete", () => {
  it("speaks 我看不清。once the assembler's 10 s timeout fires, even after device.result already resolved the pending entry", async () => {
    vi.useFakeTimers();
    stubWeatherFetch();
    const { controller, send, upstream } = await startIosSession();

    await riderTurn(upstream, "Max 看看我刚拍的照片");
    const commandId = captureDeviceCommandId(send, "gallery.describe");

    // Realistic wire order (per the brief): the frame chunk arrives first —
    // opening the set and recording it into recentGalleryCommands — and only
    // then does device.result resolve (delete) the pending entry. The 2nd of
    // 2 declared frames never arrives, so the assembler's own 10 s timer is
    // what must eventually fire "我看不清。", using recentGalleryCommands
    // rather than the (by-then-gone) pending entry.
    await controller.handleMessage(visionFrameMessage(commandId, 0, 2, "F0"), false);
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" })),
      false
    );

    vi.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(mockDescribeFrame).not.toHaveBeenCalled();
    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "我看不清。"
      )
    ).toBe(true);

    await controller.close();
  });
});

describe("gallery.describe frame sets keep the ORIGINAL turn's delivery", () => {
  it("speaks the answer against the turn that asked, not a later turn that started while describe() was still pending", async () => {
    stubWeatherFetch();
    const { resolveVision } = gateDescribeFrame();
    const { controller, send, upstream } = await startIosSession();

    await riderTurn(upstream, "Max 你好");
    await riderTurn(upstream, "我刚拍的照片里面有什么");
    const commandId = captureDeviceCommandId(send, "gallery.describe");

    // Single-frame set: the assembler completes synchronously on this one
    // accept() call, capturing THIS turn's agentDelivery into
    // recentGalleryCommands and starting the (gated) describe() call.
    await controller.handleMessage(visionFrameMessage(commandId, 0, 1, "F0"), false);

    // device.result's "我看看…" filler is spoken now, against the same live
    // agentDelivery binding — capture its ids as the ORIGINAL turn's delivery.
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" })),
      false
    );
    const filler = clientEvents(send).find(
      (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "我看看…"
    );
    expect(filler).toBeDefined();
    const originalTurnId = filler!.turnId;
    const originalDeliveryId = filler!.deliveryId;
    expect(originalTurnId).toBeDefined();
    expect(originalDeliveryId).toBeDefined();

    // A brand new rider turn begins and finishes WHILE describe() is still
    // gated open — the same turn machinery a live ride uses reassigns the
    // mutable agentDelivery binding here, exactly the gap the brief's
    // "captured synchronously" requirement exists to survive.
    await riderTurn(upstream, "现在几点了");

    resolveVision("前方有一段畅通的道路。");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const answer = clientEvents(send).find(
      (event) => event.type === "transcript" && event.speaker === "agent" && event.text === "前方有一段畅通的道路。"
    );
    expect(answer).toBeDefined();
    // The spoken answer must carry the ORIGINAL turn's delivery ids, not the
    // new turn's — proving the capture happened at accept time, not at
    // (post-await) speak time.
    expect(answer!.turnId).toBe(originalTurnId);
    expect(answer!.deliveryId).toBe(originalDeliveryId);

    await controller.close();
  });
});

describe("gallery.describe frame sets in flight silence the generic expiry failure", () => {
  it("speaks no generic failure at the 8 s device-result timeout, then exactly one 我看不清 line at the assembler's own 10 s timeout", async () => {
    vi.useFakeTimers();
    stubWeatherFetch();
    const { controller, send, upstream } = await startIosSession();

    await riderTurn(upstream, "Max 看看我刚拍的照片");
    const commandId = captureDeviceCommandId(send, "gallery.describe");

    // Only 1 of 2 declared frames ever arrives, and device.result never
    // arrives either — the frame set is genuinely still "in flight" when the
    // 8 s pendingDeviceCommands watchdog fires.
    await controller.handleMessage(visionFrameMessage(commandId, 0, 2, "F0"), false);

    vi.advanceTimersByTime(8_000);
    await Promise.resolve();

    // The generic "描述照片操作没成功。" (or any other reconciliation) line
    // must not have been spoken — the assembler, not the pending-command
    // watchdog, owns this outcome for a command whose frame set is in flight.
    expect(clientEvents(send).filter((event) => event.type === "transcript" && event.speaker === "agent")).toEqual([]);

    vi.advanceTimersByTime(2_000); // 10 s total: the assembler's own onIncomplete timeout
    await Promise.resolve();

    const agentTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    expect(agentTranscripts).toHaveLength(1);
    expect(agentTranscripts[0].text).toBe("我看不清。");

    await controller.close();
  });
});
