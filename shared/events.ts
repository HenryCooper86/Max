// Runtime validation for relay → client AgentEvents. The web client used to
// blind-cast `JSON.parse(...) as AgentEvent`, so a relay version skew or bug
// rendered "undefined°C", NaN timers, or a safety banner that dismissed itself
// on the next tick. validateAgentEvent admits an event only when every field
// the clients dereference is present and well-typed, sanitizes optional
// numerics, and returns null for malformed or unknown events (unknown types
// are ignored, not errors, so older clients tolerate newer relays).

import { ADAS_DIRECTIONS, ADAS_THREATS, type AdasDirection, type AdasSeverity, type AdasThreat } from "./adas";
import type { AgentEvent, ConnectionState, ProviderCapabilities } from "./agent";
import type { DemoScenario, RideMode } from "./ride";
import { MAX_MEMORY_DESTINATION_CHARS } from "./session";

const CONNECTION_STATES = new Set(["offline", "connecting", "relay", "provider", "ready", "degraded"]);
const PROVIDER_MODES = new Set(["mock", "live"]);
const SPEAKERS = new Set(["rider", "agent"]);
const HAZARD_LEVELS = new Set(["normal", "caution", "critical"]);
const RIDE_MODES = new Set(["ride", "stop", "navigation", "emergency"]);
const DEMO_SCENARIOS = new Set(["commute", "wind", "fuel", "group", "emergency", "adas"]);
const MEMORY_LANGUAGES = new Set(["zh", "en"]);
const RESPONSE_MODES = new Set(["concise", "normal", "emergency"]);
const NETWORK_STATES = new Set(["online", "degraded", "offline"]);
const ADAS_THREAT_SET = new Set<string>(ADAS_THREATS);
const ADAS_DIRECTION_SET = new Set<string>(ADAS_DIRECTIONS);

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

function finiteInRange(value: unknown, fallback: number, min: number, max = Number.POSITIVE_INFINITY): number {
  return isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Optional numeric field: keep only finite values. */
function finiteOrUndefined(
  value: unknown,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY
): number | undefined {
  return isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : undefined;
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
      // Build a sanitized object like every other branch — returning the raw
      // record let unchecked capability values (and extra fields) into state.
      const raw = value.capabilities;
      const capabilities: ProviderCapabilities = {
        serverVad: raw.serverVad === true,
        synthesizedAudio: raw.synthesizedAudio === true,
        transcriptEvents: raw.transcriptEvents === true,
        bargeIn: raw.bargeIn === true,
        voiceSelection: raw.voiceSelection === true,
        weatherContext: raw.weatherContext === true,
        sessionMemory: raw.sessionMemory === true,
        emergencyMode: raw.emergencyMode === true
      };
      return {
        type: "session.started",
        provider: value.provider,
        mode: value.mode as "mock" | "live",
        capabilities
      };
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
        latencyMs: finiteInRange(value.latencyMs, 0, 0),
        droppedFrames: finiteOrUndefined(value.droppedFrames, 0),
        outgoingFps: finiteOrUndefined(value.outgoingFps, 0)
      };
    }

    case "weather": {
      if (!isString(value.description)) return null;
      return {
        type: "weather",
        description: value.description,
        temperatureC: finiteOr(value.temperatureC, 0),
        windSpeedKmh: finiteInRange(value.windSpeedKmh, 0, 0),
        // Accept the upstream Open-Meteo numeric form (is_day: 0|1) too — a
        // bare `!== false` coerced numeric 0 (night) into daytime rendering.
        isDay: typeof value.isDay === "boolean" ? value.isDay : value.isDay !== 0,
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
        speedKmh: finiteOrUndefined(value.speedKmh, 0),
        routePhase: isString(value.routePhase) ? value.routePhase : undefined,
        network: enumOrUndefined(value.network, NETWORK_STATES),
        batteryPct: finiteOrUndefined(value.batteryPct, 0, 100),
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
        // Clamp by code point (not UTF-16 units, which can bisect a surrogate
        // pair) and to the same cap the server applies on restore.
        destination: isString(value.destination)
          ? [...value.destination].slice(0, MAX_MEMORY_DESTINATION_CHARS).join("")
          : undefined,
        lastIntent: isString(value.lastIntent) ? value.lastIntent : undefined,
        responseMode
      };
    }

    case "telemetry": {
      return {
        type: "telemetry",
        asrMs: finiteInRange(value.asrMs, 0, 0),
        thinkMs: finiteInRange(value.thinkMs, 0, 0),
        firstAudioMs: finiteInRange(value.firstAudioMs, 0, 0),
        totalMs: finiteInRange(value.totalMs, 0, 0)
      };
    }

    case "hazard.alert": {
      // The safety banner renders these strings directly — a missing message
      // must not put "undefined" in front of the rider.
      if (!isString(value.label) || !isString(value.message) || !isString(value.advice)) return null;
      // threat/direction feed Record lookups (adasDirectionLabel) — an unknown
      // value from a skewed relay must be rejected, not cast through.
      if (!isString(value.threat) || !ADAS_THREAT_SET.has(value.threat)) return null;
      if (!isString(value.direction) || !ADAS_DIRECTION_SET.has(value.direction)) return null;
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
        ttcSeconds: finiteInRange(value.ttcSeconds, 6, 0, 300),
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
