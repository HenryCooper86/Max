export type CompanionClientEvent =
  | { type: "companion.pair"; code: string }
  | { type: "companion.pairDiscover"; token: string }
  | { type: "companion.start" }
  | { type: "companion.stop" }
  | { type: "companion.unpair" }
  | {
      type: "companion.location";
      sequence: number;
      lat: number;
      lon: number;
      horizontalAccuracyMeters: number;
      timestamp: number;
      courseDegrees?: number;
      speedMps?: number;
    };

export type CompanionServerEvent =
  | {
      type: "companion.status";
      state: "unpaired" | "paired" | "helmetOffline" | "ready" | "sharing";
      deviceId?: string;
      deviceLabel?: string;
      detail?: string;
    }
  | { type: "companion.error"; code: string; detail: string };

const MAX_COMPANION_STRING_BYTES = 120;

function assertFiniteNumber(value: unknown, field: string, min?: number, max?: number) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    throw new Error(`Invalid companion.location ${field}`);
  }
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((field) => allowed.includes(field));
}

export function parseCompanionClientEvent(input: Buffer | string): CompanionClientEvent {
  const value = JSON.parse(typeof input === "string" ? input : input.toString("utf8")) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw new Error("Companion client event type is required");
  }

  if (value.type === "companion.pair") {
    if (
      !hasOnlyFields(value, ["type", "code"]) ||
      typeof value.code !== "string" ||
      !value.code.trim() ||
      Buffer.byteLength(value.code) > MAX_COMPANION_STRING_BYTES
    ) {
      throw new Error("Invalid companion.pair code");
    }
    return { type: "companion.pair", code: value.code };
  }

  if (value.type === "companion.pairDiscover") {
    if (
      !hasOnlyFields(value, ["type", "token"]) ||
      typeof value.token !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.token)
    ) {
      throw new Error("Invalid companion.pairDiscover token");
    }
    return { type: "companion.pairDiscover", token: value.token };
  }

  if (value.type === "companion.start" || value.type === "companion.stop" || value.type === "companion.unpair") {
    if (!hasOnlyFields(value, ["type"])) throw new Error(`Invalid ${value.type} fields`);
    return { type: value.type };
  }

  if (value.type !== "companion.location") {
    throw new Error(`Unsupported companion client event ${value.type}`);
  }
  if (
    !hasOnlyFields(value, [
      "type",
      "sequence",
      "lat",
      "lon",
      "horizontalAccuracyMeters",
      "timestamp",
      "courseDegrees",
      "speedMps"
    ])
  ) {
    throw new Error("Invalid companion.location fields");
  }
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence <= 0) {
    throw new Error("Invalid companion.location sequence");
  }
  assertFiniteNumber(value.lat, "lat", -90, 90);
  assertFiniteNumber(value.lon, "lon", -180, 180);
  assertFiniteNumber(value.horizontalAccuracyMeters, "horizontalAccuracyMeters", 0);
  assertFiniteNumber(value.timestamp, "timestamp", 0);
  if (value.courseDegrees !== undefined) assertFiniteNumber(value.courseDegrees, "courseDegrees", 0, 360);
  if (value.speedMps !== undefined) assertFiniteNumber(value.speedMps, "speedMps", 0);

  return {
    type: "companion.location",
    sequence: value.sequence,
    lat: value.lat as number,
    lon: value.lon as number,
    horizontalAccuracyMeters: value.horizontalAccuracyMeters as number,
    timestamp: value.timestamp as number,
    courseDegrees: value.courseDegrees as number | undefined,
    speedMps: value.speedMps as number | undefined
  };
}
