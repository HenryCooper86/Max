import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationLifecycle, type ConversationLifecycleOptions } from "../server/conversation-lifecycle";
import type { SpanExporter } from "../server/tracing";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-lifecycle-"));
  dirs.push(dir);
  return dir;
}

const HOOK = "https://hooks.example.com/ended";
const MODEL_ENV = { ANALYSIS_LLM_BASE_URL: "https://llm.example.com/v1", ANALYSIS_LLM_MODEL: "tiny" };

// Parsed JSON bodies are read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

function harness(answer?: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; body: Body }[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Body });
    return answer?.(url) ?? new Response("ok", { status: 200 });
  });
  return { request, calls, hooks: () => calls.filter((call) => call.url === HOOK).map((call) => call.body) };
}

const base = (extra: ConversationLifecycleOptions = {}): ConversationLifecycleOptions => ({
  now: () => 1_000,
  ...extra
});

function converse(observer: ReturnType<ReturnType<typeof createConversationLifecycle>["open"]>) {
  observer.event({ type: "session.started", provider: "openai" });
  observer.event({ type: "transcript", speaker: "rider", turnId: "t1", final: true, text: "Hello there" });
  observer.event({ type: "transcript", speaker: "agent", turnId: "a1", final: true, text: "Hi, how can I help?" });
  observer.event({ type: "tool.activity", name: "lookup", state: "succeeded", durationMs: 12 });
}

const info = { sessionId: "sess-1", channel: "web" as const };

describe("createConversationLifecycle configuration", () => {
  it("is inactive with nothing configured", () => {
    const lifecycle = createConversationLifecycle(base({ env: {} }));
    expect(lifecycle.active()).toBe(false);
    expect(lifecycle.problems()).toEqual([]);
    expect(lifecycle.traceStats()).toBeUndefined();
  });

  it("is active with a webhook, a log file, or an exporter", () => {
    expect(createConversationLifecycle(base({ env: { CONVERSATION_WEBHOOK_URL: HOOK } })).active()).toBe(true);
    expect(createConversationLifecycle(base({ env: { CONVERSATION_LOG_FILE: "/tmp/x.log" } })).active()).toBe(true);
  });

  it("reports analysis without a model", () => {
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, analysis: { summary: true, sentiment: false, fields: [] } })
    );
    expect(lifecycle.problems().join("\n")).toMatch(/no model to run it/);
  });

  it("reports analysis whose results go nowhere", () => {
    const lifecycle = createConversationLifecycle(
      base({ env: MODEL_ENV, analysis: { summary: true, sentiment: false, fields: [] } })
    );
    expect(lifecycle.problems().join("\n")).toMatch(/results go nowhere/);
  });

  it("accepts analysis with a model and a destination", () => {
    const lifecycle = createConversationLifecycle(
      base({
        env: { ...MODEL_ENV, CONVERSATION_LOG_FILE: "/tmp/x.log" },
        analysis: { summary: true, sentiment: false, fields: [] }
      })
    );
    expect(lifecycle.problems()).toEqual([]);
  });

  it("reports a bad webhook URL", () => {
    const lifecycle = createConversationLifecycle(base({ env: { CONVERSATION_WEBHOOK_URL: "not a url" } }));
    expect(lifecycle.problems().join("\n")).toMatch(/CONVERSATION_WEBHOOK_URL/);
    expect(lifecycle.active()).toBe(false);
  });
});

