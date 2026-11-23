// Max Cloud traces: a project's conversations, exported to the project's own
// OpenTelemetry collector (Langfuse, Honeycomb, Grafana Tempo, Datadog...: anything
// that takes OTLP/HTTP). The spans are those of the relay's own tracing
// (server/tracing.ts), sent with the same rules as a project's tools and its
// conversation webhook (server/cloud/tools.ts): https to a public address, the
// connection made to the address that was checked, no redirects.
//
// Never a dependency of a conversation: nothing here throws into a session or
// waits for a collector. A collector that is down costs the project its traces.

import { randomUUID } from "node:crypto";
import type { StudioTraces } from "../../shared/cloud-studio";
import { createLogger } from "../logger";
import {
  createSessionTracer,
  createSpanExporter,
  parseHeaders,
  type SessionTracer,
  type SpanExporter
} from "../tracing";
import { guardedFetch } from "./tools";

const log = createLogger("cloud");

export const TRACES_HEADERS_MAX = 2000;
const TRACES_HEADERS_MAX_COUNT = 10;
/**
 * Headers the relay sets itself, that would change what the request is, or that would make the relay speak
 * for somebody it is not (a cookie, a forwarded address) to a service that trusts where a request comes from.
 */
const REFUSED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "expect",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
  "forwarded"
]);
const REFUSED_HEADER_PREFIXES = ["proxy-", "x-forwarded-"];
/** RFC 9110 token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code < 160)) return true;
  }
  return false;
}

/**
 * Why a collector's headers cannot be saved, in words for the person who typed them; undefined when they can.
 * The OTLP form: `name=value,name2=value2` with URL-encoded values. "" (no headers) is valid.
 */
export function tracesHeadersProblem(raw: string): string | undefined {
  if (raw.length > TRACES_HEADERS_MAX) return `Traces headers must be at most ${TRACES_HEADERS_MAX} characters.`;
  if (hasControl(raw)) return "Traces headers contain characters they cannot have.";
  const parts = raw.split(",").filter((part) => part.trim());
  if (parts.length > TRACES_HEADERS_MAX_COUNT) {
    return `Traces headers can have at most ${TRACES_HEADERS_MAX_COUNT} headers.`;
  }
  for (const part of parts) {
    const at = part.indexOf("=");
    const name = at > 0 ? part.slice(0, at).trim() : "";
    if (!name) return "Traces headers must look like name=value,name2=value2.";
    if (!HEADER_NAME.test(name)) return `${name.slice(0, 40)} is not a valid header name.`;
    const lower = name.toLowerCase();
    if (REFUSED_HEADERS.has(lower) || REFUSED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return `The ${lower.slice(0, 40)} header cannot be set here.`;
    }
  }
  // A value is URL-encoded, so what it decodes to is what is sent: no line breaks smuggled in as %0D%0A.
  for (const value of Object.values(parseHeaders(raw))) {
    if (hasControl(value) || /[^\x20-\x7e]/.test(value)) {
      return "A header value can only be plain printable characters (encode anything else, like %20).";
    }
  }
  return undefined;
}

/** A failure of one request to a collector in words for the person whose collector it is. */
function inWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "cancelled" || (error instanceof Error && /^(Abort|Timeout)Error$/.test(error.name))) {
    return "the collector did not answer within 10 seconds";
  }
  return message
    .replace(/^tool address /, "the address ")
    .replace("the tool did not answer", "the collector did not answer")
    .replace("is your server running?", "is the address right?")
    .slice(0, 200);
}

function statusInWords(status: number): string {
  if (status === 401 || status === 403) {
    return `HTTP ${status} from the collector: it did not accept the headers (check the API key)`;
  }
  if (status === 404)
    return "HTTP 404 from the collector: check the endpoint's address (it ends in /v1/traces or similar)";
  return `HTTP ${status} from the collector`;
}

/** What a session of a project is traced with; what the relay knows of the project at its start. */
export type ProjectTraceSession = {
  projectId: string;
  /** The project's name: the service in the collector, and the assistant on the spans. */
  name: string;
  sessionId: string;
  backend: string;
  traces: StudioTraces;
  /** The collector's headers, decrypted; undefined when there are none. */
  headers?: string;
  /** The headers are saved but cannot be decrypted: no traces, rather than traces sent without them. */
  headersUnreadable?: boolean;
};

type Entry = { key: string; exporter: SpanExporter; open: number };

