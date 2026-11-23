import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionTracer,
  createSpanExporter,
  tracingSettingsFromEnv,
  type OtlpKeyValue,
  type OtlpSpan,
  type SpanExporter,
  type TracingSettings
} from "../server/tracing";

const settings: TracingSettings = {
  endpoint: "https://collector.example/v1/traces",
  headers: { authorization: "Bearer abc" },
  serviceName: "max-test",
  captureContent: false
};

function span(name = "s"): OtlpSpan {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name,
    kind: 1,
    startTimeUnixNano: "1000000",
    endTimeUnixNano: "2000000",
    attributes: [],
    status: { code: 0 },
    events: []
  };
}

function spans(count: number, prefix = "s"): OtlpSpan[] {
  return Array.from({ length: count }, (_, index) => span(`${prefix}${index}`));
}

describe("tracingSettingsFromEnv", () => {
  it("is off without an endpoint", () => {
    expect(tracingSettingsFromEnv({})).toEqual({});
  });

  it("uses the traces endpoint as is", () => {
    const result = tracingSettingsFromEnv({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://tempo:4318/custom",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://other:4318"
    });
    expect(result.settings?.endpoint).toBe("http://tempo:4318/custom");
  });

  it("appends /v1/traces to the general endpoint", () => {
    expect(tracingSettingsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318" }).settings?.endpoint).toBe(
      "http://tempo:4318/v1/traces"
    );
    expect(tracingSettingsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://tempo:4318/" }).settings?.endpoint).toBe(
      "http://tempo:4318/v1/traces"
    );
  });

  it("decodes headers and prefers the traces-specific list", () => {
    const general = tracingSettingsFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://x",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=a%20b, x-team=core,broken,=nokey"
    });
    expect(general.settings?.headers).toEqual({ "api-key": "a b", "x-team": "core" });
    const specific = tracingSettingsFromEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://x",
      OTEL_EXPORTER_OTLP_HEADERS: "a=1",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "b=2"
    });
    expect(specific.settings?.headers).toEqual({ b: "2" });
  });

  it("reads service name and content capture, with defaults", () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://x" };
    expect(tracingSettingsFromEnv(base).settings).toMatchObject({ serviceName: "max-relay", captureContent: false });
    expect(
      tracingSettingsFromEnv({ ...base, OTEL_SERVICE_NAME: "voice", MAX_TRACE_CONTENT: "on" }).settings
    ).toMatchObject({ serviceName: "voice", captureContent: true });
  });

  it("is off when disabled", () => {
    expect(tracingSettingsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://x", OTEL_SDK_DISABLED: "true" })).toEqual({});
  });

  it("reports a problem for a URL that is not http(s)", () => {
    for (const bad of ["ftp://x/y", "not a url", "grpc://collector:4317"]) {
      const result = tracingSettingsFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: bad });
      expect(result.settings).toBeUndefined();
      expect(result.problem).toBeTruthy();
    }
  });
});

