import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// Regression coverage for the fabrication-guard PROVIDER wiring in
// server/providers/doubao.ts. tests/nav-fabrication-guard.test.ts covers the
// pure decision function (server/nav-fabrication-guard.ts) in isolation; this
// file drives the real socket-facing wiring for the three gaps a review round
// found in that wiring:
//   1. Critical: fabricated AUDIO was never muted locally — only the caption
//      was suppressed, so the rider still heard the fabricated reply.
//   2. Important: the ChatResponse/chatText fallback-to-browser-speech path
//      (the same gap the TTS-fallback timer itself exists to cover) was never
//      inspected — a reply with no TtsSentence events at all could still be
//      read aloud verbatim.
//   3. Important: the honest-line choice read local voice-command bookkeeping
//      (DeviceActivityContext) instead of the relay's actual route state, and
//      could go stale-true — the dangerous direction, since it promises a nav
//      prompt that will never come.
// Same MockWebSocket/frame-injection harness idiom as doubao-wake.test.ts and
// doubao-nav-speech.test.ts.

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

const { routeProviderOverride } = vi.hoisted(() => ({
  routeProviderOverride: { current: undefined as unknown }
}));
vi.mock("../server/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/routing")>();
  return {
    ...actual,
    selectRouteProvider: (...args: Parameters<typeof actual.selectRouteProvider>) =>
      routeProviderOverride.current ?? actual.selectRouteProvider(...args)
  };
});

import { createDoubaoProvider } from "../server/providers/doubao";
import type { AgentProvider, ProviderSessionContext, SessionStartEvent } from "../server/providers/types";
import { createMockRouteProvider } from "../server/routing";
import { AgentSessionController, type ProviderFactory } from "../server/session-controller";
import { NO_ROUTE_LINE, ROUTE_ACTIVE_LINE } from "../server/nav-fabrication-guard";

// Doubao server-response event codes (EventReceive is a non-exported const enum).
const CONNECTION_STARTED = 50;
const SESSION_STARTED = 150;
const TTS_SENTENCE_START = 350;
const TTS_RESPONSE = 352;
const TTS_ENDED = 359;
const ASR_INFO = 450;
const ASR_RESPONSE = 451;
const ASR_ENDED = 459;
const CHAT_RESPONSE = 550;
const CHAT_ENDED = 559;
const FULL_SERVER_RESPONSE = 0b1001;
const AUDIO_ONLY_RESPONSE = 0b1011;

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

function audioFrame(pcm: Buffer, sessionId = "s") {
  const header = Buffer.from([0x11, (AUDIO_ONLY_RESPONSE << 4) | 0b0100, 0x00, 0x00]);
  const session = Buffer.from(sessionId);
  return Buffer.concat([header, uint32(TTS_RESPONSE), uint32(session.length), session, uint32(pcm.length), pcm]);
}

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const START_EVENT: SessionStartEvent = {
  sampleRate: 16000,
  channels: 1,
  voiceGender: "female",
  voicePersonality: "concise",
  rideMode: "ride",
  scenario: "commute",
  lat: 1,
  lon: 2
} as SessionStartEvent;

function stubWeatherFetch() {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } }),
    url
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeClient() {
  const send = vi.fn();
  const client = { readyState: 1, OPEN: 1, bufferedAmount: 0, send, close: vi.fn() } as never;
  return { client, send };
}

/** JSON events the relay pushed to the client. */
function clientEvents(send: Mock): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([data]) => typeof data === "string")
    .map(([data]) => JSON.parse(data as string) as Record<string, unknown>);
}

/** Binary (voice PCM) frames forwarded to the client. */
function forwardedAudio(send: Mock): Buffer[] {
  return send.mock.calls.filter(([data]) => Buffer.isBuffer(data)).map(([data]) => data as Buffer);
}

async function startLiveSession(
  client: unknown,
  context?: ProviderSessionContext
): Promise<{ provider: AgentProvider; upstream: MockWebSocket }> {
  const provider = createDoubaoProvider(client as never, silentLog);
  await provider.start(START_EVENT, context);
  const upstream = upstreamInstances[upstreamInstances.length - 1];
  upstream.emit("open");
  await upstream.emit("message", jsonFrame(CONNECTION_STARTED, {}));
  upstream.emit("message", jsonFrame(SESSION_STARTED, { dialog_id: "dialog-live" }));
  return { provider, upstream };
}

async function riderTurn(upstream: MockWebSocket, text: string) {
  await upstream.emit("message", jsonFrame(ASR_INFO, {}));
  await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text }] }));
  await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
}

afterEach(() => {
  upstreamInstances.length = 0;
  routeProviderOverride.current = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("doubao provider — fabrication guard mutes audio, not just the caption", () => {
  it("stops forwarding further audio once a sentence is flagged, and clears queued client playback", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 现在几点");
    // Audio-leads-text ordering: one chunk is forwarded before the
    // corresponding sentence text proves it fabricated — this relay cannot
    // recall bytes already on the wire, which is exactly why a client-side
    // clear signal is also required.
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
    expect(forwardedAudio(send)).toHaveLength(1);

    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));
    // A second chunk for the same (now-flagged) reply must never reach the client.
    await upstream.emit("message", audioFrame(Buffer.from([5, 6, 7, 8])));
    expect(forwardedAudio(send)).toHaveLength(1);

    // Reuses the exact signal barge-in sends (session-controller.ts's own
    // comment: "an immediate, privacy-safe signal to clear queued playback"),
    // so every client flushes whatever it already has queued before the
    // honest correction's own audio arrives.
    expect(clientEvents(send)).toContainEqual(expect.objectContaining({ type: "status", state: "hearing" }));
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
  });

  it("forwards no audio at all when the fabricated text arrives before any audio", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 现在几点");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));

    expect(forwardedAudio(send)).toHaveLength(0);
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
  });
});

