// OpenTelemetry tracing for voice sessions. Each conversation becomes one trace
// (a session span, a child span per turn, a child span per tool call) exported
// over OTLP/HTTP with JSON encoding, so an operator can point the relay at any
// collector (Tempo, Jaeger, Honeycomb, Langfuse, Datadog...) and see per-turn
// latency. The JSON is written by hand: the OpenTelemetry SDK would add a large
// dependency tree to a relay whose only need is "POST some spans".
//
// Tracing is observability, never a dependency of the call. Nothing here may
// throw into a voice session, block it, or grow without bound.

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { createLogger } from "./logger";

const log = createLogger("tracing");

// ---------------------------------------------------------------------------
// OTLP JSON shapes. The encoding rules differ from protobuf-JSON defaults:
// trace and span ids are lower-case hex (not base64), 64-bit integers and
// timestamps are decimal strings, and enums are integers.
// ---------------------------------------------------------------------------

type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 = INTERNAL, 3 = CLIENT. */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  /** 0 = unset, 1 = ok, 2 = error. */
  status: { code: number; message?: string };
  events: { timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }[];
};

const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type TracingSettings = {
  /** Full URL of the traces endpoint. */
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  /** Put what was said (transcripts, tool names are always included; tool arguments never) on spans. Off by default. */
  captureContent: boolean;
};

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The OTLP spec's `k=v,k2=v2` header list; values are URL-encoded. */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    if (!name) continue;
    headers[name] = decodeComponent(part.slice(at + 1).trim());
  }
  return headers;
}

/**
 * Reads the standard OpenTelemetry variables so operators need no Max-specific
 * setup: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (used as is) else
 * OTEL_EXPORTER_OTLP_ENDPOINT (`/v1/traces` appended); the matching *_HEADERS;
 * OTEL_SERVICE_NAME; OTEL_SDK_DISABLED=true. MAX_TRACE_CONTENT=on adds what was
 * said to spans. Returns no settings when tracing is off, and a `problem` when
 * an endpoint is set but unusable (so the relay can warn instead of silently
 * exporting nowhere).
 */
export function tracingSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  settings?: TracingSettings;
  problem?: string;
} {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return {};
  const tracesEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  let endpoint: string;
  if (tracesEndpoint) endpoint = tracesEndpoint;
  else if (baseEndpoint) endpoint = `${baseEndpoint.replace(/\/+$/, "")}/v1/traces`;
  else return {};

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { problem: "The OpenTelemetry endpoint is not a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { problem: "The OpenTelemetry endpoint must start with http:// or https://." };
  }

  const headers = parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim() || env.OTEL_EXPORTER_OTLP_HEADERS);
  return {
    settings: {
      endpoint,
      headers,
      serviceName: env.OTEL_SERVICE_NAME?.trim() || "max-relay",
      captureContent: env.MAX_TRACE_CONTENT?.trim().toLowerCase() === "on"
    }
  };
}

// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 5000;
const BATCH_TRIGGER = 128;
const MAX_BATCH = 512;
const MAX_QUEUE = 4096;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type SpanExporter = {
  /** Queues finished spans. Never throws. */
  export(spans: OtlpSpan[]): void;
  /** Sends what is queued now; resolves when done (for shutdown). */
  flush(): Promise<void>;
  /** Counters for /metrics. */
  stats(): { exported: number; dropped: number; failedBatches: number };
  close(): Promise<void>;
};

type TimerHandle = unknown;

export type SpanExporterOptions = {
  request?: typeof fetch;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Reported as `service.version` and the instrumentation scope version. */
  version?: string;
  /** False: a failed request is not tried again (a one-off test export). Default true. */
  retry?: boolean;
};

function stringAttr(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}

/**
 * Batches spans and POSTs them: every 5 s or as soon as 128 are queued; at most
 * 512 per request; the queue holds at most 4096 spans and drops the oldest
 * beyond that (a dead collector must not eat the relay's memory); one retry
 * after 1 s on a network error, 429 or 5xx, then the batch is dropped and
 * counted; 10 s request timeout; the timer is unref'd so it never keeps the
 * process alive.
 */
