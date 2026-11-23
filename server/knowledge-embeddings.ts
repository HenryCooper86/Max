import { urlAllowed } from "./tools/webhook";

/**
 * Optional embeddings for the knowledge base: configuration from the environment
 * and a client for any OpenAI-compatible `/embeddings` endpoint (a hosted API or
 * a local server). Off unless `KNOWLEDGE_EMBEDDINGS_MODEL` is set.
 *
 * Errors thrown from here name a status or a shape problem only. They never
 * carry the response body, the URL's query string or the key.
 */

export type EmbeddingModel = { baseUrl: string; model: string; apiKey?: string };

const OPENAI_URL = "https://api.openai.com/v1";
const MAX_TEXT_CHARS = 8000;
const DEFAULT_BATCH = 64;
const MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_MAX_PASSAGES = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Reads `KNOWLEDGE_MAX_PASSAGES`: the most passages that get embeddings. Larger knowledge bases stay on keyword search. */
export function maxPassagesFromEnv(env: NodeJS.ProcessEnv = process.env): { value: number; problem?: string } {
  const raw = env.KNOWLEDGE_MAX_PASSAGES?.trim();
  if (!raw) return { value: DEFAULT_MAX_PASSAGES };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    return {
      value: DEFAULT_MAX_PASSAGES,
      problem: `KNOWLEDGE_MAX_PASSAGES must be a whole number of at least 1; ${DEFAULT_MAX_PASSAGES} is used`
    };
  return { value };
}

/** Reads `KNOWLEDGE_EMBEDDINGS_MODEL`, `_BASE_URL` and `_API_KEY`. `OPENAI_API_KEY` is used only
 *  when the endpoint is OpenAI's own, so that key never goes to another host. */
export function embeddingModelFromEnv(env: NodeJS.ProcessEnv = process.env): {
  model?: EmbeddingModel;
  problem?: string;
} {
  const get = (name: string) => env[name]?.trim() || undefined;
  const model = get("KNOWLEDGE_EMBEDDINGS_MODEL");
  if (!model) return {};
  const baseUrl = (get("KNOWLEDGE_EMBEDDINGS_BASE_URL") ?? OPENAI_URL).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { problem: "KNOWLEDGE_EMBEDDINGS_BASE_URL is not a valid URL, so embeddings are off" };
  }
  if (!urlAllowed(parsed))
    return {
      problem:
        "KNOWLEDGE_EMBEDDINGS_BASE_URL must be https (plain http only to a local or private host), so embeddings are off"
    };
  const isOpenAi = baseUrl === OPENAI_URL;
  const apiKey = get("KNOWLEDGE_EMBEDDINGS_API_KEY") ?? (isOpenAi ? get("OPENAI_API_KEY") : undefined);
  if (isOpenAi && !apiKey)
    return {
      problem: "KNOWLEDGE_EMBEDDINGS_MODEL needs KNOWLEDGE_EMBEDDINGS_API_KEY or OPENAI_API_KEY, so embeddings are off"
    };
  return { model: { baseUrl, model, ...(apiKey ? { apiKey } : {}) } };
}

/** `retryable` is true for a failure that may pass by itself: a timeout, a network error, a 429 or a 5xx, a body
 *  that is not JSON, a wrong count of vectors. `retryAfterMs` is the server's `Retry-After`, at most 30 s. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number
  ) {
    super(`embeddings: ${message}`);
    this.name = "EmbeddingError";
  }
}

function failure(message: string, retryable = false, retryAfterMs?: number): never {
  throw new EmbeddingError(message, retryable, retryAfterMs);
}

function normalise(values: number[]): Float32Array {
  const vector = new Float32Array(values);
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (!(length > 0) || !Number.isFinite(length)) failure("a vector has no length");
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] as number) / length;
  return vector;
}

async function embedBatch(model: EmbeddingModel, texts: string[], request: typeof fetch, timeoutMs: number) {
  let response: Response;
  try {
    response = await request(`${model.baseUrl}/embeddings`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {})
      },
      body: JSON.stringify({ model: model.model, input: texts.map((text) => text.slice(0, MAX_TEXT_CHARS)) })
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    failure(name === "TimeoutError" || name === "AbortError" ? "the request timed out" : "the request failed", true);
  }
  if (!response.ok) {
    const after = response.headers.get("retry-after")?.trim() ?? "";
    // Only a number of seconds is honoured (not a date), and never for longer than 30 s.
    const retryAfterMs =
      (response.status === 429 || response.status === 503) && /^\d+(\.\d+)?$/.test(after)
        ? Math.min(MAX_RETRY_AFTER_MS, Number(after) * 1000)
        : undefined;
    failure(
      `the endpoint answered with status ${response.status}`,
      response.status === 429 || response.status >= 500,
      retryAfterMs
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    failure("the response is not JSON", true);
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) failure("the response has no data list");
  if (data.length !== texts.length) failure(`expected ${texts.length} vectors, got ${data.length}`, true);
  const sorted = data.map((item, position) => {
    const entry = item as { index?: unknown; embedding?: unknown } | null;
    const index = typeof entry?.index === "number" ? entry.index : position;
    if (!Array.isArray(entry?.embedding) || entry.embedding.length === 0) failure("a vector is missing or empty");
    if (!entry.embedding.every((value: unknown) => typeof value === "number" && Number.isFinite(value)))
      failure("a vector holds a value that is not a finite number");
    return { index, embedding: entry.embedding as number[] };
  });
  sorted.sort((a, b) => a.index - b.index);
  if (sorted.some((item, i) => item.index !== i)) failure("the vector indexes are not consecutive");
  return sorted.map((item) => item.embedding);
}

/** Embeds texts in batches. Every vector comes back L2-normalised, in input order, so cosine similarity
 *  is a dot product. Throws an Error that leaks neither the body, the query string nor the key. */
export async function embedTexts(
  model: EmbeddingModel,
  texts: string[],
  options: { request?: typeof fetch; timeoutMs?: number; batchSize?: number } = {}
): Promise<Float32Array[]> {
  const request = options.request ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH));
  const raw: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize)
    raw.push(...(await embedBatch(model, texts.slice(start, start + batchSize), request, timeoutMs)));
  const dimensions = raw[0]?.length ?? 0;
  if (raw.some((vector) => vector.length !== dimensions)) failure("the vectors differ in length");
  return raw.map(normalise);
}
