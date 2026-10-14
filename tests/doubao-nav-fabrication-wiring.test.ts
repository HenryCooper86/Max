import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// Regression coverage for the fabrication-guard PROVIDER wiring in
// server/providers/doubao.ts. tests/nav-fabrication-guard.test.ts covers the
// pure decision function (server/nav-fabrication-guard.ts) in isolation; this
// file drives the real socket-facing wiring. Round 1 findings:
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
// Round 2 findings, on the fixes for the above:
//   4. Critical: the client-clear "hearing" status was sent AFTER the honest
//      line's own transcript, not before — every real client's speech stack
//      cancels in-flight playback on that same signal, so it cancelled the
//      correction it was meant to protect.
//   5. Critical (RDK only): the clear signal routed through the mic-gated
//      barge-in path, which a fabrication event (no rider speech) can never
//      corroborate — covered by rdk/agent tsc, not vitest, since RDK has no
//      test suite of its own.
//   6. Important: the guard ran before replyIsAddressed(), so an unaddressed
//      reply could get an unprompted honest-line correction instead of
//      staying silently dropped.
// Round 3 finding, on the fix for #6 — gating the WHOLE guard call on
// replyIsAddressed() (as round 2 did) let fabrication detected during the
// wake-undecided window (riderTurnAddressed false, riderTurnFinalized false)
// escape suppression entirely: inspectForFabrication was skipped, so
// fabricationSuppressed was never set, and the moment a later ASR hypothesis
// added the wake phrase, flushUndecidedTtsAudio() forwarded the buffered
// fabricated audio through forwardTtsAudio with no gate left to stop it.
// server/nav-fabrication-guard.ts now splits detection/suppression
// (inspectSentence — never gated on being addressed) from the audible
// correction (announceIfDetected — called once the caller confirms
// addressed, from every place in doubao.ts a reply's wake decision can
// resolve). See that file's own doc comment for the full invariant.
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
import { NAV_FABRICATION_CLEAR_DETAIL } from "../shared/nav-fabrication";

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
// Client-request event code (EventSend is a non-exported const enum).
const CONVERSATION_DELETE = 514;

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

/** The event code of a binary frame the provider sent TO the upstream socket
 *  (upstream.sent) — buildFullClientRequest's own header shape, same offset
 *  doubao-nav-speech.test.ts's identically-named helper reads. */
function clientFrameEvent(frame: unknown): number | undefined {
  return Buffer.isBuffer(frame) && frame.length >= 8 ? frame.readUInt32BE(4) : undefined;
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
    // tagged with the detail string RDK matches to route it to an
    // unconditional flush (rdk/agent/src/main.ts) rather than its normal
    // mic-corroborated barge-in path.
    expect(clientEvents(send)).toContainEqual(
      expect.objectContaining({ type: "status", state: "hearing", detail: NAV_FABRICATION_CLEAR_DETAIL })
    );
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
  });

  // Regression: every real client's speech stack (web speechSynthesis.
  // cancel(), iOS stopSpeaking(.immediate), Android tts.stop()) aborts
  // in-flight playback on receipt of the SAME "hearing" signal the honest
  // line's own transcript/audio rides behind. Sending the clear signal AFTER
  // the honest line started speaking cancelled the correction itself.
  it("sends the client playback-clear signal BEFORE the honest-line transcript, not after", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 现在几点");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-fab", text: "前方800米后左转" }));

    const events = clientEvents(send);
    // Matched on the specific detail, not just state === "hearing" — AsrInfo's
    // own ordinary barge-in reset (riderTurn's ASR_INFO frame, above) sends an
    // earlier "hearing" status of its own with a different detail, which
    // would otherwise make this assertion pass regardless of the fabrication
    // guard's own signal's real position.
    const clearIndex = events.findIndex(
      (event) => event.type === "status" && event.state === "hearing" && event.detail === NAV_FABRICATION_CLEAR_DETAIL
    );
    const honestLineIndex = events.findIndex((event) => event.type === "transcript" && event.text === NO_ROUTE_LINE);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(honestLineIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeLessThan(honestLineIndex);
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
  it.each([
    { status: "ok", reason: undefined, newerRoute: false, unknownCommand: false, expected: NO_ROUTE_LINE },
    {
      status: "failed",
      reason: "navigation.notActive",
      newerRoute: false,
      unknownCommand: false,
      expected: NO_ROUTE_LINE
    },
    { status: "denied", reason: undefined, newerRoute: false, unknownCommand: false, expected: ROUTE_ACTIVE_LINE },
    { status: "ok", reason: undefined, newerRoute: true, unknownCommand: false, expected: ROUTE_ACTIVE_LINE },
    { status: "ok", reason: undefined, newerRoute: false, unknownCommand: true, expected: ROUTE_ACTIVE_LINE }
  ])(
    "reconciles stopped route state for $status/$reason, newer=$newerRoute, unknown=$unknownCommand",
    async ({ status, reason, newerRoute, unknownCommand, expected }) => {
      routeProviderOverride.current = createMockRouteProvider();
      stubWeatherFetch();
      const { client, send } = makeClient();
      const controller = new AgentSessionController(
        client,
        (socket, telemetry) => createDoubaoProvider(socket, silentLog, telemetry),
        silentLog
      );
      const control = (value: unknown) => controller.handleMessage(Buffer.from(JSON.stringify(value)), false);
      await control({ type: "session.start", sampleRate: 16000, channels: 1, platform: "ios" });
      const upstream = upstreamInstances.at(-1)!;
      upstream.emit("open");
      await upstream.emit("message", jsonFrame(CONNECTION_STARTED, {}));
      upstream.emit("message", jsonFrame(SESSION_STARTED, { dialog_id: "dialog-live" }));
      await control({ type: "audio.start" });
      const plan = async (commandId: string) => {
        await control({
          type: "nav.request",
          commandId,
          reason: "start",
          origin: { lat: 31.2304, lon: 121.4737 },
          query: "人民广场"
        });
        await vi.waitFor(() =>
          expect(clientEvents(send).some((event) => event.type === "nav.route" && event.commandId === commandId)).toBe(
            true
          )
        );
      };
      await plan("first-route");
      await riderTurn(upstream, "Max 停止导航");
      const stop = clientEvents(send).find(
        (event) => event.type === "device.command" && event.action === "navigation.stop"
      );
      expect(stop).toBeDefined();
      if (newerRoute) await plan("new-route");
      await control({ type: "device.result", commandId: unknownCommand ? "unknown" : stop!.commandId, status, reason });
      send.mockClear();
      await riderTurn(upstream, "Max 还有多远");
      await upstream.emit(
        "message",
        jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-after-stop", text: "前方800米后左转" })
      );
      expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === expected)).toBe(true);
      await controller.close();
    }
  );

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

