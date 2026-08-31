import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// End-to-end coverage for the wake-word gate, the follow-up window chain cap,
// streaming captions, the barge-in turn reset, and mid-ride location updates —
// driving createDoubaoProvider with a mock upstream socket like
// doubao-session.test.ts does.

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

import { createDoubaoProvider } from "../server/providers/doubao";
import type { AgentProvider, SessionStartEvent } from "../server/providers/types";

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

function clientFrameEvent(frame: unknown): number | undefined {
  return Buffer.isBuffer(frame) && frame.length >= 8 ? frame.readUInt32BE(4) : undefined;
}

function clientFramePayload(frame: unknown): Record<string, unknown> {
  if (!Buffer.isBuffer(frame)) return {};
  const sessionLength = frame.readUInt32BE(8);
  const payloadLengthOffset = 12 + sessionLength;
  const payloadLength = frame.readUInt32BE(payloadLengthOffset);
  const payloadOffset = payloadLengthOffset + 4;
  return JSON.parse(frame.subarray(payloadOffset, payloadOffset + payloadLength).toString()) as Record<string, unknown>;
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

async function startLiveSession(client: unknown): Promise<{ provider: AgentProvider; upstream: MockWebSocket }> {
  const provider = createDoubaoProvider(client as never, silentLog);
  await provider.start(START_EVENT);
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

async function agentReply(upstream: MockWebSocket, text: string) {
  await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: text }));
  await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { content: text }));
  await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
  await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));
  await upstream.emit("message", jsonFrame(TTS_ENDED, {}));
}

afterEach(() => {
  upstreamInstances.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createDoubaoProvider — cumulative ASR partials", () => {
  it("finalizes the rider turn as the LAST hypothesis, not the concatenated pile", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    // Doubao streams cumulative whole-utterance hypotheses within one turn.
    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    for (const hypothesis of ["Max", "Max 前面", "Max 前面堵吗"]) {
      await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: hypothesis }] }));
    }
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    const riderTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "rider"
    );
    // Three streamed partials plus exactly one final, even when the provider
    // repeats its turn-end signal.
    expect(riderTranscripts).toHaveLength(4);
    expect(riderTranscripts.at(-1)).toMatchObject({ text: "Max 前面堵吗", final: true });
    expect(new Set(riderTranscripts.map((event) => event.turnId)).size).toBe(1);
    expect(new Set(riderTranscripts.map((event) => event.deliveryId)).size).toBe(1);
    expect(riderTranscripts[0]?.turnId).toEqual(expect.any(String));
    expect(riderTranscripts[0]?.deliveryId).toEqual(expect.any(String));
    // Regression: appending the cumulative hypotheses produced "Max Max 前面 …".
    expect(riderTranscripts.at(-1)?.text).not.toContain("Max Max");

    await provider.close();
  });

  it("reconnects the realtime voice session when Doubao never ends an ASR turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 帮我导航" }] }));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(upstream.readyState).toBe(MockWebSocket.OPEN);
    expect(upstreamInstances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(upstream.readyState).toBe(MockWebSocket.CLOSED);
    expect(clientEvents(send)).toContainEqual(expect.objectContaining({ type: "status", state: "connecting" }));

    await vi.advanceTimersByTimeAsync(500);
    expect(upstreamInstances).toHaveLength(2);

    await provider.close();
  });
});

