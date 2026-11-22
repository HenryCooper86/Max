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
const DEFAULT_TIMEOUT_MS = 30_000;

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

function failure(message: string): never {
  throw new Error(`embeddings: ${message}`);
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
    failure(name === "TimeoutError" || name === "AbortError" ? "the request timed out" : "the request failed");
  }
  if (!response.ok) failure(`the endpoint answered with status ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    failure("the response is not JSON");
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) failure("the response has no data list");
  if (data.length !== texts.length) failure(`expected ${texts.length} vectors, got ${data.length}`);
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
