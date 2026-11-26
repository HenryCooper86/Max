import { afterEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the weather-blocks-audio fix: the live-weather fetch
// now runs CONCURRENTLY with the Doubao connection handshake, and mic frames that
// arrive before the session is ready are buffered (not dropped) until StartSession
// completes. These tests drive createDoubaoProvider with a mock upstream socket
// and a manually-gated weather fetch to pin that behaviour.

// Mock the `ws` WebSocket the provider opens upstream. Hoisted so the factory can
// reach the shared instance registry.
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

import { assistantProfileFrom, setAssistantProfileForTests } from "../server/assistant";
import { createDoubaoProvider } from "../server/providers/doubao";
import type { ProviderSessionContext, SessionStartEvent } from "../server/providers/types";
import type { ResumeState } from "../server/session-resume";

// Doubao server-response event codes the provider reacts to during startup.
// (EventReceive is a non-exported const enum, so mirror the two we need here.)
const EVENT_CONNECTION_STARTED = 50;
const EVENT_SESSION_STARTED = 150;
const EVENT_SESSION_FAILED = 153;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** Builds a minimal Doubao FullServerResponse frame for the given event code and JSON payload. */
function serverFrame(event: number, sessionId = "", payload: unknown = {}) {
  const header = Buffer.from([0x11, (MESSAGE_TYPE_FULL_SERVER_RESPONSE << 4) | 0b0100, 0b0001 << 4, 0x00]);
  const session = Buffer.from(sessionId);
  const body = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([header, uint32(event), uint32(session.length), session, uint32(body.length), body]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

afterEach(() => {
  upstreamInstances.length = 0;
  setAssistantProfileForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createDoubaoProvider — concurrent weather + audio buffering", () => {
  it("opens the upstream connection before the weather fetch resolves", async () => {
    // Weather fetch that never resolves during the test: if start() awaited it,
    // the upstream socket would never be constructed.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );

    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);

    // The connection was opened concurrently, not gated behind the (still pending) fetch.
    expect(upstreamInstances).toHaveLength(1);

    await provider.close();
  });

  it("defers StartSession until weather resolves, then folds it into system_role", async () => {
    let resolveWeather!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveWeather = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return {
          ok: true,
          json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
        } as Response;
      })
    );

    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const upstream = upstreamInstances[0];

    upstream.emit("open");
    const sentAfterOpen = upstream.sent.length; // StartConnection

    // ConnectionStarted arrives; the handler awaits the (still-gated) weather.
    const handled = upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    await tick();
    // StartSession must NOT have been sent yet — it waits for the weather addendum.
    expect(upstream.sent.length).toBe(sentAfterOpen);

    resolveWeather();
    await handled;

    // StartSession is now sent and carries the live weather in the system role.
    expect(upstream.sent.length).toBe(sentAfterOpen + 1);
    const startSession = String(upstream.sent[upstream.sent.length - 1]);
    expect(startSession).toContain("实时骑行情报");
    expect(startSession).toContain("21");

    await provider.close();
  });

  it("adds bounded authenticated-user history as explicitly untrusted context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response)
    );
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT, {
      previousConversation: {
        updatedAt: 1,
        turns: [
          { at: 1, speaker: "rider", text: "Remember my destination is Busan" },
          { at: 2, speaker: "agent", text: "I will remember that destination." }
        ],
        facts: [{ at: 1, text: "my destination is Busan" }]
      }
    });
    const upstream = upstreamInstances[0];
    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));

    const startSession = String(upstream.sent.at(-1));
    expect(startSession).toContain("跨会话记忆：同一登录用户的不可信数据");
    expect(startSession).toContain("Remember my destination is Busan");
    expect(startSession).toContain("骑手明确要求长期记住的事实");
    await provider.close();
  });

  it("buffers mic frames sent before the session is ready and flushes them on SessionStarted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
      }))
    );

    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const upstream = upstreamInstances[0];

    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    await tick();

    // Rider starts speaking before the session is ready — a unique byte marker.
    const marker = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await provider.startAudio();
    await provider.sendAudio(marker);
    const sentBeforeReady = upstream.sent.length;

    // SessionStarted flushes the buffered frame upstream instead of dropping it.
    upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(upstream.sent.length).toBeGreaterThan(sentBeforeReady);
    const flushed = upstream.sent
      .slice(sentBeforeReady)
      .some((frame) => Buffer.isBuffer(frame) && frame.includes(marker));
    expect(flushed).toBe(true);

    await provider.close();
  });

  it("drops buffered pre-session frames when the rider stops the mic", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
      }))
    );

    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const upstream = upstreamInstances[0];

    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    await tick();

    // Frames arrive before the session is ready, then the rider mutes the mic.
    const marker = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await provider.startAudio();
    await provider.sendAudio(marker);
    await provider.stopAudio();
    const sentBeforeReady = upstream.sent.length;

    // SessionStarted must not replay the stale frames from the ended stream.
    upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    const replayed = upstream.sent
      .slice(sentBeforeReady)
      .some((frame) => Buffer.isBuffer(frame) && frame.includes(marker));
    expect(replayed).toBe(false);

    await provider.close();
  });

  it("sends EndASR only for push-to-talk sessions", async () => {
    vi.stubEnv("DOUBAO_INPUT_MODE", "push_to_talk");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response)
    );
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const upstream = upstreamInstances[0];
    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    await provider.startAudio();
    await provider.stopAudio();

    expect(
      upstream.sent.some((frame) => Buffer.isBuffer(frame) && frame.length >= 8 && frame.readUInt32BE(4) === 400)
    ).toBe(true);
    await provider.close();
  });

  it("does not send EndASR when keep-alive VAD owns turn boundaries", async () => {
    vi.stubEnv("DOUBAO_INPUT_MODE", "keep_alive");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response)
    );
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const upstream = upstreamInstances[0];
    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    await provider.startAudio();
    await provider.stopAudio();

    expect(
      upstream.sent.some((frame) => Buffer.isBuffer(frame) && frame.length >= 8 && frame.readUInt32BE(4) === 400)
    ).toBe(false);
    await provider.close();
  });

  it("revives a dropped upstream in place and replays the session as a resume", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
      }))
    );

    const clientClose = vi.fn();
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: clientClose } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const first = upstreamInstances[0];

    first.emit("open");
    await first.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    first.emit("message", serverFrame(EVENT_SESSION_STARTED));

    // The Doubao side drops: the relay reconnects in place instead of bouncing
    // the client, so the rider keeps their session.
    first.emit("close");
    expect(clientClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(upstreamInstances).toHaveLength(2);

    // The resumed StartSession replays the context with the resume addendum.
    const second = upstreamInstances[1];
    second.emit("open");
    await second.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    const startSession = String(second.sent[second.sent.length - 1]);
    expect(startSession).toContain("会话恢复");
    expect(startSession).toContain("恢复的短期记忆");

    vi.useRealTimers();
    await provider.close();
  });

  it("closes the client socket only after upstream retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
      }))
    );

    const clientClose = vi.fn();
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: clientClose } as never,
      silentLog
    );
    await provider.start(START_EVENT);

    upstreamInstances[0].emit("open");
    await upstreamInstances[0].emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    upstreamInstances[0].emit("message", serverFrame(EVENT_SESSION_STARTED));

    // Every reconnect attempt dies too (Doubao outage). Walk through the
    // backoff ladder until the retry budget is spent.
    upstreamInstances[0].emit("close");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(clientClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(upstreamInstances).toHaveLength(attempt + 1);
      upstreamInstances[attempt].emit("close");
    }

    // Out of retries: now the client socket is bounced so its own reconnect
    // logic rebuilds a fresh relay session.
    expect(clientClose).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("reconnects when Doubao reports a terminal session failure without closing its socket", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 5, is_day: 1 } })
      }))
    );

    const clientClose = vi.fn();
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: clientClose } as never,
      silentLog
    );
    await provider.start(START_EVENT);
    const first = upstreamInstances[0];
    first.emit("open");
    await first.emit("message", serverFrame(EVENT_CONNECTION_STARTED));

    // The upstream sends SessionFailed but deliberately does not close the
    // transport itself. The provider must close it and enter its retry path.
    first.emit("message", serverFrame(EVENT_SESSION_FAILED));
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(clientClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    expect(upstreamInstances).toHaveLength(2);

    vi.useRealTimers();
    await provider.close();
  });
});

