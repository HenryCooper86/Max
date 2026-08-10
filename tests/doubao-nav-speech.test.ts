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

const { mockDescribeFrame, synthesizedText, synthesisGates, routeProviderOverride } = vi.hoisted(() => ({
  mockDescribeFrame: vi.fn(),
  synthesizedText: [] as string[],
  synthesisGates: new Map<string, Promise<Buffer>>(),
  routeProviderOverride: { current: undefined as unknown }
}));
vi.mock("../server/vision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/vision")>();
  return { ...actual, selectVisionProvider: () => ({ mode: "mock" as const, describe: mockDescribeFrame }) };
});
vi.mock("../server/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/speech")>();
  return {
    ...actual,
    createSynthesizer: () => async (text: string) => {
      synthesizedText.push(text);
      const gate = synthesisGates.get(text);
      if (gate) return gate;
      return Buffer.from(`pcm:${text}`);
    }
  };
});
vi.mock("../server/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/routing")>();
  return {
    ...actual,
    selectRouteProvider: (...args: Parameters<typeof actual.selectRouteProvider>) =>
      routeProviderOverride.current ?? actual.selectRouteProvider(...args)
  };
});

import { createDoubaoProvider } from "../server/providers/doubao";
import { createMockProvider } from "../server/providers/mock";
import type { AgentProvider } from "../server/providers/types";
import { createMockRouteProvider, type NavPromptSpeech } from "../server/routing";
import { AgentSessionController, type ProviderFactory } from "../server/session-controller";
import { metrics } from "../server/metrics";

// Doubao server-response event codes (EventReceive is a non-exported const enum).
const CONNECTION_STARTED = 50;
const SESSION_STARTED = 150;
const ASR_INFO = 450;
const ASR_RESPONSE = 451;
const ASR_ENDED = 459;
const TTS_SENTENCE_START = 350;
const TTS_RESPONSE = 352;
const TTS_ENDED = 359;
const FULL_SERVER_RESPONSE = 0b1001;

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
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

function clientFrameEvent(frame: unknown): number | undefined {
  return Buffer.isBuffer(frame) && frame.length >= 8 ? frame.readUInt32BE(4) : undefined;
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
  synthesizedText.length = 0;
  synthesisGates.clear();
  routeProviderOverride.current = undefined;
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

  it("also sends reroute success through embedded PCM", async () => {
    stubWeatherFetch();
    const { controller, send, provider } = await startSession("embedded");
    provider.speakNavLine!("已重新规划路线。");
    await vi.waitFor(() => expect(synthesizedText).toContain("已重新规划路线。"));

    expect(
      clientEvents(send).filter((event) => event.type === "transcript" && event.text === "已重新规划路线。")
    ).toHaveLength(1);
    expect(
      send.mock.calls.some(([data, options]) => Buffer.isBuffer(data) && (options as { binary?: boolean })?.binary)
    ).toBe(true);
    await controller.close();
  });
});

