// Max Cloud conversation webhooks: a project's own server is sent what was
// said in each conversation when it ends.
//
// The payload and the headers are those of the relay's own conversation
// webhook (server/conversation-webhook.ts), signed with the project's
// signing secret like its tools, and sent with the same rules as a tool call
// (server/cloud/tools.ts): https to a public address, the connection made to
// the address that was checked, no redirects. Up to four attempts.

import { randomUUID } from "node:crypto";
import type { AnalysisResult } from "../../shared/analysis";
import { deliverConversation, type ConversationEndedPayload } from "../conversation-webhook";
import { createLogger } from "../logger";
import { signatureHeaders } from "../tools/webhook";
import { now } from "./context";
import type { ConversationTurn } from "./conversations";
import { guardedFetch } from "./tools";

const log = createLogger("cloud");

/** Deliveries of one project under way at a time: a server that is down holds each for about a minute. */
const MAX_WAITING_PER_PROJECT = 20;
/** And of all projects together: each holds a conversation in memory while it waits. */
const MAX_WAITING = 200;
/** Projects whose last delivery is remembered. */
const MAX_REMEMBERED = 5_000;

/** What the project's server is sent: the relay's `conversation.ended`, with the project it belongs to and, for a session whose token named one, `session.userId`. */
export type ProjectConversationPayload = ConversationEndedPayload & {
  project: { id: string };
  /** Where the conversation came from: the website embed, the customer's own backend, or the console's Test. */
  source: string;
  /** True for the console's "Send test": nobody said this. */
  test?: true;
};

/** How the last delivery to a project's server went. Kept in memory: it starts empty when the relay restarts. */
export type WebhookDelivery = {
  at: number;
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
};

type Target = { projectId: string; url: string; secret: string | undefined };

type Ended = Target & {
  backend: string;
  source: string;
  sessionId: string;
  startedAt: number;
  /** The end user the session's token named, when it named one. */
  userId?: string;
  endedAt: number;
  seconds: number;
  turns: ConversationTurn[];
  /** What the project's analysis made of the conversation, or why it made nothing. */
  analysis?: AnalysisResult;
  analysisError?: string;
};

function payloadOf(input: Omit<Ended, "url" | "secret">, test = false): ProjectConversationPayload {
  return {
    type: "conversation.ended",
    id: randomUUID(),
    ...(test ? { test: true as const } : {}),
    project: { id: input.projectId },
    source: input.source,
    session: {
      id: input.sessionId,
      ...(input.userId ? { userId: input.userId } : {}),
      backend: input.backend,
      channel: "web",
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      seconds: Math.max(0, Math.round(input.seconds))
    },
    transcript: input.turns,
    ...(input.analysis ? { analysis: input.analysis } : {}),
    ...(input.analysisError ? { analysisError: input.analysisError } : {})
  };
}

/** A failure of one request in words for the person whose server it is. */
function inWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The request was given up on because its time was up: a server that answers too slowly.
  if (message === "cancelled" || (error instanceof Error && /^(Abort|Timeout)Error$/.test(error.name))) {
    return "your server did not answer within 10 seconds";
  }
  return message
    .replace(/^tool address /, "the address ")
    .replace("the tool did not answer", "your server did not answer")
    .slice(0, 200);
}

