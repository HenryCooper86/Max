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
  // Each replay case owns its JSONL fixture; never merge the developer's
  // durable SQLite corpus into this isolated loader test.
  vi.stubEnv("TESTING_DATABASE", "off");
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
  it("detects a stored evidence hash mismatch", async () => {
    const tampered = JSON.stringify({
      sessionId: "tampered",
      testerId: "history-tester",
      ipAddress: "203.0.113.77",
      testCaseId: "baseline-live-session",
      startedAt: 1_000,
      endedAt: 5_000,
      durationMs: 4_000,
      micFrames: 1,
      p95LatencyMs: 120,
      evidenceHash: "0".repeat(64),
      turns: [
        { sessionId: "tampered", at: 1_500, speaker: "rider", text: "Max, route status?", final: true },
        { sessionId: "tampered", at: 1_800, speaker: "agent", text: "Route clear. Ride safely.", final: true }
      ]
    });
    const file = historyFile([tampered]);
    const { testingSnapshot } = await loadMetricsWithHistory(file);
    expect(testingSnapshot(10_000).sessions[0].evidenceIntegrity).toBe("mismatch");
  });

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

  it("indexes and can delete archive evidence older than the in-memory gate window", async () => {
    const file = historyFile(Array.from({ length: 25 }, (_, index) => sessionLine(index)));
    const { testingSnapshot, testingSessionPage, clearTestingSession, flushTestingHistory } =
      await loadMetricsWithHistory(file);
    expect(testingSnapshot(10_000).sessions).toHaveLength(MAX_SESSIONS);
    expect(testingSessionPage({ search: "hist-0" }).items.map((session) => session.sessionId)).toEqual(["hist-0"]);

    expect(clearTestingSession("hist-0")).toEqual({ removedTesters: 0, removedSessions: 1 });
    await flushTestingHistory();
    const retainedIds = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).sessionId as string);
    expect(retainedIds).toHaveLength(24);
    expect(retainedIds).not.toContain("hist-0");
  });

  it("skips a corrupt line without discarding the sessions recorded after it", async () => {
    const file = historyFile([sessionLine(0), '{"sessionId": "torn-partial-wri', sessionLine(1), sessionLine(2)]);
    const { testingSnapshot } = await loadMetricsWithHistory(file);

    const ids = testingSnapshot(10_000).sessions.map((session) => session.sessionId);
    expect(ids).toEqual(expect.arrayContaining(["hist-0", "hist-1", "hist-2"]));
    expect(ids.length).toBe(3);
  });

  it("re-evaluates persisted quality and validity with the current deterministic policy", async () => {
    const stalePass = JSON.stringify({
      sessionId: "stale-pass",
      testerId: "history-tester",
      ipAddress: "203.0.113.77",
      testCaseId: "baseline-live-session",
      startedAt: 1_000,
      endedAt: 5_000,
      durationMs: 4_000,
      micFrames: 0,
      p95LatencyMs: 120,
      errorEvents: 0,
      ttsFallbacks: 0,
      turns: [
        { sessionId: "stale-pass", at: 1_500, speaker: "rider", text: "Max, route status?", final: true },
        { sessionId: "stale-pass", at: 1_800, speaker: "agent", text: "Route clear. Ride safely.", final: true }
      ],
      // Simulate an older policy snapshot that incorrectly trusted this run.
      quality: "pass",
      validity: { status: "valid", reasons: [], detail: "Old policy accepted this." },
      evaluation: {
        testCaseId: "baseline-live-session",
        testCaseName: "Baseline Live Session",
        score: 100,
        quality: "pass",
        checks: [{ id: "old-check", label: "Old check", status: "pass", detail: "Passed before policy update." }]
      }
    });
    const file = historyFile([stalePass]);
    const { testingSnapshot } = await loadMetricsWithHistory(file);

    const [session] = testingSnapshot(10_000).sessions;
    expect(session.quality).toBe("fail");
    expect(session.validity).toMatchObject({ status: "invalid", reasons: ["missing-mic-audio"] });
    expect(session.flags).toContain("mic-audio");
    expect(session.flags).not.toContain("old-check");
  });

  it("rewrites the file when a tester is cleared, and empties it on clear-all", async () => {
    const file = historyFile([sessionLine(0), sessionLine(1), sessionLine(2)]);
    const { testingSnapshot, clearTesterData, clearAllTesterData, flushTestingHistory } =
      await loadMetricsWithHistory(file);
    testingSnapshot(10_000); // lazy-load the history

    // All seeded sessions belong to the same tester (see sessionLine).
    const result = clearTesterData("history-tester@203.0.113.77");
    expect(result.removedSessions).toBe(3);
    await flushTestingHistory();
    expect(fs.readFileSync(file, "utf8").trim()).toBe("");

    clearAllTesterData();
    await flushTestingHistory();
    expect(fs.readFileSync(file, "utf8").trim()).toBe("");
  });

  it("compacts a file that grew far past the cap", async () => {
    const total = MAX_SESSIONS * 4 + 10;
    const file = historyFile(Array.from({ length: total }, (_, index) => sessionLine(index)));
    vi.stubEnv("TESTING_ARCHIVE_MAX_SESSIONS", String(MAX_SESSIONS));
    const { testingSnapshot } = await loadMetricsWithHistory(file);
    testingSnapshot(10_000); // triggers the lazy load + compaction

    const rewritten = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(rewritten.length).toBe(MAX_SESSIONS);
    expect(JSON.parse(rewritten.at(-1)!).sessionId).toBe(`hist-${total - 1}`);
  });
});
