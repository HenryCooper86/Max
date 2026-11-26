import type { SessionStartEvent } from "../../../shared/agent";

/** QA attribution a board under test sends in `session.start`, as the phones and the web app do. */
export type RdkTesting = Partial<
  Pick<
    SessionStartEvent,
    "testerId" | "testerRegion" | "testingCampaignId" | "testingTestCaseId" | "testingRunId" | "testingAssignmentId"
  >
>;

export type RdkConfig = {
  relayUrl: string;
  /** Operator relay token. The relay refuses the /agent upgrade with 401 once
   *  accounts exist or RELAY_AUTH_TOKEN is set, so a production relay needs
   *  this. Sent as an `Authorization: Bearer` header, never in the URL. */
  relayToken: string;
  insecureTls: boolean;
  /** MAX_REQUIRE_TLS=on: refuse to start when the relay URL would send the
   *  token and microphone audio unencrypted to a non-loopback host. */
  requireTls: boolean;
  alsaCapture: string;
  alsaPlayback: string;
  cameraFront: string;
  cameraRear: string;
  deviceIdFile: string;
  galleryDir: string;
  galleryMinFreeMb: number;
  hudPort: number;
  visionPreviewPort: number;
  /** Shared secret for the sidecar's bench HTTP surface. The sidecar reads the
   *  same variable and refuses every non-loopback peer without it, so the agent
   *  needs it only to template into the HUD page it serves. Empty means the
   *  sidecar is reachable from the board itself and nowhere else. */
  visionToken: string;
  visionSocket: string;
  voiceGateRms: number;
  voiceGateMs: number;
  /** "apm" runs max-aec; "off" falls back to arecord plus the hardware duck. */
  aecMode: "apm" | "off";
  aecBin: string;
  /**
   * Reference-to-mic delay hint for APM. 80 ms is measured, not guessed:
   * cross-correlating the recorded mic against the reference on the board gave
   * 81 ms once playback was paced. DelayAgnostic tracks drift from here.
   */
  aecDelayMs: number;
  /**
   * Residual echo suppressor: 0 low, 1 moderate, 2 high.
   *
   * Defaults to HIGH, on hardware evidence that overruled the bench. The
   * offline fixture found ERLE identical at all three levels while double-talk
   * loss climbed 12.5 -> 16.7 -> 22.1 dB, and recommended 0. That fixture's
   * echo path is linear; a real speaker is not. On the board the linear filter
   * alone managed erle 0.0-2.0 dB and the echo loop returned, and only the
   * residual suppressor stopped it — confirmed live, headset on, 2026-07-26.
   *
   * The cost is real: high suppression attenuates the rider during double-talk,
   * so barge-in is harder. Drop to 1 if interrupting Max becomes unreliable.
   */
  aecSuppression: number;
  /**
   * When set, max-aec writes <prefix>.mic.raw and <prefix>.ref.raw, sample
   * aligned. Diagnostic only — it writes 64 KB/s and never rotates, so it is
   * off unless someone is actively debugging the echo path.
   */
  aecDump: string;
  /**
   * Arms ADAS alert audio. Defaults false and must stay false until shadow-mode
   * false-alarm numbers meet the M1 gate — under 1 false alert/hour and zero
   * false criticals. M1's thresholds are untuned starting values, and untuned
   * thresholds must not reach a rider's ears at 100 km/h. See the M2 spec.
   */
  adasAudio: boolean;
  adasAudioDir: string;
  /** The installed release (deploy.sh stamps its SHA there as .rdk-release-sha), for the build identity it reports. */
  releaseRoot: string;
  /** Set only from the MAX_TESTER_* / MAX_TESTING_* variables that are present. */
  testing: RdkTesting;
};

