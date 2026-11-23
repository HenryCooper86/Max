import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  conversationWebhookFromEnv,
  deliverConversation,
  type ConversationEndedPayload
} from "../server/conversation-webhook";

const payload: ConversationEndedPayload = {
  type: "conversation.ended",
  id: "delivery-1",
  session: { id: "s1", backend: "openai", channel: "web", startedAt: 1, endedAt: 61_000, seconds: 60 },
  transcript: [{ at: 1, speaker: "user", text: "hello" }],
  analysis: { summary: "A greeting." }
};
const hook = { url: "https://hooks.example.com/ended?token=querysecret", secret: "whsec_topsecret" };

function harness(...replies: Array<number | Error>) {
  const queue = [...replies];
  const request = vi.fn<typeof fetch>(async () => {
    const next = queue.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response("body", { status: next });
  });
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  return { request, waits, sleep };
}

const headersOf = (request: ReturnType<typeof harness>["request"], call = 0) =>
  request.mock.calls[call]![1]!.headers as Record<string, string>;

describe("conversationWebhookFromEnv", () => {
  it("is empty without a URL", () => expect(conversationWebhookFromEnv({})).toEqual({}));
  it("reads the URL and the secret", () => {
    expect(
      conversationWebhookFromEnv({
        CONVERSATION_WEBHOOK_URL: " https://a.example.com/x ",
        CONVERSATION_WEBHOOK_SECRET: " s "
      })
    ).toEqual({
      webhook: { url: "https://a.example.com/x", secret: "s" }
    });
    expect(conversationWebhookFromEnv({ CONVERSATION_WEBHOOK_URL: "https://a.example.com/x" }).webhook).toEqual({
      url: "https://a.example.com/x"
    });
  });
  it("allows plain http only to local or private hosts", () => {
    for (const url of ["http://localhost:3000/x", "http://10.0.0.5/x", "http://backend/x"])
      expect(conversationWebhookFromEnv({ CONVERSATION_WEBHOOK_URL: url }).webhook?.url).toBe(url);
    for (const url of ["http://example.com/x", "ftp://example.com/x"]) {
      const result = conversationWebhookFromEnv({ CONVERSATION_WEBHOOK_URL: url });
      expect(result.webhook).toBeUndefined();
      expect(result.problem).toMatch(/https/);
    }
    expect(conversationWebhookFromEnv({ CONVERSATION_WEBHOOK_URL: "not a url" }).problem).toMatch(/not a URL/);
  });
});

describe("deliverConversation request", () => {
  it("posts the JSON body with the event headers and a verifiable signature", async () => {
    const { request, sleep } = harness(200);
    const result = await deliverConversation(payload, hook, { request, sleep, now: () => 1_700_000_000_000 });
    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(hook.url);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(payload), redirect: "error" });
    const headers = headersOf(request);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-voice-agent-event"]).toBe("conversation.ended");
    expect(headers["x-voice-agent-delivery"]).toBe("delivery-1");
    expect(headers["x-voice-agent-timestamp"]).toBe("1700000000000");
    const expected = createHmac("sha256", "whsec_topsecret")
      .update(`1700000000000.${JSON.stringify(payload)}`)
      .digest("hex");
    expect(headers["x-voice-agent-signature"]).toBe(`sha256=${expected}`);
  });

  it("does not sign without a secret", async () => {
    const { request, sleep } = harness(204);
    await deliverConversation(payload, { url: hook.url }, { request, sleep });
    expect(headersOf(request)["x-voice-agent-signature"]).toBeUndefined();
    expect(headersOf(request)["x-voice-agent-timestamp"]).toBeUndefined();
  });

  it("signs each attempt with a fresh timestamp", async () => {
    const { request, sleep } = harness(500, 200);
    let clock = 1000;
    await deliverConversation(payload, hook, { request, sleep, now: () => (clock += 5000) });
    const [a, b] = [headersOf(request, 0), headersOf(request, 1)];
    expect(a["x-voice-agent-timestamp"]).toBe("6000");
    expect(b["x-voice-agent-timestamp"]).toBe("11000");
    expect(a["x-voice-agent-signature"]).not.toBe(b["x-voice-agent-signature"]);
    expect(b["x-voice-agent-delivery"]).toBe("delivery-1");
  });
});

