export type RdkConfig = {
  relayUrl: string;
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
    voiceGateMs: optionalNumber(env, "MAX_VOICE_GATE_MS", 400)
  };
}
