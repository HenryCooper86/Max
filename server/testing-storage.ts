import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TESTING_STORAGE_DIRECTORY = path.join(os.homedir(), ".max-relay");

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The default QA directory contains credentials and transcript evidence, so
 * an older permissive umask must not leave it traversable by other users. */
export function ensureTestingStorageDirectorySync(filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (path.resolve(directory) === path.resolve(DEFAULT_TESTING_STORAGE_DIRECTORY)) {
    fs.chmodSync(directory, 0o700);
  }
}

export async function ensureTestingStorageDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  if (path.resolve(directory) === path.resolve(DEFAULT_TESTING_STORAGE_DIRECTORY)) {
    await fs.promises.chmod(directory, 0o700);
  }
}

/** Evidence files may contain tester identifiers and transcripts. Enforce the
 * same private mode on newly-created files and archives from older releases. */
export function secureTestingFileSync(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function secureTestingFile(filePath: string): Promise<void> {
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
