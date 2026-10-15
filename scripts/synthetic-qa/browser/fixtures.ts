/** Integrity checks run before any real relay session is opened. */
import { ADAS_SCENARIOS } from "../../../shared/adas";

export type WarningAsset = {
  url: string;
  text: string;
  pcmSha256: string;
  sha256: string;
  samples: number;
  threat: string;
  gender: string;
};
export function validateWarningManifest(value: unknown): WarningAsset[] {
  const manifest = value as {
    sampleRate?: number;
    channels?: number;
    sampleFormat?: string;
    assets?: WarningAsset[];
  } | null;
  if (
    !manifest ||
    manifest.sampleRate !== 24000 ||
    manifest.channels !== 1 ||
    manifest.sampleFormat !== "s16le" ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== ADAS_SCENARIOS.length * 2
  )
    throw new Error("Invalid canonical warning manifest");
  const identities = new Set<string>();
  const urls = new Set<string>();
  for (const asset of manifest.assets) {
    const scenario = ADAS_SCENARIOS.find((item) => item.threat === asset?.threat);
    if (
      !scenario ||
      !["female", "male"].includes(asset.gender) ||
      asset.text !== `${scenario.message} ${scenario.advice}` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !/^[a-f0-9]{64}$/.test(asset.pcmSha256) ||
      !Number.isInteger(asset.samples) ||
      asset.samples <= 0
    )
      throw new Error("Invalid canonical warning identity");
    const url = new URL(asset.url, "https://qa.invalid");
    if (
      url.origin !== "https://qa.invalid" ||
      url.pathname !== `/audio/adas/${asset.gender}/${asset.threat}.wav` ||
      url.searchParams.size !== 1 ||
      url.searchParams.get("v") !== asset.sha256.slice(0, 16) ||
      url.hash
    )
      throw new Error("Invalid warning asset URL");
    const identity = `${asset.gender}:${asset.threat}`;
    if (identities.has(identity) || urls.has(asset.url)) throw new Error("Duplicate canonical warning asset");
    identities.add(identity);
    urls.add(asset.url);
  }
  return manifest.assets;
}
export const REQUIRED_FIXTURES = [
  "baseline",
  "wake-background",
  "wake-addressed",
  "emergency",
  "adas",
  "wind-clean",
  "wind",
  "network"
] as const;
export type Fixture = { file: string; text: string; durationSeconds: number; sha256: string; snrDb?: number };
export type FixtureManifest = {
  sampleRate: 16000;
  channels: 1;
  sampleFormat: "s16le";
  fixtures: Record<string, Fixture>;
};
export function validateManifest(value: unknown): FixtureManifest {
  const manifest = value as FixtureManifest | null;
  if (
    !manifest ||
    manifest.sampleRate !== 16000 ||
    manifest.channels !== 1 ||
    manifest.sampleFormat !== "s16le" ||
    !manifest.fixtures
  )
    throw new Error("Fixtures must be mono 16 kHz s16le PCM");
  for (const name of REQUIRED_FIXTURES) {
    const fixture = manifest.fixtures[name];
    if (
      !fixture ||
      !/^[a-z-]+\.pcm$/.test(fixture.file) ||
      !/^[a-f0-9]{64}$/.test(fixture.sha256) ||
      typeof fixture.text !== "string" ||
      !fixture.text.trim() ||
      !Number.isFinite(fixture.durationSeconds) ||
      fixture.durationSeconds <= 0
    )
      throw new Error(`Invalid or missing fixture: ${name}`);
  }
  if (manifest.fixtures.wind?.snrDb !== 12) throw new Error("Wind fixture must declare deterministic 12 dB SNR");
  return manifest;
}
export async function verifyFixture(fixture: Fixture, bytes: ArrayBuffer): Promise<void> {
  if (!bytes.byteLength || bytes.byteLength % 2) throw new Error(`Invalid PCM length: ${fixture.file}`);
  const expectedSamples = Math.round(fixture.durationSeconds * 16000);
  if (bytes.byteLength !== expectedSamples * 2) throw new Error(`PCM duration mismatch: ${fixture.file}`);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== fixture.sha256) throw new Error(`Fixture hash mismatch: ${fixture.file}`);
}