function requireString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function optionalNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got ${value}`);
  return parsed;
}

function optionalEnum<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const trimmed = value.trim() as T;
  if (!allowed.includes(trimmed)) {
    throw new Error(`${key} must be one of ${allowed.join(", ")}, got ${value}`);
  }
  return trimmed;
}

/**
 * Only the exact string "1" enables the self-signed escape hatch. Anything
 * vaguer ("yes", "true") is treated as off, so a typo cannot quietly disable
 * certificate validation.
 */
function optionalFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key]?.trim() === "1";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Plain ws:// to anything but this board carries the rider's microphone audio
 * and the relay token in clear text to every hop on the path. Returns the
 * reason when the URL is in that state, null when it is safe (wss, or loopback).
 * A URL that is not ws/wss at all is reported only so strict mode can refuse it.
 */
function cleartextRelayReason(relayUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    return "MAX_RELAY_URL is not a valid URL";
  }
  if (parsed.protocol === "wss:") return null;
  if (parsed.protocol !== "ws:") return `MAX_RELAY_URL uses ${parsed.protocol}, not wss:`;
  if (isLoopbackHost(parsed.hostname)) return null;
  return `MAX_RELAY_URL is plain ws:// to ${parsed.hostname}`;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = (line) => console.warn(line)
): RdkConfig {
  const relayUrl = requireString(env, "MAX_RELAY_URL");
  const requireTls = optionalEnum(env, "MAX_REQUIRE_TLS", ["on", "off"] as const, "off") === "on";
  const cleartext = cleartextRelayReason(relayUrl);
  if (cleartext && requireTls) {
    throw new Error(`MAX_REQUIRE_TLS=on: ${cleartext}; use a wss:// relay URL`);
  }
  const insecureTls = optionalFlag(env, "MAX_RELAY_INSECURE_TLS");
  if (requireTls && insecureTls && !isLoopbackHost(new URL(relayUrl).hostname)) {
    throw new Error(
      "MAX_REQUIRE_TLS=on conflicts with MAX_RELAY_INSECURE_TLS=1: TLS without certificate verification " +
        "defeats the strict mode; unset MAX_RELAY_INSECURE_TLS or set MAX_REQUIRE_TLS=off"
    );
  }
  if (cleartext && /^ws:/i.test(relayUrl)) {
    warn(
      `[config] WARNING: ${cleartext}. The relay token and the rider's microphone audio cross the network ` +
        "unencrypted. Use wss://, or set MAX_REQUIRE_TLS=on to refuse to start like this."
    );
  }
  return {
    relayUrl,
    requireTls,
    relayToken: optionalString(env, "MAX_RELAY_TOKEN", ""),
    insecureTls,
    alsaCapture: optionalString(env, "RDK_ALSA_CAPTURE", "plughw:0,0"),
    alsaPlayback: optionalString(env, "RDK_ALSA_PLAYBACK", "plughw:0,0"),
    // VCON index, not a guess: on this board vcon@0/@1 sit on i2c bus 6, which
    // has no connector, while both camera connectors map to vcon@2/@3 on bus 4.
    // Verified on hardware — see "Camera findings" in rdk/README.md.
    cameraFront: optionalString(env, "RDK_CAMERA_FRONT", "2"),
    cameraRear: optionalString(env, "RDK_CAMERA_REAR", "3"),
    deviceIdFile: optionalString(env, "MAX_DEVICE_ID_FILE", "/var/lib/max/device-id"),
    galleryDir: optionalString(env, "MAX_GALLERY_DIR", "/var/lib/max/gallery"),
    galleryMinFreeMb: optionalNumber(env, "MAX_GALLERY_MIN_FREE_MB", 1024),
    hudPort: optionalNumber(env, "MAX_HUD_PORT", 8080),
    visionPreviewPort: optionalNumber(env, "MAX_VISION_PREVIEW_PORT", 8081),
    visionToken: optionalString(env, "MAX_VISION_TOKEN", ""),
    visionSocket: optionalString(env, "MAX_VISION_SOCKET", "/run/max/vision.sock"),
    voiceGateRms: optionalNumber(env, "MAX_VOICE_GATE_RMS", 900),
    voiceGateMs: optionalNumber(env, "MAX_VOICE_GATE_MS", 400),
    aecMode: optionalEnum(env, "MAX_AEC_MODE", ["apm", "off"] as const, "apm"),
    aecBin: optionalString(env, "MAX_AEC_BIN", "/opt/max/rdk/aec/max-aec"),
    aecDelayMs: optionalNumber(env, "MAX_AEC_DELAY_MS", 80),
    aecSuppression: optionalNumber(env, "MAX_AEC_SUPPRESSION", 2),
    aecDump: optionalString(env, "MAX_AEC_DUMP", ""),
    adasAudio: optionalFlag(env, "MAX_ADAS_AUDIO"),
    adasAudioDir: optionalString(env, "MAX_ADAS_AUDIO_DIR", "/opt/max/rdk/audio/alerts"),
    releaseRoot: optionalString(env, "MAX_RELEASE_ROOT", "/opt/max"),
    testing: Object.fromEntries(
      Object.entries({
        testerId: env.MAX_TESTER_ID,
        testerRegion: env.MAX_TESTER_REGION,
        testingCampaignId: env.MAX_TESTING_CAMPAIGN_ID,
        testingTestCaseId: env.MAX_TESTING_TEST_CASE_ID,
        testingRunId: env.MAX_TESTING_RUN_ID,
        testingAssignmentId: env.MAX_TESTING_ASSIGNMENT_ID
      }).flatMap(([key, value]) => (value?.trim() ? [[key, value.trim()]] : []))
    )
  };
}