describe("createSpanExporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function okFetch() {
    return vi.fn(async (...args: [unknown, RequestInit?]) => {
      void args;
      return new Response("{}", { status: 200 });
    });
  }
  const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

  it("sends the OTLP JSON shape with configured headers", async () => {
    const request = okFetch();
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch, version: "1.2.3" });
    exporter.export([span("one")]);
    await exporter.flush();

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(settings.endpoint);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer abc", "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "max-test" } },
              { key: "service.version", value: { stringValue: "1.2.3" } },
              { key: "telemetry.sdk.name", value: { stringValue: "max-relay" } },
              { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } }
            ]
          },
          scopeSpans: [{ scope: { name: "max.voice", version: "1.2.3" }, spans: [span("one")] }]
        }
      ]
    });
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failedBatches: 0 });
  });

  it("sends after 5 seconds", async () => {
    const request = okFetch();
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export([span()]);
    await vi.advanceTimersByTimeAsync(4900);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(request).toHaveBeenCalledTimes(1);
    expect(exporter.stats().exported).toBe(1);
  });

  it("sends as soon as 128 are queued, at most 512 per request", async () => {
    const request = okFetch();
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export(spans(127));
    expect(request).not.toHaveBeenCalled();
    exporter.export(spans(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    exporter.export(spans(1200));
    await exporter.flush();
    const sizes = request.mock.calls.map((call) => bodyOf(call).resourceSpans[0].scopeSpans[0].spans.length);
    expect(sizes).toEqual([128, 512, 512, 176]);
    expect(exporter.stats().exported).toBe(1328);
  });

  it("drops the oldest spans beyond 4096 and counts them", async () => {
    const request = okFetch();
    const working = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    const names: string[] = [];
    request.mockImplementation(async (_url, init) => {
      for (const s of JSON.parse(init!.body as string).resourceSpans[0].scopeSpans[0].spans) names.push(s.name);
      return new Response("{}", { status: 200 });
    });
    // Queue 4100 without letting the size trigger drain first: block the chain with a pending send.
    let release: () => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response("{}", { status: 200 }));
        })
    );
    working.export(spans(128, "x"));
    await vi.advanceTimersByTimeAsync(0);
    working.export(spans(4100, "y"));
    expect(working.stats().dropped).toBe(4);
    release();
    await working.flush();
    expect(names.filter((name) => name.startsWith("y"))[0]).toBe("y4");
    expect(names.filter((name) => name.startsWith("y"))).toHaveLength(4096);
  });

  it("retries once after a network error, then succeeds", async () => {
    const request = okFetch();
    request.mockRejectedValueOnce(new Error("ECONNRESET"));
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export([span()]);
    const done = exporter.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(request).toHaveBeenCalledTimes(2);
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failedBatches: 0 });
  });

  it("retries on 429 and 5xx, then drops and counts the batch", async () => {
    for (const status of [429, 503]) {
      const request = vi.fn(async () => new Response("no", { status }));
      const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
      exporter.export(spans(3));
      const done = exporter.flush();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(request).toHaveBeenCalledTimes(2);
      expect(exporter.stats()).toEqual({ exported: 0, dropped: 3, failedBatches: 1 });
    }
  });

  it("does not retry other 4xx answers", async () => {
    const request = vi.fn(async () => new Response("no", { status: 400 }));
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export(spans(2));
    await exporter.flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 2, failedBatches: 1 });
  });

  it("aborts a request after 10 seconds", async () => {
    const request = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export([span()]);
    const done = exporter.flush();
    await vi.advanceTimersByTimeAsync(9900);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); // aborted, then the 1 s retry wait
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 1, failedBatches: 1 });
  });

  it("gives a request up after 10 seconds even when it never settles, and goes on to the next batch", async () => {
    // A request that takes no notice of the abort: the exporter is not left waiting on it for good.
    const request = vi.fn(() => new Promise<Response>(() => undefined));
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export([span()]);
    const done = exporter.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 1, failedBatches: 1 });
    // And closing it ends: it is not held by what was never answered.
    exporter.export([span()]);
    const closed = exporter.close();
    await vi.advanceTimersByTimeAsync(21_000);
    await closed;
    expect(exporter.stats().failedBatches).toBe(2);
  });

  it("flush sends what is queued and close stops later exports", async () => {
    const request = okFetch();
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    exporter.export(spans(2));
    await exporter.close();
    expect(request).toHaveBeenCalledTimes(1);
    exporter.export(spans(5));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(exporter.stats()).toEqual({ exported: 2, dropped: 5, failedBatches: 0 });
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const request = vi.fn(() => {
      throw new Error("boom");
    });
    const exporter = createSpanExporter(settings, { request: request as unknown as typeof fetch });
    expect(() => exporter.export(spans(2))).not.toThrow();
    expect(() => exporter.export(undefined as unknown as OtlpSpan[])).not.toThrow();
    const done = exporter.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBeUndefined();
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 2, failedBatches: 1 });
  });

  it("uses injected timers and does not keep the process alive by default", () => {
    const setTimer = vi.fn(() => 7);
    const clearTimer = vi.fn();
    const exporter = createSpanExporter(settings, {
      request: okFetch() as unknown as typeof fetch,
      setTimer,
      clearTimer
    });
    exporter.export([span()]);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5000);
    void exporter.flush();
    expect(clearTimer).toHaveBeenCalledWith(7);

    const unref = vi.spyOn(globalThis, "setTimeout");
    const plain = createSpanExporter(settings, { request: okFetch() as unknown as typeof fetch });
    plain.export([span()]);
    const handle = unref.mock.results[0]!.value as { hasRef?: () => boolean };
    expect(handle.hasRef?.() ?? false).toBe(false);
    unref.mockRestore();
  });
});