describe("doubao provider — fabrication guard announces only once addressed", () => {
  // Both cases inject the fabricated text WHILE the wake-word decision is
  // still undecided (before ASR_ENDED), then let it resolve NOT addressed.
  // Suppression (inspectForFabrication) still runs unconditionally here — the
  // assertion is that no ANNOUNCEMENT (honest-line transcript) ever fires,
  // because announceIfDetected() is only ever called from a place in
  // doubao.ts where the reply has just resolved (or already was) addressed,
  // and this turn never resolves that way. See the "wake-undecided window"
  // describe block below for the companion property: suppression itself does
  // NOT wait for this same resolution.
  it("stays silent on an unaddressed reply via the TtsSentence path — no unprompted correction", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "今天天气怎么样" }] }));
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-unaddressed", text: "前方800米后左转" })
    );
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && (event.text === NO_ROUTE_LINE || event.text === ROUTE_ACTIVE_LINE)
      )
    ).toBe(false);
  });

  it("stays silent on an unaddressed reply via the chatText path — no unprompted correction", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "今天天气怎么样" }] }));
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方800米后左转" }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    expect(
      clientEvents(send).some(
        (event) => event.type === "transcript" && (event.text === NO_ROUTE_LINE || event.text === ROUTE_ACTIVE_LINE)
      )
    ).toBe(false);
  });
});

describe("doubao provider — suppression does not wait on the wake decision", () => {
  // The Critical regression this round closes: gating the WHOLE guard call
  // on replyIsAddressed() (round 2's fix) let a fabricated sentence detected
  // during the undecided window escape suppression entirely — its audio,
  // buffered by bufferUndecidedTtsAudio, was then forwarded uncaught the
  // moment a later ASR hypothesis added the wake phrase and
  // flushUndecidedTtsAudio() ran, because fabricationSuppressed had never
  // been set. This drives that exact sequence end to end.
  it("suppresses a sentence detected while undecided, then still announces once the decision latches addressed", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    // First hypothesis has not said "Max" yet — riderTurnAddressed is still
    // false and riderTurnFinalized is still false: genuinely undecided, not
    // yet-resolved-unaddressed.
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "帮我导航到人民广场" }] }));

    // Doubao answers — and fabricates — before the wake decision settles.
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-undecided", text: "前方800米后左转" })
    );
    // Its audio arrives while still undecided: bufferUndecidedTtsAudio holds
    // it rather than forwarding it.
    await upstream.emit("message", audioFrame(Buffer.from([9, 9, 9, 9])));
    expect(forwardedAudio(send)).toHaveLength(0);

    // A later cumulative ASR hypothesis adds the wake phrase — the decision
    // latches addressed, and flushUndecidedTtsAudio() reaches the buffered
    // chunk from above.
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 帮我导航到人民广场" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    // The fabricated audio must never reach the client, even after the latch
    // — forwardTtsAudio's fabricationSuppressed gate was already set the
    // instant the sentence was inspected, before the decision resolved.
    expect(forwardedAudio(send)).toHaveLength(0);
    // Nor its text, as a caption or a later flush.
    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === "前方800米后左转")).toBe(
      false
    );
    // But the honest correction — deferred until the decision resolved
    // addressed, since there is no further TtsSentence delta to re-trigger
    // detection — must still reach the rider once it does.
    const honestLine = clientEvents(send).find((event) => event.type === "transcript" && event.text === NO_ROUTE_LINE);
    expect(honestLine).toMatchObject({ final: true, useBrowserSpeech: true });
  });
});

