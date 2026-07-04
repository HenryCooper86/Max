// The durable testing-session replay file (JSONL) — load-time behavior.
// TESTING_HISTORY_PATH is resolved when server/metrics loads, so each case
// stubs the env and imports a fresh copy of the module.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const MAX_SESSIONS = 20; // TESTING_HISTORY_MAX_SESSIONS lower bound

function sessionLine(index: number): string {
  return JSON.stringify({
    sessionId: `hist-${index}`,
    testerId: "history-tester",
    ipAddress: "203.0.113.77",
    startedAt: 1_000 + index,
    endedAt: 2_000 + index,
    micFrames: 1,
    turns: []
  });
}

async function loadMetricsWithHistory(file: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("TESTING_HISTORY_MAX_SESSIONS", String(MAX_SESSIONS));
  vi.stubEnv("TESTING_HISTORY_FILE", file);
  return import("../server/metrics");
}

let tempDir: string | null = null;

function historyFile(lines: string[]): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "max-testing-history-"));
  const file = path.join(tempDir, "sessions.jsonl");
  // Like the writer: every line, including the last, ends with "\n".
  fs.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("testing history replay", () => {
  it("retains the full session cap despite the trailing newline", async () => {
    // 25 sessions on disk, cap 20 → exactly the newest 20 must survive. The
    // old loader counted the trailing "" as a line and silently dropped the
    // oldest retained session.
    const file = historyFile(Array.from({ length: 25 }, (_, index) => sessionLine(index)));
    const { testingSnapshot } = await loadMetricsWithHistory(file);

    const sessions = testingSnapshot(10_000).sessions;
    expect(sessions.length).toBe(MAX_SESSIONS);
    const ids = sessions.map((session) => session.sessionId);
    expect(ids).toContain("hist-5"); // oldest retained (25 - 20 = 5)
    expect(ids).toContain("hist-24");
    expect(ids).not.toContain("hist-4");
  });

  it("skips a corrupt line without discarding the sessions recorded after it", async () => {
    const file = historyFile([sessionLine(0), '{"sessionId": "torn-partial-wri', sessionLine(1), sessionLine(2)]);
    const { testingSnapshot } = await loadMetricsWithHistory(file);

    const ids = testingSnapshot(10_000).sessions.map((session) => session.sessionId);
    expect(ids).toEqual(expect.arrayContaining(["hist-0", "hist-1", "hist-2"]));
    expect(ids.length).toBe(3);
  });

  it("compacts a file that grew far past the cap", async () => {
    const total = MAX_SESSIONS * 4 + 10;
    const file = historyFile(Array.from({ length: total }, (_, index) => sessionLine(index)));
    const { testingSnapshot } = await loadMetricsWithHistory(file);
    testingSnapshot(10_000); // triggers the lazy load + compaction

    const rewritten = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(rewritten.length).toBe(MAX_SESSIONS);
    expect(JSON.parse(rewritten.at(-1)!).sessionId).toBe(`hist-${total - 1}`);
  });
});
