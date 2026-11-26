import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheDirFromEnv,
  cacheKeys,
  compactVectorCache,
  loadVectorCache,
  saveVectorPart
} from "../server/knowledge-cache";
import { embedKnowledgePassages } from "../server/knowledge-embed-job";
import { EmbeddingError, type EmbeddingModel } from "../server/knowledge-embeddings";

const model: EmbeddingModel = { baseUrl: "https://emb.example.com/v1", model: "small", apiKey: "sk-secret" };
const DIMS = 6;

/** A vector that depends on the text only, so the same text always gets the same vector. */
function vectorOf(text: string, dims = DIMS): number[] {
  let state = 17;
  for (const char of text) state = (state * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: dims }, () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32 + 0.1);
}

type Fake = ReturnType<typeof fakeEndpoint>;
function fakeEndpoint(options: { dims?: number; fail?: (call: number, input: string[]) => Response | undefined } = {}) {
  const inputs: string[][] = [];
  let inFlight = 0;
  let peak = 0;
  const request = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(input);
    const failure = options.fail?.(inputs.length, input);
    if (failure) return failure;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((done) => setImmediate(done));
    inFlight--;
    return new Response(
      JSON.stringify({ data: input.map((text, index) => ({ index, embedding: vectorOf(text, options.dims ?? DIMS) })) })
    );
  }) as unknown as typeof fetch;
  return {
    request,
    inputs,
    get requests() {
      return inputs.length;
    },
    get embedded() {
      return inputs.flat().length;
    },
    get peak() {
      return peak;
    }
  };
}

const passages = (count: number, tag = "p") =>
  Array.from({ length: count }, (_, i) => `${tag} number ${i} secret-body`);
const logger = () => ({ info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>() });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cache-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (endpoint: Fake, texts: string[], extra: Partial<Parameters<typeof embedKnowledgePassages>[0]> = {}) => {
  const log = logger();
  const done = embedKnowledgePassages({
    model,
    texts,
    request: endpoint.request,
    cacheDir: dir,
    batchSize: 4,
    backoffMs: 1,
    log,
    ...extra
  });
  return { done, log };
};
const row = (matrix: { data: Float32Array; dimensions: number }, i: number) => [
  ...matrix.data.subarray(i * matrix.dimensions, (i + 1) * matrix.dimensions)
];

describe("cacheDirFromEnv", () => {
  it("is off for `off`, takes a named directory, and defaults to the Studio directory", () => {
    expect(cacheDirFromEnv({ KNOWLEDGE_EMBEDDINGS_CACHE: "off" })).toBeUndefined();
    expect(cacheDirFromEnv({ KNOWLEDGE_EMBEDDINGS_CACHE: " OFF " })).toBeUndefined();
    expect(cacheDirFromEnv({ KNOWLEDGE_EMBEDDINGS_CACHE: "/var/kb" })).toBe("/var/kb");
    expect(cacheDirFromEnv({ STUDIO_DIR: "/srv/studio" })).toBe(path.join("/srv/studio", "knowledge-embeddings"));
    expect(cacheDirFromEnv({})).toBe(path.join(os.homedir(), ".max-relay", "knowledge-embeddings"));
  });
});

describe("cacheKeys", () => {
  it("depends on the URL, the model and the text", () => {
    const [base] = cacheKeys(model, ["a"]);
    expect(base).toHaveLength(16);
    expect(cacheKeys(model, ["a"])[0]).toBe(base);
    expect(cacheKeys(model, ["b"])[0]).not.toBe(base);
    expect(cacheKeys({ ...model, model: "large" }, ["a"])[0]).not.toBe(base);
    expect(cacheKeys({ ...model, baseUrl: "https://other.example.com/v1" }, ["a"])[0]).not.toBe(base);
    expect(cacheKeys({ ...model, apiKey: "another" }, ["a"])[0]).toBe(base);
  });
});