export function createSpanExporter(settings: TracingSettings, options: SpanExporterOptions = {}): SpanExporter {
  const request = options.request ?? ((input, init) => fetch(input, init));
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number): TimerHandle => {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as NodeJS.Timeout));
  const version = options.version ?? "0";
  const retries = options.retry !== false;

  let queue: OtlpSpan[] = [];
  let timer: TimerHandle | undefined;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  const counters = { exported: 0, dropped: 0, failedBatches: 0 };

  function body(spans: OtlpSpan[]): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              stringAttr("service.name", settings.serviceName),
              stringAttr("service.version", version),
              stringAttr("telemetry.sdk.name", "max-relay"),
              stringAttr("telemetry.sdk.language", "nodejs")
            ]
          },
          scopeSpans: [{ scope: { name: "max.voice", version }, spans }]
        }
      ]
    });
  }

  /** One POST. Resolves true on success, false when worth retrying, and throws nothing. */
  async function attempt(payload: string): Promise<{ ok: boolean; retry: boolean; detail: string }> {
    const controller = new AbortController();
    let timeout: TimerHandle | undefined;
    try {
      timeout = setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await request(settings.endpoint, {
        method: "POST",
        headers: { ...settings.headers, "content-type": "application/json" },
        body: payload,
        signal: controller.signal
      });
      try {
        await response.body?.cancel();
      } catch {
        // The body is irrelevant; failing to discard it is not a failed export.
      }
      if (response.status >= 200 && response.status < 300) return { ok: true, retry: false, detail: "" };
      const retry = response.status === 429 || response.status >= 500;
      return { ok: false, retry, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, retry: true, detail: error instanceof Error ? error.message : "request failed" };
    } finally {
      if (timeout !== undefined) {
        try {
          clearTimer(timeout);
        } catch {
          // A broken injected timer must not turn into an exception.
        }
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      try {
        setTimer(resolve, ms);
      } catch {
        resolve();
      }
    });
  }

  async function send(batch: OtlpSpan[]): Promise<void> {
    let payload: string;
    try {
      payload = body(batch);
    } catch {
      counters.dropped += batch.length;
      counters.failedBatches += 1;
      return;
    }
    let result = await attempt(payload);
    if (!result.ok && result.retry && retries) {
      await sleep(RETRY_DELAY_MS);
      result = await attempt(payload);
    }
    if (result.ok) {
      counters.exported += batch.length;
      return;
    }
    counters.dropped += batch.length;
    counters.failedBatches += 1;
    log.warn("trace export failed; batch dropped", { spans: batch.length, detail: result.detail });
  }

  function cancelTimer(): void {
    if (timer === undefined) return;
    try {
      clearTimer(timer);
    } catch {
      // Ignore: see attempt().
    }
    timer = undefined;
  }

  function drain(): Promise<void> {
    cancelTimer();
    chain = chain.then(async () => {
      while (queue.length) {
        const batch = queue.slice(0, MAX_BATCH);
        queue = queue.slice(MAX_BATCH);
        await send(batch);
      }
    });
    return chain;
  }

  function schedule(): void {
    if (timer !== undefined || closed) return;
    try {
      timer = setTimer(() => {
        timer = undefined;
        void drain();
      }, FLUSH_INTERVAL_MS);
    } catch {
      timer = undefined;
    }
  }

  return {
    export(spans) {
      try {
        if (!Array.isArray(spans) || !spans.length) return;
        if (closed) {
          counters.dropped += spans.length;
          return;
        }
        queue.push(...spans);
        if (queue.length > MAX_QUEUE) {
          const excess = queue.length - MAX_QUEUE;
          queue = queue.slice(excess);
          counters.dropped += excess;
        }
        if (queue.length >= BATCH_TRIGGER) void drain();
        else schedule();
      } catch {
        // Tracing never throws into a session.
      }
    },
    flush: () => drain(),
    stats: () => ({ ...counters }),
    async close() {
      closed = true;
      await drain();
    }
  };
}

// ---------------------------------------------------------------------------
// Session tracer
// ---------------------------------------------------------------------------

const MAX_SPANS_PER_SESSION = 2000;
const MAX_CONTENT = 2000;
const MAX_ERROR_MESSAGE = 300;

export type SessionTracer = {
  /** Feed every event the relay sends the client. */
  event(payload: unknown): void;
  /** Ends the session span and hands all spans to the exporter. Idempotent. */
  end(reason?: string): void;
};

export type SessionTraceInfo = {
  sessionId: string;
  backend?: string;
  userId?: string;
  channel?: "web" | "phone";
  assistant?: string;
  /** Further attributes of the session span (a test trace says so here). */
  attributes?: Record<string, string | number | boolean>;
};

export type SessionTracerOptions = {
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  captureContent?: boolean;
};

type AttrValue = string | number | boolean;

