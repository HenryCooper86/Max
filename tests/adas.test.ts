import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAS_SCENARIOS,
  adasDirectionLabel,
  formatAdasAlert,
  getAdasScenario,
  type AdasDirection
} from "../shared/adas";
import { createMockProvider } from "../server/providers/mock";
import { createHazardInjector } from "../server/hazard-injector";

describe("ADAS catalog", () => {
  it("has well-formed entries", () => {
    expect(ADAS_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    for (const s of ADAS_SCENARIOS) {
      expect(s.message.trim()).not.toBe("");
      expect(s.advice.trim()).not.toBe("");
      expect(s.label.trim()).not.toBe("");
      expect(s.ttcSeconds).toBeGreaterThan(0);
      expect(["caution", "critical"]).toContain(s.severity);
    }
  });

  it("has unique threat ids", () => {
    const ids = ADAS_SCENARIOS.map((s) => s.threat);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers rear, front, and side hazards", () => {
    const directions = new Set<AdasDirection>(ADAS_SCENARIOS.map((s) => s.direction));
    expect(directions.has("rear")).toBe(true);
    expect(directions.has("front")).toBe(true);
    const hasSide = ["left", "right", "left_rear", "right_rear"].some((d) => directions.has(d as AdasDirection));
    expect(hasSide).toBe(true);
  });

  it("includes the canonical rear-approach scenario", () => {
    const rear = getAdasScenario("rear_approach");
    expect(rear?.direction).toBe("rear");
    expect(rear?.severity).toBe("critical");
  });

  it("formats a directional alert line", () => {
    const rear = getAdasScenario("rear_approach")!;
    const line = formatAdasAlert(rear);
    expect(line).toContain(adasDirectionLabel("rear"));
    expect(line).toContain(rear.message);
    expect(line).toContain(rear.advice);
  });
});

describe("createHazardInjector", () => {
  afterEach(() => vi.useRealTimers());

  it("fires an interrupting alert with a display-only transcript and raises the hazard", () => {
    vi.useFakeTimers();
    const sent: Array<Record<string, unknown>> = [];
    const hazardOverrides: Array<string | undefined> = [];
    const injector = createHazardInjector({
      send: (p) => sent.push(p as Record<string, unknown>),
      emitRideContext: (o) => hazardOverrides.push(o)
    });

    injector.start(5000, 2000);
    vi.advanceTimersByTime(2100); // first alert at 2000 ms

    const alert = sent.find((m) => m.type === "hazard.alert");
    expect(alert?.interrupt).toBe(true);

    // The client's hazard.alert handler speaks the warning, so the transcript
    // must be display-only to avoid a double TTS read.
    const transcript = sent.find((m) => m.type === "transcript" && m.speaker === "agent");
    expect(transcript?.useBrowserSpeech).toBe(false);

    // The ride-pulse hazard is raised to the alert severity.
    expect(hazardOverrides).toContain(alert?.severity);

    injector.stop();
  });
});

describe("mock provider ADAS injection", () => {
  afterEach(() => vi.useRealTimers());

  function makeClient() {
    const messages: Array<Record<string, unknown>> = [];
    const client = {
      OPEN: 1,
      readyState: 1,
      send: (raw: string) => messages.push(JSON.parse(raw))
    } as unknown as Parameters<typeof createMockProvider>[0];
    return { client, messages };
  }

  it("auto-injects an interrupting hazard.alert after startAudio", async () => {
    vi.useFakeTimers();
    const { client, messages } = makeClient();
    const provider = createMockProvider(client);

    await provider.start({ type: "session.start", sampleRate: 16000, channels: 1 });
    await provider.startAudio();
    vi.advanceTimersByTime(4100); // first hazard fires at 4000 ms

    const alert = messages.find((m) => m.type === "hazard.alert");
    expect(alert).toBeTruthy();
    expect(alert?.interrupt).toBe(true);
    expect(["caution", "critical"]).toContain(alert?.severity);
    expect(typeof alert?.message).toBe("string");

    await provider.close();
  });
});