describe("conversation delivery", () => {
  it("posts one conversation.ended to the webhook", async () => {
    const h = harness();
    let clock = 1_000;
    const lifecycle = createConversationLifecycle({
      env: { CONVERSATION_WEBHOOK_URL: HOOK },
      request: h.request,
      now: () => clock
    });
    const observer = lifecycle.open({
      ...info,
      userId: "u1",
      phone: { from: "+15551234567", to: "+15557654321" } as never
    });
    converse(observer);
    clock = 31_000;
    observer.end("client");
    await lifecycle.drain(1000);

    const bodies = h.hooks();
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body.type).toBe("conversation.ended");
    expect(body.session).toMatchObject({
      id: "sess-1",
      userId: "u1",
      backend: "openai",
      channel: "web",
      endReason: "client",
      startedAt: 1_000,
      endedAt: 31_000,
      seconds: 30,
      phone: { from: "+15551234567", to: "+15557654321" }
    });
    expect(body.transcript.map((turn: Body) => [turn.speaker, turn.text])).toEqual([
      ["user", "Hello there"],
      ["agent", "Hi, how can I help?"],
      ["tool", "lookup"]
    ]);
    expect(body.analysis).toBeUndefined();
  });

  it("omits optional session fields when not given", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.end();
    await lifecycle.drain(1000);
    const session = h.hooks()[0]!.session as Body;
    expect(session.userId).toBeUndefined();
    expect(session.phone).toBeUndefined();
    expect(session.endReason).toBeUndefined();
  });

  it("uses backend 'unknown' when the session never announced one", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    observer.event({ type: "transcript", speaker: "rider", final: true, text: "hi" });
    observer.end("client");
    await lifecycle.drain(1000);
    expect(h.hooks()[0]!.session.backend).toBe("unknown");
  });

  it("prefers the reason from session.ended over the one passed to end", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.event({ type: "session.ended", reason: "idle" });
    observer.end("client");
    await lifecycle.drain(1000);
    expect(h.hooks()[0]!.session.endReason).toBe("idle");
  });

  it("delivers nothing when the user never spoke", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    observer.event({ type: "session.started", provider: "openai" });
    observer.event({ type: "transcript", speaker: "agent", final: true, text: "Welcome" });
    observer.end("client");
    await lifecycle.drain(1000);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("ignores non-final transcripts", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    observer.event({ type: "transcript", speaker: "rider", final: false, text: "partial" });
    observer.end("client");
    await lifecycle.drain(1000);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("redacts what was said before delivery", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request, redact: ["email"] })
    );
    const observer = lifecycle.open(info);
    observer.event({
      type: "transcript",
      speaker: "rider",
      turnId: "t1",
      final: true,
      text: "Mail me at jane.doe@example.com please"
    });
    observer.end("client");
    await lifecycle.drain(1000);
    const text = h.hooks()[0]!.transcript[0].text as string;
    expect(text).not.toContain("jane.doe@example.com");
    expect(text).toContain("[email]");
  });

  it("takes the call's own numbers out when phone numbers are redacted, and only then", async () => {
    const phone = { direction: "inbound" as const, from: "+15551234567", to: "sip:desk@example.com", callSid: "CA1" };
    const deliver = async (redact: ConversationLifecycleOptions["redact"]) => {
      const h = harness();
      const lifecycle = createConversationLifecycle(
        base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request, redact })
      );
      const observer = lifecycle.open({ sessionId: "sess-1", channel: "phone", phone });
      converse(observer);
      observer.end("caller");
      await lifecycle.drain(1000);
      return h.hooks()[0]!.session.phone as Body;
    };
    expect(await deliver(["phone"])).toEqual({ direction: "inbound", from: "[phone]", to: "[phone]", callSid: "CA1" });
    expect(await deliver(["email"])).toEqual(phone);
  });

  it("delivers once when end is called twice, and ignores events after end", async () => {
    const h = harness();
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.end("client");
    observer.event({ type: "transcript", speaker: "rider", turnId: "late", final: true, text: "too late" });
    observer.event({ type: "session.ended", reason: "late" });
    observer.end("again");
    await lifecycle.drain(1000);
    expect(h.hooks()).toHaveLength(1);
    expect(h.hooks()[0]!.transcript.map((turn: Body) => turn.text)).not.toContain("too late");
    expect(h.hooks()[0]!.session.endReason).toBe("client");
  });

  it("appends one JSON line per conversation to CONVERSATION_LOG_FILE", async () => {
    const file = path.join(tempDir(), "nested", "conversations.jsonl");
    const lifecycle = createConversationLifecycle(base({ env: { CONVERSATION_LOG_FILE: file } }));
    for (const id of ["a", "b"]) {
      const observer = lifecycle.open({ ...info, sessionId: id });
      converse(observer);
      observer.end("client");
      await lifecycle.drain(1000);
    }
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as Body);
    expect(parsed.map((item) => item.session.id)).toEqual(["a", "b"]);
    expect(parsed[0]!.type).toBe("conversation.ended");
  });

  it("still delivers to the webhook when it fails (no throw)", async () => {
    vi.useFakeTimers();
    const h = harness(() => new Response("no", { status: 400 }));
    const lifecycle = createConversationLifecycle(
      base({ env: { CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.end("client");
    await vi.advanceTimersByTimeAsync(0);
    await lifecycle.drain(1000);
    expect(h.request).toHaveBeenCalledTimes(1);
  });
});

describe("conversation analysis", () => {
  const analysis = { summary: true, sentiment: false, fields: [] };
  const chat = (content: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });

  it("adds the analysis to the delivered body", async () => {
    const h = harness((url) =>
      url.endsWith("/chat/completions") ? chat({ summary: "A short greeting." }) : new Response("ok")
    );
    const lifecycle = createConversationLifecycle(
      base({ env: { ...MODEL_ENV, CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request, analysis })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.end("client");
    await lifecycle.drain(1000);
    expect(h.calls.some((call) => call.url === "https://llm.example.com/v1/chat/completions")).toBe(true);
    const body = h.hooks()[0]!;
    expect(body.analysis).toEqual({ summary: "A short greeting." });
    expect(body.analysisError).toBeUndefined();
  });

  it("delivers with analysisError when the model call fails", async () => {
    const h = harness((url) =>
      url.endsWith("/chat/completions") ? new Response("boom", { status: 500 }) : new Response("ok")
    );
    const lifecycle = createConversationLifecycle(
      base({ env: { ...MODEL_ENV, CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request, analysis })
    );
    const observer = lifecycle.open(info);
    converse(observer);
    observer.end("client");
    await lifecycle.drain(1000);
    const body = h.hooks()[0]!;
    expect(body.analysis).toBeUndefined();
    expect(typeof body.analysisError).toBe("string");
    expect(body.transcript).toHaveLength(3);
  });

  it("sends the analysis model only the redacted transcript", async () => {
    const h = harness((url) => (url.endsWith("/chat/completions") ? chat({ summary: "s" }) : new Response("ok")));
    const lifecycle = createConversationLifecycle(
      base({ env: { ...MODEL_ENV, CONVERSATION_WEBHOOK_URL: HOOK }, request: h.request, analysis, redact: ["email"] })
    );
    const observer = lifecycle.open(info);
    observer.event({ type: "transcript", speaker: "rider", final: true, text: "I am bob@example.org" });
    observer.end("client");
    await lifecycle.drain(1000);
    const llm = h.calls.find((call) => call.url.endsWith("/chat/completions"))!;
    expect(JSON.stringify(llm.body)).not.toContain("bob@example.org");
  });
});

describe("tracing", () => {
  it("exports spans including voice.session when the session ends", async () => {
    const exporter = {
      export: vi.fn(),
      flush: vi.fn(async () => undefined),
      stats: vi.fn(() => ({ exported: 0, dropped: 0, failedBatches: 0 })),
      close: vi.fn(async () => undefined)
    } satisfies SpanExporter;
    const lifecycle = createConversationLifecycle(base({ env: {}, exporter }));
    expect(lifecycle.active()).toBe(true);
    expect(lifecycle.traceStats()).toEqual({ exported: 0, dropped: 0, failedBatches: 0 });
    const observer = lifecycle.open({ ...info, assistant: "Max" });
    converse(observer);
    observer.end("client");
    await lifecycle.drain(1000);
    expect(exporter.export).toHaveBeenCalled();
    const spans = exporter.export.mock.calls.flatMap(([batch]) => batch as { name: string }[]);
    expect(spans.map((span) => span.name)).toContain("voice.session");
    expect(exporter.flush).toHaveBeenCalled();
  });
});
