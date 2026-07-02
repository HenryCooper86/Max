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

import { createDoubaoProvider } from "../server/providers/doubao";
import type { SessionStartEvent } from "../server/providers/types";

// Doubao server-response event codes the provider reacts to during startup.
// (EventReceive is a non-exported const enum, so mirror the two we need here.)
const EVENT_CONNECTION_STARTED = 50;
const EVENT_SESSION_STARTED = 150;
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001;

function uint32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** Builds a minimal Doubao FullServerResponse frame for the given event code. */
function serverFrame(event: number, sessionId = "") {
  const header = Buffer.from([0x11, (MESSAGE_TYPE_FULL_SERVER_RESPONSE << 4) | 0b0100, 0b0001 << 4, 0x00]);
  const session = Buffer.from(sessionId);
  const payload = Buffer.from("{}");
  return Buffer.concat([header, uint32(event), uint32(session.length), session, uint32(payload.length), payload]);
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
    await provider.sendAudio(marker);
    const sentBeforeReady = upstream.sent.length;

    // SessionStarted flushes the buffered frame upstream instead of dropping it.
    upstream.emit("message", serverFrame(EVENT_SESSION_STARTED));

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
});
