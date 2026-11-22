import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cloudCounters, countCloud } from "../server/cloud/counters";
import { registerMetricsSource, renderPrometheus, resetMetricsSources } from "../server/prometheus";

// An operator has to be able to see billing break: the money counters must
// reach the scrape endpoint under the names the docs give.

afterEach(() => resetMetricsSources());

describe("billing counters on /metrics", () => {
  it("are exported as counters under their own names", () => {
    registerMetricsSource(cloudCounters);
    const text = renderPrometheus(1);
    for (const name of Object.keys(cloudCounters())) {
      expect(name).toMatch(/^max_cloud_[a-z_]+_total$/);
      expect(text).toContain(`# TYPE ${name} counter`);
      expect(text).toMatch(new RegExp(`^${name} \\d+$`, "m"));
    }
    expect(text).not.toContain("max_max_");
  });

  it("move when a booking fails", () => {
    registerMetricsSource(cloudCounters);
    const before = cloudCounters().max_cloud_booking_failures_total ?? 0;
    countCloud("max_cloud_booking_failures_total");
    expect(renderPrometheus(1)).toMatch(new RegExp(`^max_cloud_booking_failures_total ${before + 1}$`, "m"));
  });

  it("are registered by the relay", () => {
    const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    expect(source).toContain("registerMetricsSource(cloudCounters)");
  });
});
