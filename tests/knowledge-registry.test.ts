import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxPassagesFromEnv } from "../server/knowledge-embeddings";
import {
  buildServerTools,
  closeServerTools,
  installServerTools,
  serverTools,
  setServerToolsForTests
} from "../server/tools/registry";
import type { ToolContext, ToolDefinition } from "../server/tools";

const context = () => ({ sessionId: "s" }) as unknown as ToolContext;
const text = [
  "# Reimbursement\n\nCustomers are reimbursed within 14 days.",
  "# Delivery\n\nOur courier delivers in 3 days.",
  "# Parking\n\nFree parking behind the shop."
].join("\n\n");
const concept = (value: string, dims = 3) =>
  [
    /reimburs|money|back/i.test(value) ? 1 : 0,
    /courier|deliver/i.test(value) ? 1 : 0,
    /park/i.test(value) ? 1 : 0
  ].concat(Array(Math.max(0, dims - 3)).fill(0.01));
const fakeRequest = (inputs: string[][] = [], dims = 3) =>
  (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(input);
    return new Response(
      JSON.stringify({ data: input.map((value, index) => ({ index, embedding: concept(value, dims) })) })
    );
  }) as unknown as typeof fetch;
/** Passages are sent as "heading\ntext"; a question is a single line. */
const passageTexts = (inputs: string[][]) => inputs.flat().filter((value) => value.includes("\n"));
const ask = async (tool: ToolDefinition, query: string) =>
  ((await tool.handler({ query }, context())) as { results: { heading?: string; score?: number }[] }).results.map(
    (item) => item.heading
  );

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-registry-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  KNOWLEDGE_EMBEDDINGS_MODEL: "small",
  KNOWLEDGE_EMBEDDINGS_API_KEY: "k",
  ...extra
});
const ready = (tool: ToolDefinition) =>
  vi.waitFor(async () => expect(await ask(tool, "money back")).toEqual(["Reimbursement"]));

describe("maxPassagesFromEnv", () => {
  it("defaults to 100,000, takes a whole number and reports a bad one", () => {
    expect(maxPassagesFromEnv({})).toEqual({ value: 100_000 });
    expect(maxPassagesFromEnv({ KNOWLEDGE_MAX_PASSAGES: " 250 " })).toEqual({ value: 250 });
    for (const bad of ["0", "-5", "1.5", "lots"]) {
      const result = maxPassagesFromEnv({ KNOWLEDGE_MAX_PASSAGES: bad });
      expect(result.value).toBe(100_000);
      expect(result.problem).toMatch(/KNOWLEDGE_MAX_PASSAGES must be a whole number/);
    }
  });
});

describe("knowledge embeddings with the disk cache", () => {
  it("gives the same hybrid answers with and without the cache, and the second build makes no request", async () => {
    const queries = ["money back", "courier", "parking", "something unrelated", "reimbursed"];
    const answers = async (tool: ToolDefinition) => Promise.all(queries.map((query) => ask(tool, query)));

    const none = await buildServerTools(
      { knowledge: { text } },
      { env: env({ KNOWLEDGE_EMBEDDINGS_CACHE: "off" }), request: fakeRequest() }
    );
    await ready(none.tools[0]!);
    const withoutCache = await answers(none.tools[0]!);

    const firstInputs: string[][] = [];
    const first = await buildServerTools(
      { knowledge: { text } },
      { env: env(), request: fakeRequest(firstInputs), cacheDir: dir }
    );
    await ready(first.tools[0]!);
    expect(passageTexts(firstInputs)).toHaveLength(3);
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]));

    const secondInputs: string[][] = [];
    const second = await buildServerTools(
      { knowledge: { text } },
      { env: env(), request: fakeRequest(secondInputs), cacheDir: dir }
    );
    await ready(second.tools[0]!);
    // Whatever the second build sent was a question, never a passage.
    expect(passageTexts(secondInputs)).toEqual([]);

    expect(await answers(first.tools[0]!)).toEqual(withoutCache);
    expect(await answers(second.tools[0]!)).toEqual(withoutCache);
  });

  it("uses KNOWLEDGE_EMBEDDINGS_CACHE as the directory", async () => {
    const built = await buildServerTools(
      { knowledge: { text } },
      { env: env({ KNOWLEDGE_EMBEDDINGS_CACHE: dir }), request: fakeRequest() }
    );
    await ready(built.tools[0]!);
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]));
  });

  it("stays on keywords above KNOWLEDGE_MAX_PASSAGES, calls nothing and writes nothing", async () => {
    const inputs: string[][] = [];
    const built = await buildServerTools(
      { knowledge: { text } },
      { env: env({ KNOWLEDGE_MAX_PASSAGES: "2" }), request: fakeRequest(inputs), cacheDir: dir }
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(inputs).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await ask(built.tools[0]!, "money back")).toEqual([]);
    expect(await ask(built.tools[0]!, "courier")).toEqual(["Delivery"]);
  });

  it("embeds exactly at the limit", async () => {
    const built = await buildServerTools(
      { knowledge: { text } },
      { env: env({ KNOWLEDGE_MAX_PASSAGES: "3" }), request: fakeRequest(), cacheDir: dir }
    );
    await ready(built.tools[0]!);
  });

  it("reports a bad KNOWLEDGE_MAX_PASSAGES as a knowledge problem and uses the default", async () => {
    const built = await buildServerTools(
      { knowledge: { text } },
      { env: env({ KNOWLEDGE_MAX_PASSAGES: "many", KNOWLEDGE_EMBEDDINGS_CACHE: "off" }), request: fakeRequest() }
    );
    expect(built.problems).toEqual([expect.stringMatching(/^knowledge: KNOWLEDGE_MAX_PASSAGES must be/)]);
    await ready(built.tools[0]!);
  });

  it("recovers when every cached vector has the wrong size: one rebuild, then hybrid search again", async () => {
    const first = await buildServerTools(
      { knowledge: { text } },
      { env: env(), request: fakeRequest([], 3), cacheDir: dir }
    );
    await ready(first.tools[0]!);
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]));
    // The model now answers with 5 numbers, but the cache holds 3-number vectors under the same keys.
    const inputs: string[][] = [];
    const second = await buildServerTools(
      { knowledge: { text } },
      { env: env(), request: fakeRequest(inputs, 5), cacheDir: dir }
    );
    const tool = second.tools[0]!;
    expect(await ask(tool, "courier")).toEqual(["Delivery"]);
    await vi.waitFor(async () => expect(await ask(tool, "money back")).toEqual(["Reimbursement"]));
    const header = fs.readFileSync(path.join(dir, "vectors.bin")).readUInt32LE(8);
    expect(header).toBe(5);
    expect(passageTexts(inputs)).toHaveLength(3);
  });
});