describe("the disk cache", () => {
  it("embeds everything on a cold start and writes one private file with no passage text in it", async () => {
    const endpoint = fakeEndpoint();
    const texts = passages(10);
    const matrix = await run(endpoint, texts).done;
    expect(matrix).toMatchObject({ dimensions: DIMS, count: 10 });
    expect(endpoint.embedded).toBe(10);
    expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]);
    const file = path.join(dir, "vectors.bin");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).size).toBe(16 + 10 * 16 + 10 * DIMS * 4);
    const bytes = fs.readFileSync(file);
    for (const needle of ["secret-body", "number", "emb.example.com", "sk-secret", "small"])
      expect(bytes.includes(Buffer.from(needle))).toBe(false);
    expect(row(matrix!, 0)).toEqual([
      ...(await loadVectorCache(dir, () => {})).vectors.get(cacheKeys(model, texts)[0]!)!
    ]);
  });

  it("makes no request on the second start and gives the same vectors", async () => {
    const texts = passages(10);
    const first = await run(fakeEndpoint(), texts).done;
    const endpoint = fakeEndpoint();
    const { done, log } = run(endpoint, texts);
    const second = await done;
    expect(endpoint.requests).toBe(0);
    expect(second!.data).toEqual(first!.data);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("10 from the cache, 0 to embed"));
  });

  it("embeds only the passages that changed or are new", async () => {
    const texts = passages(10);
    await run(fakeEndpoint(), texts).done;
    const edited = [...texts];
    edited[3] = "an edited passage";
    edited.push("a new passage");
    const endpoint = fakeEndpoint();
    const matrix = await run(endpoint, edited).done;
    expect(endpoint.inputs.flat().sort()).toEqual(["a new passage", "an edited passage"]);
    expect(matrix!.count).toBe(11);
    const full = await run(fakeEndpoint(), edited, { cacheDir: undefined }).done;
    expect(matrix!.data).toEqual(full!.data);
  });

  it("drops entries for passages that no longer exist", async () => {
    await run(fakeEndpoint(), passages(10)).done;
    await run(fakeEndpoint(), passages(4)).done;
    expect(fs.statSync(path.join(dir, "vectors.bin")).size).toBe(16 + 4 * 16 + 4 * DIMS * 4);
    expect((await loadVectorCache(dir, () => {})).entries).toBe(4);
  });

  it("does not use vectors cached for another model or endpoint", async () => {
    const texts = passages(6);
    await run(fakeEndpoint(), texts).done;
    const other = fakeEndpoint();
    await run(other, texts, { model: { ...model, model: "large" } }).done;
    expect(other.embedded).toBe(6);
    const elsewhere = fakeEndpoint();
    await run(elsewhere, texts, { model: { ...model, model: "large", baseUrl: "https://b.example.com/v1" } }).done;
    expect(elsewhere.embedded).toBe(6);
    expect((await loadVectorCache(dir, () => {})).entries).toBe(6);
  });

  it("embeds a repeated passage once", async () => {
    const endpoint = fakeEndpoint();
    const matrix = await run(endpoint, ["same", "other", "same", "same"]).done;
    expect(endpoint.embedded).toBe(2);
    expect(row(matrix!, 2)).toEqual(row(matrix!, 0));
    expect(row(matrix!, 3)).toEqual(row(matrix!, 0));
    expect((await loadVectorCache(dir, () => {})).entries).toBe(2);
  });

  it("reads and writes nothing without a directory", async () => {
    const endpoint = fakeEndpoint();
    await run(endpoint, passages(5), { cacheDir: undefined }).done;
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(endpoint.embedded).toBe(5);
  });

  it("ignores the cache but rewrites it when asked to", async () => {
    const texts = passages(5);
    await run(fakeEndpoint(), texts).done;
    const endpoint = fakeEndpoint();
    await run(endpoint, texts, { ignoreCache: true }).done;
    expect(endpoint.embedded).toBe(5);
    expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]);
  });

  it.each([
    ["garbage", () => Buffer.from("this is not a cache file at all, just words")],
    ["empty", () => Buffer.alloc(0)],
    [
      "truncated",
      () => {
        const whole = fs.readFileSync(path.join(dir, "vectors.bin"));
        return whole.subarray(0, whole.length - 7);
      }
    ],
    ["too long", () => Buffer.concat([fs.readFileSync(path.join(dir, "vectors.bin")), Buffer.from("extra")])],
    [
      "a size that is not valid",
      () => {
        const whole = Buffer.from(fs.readFileSync(path.join(dir, "vectors.bin")));
        whole.writeUInt32LE(0, 8);
        return whole;
      }
    ]
  ])("embeds again, logs it and repairs the cache when the file is %s", async (_name, damage) => {
    const texts = passages(8);
    await run(fakeEndpoint(), texts).done;
    fs.writeFileSync(path.join(dir, "vectors.bin"), damage());
    const endpoint = fakeEndpoint();
    const { done, log } = run(endpoint, texts);
    const matrix = await done;
    expect(matrix).toBeDefined();
    expect(endpoint.embedded).toBe(8);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ignoring vectors.bin"));
    const again = fakeEndpoint();
    await run(again, texts).done;
    expect(again.requests).toBe(0);
  });

  it("ignores cached vectors of another size when the model answers with a different size", async () => {
    const texts = passages(8);
    await run(fakeEndpoint({ dims: 3 }), texts.slice(0, 4)).done;
    // Same keys, but the model now answers with 6 numbers. The cached 3-number vectors must not be mixed in.
    const endpoint = fakeEndpoint({ dims: DIMS });
    const { done, log } = run(endpoint, texts);
    const matrix = await done;
    expect(matrix).toMatchObject({ dimensions: DIMS, count: 8 });
    expect(endpoint.embedded).toBe(8 + 4);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("do not match the model"));
    const full = await run(fakeEndpoint(), texts, { cacheDir: undefined }).done;
    expect(matrix!.data).toEqual(full!.data);
  });

  it("writes through a temp file and a rename, and leaves the old file alone if that fails", async () => {
    const texts = passages(6);
    await run(fakeEndpoint(), texts).done;
    const before = fs.readFileSync(path.join(dir, "vectors.bin"));
    const rename = vi.spyOn((await import("node:fs/promises")).default, "rename").mockRejectedValue(new Error("disk"));
    const { done, log } = run(fakeEndpoint(), [...texts, "one more"]);
    const matrix = await done;
    expect(matrix).toMatchObject({ count: 7 });
    expect(rename).toHaveBeenCalled();
    expect(String(rename.mock.calls[0]![0])).toContain(".tmp-");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cannot save"));
    expect(fs.readFileSync(path.join(dir, "vectors.bin")).equals(before)).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("creates the directory private, and the matrix and file survive a reload with every row in place", async () => {
    const nested = path.join(dir, "a", "b");
    const entries = [
      { key: "k".repeat(16), vector: Float32Array.of(1, 2, 3) },
      { key: "j".repeat(16), vector: Float32Array.of(4, 5, 6) }
    ];
    await compactVectorCache(nested, entries, []);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    const loaded = await loadVectorCache(nested, () => {});
    expect([...loaded.vectors.get("j".repeat(16))!]).toEqual([4, 5, 6]);
  });

  it("never loads an unrelated file in the directory", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    fs.writeFileSync(path.join(dir, "part-zz.bin"), "not hex, not ours");
    const log = vi.fn();
    expect((await loadVectorCache(dir, log)).vectors.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect((await loadVectorCache(path.join(dir, "missing"), log)).vectors.size).toBe(0);
  });

  it("saves part files as it goes, and compacts them at the end", async () => {
    const endpoint = fakeEndpoint();
    await run(endpoint, passages(12), { saveEvery: 4 }).done;
    expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]);
    await saveVectorPart(dir, []);
    expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]);
  });
});

