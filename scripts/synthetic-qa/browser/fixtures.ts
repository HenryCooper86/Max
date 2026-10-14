/** Integrity checks run before any real relay session is opened. */
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
