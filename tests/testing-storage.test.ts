import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tempDir: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("testing evidence storage", () => {
  it("creates a private SQLite database and journal", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-testing-store-"));
    const databasePath = path.join(tempDir, "testing.sqlite");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TESTING_DATABASE", databasePath);

    const store = await import("../server/testing-store");
    store.getActiveTestingPolicy();

    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const journalPath = `${databasePath}${suffix}`;
      if (fs.existsSync(journalPath)) expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
    }
    store.closeTestingStoreForTests();
  });
});