// ---------------------------------------------------------------------------

type Harness = {
  tracer: ReturnType<typeof createSessionTracer>;
  exported: OtlpSpan[][];
  advance(ms: number): void;
};

function harness(
  session: Parameters<typeof createSessionTracer>[1] = { sessionId: "sess-1" },
  options: { captureContent?: boolean } = {}
): Harness {
  let time = 1_700_000_000_000;
  let counter = 0;
  const exported: OtlpSpan[][] = [];
  const exporter: SpanExporter = {
    export: (batch) => void exported.push(batch),
    flush: async () => {},
    stats: () => ({ exported: 0, dropped: 0, failedBatches: 0 }),
    close: async () => {}
  };
  const tracer = createSessionTracer(exporter, session, {
    now: () => time,
    randomBytes: (n) => {
      counter += 1;
      const buffer = Buffer.alloc(n);
      buffer.writeUInt32BE(counter, n - 4);
      return buffer;
    },
    ...options
  });
  return { tracer, exported, advance: (ms) => void (time += ms) };
}

function attrs(s: OtlpSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of s.attributes as OtlpKeyValue[]) {
    out[key] = Object.values(value)[0];
  }
  return out;
}

const say = (speaker: "rider" | "agent", text: string, turnId: string, final = true) => ({
  type: "transcript",
  speaker,
  text,
  turnId,
  final
});
const status = (state: string) => ({ type: "status", state, detail: "" });

