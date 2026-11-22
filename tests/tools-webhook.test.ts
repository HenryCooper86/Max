import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { callWebhook, expandEnv, plainHttpAllowed, webhookToolFrom, type WebhookConfig } from "../server/tools/webhook";

const base: WebhookConfig = { url: "https://api.example.com/hook", method: "POST", headers: {}, timeoutMs: 1000 };
const context = { callId: "c1", sessionId: "s1", language: "en", userId: "u1", signal: new AbortController().signal };

function reply(body: string, init: { status?: number; type?: string } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "application/json" }
  });
}

describe("expandEnv", () => {
  it("replaces variables and reports missing or empty ones", () => {
    expect(expandEnv("Bearer ${KEY}-${KEY}", { KEY: "k" })).toEqual({ value: "Bearer k-k", missing: [] });
    expect(expandEnv("${A}${B}${C}", { A: "1", B: "" })).toEqual({ value: "1", missing: ["B", "C"] });
    expect(expandEnv("no vars $X {Y}", {})).toEqual({ value: "no vars $X {Y}", missing: [] });
  });
});

describe("plainHttpAllowed", () => {
  it.each([
    "localhost",
    "foo.localhost",
    "[::1]",
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.16.0.1",
    "172.31.255.1",
    "printer.local",
    "svc.internal",
    "fd12:3456::1",
    "orders-api"
  ])("allows %s", (host) => expect(plainHttpAllowed(host)).toBe(true));

  it.each(["example.com", "api.example.com", "172.32.0.1", "8.8.8.8", "172.15.0.1", "1234"])("rejects %s", (host) =>
    expect(plainHttpAllowed(host)).toBe(false)
  );
});