export function createProjectWebhooks(
  options: { request?: typeof fetch; sleep?: (ms: number) => Promise<void>; clock?: () => number } = {}
) {
  const request = options.request ?? guardedFetch;
  const clock = options.clock ?? now;
  const waiting = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  const last = new Map<string, WebhookDelivery>();
  const stopping = new AbortController();
  // The wait before another try ends when the relay stops, and does not keep the process alive.
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        stopping.signal.addEventListener("abort", done, { once: true });
      }));

  function remember(projectId: string, delivery: WebhookDelivery): void {
    last.delete(projectId);
    last.set(projectId, delivery);
    if (last.size > MAX_REMEMBERED) last.delete(last.keys().next().value!);
  }

  return {
    /**
     * A conversation of the project ended: its server is told, in the
     * background. Nothing is sent for one in which nothing was said, without
     * a signing secret (a receiver could not tell it from a forgery), or
     * while too many deliveries of the project wait on a server that is down.
     */
    ended(input: Ended): void {
      if (input.turns.length === 0) return;
      if (!input.secret) {
        log.error("a conversation was not sent to a project's server: its signing secret cannot be read", {
          projectId: input.projectId
        });
        remember(input.projectId, {
          at: clock(),
          ok: false,
          attempts: 0,
          error: "the signing secret could not be read"
        });
        return;
      }
      const under = waiting.get(input.projectId) ?? 0;
      if (under >= MAX_WAITING_PER_PROJECT || pending.size >= MAX_WAITING) {
        log.warn("a conversation was not sent to a project's server: too many are waiting", {
          projectId: input.projectId,
          ofTheProject: under,
          inAll: pending.size
        });
        remember(input.projectId, {
          at: clock(),
          ok: false,
          attempts: 0,
          error:
            under >= MAX_WAITING_PER_PROJECT
              ? `not sent: ${MAX_WAITING_PER_PROJECT} deliveries were already waiting on your server`
              : "not sent: too many deliveries were waiting"
        });
        return;
      }
      waiting.set(input.projectId, under + 1);
      const { url, secret, ...rest } = input;
      // Why a request did not go through, in the words the owner of the server is shown. (The delivery itself
      // only says "network error": the relay's own webhook must not repeat an address in a log.)
      let why: string | undefined;
      const asking: typeof fetch = async (target, init) => {
        try {
          return await request(target, init);
        } catch (error) {
          if (!stopping.signal.aborted) why = inWords(error);
          throw error;
        }
      };
      const delivery = deliverConversation(
        payloadOf(rest),
        { url, secret },
        {
          request: asking,
          now: clock,
          signal: stopping.signal,
          sleep
        }
      )
        .then((found) => {
          const outcome = found.error === "network error" && why ? { ...found, error: why } : found;
          remember(input.projectId, { at: clock(), ...outcome });
          if (!outcome.ok) {
            log.warn("a conversation did not reach a project's server", {
              projectId: input.projectId,
              attempts: outcome.attempts,
              ...(outcome.status ? { status: outcome.status } : {}),
              ...(outcome.error ? { error: outcome.error } : {})
            });
          }
        })
        .finally(() => {
          const left = (waiting.get(input.projectId) ?? 1) - 1;
          if (left > 0) waiting.set(input.projectId, left);
          else waiting.delete(input.projectId);
          pending.delete(delivery);
        });
      pending.add(delivery);
    },

    /** The console's "Send test": one request with a sample conversation, and how it went. */
    async test(target: Target): Promise<{ ok: boolean; status?: number; error?: string; ms: number }> {
      const started = Date.now();
      const at = clock();
      // A real delivery is never sent unsigned, and a test that says "it works" must be one of those.
      if (!target.secret) return { ok: false, error: "the signing secret could not be read", ms: 0 };
      const sample = payloadOf(
        {
          projectId: target.projectId,
          backend: "test",
          source: "test",
          sessionId: "console-test",
          startedAt: at - 42_000,
          endedAt: at,
          seconds: 42,
          turns: [
            { at: at - 40_000, speaker: "agent", text: "Hello! How can I help?" },
            { at: at - 34_000, speaker: "user", text: "Where is my order A-1042?" },
            { at: at - 32_000, speaker: "tool", text: "check_order", ok: true, ms: 412 },
            { at: at - 30_000, speaker: "agent", text: "It shipped yesterday and arrives on Friday." }
          ]
        },
        true
      );
      const body = JSON.stringify(sample);
      try {
        const response = await request(target.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-voice-agent-event": "conversation.ended",
            "x-voice-agent-delivery": sample.id,
            ...signatureHeaders(body, target.secret, clock())
          },
          body,
          signal: AbortSignal.timeout(11_000),
          redirect: "error"
        });
        await response.body?.cancel().catch(() => undefined);
        return response.ok
          ? { ok: true, status: response.status, ms: Date.now() - started }
          : {
              ok: false,
              status: response.status,
              error: `your server answered HTTP ${response.status}`,
              ms: Date.now() - started
            };
      } catch (error) {
        return { ok: false, error: inWords(error), ms: Date.now() - started };
      }
    },

    /** How the last delivery of a project went, if one was made since the relay started. */
    last(projectId: string): WebhookDelivery | undefined {
      return last.get(projectId);
    },

    /** At shutdown: waits this long for deliveries under way, then gives up on the rest. */
    async drain(timeoutMs: number): Promise<void> {
      if (pending.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        });
        await Promise.race([Promise.allSettled([...pending]), timeout]);
        clearTimeout(timer);
      }
      stopping.abort();
    }
  };
}

/** The relay's own. */
export const projectWebhooks = createProjectWebhooks();
