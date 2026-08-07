import { describe, expect, it, vi } from "vitest";
import {
  buildChatCompletionsEndpoint,
  createArkVisionProvider,
  createMockVisionProvider,
  selectVisionProvider,
  VISION_ENDPOINT,
  WATCH_PROMPT
} from "../server/vision";

describe("buildChatCompletionsEndpoint", () => {
  it("appends the chat-completions path to a bare base url", () => {
    expect(buildChatCompletionsEndpoint("https://ark.example.com/api/v3")).toBe(
      "https://ark.example.com/api/v3/chat/completions"
    );
  });

  it("tolerates a trailing slash on ARK_BASE_URL instead of doubling it", () => {
    expect(buildChatCompletionsEndpoint("https://ark.example.com/api/v3/")).toBe(
      "https://ark.example.com/api/v3/chat/completions"
    );
    expect(buildChatCompletionsEndpoint("https://ark.example.com/api/v3///")).toBe(
      "https://ark.example.com/api/v3/chat/completions"
    );
  });
});

function reply(text: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] })
  } as unknown as Response;
}

function describer(overrides: Partial<Parameters<typeof createArkVisionProvider>[0]> = {}) {
  const fetchImpl = vi.fn(async () => reply("前面是一条空路。"));
  const provider = createArkVisionProvider({
    apiKey: "key",
    model: "vision-model",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides
  });
  return { describe: (image: string) => provider.describe([image]), fetchImpl };
}

// Migrated from the old createDescriber (deleted — createArkVisionProvider is
// its last consumer's replacement, driven single-frame here). Every
// failure-class assertion the old suite made is preserved: missing key, HTTP
// error, timeout, empty content, and malformed/network failure.
describe("createArkVisionProvider (single frame, migrated from createDescriber)", () => {
  it("returns the description", async () => {
    const { describe: run } = describer();
    expect(await run("AAAA")).toBe("前面是一条空路。");
  });

  it("sends the image as a data url and asks in Chinese", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The default endpoint — ARK_BASE_URL + "/chat/completions" as measured in
    // Task 1's report — is used whenever a caller does not override it (as
    // server/providers/doubao.ts does when ARK_BASE_URL is configured).
    expect(url).toBe(VISION_ENDPOINT);
    const body = JSON.parse(String(init.body));
    const parts = body.messages[0].content;
    expect(parts.find((p: { type: string }) => p.type === "image_url").image_url.url).toBe(
      "data:image/jpeg;base64,AAAA"
    );
    expect(parts.find((p: { type: string }) => p.type === "text").text).toMatch(/描述/);
  });

  it("returns null without a key and never calls out (missing key)", async () => {
    const fetchImpl = vi.fn();
    const provider = createArkVisionProvider({ model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await provider.describe(["AAAA"])).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the service rejects (HTTP error)", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when the payload has no text (empty content)", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => ({ ok: true, json: async () => ({ choices: [] }) })) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null when fetch throws (malformed / network failure)", async () => {
    const { describe: run } = describer({
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch
    });
    expect(await run("AAAA")).toBeNull();
  });

  it("returns null and reports 'timed out' when the request exceeds timeoutMs", async () => {
    const reasons: string[] = [];
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const { describe: run } = describer({
      timeoutMs: 5,
      fetchImpl: hangingFetch,
      onFailure: (reason) => reasons.push(reason)
    });
    expect(await run("AAAA")).toBeNull();
    expect(reasons).toEqual(["timed out"]);
  });

  it("reports a reason on each failure", async () => {
    const reasons: string[] = [];
    const { describe: run } = describer({
      onFailure: (reason) => reasons.push(reason),
      fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    });
    await run("AAAA");
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("401");
  });

  it("never caches — every look is a new scene", async () => {
    const { describe: run, fetchImpl } = describer();
    await run("AAAA");
    await run("AAAA");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

const FRAME = "aGVsbG8="; // any base64 string; the provider never decodes it
const ARK_OK = JSON.stringify({ choices: [{ message: { content: "前方有一个蓝色路牌。" } }] });

function fetchCapturing(body: string, captured: { url?: string; body?: unknown }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = JSON.parse(String(init?.body));
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe("createArkVisionProvider", () => {
  it("sends images first, then the question as the text part", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const provider = createArkVisionProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchCapturing(ARK_OK, captured)
    });
    const answer = await provider.describe([FRAME, FRAME], "路牌写的什么");
    expect(answer).toBe("前方有一个蓝色路牌。");
    const content = (captured.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]
      .content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("image_url");
    expect(content[1].type).toBe("image_url");
    expect(content[2]).toEqual({ type: "text", text: "路牌写的什么" });
  });

  it("falls back to the fixed describe prompt when no question is asked", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const provider = createArkVisionProvider({ apiKey: "k", model: "m", fetchImpl: fetchCapturing(ARK_OK, captured) });
    await provider.describe([FRAME]);
    const content = (captured.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[0]
      .content;
    expect(content).toHaveLength(2);
    expect((content[1] as { text: string }).text).toContain("描述");
  });

  it("returns null with one onFailure on missing credentials, HTTP error, and empty content", async () => {
    for (const setup of [
      { options: { apiKey: undefined, model: "m" } },
      { options: { apiKey: "k", model: undefined } },
      {
        options: {
          apiKey: "k",
          model: "m",
          fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch
        }
      },
      {
        options: {
          apiKey: "k",
          model: "m",
          fetchImpl: (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch
        }
      }
    ]) {
      const reasons: string[] = [];
      const provider = createArkVisionProvider({ ...setup.options, onFailure: (r) => reasons.push(r) });
      expect(await provider.describe([FRAME], "q")).toBeNull();
      expect(reasons.length).toBe(1);
    }
  });
});

describe("createMockVisionProvider", () => {
  it("answers deterministically for photo, clip, and question", async () => {
    const provider = createMockVisionProvider();
    expect(provider.mode).toBe("mock");
    expect(await provider.describe([FRAME])).toBe("前方道路畅通，天气晴朗。");
    expect(await provider.describe([FRAME, FRAME, FRAME])).toBe("这段视频里，前方道路畅通，一路顺利。");
    expect(await provider.describe([FRAME], "前面是什么")).toBe(`关于“前面是什么”：我看到前方道路畅通。`);
  });
});

it("answers the watch prompt with the fixed observation", async () => {
  const provider = createMockVisionProvider();
  expect(await provider.describe(["F"], WATCH_PROMPT)).toBe("前方有施工路段，注意慢行。");
});

describe("selectVisionProvider", () => {
  it("selects ark with credentials, mock without, warning once per process", () => {
    const warnings: string[] = [];
    const log = { warn: (m: string) => warnings.push(m) };
    expect(selectVisionProvider({ apiKey: "k", model: "m" }, log).mode).toBe("ark");
    expect(warnings.length).toBe(0);
    expect(selectVisionProvider({ apiKey: "k" }, log).mode).toBe("mock"); // model missing counts as unconfigured
    expect(warnings.length).toBe(1);
    selectVisionProvider({}, log); // second unconfigured selection: latch already fired
    expect(warnings.length).toBe(1);
  });
});
