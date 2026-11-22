// GET /metrics: the relay's in-process counters in the Prometheus text
// exposition format (version 0.0.4), so operators can graph the relay over
// time instead of polling /health snapshots. Values live in this process only
// and restart from zero with it, which Prometheus' counter functions expect.

import { timingSafeEqual } from "node:crypto";
import { loginBackoffEntries } from "./auth";
import { buildInfo } from "./build-info";
import { relayMetrics, type RelayMetrics } from "./relay-metrics";
import { config } from "./runtime-config";

type MetricType = "counter" | "gauge";
type Family = { name: string; type: MetricType; help?: string; samples: Array<{ labels?: string; value: number }> };
type MetricsSource = () => Record<string, number>;

const sources = new Set<MetricsSource>();
const processStartedAt = Date.now();

const RELAY_HELP: Record<keyof RelayMetrics, string> = {
  maxSpeechRequested: "Max Speech utterances requested.",
  maxSpeechDelivered: "Max Speech utterances delivered.",
  maxSpeechFailed: "Max Speech utterances that failed.",
  maxSpeechCancelled: "Max Speech utterances cancelled.",
  maxSpeechExpired: "Max Speech utterances that expired before delivery.",
  maxSpeechCongested: "Max Speech utterances refused because the speech server was busy.",
  maxSpeechLatencyMsTotal: "Sum of delivered Max Speech latencies, in milliseconds.",
  activeSessions: "Voice sessions open now.",
  totalSessions: "Voice sessions opened.",
  rejectedUpgrades: "WebSocket upgrades refused (auth, origin or rate limit).",
  upstreamFailures: "Voice backend connections that failed.",
  upstreamReconnects: "Voice backend reconnects.",
  ttsFallbacks: "Replies that fell back to browser speech.",
  watchdogTerminations: "Sockets terminated for missing heartbeats.",
  watchdogIdleCloses: "Sockets closed for being idle.",
  audioUpBytes: "Audio bytes received from clients.",
  audioDownBytes: "Audio bytes sent to clients.",
  controlDownBytes: "Control event bytes sent to clients."
};

// Relay counter names that do not read well once snake-cased.
const RELAY_NAMES: Partial<Record<keyof RelayMetrics, string>> = {
  totalSessions: "max_relay_sessions_total"
};

const GAUGES = new Set<keyof RelayMetrics>(["activeSessions"]);

function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_:]/g, "_")
    .toLowerCase();
}

/** A valid metric name for `key`: snake_case, `max_` prefixed, never starting with a digit. */
function metricName(key: string): string {
  const name = snakeCase(key);
  return name.startsWith("max_") ? name : `max_${name.startsWith("_") || /^\d/.test(name) ? "_" : ""}${name}`;
}

/** HELP text escaping: backslash and line feed. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Label value escaping: backslash, double quote and line feed. */
export function escapeLabelValue(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

/**
 * Lets another module add its own numbers to /metrics. Keys become metric
 * names (camelCase is snake-cased and `max_` is prefixed); a name ending in
 * `_total` is exposed as a counter, anything else as a gauge. A name already
 * taken is skipped and a source that throws is left out of that scrape, so
 * one broken source never breaks the endpoint. Returns an unregister function.
 */
export function registerMetricsSource(source: MetricsSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** Test hook: drops every registered source. */
export function resetMetricsSources(): void {
  sources.clear();
}

function relayFamilies(uptimeSeconds: number): Family[] {
  const snapshot = relayMetrics.snapshot();
  const families: Family[] = (Object.keys(RELAY_HELP) as Array<keyof RelayMetrics>).map((key) => {
    const gauge = GAUGES.has(key);
    const base = RELAY_NAMES[key] ?? `max_relay_${snakeCase(key)}`;
    return {
      name: gauge || base.endsWith("_total") ? base : `${base}_total`,
      type: gauge ? "gauge" : "counter",
      help: RELAY_HELP[key],
      samples: [{ value: snapshot[key] }]
    };
  });
  families.push(
    {
      name: "max_relay_process_uptime_seconds",
      type: "gauge",
      help: "Seconds since the relay process started.",
      samples: [{ value: uptimeSeconds }]
    },
    {
      name: "max_relay_login_backoff_accounts",
      type: "gauge",
      help: "Account names with failed logins on record (login backoff).",
      samples: [{ value: loginBackoffEntries() }]
    },
    {
      name: "max_relay_build_info",
      type: "gauge",
      help: "The running build; always 1.",
      samples: [
        {
          labels: `{version="${escapeLabelValue(buildInfo.appVersion)}",commit="${escapeLabelValue(buildInfo.gitCommit)}"}`,
          value: 1
        }
      ]
    }
  );
  return families;
}

/** The full exposition text. `uptimeSeconds` is a seam for tests. */
export function renderPrometheus(uptimeSeconds = Math.round((Date.now() - processStartedAt) / 1000)): string {
  const families = relayFamilies(uptimeSeconds);
  const taken = new Set(families.map((family) => family.name));
  for (const source of sources) {
    let values: Record<string, number>;
    try {
      values = source();
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(values ?? {})) {
      if (typeof value !== "number") continue;
      const name = metricName(key);
      if (taken.has(name)) continue;
      taken.add(name);
      families.push({ name, type: name.endsWith("_total") ? "counter" : "gauge", samples: [{ value }] });
    }
  }
  const lines: string[] = [];
  for (const family of families) {
    if (family.help) lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      lines.push(`${family.name}${sample.labels ?? ""} ${formatValue(sample.value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The response to GET /metrics for a request's Authorization header. Only the
 * dedicated METRICS_TOKEN opens it: not the relay token, not a login. With no
 * token configured the endpoint does not exist (404), so a relay that never
 * opted in exposes nothing new.
 */
export function metricsResponse(authorization: string | undefined): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  if (!config.metricsToken) {
    return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Not found.\n" };
  }
  const match = /^Bearer\s+(\S+)\s*$/.exec(authorization ?? "");
  if (!match?.[1] || !tokenMatches(match[1], config.metricsToken)) {
    return {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "WWW-Authenticate": 'Bearer realm="metrics"' },
      body: "Send the metrics token: Authorization: Bearer <METRICS_TOKEN>.\n"
    };
  }
  return {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" },
    body: renderPrometheus()
  };
}
