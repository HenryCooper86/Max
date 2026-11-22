import { cacheKeys, compactVectorCache, loadVectorCache, saveVectorPart, type CacheEntry } from "./knowledge-cache";
import { EmbeddingError, embedTexts, type EmbeddingModel } from "./knowledge-embeddings";
import type { VectorMatrix } from "./knowledge-vectors";

/**
 * Embeds every passage of the knowledge base in the background: reads what the disk cache already has,
 * sends only the rest to the endpoint in batches (a few at a time, each retried with backoff), saves
 * progress as it goes and ends by compacting the cache.
 *
 * It never throws. On a failure it gives up, says so in the log and returns undefined; the caller stays
 * on keyword search.
 */

export type EmbedJobOptions = {
  model: EmbeddingModel;
  /** The text to embed for each passage, in passage order. */
  texts: string[];
  request?: typeof fetch;
  /** Where to keep the cache. Without it nothing is read or written. */
  cacheDir?: string;
  /** Skip what the cache holds (it is still rewritten). */
  ignoreCache?: boolean;
  /** Requests in flight at once. Default 2. */
  concurrency?: number;
  /** Passages per request. Default 64. */
  batchSize?: number;
  /** Tries per batch, the first included. Default 4. */
  attempts?: number;
  /** Wait before the second try; it doubles after each. Default 1000. */
  backoffMs?: number;
  /** New vectors to collect before a part file is written. Default 5000. */
  saveEvery?: number;
  log: { info(message: string): void; warn(message: string): void };
};

const wait = (ms: number) =>
  new Promise<void>((done) => {
    // Unreferenced, so a backoff wait cannot keep a process that is shutting down alive.
    setTimeout(done, ms).unref();
  });

export async function embedKnowledgePassages(options: EmbedJobOptions): Promise<VectorMatrix | undefined> {
  try {
    return await runJob(options);
  } catch (error) {
    // Everything in the job is under this guard, so a surprise (a bad cache, no memory) cannot reach the caller.
    try {
      options.log.warn(`knowledge embeddings failed, keyword search is used: ${describe(error)}`);
    } catch {
      /* a logger that throws is not worth failing for */
    }
    return undefined;
  }
}

