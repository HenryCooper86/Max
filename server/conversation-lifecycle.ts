import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { conversationRecorder } from "./cloud/conversations";
import {
  analysisModelFromEnv,
  analyzeConversation,
  type AnalysisConfig,
  type AnalysisModel,
  type AnalysisResult
} from "./conversation-analysis";
import {
  conversationWebhookFromEnv,
  deliverConversation,
  type ConversationEndedPayload,
  type ConversationWebhook,
  type GuardrailFinding
} from "./conversation-webhook";
import { createLogger } from "./logger";
import { redactText, redactTurns, type RedactionKind } from "./redact";
import {
  createSessionTracer,
  createSpanExporter,
  tracingSettingsFromEnv,
  type SpanExporter,
  type TracingSettings
} from "./tracing";

/**
 * What the relay does with a conversation besides holding it: trace it as it
 * runs, and once it is over analyse it (summary, outcome, extracted fields),
 * hand the record to the owner's webhook and append it to their log file.
 *
 * Everything here is optional and off until configured:
 * - `analysis` and `privacy.redact` in `assistant.config.json`;
 * - `CONVERSATION_WEBHOOK_URL` (+ `CONVERSATION_WEBHOOK_SECRET`);
 * - `CONVERSATION_LOG_FILE`, one JSON line per conversation;
 * - the standard `OTEL_EXPORTER_OTLP_*` variables for traces.
 *
 * Redaction is applied before anything leaves the relay's memory: the analysis
 * model, the webhook, the log file and trace content all see the redacted text.
 */

const log = createLogger("conversations");

const MAX_PENDING = 200;
const ANALYSIS_TIMEOUT_MS = 30_000;
/** How long a record waits for its recording's file to be finished. */
const RECORDING_WAIT_MS = 10_000;

/** What a session hands over when it ends, besides why it ended. */
type ConversationEnding = {
  /** The conversation's recording, once its file is complete; nothing when there is none. */
  recording?: Promise<{ file: string; durationMs: number } | undefined>;
};

type ConversationSessionInfo = {
  sessionId: string;
  userId?: string;
  channel: "web" | "phone";
  phone?: NonNullable<ConversationEndedPayload["session"]["phone"]>;
  /** Language the assistant answers in, for the analysis text. */
  language?: string;
  assistant?: string;
  /** The config's `version`, and the variant the conversation was given. */
  version?: string;
  variant?: string;
};

type ConversationObserver = {
  /** Feed every event the relay sends the client. */
  event(payload: unknown): void;
  /** The session is over. Returns at once; the follow-up work runs on its own. */
  end(reason?: string, ending?: ConversationEnding): void;
};

export type ConversationLifecycleOptions = {
  analysis?: AnalysisConfig;
  redact?: readonly RedactionKind[];
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  now?: () => number;
  /** Test seam: replaces the trace exporter the environment asks for. */
  exporter?: SpanExporter;
  version?: string;
  /** Hears every finished conversation's record, whether or not it could be delivered. */
  onRecord?: (record: ConversationEndedPayload) => void;
  /** Make records for `onRecord` even when there is no webhook and no log file to send them to. */
  keepRecords?: boolean;
};

