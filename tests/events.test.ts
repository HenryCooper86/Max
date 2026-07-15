import { describe, expect, it } from "vitest";
import { validateAgentEvent } from "../shared/events";

describe("validateAgentEvent", () => {
  it("rejects non-objects and events without a type", () => {
    expect(validateAgentEvent(null)).toBeNull();
    expect(validateAgentEvent("status")).toBeNull();
    expect(validateAgentEvent([])).toBeNull();
    expect(validateAgentEvent({ detail: "no type" })).toBeNull();
  });

  it("ignores unknown event types (newer relay, older client)", () => {
    expect(validateAgentEvent({ type: "future.thing", payload: 1 })).toBeNull();
  });

  it("passes well-formed events through", () => {
    expect(validateAgentEvent({ type: "status", state: "ready", detail: "ok" })).toEqual({
      type: "status",
      state: "ready",
      detail: "ok"
    });
    expect(validateAgentEvent({ type: "transcript", speaker: "agent", text: "前方畅通", final: false })).toMatchObject({
      speaker: "agent",
      text: "前方畅通",
      final: false
    });
  });

  it("rejects transcripts with a bad speaker or missing text", () => {
    expect(validateAgentEvent({ type: "transcript", speaker: "server", text: "hi" })).toBeNull();
    expect(validateAgentEvent({ type: "transcript", speaker: "agent" })).toBeNull();
  });

  it("sanitizes a hazard alert's non-finite TTC instead of letting NaN reach a timer", () => {
    const event = validateAgentEvent({
      type: "hazard.alert",
      threat: "rear_approach",
      direction: "rear",
      severity: "critical",
      label: "后方",
      message: "后方车辆快速接近",
      advice: "保持车道",
      interrupt: true
      // ttcSeconds missing entirely
    });
    expect(event).toMatchObject({ type: "hazard.alert", ttcSeconds: 6, interrupt: true });
  });

  it("rejects a hazard alert missing the strings the banner renders", () => {
    expect(
      validateAgentEvent({ type: "hazard.alert", threat: "rear_approach", direction: "rear", severity: "critical" })
    ).toBeNull();
  });

  it("sanitizes weather and telemetry numerics", () => {
    expect(validateAgentEvent({ type: "weather", description: "晴", temperatureC: "hot" })).toMatchObject({
      temperatureC: 0,
      windSpeedKmh: 0,
      isDay: true
    });
    expect(validateAgentEvent({ type: "telemetry", asrMs: Number.NaN, thinkMs: 120 })).toMatchObject({
      asrMs: 0,
      thinkMs: 120,
      firstAudioMs: 0,
      totalMs: 0
    });
  });

  it("clamps impossible negative counters and out-of-range HUD values", () => {
    expect(validateAgentEvent({ type: "metric", latencyMs: -40, droppedFrames: -2 })).toMatchObject({
      latencyMs: 0,
      droppedFrames: 0
    });
    expect(
      validateAgentEvent({
        type: "ride.context",
        mode: "ride",
        scenario: "commute",
        modeLabel: "骑行",
        scenarioLabel: "通勤",
        hazardLevel: "normal",
        glanceableFocus: "速度",
        speedKmh: -10,
        batteryPct: 160
      })
    ).toMatchObject({ speedKmh: 0, batteryPct: 100 });
    expect(
      validateAgentEvent({
        type: "hazard.alert",
        threat: "rear_approach",
        direction: "rear",
        severity: "critical",
        label: "后方",
        message: "后方车辆快速接近",
        advice: "保持车道",
        ttcSeconds: -3
      })
    ).toMatchObject({ ttcSeconds: 0 });
  });

  it("drops invalid optional enums instead of the whole event", () => {
    const weather = validateAgentEvent({ type: "weather", description: "晴", riskLevel: "apocalyptic" });
    expect(weather).toMatchObject({ type: "weather", riskLevel: undefined });
  });

  it("rejects ride.context with an unknown mode or hazard level", () => {
    const base = {
      type: "ride.context",
      mode: "ride",
      scenario: "commute",
      modeLabel: "骑行",
      scenarioLabel: "通勤",
      hazardLevel: "normal",
      glanceableFocus: "速度"
    };
    expect(validateAgentEvent(base)).toMatchObject({ mode: "ride", hazardLevel: "normal" });
    expect(validateAgentEvent({ ...base, mode: "warp" })).toBeNull();
    expect(validateAgentEvent({ ...base, hazardLevel: "purple" })).toBeNull();
  });

  it("rejects hazard alerts with unknown threat or direction values", () => {
    const base = {
      type: "hazard.alert",
      threat: "rear_approach",
      direction: "rear",
      severity: "critical",
      label: "后方",
      message: "后方车辆快速接近",
      advice: "保持车道"
    };
    expect(validateAgentEvent(base)).toMatchObject({ threat: "rear_approach", direction: "rear" });
    // "behind" would render an undefined direction chip on the safety banner.
    expect(validateAgentEvent({ ...base, direction: "behind" })).toBeNull();
    expect(validateAgentEvent({ ...base, threat: "meteor_strike" })).toBeNull();
  });

  it("sanitizes session.started capabilities instead of blind-casting the record", () => {
    const event = validateAgentEvent({
      type: "session.started",
      provider: "doubao",
      mode: "live",
      capabilities: { serverVad: "yes", bargeIn: true, extraField: 1 },
      unexpected: "field"
    });
    expect(event).toEqual({
      type: "session.started",
      provider: "doubao",
      mode: "live",
      capabilities: {
        serverVad: false, // "yes" is not the boolean true
        synthesizedAudio: false,
        transcriptEvents: false,
        bargeIn: true,
        voiceSelection: false,
        weatherContext: false,
        sessionMemory: false,
        emergencyMode: false
      }
    });
  });

  it("accepts the numeric Open-Meteo is_day form without flipping night to day", () => {
    expect(validateAgentEvent({ type: "weather", description: "晴", isDay: 0 })).toMatchObject({ isDay: false });
    expect(validateAgentEvent({ type: "weather", description: "晴", isDay: 1 })).toMatchObject({ isDay: true });
    expect(validateAgentEvent({ type: "weather", description: "晴", isDay: false })).toMatchObject({ isDay: false });
  });

  it("clamps session.memory destination by code point", () => {
    const long = "旗".repeat(80);
    const event = validateAgentEvent({
      type: "session.memory",
      language: "zh",
      responseMode: "concise",
      destination: long
    });
    expect(event).toMatchObject({ destination: "旗".repeat(64) });
  });

  it("validates session.memory enums", () => {
    expect(validateAgentEvent({ type: "session.memory", language: "zh", responseMode: "concise" })).toMatchObject({
      language: "zh",
      responseMode: "concise"
    });
    expect(validateAgentEvent({ type: "session.memory", language: "fr", responseMode: "concise" })).toBeNull();
  });
});