async function runJob(options: EmbedJobOptions): Promise<VectorMatrix | undefined> {
  const { model, texts, request, cacheDir, log } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 64));
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4));
  const backoffMs = options.backoffMs ?? 1000;
  const saveEvery = Math.max(1, Math.floor(options.saveEvery ?? 5000));

  const keys = cacheKeys(model, texts);
  /** Passage row of the first passage with each key. Later passages with the same text copy from it. */
  const firstRow = new Map<string, number>();
  const repeats: [row: number, of: number][] = [];
  keys.forEach((key, row) => {
    const first = firstRow.get(key);
    if (first === undefined) firstRow.set(key, row);
    else repeats.push([row, first]);
  });

  const cache = cacheDir
    ? await loadVectorCache(cacheDir, (message) => log.warn(message))
    : { vectors: new Map<string, Float32Array>(), files: 0, entries: 0, parts: [] as string[], damaged: false };
  /** The part files this job read or wrote: the only ones it may remove when it compacts. */
  const ownParts = new Set(cache.parts);
  let hits = new Map<string, Float32Array>();
  if (!options.ignoreCache)
    for (const key of firstRow.keys()) if (cache.vectors.has(key)) hits.set(key, cache.vectors.get(key)!);
  // Cached vectors of different sizes cannot all be right. Keep the size of the first one.
  let dimensions = hits.values().next().value?.length;
  const odd = [...hits].filter(([, vector]) => vector.length !== dimensions).map(([key]) => key);
  if (odd.length) {
    log.warn(`knowledge embedding cache: ${odd.length} cached vectors have a different size and are ignored`);
    for (const key of odd) hits.delete(key);
  }

  let todo = [...firstRow.keys()].filter((key) => !hits.has(key));
  let total = todo.length;
  log.info(`knowledge embeddings: ${texts.length} passages, ${hits.size} from the cache, ${total} to embed`);

  let data: Float32Array | undefined;
  const allocate = (size: number) => {
    dimensions = size;
    data = new Float32Array(texts.length * size);
    for (const [key, vector] of hits) data.set(vector, (firstRow.get(key) as number) * size);
    // The matrix has its own copy. Let go of the file buffers the cached vectors were views of.
    hits.clear();
    cache.vectors.clear();
  };
  const hadHits = hits.size > 0;
  if (dimensions) allocate(dimensions);

  let fresh: CacheEntry[] = [];
  let embedded = 0;
  let nextTenth = 1;
  let saving: Promise<void> = Promise.resolve();
  let saveFailed = false;
  const save = (entries: CacheEntry[]) => {
    if (!cacheDir || saveFailed || !entries.length) return;
    saving = saving.then(() =>
      saveVectorPart(cacheDir, entries)
        .then((name) => {
          if (name) ownParts.add(name);
        })
        .catch((error: unknown) => {
          saveFailed = true;
          log.warn(`knowledge embedding cache: cannot save, continuing without it: ${describe(error)}`);
        })
    );
  };

  let stopped = false;
  async function embedBatch(batch: string[]): Promise<Float32Array[]> {
    const batchTexts = batch.map((key) => texts[firstRow.get(key) as number] as string);
    for (let attempt = 1; ; attempt++) {
      try {
        return await embedTexts(model, batchTexts, { request, batchSize: batchTexts.length });
      } catch (error) {
        const retry = error instanceof EmbeddingError ? error.retryable : false;
        if (!retry || attempt >= attempts || stopped) throw error;
        await wait((error as EmbeddingError).retryAfterMs ?? backoffMs * 2 ** (attempt - 1));
        if (stopped) throw error;
      }
    }
  }

  function place(batch: string[], vectors: Float32Array[]) {
    const size = vectors[0]?.length ?? 0;
    if (!size || vectors.some((vector) => vector.length !== size))
      throw new Error("the endpoint returned vectors of different sizes");
    if (!data) allocate(size);
    else if (size !== dimensions)
      throw new Error("the endpoint returned vectors of a different size than the first batch");
    batch.forEach((key, i) => {
      const row = firstRow.get(key) as number;
      (data as Float32Array).set(vectors[i] as Float32Array, row * size);
      fresh.push({ key, vector: (data as Float32Array).subarray(row * size, (row + 1) * size) });
    });
    embedded += batch.length;
    if (fresh.length >= saveEvery) {
      save(fresh);
      fresh = [];
    }
    // One line per tenth, however many tenths a batch crosses, and none for the last one: "ready" says that.
    const tenth = Math.floor((embedded * 10) / total);
    if (total >= 10 && tenth >= nextTenth && tenth < 10) {
      log.info(`knowledge embeddings: ${tenth * 10}% (${embedded} of ${total})`);
      nextTenth = tenth + 1;
    }
  }

  const batchesOf = (keysToEmbed: string[]) => {
    const batches: string[][] = [];
    for (let i = 0; i < keysToEmbed.length; i += batchSize) batches.push(keysToEmbed.slice(i, i + batchSize));
    return batches;
  };

  try {
    let queue = batchesOf(todo);
    if (hadHits && queue.length) {
      // The first batch runs alone: it shows whether the cache and the endpoint agree on the vector size.
      const first = queue.shift() as string[];
      const vectors = await embedBatch(first);
      if (vectors[0]?.length === dimensions) place(first, vectors);
      else {
        log.warn("knowledge embedding cache: cached vectors do not match the model, so everything is embedded again");
        hits = new Map();
        data = undefined;
        dimensions = undefined;
        todo = [...firstRow.keys()];
        total = todo.length;
        queue = batchesOf(todo);
      }
    }
    const worker = async () => {
      try {
        for (let batch = queue.shift(); batch && !stopped; batch = queue.shift()) place(batch, await embedBatch(batch));
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      stopped = true;
      throw (failure as PromiseRejectedResult).reason;
    }
  } catch (error) {
    stopped = true;
    save(fresh);
    await saving;
    const saved = cacheDir && !saveFailed ? `; ${embedded} embedded so far are saved and the next start resumes` : "";
    log.warn(`knowledge embeddings gave up, keyword search is used: ${describe(error)}${saved}`);
    return undefined;
  }

  if (!data || !dimensions) {
    log.warn("knowledge embeddings: there was nothing to embed");
    return undefined;
  }
  for (const [row, of] of repeats) data.copyWithin(row * dimensions, of * dimensions, (of + 1) * dimensions);
  if (cacheDir && !saveFailed) {
    const unchanged =
      embedded === 0 && !cache.damaged && cache.files === 1 && cache.entries === firstRow.size && !options.ignoreCache;
    await saving;
    if (!unchanged) {
      const size = dimensions;
      const all = data;
      const live = [...firstRow].map(([key, row]) => ({ key, vector: all.subarray(row * size, (row + 1) * size) }));
      try {
        await compactVectorCache(cacheDir, live, [...ownParts]);
      } catch (error) {
        log.warn(`knowledge embedding cache: cannot save, continuing without it: ${describe(error)}`);
      }
    }
  }
  log.info(`knowledge embeddings ready: ${texts.length} passages, ${embedded} embedded now, ${dimensions} dimensions`);
  return { data, dimensions, count: texts.length };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