describe("the embedding job of a tools build", () => {
  const otherText = "# Refunds\n\nMoney comes back in 5 days.\n\n# Parking\n\nFree parking behind the shop.";
  const refundReady = (tool: ToolDefinition) =>
    vi.waitFor(async () => expect(await ask(tool, "money back")).toEqual(["Refunds"]));

  afterEach(() => {
    setServerToolsForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** Answers `answers` requests, then holds the next one until its request is aborted, as fetch would. */
  const holding = (answers: number) => {
    const inputs: string[][] = [];
    const answered = fakeRequest(inputs);
    const held: AbortSignal[] = [];
    const request = (async (url: string, init: RequestInit) => {
      if (inputs.length < answers) return answered(url as never, init);
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init.signal!;
      held.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      return promise;
    }) as unknown as typeof fetch;
    return { request, held };
  };
  /** `installServerTools` reads the environment and the global `fetch`: both are pointed at this test's own. */
  const use = (request: typeof fetch) => {
    vi.stubEnv("KNOWLEDGE_EMBEDDINGS_MODEL", "small");
    vi.stubEnv("KNOWLEDGE_EMBEDDINGS_API_KEY", "k");
    vi.stubEnv("KNOWLEDGE_EMBEDDINGS_CACHE", dir);
    vi.stubGlobal("fetch", request);
  };

  it("is cancelled when a newer config is installed, and nothing of it reaches the cache after that", async () => {
    const first = holding(0);
    use(first.request);
    await installServerTools({ knowledge: { text } });
    await vi.waitFor(() => expect(first.held).toHaveLength(1));

    const second = fakeRequest();
    use(second);
    await installServerTools({ knowledge: { text: otherText } });
    expect(first.held[0]!.aborted).toBe(true);
    await refundReady(serverTools()[0]!);
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]));
    // The cache is the newer job's, with its two passages: the cancelled job never got as far as writing.
    expect(fs.readFileSync(path.join(dir, "vectors.bin")).readUInt32LE(12)).toBe(2);
  });

  it("is cancelled when the relay's tools are closed", async () => {
    const endpoint = holding(0);
    use(endpoint.request);
    await installServerTools({ knowledge: { text } });
    await vi.waitFor(() => expect(endpoint.held).toHaveLength(1));
    closeServerTools();
    expect(endpoint.held[0]!.aborted).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps what a closed build saved before, and leaves the cache to the build that follows", async () => {
    const first = holding(2);
    const stalled = await buildServerTools(
      { knowledge: { text } },
      { env: env(), request: first.request, cacheDir: dir, embedJob: { batchSize: 1, concurrency: 1, saveEvery: 1 } }
    );
    // Both part files land before the build is closed, so the cancelled job has no write in flight.
    await vi.waitFor(() => expect(fs.readdirSync(dir).filter((name) => name.startsWith("part-"))).toHaveLength(2));
    expect(first.held).toHaveLength(1);
    stalled.close();
    expect(first.held[0]!.aborted).toBe(true);

    const next = await buildServerTools(
      { knowledge: { text: otherText } },
      { env: env(), request: fakeRequest(), cacheDir: dir }
    );
    await refundReady(next.tools[0]!);
    // The next build owns the cache: its compaction is what stands, with the part files gone.
    await vi.waitFor(() => expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]));
    expect(fs.readFileSync(path.join(dir, "vectors.bin")).readUInt32LE(12)).toBe(2);
  });
});