describe("doubao provider speakNavPrompt", () => {
  it("uses a fresh transcript delivery and embedded PCM for each prompt", async () => {
    stubWeatherFetch();
    const { controller, send, provider } = await startSession("embedded");
    const speech: NavPromptSpeech = { text: "已到达目的地。", interrupt: false };
    provider.speakNavPrompt!(speech);
    provider.speakNavPrompt!({ text: "手机定位已断开，导航已暂停。", interrupt: false });
    await vi.waitFor(() => expect(synthesizedText).toHaveLength(2));

    const lines = clientEvents(send).filter(
      (event) =>
        event.type === "transcript" &&
        (event.text === "已到达目的地。" || event.text === "手机定位已断开，导航已暂停。")
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ speaker: "agent", final: true, useBrowserSpeech: true });
    expect(lines[1]!.deliveryId).not.toBe(lines[0]!.deliveryId);
    await controller.close();
  });

  it("interrupting prompts truncate the current ordinary reply before speaking", async () => {
    stubWeatherFetch();
    const { controller, upstream, provider } = await startSession("embedded");
    await riderTurn(upstream, "Max 继续导航");
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-live", text: "这是一段正在播放的普通回复。" })
    );
    await upstream.emit("message", jsonFrame(TTS_RESPONSE, { audio: "bytes" }));

    provider.speakNavPrompt!({ text: "右转进入南京东路", interrupt: true });
    await vi.waitFor(() => expect(synthesizedText).toContain("右转进入南京东路"));

    expect(upstream.sent.some((frame) => clientFrameEvent(frame) === 513)).toBe(true);
    await controller.close();
  });

  it("holds non-interrupting prompts behind the ordinary reply", async () => {
    stubWeatherFetch();
    const { controller, send, upstream, provider } = await startSession("embedded");
    await riderTurn(upstream, "Max 现在几点");
    provider.speakNavPrompt!({ text: "已偏离路线，正在重新规划。", interrupt: false });
    await Promise.resolve();
    expect(synthesizedText).not.toContain("已偏离路线，正在重新规划。");
    expect(clientEvents(send).some((event) => event.text === "已偏离路线，正在重新规划。")).toBe(false);

    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
    await vi.waitFor(() => expect(synthesizedText).toContain("已偏离路线，正在重新规划。"));
    expect(clientEvents(send).filter((event) => event.text === "已偏离路线，正在重新规划。")).toHaveLength(1);
    await controller.close();
  });

  it("drops a queued maneuver prompt when it expires before synthesis begins", async () => {
    stubWeatherFetch();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { controller, send, upstream, provider } = await startSession("embedded");
    await riderTurn(upstream, "Max 现在几点");
    provider.speakNavPrompt!({ text: "前方150米，右转进入南京东路", interrupt: false, expiresAt: 4_000 });

    now.mockReturnValue(4_001);
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
    await Promise.resolve();
    await Promise.resolve();

    expect(synthesizedText).not.toContain("前方150米，右转进入南京东路");
    expect(clientEvents(send).some((event) => event.text === "前方150米，右转进入南京东路")).toBe(false);
    await controller.close();
  });

  it("rechecks a newer ordinary reply when a prompt reaches the generated-speech queue head", async () => {
    stubWeatherFetch();
    const occupied = defer<Buffer>();
    synthesisGates.set("占用生成语音。", occupied.promise);
    const { controller, send, upstream, provider } = await startSession("embedded");

    provider.speakNavLine!("占用生成语音。");
    await vi.waitFor(() => expect(synthesizedText).toContain("占用生成语音。"));
    provider.speakNavPrompt!({ text: "已到达目的地。", interrupt: false });
    await riderTurn(upstream, "Max 这是更新的普通回复");

    occupied.resolve(Buffer.from("occupied-pcm"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesizedText).not.toContain("已到达目的地。");
    expect(clientEvents(send).some((event) => event.text === "已到达目的地。")).toBe(false);

    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
    await vi.waitFor(() => expect(synthesizedText).toContain("已到达目的地。"));
    expect(clientEvents(send).filter((event) => event.text === "已到达目的地。")).toHaveLength(1);
    await controller.close();
  });

  it("serializes multiple re-waiting prompts and drops one that expires at the start boundary", async () => {
    stubWeatherFetch();
    const occupied = defer<Buffer>();
    synthesisGates.set("占用生成语音。", occupied.promise);
    const { controller, send, upstream, provider } = await startSession("embedded");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    provider.speakNavLine!("占用生成语音。");
    await vi.waitFor(() => expect(synthesizedText).toContain("占用生成语音。"));
    provider.speakNavPrompt!({ text: "已偏离路线，正在重新规划。", interrupt: false });
    provider.speakNavPrompt!({
      text: "前方150米，右转进入南京东路",
      interrupt: false,
      expiresAt: 1_500
    });
    await riderTurn(upstream, "Max 这是更新的普通回复");

    now.mockReturnValue(1_500);
    occupied.resolve(Buffer.from("occupied-pcm"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesizedText).not.toContain("已偏离路线，正在重新规划。");
    expect(synthesizedText).not.toContain("前方150米，右转进入南京东路");

    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
    await vi.waitFor(() => expect(synthesizedText).toContain("已偏离路线，正在重新规划。"));
    expect(synthesizedText).not.toContain("前方150米，右转进入南京东路");
    expect(clientEvents(send).some((event) => event.text === "前方150米，右转进入南京东路")).toBe(false);
    await controller.close();
  });

  it("drops a prompt released from an ordinary-speech wait after provider close", async () => {
    stubWeatherFetch();
    const { controller, send, upstream, provider } = await startSession("embedded");
    await riderTurn(upstream, "Max 这是关闭前的普通回复");
    provider.speakNavPrompt!({ text: "已到达目的地。", interrupt: false });

    await controller.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(synthesizedText).not.toContain("已到达目的地。");
    expect(clientEvents(send).some((event) => event.text === "已到达目的地。")).toBe(false);
    expect(
      send.mock.calls.some(
        ([data, options]) =>
          Buffer.isBuffer(data) &&
          data.includes(Buffer.from("已到达目的地。")) &&
          (options as { binary?: boolean })?.binary
      )
    ).toBe(false);
  });
});

