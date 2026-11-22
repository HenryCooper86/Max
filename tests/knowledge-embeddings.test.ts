import { describe, expect, it, vi } from "vitest";
import { embeddingModelFromEnv, embedTexts, type EmbeddingModel } from "../server/knowledge-embeddings";

const model: EmbeddingModel = { baseUrl: "https://emb.example.com/v1", model: "small", apiKey: "sk-secret" };

type Call = { url: string; init: RequestInit; body: { model: string; input: string[] } };

/** A fake endpoint: answers each request with `reply(call)`, and records what it was sent. */
function endpoint(reply: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const request = (async (url: string, init: RequestInit) => {
    const call = { url, init, body: JSON.parse(String(init.body)) } as Call;
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, request };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const vectorsFor = (input: string[], make = (i: number) => [i + 1, 0]) =>
  json({ data: input.map((_, index) => ({ index, embedding: make(index) })) });

describe("embeddingModelFromEnv", () => {
  it("is off unless a model is named", () => {
    expect(embeddingModelFromEnv({})).toEqual({});
    expect(embeddingModelFromEnv({ OPENAI_API_KEY: "sk-x", KNOWLEDGE_EMBEDDINGS_MODEL: "  " })).toEqual({});
  });

  it("uses OpenAI by default and takes its key from OPENAI_API_KEY", () => {
    expect(embeddingModelFromEnv({ KNOWLEDGE_EMBEDDINGS_MODEL: "m", OPENAI_API_KEY: "sk-o" })).toEqual({
      model: { baseUrl: "https://api.openai.com/v1", model: "m", apiKey: "sk-o" }
    });
  });

  it("prefers the dedicated key", () => {
    const { model: found } = embeddingModelFromEnv({
      KNOWLEDGE_EMBEDDINGS_MODEL: "m",
      KNOWLEDGE_EMBEDDINGS_API_KEY: "sk-k",
      OPENAI_API_KEY: "sk-o"
    });
    expect(found?.apiKey).toBe("sk-k");
  });

  it("reports a problem for OpenAI without any key", () => {
    const result = embeddingModelFromEnv({ KNOWLEDGE_EMBEDDINGS_MODEL: "m" });
    expect(result.model).toBeUndefined();
    expect(result.problem).toMatch(/API_KEY/);
  });

  it("never sends the OpenAI key to another host", () => {
    const { model: found } = embeddingModelFromEnv({
      KNOWLEDGE_EMBEDDINGS_MODEL: "m",
      KNOWLEDGE_EMBEDDINGS_BASE_URL: "https://emb.example.com/v1/",
      OPENAI_API_KEY: "sk-o"
    });
    expect(found).toEqual({ baseUrl: "https://emb.example.com/v1", model: "m" });
  });

  it("allows plain http to a local server without a key", () => {
    const { model: found } = embeddingModelFromEnv({
      KNOWLEDGE_EMBEDDINGS_MODEL: "nomic",
      KNOWLEDGE_EMBEDDINGS_BASE_URL: "http://localhost:11434/v1"
    });
    expect(found).toEqual({ baseUrl: "http://localhost:11434/v1", model: "nomic" });
  });

  it.each(["not a url", "http://embeddings.example.com/v1", "ftp://localhost/v1"])("rejects %s", (url) => {
    const result = embeddingModelFromEnv({
      KNOWLEDGE_EMBEDDINGS_MODEL: "m",
      KNOWLEDGE_EMBEDDINGS_BASE_URL: url,
      KNOWLEDGE_EMBEDDINGS_API_KEY: "k"
    });
    expect(result.model).toBeUndefined();
    expect(result.problem).toMatch(/KNOWLEDGE_EMBEDDINGS_BASE_URL/);
  });
});

describe("embedTexts", () => {
  it("posts the model and the texts in the OpenAI format", async () => {
    const { calls, request } = endpoint((call) => vectorsFor(call.body.input));
    await embedTexts(model, ["a", "b"], { request });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://emb.example.com/v1/embeddings");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer sk-secret" });
    expect(calls[0]!.body).toEqual({ model: "small", input: ["a", "b"] });
  });

  it("sends no Authorization header without a key", async () => {
    const { calls, request } = endpoint((call) => vectorsFor(call.body.input));
    await embedTexts({ baseUrl: "http://localhost:11434/v1", model: "m" }, ["a"], { request });
    expect(Object.keys(calls[0]!.init.headers as object).map((name) => name.toLowerCase())).not.toContain(
      "authorization"
    );
  });

  it("splits into batches and keeps the input order", async () => {
    const { calls, request } = endpoint((call) => vectorsFor(call.body.input, () => [1, 1]));
    const texts = Array.from({ length: 5 }, (_, i) => `t${i}`);
    const vectors = await embedTexts(model, texts, { request, batchSize: 2 });
    expect(calls.map((call) => call.body.input)).toEqual([["t0", "t1"], ["t2", "t3"], ["t4"]]);
    expect(vectors).toHaveLength(5);
  });

  it("batches 64 texts per request by default", async () => {
    const { calls, request } = endpoint((call) => vectorsFor(call.body.input));
    await embedTexts(
      model,
      Array.from({ length: 130 }, (_, i) => `t${i}`),
      { request }
    );
    expect(calls.map((call) => call.body.input.length)).toEqual([64, 64, 2]);
  });

  it("cuts each text to 8,000 characters", async () => {
    const { calls, request } = endpoint((call) => vectorsFor(call.body.input));
    await embedTexts(model, ["x".repeat(9000)], { request });
    expect(calls[0]!.body.input[0]).toHaveLength(8000);
  });

  it("orders the vectors by their index, whatever order they arrive in", async () => {
    const { request } = endpoint(() =>
      json({
        data: [
          { index: 1, embedding: [0, 5] },
          { index: 0, embedding: [3, 0] }
        ]
      })
    );
    const [first, second] = await embedTexts(model, ["a", "b"], { request });
    expect(Array.from(first!)).toEqual([1, 0]);
    expect(Array.from(second!)).toEqual([0, 1]);
  });

  it("returns unit vectors", async () => {
    const { request } = endpoint(() => json({ data: [{ index: 0, embedding: [3, 4] }] }));
    const [vector] = await embedTexts(model, ["a"], { request });
    expect(vector![0]).toBeCloseTo(0.6);
    expect(vector![1]).toBeCloseTo(0.8);
    expect(vector).toBeInstanceOf(Float32Array);
  });

  it("returns nothing for no texts, without a request", async () => {
    const { calls, request } = endpoint(() => json({}));
    expect(await embedTexts(model, [], { request })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  const bad: [string, () => Response][] = [
    ["a non-JSON body", () => new Response("<html>nope</html>")],
    ["no data list", () => json({ result: [] })],
    ["too few vectors", () => json({ data: [] })],
    [
      "too many vectors",
      () =>
        json({
          data: [
            { index: 0, embedding: [1] },
            { index: 1, embedding: [1] },
            { index: 2, embedding: [1] }
          ]
        })
    ],
    [
      "an empty vector",
      () =>
        json({
          data: [
            { index: 0, embedding: [] },
            { index: 1, embedding: [] }
          ]
        })
    ],
    ["a missing vector", () => json({ data: [{ index: 0 }, { index: 1, embedding: [1] }] })],
    [
      "a non-numeric value",
      () =>
        json({
          data: [
            { index: 0, embedding: ["x"] },
            { index: 1, embedding: [1] }
          ]
        })
    ],
    [
      "a null value",
      () =>
        json({
          data: [
            { index: 0, embedding: [null] },
            { index: 1, embedding: [1] }
          ]
        })
    ],
    [
      "a repeated index",
      () =>
        json({
          data: [
            { index: 0, embedding: [1] },
            { index: 0, embedding: [1] }
          ]
        })
    ],
    [
      "different lengths",
      () =>
        json({
          data: [
            { index: 0, embedding: [1] },
            { index: 1, embedding: [1, 2] }
          ]
        })
    ],
    [
      "an all-zero vector",
      () =>
        json({
          data: [
            { index: 0, embedding: [0, 0] },
            { index: 1, embedding: [0, 1] }
          ]
        })
    ]
  ];
  it.each(bad)("rejects %s", async (_, reply) => {
    const { request } = endpoint(reply);
    await expect(embedTexts(model, ["a", "b"], { request })).rejects.toThrow(/^embeddings: /);
  });

  it("names the status of a failed request, not its body or the key", async () => {
    const { request } = endpoint(() => new Response("secret body sk-secret", { status: 401 }));
    const error = await embedTexts(model, ["a"], { request }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toMatch(/secret/);
  });

  it("does not leak the query string or the key when the request itself fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connect failed https://emb.example.com/v1?key=sk-secret"));
    const withQuery = { ...model, baseUrl: "https://emb.example.com/v1?api-version=1" };
    const error = (await embedTexts(withQuery, ["a"], { request }).catch((caught: Error) => caught)) as Error;
    expect(error.message).not.toMatch(/sk-secret|api-version|emb\.example\.com/);
  });

  it("does not leak a malformed body", async () => {
    const { request } = endpoint(() => json({ data: [{ index: 0, embedding: ["sk-secret"] }] }));
    const error = (await embedTexts(model, ["a"], { request }).catch((caught: Error) => caught)) as Error;
    expect(error.message).not.toMatch(/sk-secret/);
  });

  it("gives up on a request that takes longer than the timeout", async () => {
    const request = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const error = (await embedTexts(model, ["a"], { request, timeoutMs: 20 }).catch(
      (caught: Error) => caught
    )) as Error;
    expect(error.message).toMatch(/timed out/);
  });

  it("stops at the first failing batch", async () => {
    const { calls, request } = endpoint((call, n) => (n === 0 ? vectorsFor(call.body.input) : json({}, 500)));
    await expect(embedTexts(model, ["a", "b", "c", "d"], { request, batchSize: 1 })).rejects.toThrow(/500/);
    expect(calls).toHaveLength(2);
  });
});