export type ConversationLifecycle = {
  /** What is configured but cannot work, for startup and /health. */
  problems(): string[];
  /** Whether anything at all observes sessions. */
  active(): boolean;
  /** True when a record is made of each conversation (for the webhook, the log file or a listener). */
  keepsRecords(): boolean;
  open(info: ConversationSessionInfo): ConversationObserver;
  /** Waits for analyses and deliveries in flight (shutdown), up to `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
  /** Trace export counters for /metrics; absent when tracing is off. */
  traceStats(): ReturnType<SpanExporter["stats"]> | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A conversation that trips a guardrail a hundred times has made its point. */
const MAX_GUARDRAIL_FINDINGS = 100;

function guardrailFindingFrom(payload: Record<string, unknown>): GuardrailFinding | undefined {
  const { speaker, kind, rule, tool, at, stopped } = payload;
  if (speaker !== "assistant" && speaker !== "user") return undefined;
  if (kind !== "term" && kind !== "rule" && kind !== "tool" && kind !== "result") return undefined;
  if (typeof rule !== "string" || typeof at !== "number") return undefined;
  return {
    speaker,
    kind,
    rule,
    ...((kind === "tool" || kind === "result") && typeof tool === "string" ? { tool: tool.slice(0, 64) } : {}),
    at,
    stopped: stopped === true
  };
}

/** A call's details with the numbers taken out: redacting phone numbers
 *  from what was said while keeping the caller's own would be no redaction. */
function withoutNumbers(phone: NonNullable<ConversationSessionInfo["phone"]>): typeof phone {
  return {
    direction: phone.direction,
    // Whatever stands here names a party to the call, a SIP address included.
    ...(phone.from ? { from: "[phone]" } : {}),
    ...(phone.to ? { to: "[phone]" } : {}),
    ...(phone.callSid ? { callSid: phone.callSid } : {})
  };
}

/** The event as the tracer may see it: with what was said redacted. */
function redactedEvent(payload: unknown, kinds: readonly RedactionKind[]): unknown {
  if (kinds.length === 0 || !isRecord(payload)) return payload;
  if (payload.type === "transcript" && typeof payload.text === "string") {
    return { ...payload, text: redactText(payload.text, kinds) };
  }
  return payload;
}

export function createConversationLifecycle(options: ConversationLifecycleOptions = {}): ConversationLifecycle {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const kinds = options.redact ?? [];
  const analysis = options.analysis;
  const problems: string[] = [];

  const { webhook, problem: webhookProblem } = conversationWebhookFromEnv(env);
  if (webhookProblem) problems.push(webhookProblem);

  const logFile = env.CONVERSATION_LOG_FILE?.trim() ? path.resolve(env.CONVERSATION_LOG_FILE.trim()) : undefined;

  let model: AnalysisModel | undefined;
  if (analysis) {
    model = analysisModelFromEnv(env);
    if (!model) {
      problems.push(
        "analysis is configured but there is no model to run it: set ANALYSIS_LLM_BASE_URL and ANALYSIS_LLM_MODEL, or OPENAI_API_KEY"
      );
    } else if (!webhook && !logFile && !options.keepRecords) {
      problems.push(
        "analysis is configured but its results go nowhere: set CONVERSATION_WEBHOOK_URL or CONVERSATION_LOG_FILE"
      );
    }
  }

  let tracing: TracingSettings | undefined;
  let exporter = options.exporter;
  if (!exporter) {
    const traced = tracingSettingsFromEnv(env);
    if (traced.problem) problems.push(traced.problem);
    tracing = traced.settings;
    if (tracing) {
      exporter = createSpanExporter(tracing, {
        ...(options.request ? { request: options.request } : {}),
        ...(options.version ? { version: options.version } : {})
      });
    }
  }
  const captureContent = tracing?.captureContent ?? false;

  const records = Boolean(webhook || logFile || (options.keepRecords && options.onRecord));
  const pending = new Set<Promise<void>>();

  async function finish(
    info: ConversationSessionInfo,
    recorder: ReturnType<typeof conversationRecorder>,
    backend: string,
    endReason: string | undefined,
    ending: ConversationEnding | undefined,
    guardrails: readonly GuardrailFinding[]
  ): Promise<void> {
    const transcript = redactTurns(recorder.turns(), kinds);
    // A session nobody spoke in is not a conversation.
    if (!transcript.some((turn) => turn.speaker === "user")) return;
    const endedAt = now();
    let recording: { file: string; durationMs: number } | undefined;
    if (ending?.recording) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), RECORDING_WAIT_MS);
        timer.unref?.();
      });
      const finished = await Promise.race([ending.recording.catch(() => undefined), late]);
      if (timer) clearTimeout(timer);
      if (finished) recording = { file: finished.file, durationMs: finished.durationMs };
    }
    let result: AnalysisResult | undefined;
    let analysisError: string | undefined;
    if (analysis) {
      if (!model) analysisError = "no analysis model is configured";
      else {
        try {
          result = await analyzeConversation(transcript, analysis, model, {
            timeoutMs: ANALYSIS_TIMEOUT_MS,
            ...(options.request ? { request: options.request } : {}),
            ...(info.language ? { language: info.language } : {})
          });
        } catch (error) {
          analysisError = error instanceof Error ? error.message : "analysis failed";
          log.warn("conversation analysis failed", { sessionId: info.sessionId, message: analysisError });
        }
      }
    }
    const payload: ConversationEndedPayload = {
      type: "conversation.ended",
      id: randomUUID(),
      session: {
        id: info.sessionId,
        ...(info.userId ? { userId: info.userId } : {}),
        backend,
        channel: info.channel,
        startedAt: recorder.startedAt,
        endedAt,
        seconds: Math.max(0, Math.round((endedAt - recorder.startedAt) / 1000)),
        ...(endReason ? { endReason } : {}),
        ...(info.version ? { version: info.version } : {}),
        ...(info.variant ? { variant: info.variant } : {}),
        ...(info.phone ? { phone: kinds.includes("phone") ? withoutNumbers(info.phone) : info.phone } : {})
      },
      transcript,
      ...(recording ? { recording } : {}),
      // The rule is the owner's own text; a blocked term is not what anyone said.
      ...(guardrails.length ? { guardrails: [...guardrails] } : {}),
      ...(result ? { analysis: result } : {}),
      ...(analysisError ? { analysisError } : {})
    };
    try {
      options.onRecord?.(payload);
    } catch {
      /* a listener's trouble is not the conversation's */
    }
    if (logFile) {
      try {
        await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
        // Readable by the relay's user only: it holds what people said.
        await fs.promises.appendFile(logFile, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      } catch (error) {
        log.warn("conversation could not be written to CONVERSATION_LOG_FILE", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (webhook) {
      const delivered = await deliverConversation(payload, webhook as ConversationWebhook, {
        ...(options.request ? { request: options.request } : {})
      });
      if (delivered.ok) {
        log.info("conversation delivered", { sessionId: info.sessionId, attempts: delivered.attempts });
      } else {
        log.warn("conversation webhook failed", {
          sessionId: info.sessionId,
          attempts: delivered.attempts,
          status: delivered.status,
          message: delivered.error
        });
      }
    }
  }

  return {
    problems: () => [...problems],
    active: () => records || Boolean(exporter),
    keepsRecords: () => records,
    open(info) {
      const recorder = records ? conversationRecorder(now) : undefined;
      let backend = "";
      let endReason: string | undefined;
      let ended = false;
      const guardrails: GuardrailFinding[] = [];
      const tracer = exporter
        ? createSessionTracer(
            exporter,
            {
              sessionId: info.sessionId,
              channel: info.channel,
              ...(info.userId ? { userId: info.userId } : {}),
              ...(info.assistant ? { assistant: info.assistant } : {})
            },
            { captureContent }
          )
        : undefined;
      return {
        event(payload) {
          if (ended) return;
          if (isRecord(payload)) {
            if (payload.type === "session.started" && typeof payload.provider === "string") backend = payload.provider;
            if (payload.type === "session.ended" && typeof payload.reason === "string") endReason = payload.reason;
            if (payload.type === "guardrail") {
              // The relay's own note of what a guardrail found: not an event a client gets.
              const finding = guardrailFindingFrom(payload);
              if (finding && guardrails.length < MAX_GUARDRAIL_FINDINGS) guardrails.push(finding);
              return;
            }
          }
          recorder?.event(payload);
          tracer?.event(captureContent ? redactedEvent(payload, kinds) : payload);
        },
        end(reason, ending) {
          if (ended) return;
          ended = true;
          const why = endReason ?? reason;
          tracer?.end(why);
          if (!recorder) return;
          if (pending.size >= MAX_PENDING) {
            // A webhook that is down while calls keep ending: drop rather than grow without bound.
            log.warn("conversation dropped: too many are waiting to be delivered", { sessionId: info.sessionId });
            return;
          }
          const work = finish(info, recorder, backend || "unknown", why, ending, guardrails)
            .catch((error: unknown) => {
              log.warn("conversation follow-up failed", {
                sessionId: info.sessionId,
                message: error instanceof Error ? error.message : String(error)
              });
            })
            .finally(() => pending.delete(work));
          pending.add(work);
        }
      };
    },
    async drain(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...pending]).then(() => undefined), timeout]);
      if (timer) clearTimeout(timer);
      await Promise.race([exporter?.flush().catch(() => undefined) ?? Promise.resolve(), timeout]);
    },
    traceStats: () => exporter?.stats()
  };
}