describe("doubao navigation command deadline", () => {
  it("reschedules after an ordinary timeout and keeps navigation.start pending for twelve seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    stubWeatherFetch();
    const { controller, send, upstream } = await startSession("ios");

    await riderTurn(upstream, "Max 打开手电筒");
    captureDeviceCommandId(send, "torch.set");
    await riderTurn(upstream, "Max 导航去外滩");
    captureDeviceCommandId(send, "navigation.start");

    await vi.advanceTimersByTimeAsync(8_000);
    expect(clientEvents(send).filter((event) => event.text === "手电筒操作没成功。")).toHaveLength(1);
    expect(clientEvents(send).some((event) => event.text === "导航操作没成功。")).toBe(false);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(clientEvents(send).some((event) => event.text === "导航操作没成功。")).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(clientEvents(send).filter((event) => event.text === "导航操作没成功。")).toHaveLength(1);
    await controller.close();
  });

  it("turns an exactly-at-deadline device result into the timeout outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    stubWeatherFetch();
    const { controller, send, upstream } = await startSession("ios");
    await riderTurn(upstream, "Max 拍照");
    const commandId = captureDeviceCommandId(send, "camera.photo");

    vi.setSystemTime(18_000);
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "device.result", commandId, status: "ok" })),
      false
    );

    expect(clientEvents(send).filter((event) => event.text === "拍照操作没成功。")).toHaveLength(1);
    expect(clientEvents(send).some((event) => event.text === "拍好了。")).toBe(false);
    await controller.close();
  });
});

describe("session navigation prompt wiring", () => {
  it("routes one prompt through the session-owned route and mock provider as one transcript line", async () => {
    // This is a relay-wiring test, not an Amap integration test. Keep its route
    // dependency in memory even when the developer's .env has AMAP_API_KEY —
    // otherwise the detached nav request crosses the network and races the
    // test's observable-event wait.
    routeProviderOverride.current = createMockRouteProvider();
    const send = vi.fn();
    const client = { readyState: 1, OPEN: 1, send, close: vi.fn() } as never;
    const controller = new AgentSessionController(client, createMockProvider, silentLog);
    await controller.handleMessage(
      Buffer.from(JSON.stringify({ type: "session.start", sampleRate: 16000, channels: 1, platform: "web" })),
      false
    );
    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "nav.request",
          commandId: "nav-session",
          reason: "start",
          origin: { lat: 31.2304, lon: 121.4737 },
          query: "外滩"
        })
      ),
      false
    );
    await vi.waitFor(() =>
      expect(clientEvents(send).some((event) => event.type === "nav.route" && event.commandId === "nav-session")).toBe(
        true
      )
    );
    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "nav.prompt",
          promptId: "prompt-session",
          routeCommandId: "nav-session",
          kind: "arrived"
        })
      ),
      false
    );

    expect(
      clientEvents(send).filter((event) => event.type === "transcript" && event.text === "已到达目的地。")
    ).toHaveLength(1);
    await controller.close();
  });

  it("drops a fresh reroute completion released after the controller closes", async () => {
    stubWeatherFetch();
    const planned = {
      distanceMeters: 1_000,
      etaSeconds: 300,
      polyline: [
        { lat: 31.23, lon: 121.47 },
        { lat: 31.24, lon: 121.49 }
      ],
      steps: [{ instruction: "右转", lat: 31.24, lon: 121.49, alongRouteMeters: 1_000 }]
    };
    const reroutePlan = defer<typeof planned | null>();
    let planCalls = 0;
    routeProviderOverride.current = {
      mode: "amap" as const,
      resolveDestination: async () => ({ name: "外滩", location: { lat: 31.24, lon: 121.49 } }),
      planRoute: async () => {
        planCalls += 1;
        return planCalls === 1 ? planned : reroutePlan.promise;
      }
    };
    const { controller, send } = await startSession("embedded");
    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "nav.request",
          commandId: "nav-start",
          reason: "start",
          origin: { lat: 31.23, lon: 121.47 },
          query: "外滩"
        })
      ),
      false
    );
    await vi.waitFor(() =>
      expect(clientEvents(send).some((event) => event.type === "nav.route" && event.commandId === "nav-start")).toBe(
        true
      )
    );
    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "nav.request",
          commandId: "reroute-after-close",
          reason: "reroute",
          origin: { lat: 31.23, lon: 121.47 },
          destination: { lat: 31.25, lon: 121.5 },
          destinationName: "新目的地"
        })
      ),
      false
    );
    await vi.waitFor(() => expect(planCalls).toBe(2));

    await controller.close();
    const eventsBeforeRelease = clientEvents(send).length;
    const binaryBeforeRelease = send.mock.calls.filter(([data]) => Buffer.isBuffer(data)).length;
    reroutePlan.resolve(planned);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clientEvents(send)).toHaveLength(eventsBeforeRelease);
    expect(send.mock.calls.filter(([data]) => Buffer.isBuffer(data))).toHaveLength(binaryBeforeRelease);
    expect(synthesizedText).not.toContain("已重新规划路线。");
  });
});
