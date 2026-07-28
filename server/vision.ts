/**
 * Describing one frame the rider asked about.
 *
 * Separate from the realtime speech socket, which has no image input. Returns
 * null on every failure rather than throwing: the caller speaks "我看不清" and
 * a guessed description about what is ahead is worse than silence.
 *
 * Nothing is cached. The synthesizer in speech.ts caches by text because a
 * confirmation is always the same sentence; a scene never is.
 *
 * Credentials: `ARK_API_KEY` / `ARK_BASE_URL` / `ARK_MODEL` (Volcano Ark), not
 * `DOUBAO_API_KEY` — that key authenticates the realtime speech socket, not
 * Ark's chat-completions endpoint, and sending it here would not work and
 * would blur which credential actually gates this feature. There is
 * deliberately no fallback between them; see server/providers/doubao.ts.
 */

/** Fallback endpoint used when the caller does not pass one explicitly (i.e.
 *  ARK_BASE_URL is unset). Matches ARK_BASE_URL + "/chat/completions" as
 *  measured in Task 1's report — see the callers in providers/doubao.ts, which
 *  derive the endpoint from ARK_BASE_URL when it is set. */
export const VISION_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

const DEFAULT_PROMPT = "用一句话描述这张照片里的场景，简洁自然，像对骑手说话。";
const DEFAULT_TIMEOUT_MS = 10_000;

export type DescriberOptions = {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  prompt?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onFailure?: (reason: string) => void;
};

export function createDescriber(options: DescriberOptions): (imageBase64: string) => Promise<string | null> {
  const {
    apiKey,
    model,
    endpoint = VISION_ENDPOINT,
    prompt = DEFAULT_PROMPT,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onFailure
  } = options;

  let loggedMissingKey = false;

  return async function describe(imageBase64: string): Promise<string | null> {
    if (!apiKey || !model) {
      if (!loggedMissingKey) {
        loggedMissingKey = true;
        onFailure?.("not configured");
      }
      return null;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
              ]
            }
          ]
        }),
        signal: abort.signal
      });
      if (!response.ok) {
        onFailure?.(`rejected — http ${response.status}`);
        return null;
      }
      // UNVERIFIED response shape. `choices[0].message.content` is the
      // documented OpenAI-compatible shape for Ark's chat-completions endpoint,
      // and matches what this parser assumes — but no successful call has ever
      // been made from this project. Task 1's probe (see
      // .superpowers/sdd/2026-07-28-vision-describe/task-1-report.md) never got
      // past authentication: the configured ARK_API_KEY was rejected with
      // HTTP 401 "The API key doesn't exist" on every attempt, so the real
      // response body — and whether the model even accepts an image — was
      // never observed. This parser is a best-effort guess at the documented
      // shape, not a confirmed one. It would be confirmed by a successful call
      // against the real endpoint with a valid ARK_API_KEY, logging (not
      // guessing) the actual JSON body that comes back.
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) {
        onFailure?.("no description in the response");
        return null;
      }
      return text;
    } catch (error) {
      onFailure?.(abort.signal.aborted ? "timed out" : `failed — ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