describe("a start that is interrupted", () => {
  it("keeps what it embedded, and the next start resumes from there", async () => {
    const texts = passages(20);
    const failing = fakeEndpoint({ fail: (call) => (call > 3 ? new Response("no", { status: 400 }) : undefined) });
    const { done, log } = run(failing, texts, { saveEvery: 4, concurrency: 1 });
    expect(await done).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("gave up"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("12 embedded so far are saved"));
    expect(fs.readdirSync(dir).some((name) => name.startsWith("part-"))).toBe(true);

    const resume = fakeEndpoint();
    const matrix = await run(resume, texts).done;
    expect(resume.embedded).toBe(8);
    const full = await run(fakeEndpoint(), texts, { cacheDir: undefined }).done;
    expect(matrix!.data).toEqual(full!.data);
    expect(fs.readdirSync(dir)).toEqual(["vectors.bin"]);
  });
});

describe("a job that is cancelled", () => {
  /** Answers `answers` requests, then holds the next one until its request is aborted, as fetch would. */
  const holding = (answers: number) => {
    const base = fakeEndpoint();
    const held: AbortSignal[] = [];
    const request = (async (url: string, init: RequestInit) => {
      if (base.inputs.length < answers) return base.request(url as never, init);
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init.signal!;
      held.push(signal);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      return promise;
    }) as unknown as typeof fetch;
    return { request, held, inputs: base.inputs };
  };

  it("stops in the middle, writes nothing more to the cache and gives no result", async () => {
    const endpoint = holding(2);
    const controller = new AbortController();
    const { done, log } = run(endpoint, passages(20), { saveEvery: 4, concurrency: 1, signal: controller.signal });
    await vi.waitFor(() => expect(endpoint.held).toHaveLength(1));
    controller.abort();
    expect(await done).toBeUndefined();
    // What was saved before is kept. The held batch and the rest are neither embedded nor saved, and the
    // job has ended, so nothing is written after this.
    const kept = fs.readdirSync(dir).sort();
    expect(kept.filter((name) => name.startsWith("part-"))).toHaveLength(2);
    expect(kept).not.toContain("vectors.bin");
    expect(endpoint.inputs).toHaveLength(2);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("stopped after 8 of 20"));
  });

  it("writes no vectors.bin when cancelled after the endpoint's last reply", async () => {
    const controller = new AbortController();
    const base = fakeEndpoint();
    let replies = 0;
    const endpoint = {
      ...base,
      request: (async (url: string, init: RequestInit) => {
        const response = await base.request(url as never, init);
        // The last reply is in: the job is replaced before it gets to compact the cache.
        if (++replies === 2) controller.abort();
        return response;
      }) as unknown as typeof fetch
    } as Fake;
    const { done, log } = run(endpoint, passages(2), { batchSize: 1, signal: controller.signal });
    expect(await done).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("stopped after 2 of 2"));
  });

  it("does not compact the cache when cancelled while its last part file is being written", async () => {
    const rename = fsp.rename.bind(fsp);
    const writing = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      // The part file's rename into place, held until the test lets it finish.
      writing.resolve();
      await written.promise;
      return rename(from, to);
    });
    const controller = new AbortController();
    const { done, log } = run(fakeEndpoint(), passages(2), { saveEvery: 2, signal: controller.signal });
    await writing.promise;
    // Past the job's check for a cancellation: it is now waiting for the write before it compacts.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    written.resolve();
    expect(await done).toBeUndefined();
    const names = fs.readdirSync(dir);
    expect(names.some((name) => name.startsWith("part-"))).toBe(true);
    expect(names).not.toContain("vectors.bin");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("stopped after 2 of 2"));
  });

  it("does not ask again when cancelled while it waits to retry", async () => {
    const endpoint = fakeEndpoint({ fail: () => new Response("down", { status: 500 }) });
    const controller = new AbortController();
    const { done, log } = run(endpoint, passages(3), {
      backoffMs: 60_000,
      cacheDir: undefined,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(endpoint.requests).toBe(1));
    controller.abort();
    expect(await done).toBeUndefined();
    expect(endpoint.requests).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does nothing when it starts cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const endpoint = holding(0);
    const { done, log } = run(endpoint, passages(5), { signal: controller.signal });
    expect(await done).toBeUndefined();
    expect(endpoint.inputs).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("waits 1 s, then 2 s, then 4 s on a 429 and then succeeds", async () => {
    vi.useFakeTimers();
    const endpoint = fakeEndpoint({
      fail: (call) => (call <= 3 ? new Response("slow down", { status: 429 }) : undefined)
    });
    const { done, log } = run(endpoint, passages(3), { backoffMs: 1000, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(endpoint.requests).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(endpoint.requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(endpoint.requests).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(endpoint.requests).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(endpoint.requests).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10);
    expect(await done).toMatchObject({ count: 3 });
    expect(endpoint.requests).toBe(4);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("retries a 500 and a network error, but not a 400", async () => {
    vi.useFakeTimers();
    let n = 0;
    const flaky = (async (_url: string, init: RequestInit) => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      if (n === 2) return new Response("oops", { status: 503 });
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
    }) as unknown as typeof fetch;
    const { done } = run({ request: flaky } as Fake, passages(2), { backoffMs: 10, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(await done).toBeDefined();
    expect(n).toBe(3);

    const bad = fakeEndpoint({ fail: () => new Response("no", { status: 400 }) });
    const second = run(bad, passages(2), { cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(await second.done).toBeUndefined();
    expect(bad.requests).toBe(1);
  });

  it("gives up after the set number of tries, and says keyword search stays on", async () => {
    vi.useFakeTimers();
    const endpoint = fakeEndpoint({ fail: () => new Response("down", { status: 500 }) });
    const { done, log } = run(endpoint, passages(3), { attempts: 3, backoffMs: 100, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBeUndefined();
    expect(endpoint.requests).toBe(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatch(
      /gave up, keyword search is used: embeddings: the endpoint answered with status 500/
    );
    expect(log.warn.mock.calls[0]![0]).not.toContain("sk-secret");
  });

  it("marks only timeouts, network errors, 429 and 5xx as retryable", () => {
    expect(new EmbeddingError("x", true).retryable).toBe(true);
    expect(new EmbeddingError("x", false).retryable).toBe(false);
  });
});

describe("concurrency", () => {
  it.each([1, 2, 3])("never has more than %i requests in flight", async (concurrency) => {
    const endpoint = fakeEndpoint();
    await run(endpoint, passages(40), { concurrency, batchSize: 2, cacheDir: undefined }).done;
    expect(endpoint.requests).toBe(20);
    expect(endpoint.peak).toBe(concurrency);
  });

  it("logs progress in steps, not once per batch", async () => {
    const { done, log } = run(fakeEndpoint(), passages(200), { batchSize: 2, cacheDir: undefined });
    await done;
    const progress = log.info.mock.calls.map(([m]) => m).filter((m) => /\d+% \(/.test(m));
    expect(progress.length).toBeLessThanOrEqual(10);
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("compaction leaves other writers alone", () => {
  const entry = (tag: string) => ({ key: tag.repeat(16), vector: Float32Array.of(1, 2, 3) });

  it("removes only the part files it was given, and only temp files older than ten minutes", async () => {
    const mine = await saveVectorPart(dir, [entry("a")]);
    const theirs = await saveVectorPart(dir, [entry("b")]);
    const fresh = path.join(dir, ".tmp-1-fresh");
    const old = path.join(dir, ".tmp-2-old");
    fs.writeFileSync(fresh, "x");
    fs.writeFileSync(old, "x");
    const longAgo = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    await compactVectorCache(dir, [entry("c")], [mine!]);
    expect(fs.readdirSync(dir).sort()).toEqual([".tmp-1-fresh", theirs, "vectors.bin"].sort());
  });

  it("keeps a part file another writer saved while this job was embedding", async () => {
    let foreign: string | undefined;
    let asked = false;
    const base = fakeEndpoint();
    const endpoint = {
      ...base,
      request: (async (url: string, init: RequestInit) => {
        if (!asked) {
          asked = true;
          foreign = await saveVectorPart(dir, [{ key: "z".repeat(16), vector: new Float32Array(DIMS) }]);
        }
        return base.request(url as never, init);
      }) as unknown as typeof fetch
    } as Fake;
    await run(endpoint, passages(6), { saveEvery: 2 }).done;
    expect(fs.readdirSync(dir).sort()).toEqual([foreign, "vectors.bin"].sort());
  });
});

describe("reading the cache directory safely", () => {
  it("does not open a FIFO, follow a symbolic link or read an oversized file", async () => {
    const warn = vi.fn();
    execFileSync("mkfifo", [path.join(dir, "vectors.bin")]);
    expect((await loadVectorCache(dir, warn)).vectors.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    fs.rmSync(path.join(dir, "vectors.bin"));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kb-outside-"));
    try {
      await compactVectorCache(outside, [{ key: "k".repeat(16), vector: Float32Array.of(1) }], []);
      fs.symlinkSync(path.join(outside, "vectors.bin"), path.join(dir, "vectors.bin"));
      const linked = await loadVectorCache(dir, warn);
      expect(linked.vectors.size).toBe(0);
      expect(linked.damaged).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
    fs.rmSync(path.join(dir, "vectors.bin"));

    const big = path.join(dir, "part-ab.bin");
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, 2 * 1024 * 1024 * 1024 + 1);
    expect((await loadVectorCache(dir, warn)).vectors.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("reads at most 1,000 part files and says so once", async () => {
    for (let i = 0; i < 1002; i++) fs.writeFileSync(path.join(dir, `part-${i.toString(16).padStart(4, "0")}.bin`), "x");
    const warn = vi.fn();
    const loaded = await loadVectorCache(dir, warn);
    expect(loaded.parts).toHaveLength(1000);
    expect(warn.mock.calls.filter(([m]) => /more than 1000 part files/.test(m))).toHaveLength(1);
  });

  it("returns undefined and logs, instead of throwing, when something unexpected goes wrong", async () => {
    const log = logger();
    const result = await embedKnowledgePassages({
      model,
      texts: [undefined as unknown as string],
      cacheDir: dir,
      log
    });
    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("keyword search is used"));
  });
});

describe("retry details", () => {
  it("retries a body that is not JSON and a wrong count of vectors", async () => {
    vi.useFakeTimers();
    let n = 0;
    const flaky = (async (_url: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Response("<html>proxy</html>", { status: 200 });
      if (n === 2) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
    }) as unknown as typeof fetch;
    const { done } = run({ request: flaky } as Fake, passages(2), { backoffMs: 10, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(100);
    expect(await done).toBeDefined();
    expect(n).toBe(3);
  });

  it.each([
    ["429", "2", 2000],
    ["503", "120", 30_000],
    ["429", "0", 0]
  ])("waits as long as Retry-After says on a %s (%s s, capped at 30 s)", async (status, seconds, expected) => {
    vi.useFakeTimers();
    const endpoint = fakeEndpoint({
      fail: (call) =>
        call === 1 ? new Response("no", { status: Number(status), headers: { "retry-after": seconds } }) : undefined
    });
    const { done } = run(endpoint, passages(2), { backoffMs: 1000, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(Math.max(0, expected - 1));
    expect(endpoint.requests).toBe(expected === 0 ? 2 : 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(endpoint.requests).toBe(2);
    expect(await done).toBeDefined();
  });

  it("ignores a Retry-After that is a date, or is on another status, and keeps the normal backoff", async () => {
    vi.useFakeTimers();
    const endpoint = fakeEndpoint({
      fail: (call) =>
        call === 1
          ? new Response("no", { status: 500, headers: { "retry-after": "5" } })
          : call === 2
            ? new Response("no", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } })
            : undefined
    });
    const { done } = run(endpoint, passages(2), { backoffMs: 1000, cacheDir: undefined });
    await vi.advanceTimersByTimeAsync(999);
    expect(endpoint.requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(endpoint.requests).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(endpoint.requests).toBe(3);
    await vi.advanceTimersByTimeAsync(10);
    expect(await done).toBeDefined();
  });

  it("does not let a backoff wait keep the process alive", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const endpoint = fakeEndpoint({ fail: (call) => (call === 1 ? new Response("no", { status: 500 }) : undefined) });
    await run(endpoint, passages(2), { backoffMs: 1, cacheDir: undefined }).done;
    const timers = spy.mock.results.map((result) => result.value as NodeJS.Timeout);
    expect(timers.some((timer) => !timer.hasRef())).toBe(true);
  });
});