describe("createDoubaoProvider — carrying a conversation across a dropped connection", () => {
  // EventReceive codes of one exchange, mirrored as above.
  const EVENT_ASR_INFO = 450;
  const EVENT_ASR_RESPONSE = 451;
  const EVENT_ASR_ENDED = 459;
  const EVENT_TTS_SENTENCE_START = 350;
  const EVENT_CHAT_RESPONSE = 550;
  const EVENT_CHAT_ENDED = 559;
  const EVENT_TTS_ENDED = 359;
  const APP = assistantProfileFrom({ name: "Ava", device: "app" });

  /** The JSON metadata of a request the relay sent upstream. */
  const metadataOf = (frame: Buffer) => {
    const payloadAt = 12 + frame.readUInt32BE(8);
    const length = frame.readUInt32BE(payloadAt);
    return JSON.parse(frame.subarray(payloadAt + 4, payloadAt + 4 + length).toString()) as {
      dialog: { system_role: string; dialog_context?: { role: string; text: string; timestamp: number }[] };
    };
  };

  /** Opens a session as the relay does, with what a reconnecting client brings. */
  async function open(context: ProviderSessionContext = {}, start: Partial<SessionStartEvent> = {}, live = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response)
    );
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      silentLog
    );
    await provider.start({ ...START_EVENT, ...start }, context);
    const upstream = upstreamInstances[upstreamInstances.length - 1]!;
    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    if (live) await upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    return { provider, upstream };
  }

  /** One exchange: the wearer asks, Doubao answers. */
  async function exchange(
    upstream: { emit(event: string, ...args: unknown[]): unknown },
    question: string,
    answer: string
  ) {
    await upstream.emit("message", serverFrame(EVENT_ASR_INFO));
    await upstream.emit("message", serverFrame(EVENT_ASR_RESPONSE, "", { results: [{ text: question }] }));
    await upstream.emit("message", serverFrame(EVENT_ASR_ENDED));
    await upstream.emit("message", serverFrame(EVENT_CHAT_RESPONSE, "", { content: answer }));
    await upstream.emit("message", serverFrame(EVENT_TTS_SENTENCE_START, "", { content: answer }));
    await upstream.emit("message", serverFrame(EVENT_CHAT_ENDED));
    await upstream.emit("message", serverFrame(EVENT_TTS_ENDED));
  }

  it("gives Doubao the earlier turns of a resumed conversation, and tells it not to greet again", async () => {
    setAssistantProfileForTests(APP);
    const { provider, upstream } = await open(
      {
        resume: {
          history: [
            { speaker: "user", text: "where is my order" },
            { speaker: "agent", text: "It shipped on Monday." },
            { speaker: "user", text: "and when will it arrive" }
          ]
        }
      },
      {},
      false
    );
    const started = metadataOf(upstream.sent.at(-1) as Buffer);
    // Complete pairs only: the API refuses a context with a question that has no answer.
    expect(started.dialog.dialog_context).toEqual([
      { role: "user", text: "where is my order", timestamp: expect.any(Number) },
      { role: "assistant", text: "It shipped on Monday.", timestamp: expect.any(Number) }
    ]);
    expect(started.dialog.system_role).toContain("不要重新自我介绍或重新问候");
    await provider.close();
  });

  it("keeps the turns of a software assistant for a client that reconnects, and none of a wearable's", async () => {
    const saved: ResumeState[] = [];
    const saveResume = (state: ResumeState) => void saved.push(state);
    // The device spots the wake word itself, so whatever is said is addressed.
    const start: Partial<SessionStartEvent> = { audio: { wakeWord: true } };

    setAssistantProfileForTests(APP);
    const app = await open({ saveResume }, start);
    await app.provider.startAudio();
    await exchange(app.upstream, "我的订单呢", "已经发货了。");
    expect(saved.map((state) => state.history)).toEqual([
      [{ speaker: "user", text: "我的订单呢" }],
      [
        { speaker: "user", text: "我的订单呢" },
        { speaker: "agent", text: "已经发货了。" }
      ]
    ]);
    await app.provider.close();

    setAssistantProfileForTests();
    saved.length = 0;
    const wearable = await open({ saveResume }, start);
    await wearable.provider.startAudio();
    await exchange(wearable.upstream, "我的订单呢", "已经发货了。");
    expect(saved).toEqual([]);
    await wearable.provider.close();
  });

  it("starts a wearable's session as a new conversation, whatever turns the resume id brings", async () => {
    const { provider, upstream } = await open(
      {
        resume: {
          history: [
            { speaker: "user", text: "where is my order" },
            { speaker: "agent", text: "It shipped." }
          ]
        }
      },
      {},
      false
    );
    const started = metadataOf(upstream.sent.at(-1) as Buffer);
    expect(started.dialog).not.toHaveProperty("dialog_context");
    expect(started.dialog.system_role).not.toContain("会话恢复");
    await provider.close();
  });
});

describe("createDoubaoProvider — hearing statuses", () => {
  it("marks one of the relay's own truncations with cause relay, and one of the wearer's voice without it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response)
    );
    const sent: Record<string, unknown>[] = [];
    const provider = createDoubaoProvider(
      { readyState: 1, OPEN: 1, send: (data: string) => void sent.push(JSON.parse(data)), close: vi.fn() } as never,
      silentLog
    );
    await provider.start({ ...START_EVENT, platform: "web" });
    const upstream = upstreamInstances[0]!;
    upstream.emit("open");
    await upstream.emit("message", serverFrame(EVENT_CONNECTION_STARTED));
    await upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));
    // Doubao's own detector heard the wearer.
    await upstream.emit("message", serverFrame(450));
    // The relay cuts the reply under way to speak a turn prompt.
    provider.speakNavPrompt!({ text: "前方两百米右转。", interrupt: true } as never);
    expect(sent.filter((event) => event.type === "status" && event.state === "hearing")).toEqual([
      { type: "status", state: "hearing", detail: "豆包检测到骑手语音" },
      { type: "status", state: "hearing", detail: "MAX 正在播报转向提示", cause: "relay" }
    ]);
    await provider.close();
  });
});