describe("createDoubaoProvider — wake-word gating", () => {
  it("suppresses voice audio and the agent transcript when the rider did not address Max", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);
    const memoryEventsBeforeTurn = clientEvents(send).filter((event) => event.type === "session.memory").length;

    await riderTurn(upstream, "今天天气怎么样");
    await agentReply(upstream, "今天晴，气温二十一度。");

    expect(forwardedAudio(send)).toHaveLength(0);
    const events = clientEvents(send);
    const agentTranscripts = events.filter((event) => event.type === "transcript" && event.speaker === "agent");
    expect(agentTranscripts).toHaveLength(0);
    expect(events.filter((event) => event.type === "transcript" && event.speaker === "rider")).toHaveLength(0);
    // Background speech must not update the durable-memory event stream either.
    expect(events.filter((event) => event.type === "session.memory")).toHaveLength(memoryEventsBeforeTurn);
    // The suppressed turn ends back at "listening" (not a TTS-fallback warning)
    // and must not pollute latency telemetry.
    expect(events.at(-1)).toMatchObject({ type: "status", state: "listening" });
    expect(events.some((event) => event.type === "telemetry")).toBe(false);

    await provider.close();
  });

  it("answers when addressed by name, streaming live captions before the final transcript", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 前面路况怎么样");
    await agentReply(upstream, "前方畅通。");

    expect(forwardedAudio(send)).toHaveLength(1);
    const agentTranscripts = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent"
    );
    // One streamed caption (non-final) from TtsSentenceStart, one final flush at TtsEnded.
    expect(agentTranscripts).toEqual([
      expect.objectContaining({ text: "前方畅通。", final: false }),
      expect.objectContaining({ text: "前方畅通。", final: true })
    ]);
    expect(agentTranscripts[0]?.turnId).toBe(agentTranscripts[1]?.turnId);
    expect(agentTranscripts[0]?.deliveryId).toBe(agentTranscripts[1]?.deliveryId);

    await provider.close();
  });

  it("does not suppress a reply that starts before cumulative ASR discovers the wake phrase", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    // The model starts generating while ASR still has an incomplete hypothesis.
    // This used to latch the whole reply as unaddressed before the next ASR
    // frame revealed that the rider had in fact said Max.
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方畅通。" }));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 前面路况怎么样" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    await upstream.emit("message", jsonFrame(TTS_SENTENCE_START, { content: "前方畅通。" }));
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
    await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));

    expect(forwardedAudio(send)).toHaveLength(1);
    expect(
      clientEvents(send).filter((event) => event.type === "transcript" && event.speaker === "agent")
    ).toContainEqual(expect.objectContaining({ text: "前方畅通。", final: true }));

    await provider.close();
  });

  it("holds early TTS audio until cumulative ASR proves the rider addressed Max", async () => {
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, { question_id: "q-addressed" }));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "前面" }] }));
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
    expect(forwardedAudio(send)).toHaveLength(0);

    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 前面堵吗" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    expect(forwardedAudio(send)).toHaveLength(1);

    await provider.close();
  });

  it("never reports negative latency when generation overlaps final ASR", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, {}));
    vi.setSystemTime(1_000_050);
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 前面堵吗" }] }));
    vi.setSystemTime(1_000_060);
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方畅通。" }));
    await upstream.emit("message", audioFrame(Buffer.from([1, 2, 3, 4])));
    vi.setSystemTime(1_000_100);
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    vi.setSystemTime(1_000_120);
    await upstream.emit("message", jsonFrame(TTS_ENDED, {}));

    const telemetry = clientEvents(send).find((event) => event.type === "telemetry");
    expect(telemetry).toMatchObject({ thinkMs: 0, firstAudioMs: 0 });
    expect(
      Object.values(telemetry ?? {})
        .filter((value) => typeof value === "number")
        .every((value) => value >= 0)
    ).toBe(true);
    await provider.close();
  });

  it("deletes an unaddressed background turn from provider context", async () => {
    stubWeatherFetch();
    const { client } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, { question_id: "q-background" }));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "今天天气怎么样" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));

    const deletion = upstream.sent.find((frame) => clientFrameEvent(frame) === 514);
    expect(clientFramePayload(deletion)).toEqual({ items: [{ item_id: "q-background" }] });
    await provider.close();
  });

  it("truncates interrupted provider context to the audio likely heard", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let monotonicNow = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    stubWeatherFetch();
    const { client } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await upstream.emit("message", jsonFrame(ASR_INFO, { question_id: "q1" }));
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "Max 介绍一下路线" }] }));
    await upstream.emit("message", jsonFrame(ASR_ENDED, {}));
    await upstream.emit(
      "message",
      jsonFrame(TTS_SENTENCE_START, { question_id: "q1", reply_id: "reply-1", content: "先直行。" })
    );
    await upstream.emit("message", audioFrame(Buffer.alloc(48_000))); // one second of PCM24k mono
    vi.setSystemTime(1_000_600);
    monotonicNow = 1_600;
    await upstream.emit("message", jsonFrame(ASR_INFO, { question_id: "q2" }));

    const truncation = upstream.sent.find((frame) => clientFrameEvent(frame) === 513);
    expect(clientFramePayload(truncation)).toEqual({
      item_id: "reply-1",
      audio_end_ms: 250
    });
    await provider.close();
  });

  it("does not clip a reply whose first token lands after the window closes", async () => {
    // Regression: the addressed/suppressed decision is latched when the rider's
    // ASR is classified, NOT re-derived from the wall clock when the agent's
    // first frame arrives. A slow first token (big prompt / bad link) must not
    // drop a reply the rider explicitly addressed.
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 前面路况怎么样"); // addressed at t0; window = t0 + 12 s
    vi.setSystemTime(t0 + 13_000); // first token arrives AFTER addressedUntil
    await agentReply(upstream, "前方畅通。");

    // Latched-at-ASR means the reply still goes through.
    expect(forwardedAudio(send)).toHaveLength(1);

    await provider.close();
  });

  it("answers follow-up turns inside the window without the name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 帮我导航回家");
    await agentReply(upstream, "已设置回家路线。");

    vi.setSystemTime(1_000_000 + 8_000); // inside the 12 s follow-up window
    await riderTurn(upstream, "大概要多久");
    await agentReply(upstream, "预计二十五分钟。");

    expect(forwardedAudio(send)).toHaveLength(2);

    await provider.close();
  });

  it("caps a follow-up chain at 60 s after the last explicit wake", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    await riderTurn(upstream, "Max 帮我看一下路况");
    await agentReply(upstream, "路况良好。");

    // Continuous chatter every 10 s keeps landing inside the sliding window…
    for (const offsetSec of [10, 20, 30, 40, 50]) {
      vi.setSystemTime(t0 + offsetSec * 1000);
      await riderTurn(upstream, "继续随便聊聊");
      await agentReply(upstream, "好的。");
    }
    // …but the chain cap ends it 60 s after the explicit "Max", even though the
    // last turn (t0+50 s) would have slid an uncapped window to t0+62 s.
    vi.setSystemTime(t0 + 61_000);
    await riderTurn(upstream, "还在随便聊");
    await agentReply(upstream, "好的。");

    // 1 explicit + 5 chatter turns answered; the 61 s turn suppressed.
    expect(forwardedAudio(send)).toHaveLength(6);

    await provider.close();
  });

  it("barge-in cancels the previous turn's TTS fallback instead of muting the new reply", async () => {
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    stubWeatherFetch();
    const { client, send } = makeClient();
    const { provider, upstream } = await startLiveSession(client);

    // Turn 1: text-only reply, no audio yet — ChatEnded arms the fallback timer.
    await riderTurn(upstream, "Max 前面堵吗");
    await upstream.emit("message", jsonFrame(CHAT_RESPONSE, { content: "前方轻微拥堵。" }));
    await upstream.emit("message", jsonFrame(CHAT_ENDED, {}));

    // Rider barges in before any audio arrives.
    vi.setSystemTime(t0 + 1_000);
    await upstream.emit("message", jsonFrame(ASR_INFO, {}));

    // The stale fallback timer must NOT fire and speak turn 1's text.
    await vi.advanceTimersByTimeAsync(10_000);
    const browserSpeech = clientEvents(send).filter(
      (event) => event.type === "transcript" && event.speaker === "agent" && event.useBrowserSpeech === true
    );
    expect(browserSpeech).toHaveLength(0);

    // Turn 2 (inside the follow-up window) gets its real audio through —
    // fallbackSpoke must not have been latched by the stale timer.
    await upstream.emit("message", jsonFrame(ASR_RESPONSE, { results: [{ text: "那走哪条路" }] }));
    await agentReply(upstream, "建议走滨江路。");
    expect(forwardedAudio(send)).toHaveLength(1);

    await provider.close();
  });
});

describe("createDoubaoProvider — mid-ride location updates", () => {
  it("refetches weather immediately after a far move, but not for GPS jitter", async () => {
    const fetchMock = stubWeatherFetch();
    const { client } = makeClient();
    const { provider, upstream } = await startLiveSession(client);
    const initialFetches = fetchMock.mock.calls.length;
    expect(initialFetches).toBe(1); // session-start weather

    // ~1.5 km of drift: coordinates update, but no immediate refetch.
    await provider.updateLocation?.(1.01, 2.01);
    expect(fetchMock.mock.calls.length).toBe(initialFetches);
    const update = upstream.sent.filter((frame) => clientFrameEvent(frame) === 201).at(-1);
    expect(clientFramePayload(update)).toMatchObject({
      dialog: {
        dialog_id: "dialog-live",
        location: { latitude: 1.01, longitude: 2.01 }
      }
    });

    // A genuinely different area (>20 km): refetch right away with new coords.
    await provider.updateLocation?.(2.5, 3.5);
    expect(fetchMock.mock.calls.length).toBe(initialFetches + 1);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("latitude=2.5");

    await provider.close();
  });
});