describe("deliverConversation retries", () => {
  it("retries a network error, 500 and 429 on the 1 s, 5 s, 25 s schedule", async () => {
    const { request, waits, sleep } = harness(new TypeError("fetch failed"), 500, 429, 200);
    expect(await deliverConversation(payload, hook, { request, sleep })).toEqual({
      ok: true,
      attempts: 4,
      status: 200
    });
    expect(waits).toEqual([1000, 5000, 25_000]);
  });

  it.each([408, 502, 503])("retries HTTP %s", async (status) => {
    const { request, waits, sleep } = harness(status, 200);
    expect((await deliverConversation(payload, hook, { request, sleep })).attempts).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it.each([400, 401, 404, 410, 422])("treats HTTP %s as final", async (status) => {
    const { request, waits, sleep } = harness(status, 200);
    expect(await deliverConversation(payload, hook, { request, sleep })).toEqual({
      ok: false,
      attempts: 1,
      status,
      error: `HTTP ${status}`
    });
    expect(waits).toEqual([]);
  });

  it("stops after four attempts", async () => {
    const { request, waits, sleep } = harness(500, 500, 500, 503, 200);
    expect(await deliverConversation(payload, hook, { request, sleep })).toEqual({
      ok: false,
      attempts: 4,
      status: 503,
      error: "HTTP 503"
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([1000, 5000, 25_000]);
  });

  /** AbortSignal.timeout runs on the runtime's own clock, so the test shortens it. */
  function withShortTimeout(run: () => Promise<void>) {
    return async () => {
      const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(10_000);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 5);
        return controller.signal;
      });
      try {
        await run();
      } finally {
        spy.mockRestore();
      }
    };
  }
  const hanging = (stopAfter = Infinity) => {
    const request: ReturnType<typeof harness>["request"] = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (request.mock.calls.length > stopAfter) return resolve(new Response("", { status: 200 }));
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        })
    );
    return request;
  };

  it(
    "times each attempt out at 10 s and retries",
    withShortTimeout(async () => {
      const request = hanging(1);
      expect(await deliverConversation(payload, hook, { request, sleep: async () => undefined })).toEqual({
        ok: true,
        attempts: 2,
        status: 200
      });
    })
  );

  it(
    "reports a timeout after the last attempt",
    withShortTimeout(async () => {
      const request = hanging();
      expect(await deliverConversation(payload, hook, { request, sleep: async () => undefined })).toEqual({
        ok: false,
        attempts: 4,
        error: "request timed out"
      });
    })
  );

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const { request } = harness(500, 500);
    const sleep = async () => controller.abort();
    const result = await deliverConversation(payload, hook, { request, sleep, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("deliverConversation safety", () => {
  it("never rejects and keeps the URL query and the secret out of errors", async () => {
    const leaky = new TypeError(`fetch failed for ${hook.url} with ${hook.secret}`, {
      cause: { code: "ECONNREFUSED" }
    });
    const { request, sleep } = harness(leaky, leaky, leaky, leaky);
    const result = await deliverConversation(payload, hook, { request, sleep });
    expect(result).toEqual({ ok: false, attempts: 4, error: "network error (ECONNREFUSED)" });
    expect(JSON.stringify(result)).not.toMatch(/querysecret|whsec_topsecret/);
  });

  it("does not follow redirects", async () => {
    const redirect = new TypeError("redirect mode is set to error: https://evil.example.com/?q=querysecret");
    const { request, sleep } = harness(redirect, redirect, redirect, redirect);
    const result = await deliverConversation(payload, hook, { request, sleep, now: () => 1 });
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(result.error).not.toMatch(/evil|querysecret/);
  });

  it("survives a payload that cannot be serialised and a throwing clock", async () => {
    const circular = { ...payload } as ConversationEndedPayload & { self?: unknown };
    circular.self = circular;
    const { request, sleep } = harness();
    const first = await deliverConversation(circular, hook, { request, sleep });
    expect(first.ok).toBe(false);
    const second = await deliverConversation(payload, hook, {
      request,
      sleep,
      now: () => {
        throw new Error("clock broke");
      }
    });
    expect(second).toMatchObject({ ok: false });
  });
});