type Builder = {
  /** False once the per-session cap was hit: the span still works, but is not exported. */
  kept: boolean;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  endMs?: number;
  attributes: Map<string, AttrValue>;
  status: { code: number; message?: string };
  events: OtlpSpan["events"];
};

type TurnState = {
  span: Builder;
  turnId?: string;
  speaking: boolean;
  agentFinal: boolean;
  hasTelemetry: boolean;
};

type ToolState = { span: Builder; startMs: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toKeyValue(key: string, value: AttrValue): OtlpKeyValue {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  return { key, value: { doubleValue: value } };
}

/** Milliseconds to the decimal nanosecond string OTLP JSON requires for 64-bit timestamps. */
function nanos(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

const hex = (bytes: Buffer): string => bytes.toString("hex");

/**
 * Turns the events the relay sends a client into one trace per session. It sees
 * the same stream as the conversation recorder, so it needs no hooks inside the
 * backends. Spans are collected in memory (bounded) and exported together in
 * `end()`, which keeps a half-finished trace from ever reaching the collector.
 */
export function createSessionTracer(
  exporter: SpanExporter,
  session: SessionTraceInfo,
  options: SessionTracerOptions = {}
): SessionTracer {
  const clock = options.now ?? Date.now;
  const random = options.randomBytes ?? ((n: number) => nodeRandomBytes(n));
  const captureContent = options.captureContent === true;

  const traceId = hex(random(16));
  const builders: Builder[] = [];
  let dropped = 0;
  let ended = false;
  let turn: TurnState | undefined;
  let lastTurn: TurnState | undefined;
  const tools = new Map<string, ToolState>();
  const totals = { turns: 0, toolCalls: 0, interruptions: 0, errors: 0 };
  let backend = session.backend;

  function open(name: string, kind: number, parent: Builder | undefined, startMs: number): Builder {
    const kept = builders.length < MAX_SPANS_PER_SESSION;
    const span: Builder = {
      kept,
      spanId: hex(random(8)),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      kind,
      startMs,
      attributes: new Map(),
      status: { code: 0 },
      events: []
    };
    if (kept) builders.push(span);
    else dropped += 1;
    return span;
  }

  const root = open("voice.session", KIND_INTERNAL, undefined, clock());
  root.attributes.set("session.id", session.sessionId);
  if (session.channel) root.attributes.set("voice.channel", session.channel);
  if (session.userId) root.attributes.set("enduser.id", session.userId);
  if (session.assistant) root.attributes.set("gen_ai.agent.name", session.assistant);
  for (const [key, value] of Object.entries(session.attributes ?? {})) root.attributes.set(key, value);

  function cut(text: string, limit: number): string {
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function closeTurn(at: number): void {
    if (!turn) return;
    turn.span.endMs = at;
    lastTurn = turn;
    turn = undefined;
  }

  function startTurn(text: string, turnId: string | undefined, at: number): void {
    closeTurn(at);
    totals.turns += 1;
    const span = open("voice.turn", KIND_INTERNAL, root, at);
    span.attributes.set("voice.user_chars", text.length);
    if (captureContent) span.attributes.set("voice.user_text", cut(text, MAX_CONTENT));
    turn = { span, ...(turnId ? { turnId } : {}), speaking: false, agentFinal: false, hasTelemetry: false };
  }

  function onTranscript(payload: Record<string, unknown>, at: number): void {
    if (payload.final !== true || typeof payload.text !== "string") return;
    const text = payload.text.trim();
    if (!text) return;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
    if (payload.speaker === "rider") {
      // A repeated final for the turn already open refines it rather than starting a new one.
      if (turn && turnId && turn.turnId === turnId && !turn.agentFinal) {
        turn.span.attributes.set("voice.user_chars", text.length);
        if (captureContent) turn.span.attributes.set("voice.user_text", cut(text, MAX_CONTENT));
        return;
      }
      startTurn(text, turnId, at);
    } else if (payload.speaker === "agent" && turn) {
      turn.agentFinal = true;
      turn.span.attributes.set("voice.agent_chars", text.length);
      if (captureContent) turn.span.attributes.set("voice.agent_text", cut(text, MAX_CONTENT));
    }
  }

  function onStatus(payload: Record<string, unknown>, at: number): void {
    const state = payload.state;
    if (state === "speaking") {
      if (turn) turn.speaking = true;
    } else if (state === "hearing") {
      if (turn?.speaking && !turn.agentFinal && turn.span.attributes.get("voice.interrupted") !== true) {
        turn.span.attributes.set("voice.interrupted", true);
        totals.interruptions += 1;
      }
    } else if ((state === "listening" || state === "ready") && turn?.agentFinal) {
      closeTurn(at);
    }
  }

  function onTelemetry(payload: Record<string, unknown>): void {
    const target = turn ?? (lastTurn && !lastTurn.hasTelemetry ? lastTurn : undefined);
    if (!target) return;
    const fields: [string, string][] = [
      ["asrMs", "voice.latency.asr_ms"],
      ["thinkMs", "voice.latency.think_ms"],
      ["firstAudioMs", "voice.latency.first_audio_ms"],
      ["totalMs", "voice.latency.total_ms"]
    ];
    for (const [field, key] of fields) {
      const value = payload[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) target.span.attributes.set(key, value);
    }
    target.hasTelemetry = true;
  }

  function onTool(payload: Record<string, unknown>, at: number): void {
    const callId = payload.callId;
    if (typeof callId !== "string" || !callId) return;
    if (payload.state === "started") {
      if (typeof payload.name !== "string" || tools.has(callId)) return;
      totals.toolCalls += 1;
      const span = open("voice.tool", KIND_CLIENT, turn?.span ?? root, at);
      span.attributes.set("gen_ai.tool.name", payload.name.slice(0, 120));
      span.attributes.set("gen_ai.tool.call.id", callId.slice(0, 120));
      if (payload.where === "server" || payload.where === "client")
        span.attributes.set("voice.tool.where", payload.where);
      tools.set(callId, { span, startMs: at });
      return;
    }
    if (payload.state !== "succeeded" && payload.state !== "failed") return;
    const tool = tools.get(callId);
    if (!tool) return;
    tools.delete(callId);
    tool.span.endMs = at;
    const duration =
      typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
        ? payload.durationMs
        : at - tool.startMs;
    tool.span.attributes.set("voice.tool.duration_ms", Math.round(duration));
    if (payload.state === "succeeded") tool.span.status = { code: STATUS_OK };
    else {
      const message = typeof payload.error === "string" ? cut(payload.error, MAX_ERROR_MESSAGE) : "";
      tool.span.status = { code: STATUS_ERROR, ...(message ? { message } : {}) };
    }
  }

  function onError(payload: Record<string, unknown>, at: number): void {
    totals.errors += 1;
    const message = typeof payload.message === "string" ? cut(payload.message, MAX_ERROR_MESSAGE) : "";
    const target = turn?.span ?? root;
    if (target.events.length < 50) {
      target.events.push({
        timeUnixNano: nanos(at),
        name: "relay.error",
        attributes: [toKeyValue("message", message)]
      });
    }
  }

  return {
    event(payload) {
      try {
        if (ended || !isRecord(payload)) return;
        const at = clock();
        switch (payload.type) {
          case "session.started":
            if (!backend && typeof payload.provider === "string") backend = payload.provider.slice(0, 80);
            break;
          case "transcript":
            onTranscript(payload, at);
            break;
          case "status":
            onStatus(payload, at);
            break;
          case "telemetry":
            onTelemetry(payload);
            break;
          case "tool.activity":
            onTool(payload, at);
            break;
          case "error":
            onError(payload, at);
            break;
          default:
            break;
        }
      } catch {
        // Tracing never throws into a session.
      }
    },
    end(reason) {
      try {
        if (ended) return;
        ended = true;
        const at = clock();
        closeTurn(at);
        for (const tool of tools.values()) {
          tool.span.endMs = at;
          tool.span.attributes.set("voice.tool.duration_ms", Math.round(at - tool.startMs));
          tool.span.status = { code: STATUS_ERROR, message: "session ended" };
        }
        tools.clear();

        root.endMs = at;
        if (backend) root.attributes.set("voice.backend", backend);
        if (reason) root.attributes.set("voice.end_reason", cut(reason, 120));
        root.attributes.set("voice.turns", totals.turns);
        root.attributes.set("voice.tool_calls", totals.toolCalls);
        root.attributes.set("voice.interruptions", totals.interruptions);
        root.attributes.set("voice.errors", totals.errors);
        if (dropped) root.attributes.set("voice.spans_dropped", dropped);

        const spans: OtlpSpan[] = builders.map((span) => ({
          traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: nanos(span.startMs),
          endTimeUnixNano: nanos(span.endMs ?? at),
          attributes: [...span.attributes].map(([key, value]) => toKeyValue(key, value)),
          status: span.status,
          events: span.events
        }));
        exporter.export(spans);
      } catch {
        // Tracing never throws into a session.
      }
    }
  };
}
