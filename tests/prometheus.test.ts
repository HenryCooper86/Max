import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, describeConfig, validateConfig } from "../server/config";
import {
  escapeHelp,
  escapeLabelValue,
  metricsResponse,
  registerMetricsSource,
  renderPrometheus,
  resetMetricsSources
} from "../server/prometheus";
import { relayMetrics, resetRelayMetrics } from "../server/relay-metrics";

// GET /metrics in the Prometheus text exposition format (version 0.0.4).

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const originalToken = config.metricsToken;

beforeEach(() => {
  resetRelayMetrics();
  resetMetricsSources();
});

afterEach(() => {
  config.metricsToken = originalToken;
  resetMetricsSources();
  resetRelayMetrics();
});

/** Every sample line as [name, labels, value]. */
function samples(text: string): Array<[string, string, string]> {
  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = /^([^{\s]+)(\{.*\})? (\S+)$/.exec(line);
      if (!match) throw new Error(`not a sample line: ${line}`);
      return [match[1]!, match[2] ?? "", match[3]!];
    });
}

describe("Prometheus exposition", () => {
  it("exports the relay counters with valid names, one # TYPE per family before its samples", () => {
    relayMetrics.sessionOpened();
    relayMetrics.sessionOpened();
    relayMetrics.sessionClosed();
    relayMetrics.rejectedUpgrade();
    relayMetrics.maxSpeechCompleted("Delivered", 120);
    const text = renderPrometheus(5);

    expect(text.endsWith("\n")).toBe(true);
    const types = new Map<string, string>();
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith("# TYPE ")) continue;
      const [, , name, type] = line.split(" ");
      expect(name).toMatch(NAME);
      expect(["counter", "gauge"]).toContain(type);
      expect(types.has(name!)).toBe(false);
      types.set(name!, type!);
      // Samples of a family come straight after its TYPE line.
      expect(lines[index + 1]?.startsWith(name!)).toBe(true);
    }
    for (const [name, , value] of samples(text)) {
      expect(name).toMatch(NAME);
      expect(types.has(name)).toBe(true);
      expect(Number.isNaN(Number(value))).toBe(false);
    }

    const values = Object.fromEntries(samples(text).map(([name, labels, value]) => [name + labels, Number(value)]));
    expect(types.get("max_relay_sessions_total")).toBe("counter");
    expect(values.max_relay_sessions_total).toBe(2);
    expect(types.get("max_relay_active_sessions")).toBe("gauge");
    expect(values.max_relay_active_sessions).toBe(1);
    expect(values.max_relay_rejected_upgrades_total).toBe(1);
    // Already ends in "total": not doubled.
    expect(values.max_relay_max_speech_latency_ms_total).toBe(120);
    expect(text).not.toContain("_total_total");
    expect(types.get("max_relay_process_uptime_seconds")).toBe("gauge");
    expect(values.max_relay_process_uptime_seconds).toBe(5);
    expect(text).toMatch(/^max_relay_build_info\{version="[^"]*",commit="[^"]*"\} 1$/m);
  });

  it("adds what other modules register, typed by their names", () => {
    registerMetricsSource(() => ({ cloudTopupsCompleted_total: 3, "cloud.live-sessions": 2, "9lives": 1 }));
    const text = renderPrometheus(0);
    expect(text).toContain("# TYPE max_cloud_topups_completed_total counter\nmax_cloud_topups_completed_total 3\n");
    expect(text).toContain("# TYPE max_cloud_live_sessions gauge\nmax_cloud_live_sessions 2\n");
    expect(text).toContain("max__9lives 1");
    for (const [name] of samples(text)) expect(name).toMatch(NAME);
  });

  it("keeps a scrape valid when a source throws, repeats a name, or reports a non-number", () => {
    registerMetricsSource(() => {
      throw new Error("store unavailable");
    });
    registerMetricsSource(() => ({ max_relay_active_sessions: 99, healthy: Number.NaN, big: Infinity }));
    const text = renderPrometheus(0);
    expect(text.match(/^# TYPE max_relay_active_sessions /gm)).toHaveLength(1);
    expect(text).toContain("max_relay_active_sessions 0");
    expect(text).toContain("max_healthy NaN");
    expect(text).toContain("max_big +Inf");
  });

  it("unregisters a source", () => {
    const stop = registerMetricsSource(() => ({ temporary: 1 }));
    expect(renderPrometheus(0)).toContain("max_temporary 1");
    stop();
    expect(renderPrometheus(0)).not.toContain("max_temporary");
  });

  it("escapes help text and label values as the format requires", () => {
    expect(escapeHelp('a\\b\nc "quoted"')).toBe('a\\\\b\\nc "quoted"');
    expect(escapeLabelValue('v1 "beta"\\\nx')).toBe('v1 \\"beta\\"\\\\\\nx');
  });
});

describe("GET /metrics access", () => {
  it("is disabled (404) while METRICS_TOKEN is unset", () => {
    config.metricsToken = "";
    expect(metricsResponse(undefined).status).toBe(404);
    expect(metricsResponse("Bearer anything").status).toBe(404);
  });

  it("requires the metrics bearer token", () => {
    config.metricsToken = "metrics-secret-0123456789";
    const missing = metricsResponse(undefined);
    expect(missing.status).toBe(401);
    expect(missing.headers["WWW-Authenticate"]).toBe('Bearer realm="metrics"');
    expect(missing.body).not.toContain("max_relay");
    expect(metricsResponse("Bearer wrong").status).toBe(401);
    expect(metricsResponse("metrics-secret-0123456789").status).toBe(401);
    expect(metricsResponse("Basic metrics-secret-0123456789").status).toBe(401);

    const ok = metricsResponse("Bearer metrics-secret-0123456789");
    expect(ok.status).toBe(200);
    expect(ok.headers["Content-Type"]).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(ok.headers["Cache-Control"]).toBe("no-store");
    expect(ok.body).toContain("# TYPE max_relay_active_sessions gauge");
  });

  it("warns at startup about a guessable token and states whether the endpoint is on", () => {
    config.metricsToken = "short";
    expect(validateConfig().some((warning) => warning.includes("METRICS_TOKEN"))).toBe(true);
    expect(describeConfig()).toContain("Metrics endpoint: /metrics (bearer METRICS_TOKEN)");
    config.metricsToken = "a-long-random-metrics-token-0123456789";
    expect(validateConfig().some((warning) => warning.includes("METRICS_TOKEN"))).toBe(false);
    config.metricsToken = "";
    expect(describeConfig()).toContain("Metrics endpoint: off");
  });
});
