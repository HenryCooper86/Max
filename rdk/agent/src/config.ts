export type RdkConfig = {
  relayUrl: string;
  /** Operator relay token. The relay refuses the /agent upgrade with 401 once
   *  accounts exist or RELAY_AUTH_TOKEN is set, so a production relay needs
   *  this. Sent as `?token=…`, matching the web client. */
  relayToken: string;
  insecureTls: boolean;
  alsaCapture: string;
  alsaPlayback: string;
  cameraFront: string;
  cameraRear: string;
  galleryDir: string;
  galleryMinFreeMb: number;
  hudPort: number;
  visionPreviewPort: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RdkConfig {
  return {
    relayUrl: requireString(env, "MAX_RELAY_URL"),
    relayToken: optionalString(env, "MAX_RELAY_TOKEN", ""),
    insecureTls: optionalFlag(env, "MAX_RELAY_INSECURE_TLS"),
    alsaCapture: optionalString(env, "RDK_ALSA_CAPTURE", "plughw:0,0"),
    alsaPlayback: optionalString(env, "RDK_ALSA_PLAYBACK", "plughw:0,0"),
    // VCON index, not a guess: on this board vcon@0/@1 sit on i2c bus 6, which
    // has no connector, while both camera connectors map to vcon@2/@3 on bus 4.
    // Verified on hardware — see "Camera findings" in rdk/README.md.
    cameraFront: optionalString(env, "RDK_CAMERA_FRONT", "2"),
    cameraRear: optionalString(env, "RDK_CAMERA_REAR", "3"),
    galleryDir: optionalString(env, "MAX_GALLERY_DIR", "/var/lib/max/gallery"),
    galleryMinFreeMb: optionalNumber(env, "MAX_GALLERY_MIN_FREE_MB", 1024),
    hudPort: optionalNumber(env, "MAX_HUD_PORT", 8080),
    visionPreviewPort: optionalNumber(env, "MAX_VISION_PREVIEW_PORT", 8081),
    visionSocket: optionalString(env, "MAX_VISION_SOCKET", "/run/max/vision.sock"),
    voiceGateRms: optionalNumber(env, "MAX_VOICE_GATE_RMS", 900),
    voiceGateMs: optionalNumber(env, "MAX_VOICE_GATE_MS", 400),
    aecMode: optionalEnum(env, "MAX_AEC_MODE", ["apm", "off"] as const, "apm"),
    aecBin: optionalString(env, "MAX_AEC_BIN", "/opt/max/rdk/aec/max-aec"),
    aecDelayMs: optionalNumber(env, "MAX_AEC_DELAY_MS", 80),
    aecSuppression: optionalNumber(env, "MAX_AEC_SUPPRESSION", 2),
    aecDump: optionalString(env, "MAX_AEC_DUMP", ""),
    adasAudio: optionalFlag(env, "MAX_ADAS_AUDIO"),
    adasAudioDir: optionalString(env, "MAX_ADAS_AUDIO_DIR", "/opt/max/rdk/audio/alerts")
  };
}
