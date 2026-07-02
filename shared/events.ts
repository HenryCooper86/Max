// Runtime validation for relay → client AgentEvents. The web client used to
// blind-cast `JSON.parse(...) as AgentEvent`, so a relay version skew or bug
// rendered "undefined°C", NaN timers, or a safety banner that dismissed itself
// on the next tick. validateAgentEvent admits an event only when every field
// the clients dereference is present and well-typed, sanitizes optional
// numerics, and returns null for malformed or unknown events (unknown types
// are ignored, not errors, so older clients tolerate newer relays).

import type { AdasDirection, AdasSeverity, AdasThreat } from "./adas";
import type { AgentEvent, ConnectionState } from "./agent";
import type { DemoScenario, RideMode } from "./ride";

const CONNECTION_STATES = new Set(["offline", "connecting", "relay", "provider", "ready", "degraded"]);
const PROVIDER_MODES = new Set(["mock", "live"]);
const SPEAKERS = new Set(["rider", "agent"]);
const HAZARD_LEVELS = new Set(["normal", "caution", "critical"]);
const RIDE_MODES = new Set(["ride", "stop", "navigation", "emergency"]);
const DEMO_SCENARIOS = new Set(["commute", "wind", "fuel", "group", "emergency", "adas"]);
const MEMORY_LANGUAGES = new Set(["zh", "en"]);
const RESPONSE_MODES = new Set(["concise", "normal", "emergency"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Non-finite (or missing) numbers become the fallback instead of NaN math. */
function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

/** Optional numeric field: keep only finite values. */
function finiteOrUndefined(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function enumOrUndefined<T extends string>(value: unknown, allowed: Set<string>): T | undefined {
  return isString(value) && allowed.has(value) ? (value as T) : undefined;
}

/**
 * Validates a parsed relay event. Returns the typed event with optional
 * numerics sanitized, or null when the event is malformed or of unknown type.
 */
export function validateAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value) || !isString(value.type)) return null;

  switch (value.type) {
    case "session.started": {
      if (!isString(value.provider)) return null;
      if (!isString(value.mode) || !PROVIDER_MODES.has(value.mode)) return null;
      if (!isRecord(value.capabilities)) return null;
      return value as AgentEvent;
    }

    case "connection": {
      if (!isString(value.state) || !CONNECTION_STATES.has(value.state)) return null;
      if (!isString(value.detail)) return null;
      return { type: "connection", state: value.state as ConnectionState, detail: value.detail };
    }

    case "status": {
      if (!isString(value.state) || !isString(value.detail)) return null;
      return { type: "status", state: value.state, detail: value.detail };
    }

    case "transcript": {
      if (!isString(value.speaker) || !SPEAKERS.has(value.speaker)) return null;
      if (!isString(value.text)) return null;
      return {
        type: "transcript",
        speaker: value.speaker as "rider" | "agent",
        text: value.text,
        final: typeof value.final === "boolean" ? value.final : undefined,
        useBrowserSpeech: typeof value.useBrowserSpeech === "boolean" ? value.useBrowserSpeech : undefined
      };
    }

    case "metric": {
      return {
        type: "metric",
        latencyMs: finiteOr(value.latencyMs, 0),
        droppedFrames: finiteOrUndefined(value.droppedFrames),
        outgoingFps: finiteOrUndefined(value.outgoingFps)
      };
    }

    case "weather": {
      if (!isString(value.description)) return null;
      return {
        type: "weather",
        description: value.description,
        temperatureC: finiteOr(value.temperatureC, 0),
        windSpeedKmh: finiteOr(value.windSpeedKmh, 0),
        isDay: value.isDay !== false,
        riskLevel: enumOrUndefined(value.riskLevel, HAZARD_LEVELS),
        riderAdvice: isString(value.riderAdvice) ? value.riderAdvice : undefined
      };
    }

    case "ride.context": {
      if (!isString(value.mode) || !RIDE_MODES.has(value.mode)) return null;
      if (!isString(value.scenario) || !DEMO_SCENARIOS.has(value.scenario)) return null;
      if (!isString(value.modeLabel) || !isString(value.scenarioLabel)) return null;
      const hazardLevel = enumOrUndefined<"normal" | "caution" | "critical">(value.hazardLevel, HAZARD_LEVELS);
      if (!hazardLevel) return null;
      return {
        type: "ride.context",
        mode: value.mode as RideMode,
        modeLabel: value.modeLabel,
        scenario: value.scenario as DemoScenario,
        scenarioLabel: value.scenarioLabel,
        speedKmh: finiteOrUndefined(value.speedKmh),
        routePhase: isString(value.routePhase) ? value.routePhase : undefined,
        network: enumOrUndefined(value.network, new Set(["online", "degraded", "offline"])),
        batteryPct: finiteOrUndefined(value.batteryPct),
        hazardLevel,
        glanceableFocus: isString(value.glanceableFocus) ? value.glanceableFocus : ""
      };
    }

    case "session.memory": {
      const language = enumOrUndefined<"zh" | "en">(value.language, MEMORY_LANGUAGES);
      const responseMode = enumOrUndefined<"concise" | "normal" | "emergency">(value.responseMode, RESPONSE_MODES);
      if (!language || !responseMode) return null;
      return {
        type: "session.memory",
        language,
        destination: isString(value.destination) ? value.destination : undefined,
        lastIntent: isString(value.lastIntent) ? value.lastIntent : undefined,
        responseMode
      };
    }

    case "telemetry": {
      return {
        type: "telemetry",
        asrMs: finiteOr(value.asrMs, 0),
        thinkMs: finiteOr(value.thinkMs, 0),
        firstAudioMs: finiteOr(value.firstAudioMs, 0),
        totalMs: finiteOr(value.totalMs, 0)
      };
    }

    case "hazard.alert": {
      // The safety banner renders these strings directly — a missing message
      // must not put "undefined" in front of the rider.
      if (!isString(value.label) || !isString(value.message) || !isString(value.advice)) return null;
      if (!isString(value.threat) || !isString(value.direction)) return null;
      const severity = enumOrUndefined<AdasSeverity>(value.severity, new Set(["caution", "critical"]));
      if (!severity) return null;
      return {
        type: "hazard.alert",
        threat: value.threat as AdasThreat,
        direction: value.direction as AdasDirection,
        severity,
        label: value.label,
        message: value.message,
        advice: value.advice,
        // NaN here used to make the auto-dismiss timeout fire on the next tick.
        ttcSeconds: finiteOr(value.ttcSeconds, 6),
        interrupt: value.interrupt === true
      };
    }

    case "error": {
      if (!isString(value.message)) return null;
      return { type: "error", message: value.message };
    }

    default:
      // Unknown event type: a newer relay talking to an older client. Ignore.
      return null;
  }
}