describe("doubao provider — fabrication guard covers the chatText fallback path", () => {
  it("never reads a fabricated chatText-only reply aloud through the TTS-fallback browser-speech path", async () => {
    vi.useFakeTimers();
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 现在几点");
    // TtsSentenceStart/End never arrives at all — the exact gap the
    // TTS-fallback timer exists to cover — so chatText is the only
    // accumulator with anything in it.
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方800米后左转" }));
    await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));

    // Advance well past the fallback delay: if the guard had not inspected
    // chatText, this fires flushPendingAgentText(true) and speaks the
    // fabricated line through the client's own browser TTS.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === "前方800米后左转")).toBe(
      false
    );
    const honestLine = clientEvents(send).find((event) => event.type === "transcript" && event.text === NO_ROUTE_LINE);
    expect(honestLine).toMatchObject({ final: true, useBrowserSpeech: true });
  });

  it("catches fabrication assembled across ChatResponse deltas, not just a single whole chunk", async () => {
    vi.useFakeTimers();
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 还有多远到");
    // ChatResponse deltas are raw, often sub-sentence LLM tokens (unlike
    // TtsSentence's complete-sentence-per-event shape) — split so neither
    // chunk matches the detector alone; only the accumulated chatText does.
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方800" }));
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "米后左转" }));
    await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(
      clientEvents(send).some((event) => event.type === "transcript" && (event.text as string).includes("左转"))
    ).toBe(false);
    const agentTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    expect(agentTranscripts).toHaveLength(1);
    expect(agentTranscripts[0]).toMatchObject({ text: NO_ROUTE_LINE, useBrowserSpeech: true });
  });

  it("leaves a legitimate ChatResponse-only reply untouched (no false positive on the fallback path)", async () => {
    vi.useFakeTimers();
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 你好");
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "你好，" }));
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "有什么可以帮你的。" }));
    await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));
    await vi.advanceTimersByTimeAsync(10_000);

    const agentTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    expect(agentTranscripts).toHaveLength(1);
    expect(agentTranscripts[0]).toMatchObject({ text: "你好，有什么可以帮你的。", useBrowserSpeech: true });
  });
});

describe("doubao provider — honest-line selection reads the supplied route state", () => {
  it("defaults to the no-route line when start() receives no routeActive accessor", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client); // no context passed

    await riderTurn(upstream, "Max 现在几点");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));

    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === NO_ROUTE_LINE)).toBe(true);
  });

  it("speaks the route-active line when the supplied accessor reports a live route", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client, { routeActive: () => true });

    await riderTurn(upstream, "Max 现在几点");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));

    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === ROUTE_ACTIVE_LINE)).toBe(
      true
    );
  });

  it("reads the accessor live on every reply, not a snapshot captured at start()", async () => {
    // routeActiveFromContext is stored as a function reference and called
    // fresh on each guard fire (server/providers/doubao.ts) — a route that
    // starts (or ends) mid-session must be picked up without a new
    // provider.start() call.
    stubWeatherFetch();
    const routeState = { active: false };
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client, { routeActive: () => routeState.active });

    await riderTurn(upstream, "Max 现在几点");
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab-before", text: "前方800米后左转" })
    );
    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === NO_ROUTE_LINE)).toBe(true);

    routeState.active = true;
    await riderTurn(upstream, "Max 现在几点2");
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab-after", text: "再走300米后掉头" })
    );
    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === ROUTE_ACTIVE_LINE)).toBe(
      true
    );
  });

  it("is plumbed end-to-end from the session controller's real route state, not a stale local copy", async () => {
    // Regression pin for the finding this closes: deviceActivity.isActive
    // ("navigation") — the previous source — only reflects navigation.start/
    // stop commands THIS session dispatched by voice, so it never saw this
    // route at all. This drives a REAL route through session-controller.ts's
    // own navHandler, the object it now actually plumbs to the provider.
    routeProviderOverride.current = createMockRouteProvider();
    stubWeatherFetch();
    const send = vi.fn();
    const client = { readyState: 1, OPEN: 1, bufferedAmount: 0, send, close: vi.fn() } as never;
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

    await controller.handleMessage(
      Buffer.from(
        JSON.stringify({
          type: "nav.request",
          commandId: "nav-fab",
          reason: "start",
          origin: { lat: 31.2304, lon: 121.4737 },
          query: "人民广场"
        })
      ),
      false
    );
    await vi.waitFor(() =>
      expect(clientEvents(send).some((event) => event.type === "nav.route" && event.commandId === "nav-fab")).toBe(true)
    );

    await riderTurn(upstream, "Max 还有多远");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));

    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === ROUTE_ACTIVE_LINE)).toBe(
      true
    );
    await controller.close();
  });
});