export function createProjectTraces(options: { request?: typeof fetch } = {}) {
  const request = options.request ?? guardedFetch;
  /** The exporter new sessions of each project use. */
  const current = new Map<string, Entry>();
  /** Exporters that are being closed (their last session ended). */
  const closing = new Set<Promise<void>>();
  const warned = new Set<string>();

  function release(projectId: string, entry: Entry): void {
    entry.open -= 1;
    if (entry.open > 0) return;
    if (current.get(projectId) === entry) current.delete(projectId);
    // close() sends what is queued, so the last conversation's spans leave with it.
    const done: Promise<void> = entry.exporter
      .close()
      .catch(() => undefined)
      .finally(() => closing.delete(done));
    closing.add(done);
  }

  return {
    /**
     * A tracer for a session of a project that has a collector, or none. It is fed every event the client is sent
     * and ended when the session is over; its spans are sent then. Never throws.
     */
    open(input: ProjectTraceSession): SessionTracer | undefined {
      try {
        if (!input.traces.endpoint) return undefined;
        if (input.headersUnreadable) {
          if (!warned.has(input.projectId)) {
            warned.add(input.projectId);
            log.warn(
              "a project's trace headers do not decrypt with CLOUD_SECRET_KEY or CLOUD_SECRET_KEY_PREVIOUS: its conversations are not traced",
              { projectId: input.projectId }
            );
          }
          return undefined;
        }
        const headers = input.headers ?? "";
        // What one exporter is tied to: a change to any of it gives the next session a new one.
        const key = JSON.stringify([input.traces.endpoint, headers, input.name]);
        let entry = current.get(input.projectId);
        if (!entry || entry.key !== key) {
          entry = {
            key,
            exporter: createSpanExporter(
              {
                endpoint: input.traces.endpoint,
                headers: parseHeaders(headers),
                serviceName: input.name,
                captureContent: input.traces.content
              },
              { request }
            ),
            open: 0
          };
          current.set(input.projectId, entry);
        }
        const held = entry;
        const tracer = createSessionTracer(
          held.exporter,
          {
            sessionId: input.sessionId,
            backend: input.backend,
            channel: "web",
            assistant: input.name
          },
          { captureContent: input.traces.content }
        );
        held.open += 1;
        let ended = false;
        return {
          event: (payload) => tracer.event(payload),
          end(reason) {
            if (ended) return;
            ended = true;
            try {
              tracer.end(reason);
            } finally {
              release(input.projectId, held);
            }
          }
        };
      } catch (error) {
        log.warn("a project's conversation could not be traced", {
          projectId: input.projectId,
          message: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
    },

    /**
     * The console's "Send test": one small sample trace to the collector, once, without a retry; and how it went.
     */
    async test(target: {
      name: string;
      endpoint: string;
      headers?: string;
    }): Promise<{ ok: true } | { ok: false; error: string }> {
      let outcome: { status: number } | { error: unknown } | undefined;
      const exporter = createSpanExporter(
        {
          endpoint: target.endpoint,
          headers: parseHeaders(target.headers ?? ""),
          serviceName: target.name,
          captureContent: false
        },
        {
          retry: false,
          request: async (input, init) => {
            try {
              const response = await request(input, init);
              outcome = { status: response.status };
              return response;
            } catch (error) {
              outcome = { error };
              throw error;
            }
          }
        }
      );
      try {
        const tracer = createSessionTracer(
          exporter,
          {
            sessionId: `console-test-${randomUUID().slice(0, 8)}`,
            backend: "test",
            channel: "web",
            assistant: `${target.name} (test)`,
            attributes: { "max.test": true }
          },
          { captureContent: false }
        );
        tracer.event({ type: "transcript", speaker: "rider", final: true, text: "test", turnId: "t1" });
        tracer.event({ type: "telemetry", asrMs: 120, thinkMs: 300, firstAudioMs: 450, totalMs: 900 });
        tracer.event({ type: "transcript", speaker: "agent", final: true, text: "test", turnId: "t1" });
        tracer.end("test");
        await exporter.close();
      } catch (error) {
        return { ok: false, error: inWords(error) };
      }
      if (!outcome) return { ok: false, error: "nothing was sent" };
      if ("error" in outcome) return { ok: false, error: inWords(outcome.error) };
      return outcome.status >= 200 && outcome.status < 300
        ? { ok: true }
        : { ok: false, error: statusInWords(outcome.status) };
    },

    /** At shutdown: waits this long for the exporters being closed, then gives up on them. */
    async drain(timeoutMs: number): Promise<void> {
      if (closing.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.allSettled([...closing]), timeout]);
      clearTimeout(timer);
    }
  };
}

/** The relay's own. */
export const projectTraces = createProjectTraces();