describe("doubao provider — at most one upstream delete per suppressed turn", () => {
  // Regression: the guard's own suppressItem (the reply's own item id) and
  // markCurrentTurnSuppressed (the rider's question item id) both queue a
  // delete for the same QA pair — deleting either side removes the whole
  // pair upstream (see markCurrentTurnSuppressed's own doc comment), so
  // sending both is exactly the second, redundant delete request that
  // comment says a suppressed turn must never generate. Doubao answering a
  // delete of an already-removed item with ErrorInformation is treated as
  // terminal a few lines below (frame.event === EventReceive.ConnectionFailed
  // et al.) and closes the socket — so this is not merely a wasted frame.
  it("sends exactly one ConversationDelete for a turn fabricated while undecided that resolves unaddressed", async () => {
    stubWeatherFetch();
    const { client } = makeClient();
    const { upstream } = await startLiveSession(client);

    // A real, distinct question_id so markCurrentTurnSuppressed (were it not
    // skipped) would queue a DIFFERENT item than the guard's own reply-id —
    // the exact shape of the reported duplicate, not two deletes of the same id.
    await upstream.emit("message", jsonFrame(ASR_INFO, { question_id: "question-dup-delete" }));
    // Never says "Max" at all — this turn resolves unaddressed.
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "帮我导航到人民广场" }] }));

    // Doubao answers — and fabricates — before the wake decision is final.
    // inspectForFabrication runs unconditionally (see the describe block
    // above) and queues+sends its own delete for reply-dup-delete right here.
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-dup-delete", text: "前方800米后左转" })
    );

    // The turn finalizes with no wake phrase ever having arrived — AsrEnded's
    // unaddressed branch calls markCurrentTurnSuppressed(), which must now
    // skip (fabricationSuppressed is already set) rather than queuing
    // question-dup-delete as a second delete for the same pair.
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    const deleteFrames = upstream.sent.filter((frame) => clientFrameEvent(frame) === CONVERSATION_DELETE);
    expect(deleteFrames).toHaveLength(1);
  });
});

describe("doubao provider — a superseded reply's late frame must not contaminate the next turn", () => {
  // Whole-branch-review finding: the replyDecided/!replyAddressed stale-frame
  // gate only fires once the NEW turn has itself been decided. Right after
  // AsrInfo the new turn is undecided (replyDecided is false), so a frame
  // belonging to the PREVIOUS (already-suppressed) reply that Doubao still
  // delivers after the barge-in fell through to the ordinary handlers,
  // reassigned currentReplyId back to the stale id, and — because its text
  // still asserts navigation — tripped inspectForFabrication again. That set
  // fabricationSuppressed for the reply actually in progress, muting the
  // rider's next, entirely legitimate turn and speaking a second,
  // unwarranted honest line on top of it.
  it("does not mute the next turn's legitimate reply when a stale frame from a suppressed prior reply arrives after AsrInfo", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { upstream } = await startLiveSession(client);

    // Turn A: addressed, and fabricates — suppressed and deleted as normal.
    await riderTurn(upstream, "Max 帮我导航到人民广场");
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-A", text: "前方800米后左转" }));
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));

    // Turn B begins — the rider speaks again, superseding turn A.
    await upstream.emit("message", jsonFrame(ASR_INFO, {}));

    // A late frame for turn A's now-superseded reply lands AFTER turn B's
    // AsrInfo (Doubao keeps delivering queued frames for a reply the relay
    // has already moved past). Same reply_id, a second fabricated sentence.
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-A", text: "然后右转进入中山路" }));

    // Turn B resolves as an ordinary addressed turn with a legitimate reply.
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 现在几点" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { reply_id: "reply-B", text: "现在下午三点" }));
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));

    // Turn B's real audio and caption must reach the rider, unmuted.
    expect(forwardedAudio(send)).toHaveLength(1);
    expect(clientEvents(send).some((event) => event.type === "transcript" && event.text === "现在下午三点")).toBe(true);
    // Exactly one honest line for the whole sequence (turn A's), never a
    // second, unwarranted one for turn B's legitimate reply.
    const honestLines = clientEvents(send).filter(
      (event) => event.type === "transcript" && (event.text === NO_ROUTE_LINE || event.text === ROUTE_ACTIVE_LINE)
    );
    expect(honestLines).toHaveLength(1);
  });
});