describe("webhookToolFrom", () => {
  const spec = { name: "get_order", description: "Look up an order" };

  it("builds a tool with defaults and clamps the timeout", () => {
    const { tool, webhook } = webhookToolFrom({ ...spec, webhook: { url: " https://a.example.com/x " } });
    expect(webhook).toMatchObject({ url: "https://a.example.com/x", method: "POST", headers: {}, timeoutMs: 10_000 });
    expect(tool).toMatchObject({ name: "get_order", timeoutMs: 10_000 });
    expect(webhookToolFrom({ ...spec, webhook: { url: "https://a.b/x", timeoutMs: 999_999 } }).webhook?.timeoutMs).toBe(
      60_000
    );
    expect(webhookToolFrom({ ...spec, webhook: { url: "https://a.b/x", timeoutMs: 8000 } }).webhook?.timeoutMs).toBe(
      8000
    );
    expect(webhookToolFrom({ ...spec, webhook: { url: "https://a.b/x", timeoutMs: -5 } }).webhook?.timeoutMs).toBe(
      10_000
    );
  });

  it("gives a background tool longer, and says when the flag is not a yes or no", () => {
    const background = { ...spec, background: true };
    const built = webhookToolFrom({ ...background, webhook: { url: "https://a.b/x" } });
    expect(built.tool).toMatchObject({ background: true, timeoutMs: 120_000 });
    expect(
      webhookToolFrom({ ...background, webhook: { url: "https://a.b/x", timeoutMs: 300_000 } }).tool?.timeoutMs
    ).toBe(300_000);
    expect(
      webhookToolFrom({ ...background, webhook: { url: "https://a.b/x", timeoutMs: 9_999_999 } }).tool?.timeoutMs
    ).toBe(600_000);
    // An ordinary tool is not marked, and keeps the short limits.
    const plain = webhookToolFrom({
      ...spec,
      background: false,
      webhook: { url: "https://a.b/x", timeoutMs: 300_000 }
    });
    expect(plain.tool?.background).toBeUndefined();
    expect(plain.tool?.timeoutMs).toBe(60_000);
    expect(webhookToolFrom({ ...spec, background: "yes", webhook: { url: "https://a.b/x" } }).problem).toBe(
      "tool get_order: background must be true or false"
    );
  });

  it("accepts a bare url, a secret, headers and env placeholders", () => {
    expect(webhookToolFrom({ ...spec, url: "https://a.b/x" }).webhook?.url).toBe("https://a.b/x");
    const { webhook } = webhookToolFrom({
      ...spec,
      webhook: { url: "https://${HOST}/x", headers: { Authorization: "Bearer ${K}" }, secret: " s3 " }
    });
    expect(webhook?.headers).toEqual({ Authorization: "Bearer ${K}" });
    expect(webhook?.secret).toBe("s3");
  });

  it("allows plain http only to private hosts", () => {
    expect(webhookToolFrom({ ...spec, url: "http://localhost:3000/x" }).tool).toBeTruthy();
    expect(webhookToolFrom({ ...spec, url: "http://example.com/x" }).problem).toContain("must be https");
    expect(webhookToolFrom({ ...spec, url: "ftp://localhost/x" }).problem).toContain("must be https");
  });

  it("reports problems", () => {
    expect(webhookToolFrom({ ...spec }).problem).toContain("needs webhook.url");
    expect(webhookToolFrom({ ...spec, webhook: { url: "  " } }).problem).toContain("needs webhook.url");
    expect(webhookToolFrom({ ...spec, url: "not a url" }).problem).toContain("not a URL");
    expect(
      webhookToolFrom({ ...spec, webhook: { url: "https://a.b", headers: { "bad header": "x" } } }).problem
    ).toContain("invalid webhook header");
    expect(webhookToolFrom({ ...spec, webhook: { url: "https://a.b", headers: { X: 1 } } }).problem).toContain(
      "invalid webhook header"
    );
    expect(webhookToolFrom({ name: "bad name", description: "d" }).problem).toContain("invalid tool name");
  });

  it("the built handler calls the webhook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply('{"ok":1}'));
    try {
      const { tool } = webhookToolFrom({ ...spec, url: "https://a.b/x" });
      await expect(tool!.handler({ a: 1 }, { ...context, log: { info() {}, warn() {} } })).resolves.toEqual({ ok: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("callWebhook", () => {
  it("posts the documented body with expanded headers", async () => {
    const request = vi.fn().mockResolvedValue(reply('{"status":"shipped"}'));
    const result = await callWebhook(
      "get_order",
      { ...base, url: "https://${HOST}/hook", headers: { Authorization: "Bearer ${KEY}" } },
      { orderId: "A1" },
      context,
      request,
      { HOST: "api.test", KEY: "abc" }
    );
    expect(result).toEqual({ status: "shipped" });
    const [url, init] = request.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://api.test/hook");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBe(context.signal);
    expect(init.headers.Authorization).toBe("Bearer abc");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-voice-agent-signature"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      tool: "get_order",
      callId: "c1",
      arguments: { orderId: "A1" },
      session: { id: "s1", language: "en", userId: "u1" }
    });
  });

  it("omits language and userId when absent", async () => {
    const request = vi.fn().mockResolvedValue(reply("{}"));
    await callWebhook("t", base, {}, { callId: "c", sessionId: "s", signal: context.signal }, request, {});
    expect(JSON.parse((request.mock.calls[0][1] as RequestInit).body as string).session).toEqual({ id: "s" });
  });

  it("signs the timestamp and body when a secret is set", async () => {
    const request = vi.fn().mockResolvedValue(reply("{}"));
    await callWebhook("t", { ...base, secret: "${SEC}" }, { a: 1 }, context, request, { SEC: "shh" }, () => 1234);
    const init = request.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["x-voice-agent-timestamp"]).toBe("1234");
    const expected = createHmac("sha256", "shh")
      .update(`1234.${init.body as string}`)
      .digest("hex");
    expect(init.headers["x-voice-agent-signature"]).toBe(`sha256=${expected}`);
  });

  it("fails closed on missing environment variables without calling out", async () => {
    const request = vi.fn();
    await expect(
      callWebhook("t", { ...base, headers: { A: "${NOPE}" }, secret: "${ALSO}" }, {}, context, request, {})
    ).rejects.toThrow(/NOPE.*ALSO/);
    await expect(callWebhook("t", { ...base, url: "https://${H}/x" }, {}, context, request, {})).rejects.toThrow("H");
    expect(request).not.toHaveBeenCalled();
  });

  it("returns text for non-JSON and malformed JSON bodies", async () => {
    await expect(
      callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(reply("plain", { type: "text/plain" })), {})
    ).resolves.toBe("plain");
    await expect(
      callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(reply("{oops", { type: "application/json" })), {})
    ).resolves.toBe("{oops");
    // JSON content-type is required to parse
    await expect(
      callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(reply('{"a":1}', { type: "text/plain" })), {})
    ).resolves.toBe('{"a":1}');
  });

  it("turns non-2xx into errors, preferring a JSON error field", async () => {
    await expect(
      callWebhook(
        "t",
        base,
        {},
        context,
        vi.fn().mockResolvedValue(reply('{"error":"no such order"}', { status: 404 })),
        {}
      )
    ).rejects.toThrow("no such order");
    await expect(
      callWebhook(
        "t",
        base,
        {},
        context,
        vi.fn().mockResolvedValue(reply("  bad\n gateway ", { status: 502, type: "text/plain" })),
        {}
      )
    ).rejects.toThrow("HTTP 502: bad gateway");
    await expect(
      callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(reply("", { status: 500, type: "text/plain" })), {})
    ).rejects.toThrow(/^HTTP 500$/);
  });

  it("rejects responses over 256 KiB", async () => {
    const big = reply("x".repeat(256 * 1024 + 1), { type: "text/plain" });
    await expect(callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(big), {})).rejects.toThrow(
      "larger than 256 KiB"
    );
  });

  it("returns an empty string when the response has no body", async () => {
    const response = new Response(null, { status: 204 });
    await expect(callWebhook("t", base, {}, context, vi.fn().mockResolvedValue(response), {})).resolves.toBe("");
  });

  it("propagates network failures", async () => {
    await expect(
      callWebhook("t", base, {}, context, vi.fn().mockRejectedValue(new Error("ECONNRESET")), {})
    ).rejects.toThrow("ECONNRESET");
  });
});
