import type { AnalysisResult } from "./conversation-analysis";
import type { ConversationTurn } from "./cloud/conversations";
import { signatureHeaders, urlAllowed } from "./tools/webhook";

/**
 * The end-of-conversation webhook: when a session ends the relay POSTs the
 * transcript (redacted if the owner asked for that) and the optional analysis
 * to CONVERSATION_WEBHOOK_URL, signed like tool webhooks (see
 * server/tools/webhook.ts: `x-voice-agent-signature` is an HMAC-SHA256 of
 * `<timestamp>.<body>`). `x-voice-agent-delivery` carries `payload.id`, which
 * stays the same across retries so the receiver can de-duplicate.
 */

export type ConversationEndedPayload = {
  type: "conversation.ended";
  /** Unique per delivery attempt group; the receiver can de-duplicate on it. */
  id: string;
  session: {
    id: string;
    userId?: string;
    backend: string;
    channel: "web" | "phone";
    startedAt: number;
    endedAt: number;
    seconds: number;
    endReason?: string;
    /** The config's `version`, and the variant this conversation was given, when the config has them. */
    version?: string;
    variant?: string;
    phone?: { direction: "inbound" | "outbound"; from?: string; to?: string; callSid?: string };
  };
  transcript: ConversationTurn[];
  /** The audio, when the relay records conversations: fetch it with GET /v1/recordings/<file>. */
  recording?: { file: string; durationMs: number };
  /** What the guardrails found, in order. `stopped` says whether the words were cut before they were all heard. */
  guardrails?: GuardrailFinding[];
  analysis?: AnalysisResult;
  /** Why there is no analysis, when one was configured. */
  analysisError?: string;
};

export type GuardrailFinding = {
  speaker: "assistant" | "user";
  /**
   * A blocked term, a rule a model judged broken, a tool call a rule for tools
   * refused, or what a tool returned that a rule for results withheld.
   */
  kind: "term" | "rule" | "tool" | "result";
  /** The term or the rule, as the config has it. */
  rule: string;
  /** With `tool`: the tool that was not run. With `result`: the tool whose result was withheld. */
  tool?: string;
  at: number;
  stopped: boolean;
};

export type ConversationWebhook = { url: string; secret?: string };

/** From CONVERSATION_WEBHOOK_URL / CONVERSATION_WEBHOOK_SECRET. Returns a problem for a URL that is not
 *  allowed (same rule as tool webhooks: https, or plain http to local/private hosts). */
export function conversationWebhookFromEnv(env: NodeJS.ProcessEnv = process.env): {
  webhook?: ConversationWebhook;
  problem?: string;
} {
  const url = env.CONVERSATION_WEBHOOK_URL?.trim();
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: "CONVERSATION_WEBHOOK_URL is not a URL" };
  }
  if (!urlAllowed(parsed))
    return { problem: "CONVERSATION_WEBHOOK_URL must be https (plain http only to local or private hosts)" };
  const secret = env.CONVERSATION_WEBHOOK_SECRET?.trim();
  return { webhook: { url, ...(secret ? { secret } : {}) } };
}

const ATTEMPT_TIMEOUT_MS = 10_000;
/** Waits after the first, second and third failed attempt: four attempts in all. */
const RETRY_WAITS_MS = [1_000, 5_000, 25_000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Delivers one payload: signed like tool webhooks (`signatureHeaders` from server/tools/webhook.ts) when a secret
 *  is set, 10 s per attempt, `redirect: "error"`, up to 4 attempts with waits of 1 s, 5 s and 25 s after a network
 *  error, a timeout, HTTP 408/429 or 5xx; any other status is final. Resolves with the outcome; never rejects. */
export async function deliverConversation(
  payload: ConversationEndedPayload,
  webhook: ConversationWebhook,
  options: {
    request?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<{ ok: boolean; attempts: number; status?: number; error?: string }> {
  const request = options.request ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  let status: number | undefined;
  let error: string | undefined;
  try {
    const body = JSON.stringify(payload);
    for (;;) {
      if (options.signal?.aborted)
        return { ok: false, attempts, ...(status ? { status } : {}), error: "delivery was cancelled" };
      attempts += 1;
      status = undefined;
      let wait = true;
      try {
        const signals = [AbortSignal.timeout(ATTEMPT_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
        const response = await request(webhook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-voice-agent-event": payload.type,
            "x-voice-agent-delivery": payload.id,
            // A fresh timestamp per attempt, so a retry minutes later is not a stale replay.
            ...(webhook.secret ? signatureHeaders(body, webhook.secret, now()) : {})
          },
          body,
          signal: AbortSignal.any(signals),
          redirect: "error"
        });
        status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) return { ok: true, attempts, status };
        error = `HTTP ${response.status}`;
        wait = retryable(response.status);
      } catch (caught) {
        if (options.signal?.aborted) return { ok: false, attempts, error: "delivery was cancelled" };
        error = describe(caught);
      }
      const delay = RETRY_WAITS_MS[attempts - 1];
      if (!wait || delay === undefined) return { ok: false, attempts, ...(status ? { status } : {}), error };
      await sleep(delay);
    }
  } catch (caught) {
    return { ok: false, attempts, ...(status ? { status } : {}), error: error ?? describe(caught) };
  }
}

/** A short reason with no URL in it: fetch errors can repeat the address, query string included. */
function describe(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "request timed out";
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string" && /^[A-Z0-9_]{3,40}$/.test(cause.code)) return `network error (${cause.code})`;
  if (error instanceof Error && /redirect/i.test(error.message)) return "the server redirected, which is not followed";
  return "network error";
}