describe("createSessionTracer", () => {
  it("turns a conversation into a span tree", () => {
    const { tracer, exported, advance } = harness({
      sessionId: "sess-1",
      backend: "openai",
      userId: "user-9",
      channel: "phone",
      assistant: "Max"
    });
    tracer.event({ type: "session.started", provider: "ignored", mode: "live" });
    tracer.event(status("listening"));
    advance(100);
    tracer.event(status("hearing"));
    tracer.event(say("rider", "What is my order", "u1", false));
    advance(500);
    tracer.event(say("rider", "What is my order status?", "u1"));
    tracer.event(status("thinking"));
    advance(200);
    tracer.event({ type: "tool.activity", callId: "c1", name: "get_order_status", where: "server", state: "started" });
    advance(300);
    tracer.event({
      type: "tool.activity",
      callId: "c1",
      name: "get_order_status",
      where: "server",
      state: "succeeded",
      durationMs: 295
    });
    tracer.event(status("speaking"));
    advance(400);
    tracer.event({ type: "telemetry", asrMs: 120, thinkMs: 450.5, firstAudioMs: 700, totalMs: 1500 });
    tracer.event(say("agent", "It shipped yesterday.", "a1"));
    tracer.event(status("listening"));
    advance(1000);

    // Second turn: interrupted while speaking.
    tracer.event(say("rider", "Where is it now", "u2"));
    tracer.event(status("thinking"));
    tracer.event(status("speaking"));
    advance(300);
    tracer.event(status("hearing"));
    advance(200);
    tracer.event({ type: "error", message: "x".repeat(400) });
    advance(100);
    tracer.end("client closed");

    expect(exported).toHaveLength(1);
    const all = exported[0]!;
    expect(all.map((s) => s.name)).toEqual(["voice.session", "voice.turn", "voice.tool", "voice.turn"]);
    const [session, turn1, tool, turn2] = all as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];

    expect(new Set(all.map((s) => s.traceId)).size).toBe(1);
    expect(session.traceId).toMatch(/^[0-9a-f]{32}$/);
    for (const s of all) {
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(s.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(s.endTimeUnixNano));
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
    }
    expect(session.parentSpanId).toBeUndefined();
    expect(turn1.parentSpanId).toBe(session.spanId);
    expect(turn2.parentSpanId).toBe(session.spanId);
    expect(tool.parentSpanId).toBe(turn1.spanId);
    expect(new Set(all.map((s) => s.spanId)).size).toBe(4);

    expect(session.kind).toBe(1);
    expect(tool.kind).toBe(3);
    expect(session.startTimeUnixNano).toBe("1700000000000000000");
    expect(turn1.startTimeUnixNano).toBe("1700000000600000000");
    // Turn 1 closes at the listening status that follows the agent's final transcript.
    expect(turn1.endTimeUnixNano).toBe("1700000001500000000");
    expect(turn2.startTimeUnixNano).toBe("1700000002500000000");
    expect(turn2.endTimeUnixNano).toBe("1700000003100000000");
    expect(session.endTimeUnixNano).toBe("1700000003100000000");

    expect(attrs(session)).toEqual({
      "session.id": "sess-1",
      "voice.channel": "phone",
      "enduser.id": "user-9",
      "gen_ai.agent.name": "Max",
      "voice.backend": "openai",
      "voice.end_reason": "client closed",
      "voice.turns": "2",
      "voice.tool_calls": "1",
      "voice.interruptions": "1",
      "voice.errors": "1"
    });
    // 64-bit integers are strings, doubles are numbers, booleans are booleans.
    const typed = Object.fromEntries(session.attributes.map((a) => [a.key, a.value]));
    expect(typed["voice.turns"]).toEqual({ intValue: "2" });
    expect(typed["session.id"]).toEqual({ stringValue: "sess-1" });

    expect(attrs(turn1)).toEqual({
      "voice.user_chars": "24",
      "voice.agent_chars": "21",
      "voice.latency.asr_ms": "120",
      "voice.latency.think_ms": 450.5,
      "voice.latency.first_audio_ms": "700",
      "voice.latency.total_ms": "1500"
    });
    expect(turn1.attributes.find((a) => a.key === "voice.latency.think_ms")!.value).toEqual({ doubleValue: 450.5 });
    expect(attrs(turn2)).toEqual({ "voice.user_chars": "15", "voice.interrupted": true });
    expect(turn2.attributes.find((a) => a.key === "voice.interrupted")!.value).toEqual({ boolValue: true });

    expect(attrs(tool)).toEqual({
      "gen_ai.tool.name": "get_order_status",
      "gen_ai.tool.call.id": "c1",
      "voice.tool.where": "server",
      "voice.tool.duration_ms": "295"
    });
    expect(tool.status).toEqual({ code: 1 });

    expect(turn2.events).toHaveLength(1);
    expect(turn2.events[0]!.name).toBe("relay.error");
    expect(turn2.events[0]!.attributes).toEqual([{ key: "message", value: { stringValue: "x".repeat(300) } }]);
    expect(turn2.events[0]!.timeUnixNano).toBe("1700000003000000000");
  });

  it("keeps what was said off spans unless captureContent is on", () => {
    const events = [
      say("rider", "my secret", "u1"),
      { type: "tool.activity", callId: "c", name: "t", state: "started", args: { password: "hunter2" } },
      say("agent", "noted", "a1")
    ];
    const off = harness();
    events.forEach((e) => off.tracer.event(e));
    off.tracer.end();
    const offJson = JSON.stringify(off.exported[0]);
    expect(offJson).not.toContain("my secret");
    expect(offJson).not.toContain("hunter2");
    expect(offJson).not.toContain("voice.user_text");

    const on = harness({ sessionId: "s" }, { captureContent: true });
    events.push(say("rider", "y".repeat(2500), "u2"));
    events.forEach((e) => on.tracer.event(e));
    on.tracer.end();
    const turns = on.exported[0]!.filter((s) => s.name === "voice.turn");
    expect(attrs(turns[0]!)["voice.user_text"]).toBe("my secret");
    expect(attrs(turns[0]!)["voice.agent_text"]).toBe("noted");
    expect(attrs(turns[1]!)["voice.user_text"]).toBe("y".repeat(2000));
    expect(attrs(turns[1]!)["voice.user_chars"]).toBe("2500");
    expect(JSON.stringify(on.exported[0])).not.toContain("hunter2");
  });

  it("parents a tool with no open turn to the session, and records failures", () => {
    const { tracer, exported, advance } = harness();
    tracer.event({ type: "tool.activity", callId: "c1", name: "lookup", where: "client", state: "started" });
    advance(50);
    tracer.event({ type: "tool.activity", callId: "c1", name: "lookup", state: "failed", error: "timed out" });
    tracer.end();
    const [session, tool] = exported[0]! as [OtlpSpan, OtlpSpan];
    expect(tool.parentSpanId).toBe(session.spanId);
    expect(tool.status).toEqual({ code: 2, message: "timed out" });
    expect(attrs(tool)["voice.tool.duration_ms"]).toBe("50");
    expect(attrs(session)["voice.tool_calls"]).toBe("1");
  });

  it("closes a tool still open at the end with an error", () => {
    const { tracer, exported, advance } = harness();
    tracer.event(say("rider", "hi", "u1"));
    tracer.event({ type: "tool.activity", callId: "c1", name: "slow", state: "started" });
    advance(1000);
    tracer.end("gone");
    const tool = exported[0]!.find((s) => s.name === "voice.tool")!;
    expect(tool.status).toEqual({ code: 2, message: "session ended" });
    expect(tool.endTimeUnixNano).toBe(exported[0]![0]!.endTimeUnixNano);
    expect(attrs(tool)["voice.tool.duration_ms"]).toBe("1000");
  });

  it("puts an error with no turn open on the session and uses provider as backend fallback", () => {
    const { tracer, exported } = harness();
    tracer.event({ type: "session.started", provider: "mock" });
    tracer.event({ type: "error", message: "bad frame" });
    tracer.end();
    const session = exported[0]![0]!;
    expect(session.events.map((e) => e.name)).toEqual(["relay.error"]);
    expect(attrs(session)["voice.backend"]).toBe("mock");
    expect(attrs(session)["voice.errors"]).toBe("1");
  });

  it("does not count hearing as an interruption unless the reply was being spoken", () => {
    const { tracer, exported } = harness();
    tracer.event(say("rider", "hi", "u1"));
    tracer.event(status("thinking"));
    tracer.event(status("hearing"));
    tracer.event(status("speaking"));
    tracer.event(say("agent", "hello", "a1"));
    tracer.event(status("hearing"));
    tracer.end();
    expect(attrs(exported[0]![0]!)["voice.interruptions"]).toBe("0");
    expect(attrs(exported[0]![1]!)["voice.interrupted"]).toBeUndefined();
  });

  it("applies a telemetry event that arrives just after the turn closed", () => {
    const { tracer, exported } = harness();
    tracer.event(say("rider", "hi", "u1"));
    tracer.event(say("agent", "hello", "a1"));
    tracer.event(status("listening"));
    tracer.event({ type: "telemetry", totalMs: 900 });
    tracer.end();
    expect(attrs(exported[0]![1]!)["voice.latency.total_ms"]).toBe("900");
  });

  it("ignores unknown and malformed events", () => {
    const { tracer, exported } = harness();
    for (const junk of [
      null,
      undefined,
      "text",
      42,
      [],
      {},
      { type: 5 },
      { type: "mystery" },
      { type: "transcript", final: true, speaker: "rider" },
      { type: "transcript", final: true, speaker: "rider", text: "   " },
      { type: "transcript", final: true, speaker: "other", text: "x" },
      { type: "tool.activity", state: "started" },
      { type: "tool.activity", callId: "c", state: "succeeded", name: "t" },
      { type: "telemetry", asrMs: "fast" },
      { type: "status", state: 3 }
    ]) {
      expect(() => tracer.event(junk)).not.toThrow();
    }
    tracer.end();
    expect(exported[0]).toHaveLength(1);
    expect(attrs(exported[0]![0]!)).toMatchObject({ "voice.turns": "0", "voice.tool_calls": "0", "voice.errors": "0" });
  });

  it("exports once when end is called twice, and ignores events afterwards", () => {
    const { tracer, exported } = harness();
    tracer.end("first");
    tracer.end("second");
    tracer.event(say("rider", "late", "u1"));
    tracer.end();
    expect(exported).toHaveLength(1);
    expect(attrs(exported[0]![0]!)["voice.end_reason"]).toBe("first");
  });

  it("never throws even when the exporter does", () => {
    const exporter = {
      export: () => {
        throw new Error("nope");
      }
    } as unknown as SpanExporter;
    const tracer = createSessionTracer(exporter, { sessionId: "s" });
    expect(() => tracer.end()).not.toThrow();
  });

  it("caps spans per session and counts the rest", () => {
    const { tracer, exported } = harness();
    for (let index = 0; index < 2500; index += 1) {
      tracer.event(say("rider", `turn ${index}`, `u${index}`));
    }
    tracer.end();
    const all = exported[0]!;
    expect(all).toHaveLength(2000);
    const session = all[0]!;
    expect(attrs(session)["voice.spans_dropped"]).toBe("501");
    expect(attrs(session)["voice.turns"]).toBe("2500");
  });
});
